// 子代理中心单测（纯 Node，不依赖 Electron）：
//  1. classifySubagentStatus：done / running / stopped / empty 判定
//  2. scanSubagentFile：字段提取（label/mode/model/parent/usage）
//  3. scanSubagents：过滤普通会话、排序
//  4. parentTitleMap / summarize
// 用法：node scripts\test-subagent-center.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { scanSubagents, scanSubagentFile, classifySubagentStatus, parentTitleMap, summarize } = require('../main/subagent-center');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 构造 zstd 拼接帧（与 harness 物理格式一致：每帧解压输出须以 { 开头）
function encodeSession(records) {
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const frame = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
  return frame;
}

const NOW = 2000000000000;
const T0 = NOW - 120000; // 2 分钟前

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-test-'));
const dshHome = path.join(root, 'home');
const wsKey = '--C-test-ws--';
const sessRoot = path.join(dshHome, 'sessions', wsKey);

const mkSess = (id, records) => {
  fs.mkdirSync(path.join(sessRoot, id), { recursive: true });
  fs.writeFileSync(path.join(sessRoot, id, 'session.jsonl.zstd'), encodeSession(records));
};

// 1. 完成的子代理（尾部 assistant/message + turn/end）
mkSess('sub-done', [
  { type: 'session', version: 0, id: 'sub-done', createdAt: T0, parentSession: 'parent-1', origin: 'subagent', delegationDepth: 1 },
  { type: 'subagent/descriptor', time: T0, data: { version: 2, mode: 'continuable', provider: 'spawn', label: '缺陷扫描', agentModel: 'deepseek-v4-flash' } },
  { type: 'user/message', time: T0 + 1000, data: { content: [{ type: 'text', text: '任务' }] } },
  { type: 'assistant/chunk', time: T0 + 5000, data: { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, reasoningTokens: 10 } } } },
  { type: 'assistant/message', time: T0 + 6000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } } },
  { type: 'turn/end', time: T0 + 6100 },
]);
// 2. 运行中的子代理（尾部 tool/call）
mkSess('sub-running', [
  { type: 'session', version: 0, id: 'sub-running', createdAt: T0, parentSession: 'parent-1', origin: 'subagent', delegationDepth: 2 },
  { type: 'subagent/descriptor', time: T0, data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '并行实现', agentModel: 'deepseek-v4-pro' } },
  { type: 'user/message', time: T0 + 1000, data: { content: [{ type: 'text', text: '任务' }] } },
  { type: 'assistant/message', time: T0 + 3000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '开始' }] } } },
  { type: 'tool/call', time: NOW - 30000, data: {} },
]);
// 3. 疑似停止（尾部 tool/call + 12 分钟无写入）
mkSess('sub-stopped', [
  { type: 'session', version: 0, id: 'sub-stopped', createdAt: NOW - 13 * 60 * 1000, parentSession: 'parent-2', origin: 'subagent', delegationDepth: 1 },
  { type: 'subagent/descriptor', time: NOW - 13 * 60 * 1000, data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '卡住的任务', agentModel: 'deepseek-v4-flash' } },
  { type: 'user/message', time: NOW - 12 * 60 * 1000 - 1000, data: { content: [{ type: 'text', text: '任务' }] } },
  { type: 'tool/call', time: NOW - 12 * 60 * 1000, data: {} },
]);
// 4. 空会话（无对话记录）
mkSess('sub-empty', [
  { type: 'session', version: 0, id: 'sub-empty', createdAt: T0, parentSession: 'parent-2', origin: 'subagent' },
  { type: 'subagent/descriptor', time: T0, data: { version: 2, mode: 'one-shot', provider: 'spawn', label: '空白', agentModel: 'deepseek-v4-flash' } },
]);
// 5. 普通会话（不应被收录）
mkSess('normal-session', [
  { type: 'session', version: 0, id: 'normal-session', createdAt: T0 },
  { type: 'session/title', data: { title: '普通对话' } },
  { type: 'user/message', time: T0 + 1000, data: { content: [{ type: 'text', text: '你好' }] } },
  { type: 'assistant/message', time: T0 + 2000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '你好' }] } } },
]);

