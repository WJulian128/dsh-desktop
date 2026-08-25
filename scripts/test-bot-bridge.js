// 回复桥单测：extractReplyAfter 纯函数判定 + findSessionFile + ReplyBridge.process 端到端
// （真实 zstd 会话文件 + 注入/轮询，串行队列）。
// 用法：node scripts\test-bot-bridge.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { ReplyBridge, extractReplyAfter, findSessionFile } = require('../main/bot-gateway/reply-bridge');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

const rec = (type, time, extra) => ({ type, time, ...(extra || {}) });
const amsg = (time, text) => rec('assistant/message', time, { data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });

async function main() {
  // 1. extractReplyAfter 纯函数
  const lines = [
    rec('session', 1),
    rec('user/message', 100),
    amsg(200, '最终答复'),
    rec('step/end', 300),
  ].map((r) => JSON.stringify(r)).join('\n');
  const r1 = extractReplyAfter(lines, 150);
  check('assistant+step/end 且 ts>afterTs → done+text', r1.done === true && r1.text === '最终答复', JSON.stringify(r1));
  const r2 = extractReplyAfter(lines, 250);
  check('ts<=afterTs → 不认（旧回复）', r2.done === false, JSON.stringify(r2));
  const noEnd = [
    rec('user/message', 100),
    amsg(200, '工具前段落'),
  ].map((r) => JSON.stringify(r)).join('\n');
  check('无结束帧 → done:false', extractReplyAfter(noEnd, 150).done === false, '');
  const turnEnd = [
    amsg(200, '子代理答复'),
    rec('turn/end', 300),
  ].map((r) => JSON.stringify(r)).join('\n');
  check('turn/end 也认（子代理）', extractReplyAfter(turnEnd, 150).done === true, '');
  const toolTail = [
    amsg(200, '段'),
    rec('tool/call', 250),
  ].map((r) => JSON.stringify(r)).join('\n');
  check('尾部 tool/call → done:false', extractReplyAfter(toolTail, 150).done === false, '');
  const emptyTail = [
    amsg(200, ''),
    rec('step/end', 300),
  ].map((r) => JSON.stringify(r)).join('\n');
  check('空文本回复 → done:false', extractReplyAfter(emptyTail, 150).done === false, '');

  // 2. findSessionFile
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
  const sessDir = path.join(root, '--ws--', 'sess-1');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'session.jsonl.zstd'), 'x');
  check('findSessionFile 按 sessionId 定位', findSessionFile(root, 'sess-1') === path.join(sessDir, 'session.jsonl.zstd'), '');
  check('findSessionFile 找不到 → null', findSessionFile(root, 'nope') === null, '');

  // 3. ReplyBridge.process 端到端：注入 → 会话文件写入最终回复 → 提取
  const sessFile = path.join(sessDir, 'session.jsonl.zstd');
  const enc = (records) => zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
  // 初始：只有注入前的旧内容（带旧回复）
  const t0 = Date.now() - 60000;
  fs.writeFileSync(sessFile, enc([rec('session', 1), rec('user/message', t0), amsg(t0 + 1000, '旧回复'), rec('step/end', t0 + 2000)]));
  const injected = [];
  const bridge = new ReplyBridge({
    sessionsRoot: root,
    injectPrompt: async (text) => { injected.push({ text, at: Date.now() }); return true; },
    getSessionId: () => 'sess-1',
    pollMs: 60,
    timeoutMs: 5000,
    log: () => {},
  });
  // 50ms 后写入本轮回复（模拟 agent 完成后落盘）
  setTimeout(() => {
    const t1 = Date.now();
    fs.writeFileSync(sessFile, enc([
      rec('session', 1),
      rec('user/message', t0),
      amsg(t0 + 1000, '旧回复'), rec('step/end', t0 + 2000),
      rec('user/message', t1 - 500),
      amsg(t1, '本轮新回复'),
      rec('step/end', t1 + 100),
    ]));
  }, 60);
  const reply = await bridge.process('QQ 用户问：你好');
  check('process 注入并等到新回复', reply === '本轮新回复', String(reply));
  check('注入文本正确', injected.length === 1 && injected[0].text === 'QQ 用户问：你好', JSON.stringify(injected));

  // 4. 串行队列：第二条注入必须等第一条完成
  const order = [];
  const bridge2 = new ReplyBridge({
    sessionsRoot: root,
    injectPrompt: async (text) => { order.push('in:' + text); await new Promise((r) => setTimeout(r, 120)); return true; },
    getSessionId: () => 'sess-1',
    pollMs: 60,
    timeoutMs: 2000,
    log: () => {},
  });
  const pA = bridge2.process('A');
  const pB = bridge2.process('B');
  await Promise.allSettled([pA, pB]);
  check('串行队列：B 在 A 完成前不注入', order[0] === 'in:A' && order[1] === 'in:B', JSON.stringify(order));

  fs.rmSync(root, { recursive: true, force: true });
  if (failures.length) { console.log('BOT-BRIDGE FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('BOT-BRIDGE OK');
}
main().catch((err) => { console.error('TEST CRASH: ' + (err && err.stack || err)); process.exit(1); });
