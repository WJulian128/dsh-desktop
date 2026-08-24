'use strict';
const { spawn } = require('node:child_process');

/**
 * 运行 `dsh plugin --profile <name> <args...>`（pnpm 转发器）：用于在设置页
 * 安装/卸载 harness profile 插件。输出按 chunk 流式回调，可取消。
 */
function runDshPlugin({ binPath, profile = 'web', args = [], cwd, env, onData, onExit, onError }) {
  let child = null;
  let killed = false;
  const trySpawn = (cmd, extraEnv) => {
    child = spawn(cmd, ['--expose-internals', binPath, 'plugin', '--profile', profile, ...args], {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    const feed = (chunk) => { if (onData) onData(String(chunk)); };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
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

module.exports = { runDshPlugin };
