// 上下文压力告警单测：
//  - shouldWarn 决策（阈值/跨会话/5% 递进/回落清除）
//  - findActiveSession（选最近写入的会话）
//  - sessionTokens 汇总
//  - listOtherSessions（多会话概览：排除活动/3 天窗口/排序/上限）
//  - 用真实 zstd 会话文件跑一遍 startContextWatcher（onWarning 含 others 概览 / onClear 触发）
// 用法：node scripts\test-context-watch.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { shouldWarn, findActiveSession, sessionTokens, sessionContextTokens, startContextWatcher, listOtherSessions } = require('../main/context-watch');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 1. shouldWarn 纯函数
let d = shouldWarn(null, { sessionId: 's1', tokens: 90000, threshold: 100000 });
check('below threshold: no warn', d.warn === false && d.next === null, JSON.stringify(d));
d = shouldWarn(null, { sessionId: 's1', tokens: 100001, threshold: 100000 });
check('crossing threshold: warn', d.warn === true && d.next.warnedTokens === 100001, JSON.stringify(d));
d = shouldWarn({ warnedSessionId: 's1', warnedTokens: 100001 }, { sessionId: 's1', tokens: 102000, threshold: 100000 });
check('same session small growth: no warn', d.warn === false, '');
d = shouldWarn({ warnedSessionId: 's1', warnedTokens: 100000 }, { sessionId: 's1', tokens: 105000, threshold: 100000 });
check('same session +5% growth: warn again', d.warn === true && d.next.warnedTokens === 105000, '');
d = shouldWarn({ warnedSessionId: 's1', warnedTokens: 105000 }, { sessionId: 's2', tokens: 100001, threshold: 100000 });
check('new session: warn again', d.warn === true, '');
d = shouldWarn({ warnedSessionId: 's1', warnedTokens: 105000 }, { sessionId: 's1', tokens: 50000, threshold: 100000 });
check('compacted below threshold: reset', d.warn === false && d.next === null, '');

// 2. sessionTokens
check('sessionTokens sums', sessionTokens({ inputTokens: 100, cacheReadTokens: 200, outputTokens: 50 }) === 350, '');
check('sessionTokens null', sessionTokens(null) === 0, '');

// 2.1 sessionContextTokens：当前上下文 = 最后一次请求的 inputTokens + cacheReadTokens
check('sessionContextTokens uses lastUsage only',
  sessionContextTokens({ lastUsage: { inputTokens: 500, cacheReadTokens: 1000, outputTokens: 50 } }) === 1500, '');
check('sessionContextTokens ignores cumulative usage',
  sessionContextTokens({ usage: { inputTokens: 6000000, cacheReadTokens: 390000000, outputTokens: 12345 }, lastUsage: { inputTokens: 500, cacheReadTokens: 1000, outputTokens: 50 } }) === 1500, '');
check('sessionContextTokens null', sessionContextTokens(null) === 0, '');
check('sessionContextTokens no lastUsage', sessionContextTokens({ usage: { inputTokens: 1, cacheReadTokens: 2 } }) === 0, '');

// 3. 构造真实会话目录 + zstd 会话文件
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ctx-watch-'));
const sessions = path.join(root, 'sessions', '--ws--');
const oldDir = path.join(sessions, 'session-old');
const newDir = path.join(sessions, 'session-new');
fs.mkdirSync(oldDir, { recursive: true });
fs.mkdirSync(newDir, { recursive: true });

function chunk(usage) {
  return JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, reasoningTokens: 0 } } } });
}
function writeSession(dir, chunks) {
  const frame = zlib.zstdCompressSync(Buffer.from(chunks.join('\n') + '\n', 'utf8'));
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), frame);
}

