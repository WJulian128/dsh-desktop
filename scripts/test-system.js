// 系统环境模块只读自测（真实机器）：体检、环境变量读取、右键菜单状态。
// 不执行任何修复/写入，避免改动用户系统。
'use strict';
const { doctor, envGet, envList, isContextMenuRegistered } = require('../main/system.js');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

const items = doctor();
check('doctor returns items', Array.isArray(items) && items.length >= 6, 'count=' + (items && items.length));
for (const i of items) {
  check('item ' + i.id + ' shape', !!i.title && typeof i.ok === 'boolean' && typeof i.detail === 'string', i.title);
}
const okCount = items.filter((i) => i.ok).length;
console.log('[info] 体检结果：' + okCount + '/' + items.length + ' 项正常');
for (const i of items) console.log('[info]   ' + (i.ok ? '✓' : '✗') + ' ' + i.title + ' — ' + i.detail + (i.fix ? ' [fix:' + i.fix.id + ']' : ''));

const pathValue = envGet('PATH');
check('envGet PATH', typeof pathValue === 'string' && pathValue.length > 0, (pathValue || '').slice(0, 60));

const vars = envList();
check('envList includes PATH', vars && typeof vars.PATH === 'string', '');

const ctx = isContextMenuRegistered();
check('context menu status readable', typeof ctx === 'boolean', 'registered=' + ctx);

if (failures.length) { console.log('SYSTEM FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('SYSTEM OK');
