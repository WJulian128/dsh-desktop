// updater 事务化纯函数单测（快照 / 恢复 / 版本校验），纯 Node 不依赖 Electron：
//  - backupPackageJson：安装前把 package.json 快照到 destDir，并校验 dsh 依赖存在
//  - restorePackageJson：失败时用快照恢复 package.json（回滚点）
//  - verifyInstalledVersion：安装后校验实际安装版本 === 目标版本（假 node_modules 结构）
// 用法：node scripts\test-updater.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupPackageJson, restorePackageJson, verifyInstalledVersion } = require('../main/updater');

const failures = [];
let count = 0;
function check(name, ok, detail) {
  count++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-test-'));
const mk = (dir) => fs.mkdirSync(dir, { recursive: true });

const ORIG = JSON.stringify({
  name: 'dsh-desktop-runtime',
  private: true,
  dependencies: { '@deepseek-ai/dsh': '0.1.1-rc.2' },
}, null, 2) + '\n';

// 1. backupPackageJson：快照到 destDir 并返回描述
{
  const appDir = path.join(root, 'app1');
  const snapDir = path.join(root, 'snap1');
  mk(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), ORIG, 'utf8');
  const snap = backupPackageJson(appDir, snapDir);
  check('backup returns { file, content, version }', !!(snap && typeof snap.file === 'string' && typeof snap.content === 'string' && typeof snap.version === 'string'), JSON.stringify(snap));
  check('backup copies package.json to destDir', fs.existsSync(snap.file) && fs.readFileSync(snap.file, 'utf8') === ORIG, '');
  check('snapshot content identical to original', snap.content === ORIG, '');
  check('snapshot records dsh version', snap.version === '0.1.1-rc.2', snap.version);
}

// 2. backupPackageJson：package.json 缺失 → 抛错
{
  const appDir = path.join(root, 'app-missing');
  mk(appDir);
  let threw = false;
  try { backupPackageJson(appDir, path.join(root, 'snap-missing')); } catch (err) { threw = /package\.json/.test(String(err.message)); }
  check('backup throws when package.json missing', threw, '');
}

// 3. backupPackageJson：未声明 dsh 依赖 → 抛错（前置校验 dsh 包存在）
{
  const appDir = path.join(root, 'app-nodsh');
  mk(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { other: '^1.0.0' } }), 'utf8');
  let threw = false;
  try { backupPackageJson(appDir, path.join(root, 'snap-nodsh')); } catch (err) { threw = /@deepseek-ai\/dsh/.test(String(err.message)); }
  check('backup throws when dsh not declared', threw, '');
}

// 4. restorePackageJson：把"半更新"后的 package.json 恢复为快照
{
  const appDir = path.join(root, 'app2');
  const snapDir = path.join(root, 'snap2');
  mk(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), ORIG, 'utf8');
  const snap = backupPackageJson(appDir, snapDir);
  // 模拟 npm install 中途失败：manifest 已指向新版本
  fs.writeFileSync(path.join(appDir, 'package.json'), ORIG.replace('0.1.1-rc.2', '9.9.9'), 'utf8');
  const ok = restorePackageJson(appDir, snap);
  check('restore returns true', ok === true, '');
  check('restore reverts package.json to snapshot', fs.readFileSync(path.join(appDir, 'package.json'), 'utf8') === ORIG, '');
}

// 5. restorePackageJson：null 快照为 no-op（不写文件）
{
  const appDir = path.join(root, 'app3');
  mk(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), ORIG, 'utf8');
  const ok = restorePackageJson(appDir, null);
  check('restore(null) returns false', ok === false, '');
  check('restore(null) leaves file untouched', fs.readFileSync(path.join(appDir, 'package.json'), 'utf8') === ORIG, '');
}

// 6. restorePackageJson：无 content 字段时从快照文件恢复
{
  const appDir = path.join(root, 'app4');
  const snapDir = path.join(root, 'snap4');
  mk(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), ORIG, 'utf8');
  const snap = backupPackageJson(appDir, snapDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), 'broken', 'utf8');
  const ok = restorePackageJson(appDir, { file: snap.file });
  check('restore from file-only snapshot', ok === true && fs.readFileSync(path.join(appDir, 'package.json'), 'utf8') === ORIG, '');
}

// 7. verifyInstalledVersion：假 node_modules 结构
{
  const appDir = path.join(root, 'app5');
  const pkgDir = path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh');
  mk(pkgDir);
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }), 'utf8');
  check('verify matches installed version', verifyInstalledVersion(appDir, '0.2.0') === true, '');
  check('verify rejects mismatched version', verifyInstalledVersion(appDir, '0.1.0') === false, '');
  check('verify rejects absent install (0.0.0 fallback)', verifyInstalledVersion(path.join(root, 'app-empty'), '0.2.0') === false, '');
  // fallbackDir：appDir 无安装时回退到内置副本
  check('verify uses fallbackDir when appDir absent', verifyInstalledVersion(path.join(root, 'app-empty'), '0.2.0', appDir) === true, '');
}

// 8. 端到端事务语义：备份 → 半更新 → 恢复后与原 manifest 一致
{
  const appDir = path.join(root, 'app6');
  const snapDir = path.join(root, 'snap6');
  mk(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), ORIG, 'utf8');
  const snap = backupPackageJson(appDir, snapDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), ORIG.replace('0.1.1-rc.2', '9.9.9'), 'utf8');
  restorePackageJson(appDir, snap);
  check('end-to-end rollback restores manifest', fs.readFileSync(path.join(appDir, 'package.json'), 'utf8') === ORIG, '');
}

// 清理
fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.log('UPDATER FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('UPDATER OK (' + count + ' checks)');
