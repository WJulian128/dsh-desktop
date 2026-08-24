'use strict';
// 上下文压力监视的扫描 worker：负责读取 + 解压 + 解析会话文件（重活），
// 结果回传主线程，避免阻塞 Electron 主进程 UI。
const { parentPort, workerData } = require('node:worker_threads');
const { scanSessionFile } = require('./usage');
const { sessionContextTokens } = require('./context-watch');

parentPort.on('message', (msg) => {
  if (!msg || typeof msg.file !== 'string') return;
  try {
    const scanned = scanSessionFile(msg.file);
    const tokens = sessionContextTokens(scanned);
    parentPort.postMessage({ type: 'scan-result', sessionId: msg.sessionId, file: msg.file, tokens });
  } catch (err) {
    parentPort.postMessage({ type: 'scan-result', sessionId: msg.sessionId, file: msg.file, tokens: 0, error: (err && err.message) || String(err) });
  }
});
