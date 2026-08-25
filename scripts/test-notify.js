// 完成通知"整轮完成"判定单测：
//  - classifyLastRecord：尾部对话记录类型 → round-done / round-active / user-pending / empty
//  - findNewestSessionFile：多工作区多会话下选最新写入
//  - scanRoundDoneFile：给定文件路径的尾部判定（scan worker 的核心逻辑）
//  - startCompletionWatcher：真实 zstd 会话 + worker 异步判定 → onComplete
// 用法：node scripts\test-notify.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { classifyLastRecord, findNewestSessionFile, scanRoundDoneFile, startCompletionWatcher, isSubagentSessionFile } = require('../main/notify');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 1. classifyLastRecord 纯函数
const rec = (type) => ({ type, time: 1 });
check('assistant/message + step/end => round-done',
  classifyLastRecord([rec('user/message'), rec('assistant/chunk'), rec('assistant/message'), rec('step/end')]) === 'round-done', '');
check('assistant/message without step/end => round-active (tool-prefix segment, NOT done)',
  classifyLastRecord([rec('user/message'), rec('assistant/chunk'), rec('assistant/message')]) === 'round-active', '');
check('last tool/call => round-active',
  classifyLastRecord([rec('user/message'), rec('assistant/message'), rec('tool/call'), rec('tool/result')]) === 'round-active', '');
check('last tool-call-chunks => round-active',
  classifyLastRecord([rec('user/message'), rec('assistant/message'), rec('tool-call-chunks')]) === 'round-active', '');
check('step/end then more activity => round-active',
  classifyLastRecord([rec('assistant/message'), rec('step/end'), rec('tool/call')]) === 'round-active', '');
check('last assistant/chunk => round-active',
  classifyLastRecord([rec('user/message'), rec('assistant/chunk')]) === 'round-active', '');
check('last user/message => user-pending',
  classifyLastRecord([rec('session/title'), rec('user/message')]) === 'user-pending', '');
check('only non-conversation records => empty',
  classifyLastRecord([rec('session'), rec('session/title')]) === 'empty', '');
check('empty array => empty', classifyLastRecord([]) === 'empty', '');
check('null input => empty', classifyLastRecord(null) === 'empty', '');
// 非对话记录（标题更新等）不应干扰判定
check('title after final answer still round-done',
  classifyLastRecord([rec('assistant/message'), rec('step/end'), rec('session/title')]) === 'round-done', '');

// 2. findNewestSessionFile：最新写入优先（跨工作区、跨会话）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-'));
const ws1 = path.join(root, '--ws-a--', 'session-old');
const ws2 = path.join(root, '--ws-b--', 'session-new');
fs.mkdirSync(ws1, { recursive: true });
fs.mkdirSync(ws2, { recursive: true });
const oldFile = path.join(ws1, 'session.jsonl.zstd');
const newFile = path.join(ws2, 'session.jsonl.zstd');
fs.writeFileSync(oldFile, 'x');
fs.writeFileSync(newFile, 'x');
const t0 = Date.now() / 1000 - 60;
fs.utimesSync(oldFile, t0, t0);
const best = findNewestSessionFile(root);
check('findNewestSessionFile picks newest', !!best && best.file === newFile, best && best.file);
fs.rmSync(root, { recursive: true, force: true });

// 2b. 子代理会话识别与跳过：子代理完成时其文件最新，不应被当作活动会话
const subRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-sub-'));
// 与 harness 物理格式一致：每行一条记录、逐行一帧（isSubagentSessionFile 按单帧 JSON 解析）
function enc(records) {
  return Buffer.concat(records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))));
}
const mainDir = path.join(subRoot, '--ws--', 'sess-main');
const subDir = path.join(subRoot, '--ws--', 'sess-subagent');
fs.mkdirSync(mainDir, { recursive: true });
fs.mkdirSync(subDir, { recursive: true });
const mainFile = path.join(mainDir, 'session.jsonl.zstd');
const subFile = path.join(subDir, 'session.jsonl.zstd');
fs.writeFileSync(mainFile, enc([{ type: 'session', id: 'm', createdAt: 1 }, { type: 'assistant/message', time: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] } } }]));
fs.writeFileSync(subFile, enc([{ type: 'session', id: 's', createdAt: 1, origin: 'subagent', parentSession: 'm' }, { type: 'assistant/message', time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'subagent done' }] } } }]));
const t1 = Date.now() / 1000 - 120;
fs.utimesSync(mainFile, t1, t1);
check('isSubagentSessionFile true on subagent session', isSubagentSessionFile(subFile) === true, '');
check('isSubagentSessionFile false on main session', isSubagentSessionFile(mainFile) === false, '');
check('isSubagentSessionFile false on missing file', isSubagentSessionFile(path.join(subRoot, 'nope')) === false, '');
const noSkip = findNewestSessionFile(subRoot);
check('default picks subagent as newest', !!noSkip && noSkip.file === subFile, noSkip && noSkip.file);
const withSkip = findNewestSessionFile(subRoot, { skipSubagent: true });
check('skipSubagent falls back to main session', !!withSkip && withSkip.file === mainFile, withSkip && withSkip.file);
fs.rmSync(subRoot, { recursive: true, force: true });

