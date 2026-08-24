// scan-worker 单测：
//  - is-round-done：给定文件路径 → 解压 → 尾部判定布尔（真实 zstd 会话文件）
//  - extract-conversation：给定文件路径 + maxChars → 对话文本提取结果
//  - 错误路径：文件缺失 → 对应 error / null；未知任务 → error
//  - 直接 require（parentPort 为 null）时导出任务函数
// 用法：node scripts\test-scan-worker.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { Worker } = require('node:worker_threads');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 构造 zstd 会话文件（与 harness 物理格式一致：单帧压缩，解压输出以 { 开头）
function encodeSession(records) {
  const text = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scan-worker-'));
const wsRoot = path.join(root, '--ws--');

// 会话 1：整轮完成（尾部 assistant/message）
const doneDir = path.join(wsRoot, 'sess-done');
fs.mkdirSync(doneDir, { recursive: true });
const doneFile = path.join(doneDir, 'session.jsonl.zstd');
fs.writeFileSync(doneFile, encodeSession([
  { type: 'session', id: 's1', createdAt: 1 },
  { type: 'user/message', time: 100, data: { content: [{ type: 'text', text: '你好' }] } },
  { type: 'assistant/chunk', time: 200, data: { chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 } } } },
  { type: 'assistant/message', time: 300, data: { message: { role: 'assistant', content: [{ type: 'text', text: '完成' }] } } },
]));

// 会话 2：回合进行中（尾部 tool/call）
const activeDir = path.join(wsRoot, 'sess-active');
fs.mkdirSync(activeDir, { recursive: true });
const activeFile = path.join(activeDir, 'session.jsonl.zstd');
fs.writeFileSync(activeFile, encodeSession([
  { type: 'session', id: 's2', createdAt: 1 },
  { type: 'user/message', time: 100, data: { content: [{ type: 'text', text: 'hi' }] } },
  { type: 'tool/call', time: 200, data: {} },
]));

// 会话 3：多轮用户/助手消息（extract-conversation 用）
const convDir = path.join(wsRoot, 'sess-conv');
fs.mkdirSync(convDir, { recursive: true });
const convFile = path.join(convDir, 'session.jsonl.zstd');
fs.writeFileSync(convFile, encodeSession([
  { type: 'session', id: 's3', createdAt: 1 },
  { type: 'user/message', time: 100, data: { content: [{ type: 'text', text: '第一条' }] } },
  { type: 'assistant/message', time: 200, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复一' }] } } },
  { type: 'user/message', time: 300, data: { content: [{ type: 'text', text: '第二条' }] } },
  { type: 'assistant/message', time: 400, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复二' }] } } },
]));

function spawn() {
  return new Worker(path.join(__dirname, '..', 'main', 'scan-worker.js'));
}

/** 按 id 关联的单次请求：发送任务并等待对应回包。 */
function request(w, id, task, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.off('message', onMsg); reject(new Error(task + ' 超时')); }, 10000);
    const onMsg = (msg) => {
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      w.off('message', onMsg);
      resolve(msg);
    };
    w.on('message', onMsg);
    w.postMessage({ id, task, ...payload });
  });
}

(async () => {
  const w = spawn();
  try {
    // 1. is-round-done
    const r1 = await request(w, 1, 'is-round-done', { file: doneFile });
    check('is-round-done: done=true', r1.type === 'scan-result' && r1.done === true, JSON.stringify(r1));
    const r2 = await request(w, 2, 'is-round-done', { file: activeFile });
    check('is-round-done: done=false', r2.done === false, JSON.stringify(r2));
    const r3 = await request(w, 3, 'is-round-done', { file: path.join(root, 'missing.jsonl.zstd') });
    check('is-round-done: missing file => done=null', r3.done === null, JSON.stringify(r3));

    // 2. extract-conversation
    const r4 = await request(w, 4, 'extract-conversation', { file: convFile, maxChars: 24000 });
    check('extract-conversation: userText keeps both', typeof r4.userText === 'string' && r4.userText.includes('第一条') && r4.userText.includes('第二条'), JSON.stringify(r4));
    check('extract-conversation: assistantText keeps both', r4.assistantText.includes('回复一') && r4.assistantText.includes('回复二'), '');
    check('extract-conversation: userCount + lastUserTime', r4.userCount === 2 && r4.lastUserTime === 300, JSON.stringify(r4));
    const r5 = await request(w, 5, 'extract-conversation', { file: path.join(root, 'missing2.jsonl.zstd'), maxChars: 1000 });
    check('extract-conversation: missing file => error', typeof r5.error === 'string', JSON.stringify(r5));

    // 3. 未知任务
    const r6 = await request(w, 6, 'unknown-task', {});
    check('unknown task => error', typeof r6.error === 'string', '');
  } finally {
    await w.terminate();
  }

  // 4. 直接 require（parentPort 为 null）：导出任务函数，结果与 worker 一致
  const direct = require('../main/scan-worker');
  check('module export exposes task functions', typeof direct.isRoundDone === 'function' && typeof direct.extractConversation === 'function', '');
  check('direct isRoundDone matches worker', direct.isRoundDone(doneFile) === true, '');
  const directConv = direct.extractConversation(convFile, 24000);
  check('direct extractConversation matches worker', directConv.userCount === 2 && directConv.lastUserTime === 300, JSON.stringify(directConv));

  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length) { console.log('SCAN-WORKER FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('SCAN-WORKER OK');
})().catch((err) => { console.error(err); process.exit(1); });
