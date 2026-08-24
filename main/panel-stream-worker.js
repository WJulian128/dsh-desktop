'use strict';
/**
 * 面板流 worker：子代理会话流读取 + transcript 内容检查全部在 worker 线程内进行。
 * 冷启动时 listSubagentStream 需要解压几十个子代理会话文件、sessionContainsText(full)
 * 需要解压数十 MB JSON——这些重活绝不在 Electron 主线程做（启动卡顿来源）。
 *
 * 消息协议（主进程 -> worker）：
 *   { requestId, task: 'list',   dshHome, workspace, now }
 *   { requestId, task: 'since',  dshHome, workspace, sessionId, sinceSeq }
 *   { requestId, task: 'contains', dshHome, workspace, mark, full }
 * worker -> 主进程：
 *   { type: 'result', requestId, result } | { type: 'result', requestId, error }
 * 缓存（subagent-stream 模块级 Map）自然常驻 worker，跨请求复用。
 */
const { parentPort } = require('node:worker_threads');
const stream = require('./subagent-stream');
const { sessionContainsText } = require('./transcript-check');

if (!parentPort) {
  throw new Error('panel-stream-worker.js must run inside a worker thread');
}

parentPort.on('message', (message) => {
  if (!message || typeof message.requestId !== 'number') return;
  try {
    let result;
    if (message.task === 'list') {
      result = stream.listSubagentStream({
        dshHome: String(message.dshHome || ''),
        workspace: String(message.workspace || ''),
        now: typeof message.now === 'number' ? message.now : Date.now(),
      });
    } else if (message.task === 'since') {
      result = stream.streamSince({
        dshHome: String(message.dshHome || ''),
        workspace: String(message.workspace || ''),
        sessionId: message.sessionId,
        sinceSeq: message.sinceSeq,
      });
    } else if (message.task === 'contains') {
      result = sessionContainsText({
        dshHome: String(message.dshHome || ''),
        workspace: String(message.workspace || ''),
        mark: message.mark,
        full: message.full === true,
      });
    } else {
      throw new Error('unknown task: ' + message.task);
    }
    parentPort.postMessage({ type: 'result', requestId: message.requestId, result });
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      requestId: message.requestId,
      error: (error && error.message) || String(error),
    });
  }
});
