'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, Notification, desktopCapturer, clipboard, nativeImage, screen, Tray, globalShortcut } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { Settings } = require('./settings');
const { HarnessController, pickFreePort } = require('./harness');
const updater = require('./updater');
const { runHeadless } = require('./headless');
const { DesktopRpcServer } = require('./desktop-rpc');
const { generateWebPatch, ensureClientPackageLink, providerEnvKey } = require('./web-patch');
const { runDshPlugin } = require('./plugin-cli');
const { scanWorkspaceUsage, queryBalance, workspaceSessionKey, resolvePriceTier, decompressFrames, resolveDeepSeekKey } = require('./usage');
const { describeImage, testVision, modelSupportsVision, readCurrentModel } = require('./vision');
const { startCompletionWatcher } = require('./notify');
const { inQuietHours } = require('./quiet-hours');
const memoryStore = require('./memory-store');
const { startAutoMemory } = require('./memory-watch');
const subagentCenter = require('./subagent-center');
const { gitSummary, gitInit, gitHead, gitStatus, gitDiff, gitLog, gitCommit, gitBranch, gitCheckout, gitRestore, gitStash, gitCurrentBranch, gitRemoteList, gitRemoteAdd, gitPush, gitPull, gitMerge } = require('./git-runner');
const githubOps = require('./github');
const projectMap = require('./project-map');
const workspaceGuard = require('./workspace-guard');
const uiIntrospect = require('./ui-introspect');
const { ensureNorms, NORM_VERSION } = require('./agents-norms');
const ollama = require('./ollama');
const winControl = require('./win-control');
const { Scheduler, afterFireUpdate } = require('./schedule');
const systemOps = require('./system');
const backupOps = require('./backup');
const { startContextWatcher, findActiveSession } = require('./context-watch');
const { archiveLargeSessions } = require('./session-archive');
const yaml = require('js-yaml');
const taskDispatch = require('./task-dispatch');

const APP_DIR = path.join(__dirname, '..');
process.env.DSH_APP_DIR = APP_DIR;
const BIN_PATH = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
// 应用图标（官方 dsh 灰色鲸鱼，scripts/generate-icons.js 从官方 favicon 生成）。
// renderer/ 会被打进安装包，dev 与打包模式共用同一路径。
const WINDOW_ICON = path.join(APP_DIR, 'renderer', 'icon.png');

// 打包模式：dsh 安装在可写目录（%APPDATA%\dsh-desktop\dsh），无系统 Node 也能自更新；
// 开发模式：仓库里的 node_modules（保留快速迭代）。
const PACKAGED_DSH_DIR = () => path.join(app.getPath('userData'), 'dsh');
function dshBinPath() {
  if (app.isPackaged) {
    const p = path.join(PACKAGED_DSH_DIR(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(p)) return p;
  }
  return BIN_PATH;
}
function dshInstallDir() {
  return app.isPackaged ? PACKAGED_DSH_DIR() : APP_DIR;
}

// 固定用户数据目录为 %APPDATA%\dsh-desktop，必须在首次 getPath('userData') 之前调用。
app.setPath('userData', path.join(app.getPath('appData'), 'dsh-desktop'));

// 关闭 GPU 硬件加速：聊天/界面类 UI 软件渲染足够流畅，规避个别显卡驱动崩溃。
app.disableHardwareAcceleration();

let mainWindow = null;
let headlessWindow = null;
let harness = null;
let headlessRunner = null;
let pluginRunner = null;
let completionWatcher = null;
let autoMemoryWatcher = null;
let contextWatcher = null;
let scheduler = null;
let quickWindow = null;
let captureWindow = null;
let gitDiffWindow = null;
let tray = null;
let quitting = false;

// The subagent view is refreshed by more than one renderer component. A full
// scan decompresses every session file, so keep it off the Electron main
// thread, share an in-flight scan, and briefly cache its result.
const SUBAGENTS_CACHE_TTL_MS = 30000;
let subagentsCacheKey = null;
let subagentsCacheAt = 0;
let subagentsCacheResult = null;
let subagentsCachePending = null;
let subagentWorker = null;
let subagentWorkerRequestId = 0;
const subagentWorkerPending = new Map();

function ensureSubagentWorker() {
  if (subagentWorker) return subagentWorker;

  const worker = new Worker(path.join(__dirname, 'subagent-worker.js'));
  worker.on('message', (message) => {
    if (!message || typeof message.requestId !== 'number') return;
    const pending = subagentWorkerPending.get(message.requestId);
    if (!pending) return;
    subagentWorkerPending.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
  worker.on('error', (error) => {
    for (const pending of subagentWorkerPending.values()) {
      pending.reject(error);
    }
    subagentWorkerPending.clear();
    subagentWorker = null;
  });
  worker.on('exit', (code) => {
    if (subagentWorker === worker) subagentWorker = null;
    if (subagentWorkerPending.size > 0) {
      const error = new Error(`subagent worker exited with code ${code}`);
      for (const pending of subagentWorkerPending.values()) pending.reject(error);
      subagentWorkerPending.clear();
    }
  });
  subagentWorker = worker;
  return worker;
}

// 面板流 worker：子代理流读取（list/since）与 transcript 内容检查（contains）全部
// 在 worker 线程内做——冷启动全量解压几十个子代理会话文件/数十 MB JSON 绝不碰主线程，
// 消除"打开桌面端卡一下"的主线程阻塞源。缓存常驻 worker，跨请求复用。
let panelStreamWorker = null;
let panelStreamRequestId = 0;
const panelStreamPending = new Map();

function ensurePanelStreamWorker() {
  if (panelStreamWorker) return panelStreamWorker;
  const worker = new Worker(path.join(__dirname, 'panel-stream-worker.js'));
  worker.on('message', (message) => {
    if (!message || typeof message.requestId !== 'number') return;
    const pending = panelStreamPending.get(message.requestId);
    if (!pending) return;
    panelStreamPending.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
  worker.on('error', (error) => {
    for (const pending of panelStreamPending.values()) pending.reject(error);
    panelStreamPending.clear();
    panelStreamWorker = null;
  });
  worker.on('exit', (code) => {
    if (panelStreamWorker === worker) panelStreamWorker = null;
    if (panelStreamPending.size > 0) {
      const error = new Error('panel stream worker exited with code ' + code);
      for (const pending of panelStreamPending.values()) pending.reject(error);
      panelStreamPending.clear();
    }
  });
  panelStreamWorker = worker;
  return worker;
}

/** 向面板流 worker 派发任务（Promise 化）。 */
function panelStreamTask(task, payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      const worker = ensurePanelStreamWorker();
      const requestId = ++panelStreamRequestId;
      panelStreamPending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, task, ...payload });
    } catch (err) {
      reject(err);
    }
  });
}

/** 会话 transcript 内容检查（异步，worker 内执行；主线程不碰解压）。 */
function sessionContainsTextAsync(mark, opts = {}) {
  return panelStreamTask('contains', {
    dshHome: state.dshHome,
    workspace: state.workspace,
    mark,
    full: opts.full === true,
  }).catch(() => false);
}

let systemNodeForSubagentScan;

function resolveSystemNodeForSubagentScan() {
  if (app.isPackaged) return null;
  if (systemNodeForSubagentScan !== undefined) return systemNodeForSubagentScan;
  const result = spawnSyncSafe('where', ['node']);
  const candidates = String((result && result.stdout) || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  systemNodeForSubagentScan = candidates.find((entry) => fs.existsSync(entry)) || null;
  return systemNodeForSubagentScan;
}

function scanSubagentsInSystemNode({ dshHome, workspace, nodePath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodePath, [path.join(__dirname, 'subagent-scan-child.js'), dshHome, workspace], {
      cwd: APP_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', fail);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(stderr.trim() || `subagent scan exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`subagent scan returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function scanSubagentsInWorker({ dshHome, workspace }) {
  const nodePath = resolveSystemNodeForSubagentScan();
  if (nodePath) return scanSubagentsInSystemNode({ dshHome, workspace, nodePath });

  const worker = ensureSubagentWorker();
  return new Promise((resolve, reject) => {
    const requestId = ++subagentWorkerRequestId;
    subagentWorkerPending.set(requestId, { resolve, reject });
    try {
      worker.postMessage({ type: 'scan', requestId, dshHome, workspace });
    } catch (error) {
      subagentWorkerPending.delete(requestId);
      reject(error);
    }
  });
}

/** 在子进程里扫描工作区 token 用量（解压所有会话文件很重，绝不能阻塞 Electron 主进程）。 */
function runUsageScanChild({ dshHome, workspace, usagePrices }) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'usage-scan-child.js');
    const nodePath = resolveSystemNodeForSubagentScan();
    const args = [script, dshHome || '', workspace || '', usagePrices ? JSON.stringify(usagePrices) : ''];
    const child = spawn(nodePath || process.execPath, args, {
      cwd: APP_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: nodePath ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', fail);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) { fail(new Error(stderr.trim() || 'usage scan exited with code ' + code)); return; }
      try {
        const doc = JSON.parse(stdout);
        if (doc && doc.ok) resolve(doc.summary);
        else fail(new Error((doc && doc.error) || 'usage scan failed'));
      } catch (err) {
        fail(new Error('usage scan returned invalid JSON: ' + err.message));
      }
    });
  });
}

function getSubagentsSnapshot() {
  if (!state.workspace) {
    return Promise.resolve({ ok: true, items: [], summary: subagentCenter.summarize([]) });
  }

  const key = `${state.dshHome}\n${state.workspace}`;
  const now = Date.now();
  if (
    subagentsCacheResult &&
    subagentsCacheKey === key &&
    now - subagentsCacheAt < SUBAGENTS_CACHE_TTL_MS
  ) {
    return Promise.resolve(subagentsCacheResult);
  }
  if (subagentsCachePending && subagentsCacheKey === key) {
    return subagentsCachePending;
  }

  subagentsCacheKey = key;
  const pending = scanSubagentsInWorker({
    dshHome: state.dshHome,
    workspace: state.workspace,
  })
    .then(
      (result) => {
        if (subagentsCacheKey === key) {
          subagentsCacheAt = Date.now();
          subagentsCacheResult = result;
          subagentsCachePending = null;
        }
        return result;
      },
      (error) => {
        if (subagentsCacheKey === key) {
          subagentsCachePending = null;
        }
        throw error;
      },
    );
  subagentsCachePending = pending;
  return pending;
}

/* ---- 用量扫描（与子代理扫描同样的异步化：子进程/回退同步 + 缓存 + 在途共享） ---- */
const USAGE_CACHE_TTL_MS = 30000;
let usageCacheKey = null;
let usageCacheAt = 0;
let usageCacheResult = null;
let usageCachePending = null;

/** 用量扫描：优先系统 Node 子进程（Electron 内置 zstd 慢），无系统 Node 时主进程兜底。 */
function runUsageScan({ dshHome, workspace, usagePrices }) {
  const nodePath = resolveSystemNodeForSubagentScan();
  if (nodePath) {
    return new Promise((resolve, reject) => {
      const child = spawn(nodePath, [path.join(__dirname, 'usage-scan-child.js'), dshHome, workspace, JSON.stringify(usagePrices || null)], {
        cwd: APP_DIR,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', fail);
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new Error(stderr.trim() || 'usage scan exited with code ' + code));
          return;
        }
        try {
          const doc = JSON.parse(stdout);
          if (!doc.ok) reject(new Error(doc.error || 'usage scan failed'));
          else resolve(doc.summary);
        } catch (error) {
          reject(new Error('usage scan returned invalid JSON: ' + error.message));
        }
      });
    });
  }
  // 无系统 Node（打包环境）：主进程同步兜底（功能可用；数据量大时仍可能卡，属已知边界）
  return Promise.resolve().then(() => scanWorkspaceUsage({ dshHome, workspace, usagePrices }));
}

/** 用量快照：30s 缓存 + 在途共享；tier 由调用方（主进程）叠加。 */
function getUsageSnapshot() {
  if (!state.workspace) {
    return Promise.resolve({ ok: true, summary: null });
  }
  const key = `${state.dshHome}\n${state.workspace}\n${JSON.stringify(settings.get('usagePrices') || null)}`;
  const now = Date.now();
  if (usageCacheResult && usageCacheKey === key && now - usageCacheAt < USAGE_CACHE_TTL_MS) {
    return Promise.resolve(usageCacheResult);
  }
  if (usageCachePending && usageCacheKey === key) {
    return usageCachePending;
  }
  usageCacheKey = key;
  const pending = runUsageScan({
    dshHome: state.dshHome,
    workspace: state.workspace,
    usagePrices: settings.get('usagePrices'),
  })
    .then(
      (summary) => {
        if (usageCacheKey === key) {
          usageCacheAt = Date.now();
          usageCacheResult = { ok: true, summary };
          usageCachePending = null;
        }
        return { ok: true, summary };
      },
      (error) => {
        if (usageCacheKey === key) usageCachePending = null;
        return { ok: false, error: (error && error.message) || String(error) };
      },
    );
  usageCachePending = pending;
  return pending;
}

const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
const logDir = path.join(app.getPath('userData'), 'logs');
const harnessLogFile = path.join(logDir, 'dsh-web.log');
// 每次启动注入 web profile 的 --patch 覆盖文件（MCP 服务器 + 桌面端设置分区）。
const PATCH_FILE = path.join(app.getPath('userData'), 'web.patch.yml');

// 桌面端 RPC：供 harness 内的 MCP 服务器（main/mcp-server.mjs）调用桌面能力。
// token 每次启动随机生成，仅通过 dsh web 子进程环境变量传递。
let rpc = null;
let rpcToken = crypto.randomBytes(32).toString('hex');

const state = {
  phase: 'starting',
  port: null,
  url: null,
  workspace: settings.get('workspace'),
  dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  installed: null,
  latest: null,
  updateAvailable: false,
  checking: false,
  updating: false,
  updateProgress: null,
  error: null,
  mcpServers: [],
  patchDropped: false,   // 注入补丁（MCP/设置分区）因启动失败被去掉时为 true
  permissionMode: settings.get('permissionMode') || 'workspace-write',
  notifyOnComplete: settings.get('notifyOnComplete') !== false,
  defaultModel: null,    // 从 $DSH_HOME/settings.yaml 读取的默认模型（provider/model）
  visionEnabled: !!(settings.get('vision') && settings.get('vision').enabled),
  autoStart: settings.get('autoStart') === true,
  closeToTray: settings.get('closeToTray') !== false,
  // 上下文压力告警（快满时弹通知 + 状态胶囊警示，让用户选「新对话接续」还是压缩）
  // 默认阈值 700000：DeepSeek 官方模型上下文窗口 100 万 tokens。
  // 70% 为建议接续点——长上下文后期成本剧增、信息召回下降、易被自动压缩，
  // 在 70% 主动「新对话接续」（交接文件+记忆无损）优于拖到接近上限被动处理。
  contextWarning: null,
  contextWarningEnabled: settings.get('contextWarningEnabled') !== false,
  contextWarningTokens: settings.get('contextWarningTokens') || 700000,
  // 通知免打扰：开启后在免打扰时段不弹原生通知（保留 flashFrame 与日志）
  quietHoursEnabled: settings.get('quietHoursEnabled') === true,
  quietHoursStart: settings.get('quietHoursStart') || '23:00',
  quietHoursEnd: settings.get('quietHoursEnd') || '07:00',
  memoryAutoEnabled: settings.get('memoryAutoEnabled') !== false,
  memoryFile: null,             // 启动后填充：<dshHome>/memory/memory.jsonl
};

/** 记忆文件路径（受控位置，随 DSH_HOME 走，纳入备份）。 */
function memoryFilePath() {
  return path.join(state.dshHome, 'memory', 'memory.jsonl');
}

/**
 * 迁移历史记忆：server-memory 旧版本把数据存在 npx 缓存目录
 * （...\_npx\<hash>\node_modules\@modelcontextprotocol\server-memory\dist\memory.jsonl），
 * 该位置会被缓存清理/哈希变化破坏。首次启动时若新位置为空，把能找到的旧文件搬过去。
 */
function migrateLegacyMemory() {
  const target = memoryFilePath();
  if (fs.existsSync(target)) return false;
  const candidates = [];
  const npxRoot = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  let entries;
  try { entries = fs.readdirSync(npxRoot, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(npxRoot, entry.name, 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'memory.jsonl');
    if (fs.existsSync(file)) candidates.push(file);
  }
  // 旧版 dist 目录还可能残留 memory.json（server-memory 自身会迁移为 jsonl，这里也认）
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(npxRoot, entry.name, 'node_modules', '@modelcontextprotocol', 'server-memory', 'dist', 'memory.json');
    if (fs.existsSync(file)) candidates.push(file);
  }
  if (!candidates.length) return false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(candidates[0], target);
    logLine('[main] 已迁移历史记忆：' + candidates[0] + ' -> ' + target);
    return true;
  } catch (err) {
    logLine('[main] 迁移历史记忆失败（忽略）：' + (err && err.message ? err.message : err));
    return false;
  }
}

/* ---------- 工具 ---------- */

function logLine(text) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(harnessLogFile, text + '\n', 'utf8');
  } catch { /* 日志失败不影响运行 */ }
}

/** GET JSON（http/https），用于 MiMo /v1/models、Provider 探测等轻量请求。失败抛错。 */
function fetchJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'dsh-desktop', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('\u89e3\u6790\u5931\u8d25\uff1a' + (err && err.message))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('\u8bf7\u6c42\u8d85\u65f6')));
  });
}

/* ---------- 通知免打扰：免打扰时段不弹原生通知（保留 flashFrame 与日志） ---------- */

/** 是否处于通知免打扰时段（读取实时设置，随设置页改动即时生效）。 */
function isQuietHoursActive() {
  return inQuietHours({
    enabled: settings.get('quietHoursEnabled') === true,
    start: settings.get('quietHoursStart'),
    end: settings.get('quietHoursEnd'),
  });
}

/**
 * 弹原生通知。免打扰时段跳过（返回 false），其余情况正常弹出。
 * 调用方需自行处理 flashFrame 与日志（免打扰时仍保留）。
 * @returns {boolean} 是否真正弹出了通知
 */
function showNotification(opts) {
  if (isQuietHoursActive()) {
    logLine('[quiet-hours] 免打扰时段，跳过通知：' + (opts && opts.title ? opts.title : ''));
    return false;
  }
  try {
    new Notification(opts).show();
    return true;
  } catch { /* 通知不可用 */ return false; }
}

/* ---------- 端口：对话热启动依赖固定端口（同一 origin 才能复用 localStorage） ---------- */

/** 探测端口是否空闲（TCP 连接成功=占用；拒绝/超时=可尝试绑定）。 */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return resolve(false);
    const socket = net.connect({ port, host });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}

/** 优先复用设置里保存的端口（热启动），被占用或首次启动则另选新端口并保存。 */
async function pickHarnessPort() {
  const saved = settings.get('serverPort');
  if (saved && await isPortFree(saved)) return { port: saved, reused: true };
  const port = await pickFreePort();
  settings.set('serverPort', port);
  return { port, reused: false };
}

/* ---------- MCP / 客户端注入：生成 web profile 的 --patch 覆盖文件 ---------- */

/** 内置 MCP 的 serverName（与 web-patch.js 的 builtinMcps 保持一致）。 */
const BUILTIN_MCP_NAMES = new Set(['memory', 'sequential-thinking']);

/**
 * 一次性迁移：历史版本曾把 fetch/memory/sequential-thinking/git 存进用户的
 * mcpServers 配置；现在这些是桌面端内置注入的，保留会导致 patch 里 loader id
 * 重复、整个补丁被 harness 拒绝（表现为设置页变回官方原版）。启动时幂等清理。
 */
function pruneBuiltinMcpServers() {
  const list = settings.get('mcpServers') || [];
  const kept = list.filter((s) => !(s && s.serverName && BUILTIN_MCP_NAMES.has(String(s.serverName))));
  if (kept.length !== list.length) {
    settings.set('mcpServers', kept);
    logLine('[web-patch] 已从用户 MCP 列表移除与内置重复的项（' + (list.length - kept.length) + ' 个）');
  }
}

function generatePatchFile() {
  generateWebPatch({
    file: PATCH_FILE,
    appDir: APP_DIR,
    dshHome: state.dshHome,
    enableDesktopMcp: settings.get('enableDesktopMcp'),
    mcpServers: settings.get('mcpServers') || [],
    apiProviders: settings.get('apiProviders') || [],
    log: logLine,
  });
  const names = (settings.get('enableDesktopMcp') !== false ? ['dsh_desktop'] : [])
    .concat((settings.get('mcpServers') || []).map((s) => (s && s.serverName) || '').filter(Boolean))
    .concat(['memory', 'sequential-thinking']); // 内置 MCP 始终计入状态
  state.mcpServers = names;
}

function broadcastState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('dsh:state', state);
  }
}

/** 面板刷新广播：主进程关键事件（编辑占用/地图/Git 变更等）发生时推给页面，
 *  右侧「环境信息/模型调度」面板即时刷新，不再等轮询周期。 */
function broadcastPanelRefresh(reason) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('dsh:panel-refresh', { reason: reason || 'change', time: Date.now() });
    }
  } catch { /* 忽略 */ }
}

function msgBox(opts) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, opts);
  return dialog.showMessageBox(opts);
}

function injectBadge(win) {
  if (!win || win.isDestroyed()) return;
  // 状态栏胶囊（客户端插件）负责正常情况下的更新提示；
  // 注入补丁被跳过（patchDropped）时用角标兜底。
  const show = state.patchDropped && settings.get('showUpdateBadge') && (state.updateAvailable || state.updating);
  const text = state.updating
    ? '\u23f3 \u6b63\u5728\u66f4\u65b0\u2026'
    : state.updateAvailable
      ? '\u{1f504} \u53d1\u73b0\u65b0\u7248\u672c v' + state.latest + ' \u2014 \u70b9\u51fb\u66f4\u65b0'
      : '';
  if (!show) {
    win.webContents.executeJavaScript("document.getElementById('dsh-desktop-badge')?.remove()").catch(() => {});
    return;
  }
  const js = '(() => {' +
    "const old = document.getElementById('dsh-desktop-badge'); if (old) old.remove();" +
    "const el = document.createElement('div'); el.id = 'dsh-desktop-badge';" +
    "el.style.cssText = 'position:fixed;top:10px;right:12px;z-index:2147483647;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:999px;padding:6px 14px;font:13px/1.4 system-ui;box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:pointer;user-select:none;';" +
    'el.textContent = ' + JSON.stringify(text) + ';' +
    'el.onclick = () => { window.dshDesktop && window.dshDesktop.applyUpdate(); };' +
    'document.body.appendChild(el);' +
    '})();';
  win.webContents.executeJavaScript(js).catch(() => {});
}

/* ---------- 窗口 ---------- */

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'DeepSeek Harness \u684c\u9762\u7aef',
    backgroundColor: '#0e1116',
    icon: WINDOW_ICON,
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 右侧常驻双面板（环境信息 + 模型调度）占位后，启动即最大化以扩大主界面可视区域。
  try { win.maximize(); } catch { /* 忽略 */ }
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const sameOrigin = state.url && url.startsWith(state.url);
    const isFile = url.startsWith('file://');
    if (!sameOrigin && !isFile) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.session.on('will-download', (event, item) => {
    dialog.showSaveDialog(win, { title: '\u4fdd\u5b58\u6587\u4ef6', defaultPath: item.getFilename() || 'download' })
      .then((r) => {
        if (r.canceled || !r.filePath) item.cancel();
        else item.setSavePath(r.filePath);
      });
  });
  win.webContents.on('did-finish-load', () => { injectBadge(win); broadcastState(); taskDispatcher.flush(); });
  // 关闭到托盘：不退出，隐藏窗口（托盘菜单里退出）。Alt+F4 也走这里。
  win.on('close', (event) => {
    if (!quitting && settings.get('closeToTray')) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { mainWindow = null; });
  win.loadFile(path.join(APP_DIR, 'renderer', 'loading.html'));
  return win;
}

/** 显示/恢复主窗口。 */
function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow = createMainWindow();
    startHarness();
  }
}

/** 生成托盘图标：官方灰色鲸鱼（16x16）；图标缺失时退回蓝色圆点。 */
function createTrayIcon() {
  try {
    const img = nativeImage.createFromPath(WINDOW_ICON);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  } catch { /* 退回圆点 */ }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.sqrt((x - 7.5) * (x - 7.5) + (y - 7.5) * (y - 7.5));
      const alpha = d <= 7 ? 255 : 0;
      buf[i] = 47; buf[i + 1] = 129; buf[i + 2] = 247; buf[i + 3] = alpha;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function setupTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip('DeepSeek Harness \u684c\u9762\u7aef');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '\u6253\u5f00\u4e3b\u754c\u9762', click: () => showMainWindow() },
    { label: '\u5feb\u901f\u547d\u4ee4\u6846', click: () => toggleQuickCommand() },
    { label: '\u65b0\u5bf9\u8bdd\u63a5\u7eed', click: () => continueInNewConversation() },
    { label: '\u5feb\u901f\u622a\u56fe', click: () => openCaptureWindow() },
    { label: '\u9644\u52a0\u6587\u4ef6\u2026', click: () => attachFiles() },
    { label: '\u7ec8\u7aef\u6a21\u5f0f', click: () => openHeadlessWindow() },
    { type: 'separator' },
    { label: '\u9000\u51fa', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => toggleQuickCommand());
}

/** 全局快捷键：应用不在前台也能用（Codex/Claude 式全局操控）。 */
function registerGlobalShortcuts() {
  const reg = (accel, fn) => { try { globalShortcut.register(accel, fn); } catch { /* 冲突时忽略 */ } };
  reg('CommandOrControl+Shift+A', () => openCaptureWindow());
  reg('CommandOrControl+Shift+T', () => openHeadlessWindow());
  reg('CommandOrControl+Shift+F', () => showMainWindow());
  reg('CommandOrControl+Shift+Space', () => toggleQuickCommand());
}

