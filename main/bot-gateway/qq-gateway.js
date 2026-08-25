'use strict';
/**
 * QQ 官方机器人网关（v2 API + WebSocket 长连接）。
 * 纯 Node 模块（Electron 主进程内运行；Node ≥22 内置全局 WebSocket）。
 * 协议依据官方文档（bot.q.qq.com/wiki）：
 *   - 鉴权：POST https://bots.qq.com/app/getAppAccessToken（appId + clientSecret → access_token，7200s）
 *   - 接入点：GET https://api.sgroup.qq.com/gateway（Authorization: QQBot {token}）→ { url }
 *   - WebSocket：OpCode 10 Hello（heartbeat_interval）→ OpCode 2 Identify（token="QQBot {accessToken}"，
 *     intents、shard [0,1]）→ OpCode 0 READY（session_id）→ OpCode 1 心跳（d=最新 s 或 null）→ OpCode 11 ACK；
 *     断线重连走 OpCode 6 RESUME（token + session_id + seq）；事件均为 OpCode 0 Dispatch。
 *   - 消息：C2C_MESSAGE_CREATE（单聊）/ GROUP_AT_MESSAGE_CREATE（群 AT）/ AT_MESSAGE_CREATE（频道）
 *   - 发送：POST /v2/users/{openid}/messages、/v2/groups/{group_openid}/messages、/v2/channels/{channel_id}/messages
 * 依赖注入（测试用）：httpTransport({method,url,headers,body}) → {status,body}；wsFactory(url) → WebSocket 兼容对象。
 * 事件回调（构造参数）：onEvent({kind:'c2c'|'group'|'channel', id, authorId, authorName, text, raw})；onState(state)。
 */
const API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
// intents：513（官方示例：频道+频道消息）+ 1<<25（单聊/群聊事件 C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE）
const INTENTS = 513 | (1 << 25);

function defaultTransport({ method, url, headers, body }) {
  const isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;
  if (isNode) {
    // Node 18+ 内置 fetch
    return fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  }
  return Promise.reject(new Error('qq-gateway: 需要 Node 内置 fetch'));
}

class QqGateway {
  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.appSecret
   * @param {(msg:object)=>void} [opts.onEvent] 收到归一化消息
   * @param {(state:string, detail?:string)=>void} [opts.onState] 状态回调（idle/connecting/ready/disconnected/error）
   * @param {(text:string)=>void} [opts.log]
   * @param {(req:object)=>Promise<object>} [opts.httpTransport]
   * @param {(url:string)=>object} [opts.wsFactory]
   * @param {(ms:number)=>Promise<void>} [opts.sleep]
   */
  constructor(opts) {
    this.appId = String(opts.appId || '');
    this.appSecret = String(opts.appSecret || '');
    this.onEvent = opts.onEvent || (() => {});
    this.onState = opts.onState || (() => {});
    this.log = opts.log || (() => {});
    this.http = opts.httpTransport || defaultTransport;
    this.wsFactory = opts.wsFactory || ((url) => new WebSocket(url));
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.token = null;         // { value, expiresAt }
    this.ws = null;
    this.sessionId = null;
    this.lastSeq = null;       // 最新 Dispatch 的 s（RESUME 用）
    this.ready = false;
    this.stopped = false;
    this.heartbeatTimer = null;
    this.reconnectDelay = 3000; // 重连退避：3s 起，最大 60s
    this.state = 'idle';
  }

  setState(state, detail) {
    this.state = state;
    try { this.onState(state, detail || ''); } catch { /* 忽略 */ }
  }

  /** 获取 access_token（缓存，提前 5 分钟刷新）。 */
  async getAccessToken() {
    const now = Date.now();
    if (this.token && this.token.expiresAt - now > 5 * 60 * 1000) return this.token.value;
    const res = await this.http({
      method: 'POST', url: TOKEN_URL,
      body: { appId: this.appId, clientSecret: this.appSecret },
    });
    if (res.status !== 200 || !res.body || !res.body.access_token) {
      throw new Error('获取 access_token 失败（HTTP ' + res.status + '）：' + JSON.stringify(res.body).slice(0, 200));
    }
    this.token = { value: res.body.access_token, expiresAt: now + Number(res.body.expires_in || 7200) * 1000 };
    return this.token.value;
  }

