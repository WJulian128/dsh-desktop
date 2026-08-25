// QQ 官方机器人网关单测（协议逻辑，注入式 transport / fake ws，不联网）：
//  - access_token 获取与缓存
//  - 网关地址获取（Authorization 头格式 QQBot xxx）
//  - start：Hello → Identify（token/intents/shard 载荷）
//  - READY → ready 状态 + sessionId
//  - 事件解析（C2C/群 AT/频道：文本去 <@!id> 提及、字段映射）
//  - RESUME 载荷（session_id + seq）
//  - sendText 三类目标 URL/body
// 用法：node scripts\test-qq-gateway.js
'use strict';
const { QqGateway, INTENTS, API_BASE, TOKEN_URL } = require('../main/bot-gateway/qq-gateway');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

/** 可编程假 WebSocket：记录发送、可手动触发事件。 */
function fakeWs(url) {
  const listeners = {};
  const sent = [];
  const ws = {
    url,
    sent,
    readyState: 1,
    addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    removeEventListener(ev, cb) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== cb); },
    send(raw) { sent.push(JSON.parse(raw)); },
    close() { (listeners.close || []).forEach((cb) => cb({ code: 1000 })); },
    emit(ev, payload) { (listeners[ev] || []).forEach((cb) => cb(payload)); },
  };
  return ws;
}

