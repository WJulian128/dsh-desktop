// 长会话归档/截断单测（纯 Node，不依赖 Electron）：
//  1. scanArchiveCandidates：尺寸/活跃度筛选
//  2. cleanupOldBackups：过期备份清理
//  3. archiveSessionFile（scan-worker 任务）：保留元数据+摘要+最后 N 帧，备份与原子替换
// 用法：node scripts\test-session-archive.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { decompressFrames } = require('../main/usage');
const { scanArchiveCandidates, cleanupOldBackups } = require('../main/session-archive');
const { archiveSessionFile } = require('../main/scan-worker');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

/** 逐行一帧（与 harness 物理格式一致） */
function enc(records) {
  return Buffer.concat(records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))));
}
const frame = (type, time, extra) => ({ type, time, data: { content: [{ type: 'text', text: 'x'.repeat(8) }] }, ...extra });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-archive-'));

// 1. 候选筛选（sessionsRoot = sessions 根，含工作区目录层级）
const sessionsRoot = path.join(root, 'sessions');
const dirBig = path.join(sessionsRoot, '--ws--', 'sess-big');
const dirSmall = path.join(sessionsRoot, '--ws--', 'sess-small');
const dirActive = path.join(sessionsRoot, '--ws--', 'sess-active');
for (const d of [dirBig, dirSmall, dirActive]) fs.mkdirSync(d, { recursive: true });
const bigFile = path.join(dirBig, 'session.jsonl.zstd');
const smallFile = path.join(dirSmall, 'session.jsonl.zstd');
const activeFile = path.join(dirActive, 'session.jsonl.zstd');
fs.writeFileSync(bigFile, Buffer.alloc(20 * 1024 * 1024, 1));   // 20MB（>16MB）
fs.writeFileSync(smallFile, Buffer.alloc(1024, 1));             // 1KB
fs.writeFileSync(activeFile, Buffer.alloc(20 * 1024 * 1024, 1)); // 20MB 但新写入
const now = Date.now();
const old = now - 2 * 60 * 60 * 1000; // 2 小时前
const fresh = now - 10 * 60 * 1000;   // 10 分钟前
fs.utimesSync(bigFile, old / 1000, old / 1000);
fs.utimesSync(smallFile, old / 1000, old / 1000);
fs.utimesSync(activeFile, fresh / 1000, fresh / 1000);
const cands = scanArchiveCandidates(sessionsRoot, { now });
check('candidates only big+idle', cands.length === 1 && cands[0].file === bigFile, JSON.stringify(cands.map((c) => path.basename(path.dirname(c.file)))));
// 备份文件不应成为候选
const backupFile = path.join(dirBig, 'session.jsonl.zstd.archived-20260101000000');
fs.writeFileSync(backupFile, Buffer.alloc(20 * 1024 * 1024, 1));
fs.utimesSync(backupFile, old / 1000, old / 1000);
const cands2 = scanArchiveCandidates(sessionsRoot, { now });
check('backup file not a candidate', cands2.length === 1, JSON.stringify(cands2.map((c) => c.file)));
fs.unlinkSync(backupFile);

// 2. 备份清理
const keepBackup = path.join(dirBig, 'session.jsonl.zstd.archived-20260824000000');
const staleBackup = path.join(dirBig, 'session.jsonl.zstd.archived-20200101000000');
fs.writeFileSync(keepBackup, 'x');
fs.writeFileSync(staleBackup, 'x');
const tOld = now / 1000 - 30 * 24 * 3600; // 30 天前
fs.utimesSync(staleBackup, tOld, tOld);
const removed = cleanupOldBackups(sessionsRoot, { now });
check('cleanup removes only stale backups', removed.length === 1 && removed[0] === staleBackup, JSON.stringify(removed));
check('fresh backup kept', fs.existsSync(keepBackup), '');
fs.unlinkSync(keepBackup);

