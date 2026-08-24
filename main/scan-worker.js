'use strict';
// 扫描 worker（worker_threads）：承担主进程中所有"读会话文件 + zstd 解压 + JSON 解析"的
// 重活（会话文件可达 12MB+），避免阻塞 Electron 主进程 UI。
// 只依赖同目录的纯 Node 模块（usage / memory-store / notify），无任何 Electron 依赖，
// 因此既可在 worker 线程内加载，也可被纯 Node 测试直接 require。
//
// 消息协议（主进程 -> worker）：
//   { id: number, task: 'is-round-done', file: string }
//   { id: number, task: 'extract-conversation', file: string, maxChars: number, fromTime: number, headFirst: boolean }
//   { id: number, task: 'archive-session', file: string, keepFrames: number }
// worker -> 主进程：
//   { type: 'scan-result', id, task, ...结果字段 | error }
//   is-round-done 成功：{ done: boolean|null }（null = 文件过大/读取失败，语义同 notify.isRoundDone）
//   extract-conversation 成功：{ userText, assistantText, lastUserTime, allLatestTime, oldestIncludedTime, coveredAll, userCount }
//   archive-session 成功：{ ok, backupFile, removedBytes, keptRecords } 或 { skipped: 原因 }
//   任何失败统一带 error 字段（字符串）。
//
// 直接以模块方式 require 时（parentPort 为 null），导出两个任务函数供单测使用；
// 以 Worker 方式启动时，父线程的 postMessage 会排队，直到此处挂上监听后逐条处理
// （同一时刻只解压一个文件，天然串行）。
const fs = require('node:fs');
const path = require('node:path');
const { parentPort } = require('node:worker_threads');
const zlib = require('node:zlib');
const { decompressFrames } = require('./usage');
const { extractConversationText } = require('./memory-store');
const { scanRoundDoneFile } = require('./notify');

/** 防御性体积上限：超过即拒绝解压（正常调用方已在主进程限流，这里兜底防 OOM）。 */
const MAX_EXTRACT_BYTES = 64 * 1024 * 1024;
/** 归档任务体积上限（截断正是为处理超大文件，单独放宽）。 */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/** 任务 a：给定会话文件路径，解压后做"整轮完成"尾部判定，返回 boolean|null（复用 notify 语义）。 */
function isRoundDone(file) {
  return scanRoundDoneFile(file);
}

/** 任务 b：给定会话文件路径 + maxChars（+ 增量游标 fromTime / 头部窗口 headFirst），
 *  解压并提取对话文本，返回 extractConversationText 结果。 */
function extractConversation(file, maxChars, fromTime = 0, headFirst = false) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_EXTRACT_BYTES) {
    throw new Error('会话文件过大（' + stat.size + 'B），拒绝解压');
  }
  const text = decompressFrames(fs.readFileSync(file));
  return extractConversationText(text, maxChars, fromTime, headFirst);
}

/** 任务 c：长会话归档截断。只处理"已含 compaction/summary 摘要"的会话（早期内容已被语义化，
 *  删除原始帧安全）；保留全部非对话帧（session/session/title/compaction/summary/subagent/descriptor…）
 *  + 最后 keepFrames 条对话帧，被移除的帧字节整体搬入备份文件，主文件原子替换。
 *  帧字节直接搬运（不重新压缩），零额外压缩开销。返回 { ok, backupFile, removedBytes, keptRecords }
 *  或 { skipped: 'no-compaction' }（无摘要的会话不截断，风险高）。 */
