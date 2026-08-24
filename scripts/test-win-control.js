// win-control 编译与安全操作自测：screen / window list / active / clipboard get。
'use strict';
const { exec, ensureCompiled } = require('../main/win-control.js');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

try {
  const bin = ensureCompiled();
  check('win-control compiled', !!bin, bin);

  const screen = exec(['screen']);
  check('screen info', screen && screen.width > 0 && screen.height > 0, JSON.stringify(screen));

  const list = exec(['window', 'list']);
  check('window list works', list && Array.isArray(list.windows) && list.windows.length > 0, 'count=' + (list && list.windows && list.windows.length));

  const active = exec(['window', 'active']);
  check('active window works', active && typeof active.title === 'string', active && active.title);

  exec(['clipboard', 'set', '--text', 'dsh-self-test-你好']);
  const clip = exec(['clipboard', 'get']);
  check('clipboard roundtrip', clip && clip.text === 'dsh-self-test-你好', clip && clip.text);

  const pos = exec(['mouse', 'position']);
  check('mouse position works', pos && typeof pos.x === 'number' && typeof pos.y === 'number', JSON.stringify(pos));
} catch (err) {
  check('win-control ops', false, (err && err.message) || String(err));
}

if (failures.length) { console.log('WIN-CONTROL FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('WIN-CONTROL OK');
