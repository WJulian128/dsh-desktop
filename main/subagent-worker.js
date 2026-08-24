'use strict';

// Subagent session files are zstd-compressed and can be large. Keep the full
// scan outside Electron's main thread so renderer IPC and window painting stay
// responsive while the snapshot is being rebuilt.
const { parentPort } = require('node:worker_threads');
const subagentCenter = require('./subagent-center');

if (!parentPort) {
  throw new Error('subagent-worker.js must run inside a worker thread');
}

parentPort.on('message', (message) => {
  if (!message || message.type !== 'scan' || typeof message.requestId !== 'number') return;

  try {
    const options = {
      dshHome: String(message.dshHome || ''),
      workspace: String(message.workspace || ''),
    };
    const items = subagentCenter.scanSubagents(options);
    const titles = subagentCenter.parentTitleMap(options);
    for (const item of items) {
      item.parentTitle =
        item.parentSession && titles[item.parentSession] ? titles[item.parentSession] : null;
    }
    parentPort.postMessage({
      type: 'result',
      requestId: message.requestId,
      result: { ok: true, items, summary: subagentCenter.summarize(items) },
    });
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      requestId: message.requestId,
      error: (error && error.message) || String(error),
    });
  }
});
