'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Windows 操控助手：管理 win-control.exe（C# 编译的 user32 操控工具）。
 * 首次使用时用 PowerShell Add-Type 编译 main/win-control.cs 到
 * %APPDATA%\dsh-desktop\bin\win-control.exe，之后直接调用（毫秒级启动）。
 */

const CS_SOURCE = path.join(__dirname, 'win-control.cs');
const BIN_DIR = path.join(process.env.APPDATA || path.join(__dirname, '..'), 'dsh-desktop', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'win-control.exe');

function compiled() {
  return fs.existsSync(BIN_PATH);
}

/** C# 源码比已编译 exe 新时需重新编译（开发期改 win-control.cs 后自动生效）。 */
function needsRecompile() {
  try {
    return fs.statSync(CS_SOURCE).mtimeMs > fs.statSync(BIN_PATH).mtimeMs;
  } catch { return true; }
}

/** 编译 win-control.exe（幂等；源码更新后自动重编）。返回 exe 路径或抛错。 */
function ensureCompiled() {
  if (compiled() && !needsRecompile()) return BIN_PATH;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  try { fs.unlinkSync(BIN_PATH); } catch { /* 不存在则忽略 */ }
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; ' +
    // 必须显式 UTF-8 读取：PS 5.1 的 Get-Content 会把无 BOM 的 UTF-8 源码当 GBK 读，中文注释/字符串全乱（编译失败）
    'Add-Type -TypeDefinition ([System.IO.File]::ReadAllText(' + JSON.stringify(CS_SOURCE) + ', [System.Text.Encoding]::UTF8)) ' +
    '-ReferencedAssemblies System.Windows.Forms,System.Drawing ' +
    '-OutputAssembly ' + JSON.stringify(BIN_PATH) + ' -OutputType ConsoleApplication',
  ], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (ps.status !== 0 || !compiled()) {
    throw new Error('编译 Windows 操控助手失败：' + String((ps.stderr || ps.stdout || '').split('\n')[0] || '未知错误').slice(0, 300));
  }
  return BIN_PATH;
}

/** 执行一个操控动作。args 形如 ['mouse','click','--x','100','--y','200']。 */
function exec(args, { timeoutMs = 15000 } = {}) {
  const bin = ensureCompiled();
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  if (r.error) throw new Error('执行操控动作失败：' + r.error.message);
  let doc = null;
  try { doc = JSON.parse((r.stdout || '').trim()); } catch { /* 非 JSON 输出 */ }
  if (r.status !== 0) {
    throw new Error((doc && doc.error) || ('操控动作失败（退出码 ' + r.status + '）：' + String(r.stderr || r.stdout || '').slice(0, 200)));
  }
  if (doc && doc.error) throw new Error(doc.error);
  return doc || { ok: true };
}

module.exports = { exec, ensureCompiled, BIN_PATH };
