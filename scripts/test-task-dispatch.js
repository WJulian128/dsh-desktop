// task-dispatch 纯函数单元测试：队列顺序 / 状态门控 / 重试上限 / 满队列丢弃策略。
// 用法：node scripts\test-task-dispatch.js
'use strict';
const {
  DEFAULT_MAX_QUEUE,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  makeTask,
  createTaskQueue,
  shouldDispatch,
  shouldRetry,
  retryDelayMs,
  nextToProcess,
  afterAttempt,
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

  // ── 汇总 ─────────────────────────────────────────────────────────────
  if (failures.length) { console.log('TASK-DISPATCH FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('TASK-DISPATCH OK (' + passed + ' checks)');
})();
