'use strict';
/**
 * 多会话并发编辑防护 + 可回溯（workspace guard）：
 * 用户可能开多个对话同时改同一个项目。为避免互相干扰、保证可回溯：
 *
 *  - 编辑占用（claim）：会话改文件前先"认领"，其他会话改前先查占用，发现冲突时
 *    先协商（告知用户/等待释放），避免两个模型同时写同一文件互相覆盖。
 *  - 变更日志（journal）：每次认领/释放/快照都落 .dsh/change-journal.jsonl，
 *    谁在什么时候动了哪些文件，可完整回溯。
 *  - 快照（snapshot，配合 git）：模型完成任务块后提交快照（git 提交带会话 id），
 *    任意时刻可回滚。
 *
 * 存储（工作区 .dsh/ 下）：
 *  - .dsh/claims.json          占用登记：{ files: { relpath: { sessionId,label,claimedAt,expiresAt } } }
 *  - .dsh/change-journal.jsonl 变更日志（append-only）
 * 全部纯 Node 逻辑、无 Electron 依赖，可单测。
 */
const fs = require('node:fs');
const path = require('node:path');

const CLAIM_TTL_MS = 30 * 60 * 1000; // 占用默认 30 分钟过期（长任务可续期）
const JOURNAL_CAP_BYTES = 2 * 1024 * 1024; // 日志超过 2MB 轮转（保留 1 个 .1 后缀）

function dshDir(workspace) {
  return path.join(workspace, '.dsh');
}

function claimsPath(workspace) {
  return path.join(dshDir(workspace), 'claims.json');
}

function journalPath(workspace) {
  return path.join(dshDir(workspace), 'change-journal.jsonl');
}

/** 相对路径归一化（统一 /，去 ./），空值过滤。 */
function normalizeRel(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim().replace(/\\/g, '/');
  if (!s || s === '.' || s === './') return null;
  return s.replace(/^\.\//, '');
}

/** 读取占用登记（顺带清掉过期项，但只有写回时才落盘）。 */
function readClaims(workspace, now = Date.now()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(claimsPath(workspace), 'utf8')); } catch { raw = null; }
  const files = {};
  if (raw && raw.files && typeof raw.files === 'object') {
    for (const rel of Object.keys(raw.files)) {
      const c = raw.files[rel];
      if (!c || typeof c !== 'object') continue;
      if (typeof c.expiresAt === 'number' && c.expiresAt <= now) continue; // 过期即视为不存在
      files[rel] = {
        sessionId: typeof c.sessionId === 'string' ? c.sessionId : '?',
        label: typeof c.label === 'string' ? c.label : '',
        claimedAt: typeof c.claimedAt === 'number' ? c.claimedAt : 0,
        expiresAt: typeof c.expiresAt === 'number' ? c.expiresAt : now + CLAIM_TTL_MS,
      };
    }
  }
  return files;
}

/** 原子写 JSON。 */
function writeClaims(workspace, files) {
  fs.mkdirSync(dshDir(workspace), { recursive: true });
  const file = claimsPath(workspace);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify({ files }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 追加一行变更日志（轮转 2MB）。 */
function appendJournal(workspace, entry) {
  fs.mkdirSync(dshDir(workspace), { recursive: true });
  const file = journalPath(workspace);
  const line = JSON.stringify({ time: Date.now(), ...entry }) + '\n';
  try {
    const st = fs.statSync(file);
    if (st.size + line.length > JOURNAL_CAP_BYTES) {
      const bak = file + '.1';
      try { fs.rmSync(bak, { force: true }); } catch { /* 忽略 */ }
      try { fs.renameSync(file, bak); } catch { /* 忽略 */ }
    }
  } catch { /* 文件不存在 */ }
  fs.appendFileSync(file, line, 'utf8');
}

/**
 * 认领文件（改前声明）。
 * @param {string} workspace 工作区
 * @param {object} opts
 * @param {string} opts.sessionId 认领会话 id（必填，用于归属与冲突判定）
 * @param {string} [opts.label] 会话标题（展示用）
 * @param {string[]} opts.files 相对路径列表
 * @param {number} [opts.ttlMs] 过期时长（默认 30 分钟）
 * @returns {{ ok:boolean, claimed:string[], conflicts:Array<{file,sessionId,label}>, released?:number, error?:string }}
 */
function claimFiles(workspace, opts) {
  const sessionId = opts && typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
  if (!sessionId) return { ok: false, error: 'sessionId 必填（认领归属的会话）' };
  const rels = [];
  if (Array.isArray(opts.files)) {
    for (const f of opts.files) {
      const rel = normalizeRel(f);
      if (rel && !rels.includes(rel)) rels.push(rel);
    }
  }
  if (!rels.length) return { ok: false, error: 'files 不能为空（要认领的文件相对路径列表）' };
  const now = Date.now();
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? opts.ttlMs : CLAIM_TTL_MS;
  const files = readClaims(workspace, now);
  const claimed = [];
  const conflicts = [];
  for (const rel of rels) {
    const existing = files[rel];
    if (existing && existing.sessionId !== sessionId) {
      conflicts.push({ file: rel, sessionId: existing.sessionId, label: existing.label || '' });
      continue; // 冲突不覆盖
    }
    files[rel] = { sessionId, label: typeof opts.label === 'string' ? opts.label : '', claimedAt: now, expiresAt: now + ttlMs };
    claimed.push(rel);
  }
  if (claimed.length) writeClaims(workspace, files);
  appendJournal(workspace, { action: 'claim', sessionId, files: claimed, conflicts: conflicts.map((c) => c.file) });
  return { ok: true, claimed, conflicts };
}

/**
 * 释放文件（改完验证后）。
 * @returns {{ ok:boolean, released:string[], error?:string }}
 */
function releaseFiles(workspace, opts) {
  const sessionId = opts && typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
  if (!sessionId) return { ok: false, error: 'sessionId 必填' };
  const files = readClaims(workspace);
  const released = [];
  const targets = Array.isArray(opts.files) ? opts.files.map(normalizeRel).filter(Boolean) : null;
  for (const rel of Object.keys(files)) {
    if (files[rel].sessionId !== sessionId) continue;
    if (targets && !targets.includes(rel)) continue; // 指定了列表则只释放列表内
    delete files[rel];
    released.push(rel);
  }
  if (released.length) {
    writeClaims(workspace, files);
    appendJournal(workspace, { action: 'release', sessionId, files: released });
  }
  return { ok: true, released };
}

/**
 * 查询占用状态。
 * @returns {{ ok:boolean, mine:Array, others:Array, total:number }}
 */
function claimsStatus(workspace, opts) {
  const sessionId = opts && typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
  const files = readClaims(workspace);
  const mine = [];
  const others = [];
  for (const rel of Object.keys(files)) {
    const c = files[rel];
    const item = { file: rel, sessionId: c.sessionId, label: c.label || '', claimedAt: c.claimedAt, expiresAt: c.expiresAt };
    if (sessionId && c.sessionId === sessionId) mine.push(item);
    else others.push(item);
  }
  return { ok: true, mine, others, total: Object.keys(files).length };
}

/** 读取最近 N 条变更日志（倒序返回最新在前）。 */
function readJournal(workspace, limit = 50) {
  const file = journalPath(workspace);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (r && typeof r === 'object') lines.push(r);
  }
  const n = typeof limit === 'number' && limit > 0 ? limit : 50;
  return lines.slice(-n).reverse();
}

module.exports = { claimFiles, releaseFiles, claimsStatus, readJournal, readClaims, appendJournal, normalizeRel, CLAIM_TTL_MS };
