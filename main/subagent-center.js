'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { decompressFrames, workspaceSessionKey } = require('./usage');
const { classifyLastRecord } = require('./notify');

/**
 * 子代理中心：扫描 $DSH_HOME/sessions/<workspace-key>/ 下所有会话，筛选出
 * origin === 'subagent' 的子代理会话，聚合展示其进度/状态/耗时/token。
 *
 * 纯文件读取（与用量统计同机制），不依赖 harness 内部接口：
 *  - 子代理会话的 session 记录带 origin:'subagent'、parentSession、delegationDepth；
 *  - subagent/descriptor 记录带 label/mode/provider/agentModel；
 *  - 状态用会话尾部判定：尾部为最终答复（assistant/message）且存在 turn/end → done；
 *    尾部为工具往返/流式块 → running；无对话记录 → empty；
 *    既非 done 又长时间无写入 → stopped（可能失败或被终止，无法从文件精确区分）。
 */

/** 判定子代理状态（纯函数，便于测试）。 */
function classifySubagentStatus(records, { now = Date.now(), stoppedAfterMs = 10 * 60 * 1000 } = {}) {
  const last = classifyLastRecord(records);
  let hasTurnEnd = false;
  let lastTime = 0;
  for (const r of records) {
    if (r && r.type === 'turn/end' && typeof r.time === 'number') hasTurnEnd = true;
    if (r && typeof r.time === 'number' && r.time > lastTime) lastTime = r.time;
  }
  if (last === 'round-done' && hasTurnEnd) return { status: 'done', lastTime };
  if (last === 'user-pending' || last === 'empty') return { status: 'empty', lastTime };
  if (lastTime > 0 && now - lastTime > stoppedAfterMs) return { status: 'stopped', lastTime };
  return { status: 'running', lastTime };
}

/**
 * 解析单个子代理会话文件，返回展示所需字段（解析失败返回 null）。
 * @param {string} file session.jsonl.zstd 路径
 * @param {number} [now] 当前时间戳
 */
function scanSubagentFile(file, now = Date.now()) {
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return null; }
  let text;
  try { text = decompressFrames(buffer); } catch { return null; }
  const records = [];
  let session = null;
  let descriptor = null;
  let title = null;
  let createdAt = null;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.type !== 'string') continue;
    records.push(r);
    if (r.type === 'session' && !session) session = r;
    else if (r.type === 'subagent/descriptor' && !descriptor) descriptor = r;
    else if (r.type === 'session/title' && r.data && typeof r.data.title === 'string' && r.data.title && !title) title = r.data.title;
    if (r.type === 'session' && typeof r.createdAt === 'number' && !createdAt) createdAt = r.createdAt;
    if (r.type === 'assistant/chunk' && r.data && r.data.chunk && r.data.chunk.type === 'usage' && r.data.chunk.usage) {
      const u = r.data.chunk.usage;
      usage.inputTokens += typeof u.inputTokens === 'number' ? u.inputTokens : 0;
      usage.outputTokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0;
      usage.cacheReadTokens += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0;
      usage.reasoningTokens += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0;
    }
  }
  if (!session || session.origin !== 'subagent') return null; // 只收子代理会话
  const { status, lastTime } = classifySubagentStatus(records, { now });
  const desc = descriptor && descriptor.data ? descriptor.data : {};
  return {
    sessionId: session.id || path.basename(path.dirname(file)),
    label: desc.label || title || session.id,
    title: title || null,
    mode: desc.mode || 'one-shot',
    provider: desc.provider || '?',
    agentModel: desc.agentModel || '?',
    parentSession: session.parentSession || null,
    delegationDepth: typeof session.delegationDepth === 'number' ? session.delegationDepth : 1,
    agentPreset: session.agentPreset || null,
    createdAt: createdAt || (records[0] && records[0].time) || null,
    lastTime,
    status,
    durationMs: lastTime && createdAt ? Math.max(0, lastTime - createdAt) : 0,
    usage,
  };
}

/**
 * 扫描某工作区的全部子代理会话（按最后活动倒序）。
 * @param {object} opts
 * @param {string} opts.dshHome DSH_HOME
 * @param {string} opts.workspace 工作区
 * @param {number} [opts.now]
 * @param {number} [opts.limit] 最多返回条数（默认 50）
 */
function scanSubagents({ dshHome, workspace, now = Date.now(), limit = 50 }) {
  const root = path.join(dshHome, 'sessions', workspaceSessionKey(workspace));
  const items = [];
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'session.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const item = scanSubagentFile(file, now);
      if (item) items.push(item);
    }
  }
  items.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  return items.slice(0, limit);
}

/** 把父会话 id 映射为标题（一次扫描所有会话的 session/title）。 */
function parentTitleMap({ dshHome, workspace }) {
  const map = {};
  const root = path.join(dshHome, 'sessions', workspaceSessionKey(workspace));
  if (!fs.existsSync(root)) return map;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'session.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    try {
      const text = decompressFrames(fs.readFileSync(file));
      let id = null;
      let title = null;
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r && r.type === 'session' && typeof r.id === 'string' && !id) id = r.id;
          if (r && r.type === 'session/title' && r.data && typeof r.data.title === 'string' && r.data.title && !title) title = r.data.title;
        } catch { /* 跳过坏行 */ }
        if (id && title) break;
      }
      if (id && title) map[id] = title;
    } catch { /* 单个会话读取失败不影响整体 */ }
  }
  return map;
}

/** 汇总统计。 */
function summarize(items) {
  const counts = { running: 0, done: 0, stopped: 0, empty: 0 };
  let totalTokens = 0;
  for (const it of items || []) {
    counts[it.status] = (counts[it.status] || 0) + 1;
    totalTokens += it.usage.inputTokens + it.usage.outputTokens + it.usage.cacheReadTokens;
  }
  return { ...counts, total: (items || []).length, totalTokens };
}

module.exports = { scanSubagents, scanSubagentFile, classifySubagentStatus, parentTitleMap, summarize };
