'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');

/**
 * Ollama 本地视觉模型集成（一键安装/启动/拉取，无需用户手动配置）：
 *  - 下载官方 Windows 便携包（ollama-windows-amd64.zip）到 %LOCALAPPDATA%\dsh-desktop\ollama
 *  - 启动 `ollama serve`（127.0.0.1:11434），拉取视觉模型（qwen2.5vl:3b 等）
 *  - 一键把视觉模型写入多模态设置（baseUrl=http://127.0.0.1:11434/v1，无需 apiKey）
 */

const ZIP_URL = 'https://ollama.com/download/ollama-windows-amd64.zip';
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const API_BASE = 'http://' + OLLAMA_HOST + ':' + OLLAMA_PORT;

/** 官方视觉模型推荐（名字 + 体积说明）。纯 CPU 场景 3b 优先：7b 单次推理可达数分钟。 */
const VISION_MODELS = [
  { name: 'qwen2.5vl:3b', size: '约 2.2GB', note: '推荐（CPU 场景）：比 7b 快数倍，中文识别够用' },
  { name: 'qwen2.5vl:7b', size: '约 5.9GB', note: '识别最准、中文最好，但纯 CPU 单次推理可能 1~8 分钟' },
  { name: 'llava:7b', size: '约 4.7GB', note: '经典多模态模型' },
  { name: 'llama3.2-vision:11b', size: '约 7.9GB', note: '英文强，体积最大' },
];

let serveChild = null;

function ollamaDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-desktop', 'ollama');
}

/** 记录真实可执行文件路径的标记文件（解压后 exe 与其 DLL 同目录，必须从那里运行）。 */
function markerFile() {
  return path.join(ollamaDir(), 'install.json');
}

/**
 * 解析可用的 ollama.exe 真实路径：
 * 1. 安装时记录的 install.json（优先）；
 * 2. 目录树里能找到、且其所在目录（或其 lib/ollama 子目录）存在 DLL 的 ollama.exe。
 * 官方便携包布局：ollama.exe 位于根目录，DLL 在 lib/ollama/ 下（相对路径加载），
 * 因此绝不能把 exe 单独复制到别处。
 */
function ollamaBin() {
  try {
    const marker = markerFile();
    if (fs.existsSync(marker)) {
      const doc = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (doc && typeof doc.exe === 'string' && fs.existsSync(doc.exe)) return doc.exe;
    }
  } catch { /* 继续探测 */ }
  let found = null;
  (function walk(base, depth) {
    if (found || depth > 5) return;
    try {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (e.isFile() && e.name.toLowerCase() === 'ollama.exe') {
          const dir = base;
          const dllHere = fs.existsSync(path.join(dir, 'ggml.dll')) || fs.existsSync(path.join(dir, 'ggml-base.dll'));
          const dllLib = fs.existsSync(path.join(dir, 'lib', 'ollama', 'ggml.dll')) || fs.existsSync(path.join(dir, 'lib', 'ollama', 'ggml-base.dll'));
          if (dllHere || dllLib) { found = path.join(dir, e.name); return; }
        } else if (e.isDirectory()) {
          walk(path.join(base, e.name), depth + 1);
        }
      }
    } catch { /* 忽略 */ }
  })(ollamaDir(), 0);
  return found;
}

/** 简单 HTTP GET（JSON）。 */
function httpJson(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (err) { reject(new Error('响应不是合法 JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
  });
}

/** 查询 Ollama 状态：已安装 / 是否运行 / 版本 / 已拉取模型。port 仅用于测试。 */
async function getStatus({ port = OLLAMA_PORT } = {}) {
  const apiBase = 'http://' + OLLAMA_HOST + ':' + port;
  const bin = ollamaBin();
  const installed = !!bin;
  let version = null;
  if (installed) {
    // 异步 spawn：spawnSync 会阻塞 Electron 主进程（设置页/状态栏每 10~60s 轮询一次，
    // 每次拉起 ollama.exe --version 约 100~300ms，是"只要使用就卡顿"的来源之一）。
    version = await new Promise((resolveV) => {
      try {
        const p = spawn(bin, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        const timer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } resolveV(null); }, 8000);
        p.stdout.on('data', (c) => { out += String(c); });
        p.on('error', () => { clearTimeout(timer); resolveV(null); });
        p.on('close', () => {
          clearTimeout(timer);
          // 兼容两种输出：旧版 "ollama version 0.3.1" / 新版 "ollama version is 0.32.11"
          const m = /version\s+(?:is\s+)?(\S+)/.exec(out);
          resolveV(m ? m[1] : out.trim() || null);
        });
      } catch { resolveV(null); }
    });
  }
  let running = false;
  let models = [];
  let serverError = null;
  try {
    const v = await httpJson(apiBase + '/api/version');
    running = v.status === 200;
  } catch (err) {
    serverError = (err && err.message) || String(err);
  }
  if (running) {
    try {
      const tags = await httpJson(apiBase + '/api/tags');
      if (tags.status === 200 && tags.json && Array.isArray(tags.json.models)) {
        models = tags.json.models.map((m) => ({ name: m.name, size: m.size }));
      }
    } catch { /* 忽略 */ }
  }
  return { installed, version, running, models, serverError, apiBase, bin };
}

