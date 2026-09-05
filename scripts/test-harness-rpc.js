'use strict';

// harness /api RPC 双风格适配层单测（main/harness-rpc.js）。
// 用法：node scripts/test-harness-rpc.js

const assert = require('node:assert');
const rpc = require('../main/harness-rpc');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
    pass += 1;
  } catch (err) {
    console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err));
    fail += 1;
  }
}

/* ---- 方法名归一化与参数名 ---- */
check('splitMethod 接受点分与斜杠两种写法', () => {
  assert.deepStrictEqual(rpc.splitMethod('session.list'), { namespace: 'session', name: 'list' });
  assert.deepStrictEqual(rpc.splitMethod('session/list'), { namespace: 'session', name: 'list' });
  assert.deepStrictEqual(rpc.splitMethod('workspace.create'), { namespace: 'workspace', name: 'create' });
});

check('argsKeyFor：session.list=_request，其余 request', () => {
  assert.strictEqual(rpc.argsKeyFor('session.list'), '_request');
  assert.strictEqual(rpc.argsKeyFor('session/list'), '_request');
  assert.strictEqual(rpc.argsKeyFor('session.prompt'), 'request');
  assert.strictEqual(rpc.argsKeyFor('workspace.create'), 'request');
});

check('argsKeyCandidates 主候选在前', () => {
  assert.deepStrictEqual(rpc.argsKeyCandidates('session.list'), ['_request', 'request']);
  assert.deepStrictEqual(rpc.argsKeyCandidates('session.prompt'), ['request', '_request']);
});

/* ---- 新风格（Typert 网关）信封 ---- */
check('新风格 session.list：斜杠端点 + args._request 包装', () => {
  const payload = { a: 1 };
  const req = rpc.buildRequest('session.list', payload, 'new');
  assert.strictEqual(req.path, '/api/session/list');
  const json = JSON.parse(req.body);
  assert.strictEqual(json.type, 'client-request');
  assert.strictEqual(json.method, 'session/list');
  assert.ok(typeof json.rpcId === 'string' && json.rpcId.length > 8);
  assert.deepStrictEqual(json.payload, { args: { _request: payload } });
});

check('新风格 session.prompt：args.request 包装', () => {
  const payload = { sessionId: 's1', mode: 'queue' };
  const json = JSON.parse(rpc.buildRequest('session.prompt', payload, 'new').body);
  assert.deepStrictEqual(json.payload, { args: { request: payload } });
});

/* ---- 旧风格信封 ---- */
check('旧风格：点分端点 + payload 透传（无 args 包装）', () => {
  const payload = { sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hi' }] };
  const req = rpc.buildRequest('session.prompt', payload, 'legacy');
  assert.strictEqual(req.path, '/api/session.prompt');
  const json = JSON.parse(req.body);
  assert.strictEqual(json.method, 'session.prompt');
  assert.deepStrictEqual(json.payload, payload);
});

/* ---- 响应分类（决定能否安全换风格/换参数名重试） ---- */
check('classifyResponse：ok=true → ok', () => {
  const text = JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { items: [] } } });
  assert.strictEqual(rpc.classifyResponse(200, text), 'ok');
});

check('classifyResponse：401 → unauthorized', () => {
  assert.strictEqual(rpc.classifyResponse(401, 'unauthorized'), 'unauthorized');
});

check('classifyResponse：404 → style-mismatch（端点不存在）', () => {
  assert.strictEqual(rpc.classifyResponse(404, 'not found'), 'style-mismatch');
});

check('classifyResponse：gateway/bad-request（method 不匹配端点）→ style-mismatch', () => {
  const text = JSON.stringify({
    type: 'server-response', rpcId: 'x',
    result: { ok: false, error: { code: 'gateway/bad-request', message: 'method session.list does not match endpoint session/list', details: {} } },
  });
  assert.strictEqual(rpc.classifyResponse(200, text), 'style-mismatch');
});

check('classifyResponse：gateway/arguments-invalid（结构化）→ args-mismatch', () => {
  const text = JSON.stringify({
    type: 'server-response', rpcId: 'x',
    result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor', details: {} } },
  });
  assert.strictEqual(rpc.classifyResponse(200, text), 'args-mismatch');
});

check('classifyResponse：纯文本 500 handler failure（Typert 参数校验抛出）→ args-mismatch', () => {
  const text = 'handler failure: TypertGatewayError: gateway/arguments-invalid: args fields do not match the descriptor: unexpected fields: request';
  assert.strictEqual(rpc.classifyResponse(500, text), 'args-mismatch');
});

check('classifyResponse：业务错误（ok:false 且非网关校验）→ business，不重试', () => {
  const text = JSON.stringify({
    type: 'server-response', rpcId: 'x',
    result: { ok: false, error: { code: 'session/prompt-conflict', message: 'busy', details: {} } },
  });
  assert.strictEqual(rpc.classifyResponse(200, text), 'business');
});

check('classifyResponse：非 JSON 500 无特征 → other', () => {
  assert.strictEqual(rpc.classifyResponse(500, 'internal explosion'), 'other');
});

console.log('---- summary: ' + pass + '/' + (pass + fail) + ' passed ----');
process.exit(fail > 0 ? 1 : 0);