// 3. archiveSessionFile：含 compaction 的会话 → 截断
const sessDir = path.join(sessionsRoot, '--ws--', 'sess-arch');
fs.mkdirSync(sessDir, { recursive: true });
const sessFile = path.join(sessDir, 'session.jsonl.zstd');
const records = [
  { type: 'session', id: 'arch-1', createdAt: 1 },
  frame('user/message', 1), frame('assistant/message', 2),
  frame('user/message', 3), frame('assistant/message', 4),
  { type: 'compaction/summary', seq: 1, time: 5, data: { summary: '早期内容摘要' } },
  frame('user/message', 6), frame('assistant/message', 7),
  frame('user/message', 8), frame('assistant/message', 9),
];
fs.writeFileSync(sessFile, enc(records));
const res = archiveSessionFile(sessFile, 4); // 保留最后 4 条对话帧
check('archive ok with backup', res && res.ok === true && fs.existsSync(res.backupFile), JSON.stringify(res));
if (res && res.ok) {
const keptText = decompressFrames(fs.readFileSync(sessFile));
const keptRecords = keptText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const keptTypes = keptRecords.map((r) => r.type);
check('keeps compaction summary', keptTypes.includes('compaction/summary'), keptTypes.join(','));
check('keeps session frame', keptTypes.filter((t) => t === 'session').length === 1, keptTypes.join(','));
check('keeps last 4 conversation frames', keptTypes.filter((t) => t === 'user/message' || t === 'assistant/message').length === 4, keptTypes.join(','));
check('drops oldest conversation frames', !keptText.includes('"time":1') && !keptText.includes('"time":2') && !keptText.includes('"time":3'), '');
check('newest frames present', keptText.includes('"time":8') && keptText.includes('"time":9'), '');
check('backup has full original size', fs.statSync(res.backupFile).size > fs.statSync(sessFile).size, '');
fs.rmSync(res.backupFile);
} // end if (res && res.ok)

// 4. 无 compaction → 跳过
const noCompDir = path.join(sessionsRoot, '--ws--', 'sess-nocomp');
fs.mkdirSync(noCompDir, { recursive: true });
const noCompFile = path.join(noCompDir, 'session.jsonl.zstd');
fs.writeFileSync(noCompFile, enc([
  { type: 'session', id: 'nc', createdAt: 1 },
  frame('user/message', 1), frame('assistant/message', 2),
]));
const res2 = archiveSessionFile(noCompFile, 4);
check('no compaction -> skipped, file untouched', res2 && res2.skipped === 'no-compaction' && fs.existsSync(noCompFile), JSON.stringify(res2));
check('no backup created for skipped', fs.readdirSync(noCompDir).filter((f) => f.includes('.archived-')).length === 0, '');

// 5. 小 keepFrames：只保留最后 1 条对话帧 + 元数据
const sessDir2 = path.join(sessionsRoot, '--ws--', 'sess-arch2');
fs.mkdirSync(sessDir2, { recursive: true });
const sessFile2 = path.join(sessDir2, 'session.jsonl.zstd');
fs.writeFileSync(sessFile2, enc([
  { type: 'session', id: 'a2', createdAt: 1 },
  frame('user/message', 1), frame('assistant/message', 2),
  { type: 'compaction/summary', seq: 1, time: 3 },
  frame('user/message', 4), frame('assistant/message', 5),
  frame('user/message', 6), frame('assistant/message', 7),
]));
const res3 = archiveSessionFile(sessFile2, 1);
const kept2 = decompressFrames(fs.readFileSync(sessFile2));
check('keepFrames=1 keeps single newest frame', kept2.includes('"time":7') && !kept2.includes('"time":6') && !kept2.includes('"time":5'), kept2.split('\n').map((l) => { try { return JSON.parse(l).type; } catch { return '?'; } }).join(','));
fs.rmSync(res3.backupFile);

fs.rmSync(root, { recursive: true, force: true });
if (failures.length) { console.log('SESSION-ARCHIVE FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('SESSION-ARCHIVE OK');
