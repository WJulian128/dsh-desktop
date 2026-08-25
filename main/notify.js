'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Worker } = require('node:worker_threads');
const { decompressFrames } = require('./usage');

/**
 * 任务完成通知：监听 $DSH_HOME/sessions 目录（递归）的写入活动。
 * harness 在模型轮次期间会持续写会话日志（检查点、事件），一轮结束后停止。
 *
 * 判定"本轮对话彻底完成"而不是"某个小任务完成"：
 *  1. 写入突发结束后静默 idleMs（默认 5 秒）——原有启发式；
 *  2. 突发至少 3 次写入且跨越 1.5 秒（避免"新建空白会话"误报）；
 *  3. 会话流尾部的最后一条对话记录必须是 assistant/message（最终答复），
 *     且其后紧跟 harness 的回合结束帧 step/end——工具调用前的文字段落
 *     （assistant/message 后是 tool/call）没有 step/end，绝不误判为完成。
 *     若尾部是 tool/call、tool/result、assistant/chunk 或 tool-call-chunks，
 *     说明回合仍在进行（工具往返中的短暂停顿），不触发通知。
 */

/** 参与"回合状态"判定的记录类型。 */
const CONVERSATION_TYPES = new Set([
  'user/message', 'assistant/message', 'assistant/chunk', 'tool/call', 'tool/result', 'tool-call-chunks',
]);

/**
 * 根据解析后的记录列表判定回合状态（纯函数，便于测试）。
 * 从尾部向前找最后一条对话记录：
 *  - assistant/message 且其后有 step/end 回合结束帧 → 'round-done'（最终答复已落盘）
 *  - assistant/message 但后无 step/end → 'round-active'（工具调用前的文字段落，回合未结束）
 *  - tool/call | tool/result | assistant/chunk | tool-call-chunks → 'round-active'（回合还在进行）
 *  - user/message → 'user-pending'（用户刚发消息，模型尚未回复）
 *  - 无对话记录 → 'empty'
 * @param {Array<object>} records 解析后的记录数组（旧→新）
 */
function classifyLastRecord(records) {
  if (!Array.isArray(records)) return 'empty';
  let sawStepEnd = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const type = r && typeof r.type === 'string' ? r.type : '';
    if (type === 'step/end' || type === 'turn/end') { sawStepEnd = true; continue; } // 回合结束帧（主会话 step/end、子代理 turn/end）：仅标记，继续向前找对话记录
    if (!CONVERSATION_TYPES.has(type)) continue;
    if (type === 'assistant/message') return sawStepEnd ? 'round-done' : 'round-active';
    if (type === 'user/message') return 'user-pending';
    return 'round-active';
  }
  return 'empty';
}

/**
 * 轻量判定会话文件是否为子代理会话：只读文件头部 headBytes 内的 zstd 帧，
 * 找 type==='session' 记录检查 origin 字段（子代理会话 origin==='subagent'）。
 * 用于让 notify/memory-watch 跳过子代理会话——否则子代理完成时其会话文件是"最新写入"，
 * 会被当成活动会话：触发"任务完成"通知误报、把子代理对话误抽取进主记忆图谱。
 * 读取/解压失败一律按普通会话处理（false），绝不阻断主流程。
 * @param {string} file session.jsonl.zstd 绝对路径
 * @param {number} [headBytes] 只读文件头部多少字节（session 记录必然在文件头部）
 */
