'use strict';
const { spawn } = require('node:child_process');

/**
 * 在工作区运行 git 命令（审查窗用）。返回 { ok, code, output }。
 */
function runGit(args, cwd, { timeoutMs = 30000, maxBytes = 400000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err) });
      return;
    }
    let out = '';
    let err = '';
    const feed = (chunk) => {
      out += chunk;
      if (out.length > maxBytes) {
        out = out.slice(-maxBytes) + '\n…(输出过长已截断)';
        try { child.kill(); } catch { /* 忽略 */ }
      }
    };
    child.stdout.on('data', (c) => feed(String(c)));
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', (e) => resolve({ ok: false, error: 'git 不可用：' + (e && e.message ? e.message : e) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, output: out, error: err || undefined }));
    setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, timeoutMs);
  });
}

/** 汇总工作区变更（status + diff --stat + diff）。 */
async function gitSummary(cwd) {
  const status = await runGit(['status', '--porcelain=v1', '--branch'], cwd);
  const stat = await runGit(['diff', '--stat'], cwd);
  const diff = await runGit(['diff'], cwd);
  const parts = ['# git status\n' + (status.ok ? status.output : '（失败）' + (status.error || ''))];
  if (stat.ok && stat.output.trim()) parts.push('# git diff --stat\n' + stat.output);
  parts.push('# git diff\n' + (diff.ok ? (diff.output || '（无未暂存改动）') : '（失败）' + (diff.error || '')));
  return parts.join('\n\n');
}

/* ============ 代理可用的安全 Git 操作（MCP 工具经此转发，只暴露白名单命令） ============ */

const GIT_TIMEOUT_MS = 120000;

function toResult(r) {
  return r.ok ? { ok: true, output: r.output } : { ok: false, error: r.error || r.output || ('git 退出码 ' + r.code) };
}

function isRepo(cwd) {
  return fsExistsSafe(cwd);
}
function fsExistsSafe(p) {
  try { require('node:fs').statSync(p); return true; } catch { return false; }
}

/** 校验仓库存在；返回 null 或错误串。 */
async function ensureRepo(cwd) {
  if (!isRepo(cwd)) return '目录不存在：' + cwd;
  const r = await runGit(['rev-parse', '--git-dir'], cwd, { timeoutMs: 15000 });
  if (!r.ok) return '不是 git 仓库（可先用 git_init 初始化）' + (r.error ? '：' + r.error : '');
  return null;
}

/** git init（无仓库时兜底，提供可回溯的基础）。 */
async function gitInit(cwd) {
  const r = await runGit(['init'], cwd, { timeoutMs: 30000 });
  return toResult(r);
}

/** 当前 HEAD（无提交返回 null）。 */
async function gitHead(cwd) {
  const r = await runGit(['rev-parse', 'HEAD'], cwd, { timeoutMs: 15000 });
  if (!r.ok) return null;
  return (r.output || '').trim() || null;
}

/** 状态：porcelain v1（机器可读，含分支与未跟踪）。 */
async function gitStatus(cwd) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  return toResult(await runGit(['status', '--porcelain=v1', '--branch'], cwd, { timeoutMs: 30000 }));
}

/** 差异：可指定单个文件或 --staged。 */
async function gitDiff(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const args = ['diff'];
  if (opts.staged) args.push('--staged');
  if (opts.path) {
    const rel = String(opts.path).trim().replace(/\\/g, '/');
    args.push('--', rel);
  }
  return toResult(await runGit(args, cwd, { timeoutMs: GIT_TIMEOUT_MS, maxBytes: 600000 }));
}

/** 提交日志（最近 n 条，单行）。 */
async function gitLog(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const n = typeof opts.n === 'number' && opts.n > 0 ? Math.min(opts.n, 100) : 20;
  const r = await runGit(['log', '-' + n, '--oneline', '--decorate'], cwd, { timeoutMs: 30000 });
  return toResult(r);
}

