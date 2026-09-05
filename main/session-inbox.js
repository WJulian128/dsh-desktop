'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * 跨会话消息收件箱（P0-1，Claude Code 借鉴）：
 * 会话 A 的 agent 可用工具给会话 B 发消息，B 侧在 EnvPanel 顶部看到
 * "来自会话 X"折叠卡片（展开才入上下文）。存储独立于官方会话文件：
 *
 *   <root>/session-inbox/<toSessionId>.jsonl
 *
 * 每行一条 JSON 消息：{ id, time, from, fromTitle, text, read }。
 * 消息只做外部通知卡片展示，绝不注入官方对话历史；标记已读只改 read 字段。
 * 全部纯 Node 逻辑、无 Electron 依赖，可单测（scripts/test-session-inbox.js）。
 *
 * 安全：to/from 会话 id 只接受 [A-Za-z0-9_-]（防路径穿越——id 出现在文件路径与
 * JSONL 内容里）。文件按箱修剪，保留最近 MAX_ITEMS_PER_BOX 条。
 */

const MAX_ITEMS_PER_BOX = 200;      // 每箱保留上限（超出丢最旧）
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 单箱超过 4MB 视为异常，拒绝追加（防失控）

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 会话 id 合法性校验（false = 拒绝，防路径穿越/脏内容）。 */
function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && id.length <= 128;
}

function inboxRoot(root) {
  return path.join(root, 'session-inbox');
}

function boxPath(root, sessionId) {
  return path.join(inboxRoot(root), sessionId + '.jsonl');
}

/** 读箱内全部消息（旧→新）；损坏行跳过，返回 [消息]。 */
function readMessages(root, sessionId) {
  const file = boxPath(root, sessionId);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const items = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (m && typeof m.id === 'string' && typeof m.text === 'string') {
        items.push({
          id: m.id,
          time: typeof m.time === 'number' ? m.time : 0,
          from: typeof m.from === 'string' ? m.from : '',
          fromTitle: typeof m.fromTitle === 'string' ? m.fromTitle : '',
          text: m.text,
          read: m.read === true,
        });
      }
    } catch { /* 损坏行跳过 */ }
  }
  return items;
}

/** 原子写回（临时文件 + rename）。 */
function writeMessages(root, sessionId, items) {
  fs.mkdirSync(inboxRoot(root), { recursive: true });
  const file = boxPath(root, sessionId);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, items.map((m) => JSON.stringify(m)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 给某会话投递一条消息（append-only 语义：读改写落盘，天然并发安全下限；
 * 桌面端单主进程串行写，冲突面不存在）。返回 { ok, message } 或 { ok:false, error }。
 * @param {string} root 收件箱根目录（userData 目录）
 * @param {string} toSessionId 目标会话
 * @param {object} msg { from, fromTitle?, text }
 */
function appendMessage(root, toSessionId, msg) {
  if (!isValidSessionId(toSessionId)) return { ok: false, error: '目标会话 id 非法' };
  const from = String((msg && msg.from) || '');
  if (!isValidSessionId(from)) return { ok: false, error: '来源会话 id 非法' };
  const text = String((msg && msg.text) || '');
  if (!text.trim()) return { ok: false, error: '消息内容为空' };
  if (text.length > 4000) return { ok: false, error: '消息过长（上限 4000 字符）' };
  const file = boxPath(root, toSessionId);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) {
      return { ok: false, error: '收件箱异常过大，已拒绝投递（可手动清理该箱）' };
    }
    const message = {
      id: 'm' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      time: Date.now(),
      from,
      fromTitle: typeof (msg && msg.fromTitle) === 'string' ? String(msg.fromTitle).slice(0, 80) : '',
      text: text.slice(0, 4000),
      read: false,
    };
    const items = readMessages(root, toSessionId);
    items.push(message);
    const pruned = items.length > MAX_ITEMS_PER_BOX ? items.slice(items.length - MAX_ITEMS_PER_BOX) : items;
    writeMessages(root, toSessionId, pruned);
    return { ok: true, message };
  } catch (err) {
    return { ok: false, error: '写入收件箱失败：' + ((err && err.message) || String(err)) };
  }
}

/**
 * 列消息（默认只列未读；read=true 时含已读，取最近 limit 条）。返回
 * { items（新→旧）, unread }；解析/读取失败返回 { ok:false, error }。
 */
function listMessages(root, sessionId, opts = {}) {
  if (!isValidSessionId(sessionId)) return { ok: false, error: '会话 id 非法' };
  const items = readMessages(root, sessionId);
  const reversed = items.slice().reverse();
  const unread = reversed.filter((m) => !m.read);
  const show = opts.includeRead ? reversed.slice(0, opts.limit || 20) : unread;
  return { ok: true, items: show, unread: unread.length };
}

/** 未读数（0 起）。 */
function unreadCount(root, sessionId) {
  const r = listMessages(root, sessionId);
  return r.ok ? r.unread : 0;
}

/**
 * 标记已读。ids 缺省/空数组 = 全部标记。
 * @param {string} root
 * @param {string} sessionId
 * @param {string[]} [ids] 只标这些消息（不存在的 id 忽略）
 */
function markRead(root, sessionId, ids) {
  if (!isValidSessionId(sessionId)) return { ok: false, error: '会话 id 非法' };
  const idSet = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const items = readMessages(root, sessionId);
  let changed = 0;
  for (const m of items) {
    if (!m.read && (!idSet || idSet.has(m.id))) { m.read = true; changed += 1; }
  }
  if (changed) {
    try { writeMessages(root, sessionId, items); } catch (err) {
      return { ok: false, error: '写回收件箱失败：' + ((err && err.message) || String(err)) };
    }
  }
  return { ok: true, marked: changed };
}

module.exports = {
  MAX_ITEMS_PER_BOX,
  isValidSessionId,
  appendMessage,
  listMessages,
  unreadCount,
  markRead,
};
