'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Worker } = require('node:worker_threads');
const { workspaceSessionKey } = require('./usage');

/**
 * 上下文压力监视：定期扫描工作区下最近写入的会话（活动会话）的 token 累计，
 * 超过阈值时回调告警——桌面端据此弹通知 + 状态胶囊警示，让用户选择
 * 「新对话接续」还是继续压缩，而不是被系统默默压缩。
 *
 * 重活（zstd 解压 + JSON 解析）在 worker 线程（context-watch-worker.js）里做，
 * 绝不阻塞 Electron 主进程——否则大会话会卡死 UI（曾引发 AppHangB1）。
 * worker 崩溃后自动重启：指数退避 1s/2s/4s…上限 30s，连续 10 次失败后放弃并日志
 * （避免崩溃循环打爆主进程；放弃后功能静默停用，主线程不受影响）。
 *
 * 告警数据除活动会话外，还附带"其他活跃会话概览"（最近 3 天有写入、最多 5 个），
 * 供客户端提示用户还有哪些会话在占用上下文——数据只增字段，不影响旧消费方。
 */

/** 多会话概览参数：最近 3 天有写入、最多 5 个。 */
const OTHERS_RECENT_MS = 3 * 24 * 3600 * 1000;
const OTHERS_MAX = 5;
/** worker 自愈参数：指数退避基数 1s、上限 30s、连续 10 次失败放弃。 */
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const RESTART_MAX_ATTEMPTS = 10;

/** 找到最近写入的会话（活动会话）。返回 { sessionId, file, mtimeMs } 或 null。 */
function findActiveSession(sessionsRoot) {
  if (!fs.existsSync(sessionsRoot)) return null;
  let best = null;
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(sessionsRoot, entry.name, 'session.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (!best || mtimeMs > best.mtimeMs) best = { sessionId: entry.name, file, mtimeMs };
  }
  return best;
}

/** 会话对话体量（tokens）：输入（缓存未命中）+ 缓存命中 + 输出。 */
function sessionTokens(usage) {
  if (!usage) return 0;
  return (usage.inputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.outputTokens || 0);
}

/**
 * 当前上下文尺寸（tokens）：取最后一次请求的 usage（inputTokens 缓存未命中 + cacheReadTokens 缓存命中）。
 * 注意与累计 usage 的区别：累计值（历史全部请求总额，cacheReadTokens 可上亿）只用于计费，
 * 不能反映当前上下文压力——旧实现用它导致告警虚高数百倍。
 * @param {{lastUsage?: object}|null} scanned scanSessionFile 的返回值
 */
function sessionContextTokens(scanned) {
  const u = scanned && scanned.lastUsage;
  if (!u) return 0;
  return (u.inputTokens || 0) + (u.cacheReadTokens || 0);
}

/**
 * 告警决策（纯函数，便于测试）。
 * @param {{warnedSessionId: string, warnedTokens: number}|null} prev 上次告警状态
 * @param {{sessionId: string, tokens: number, threshold: number}} current
 * @returns {{warn: boolean, next: object|null}} 是否告警及新状态
 * 规则：低于阈值 → 清除状态（压缩后回落会重置）；跨会话 → 重新告警；
 * 同一会话在阈值上，每再增长 5% 追加告警一次（持续施压提醒）。
 */
function shouldWarn(prev, current) {
  if (current.tokens < current.threshold) return { warn: false, next: null };
  if (!prev || prev.warnedSessionId !== current.sessionId || current.tokens >= prev.warnedTokens * 1.05) {
    return { warn: true, next: { warnedSessionId: current.sessionId, warnedTokens: current.tokens } };
  }
  return { warn: false, next: prev };
}

/**
 * 列出"其他活跃会话"（排除活动会话）：最近 recentMs 内有写入（按文件 mtime），
 * 按最近写入降序，最多 max 个。只做轻量目录/stat 扫描，不解压（token 由调用方经 worker 计算）。
 * @param {string} sessionsRoot 工作区会话根目录
 * @param {string} activeSessionId 当前活动会话（排除）
 * @param {number} [now] 当前时间戳（ms）
 * @param {number} [max] 最多返回个数，默认 5
 * @param {number} [recentMs] 最近写入窗口，默认 3 天
 * @returns {Array<{sessionId: string, file: string, mtimeMs: number}>}
 */