/**
 * 提交快照：git add -A + commit（消息自动加会话归属前缀，保证可回溯）。
 * @param {string} cwd 工作区
 * @param {object} opts
 * @param {string} opts.message 提交说明
 * @param {string} [opts.sessionId] 会话 id（写入提交消息前缀）
 * @param {string[]} [opts.paths] 只提交这些路径（默认全部）
 */
async function gitCommit(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const message = String(opts.message || '').trim();
  if (!message) return { ok: false, error: 'message 必填（提交说明）' };
  const tag = typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : 'dsh';
  const full = '[dsh:' + tag + '] ' + message;
  const paths = Array.isArray(opts.paths) ? opts.paths.map((p) => String(p).trim()).filter(Boolean) : [];
  const addArgs = ['add', '-A'];
  if (paths.length) addArgs.push('--', ...paths);
  const add = await runGit(addArgs, cwd, { timeoutMs: GIT_TIMEOUT_MS });
  if (!add.ok) return { ok: false, error: 'git add 失败：' + (add.error || add.output) };
  // 无内容可提交时不算失败（返回提示）
  const commit = await runGit(['commit', '-m', full], cwd, { timeoutMs: GIT_TIMEOUT_MS });
  if (commit.ok) return { ok: true, output: commit.output };
  if (commit.code === 1 && /nothing to commit|no changes added/i.test(commit.output)) {
    return { ok: true, output: '（没有需要提交的变更）' };
  }
  return { ok: false, error: 'git commit 失败：' + (commit.error || commit.output) };
}

/** 分支列表（当前分支标注 *）。 */
async function gitBranch(cwd) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  return toResult(await runGit(['branch', '--list'], cwd, { timeoutMs: 30000 }));
}

/**
 * 切换/新建分支。切换前自动检查未提交变更：有变更时先 stash（保证不丢），
 * checkout 后不自动 pop（由调用方决定），输出里说明。
 */
async function gitCheckout(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const name = String(opts.branch || '').trim();
  if (!name) return { ok: false, error: 'branch 必填（目标分支名）' };
  const args = opts.create ? ['checkout', '-b', name] : ['checkout', name];
  let stashInfo = '';
  const dirty = await runGit(['status', '--porcelain=v1'], cwd, { timeoutMs: 30000 });
  if (dirty.ok && dirty.output.trim()) {
    const st = await runGit(['stash', 'push', '-m', 'dsh-auto-stash-before-checkout'], cwd, { timeoutMs: GIT_TIMEOUT_MS });
    if (!st.ok) return { ok: false, error: '有未提交变更且 stash 失败：' + (st.error || st.output) };
    stashInfo = '（未提交变更已 stash 保存，可 git stash pop 恢复）';
  }
  const r = await runGit(args, cwd, { timeoutMs: GIT_TIMEOUT_MS });
  if (!r.ok) return { ok: false, error: 'checkout 失败：' + (r.error || r.output) + stashInfo };
  return { ok: true, output: (r.output || '已切换') + stashInfo };
}

/** 回滚：git restore（工作区或暂存区，按路径可选；默认全部未暂存变更）。 */
async function gitRestore(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const args = ['restore'];
  if (opts.staged) args.push('--staged');
  if (opts.path) args.push('--', String(opts.path).trim().replace(/\\/g, '/'));
  else args.push('.');
  return toResult(await runGit(args, cwd, { timeoutMs: GIT_TIMEOUT_MS }));
}

/** stash 列表 / push / pop（pop 可选恢复指定条目）。 */
async function gitStash(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const action = opts.action === 'push' || opts.action === 'pop' ? opts.action : 'list';
  if (action === 'list') return toResult(await runGit(['stash', 'list'], cwd, { timeoutMs: 30000 }));
  if (action === 'pop') {
    const args = ['stash', 'pop'];
    if (opts.index) args.push('stash@{' + Number(opts.index) + '}');
    return toResult(await runGit(args, cwd, { timeoutMs: GIT_TIMEOUT_MS }));
  }
  const msg = typeof opts.message === 'string' && opts.message.trim() ? opts.message.trim() : 'dsh-stash';
  return toResult(await runGit(['stash', 'push', '-m', msg], cwd, { timeoutMs: GIT_TIMEOUT_MS }));
}

