'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

/**
 * Windows 系统环境助手：体检（PATH 工具/LongPaths/开发者模式/执行策略/UTF-8/winget）、
 * 一键修复、用户环境变量管理（HKCU\Environment）、winget 安装、右键菜单集成。
 * 目的：把 Windows 控制台生态的常见坑填平，让桌面端像 macOS 一样"直接"。
 */

function ps(args, { timeoutMs = 30000, encoding = 'utf8' } = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], {
    encoding, timeout: timeoutMs, windowsHide: true,
  });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

/** 检查命令是否在 PATH 可用。 */
function commandVersion(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: true });
    if (r.status === 0) return String(r.stdout || '').trim().split(/\r?\n/)[0].slice(0, 60);
    return null;
  } catch { return null; }
}

function regQuery(path) {
  const r = spawnSync('reg', ['query', path], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return r.status === 0 ? String(r.stdout || '') : null;
}

function regValue(text, name) {
  if (!text) return null;
  const re = new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\S+\\s+(.+)$', 'm');
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

/** 系统体检：返回检查项列表。 */
/** 注册表 PATH（系统+用户）中是否包含某片段（如 Git\\cmd）。 */
function registryPathContains(needle) {
  const sys = regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  const user = regQuery('HKCU\\Environment');
  return String(sys || '').includes(needle) || String(user || '').includes(needle);
}

function doctor() {
  const items = [];
  const add = (id, title, ok, detail, fix) => items.push({ id, title, ok, detail: detail || '', fix: fix || null });

  const node = commandVersion('node');
  const npm = commandVersion('npm');
  const git = commandVersion('git');
  const winget = commandVersion('winget');
  add('node', 'Node.js（PATH 可用）', !!node, node || '未找到——大部分工具链需要它', { type: 'winget', id: 'OpenJS.NodeJS.LTS' });
  // git：当前进程环境可能滞后，再查注册表 PATH 与默认安装位置
  const gitOnDisk = fs.existsSync('C:\\Program Files\\Git\\cmd\\git.exe') || registryPathContains('Git\\cmd');
  add('git', 'Git（PATH 可用）', !!(git || gitOnDisk),
    git || (gitOnDisk ? '已安装（当前进程 PATH 滞后，重启桌面端后生效）' : '未找到'),
    gitOnDisk ? null : { type: 'winget', id: 'Git.Git' });
  add('npm', 'npm', !!npm, npm || '随 Node 安装', { type: 'winget', id: 'OpenJS.NodeJS.LTS' });
  add('winget', 'winget（Windows 的包管理器）', !!winget, winget || '未找到（Win10/11 自带；缺失可手动安装 App Installer）', null);

  const longPath = regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem');
  const longPathValue = regValue(longPath, 'LongPathsEnabled');
  add('longpath', '长路径支持（>260 字符）', longPathValue === '0x1', longPathValue === '0x1' ? '已启用' : '未启用——深目录/长文件名会报错', { type: 'admin', id: 'longpath' });

  const devMode = regQuery('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock');
  const devModeValue = regValue(devMode, 'AllowDevelopmentWithoutDevLicense');
  add('devmode', '开发者模式（符号链接/junction 可用）', devModeValue === '0x1', devModeValue === '0x1' ? '已启用' : '未启用——npm/pnpm 链接会失败', { type: 'admin', id: 'devmode' });

  const exec = ps(['Get-ExecutionPolicy -Scope CurrentUser']);
  add('execpolicy', 'PowerShell 执行策略（CurrentUser）', ['RemoteSigned', 'Unrestricted', 'Bypass'].includes(exec.out), exec.out || '未知', { type: 'simple', id: 'execpolicy' });

  // 控制台 CodePage 是 REG_DWORD，reg query 输出十六进制（65001 → 0xfde9）
  const consoleCpRaw = regValue(regQuery('HKCU\\Console'), 'CodePage');
  const cpNum = consoleCpRaw && /^0x/i.test(consoleCpRaw) ? parseInt(consoleCpRaw, 16) : parseInt(consoleCpRaw, 10);
  const utf8 = cpNum === 65001;
  add('utf8', '控制台默认 UTF-8（避免中文乱码）', utf8, utf8 ? '已设置' : '未设置——PowerShell/node 输出中文可能乱码', { type: 'simple', id: 'utf8' });

  return items;
}

/** 应用修复。type=admin 的修复需要管理员权限（自动尝试提权执行）。 */
function applyFix(fix) {
  if (!fix) return { ok: false, error: '无可用修复' };
  if (fix.type === 'simple' && fix.id === 'execpolicy') {
    const r = ps(['Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force; Get-ExecutionPolicy -Scope CurrentUser']);
    return r.code === 0 ? { ok: true, detail: r.out } : { ok: false, error: r.err || r.out };
  }
  if (fix.type === 'simple' && fix.id === 'utf8') {
    // HKCU\Console 默认代码页 + cmd 专用项
    const r1 = spawnSync('reg', ['add', 'HKCU\\Console', '/v', 'CodePage', '/t', 'REG_DWORD', '/d', '65001', '/f'], { encoding: 'utf8', windowsHide: true });
    const r2 = spawnSync('reg', ['add', 'HKCU\\Console\\%SystemRoot%_system32_cmd.exe', '/v', 'CodePage', '/t', 'REG_DWORD', '/d', '65001', '/f'], { encoding: 'utf8', windowsHide: true });
    return r1.status === 0 ? { ok: true, detail: '已设置控制台 UTF-8（新开终端生效）' } : { ok: false, error: String(r1.stderr || '') };
  }
  if (fix.type === 'admin' && fix.id === 'longpath') {
    return runElevated('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f');
  }
  if (fix.type === 'admin' && fix.id === 'devmode') {
    return runElevated('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock" /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 1 /f');
  }
  return { ok: false, error: '未知修复项' };
}

/** 提权执行一条命令（UAC 弹窗确认）。 */
function runElevated(command) {
  const bat = path.join(os.tmpdir(), 'dsh-elevated-' + Date.now() + '.bat');
  fs.writeFileSync(bat, '@echo off\r\n' + command + '\r\n', 'utf8');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    'Start-Process -FilePath ' + JSON.stringify(bat) + ' -Verb RunAs -Wait'], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
  });
  try { fs.unlinkSync(bat); } catch { /* 忽略 */ }
  if (r.status !== 0) return { ok: false, error: '提权执行失败：' + String(r.stderr || r.stdout).slice(0, 200) };
  return { ok: true, detail: '已执行（请重新体检确认）' };
}

