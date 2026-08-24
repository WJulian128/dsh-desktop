// 通知免打扰时段判定单测（main/quiet-hours.js 纯函数）：
//  - inQuietHours：跨午夜、全天、非法输入、边界时刻
//  - parseTime："HH:MM" 解析与非法输入
// 用法：node scripts\test-quiet-hours.js
'use strict';
const { inQuietHours, parseTime } = require('../main/quiet-hours');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 1. parseTime 基本解析
check('parseTime 23:00 = 1380', parseTime('23:00') === 1380, 'got ' + parseTime('23:00'));
check('parseTime 07:00 = 420', parseTime('07:00') === 420, 'got ' + parseTime('07:00'));
check('parseTime 0:05 = 5（允许非补零）', parseTime('0:05') === 5, 'got ' + parseTime('0:05'));
check('parseTime 非法 25:00 = null', parseTime('25:00') === null, '');
check('parseTime 非法 12:60 = null', parseTime('12:60') === null, '');
check('parseTime 非法 12:3 = null', parseTime('12:3') === null, '');
check('parseTime 非法 12-30 = null', parseTime('12-30') === null, '');
check('parseTime 非字符串 = null', parseTime(2300) === null, '');

// 2. 未启用 / 非法配置一律 false
check('未启用 → false', inQuietHours({ enabled: false, start: '23:00', end: '07:00' }, '23:30') === false, '');
check('启用但开始非法 → false', inQuietHours({ enabled: true, start: '99:00', end: '07:00' }, '23:30') === false, '');
check('启用但结束非法 → false', inQuietHours({ enabled: true, start: '23:00', end: '99:00' }, '23:30') === false, '');
check('null 配置 → false', inQuietHours(null, '23:30') === false, '');

// 3. 跨午夜 23:00-07:00
check('23:00 跨午夜开始 → true（含边界）', inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, '23:00') === true, '');
check('23:59 跨午夜 → true', inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, '23:59') === true, '');
check('00:00 跨午夜凌晨 → true', inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, '00:00') === true, '');
check('06:59 跨午夜 → true', inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, '06:59') === true, '');
check('07:00 结束边界 → false（不含结束）', inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, '07:00') === false, '');
check('22:59 跨午夜之外 → false', inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, '22:59') === false, '');

// 4. 普通区间 07:00-23:00（不跨午夜）
check('12:00 普通区间 → true', inQuietHours({ enabled: true, start: '07:00', end: '23:00' }, '12:00') === true, '');
check('07:00 普通区间开始 → true（含边界）', inQuietHours({ enabled: true, start: '07:00', end: '23:00' }, '07:00') === true, '');
check('23:00 普通区间结束 → false（不含结束）', inQuietHours({ enabled: true, start: '07:00', end: '23:00' }, '23:00') === false, '');
check('06:59 普通区间之外 → false', inQuietHours({ enabled: true, start: '07:00', end: '23:00' }, '06:59') === false, '');

// 5. start === end → 全天免打扰
check('start=end 全天 → true', inQuietHours({ enabled: true, start: '00:00', end: '00:00' }, '12:34') === true, '');
check('start=end 全天任意时刻 → true', inQuietHours({ enabled: true, start: '12:00', end: '12:00' }, '23:59') === true, '');

// 6. Date / 时间戳入参
check('Date 入参 23:30 跨午夜 → true',
  inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, new Date(2026, 0, 1, 23, 30)) === true, '');
check('时间戳入参 23:30 跨午夜 → true',
  inQuietHours({ enabled: true, start: '23:00', end: '07:00' }, new Date(2026, 0, 1, 23, 30).getTime()) === true, '');

if (failures.length) { console.log('QUIET-HOURS FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('QUIET-HOURS OK (' + failures.length + ' failures)');