/** 下载文件（带进度回调）。 */
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'dsh-desktop-ollama' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, dest, onProgress));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('下载失败：HTTP ' + res.statusCode)); return; }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(dest + '.part');
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total > 0) {
          const pct = Math.floor(received / total * 100);
          if (pct !== lastPct) { lastPct = pct; onProgress({ percent: pct, received, total }); }
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        try { fs.renameSync(dest + '.part', dest); } catch (err) { reject(err); return; }
        resolve({ bytes: received });
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('下载超时')));
  });
}

/** 用 PowerShell Expand-Archive 解压 zip。 */
function extractZip(zip, destDir) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; ' +
      'Expand-Archive -LiteralPath ' + JSON.stringify(zip) + ' -DestinationPath ' + JSON.stringify(destDir) + ' -Force',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    ps.stderr.on('data', (c) => { err += String(c); });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('解压失败（退出码 ' + code + '）：' + err.slice(0, 300)));
    });
  });
}

/**
 * 安装 Ollama（下载官方便携包 + 解压）。幂等：已安装直接返回。
 * @param {(p: {stage: string, text: string, percent?: number}) => void} onProgress
 */
async function install(onProgress = () => {}) {
  const dir = ollamaDir();
  if (ollamaBin()) { onProgress({ stage: 'done', text: '已安装', percent: 100 }); return { installed: true }; }
  onProgress({ stage: 'download', text: '正在下载 Ollama 便携包（约 700MB，视网速需要几分钟）…', percent: 0 });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'ollama.zip');
  const tmp = path.join(dir, '.extract');
  await download(ZIP_URL, zip, (p) => onProgress({ stage: 'download', text: '下载中 ' + p.percent + '%（' + Math.round(p.received / 1024 / 1024) + 'MB / ' + Math.round(p.total / 1024 / 1024) + 'MB）', percent: p.percent }));
  onProgress({ stage: 'extract', text: '正在解压…', percent: 100 });
  fs.rmSync(tmp, { recursive: true, force: true });
  await extractZip(zip, tmp);
  // 找到与 DLL 同目录的 ollama.exe（便携包结构：lib/ollama/ollama.exe），
  // 记录其真实路径——绝不能把 exe 单独复制出来，否则找不到 DLL 无法运行。
  const bin = ollamaBin();
  if (!bin || !bin.startsWith(dir + path.sep)) throw new Error('解压后未找到可用的 ollama.exe，请检查下载包是否完整');
  fs.writeFileSync(markerFile(), JSON.stringify({ exe: bin, installedAt: Date.now() }, null, 2) + '\n', 'utf8');
  fs.rmSync(zip, { force: true });
  onProgress({ stage: 'done', text: '安装完成', percent: 100 });
  return { installed: true };
}

/** 启动 ollama serve（幂等）。numGpu 可强制服务级 GPU 层数（'0' = 纯 CPU）：
 *  显存不足时请求级 num_gpu 拦不住 llama-server 初始化 CUDA，必须用环境变量重启服务。 */