/** 应用开机自启设置。 */
function applyAutoStart(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: [APP_DIR],
    });
    settings.set('autoStart', !!enabled);
    state.autoStart = !!enabled;
    broadcastState();
    return { ok: true, autoStart: !!enabled };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/* ---------- Spotlight 式全局命令框 ---------- */

/** 创建（或复用）命令框窗口：屏幕上方居中的无边框输入框。 */
function createQuickCommandWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) return quickWindow;
  const display = screen.getPrimaryDisplay();
  const { width } = display.bounds;
  const w = 700;
  quickWindow = new BrowserWindow({
    width: w,
    height: 200,
    x: Math.round((display.bounds.x + width - w) / 2),
    y: display.bounds.y,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    icon: WINDOW_ICON,
    show: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  quickWindow.setAlwaysOnTop(true, 'screen-saver');
  quickWindow.on('closed', () => { quickWindow = null; });
  quickWindow.on('blur', () => { if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide(); });
  quickWindow.loadFile(path.join(APP_DIR, 'renderer', 'quick-command.html'));
  return quickWindow;
}

function showQuickCommand() {
  const win = createQuickCommandWindow();
  win.show();
  win.focus();
  win.webContents.executeJavaScript("(() => { const el = document.getElementById('cmd'); if (el) { el.value=''; el.focus(); } return true; })()").catch(() => {});
}

function toggleQuickCommand() {
  if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
    quickWindow.hide();
  } else {
    showQuickCommand();
  }
}

/** 把一段任务文本派发给 harness 对话。send=false 只粘贴。走队列 + 门控 + 重试，不再依赖窗口聚焦。 */
function dispatchTaskToHarness(text, { send = true } = {}) {
  showMainWindow();
  taskDispatcher.enqueue(String(text), { send });
}

/* ---------- 任务派发：官方 RPC 优先，剪贴板兜底；队列 + 门控 + 重试 ---------- */

/**
 * 调用 harness 官方 /api RPC（dsh-host-apiproxy 的 client-request 信封，
 * 与官方 Web UI 同一条通道）。信任栅栏只要求 loopback Host + 无跨站标记，
 * 主进程直连 127.0.0.1 天然满足，不依赖窗口聚焦与页面 DOM。
 * @returns {Promise<{status:number, body:object|null}>}
 */
function rpcCall(method, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!state.url) return reject(new Error('harness URL 不可用'));
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload,
    });
    const url = new URL(state.url + '/api/' + method);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data || '{}'); } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('RPC 超时（' + method + '）')));
    req.on('error', reject);
    req.end(body);
  });
}

/** 通过官方 /api 通道把文本送进对话（session.prompt）。返回是否被接受。 */
async function rpcSendPrompt(text) {
  const list = await rpcCall('session.list', {});
  const listResult = list.body && list.body.result;
  if (list.status !== 200 || !listResult || !listResult.ok) {
    throw new Error('session.list 失败：' + (listResult && listResult.error ? listResult.error.message : ('HTTP ' + list.status)));
  }
  // 列表按 updatedAt 最新在前；排除子代理只读会话（origin==='subagent'）。
  const items = (listResult.value && listResult.value.items) || [];
  const session = items.find((s) => s && s.sessionId && !s.origin);
  if (!session) throw new Error('没有可用的顶层会话');
  const prompt = await rpcCall('session.prompt', {
    sessionId: session.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  });
  const result = prompt.body && prompt.body.result;
  if (prompt.status !== 200 || !result) throw new Error('session.prompt 失败：HTTP ' + prompt.status);
  return result.ok === true;
}

/** 剪贴板兜底：聚焦主窗口 → 粘贴 → 回车发送。返回是否执行了派发动作。 */
async function pasteTask(text, send) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  clipboard.writeText(String(text));
  const focused = await focusComposerAndPaste();
  if (!focused || !mainWindow || mainWindow.isDestroyed()) return false;
  if (send) {
    await new Promise((r) => setTimeout(r, 500));
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: [] });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: [] });
  }
  return true;
}

/** 一次派发尝试：官方 RPC 优先（不依赖窗口/页面状态），失败回退剪贴板。 */
async function sendTaskToHarness(task) {
  if (task.send !== false && state.phase === 'ready' && state.url) {
    try {
      if (await rpcSendPrompt(task.text)) return true;
    } catch (err) {
      logLine('[task-dispatch] 官方 RPC 派发失败，回退剪贴板：' + (err && err.message ? err.message : err));
    }
  }
  return pasteTask(task.text, task.send !== false);
}

/** 任务派发器：状态门控 + 内存队列（上限 20）+ 失败重试 3 次（间隔 2s）。 */
const taskDispatcher = new taskDispatch.TaskDispatcher({
  maxQueue: taskDispatch.DEFAULT_MAX_QUEUE,
  dropPolicy: 'drop-oldest',
  maxAttempts: taskDispatch.DEFAULT_MAX_ATTEMPTS,
  retryDelayMs: taskDispatch.DEFAULT_RETRY_DELAY_MS,
  isReady: () => state.phase === 'ready',
  sendTask: sendTaskToHarness,
  log: logLine,
  onDropped: (task) => logLine('[task-dispatch] \u961f\u5217\u5df2\u6ee1\uff0c\u4e22\u5f03\u6700\u65e7\u4efb\u52a1\uff1a' + String(task.text).slice(0, 80)),
  notifyFailure: (task, error) => {
    logLine('[task-dispatch] \u4efb\u52a1\u6d3e\u53d1\u5931\u8d25\uff1a' + String(task.text).slice(0, 120) + (error && error.message ? '（' + error.message + '）' : ''));
    try {
      showNotification({ title: '\u5b9a\u65f6\u4efb\u52a1\u6d3e\u53d1\u5931\u8d25', body: String(task.text).slice(0, 120) });
    } catch { /* 通知不可用 */ }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
  },
});

/* ---------- 定时任务 / 提醒 ---------- */

function scheduleList() {
  return (settings.get('scheduledTasks') || []).slice();
}

function scheduleSave(list) {
  settings.set('scheduledTasks', list);
  return list;
}

function fireScheduledTask(task) {
  logLine('[schedule] \u89e6\u53d1\uff1a' + (task.label || task.id) + ' kind=' + task.kind);
  const body = String(task.task || task.label || '').slice(0, 200);
  try {
    showNotification({ title: (task.kind === 'task' ? '\u5b9a\u65f6\u4efb\u52a1 \u2014 ' : '\u63d0\u9192 \u2014 ') + (task.label || 'harness'), body });
  } catch { /* 通知不可用 */ }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true);
  if (task.kind === 'task' && body) {
    dispatchTaskToHarness(body);
  }
}

function startScheduler() {
  scheduler = new Scheduler({
    getTasks: () => settings.get('scheduledTasks') || [],
    log: logLine,
    onFire: (task, now) => {
      const list = scheduleList();
      const index = list.findIndex((t) => t && t.id === task.id);
      if (index >= 0) list[index] = afterFireUpdate(list[index], now);
      scheduleSave(list);
      fireScheduledTask(list[index] || task);
    },
  });
  scheduler.start();
}

function openHeadlessWindow() {
  if (headlessWindow && !headlessWindow.isDestroyed()) { headlessWindow.focus(); return; }
  headlessWindow = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 640,
    minHeight: 440,
    title: '\u7ec8\u7aef\u6a21\u5f0f \u2014 DeepSeek Harness',
    backgroundColor: '#0d1117',
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  headlessWindow.on('closed', () => {
    headlessWindow = null;
    if (headlessRunner) { headlessRunner.cancel(); headlessRunner = null; }
  });
  headlessWindow.loadFile(path.join(APP_DIR, 'renderer', 'terminal.html'));
}

/* ---------- harness 子进程 ---------- */

function buildChildEnv() {
  const env = { ...process.env };
  for (const key of ['DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL', 'DSH_SHELL']) delete env[key];
  env.DSH_HOME = state.dshHome;
  // 权限/沙箱模式（Codex 风格：read-only | workspace-write | danger-full-access）。
  env.DSH_PERMISSION_MODE = state.permissionMode;
  if (rpc && rpc.url) {
    // 桌面端 RPC 地址/令牌：仅存在于 dsh web 子进程环境，供 MCP 服务器读取。
    env.DSH_DESKTOP_RPC_URL = rpc.url;
    env.DSH_DESKTOP_RPC_TOKEN = rpcToken;
  }
  // 多厂商 LLM Provider：为每个启用且有 key 的 Provider 注入 `<ID大写>_API_KEY`。
  // apiKey 只进 dsh web 子进程环境（llm-openai-compat 插件按 apiKeyEnv 读取），
  // 绝不写入日志；web.patch.yml 里只出现环境变量名。
  for (const p of settings.get('apiProviders') || []) {
    if (!p || p.enabled === false || !p.id || !p.apiKey) continue;
    env[providerEnvKey(p.id)] = String(p.apiKey);
  }
  return env;
}

/** 拉起一个 HarnessController 并挂接监听（端口与状态已就绪）。 */
function launchHarness(port, withPatch = true) {
  state.port = port;
  state.url = 'http://127.0.0.1:' + port;
  harness = new HarnessController({
    binPath: dshBinPath(),
    cwd: state.workspace,
    env: buildChildEnv(),
    host: '127.0.0.1',
    port,
    patches: withPatch && fs.existsSync(PATCH_FILE) ? [PATCH_FILE] : [],
  });
  harness.on('log', logLine);
  harness.on('exit', (code) => {
    if (quitting) return;
    if (state.phase === 'ready') {
      state.phase = 'error';
      state.error = 'harness \u670d\u52a1\u5df2\u9000\u51fa\uff08\u9000\u51fa\u7801 ' + code + '\uff09\u3002';
      broadcastState();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadFile(path.join(APP_DIR, 'renderer', 'loading.html'));
      }
    }
  });
  return harness.start();
}

async function startHarness() {
  state.phase = 'starting';
  state.error = null;
  state.url = null;
  state.patchDropped = false;
  broadcastState();
  if (harness) await harness.stop().catch(() => {});
  harness = null;

  // 每次启动重新生成注入补丁（设置可能被修改过）。
  pruneBuiltinMcpServers(); // 幂等：先清理与内置 MCP 同名的历史配置，防 patch id 重复
  generatePatchFile();

  let port;
  let reusedSaved = false;
  try {
    const picked = await pickHarnessPort();
    port = picked.port;
    reusedSaved = picked.reused;
  } catch (err) {
    state.phase = 'error';
    state.error = '\u65e0\u6cd5\u5206\u914d\u672c\u5730\u7aef\u53e3\uff1a' + err.message;
    broadcastState();
    return;
  }

  let lastErr = null;
  const tryLaunch = async (targetPort, withPatch) => {
    if (harness) { await harness.stop().catch(() => {}); harness = null; }
    state.phase = 'waiting-server';
    broadcastState();
    await launchHarness(targetPort, withPatch);
  };

  // 依次尝试：带补丁 → （端口被占则换新端口）→ 仍失败则去掉注入补丁再试一次。
  try {
    await tryLaunch(port, true);
    lastErr = null;
  } catch (err) {
    lastErr = err;
    if (reusedSaved) {
      try {
        port = await pickFreePort();
        settings.set('serverPort', port);
        await tryLaunch(port, true);
        lastErr = null;
      } catch (err2) { lastErr = err2; }
    }
    if (lastErr) {
      // 注入补丁导致启动失败（如 MCP 配置或客户端插件解析问题）时，
      // 去掉补丁重试一次，保证 harness 客户端始终可用。
      logLine('[main] \u5e26\u8865\u4e01\u542f\u52a8\u5931\u8d25\uff0c\u53bb\u6389\u6ce8\u5165\u8865\u4e01\u91cd\u8bd5\uff1a' + (lastErr && lastErr.message ? lastErr.message : lastErr));
      try {
        await tryLaunch(port, false);
        lastErr = null;
        state.patchDropped = true;
        broadcastState();
      } catch (err3) { lastErr = err3; }
    }
  }

  if (lastErr) {
    state.phase = 'error';
    state.error = lastErr && lastErr.message ? lastErr.message : String(lastErr);
    broadcastState();
    return;
  }
  state.phase = 'ready';
  broadcastState();
  taskDispatcher.flush(); // 就绪后补发积压的定时任务
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(state.url);
}

async function chooseWorkspaceDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '\u9009\u62e9\u5de5\u4f5c\u533a\u76ee\u5f55',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: state.workspace || os.homedir(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

async function chooseWorkspace() {
  const dir = await chooseWorkspaceDialog();
  if (!dir) return;
  settings.set('workspace', dir);
  state.workspace = dir;
  rememberWorkspace(dir);
  broadcastState();
  await startHarness();
}

/** 记录最近使用的工作区（去重，最多 8 个）。 */
function rememberWorkspace(dir) {
  const list = [dir, ...(settings.get('recentWorkspaces') || []).filter((w) => w !== dir)].slice(0, 8);
  settings.set('recentWorkspaces', list);
}

/** 从 $DSH_HOME/settings.yaml 读取默认模型（用于状态栏显示）。 */
function loadDefaultModel() {
  try {
    const file = path.join(state.dshHome, 'settings.yaml');
    if (fs.existsSync(file)) {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
      const m = doc['agent-default-model'];
      if (m && m.model) state.defaultModel = (m.provider ? m.provider + '/' : '') + m.model;
    }
  } catch { /* 忽略 */ }
}

/* ---------- 更新 ---------- */

/** 会话最近 3 分钟内有写入视为"忙碌"（更新会打断任务，应推迟）。 */
function isAppBusy() {
  try {
    const root = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
    const active = findActiveSession(root);
    return !!(active && Date.now() - active.mtimeMs < 3 * 60 * 1000);
  } catch { return false; }
}

/** 忙碌时延迟执行的动作队列（5 分钟一轮，最多 12 小时），空闲即执行。 */
let deferredUpdateTimer = null;
function scheduleDeferredUpdate(action, label) {
  if (deferredUpdateTimer) clearTimeout(deferredUpdateTimer);
  deferredUpdateTimer = setTimeout(async () => {
    deferredUpdateTimer = null;
    if (!state.updateAvailable || state.updating || state.checking) return;
    if (isAppBusy()) { scheduleDeferredUpdate(action, label); return; }
    logLine('[updater] 空闲，执行延迟更新：' + label);
    try { await action(); } catch { /* 失败由 action 内部处理 */ }
  }, 5 * 60 * 1000);
}

/** 空闲感知的更新入口：忙碌则延迟（仅对自动路径生效，手动更新立即执行）。 */
function applyUpdateWhenIdle(version, { label = '自动更新' } = {}) {
  if (isAppBusy()) {
    logLine('[updater] 会话活跃，延迟' + label + '到空闲（5 分钟后再试）');
    scheduleDeferredUpdate(() => applyUpdate(version), label);
  } else {
    applyUpdate(version);
  }
}

async function checkUpdates({ manual = false, silent = false } = {}) {
  if (state.checking || state.updating) return;
  state.checking = true;
  broadcastState();
  try {
    const res = await updater.checkForUpdates(dshInstallDir(), {
      checkPrereleases: settings.get('checkPrereleases'),
      fallbackDir: APP_DIR,
    });
    state.installed = res.installed;
    state.latest = res.latest;
    state.updateAvailable = res.hasUpdate;
    broadcastState();
    if (res.hasUpdate) {
      if (settings.get('silentAutoUpdate')) {
        // 静默自动更新：等会话空闲再装，避免打断进行中的任务
        applyUpdateWhenIdle(res.latest, { label: '静默自动更新' });
      } else if (silent) { /* 仅刷新状态（MCP 检查工具），不打扰用户 */ }
      else if (manual) {
        await promptUpdate(res);
      } else if (settings.get('autoUpdate')) {
        // 自动更新弹窗同样等空闲再打扰（保持 updateAvailable 徽标提示）
        if (isAppBusy()) {
          logLine('[updater] 会话活跃，延迟更新询问到空闲');
          scheduleDeferredUpdate(() => promptUpdate(res), '更新询问');
        } else {
          await promptUpdate(res);
        }
      }
    } else if (manual && !silent) {
      await msgBox({
        type: 'info', title: '\u68c0\u67e5\u66f4\u65b0', noLink: true, buttons: ['\u786e\u5b9a'],
        message: '\u5f53\u524d\u5df2\u662f\u6700\u65b0\u7248\u672c',
        detail: '\u5df2\u5b89\u88c5 v' + res.installed + '\nregistry latest: v' + res.latest,
      });
    }
  } catch (err) {
    if (manual && !silent) dialog.showErrorBox('\u68c0\u67e5\u66f4\u65b0\u5931\u8d25', err && err.message ? err.message : String(err));
  } finally {
    state.checking = false;
    broadcastState();
  }
}

/** 弹窗询问是否更新（附带官方发布说明）；返回用户是否确认。 */
async function promptUpdate(res) {
  const notes = await updater.fetchReleaseNotes(res.latest);
  const detail = '\u5f53\u524d\u5b89\u88c5\uff1av' + res.installed +
    (notes ? '\n\n\u672c\u6b21\u66f4\u65b0\u5185\u5bb9\uff1a\n' + notes : '') +
    '\n\n\u201c\u7acb\u5373\u66f4\u65b0\u201d\u4f1a\u4e0b\u8f7d\u5e76\u5b89\u88c5\u65b0\u7248\u672c\uff0c\u7136\u540e\u81ea\u52a8\u91cd\u542f\u5e94\u7528\u3002';
  const { response } = await msgBox({
    type: 'info', title: '\u53d1\u73b0\u65b0\u7248\u672c', noLink: true,
    message: 'harness \u6709\u65b0\u7248\u672c\u53ef\u7528\uff1av' + res.latest,
    detail,
    buttons: ['\u7acb\u5373\u66f4\u65b0', '\u7a0d\u540e'], defaultId: 0, cancelId: 1,
  });
  if (response === 0) {
    applyUpdate(res.latest);
    return true;
  }
  return false;
}

function spawnSyncSafe(cmd, args) {
  try {
    return require('node:child_process').spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  } catch (err) { return null; }
}

/** 解析更新用的 npm 运行器：开发模式优先系统 npm；打包模式用内置 npm + Electron Node。 */
function resolveNpmRunner() {
  if (!app.isPackaged) {
    const r = spawnSyncSafe('where', ['npm']);
    if (r && r.stdout && r.stdout.trim()) return { kind: 'system' };
  }
  // 打包模式 asar: false，应用以真实文件形式位于 resources/app。
  const appRoot = app.isPackaged ? path.join(process.resourcesPath, 'app') : APP_DIR;
  const cli = path.join(appRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { kind: 'bundled', node: process.execPath, cli };
}

/**
 * 打包模式：初始化 %APPDATA%\dsh-desktop\dsh 安装目录（更新目标）。
 * 首次运行写入与内置版本一致的 package.json，保证 npm install --save-exact 可用。
 */
function ensurePackagedDshDir() {
  if (!app.isPackaged) return;
  const dir = PACKAGED_DSH_DIR();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) {
      const version = updater.installedVersion(APP_DIR) || '0.0.0';
      fs.writeFileSync(manifest, JSON.stringify({
        name: 'dsh-desktop-runtime',
        private: true,
        dependencies: { '@deepseek-ai/dsh': version },
      }, null, 2) + '\n', 'utf8');
      logLine('[main] 已初始化打包安装目录：' + dir);
    }
  } catch (err) {
    logLine('[main] 初始化打包安装目录失败：' + (err && err.message ? err.message : err));
  }
}

async function applyUpdate(version) {
  if (state.updating) return;
  const target = version || state.latest;
  if (!target) return;
  state.updating = true;
  state.updateProgress = { stage: 'install', text: '\u6b63\u5728\u4e0b\u8f7d\u5e76\u5b89\u88c5\u66f4\u65b0\u2026' };
  broadcastState();
  if (mainWindow && !mainWindow.isDestroyed()) injectBadge(mainWindow);
  // 更新事务标记：安装前写入 in-progress（进程被杀/半更新时，下次启动可检测并提示重试）
  const guard = { version: target, startedAt: new Date().toISOString(), status: 'in-progress' };
  settings.set('updateGuard', guard);
  logLine('[updater] \u5f00\u59cb\u66f4\u65b0\u5230 v' + target + '\uff0c\u5199\u5165 updateGuard\uff08in-progress\uff09');
  try {
    const runner = resolveNpmRunner();
    await updater.applyUpdate(dshInstallDir(), target, runner, (text) => {
      state.updateProgress.text = text;
      broadcastState();
    });
    // 安装后校验：版本必须与目标一致，否则视为失败（提示重试，不盲目重启）。
    // updater 内部已做同样校验并回滚 package.json，这里是含内置副本的兜底校验。
    const installedNow = updater.installedVersion(dshInstallDir(), APP_DIR);
    if (installedNow !== target) {
      throw new Error('\u5b89\u88c5\u540e\u7248\u672c\u6821\u9a8c\u5931\u8d25\uff1a\u671f\u671b v' + target + '\uff0c\u5b9e\u9645 v' + installedNow +
        '\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\uff0c\u6216\u624b\u52a8\u6267\u884c npm install @deepseek-ai/dsh@' + target);
    }
    // 更新成功：先标记 ok（防重启间隙误判为失败），重启前清除
    settings.set('updateGuard', { ...guard, status: 'ok' });
    state.updating = false;
    state.updateProgress = null;
    state.updateAvailable = false;
    broadcastState();
    await msgBox({
      type: 'info', title: '\u66f4\u65b0\u5b8c\u6210', noLink: true, buttons: ['\u7acb\u5373\u91cd\u542f'],
      message: 'harness \u5df2\u66f4\u65b0\u5230 v' + target,
      detail: '\u5e94\u7528\u5c06\u7acb\u5373\u91cd\u542f\u4ee5\u52a0\u8f7d\u65b0\u7248\u672c\u3002',
    });
    quitting = true;
    settings.set('updateGuard', null); // 更新成功，清除事务标记
    if (harness) await harness.stop().catch(() => {});
    app.relaunch();
    app.exit(0);
  } catch (err) {
    // 失败：标记 failed（下次启动提示"上次更新未完成，可重试"，不自动重装）
    const prev = settings.get('updateGuard') || guard;
    settings.set('updateGuard', { version: prev.version || target, startedAt: prev.startedAt || guard.startedAt, status: 'failed' });
    logLine('[updater] \u66f4\u65b0\u5931\u8d25\uff1a' + (err && err.message ? err.message : err));
    state.updating = false;
    state.updateProgress = null;
    broadcastState();
    dialog.showErrorBox('\u66f4\u65b0\u5931\u8d25', err && err.message ? err.message : String(err));
  }
}

/** 启动时检测上次未完成的更新（updateGuard）：记录日志并提示用户可重试，不自动重装（避免反复失败）。 */
function checkUpdateGuard() {
  const guard = settings.get('updateGuard');
  if (!guard || typeof guard.version !== 'string') return;
  const installed = updater.installedVersion(dshInstallDir(), APP_DIR);
  // ok 标记或目标版本已就位：更新实际已完成，仅清理残留标记
  if (guard.status === 'ok' || installed === guard.version) {
    logLine('[updater] updateGuard \u72b6\u6001 ' + guard.status + ' \u4f46 v' + installed + ' \u5df2\u5c31\u4f4d\uff0c\u6e05\u9664\u6807\u8bb0');
    settings.set('updateGuard', null);
    return;
  }
  if (guard.status !== 'failed' && guard.status !== 'in-progress') return; // 未知状态不打扰
  // 版本未变：上次更新失败或安装中断 → 日志 + 提示可重试
  logLine('[updater] \u4e0a\u6b21\u66f4\u65b0\u672a\u5b8c\u6210\uff1astatus=' + guard.status + ', target=' + guard.version + ', installed=' + installed);
  msgBox({
    type: 'warning', title: '\u4e0a\u6b21\u66f4\u65b0\u672a\u5b8c\u6210', noLink: true,
    message: '\u68c0\u6d4b\u5230\u4e0a\u6b21\u66f4\u65b0\u672a\u5b8c\u6210\uff08' + (guard.status === 'in-progress' ? '\u5b89\u88c5\u8fc7\u7a0b\u4e2d\u65ad' : '\u5b89\u88c5\u5931\u8d25') + '\uff09\u3002',
    detail: '\u76ee\u6807\u7248\u672c v' + guard.version + '\uff0c\u5f53\u524d\u7248\u672c v' + installed +
      '\u3002\u4e0d\u4f1a\u81ea\u52a8\u91cd\u88c5\uff0c\u53ef\u7a0d\u540e\u624b\u52a8\u91cd\u8bd5\u66f4\u65b0\u3002',
    buttons: ['\u91cd\u8bd5\u66f4\u65b0', '\u7a0d\u540e'], defaultId: 1, cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) applyUpdate(guard.version);
  }).catch(() => {});
}

/* ---------- 桌面端 RPC（供 harness 内 MCP 服务器调用） ---------- */

