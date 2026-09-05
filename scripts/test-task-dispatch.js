// task-dispatch 纯函数单元测试：队列顺序 / 状态门控 / 重试上限 / 满队列丢弃策略。
// 用法：node scripts\test-task-dispatch.js
'use strict';
const {
  DEFAULT_MAX_QUEUE,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  RETRY_BACKOFF_MS,
  makeTask,
  createTaskQueue,
  shouldDispatch,
  shouldRetry,
  retryDelayMs,
  retryDelayMsFor,
  classifyFailure,
  nextToProcess,
  afterAttempt,
  afterAttemptClassified,
  TaskDispatcher,
} = require('../main/task-dispatch.js');

const failures = [];
let passed = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (ok) passed += 1; else failures.push(name);
}

// ── 1. makeTask 归一化 ────────────────────────────────────────────────
const t = makeTask('hello');
check('makeTask 默认 send=true / attempts=0 / maxAttempts=4', t.send === true && t.attempts === 0 && t.maxAttempts === DEFAULT_MAX_ATTEMPTS, 'send=' + t.send + ', attempts=' + t.attempts + ', maxAttempts=' + t.maxAttempts);
check('makeTask send=false 保留', makeTask('x', { send: false }).send === false, '');
check('makeTask 文本强制字符串', makeTask(123).text === '123', '');

// ── 2. 队列顺序（FIFO） ───────────────────────────────────────────────
const q = createTaskQueue(5);
q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
check('FIFO 出队顺序 a,b,c', q.dequeue().text === 'a' && q.dequeue().text === 'b' && q.dequeue().text === 'c' && q.size === 0, 'size=' + q.size);
q.enqueue('a'); q.enqueue('b');
check('peek 不改变队列', q.peek().text === 'a' && q.size === 2, 'peek=' + q.peek().text + ', size=' + q.size);

// ── 3. 状态门控 ──────────────────────────────────────────────────────
check('shouldDispatch ready=true', shouldDispatch('ready') === true, '');
check('shouldDispatch 非 ready 全部 false', shouldDispatch('starting') === false && shouldDispatch('error') === false && shouldDispatch('waiting-server') === false && shouldDispatch(null) === false && shouldDispatch(undefined) === false, '');
const gq = createTaskQueue(5);
check('nextToProcess 未就绪返回 null（即使有任务）', (gq.enqueue('a'), nextToProcess(gq, 'starting') === null), '');
check('nextToProcess 就绪返回队首', nextToProcess(gq, 'ready') !== null && nextToProcess(gq, 'ready').text === 'a', '');

// ── 4. 重试上限 ──────────────────────────────────────────────────────
check('shouldRetry 上限内继续重试', shouldRetry(0, 4) === true && shouldRetry(3, 4) === true, '');
check('shouldRetry 超过上限停止', shouldRetry(4, 4) === false && shouldRetry(5, 4) === false, '');
check('retryDelayMs 固定 2000ms', retryDelayMs(1) === DEFAULT_RETRY_DELAY_MS && retryDelayMs(3) === 2000, '');

// ── 5. 满队列丢弃策略 ────────────────────────────────────────────────
const qd = createTaskQueue(3, 'drop-oldest');
['a', 'b', 'c'].forEach((x) => qd.enqueue(x));
const d = qd.enqueue('d');
check('drop-oldest 挤掉最旧 a，保留 bcd', d.dropped !== null && d.dropped.text === 'a' && qd.snapshot().map((x) => x.text).join('') === 'bcd', 'dropped=' + (d.dropped && d.dropped.text) + ', queue=' + qd.snapshot().map((x) => x.text).join(''));
const qr = createTaskQueue(3, 'reject-newest');
['a', 'b', 'c'].forEach((x) => qr.enqueue(x));
const r = qr.enqueue('d');
check('reject-newest 拒绝新任务 d，队列不变', r.task === null && r.dropped.text === 'd' && qr.snapshot().map((x) => x.text).join('') === 'abc', 'queue=' + qr.snapshot().map((x) => x.text).join(''));
check('队列默认上限 20', createTaskQueue().max === DEFAULT_MAX_QUEUE && createTaskQueue().isFull() === false, 'max=' + createTaskQueue().max);

