// 项目代码地图模块测试（main/project-map.js）：
// 建图/读图/状态/指纹扫描/stale 判定（mtime+size）/删除文件判定/空 map 拒绝。
// 用法：node scripts\test-project-map.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pm = require('../main/project-map');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 临时工作区
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
const files = { 'src/a.js': 'console.log(1)\n', 'src/b.ts': 'export const x = 1\n', 'README.md': '# hello\n' };
for (const [rel, content] of Object.entries(files)) {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

// 1. 初始状态：无地图
{
  const s = pm.mapStatus(ws);
  check('mapStatus initial: not exists', s.exists === false && s.tracked === 0, JSON.stringify(s));
  check('readMap initial: null', pm.readMap(ws) === null, '');
  check('readState initial: null', pm.readState(ws) === null, '');
}

// 2. 空 map 拒绝
{
  const r = pm.saveMap(ws, { map: '   ' });
  check('saveMap rejects empty map', r.ok === false, JSON.stringify(r));
  check('no files written after reject', !fs.existsSync(pm.mapPath(ws)), '');
}

// 3. 建图（全自动扫描指纹）
{
  const r = pm.saveMap(ws, { map: '# 地图\n- 模块 src\n', gitHead: 'abc123', updatedBySession: 'session-1' });
  check('saveMap ok + scanned', r.ok === true && r.scanned === 3 && r.tracked === 3, JSON.stringify(r));
  check('map file written', pm.readMap(ws) === '# 地图\n- 模块 src\n', '');
  const st = pm.readState(ws);
  check('state written with gitHead', st && st.gitHead === 'abc123' && st.updatedBySession === 'session-1', JSON.stringify(st));
}

// 4. 全最新：stale 0
{
  const s = pm.mapStatus(ws, { currentGitHead: 'abc123' });
  check('mapStatus fresh: 0 stale', s.exists && s.staleCount === 0, JSON.stringify(s));
}

// 5. 文件内容变化（size 变化）→ stale
{
  fs.writeFileSync(path.join(ws, 'src/a.js'), 'console.log(123)\n', 'utf8');
  const s = pm.mapStatus(ws, { currentGitHead: 'abc123' });
  check('mapStatus detects content change', s.staleCount === 1 && s.staleFiles.includes('src/a.js'), JSON.stringify(s));
}

// 6. mtime 变化（touch）→ stale
{
  const f = path.join(ws, 'src/b.ts');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
  const s = pm.mapStatus(ws);
  check('mapStatus detects mtime change', s.staleCount === 2, JSON.stringify(s.staleFiles));
}

// 7. 文件删除 → stale（已删除）
{
  fs.rmSync(path.join(ws, 'README.md'));
  const s = pm.mapStatus(ws);
  check('mapStatus detects deletion', s.staleCount === 3 && s.staleFiles.some((f) => f.includes('已删除')), JSON.stringify(s.staleFiles));
}

// 8. git HEAD 变化提示
{
  const s = pm.mapStatus(ws, { currentGitHead: 'def456' });
  check('mapStatus reports gitHeadChanged', s.gitHeadChanged === true, JSON.stringify(s));
}

// 9. 增量补图：只更新部分文件指纹（files 参数），其余保留
{
  const bOrig = fs.statSync(path.join(ws, 'src/b.ts')).size;
  const r = pm.saveMap(ws, { map: '# 地图 v2\n', files: ['src/a.js'], gitHead: 'def456', updatedBySession: 'session-2' });
  check('saveMap incremental scan', r.ok === true && r.scanned === 1, JSON.stringify(r));
  const st = pm.readState(ws);
  check('state keeps old fingerprint for b.ts', st && st.files['src/b.ts'] && st.files['src/b.ts'].size === bOrig, JSON.stringify(st && st.files));
  const s = pm.mapStatus(ws, { currentGitHead: 'def456' });
  // b.ts 与 README.md 仍 stale（未被本次重读覆盖），a.js 已更新
  check('mapStatus after incremental update', s.staleCount === 2 && !s.staleFiles.includes('src/a.js'), JSON.stringify(s.staleFiles));
}

// 10. 路径归一化
{
  check('normalizeRel unifies separators', pm.normalizeRel('.\\src\\a.js') === 'src/a.js', pm.normalizeRel('.\\src\\a.js'));
  check('normalizeRel rejects empty', pm.normalizeRel('  ') === null && pm.normalizeRel('./') === null, '');
}

// 清理
fs.rmSync(ws, { recursive: true, force: true });

if (failures.length) { console.log('PROJECT-MAP FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('PROJECT-MAP OK');