async function main() {
  // 1. token 获取与缓存
  let tokenCalls = 0;
  const http = async (req) => {
    if (req.url === TOKEN_URL) {
      tokenCalls++;
      return { status: 200, body: { access_token: 'tok-' + tokenCalls, expires_in: 7200 } };
    }
    if (req.url === API_BASE + '/gateway') {
      if (req.headers && req.headers.Authorization !== 'QQBot tok-1') return { status: 401, body: {} };
      return { status: 200, body: { url: 'wss://gateway.example/ws' } };
    }
    return { status: 404, body: {} };
  };
  const g1 = new QqGateway({ appId: 'a1', appSecret: 's1', httpTransport: http, log: () => {} });
  check('access_token 获取成功', (await g1.getAccessToken()) === 'tok-1', '');
  check('access_token 缓存命中（不再请求）', (await g1.getAccessToken()) === 'tok-1' && tokenCalls === 1, 'calls=' + tokenCalls);
  const url1 = await g1.getGatewayUrl();
  check('gateway url 获取（带 QQBot 鉴权头）', url1 === 'wss://gateway.example/ws', url1);
  // token 失败报错
  const gBad = new QqGateway({
    appId: 'x', appSecret: 'y',
    httpTransport: async () => ({ status: 200, body: { errcode: 1, errmsg: 'bad' } }),
    log: () => {},
  });
  let threw = false;
  try { await gBad.getAccessToken(); } catch { threw = true; }
  check('access_token 失败抛错', threw, '');

  // 2. start：Hello → Identify
  const wsA = fakeWs();
  const g2 = new QqGateway({
    appId: 'a2', appSecret: 's2',
    httpTransport: async (req) => {
      if (req.url === TOKEN_URL) return { status: 200, body: { access_token: 'tokX', expires_in: 7200 } };
      return { status: 200, body: { url: 'wss://gateway.example/ws' } };
    },
    wsFactory: () => wsA,
    log: () => {},
  });
  const started = g2.start();
  await new Promise((r) => setTimeout(r, 30));
  wsA.emit('open', {});
  wsA.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }) });
  await new Promise((r) => setTimeout(r, 30));
  const identify = wsA.sent.find((m) => m.op === 2);
  check('start 后发送 Identify', !!identify, JSON.stringify(identify));
  check('Identify token 格式 QQBot xxx', identify && identify.d && identify.d.token === 'QQBot tokX', identify && identify.d && identify.d.token);
  check('Identify intents 含 C2C 位', identify && identify.d && identify.d.intents === INTENTS, String(identify && identify.d && identify.d.intents));
  check('Identify shard [0,1]', identify && identify.d && Array.isArray(identify.d.shard) && identify.d.shard[0] === 0 && identify.d.shard[1] === 1, JSON.stringify(identify && identify.d && identify.d.shard));

  // 3. READY → ready 状态 + sessionId
  let stateGot = null;
  const g3 = new QqGateway({
    appId: 'a3', appSecret: 's3',
    httpTransport: async () => ({ status: 200, body: { access_token: 't3', expires_in: 7200 } }),
    onState: (s, d) => { stateGot = { s, d }; },
    log: () => {},
  });
  g3.handleMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
  g3.handleMessage(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { version: 1, session_id: 'sess-abc', user: { id: 'u1', username: '我的机器人', bot: true }, shard: [0, 1] } }));
  check('READY 后 state=ready + sessionId', g3.ready === true && g3.sessionId === 'sess-abc' && stateGot && stateGot.s === 'ready' && stateGot.d === '我的机器人', JSON.stringify(stateGot));

  // 4. 事件解析（消息归一化）
  const events = [];
  const g4 = new QqGateway({ appId: 'a4', appSecret: 's4', onEvent: (e) => events.push(e), log: () => {} });
  g4.handleMessage(JSON.stringify({
    op: 0, s: 5, t: 'C2C_MESSAGE_CREATE',
    d: { id: 'm1', author: { user_openid: 'OPENID1' }, content: '<@!12345> 你好 截图按钮', timestamp: '1' },
  }));
  g4.handleMessage(JSON.stringify({
    op: 0, s: 6, t: 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'm2', group_openid: 'G1', author: { member_openid: 'M1' }, content: '在吗', timestamp: '2' },
  }));
  g4.handleMessage(JSON.stringify({
    op: 0, s: 7, t: 'AT_MESSAGE_CREATE',
    d: { id: 'm3', channel_id: 'C1', author: { id: 'A1', username: '小明' }, content: '频道消息', timestamp: '3' },
  }));
  check('C2C 事件归一化（去提及）', events[0] && events[0].kind === 'c2c' && events[0].authorId === 'OPENID1' && events[0].text === '你好 截图按钮', JSON.stringify(events[0]));
  check('群 AT 事件归一化', events[1] && events[1].kind === 'group' && events[1].groupOpenid === 'G1' && events[1].authorId === 'M1' && events[1].text === '在吗', JSON.stringify(events[1]));
  check('频道事件归一化（昵称）', events[2] && events[2].kind === 'channel' && events[2].channelId === 'C1' && events[2].authorName === '小明', JSON.stringify(events[2]));

  // 5. RESUME 载荷
  const wsR = fakeWs();
  const g5 = new QqGateway({
    appId: 'a5', appSecret: 's5',
    httpTransport: async (req) => (req.url === TOKEN_URL
      ? { status: 200, body: { access_token: 't5', expires_in: 7200 } }
      : { status: 200, body: { url: 'wss://gateway.example/ws' } }),
    wsFactory: () => wsR,
    log: () => {},
  });
  g5.sessionId = 'sess-old';
  g5.lastSeq = 42;
  const p = g5.connectOnce(true);
  await new Promise((r) => setTimeout(r, 20));
  wsR.emit('open', {});
  await p;
  const resume = wsR.sent.find((m) => m.op === 6);
  check('RESUME 载荷（session+seq）', !!resume && resume.d.session_id === 'sess-old' && resume.d.seq === 42 && resume.d.token === 'QQBot t5', JSON.stringify(resume && resume.d));
  check('RESUME 不发送 Identify', !wsR.sent.find((m) => m.op === 2), '');

  // 6. sendText 三类目标
  const sends = [];
  const g6 = new QqGateway({
    appId: 'a6', appSecret: 's6',
    httpTransport: async (req) => { sends.push({ url: req.url, body: req.body, auth: req.headers && req.headers.Authorization }); return { status: 200, body: {} }; },
    log: () => {},
  });
  g6.token = { value: 't6', expiresAt: Date.now() + 3600000 };
  const r1 = await g6.sendText({ kind: 'c2c', openid: 'OP1' }, '你好');
  const r2 = await g6.sendText({ kind: 'group', groupOpenid: 'GG1' }, '群里好');
  const r3 = await g6.sendText({ kind: 'channel', channelId: 'CC1' }, '频道好');
  check('sendText c2c URL/body', r1.ok && sends[0].url === API_BASE + '/v2/users/OP1/messages' && sends[0].body.content === '你好' && sends[0].auth === 'QQBot t6', JSON.stringify(sends[0]));
  check('sendText group URL/body', r2.ok && sends[1].url === API_BASE + '/v2/groups/GG1/messages' && sends[1].body.msg_type === 0, JSON.stringify(sends[1]));
  check('sendText channel URL/body', r3.ok && sends[2].url === API_BASE + '/v2/channels/CC1/messages' && sends[2].body.content === '频道好', JSON.stringify(sends[2]));

  // 7. stop 后不再重连（close 事件不触发重连）
  let reconnectScheduled = false;
  const g7 = new QqGateway({ appId: 'a7', appSecret: 's7', log: () => {} });
  g7.ws = { readyState: 1, close() {}, addEventListener() {}, removeEventListener() {}, send() {} };
  g7.stopped = false;
  // 手动调用 close 逻辑路径：通过 fakeWs 触发 close
  const ws7 = fakeWs();
  const g8 = new QqGateway({
    appId: 'a8', appSecret: 's8',
    wsFactory: () => ws7,
    httpTransport: async (req) => (req.url === TOKEN_URL
      ? { status: 200, body: { access_token: 't8', expires_in: 7200 } }
      : { status: 200, body: { url: 'wss://gateway.example/ws' } }),
    log: () => {},
  });
  const p8 = g8.connectOnce(false);
  await new Promise((r) => setTimeout(r, 20));
  ws7.emit('open', {});
  await p8;
  g8.stop();
  ws7.emit('close', { code: 4000 });
  await new Promise((r) => setTimeout(r, 60));
  check('stop 后 close 不再重连（ws 已清空）', g8.ws === null, '');

  // 清理：停掉所有实例的心跳定时器，避免进程挂住
  [g2, g3, g4, g5, g6].forEach((g) => { try { g.stop(); } catch { /* 忽略 */ } });

  if (failures.length) { console.log('QQ-GATEWAY FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('QQ-GATEWAY OK');
}
main().catch((err) => { console.error('TEST CRASH: ' + (err && err.stack || err)); process.exit(1); });
