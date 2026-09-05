'use strict';

/**
 * Office/WPS 应用通道（Windows COM 自动化；与 office-docx.js 的文件级通道互补）。
 *
 * detectOffice()      ：只读探测本机 Office 环境（注册表 App Paths + 常见路径 +
 *                       COM ProgID），不启动 Office 应用；
 * verifyWordCom()     ：真实创建 Word.Application（detect 深度版，首次约数秒）；
 * exportDocxToPdf()   ：Word/WPS 无头打开 docx → 另存 PDF（排版与字体走真实应用）；
 * openInWord()        ：Word 可见打开文档给用户（配合 computer_* 后续操控窗口）。
 *
 * PowerShell 脚本：scripts/office-com/word.ps1（纯 ASCII；stdout 只回 OK/ERR，
 * 结果 JSON 写临时文件避免编码损坏）。exec 可注入便于单测。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'office-com', 'word.ps1');

/** 解析 PowerShell 可执行文件（优先 pwsh，其次系统 powershell）。 */
function resolvePowerShell() {
  const candidates = [];
  if (process.env.PATH) {
    for (const dir of String(process.env.PATH).split(path.delimiter)) {
      if (!dir) continue;
      candidates.push(path.join(dir, 'pwsh.exe'), path.join(dir, 'powershell.exe'));
    }
  }
  candidates.push(
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  );
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 继续找 */ }
  }
  return null;
}

/**
 * 注册表 App Paths 值读取（reg query 输出解析）。exec 注入式（单测用 fake）。
 * @returns {Promise<{winword:string|null, excel:string|null}>}
 */
async function queryAppPaths({ exec } = {}) {
  const doExec = exec || ((cmd, args, opts) => new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  }));
  const parse = (stdout) => {
    const m = String(stdout).match(/\(Default\)\s+REG_SZ\s+(.+)$/im) || String(stdout).match(/\(default\)\s+REG_SZ\s+(.+)$/im);
    return m ? m[1].trim() : null;
  };
  const out = { winword: null, excel: null };
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
  for (const [name, app] of [['winword', 'WINWORD.EXE'], ['excel', 'EXCEL.EXE']]) {
    try {
      const r = await doExec('reg', ['query', key + '\\' + app, '/ve'], { timeout: 8000, windowsHide: true });
      out[name] = parse(r.stdout);
    } catch { /* 未安装该应用 */ }
  }
  return out;
}

/** 常见安装路径兜底探测（Click-to-Run / 经典 MSI 布局）。 */
function probeCommonPaths() {
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
  ].filter(Boolean);
  const found = { winword: null, excel: null };
  for (const root of roots) {
    if (!found.winword) {
      for (const p of [
        path.join(root, 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'),
        path.join(root, 'Microsoft Office', 'Office16', 'WINWORD.EXE'),
      ]) {
        try { if (fs.statSync(p).isFile()) { found.winword = p; break; } } catch { /* 下一个 */ }
      }
    }
    if (!found.excel) {
      for (const p of [
        path.join(root, 'Microsoft Office', 'root', 'Office16', 'EXCEL.EXE'),
        path.join(root, 'Microsoft Office', 'Office16', 'EXCEL.EXE'),
      ]) {
        try { if (fs.statSync(p).isFile()) { found.excel = p; break; } } catch { /* 下一个 */ }
      }
    }
  }
  return found;
}

/**
 * 只读探测 Office 环境（不启动应用）。
 * @returns {Promise<{word:{available:boolean,kind:string|null,exe:string|null},
 *  excel:{available:boolean,kind:string|null,exe:string|null},ps:boolean}>}
 */
async function detectOffice({ exec } = {}) {
  const paths = { ...probeCommonPaths() };
  try {
    const appPaths = await queryAppPaths({ exec });
    if (!paths.winword && appPaths.winword) paths.winword = appPaths.winword;
    if (!paths.excel && appPaths.excel) paths.excel = appPaths.excel;
  } catch { /* 注册表不可用则只靠路径探测 */ }
  return {
    word: {
      available: !!paths.winword,
      kind: paths.winword ? (String(paths.winword).toLowerCase().includes('kingsoft') ? 'wps' : 'ms-office') : null,
      exe: paths.winword,
    },
    excel: {
      available: !!paths.excel,
      kind: paths.excel ? (String(paths.excel).toLowerCase().includes('kingsoft') ? 'wps' : 'ms-office') : null,
      exe: paths.excel,
    },
    ps: !!resolvePowerShell(),
  };
}

/** PowerShell 解析器（可注入替换，供单测；仿 github.js setTransportForTest 模式）。 */
let shellResolver = resolvePowerShell;
function setShellResolverForTest(fn) {
  shellResolver = fn;
}

/**
 * 调用 scripts/office-com/word.ps1 的通用入口。
 * stdout 只作 OK/ERR 标记；结果 JSON 写临时文件（规避控制台编码问题）。
 */
function runWordPs({ action, inPath, outPath, timeoutMs = 180000, ps, exec } = {}) {
  return new Promise((resolve) => {
    const shell = ps || shellResolver();
    if (!shell) return resolve({ ok: false, error: '未找到 PowerShell，无法执行 Office COM 自动化' });
    const jsonPath = path.join(os.tmpdir(), 'dsh-office-com-' + process.pid + '-' + Date.now() + '.json');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-Action', action, '-Json', jsonPath];
    if (inPath) args.push('-In', String(inPath));
    if (outPath) args.push('-Out', String(outPath));
    const doExec = exec || execFile;
    doExec(shell, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const read = () => {
        try {
          const raw = fs.readFileSync(jsonPath, 'utf8');
          return JSON.parse(raw.replace(/^\uFEFF/, ''));
        } catch { return null; }
      };
      if (err) {
        try { fs.rmSync(jsonPath, { force: true }); } catch { /* 忽略 */ }
        // EPERM/ENOENT/超时等进程级失败
        return resolve({ ok: false, error: err.code === 'ETIMEDOUT' ? 'Office 操作超时（' + timeoutMs + 'ms）' : (err.message || String(err)) });
      }
      const data = read();
      try { fs.rmSync(jsonPath, { force: true }); } catch { /* 忽略 */ }
      if (data) return resolve(data);
      const tail = [String(stdout), String(stderr)].join(' | ').trim().slice(0, 400);
      return resolve({ ok: false, error: 'Office 脚本无结果输出' + (tail ? '：' + tail : '') });
    });
  });
}

/** 深度检测：真实创建 Word.Application（返回版本号；无 Office 时给可读错误）。 */
function verifyWordCom({ ps, exec } = {}) {
  return runWordPs({ action: 'detect', ps, exec });
}

/** Word 无头打开 docx 另存 PDF（排版/字体与 Word 一致）。 */
function exportDocxToPdf({ docxPath, pdfPath, ps, exec } = {}) {
  return runWordPs({ action: 'export-pdf', inPath: docxPath, outPath: pdfPath, ps, exec });
}

/** Word 可见打开文档（保持打开，供用户查看/后续 GUI 操控）。 */
function openInWord({ docxPath, ps, exec } = {}) {
  return runWordPs({ action: 'open', inPath: docxPath, ps, exec, timeoutMs: 60000 });
}

module.exports = {
  resolvePowerShell,
  setShellResolverForTest,
  detectOffice,
  queryAppPaths,
  verifyWordCom,
  exportDocxToPdf,
  openInWord,
  runWordPs,
  SCRIPT,
};
