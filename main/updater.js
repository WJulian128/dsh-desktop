'use strict';
const https = require('node:https');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const semver = require('semver');

const PACKAGE = '@deepseek-ai/dsh';
const REGISTRY = 'https://registry.npmjs.org/' + PACKAGE;

function fetchJson(url, { timeoutMs = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json',
        'User-Agent': 'dsh-desktop-updater',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchJson(new URL(res.headers.location, url).href, { timeoutMs, redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('registry 返回 HTTP ' + res.statusCode));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求 registry 超时')));
  });
}

/** 读取已安装版本。appDir 无安装时回退到 fallbackDir（打包模式：内置副本的版本）。 */
function installedVersion(appDir, fallbackDir) {
  const dirs = [appDir];
  if (fallbackDir && fallbackDir !== appDir) dirs.push(fallbackDir);
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(fs.readFileSync(
        path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
      if (typeof manifest.version === 'string') return manifest.version;
    } catch { /* 继续尝试下一个目录 */ }
  }
  return '0.0.0';
}

/** 检查 @deepseek-ai/dsh 是否有新版本。fallbackDir 为打包模式内置副本目录。 */
async function checkForUpdates(appDir, { checkPrereleases = false, fallbackDir = null } = {}) {
  const installed = installedVersion(appDir, fallbackDir);
  const doc = await fetchJson(REGISTRY);
  const tags = doc['dist-tags'] || {};
  const stable = tags.latest || doc.version;
  let latest = stable;
  if (checkPrereleases && tags.next && semver.valid(tags.next) && semver.gt(tags.next, latest)) {
    latest = tags.next;
  }
  const hasUpdate = Boolean(installed && semver.valid(installed) && semver.gt(latest, installed));
  return { installed, latestStable: stable, latest, hasUpdate };
}

/**
 * 拉取指定版本的官方发布说明（GitHub deepseek-ai/deepseek-harness releases，tag dsh-v<version>）。
 * 返回精简后的纯文本（去掉 markdown 链接/标题符，截断 maxLen 字符）；任何失败返回 ''（不影响更新流程）。
 */
async function fetchReleaseNotes(version, { maxLen = 1500 } = {}) {
  if (!version) return '';
  try {
    const doc = await fetchJson('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v' + version, { timeoutMs: 10000 });
    const body = typeof doc.body === 'string' && doc.body.trim() ? doc.body : '';
    if (!body) return '';
    const plain = body
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // markdown 链接 → 文本
      .replace(/<[^>]+>/g, '')                    // 残余 html 标签
      .replace(/^#{1,6}\s*/gm, '')                // 标题符
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return plain.length > maxLen ? plain.slice(0, maxLen) + '…' : plain;
  } catch { return ''; }
}

/**
 * 备份应用目录的 package.json 到 destDir（作为更新回滚点），并校验 @deepseek-ai/dsh
 * 已声明在依赖中（否则更新/回滚都没有依据，直接拒绝）。
 * 返回快照描述 { file, content, version }；任何失败抛错（纯函数，可单测）。
 */
function backupPackageJson(appDir, destDir) {
  const manifestPath = path.join(appDir, 'package.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
  const version = deps[PACKAGE];
  if (typeof version !== 'string' || !version) {
    throw new Error('package.json 中未声明 ' + PACKAGE + ' 依赖，无法安全更新');
  }
  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, 'package.json');
  fs.writeFileSync(file, raw, 'utf8');
  return { file, content: raw, version };
}

/**
 * 用快照恢复 appDir 的 package.json。无快照或无内容时返回 false（无需恢复）。
 * 优先用快照内联 content；content 缺失时才回退读快照文件（纯函数，可单测）。
 */
function restorePackageJson(appDir, snapshot) {
  if (!snapshot) return false;
  let content = snapshot.content;
  if (content === undefined) {
    if (!snapshot.file || !fs.existsSync(snapshot.file)) return false;
    content = fs.readFileSync(snapshot.file, 'utf8');
  }
  fs.writeFileSync(path.join(appDir, 'package.json'), content, 'utf8');
  return true;
}

/**
 * 校验 appDir 实际安装的 dsh 版本是否等于 version（不匹配视为半更新/失败）。
 * fallbackDir 为打包模式内置副本目录，仅当 appDir 无安装时才回退（纯函数，可单测）。
 */
function verifyInstalledVersion(appDir, version, fallbackDir = null) {
  return installedVersion(appDir, fallbackDir) === version;
}

/** 执行 npm install：成功 resolve；非零退出码 / 启动失败 reject（失败信号 = close code）。 */
function runNpmInstall(appDir, version, runner, onProgress) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const npmArgs = ['install', '--no-audit', '--no-fund', '--save-exact', PACKAGE + '@' + version];
    const spawnOpts = {
      cwd: appDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    let child;
    if (runner && runner.kind === 'bundled') {
      child = spawn(runner.node, [runner.cli, ...npmArgs], {
        ...spawnOpts,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    } else {
      const npmCmd = isWin ? 'npm.cmd' : 'npm';
      child = spawn(npmCmd, npmArgs, { ...spawnOpts, shell: isWin });
    }
    let last = '';
    const feed = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        last = t;
        if (onProgress) onProgress(t);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        return reject(new Error(runner && runner.kind === 'bundled'
          ? '内置 npm 运行器缺失（npm-cli.js 未打包进应用）'
          : '未找到 npm，请安装 Node.js 并确保其在 PATH 中'));
      }
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('npm install 失败（退出码 ' + code + '）\n最后输出：' + last));
    });
  });
}

/**
 * 事务化更新 @deepseek-ai/dsh 到指定版本：
 *  1. 安装前：把当前 package.json 快照到 os.tmpdir 临时目录，并校验 dsh 包存在；
 *  2. 安装中：npm install，非零退出码视为失败（close code），输出行透传 onProgress；
 *  3. 安装后：校验 installedVersion(appDir) === version，不匹配视为失败；
 *  4. 任一步失败：恢复 package.json 快照，抛出含"可重试"提示的错误。
 * `runner`：{ kind: 'system' } 用 PATH 里的 npm；{ kind: 'bundled', node, cli }
 * 用打包进应用的 npm-cli.js + Electron 自带的 Node（无系统 Node 也能自更新）。
 * `onProgress(text)`：接收安装输出行。
 */
async function applyUpdate(appDir, version, runner, onProgress) {
  const snapshotDir = path.join(os.tmpdir(), 'dsh-desktop-update-' + process.pid + '-' + Date.now());
  let snapshot = null;
  try {
    snapshot = backupPackageJson(appDir, snapshotDir);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    throw new Error('更新前置检查失败：' + msg + '（未开始安装，可重试）');
  }
  try {
    await runNpmInstall(appDir, version, runner, onProgress);
    if (!verifyInstalledVersion(appDir, version)) {
      throw new Error('安装后版本校验失败：期望 v' + version + '，实际 v' + installedVersion(appDir) + '（node_modules 未就位）');
    }
    try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch { /* 清理失败可忽略 */ }
  } catch (err) {
    let restored = false;
    try { restored = restorePackageJson(appDir, snapshot); } catch { /* 恢复失败时保留原始错误 */ }
    try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch { /* 清理失败可忽略 */ }
    const msg = (err && err.message) || String(err);
    throw new Error(msg + (restored
      ? '（已回滚 package.json，可重试更新）'
      : '（package.json 回滚失败，请检查应用目录后重试）'));
  }
}

module.exports = { checkForUpdates, applyUpdate, installedVersion, fetchJson, fetchReleaseNotes, backupPackageJson, restorePackageJson, verifyInstalledVersion };