/** 用户环境变量：读取。 */
function envGet(name) {
  const r = ps(['[Environment]::GetEnvironmentVariable(' + JSON.stringify(name) + ', "User")']);
  return r.code === 0 ? r.out : null;
}

/** 用户环境变量：设置（PowerShell 自带广播，立即生效于新进程）。 */
function envSet(name, value) {
  const r = ps(['[Environment]::SetEnvironmentVariable(' + JSON.stringify(name) + ', ' + JSON.stringify(String(value)) + ', "User")']);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.err || r.out };
}

/** 用户环境变量：删除。 */
function envRemove(name) {
  const r = ps(['[Environment]::SetEnvironmentVariable(' + JSON.stringify(name) + ', $null, "User")']);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.err || r.out };
}

/** 列出常用用户环境变量（含 PATH 各条目）。 */
function envList() {
  const vars = {};
  for (const name of ['PATH', 'NODE_ENV', 'GITHUB_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY']) {
    const v = envGet(name);
    if (v !== null) vars[name] = v;
  }
  return vars;
}

/** winget 安装（流式输出）。 */
function wingetInstall(packageId, onOutput = () => {}, onExit = () => {}) {
  const child = spawn('winget', ['install', '--id', packageId, '-e', '--accept-source-agreements', '--accept-package-agreements'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true,
  });
  const feed = (chunk) => { for (const line of String(chunk).split(/\r?\n/)) { const t = line.trim(); if (t) onOutput(t); } };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('error', (err) => onExit({ ok: false, error: err.message }));
  child.on('close', (code) => onExit({ ok: code === 0, code }));
  return {
    cancel() { try { child.kill(); } catch { /* 忽略 */ } },
  };
}

/* ---- 右键菜单集成（把文件/文件夹交给 harness） ---- */

const CONTEXT_KEY = 'HKCU\\Software\\Classes';

function contextMenuCommand(target) {
  // 通过 second-instance 把路径带回运行中的桌面端
  return '"' + process.execPath + '" "' + (process.env.DSH_APP_DIR || path.join(__dirname, '..')) + '" --from-context "' + target + '"';
}

/** 注册右键菜单：文件与文件夹的“交给 DSH 处理”。 */
function registerContextMenu() {
  const cmds = [
    ['*', 'shell', 'DSH', '交给 DSH 处理'],
    ['*', 'shell', 'DSH', 'command', contextMenuCommand('%1')],
    ['Directory', 'shell', 'DSH', '在 DSH 中处理此文件夹'],
    ['Directory', 'shell', 'DSH', 'command', contextMenuCommand('%1')],
    ['Directory\\Background', 'shell', 'DSH', '在此文件夹打开 DSH'],
    ['Directory\\Background', 'shell', 'DSH', 'command', contextMenuCommand('%V')],
  ];
  for (const item of cmds) {
    const key = [CONTEXT_KEY].concat(item.slice(0, -1)).join('\\');
    const value = item[item.length - 1];
    const args = item.length === 4 ? ['add', key, '/ve', '/d', value, '/f'] : ['add', key, '/ve', '/d', value, '/f'];
    const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return { ok: false, error: String(r.stderr || '注册失败').slice(0, 200) };
  }
  return { ok: true };
}

/** 移除右键菜单。 */
function unregisterContextMenu() {
  for (const base of ['*', 'Directory', 'Directory\\Background']) {
    spawnSync('reg', ['delete', CONTEXT_KEY + '\\' + base + '\\shell\\DSH', '/f'], { encoding: 'utf8', windowsHide: true });
  }
  return { ok: true };
}

function isContextMenuRegistered() {
  const r = spawnSync('reg', ['query', CONTEXT_KEY + '\\*\\shell\\DSH'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

module.exports = {
  doctor, applyFix, envGet, envSet, envRemove, envList,
  wingetInstall, registerContextMenu, unregisterContextMenu, isContextMenuRegistered,
};
