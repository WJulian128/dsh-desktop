'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const net = require('node:net');

/** 从本机网卡取一个空闲端口（bind 后立即释放，竞态窗口极小）。 */
function pickFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 HTTP 直到服务应答（harness 不打印 URL，用 HTTP 探活作为就绪信号）。 */
function waitForHttp(url, timeoutMs = 60000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('等待服务就绪超时（' + url + '）'));
        setTimeout(probe, intervalMs);
      });
      req.setTimeout(3000, () => req.destroy());
    };
    probe();
  });
}

/**
 * 托管 dsh web 子进程：分配端口、启动、探活、停止（Windows 下按进程树清理）。
 * `patches` 为额外 --patch 覆盖文件（绝对路径，按序传入），用于注入 MCP 服务器
 * 与桌面端设置分区等 harness 客户端能力。
 */
class HarnessController extends EventEmitter {
  constructor({ binPath, cwd, env, host = '127.0.0.1', port, patches = [] }) {
    super();
    this.binPath = binPath; this.cwd = cwd; this.env = env;
    this.host = host; this.port = port; this.patches = patches;
    this.child = null; this.settled = false; this.lastError = null;
    this.webUrl = null; // 子进程打印的完整 URL（含 ?token=…，0.1.2-rc.1+ 需要）
    this.recentLog = []; // 子进程输出环形缓冲（启动失败时供分类/提示，上限 120 行）
  }

  get url() { return 'http://' + this.host + ':' + this.port; }

  /** 最近 N 行子进程输出（失败诊断素材；join 后截断超长行）。 */
  get lastLogTail() {
    const lines = this.recentLog.slice(-60).map((l) => (l.length > 500 ? l.slice(0, 500) + '…' : l));
    return lines.join('\n');
  }

  pushLog(line) {
    this.recentLog.push(line);
    if (this.recentLog.length > 120) this.recentLog.splice(0, this.recentLog.length - 120);
    this.emit('log', line);
  }

  start() {
    return new Promise((resolve, reject) => {
      const patchArgs = this.patches.flatMap((file) => ['--patch', file]);
      // --expose-internals：cordis loader/HMR 需要 Node 内部模块；显式传入后无需
      // 依赖 ABI 敏感的 node-addon-require-builtin 原生回退，打包模式
      // （Electron 自带 Node，ELECTRON_RUN_AS_NODE）下同样可用。
      // --no-open：官方 dsh-web-app（0.1.1-rc.2+）默认启动时自动打开默认浏览器，
      // 桌面端自带窗口，必须禁用，否则每次启动/重启服务都会弹浏览器标签页。
      const args = ['--expose-internals', this.binPath, 'web', ...patchArgs, '--host', this.host, '--port', String(this.port), '--no-open'];
      const spawnNow = (cmd, extraEnv) => {
        this.child = spawn(cmd, args, {
          cwd: this.cwd,
          env: { ...this.env, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        // 行缓冲：dsh web 的带 token URL 可能跨 chunk，不能按 chunk 切行丢内容。
        const makeLineSink = () => {
          let buffer = '';
          return (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) {
              const t = line.trim();
              if (!t) continue;
              this.pushLog(t);
              // 0.1.2-rc.1+ 的 web 页面需要 token 认证：完整 URL（含 ?token=…）
              // 由子进程打印，页面加载与主进程 RPC 都必须走它。
              if (t.startsWith('dsh web: ')) {
                this.webUrl = t.slice('dsh web: '.length).trim();
              }
            }
          };
        };
        const onStdout = makeLineSink();
        const onStderr = makeLineSink();
        this.child.stdout.on('data', onStdout);
        this.child.stderr.on('data', onStderr);
        this.child.on('error', (err) => {
          if (err.code === 'ENOENT' && cmd === 'node' && !extraEnv.ELECTRON_RUN_AS_NODE) {
            // PATH 里没有 node 时退回 Electron 自带的 Node
            spawnNow(process.execPath, { ELECTRON_RUN_AS_NODE: '1' });
            return;
          }
          this.fail(err);
          reject(err);
        });
        this.child.on('close', (code) => {
          if (!this.settled) {
            this.fail(new Error('harness 进程提前退出（退出码 ' + code + '）'));
            reject(this.lastError);
          }
          this.emit('exit', code);
        });
        waitForHttp(this.url).then(async () => {
          // HTTP 已应答但 token URL 可能还没打印完：等一小段（最多 ~8s）再定版。
          // 8s 只是上限：token 行一到立即跳出，正常启动多等 <100ms。
          const deadline = Date.now() + 8000;
          while (!this.webUrl && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
          }
          this.settled = true;
          resolve(this.webUrl || this.url);
        }).catch((err) => {
          this.fail(err);
          reject(err);
        });
      };
      spawnNow('node', {});
    });
  }

  fail(err) {
    if (this.settled) return;
    this.settled = true;
    this.lastError = err;
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('exit', () => resolve());
        killer.on('error', () => { try { child.kill(); } catch {} resolve(); });
        setTimeout(resolve, 3000);
      } else {
        child.kill('SIGTERM');
        setTimeout(resolve, 1000);
      }
    });
  }
}

module.exports = { HarnessController, pickFreePort, waitForHttp };