// 老会话：小体量；新会话：大 - 先写老的后写新的，用 mtime 区分
writeSession(oldDir, [chunk({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 })]);
const oldFile = path.join(oldDir, 'session.jsonl.zstd');
const t0 = Date.now() - 60000;
fs.utimesSync(oldFile, t0 / 1000, t0 / 1000);
// 新会话：当前上下文 52000 + 50000 = 102000 > 阈值 100000 → 告警 ratio 102（旧实现累计 103000 也过阈值，但新实现才是"当前上下文"语义）
writeSession(newDir, [chunk({ inputTokens: 50000, outputTokens: 1000, cacheReadTokens: 52000 })]);
const newFile = path.join(newDir, 'session.jsonl.zstd');
const t1 = Date.now() - 1000;
fs.utimesSync(newFile, t1 / 1000, t1 / 1000);

const active = findActiveSession(sessions);
check('findActiveSession picks newest', !!active && active.sessionId === 'session-new', active && active.sessionId);

// 3.1 listOtherSessions：排除活动会话、按最近写入排序、最多 5 个、3 天窗口
let others = listOtherSessions(sessions, 'session-new', Date.now());
check('listOtherSessions excludes active + orders by recency',
  others.length === 1 && others[0].sessionId === 'session-old', JSON.stringify(others));
// 超 3 天未写入的会话不收录
const staleDir = path.join(sessions, 'session-stale');
fs.mkdirSync(staleDir, { recursive: true });
writeSession(staleDir, [chunk({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 })]);
const staleFile = path.join(staleDir, 'session.jsonl.zstd');
const staleT = Date.now() - 4 * 24 * 3600 * 1000;
fs.utimesSync(staleFile, staleT / 1000, staleT / 1000);
others = listOtherSessions(sessions, 'session-new', Date.now());
check('listOtherSessions excludes sessions idle over 3 days',
  !others.some((o) => o.sessionId === 'session-stale'), JSON.stringify(others));
// max 上限生效（构造 6 个近 3 天会话 → 最多返回 5 个；mtime 取 10 分钟前，不干扰活动会话判定）
for (let i = 0; i < 6; i++) {
  const d = path.join(sessions, 'session-many-' + i);
  fs.mkdirSync(d, { recursive: true });
  writeSession(d, [chunk({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 })]);
  fs.utimesSync(path.join(d, 'session.jsonl.zstd'), (Date.now() - 600000) / 1000, (Date.now() - 600000) / 1000);
}
const many = listOtherSessions(sessions, 'session-many-0', Date.now());
check('listOtherSessions caps at 5', many.length <= 5, 'len=' + many.length);

// 4. 真实监视器：阈值 100000（102000 tokens > 阈值 → 告警；换小会话 → onClear）
const warnings = [];
let cleared = 0;
const watcher = startContextWatcher({
  dshHome: root, getWorkspace: () => 'ws', getEnabled: () => true, getThreshold: () => 100000,
  onWarning: (info) => warnings.push(info), onClear: () => { cleared++; }, log: () => {},
  intervalMs: 100,
});
setTimeout(() => {
  check('watcher fires onWarning above threshold', warnings.length === 1 && warnings[0].ratio === 102, JSON.stringify(warnings));
  check('warning carries other active sessions overview',
    Array.isArray(warnings[0].others) && warnings[0].others.some((o) => o.sessionId === 'session-old' && o.tokens === 1000),
    JSON.stringify(warnings[0].others));
  // 压缩：新会话体量回落到阈值以下（mtime 最新 → 成为活动会话）
  const compactDir = path.join(sessions, 'session-compacted');
  fs.mkdirSync(compactDir, { recursive: true });
  writeSession(compactDir, [chunk({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 })]);
  const cf = path.join(compactDir, 'session.jsonl.zstd');
  const t2 = Date.now();
  fs.utimesSync(cf, t2 / 1000, t2 / 1000);
  setTimeout(() => {
    watcher.stop();
    check('watcher onClear after compaction', cleared === 1, 'cleared=' + cleared);
    fs.rmSync(root, { recursive: true, force: true });
    if (failures.length) { console.log('CONTEXT-WATCH FAIL: ' + failures.join(', ')); process.exit(1); }
    console.log('CONTEXT-WATCH OK');
  }, 500);
}, 500);