// 3. scanRoundDoneFile：给定文件路径的尾部判定（worker 任务的核心逻辑）
const zroot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-scan-'));
function encodeSession(records) {
  // 与 harness 物理格式一致：单帧 zstd，解压输出以 { 开头
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}
const doneDir = path.join(zroot, '--ws-c--', 'sess-done');
fs.mkdirSync(doneDir, { recursive: true });
const doneFile = path.join(doneDir, 'session.jsonl.zstd');
fs.writeFileSync(doneFile, encodeSession([
  { type: 'session', id: 's1', createdAt: 1 },
  { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'assistant/chunk', time: 3, data: { chunk: { type: 'usage', usage: {} } } },
  { type: 'assistant/message', time: 4, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
  { type: 'step/end', time: 5, data: {} },
]));
check('scanRoundDoneFile true on final answer + step/end', scanRoundDoneFile(doneFile) === true, '');
// 工具调用前的文字段落（无 step/end）：判定必须拒绝——这是"思考完成就误弹通知"的实证场景
const prefixOnlyDir = path.join(zroot, '--ws-c--', 'sess-prefix');
fs.mkdirSync(prefixOnlyDir, { recursive: true });
const prefixOnlyFile = path.join(prefixOnlyDir, 'session.jsonl.zstd');
fs.writeFileSync(prefixOnlyFile, encodeSession([
  { type: 'session', id: 's3', createdAt: 1 },
  { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'assistant/chunk', time: 3, data: { chunk: { type: 'usage', usage: {} } } },
  { type: 'assistant/message', time: 4, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] } } },
]));
check('scanRoundDoneFile false on tool-prefix message without step/end', scanRoundDoneFile(prefixOnlyFile) === false, '');
const activeDir = path.join(zroot, '--ws-c--', 'sess-active');
fs.mkdirSync(activeDir, { recursive: true });
const activeFile = path.join(activeDir, 'session.jsonl.zstd');
fs.writeFileSync(activeFile, encodeSession([
  { type: 'session', id: 's2', createdAt: 1 },
  { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'tool/call', time: 3, data: {} },
]));
check('scanRoundDoneFile false on tool/call tail', scanRoundDoneFile(activeFile) === false, '');
check('scanRoundDoneFile null on missing file', scanRoundDoneFile(path.join(zroot, 'nope.jsonl.zstd')) === null, '');
fs.rmSync(zroot, { recursive: true, force: true });

// 4. startCompletionWatcher 异步路径：真实 zstd 会话经 scan worker 判定 → onComplete
const watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-watch-'));
const watchSessions = path.join(watchRoot, '--ws--');
const sessDir = path.join(watchSessions, 'sess');
fs.mkdirSync(sessDir, { recursive: true });
const sessFile = path.join(sessDir, 'session.jsonl.zstd');
const payload = encodeSession([
  { type: 'session', id: 'w', createdAt: 1 },
  { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'assistant/message', time: 3, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } } },
  { type: 'step/end', time: 4, data: {} },
]);
let completed = 0;
const watcher = startCompletionWatcher({ sessionsDir: watchRoot, onComplete: () => { completed++; }, idleMs: 300, log: () => {} });
// 以 200ms 间隔连续写 10 次：构成一个"写入突发"（间隙 < idleMs），
// 满足 count>=3 且 span>=1500ms（真实 harness 行为：一轮模型回合内持续写事件）。
let writes = 0;
const writeTimer = setInterval(() => {
  writes += 1;
  fs.writeFileSync(sessFile, payload);
  if (writes >= 10) clearInterval(writeTimer);
}, 200);
setTimeout(() => {
  watcher.stop();
  check('watcher onComplete fired via worker scan', completed >= 1, 'completed=' + completed);
  fs.rmSync(watchRoot, { recursive: true, force: true });
  if (failures.length) { console.log('NOTIFY FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('NOTIFY OK');
}, 8000);
