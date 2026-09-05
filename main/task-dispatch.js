'use strict';

/**
 * 任务派发纯逻辑：状态门控、内存队列、分类退避重试、崩溃续发。
 *
 * 本模块不依赖 Electron / 主窗口 / 剪贴板，队列与决策部分全部是纯函数，
 * 可直接单测（scripts/test-task-dispatch.js）。main.js 只做接线：
 * 注入 isReady / sendTask / log / notifyFailure / onStateChanged（持久化钩子），
 * 把 ready 事件接到 flush()，并在启动时 restoreState() 恢复上次未完成的任务。
 *
 * 失败原因分类（P0-3，Claude Code 借鉴）：
 *  - auth / network：认证与网络类故障（RPC 401、cookie 失效、连接重置等），
 *    退避档 15s / 60s / 5m ×3 —— 期间桌面端/服务可能自愈（如自动重启 harness）。
 *  - quota：额度类信号（429 / quota / 余额不足），退避更长 60s / 5m / 15m。
 *  - generic：其余失败保持原 2s ×3 快节奏。
 */

const DEFAULT_MAX_QUEUE = 20;        // 内存队列上限：超过按丢弃策略处理
const DEFAULT_MAX_ATTEMPTS = 4;      // 1 次初始发送 + 最多 3 次重试

/** 分类退避表：失败原因 -> 各次重试前的等待毫秒（长度 = 重试次数上限）。 */
const RETRY_BACKOFF_MS = {
  auth: [15 * 1000, 60 * 1000, 5 * 60 * 1000],
  network: [15 * 1000, 60 * 1000, 5 * 60 * 1000],
  quota: [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000],
  generic: [2000, 2000, 2000],
};

const DEFAULT_RETRY_DELAY_MS = RETRY_BACKOFF_MS.generic[0]; // 兼容旧默认（2s）

let idCounter = 0;

/** 归一化任务对象（纯函数）。opts.attempts 用于崩溃恢复后接续计数。 */
function makeTask(text, opts = {}) {
  return {
    id: opts.id !== undefined && opts.id !== null ? String(opts.id) : 't' + (++idCounter),
    text: String(text),
    send: opts.send !== false, // false = 只粘贴不回车
    attempts: Number.isFinite(opts.attempts) && opts.attempts >= 0 ? Math.round(opts.attempts) : 0,
    maxAttempts: Number.isFinite(opts.maxAttempts) && opts.maxAttempts >= 1 ? Math.round(opts.maxAttempts) : DEFAULT_MAX_ATTEMPTS,
    enqueuedAt: opts.enqueuedAt || Date.now(),
    finishedAt: null,
  };
}

/**
 * 内存任务队列（纯函数）：FIFO；满队列时按 dropPolicy 处理。
 * @param {number} max 上限（默认 20）
 * @param {'drop-oldest'|'reject-newest'} dropPolicy
 *   drop-oldest：挤掉最旧（默认，保留最新意图）；
 *   reject-newest：拒绝新任务，队列不变。
 */
function createTaskQueue(max = DEFAULT_MAX_QUEUE, dropPolicy = 'drop-oldest') {
  const items = [];
  return {
    get size() { return items.length; },
    get max() { return max; },
    isFull() { return items.length >= max; },
    peek() { return items.length ? items[0] : null; },
    /** 入队。返回 { task, dropped }：task 为入队后的任务（reject-newest 时 null），dropped 为被丢弃的任务（无则 null）。 */
    enqueue(text, opts = {}) {
      const task = makeTask(text, opts);
      if (items.length >= max) {
        if (dropPolicy === 'reject-newest') return { task: null, dropped: task };
        const evicted = items.shift(); // drop-oldest：挤掉最旧
        items.push(task);
        return { task, dropped: evicted };
      }
      items.push(task);
      return { task, dropped: null };
    },
    /** 取出队首（无则 null）。 */
    dequeue() { return items.length ? items.shift() : null; },
    /** 只读快照。 */
    snapshot() { return items.slice(); },
    /** 整体替换队列内容（崩溃恢复用：跳过满队列丢弃策略，列表按序保留）。 */
    replace(list) {
      items.length = 0;
      for (const t of Array.isArray(list) ? list : []) {
        if (t && typeof t === 'object' && typeof t.text === 'string') items.push(t);
      }
    },
    /** 清空并返回全部。 */
    drain() { return items.splice(0); },
  };
}

/** 门控：只有 harness 处于 ready 阶段才允许派发（其余阶段任务留在队列等待）。 */
function shouldDispatch(phase) {
  return phase === 'ready';
}

/** 重试决策：已用次数未达上限则继续重试。 */
function shouldRetry(attemptsUsed, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  return attemptsUsed < maxAttempts;
}

