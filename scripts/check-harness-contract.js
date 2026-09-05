'use strict';

/**
 * harness 官方契约体检（只读为主，幂等自愈仅限 profiles 链接）：
 * 每次 @deepseek-ai/dsh 升级前后跑一次，快速回答“桌面端与官方耦合点是否仍成立”。
 *   node scripts\check-harness-contract.js [--dshHome <路径>] [--patch <web.patch.yml 路径>]
 *
 * 覆盖的契约（详见仓库根 UPGRADE-PLAYBOOK.md）：
 *  1. dsh 包已安装、bin 入口存在、桌面端三插件（settings-update/llm-openai-compat/
 *     subagent-approval）在应用目录内目标完整；
 *  2. $DSH_HOME/profiles/node_modules/@dsh-desktop/* 链接可用（悬挂自动修复）；
 *  3. 本地插件声明依赖可解析（只报告，缺失提示修复命令，不自动装）；
 *  4. 截图补救依赖的官方 i18n 精确文案仍存在于 profile 的 conversation 客户端包；
 *  5. web.patch.yml 非空且含预期插件行（MCP/桌面端设置/审批桥）；
 *  6. 会话目录存在且最新 session.jsonl.zstd 可解压出帧（存储格式未变）；
 * 退出码：全部 PASS=0；有 WARN=2（提示但不阻断）；有 FAIL=1。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const DSH_HOME = argOf('--dshHome') || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PATCH_FILE = argOf('--patch') || path.join(os.homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'web.patch.yml');

let pass = 0;
let warn = 0;
let fail = 0;
const lines = [];

function report(level, name, detail) {
  lines.push((level === 'PASS' ? 'PASS ' : level === 'WARN' ? 'WARN ' : 'FAIL ') + name + (detail ? ' —— ' + detail : ''));
  if (level === 'PASS') pass += 1;
  else if (level === 'WARN') warn += 1;
  else fail += 1;
}

/* 1. dsh 安装与桌面端插件目标完整 */
const dshManifestPath = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
let dshVersion = '未知';
try { dshVersion = JSON.parse(fs.readFileSync(dshManifestPath, 'utf8')).version || '未知'; } catch { /* 下面报 FAIL */ }
report(fs.existsSync(dshManifestPath) ? 'PASS' : 'FAIL', 'dsh 包已安装（v' + dshVersion + '）',
  fs.existsSync(dshManifestPath) ? path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh') : dshManifestPath);
report(fs.existsSync(path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) ? 'PASS' : 'FAIL',
  'dsh bin 入口存在', 'node_modules/@deepseek-ai/dsh/lib/bin.js');

const bootPreflight = require('../main/boot-preflight');
for (const pkg of bootPreflight.DESKTOP_PLUGINS) {
  const target = bootPreflight.resolvePluginTarget(APP_DIR, pkg.candidates, pkg.requiredFiles);
  report(target ? 'PASS' : 'FAIL', '插件目标完整：' + pkg.name, target ? target.realDir : '在 ' + APP_DIR + ' 下未找到完整目标（' + pkg.candidates.join(' / ') + '）');
}

/* 2. profiles 链接（允许幂等自愈：与启动行为一致） */
const links = bootPreflight.ensureProfilePluginLinks({ dshHome: DSH_HOME, appDir: APP_DIR, log: () => {} });
report(links.ok === links.total ? 'PASS' : 'FAIL', 'profiles 插件链接可用', links.ok + '/' + links.total + '（' + path.join(DSH_HOME, 'profiles', 'node_modules', '@dsh-desktop') + '）');

/* 3. 本地插件声明依赖可解析（只报告，不自动安装） */
const pluginDeps = require('../main/plugin-deps');
for (const pkg of bootPreflight.DESKTOP_PLUGINS) {
  if (!pkg.localDeps) continue;
  const target = bootPreflight.resolvePluginTarget(APP_DIR, pkg.candidates, pkg.requiredFiles);
  if (!target) continue;
  const missing = pluginDeps.missingDeps(target.realDir, APP_DIR);
  if (!missing.length) {
    report('PASS', '插件依赖可解析：' + pkg.name, target.realDir);
  } else {
    report('FAIL', '插件依赖缺失：' + pkg.name,
      missing.join(', ') + ' —— 修复：在 ' + target.realDir + ' 执行 npm install --no-audit --no-fund --omit=peer（或重跑根 npm install 触发 postinstall）');
  }
}

/* 4. 截图补救 i18n 精确文案（官方 dsh-client-ui-conversation） */
const convCandidates = [
  path.join(DSH_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
  path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'),
];
const convFile = convCandidates.find((f) => fs.existsSync(f));
if (convFile) {
  const content = fs.readFileSync(convFile, 'utf8');
  const keys = ['当前模型不支持图片', '图片发送失败'];
  const missingKeys = keys.filter((k) => !content.includes(k));
  report(missingKeys.length === 0 ? 'PASS' : 'FAIL', '截图补救 i18n 文案存在', missingKeys.length ? '缺失：' + missingKeys.join(',') + '（' + convFile + '）——需同步 packages/settings-update/client.js 的匹配文案' : keys.join(' / '));
} else {
  report('WARN', 'conversation 客户端包未找到', '跳过文案检查（' + convCandidates.join(' | ') + '）');
}

/* 5. web.patch.yml 内容（预期含桌面端插件行） */
if (fs.existsSync(PATCH_FILE)) {
  const patchText = fs.readFileSync(PATCH_FILE, 'utf8');
  const expected = ['@dsh-desktop/settings-update', '@dsh-desktop/subagent-approval', '@deepseek-ai/dsh-mcp-client'];
  const missingRows = expected.filter((n) => !patchText.includes(n));
  report(missingRows.length === 0 ? 'PASS' : 'FAIL', 'web.patch.yml 含预期插件行', missingRows.length ? '缺失行：' + missingRows.join(',') + '（' + PATCH_FILE + '）' : expected.join(' / '));
} else {
  report('WARN', 'web.patch.yml 不存在', PATCH_FILE + '（未生成过 patch？）');
}

/* 6. 会话存储格式：最新 session.jsonl.zstd 可解压出帧 */
try {
  const sessionsRoot = path.join(DSH_HOME, 'sessions');
  if (!fs.existsSync(sessionsRoot)) throw new Error('sessions 目录不存在：' + sessionsRoot);
  let best = null;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'session.jsonl.zstd') {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (!best || m > best.m) best = { file: full, m };
        } catch { /* 忽略 */ }
      }
    }
  };
  walk(sessionsRoot);
  if (!best) throw new Error('未找到任何 session.jsonl.zstd');
  const { decompressFrames } = require('../main/usage');
  const text = decompressFrames(fs.readFileSync(best.file));
  const frames = String(text).split('\n').filter((l) => l.trim().startsWith('{')).length;
  report(frames > 0 ? 'PASS' : 'FAIL', '会话帧可解压（存储格式未变）', best.file + ' → ' + frames + ' 帧');
} catch (err) {
  report('WARN', '会话格式检查跳过', (err && err.message) || String(err));
}

/* 汇总 */
console.log('check-harness-contract：dshHome=' + DSH_HOME + '（dsh v' + dshVersion + '）\n');
for (const l of lines) console.log(l);
console.log('\n---- summary: PASS ' + pass + ' / WARN ' + warn + ' / FAIL ' + fail + ' ----');
if (fail > 0) {
  console.log('\n发现 FAIL：请对照仓库根 UPGRADE-PLAYBOOK.md 处置后再启动/升级。');
  process.exit(1);
}
if (warn > 0) process.exit(2);
process.exit(0);