async function start({ numGpu } = {}) {
  const bin = ollamaBin();
  if (!bin) throw new Error('Ollama 尚未安装');
  try { const v = await httpJson(API_BASE + '/api/version'); if (v.status === 200) return { running: true }; } catch { /* 未运行 */ }
  if (serveChild && serveChild.exitCode === null) return { running: true };
  serveChild = spawn(bin, ['serve'], {
    cwd: path.dirname(bin),
    env: {
      ...process.env,
      OLLAMA_HOST: OLLAMA_HOST + ':' + OLLAMA_PORT,
      OLLAMA_KEEP_ALIVE: '30m',
      ...(numGpu !== undefined && numGpu !== null ? { OLLAMA_NUM_GPU: String(numGpu) } : {}),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  serveChild.on('exit', () => { serveChild = null; });
  // 等 /api/version 就绪
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const v = await httpJson(API_BASE + '/api/version');
      if (v.status === 200) return { running: true, version: v.json && v.json.version };
    } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Ollama 服务启动超时');
}

/** 拉取模型（流式输出进度）。 */
function pull(model, onOutput = () => {}) {
  const bin = ollamaBin();
  if (!bin) return Promise.reject(new Error('Ollama 尚未安装'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['pull', model], {
      cwd: path.dirname(bin),
      env: { ...process.env, OLLAMA_HOST: OLLAMA_HOST + ':' + OLLAMA_PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const feed = (chunk) => { for (const line of String(chunk).split(/\r?\n/)) { const t = line.trim(); if (t) onOutput(t); } };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', reject);
    child.on('close', (code) => { if (code === 0) resolve(); else reject(new Error('拉取模型失败（退出码 ' + code + '）')); });
  });
}

/** 查询 NVIDIA 显存可用量（MB）。无 NVIDIA GPU/驱动失败时返回 null（视为无 GPU）。 */
function detectGpuMemory({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      const p = spawn('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => { try { p.kill(); } catch { /* 忽略 */ } resolve(null); }, timeoutMs);
      p.stdout.on('data', (c) => { out += String(c); });
      p.on('error', () => { clearTimeout(timer); resolve(null); });
      p.on('close', () => {
        clearTimeout(timer);
        const vals = out.split(/\r?\n/).map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
        resolve(vals.length ? Math.max(...vals) : null);
      });
    } catch { resolve(null); }
  });
}

/** 杀掉便携安装目录（ollamaDir）下残留的 llama-server 孤儿（同步，PowerShell 路径过滤）。
 *  只杀本便携安装的进程，不误伤用户自装的独立 Ollama。 */
function killPortableLlamaServers() {
  if (process.platform !== 'win32') return;
  try {
    const dir = ollamaDir().toLowerCase().replace(/'/g, "''");
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'llama-server.exe\'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith(\'' + dir + '\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  } catch { /* 清理失败不影响主流程 */ }
}

/** 停止 ollama serve（含便携目录下残留的 llama-server 孤儿）。
 *  CUDA 崩溃/被强杀后 llama-server 可能脱离进程树成为孤儿（曾出现 6 个僵尸
 *  吃满 4GB 显存、3b 无法上 GPU 的案例），taskkill /T 之后按路径兜底清理。 */
function stop() {
  if (serveChild && serveChild.exitCode === null) {
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/pid', String(serveChild.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* 忽略 */ }
    } else {
      try { serveChild.kill('SIGTERM'); } catch { /* 忽略 */ }
    }
  }
  serveChild = null;
  killPortableLlamaServers();
}

/** 启动前清理僵尸 llama-server（应用崩溃/强杀后残留的 llama-server 不监听 11434，
 *  但一直占显存；反复重启会积累，曾出现 6 个吃满 4GB）。
 *  仅当 11434 无服务在监听时执行——有服务说明 llama-server 属于活动实例，绝不能动。 */
async function cleanupOrphans() {
  try {
    const v = await httpJson(API_BASE + '/api/version');
    if (v.status === 200) return; // 服务活着：跳过
  } catch { /* 无服务监听，继续清理 */ }
  killPortableLlamaServers();
}

/**
 * 判断 baseUrl 是否指向本地 Ollama 服务：主机为 127.0.0.1/localhost 且端口为 11434。
 * 纯函数（无副作用，不做网络请求），供桌面端启动早期判断是否应自动拉起本地 Ollama。
 * @param {string|undefined|null} baseUrl 多模态设置里的 baseUrl（如 http://127.0.0.1:11434/v1）
 * @returns {boolean}
 */
function isLocalOllama(baseUrl) {
  if (typeof baseUrl !== 'string') return false;
  const url = baseUrl.trim().toLowerCase();
  if (!url) return false;
  const hostIsLocal = url.includes('127.0.0.1') || url.includes('localhost');
  return hostIsLocal && url.includes('11434');
}

module.exports = { getStatus, install, start, pull, stop, detectGpuMemory, ollamaBin, ollamaDir, API_BASE, VISION_MODELS, isLocalOllama, cleanupOrphans };