/** 兼容旧接口：固定 baseMs（默认 2s）。新代码用 retryDelayMsFor(kind, attempt)。 */
function retryDelayMs(attempt, baseMs = DEFAULT_RETRY_DELAY_MS) {
  return baseMs;
}

/**
 * 失败原因分类（纯函数）。从错误对象（message/code）与文本中识别：
 *  - quota：额度/限流信号（429、quota、rate limit、余额不足）
 *  - auth：认证类（401、unauthorized、cookie、token 失效）
 *  - network：网络/连接类（econn、timeout、socket、proxy、fetch failed）
 *  - generic：其余一律归通用
 * 未知/空错误归 generic（调用方要分类就应在 sendTask 里抛带信息的错误）。
 */
function classifyFailure(error) {
  const err = error instanceof Error ? error : (typeof error === 'object' && error !== null ? error : null);
  const text = String(
    (err && (err.message || err.code)) ||
    (typeof error === 'string' ? error : '') ||
    ''
  ).toLowerCase();
  if (!text) return 'generic';
  if (/quota|429|rate\s*limit|too\s*many\s*requests|insufficient|balance|billing|额度|余额|限流/i.test(text)) return 'quota';
  if (/401|403|unauthor|invalid\s*cookie|credentials?|认证|凭证|token.*(invalid|expired|失效)|登录态/i.test(text)) return 'auth';
  if (/econn|etimed|socket|timeout|timed?\s*out|network|fetch\s*failed|proxy|unreachable|enotfound|reset|网络|超时|连接/i.test(text)) return 'network';
  return 'generic';
}

/** 分类退避间隔：kind 档第 attempt 次（≥1）重试前的等待毫秒；超出档位长度用最后一档。 */
function retryDelayMsFor(kind, attempt, backoffs = RETRY_BACKOFF_MS) {
  const table = backoffs[kind] || backoffs.generic;
  const idx = Math.max(0, Math.min(table.length - 1, attempt - 1));
  return table[idx];
}

/** 队列 + 门控决策：当前应处理哪个任务（null = 不处理）。 */
function nextToProcess(queue, phase) {
  if (!shouldDispatch(phase)) return null;
  return queue.peek();
}

/**
 * 一次发送尝试之后的去向决策（纯函数，旧接口：固定间隔）。
 * @param {object} task 当前任务（attempts 为已用次数）
 * @param {boolean} ok 本次尝试是否成功
 * @returns {{kind:'done',task}|{kind:'retry',task,delayMs}|{kind:'failed',task}}
 */
function afterAttempt(task, ok, now = Date.now(), baseDelayMs = DEFAULT_RETRY_DELAY_MS) {
  const attempts = task.attempts + 1;
  if (ok) return { kind: 'done', task: { ...task, attempts, finishedAt: now } };
  if (shouldRetry(attempts, task.maxAttempts)) {
    return {
      kind: 'retry',
      task: { ...task, attempts, finishedAt: null },
      delayMs: retryDelayMs(attempts, baseDelayMs),
    };
  }
  return { kind: 'failed', task: { ...task, attempts, finishedAt: now } };
}

/**
 * 一次失败后的去向决策（新接口：按失败原因分类退避）。
 * @param {object} task 当前任务（attempts 为已用次数）
 * @param {unknown} [error] 本次尝试抛出的错误（用于分类；无错误 = generic）
 * @param {number} [now]
 * @param {object} [backoffs] 退避表（测试可注入快进；缺省用 RETRY_BACKOFF_MS）
 * @returns {{kind:'retry',task,delayMs}|{kind:'failed',task}}
 */
