'use strict';
/**
 * 企业微信群机器人 webhook 推送（单向：agent 主动推送到群，收不到群消息）。
 * 官方接口：POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=KEY
 *  markdown 消息 content 上限 4096 字节（超长按字节安全截断）。
 * 限制：每机器人 20 条/分钟（超限接口会拒绝，模块只做一次重试）。
 * 依赖注入（测试用）：httpTransport({method,url,body}) → {status,body}；sleep。
 */
const WECOM_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';
const MAX_MARKDOWN_BYTES = 4096;

function defaultTransport({ method, url, body }) {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

/** 按 UTF-8 字节数安全截断（markdown 4096 字节上限；逐字符按字节预算拼接，绝不劈开多字节字符；
 *  后缀「…（已截断）」预留在预算内）。 */
function truncateUtf8Bytes(text, maxBytes) {
  const s = String(text || '');
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const suffix = '\u2026\uff08\u5df2\u622a\u65ad\uff09'; // …（已截断）
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  if (budget <= 0) return suffix; // 上限小到放不下正文：只给后缀（极端兜底）
  let out = '';
  let used = 0;
  for (const ch of s) { // for-of 按码点迭代，代理对/多字节字符天然完整
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  return out + suffix;
}

/**
 * 推送一条 markdown 到企业微信群。
 * @param {object} opts
 * @param {string} opts.webhookUrl 完整 webhook 地址（含 key）
 * @param {string} opts.content markdown 内容
 * @param {(text:string)=>void} [opts.log]
 * @param {(req:object)=>Promise<object>} [opts.httpTransport]
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function wechatPush({ webhookUrl, content, log = () => {}, httpTransport = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const http = httpTransport || defaultTransport;
  const url = String(webhookUrl || '').trim();
  if (!url) return { ok: false, error: '未配置企业微信 webhook 地址' };
  if (!/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=/.test(url)) {
    return { ok: false, error: 'webhook 地址格式不对（应以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key= 开头）' };
  }
  const body = { msgtype: 'markdown', markdown: { content: truncateUtf8Bytes(content, MAX_MARKDOWN_BYTES) } };
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await http({ method: 'POST', url, body });
      // 官方返回 { errcode, errmsg }（HTTP 始终 200）
      const errcode = res.body && res.body.errcode;
      if (errcode === 0 || errcode === undefined) return { ok: true };
      lastErr = new Error('errcode=' + errcode + ' ' + (res.body && res.body.errmsg || ''));
      if (errcode === 45009) return { ok: false, error: '接口调用超限（每分钟 20 条）：' + (res.body && res.body.errmsg || '') }; // 限流不再重试
    } catch (err) {
      lastErr = err;
    }
    if (attempt === 1) await sleep(1200);
  }
  const msg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
  log('[wechat-push] 推送失败：' + msg);
  return { ok: false, error: msg.slice(0, 200) };
}

/** 把 agent 回复文本包一层标题（推送用）。 */
function formatReplyMarkdown(text) {
  return '### DSH 桌面端回复\n' + String(text || '');
}

module.exports = { wechatPush, formatReplyMarkdown, truncateUtf8Bytes, MAX_MARKDOWN_BYTES };
