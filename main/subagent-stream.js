'use strict';
/**
 * 子代理推理过程实时读取：供 UI 调度面板展示每个运行中子代理的流式推理/输出内容。
 *
 * 数据源与 subagent-center.js 同机制：$DSH_HOME/sessions/<workspace-key>/<session-id>/session.jsonl.zstd
 * （拼接的 zstd 帧 JSONL，逐帧解压）。纯 Node 模块，不依赖 electron；所有异常 catch 返回空结果不抛出。
 *
 * 真实事件字段（已在真实会话文件中确认，见 selfcheck 输出）：
 *  - session 记录：{ type:'session', id, createdAt, origin:'subagent', parentSession, ... }
 *  - subagent/descriptor：{ type, seq, time, data:{ label, mode, provider, agentProvider, agentModel } }
 *  - assistant/chunk：{ type:'assistant/chunk', seq, time, data:{ turn, step, chunk } }
 *    chunk.type ∈ block-start | reasoning-delta | tool-call-delta | text-delta | block-end | usage | finish；
 *    内容增量在 text-delta 的 chunk.text，推理增量在 reasoning-delta 的 chunk.text。
 *  - assistant/message：{ type, seq, time, data:{ message:{ content:[{type:'text'|'reasoning', text}...] } } }
 *  - turn/end：{ type:'turn/end', seq, time, data:{ turn, reason } } —— 会话结束信号
 *  - reasoning-chunks / text-chunks / tool-call-chunks：UI 同步事件，只有 seq0/time0，无 seq/time，不参与增量。
 *  - 注意：记录的 seq 是 harness 的全局事件序号（单调递增），不是 JSONL 行号；
 *    compaction 重写后文件从头开始，靠 截断检测 / 首条 seq 回退 / compaction/start 记录 触发全量重扫。
 *
 * 缓存策略：
 *  - Map<file, entry>，entry 含 mtimeMs/bytesRead/累计 text/reasoning/尾部原始记录/增量块数组等；
 *  - 列表轮询（2s）内 1.5s 新鲜度窗口直接复用缓存（连 stat 都省）；
 *  - 文件没变（mtime+size 相同）直接复用；变了则只解压新增字节增量续读（zstd 帧自包含，可从上次
 *    bytesRead 处继续）；截断重写/seq 回退/出现 compaction/start 时全量重扫。
 */
const fs = require('node:fs');
const path = require('node:path');
const { decompressFrames, workspaceSessionKey } = require('./usage');
const { classifySubagentStatus } = require('./subagent-center');

// ---------- 常量 ----------
const CACHE_TTL_MS = 1500;             // 列表轮询新鲜度窗口：1.5s 内直接复用缓存
const TEXT_CAP = 3000;                 // listSubagentStream 的 lastText/reasoningText 上限（running 累计）
const ACCUM_CAP = 100000;              // 内部累计上限，防止超长会话字符串无限增长
const TAIL_RECORDS = 500;              // 保留的尾部原始记录数（状态判定足够精确）
const DELTA_CAP = 5000;                // streamSince 保留的增量块数；游标落后于保留区则全量重扫
const MAX_CACHE = 500;                 // 缓存条目上限，超出清空避免无界增长

const cache = new Map(); // file -> entry

/** 新建空缓存条目。 */
function newEntry() {
  return {
    mtimeMs: 0,
    scannedAt: 0,
    bytesRead: 0,
    seq: 0,          // 游标：已见最大事件 seq（无 seq 字段时回退为记录数）
    hasRealSeq: false,
    recordCount: 0,
    text: '',        // text-delta 累计（内部封顶 ACCUM_CAP）
    reasoning: '',   // reasoning-delta 累计（内部封顶 ACCUM_CAP）
    lastMessageText: '',
    lastMessageReasoning: '',
    deltas: [],      // [{ seq, kind:'text'|'reasoning', value }]，供 streamSince 增量返回
    deltasStartSeq: Infinity,
    records: [],     // 尾部原始记录（封顶 TAIL_RECORDS），供 classifySubagentStatus 判定
    updatedAt: 0,    // 已见最大 time
    hasTurnEnd: false,
    seenSession: false,
    isSubagent: false,
    sessionId: null,
    parentSession: null, // 父会话 id：用于按当前对话过滤子代理
    createdAt: null,
    descriptor: null,
    title: null,
  };
}

