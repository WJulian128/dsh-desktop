'use strict';
/**
 * 会话 transcript 内容检查（纯 Node，无 Electron 依赖）：
 * 判断最新会话的用户消息/inbox 中是否包含指定文本——用于自动接续的去重与发送确认。
 * 只查 user/message 与 agent/inbox/spliced 的内容，绝不匹配 tool/call 参数里的同文本
 * （restartApp 的 task 参数本身就会出现在工具调用记录里，会误判"已在队列"）。
 * 性能关键：默认尾帧快检（只解压尾部 ≤256KB 的最后若干帧），full=true 时才对
 * ≤16MB 的会话文件全量解压（跨重启去重用）；本模块供 worker 线程调用，主线程不直接
 * 做全量解压（避免启动卡顿）。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { decompressFrames, workspaceSessionKey } = require('./usage');

/** 尾帧精确检查：只解压文件尾部 tailBytes 内的最后 maxFrames 个 zstd 帧，
 *  逐条解析 user/message 与 agent/inbox/spliced 是否包含 mark（与全量检查同语义）。 */
function tailFramesContainsMark(file, mark, tailBytes = 256 * 1024, maxFrames = 24) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - tailBytes);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const magic = [0x28, 0xb5, 0x2f, 0xfd];
    const positions = [];
    for (let i = buf.length - 4; i >= 0; i--) {
      if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
        positions.push(i);
        if (positions.length >= maxFrames) break;
      }
    }
    for (const pos of positions) {
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(pos)).toString('utf8');
        const r = JSON.parse(out);
        if (!r || !r.data) continue;
        if (r.type === 'user/message') {
          if (JSON.stringify(r.data.content || r.data.message || '').includes(mark)) return true;
        } else if (r.type === 'agent/inbox/spliced') {
          const inserted = r.data.inserted;
          if (Array.isArray(inserted) && JSON.stringify(inserted).includes(mark)) return true;
        }
      } catch { /* 尾部可能含未写完的帧，跳过 */ }
    }
    return false;
  } catch { return false; }
}

/** 全量扫描单个文件（≤16MB 压缩文件）。 */
function scanFileFull(file, mark) {
  const text = decompressFrames(fs.readFileSync(file));
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.data) continue;
    if (r.type === 'user/message') {
      if (JSON.stringify(r.data.content || r.data.message || '').includes(mark)) return true;
    } else if (r.type === 'agent/inbox/spliced') {
      const inserted = r.data.inserted;
      if (Array.isArray(inserted) && JSON.stringify(inserted).includes(mark)) return true;
    }
  }
  return false;
}

/**
 * 最新会话 transcript 是否包含 mark。
 * @param {object} opts { dshHome, workspace, mark, full }
 * @param {boolean} [opts.full] true 时对 ≤16MB 文件全量解压扫描（跨重启去重），否则尾帧快检
 * @returns {boolean}
 */
function sessionContainsText({ dshHome, workspace, mark, full = false }) {
  try {
    if (!mark || typeof mark !== 'string' || !mark) return false;
    const root = path.join(dshHome, 'sessions', workspaceSessionKey(workspace));
    if (!fs.existsSync(root)) return false;
    const files = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'session.jsonl.zstd');
      let m = 0;
      try { m = fs.statSync(file).mtimeMs; } catch { continue; }
      files.push({ file, mtimeMs: m });
    }
    if (!files.length) return false;
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!full) {
      // 快检：只查最新会话（发送确认用；刚发送的会话文件 mtime 必然最新）。
      const best = files[0];
      try {
        if (fs.statSync(best.file).size > 2 * 1024 * 1024) return tailFramesContainsMark(best.file, mark);
      } catch { return false; }
      return scanFileFull(best.file, mark);
    }
    // 跨重启去重：消息可能落在非最新会话（多会话/子代理并行写入时，
    // 更新的文件常是子代理会话）。按 mtime 从新到旧扫多个会话直到命中。
    // 预算：最多 12 个会话、累计 64MB 压缩数据；>16MB 的文件只做尾帧检查。
    const MAX_SESSIONS = 12;
    const BYTE_BUDGET = 64 * 1024 * 1024;
    let scannedBytes = 0;
    for (const { file } of files.slice(0, MAX_SESSIONS)) {
      let size = 0;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (size > 16 * 1024 * 1024) {
        if (tailFramesContainsMark(file, mark)) return true;
        continue;
      }
      if (scannedBytes + size > BYTE_BUDGET) continue;
      scannedBytes += size;
      if (scanFileFull(file, mark)) return true;
    }
    return false;
  } catch { return false; }
}

module.exports = { sessionContainsText, tailFramesContainsMark };
