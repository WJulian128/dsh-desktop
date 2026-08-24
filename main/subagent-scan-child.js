'use strict';

// Development fallback for Electron builds whose embedded zstd implementation
// is substantially slower than the system Node runtime. The helper is kept
// dependency-free apart from the local subagent scanner and writes one JSON
// result to stdout.
const subagentCenter = require('./subagent-center');

const dshHome = String(process.argv[2] || '');
const workspace = String(process.argv[3] || '');

try {
  const options = { dshHome, workspace };
  const items = subagentCenter.scanSubagents(options);
  const titles = subagentCenter.parentTitleMap(options);
  for (const item of items) {
    item.parentTitle =
      item.parentSession && titles[item.parentSession] ? titles[item.parentSession] : null;
  }
  process.stdout.write(JSON.stringify({ ok: true, items, summary: subagentCenter.summarize(items) }));
} catch (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
}