// 父会话标题映射源
mkSess('parent-1', [
  { type: 'session', version: 0, id: 'parent-1', createdAt: T0 },
  { type: 'session/title', data: { title: '优化软件版本' } },
  { type: 'user/message', time: T0, data: { content: [{ type: 'text', text: 'x' }] } },
]);

// 1. 状态判定纯函数
const rec = (types) => types.map((type) => ({ type, time: NOW }));
check('classify: done', classifySubagentStatus(rec(['user/message', 'assistant/message', 'turn/end']), { now: NOW }).status === 'done', '');
check('classify: running on tool/call', classifySubagentStatus(rec(['user/message', 'tool/call']), { now: NOW }).status === 'running', '');
check('classify: running on chunk', classifySubagentStatus(rec(['user/message', 'assistant/chunk']), { now: NOW }).status === 'running', '');
check('classify: empty', classifySubagentStatus(rec(['user/message']), { now: NOW }).status === 'empty', '');
const oldRec = [{ type: 'user/message', time: NOW - 60000 }, { type: 'tool/call', time: NOW - 60000 }];
check('classify: stopped after long silence', classifySubagentStatus(oldRec, { now: NOW, stoppedAfterMs: 10000 }).status === 'stopped', '');
check('classify: done requires turn/end', classifySubagentStatus(rec(['user/message', 'assistant/message']), { now: NOW }).status === 'running', '');

// 2. scanSubagentFile
const done = scanSubagentFile(path.join(sessRoot, 'sub-done', 'session.jsonl.zstd'), NOW);
check('scan: done status', done && done.status === 'done', done && done.status);
check('scan: label from descriptor', done && done.label === '缺陷扫描', '');
check('scan: mode/model/parent', done && done.mode === 'continuable' && done.agentModel === 'deepseek-v4-flash' && done.parentSession === 'parent-1' && done.delegationDepth === 1, JSON.stringify(done));
check('scan: token usage', done && done.usage.inputTokens === 100 && done.usage.outputTokens === 50 && done.usage.cacheReadTokens === 200, JSON.stringify(done.usage));
check('scan: duration computed', done && done.durationMs === 6100, String(done.durationMs));
const running = scanSubagentFile(path.join(sessRoot, 'sub-running', 'session.jsonl.zstd'), NOW);
check('scan: running status', running && running.status === 'running', running && running.status);
const stopped = scanSubagentFile(path.join(sessRoot, 'sub-stopped', 'session.jsonl.zstd'), NOW);
check('scan: stopped status', stopped && stopped.status === 'stopped', stopped && stopped.status);
const empty = scanSubagentFile(path.join(sessRoot, 'sub-empty', 'session.jsonl.zstd'), NOW);
check('scan: empty status', empty && empty.status === 'empty', empty && empty.status);
check('scan: normal session excluded', scanSubagentFile(path.join(sessRoot, 'normal-session', 'session.jsonl.zstd'), NOW) === null, '');

// 3. scanSubagents 聚合
const items = scanSubagents({ dshHome, workspace: 'C:/test/ws', now: NOW });
check('scanSubagents collects 4 subagents (excludes normal)', items.length === 4, String(items.length));
check('scanSubagents sorted by last activity desc', items[0].sessionId === 'sub-stopped' || items[0].sessionId === 'sub-running', items.map((i) => i.sessionId).join(','));
const summary = summarize(items);
check('summarize counts', summary.running === 1 && summary.done === 1 && summary.stopped === 1 && summary.empty === 1 && summary.total === 4, JSON.stringify(summary));
check('summarize tokens', summary.totalTokens === 350, String(summary.totalTokens));

// 4. parentTitleMap
const titles = parentTitleMap({ dshHome, workspace: 'C:/test/ws' });
check('parentTitleMap resolves parent title', titles['parent-1'] === '优化软件版本', JSON.stringify(titles));

// 清理
fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.log('SUBAGENT-CENTER FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('SUBAGENT-CENTER OK');