function isSubagentSessionFile(file, headBytes = 128 * 1024) {
  try {
    const st = fs.statSync(file);
    if (st.size < 64) return false;
    const len = Math.min(st.size, headBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    const magic = [0x28, 0xb5, 0x2f, 0xfd];
    for (let i = 0; i <= buf.length - 4; i++) {
      if (buf[i] !== magic[0] || buf[i + 1] !== magic[1] || buf[i + 2] !== magic[2] || buf[i + 3] !== magic[3]) continue;
      try {
        const r = JSON.parse(zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8'));
        if (r && r.type === 'session') return r.origin === 'subagent';
      } catch { /* 帧不完整/魔数误报，继续找下一帧 */ }
    }
    return false;
  } catch { return false; }
}

/** 递归找 sessions 目录下最新写入的 session.jsonl.zstd（形如 <workspace-key>/<session-id>/session.jsonl.zstd）。
 *  @param {string} sessionsRoot 会话根目录
 *  @param {object} [opts]
 *  @param {boolean} [opts.skipSubagent] 跳过子代理会话（子代理完成不应触发"任务完成"判定/记忆抽取）
 *  @param {number} [opts.maxSkips] 最多跳过的子代理会话数（防御性上限） */
function findNewestSessionFile(sessionsRoot, { skipSubagent = false, maxSkips = 20 } = {}) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return null; }
  for (const ws of entries) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(sessionsRoot, ws.name);
    let sess;
    try { sess = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of sess) {
      if (!s.isDirectory()) continue;
      const file = path.join(wsDir, s.name, 'session.jsonl.zstd');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      found.push({ file, mtimeMs });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (skipSubagent) {
    let skipped = 0;
    for (const cand of found) {
      if (skipped >= maxSkips) return cand; // 极端情况兜底：子代理过多时放弃过滤
      if (isSubagentSessionFile(cand.file)) { skipped += 1; continue; }
      return cand;
    }
    return null; // 全部都是子代理会话（罕见）
  }
  return found[0];
}

/** 文件过大时跳过尾部判定（避免阻塞主进程），返回 null 表示放弃判定。 */
const MAX_TAIL_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * 读取单个会话文件，判定是否"整轮完成"（纯 Node，可在 worker 线程内安全运行）。
 * 失败/文件过大返回 null（调用方回退旧行为）。
 * @param {string} file session.jsonl.zstd 的绝对路径
 */
function scanRoundDoneFile(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_TAIL_SCAN_BYTES) return null;
    const text = decompressFrames(fs.readFileSync(file));
    const records = [];
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try { records.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
    return classifyLastRecord(records) === 'round-done';
  } catch { return null; }
}

/** 读取最新会话文件尾部，判定是否"整轮完成"（跳过子代理会话——子代理完成不算主会话回合结束）。
 *  失败时返回 null（调用方回退旧行为）。 */
function isRoundDone(sessionsDir) {
  const active = findNewestSessionFile(sessionsDir, { skipSubagent: true });
  if (!active) return null;
  return scanRoundDoneFile(active.file);
}

// ---------------------------------------------------------------------------
// 共享扫描 worker 客户端：notify 与 memory-watch 共用一个 scan-worker 线程做
// "解压 + 解析"重活，主进程只做轻量调度。worker 加载失败/运行出错/超时时，
// 回退主进程同步执行（fallback），保证功能永不因 worker 停摆而失效。
// ---------------------------------------------------------------------------

let scanWorker = null;            // 共享 Worker 实例（惰性创建，进程生命周期内复用）
let scanSeq = 0;                  // 请求自增 id（与 worker 回包关联）
const scanCallbacks = new Map();  // id -> (msg) => void
let scanWorkerFailed = false;     // 构造彻底失败后不再重试（避免反复抛错）
const SCAN_TIMEOUT_MS = 60000;    // 单次扫描超时（防 worker 卡死导致永久等待）

/** 惰性创建/复用共享 scan worker；不可用时返回 null。 */
function getScanWorker(log) {
  if (scanWorker) return scanWorker;
  if (scanWorkerFailed) return null;
  try {
    const w = new Worker(path.join(__dirname, 'scan-worker.js'));
    let downHandled = false;
    const markDown = (reason) => {
      if (downHandled) return;
      downHandled = true;
      scanWorker = null;
      log('[scan-worker] ' + reason);
      const pending = Array.from(scanCallbacks.values());
      scanCallbacks.clear();
      // 在途请求全部回退（调用方走同步 fallback），绝不悬挂
      for (const cb of pending) cb({ error: reason });
    };
    w.on('message', (msg) => {
      if (!msg || typeof msg.id !== 'number') return;
      const cb = scanCallbacks.get(msg.id);
      if (!cb) return;
      scanCallbacks.delete(msg.id);
      cb(msg);
    });
    w.on('error', (err) => markDown('worker 错误：' + (err && err.message ? err.message : err)));
    w.on('exit', (code) => markDown('worker 退出（code=' + code + '）'));
    w.unref(); // 不因 worker 挂住进程退出（桌面端主进程常驻不受影响；纯 Node 测试/工具可正常收尾）
    scanWorker = w;
    return w;
  } catch (err) {
    scanWorkerFailed = true;
    log('[scan-worker] 加载失败，回退主进程同步扫描：' + (err && err.message ? err.message : err));
    return null;
  }
}