function listOtherSessions(sessionsRoot, activeSessionId, now = Date.now(), max = OTHERS_MAX, recentMs = OTHERS_RECENT_MS) {
  const out = [];
  if (!fs.existsSync(sessionsRoot)) return out;
  let entries;
  try { entries = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === activeSessionId) continue;
    const file = path.join(sessionsRoot, entry.name, 'session.jsonl.zstd');
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (now - mtimeMs > recentMs) continue;
    out.push({ sessionId: entry.name, file, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, max);
}

/**
 * 启动监视器（主线程只做轻量调度与决策，扫描在 worker 线程）。
 * @param {object} options
 * @param {string} options.dshHome
 * @param {() => string} options.getWorkspace 工作区（实时读取，支持切换）
 * @param {() => boolean} options.getEnabled 告警开关（实时读取）
 * @param {() => number} options.getThreshold 阈值（实时读取）
 * @param {(info: {sessionId: string, tokens: number, threshold: number, ratio: number, others: Array<{sessionId: string, tokens: number, lastWriteMs: number}>}) => void} options.onWarning
 * @param {() => void} [options.onClear] tokens 回落到阈值以下时回调（清除警示态）
 * @param {({sessionId: string, seq: number}) => void} [options.onCompaction] 检测到会话文件新增 compaction/summary 记录时回调（对话已被自动压缩）
 * @param {(text: string) => void} [options.log]
 * @param {number} [options.intervalMs] 默认 30 秒（15s 时 worker 扫描与渲染/Ollama 抢 CPU 造成体感卡顿）
 * @returns {{ stop: () => void }}
 */
function startContextWatcher({ dshHome, getWorkspace, getEnabled, getThreshold, onWarning, onClear, onCompaction, log = () => {}, intervalMs = 60000 }) {
  let worker = null;
  let warned = null;
  let lastFile = null;       // 上次已扫描的活动会话文件
  let lastMtime = 0;
  let lastCompactionSeq = null; // 上次已通知的 compaction/summary seq（按活动会话文件重置）
  let pendingCount = 0;      // 在途 worker 扫描数（活动 + 其他会话，全部返回后统一决策）
  let activeResult = null;   // 当前批次活动会话扫描结果
  let othersResults = [];    // 当前批次其他会话概览
  let batchMtimes = new Map(); // file -> mtimeMs（当前批次其他会话，用于结果缓存）
  let othersCache = new Map(); // file -> { mtimeMs, tokens }（跨批次缓存，其他会话不常变）
  let restartAttempts = 0;   // 连续重启失败计数
  let restartTimer = null;   // 退避重启定时器
  let stopped = false;

  /** 本批次扫描全部返回后：统一做告警决策（活动会话 + 其他会话概览）。 */
  const finalizeBatch = () => {
    const threshold = Math.max(10000, Number(getThreshold()) || 700000);
    const decision = shouldWarn(warned, { sessionId: activeResult.sessionId, tokens: activeResult.tokens, threshold });
    if (decision.warn) {
      warned = decision.next;
      onWarning({
        sessionId: activeResult.sessionId,
        tokens: activeResult.tokens,
        threshold,
        ratio: Math.round((activeResult.tokens / threshold) * 100),
        others: othersResults, // 新增字段：其他活跃会话概览（[{sessionId, tokens, lastWriteMs}]）
      });
    } else if (decision.next === null && warned !== null) {
      warned = null;
      if (onClear) onClear();
    }
  };

  /** worker 掉线：作废在途请求、安排指数退避重启；连续 10 次失败放弃。 */
  const handleWorkerDown = (reason) => {
    if (stopped) return;
    log('[context-watch] ' + reason);
    worker = null;
    pendingCount = 0;      // 在途请求作废（结果不会再回来）
    activeResult = null;
    othersResults = [];
    lastFile = null;       // 重启后重新扫描当前活动会话，避免漏掉崩溃时刻
    lastMtime = 0;
    restartAttempts += 1;
    if (restartAttempts >= RESTART_MAX_ATTEMPTS) {
      log('[context-watch] 连续 ' + restartAttempts + ' 次重启失败，放弃 worker（上下文告警停用）');
      return;
    }
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * Math.pow(2, restartAttempts - 1));
    log('[context-watch] ' + delay + 'ms 后重启 worker（第 ' + restartAttempts + ' 次）');
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(spawnWorker, delay);
  };

  /** 创建 worker 并接线；'error'/'exit' 触发自愈（stop() 主动终止除外）。 */
  const spawnWorker = () => {
    if (stopped) return;
    let downHandled = false;
    const markDown = (reason) => {
      if (downHandled) return; // error 与 exit 可能成对触发，只处理一次
      downHandled = true;
      handleWorkerDown(reason);
    };
    try {
      const w = new Worker(path.join(__dirname, 'context-watch-worker.js'), { workerData: { dshHome } });
      w.on('message', (msg) => {
        if (!msg || msg.type !== 'scan-result') return;
        restartAttempts = 0; // 能回包说明 worker 真正存活：中断"连续失败"计数
        pendingCount = Math.max(0, pendingCount - 1);
        if (msg.error) {
          log('[context-watch] scan error: ' + msg.error);
        } else if (msg.file === lastFile) {
          activeResult = { sessionId: msg.sessionId, tokens: msg.tokens };
        } else {
          const mtimeMs = batchMtimes.get(msg.file);
          if (typeof mtimeMs === 'number') othersCache.set(msg.file, { mtimeMs, tokens: msg.tokens });
          othersResults.push({ sessionId: msg.sessionId, tokens: msg.tokens, lastWriteMs: mtimeMs });
        }
        if (pendingCount === 0 && activeResult) finalizeBatch();
      });
      w.on('error', (err) => markDown('worker error: ' + (err && err.message ? err.message : err)));
      w.on('exit', (code) => { if (stopped) return; markDown('worker 退出（code=' + code + '），自动重启'); });
      worker = w;
      // 注意：restartAttempts 不在此处清零——new Worker() 成功不代表线程真正起来
      // （启动即崩溃也会走到这里），只有在 message 里收到回包才算存活（见上）。
    } catch (err) {
      markDown('worker 启动失败：' + (err && err.message ? err.message : err));
    }
  };

  // 初始启动（失败也由自愈逻辑接管）
  spawnWorker();

  const timer = setInterval(() => {
    try {
      if (!worker || pendingCount > 0 || !getEnabled()) return;
      const sessionsRoot = path.join(dshHome, 'sessions', workspaceSessionKey(getWorkspace() || ''));
      const active = findActiveSession(sessionsRoot);
      if (!active) return;
      if (active.file === lastFile && active.mtimeMs === lastMtime) return; // 无新增，不重复扫描
      // 压缩检测（压缩前用户已被告警，这里兜底告知压缩已发生）：
      // 活动会话文件有新增内容时，尾帧解压检查是否有新的 compaction/summary 记录（zstd 帧自包含，
      // 只解压尾部 256KB 内最后 40 帧，毫秒级；去重按 seq）。
      if (active.file !== lastFile) lastCompactionSeq = null; // 切换会话重置去重游标
      try {
        const seq = tailCompactionSeq(active.file, lastCompactionSeq);
        if (seq !== null) {
          lastCompactionSeq = seq;
          if (onCompaction) {
            try { onCompaction({ sessionId: active.sessionId, seq }); } catch { /* 忽略 */ }
          }
        }
      } catch { /* 检测失败不影响扫描 */ }
      lastFile = active.file;
      lastMtime = active.mtimeMs;
      activeResult = null;
      othersResults = [];
      batchMtimes = new Map();
      pendingCount = 1;
      worker.postMessage({ file: active.file, sessionId: active.sessionId });
      // 其他活跃会话概览：缓存命中（文件未变）不重复扫描
      const others = listOtherSessions(sessionsRoot, active.sessionId);
      for (const o of others) {
        const cached = othersCache.get(o.file);
        if (cached && cached.mtimeMs === o.mtimeMs) {
          othersResults.push({ sessionId: o.sessionId, tokens: cached.tokens, lastWriteMs: o.mtimeMs });
        } else {
          batchMtimes.set(o.file, o.mtimeMs);
          pendingCount += 1;
          worker.postMessage({ file: o.file, sessionId: o.sessionId });
        }
      }
    } catch (err) {
      pendingCount = 0;
      log('[context-watch] ' + (err && err.message ? err.message : err));
    }
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (worker) { try { worker.terminate(); } catch { /* 忽略 */ } worker = null; }
    },
  };
}