/** 解析 JSONL 文本为记录数组；给每条记录附加 __line（1 起行号，作无 seq 时的兜底）。 */
function parseLines(text) {
  const out = [];
  let lineIndex = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    lineIndex++;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // 坏行跳过
    if (!r || typeof r.type !== 'string') continue;
    r.__line = lineIndex;
    out.push(r);
  }
  return out;
}

/** 追加一条增量块并裁剪（封顶 DELTA_CAP，更新保留区起点 seq）。 */
function pushDelta(entry, record, kind, value) {
  const seq = typeof record.seq === 'number' ? record.seq : record.__line;
  entry.deltas.push({ seq, kind, value });
  if (entry.deltas.length > DELTA_CAP) entry.deltas.splice(0, entry.deltas.length - DELTA_CAP);
  entry.deltasStartSeq = entry.deltas.length ? entry.deltas[0].seq : Infinity;
}

/** 把解析出的记录折入缓存条目（增量与全量共用）。 */
function foldRecords(entry, records) {
  for (const r of records) {
    entry.recordCount++;
    if (typeof r.time === 'number' && r.time > entry.updatedAt) entry.updatedAt = r.time;
    if (typeof r.seq === 'number') {
      entry.hasRealSeq = true;
      if (r.seq > entry.seq) entry.seq = r.seq;
    }
    const t = r.type;
    if (t === 'session') {
      entry.seenSession = true;
      if (!entry.sessionId && typeof r.id === 'string') entry.sessionId = r.id;
      if (!entry.parentSession && typeof r.parentSession === 'string') entry.parentSession = r.parentSession;
      if (!entry.createdAt && typeof r.createdAt === 'number') entry.createdAt = r.createdAt;
      if (r.origin === 'subagent') entry.isSubagent = true;
    } else if (t === 'subagent/descriptor') {
      if (!entry.descriptor && r.data && typeof r.data === 'object') entry.descriptor = r.data;
    } else if (t === 'request/header') {
      // 真实模型路由：descriptor 里没有 agentModel（实际结构仅 {version, mode, provider:'spawn'}），
      // 模型名/厂商从 request/header.config 读取（provider/model 是实际路由）
      const cfg = r.data && r.data.header && r.data.header.config;
      if (cfg && typeof cfg === 'object') {
        if (typeof cfg.provider === 'string' && cfg.provider && !entry.provider) entry.provider = cfg.provider;
        if (typeof cfg.model === 'string' && cfg.model && !entry.model) entry.model = cfg.model;
      }
    } else if (t === 'session/title') {
      if (!entry.title && r.data && typeof r.data.title === 'string' && r.data.title) entry.title = r.data.title;
    } else if (t === 'turn/end') {
      entry.hasTurnEnd = true;
    } else if (t === 'assistant/message') {
      const msg = r.data && r.data.message;
      if (msg && Array.isArray(msg.content)) {
        let text = '';
        let reasoning = '';
        for (const block of msg.content) {
          if (!block || typeof block.text !== 'string') continue;
          if (block.type === 'text') text += block.text;
          else if (block.type === 'reasoning') reasoning += block.text;
        }
        if (text) entry.lastMessageText = text;
        if (reasoning) entry.lastMessageReasoning = reasoning;
      }
    } else if (t === 'assistant/chunk') {
      const c = r.data && r.data.chunk;
      if (c && typeof c.type === 'string') {
        if (c.type === 'text-delta' && typeof c.text === 'string' && c.text) {
          entry.text = (entry.text + c.text).slice(-ACCUM_CAP);
          pushDelta(entry, r, 'text', c.text);
        } else if (c.type === 'reasoning-delta' && typeof c.text === 'string' && c.text) {
          entry.reasoning = (entry.reasoning + c.text).slice(-ACCUM_CAP);
          pushDelta(entry, r, 'reasoning', c.text);
        }
      }
    }
    entry.records.push(r);
    if (entry.records.length > TAIL_RECORDS) entry.records.splice(0, entry.records.length - TAIL_RECORDS);
  }
  if (!entry.hasRealSeq) entry.seq = entry.recordCount; // 全程无 seq 字段时用记录数兜底
}