  /** 获取通用 WSS 接入点地址。 */
  async getGatewayUrl() {
    const token = await this.getAccessToken();
    const res = await this.http({
      method: 'GET', url: API_BASE + '/gateway',
      headers: { Authorization: 'QQBot ' + token },
    });
    if (res.status !== 200 || !res.body || !res.body.url) {
      throw new Error('获取 WSS 接入点失败（HTTP ' + res.status + '）：' + JSON.stringify(res.body).slice(0, 200));
    }
    return String(res.body.url);
  }

  sendJson(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const op = msg && msg.op;
    if (op === 10) {
      // Hello：按 heartbeat_interval 启心跳
      const interval = (msg.d && msg.d.heartbeat_interval) || 45000;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        this.sendJson({ op: 1, d: this.lastSeq });
      }, interval);
      this.log('[qq-bot] Hello，心跳周期 ' + interval + 'ms');
    } else if (op === 11) {
      // Heartbeat ACK：无需处理
    } else if (op === 0) {
      // Dispatch
      if (msg.s !== null && msg.s !== undefined) this.lastSeq = msg.s;
      this.handleDispatch(msg);
    } else if (op === 7) {
      // Reconnect：服务端要求重连
      this.log('[qq-bot] 服务端要求重连（op 7），准备重连');
      try { if (this.ws) this.ws.close(); } catch { /* 忽略 */ }
    } else {
      this.log('[qq-bot] 未知 opcode：' + op);
    }
  }

  handleDispatch(msg) {
    const t = msg.t;
    const d = msg.d || {};
    if (t === 'READY') {
      this.sessionId = d.session_id || null;
      this.ready = true;
      this.reconnectDelay = 3000;
      const user = d.user || {};
      this.setState('ready', user.username || '');
      this.log('[qq-bot] READY：' + (user.username || user.id || '') + ' session=' + this.sessionId);
      return;
    }
    if (t === 'RESUMED') {
      this.ready = true;
      this.setState('ready', '');
      this.log('[qq-bot] RESUME 成功');
      return;
    }
    if (t === 'C2C_MESSAGE_CREATE' || t === 'GROUP_AT_MESSAGE_CREATE' || t === 'AT_MESSAGE_CREATE') {
      let kind = 'channel';
      let text = '';
      let authorId = '';
      let authorName = '';
      let id = '';
      try {
        if (t === 'C2C_MESSAGE_CREATE') {
          kind = 'c2c';
          text = d.content || '';
          authorId = (d.author && d.author.user_openid) || '';
          id = d.id || '';
        } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
          kind = 'group';
          text = d.content || '';
          authorId = (d.author && d.author.member_openid) || '';
          id = d.id || '';
        } else {
          kind = 'channel';
          text = d.content || '';
          authorId = (d.author && d.author.id) || '';
          id = d.id || '';
        }
        if (d.author) {
          authorName = (d.author.username) || (d.author.user && d.author.user.username) || '';
        }
        text = String(text).replace(/<@!?\d+>/g, '').trim();
        if (text) {
          this.onEvent({
            kind, id,
            authorId, authorName,
            groupOpenid: (d.group_openid) || '',
            channelId: (d.channel_id) || '',
            text, raw: d,
          });
        }
      } catch (err) {
        this.log('[qq-bot] 消息解析失败：' + (err && err.message ? err.message : err));
      }
    }
  }

  async connectOnce(isResume) {
    const token = await this.getAccessToken();
    const url = await this.getGatewayUrl();
    this.ws = this.wsFactory(url);
    const ws = this.ws;
    // 先注册 message/close（避免 open 前断开漏监听），再等 open
    ws.addEventListener('message', (ev) => {
      const raw = (ev && ev.data !== undefined) ? ev.data : ev;
      this.handleMessage(raw);
    });
    ws.addEventListener('close', (ev) => {
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      this.ready = false;
      if (this.stopped) return;
      this.setState('disconnected', String((ev && ev.code) || ''));
      this.log('[qq-bot] 连接断开（code=' + ((ev && ev.code) || '') + '），' + this.reconnectDelay + 'ms 后重连');
      setTimeout(() => { this.reconnectLoop(); }, this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    });
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        if (isResume && this.sessionId) {
          this.sendJson({
            op: 6,
            d: { token: 'QQBot ' + token, session_id: this.sessionId, seq: this.lastSeq },
          });
          this.log('[qq-bot] 已发送 RESUME（session=' + this.sessionId + ' seq=' + this.lastSeq + '）');
        } else {
          this.sendJson({
            op: 2,
            d: {
              token: 'QQBot ' + token,
              intents: INTENTS,
              shard: [0, 1],
              properties: { $os: 'windows', $browser: 'dsh-desktop', $device: 'dsh-desktop' },
            },
          });
          this.log('[qq-bot] 已发送 Identify');
        }
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(new Error('WebSocket 连接失败：' + ((err && err.message) || err)));
      };
      const cleanup = () => {
        try { ws.removeEventListener('open', onOpen); } catch { /* 忽略 */ }
        try { ws.removeEventListener('error', onError); } catch { /* 忽略 */ }
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  async reconnectLoop() {
    if (this.stopped) return;
    try {
      this.setState('connecting', '');
      await this.connectOnce(true);
    } catch (err) {
      this.log('[qq-bot] 重连失败：' + (err && err.message ? err.message : err));
      this.setState('disconnected', (err && err.message ? err.message : '').slice(0, 120));
      if (!this.stopped) setTimeout(() => { this.reconnectLoop(); }, this.reconnectDelay);
    }
  }

  /** 启动网关：鉴权 → 接入点 → WebSocket 长连接（含自动重连）。 */
  async start() {
    if (this.stopped) return;
    if (!this.appId || !this.appSecret) throw new Error('缺少 QQ AppID/AppSecret');
    this.stopped = false;
    this.setState('connecting', '');
    try {
      await this.connectOnce(false);
    } catch (err) {
      this.log('[qq-bot] 启动失败：' + (err && err.message ? err.message : err));
      this.setState('error', (err && err.message ? err.message : '').slice(0, 120));
      if (!this.stopped) setTimeout(() => { this.reconnectLoop(); }, this.reconnectDelay);
    }
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* 忽略 */ } this.ws = null; }
    this.ready = false;
    this.setState('idle', '');
  }

  /** 带鉴权的 API 请求。 */
  async api(method, apiPath, body) {
    const token = await this.getAccessToken();
    return this.http({
      method, url: API_BASE + apiPath,
      headers: { Authorization: 'QQBot ' + token },
      body,
    });
  }

  /** 发送文本消息（C2C/群/频道统一入口）。msg_id 用于被动回复窗口内的群消息。 */
  async sendText(target, text) {
    const content = String(text || '').slice(0, 2000);
    if (!content) return { ok: false, error: '空消息' };
    let res;
    if (target.kind === 'c2c') {
      res = await this.api('POST', '/v2/users/' + encodeURIComponent(target.openid) + '/messages',
        { content, msg_type: 0 });
    } else if (target.kind === 'group') {
      res = await this.api('POST', '/v2/groups/' + encodeURIComponent(target.groupOpenid) + '/messages',
        { content, msg_type: 0, ...(target.msgId ? { msg_id: target.msgId } : {}) });
    } else {
      res = await this.api('POST', '/v2/channels/' + encodeURIComponent(target.channelId) + '/messages',
        { content, msg_type: 0 });
    }
    if (res.status === 200 || res.status === 201 || res.status === 204) return { ok: true };
    return { ok: false, error: 'HTTP ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 160) };
  }
}

module.exports = { QqGateway, INTENTS, API_BASE, TOKEN_URL };
