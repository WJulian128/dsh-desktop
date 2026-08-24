'use strict';
const { spawn } = require('node:child_process');

/** 运行一次 headless 任务：dsh --profile headless "<task>"，输出按 chunk 回调。 */
function runHeadless({ binPath, task, cwd, env, onData, onExit, onError }) {
  let child = null;
  let killed = false;
  const trySpawn = (cmd, extraEnv) => {
    child = spawn(cmd, ['--expose-internals', binPath, '--profile', 'headless', task], {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => { if (onData) onData('stdout', String(d)); });
    child.stderr.on('data', (d) => { if (onData) onData('stderr', String(d)); });
    child.on('error', (err) => {
      if (err.code === 'ENOENT' && cmd === 'node' && extraEnv.ELECTRON_RUN_AS_NODE !== '1') {
        trySpawn(process.execPath, { ELECTRON_RUN_AS_NODE: '1' });
        return;
      }
      if (onError) onError(err.message || String(err));
    });
    child.on('close', (code) => { if (onExit) onExit(killed ? null : code); });
  };
  trySpawn('node', {});
  return {
    cancel() {
      killed = true;
      if (child && child.exitCode === null) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      }
    },
  };
}

module.exports = { runHeadless };
