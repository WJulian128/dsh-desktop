'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runScanTask } = require('./notify');
const { workspaceSessionKey } = require('./usage');

/**
 * 长会话文件归档/截断：
 *  - 目标：防止单会话文件无限增长（超大文件拖慢启动扫描 / notify / memory 尾部判定）；
 *  - 安全条件（全部满足才截断）：
 *      1. 文件 > ARCHIVE_MIN_BYTES（16MB，正常会话几乎达不到）；
 *      2. 文件 1 小时内无写入（非活动，harness 不会在读）；
 *      3. 会话已含 compaction/summary 摘要（早期内容已被语义化，删原始帧安全）——
 *         无摘要的会话不截断（早期内容没有语义保留，风险高）；
 *  - 截断动作在 scan worker 线程执行：保留全部元数据帧 + 摘要 + 最后 KEEP_FRAMES 条对话帧，
 *    其余帧字节整体搬入同目录备份文件 session.jsonl.zstd.archived-<ts>（harness 不读该文件，
 *    可手工恢复），主文件原子替换；
 *  - 备份保留 BACKUP_RETENTION_MS（7 天），到期自动清理，避免磁盘翻倍。
 */

/** 会话文件达到此尺寸才考虑截断。 */
const ARCHIVE_MIN_BYTES = 16 * 1024 * 1024;
/** 文件此时间内无写入视为"活动"，跳过（harness 正在读写的会话绝不动）。 */
const ARCHIVE_MIN_AGE_MS = 60 * 60 * 1000;
/** 主文件保留的最后对话帧数（含全部非对话帧：session/title/compaction/summary/descriptor…）。 */
const KEEP_FRAMES = 2000;
/** 备份文件保留时长，到期自动删除。 */
const BACKUP_RETENTION_MS = 7 * 24 * 3600 * 1000;
/** 单次扫描最多截断的会话数（防御性上限）。 */
const MAX_ARCHIVE_PER_RUN = 5;

/** 列出当前工作区下满足截断条件的候选会话（纯函数，便于测试）。
 *  返回 [{ file, mtimeMs, size }]，按 mtime 升序（最久未动优先）。 */
function scanArchiveCandidates(sessionsRoot, { minBytes = ARCHIVE_MIN_BYTES, minAgeMs = ARCHIVE_MIN_AGE_MS, now = Date.now(), max = MAX_ARCHIVE_PER_RUN } = {}) {
  const out = [];
  if (!fs.existsSync(sessionsRoot)) return out;
  let entries;
  try { entries = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return out; }
  for (const ws of entries) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(sessionsRoot, ws.name);
    let sess;
    try { sess = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of sess) {
      if (!s.isDirectory()) continue;
      const file = path.join(wsDir, s.name, 'session.jsonl.zstd');
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size < minBytes) continue;               // 不够大，不动
      if (now - st.mtimeMs < minAgeMs) continue;      // 近期有写入（活动），不动
      if (file.includes('.archived-') || file.includes('.tmp-')) continue;
      out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out.slice(0, max);
}

/** 清理过期的归档备份文件（session.jsonl.zstd.archived-*），纯函数便于测试。
 *  返回清理掉的文件路径数组。 */
function cleanupOldBackups(sessionsRoot, { retentionMs = BACKUP_RETENTION_MS, now = Date.now() } = {}) {
  const removed = [];
  if (!fs.existsSync(sessionsRoot)) return removed;
  let entries;
  try { entries = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return removed; }
  for (const ws of entries) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(sessionsRoot, ws.name);
    let sess;
    try { sess = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const s of sess) {
      if (!s.isDirectory()) continue;
      const dir = path.join(wsDir, s.name);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('session.jsonl.zstd.archived-')) continue;
        const fp = path.join(dir, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (now - st.mtimeMs > retentionMs) {
          try { fs.unlinkSync(fp); removed.push(fp); } catch { /* 删除失败忽略 */ }
        }
      }
    }
  }
  return removed;
}

/**
 * 执行一轮长会话归档（启动后延迟 + 每日一次）。全部经 scan worker（重活不进主进程），
 * worker 不可用时静默跳过（归档非关键功能，绝不阻塞主流程）。
 * @param {object} opts
 * @param {string} opts.dshHome DSH_HOME
 * @param {string} opts.workspace 当前工作区（实时传入，支持切换）
 * @param {(text: string) => void} [opts.log]
 * @param {Function} [opts.runTask] 任务执行器（默认 runScanTask；测试可注入）
 * @returns {Promise<Array<object>>} 每候选的处理结果（成功/跳过/失败）
 */
async function archiveLargeSessions({ dshHome, workspace, log = () => {}, runTask = runScanTask }) {
  const results = [];
  try {
    const sessionsRoot = path.join(dshHome, 'sessions', workspaceSessionKey(workspace || ''));
    if (!fs.existsSync(sessionsRoot)) return results;
    const removed = cleanupOldBackups(sessionsRoot);
    if (removed.length) log('[archive] 清理过期归档备份 ' + removed.length + ' 个');
    const candidates = scanArchiveCandidates(sessionsRoot);
    if (!candidates.length) return results;
    for (const c of candidates) {
      try {
        const res = await runTask('archive-session', { file: c.file, keepFrames: KEEP_FRAMES }, () => ({ skipped: 'worker-unavailable' }), log);
        results.push({ file: c.file, ...res });
        if (res && res.ok) {
          log('[archive] 截断 ' + c.file + '：移除 ' + (res.removedBytes / 1024 / 1024).toFixed(1) + 'MB，保留 ' + res.keptRecords + ' 帧，备份 ' + path.basename(res.backupFile));
        } else if (res && res.skipped) {
          log('[archive] 跳过 ' + c.file + '（' + res.skipped + '）');
        } else {
          log('[archive] ' + c.file + ' 无结果');
        }
      } catch (err) {
        log('[archive] 截断失败 ' + c.file + '：' + (err && err.message ? err.message : err));
        results.push({ file: c.file, error: (err && err.message) || String(err) });
      }
    }
  } catch (err) {
    log('[archive] 归档扫描失败：' + (err && err.message ? err.message : err));
  }
  return results;
}

module.exports = { archiveLargeSessions, scanArchiveCandidates, cleanupOldBackups, ARCHIVE_MIN_BYTES, KEEP_FRAMES };
