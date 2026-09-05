// session-inbox 纯函数单元测试：投递 / 列表 / 已读 / 修剪 / 安全校验。
// 用法：node scripts\test-session-inbox.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MAX_ITEMS_PER_BOX,
  isValidSessionId,
  appendMessage,
  listMessages,
  unreadCount,
  markRead,
} = require('../main/session-inbox.js');

const failures = [];
let passed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (ok) passed += 1; else failures.push(name);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inbox-'));

// ── 1. 会话 id 安全校验 ────────────────────────────────────────────────
check('合法 id：uuid/短横线/下划线', isValidSessionId('session-464ac413-dc95-4236-8507-45755c0ed2e1') && isValidSessionId('a_B-1'), '');
check('非法 id：路径穿越/点/空白/超长', !isValidSessionId('../evil') && !isValidSessionId('a b') && !isValidSessionId('a/b') && !isValidSessionId('') && !isValidSessionId('x'.repeat(200)) && !isValidSessionId(null) && !isValidSessionId(123), '');

// ── 2. 投递 / 未读 ─────────────────────────────────────────────────────
const r1 = appendMessage(root, 'sess-b', { from: 'sess-a', text: '你好，B 会话' });
check('投递成功返回消息', r1.ok === true && r1.message && r1.message.read === false && r1.message.text === '你好，B 会话', JSON.stringify(r1));
check('投递后未读数 = 1', unreadCount(root, 'sess-b') === 1, 'unread=' + unreadCount(root, 'sess-b'));
check('其它会话收不到', unreadCount(root, 'sess-a') === 0 && unreadCount(root, 'sess-c') === 0, '');
const r2 = appendMessage(root, 'sess-b', { from: 'sess-a', fromTitle: '会话甲', text: '第二条' });
check('fromTitle 随消息保存', r2.ok === true && r2.message.fromTitle === '会话甲', '');
check('非法来源被拒', appendMessage(root, 'sess-b', { from: '../x', text: 'hi' }).ok === false, '');
check('空内容被拒', appendMessage(root, 'sess-b', { from: 'sess-a', text: '  ' }).ok === false, '');
check('超长内容被拒', appendMessage(root, 'sess-b', { from: 'sess-a', text: 'x'.repeat(5000) }).ok === false, '');

// ── 3. 列表语义（新→旧、未读默认、includeRead） ────────────────────────
const l1 = listMessages(root, 'sess-b');
check('默认只列未读且新→旧', l1.ok === true && l1.unread === 2 && l1.items.length === 2 && l1.items[0].text === '第二条' && l1.items[1].text === '你好，B 会话', JSON.stringify(l1));
const l2 = listMessages(root, 'sess-b', { includeRead: true });
check('includeRead 含已读并保持新→旧', l2.ok === true && l2.items.length === 2 && l2.items[0].id === r2.message.id, '');
check('缺失会话列表为空', listMessages(root, 'sess-z').unread === 0 && listMessages(root, 'sess-z').items.length === 0, '');

// ── 4. 标记已读（指定 id / 全部） ──────────────────────────────────────
const m1 = markRead(root, 'sess-b', [r1.message.id]);
check('按 id 标记已读', m1.ok === true && m1.marked === 1 && unreadCount(root, 'sess-b') === 1, '');
const m2 = markRead(root, 'sess-b');
check('缺省全部标记', m2.ok === true && m2.marked === 1 && unreadCount(root, 'sess-b') === 0, '');
const m3 = markRead(root, 'sess-b');
check('重复标记无变化', m3.ok === true && m3.marked === 0, '');
check('对不存在的会话标记安全返回', markRead(root, 'sess-nope').ok === true, '');
const l3 = listMessages(root, 'sess-b');
check('全部已读后默认列表为空但 unread=0', l3.ok === true && l3.items.length === 0 && l3.unread === 0, '');

// ── 5. 文件格式：损坏行容错 + 修剪上限 ─────────────────────────────────
const boxFile = path.join(root, 'session-inbox', 'sess-b.jsonl');
fs.appendFileSync(boxFile, '{broken json\n', 'utf8');
check('损坏行被跳过不影响读取', listMessages(root, 'sess-b', { includeRead: true }).ok === true, '');
for (let i = 0; i < MAX_ITEMS_PER_BOX + 30; i++) {
  appendMessage(root, 'sess-b', { from: 'sess-a', text: 'bulk-' + i });
}
const afterBulk = listMessages(root, 'sess-b', { includeRead: true, limit: 500 });
check('箱内消息修剪到上限', afterBulk.items.length === MAX_ITEMS_PER_BOX, 'len=' + afterBulk.items.length);
check('修剪保留的是最新消息', afterBulk.items[afterBulk.items.length - 1].text === 'bulk-29' || afterBulk.items[0].text === 'bulk-' + (MAX_ITEMS_PER_BOX + 29), 'head=' + afterBulk.items[0].text);

fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.log('SESSION-INBOX FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('SESSION-INBOX OK (' + passed + ' checks)');