/* ============ GitHub 协作（远程/推送/拉取/合并，全部安全参数，禁 force） ============ */

/** 当前分支名（无仓库/无提交返回 null）。 */
async function gitCurrentBranch(cwd) {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, { timeoutMs: 15000 });
  if (!r.ok) return null;
  return (r.output || '').trim() || null;
}

/** 远程列表：git remote -v（返回输出文本）。 */
async function gitRemoteList(cwd) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  return toResult(await runGit(['remote', '-v'], cwd, { timeoutMs: 15000 }));
}

/** 添加/修改远程。name 默认 origin。 */
async function gitRemoteAdd(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const name = String(opts.name || 'origin').trim() || 'origin';
  const url = String(opts.url || '').trim();
  if (!/^https?:\/\/|^git@/.test(url)) return { ok: false, error: '远程地址需为 https:// 或 git@ 形式' };
  // 已存在同名远程 → set-url；否则 add
  const existing = await runGit(['remote', 'get-url', name], cwd, { timeoutMs: 15000 });
  const args = existing.ok ? ['remote', 'set-url', name, url] : ['remote', 'add', name, url];
  return toResult(await runGit(args, cwd, { timeoutMs: 30000 }));
}

/** 推送（禁 force）。push -u origin <branch>；branch 默认当前分支。 */
async function gitPush(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const remote = String(opts.remote || 'origin').trim() || 'origin';
  let branch = String(opts.branch || '').trim();
  if (!branch) {
    branch = await gitCurrentBranch(cwd);
    if (!branch) return { ok: false, error: '无法确定当前分支（无提交？）' };
  }
  const args = ['push', '-u', remote, branch];
  return toResult(await runGit(args, cwd, { timeoutMs: 300000, maxBytes: 600000 }));
}

/** 拉取（默认 --ff-only，绝不产生意外合并）。 */
async function gitPull(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const remote = String(opts.remote || 'origin').trim() || 'origin';
  let branch = String(opts.branch || '').trim();
  if (!branch) branch = await gitCurrentBranch(cwd);
  const args = ['pull', '--ff-only'];
  if (remote && branch) args.push(remote, branch);
  return toResult(await runGit(args, cwd, { timeoutMs: 300000, maxBytes: 600000 }));
}

/** 合并指定分支到当前分支（优先快进；冲突时提示用 resolving-merge-conflicts skill）。 */
async function gitMerge(cwd, opts = {}) {
  const err = await ensureRepo(cwd);
  if (err) return { ok: false, error: err };
  const branch = String(opts.branch || '').trim();
  if (!branch) return { ok: false, error: 'branch 必填（要合并进来的分支）' };
  const r = await runGit(['merge', '--no-edit', branch], cwd, { timeoutMs: 120000, maxBytes: 600000 });
  if (r.ok) return { ok: true, output: r.output };
  // 合并冲突：给出明确的下一步指引
  const out = String(r.output || '') + (r.error || '');
  if (/CONFLICT|conflict/i.test(out)) {
    return { ok: false, error: '合并冲突：请按 resolving-merge-conflicts skill 处理（git status 看冲突文件，解决后 git add + git_commit 完成合并，或 git_restore 中止）。' + out.slice(0, 400) };
  }
  return { ok: false, error: 'merge 失败：' + out.slice(0, 400) };
}

module.exports = {
  runGit,
  gitSummary,
  gitInit,
  gitHead,
  gitStatus,
  gitDiff,
  gitLog,
  gitCommit,
  gitBranch,
  gitCheckout,
  gitRestore,
  gitStash,
  gitCurrentBranch,
  gitRemoteList,
  gitRemoteAdd,
  gitPush,
  gitPull,
  gitMerge,
};
