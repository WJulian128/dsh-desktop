'use strict';

/**
 * 定时任务/提醒调度器。
 * 任务规格（存于 settings.json 的 scheduledTasks）：
 *   { id, label, kind: 'reminder'|'task', mode: 'once'|'daily'|'interval',
 *     at: 'HH:MM'（once/daily）, everyMinutes: N（interval）, task: 文本, enabled, lastRun }
 * 触发语义：
 *   once     —— 到达当天 at 后触发一次，触发后自动停用；
 *   daily    —— 每天 at 触发一次（lastRun 记录当天已触发，跨天重置）；
 *   interval —— 距上次触发每 everyMinutes 分钟一次（应用运行期间）。
 */

/** 解析 'HH:MM' 为当天的时间戳（ms）。 */
function todayAt(hhmm, now = Date.now()) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
  if (!match) return null;
  const d = new Date(now);
  d.setHours(parseInt(match[1], 10), parseInt(match[2], 10), 0, 0);
  return d.getTime();
}

/** 判断任务此刻是否到期（纯函数，便于测试）。 */
function isDue(task, now = Date.now()) {
  if (!task || task.enabled === false) return false;
  const last = typeof task.lastRun === 'number' ? task.lastRun : null;
  if (task.mode === 'interval') {
    const minutes = Number(task.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) return false;
    const interval = minutes * 60 * 1000;
    const base = last || now - interval - 1; // 首次立即视为到期？不：首次从启动后每 N 分钟
    return now - base >= interval;
  }
  const at = todayAt(task.at, now);
  if (at === null) return false;
  if (task.mode === 'daily') {
    return now >= at && (last === null || last < at);
  }
  // once
  return now >= at && last === null;
}

/** 触发后要写回任务的变化。 */
function afterFireUpdate(task, now = Date.now()) {
  const update = { ...task, lastRun: now };
  if (task.mode === 'once') update.enabled = false;
  return update;
}

/** 计算下次触发时间描述（用于 UI 展示）。 */
function nextFireText(task, now = Date.now()) {
  if (!task || task.enabled === false) return '已停用';
  if (task.mode === 'interval') return '每 ' + Number(task.everyMinutes) + ' 分钟';
  const at = todayAt(task.at, now);
  if (at === null) return '时间格式无效';
  if (task.mode === 'daily') return '每天 ' + String(task.at).trim();
  return '单次 ' + String(task.at).trim();
}

/** 生成任务 id。 */
function newTaskId() {
  return 'sched-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 调度器：每 tickMs 检查一次任务列表（通过 getTasks 实时读取，天然支持设置热加载）。
 */
class Scheduler {
  constructor({ getTasks, onFire, tickMs = 20000, log = () => {} }) {
    this.getTasks = getTasks;
    this.onFire = onFire;
    this.tickMs = tickMs;
    this.log = log;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.log('[schedule] 调度器已启动（每 ' + this.tickMs / 1000 + ' 秒检查）');
  }

  tick(now = Date.now()) {
    let tasks;
    try { tasks = this.getTasks() || []; } catch (err) { this.log('[schedule] 读取任务失败：' + (err && err.message ? err.message : err)); return; }
    for (const task of tasks) {
      if (isDue(task, now)) {
        try { this.onFire(task, now); } catch (err) { this.log('[schedule] 触发失败：' + (err && err.message ? err.message : err)); }
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Scheduler, isDue, todayAt, afterFireUpdate, nextFireText, newTaskId };
