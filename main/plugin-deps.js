'use strict';

/**
 * 桌面端本地插件依赖自愈（纯 Node；供根 postinstall 与主进程启动前自检共用）。
 *
 * 背景（0.1.1-rc.2 → 0.1.2-rc.1 升级事故）：0.1.2-rc.1 起 harness Loader 以插件
 * 真实目录加载，ESM 从插件目录向上解析依赖，不再保证依赖出现在仓库/应用顶层
 * node_modules（npm 布局变化、升级中途重写都会让“只靠根提升”的插件 import 失败，
 * 报 ERR_MODULE_NOT_FOUND / failed to import loader entry，新版把它当致命错误，
 * 整个 harness 起不来）。
 *
 * 对策：插件自身 package.json 声明 dependencies，并在“从真实目录向上解析不到”
 * 时把缺失依赖补装到插件目录本地（对 hoist 布局免疫）。校验条件是“能解析到”，
 * 版本范围不匹配但能解析时不动（避免制造重复安装与版本漂移）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** 读取插件 package.json；缺失/损坏返回 null。 */
function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 依赖能否从插件真实目录沿祖先链解析到（含插件本地 node_modules）。
 * @param {string} realDir 插件真实目录（junction 目标）
 * @param {string} depName 依赖包名
 * @param {string} stopDir 向上最多走到这里（通常是应用根目录；再上就不是应用的地盘了）
 * @returns {boolean}
 */
function resolvableFrom(realDir, depName, stopDir) {
  let dir = path.resolve(realDir);
  const root = path.resolve(stopDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', depName, 'package.json');
    try {
      if (fs.statSync(candidate).isFile()) return true;
    } catch { /* 继续向上 */ }
    if (dir === root) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * 列出无法从 realDir 解析的声明依赖。
 * @param {string} realDir 插件真实目录
 * @param {string} stopDir 解析上界（应用根目录）
 * @param {boolean} [includePeers=false] 是否把 peerDependencies 一并纳入检查
 * @returns {string[]}
 */
function missingDeps(realDir, stopDir, { includePeers = false } = {}) {
  const manifest = readManifest(realDir);
  if (!manifest) return [];
  const declared = { ...(manifest.dependencies || {}) };
  if (includePeers) Object.assign(declared, manifest.peerDependencies || {});
  return Object.keys(declared).filter((dep) => !resolvableFrom(realDir, dep, stopDir));
}

/**
 * 挑选 npm 运行器：优先仓库/应用内置的 npm-cli.js（Windows 上 spawn npm.cmd
 * 在部分 shell 环境会 EINVAL，用 node 直跑最稳）；内置缺失时退回 PATH 里的 npm。
 * @param {{root:string, nodeExe?:string}} input
 * @returns {{command:string, args:string[], shell:boolean}|null}
 */
function resolveNpmRunner({ root, nodeExe }) {
  const node = nodeExe || process.execPath;
  const bundledCli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundledCli)) {
    return { command: node, args: [bundledCli], shell: false };
  }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' };
}

/**
 * 在插件目录补装依赖（npm install --omit=peer；dependencies 已声明的本地缺失时调用）。
 * @param {string} pluginDir 插件目录（安装目标）
 * @param {object} [runner] 运行器（缺省自动探测）
 * @param {(cmd:string, args:string[], opts:object) => object} [run]
 *        spawnSync 风格的执行函数（单测注入；缺省用 child_process.spawnSync）
 * @returns {{ok:boolean, error?:string}}
 */
function installPluginDeps(pluginDir, { runner, run } = {}) {
  const resolved = runner || resolveNpmRunner({ root: path.dirname(path.dirname(pluginDir)) });
  if (!resolved) return { ok: false, error: '未找到 npm 运行器' };
  const doRun = run || ((cmd, args, opts) => spawnSync(cmd, args, opts));
  const args = [...resolved.args, 'install', '--no-audit', '--no-fund', '--omit=peer'];
  try {
    const result = doRun(resolved.command, args, {
      cwd: pluginDir,
      stdio: 'pipe',
      windowsHide: true,
      shell: resolved.shell,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
      const tail = String(result.stderr || result.stdout || '').split(/\r?\n/).filter(Boolean).slice(-5).join(' | ');
      return { ok: false, error: 'npm install 退出码 ' + result.status + (tail ? '：' + tail : '') };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * 一次完整的“检查 + 补装”：解析不到才装，装完复检。
 * @param {string} realDir 插件真实目录（也用作安装目录）
 * @param {string} stopDir 解析上界（应用根目录）
 * @param {{nodeExe?:string, log?:(s:string)=>void, run?:Function}} [opts]
 * @returns {{action:'none'|'installed'|'failed'|'no-manifest', missing:string[], error?:string}}
 */
function ensureLocalDeps(realDir, stopDir, { nodeExe, log = () => {}, run } = {}) {
  if (!readManifest(realDir)) return { action: 'no-manifest', missing: [] };
  const missing = missingDeps(realDir, stopDir);
  if (!missing.length) return { action: 'none', missing: [] };
  log('[plugin-deps] ' + path.basename(realDir) + ' 依赖缺失，本地补装：' + missing.join(', '));
  const result = installPluginDeps(realDir, { runner: resolveNpmRunner({ root: stopDir, nodeExe }), run });
  if (!result.ok) {
    log('[plugin-deps] 补装失败：' + (result.error || '未知错误'));
    return { action: 'failed', missing, error: result.error };
  }
  const stillMissing = missingDeps(realDir, stopDir);
  if (stillMissing.length) {
    log('[plugin-deps] 补装后仍缺失：' + stillMissing.join(', '));
    return { action: 'failed', missing: stillMissing, error: '补装后仍缺失' };
  }
  log('[plugin-deps] ' + path.basename(realDir) + ' 依赖补装完成');
  return { action: 'installed', missing };
}

module.exports = {
  readManifest,
  resolvableFrom,
  missingDeps,
  resolveNpmRunner,
  installPluginDeps,
  ensureLocalDeps,
};