function archiveSessionFile(file, keepFrames = 2000, maxBytes = MAX_ARCHIVE_BYTES) {
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) throw new Error('会话文件过大（' + stat.size + 'B），拒绝归档');
  const buf = fs.readFileSync(file);
  // 逐帧扫描：收集解压成功的帧（记录帧头位置；帧边界=下一成功帧头或文件尾）
  const magic = [0x28, 0xb5, 0x2f, 0xfd];
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] !== magic[0] || buf[i + 1] !== magic[1] || buf[i + 2] !== magic[2] || buf[i + 3] !== magic[3]) continue;
    try {
      const out = zlib.zstdDecompressSync(buf.subarray(i));
      if (out.length > 0 && out[0] === 0x7b) starts.push(i);
    } catch { /* 压缩数据内魔数误报，跳过 */ }
  }
  if (!starts.length) return { skipped: 'no-frames' };
  const frames = starts.map((start, idx) => ({
    start,
    end: idx + 1 < starts.length ? starts[idx + 1] : buf.length,
  }));
  // 解析每帧内容（帧字节是 zstd 压缩的，需解压后再 JSON 解析）
  const parseFrame = (f) => {
    try {
      return JSON.parse(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8').trim());
    } catch { return null; }
  };
  // 分类保留：从尾向前收集最后 keepFrames 条对话帧；非对话帧（元数据/摘要）全保留
  const CONVERSATION_TYPES = new Set(['user/message', 'assistant/message', 'assistant/chunk', 'tool/call', 'tool/result']);
  let hasCompaction = false;
  let convCount = 0;
  const keep = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    const r = parseFrame(f);
    const type = r && typeof r.type === 'string' ? r.type : '';
    if (type === 'compaction/summary') { hasCompaction = true; keep.push(f); continue; }
    if (!type || !CONVERSATION_TYPES.has(type)) { keep.push(f); continue; } // 元数据/未知帧保留
    if (convCount < keepFrames) { convCount += 1; keep.push(f); continue; }
    // 超出保留量的对话帧 → 丢弃（进备份）
  }
  if (!hasCompaction) return { skipped: 'no-compaction' }; // 无摘要不截断
  keep.reverse();
  const keptBytes = Buffer.concat(keep.map((f) => buf.subarray(f.start, f.end)));
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupFile = file + '.archived-' + ts;
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, keptBytes);
  fs.renameSync(file, backupFile); // 原文件先改名为备份（同盘原子）
  try { fs.renameSync(tmp, file); } catch (err) {
    // 替换失败：尽力恢复原文件
    try { fs.renameSync(backupFile, file); } catch { /* 双失败：主文件留在 tmp，日志兜底 */ }
    throw err;
  }
  return { ok: true, backupFile, removedBytes: buf.length - keptBytes.length, keptRecords: keep.length };
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'number' || typeof msg.task !== 'string') return;
    try {
      if (msg.task === 'is-round-done') {
        const done = isRoundDone(msg.file);
        parentPort.postMessage({ type: 'scan-result', id: msg.id, task: msg.task, done });
      } else if (msg.task === 'extract-conversation') {
        const conv = extractConversation(msg.file, msg.maxChars, msg.fromTime || 0, msg.headFirst === true);
        parentPort.postMessage({
          type: 'scan-result',
          id: msg.id,
          task: msg.task,
          userText: conv.userText,
          assistantText: conv.assistantText,
          lastUserTime: conv.lastUserTime,
          allLatestTime: conv.allLatestTime,
          oldestIncludedTime: conv.oldestIncludedTime,
          coveredAll: conv.coveredAll,
          userCount: conv.userCount,
        });
      } else if (msg.task === 'archive-session') {
        const res = archiveSessionFile(msg.file, msg.keepFrames || 2000);
        parentPort.postMessage({ type: 'scan-result', id: msg.id, task: msg.task, ...res });
      } else {
        parentPort.postMessage({ type: 'scan-result', id: msg.id, task: msg.task, error: '未知任务：' + msg.task });
      }
    } catch (err) {
      parentPort.postMessage({ type: 'scan-result', id: msg.id, task: msg.task, error: (err && err.message) || String(err) });
    }
  });
} else {
  // 直接以模块方式加载（测试用）：导出任务函数，绕过消息协议做单测。
  module.exports = { isRoundDone, extractConversation, archiveSessionFile };
}
