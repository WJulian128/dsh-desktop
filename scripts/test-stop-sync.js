// 停止联动单测（host 半边）：官方"停止"（turn/end aborted）→ 自动递归终止运行中的子代理。
// 用 mock ctx 捕获监听，验证 session/event 的判定与 subagents.interrupt 调用。
// 用法：node scripts\test-stop-sync.js
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'packages', 'settings-update', 'lib', 'index.js')).href);
  check('host half exports apply', typeof mod.apply === 'function', '');

  // 模拟 ctx：捕获 session/event 监听 + 提供 subagents 服务（含 listChildren/interrupt）
  let handler = null;
  const interrupts = [];
  const childMap = {}; // parentSessionId -> children 数组（测试填充）
  const subagents = {
    listChildren: async (parent) => (childMap['' + parent]) || [],
    interrupt: async (target, authority) => { interrupts.push({ target, authority }); },
  };
  const ctx = {
    get: (name) => (name === 'subagents' ? subagents : undefined),
    on: (event, fn) => { if (event === 'session/event') handler = fn; },
  };
  mod.apply(ctx);
  check('listens session/event', typeof handler === 'function', '');

  const event = (type, data) => ({ type, data });
  const session = (id) => ({ id });

  // 1. 非 turn/end 事件不触发
  await handler(session('s1'), event('step/start', {}));
  check('ignores non turn/end events', interrupts.length === 0, '');

  // 2. turn/end 正常结束（completed）不触发
  await handler(session('s1'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  check('ignores normal turn end', interrupts.length === 0, '');

  // 3. turn/end aborted（用户停止）→ 终止运行中的子代理
  childMap['s1'] = [
    { id: 'sub-a', activity: 'running' },
    { id: 'sub-b', activity: 'inactive' },
    { id: 'sub-c', activity: 'running' },
  ];
  childMap['sub-a'] = [{ id: 'sub-a1', activity: 'running' }];
  await handler(session('s1'), event('turn/end', { turn: 2, reason: { kind: 'aborted', reason: new Error('cancelled') } }));
  check('interrupts running children on aborted', interrupts.length >= 2 && interrupts.some((i) => i.target === 'sub-a') && interrupts.some((i) => i.target === 'sub-c'), JSON.stringify(interrupts.map((i) => i.target)));
  check('skips inactive child', !interrupts.some((i) => i.target === 'sub-b'), '');
  check('recurses into running child tree', interrupts.some((i) => i.target === 'sub-a1'), JSON.stringify(interrupts.map((i) => i.target)));
  check('authority is user + direct parent', interrupts.every((i) => i.authority && i.authority.kind === 'user' && i.authority.parentSessionId), '');

  // 4. 无子代理时不报错
  interrupts.length = 0;
  childMap['s2'] = [];
  await handler(session('s2'), event('turn/end', { reason: { kind: 'aborted' } }));
  check('aborted without children is no-op', interrupts.length === 0, '');

  // 5. subagents 服务缺失时静默
  const ctxNoSubs = { get: () => undefined, on: (e, fn) => { if (e === 'session/event') handler = fn; } };
  mod.apply(ctxNoSubs);
  await handler(session('s1'), event('turn/end', { reason: { kind: 'aborted' } }));
  check('missing subagents service is silent', true, '');

  if (failures.length) { console.log('STOP-SYNC FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('STOP-SYNC OK');
})();
