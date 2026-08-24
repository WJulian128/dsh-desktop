'use strict';
/**
 * 项目代码地图（project map）：
 * 面对长代码/大项目时，"首次仔细阅读并建立地图，之后只增量阅读"的桌面端支撑能力。
 *
 * 存储（均在工作区 .dsh/ 下）：
 *  - .dsh/project-map.md          地图正文（模型撰写，Markdown，人类可读）
 *  - .dsh/project-map.state.json  机器状态：更新时间、指纹（文件 size+mtimeMs）、git HEAD
 *
 * 同步判定（代码更新后地图"补上"的依据）：
 *  - 跟踪文件的 size/mtime 与记录不一致 → 该文件 stale（地图对应部分需要更新）；
 *  - git HEAD 变化但所有跟踪文件未变 → 提示"提交变了但指纹未变"，由模型自行判断。
 * 全部纯 Node 逻辑、无 Electron 依赖，可单测。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAP_FILE = 'project-map.md';
const STATE_FILE = 'project-map.state.json';

/** 自动指纹扫描时跳过的目录/文件名（与常见项目结构一致）。 */
const SKIP_DIRS = new Set(['.git', '.dsh', 'node_modules', 'dist', 'build', 'release', 'out', 'coverage', '.next', '.turbo', '__pycache__', '.venv', 'venv', 'target']);
const SKIP_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'session.jsonl.zstd']);
const MAX_SCAN_FILES = 400;        // 自动扫描文件数上限（防止巨型仓库拖垮状态查询）
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 单文件超过 2MB 不参与指纹（二进制/数据文件无地图意义）

function dshDir(workspace) {
  return path.join(workspace, '.dsh');
}

function mapPath(workspace) {
  return path.join(dshDir(workspace), MAP_FILE);
}

function statePath(workspace) {
  return path.join(dshDir(workspace), STATE_FILE);
}

/** 相对路径归一化（统一用 / 分隔，去 ./ 前缀），空值过滤。 */
function normalizeRel(p) {
  if (typeof p !== 'string') return null;
  const s = p.trim().replace(/\\/g, '/');
  if (!s || s === '.' || s === './') return null;
  return s.replace(/^\.\//, '');
}

/** 读取地图正文；不存在返回 null。 */
function readMap(workspace) {
  const file = mapPath(workspace);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 读取机器状态；不存在返回 null。 */
function readState(workspace) {
  const file = statePath(workspace);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      updatedBySession: typeof raw.updatedBySession === 'string' ? raw.updatedBySession : null,
      gitHead: typeof raw.gitHead === 'string' ? raw.gitHead : null,
      files: raw.files && typeof raw.files === 'object' ? raw.files : {},
    };
  } catch {
    return null;
  }
}

/** 原子写（临时文件 + rename），目录自动创建。 */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** 原子写 JSON。 */
function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

/**
 * 扫描工作区源码文件并计算指纹（size + mtimeMs）。
 * @param {string} workspace 工作区根目录
 * @param {string[]} [only] 只扫描这些相对路径（跳过递归；不提供则递归扫描）
 * @returns {{ files: Object<string,{size:number,mtimeMs:number}>, scanned: number, skipped: number }}
 */
function scanFingerprints(workspace, only) {
  const files = {};
  let scanned = 0;
  let skipped = 0;
  const walk = (dir, relPrefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relPrefix ? relPrefix + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), rel);
        continue;
      }
      if (!e.isFile() || SKIP_NAMES.has(e.name)) continue;
      if (scanned >= MAX_SCAN_FILES) { skipped++; continue; }
      let st;
      try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) { skipped++; continue; }
      files[rel] = { size: st.size, mtimeMs: st.mtimeMs };
      scanned++;
    }
  };
  if (Array.isArray(only) && only.length) {
    for (const raw of only) {
      const rel = normalizeRel(raw);
      if (!rel) continue;
      const abs = path.join(workspace, rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) { skipped++; continue; }
      files[rel] = { size: st.size, mtimeMs: st.mtimeMs };
      scanned++;
    }
  } else {
    walk(workspace, '');
  }
  return { files, scanned, skipped };
}

