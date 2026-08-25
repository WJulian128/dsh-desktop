'use strict';
/**
 * 回复桥：把外部消息注入 harness 当前会话 → 轮询该会话文件等本轮回复完成 → 提取回复文本回推。
 * 完成判定复用 notify 的语义：最后一条 assistant/message 后跟回合结束帧（step/end 主会话 / turn/end 子代理）。
 * 纯 Node 可测：文件系统与计时器注入。
 */
const fs = require('node:fs');
const path = require('node:path');
const { decompressFrames } = require('../usage');
const { isSubagentSessionFile } = require('../notify');

const CONVERSATION_TYPES = new Set([
  'user/message', 'assistant/message', 'assistant/chunk', 'tool/call', 'tool/result', 'tool-call-chunks',
]);

/** 提取 assistant/message 的文本（content 数组逐块拼接，兼容 text 字段）。 */
function messageText(r) {
  try {
    const m = r.data && r.data.message;
    const c = m && m.content;
    if (Array.isArray(c)) return c.map((x) => (x && x.text) || '').join('').trim();
    return String((m && m.text) || '').trim();
  } catch { return ''; }
}

/**
 * 从解压后的会话文本里找注入时间之后的最新最终回复（纯函数，便于测试）。
 * 从尾向前找第一条对话记录：
 *  - assistant/message 且文本非空且 time > afterTs 且其后（向尾部方向）出现过回合结束帧 → { text, done:true, ts }
 *  - assistant/message 但无结束帧 → { done:false }（回复还在生成/工具往返中）
 *  - 其它（tool/chunk/无记录）→ { done:false }
 * @param {string} sessionText 解压后的 JSONL 文本
 * @param {number} afterTs 注入时间戳（ms）
 */
function extractReplyAfter(sessionText, afterTs) {
  const records = [];
  for (const rawLine of String(sessionText || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.type === 'string') records.push(r);
    } catch { /* 跳过坏行 */ }
  }
  let sawEnd = false;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    const type = r.type;
    if (type === 'step/end' || type === 'turn/end') { sawEnd = true; continue; }
    if (!CONVERSATION_TYPES.has(type)) continue;
    if (type === 'assistant/message') {
      const ts = typeof r.time === 'number' ? r.time : 0;
      if (!sawEnd || ts <= afterTs) return { done: false };
      const text = messageText(r);
      if (!text) return { done: false };
      return { done: true, text, ts };
    }
    return { done: false };
  }
  return { done: false };
}

/** 在 sessionsRoot 下按 sessionId 定位会话文件（遍历工作区目录）。 */
function findSessionFile(sessionsRoot, sessionId) {
  try {
    const wsEntries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    for (const ws of wsEntries) {
      if (!ws.isDirectory()) continue;
      const file = path.join(sessionsRoot, ws.name, String(sessionId), 'session.jsonl.zstd');
      if (fs.existsSync(file)) return file;
    }
  } catch { /* 忽略 */ }
  return null;
}

/**
 * 回复桥。
 * @param {object} opts
 * @param {string} opts.sessionsRoot $DSH_HOME/sessions
 * @param {(text:string)=>Promise<boolean>} opts.injectPrompt 注入用户消息（成功返回 true）
 * @param {(text:string)=>void} [opts.log]
 * @param {number} [opts.pollMs] 轮询间隔（默认 2500ms）
 * @param {number} [opts.timeoutMs] 等回复超时（默认 15 分钟，agent 长任务）
 * @param {() => string|null} [opts.getSessionId] 当前会话 id（注入成功后由调用方解析）
 */
class ReplyBridge {
  constructor(opts) {
    this.sessionsRoot = opts.sessionsRoot;
    this.injectPrompt = opts.injectPrompt;
    this.getSessionId = opts.getSessionId || (() => null);
    this.log = opts.log || (() => {});
    this.pollMs = opts.pollMs || 2500;
    this.timeoutMs = opts.timeoutMs || 15 * 60 * 1000;
    this.queue = Promise.resolve(); // 串行队列：同一会话多轮回复按顺序处理，避免错位
  }

  /**
   * 注入并等本轮回复完成。返回回复文本；失败/超时返回 null。
   * 串行化：同一时刻只处理一条（新消息排队），避免"两条注入一个回复"错位。
   */
  process(text) {
    const run = () => this.processInner(text);
    const next = this.queue.then(run, run);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async processInner(text) {
    const afterTs = Date.now();
    const ok = await this.injectPrompt(text);
    if (!ok) {
      this.log('[bot-bridge] 注入失败：' + String(text).slice(0, 80));
      return null;
    }
    // 注入成功后拿会话 id（rpcPromptCurrentSession 内部已定位当前会话）
    const sessionId = this.getSessionId();
    const file = sessionId ? findSessionFile(this.sessionsRoot, sessionId) : null;
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      if (!file) return null; // 定位不到会话文件：无法确认回复
      if (isSubagentSessionFile(file)) { // 理论不发生（注入的是主会话），防御
        this.log('[bot-bridge] 会话文件被识别为子代理，跳过');
        return null;
      }
      try {
        const sessionText = decompressFrames(fs.readFileSync(file));
        const r = extractReplyAfter(sessionText, afterTs);
        if (r.done) return r.text;
      } catch (err) {
        this.log('[bot-bridge] 读取会话失败：' + (err && err.message ? err.message : err));
      }
    }
    this.log('[bot-bridge] 等待回复超时（' + Math.round(this.timeoutMs / 1000) + 's）');
    return null;
  }
}

module.exports = { ReplyBridge, extractReplyAfter, findSessionFile, messageText };