function startRpc() {
  rpc = new DesktopRpcServer({ token: rpcToken, logger: logLine });
  rpc.on('getState', async () => ({ ...state, currentModel: currentModelCached() }));
  // 模型可用：供 MCP 工具 dsh_desktop_list_providers 查询（主模型派发子代理时选择 provider/思考强度）
  rpc.on('providersList', async () => ({ ok: true, providers: providersListPayload() }));
  rpc.on('checkUpdates', async (params) => {
    const checkPrereleases = params && params.checkPrereleases !== undefined
      ? Boolean(params.checkPrereleases)
      : settings.get('checkPrereleases');
    const res = await updater.checkForUpdates(dshInstallDir(), { checkPrereleases, fallbackDir: APP_DIR });
    state.installed = res.installed;
    state.latest = res.latest;
    state.updateAvailable = res.hasUpdate;
    broadcastState();
    return { installed: res.installed, latest: res.latest, hasUpdate: res.hasUpdate };
  });
  rpc.on('applyUpdate', async () => {
    if (!state.updateAvailable || !state.latest) return { applied: false, reason: 'no update available' };
    const confirmed = await promptUpdate({ installed: state.installed, latest: state.latest });
    return { applied: confirmed, reason: confirmed ? 'installing' : 'user cancelled' };
  });
  rpc.on('openFolder', async (params) => {
    const target = (params && params.path && String(params.path).trim()) || state.workspace;
    if (target) shell.openPath(target);
    return { path: target || null };
  });
  rpc.on('openLogs', async () => {
    fs.mkdirSync(logDir, { recursive: true });
    shell.openPath(logDir);
    return { path: logDir };
  });
  rpc.on('openTerminal', async () => {
    openHeadlessWindow();
    return { ok: true };
  });
  rpc.on('restartApp', async (params) => {
    // 自动接续：agent 主动重启时把任务摘要落盘；并在重启前（页面仍活着）直接把接续任务
    // 注入发送——消息立刻进入当前会话队列/回合，重启后恢复时天然排在其后到达的任何用户
    // 消息之前。注入失败则依赖落盘标记，重启后页面就绪时兜底注入。
    const task = params && params.task ? String(params.task).slice(0, 4000) : '';
    const msg = '\u7ee7\u7eed\u5b8c\u6210\u672a\u5b8c\u6210\u7684\u4efb\u52a1\uff08\u684c\u9762\u7aef\u5df2\u91cd\u542f\uff09\uff1a' + task;
    if (task) {
      // 只写标记：重启后页面就绪时统一自动注入发送（用户可看到发送动作，且可用插话排到队列最前）。
      // 不在重启前注入——重启前提交的消息会"消失"在队列里，重启后无任何可见动作，用户以为没接续。
      try {
        fs.writeFileSync(path.join(app.getPath('userData'), 'auto-resume.json'), JSON.stringify({ msg, task, at: Date.now() }), 'utf8');
        logLine('[auto-resume] \u5df2\u5199\u5165\u63a5\u7eed\u4efb\u52a1\uff08\u91cd\u542f\u540e\u6ce8\u5165\uff09');
      } catch (err) { logLine('[auto-resume] \u5199\u5165\u5931\u8d25\uff1a' + (err && err.message)); }
    }
    setImmediate(() => {
      quitting = true;
      Promise.resolve(harness ? harness.stop().catch(() => {}) : null).then(() => {
        app.relaunch();
        app.exit(0);
      });
    });
    return { ok: true };
  });
  rpc.on('switchWorkspace', async (params) => {
    const dir = params && params.path ? String(params.path) : '';
    if (!dir || !fs.existsSync(dir)) throw new Error('\u5de5\u4f5c\u533a\u76ee\u5f55\u4e0d\u5b58\u5728\uff1a' + dir);
    settings.set('workspace', dir);
    state.workspace = dir;
    rememberWorkspace(dir);
    broadcastState();
    broadcastPanelRefresh('workspace');
    startHarness();
    return { workspace: dir };
  });
  rpc.on('describeImage', async (params, io) => {
    const vision = settings.get('vision');
    const vb = visionBroadcast();
    await ensureOllamaMode(); // 显存感知：GPU 可用则 GPU，否则纯 CPU（模式不变时零开销）
    logLine('[vision] \u5f00\u59cb\u8bc6\u522b\uff08' + (vision && vision.model ? vision.model : '?') + '\uff09');
    vb.send({ phase: 'start' });
    // 客户端断开（MCP 层报错/超时/断连）时取消推理，避免主进程空转浪费 CPU。
    // 注意：必须监听响应流 res 'close'——req 'close' 在请求体读完即触发，会误杀刚启动的推理。
    const controller = new AbortController();
    visionRuns.set(vb.id, controller);
    const onClose = () => { if (io && io.res && !io.res.writableEnded) controller.abort(); };
    if (io && io.res) io.res.on('close', onClose);
    try {
      const description = await describeImage(effectiveVision(vision), {
        path: params && params.path,
        url: params && params.url,
        ref: params && params.ref,
        question: params && params.question,
        region: params && params.region,
        dshHome: state.dshHome,
        stream: true,
        onDelta: (text) => vb.send({ phase: 'delta', text }),
        onReset: () => vb.send({ phase: 'reset' }),
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - vb.startedAt;
      vb.send({ phase: 'done', elapsedMs, chars: description.length });
      logLine('[vision] \u8bc6\u522b\u5b8c\u6210\uff1a' + elapsedMs + 'ms\uff0c' + description.length + '\u5b57\u7b26');
      return { description, elapsedMs };
    } catch (err) {
      if (err && (err.code === 'CUDA_OOM' || err.code === 'OLLAMA_BROKEN') && ollama.isLocalOllama(String(vision && vision.baseUrl || ''))) {
        // 显存不足或 llama-server 崩溃（health refused 等）：重启本地 Ollama 服务清掉失败状态，
        // 纯 CPU 重试一次（慢但必然成功）。
        try {
          ollama.stop();
          await new Promise((r) => setTimeout(r, 1500));
          await ollama.start({ numGpu: '0' }); // 服务级纯 CPU 重启：请求级 num_gpu 拦不住 llama-server 初始化 CUDA
          await new Promise((r) => setTimeout(r, 2500));
          ollamaMode = 'cpu'; // 记录降级；下次推理前 ensureOllamaMode 会在显存恢复时自动切回 GPU
          logLine('[vision] \u672c\u5730\u89c6\u89c9\u670d\u52a1\u5f02\u5e38\uff0c\u5df2\u91cd\u542f Ollama \u670d\u52a1\uff08\u7eaf CPU\uff09\uff0c\u91cd\u8bd5');
        } catch (err2) { logLine('[vision] Ollama \u91cd\u542f\u5931\u8d25\uff1a' + (err2 && err2.message)); }
        const description = await describeImage(effectiveVision(vision), {
          path: params && params.path,
          url: params && params.url,
          ref: params && params.ref,
          question: params && params.question,
          region: params && params.region,
          dshHome: state.dshHome,
          stream: true,
          onDelta: (text) => vb.send({ phase: 'delta', text }),
        onReset: () => vb.send({ phase: 'reset' }),
          options: { num_gpu: 0 },
          signal: controller.signal,
        });
        const elapsedMs = Date.now() - vb.startedAt;
        vb.send({ phase: 'done', elapsedMs, chars: description.length });
        logLine('[vision] \u8bc6\u522b\u5b8c\u6210\uff08CPU \u964d\u7ea7\uff09\uff1a' + elapsedMs + 'ms\uff0c' + description.length + '\u5b57\u7b26');
        return { description, elapsedMs };
      }
      const elapsedMs = Date.now() - vb.startedAt;
      if (controller.signal.aborted) {
        // 用户点了运行框「停止」：广播友好状态（UI 显示"已停止"而非红色失败），并向调用方抛明确错误。
        vb.send({ phase: 'error', cancelled: true, message: '\u5df2\u624b\u52a8\u505c\u6b62\u8bc6\u522b', elapsedMs });
        logLine('[vision] \u8bc6\u522b\u5df2\u505c\u6b62\uff08' + elapsedMs + 'ms\uff09');
        throw new Error('\u672c\u5730\u89c6\u89c9\u8bc6\u522b\u5df2\u88ab\u7528\u6237\u505c\u6b62');
      }
      vb.send({ phase: 'error', message: (err && err.message) || String(err), elapsedMs });
      logLine('[vision] \u8bc6\u522b\u5931\u8d25\uff08' + elapsedMs + 'ms\uff09\uff1a' + ((err && err.message) || String(err)));
      throw err;
    } finally {
      visionRuns.delete(vb.id);
      if (io && io.res) io.res.removeListener('close', onClose);
    }
  });
  rpc.on('getBalance', async () => {
    const result = await queryBalance({ dshHome: state.dshHome });
    if (!result.ok) throw new Error(result.error);
    return result;
  });
  rpc.on('getUsage', async (params) => {
    // 在子进程扫描（解压全部会话文件很重，直接调用会周期性阻塞主进程造成 UI 卡顿）
    try {
      return await runUsageScanChild({
        dshHome: state.dshHome,
        workspace: (params && params.workspace) || state.workspace,
        usagePrices: settings.get('usagePrices'),
      });
    } catch {
      return scanWorkspaceUsage({
        dshHome: state.dshHome,
        workspace: (params && params.workspace) || state.workspace,
        usagePrices: settings.get('usagePrices'),
      });
    }
  });

  /* ---- Windows 电脑操控（Codex/Claude computer-use 风格） ---- */

  rpc.on('computerMouse', async (params) => {
    const args = ['mouse', String((params && params.action) || 'position')];
    for (const key of ['x', 'y', 'dx', 'dy', 'amount']) {
      if (params && typeof params[key] === 'number') args.push('--' + key, String(Math.round(params[key])));
    }
    return winControl.exec(args);
  });

  rpc.on('computerKeyboard', async (params) => {
    const action = String((params && params.action) || 'type');
    const args = ['keyboard', action];
    if (action === 'type' && params && typeof params.text === 'string') args.push('--text', params.text);
    if (action === 'press' && params && typeof params.keys === 'string') args.push('--keys', params.keys);
    return winControl.exec(args);
  });

  rpc.on('computerWindow', async (params) => {
    const action = String((params && params.action) || 'list');
    const args = ['window', action];
    if (params && typeof params.title === 'string' && params.title) args.push('--title', params.title);
    if (params && (typeof params.hwnd === 'string' || typeof params.hwnd === 'number')) args.push('--hwnd', String(params.hwnd));
    for (const key of ['x', 'y', 'w', 'h']) {
      if (params && typeof params[key] === 'number') args.push('--' + key, String(Math.round(params[key])));
    }
    return winControl.exec(args);
  });

  rpc.on('computerClipboard', async (params) => {
    const action = String((params && params.action) || 'get');
    const args = ['clipboard', action];
    if (action === 'set') args.push('--text', String((params && params.text) || ''));
    return winControl.exec(args);
  });

  rpc.on('computerLaunch', async (params) => {
    const target = String((params && params.target) || '').trim();
    if (!target) throw new Error('\u7f3a\u5c11\u542f\u52a8\u76ee\u6807\uff08target\uff09');
    return winControl.exec(['launch', '--target', target]);
  });

  rpc.on('computerScreen', async () => {
    return winControl.exec(['screen']);
  });

  // 看屏幕：全屏截图（可选区域），保存到工作区附件目录；视觉模型启用时自动识别。
  // region 坐标为物理像素（与保存的截图文件同一坐标系，如 1920×1080 全屏内取 0..1919/0..1079），
  // 越界部分自动裁剪到屏幕边界，实际裁剪结果随 result.crop 返回。
  rpc.on('computerScreenshot', async (params, io) => {
    const region = params && params.region && typeof params.region === 'object' ? params.region : null;
    let img = null;
    if (params && params.target === 'self') {
      // 截桌面端自己窗口的内容（capturePage）：不受其他窗口叠放/遮挡影响——
      // 屏幕截图在 ChatGPT 等全屏窗口与 DSH 重叠时会截错窗口
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('桌面窗口不可用');
      img = await mainWindow.webContents.capturePage();
    } else {
      const display = screen.getPrimaryDisplay();
      const sf = display.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) },
      });
      const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      if (!source) throw new Error('\u65e0\u6cd5\u83b7\u53d6\u5c4f\u5e55\u5185\u5bb9');
      img = source.thumbnail;
    }
    const fullSize = img.getSize();
    let crop = null;
    if (region) {
      // region 已是物理像素（与截图文件一致），不再乘 scaleFactor；越界静默裁剪到屏幕边界
      const rx = Math.max(0, Math.round(Number(region.x) || 0));
      const ry = Math.max(0, Math.round(Number(region.y) || 0));
      const rw = Math.min(fullSize.width - rx, Math.max(1, Math.round(Number(region.width) || fullSize.width)));
      const rh = Math.min(fullSize.height - ry, Math.max(1, Math.round(Number(region.height) || fullSize.height)));
      if (rw > 0 && rh > 0) {
        img = img.crop({ x: rx, y: ry, width: rw, height: rh });
        crop = { x: rx, y: ry, width: rw, height: rh };
      }
    }
    const png = img.toPNG();
    const attachDir = path.join(state.workspace, '.dsh-attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const file = path.join(attachDir, 'screen-' + Date.now() + '.png');
    fs.writeFileSync(file, png);
    const result = { path: file, width: img.getSize().width, height: img.getSize().height };
    if (crop) result.crop = crop;
    const vision = settings.get('vision');
    // 当前会话模型是官方多模态（vision-exp 等）时模型自己看图，跳过本地识别（避免白等数分钟）。
    const currentModel = currentModelCached();
    if (vision && vision.enabled && !modelSupportsVision(currentModel)) {
      const vb = visionBroadcast();
      await ensureOllamaMode(); // 显存感知：GPU 可用则 GPU，否则纯 CPU
      vb.send({ phase: 'start' });
      // 客户端断开时取消推理，避免空转浪费 CPU（监听 res 'close'，见 describeImage 注释）。
      const controller = new AbortController();
      visionRuns.set(vb.id, controller);
      const onClose = () => { if (io && io.res && !io.res.writableEnded) controller.abort(); };
      if (io && io.res) io.res.on('close', onClose);
      try {
        const description = await describeImage(effectiveVision(vision), {
          path: file,
          question: params && params.question,
          dshHome: state.dshHome,
          timeoutMs: 480000,
          stream: true,
          onDelta: (text) => vb.send({ phase: 'delta', text }),
        onReset: () => vb.send({ phase: 'reset' }),
          signal: controller.signal,
        });
        const shotElapsed = Date.now() - vb.startedAt;
        vb.send({ phase: 'done', elapsedMs: shotElapsed, chars: description.length });
        logLine('[vision] \u622a\u56fe\u8bc6\u522b\u5b8c\u6210\uff1a' + shotElapsed + 'ms\uff0c' + description.length + '\u5b57\u7b26');
        result.description = description;
        result.descriptionElapsedMs = shotElapsed;
      } catch (err) {
        const shotElapsed = Date.now() - vb.startedAt;
        if (controller.signal.aborted) {
          vb.send({ phase: 'error', cancelled: true, message: '\u5df2\u624b\u52a8\u505c\u6b62\u8bc6\u522b', elapsedMs: shotElapsed });
          logLine('[vision] \u622a\u56fe\u8bc6\u522b\u5df2\u505c\u6b62\uff08' + shotElapsed + 'ms\uff09');
          result.descriptionError = '\u5df2\u624b\u52a8\u505c\u6b62\u8bc6\u522b';
        } else {
          vb.send({ phase: 'error', message: (err && err.message) || String(err), elapsedMs: shotElapsed });
          logLine('[vision] \u622a\u56fe\u8bc6\u522b\u5931\u8d25\uff08' + shotElapsed + 'ms\uff09\uff1a' + ((err && err.message) || String(err)));
          result.descriptionError = (err && err.message) || String(err);
        }
      } finally {
        visionRuns.delete(vb.id);
        if (io && io.res) io.res.removeListener('close', onClose);
      }
    }
    return result;
  });

  /* ---- UI 内省（读自己窗口 DOM：结构化定位/精确点击/读文本，告别截图猜坐标） ---- */

  async function evalInMainWindow(code) {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.webContents || mainWindow.webContents.isDestroyed()) {
      throw new Error('\u684c\u9762\u7a97\u53e3\u4e0d\u53ef\u7528');
    }
    return await mainWindow.webContents.executeJavaScript(code, true);
  }

  rpc.on('uiSnapshot', async () => {
    const raw = await evalInMainWindow(uiIntrospect.snapshotScript());
    return { ok: true, ...uiIntrospect.normalizeSnapshot(raw) };
  });

  rpc.on('uiClick', async (params) => {
    const result = await evalInMainWindow(uiIntrospect.clickScript(params || {}));
    return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
  });

  rpc.on('uiText', async (params) => {
    const selector = String((params && params.selector) || '');
    if (!selector) return { ok: false, error: 'selector \u5fc5\u586b' };
    const result = await evalInMainWindow(uiIntrospect.textScript(selector, params && params.cap));
    return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
  });

  rpc.on('uiCaptureSelf', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('\u684c\u9762\u7a97\u53e3\u4e0d\u53ef\u7528');
    const cap = await mainWindow.webContents.capturePage();
    const png = cap.toPNG();
    const attachDir = path.join(state.workspace, '.dsh-attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const file = path.join(attachDir, 'ui-capture-' + Date.now() + '.png');
    fs.writeFileSync(file, png);
    return { ok: true, path: file, width: cap.getSize().width, height: cap.getSize().height };
  });

  /* ---- 定时任务 / 提醒（模型可自建） ---- */

  rpc.on('scheduleList', async () => scheduleList());

  rpc.on('scheduleAdd', async (params) => {
    const task = params && params.task;
    if (!task || !task.task) throw new Error('\u4efb\u52a1\u5185\u5bb9\u4e3a\u7a7a');
    const clean = {
      id: task.id || 'sched-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      label: String(task.label || '').slice(0, 80),
      kind: task.kind === 'task' ? 'task' : 'reminder',
      mode: ['once', 'daily', 'interval'].includes(task.mode) ? task.mode : 'once',
      at: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(task.at || '').trim()) ? String(task.at).trim() : '09:00',
      everyMinutes: Number.isFinite(Number(task.everyMinutes)) && Number(task.everyMinutes) >= 1 ? Math.round(Number(task.everyMinutes)) : 60,
      task: String(task.task).slice(0, 4000),
      enabled: task.enabled !== false,
      lastRun: null,
    };
    scheduleSave([...scheduleList().filter((t) => t && t.id !== clean.id), clean]);
    return clean;
  });

  rpc.on('scheduleRemove', async (params) => {
    const id = String((params && params.id) || '');
    scheduleSave(scheduleList().filter((t) => t && t.id !== id));
    return { ok: true };
  });

  rpc.on('scheduleToggle', async (params) => {
    const id = String((params && params.id) || '');
    scheduleSave(scheduleList().map((t) => (t && t.id === id ? { ...t, enabled: params.enabled !== false } : t)));
    return { ok: true };
  });

  /* ---- Windows 系统环境（体检/修复/环境变量，模型可自助修电脑） ---- */

  rpc.on('systemDoctor', async () => systemOps.doctor());
  rpc.on('systemFix', async (params) => systemOps.applyFix(params && params.fix));
  rpc.on('systemEnvList', async () => systemOps.envList());
  rpc.on('systemEnvSet', async (params) => {
    const name = String((params && params.name) || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('\u73af\u5883\u53d8\u91cf\u540d\u65e0\u6548');
    return systemOps.envSet(name, params && params.value);
  });
  rpc.on('systemEnvRemove', async (params) => systemOps.envRemove(String((params && params.name) || '')));

  /* ---- 项目代码地图（长代码/大项目：首次精读建图，更新后增量补图） ---- */

  /** 当前活动会话目录名（MCP 调用未显式带 sessionId 时的归属兜底）。 */
  function activeSessionId() {
    try {
      const root = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
      const active = findActiveSession(root);
      return active ? active.sessionId : null;
    } catch { return null; }
  }

  /** 地图状态（含 git HEAD 变化判定）。 */
  async function projectMapStatusPayload() {
    let gitH = null;
    try { gitH = await gitHead(state.workspace); } catch { /* 忽略 */ }
    return projectMap.mapStatus(state.workspace, { currentGitHead: gitH || undefined });
  }

  rpc.on('projectMapGet', async () => {
    const map = projectMap.readMap(state.workspace);
    const status = await projectMapStatusPayload();
    return { ok: true, exists: map != null, map, ...status };
  });

  rpc.on('projectMapStatus', async () => ({ ok: true, ...(await projectMapStatusPayload()) }));

  rpc.on('projectMapSet', async (params) => {
    let gitH = null;
    try { gitH = await gitHead(state.workspace); } catch { /* 忽略 */ }
    const result = projectMap.saveMap(state.workspace, {
      map: params && params.map,
      files: params && params.files,
      gitHead: gitH || undefined,
      updatedBySession: (params && params.sessionId) || activeSessionId(),
    });
    if (result && result.ok) broadcastPanelRefresh('project-map');
    return result;
  });

  /* ---- 多会话编辑占用 + 变更日志 + 快照（互不干扰 + 可回溯） ---- */

  rpc.on('editClaim', async (params) => {
    const sid = (params && params.sessionId) || activeSessionId();
    const result = workspaceGuard.claimFiles(state.workspace, { ...(params || {}), sessionId: sid });
    if (result && result.ok) broadcastPanelRefresh('edit-claim');
    return result;
  });
  rpc.on('editRelease', async (params) => {
    const result = workspaceGuard.releaseFiles(state.workspace, {
      ...(params || {}), sessionId: (params && params.sessionId) || activeSessionId(),
    });
    if (result && result.ok && result.released && result.released.length) broadcastPanelRefresh('edit-release');
    return result;
  });
  rpc.on('editStatus', async (params) => workspaceGuard.claimsStatus(state.workspace, {
    sessionId: (params && params.sessionId) || activeSessionId(),
  }));
  rpc.on('editJournal', async (params) => ({ ok: true, entries: workspaceGuard.readJournal(state.workspace, params && params.limit) }));

  /* ---- Git（代理可用的安全白名单操作；全部走 git-runner 白名单封装） ---- */

  rpc.on('gitInit', async () => {
    const result = await gitInit(state.workspace);
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });
  rpc.on('gitStatus', async () => gitStatus(state.workspace));
  rpc.on('gitDiff', async (params) => gitDiff(state.workspace, params || {}));
  rpc.on('gitLog', async (params) => gitLog(state.workspace, params || {}));
  rpc.on('gitCommit', async (params) => {
    const result = await gitCommit(state.workspace, {
      ...(params || {}), sessionId: (params && params.sessionId) || activeSessionId(),
    });
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });
  rpc.on('gitBranch', async () => gitBranch(state.workspace));
  rpc.on('gitCheckout', async (params) => {
    const result = await gitCheckout(state.workspace, params || {});
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });
  rpc.on('gitRestore', async (params) => {
    const result = await gitRestore(state.workspace, params || {});
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });
  rpc.on('gitStash', async (params) => {
    const result = await gitStash(state.workspace, params || {});
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });

  /* ---- GitHub 集成（设备码登录 / 远程仓库 / 代码搜索 / 推送拉取合并） ---- */

  // 进行中的设备码登录（进程内保存 deviceCode，不落盘）
  let pendingDeviceFlow = null;

  rpc.on('githubStatus', async () => {
    const st = await githubOps.status(state.dshHome);
    // 附带本地仓库远程信息（分支工作流需要）
    try {
      const remote = await gitRemoteList(state.workspace);
      st.remote = remote.ok ? String(remote.output || '').trim() : null;
    } catch { st.remote = null; }
    try {
      st.branch = await gitCurrentBranch(state.workspace);
    } catch { st.branch = null; }
    // 远程仓库可见性（有 origin 且已登录时查一次 API）
    try {
      const auth = githubOps.readAuth(state.dshHome);
      const fullName = githubOps.parseRepoFullName(st.remote || '');
      st.repoFullName = fullName;
      if (auth && fullName) {
        const repo = await githubOps.getRepo(auth.token, fullName);
        if (repo) {
          st.visibility = repo.visibility;
          st.repoHtmlUrl = repo.htmlUrl;
          st.isPrivate = repo.isPrivate;
        }
      }
    } catch { /* 查询失败不影响其余状态 */ }
    return { ok: true, ...st };
  });

  rpc.on('githubSetVisibility', async (params) => {
    const auth = githubOps.readAuth(state.dshHome);
    if (!auth) return { ok: false, error: '未登录 GitHub' };
    const remote = await gitRemoteList(state.workspace);
    const fullName = githubOps.parseRepoFullName(remote.ok ? String(remote.output || '') : '');
    if (!fullName) return { ok: false, error: '未关联 GitHub 远程仓库（先 github_remote_setup）' };
    const isPrivate = params && params.isPrivate !== undefined ? Boolean(params.isPrivate) : true;
    const repo = await githubOps.setRepoVisibility(auth.token, fullName, isPrivate);
    broadcastPanelRefresh('git');
    return { ok: true, ...repo };
  });

  rpc.on('githubLoginStart', async () => {
    const flow = await githubOps.deviceFlowStart();
    pendingDeviceFlow = { deviceCode: flow.deviceCode, expiresAt: Date.now() + flow.expiresIn * 1000 };
    const { deviceCode, ...safe } = flow;
    return { ok: true, ...safe };
  });

  rpc.on('githubLoginPoll', async () => {
    if (!pendingDeviceFlow) return { ok: false, error: '未发起登录（先调 githubLoginStart）' };
    if (Date.now() > pendingDeviceFlow.expiresAt) {
      pendingDeviceFlow = null;
      return { ok: false, error: '登录码已过期，请重新发起' };
    }
    const r = await githubOps.deviceFlowPoll(pendingDeviceFlow.deviceCode);
    if (!r.pending) {
      // 拿到 token：解析用户并存档
      const user = await githubOps.whoami(r.token);
      githubOps.writeAuth(state.dshHome, { token: r.token, login: user.login, authedAt: Date.now() });
      pendingDeviceFlow = null;
      return { ok: true, pending: false, login: user.login, name: user.name };
    }
    return { ok: true, pending: true, slowDown: r.slowDown === true };
  });

  rpc.on('githubLogout', async () => {
    pendingDeviceFlow = null;
    githubOps.clearAuth(state.dshHome);
    return { ok: true };
  });

  /** 一键关联远程：登录态校验 → 创建私有仓库（同名已存在则复用）→ origin → 推送当前分支。 */
  rpc.on('githubRemoteSetup', async (params) => {
    const auth = githubOps.readAuth(state.dshHome);
    if (!auth) return { ok: false, error: '未登录 GitHub（先登录再关联）' };
    // 已有 origin 则跳过创建，直接推送
    const existing = await gitRemoteList(state.workspace);
    let repo = null;
    if (!existing.ok || !String(existing.output || '').trim()) {
      const name = String((params && params.name) || '').trim() || githubOps.suggestRepoName(state.workspace);
      const isPrivate = params && params.isPrivate !== undefined ? Boolean(params.isPrivate) : true;
      try {
        repo = await githubOps.createRepo(auth.token, { name, description: 'DSH Desktop workspace: ' + path.basename(state.workspace), isPrivate });
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
      const added = await gitRemoteAdd(state.workspace, { name: 'origin', url: repo.cloneUrl });
      if (!added.ok) return { ok: false, error: '远程关联失败：' + (added.error || added.output) };
    }
    const pushed = await gitPush(state.workspace, { remote: 'origin' });
    if (!pushed.ok) return { ok: false, error: '推送失败：' + (pushed.error || pushed.output) };
    broadcastPanelRefresh('git');
    return { ok: true, repo: repo && { name: repo.name, fullName: repo.fullName, htmlUrl: repo.htmlUrl, isPrivate: repo.isPrivate }, pushed: pushed.output };
  });

  rpc.on('githubSearchCode', async (params) => {
    const auth = githubOps.readAuth(state.dshHome);
    if (!auth) return { ok: false, error: '未登录 GitHub' };
    const q = String((params && params.q) || '').trim();
    if (!q) return { ok: false, error: 'q 必填（GitHub 代码搜索语法，如 repo:owner/name keyword）' };
    const result = await githubOps.searchCode(auth.token, q, params && params.perPage);
    return { ok: true, ...result };
  });

  rpc.on('gitPush', async (params) => {
    const result = await gitPush(state.workspace, params || {});
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });
  rpc.on('gitPull', async (params) => {
    const result = await gitPull(state.workspace, params || {});
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });
  rpc.on('gitMerge', async (params) => {
    const result = await gitMerge(state.workspace, params || {});
    if (result && result.ok) broadcastPanelRefresh('git');
    return result;
  });
  rpc.on('gitRemoteList', async () => gitRemoteList(state.workspace));

  return rpc.start();
}

/* ---------- IPC ---------- */

function registerIpc() {
  ipcMain.handle('dsh:state', () => state);
  ipcMain.handle('dsh:retry', () => { startHarness(); return { ok: true }; });
  ipcMain.handle('dsh:choose-workspace', () => { chooseWorkspace(); return { ok: true }; });
  ipcMain.handle('dsh:open-logs', () => { fs.mkdirSync(logDir, { recursive: true }); shell.openPath(logDir); return { ok: true }; });
  ipcMain.handle('dsh:update-check', () => { checkUpdates({ manual: true }); return { ok: true }; });
  ipcMain.handle('dsh:update-apply', () => {
    if (state.updateAvailable && state.latest) {
      promptUpdate({ installed: state.installed, latest: state.latest });
    }
    return { ok: true };
  });
  ipcMain.handle('dsh:show-main', () => { showMainWindow(); return { ok: true }; });
  ipcMain.handle('dsh:restart', async () => {
    quitting = true;
    if (harness) await harness.stop().catch(() => {});
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
  ipcMain.handle('dsh:headless-run', async (event, payload) => {
    const task = String((payload && payload.task) || '').trim();
    if (!task) return { ok: false, error: '\u4efb\u52a1\u5185\u5bb9\u4e3a\u7a7a' };
    if (headlessRunner) headlessRunner.cancel();
    const win = BrowserWindow.fromWebContents(event.sender);
    headlessRunner = runHeadless({
      binPath: dshBinPath(),
      cwd: state.workspace,
      env: buildChildEnv(),
      task,
      onData: (stream, text) => {
        if (win && !win.isDestroyed()) win.webContents.send('dsh:headless-data', { stream, text });
      },
      onExit: (code) => {
        if (win && !win.isDestroyed()) win.webContents.send('dsh:headless-exit', { code });
        headlessRunner = null;
      },
      onError: (message) => {
        if (win && !win.isDestroyed()) win.webContents.send('dsh:headless-exit', { code: -1, error: message });
        headlessRunner = null;
      },
    });
    return { ok: true };
  });
  ipcMain.handle('dsh:headless-cancel', () => {
    if (headlessRunner) headlessRunner.cancel();
    return { ok: true };
  });
}

/* ---------- MCP / 插件管理（设置页） ---------- */

function mcpListPayload() {
  return {
    servers: settings.get('mcpServers') || [],
    enableDesktopMcp: settings.get('enableDesktopMcp'),
    builtin: 'dsh_desktop',
  };
}

/** 规范化一个 MCP 服务器配置（与 web-patch.js 的字段约定一致）。 */
function sanitizeMcpServer(server) {
  const name = String((server && server.serverName) || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return null;
  const clean = { serverName: name, transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio' };
  if (clean.transport === 'streamable-http') {
    if (server.url) clean.url = String(server.url);
    if (server.headers && typeof server.headers === 'object') clean.headers = server.headers;
  } else {
    if (server.command) clean.command = String(server.command);
    if (Array.isArray(server.args)) clean.args = server.args.map(String);
    if (server.env && typeof server.env === 'object') clean.env = server.env;
    if (server.cwd) clean.cwd = String(server.cwd);
  }
  if (server.failOnStartupError) clean.failOnStartupError = true;
  if (typeof server.toolCallTimeoutMs === 'number') clean.toolCallTimeoutMs = server.toolCallTimeoutMs;
  if (server.reconnect && typeof server.reconnect === 'object') clean.reconnect = server.reconnect;
  clean.enabled = server.enabled !== false;
  return clean;
}

function registerMcpPluginIpc() {
  ipcMain.handle('dsh:mcp-list', () => ({ ok: true, ...mcpListPayload() }));

  ipcMain.handle('dsh:mcp-save', (_event, payload) => {
    const clean = sanitizeMcpServer(payload && payload.server);
    if (!clean) return { ok: false, error: 'serverName \u9700\u4e3a 1-32 \u4f4d\u5b57\u6bcd\u3001\u6570\u5b57\u3001\u4e0b\u5212\u7ebf\u6216\u77ed\u6a2a\u7ebf' };
    if (clean.transport === 'stdio' && !clean.command) return { ok: false, error: 'stdio \u4f20\u8f93\u9700\u8981 command' };
    if (clean.transport === 'streamable-http' && !clean.url) return { ok: false, error: 'HTTP \u4f20\u8f93\u9700\u8981 url' };
    const list = (settings.get('mcpServers') || []).slice();
    const index = list.findIndex((s) => s && s.serverName === clean.serverName);
    if (index >= 0) list[index] = clean;
    else list.push(clean);
    settings.set('mcpServers', list);
    return { ok: true, ...mcpListPayload() };
  });

  ipcMain.handle('dsh:mcp-remove', (_event, payload) => {
    const name = String((payload && payload.serverName) || '');
    const list = (settings.get('mcpServers') || []).filter((s) => s && s.serverName !== name);
    settings.set('mcpServers', list);
    return { ok: true, ...mcpListPayload() };
  });

  ipcMain.handle('dsh:mcp-toggle', (_event, payload) => {
    const name = String((payload && payload.serverName) || '');
    const list = (settings.get('mcpServers') || []).map((s) => {
      if (s && s.serverName === name) return { ...s, enabled: payload.enabled !== false };
      return s;
    });
    settings.set('mcpServers', list);
    return { ok: true, ...mcpListPayload() };
  });

  ipcMain.handle('dsh:mcp-set-builtin', (_event, payload) => {
    settings.set('enableDesktopMcp', payload.enableDesktopMcp !== false);
    return { ok: true, ...mcpListPayload() };
  });

  // 应用 MCP 更改：重新生成注入补丁并重启 harness 服务（页面将刷新）。
  ipcMain.handle('dsh:mcp-apply', () => {
    generatePatchFile();
    startHarness();
    return { ok: true };
  });

  ipcMain.handle('dsh:desktop-plugins', () => ({
    ok: true,
    enableDesktopMcp: settings.get('enableDesktopMcp'),
    mcpServers: (settings.get('mcpServers') || []).length,
    settingsUi: true,
    patchDropped: state.patchDropped,
  }));

  const runPluginOp = (args, event) => new Promise((resolve) => {
    if (pluginRunner) pluginRunner.cancel();
    const win = BrowserWindow.fromWebContents(event.sender);
    pluginRunner = runDshPlugin({
      binPath: dshBinPath(),
      profile: 'web',
      args,
      cwd: state.workspace,
      env: buildChildEnv(),
      onData: (text) => {
        if (win && !win.isDestroyed()) win.webContents.send('dsh:plugin-output', { text });
      },
      onExit: (code) => {
        pluginRunner = null;
        resolve({ ok: code === 0, code });
      },
      onError: (message) => {
        pluginRunner = null;
        resolve({ ok: false, error: message });
      },
    });
  });

  ipcMain.handle('dsh:plugin-install', async (event, payload) => {
    const pkg = String((payload && payload.pkg) || '').trim();
    if (!pkg) return { ok: false, error: '\u5305\u540d\u4e3a\u7a7a' };
    return runPluginOp(['add', pkg], event);
  });

  ipcMain.handle('dsh:plugin-remove', async (event, payload) => {
    const pkg = String((payload && payload.pkg) || '').trim();
    if (!pkg) return { ok: false, error: '\u5305\u540d\u4e3a\u7a7a' };
    return runPluginOp(['remove', pkg], event);
  });

  ipcMain.handle('dsh:plugin-cancel', () => {
    if (pluginRunner) pluginRunner.cancel();
    return { ok: true };
  });
}

/* ---------- 桌面功能 IPC ---------- */

function registerDesktopFeatureIpc() {
  ipcMain.handle('dsh:git-summary', async () => {
    if (!state.workspace) return { ok: false, error: '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a' };
    try {
      // 非 git 目录快速返回（避免每次轮询都拉起 3 条 git 命令）
      if (!fs.existsSync(path.join(state.workspace, '.git'))) {
        logLine('[git-summary] not a git repo（workspace=' + state.workspace + '）');
        return { ok: true, output: '# 当前目录不是 Git 仓库', workspace: state.workspace, notGit: true };
      }
      const output = await gitSummary(state.workspace);
      // 诊断日志：面板「非 Git 工作区」排查用（输出不含敏感信息）
      const head = String(output || '').split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ');
      logLine('[git-summary] ok，head=' + head.slice(0, 200));
      return { ok: true, output, workspace: state.workspace };
    } catch (err) {
      logLine('[git-summary] 失败：' + ((err && err.message) || err));
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:project-map-status', async () => {
    if (!state.workspace) return { ok: false, error: '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a' };
    try {
      let gitH = null;
      try { gitH = await gitHead(state.workspace); } catch { /* 忽略 */ }
      return { ok: true, ...projectMap.mapStatus(state.workspace, { currentGitHead: gitH || undefined }) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:edit-status', async () => {
    if (!state.workspace) return { ok: false, error: '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a' };
    try {
      const root = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
      const active = findActiveSession(root);
      return { ok: true, ...workspaceGuard.claimsStatus(state.workspace, { sessionId: active ? active.sessionId : null }), currentSessionId: active ? active.sessionId : null };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // GitHub 集成（设置页分区：登录状态 / 设备码登录 / 一键关联远程仓库）
  const githubStatusPayload = async () => {
    const st = await githubOps.status(state.dshHome);
    try {
      const remote = await gitRemoteList(state.workspace);
      st.remote = remote.ok ? String(remote.output || '').trim() : null;
    } catch { st.remote = null; }
    try {
      st.branch = await gitCurrentBranch(state.workspace);
    } catch { st.branch = null; }
    try {
      const auth = githubOps.readAuth(state.dshHome);
      const fullName = githubOps.parseRepoFullName(st.remote || '');
      st.repoFullName = fullName;
      if (auth && fullName) {
        const repo = await githubOps.getRepo(auth.token, fullName);
        if (repo) {
          st.visibility = repo.visibility;
          st.repoHtmlUrl = repo.htmlUrl;
          st.isPrivate = repo.isPrivate;
        }
      }
    } catch { /* 查询失败不影响其余状态 */ }
    return { ok: true, ...st };
  };

  ipcMain.handle('dsh:github-status', async () => {
    try { return await githubStatusPayload(); } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  ipcMain.handle('dsh:github-visibility-set', async (_event, payload) => {
    try {
      const auth = githubOps.readAuth(state.dshHome);
      if (!auth) return { ok: false, error: '未登录 GitHub' };
      const remote = await gitRemoteList(state.workspace);
      const fullName = githubOps.parseRepoFullName(remote.ok ? String(remote.output || '') : '');
      if (!fullName) return { ok: false, error: '未关联 GitHub 远程仓库' };
      const isPrivate = payload && payload.isPrivate !== undefined ? Boolean(payload.isPrivate) : true;
      const repo = await githubOps.setRepoVisibility(auth.token, fullName, isPrivate);
      broadcastPanelRefresh('git');
      return { ok: true, ...repo };
    } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  // 用系统浏览器打开外链（GitHub 验证页等）
  ipcMain.handle('dsh:open-external', async (_event, payload) => {
    const url = String((payload && payload.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅允许 http(s) 链接' };
    try { await shell.openExternal(url); return { ok: true }; } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  // 客户端诊断回报：面板实际收到的数据回传主进程日志（不存盘、不含敏感信息）
  ipcMain.handle('dsh:client-debug', async (_event, payload) => {
    try {
      const safe = payload && typeof payload === 'object' ? payload : {};
      logLine('[client-debug] ' + JSON.stringify(safe).slice(0, 400));
      return { ok: true };
    } catch { return { ok: false }; }
  });

  let pendingDeviceFlow = null; // 设备码登录进行中（进程内）

  ipcMain.handle('dsh:github-login-start', async () => {
    try {
      const flow = await githubOps.deviceFlowStart();
      pendingDeviceFlow = { deviceCode: flow.deviceCode, expiresAt: Date.now() + flow.expiresIn * 1000 };
      const { deviceCode, ...safe } = flow;
      return { ok: true, ...safe };
    } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  ipcMain.handle('dsh:github-login-poll', async () => {
    try {
      if (!pendingDeviceFlow) return { ok: false, error: '未发起登录' };
      if (Date.now() > pendingDeviceFlow.expiresAt) {
        pendingDeviceFlow = null;
        return { ok: false, error: '登录码已过期，请重新发起' };
      }
      const r = await githubOps.deviceFlowPoll(pendingDeviceFlow.deviceCode);
      if (!r.pending) {
        const user = await githubOps.whoami(r.token);
        githubOps.writeAuth(state.dshHome, { token: r.token, login: user.login, authedAt: Date.now() });
        pendingDeviceFlow = null;
        return { ok: true, pending: false, login: user.login, name: user.name };
      }
      return { ok: true, pending: true, slowDown: r.slowDown === true };
    } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  ipcMain.handle('dsh:github-logout', async () => {
    pendingDeviceFlow = null;
    githubOps.clearAuth(state.dshHome);
    return { ok: true };
  });

  ipcMain.handle('dsh:github-remote-setup', async (_event, payload) => {
    try {
      const auth = githubOps.readAuth(state.dshHome);
      if (!auth) return { ok: false, error: '未登录 GitHub' };
      const existing = await gitRemoteList(state.workspace);
      let repo = null;
      if (!existing.ok || !String(existing.output || '').trim()) {
        const name = String((payload && payload.name) || '').trim() || githubOps.suggestRepoName(state.workspace);
        const isPrivate = payload && payload.isPrivate !== undefined ? Boolean(payload.isPrivate) : true;
        repo = await githubOps.createRepo(auth.token, { name, description: 'DSH Desktop workspace: ' + path.basename(state.workspace), isPrivate });
        const added = await gitRemoteAdd(state.workspace, { name: 'origin', url: repo.cloneUrl });
        if (!added.ok) return { ok: false, error: '远程关联失败：' + (added.error || added.output) };
      }
      const pushed = await gitPush(state.workspace, { remote: 'origin' });
      if (!pushed.ok) return { ok: false, error: '推送失败：' + (pushed.error || pushed.output) };
      broadcastPanelRefresh('git');
      return { ok: true, repo: repo && { name: repo.name, fullName: repo.fullName, htmlUrl: repo.htmlUrl, isPrivate: repo.isPrivate }, pushed: pushed.output };
    } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  // Git 窗操作（提交/回滚/分支），提交自动带活动会话归属前缀
  ipcMain.handle('dsh:git-commit', async (_event, payload) => {
    if (!state.workspace) return { ok: false, error: '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a' };
    try {
      const root = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
      const active = findActiveSession(root);
      const result = await gitCommit(state.workspace, { message: payload && payload.message, sessionId: active ? active.sessionId : 'dsh' });
      if (result && result.ok) broadcastPanelRefresh('git');
      return result;
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:git-restore', async () => {
    if (!state.workspace) return { ok: false, error: '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a' };
    try {
      const result = await gitRestore(state.workspace, {});
      if (result && result.ok) broadcastPanelRefresh('git');
      return result;
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:git-branch', async () => {
    if (!state.workspace) return { ok: false, error: '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a' };
    try {
      return await gitBranch(state.workspace);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:usage-get', async () => {
    try {
      const result = await getUsageSnapshot();
      if (!result.ok) return result;
      const tier = resolvePriceTier(new Date(), settings.get('tierPrices'));
      tier.custom = !!settings.get('tierPrices');
      return { ok: true, summary: { ...result.summary, tier } };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:usage-set-prices', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const { resolveTierPrices } = require('./usage');
    if (p.custom === false) {
      settings.set('tierPrices', null);
    } else {
      settings.set('tierPrices', resolveTierPrices(p.tierPrices));
    }
    return { ok: true, tierPrices: settings.get('tierPrices') };
  });

  ipcMain.handle('dsh:balance-get', async () => {
    const result = await queryBalance({ dshHome: state.dshHome });
    return result.ok ? { ok: true, ...result } : { ok: false, error: result.error };
  });

  // 小米 MiMo 视觉 API 状态探测：调 /v1/models 判断 key 可用性与模型清单。
  // key 只在主进程使用，绝不返回给页面（页面侧 getVision 拿到的是脱敏 key）。
  ipcMain.handle('dsh:mimo-status', async () => {
    try {
      const vision = settings.get('vision');
      if (!vision || vision.enabled === false) return { ok: true, configured: false };
      const base = String(vision.baseUrl || '').toLowerCase();
      if (!base.includes('xiaomimimo') && !base.includes('mimo')) return { ok: true, configured: false };
      const key = String(vision.apiKey || '').trim();
      if (!key) return { ok: true, configured: true, available: false, error: '\u7f3a\u5c11 API key' };
      const body = await fetchJson(base.replace(/\/+$/, '') + '/models', { headers: { Authorization: 'Bearer ' + key } });
      const ids = Array.isArray(body && body.data) ? body.data.map((m) => m && m.id).filter(Boolean) : [];
      return { ok: true, configured: true, available: true, models: ids };
    } catch (err) {
      return { ok: true, configured: true, available: false, error: (err && err.message) || String(err) };
    }
  });

  // 打开小米 MiMo 控制台（余额/配额/用量在网页控制台查看——官方无余额查询 API）。
  ipcMain.handle('dsh:mimo-console', () => {
    shell.openExternal('https://platform.xiaomimimo.com/console/profile');
    return { ok: true };
  });

  ipcMain.handle('dsh:vision-save', (_event, payload) => {
    const vision = payload && payload.vision;
    if (!vision || typeof vision !== 'object') return { ok: false, error: '\u914d\u7f6e\u65e0\u6548' };
    const clean = {
      enabled: vision.enabled !== false,
      baseUrl: String(vision.baseUrl || '').trim(),
      apiKey: String(vision.apiKey || '').trim(),
      model: String(vision.model || '').trim(),
    };
    if (clean.enabled && (!clean.baseUrl || !clean.apiKey || !clean.model)) {
      return { ok: false, error: '\u542f\u7528\u591a\u6a21\u6001\u9700\u8981\u586b\u5199 baseUrl\u3001apiKey\u3001model' };
    }
    settings.set('vision', clean);
    state.visionEnabled = clean.enabled;
    broadcastState();
    return { ok: true, vision: clean };
  });

  ipcMain.handle('dsh:vision-get', () => {
    const vision = settings.get('vision') || {};
    return { ok: true, vision: { ...vision, apiKey: vision.apiKey ? '\u2022\u2022\u2022\u2022' + String(vision.apiKey).slice(-4) : '' }, hasKey: !!vision.apiKey };
  });

  ipcMain.handle('dsh:vision-test', async () => {
    const vision = settings.get('vision');
    try {
      const result = await testVision(vision);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:permission-mode', (_event, payload) => {
    const mode = String((payload && payload.mode) || '');
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) return { ok: false, error: '\u65e0\u6548\u7684\u6743\u9650\u6a21\u5f0f' };
    switchPermissionMode(mode);
    return { ok: true, mode: state.permissionMode };
  });

  ipcMain.handle('dsh:notify-set', (_event, payload) => {
    settings.set('notifyOnComplete', payload.enabled !== false);
    state.notifyOnComplete = payload.enabled !== false;
    broadcastState();
    return { ok: true, notifyOnComplete: state.notifyOnComplete };
  });

  /* ---- 通知免打扰（深夜不弹通知，保留 flashFrame 与日志） ---- */

  /** 校验并规范化 "HH:MM"（非法时回退当前值）。 */
  const normalizeTime = (value, fallback) => {
    const s = String(value || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(s)) return fallback;
    const [h, m] = s.split(':').map(Number);
    if (h > 23 || m > 59) return fallback;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  };

  ipcMain.handle('dsh:quiet-hours-set', (_event, payload) => {
    const enabled = !!(payload && payload.enabled !== false);
    const start = normalizeTime(payload && payload.start, settings.get('quietHoursStart') || '23:00');
    const end = normalizeTime(payload && payload.end, settings.get('quietHoursEnd') || '07:00');
    settings.set('quietHoursEnabled', enabled);
    settings.set('quietHoursStart', start);
    settings.set('quietHoursEnd', end);
    state.quietHoursEnabled = enabled;
    state.quietHoursStart = start;
    state.quietHoursEnd = end;
    broadcastState();
    return { ok: true, enabled, start, end };
  });

  /* ---- 上下文压力告警 ---- */

  ipcMain.handle('dsh:context-warning-set', (_event, payload) => {
    const enabled = payload.enabled !== false;
    settings.set('contextWarningEnabled', enabled);
    state.contextWarningEnabled = enabled;
    if (!enabled) state.contextWarning = null;
    broadcastState();
    return { ok: true, enabled };
  });

  ipcMain.handle('dsh:context-warning-tokens', (_event, payload) => {
    const raw = Math.round(Number(payload && payload.tokens));
    const tokens = Number.isFinite(raw) ? Math.max(10000, Math.min(1000000, raw)) : 100000;
    settings.set('contextWarningTokens', tokens);
    state.contextWarningTokens = tokens;
    broadcastState();
    return { ok: true, tokens };
  });

  ipcMain.handle('dsh:agents-file', (_event, payload) => {
    openAgentsFile(String((payload && payload.scope) || 'workspace') === 'global' ? 'global' : 'workspace');
    return { ok: true };
  });

  ipcMain.handle('dsh:git-diff-window', () => {
    openGitDiffWindow();
    return { ok: true };
  });

  /* ---- Ollama 本地视觉模型集成 ---- */

  ipcMain.handle('dsh:ollama-status', async () => {
    try { return { ok: true, status: await ollama.getStatus() }; }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  ipcMain.handle('dsh:ollama-install', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('dsh:ollama-progress', p); };
    try {
      const result = await ollama.install(send);
      send({ stage: 'done', text: '\u5b89\u88c5\u5b8c\u6210' });
      return { ok: true, ...result };
    } catch (err) {
      send({ stage: 'error', text: (err && err.message) || String(err) });
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:ollama-start', async () => {
    try { return { ok: true, ...(await ollama.start()) }; }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  ipcMain.handle('dsh:ollama-pull', async (event, payload) => {
    const model = String((payload && payload.model) || '').trim();
    if (!model) return { ok: false, error: '\u6a21\u578b\u540d\u4e3a\u7a7a' };
    const win = BrowserWindow.fromWebContents(event.sender);
    const send = (text) => { if (win && !win.isDestroyed()) win.webContents.send('dsh:ollama-output', { text }); };
    try {
      await ollama.pull(model, send);
      return { ok: true };
    } catch (err) {
      send((err && err.message) || String(err));
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:ollama-use-vision', async (_event, payload) => {
    const model = String((payload && payload.model) || '').trim();
    if (!model) return { ok: false, error: '\u6a21\u578b\u540d\u4e3a\u7a7a' };
    try {
      await ollama.start();
      const vision = { enabled: true, baseUrl: ollama.API_BASE + '/v1', apiKey: '', model };
      settings.set('vision', vision);
      state.visionEnabled = true;
      broadcastState();
      const test = await testVision(vision);
      return { ok: true, vision, test };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  /* ---- 截图 / 附件 / 新对话接续 ---- */

  ipcMain.handle('dsh:screenshot', () => { openCaptureWindow(); return { ok: true }; });

  // 截图预热：mousedown 时并行启动全屏捕获，mouseup 提交时大概率已就绪（消除松手后的 1-3s 等待）
  let captureWarm = null; // { promise, at }

  ipcMain.handle('dsh:capture-warmup', async () => {
    try {
      if (captureWarm && Date.now() - captureWarm.at < 5000) return { ok: true, cached: true };
      const display = screen.getPrimaryDisplay();
      const sf = display.scaleFactor || 1;
      captureWarm = {
        at: Date.now(),
        promise: desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) },
        }),
      };
      captureWarm.promise.catch(() => { captureWarm = null; }); // 失败自清，不阻塞
      return { ok: true, cached: false };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:capture-region', async (_event, region) => {
    const t0 = Date.now();
    try {
      const display = screen.getPrimaryDisplay();
      const sf = display.scaleFactor || 1;
      // 优先用预热结果（鼠标拖动期间已并行捕获），过期/未就绪再现场捕获
      let sources = null;
      if (captureWarm && Date.now() - captureWarm.at < 5000) {
        try { sources = await captureWarm.promise; } catch { sources = null; }
      }
      if (!sources) {
        sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) },
        });
      }
      captureWarm = null;
      const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
      if (!source) throw new Error('\u65e0\u6cd5\u83b7\u53d6\u5c4f\u5e55\u5185\u5bb9');
      const img = source.thumbnail.crop({
        x: Math.round((region.x || 0) * sf), y: Math.round((region.y || 0) * sf),
        width: Math.round((region.width || 10) * sf), height: Math.round((region.height || 10) * sf),
      });
      const png = img.toPNG();
      logLine('[screenshot] \u6355\u83b7+\u7f16\u7801 ' + (Date.now() - t0) + 'ms\uff08' + Math.round((region.width || 10) * sf) + 'x' + Math.round((region.height || 10) * sf) + '\uff09');
      clipboard.writeImage(nativeImage.createFromBuffer(png));
      // 持久保存到工作区附件目录（备用；agent 可按需用 dsh_desktop_describe_image 引用）
      let attachDir = path.join(state.workspace || os.tmpdir(), '.dsh-attachments');
      try { fs.mkdirSync(attachDir, { recursive: true }); } catch { attachDir = os.tmpdir(); }
      const file = path.join(attachDir, 'screenshot-' + Date.now() + '.png');
      try { fs.writeFileSync(file, png); } catch (err) { logLine('[screenshot] \u4fdd\u5b58\u622a\u56fe\u5931\u8d25\uff1a' + (err && err.message ? err.message : err)); }
      closeCaptureWindow();
      // 统一走官方附件草稿：图片缩略图进输入框（任何模型都"看见"图片，无文字噪音）。
      // 发送后：官方多模态模型直传 API；纯文本模型由 harness 替换为
      // [image omitted; attachment sha256:...] 占位，agent 依规则自动调
      // describe_image 看图（先总体后细节，注意力由主模型主导）。
      try {
        const dataUrl = 'data:image/png;base64,' + png.toString('base64');
        const win = mainWindow;
        if (win && !win.isDestroyed()) {
          win.webContents.send('dsh:screenshot-ready', { dataUrl, path: file, ts: Date.now() });
          // 预识别（截图时就开始，不阻塞返回）：纯文本模型会话发送截图被拒时，
          // 补救流程可直接用这里的识别结果（零等待），彻底消除"识别中占位被误发"。
          // 识别过程照常经 visionBroadcast 在环境信息面板展示卡片。
          preRecognizeScreenshot(file);
          return { ok: true };
        }
      } catch (err) { logLine('[screenshot] \u8349\u7a3f\u6ce8\u5165\u901a\u77e5\u5931\u8d25\uff1a' + (err && err.message ? err.message : err)); }
      // 兜底：无法注入草稿时给出引用（可 read_image / describe_image 查看）
      injectText('\u3010\u622a\u56fe\u3011\u5df2\u4fdd\u5b58\uff1a' + file);
      return { ok: true };
    } catch (err) {
      closeCaptureWindow();
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:capture-cancel', () => { closeCaptureWindow(); return { ok: true }; });

  ipcMain.handle('dsh:attach-files', async () => { attachFiles(); return { ok: true }; });

  ipcMain.handle('dsh:inject-text', (_event, payload) => {
    const text = String((payload && payload.text) || '');
    if (text) injectText(text);
    return { ok: true };
  });

  ipcMain.handle('dsh:handoff-status', () => {
    const file = state.workspace ? path.join(state.workspace, '.dsh', 'handoff.md') : null;
    return { ok: true, exists: !!(file && fs.existsSync(file)), path: file };
  });

  ipcMain.handle('dsh:continue-conversation', async () => { continueInNewConversation(); return { ok: true }; });

  ipcMain.handle('dsh:open-attachments-dir', () => {
    if (!state.workspace) return { ok: false, error: '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a' };
    const dir = path.join(state.workspace, '.dsh-attachments');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  });

  /* ---- 记忆（自动记忆 + 知识图谱管理） ---- */

  ipcMain.handle('dsh:memory-status', () => {
    const file = memoryFilePath();
    const graph = memoryStore.readGraph(file);
    return {
      ok: true,
      exists: graph.entities.length > 0 || graph.relations.length > 0,
      path: file,
      autoEnabled: settings.get('memoryAutoEnabled') !== false,
      entities: graph.entities.length,
      relations: graph.relations.length,
      lastSeen: settings.get('memoryLastSeen') || null,
    };
  });

  ipcMain.handle('dsh:memory-list', () => {
    const graph = memoryStore.readGraph(memoryFilePath());
    return { ok: true, entities: graph.entities, relations: graph.relations };
  });

  ipcMain.handle('dsh:memory-delete', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const result = memoryStore.deleteFromFile(
      memoryFilePath(),
      Array.isArray(p.entities) ? p.entities : [],
      Array.isArray(p.observations) ? p.observations : [],
    );
    return { ok: true, ...result };
  });

  ipcMain.handle('dsh:memory-add', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const entities = Array.isArray(p.entities) ? p.entities : [];
    const relations = Array.isArray(p.relations) ? p.relations : [];
    if (!entities.length && !relations.length) return { ok: false, error: '\u8bf7\u63d0\u4f9b\u5b9e\u4f53\u6216\u5173\u7cfb' };
    const result = memoryStore.mergeIntoFile(memoryFilePath(), entities, relations);
    return { ok: true, ...result };
  });

  ipcMain.handle('dsh:memory-set-auto', (_event, payload) => {
    const enabled = !!(payload && payload.enabled);
    settings.set('memoryAutoEnabled', enabled);
    state.memoryAutoEnabled = enabled;
    broadcastState();
    return { ok: true, enabled };
  });

  ipcMain.handle('dsh:memory-open', () => {
    const file = memoryFilePath();
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '', 'utf8');
    }
    shell.openPath(file);
    return { ok: true };
  });

  /* ---- 子代理中心（聚合展示子代理进度/状态/耗时/token，纯文件读取） ---- */

  ipcMain.handle('dsh:subagents-list', () => getSubagentsSnapshot());

  /* ---- 开机自启 / 关闭到托盘 ---- */

  ipcMain.handle('dsh:autostart-set', (_event, payload) => {
    return applyAutoStart(payload.enabled !== false);
  });

  ipcMain.handle('dsh:tray-set', (_event, payload) => {
    settings.set('closeToTray', payload.enabled !== false);
    state.closeToTray = payload.enabled !== false;
    broadcastState();
    return { ok: true, closeToTray: state.closeToTray };
  });

  /* ---- 快速命令框 ---- */

  ipcMain.handle('dsh:quick-submit', (_event, payload) => {
    if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
    const text = String((payload && payload.text) || '').trim();
    if (text) dispatchTaskToHarness(text, { send: payload.send !== false });
    return { ok: true };
  });

  ipcMain.handle('dsh:quick-cancel', () => {
    if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
    return { ok: true };
  });

  ipcMain.handle('dsh:quick-toggle', () => { toggleQuickCommand(); return { ok: true }; });

  /* ---- 定时任务 / 提醒 ---- */

  ipcMain.handle('dsh:schedule-list', () => ({ ok: true, tasks: scheduleList() }));

  ipcMain.handle('dsh:schedule-add', (_event, payload) => {
    const task = payload && payload.task;
    if (!task || !task.task) return { ok: false, error: '\u4efb\u52a1\u5185\u5bb9\u4e3a\u7a7a' };
    const clean = {
      id: task.id || 'sched-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      label: String(task.label || '').slice(0, 80),
      kind: task.kind === 'task' ? 'task' : 'reminder',
      mode: ['once', 'daily', 'interval'].includes(task.mode) ? task.mode : 'once',
      at: /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(task.at || '').trim()) ? String(task.at).trim() : '09:00',
      everyMinutes: Number.isFinite(Number(task.everyMinutes)) && Number(task.everyMinutes) >= 1 ? Math.round(Number(task.everyMinutes)) : 60,
      task: String(task.task).slice(0, 4000),
      enabled: task.enabled !== false,
      lastRun: null,
    };
    const list = scheduleList().filter((t) => t && t.id !== clean.id);
    list.push(clean);
    scheduleSave(list);
    return { ok: true, tasks: scheduleList() };
  });

  ipcMain.handle('dsh:schedule-remove', (_event, payload) => {
    const id = String((payload && payload.id) || '');
    scheduleSave(scheduleList().filter((t) => t && t.id !== id));
    return { ok: true, tasks: scheduleList() };
  });

  ipcMain.handle('dsh:schedule-toggle', (_event, payload) => {
    const id = String((payload && payload.id) || '');
    const list = scheduleList().map((t) => (t && t.id === id ? { ...t, enabled: payload.enabled !== false } : t));
    scheduleSave(list);
    return { ok: true, tasks: scheduleList() };
  });

  ipcMain.handle('dsh:schedule-run-now', (_event, payload) => {
    const id = String((payload && payload.id) || '');
    const task = scheduleList().find((t) => t && t.id === id);
    if (!task) return { ok: false, error: '\u4efb\u52a1\u4e0d\u5b58\u5728' };
    fireScheduledTask(task);
    return { ok: true };
  });

  /* ---- Windows 系统环境 ---- */

  ipcMain.handle('dsh:system-doctor', () => {
    try { return { ok: true, items: systemOps.doctor() }; }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  ipcMain.handle('dsh:system-fix', (_event, payload) => {
    try { return systemOps.applyFix(payload && payload.fix); }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  ipcMain.handle('dsh:system-env-list', () => ({ ok: true, vars: systemOps.envList() }));

  ipcMain.handle('dsh:system-env-set', (_event, payload) => {
    const name = String((payload && payload.name) || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok: false, error: '\u73af\u5883\u53d8\u91cf\u540d\u65e0\u6548' };
    const r = systemOps.envSet(name, payload.value);
    return r.ok ? { ok: true, vars: systemOps.envList() } : r;
  });

  ipcMain.handle('dsh:system-env-remove', (_event, payload) => {
    const r = systemOps.envRemove(String((payload && payload.name) || ''));
    return r.ok ? { ok: true, vars: systemOps.envList() } : r;
  });

  ipcMain.handle('dsh:system-winget', (event, payload) => {
    const id = String((payload && payload.id) || '').trim();
    if (!id) return { ok: false, error: '\u5305 id \u4e3a\u7a7a' };
    const win = BrowserWindow.fromWebContents(event.sender);
    systemOps.wingetInstall(id,
      (text) => { if (win && !win.isDestroyed()) win.webContents.send('dsh:system-winget-output', { text }); },
      (result) => { if (win && !win.isDestroyed()) win.webContents.send('dsh:system-winget-exit', result); });
    return { ok: true };
  });

  ipcMain.handle('dsh:context-menu-status', () => ({ ok: true, registered: systemOps.isContextMenuRegistered() }));

  ipcMain.handle('dsh:context-menu-set', (_event, payload) => {
    const r = payload.enabled !== false ? systemOps.registerContextMenu() : systemOps.unregisterContextMenu();
    return r.ok ? { ok: true, registered: systemOps.isContextMenuRegistered() } : r;
  });

  /* ---- 备份与迁移 ---- */

  ipcMain.handle('dsh:backup-export', async (_event, payload) => {
    try {
      const includeCredentials = !!(payload && payload.includeCredentials);
      const includeSessions = !!(payload && payload.includeSessions);
      const file = backupOps.exportBackup(backupOptions(includeCredentials, includeSessions));
      try { shell.showItemInFolder(file); } catch { /* 定位失败不影响 */ }
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:backup-import', async (_event, payload) => {
    try {
      const file = payload && payload.file;
      if (!file || !fs.existsSync(file)) return { ok: false, error: '\u8bf7\u9009\u62e9\u5907\u4efd zip \u6587\u4ef6' };
      backupOps.importBackup(file, backupOptions(false));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('dsh:backup-select-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '\u9009\u62e9\u5907\u4efd zip \u6587\u4ef6',
      properties: ['openFile'],
      filters: [{ name: 'DSH \u5907\u4efd', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
    return { ok: true, file: result.filePaths[0] };
  });
}

/* ---------- 多厂商 LLM Provider 管理（设置页） ----------
 * Provider = OpenAI 兼容 LLM 端点（DeepSeek / 小米 MiMo 等），存于 settings.apiProviders。
 * 启动时主进程把每个启用 Provider 的 apiKey 以 <ID大写>_API_KEY 环境变量注入 harness，
 * 并在 web.patch.yml 追加 @dsh-desktop/llm-openai-compat 插件行（子代理可选用不同厂商模型）。
 * apiKey 只在本进程使用：返回给页面的一律脱敏（'****' + 后 4 位），绝不写日志。
 */

const PROVIDER_BALANCE_KINDS = ['deepseek', 'openai-billing', 'none'];

/** 内置 DeepSeek 官方 provider（harness 原生注册，子代理默认继承；余额走 queryBalance）。
 *  不写入 settings、不注入 web.patch（官方 adapter 已注册）、key 从 .credentials.yaml 解析。 */
function builtinDeepseekProvider() {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    provider: 'deepseek-official',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    hasKey: true,
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    enabled: true,
    balanceKind: 'deepseek',
    builtin: true,
    note: '内置（harness 官方 provider，子代理默认继承；余额/用量查询走官方接口）',
  };
}

/** apiKey 脱敏：'****' + 后 4 位（空 key 返回空串）。 */
function maskApiKey(key) {
  const s = String(key || '');
  return s ? '****' + s.slice(-4) : '';
}

/** 规范化一个 Provider 配置；不合法返回 null。id 缺失时自动生成（'p' + 时间戳36进制）。 */
function sanitizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const provider = String(raw.provider || '').trim();
  const baseUrl = String(raw.baseUrl || '').trim().replace(/\/+$/, '');
  const models = Array.isArray(raw.models)
    ? raw.models.map((m) => String(m).trim()).filter(Boolean)
    : [];
  if (!name || !provider || !baseUrl || !models.length) return null;
  if (name.length > 128 || provider.length > 128 || baseUrl.length > 512) return null;
  if (!/^https?:\/\//i.test(baseUrl)) return null;
  const balanceKind = PROVIDER_BALANCE_KINDS.includes(String(raw.balanceKind)) ? String(raw.balanceKind) : 'none';
  return {
    id: id || 'p' + Date.now().toString(36),
    name,
    provider,
    baseUrl,
    apiKey: String(raw.apiKey || '').trim(),
    models,
    enabled: raw.enabled !== false,
    balanceKind,
    note: String(raw.note || ''),
  };
}

/** 设置页可见的 Provider 列表：内置 DeepSeek 在最前（builtin 标记），其余 apiKey 脱敏 + hasKey。 */
function providersListPayload() {
  const user = (settings.get('apiProviders') || []).flatMap((p) => {
    const base = {
      ...p,
      apiKey: maskApiKey(p.apiKey),
      hasKey: !!p.apiKey,
    };
    // 派生思考强度实例（fast→off / deep→high），供主模型按 provider 名间接控制子代理思考强度
    const efforts = Array.isArray(p.efforts) ? p.efforts.filter((e) => e === 'fast' || e === 'deep') : [];
    if (!efforts.length) return [base];
    return [base, ...efforts.map((e) => ({
      ...base,
      id: p.id + '-' + e,
      provider: String(p.provider) + '-' + e,
      effort: e === 'fast' ? 'off' : 'high',
      note: (base.note ? base.note + '；' : '') + '\u601d\u8003\u5f3a\u5ea6\u5b9e\u4f8b ' + e + '（effort=' + (e === 'fast' ? 'off' : 'high') + '）',
    }))];
  });
  return [builtinDeepseekProvider(), ...user];
}

function registerProvidersIpc() {
  ipcMain.handle('dsh:providers-list', () => ({
    ok: true,
    providers: providersListPayload(),
  }));

  ipcMain.handle('dsh:providers-save', (_event, payload) => {
    const clean = sanitizeProvider(payload && payload.provider);
    if (!clean) {
      return { ok: false, error: '保存失败：需填写 name / provider / baseUrl / models（models 不可为空）' };
    }
    if (clean.id === 'deepseek') return { ok: false, error: '内置 DeepSeek provider 不可修改' };
    const list = (settings.get('apiProviders') || []).slice();
    const index = list.findIndex((p) => p && p.id === clean.id);
    if (index >= 0) list[index] = clean;
    else list.push(clean);
    settings.set('apiProviders', list);
    return { ok: true, providers: providersListPayload() };
  });

  ipcMain.handle('dsh:providers-remove', (_event, payload) => {
    const id = String((payload && payload.id) || '');
    if (id === 'deepseek') return { ok: false, error: '内置 DeepSeek provider 不可删除' };
    const list = (settings.get('apiProviders') || []).filter((p) => p && p.id !== id);
    settings.set('apiProviders', list);
    return { ok: true, providers: providersListPayload() };
  });

  // 连通性测试：用完整 key 调 GET {base}/models（Bearer），超时 15s。
  // key 只在主进程使用，绝不返回给页面（返回体只含 available/models/latencyMs）。
  // 内置 deepseek 的 key 从 .credentials.yaml 解析（不在 settings 里）。
  ipcMain.handle('dsh:providers-test', async (_event, payload) => {
    const id = String((payload && payload.id) || '');
    if (id === 'deepseek') {
      const { resolveDeepSeekKey } = require('./usage');
      const key = resolveDeepSeekKey(state.dshHome);
      const startedAt = Date.now();
      if (!key) return { ok: true, available: false, models: [], latencyMs: 0, error: '未找到 DEEPSEEK_API_KEY（.credentials.yaml）' };
      try {
        const body = await fetchJson('https://api.deepseek.com/v1/models', {
          headers: { Authorization: 'Bearer ' + key },
          timeoutMs: 15000,
        });
        const models = Array.isArray(body && body.data)
          ? body.data.map((m) => m && m.id).filter(Boolean)
          : [];
        return { ok: true, available: true, models, latencyMs: Date.now() - startedAt };
      } catch (err) {
        return {
          ok: true, available: false, models: [], latencyMs: Date.now() - startedAt,
          error: (err && err.message) || String(err),
        };
      }
    }
    // 派生思考强度实例（id 带 -fast/-deep）映射回基础配置测试（同一端点/同一 key）
    const list = settings.get('apiProviders') || [];
    const provider = list.find((p) => p && p.id === id)
      || list.find((p) => p && p.id === String(id).replace(/-(fast|deep)$/, ''));
    if (!provider) return { ok: false, error: '未找到该 Provider' };
    if (!provider.apiKey) return { ok: false, error: '缺少 API key，无法测试' };
    const startedAt = Date.now();
    try {
      const body = await fetchJson(provider.baseUrl.replace(/\/+$/, '') + '/models', {
        headers: { Authorization: 'Bearer ' + provider.apiKey },
        timeoutMs: 15000,
      });
      const models = Array.isArray(body && body.data)
        ? body.data.map((m) => m && m.id).filter(Boolean)
        : [];
      return { ok: true, available: true, models, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        ok: true, available: false, models: [], latencyMs: Date.now() - startedAt,
        error: (err && err.message) || String(err),
      };
    }
  });

  // 余额查询：按 balanceKind 分派。'deepseek' 复用 queryBalance（取最大余额）；
  // 'openai-billing' 调 {base}/dashboard/billing/credit_grants（解析失败视为不支持）；
  // 'none' 无余额 API。内置 deepseek 也走 'deepseek' 分支。
  ipcMain.handle('dsh:providers-balance', async (_event, payload) => {
    const id = String((payload && payload.id) || '');
    let provider = null;
    if (id === 'deepseek') {
      provider = { balanceKind: 'deepseek' };
    } else {
      // 派生思考强度实例（id 带 -fast/-deep）映射回基础配置查询余额
      const list = settings.get('apiProviders') || [];
      provider = list.find((p) => p && p.id === id)
        || list.find((p) => p && p.id === String(id).replace(/-(fast|deep)$/, ''));
    }
    if (!provider) return { ok: false, error: '未找到该 Provider' };
    const kind = PROVIDER_BALANCE_KINDS.includes(provider.balanceKind) ? provider.balanceKind : 'none';
    if (kind === 'none') return { ok: true, supported: false };
    if (kind === 'deepseek') {
      const result = await queryBalance({ dshHome: state.dshHome });
      if (!result.ok || !Array.isArray(result.balanceInfos) || !result.balanceInfos.length) {
        return { ok: true, supported: false, error: result.error || '无余额信息' };
      }
      // 多币种/多账户时取余额最大的一个。
      let best = null;
      for (const info of result.balanceInfos) {
        const total = Number(info && info.total_balance);
        if (!Number.isFinite(total)) continue;
        if (!best || total > best.total) best = { currency: info.currency || 'CNY', total };
      }
      if (!best) return { ok: true, supported: false, error: '无有效余额数据' };
      return { ok: true, supported: true, balance: best };
    }
    if (kind === 'openai-billing') {
      try {
        const body = await fetchJson(provider.baseUrl.replace(/\/+$/, '') + '/dashboard/billing/credit_grants', {
          headers: { Authorization: 'Bearer ' + provider.apiKey },
          timeoutMs: 15000,
        });
        const total = body && (body.total_available ?? body.total_remaining ?? (
          body.total_granted != null && body.total_used != null ? body.total_granted - body.total_used : null
        ));
        if (total === null || total === undefined) return { ok: true, supported: false };
        return { ok: true, supported: true, balance: { currency: 'USD', total } };
      } catch (err) {
        return { ok: true, supported: false, error: (err && err.message) || String(err) };
      }
    }
    return { ok: true, supported: false };
  });

  // 应用 Provider 更改：重新生成 web.patch.yml（含 provider 行）并重启 harness 服务。
  // 与 dsh:mcp-apply 一致：重启前不做任何破坏性操作（页面随服务重启自动刷新）。
  ipcMain.handle('dsh:providers-apply', () => {
    generatePatchFile();
    startHarness();
    return { ok: true };
  });

  // 子代理会话流（stream 读取）：委托给 panel-stream-worker（worker 线程内解压，
  // 冷启动全量扫描不阻塞 Electron 主进程——启动卡顿治理）。worker 未就绪时返回空列表。
  ipcMain.handle('dsh:subagent-stream-list', async () => {
    try {
      const result = await panelStreamTask('list', { dshHome: state.dshHome, workspace: state.workspace });
      // 模块返回数组（非 { items }）；兼容两种形态；client 契约 { ok, items, summary }
      const list = Array.isArray(result) ? result : ((result && result.items) || []);
      return { ok: true, items: list, summary: null };
    } catch (err) {
      logLine('[subagent-stream] list 调用失败：' + ((err && err.message) || err));
      return { ok: true, items: [], summary: null };
    }
  });

  ipcMain.handle('dsh:subagent-stream-since', async (_event, payload) => {
    const sessionId = String((payload && payload.sessionId) || '');
    const sinceSeq = Number((payload && payload.sinceSeq) || 0);
    try {
      const result = await panelStreamTask('since', { dshHome: state.dshHome, workspace: state.workspace, sessionId, sinceSeq });
      return result && typeof result === 'object' ? { ok: true, ...result } : { ok: true, data: result };
    } catch (err) {
      logLine('[subagent-stream] since 调用失败：' + ((err && err.message) || err));
      return { ok: false, error: 'worker 未就绪' };
    }
  });
}

/* ---------- 备份与迁移 ---------- */

/** 构造备份操作所需的路径绑定（把状态绑定到纯逻辑模块 main/backup.js）。 */
function backupOptions(includeCredentials, includeSessions) {
  return {
    includeCredentials,
    includeSessions,
    settingsFile: settings.file,
    dshHome: state.dshHome,
    workspace: state.workspace,
    installDir: dshInstallDir(),
    appDir: APP_DIR,
  };
}

/* ---------- 截图 / 附件 / 新对话接续 ---------- */

function closeCaptureWindow() {
  // 隐藏而非销毁：透明窗口创建在软件渲染下很慢，复用消除再次点击截图按钮的等待
  if (captureWindow && !captureWindow.isDestroyed()) {
    try { captureWindow.hide(); } catch { /* 忽略 */ }
  }
}

/** 全屏透明选区窗口（renderer/capture.html 里拖选区域）。预创建 + 复用：显示时重新定位到当前主屏。 */
function openCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) {
    const display = screen.getPrimaryDisplay();
    try { captureWindow.setBounds(display.bounds); } catch { /* 忽略 */ }
    captureWindow.setAlwaysOnTop(true, 'screen-saver');
    captureWindow.show();
    captureWindow.focus();
    return;
  }
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  captureWindow = new BrowserWindow({
    x, y, width, height,
    frame: false, transparent: true, resizable: false, movable: false,
    fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    show: false, // 预创建时隐藏；openCaptureWindow 显示
    icon: WINDOW_ICON,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  captureWindow.setAlwaysOnTop(true, 'screen-saver');
  captureWindow.on('closed', () => { captureWindow = null; });
  captureWindow.loadFile(path.join(APP_DIR, 'renderer', 'capture.html'));
  captureWindow.once('ready-to-show', () => {
    // 首次打开（预创建后）：加载完成再显示，避免白屏闪烁
    if (captureWindow && !captureWindow.isDestroyed()) {
      try { captureWindow.show(); } catch { /* 忽略 */ }
      try { captureWindow.focus(); } catch { /* 忽略 */ }
    }
  });
}

/** 应用启动时预创建截图选区窗口（隐藏），首次点击截图按钮零创建延迟。 */
function precreateCaptureWindow() {
  try {
    if (captureWindow && !captureWindow.isDestroyed()) return;
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.bounds;
    captureWindow = new BrowserWindow({
      x, y, width, height,
      frame: false, transparent: true, resizable: false, movable: false,
      fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      show: false,
      icon: WINDOW_ICON,
      webPreferences: {
        preload: path.join(APP_DIR, 'preload', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    captureWindow.setAlwaysOnTop(true, 'screen-saver');
    captureWindow.on('closed', () => { captureWindow = null; });
    captureWindow.loadFile(path.join(APP_DIR, 'renderer', 'capture.html'));
  } catch (err) {
    logLine('[screenshot] 预创建选区窗口失败（忽略）：' + ((err && err.message) || String(err)));
  }
}

/** 聚焦主窗口输入框并向页面发送 Ctrl+V（把剪贴板内容贴进对话框）。返回是否找到输入框。 */
function focusComposerAndPaste() {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow.webContents.executeJavaScript(
    "(() => { const el = document.querySelector('[contenteditable=\"true\"], textarea, [role=\"textbox\"], .ProseMirror'); if (el) { el.focus(); return true; } return false; })()",
  ).then((focused) => {
    if (!focused || !mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'v', modifiers: ['control'] });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
    return true;
  }).catch(() => false);
}

/** 把一段文字注入对话框（剪贴板 + 模拟粘贴，兼容任意编辑器）。 */
function injectText(text) {
  clipboard.writeText(String(text));
  focusComposerAndPaste();
}

/** 判断当前会话是否在进行中（最新 transcript 的 turn/start 多于 turn/end）。
 *  进行中提交的消息会进入队列——此时接续任务需走插话（steer）排到队列最前。 */
function sessionIsBusy() {
  try {
    const root = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
    if (!fs.existsSync(root)) return false;
    let best = null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'session.jsonl.zstd');
      let m = 0;
      try { m = fs.statSync(file).mtimeMs; } catch { continue; }
      if (!best || m > best.mtimeMs) best = { file, mtimeMs: m };
    }
    if (!best) return false;
    const text = decompressFrames(fs.readFileSync(best.file));
    const lines = text.split('\n');
    let start = 0, end = 0;
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      if (r.type === 'turn/start') start++;
      else if (r.type === 'turn/end') end++;
    }
    return start > end;
  } catch { return false; }
}

/** 最新会话记录在指定时间窗口内是否有写入（用户最近正在使用，含正在输入）。轻量 stat，不解压。 */
function sessionRecentlyActive(windowMs) {
  try {
    const root = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
    if (!fs.existsSync(root)) return false;
    let best = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'session.jsonl.zstd');
      let m = 0;
      try { m = fs.statSync(file).mtimeMs; } catch { continue; }
      if (m > best) best = m;
    }
    return best > 0 && Date.now() - best < windowMs;
  } catch { return false; }
}

/** 会话 transcript 内容检查已迁移到 main/transcript-check.js 并 worker 化：
 *  主线程统一走 sessionContainsTextAsync()（panel-stream worker 执行），
 *  避免启动/接续流程在 Electron 主线程全量解压数十 MB JSON 造成卡顿。 */

/** 单次注入并发送。返回是否真正发送成功——权威判据是消息文本已出现在最新会话
 *  transcript（user/message 或 inbox）里：输入框清空不能作为成功证据（粘贴静默失败时
 *  输入框本来就是空的，旧逻辑会误判成功、任务永远没发出去）。
 *  页面未就绪/输入框不存在/输入框 readOnly（harness 恢复期 machineBusy）时返回 false
 *  （由调用方轮询重试）。
 *  关键：对话输入框的唯一标识是 textarea[data-phase]（官方 InputBar）；恢复期它 readOnly，
 *  Enter 与粘贴都会被静默拒绝——通用选择器会命中页面上其它隐藏输入控件导致误判。 */
async function injectAndSendOnce(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const EDITOR_SELECTOR = "textarea[data-phase]";
  const EDITOR_FALLBACK = "[contenteditable=\"true\"], textarea, [role=\"textbox\"], .ProseMirror";
  const readEditor = (mode) => mainWindow.webContents.executeJavaScript(
    "(() => { const el = document.querySelector(" + JSON.stringify(EDITOR_SELECTOR) + ") || document.querySelector(" + JSON.stringify(EDITOR_FALLBACK) + "); " +
    "if (!el) return { found: false }; " +
    (mode === 'read'
      ? "const v = el.value !== undefined ? el.value : (el.textContent || ''); return { found: true, draft: String(v), readOnly: !!(el.readOnly || el.disabled) };"
      : "el.focus(); return { found: true, readOnly: !!(el.readOnly || el.disabled) };") +
    " })()",
  );
  // 去前缀后的唯一部分：模板前缀固定，前 30 字会命中无关历史文本
  const RESUME_PREFIX = '\u7ee7\u7eed\u5b8c\u6210\u672a\u5b8c\u6210\u7684\u4efb\u52a1\uff08\u684c\u9762\u7aef\u5df2\u91cd\u542f\uff09\uff1a';
  const uniquePart = String(text).startsWith(RESUME_PREFIX)
    ? String(text).slice(RESUME_PREFIX.length).trim()
    : String(text);
  const mark = uniquePart.slice(0, 40);
  // 防重复：重试前先确认消息确实还没进会话（全量查一次，跨轮重试幂等）
  try {
    if (mark && await sessionContainsTextAsync(mark, { full: true })) return true;
  } catch { /* 检查失败继续尝试 */ }

  const st = await readEditor('read');
  if (!st || !st.found) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // 输入框 readOnly（恢复期 busy）：不粘贴不按键，让外圈重试等待恢复。
  if (st.readOnly) return false;
  // 上次尝试的文字仍停在输入框 → 只按 Enter，不再重复粘贴（避免闪烁与重复）。
  const alreadyThere = !!(mark && String(st.draft || '').includes(mark));
  const userDraft = alreadyThere ? '' : String(st.draft || '').trim().slice(0, 8000);
  // 1) 用户草稿暂存并清空（Ctrl+A + Delete），保证接续任务在前。
  if (userDraft) {
    await readEditor('focus');
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'a', modifiers: ['control'] });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    await new Promise((r) => setTimeout(r, 200));
  }
  // 2) 注入接续任务，并验证粘贴确实进入了输入框——静默粘贴失败时必须返回 false
  //    让外圈重试，绝不能拿"输入框本来就空"当成功。
  if (!alreadyThere) {
    clipboard.writeText(String(text));
    await readEditor('focus');
    let pasted = false;
    for (let attempt = 0; attempt < 3 && !pasted; attempt++) {
      mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
      mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'v', modifiers: ['control'] });
      mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
      await new Promise((r) => setTimeout(r, 400)); // 等 React 收到粘贴内容
      try {
        const chk = await readEditor('read');
        pasted = !!(chk && chk.found && mark && String(chk.draft || '').includes(mark));
      } catch { /* 页面未就绪 */ }
    }
    if (!pasted) {
      logLine('[auto-resume] \u7c98\u8d34\u672a\u8fdb\u5165\u8f93\u5165\u6846\uff0c\u7b49\u5f85\u91cd\u8bd5');
      return false;
    }
  } else {
    await readEditor('focus');
  }
  // 3) 发送（普通 Enter：保证消息进入队列/新回合，绝不丢失——Ctrl+Enter 的 steer 在
  //    部分状态下会被 harness 静默丢弃）。
  const busy = sessionIsBusy();
  const pressEnter = () => {
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  };
  pressEnter();
  // 4) 权威确认：消息文本必须真正进入最新会话 transcript（user/message 或 inbox）。
  //    轮询最多 ~20s；readOnly 恢复期只等待不硬按。
  let confirmed = false;
  const confirmDeadline = Date.now() + 20000;
  while (Date.now() < confirmDeadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      if (mark && await sessionContainsTextAsync(mark)) { confirmed = true; break; }
    } catch { /* 检查失败继续等 */ }
    let st2 = { readOnly: false };
    try { st2 = await readEditor('read'); } catch { /* 保持默认 */ }
    if (st2.readOnly) continue; // 恢复期：等待而非硬按
    const draftLeft = st2 && st2.draft ? String(st2.draft).trim() : '';
    if (draftLeft) {
      // 文字还停在输入框 → 再次 Enter（可能上一发被页面事件吞掉）
      pressEnter();
    }
  }
  if (!confirmed) logLine('[auto-resume] \u53d1\u9001\u672a\u786e\u8ba4\uff1a\u6d88\u606f\u672a\u8fdb\u5165\u4f1a\u8bdd\u6d41\uff0c\u5c06\u7ee7\u7eed\u91cd\u8bd5');
  if (busy && confirmed) {
    // 会话进行中 → 消息进队列后，把接续任务那行「插话发送」插到队列最前。
    // 队列多项时官方 dock 默认折叠（按钮不在 DOM），先点 header 展开。
    const MARK = String(text).slice(0, 24);
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 8; i++) {
      let steered = false;
      try {
        steered = await mainWindow.webContents.executeJavaScript(
          "(() => { const MARK = " + JSON.stringify(MARK) + "; " +
          "const dock = document.querySelector('[data-queue-dock]'); if (!dock) return 'no-dock'; " +
          "const hdr = dock.querySelector('button[aria-expanded=\"false\"]'); if (hdr) hdr.click(); " +
          "const btns = [...dock.querySelectorAll('button')]; " +
          "for (const b of btns) { const t = (b.getAttribute('title') || '') + (b.getAttribute('aria-label') || ''); " +
          "if (/插话发送|Steer queued message/i.test(t)) { let node = b; for (let d = 0; d < 6 && node; d++) { if ((node.textContent || '').includes(MARK)) { b.click(); return true; } node = node.parentElement; } } } " +
          "return false; })()",
        );
        if (steered === true) { logLine('[auto-resume] \u63a5\u7eed\u4efb\u52a1\u5df2\u63d2\u8bdd\u5230\u961f\u5217\u6700\u524d'); break; }
        if (steered === 'no-dock') { logLine('[auto-resume] \u961f\u5217\u5df2\u6d88\u8d39\uff08\u63a5\u7eed\u4efb\u52a1\u5373\u5c06\u88ab\u5904\u7406\uff09'); break; }
      } catch (err) { logLine('[auto-resume] steer \u68c0\u67e5\u5931\u8d25\uff1a' + (err && err.message)); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  // 5) 用户草稿放回输入框（不发送，排在接续任务之后）。
  if (userDraft) {
    await new Promise((r) => setTimeout(r, 1500));
    clipboard.writeText(userDraft);
    await readEditor('focus');
    mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: 'v', modifiers: ['control'] });
    mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
  }
  return confirmed;
}

/** 轮询式自动接续：页面刚重启时 React 渲染需要时间，最多轮询 10 分钟等输入框出现。 */
async function autoResumeInject(text) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      if (await injectAndSendOnce(text)) return true;
    } catch { /* 页面未就绪等异常：继续重试 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // 超时：输入框长时间不可用，放弃注入并通知，绝不破坏用户输入。
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      new Notification({
        title: 'DSH 桌面端 · 自动接续已推迟',
        body: '未找到可用输入框，自动接续任务未发送。可手动粘贴剪贴板中的任务文本继续。',
      }).show();
    }
  } catch { /* 忽略 */ }
  throw new Error('输入框长时间不可用，已放弃自动接续（未触碰用户输入）');
}

/** 页面就绪后自动接续：restartApp 带 task 时写入 auto-resume.json，
 *  harness 页面加载完成（preload 发 dsh:web-ready）后把任务作为新消息发送。 */
ipcMain.on('dsh:web-ready', () => {
  try {
    const file = path.join(app.getPath('userData'), 'auto-resume.json');
    if (!fs.existsSync(file)) {
      // 无显式接续任务（restartApp 未带 task）时：若存在 .dsh/handoff.md（有未完成工作），
      // 自动发送接续指令到当前会话——重启后无需任何操作即可无缝继续（用户可删除 handoff 以禁用）。
      maybeAutoResumeFromHandoff();
      return;
    }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    const task = doc && doc.task ? String(doc.task).slice(0, 4000) : '';
    const msg = (doc && doc.msg ? String(doc.msg) : '') || ('\u7ee7\u7eed\u5b8c\u6210\u672a\u5b8c\u6210\u7684\u4efb\u52a1\uff08\u684c\u9762\u7aef\u5df2\u91cd\u542f\uff09\uff1a' + task);
    if (!msg) return;
    // 重启前已发送成功（sent 标记）→ 不兜底重发，避免重复消息。
    if (doc && doc.sent === true) {
      logLine('[auto-resume] \u91cd\u542f\u524d\u5df2\u53d1\u9001\uff0c\u8df3\u8fc7\u515c\u5e95\u6ce8\u5165\uff08\u9632\u91cd\u590d\uff09');
      return;
    }
    // 重启前注入失败时，检查会话记录里是否已有（异步落盘）再决定是否兜底。
    // 注意：必须用消息的唯一部分（任务文本）做匹配——所有接续消息共享固定模板前缀
    // （"继续完成未完成的任务（桌面端已重启）："），若用前 20 字匹配，首次接续成功进入
    // 会话记录后，后续每次重启都会误判"已在队列"，新任务永远不被发送。
    const RESUME_PREFIX = '\u7ee7\u7eed\u5b8c\u6210\u672a\u5b8c\u6210\u7684\u4efb\u52a1\uff08\u684c\u9762\u7aef\u5df2\u91cd\u542f\uff09\uff1a';
    const uniqueMark = String(msg).startsWith(RESUME_PREFIX)
      ? String(msg).slice(RESUME_PREFIX.length).trim().slice(0, 60)
      : String(msg).slice(0, 60);
    (async () => {
      if (uniqueMark && await sessionContainsTextAsync(uniqueMark, { full: true })) {
        logLine('[auto-resume] \u63a5\u7eed\u4efb\u52a1\u5df2\u5728\u4f1a\u8bdd\u4e2d\uff0c\u8df3\u8fc7\u515c\u5e95\u6ce8\u5165');
        return;
      }
      // 官方 RPC 直发优先：host 侧直达当前会话，页面 reload 不丢消息（输入框注入在页面
      // reload 瞬间会丢——消息已提交但未达 host）。失败再退回输入框注入。
      rpcPromptCurrentSession(msg)
        .then((sent) => {
          if (sent) { logLine('[auto-resume] \u5df2\u81ea\u52a8\u63a5\u7eed\u4efb\u52a1'); return; }
          return autoResumeInject(msg)
            .then(() => logLine('[auto-resume] \u5df2\u81ea\u52a8\u63a5\u7eed\u4efb\u52a1'))
            .catch((err) => logLine('[auto-resume] \u6ce8\u5165\u5931\u8d25\uff08\u4efb\u52a1\u672a\u53d1\u9001\uff09\uff1a' + (err && err.message ? err.message : err)));
        })
        .catch((err) => logLine('[auto-resume] \u6ce8\u5165\u5931\u8d25\uff08\u4efb\u52a1\u672a\u53d1\u9001\uff09\uff1a' + (err && err.message ? err.message : err)));
    })();
  } catch { /* 忽略 */ }
});

/** 官方 RPC 直发：把文本作为用户消息送进"当前会话"。当前会话取自页面 localStorage 的
 *  dsh.sessions.current（官方客户端每次切换会话都会持久化该键）——重启后页面就绪时
 *  该值即恢复的当前会话；host 侧直达，不经输入框，页面 reload 也不丢消息。
 *  @returns {Promise<boolean>} 是否已发送（读不到当前会话或调用失败 → false）。 */
async function rpcPromptCurrentSession(text) {
  let sessionId = null;
  // web-ready 由 preload 提前发出，页面脚本可能尚未初始化，localStorage 读取会失败——
  // 轮询重试最多 ~20 秒（命中即走官方 RPC 直发），始终读不到再退回输入框注入。
  // 之前 5s 太短：页面冷启动（含 harness 初始化）常超过 5s，导致直发通道没机会走。
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try {
          const v = await mainWindow.webContents.executeJavaScript(
            "(() => { try { const r = localStorage.getItem('dsh.sessions.current'); if (!r) return null; const o = JSON.parse(r); return (o && typeof o.sessionId === 'string') ? o.sessionId : null; } catch { return null; } })()",
          );
          if (v && typeof v === 'string') { sessionId = v; break; }
        } catch { /* 页面未就绪，稍后重试 */ }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch { sessionId = null; }
  if (!sessionId) return false;
  try {
    const prompt = await rpcCall('session.prompt', {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: String(text) }],
    }, 15000);
    const result = prompt.body && prompt.body.result;
    if (prompt.status === 200 && result && result.ok === true) {
      logLine('[auto-resume] \u5df2\u901a\u8fc7\u5b98\u65b9 RPC \u53d1\u9001\u5230\u4f1a\u8bdd ' + sessionId);
      return true;
    }
    logLine('[auto-resume] session.prompt \u672a\u63a5\u53d7\uff08' + sessionId + '\uff09\uff1a' + (result && result.error ? result.error.message : ('HTTP ' + prompt.status)));
  } catch (err) {
    logLine('[auto-resume] session.prompt \u5931\u8d25\uff08' + sessionId + '\uff09\uff1a' + (err && err.message ? err.message : err));
  }
  return false;
}

/** 重启后自动接续（handoff 兜底）：无显式接续任务时，若 .dsh/handoff.md 存在，
 *  自动向当前会话发送接续指令（与"点击接续"同文案）——重启后零操作无缝继续。
 *  防重复：进程内只注入一次（web-ready 可能触发多次，且消息落盘有延迟，
 *  sessionContainsText 尾帧检查来不及看到刚注入的消息，会重复注入）。 */
let handoffAutoResumed = false;
function maybeAutoResumeFromHandoff() {
  try {
    if (handoffAutoResumed) return;
    handoffAutoResumed = true;
    if (!state.workspace) return;
    const handoff = path.join(state.workspace, '.dsh', 'handoff.md');
    if (!fs.existsSync(handoff)) return;
    const text = '\u8bf7\u6309 .dsh/handoff.md \u63a5\u7eed\u4efb\u52a1\uff1a\u5148\u8bfb\u8be5\u6587\u4ef6\u4e0e AGENTS.md\uff0c\u518d\u7528 memory__search_nodes \u67e5 task-progress\uff0c\u7136\u540e\u76f4\u63a5\u7ee7\u7eed\uff0c\u4e0d\u8981\u91cd\u505a\u5df2\u5b8c\u6210\u7684\u5de5\u4f5c\u3002';
    const mark = '\u8bf7\u6309 .dsh/handoff.md \u63a5\u7eed\u4efb\u52a1';
    // 去重检查走 worker（全量解压不进主线程）
    sessionContainsTextAsync(mark, { full: true }).then((already) => {
      if (already) {
        logLine('[auto-resume] handoff \u63a5\u7eed\u6307\u4ee4\u5df2\u5728\u4f1a\u8bdd\u4e2d\uff0c\u8df3\u8fc7');
        return;
      }
      logLine('[auto-resume] \u68c0\u6d4b\u5230 .dsh/handoff.md\uff0c\u81ea\u52a8\u53d1\u9001\u63a5\u7eed\u6307\u4ee4');
      // 官方 RPC 直发优先（host 侧直达当前会话，reload 不丢消息）；失败退回输入框注入。
      rpcPromptCurrentSession(text)
        .then((sent) => {
          if (sent) { logLine('[auto-resume] handoff \u63a5\u7eed\u6307\u4ee4\u5df2\u81ea\u52a8\u53d1\u9001'); return; }
          return autoResumeInject(text)
            .then(() => logLine('[auto-resume] handoff \u63a5\u7eed\u6307\u4ee4\u5df2\u81ea\u52a8\u53d1\u9001'))
            .catch((err) => logLine('[auto-resume] handoff \u63a5\u7eed\u6307\u4ee4\u53d1\u9001\u5931\u8d25\uff1a' + (err && err.message ? err.message : err)));
        })
        .catch((err) => logLine('[auto-resume] handoff \u63a5\u7eed\u6307\u4ee4\u53d1\u9001\u5931\u8d25\uff1a' + (err && err.message ? err.message : err)));
    }).catch((err) => logLine('[auto-resume] handoff \u53bb\u91cd\u68c0\u67e5\u5931\u8d25\uff1a' + (err && err.message ? err.message : err)));
  } catch { /* 忽略 */ }
}

/** 带缓存的当前会话模型读取：readCurrentModel 需解压 zstd 会话文件，30 秒内复用结果。
 *  用于 computerScreenshot 判断会话模型是否为多模态（是则跳过本地识别）。 */
let currentModelCache = { at: 0, model: null };
function currentModelCached() {
  const now = Date.now();
  if (now - currentModelCache.at < 30000) return currentModelCache.model;
  let model = null;
  try {
    model = readCurrentModel(path.join(state.dshHome, 'sessions'), workspaceSessionKey(state.workspace));
  } catch { model = null; }
  currentModelCache = { at: now, model };
  return model;
}

/* ---- 会话活动足迹（环境信息侧边栏：技能/MCP 调用、本轮文件/网页来源、本轮产出文件） ---- */

/** 解析最新会话 transcript（在 activity-scan-child.js 子进程里做，绝不阻塞主进程），
 *  提取技能/MCP 调用、当前轮次读的文件/网页来源、本轮产出文件。缓存按文件 mtime 驱动。 */
let activityCache = { file: '', mtimeMs: 0, value: null, pending: null };
async function getSessionActivity() {
  try {
    const root = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
    if (!fs.existsSync(root)) return { ok: false, error: 'no sessions' };
    let best = null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'session.jsonl.zstd');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
    }
    if (!best) return { ok: false, error: 'no transcript' };
    // 缓存按 mtime 驱动：会话记录未变时永远复用，变更时子进程重扫（在途共享防并发）。
    if (activityCache.value && activityCache.file === best.file && activityCache.mtimeMs === best.mtimeMs) {
      return activityCache.value;
    }
    if (activityCache.pending && activityCache.file === best.file && activityCache.mtimeMs === best.mtimeMs) {
      return activityCache.pending;
    }
    const pending = new Promise((resolve, reject) => {
      const nodePath = resolveSystemNodeForSubagentScan();
      const child = spawn(nodePath || process.execPath, [path.join(__dirname, 'activity-scan-child.js'), best.file], {
        cwd: APP_DIR,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: nodePath ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      let stdout = '';
      let settled = false;
      const fail = (error) => { if (settled) return; settled = true; reject(error); };
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.once('error', fail);
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) { fail(new Error('activity scan exited with code ' + code)); return; }
        try { resolve(JSON.parse(stdout)); } catch (err) { fail(new Error('activity scan returned invalid JSON: ' + err.message)); }
      });
    });
    activityCache = { file: best.file, mtimeMs: best.mtimeMs, value: null, pending };
    try {
      const value = await pending;
      if (activityCache.file === best.file && activityCache.mtimeMs === best.mtimeMs) activityCache.value = value;
      return value;
    } catch (err) {
      if (activityCache.pending === pending) activityCache.pending = null;
      return { ok: false, error: (err && err.message) || String(err) };
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}
ipcMain.handle('dsh:activity-get', () => getSessionActivity());

/** 页面侧补救通道：纯文本模型下截图发送被 harness 拒绝（不支持图片）时，
 *  页面插件调用本通道做本地识别，把描述文字重新填入并发送。
 *  按用户要求：先复制一份图片副本交给视觉模型（原图保留在对话框/附件目录，只读不改）。 */
ipcMain.handle('dsh:describe-image-path', async (_event, payload) => {
  const vision = settings.get('vision');
  if (!vision || vision.enabled === false) return { ok: false, error: '本地视觉未启用' };
  const vb = visionBroadcast();
  await ensureOllamaMode();
  vb.send({ phase: 'start' });
  const controller = new AbortController();
  visionRuns.set(vb.id, controller);
  let copyPath = null;
  try {
    // 复制一份交给视觉模型（预处理/裁剪不会碰原图）
    try {
      const src = String(payload && payload.path || '');
      if (src && fs.existsSync(src)) {
        copyPath = src.replace(/\.(png|jpe?g|webp|gif)$/i, '') + '.vision-copy' + path.extname(src);
        fs.copyFileSync(src, copyPath);
      }
    } catch { copyPath = null; }
    const description = await describeImage(vision, {
      path: copyPath || (payload && payload.path),
      dshHome: state.dshHome,
      stream: true,
      onDelta: (text) => vb.send({ phase: 'delta', text }),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - vb.startedAt;
    vb.send({ phase: 'done', elapsedMs, chars: description.length });
    logLine('[vision] \u9875\u9762\u8865\u6551\u8bc6\u522b\u5b8c\u6210\uff1a' + elapsedMs + 'ms');
    // 返回实际视觉模型名（客户端占位/完成文案显示真实视觉源，不再写死"本地视觉"）
    return { ok: true, description, elapsedMs, model: vision && vision.model ? String(vision.model) : '' };
  } catch (err) {
    const elapsedMs = Date.now() - vb.startedAt;
    if (controller.signal.aborted) {
      vb.send({ phase: 'error', cancelled: true, message: '\u5df2\u624b\u52a8\u505c\u6b62\u8bc6\u522b', elapsedMs });
      logLine('[vision] \u9875\u9762\u8865\u6551\u8bc6\u522b\u5df2\u505c\u6b62\uff08' + elapsedMs + 'ms\uff09');
      return { ok: false, error: '\u5df2\u624b\u52a8\u505c\u6b62\u8bc6\u522b' };
    }
    vb.send({ phase: 'error', message: (err && err.message) || String(err), elapsedMs });
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    visionRuns.delete(vb.id);
    if (copyPath) { try { fs.rmSync(copyPath, { force: true }); } catch { /* 忽略 */ } }
  }
});

/* ---- 显存感知的 Ollama 运行模式：显存够用 GPU（快），不够自动降级纯 CPU（慢但必然成功） ---- */

let ollamaMode = null; // null=未知 / 'gpu' / 'cpu'
let gpuMemoryCheckedAt = 0;
let gpuMemoryFreeMb = null;

/** 按模型名估算 GPU 所需空闲显存（MB）：Q4 加载占用 + 余量。
 *  之前固定 7500MB 阈值把 3b 这类小模型也强制降到 CPU（4GB 显卡上 3b 明明能跑 GPU），
 *  小模型必须按实际需求评估。未知模型保守按 7b。 */
function visionGpuNeedMb(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('3b')) return 3000;      // qwen2.5vl:3b Q4 ≈ 2.2GB，4GB 显卡（空闲约 3.2GB）可跑 GPU
  if (m.includes('8b')) return 9000;
  if (m.includes('11b') || m.includes('13b')) return 10000;
  if (m.includes('7b')) return 7500;      // qwen2.5vl:7b / llava:7b Q4 ≈ 5-6GB
  return 7500;
}

/** 推理前确保 Ollama 运行模式与显存匹配：可用显存 ≥ 模型需求用 GPU，否则纯 CPU。
 *  检测 30s 缓存，模式不变时零开销；模式切换需重启服务（冷启动一次）。 */
async function ensureOllamaMode() {
  try {
    const vision = settings.get('vision');
    if (!vision || !ollama.isLocalOllama(String(vision.baseUrl || ''))) return;
    const now = Date.now();
    if (now - gpuMemoryCheckedAt > 30000) {
      gpuMemoryFreeMb = await ollama.detectGpuMemory();
      gpuMemoryCheckedAt = now;
    }
    const wantCpu = gpuMemoryFreeMb === null || gpuMemoryFreeMb < visionGpuNeedMb(vision && vision.model);
    const want = wantCpu ? 'cpu' : 'gpu';
    if (ollamaMode === want) return;
    ollama.stop();
    await new Promise((r) => setTimeout(r, 1500));
    await ollama.start(wantCpu ? { numGpu: '0' } : {});
    await new Promise((r) => setTimeout(r, 2500));
    ollamaMode = want;
    logLine('[vision] Ollama \u6a21\u5f0f\u5207\u6362\u4e3a ' + want + '\uff08' + (vision && vision.model ? vision.model : '?') + ' \u9700\u663e\u5b58\u2265' + visionGpuNeedMb(vision && vision.model) + 'MB\uff0c\u53ef\u7528 ' + (gpuMemoryFreeMb === null ? 'N/A' : gpuMemoryFreeMb + 'MB') + '\uff09');
  } catch (err) {
    logLine('[vision] \u786e\u4fdd Ollama \u6a21\u5f0f\u5931\u8d25\uff1a' + (err && err.message));
  }
}

/** 视觉配置生效值：baseUrl 指向 DeepSeek 官方且未填 apiKey 时，自动从
 *  .credentials.yaml 补 DEEPSEEK_API_KEY（设置页选"官方 Vision"快捷项即可用，无需重复填 key）。 */
function effectiveVision(vision) {
  if (!vision || !vision.enabled) return vision;
  const base = String(vision.baseUrl || '').toLowerCase();
  if (base.includes('api.deepseek.com') && !String(vision.apiKey || '').trim()) {
    const key = resolveDeepSeekKey(state.dshHome);
    if (key) return { ...vision, apiKey: key };
  }
  return vision;
}

/** 进行中的本地视觉识别注册表：id → AbortController。
 *  运行框「停止」按钮按 id 取消对应识别（vision.js 的 signal 会中断 HTTP 请求，
 *  Ollama 检测到客户端断开即停止推理，CPU/显存立即释放）。 */
const visionRuns = new Map();

/** 停止本地视觉识别：带 id 取消对应识别（运行框停止按钮）；不带 id 取消全部。 */
ipcMain.handle('dsh:vision-cancel', (_event, payload) => {
  const id = payload && payload.id ? String(payload.id) : null;
  let aborted = 0;
  if (id) {
    const controller = visionRuns.get(id);
    if (controller) { controller.abort(); visionRuns.delete(id); aborted = 1; }
  } else {
    for (const controller of visionRuns.values()) controller.abort();
    aborted = visionRuns.size;
    visionRuns.clear();
  }
  return { ok: true, aborted };
});

/** 视觉识别进度广播：把本地视觉模型的一次识别过程（开始/增量/完成/失败/停止）推给
 *  Web 页面浮层实时展示（本地推理可达数分钟，让用户看到进展而不是误以为卡住）。
 *  事件名 dsh:vision-stream，preload 以 onVisionStream 桥接。 */
function visionBroadcast() {
  const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const startedAt = Date.now();
  const vision = settings.get('vision');
  const model = vision && vision.model ? String(vision.model) : '';
  const send = (payload) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dsh:vision-stream', { id, model, startedAt, ...payload });
      }
    } catch { /* 广播失败不影响识别 */ }
  };
  return { send, startedAt, id };
}

/** 截图预识别（异步、不阻塞）：截图完成即开始识别，结果经 dsh:screenshot-desc 推给页面缓存。
 *  纯文本模型会话发送截图被拒时，补救流程直用该结果——零等待、无"识别中"占位被误发的风险。
 *  仅当视觉启用且当前会话模型不支持图片时执行（多模态模型无需兜底）。
 *  幂等：同路径只识别一次；失败静默（补救流程会现场重试）。 */
const preRecognized = new Set();
function preRecognizeScreenshot(file) {
  try {
    if (!file || preRecognized.has(file)) return;
    preRecognized.add(file);
    if (preRecognized.size > 50) preRecognized.clear(); // 防无限增长
    const vision = settings.get('vision');
    if (!vision || vision.enabled === false) return;
    if (modelSupportsVision(currentModelCached())) return; // 官方多模态模型无需兜底识别
    const vb = visionBroadcast();
    vb.send({ phase: 'start' });
    describeImage(effectiveVision(vision), { path: file, dshHome: state.dshHome, stream: true, onDelta: (text) => vb.send({ phase: 'delta', text }) })
      .then((description) => {
        const elapsedMs = Date.now() - vb.startedAt;
        vb.send({ phase: 'done', elapsedMs, chars: description.length });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('dsh:screenshot-desc', {
            path: file,
            description,
            elapsedMs,
            model: vision && vision.model ? String(vision.model) : '',
          });
        }
      })
      .catch((err) => {
        vb.send({ phase: 'error', message: (err && err.message) || String(err), elapsedMs: Date.now() - vb.startedAt });
        logLine('[vision] \u9884\u8bc6\u522b\u5931\u8d25\uff08\u7559\u7ed9\u8865\u6551\u73b0\u573a\u91cd\u8bd5\uff09\uff1a' + (err && err.message ? err.message : err));
      });
  } catch { /* 预识别失败静默 */ }
}

/** 后台预热本地视觉模型：首次推理含模型加载（可 60s+），预热后后续识别明显变快。
 *  仅当视觉源为本地 Ollama 时预热——云端视觉（小米 MiMo / DeepSeek 官方等）不预热，
 *  避免无谓的云端测试调用（浪费 token/资源）。幂等：同一时刻只允许一次预热；失败静默。 */
let visionWarmInFlight = false;
function warmVisionModel() {
  if (visionWarmInFlight) return;
  const vision = settings.get('vision');
  if (!vision || vision.enabled === false || !vision.model || !vision.baseUrl) return;
  // 云端视觉：本地 Ollama 不加载、不预热（用户明确切换到本地时才启动）
  if (!ollama.isLocalOllama(String(vision.baseUrl || ''))) return;
  visionWarmInFlight = true;
  testVision(vision)
    .then(() => logLine('[vision] \u672c\u5730\u89c6\u89c9\u6a21\u578b\u5df2\u9884\u70ed\uff08' + vision.model + '\uff09'))
    .catch((err) => logLine('[vision] \u9884\u70ed\u5931\u8d25\uff08\u5ffd\u7565\uff09\uff1a' + (err && err.message ? err.message : err)))
    .finally(() => { visionWarmInFlight = false; });
}

/** 选择文件并附加到工作区 .dsh-attachments/，再把清单注入对话框。 */
async function attachFiles() {
  if (!state.workspace) { dialog.showErrorBox('\u9644\u52a0\u6587\u4ef6', '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a'); return; }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '\u9009\u62e9\u8981\u9644\u52a0\u7684\u6587\u4ef6', properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const attachDir = path.join(state.workspace, '.dsh-attachments');
  try { fs.mkdirSync(attachDir, { recursive: true }); } catch (err) {
    dialog.showErrorBox('\u9644\u52a0\u6587\u4ef6', '\u521b\u5efa\u9644\u4ef6\u76ee\u5f55\u5931\u8d25\uff1a' + (err && err.message ? err.message : err)); return;
  }
  const copied = [];
  for (const src of result.filePaths) {
    try {
      const dest = path.join(attachDir, Date.now() + '-' + path.basename(src));
      fs.copyFileSync(src, dest);
      const stat = fs.statSync(dest);
      copied.push({ name: path.basename(dest), size: stat.size, src, dest });
    } catch (err) {
      logLine('[attach] \u590d\u5236\u5931\u8d25 ' + src + '\uff1a' + (err && err.message ? err.message : err));
    }
  }
  if (!copied.length) { dialog.showErrorBox('\u9644\u52a0\u6587\u4ef6', '\u6ca1\u6709\u6587\u4ef6\u88ab\u6210\u529f\u9644\u52a0'); return; }
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
  const isImage = (p) => IMAGE_EXTS.includes(path.extname(p).slice(1).toLowerCase());
  if (copied.length === 1 && isImage(copied[0].src)) {
    const img = nativeImage.createFromPath(copied[0].src);
    if (!img.isEmpty()) { clipboard.writeImage(img); focusComposerAndPaste(); return; }
  }
  const lines = copied.map((c) => '- ' + c.name + '\uff08' + Math.max(1, Math.round(c.size / 1024)) + 'KB\uff09');
  injectText(
    '\u{1f4ce} \u7528\u6237\u9644\u52a0\u4e86\u6587\u4ef6\uff08\u5df2\u590d\u5236\u5230\u5de5\u4f5c\u533a .dsh-attachments/ \u76ee\u5f55\uff09\uff1a\n' + lines.join('\n') +
    '\n\u5982\u9700\u8bfb\u53d6\u5185\u5bb9\u8bf7\u7528 read/grep \u5de5\u5177\uff1b\u56fe\u7247\u8bf7\u7528 mcp__dsh_desktop__describe_image \u8bc6\u522b\u3002',
  );
}

/** 上下文告警时自动生成交接草稿（Codex「Persistent Memory」精神：任务状态自动沉淀，
 *  不依赖模型自觉；已有交接文件（模型/用户已写）绝不覆盖）。
 *  草稿为骨架：会话标题 + 时间 + 进度占位，接续时模型按 handoff 协议完善后直接可用。
 *  @param {string} sessionId 会话 id（用于读取标题）
 *  @param {number} [tokens] 当前上下文 tokens（0/未传时用于压缩等无 token 场景）
 *  @param {string} [reason] 触发原因（如"对话已自动压缩"），写入草稿头部 */
function writeHandoffDraftIfMissing(sessionId, tokens, reason) {
  try {
    if (!state.workspace) return;
    const dir = path.join(state.workspace, '.dsh');
    const file = path.join(dir, 'handoff.md');
    if (fs.existsSync(file)) return; // 已有交接（模型已写）不覆盖
    fs.mkdirSync(dir, { recursive: true });
    let title = sessionId || '';
    try {
      // 尝试读会话标题（session/title 记录），失败用会话 id
      const sessionsRoot = path.join(state.dshHome, 'sessions', workspaceSessionKey(state.workspace));
      const dir2 = path.join(sessionsRoot, sessionId);
      if (fs.existsSync(dir2)) {
        const f = path.join(dir2, 'session.jsonl.zstd');
        if (fs.existsSync(f) && fs.statSync(f).size <= 2 * 1024 * 1024) {
          const text = decompressFrames(fs.readFileSync(f));
          for (const rawLine of text.split('\n')) {
            try {
              const r = JSON.parse(rawLine.trim());
              if (r && r.type === 'session/title' && r.data && r.data.title) { title = String(r.data.title); break; }
            } catch { /* 跳过 */ }
          }
        }
      }
    } catch { /* 标题读取失败用会话 id */ }
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const why = reason ? '（' + reason + '）' : '';
    const tokensNote = Number(tokens || 0) > 0 ? '上下文约 ' + Number(tokens).toLocaleString() + ' tokens，接近上限。' : '本会话即将/已发生自动压缩，建议开新对话接续。';
    const draft = [
      '# Handoff — ' + title,
      '',
      '> 自动生成的交接草稿（' + now + '）' + why + '。' + tokensNote,
      '> 请主模型按 handoff 协议完善以下内容后，点状态胶囊「接续」开新对话。',
      '',
      '## 当前目标',
      '（待完善：本任务要达成的最终目标）',
      '',
      '## 进度',
      '（待完善：已完成/进行中的工作）',
      '',
      '## 下一步',
      '（待完善：明确的下一步动作）',
      '',
      '## 关键结论',
      '（待完善：重要决策、踩坑、文件位置等，新会话需要知道的）',
      '',
    ].join('\n');
    fs.writeFileSync(file, draft, 'utf8');
    logLine('[handoff] 已自动生成交接草稿（' + title.slice(0, 40) + '）');
  } catch (err) {
    logLine('[handoff] 自动生成草稿失败：' + (err && err.message ? err.message : err));
  }
}

/** 新对话接续：确认交接文件存在后新建会话，并自动发送接续指令（用户零操作，
 *  新会话自动开始处理——接续完成后用户直接在新对话中继续）。 */
async function continueInNewConversation() {
  const handoff = state.workspace ? path.join(state.workspace, '.dsh', 'handoff.md') : null;
  if (!handoff || !fs.existsSync(handoff)) {
    await msgBox({
      type: 'warning', title: '\u65b0\u5bf9\u8bdd\u63a5\u7eed', noLink: true, buttons: ['\u77e5\u9053\u4e86'],
      message: '\u672a\u627e\u5230\u4ea4\u63a5\u6587\u4ef6 .dsh/handoff.md',
      detail: '\u8bf7\u5148\u5728\u5f53\u524d\u5bf9\u8bdd\u8ba9\u6a21\u578b\u5199\u4ea4\u63a5\uff08\u5bf9\u5b83\u8bf4\uff1a\u6309 handoff \u534f\u8bae\u5199\u4ea4\u63a5\u6587\u4ef6\uff09\uff0c\n\u5b83\u4f1a\u8bb0\u5f55\u76ee\u6807\u3001\u8fdb\u5ea6\u4e0e\u4e0b\u4e00\u6b65\uff1b\u968f\u540e\u518d\u70b9\u4e00\u6b21\u672c\u529f\u80fd\u5373\u53ef\u65e0\u7f1d\u7eed\u505a\u3002',
    });
    return;
  }
  // 用官方 HTTP RPC 创建新会话（不依赖 DOM 按钮——按钮文案/结构易变不可靠）：
  // POST /api/session.create { workspaceId } → {result:{ok:true,value:{sessionId}}}。
  // ⚠️ 必须传 workspaceId 而非 cwd：官方实现只在传了 workspaceId 时才把新会话 attach 进
  // 工作区（workspace.attachSession），只传 cwd 会创建"未分组"的会话。
  // workspaceId 通过 workspace.list 按路径匹配得到。loopback 请求过信任围栏。
  // 随后把新会话 id 写入官方客户端持久化（localStorage dsh.sessions.current，客户端
  // 每次切换会话都会写该键），刷新页面后客户端恢复它为当前会话——再用官方
  // session.prompt 把接续指令直发新会话（host 侧，不经 DOM/输入框，不会发错会话，
  // 页面 reload 也不丢消息）。
  let sessionId = null;
  let createError = null;
  let workspaceId = null;
  try {
    const ws = await rpcCall('workspace.list', {}, 10000);
    const items = ws.body && ws.body.result && ws.body.result.value && ws.body.result.value.items;
    if (Array.isArray(items) && state.workspace) {
      const target = path.normalize(String(state.workspace)).toLowerCase();
      const hit = items.find((it) => it && it.path && path.normalize(String(it.path)).toLowerCase() === target);
      if (hit && hit.workspaceId) workspaceId = String(hit.workspaceId);
    }
    if (!workspaceId) logLine('[handoff] \u672a\u627e\u5230\u5339\u914d\u5de5\u4f5c\u533a\uff08path=' + state.workspace + '\uff09\uff0c\u56de\u9000 cwd \u5efa\u4f1a\u8bdd\uff08\u5c06\u663e\u793a\u4e3a\u672a\u5206\u7ec4\uff09');
  } catch (err) {
    logLine('[handoff] \u67e5\u8be2\u5de5\u4f5c\u533a\u5931\u8d25\uff1a' + (err && err.message ? err.message : err));
  }
  try {
    const rpc = await rpcCall('session.create', workspaceId ? { workspaceId } : { cwd: state.workspace }, 15000);
    const result = rpc.body && rpc.body.result;
    if (rpc.status === 200 && result && result.ok === true && result.value && result.value.sessionId) {
      sessionId = String(result.value.sessionId);
    } else {
      createError = result && result.error ? result.error.message : ('HTTP ' + rpc.status);
      logLine('[handoff] session.create \u672a\u8fd4\u56de\u4f1a\u8bdd\uff1a' + createError);
    }
  } catch (err) {
    createError = err && err.message ? err.message : String(err);
    logLine('[handoff] \u521b\u5efa\u65b0\u4f1a\u8bdd\u5931\u8d25\uff1a' + createError);
  }
  if (!sessionId) {
    await msgBox({
      type: 'warning', title: '\u65b0\u5bf9\u8bdd\u63a5\u7eed', noLink: true, buttons: ['\u77e5\u9053\u4e86'],
      message: '\u521b\u5efa\u65b0\u4f1a\u8bdd\u5931\u8d25',
      detail: (createError ? '\u539f\u56e0\uff1a' + createError + '\n\n' : '') + '\u8bf7\u624b\u52a8\u70b9\u51fb\u4fa7\u680f\u201c\u65b0\u5bf9\u8bdd\u201d\u5efa\u7acb\u65b0\u4f1a\u8bdd\u540e\uff0c\u518d\u70b9\u4e00\u6b21\u672c\u529f\u80fd\uff1b\u6216\u76f4\u63a5\u5728\u65b0\u5bf9\u8bdd\u4e2d\u8bf4\uff1a\u6309 .dsh/handoff.md \u63a5\u7eed\u4efb\u52a1\u3002',
    });
    return;
  }
  logLine('[handoff] 已创建新会话 ' + sessionId);
  // 刷新前把"当前会话"指针写入官方客户端持久化：刷新后客户端恢复 localStorage 中的
  // 会话为当前会话（官方 restore 路径），新会话即成为 UI 当前会话。
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.executeJavaScript(
        "localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: " + JSON.stringify(sessionId) + " })); true",
      );
    }
  } catch (err) {
    logLine('[handoff] 写入当前会话指针失败：' + (err && err.message ? err.message : err));
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  } catch { /* 忽略 */ }
  // 自动发送接续指令（无需用户点击/输入）：官方 session.prompt 直发新会话（host 侧，
  // 新会话空白空闲，消息直接进入处理）；失败再退回输入框注入（页面此时已切到新会话）。
  const text = '\u8bf7\u6309 .dsh/handoff.md \u63a5\u7eed\u4efb\u52a1\uff1a\u5148\u8bfb\u8be5\u6587\u4ef6\u4e0e AGENTS.md\uff0c\u518d\u7528 memory__search_nodes \u67e5 task-progress\uff0c\u7136\u540e\u76f4\u63a5\u7ee7\u7eed\uff0c\u4e0d\u8981\u91cd\u505a\u5df2\u5b8c\u6210\u7684\u5de5\u4f5c\u3002';
  setTimeout(async () => {
    await new Promise((r) => setTimeout(r, 800)); // 等页面恢复
    let ok = false;
    try {
      const prompt = await rpcCall('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, 15000);
      const pr = prompt.body && prompt.body.result;
      ok = prompt.status === 200 && pr && pr.ok === true;
      if (!ok) logLine('[handoff] session.prompt 未接受：' + (pr && pr.error ? pr.error.message : ('HTTP ' + prompt.status)));
    } catch (err) {
      logLine('[handoff] session.prompt 失败：' + (err && err.message ? err.message : err));
    }
    if (ok) {
      logLine('[handoff] 接续指令已通过官方 API 发送到新会话 ' + sessionId);
      return;
    }
    // 兜底：输入框注入（页面应已切换到新会话）
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        if (await injectAndSendOnce(text)) {
          logLine('[handoff] 接续指令已通过输入框发送到新会话');
          return;
        }
      } catch { /* 页面未就绪，重试 */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    logLine('[handoff] 自动发送接续指令超时（30s），请手动发送');
  }, 1200);
}

/* ---------- 菜单 ---------- */

const AGENTS_TEMPLATE = `# AGENTS.md \u2014 \u9879\u76ee\u5de5\u4f5c\u6307\u5357
# harness \u4f1a\u81ea\u52a8\u52a0\u8f7d\u672c\u6587\u4ef6\u4f5c\u4e3a\u5de5\u4f5c\u4e0a\u4e0b\u6587\uff08\u7c7b\u4f3c CLAUDE.md\uff09\u3002
# \u5728\u6b64\u8bb0\u5f55\u9879\u76ee\u7ea6\u5b9a\u3001\u6784\u5efa\u65b9\u5f0f\u4e0e\u6ce8\u610f\u4e8b\u9879\u3002
`;

/** 打开/创建项目说明文件（workspace/AGENTS.md 或 $DSH_HOME/AGENTS.md），并补齐桌面端自动规范块。 */
function openAgentsFile(scope) {
  const target = scope === 'global'
    ? path.join(state.dshHome, 'AGENTS.md')
    : path.join(state.workspace, 'AGENTS.md');
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, AGENTS_TEMPLATE, 'utf8');
    }
    // 桌面端自动规范（项目地图 / 多会话并发 / Git 纪律）：追加或升级规范块
    const r = ensureNorms(target);
    if (r.status === 'error') logLine('[norms] 写入规范失败（' + target + '）：' + (r.error || ''));
    shell.openPath(target);
  } catch (err) {
    dialog.showErrorBox('\u6253\u5f00\u8bf4\u660e\u6587\u4ef6\u5931\u8d25', err && err.message ? err.message : String(err));
  }
}

/** 打开 Git 变更审查窗（Codex /diff 风格）。 */
function openGitDiffWindow() {
  if (gitDiffWindow && !gitDiffWindow.isDestroyed()) { gitDiffWindow.focus(); return; }
  if (!state.workspace) { dialog.showErrorBox('Git \u53d8\u66f4', '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a'); return; }
  gitDiffWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 560,
    minHeight: 380,
    title: 'Git \u53d8\u66f4 \u2014 DeepSeek Harness',
    backgroundColor: '#0d1117',
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  gitDiffWindow.on('closed', () => { gitDiffWindow = null; });
  gitDiffWindow.loadFile(path.join(APP_DIR, 'renderer', 'git-diff.html'));
}

/** 切换权限/沙箱模式并重启 harness（Codex 风格 sandbox/approval 控制）。 */
function switchPermissionMode(mode) {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) return;
  settings.set('permissionMode', mode);
  state.permissionMode = mode;
  broadcastState();
  buildMenu();
  logLine('[main] \u6743\u9650\u6a21\u5f0f\u5207\u6362\u4e3a ' + mode + '\uff0c\u91cd\u542f\u670d\u52a1\u2026');
  startHarness();
}

async function showApiBalance() {
  const result = await queryBalance({ dshHome: state.dshHome });
  if (!result.ok) {
    dialog.showErrorBox('API \u4f59\u989d', result.error || '\u67e5\u8be2\u5931\u8d25');
    return;
  }
  const lines = (result.balanceInfos || []).map((info) =>
    (info.currency || '?') + ' ' + (info.total_balance ?? '?') +
    '\uff08\u8d60\u9001 ' + (info.granted_balance ?? '?') + ' / \u5145\u503c ' + (info.topped_up_balance ?? '?') + ')');
  await msgBox({
    type: 'info', title: 'DeepSeek API \u4f59\u989d', noLink: true, buttons: ['\u786e\u5b9a'],
    message: result.isAvailable ? '\u8d26\u6237\u53ef\u7528' : '\u8d26\u6237\u4e0d\u53ef\u7528',
    detail: lines.join('\n') || '\uff08\u65e0\u4f59\u989d\u4fe1\u606f\uff09',
  });
}

async function showApiUsage() {
  const summary = scanWorkspaceUsage({ dshHome: state.dshHome, workspace: state.workspace, usagePrices: settings.get('usagePrices') });
  const t = summary.total;
  const lines = [
    '\u8f93\u5165\uff08\u7f13\u5b58\u672a\u547d\u4e2d\uff09\uff1a' + t.inputTokens.toLocaleString() + ' tokens',
    '\u8f93\u5165\uff08\u7f13\u5b58\u547d\u4e2d\uff09\uff1a' + t.cacheReadTokens.toLocaleString() + ' tokens',
    '\u8f93\u51fa\uff1a' + t.outputTokens.toLocaleString() + ' tokens',
    '\u63a8\u7406\uff1a' + t.reasoningTokens.toLocaleString() + ' tokens',
    '',
    '\u4f30\u7b97\u6210\u672c\uff1a$' + summary.estimatedCostUsd.toFixed(4),
    '\u4f1a\u8bdd\u6570\uff1a' + summary.sessions.length,
  ];
  await msgBox({
    type: 'info', title: 'API \u7528\u91cf\u7edf\u8ba1\uff08\u672c\u5de5\u4f5c\u533a\uff09', noLink: true, buttons: ['\u786e\u5b9a'],
    message: '\u7d2f\u8ba1\u7528\u91cf',
    detail: lines.join('\n'),
  });
}

function buildMenu() {
  const recent = (settings.get('recentWorkspaces') || []).filter((w) => w !== state.workspace).slice(0, 8);
  const recentItems = recent.length
    ? [
      ...recent.map((w) => ({
        label: w.length > 70 ? '\u2026' + w.slice(-66) : w,
        click: () => {
          settings.set('workspace', w);
          state.workspace = w;
          rememberWorkspace(w);
          broadcastState();
          startHarness();
        },
      })),
      { type: 'separator' },
    ]
    : [];
  const permissionItems = [
    {
      label: '\u53ea\u8bfb\uff08read-only\uff09',
      type: 'radio', checked: state.permissionMode === 'read-only',
      click: () => switchPermissionMode('read-only'),
    },
    {
      label: '\u5de5\u4f5c\u533a\u5199\u5165\uff08workspace-write\uff0c\u9ed8\u8ba4\uff09',
      type: 'radio', checked: state.permissionMode === 'workspace-write',
      click: () => switchPermissionMode('workspace-write'),
    },
    {
      label: '\u5b8c\u5168\u8bbf\u95ee\uff08danger-full-access\uff0c\u4e0d\u518d\u8be2\u95ee\uff09',
      type: 'radio', checked: state.permissionMode === 'danger-full-access',
      click: () => switchPermissionMode('danger-full-access'),
    },
  ];
  const template = [
    {
      label: '\u6587\u4ef6',
      submenu: [
        { label: '\u5207\u6362\u5de5\u4f5c\u533a\u2026', click: () => chooseWorkspace() },
        { label: '\u6253\u5f00\u5de5\u4f5c\u533a\u6587\u4ef6\u5939', click: () => { if (state.workspace) shell.openPath(state.workspace); } },
        ...(recent.length ? [{ label: '\u6700\u8fd1\u5de5\u4f5c\u533a', submenu: recentItems }] : []),
        { type: 'separator' },
        { label: '\u7f16\u8f91\u9879\u76ee\u8bf4\u660e\uff08AGENTS.md\uff09', click: () => openAgentsFile('workspace') },
        { label: '\u7f16\u8f91\u5168\u5c40\u8bf4\u660e\uff08DSH_HOME/AGENTS.md\uff09', click: () => openAgentsFile('global') },
        { type: 'separator' },
        { label: '\u91cd\u65b0\u52a0\u8f7d\u754c\u9762', accelerator: 'CmdOrCtrl+R', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } },
        { label: '\u91cd\u65b0\u542f\u52a8\u670d\u52a1', click: () => startHarness() },
        { type: 'separator' },
        { label: '\u9000\u51fa', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '\u89c6\u56fe',
      submenu: [
        { label: '\u7ec8\u7aef\u6a21\u5f0f\uff08\u5feb\u901f\u6267\u884c\u4efb\u52a1\uff09', accelerator: 'CmdOrCtrl+T', click: () => openHeadlessWindow() },
        { label: '\u67e5\u770b Git \u53d8\u66f4\u2026', accelerator: 'CmdOrCtrl+Shift+D', click: () => openGitDiffWindow() },
        { type: 'separator' },
        { label: '\u653e\u5927', role: 'zoomIn' },
        { label: '\u7f29\u5c0f', role: 'zoomOut' },
        { label: '\u5b9e\u9645\u5927\u5c0f', role: 'resetZoom' },
        { type: 'separator' },
        { label: '\u5f00\u53d1\u8005\u5de5\u5177', role: 'toggleDevTools' },
      ],
    },
    {
      label: '\u6a21\u5f0f',
      submenu: [
        ...permissionItems,
        { type: 'separator' },
        {
          label: '\u4efb\u52a1\u5b8c\u6210\u901a\u77e5',
          type: 'checkbox',
          checked: state.notifyOnComplete,
          click: (item) => {
            settings.set('notifyOnComplete', item.checked);
            state.notifyOnComplete = item.checked;
            broadcastState();
          },
        },
        { type: 'separator' },
        { label: '\u67e5\u8be2 API \u4f59\u989d\u2026', click: () => showApiBalance() },
        { label: 'API \u7528\u91cf\u7edf\u8ba1\u2026', click: () => showApiUsage() },
      ],
    },
    {
      label: '\u5de5\u5177',
      submenu: [
        { label: '\u5feb\u901f\u622a\u56fe\u5e76\u7c98\u8d34\u5230\u5bf9\u8bdd\u6846', accelerator: 'CmdOrCtrl+Shift+A', click: () => openCaptureWindow() },
        { label: '\u9644\u52a0\u6587\u4ef6\u2026', accelerator: 'CmdOrCtrl+Shift+O', click: () => attachFiles() },
        { label: '\u6253\u5f00\u9644\u4ef6\u76ee\u5f55', click: () => {
          if (state.workspace) {
            const dir = path.join(state.workspace, '.dsh-attachments');
            fs.mkdirSync(dir, { recursive: true });
            shell.openPath(dir);
          }
        } },
        { type: 'separator' },
        { label: '\u65b0\u5bf9\u8bdd\u63a5\u7eed\u5f53\u524d\u4efb\u52a1', accelerator: 'CmdOrCtrl+Shift+N', click: () => continueInNewConversation() },
        { type: 'separator' },
        { label: '\u7cfb\u7edf\u4f53\u68c0\u2026', click: async () => {
          const items = systemOps.doctor();
          const lines = items.map((i) => (i.ok ? '\u2713 ' : '\u2717 ') + i.title + ' \u2014 ' + i.detail);
          await msgBox({
            type: 'info', title: 'Windows \u73af\u5883\u4f53\u68c0', noLink: true, buttons: ['\u786e\u5b9a'],
            message: '\u5171 ' + items.filter((i) => i.ok).length + '/' + items.length + ' \u9879\u6b63\u5e38',
            detail: lines.join('\n') + '\n\n\u5b8c\u6574\u4fee\u590d\u8bf7\u5728 \u8bbe\u7f6e \u2192 \u7cfb\u7edf\u73af\u5883 \u4e2d\u64cd\u4f5c\u3002',
          });
        } },
        { type: 'separator' },
        { label: '\u5907\u4efd\u4e0e\u8fc1\u79fb\u2026', click: () => showBackupDialog() },
      ],
    },
    {
      label: '\u5e2e\u52a9',
      submenu: [
        { label: '\u68c0\u67e5\u66f4\u65b0\u2026', click: () => checkUpdates({ manual: true }) },
        { label: '\u6253\u5f00\u8bbe\u7f6e\u6587\u4ef6', click: () => { settings.save(); shell.openPath(settings.file); } },
        { label: '\u6253\u5f00\u65e5\u5fd7\u76ee\u5f55', click: () => { fs.mkdirSync(logDir, { recursive: true }); shell.openPath(logDir); } },
        { type: 'separator' },
        {
          label: '\u5173\u4e8e',
          click: () => msgBox({
            type: 'info', title: '\u5173\u4e8e', noLink: true, buttons: ['\u786e\u5b9a'],
            message: 'DeepSeek Harness \u684c\u9762\u7aef',
            detail: 'harness v' + (state.installed || '?') +
              '\n\u5de5\u4f5c\u533a\uff1a' + (state.workspace || '\u2014') +
              '\n\u6570\u636e\u76ee\u5f55\uff08DSH_HOME\uff09\uff1a' + state.dshHome,
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 备份与迁移对话框（菜单入口）。 */
async function showBackupDialog() {
  const { response } = await msgBox({
    type: 'info', title: '\u5907\u4efd\u4e0e\u8fc1\u79fb', noLink: true,
    message: '\u5bfc\u51fa/\u5bfc\u5165\u4f60\u7684\u5b9a\u5236\u5316 harness',
    detail: '\u5bfc\u51fa\uff1a\u8bbe\u7f6e\u3001skills\u3001AGENTS.md\u3001\u8bb0\u5fc6\u3001MCP/\u89c6\u89c9\u914d\u7f6e\u6253\u5305\u4e3a zip\uff08\u53ef\u9009\u5305\u542b API \u5bc6\u94a5\uff09\u3002\n\u5bfc\u5165\uff1a\u5728\u65b0\u7535\u8111\u5b89\u88c5 DSH \u684c\u9762\u7aef\u540e\u5bfc\u5165 zip\uff0c\u5373\u6062\u590d\u5168\u90e8\u6253\u78e8\u6210\u679c\u3002\n\n\u5b8c\u6574\u9009\u9879\u8bf7\u5230 \u8bbe\u7f6e \u2192 \u5907\u4efd\u4e0e\u8fc1\u79fb\u3002',
    buttons: ['\u5bfc\u51fa\uff08\u4e0d\u542b\u5bc6\u94a5\uff09', '\u5bfc\u51fa\uff08\u542b\u5bc6\u94a5\uff09', '\u53d6\u6d88'], defaultId: 0, cancelId: 2,
  });
  if (response === 0 || response === 1) {
    const file = backupOps.exportBackup(backupOptions(response === 1));
    try { shell.showItemInFolder(file); } catch { /* 定位失败不影响 */ }
  }
}

/* ---------- 启动 ---------- */

/**
 * 启动早期自动拉起本地 Ollama：当多模态设置已启用且 baseUrl 指向本地 Ollama
 * （127.0.0.1/localhost:11434）时，静默调用 ollama.start()，避免重启后本地 vision
 * 因服务未启动而失效。任何情况不阻塞启动、不弹窗：成功/失败都只写日志。
 * 调用方不 await（ollama.start() 内部自带幂等与并发保护，详见 main/ollama.js）。
 */
async function autoStartVisionOllama() {
  try {
    const vision = settings.get('vision');
    if (!vision || !vision.enabled || !vision.baseUrl) return;
    if (!ollama.isLocalOllama(String(vision.baseUrl))) return;
    // 先清僵尸 llama-server（上次崩溃/强杀残留，不监听 11434 但占显存；有活服务时自动跳过）
    await ollama.cleanupOrphans();
    await ollama.start();
    logLine('[vision] 本地多模态服务已自动启动');
  } catch (err) {
    logLine('[vision] 本地多模态自动启动失败（忽略）：' + ((err && err.message) || String(err)));
  }
}

async function main() {
  app.setName('DSH Desktop');
  // Windows 通知需要 AppUserModelId 才能以本应用身份弹出（否则显示 electron 默认名）。
  try { app.setAppUserModelId('com.dsh.desktop'); } catch { /* 忽略 */ }
  await app.whenReady();
  loadDefaultModel();
  // 启动早期自动拉起本地 Ollama（不 await：失败静默，绝不阻塞启动流程）。
  autoStartVisionOllama();
  ensurePackagedDshDir();
  checkUpdateGuard(); // 检测上次未完成的更新（只提示可重试，不自动重装）
  buildMenu();
  registerIpc();
  registerMcpPluginIpc();
  registerDesktopFeatureIpc();
  registerProvidersIpc();

  // 托盘、全局快捷键、开机自启（Codex/Claude 式常驻体验）
  setupTray();
  registerGlobalShortcuts();
  applyAutoStart(settings.get('autoStart'));
  // Windows 任务栏 JumpList：常用操作直达
  try {
    app.setUserTasks([
      { program: process.execPath, arguments: APP_DIR, title: '\u6253\u5f00 DeepSeek Harness', description: '\u6253\u5f00\u4e3b\u754c\u9762' },
      { program: process.execPath, arguments: APP_DIR + ' --from-context', title: '\u5feb\u901f\u547d\u4ee4', description: '\u5524\u8d77\u5feb\u901f\u547d\u4ee4\u6846' },
    ]);
  } catch { /* JumpList 失败不影响运行 */ }

  mainWindow = createMainWindow();
  // 预创建截图选区窗口（隐藏）：首次点击截图按钮零创建延迟（透明窗在软件渲染下创建很慢）
  precreateCaptureWindow();

  if (!state.workspace || !fs.existsSync(state.workspace)) {
    const dir = await chooseWorkspaceDialog();
    if (dir) {
      settings.set('workspace', dir);
      state.workspace = dir;
    } else {
      state.workspace = os.homedir();
    }
  }
  rememberWorkspace(state.workspace);

  // 桌面端自动规范：把项目地图 / 多会话并发 / Git 纪律写进全局与项目 AGENTS.md，
  // 让每个会话（不只当前对话）自动遵守；失败只记日志，不影响启动。
  try {
    for (const f of [path.join(state.dshHome, 'AGENTS.md'), path.join(state.workspace, 'AGENTS.md')]) {
      const r = ensureNorms(f);
      if (r.status !== 'unchanged') logLine('[norms] ' + r.status + '：' + f + (r.fromVersion ? '（v' + r.fromVersion + ' → v' + NORM_VERSION + '）' : ''));
    }
  } catch (err) {
    logLine('[norms] 写入自动规范失败（忽略）：' + ((err && err.message) || String(err)));
  }

  // 任务完成通知（Claude 风格）：监听会话日志写入突发结束。
  if (state.notifyOnComplete) {
    completionWatcher = startCompletionWatcher({
      sessionsDir: path.join(state.dshHome, 'sessions'),
      log: logLine,
      onComplete: () => {
        if (!state.notifyOnComplete) return;
        const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
        if (!focused) {
          showNotification({ title: 'DSH \u684c\u9762\u7aef \u2014 \u4efb\u52a1\u5b8c\u6210', body: 'harness \u5df2\u5b8c\u6210\u672c\u8f6e\u5de5\u4f5c\uff0c\u56de\u5230\u7a97\u53e3\u67e5\u770b\u7ed3\u679c\u3002' });
        }
        if (mainWindow && !mainWindow.isDestroyed() && !focused) mainWindow.flashFrame(true);
      },
    });
  }
  mainWindow.on('focus', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false); });

  // 自动记忆：把历史记忆从 npx 缓存迁移到受控位置（仅首次），然后监听"整轮对话
  // 彻底完成"，自动抽取值得沉淀的知识（项目事实/决策/踩坑/偏好）写入记忆图谱。
  migrateLegacyMemory();
  state.memoryFile = memoryFilePath();
  autoMemoryWatcher = startAutoMemory({
    sessionsDir: path.join(state.dshHome, 'sessions'),
    memoryFile: state.memoryFile,
    dshHome: state.dshHome,
    getEnabled: () => settings.get('memoryAutoEnabled') !== false,
    getLastSeen: () => settings.get('memoryLastSeen') || null,
    setLastSeen: (v) => settings.set('memoryLastSeen', v),
    log: logLine,
  });

  // 上下文压力告警：活动会话 token 累计超过阈值时弹通知 + 状态胶囊警示，
  // 让用户自己决定「新对话接续」还是继续压缩（而不是被系统默默压缩）。
  contextWatcher = startContextWatcher({
    dshHome: state.dshHome,
    getWorkspace: () => state.workspace,
    getEnabled: () => state.contextWarningEnabled,
    getThreshold: () => state.contextWarningTokens,
    log: logLine,
    onWarning: ({ sessionId, tokens, threshold, ratio }) => {
      state.contextWarning = { active: true, sessionId, tokens, threshold, ratio };
      broadcastState();
      // Codex「Persistent Memory」精神：任务状态自动沉淀，不依赖模型自觉——
      // 首次告警且尚无交接文件时自动生成 handoff 草稿（模型/用户可后续完善，
      // 已有文件（模型已写）绝不覆盖）。
      writeHandoffDraftIfMissing(sessionId, tokens);
      const focused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
      // 分级提醒：接近自动压缩点（harness compaction 阈值 = 上下文 80%，约 80 万 tokens）时，
      // 明确告知用户"即将自动压缩，可选接续或继续"；更早的告警只提示接近上限。
      const nearCompaction = tokens >= 750000;
      if (!focused) {
        showNotification({
          title: nearCompaction
            ? '\u5373\u5c06\u81ea\u52a8\u538b\u7f29\uff08' + Math.round((tokens / 800000) * 100) + '%\uff09'
            : '\u4e0a\u4e0b\u6587\u63a5\u8fd1\u4e0a\u9650\uff08' + ratio + '%\uff09',
          body: nearCompaction
            ? '\u5f53\u524d\u4f1a\u8bdd\u7ea6 ' + tokens.toLocaleString() + ' tokens\uff0c\u5c06\u5728\u538b\u7f29\u70b9\uff0880\u4e07\uff09\u81ea\u52a8\u538b\u7f29\u65e9\u671f\u5185\u5bb9\u3002\u5efa\u8bae\u70b9\u72b6\u6001\u80f6\u56ca\u201c\u63a5\u7eed\u201d\u5f00\u65b0\u5bf9\u8bdd\uff08\u65e0\u635f\uff09\uff0c\u6216\u7ee7\u7eed\u4f7f\u7528\u8ba9\u7cfb\u7edf\u538b\u7f29\u3002'
            : '\u5f53\u524d\u4f1a\u8bdd\u7ea6 ' + tokens.toLocaleString() + ' / ' + threshold.toLocaleString() +
              ' tokens\u3002\u5efa\u8bae\u70b9\u72b6\u6001\u80f6\u56ca\u201c\u63a5\u7eed\u201d\u5f00\u65b0\u5bf9\u8bdd\uff08\u65e0\u635f\u4ea4\u63a5\uff09\uff0c\u6216\u544a\u8bc9\u6a21\u578b\u7ee7\u7eed\u538b\u7f29\u3002',
        });
      }
      if (mainWindow && !mainWindow.isDestroyed() && !focused) mainWindow.flashFrame(true);
      logLine('[context-watch] \u8b66\u793a ' + sessionId + ' tokens=' + tokens + ' threshold=' + threshold + (nearCompaction ? '（\u5373\u5c06\u538b\u7f29\uff09' : ''));
    },
    // 压缩已发生（兜底告知）：自动压缩后通知用户，关键信息已保留在摘要中；
    // 同时补写 handoff 草稿（若告警时尚未生成；已有文件不覆盖）——压缩意味着上下文
    // 已被摘要化，此时自动沉淀任务状态，用户随时可点「接续」开新对话无损续做。
    onCompaction: ({ sessionId, seq }) => {
      logLine('[context-watch] \u5bf9\u8bdd\u5df2\u81ea\u52a8\u538b\u7f29 ' + sessionId + ' seq=' + seq);
      writeHandoffDraftIfMissing(sessionId, 0, '\u5bf9\u8bdd\u5df2\u81ea\u52a8\u538b\u7f29');
      try {
        if (state.notifyOnComplete !== false) {
          showNotification({
            title: '\u5bf9\u8bdd\u5df2\u81ea\u52a8\u538b\u7f29',
            body: '\u65e9\u671f\u5185\u5bb9\u5df2\u538b\u7f29\u4e3a\u6458\u8981\u4ee5\u91ca\u653e\u4e0a\u4e0b\u6587\u7a7a\u95f4\uff0c\u5173\u952e\u4fe1\u606f\u5df2\u4fdd\u7559\uff1b\u5982\u611f\u4fe1\u606f\u7f3a\u5931\u53ef\u8981\u6c42\u6a21\u578b\u8865\u5145\u3002\u5efa\u8bae\u540e\u7eed\u89c4\u5212\u65b0\u5bf9\u8bdd\u63a5\u7eed\u3002',
          });
        }
      } catch { /* 通知失败忽略 */ }
    },
    onClear: () => {
      if (state.contextWarning) {
        state.contextWarning = null;
        broadcastState();
      }
    },
  });

  // RPC 必须先于 harness 子进程启动：buildChildEnv 需要把地址/令牌注入子进程环境。
  await startRpc();
  // 让 harness 能解析桌面端客户端插件（写入 $DSH_HOME/profiles/node_modules 链接）。
  ensureClientPackageLink({ dshHome: state.dshHome, appDir: APP_DIR, log: logLine });
  await startHarness();
  startScheduler();
  setTimeout(() => { checkUpdates({ manual: false }); }, 5000);
  // 长会话文件归档：启动后延迟 60s 跑一次（避开启动高峰），此后每 24 小时一次；
  // 只截断"超大 + 非活动 + 已含 compaction 摘要"的会话（见 session-archive.js），
  // 失败/worker 不可用均静默跳过，绝不影响主流程。
  setTimeout(() => { try { archiveLargeSessions({ dshHome: state.dshHome, workspace: state.workspace, log: logLine }); } catch { /* 忽略 */ } }, 60000);
  setInterval(() => { try { archiveLargeSessions({ dshHome: state.dshHome, workspace: state.workspace, log: logLine }); } catch { /* 忽略 */ } }, 24 * 3600 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      startHarness();
    } else {
      showMainWindow();
    }
  });
  // 关闭到托盘时窗口只是隐藏，这里兜底保持进程常驻（托盘退出才真正退出）。
  app.on('window-all-closed', () => { /* 托盘模式下不退出 */ });
  app.on('before-quit', () => {
    quitting = true;
    // 任何原因的重启/退出，只要打断了进行中的回合、或用户最近正在使用（正在输入内容
    // 也算——此时没有进行中回合，sessionIsBusy 会漏判），就写接续消息：
    // 下次启动页面就绪后自动发送，让会话自己继续（无需用户手动接续）。
    try {
      const file = path.join(app.getPath('userData'), 'auto-resume.json');
      if (!fs.existsSync(file) && (sessionIsBusy() || sessionRecentlyActive(10 * 60 * 1000))) {
        fs.writeFileSync(file, JSON.stringify({
          msg: '\u7ee7\u7eed\u5b8c\u6210\u4e0a\u4e00\u4e2a\u88ab\u4e2d\u65ad\u7684\u4efb\u52a1\uff1a\u684c\u9762\u7aef\u91cd\u542f\u6253\u65ad\u4e86\u6b63\u5728\u8fdb\u884c\u7684\u5de5\u4f5c\uff08\u53ef\u80fd\u5305\u62ec\u60a8\u6b63\u5728\u8f93\u5165\u7684\u5185\u5bb9\uff09\uff0c\u8bf7\u68c0\u67e5\u4e0a\u4e0b\u6587\u540e\u7ee7\u7eed\u5b8c\u6210\u3002',
          at: Date.now(),
        }), 'utf8');
        logLine('[auto-resume] \u9000\u51fa\u65f6\u68c0\u6d4b\u5230\u672a\u5b8c\u6210\u5de5\u4f5c\uff0c\u5df2\u5199\u63a5\u7eed\u6d88\u606f');
      }
    } catch (err) { /* 忽略 */ }
  });
  app.on('will-quit', (event) => {
    const stop = async () => {
      globalShortcut.unregisterAll();
      if (scheduler) { try { scheduler.stop(); } catch { /* 忽略 */ } }
      if (completionWatcher) { try { completionWatcher.stop(); } catch { /* 忽略 */ } }
      if (autoMemoryWatcher) { try { autoMemoryWatcher.stop(); } catch { /* 忽略 */ } }
      if (contextWatcher) { try { contextWatcher.stop(); } catch { /* 忽略 */ } }
      ollama.stop();
      if (rpc) await rpc.stop().catch(() => {});
      if (harness) await harness.stop().catch(() => {});
      app.exit(0);
    };
    if (rpc || harness) {
      event.preventDefault();
      stop();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  // 安装版与 bat 版共用 userData，单实例锁按 userData 生效：
  // 另一个实例（可能是安装版/上次卡死的残留）还活着时会拿到锁失败。
  // 不静默退出，明确告诉用户怎么处理。
  dialog.showErrorBox(
    '\u65e0\u6cd5\u542f\u52a8\uff1a\u5df2\u6709\u4e00\u4e2a DSH \u684c\u9762\u7aef\u5728\u8fd0\u884c',
    '\u5b89\u88c5\u7248\u4e0e\u5f00\u53d1\u7248\uff08bat\uff09\u5171\u7528\u6570\u636e\u76ee\u5f55\uff0c\u540c\u65f6\u53ea\u80fd\u8fd0\u884c\u4e00\u4e2a\u3002\n\n' +
    '\u8bf7\u5148\u5b8c\u5168\u9000\u51fa\u5df2\u5728\u8fd0\u884c\u7684\u5b9e\u4f8b\uff1a\u6258\u76d8\u56fe\u6807\u53f3\u952e \u2192 \u9000\u51fa\uff1b\n' +
    '\u82e5\u627e\u4e0d\u5230\u7a97\u53e3\uff0c\u8bf7\u5728\u4efb\u52a1\u7ba1\u7406\u5668\u7ed3\u675f\u201cDSH Desktop.exe\u201d\u6216\u201celectron.exe\u201d\u540e\u91cd\u8bd5\u3002'
  );
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    // 右键菜单/JumpList 唤醒：--from-context [path]
    const idx = argv.indexOf('--from-context');
    if (idx >= 0) {
      if (argv[idx + 1]) {
        const target = argv[idx + 1];
        showMainWindow();
        setTimeout(() => {
          dispatchTaskToHarness('\u7528\u6237\u901a\u8fc7\u53f3\u952e\u83dc\u5355\u628a\u4e0b\u9762\u7684\u6587\u4ef6/\u6587\u4ef6\u5939\u4ea4\u7ed9\u4f60\u5904\u7406\uff1a\n' + target + '\n\n\u8bf7\u67e5\u770b\u5b83\u5e76\u8bf4\u660e\u4f60\u80fd\u505a\u4ec0\u4e48\uff08\u5982\u679c\u662f\u4ee3\u7801/\u6587\u6863\uff0c\u8bfb\u53d6\u5e76\u603b\u7ed3\uff1b\u5982\u679c\u662f\u6587\u4ef6\u5939\uff0c\u7ed9\u51fa\u7ed3\u6784\u6982\u89c8\u4e0e\u5efa\u8bae\uff09\u3002');
        }, 1200);
      } else {
        toggleQuickCommand();
      }
      return;
    }
    showMainWindow();
  });
  main().catch((err) => {
    dialog.showErrorBox('\u542f\u52a8\u5931\u8d25', err && err.stack ? err.stack : String(err));
    app.quit();
  });
}
