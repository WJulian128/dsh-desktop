'use strict';

/**
 * 任务派发纯逻辑：状态门控、内存队列、重试决策。
 *
 * 本模块不依赖 Electron / 主窗口 / 剪贴板，队列与决策部分全部是纯函数，
 * 可直接单测（scripts/test-task-dispatch.js）。main.js 只做接线：
 * 注入 isReady / sendTask / log / notifyFailure，并把 ready 事件接到 flush()。
 */

const DEFAULT_MAX_QUEUE = 20;        // 内存队列上限：超过按丢弃策略处理
const DEFAULT_MAX_ATTEMPTS = 4;      // 1 次初始发送 + 最多 3 次重试
const DEFAULT_RETRY_DELAY_MS = 2000; // 重试间隔（固定 2s）

let idCounter = 0;

/** 归一化任务对象（纯函数）。 */
function makeTask(text, opts = {}) {
  return {
    id: opts.id !== undefined && opts.id !== null ? String(opts.id) : 't' + (++idCounter),
    text: String(text),
    send: opts.send !== false, // false = 只粘贴不回车
    attempts: 0,               // 已尝试次数（含重试）
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

/** 重试间隔（固定 baseMs，默认 2s；attempt 参数保留以便将来做退避策略）。 */
function retryDelayMs(attempt, baseMs = DEFAULT_RETRY_DELAY_MS) {
  return baseMs;
}

/** 队列 + 门控决策：当前应处理哪个任务（null = 不处理）。 */
function nextToProcess(queue, phase) {
  if (!shouldDispatch(phase)) return null;
  return queue.peek();
}

/**
 * 一次发送尝试之后的去向决策（纯函数）。
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 状态化派发器：main.js 只做接线（注入 isReady/sendTask/log/notifyFailure）。
 * 队列、门控、重试决策全部复用上面的纯函数；一次只处理一个任务。
 */
class TaskDispatcher {
  constructor(options = {}) {
    this.queue = createTaskQueue(options.maxQueue, options.dropPolicy);
    this.isReady = typeof options.isReady === 'function' ? options.isReady : () => true;
    this.sendTask = typeof options.sendTask === 'function' ? options.sendTask : async () => true;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.onDropped = typeof options.onDropped === 'function' ? options.onDropped : () => {};
    this.notifyFailure = typeof options.notifyFailure === 'function' ? options.notifyFailure : () => {};
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
    this.busy = false;
    this.stopped = false;
  }

  get size() { return this.queue.size; }

  /** 入队并尝试立即处理（未就绪则留在队列，等 flush）。 */
  enqueue(text, opts = {}) {
    const { task, dropped } = this.queue.enqueue(text, opts);
    if (dropped) this.onDropped(dropped);
    if (task && !this.stopped) this.kick();
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
        this.queue.dequeue(); // 发送成功：出队
        return;
      }
      const decision = afterAttempt(current, false, Date.now(), this.retryDelayMs);
      if (decision.kind === 'retry') {
        this.log('[task-dispatch] 发送失败（第 ' + decision.task.attempts + ' 次尝试），' + decision.delayMs + 'ms 后重试：' + String(current.text).slice(0, 80));
        await sleep(decision.delayMs);
        current = decision.task;
        continue;
      }
      // 最终失败：出队 + 记录 + 通知
      this.queue.dequeue();
      const reason = error && error.message ? error.message : String(error || '');
      this.log('[task-dispatch] 发送最终失败，任务放弃：' + String(current.text).slice(0, 120) + (reason ? '（' + reason + '）' : ''));
      this.notifyFailure(current, error);
      return;
    }
  }

  stop() {
    this.stopped = true;
  }
}

module.exports = {
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
  sleep,
  TaskDispatcher,
};