/**
 * 经共享 worker 执行扫描任务；worker 不可用/出错/超时时回退主进程同步执行。
 * 永不 reject（失败一律以 { error } 形态 resolve）。
 * @param {'is-round-done'|'extract-conversation'} task 任务名
 * @param {object} payload 任务参数（file，或 file+maxChars）
 * @param {() => object} fallback 同步回退实现，返回与 worker 成功结果相同形状的对象
 * @param {(text: string) => void} [log]
 * @returns {Promise<object>} 结果对象（成功字段或 error）
 */
function runScanTask(task, payload, fallback, log = () => {}) {
  return new Promise((resolve) => {
    const safeFallback = () => {
      try { resolve(fallback()); }
      catch (err) { resolve({ error: '同步回退失败：' + (err && err.message ? err.message : err) }); }
    };
    const w = getScanWorker(log);
    if (!w) { safeFallback(); return; }
    const id = ++scanSeq;
    const timer = setTimeout(() => {
      if (scanCallbacks.delete(id)) {
        log('[scan-worker] ' + task + ' 超时（' + SCAN_TIMEOUT_MS + 'ms），回退主进程同步');
        safeFallback();
      }
    }, SCAN_TIMEOUT_MS);
    scanCallbacks.set(id, (msg) => {
      clearTimeout(timer);
      if (msg && msg.error) {
        log('[scan-worker] ' + task + ' 失败，回退主进程同步：' + msg.error);
        safeFallback();
      } else {
        resolve(msg || { error: '空响应' });
      }
    });
    try {
      w.postMessage({ id, task, ...payload });
    } catch (err) {
      scanCallbacks.delete(id);
      clearTimeout(timer);
      log('[scan-worker] 发送任务失败，回退主进程同步：' + (err && err.message ? err.message : err));
      safeFallback();
    }
  });
}

/** 经 worker 异步判定"整轮完成"（回调形式，跳过子代理会话）；worker 不可用时同步回退。 */
function scanRoundDoneAsync(sessionsDir, log, cb) {
  const active = findNewestSessionFile(sessionsDir, { skipSubagent: true });
  if (!active) { cb(null); return; }
  runScanTask('is-round-done', { file: active.file }, () => ({ done: scanRoundDoneFile(active.file) }), log)
    .then((res) => cb(res && typeof res.done === 'boolean' ? res.done : null));
}

function startCompletionWatcher({ sessionsDir, onComplete, idleMs = 5000, log = () => {} }) {
  if (!fs.existsSync(sessionsDir)) {
    log('[notify] 会话目录不存在，跳过完成通知：' + sessionsDir);
    return { stop() {} };
  }
  let active = false;
  let firstAt = 0;
  let lastAt = 0;
  let count = 0;
  let timer = null;
  let watcher = null;
  let scanning = false;   // 尾部扫描（worker 异步）进行中，期间新完成事件跳过，避免堆积

  const settle = () => {
    const now = Date.now();
    const idle = now - lastAt >= idleMs;
    const span = lastAt - firstAt;
    if (active && idle && count >= 3 && span >= 1500) {
      // 关键：只有"整轮完成"（尾部为最终答复）才通知；中间的工具往返停顿不通知。
      // 尾部判定经 scan worker 异步执行（解压重活不进主进程）；扫描期间再来完成事件则跳过。
      if (scanning) {
        log('[notify] 上一次尾部扫描尚未结束，跳过本次完成判定');
      } else {
        scanning = true;
        scanRoundDoneAsync(sessionsDir, log, (done) => {
          scanning = false;
          if (done === null || done) {
            try { onComplete(); } catch (err) { log('[notify] onComplete 失败：' + (err && err.message ? err.message : err)); }
          } else {
            log('[notify] 回合仍在进行（尾部非最终答复），跳过本次完成通知');
          }
        });
      }
    }
    active = false;
    count = 0;
  };

  try {
    watcher = fs.watch(sessionsDir, { recursive: true }, () => {
      const now = Date.now();
      if (!active) { active = true; firstAt = now; lastAt = now; count = 1; }
      else { lastAt = now; count += 1; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(settle, idleMs);
    });
    watcher.on('error', (err) => log('[notify] 会话目录监听错误：' + (err && err.message ? err.message : err)));
  } catch (err) {
    log('[notify] 启动完成通知监听失败：' + (err && err.message ? err.message : err));
  }

  return {
    stop() {
      if (timer) clearTimeout(timer);
      if (watcher) { try { watcher.close(); } catch { /* 忽略 */ } }
      watcher = null;
    },
  };
}

module.exports = {
  startCompletionWatcher, classifyLastRecord, findNewestSessionFile,
  scanRoundDoneFile, isRoundDone, runScanTask, isSubagentSessionFile,
};