/** 尾帧检测：活动会话文件尾部是否出现新的 compaction/summary 记录（返回其 seq，未新增返回 null）。
 *  只解压文件尾部 tailBytes 内的最后 maxFrames 个 zstd 帧（每条 JSONL 记录一帧，毫秒级），
 *  不做全量解压（长会话文件可达数 MB，全量解压会阻塞主进程）。 */
function tailCompactionSeq(file, lastSeq, tailBytes = 256 * 1024, maxFrames = 40) {
  try {
    const st = fs.statSync(file);
    if (st.size < 64) return null;
    const start = Math.max(0, st.size - tailBytes);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const magic = [0x28, 0xb5, 0x2f, 0xfd];
    let maxSeq = null;
    for (let i = buf.length - 4; i >= 0; i--) {
      if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
        try {
          const r = JSON.parse(zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8'));
          if (r && r.type === 'compaction/summary' && typeof r.seq === 'number') {
            if (maxSeq === null || r.seq > maxSeq) maxSeq = r.seq;
          }
        } catch { /* 帧可能未写完，跳过 */ }
      }
    }
    return maxSeq !== null && maxSeq !== lastSeq ? maxSeq : null;
  } catch { return null; }
}

module.exports = { startContextWatcher, findActiveSession, sessionTokens, sessionContextTokens, shouldWarn, listOtherSessions };
