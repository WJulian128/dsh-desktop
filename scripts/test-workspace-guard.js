// 多会话编辑占用 + 变更日志 + 自动规范测试（main/workspace-guard.js + main/agents-norms.js）：
// 认领/冲突不覆盖/释放/过期清理/日志轮转/规范块幂等合并。
// 用法：node scripts\test-workspace-guard.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('../main/workspace-guard');
const { ensureNorms, NORM_VERSION } = require('../main/agents-norms');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-test-'));

// 1. 认领与状态
{
  const r = guard.claimFiles(ws, { sessionId: 'session-1', label: '对话A', files: ['src/a.js', '.\\src\\b.ts'] });
  check('claim ok', r.ok && r.claimed.length === 2 && r.conflicts.length === 0, JSON.stringify(r));
  const st = guard.claimsStatus(ws, { sessionId: 'session-1' });
  check('status: mine=2 others=0', st.mine.length === 2 && st.others.length === 0, JSON.stringify(st));
}

// 2. 冲突：其他会话认领同一文件不覆盖
{
  const r = guard.claimFiles(ws, { sessionId: 'session-2', label: '对话B', files: ['src/a.js', 'src/c.js'] });
  check('conflict detected, c.js claimed', r.conflicts.length === 1 && r.conflicts[0].file === 'src/a.js' && r.conflicts[0].sessionId === 'session-1' && r.claimed.length === 1, JSON.stringify(r));
  const st = guard.claimsStatus(ws, { sessionId: 'session-2' });
  check('status: others shows session-1 files, mine has c.js', st.others.length === 2 && st.others.every((c) => c.sessionId === 'session-1') && st.mine.length === 1 && st.mine[0].file === 'src/c.js', JSON.stringify(st));
}

// 3. 释放（只释放本会话的）
{
  const r = guard.releaseFiles(ws, { sessionId: 'session-2', files: ['src/c.js'] });
  check('release own file', r.released.length === 1 && r.released[0] === 'src/c.js', JSON.stringify(r));
  // session-2 试图释放 session-1 的文件：无效
  const r2 = guard.releaseFiles(ws, { sessionId: 'session-2', files: ['src/a.js'] });
  check('cannot release others file', r2.released.length === 0, JSON.stringify(r2));
  const st = guard.claimsStatus(ws, {});
  check('session-1 keeps both files', st.total === 2 && st.others.length === 2 && st.others.every((c) => c.sessionId === 'session-1'), JSON.stringify(st));
}

// 4. 过期清理：手工写入已过期占用，再认领同名文件 → 不算冲突
{
  const claimsFile = path.join(ws, '.dsh', 'claims.json');
  fs.writeFileSync(claimsFile, JSON.stringify({ files: { 'old.js': { sessionId: 'session-9', label: '', claimedAt: 1, expiresAt: Date.now() - 1000 } } }), 'utf8');
  const r = guard.claimFiles(ws, { sessionId: 'session-3', files: ['old.js'] });
  check('expired claim not a conflict', r.conflicts.length === 0 && r.claimed.length === 1, JSON.stringify(r));
  const st = guard.claimsStatus(ws, {});
  check('old claim replaced by session-3', st.others.length === 1 && st.others[0].sessionId === 'session-3', JSON.stringify(st.others));
}

// 5. 变更日志
{
  const entries = guard.readJournal(ws, 10);
  check('journal records claims', entries.length >= 4 && entries[0].action === 'claim' && entries[0].sessionId === 'session-3', JSON.stringify(entries[0]));
  const withFiles = entries.filter((e) => e.files && e.files.length);
  check('journal has files list', withFiles.length >= 3, '');
}

// 6. 日志轮转（超 2MB 轮转到 .1）
{
  const jp = path.join(ws, '.dsh', 'change-journal.jsonl');
  fs.writeFileSync(jp, 'x'.repeat(2 * 1024 * 1024 + 10) + '\n', 'utf8');
  guard.appendJournal(ws, { action: 'release', sessionId: 'session-3', files: ['old.js'] });
  check('journal rotated', fs.existsSync(jp + '.1') && fs.readFileSync(jp, 'utf8').includes('"release"'), '');
}

// 7. 自动规范块（agents-norms）
{
  const file = path.join(ws, 'AGENTS.md');
  // 不存在 → 创建
  const r1 = ensureNorms(file);
  check('norms: create missing file', r1.status === 'created', JSON.stringify(r1));
  const text1 = fs.readFileSync(file, 'utf8');
  check('norms: block contains key protocols', text1.includes('项目代码地图') && text1.includes('edit_claim') && text1.includes('Git 纪律'), '');
  // 已存在且同版本 → unchanged（幂等）
  const r2 = ensureNorms(file);
  check('norms: idempotent', r2.status === 'unchanged', JSON.stringify(r2));
  // 用户手写内容保留 + 追加块
  const userFile = path.join(ws, 'AGENTS-user.md');
  fs.writeFileSync(userFile, '# 我的项目\n\n这里是我的约定。\n', 'utf8');
  const r3 = ensureNorms(userFile);
  check('norms: appended to user content', r3.status === 'appended' && fs.readFileSync(userFile, 'utf8').indexOf('# 我的项目') === 0, '');
  // 旧版本块 → 升级替换（构造 v1 块）
  const oldFile = path.join(ws, 'AGENTS-old.md');
  fs.writeFileSync(oldFile, '# 头\n\n<!-- dsh-desktop-norms:v1:begin -->\n旧内容\n<!-- dsh-desktop-norms:v1:end -->\n\n# 尾\n', 'utf8');
  const r4 = ensureNorms(oldFile);
  const text4 = fs.readFileSync(oldFile, 'utf8');
  check('norms: upgrade old version block', r4.status === 'updated' && r4.fromVersion === 1 && text4.includes('v' + NORM_VERSION + ':begin') && text4.includes('# 头') && text4.includes('# 尾') && !text4.includes('旧内容'), '');
}

// 清理
fs.rmSync(ws, { recursive: true, force: true });

if (failures.length) { console.log('WORKSPACE-GUARD FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('WORKSPACE-GUARD OK');
