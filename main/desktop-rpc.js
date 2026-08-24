'use strict';
const http = require('node:http');

/**
 * 桌面端 RPC 服务：绑定 127.0.0.1 随机端口，供 harness 内启动的 MCP 服务器
 * （main/mcp-server.mjs）通过 HTTP + Bearer token 调用桌面能力
 * （检查更新 / 应用更新 / 打开目录 / 重启等）。
 *
 * 协议：POST /rpc，body = { method, params }，Header: Authorization: Bearer <token>。
 * 响应：{ ok: true, result } 或 { ok: false, error }。
 */
class DesktopRpcServer {
  constructor({ token, logger = () => {} }) {
    this.token = token;
    this.logger = logger;
    this.server = null;
    this.port = null;
    this.handlers = new Map();
  }

  on(method, handler) {
    if (typeof handler !== 'function') throw new Error('rpc handler must be a function');
    this.handlers.set(method, handler);
  }

  get url() { return 'http://127.0.0.1:' + this.port; }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res);
      });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.logger('[desktop-rpc] listening on ' + this.url);
        resolve(this.url);
      });
    });
  }

  async handle(req, res) {
    const send = (code, body) => {
      const raw = JSON.stringify(body);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(raw);
    };
    if (req.method !== 'POST' || req.url !== '/rpc') {
      send(404, { ok: false, error: 'not found' });
      return;
    }
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== this.token) {
      send(401, { ok: false, error: 'unauthorized' });
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        send(400, { ok: false, error: 'invalid json' });
        return;
      }
      const method = String(payload.method || '');
      const handler = this.handlers.get(method);
      if (!handler) {
        send(404, { ok: false, error: 'unknown method: ' + method });
        return;
      }
      try {
        // handler 声明第二参数时可拿到 { req, res }，用于感知客户端断开（如取消长时间推理）。
        const result = handler.length >= 2
          ? await handler(payload.params || {}, { req, res })
          : await handler(payload.params || {});
        send(200, { ok: true, result });
      } catch (err) {
        send(500, { ok: false, error: (err && err.message) ? err.message : String(err) });
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
      this.port = null;
    });
  }
}

module.exports = { DesktopRpcServer };
