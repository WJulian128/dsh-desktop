// 企业微信群机器人推送单测（注入式 transport，不联网）：
//  - 成功（errcode 0）
//  - 限流 45009 不重试直接失败
//  - 其他 errcode / 网络异常：重试一次
//  - markdown 4096 字节截断（多字节字符不劈开）
//  - URL 格式校验
// 用法：node scripts\test-wechat-push.js
'use strict';
const { wechatPush, formatReplyMarkdown, truncateUtf8Bytes, MAX_MARKDOWN_BYTES } = require('../main/bot-gateway/wechat-push');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

async function main() {
  const OK_URL = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc';

  // 1. 成功
  const r1 = await wechatPush({
    webhookUrl: OK_URL, content: 'hi',
    httpTransport: async () => ({ status: 200, body: { errcode: 0, errmsg: 'ok' } }),
    sleep: async () => {},
  });
  check('errcode 0 → ok', r1.ok === true, JSON.stringify(r1));

  // 2. 限流不重试
  let calls45009 = 0;
  const r2 = await wechatPush({
    webhookUrl: OK_URL, content: 'hi',
    httpTransport: async () => { calls45009++; return { status: 200, body: { errcode: 45009, errmsg: 'api freq out of limit' } }; },
    sleep: async () => {},
  });
  check('45009 限流立即失败且不重试', r2.ok === false && calls45009 === 1, 'calls=' + calls45009);

  // 3. 其他 errcode 重试一次
  let callsErr = 0;
  const r3 = await wechatPush({
    webhookUrl: OK_URL, content: 'hi',
    httpTransport: async () => { callsErr++; return { status: 200, body: { errcode: 93000, errmsg: 'invalid key' } }; },
    sleep: async () => {},
  });
  check('errcode 93000 重试一次（共 2 次）', r3.ok === false && callsErr === 2, 'calls=' + callsErr);

  // 4. 网络异常重试一次，第二次成功
  let callsNet = 0;
  const r4 = await wechatPush({
    webhookUrl: OK_URL, content: 'hi',
    httpTransport: async () => {
      callsNet++;
      if (callsNet === 1) throw new Error('ECONNRESET');
      return { status: 200, body: { errcode: 0 } };
    },
    sleep: async () => {},
  });
  check('网络异常重试后成功', r4.ok === true && callsNet === 2, 'calls=' + callsNet);

  // 5. 截断（多字节安全）
  const longText = '汉'.repeat(2000) + 'abc';
  const cut = truncateUtf8Bytes(longText, MAX_MARKDOWN_BYTES);
  check('超长截断到 ≤4096 字节', Buffer.byteLength(cut, 'utf8') <= MAX_MARKDOWN_BYTES, String(Buffer.byteLength(cut, 'utf8')));
  check('截断后仍是合法 UTF-8（无半字符）', !cut.includes('\uFFFD'), '');
  const short = truncateUtf8Bytes('短文本', MAX_MARKDOWN_BYTES);
  check('短文本不截断', short === '短文本', short);

  // 6. URL 校验
  const r6 = await wechatPush({
    webhookUrl: 'https://evil.example.com/hook', content: 'hi',
    httpTransport: async () => ({ status: 200, body: { errcode: 0 } }),
    sleep: async () => {},
  });
  check('非法 URL 拒绝', r6.ok === false && /格式不对/.test(r6.error || ''), r6.error);
  const r7 = await wechatPush({ webhookUrl: '', content: 'hi', httpTransport: async () => ({ status: 200, body: {} }) });
  check('空 URL 拒绝', r7.ok === false, r7.error);

  // 7. formatReplyMarkdown
  check('formatReplyMarkdown 带标题', formatReplyMarkdown('答案').startsWith('### DSH 桌面端回复'), '');

  if (failures.length) { console.log('WECHAT-PUSH FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('WECHAT-PUSH OK');
}
main().catch((err) => { console.error('TEST CRASH: ' + (err && err.stack || err)); process.exit(1); });