// ── 6. afterAttempt 决策（成功 / 重试 / 放弃） ────────────────────────
const ok1 = afterAttempt(makeTask('hello'), true);
check('afterAttempt 成功 → done 且 attempts=1', ok1.kind === 'done' && ok1.task.attempts === 1 && ok1.task.finishedAt !== null, 'kind=' + ok1.kind);
const f1 = afterAttempt(makeTask('x'), false);
check('afterAttempt 失败且未用尽 → retry + delay 2000', f1.kind === 'retry' && f1.delayMs === DEFAULT_RETRY_DELAY_MS && f1.task.attempts === 1, 'kind=' + f1.kind + ', delay=' + f1.delayMs);
const f2 = afterAttempt(makeTask('x', { maxAttempts: 1 }), false);
check('afterAttempt 用尽 → failed', f2.kind === 'failed' && f2.task.attempts === 1, 'kind=' + f2.kind);
let cur = makeTask('x');
for (let i = 0; i < 4; i++) cur = afterAttempt(cur, false).task;
check('连续失败 4 次后第 4 次决策为 failed（3 次重试封顶）', afterAttempt(cur, false).kind === 'failed', '');

// ── 7. TaskDispatcher 集成（假 sendTask，快进重试间隔） ────────────────
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 7a. 失败重试：共 4 次尝试、通知 1 次、队列清空
  let calls = 0, notified = 0;
  const failDisp = new TaskDispatcher({
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    retryDelayMs: 1,
    isReady: () => true,
    sendTask: async () => { calls += 1; throw new Error('boom'); },
    notifyFailure: () => { notified += 1; },
  });
  failDisp.enqueue('failing');
  while (failDisp.busy) await sleep(5);
  check('失败任务重试 3 次共 4 次尝试', calls === DEFAULT_MAX_ATTEMPTS, 'calls=' + calls);
  check('最终失败通知一次且队列清空', notified === 1 && failDisp.size === 0, 'notified=' + notified + ', size=' + failDisp.size);

  // 7b. 成功路径：一次发送即出队
  let sent = 0;
  const okDisp = new TaskDispatcher({ isReady: () => true, sendTask: async () => { sent += 1; return true; } });
  okDisp.enqueue('works');
  while (okDisp.busy) await sleep(5);
  check('成功发送一次且队列清空', sent === 1 && okDisp.size === 0, 'sent=' + sent + ', size=' + okDisp.size);

  // 7c. 门控集成：未就绪入队滞留 → 就绪后 flush 按序补发
  let ready = false;
  const sentTexts = [];
  const gateDisp = new TaskDispatcher({
    isReady: () => ready,
    sendTask: async (task) => { sentTexts.push(task.text); return true; },
  });
  gateDisp.enqueue('first'); gateDisp.enqueue('second');
  await sleep(5);
  check('未就绪时任务滞留队列且不发送', gateDisp.size === 2 && sentTexts.length === 0, 'size=' + gateDisp.size + ', sent=' + sentTexts.length);
  ready = true;
  gateDisp.flush();
  while (gateDisp.busy) await sleep(5);
  check('就绪后 flush 按序补发全部', gateDisp.size === 0 && sentTexts.join(',') === 'first,second', 'sent=' + sentTexts.join(','));

  // ── 8. 失败原因分类（P0-3） ───────────────────────────────────────────
  check('classifyFailure 401 → auth', classifyFailure(new Error('HTTP 401 Unauthorized')) === 'auth', '');
  check('classifyFailure cookie 失效 → auth', classifyFailure(new Error('认证 cookie 已失效')) === 'auth', '');
  check('classifyFailure 403 → auth', classifyFailure(new Error('request forbidden 403')) === 'auth', '');
  check('classifyFailure 429 → quota', classifyFailure(new Error('HTTP 429 Too Many Requests')) === 'quota', '');
  check('classifyFailure quota 文案 → quota', classifyFailure(new Error('rate limit exceeded')) === 'quota', '');
  check('classifyFailure 连接失败 → network', classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1')) === 'network', '');
  check('classifyFailure 超时 → network', classifyFailure(new Error('请求超时 timeout')) === 'network', '');
  check('classifyFailure 未知文案 → generic', classifyFailure(new Error('boom')) === 'generic', '');
  check('classifyFailure 空错误 → generic', classifyFailure(null) === 'generic' && classifyFailure(undefined) === 'generic', '');

  // ── 9. 分类退避档位（P0-3） ───────────────────────────────────────────
  check('auth/network 档 = 15s/60s/5m', RETRY_BACKOFF_MS.auth.join(',') === '15000,60000,300000' && RETRY_BACKOFF_MS.network.join(',') === RETRY_BACKOFF_MS.auth.join(','), '');
  check('quota 档更长 = 60s/5m/15m', RETRY_BACKOFF_MS.quota.join(',') === '60000,300000,900000', '');
  check('generic 档保持 2s', RETRY_BACKOFF_MS.generic.join(',') === '2000,2000,2000' && DEFAULT_RETRY_DELAY_MS === 2000, '');
  check('retryDelayMsFor 按档取间隔', retryDelayMsFor('auth', 1) === 15000 && retryDelayMsFor('auth', 2) === 60000 && retryDelayMsFor('auth', 3) === 300000, '');
  check('retryDelayMsFor 越界用最后一档', retryDelayMsFor('auth', 9) === 300000, '');
  check('retryDelayMsFor 未知档回退 generic', retryDelayMsFor('nope', 1) === 2000, '');
  const q1 = afterAttemptClassified(makeTask('x'), new Error('HTTP 401'));
  check('afterAttemptClassified auth 失败 → retry 15s', q1.kind === 'retry' && q1.reason === 'auth' && q1.delayMs === 15000, 'kind=' + q1.kind + ', reason=' + q1.reason + ', delay=' + q1.delayMs);
  const q2 = afterAttemptClassified(makeTask('x'), new Error('quota 余额不足'));
  check('afterAttemptClassified quota → retry 60s', q2.kind === 'retry' && q2.reason === 'quota' && q2.delayMs === 60000, '');
  const q3 = afterAttemptClassified(makeTask('x'), null);
  check('afterAttemptClassified 无错误 → generic 2s', q3.kind === 'retry' && q3.reason === 'generic' && q3.delayMs === 2000, '');
  const q4 = afterAttemptClassified(makeTask('x', { maxAttempts: 1 }), new Error('HTTP 401'));
  check('afterAttemptClassified 用尽 → failed（带 reason）', q4.kind === 'failed' && q4.reason === 'auth' && q4.task.attempts === 1, '');
  let qc = makeTask('x');
  for (let i = 0; i < 3; i++) qc = afterAttemptClassified(qc, new Error('HTTP 401')).task;
  check('auth 失败 3 次后第 4 次 failed', afterAttemptClassified(qc, new Error('HTTP 401')).kind === 'failed', '');
  check('makeTask 保留 attempts（恢复续发用）', makeTask('x', { attempts: 2 }).attempts === 2, 'attempts=' + makeTask('x', { attempts: 2 }).attempts);

  // ── 10. 分类退避集成：auth 错误走长退避（注入快进表） ──────────────────
  let authCalls = 0;
  let authNotified = 0;
  const fastAuth = { auth: [1, 1, 1] };
  const authDisp = new TaskDispatcher({
    backoffs: fastAuth,
    isReady: () => true,
    sendTask: async () => { authCalls += 1; throw new Error('HTTP 401 unauthorized'); },
    notifyFailure: () => { authNotified += 1; },
  });
  authDisp.enqueue('auth-task');
  while (authDisp.busy) await sleep(5);
  check('auth 错误按 maxAttempts 尝试 4 次', authCalls === DEFAULT_MAX_ATTEMPTS, 'calls=' + authCalls);
  check('auth 最终失败通知 1 次', authNotified === 1 && authDisp.size === 0, 'notified=' + authNotified);

  // ── 11. 崩溃续发：persistState/restoreState（P0-3） ────────────────────
  const snaps = [];
  const snapDisp = new TaskDispatcher({
    isReady: () => false, // 不发送：只验证状态快照
    onStateChanged: (s) => snaps.push({ queue: s.queue.map((t) => t.text).join(','), pending: s.pending ? s.pending.text : null }),
    sendTask: async () => true,
  });
  snapDisp.enqueue('a'); snapDisp.enqueue('b');
  check('入队触发状态快照（queue 含全部）', snaps.length >= 1 && snaps[snaps.length - 1].queue === 'a,b' && snaps[snaps.length - 1].pending === null, JSON.stringify(snaps[snaps.length - 1]));

  const saved = snapDisp.persistState();
  const sentTexts2 = [];
  const revivedSeenAttempts = [];
  const revived = new TaskDispatcher({
    isReady: () => true,
    sendTask: async (task) => { sentTexts2.push(task.text); revivedSeenAttempts.push(task.attempts); return true; },
  });
  revived.restoreState(saved);
  check('restoreState 恢复队列（含 attempts 保留）', revived.size === 2 && revived.persistState().queue[0].attempts === 0, 'size=' + revived.size);
  revived.flush();
  while (revived.busy) await sleep(5);
  check('恢复后按序补发 a,b', sentTexts2.join(',') === 'a,b', 'sent=' + sentTexts2.join(','));

  // 在途重试任务（pending）恢复：attempts 已含失败次数，恢复后放在队首
  const pendingSent = [];
  const pendingDisp = new TaskDispatcher({
    isReady: () => true,
    sendTask: async (task) => { pendingSent.push({ text: task.text, attempts: task.attempts }); return true; },
  });
  pendingDisp.restoreState({
    queue: [makeTask('later', { id: 'l1', attempts: 0 })],
    pending: makeTask('inflight', { id: 'p1', attempts: 2, maxAttempts: 4 }),
  });
  check('restoreState pending 置队首且 attempts=2', pendingDisp.size === 2 && pendingDisp.persistState().queue[0].id === 'p1' && pendingDisp.persistState().queue[0].attempts === 2, 'queue=' + pendingDisp.persistState().queue.map((t) => t.id).join(','));
  pendingDisp.flush();
  while (pendingDisp.busy) await sleep(5);
  check('恢复续发顺序：在途任务先发、attempts 接续', pendingSent.length === 2 && pendingSent[0].text === 'inflight' && pendingSent[0].attempts === 2 && pendingSent[1].text === 'later', JSON.stringify(pendingSent));

  // 重试中的在途任务进入持久化（pending 非空）：发送一次失败后快照含 pending
  const pendSnaps = [];
  let pendFailOnce = 0;
  const pendDisp = new TaskDispatcher({
    backoffs: { auth: [5, 5, 5] }, // 快速档：只验证 pending 持久化时机，不等真实 15s
    isReady: () => true,
    sendTask: async () => { pendFailOnce += 1; throw new Error('HTTP 401'); },
    onStateChanged: (s) => pendSnaps.push(s.pending ? s.pending.text + '@' + s.pending.attempts : null),
  });
  pendDisp.enqueue('retry-me');
  for (let i = 0; i < 50 && !pendSnaps.some((s) => s && s.indexOf('retry-me@') === 0); i++) await sleep(5);
  check('重试等待期 pending 已持久化（attempts=1）', pendFailOnce === 1 && pendSnaps.some((s) => s === 'retry-me@1'), 'calls=' + pendFailOnce + ', snaps=' + pendSnaps.join('|'));
  while (pendDisp.busy) await sleep(5); // 等快速退避跑完（5ms×3 次），进程可正常退出
  check('快速退避跑完后队列清空', pendDisp.size === 0 && pendFailOnce === DEFAULT_MAX_ATTEMPTS, 'calls=' + pendFailOnce);

  // ── 汇总 ─────────────────────────────────────────────────────────────
  if (failures.length) { console.log('TASK-DISPATCH FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('TASK-DISPATCH OK (' + passed + ' checks)');
})();