/** 全量解析文件，构建全新缓存条目（失败返回 null）。 */
function buildEntry(file, st) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  let text;
  try { text = decompressFrames(buf); } catch { return null; }
  const entry = newEntry();
  entry.mtimeMs = st.mtimeMs;
  entry.bytesRead = buf.length;
  entry.scannedAt = Date.now();
  foldRecords(entry, parseLines(text));
  return entry;
}

/**
 * 文件已变化：优先只解压新增字节增量续读；
 * 检测到截断/重写（长度回退、首条 seq 回退、出现 session/compaction/start）则全量重扫。
 */
function refreshEntry(entry, file, st) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length <= entry.bytesRead) {
    if (buf.length === entry.bytesRead) { // 内容未变（仅 touch/元数据），刷新即可
      entry.mtimeMs = st.mtimeMs;
      entry.scannedAt = Date.now();
      return entry;
    }
    return buildEntry(file, st); // 文件被截断重写（compaction）→ 全量重扫
  }
  let tailText;
  try { tailText = decompressFrames(buf.subarray(entry.bytesRead)); } catch { return null; }
  // 帧边界校验：上次读取可能命中"正在写入的未完成帧"（该帧被解压器跳过但 bytesRead 已越过它），
  // 此时新尾巴起点在帧中间，增量续读会永久丢帧 → 回退全量重扫。
  const tail = buf.subarray(entry.bytesRead);
  const atFrameBoundary = tail.length >= 4 && tail[0] === 0x28 && tail[1] === 0xb5 && tail[2] === 0x2f && tail[3] === 0xfd;
  if (!atFrameBoundary) return buildEntry(file, st);
  const newRecords = parseLines(tailText);
  const first = newRecords[0];
  const rewritten = first && (first.type === 'session' || first.type === 'compaction/start' ||
    (typeof first.seq === 'number' && first.seq <= entry.seq));
  if (rewritten) return buildEntry(file, st);
  foldRecords(entry, newRecords);
  entry.mtimeMs = st.mtimeMs;
  entry.bytesRead = buf.length;
  entry.scannedAt = Date.now();
  return entry;
}

/** 读取/刷新某会话文件的缓存条目（1.5s 新鲜度 + mtime/size 复用 + 增量续读）。 */
function getEntry(file, now) {
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return null; }
  const entry = cache.get(file);
  if (entry) {
    if (now - entry.scannedAt < CACHE_TTL_MS) return entry; // 新鲜度窗口内直接复用
    if (st.mtimeMs === entry.mtimeMs && st.size === entry.bytesRead) {
      entry.scannedAt = now; // 文件没变，直接复用
      return entry;
    }
    const refreshed = refreshEntry(entry, file, st); // 变了：增量续读 / 全量重扫
    if (refreshed) { cache.set(file, refreshed); return refreshed; }
    cache.delete(file);
    return null;
  }
  const built = buildEntry(file, st);
  if (built) {
    cache.set(file, built);
    if (cache.size > MAX_CACHE) cache.clear(); // 简单兜底，防无界增长
  }
  return built;
}

/**
 * 列出某工作区全部子代理会话的流式视图（按 updatedAt 倒序）。
 * @param {object} opts
 * @param {string} opts.dshHome DSH_HOME
 * @param {string} opts.workspace 工作区目录
 * @param {number} [opts.now] 当前时间戳
 * @returns {Array<{sessionId:string,label:string,provider:string,model:string,status:string,lastText:string,reasoningText:string,updatedAt:number}>}
 */
