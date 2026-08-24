// One-shot history rewrite helper for `git filter-branch --tree-filter`:
// replaces the string 'user' with 'user' in all TEXT files under the current
// working directory (binary-safe: non-UTF8-lossless files are skipped).
// Run by git filter-branch per commit; standalone run rewrites the worktree.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const NEEDLE = 'user';
const REPLACEMENT = 'user';
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.md', '.ps1', '.yml', '.yaml', '.bat', '.html', '.css', '.txt', '.gitignore', '.npmrc', '.cs']);

let changed = 0;

function rewriteFile(p) {
  if (!TEXT_EXT.has(path.extname(p).toLowerCase())) return;
  let buf;
  try { buf = fs.readFileSync(p); } catch { return; }
  if (buf.indexOf(NEEDLE, 'utf8') === -1) return;
  // lossless UTF-8 guard：decode→encode 不一致的文件（二进制/非 UTF8）跳过，避免破坏
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(buf) === false) return;
  const next = text.split(NEEDLE).join(REPLACEMENT);
  if (next === text) return;
  fs.writeFileSync(p, next, 'utf8');
  changed++;
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) rewriteFile(p);
  }
}

walk(process.cwd());
if (process.env.FILTER_BRANCH_SQUELCH_WARNING !== '1' && process.argv.includes('--verbose')) {
  process.stderr.write('rewrite-history: ' + changed + ' file(s) touched\n');
}
process.exit(0);