/**
 * 保存/更新地图：写地图正文 + 重新记录指纹与 git HEAD。
 * @param {string} workspace 工作区
 * @param {object} opts
 * @param {string} opts.map 地图正文（Markdown）
 * @param {string[]} [opts.files] 要跟踪指纹的文件（相对路径）；缺省自动扫描工作区
 * @param {string} [opts.gitHead] 当前 git HEAD（调用方已查好）；缺省留 null
 * @param {string} [opts.updatedBySession] 写入方会话 id（用于审计）
 * @returns {{ ok:boolean, scanned:number, skipped:number, tracked:number, error?:string }}
 */
function saveMap(workspace, opts) {
  if (!opts || typeof opts.map !== 'string') {
    return { ok: false, error: 'map 必须是字符串（地图正文 Markdown）' };
  }
  const mapText = opts.map.trim();
  if (!mapText) {
    return { ok: false, error: '地图正文为空，拒绝写入（避免清空已有地图）' };
  }
  const scan = scanFingerprints(workspace, opts.files);
  const prev = readState(workspace);
  // 增量补图：只传了本次重读的文件时，其余文件沿用旧指纹（未重读 ≠ 未变化，下次 status 会再判）
  const mergedFiles = (prev && prev.files) ? { ...prev.files, ...scan.files } : scan.files;
  const state = {
    version: 1,
    updatedAt: Date.now(),
    updatedBySession: typeof opts.updatedBySession === 'string' ? opts.updatedBySession : null,
    gitHead: typeof opts.gitHead === 'string' ? opts.gitHead : (prev && prev.gitHead) || null,
    files: mergedFiles,
  };
  try {
    writeFileAtomic(mapPath(workspace), mapText + '\n');
    writeJsonAtomic(statePath(workspace), state);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  return { ok: true, scanned: scan.scanned, skipped: scan.skipped, tracked: Object.keys(scan.files).length };
}

/**
 * 地图状态：是否存在、跟踪多少文件、哪些文件已变化（stale）、git HEAD 是否变化。
 * @param {string} workspace 工作区
 * @param {object} [opts]
 * @param {number} [opts.limit] staleFiles 返回上限（默认 30）
 * @param {string} [opts.currentGitHead] 当前 git HEAD（调用方查好可省一次 git 调用）
 * @returns {{ exists:boolean, updatedAt:number, tracked:number, staleCount:number, staleFiles:string[], gitHeadChanged:boolean|null }}
 */
function mapStatus(workspace, opts = {}) {
  const state = readState(workspace);
  const map = readMap(workspace);
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 30;
  if (!state || map == null) {
    return { exists: false, updatedAt: 0, tracked: 0, staleCount: 0, staleFiles: [], gitHeadChanged: null };
  }
  const staleFiles = [];
  let staleCount = 0;
  for (const rel of Object.keys(state.files)) {
    const rec = state.files[rel];
    let st;
    try { st = fs.statSync(path.join(workspace, rel)); } catch {
      staleCount++; // 文件被删除
      if (staleFiles.length < limit) staleFiles.push(rel + '（已删除）');
      continue;
    }
    if (st.size !== rec.size || st.mtimeMs !== rec.mtimeMs) {
      staleCount++;
      if (staleFiles.length < limit) staleFiles.push(rel);
    }
  }
  let gitHeadChanged = null;
  if (typeof opts.currentGitHead === 'string' && typeof state.gitHead === 'string') {
    gitHeadChanged = opts.currentGitHead !== state.gitHead;
  }
  return {
    exists: true,
    updatedAt: state.updatedAt,
    tracked: Object.keys(state.files).length,
    staleCount,
    staleFiles,
    gitHeadChanged,
  };
}

module.exports = { readMap, readState, saveMap, mapStatus, scanFingerprints, normalizeRel, mapPath, statePath };
