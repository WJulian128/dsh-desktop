'use strict';

// 升级防护状态/判定单测（main/upgrade-guard.js）。
// 用法：node scripts/test-upgrade-guard.js

const assert = require('node:assert');
const guard = require('../main/upgrade-guard');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
    pass += 1;
  } catch (err) {
    console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err));
    fail += 1;
  }
}

/* ---- guardForUpdate / markApplied ---- */
check('guardForUpdate 记录 prev（回滚依据）与 in-progress', () => {
  const g = guard.guardForUpdate({ installed: '0.1.1-rc.2', target: '0.1.2-rc.1' });
  assert.strictEqual(g.status, 'in-progress');
  assert.strictEqual(g.prev, '0.1.1-rc.2');
  assert.strictEqual(g.version, '0.1.2-rc.1');
  assert.ok(typeof g.startedAt === 'string' && g.startedAt.length > 0);
});

check('markApplied 保留 prev 并切到 applied', () => {
  const g = guard.markApplied(guard.guardForUpdate({ installed: '0.1.1-rc.2', target: '0.1.2-rc.1' }));
  assert.strictEqual(g.status, 'applied');
  assert.strictEqual(g.prev, '0.1.1-rc.2');
});

/* ---- shouldSmoke ---- */
check('shouldSmoke：无 lastGood 需要冒烟', () => {
  assert.strictEqual(guard.shouldSmoke('0.1.2-rc.1', null), true);
  assert.strictEqual(guard.shouldSmoke('0.1.2-rc.1', ''), true);
});
check('shouldSmoke：版本不同需要冒烟', () => {
  assert.strictEqual(guard.shouldSmoke('0.1.2-rc.1', '0.1.1-rc.2'), true);
});
check('shouldSmoke：版本相同不冒烟（正常启动零打扰）', () => {
  assert.strictEqual(guard.shouldSmoke('0.1.2-rc.1', '0.1.2-rc.1'), false);
});
check('shouldSmoke：哨兵 0.0.0/空版本不冒烟', () => {
  assert.strictEqual(guard.shouldSmoke('0.0.0', '0.0.0'), false);
  assert.strictEqual(guard.shouldSmoke('', null), false);
});

/* ---- triageUpgradeBootFailure ---- */
check('triage：升级后首启失败（applied+版本变化+有 prev）→ 提示回滚', () => {
  const t = guard.triageUpgradeBootFailure({
    installed: '0.1.2-rc.1', lastGood: '0.1.1-rc.2',
    guard: guard.markApplied(guard.guardForUpdate({ installed: '0.1.1-rc.2', target: '0.1.2-rc.1' })),
  });
  assert.strictEqual(t.newVersion, true);
  assert.strictEqual(t.prev, '0.1.1-rc.2');
  assert.strictEqual(t.promptRollback, true);
});

check('triage：applied 但冒烟已通过的版本（lastGood 一致）→ 不回滚', () => {
  const t = guard.triageUpgradeBootFailure({
    installed: '0.1.2-rc.1', lastGood: '0.1.2-rc.1',
    guard: guard.markApplied(guard.guardForUpdate({ installed: '0.1.1-rc.2', target: '0.1.2-rc.1' })),
  });
  assert.strictEqual(t.newVersion, false);
  assert.strictEqual(t.promptRollback, false);
});

check('triage：同版本重装失败（applied 且版本未变）→ 不回滚', () => {
  const t = guard.triageUpgradeBootFailure({
    installed: '0.1.2-rc.1', lastGood: '0.1.2-rc.1',
    guard: guard.markApplied(guard.guardForUpdate({ installed: '0.1.2-rc.1', target: '0.1.2-rc.1' })),
  });
  assert.strictEqual(t.promptRollback, false);
});

check('triage：无事务 + 版本变化（手动升级）→ 无 prev 不可回滚', () => {
  const t = guard.triageUpgradeBootFailure({ installed: '0.1.3', lastGood: '0.1.2-rc.1', guard: null });
  assert.strictEqual(t.newVersion, false); // 没有事务就不当“升级首启”处理
  assert.strictEqual(t.promptRollback, false);
  assert.strictEqual(t.prev, null);
});

check('triage：无事务且版本未变 → 普通失败', () => {
  const t = guard.triageUpgradeBootFailure({ installed: '0.1.2-rc.1', lastGood: '0.1.2-rc.1', guard: null });
  assert.strictEqual(t.newVersion, false);
  assert.strictEqual(t.promptRollback, false);
});

/* ---- classifyBootFailure（使用真实事故日志片段） ---- */
check('classify：插件树整体失败', () => {
  const c = guard.classifyBootFailure('Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include)');
  assert.strictEqual(c.kind, 'plugin-tree');
});

check('classify：loader entry 导入失败（升级事故主特征）', () => {
  const c = guard.classifyBootFailure('failed to import loader entry llm-provider-mimo (@dsh-desktop/llm-openai-compat): Cannot find package');
  assert.strictEqual(c.kind, 'loader-entry');
});

check('classify：ERR_MODULE_NOT_FOUND / Cannot find package', () => {
  assert.strictEqual(guard.classifyBootFailure('Error [ERR_MODULE_NOT_FOUND]: Cannot find package x').kind, 'module-not-found');
  assert.strictEqual(guard.classifyBootFailure('Cannot find package C:\\app\\index.js').kind, 'module-not-found');
});

check('classify：端口占用', () => {
  const c = guard.classifyBootFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:60107');
  assert.strictEqual(c.kind, 'port-busy');
});

check('classify：未知错误 → other（不吓唬用户）', () => {
  const c = guard.classifyBootFailure('some weird crash at line 42');
  assert.strictEqual(c.kind, 'other');
});

console.log('---- summary: ' + pass + '/' + (pass + fail) + ' passed ----');
process.exit(fail > 0 ? 1 : 0);
