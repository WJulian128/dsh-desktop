'use strict';

// Usage scan child: run the workspace usage scan (which decompresses every
// session file) in a separate Node process so the Electron main thread never
// blocks on it. Writes one JSON object to stdout:
//   { ok: true, summary }  |  { ok: false, error }
const { scanWorkspaceUsage } = require('./usage');

const dshHome = String(process.argv[2] || '');
const workspace = String(process.argv[3] || '');
let usagePrices = null;
try { usagePrices = process.argv[4] ? JSON.parse(process.argv[4]) : null; } catch { /* 非法价格参数用默认 */ }

try {
  const summary = scanWorkspaceUsage({ dshHome, workspace, usagePrices });
  process.stdout.write(JSON.stringify({ ok: true, summary }));
} catch (error) {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
}