function listSubagentStream({ dshHome, workspace, now = Date.now() }) {
  const items = [];
  try {
    const root = path.join(dshHome, 'sessions', workspaceSessionKey(workspace));
    if (!fs.existsSync(root)) return items;
    for (const dirEntry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      try {
        const file = path.join(root, dirEntry.name, 'session.jsonl.zstd');
        if (!fs.existsSync(file)) continue;
        // 性能：压缩后超大的会话文件（主会话可达数 MB，解压后数十 MB JSON）不可能是子代理
        // （子代理会话通常 KB~MB 级），直接跳过，避免启动/轮询时全量解压阻塞主进程（启动卡顿）。
        // 阈值取 4MB：主会话必然跳过，长任务子代理（几十轮工具调用）几乎不会达到。
        try { if (fs.statSync(file).size > 4 * 1024 * 1024) continue; } catch { continue; }
        const entry = getEntry(file, now);
        if (!entry || !entry.seenSession || !entry.isSubagent) continue; // 只收子代理会话
        const { status } = classifySubagentStatus(entry.records, { now });
        let lastText;
        let reasoningText;
        if (status === 'running') {
          // running：取 chunk 内容/推理增量累计的最近 TEXT_CAP 字符
          lastText = entry.text.slice(-TEXT_CAP);
          reasoningText = entry.reasoning.slice(-TEXT_CAP);
        } else {
          // 已结束：最近一次 assistant/message 的完整文本（无则回退累计）
          lastText = entry.lastMessageText || entry.text.slice(-TEXT_CAP);
          reasoningText = entry.lastMessageReasoning || entry.reasoning.slice(-TEXT_CAP);
        }
        const desc = entry.descriptor || {};
        items.push({
          sessionId: entry.sessionId || dirEntry.name,
          parentSession: entry.parentSession || null,
          label: desc.label || entry.title || entry.sessionId || dirEntry.name,
          provider: entry.provider || desc.provider || '?',
          model: entry.model || desc.agentModel || '?',
          status,
          lastText,
          reasoningText,
          updatedAt: entry.updatedAt || 0,
        });
      } catch { /* 单会话异常不影响整体 */ }
    }
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch { /* 整体异常返回空数组 */ }
  return items;
}

/**
 * 自 sinceSeq 之后的流式增量（text/reasoning 各拼接返回）。
 * @param {object} opts
 * @param {string} opts.dshHome DSH_HOME
 * @param {string} opts.workspace 工作区目录
 * @param {string} opts.sessionId 会话 id（目录名）
 * @param {number} [opts.sinceSeq] 上次返回的 seq 游标；0 表示从头
 * @returns {{ok:boolean,seq:number,text:string,reasoning:string,done:boolean,error?:string}}
 *   seq：当前游标（最大事件 seq）；done：是否已出现 turn/end；
 *   无该会话 → { ok:false, error:'not found' }
 */
function streamSince({ dshHome, workspace, sessionId, sinceSeq }) {
  try {
    if (!sessionId || typeof sessionId !== 'string') return { ok: false, error: 'not found' };
    const file = path.join(dshHome, 'sessions', workspaceSessionKey(workspace), sessionId, 'session.jsonl.zstd');
    if (!fs.existsSync(file)) return { ok: false, error: 'not found' };
    let entry = getEntry(file, Date.now());
    if (!entry || !entry.seenSession) return { ok: false, error: 'not found' };
    const since = typeof sinceSeq === 'number' && Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
    let deltas = entry.deltas;
    if (deltas.length && since < entry.deltasStartSeq) {
      // 游标落后于增量保留区（长会话增量被裁剪）→ 全量重扫补齐
      try {
        const st = fs.statSync(file);
        const fresh = buildEntry(file, st);
        if (fresh) { cache.set(file, fresh); entry = fresh; deltas = fresh.deltas; }
      } catch { /* 重扫失败则按现有缓存返回 */ }
    }
    let text = '';
    let reasoning = '';
    for (const d of deltas) {
      if (d.seq <= since) continue;
      if (d.kind === 'text') text += d.value;
      else reasoning += d.value;
    }
    return { ok: true, seq: entry.seq, text, reasoning, done: entry.hasTurnEnd };
  } catch {
    return { ok: false, error: 'read failed' };
  }
}

module.exports = { listSubagentStream, streamSince };
