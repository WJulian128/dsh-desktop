// transcript-check 与 panel-stream-worker 测试：
// 全量/尾帧检查语义（user/message 与 inbox 命中、tool/call 参数绝不命中）、
// 大文件尾帧路径（压缩后 >2MB 走尾帧）、worker 端到端（list/since/contains）。
// 注意语义：sessionContainsText 只检查"最新会话"（按 mtime），测试按此排序。
// 用法：node scripts\test-transcript-check.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { sessionContainsText } = require('../main/transcript-check');
const { workspaceSessionKey } = require('../main/usage');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-test-'));
const workspace = 'C:\\fake\\project';
const root = path.join(dshHome, 'sessions', workspaceSessionKey(workspace));

/** 把若干 JSON 对象逐条压缩为独立 zstd 帧并拼接（与真实会话文件同格式）。 */
function buildSessionFile(records) {
  const chunks = [];
  for (const r of records) {
    chunks.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')));
  }
  return Buffer.concat(chunks);
}

function writeSession(dirName, records) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), buildSessionFile(records));
}

const MARK_IN_USER = '唯一接续标记-甲';
const MARK_IN_INBOX = '唯一接续标记-乙';
const MARK_IN_TOOL = '唯一接续标记-丙';

// 1. 主会话（最新）：user/message 与 inbox 命中，tool/call 参数绝不命中
writeSession('session-main', [
  { type: 'session', data: { id: 'session-main' } },
  { type: 'tool/call', seq: 1, data: { turn: 1, name: 'restartApp', arguments: JSON.stringify({ task: MARK_IN_TOOL }) } },
  { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '正常消息 ' + MARK_IN_USER }] } },
  { type: 'agent/inbox/spliced', seq: 3, data: { inserted: [{ type: 'text', text: '队列消息 ' + MARK_IN_INBOX }] } },
]);
{
  check('contains: user/message hit', sessionContainsText({ dshHome, workspace, mark: MARK_IN_USER, full: true }) === true, '');
  check('contains: inbox hit', sessionContainsText({ dshHome, workspace, mark: MARK_IN_INBOX, full: true }) === true, '');
  check('contains: tool args never match', sessionContainsText({ dshHome, workspace, mark: MARK_IN_TOOL, full: true }) === false, '');
  check('contains: absent text false', sessionContainsText({ dshHome, workspace, mark: '不存在的文本', full: true }) === false, '');
  check('contains tail(小文件): user hit', sessionContainsText({ dshHome, workspace, mark: MARK_IN_USER }) === true, '');
  check('contains tail(小文件): tool never', sessionContainsText({ dshHome, workspace, mark: MARK_IN_TOOL }) === false, '');
}

// 2. panel-stream-worker 端到端（contains 需在 session-main 仍为最新会话时测；
//    list 需要真实子代理记录：session 记录的 origin/parentSession 在顶层，不在 data 内）
(async () => {
  const worker = new Worker(path.join(__dirname, '..', 'main', 'panel-stream-worker.js'));
  const call = (task, payload) => new Promise((resolve, reject) => {
    worker.once('message', (m) => {
      if (m && m.requestId === 1) {
        if (m.error) reject(new Error(m.error));
        else resolve(m.result);
      }
    });
    worker.postMessage({ requestId: 1, task, ...payload });
  });
  try {
    const hit = await call('contains', { dshHome, workspace, mark: MARK_IN_USER, full: true });
    check('worker contains hit', hit === true, '');
    const miss = await call('contains', { dshHome, workspace, mark: MARK_IN_TOOL, full: true });
    check('worker contains tool-never', miss === false, '');
    // 子代理会话（session 记录顶层带 origin:'subagent' + parentSession，与真实文件一致）
    writeSession('sub-1', [
      { type: 'session', id: 'sub-1', origin: 'subagent', parentSession: 'session-main', createdAt: Date.now() },
      { type: 'subagent/descriptor', seq: 1, data: { label: '测试子代理' } },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]);
    const list = await call('list', { dshHome, workspace });
    const sub = Array.isArray(list) ? list.find((x) => x && x.sessionId === 'sub-1') : null;
    check('worker list includes subagent with parentSession', !!(sub && sub.parentSession === 'session-main' && sub.label === '测试子代理'), JSON.stringify(sub));
  } catch (err) {
    check('worker tasks', false, (err && err.message) || String(err));
  } finally {
    await worker.terminate();
  }

  // 3. 大文件（压缩后 >2MB，用不可压缩随机内容）→ 尾帧路径：尾部命中、首部漏判
  const bigRecords = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '首部标记-FIRST' }] } },
    { type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: crypto.randomBytes(3 * 1024 * 1024).toString('base64') }] } } },
    { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '尾部标记-LAST' }] } },
  ];
  writeSession('session-big', bigRecords); // 写入时间最晚 → 成为"最新会话"
  const bigSize = fs.statSync(path.join(root, 'session-big', 'session.jsonl.zstd')).size;
  check('big file > 2MB (tail path)', bigSize > 2 * 1024 * 1024, 'size=' + bigSize);
  check('big: tail mark found', sessionContainsText({ dshHome, workspace, mark: '尾部标记-LAST' }) === true, '');
  const tailMiss = sessionContainsText({ dshHome, workspace, mark: '首部标记-FIRST' });
  const fullHit = sessionContainsText({ dshHome, workspace, mark: '首部标记-FIRST', full: true });
  check('big: head mark tail-miss but full-hit', tailMiss === false && fullHit === true, 'tail=' + tailMiss + ' full=' + fullHit);

  fs.rmSync(dshHome, { recursive: true, force: true });

  if (failures.length) { console.log('TRANSCRIPT-CHECK FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('TRANSCRIPT-CHECK OK');
})();
