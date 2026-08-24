// 调度器单元测试：isDue / todayAt / afterFireUpdate / Scheduler.tick。
// 用法：node scripts\test-schedule.js
'use strict';
const { Scheduler, isDue, todayAt, afterFireUpdate, nextFireText, newTaskId } = require('../main/schedule.js');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

const T = new Date(2026, 7, 14, 10, 0, 0).getTime(); // 2026-08-14 10:00 本地时间基准

// todayAt
check('todayAt 09:00', todayAt('09:00', T) === new Date(2026, 7, 14, 9, 0, 0).getTime(), '');
check('todayAt invalid', todayAt('25:00', T) === null && todayAt('9x', T) === null, '');

// once：未触发且已过点 → due；触发后停用
const once = { id: 'a', kind: 'reminder', mode: 'once', at: '09:00', task: 'x', enabled: true, lastRun: null };
check('once due before fired', isDue(once, T) === true, '');
check('once not due before time', isDue(once, new Date(2026, 7, 14, 8, 0).getTime()) === false, '');
check('once not due after fired', isDue({ ...once, lastRun: T - 1000 }, T) === false, '');
check('once disabled not due', isDue({ ...once, enabled: false }, T) === false, '');
check('afterFireUpdate once disables', afterFireUpdate(once, T).enabled === false && typeof afterFireUpdate(once, T).lastRun === 'number', '');

// daily：当天触发一次；第二天重新触发
const daily = { id: 'b', kind: 'reminder', mode: 'daily', at: '09:00', task: 'x', enabled: true, lastRun: null };
check('daily due first time', isDue(daily, T) === true, '');
check('daily not due again same day', isDue({ ...daily, lastRun: new Date(2026, 7, 14, 9, 0, 10).getTime() }, T) === false, '');
check('daily due next day', isDue({ ...daily, lastRun: new Date(2026, 7, 14, 9, 0, 10).getTime() }, new Date(2026, 7, 15, 10, 0).getTime()) === true, '');
check('daily keeps enabled after fire', afterFireUpdate(daily, T).enabled === true, '');

// interval
const interval = { id: 'c', kind: 'task', mode: 'interval', everyMinutes: 5, task: 'x', enabled: true, lastRun: null };
check('interval not due immediately after start', isDue({ ...interval, lastRun: T }, T + 60 * 1000) === false, '');
check('interval due after N minutes', isDue({ ...interval, lastRun: T }, T + 5 * 60 * 1000) === true, '');

// Scheduler tick：一次 tick 触发多个到期任务并回调
const fired = [];
const scheduler = new Scheduler({ getTasks: () => [once, daily, { ...interval, lastRun: T }], onFire: (task) => fired.push(task.id), tickMs: 60000 });
scheduler.tick(T + 5 * 60 * 1000);
check('scheduler fires due tasks', fired.length === 3 && fired.includes('a') && fired.includes('b') && fired.includes('c'), fired.join(','));
scheduler.stop();

// 辅助
check('nextFireText', nextFireText(daily, T).includes('每天 09:00') && nextFireText({ ...once, enabled: false }, T) === '已停用', '');
check('newTaskId unique', newTaskId() !== newTaskId(), '');

if (failures.length) { console.log('SCHEDULE FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('SCHEDULE OK');