function afterAttemptClassified(task, error, now = Date.now(), backoffs = RETRY_BACKOFF_MS) {
  const attempts = task.attempts + 1;
  const kind = classifyFailure(error);
  if (shouldRetry(attempts, task.maxAttempts)) {
    return {
      kind: 'retry',
      task: { ...task, attempts, finishedAt: null },
      delayMs: retryDelayMsFor(kind, attempts, backoffs),
      reason: kind,
    };
  }
  return { kind: 'failed', task: { ...task, attempts, finishedAt: now }, reason: kind };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 状态化派发器：main.js 只做接线（注入 isReady/sendTask/log/notifyFailure/onStateChanged）。
 * 队列、门控、分类退避决策全部复用上面的纯函数；一次只处理一个任务。
 *
 * 崩溃续发（P0-3）：每次队列/重试状态变化都会触发 onStateChanged(snapshot)，
 * 由 main.js 落盘 userData；启动时把上次快照 restoreState 回来，ready 后继续发送，
 * 中断/重启不丢任务（在途重试任务记入 snapshot.pending）。
 */
class TaskDispatcher {
  constructor(options = {}) {
    this.queue = createTaskQueue(options.maxQueue, options.dropPolicy);
    this.isReady = typeof options.isReady === 'function' ? options.isReady : () => true;
    this.sendTask = typeof options.sendTask === 'function' ? options.sendTask : async () => true;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onDropped = typeof options.onDropped === 'function' ? options.onDropped : () => {};
    this.notifyFailure = typeof options.notifyFailure === 'function' ? options.notifyFailure : () => {};
    this.onStateChanged = typeof options.onStateChanged === 'function' ? options.onStateChanged : () => {};
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
    this.backoffs = options.backoffs && typeof options.backoffs === 'object' ? options.backoffs : RETRY_BACKOFF_MS;
    this.busy = false;
    this.stopped = false;
    this.retrying = null; // 正在等待下次重试的在途任务（已从队列取出，崩溃续发靠它）
  }

  get size() { return this.queue.size; }

  /** 当前可持久化状态：{ queue, pending }（queue=排队任务，pending=重试等待中的任务）。 */
  persistState() {
    return { queue: this.queue.snapshot(), pending: this.retrying };
  }

  /** 启动时恢复上次未完成的任务：queue 按原序 + pending（在途重试）排到最前继续重试。 */
  restoreState(saved) {
    if (!saved || typeof saved !== 'object') return;
    const restored = [];
    const pushRaw = (t) => {
      if (!t || typeof t !== 'object' || typeof t.text !== 'string') return;
      restored.push(makeTask(t.text, {
        id: t.id,
        send: t.send !== false,
        attempts: t.attempts,
        maxAttempts: t.maxAttempts,
        enqueuedAt: t.enqueuedAt,
      }));
    };
    const pending = saved.pending;
    if (pending) pushRaw(pending); // 在途重试任务优先
    for (const t of Array.isArray(saved.queue) ? saved.queue : []) pushRaw(t);
    this.queue.replace(restored);
    const count = this.queue.snapshot().length;
    if (count) this.log('[task-dispatch] 恢复上次未完成的任务：' + count + ' 个（含在途重试）');
    this.onStateChanged(this.persistState());
  }

  /** 入队并尝试立即处理（未就绪则留在队列，等 flush）。 */
  enqueue(text, opts = {}) {
    const { task, dropped } = this.queue.enqueue(text, opts);
    if (dropped) this.onDropped(dropped);
    if (task && !this.stopped) this.kick();
    this.onStateChanged(this.persistState());
    return task;
  }

  /** 就绪/重启后调用：补发积压队列。 */
  flush() {
    if (!this.stopped) this.kick();
  }

  kick() {
    if (this.stopped || this.busy || !this.isReady()) return; // 门控
    const task = this.queue.peek();
    if (!task) return;
    this.busy = true;
    this.processTask(task)
      .catch((err) => this.log('[task-dispatch] 处理异常：' + (err && err.message ? err.message : err)))
      .finally(() => {
        this.busy = false;
        if (!this.stopped) this.kick(); // 继续队列中的下一个
      });
  }

  async processTask(head) {
    let current = head;
    for (;;) {
      let ok = false;
      let error = null;
      try {
        ok = await this.sendTask(current);
      } catch (err) {
        error = err;
      }
      if (ok) {
        this.retrying = null;
        this.queue.dequeue(); // 发送成功：出队
        this.onStateChanged(this.persistState());
        return;
      }
      // 失败：按原因分类退避（auth/network 15s→60s→5m；quota 60s→5m→15m；其余 2s）
      const decision = afterAttemptClassified(current, error, Date.now(), this.backoffs);
      if (decision.kind === 'retry') {
        this.log('[task-dispatch] 发送失败（' + decision.reason + '，第 ' + decision.task.attempts + ' 次尝试），' +
          Math.round(decision.delayMs / 1000) + 's 后重试：' + String(current.text).slice(0, 80));
        // 在途任务记入持久化（崩溃/重启后续发；attempts 已含本次失败计数）
        this.retrying = decision.task;
        this.onStateChanged(this.persistState());
        await sleep(decision.delayMs);
        current = decision.task;
        continue;
      }
      // 最终失败：出队 + 记录 + 通知
      this.retrying = null;
      this.queue.dequeue();
      const reason = error && error.message ? error.message : String(error || '');
      this.log('[task-dispatch] 发送最终失败（' + decision.reason + '），任务放弃：' + String(current.text).slice(0, 120) + (reason ? '（' + reason + '）' : ''));
      this.onStateChanged(this.persistState());
      this.notifyFailure(current, error);
      return;
    }
  }

  stop() {
    this.stopped = true;
    this.retrying = null;
  }
}

module.exports = {
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
  sleep,
  TaskDispatcher,
};
