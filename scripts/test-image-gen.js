// 文生图模块单测（注入式 transport，不联网）：
//  - 配置校验（未启用/缺 model/baseUrl）
//  - 成功（b64_json 解析、多张、revised_prompt）
//  - 失败（非 200 / data 空 / error.message）
//  - 网络异常 → ok:false 而非抛出
//  - prompt 为空拒绝、n 上限截断、size 覆盖
// 用法：node scripts\test-image-gen.js
'use strict';
const { generateImage, validateConfig } = require('../main/image-gen');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

async function main() {
  const cfg = { enabled: true, baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-1', model: 'FLUX.1-schnell', size: '1024x1024' };

  // 1. 成功：单张 b64
  const r1 = await generateImage(cfg, { prompt: '一只猫' }, {
    httpTransport: async (req) => {
      check('请求 URL/headers/body 正确',
        req.url === 'https://api.siliconflow.cn/v1/images/generations' &&
        req.headers.Authorization === 'Bearer sk-1' &&
        req.body.model === 'FLUX.1-schnell' && req.body.prompt === '一只猫' &&
        req.body.n === 1 && req.body.size === '1024x1024' && req.body.response_format === 'b64_json',
        JSON.stringify(req));
      return { status: 200, body: { data: [{ b64_json: 'aGVsbG8=', revised_prompt: 'better cat' }] } };
    },
  });
  check('成功返回 b64 与 revised_prompt', r1.ok && r1.images.length === 1 && r1.images[0].b64 === 'aGVsbG8=' && r1.images[0].revisedPrompt === 'better cat', JSON.stringify(r1));

  // 2. 成功：多张 + size 覆盖 + n 截断
  const r2 = await generateImage(cfg, { prompt: '猫', n: 9, size: '768x1024' }, {
    httpTransport: async (req) => {
      check('n 截断到 4、size 覆盖生效', req.body.n === 4 && req.body.size === '768x1024', JSON.stringify(req.body));
      return { status: 200, body: { data: [{ url: 'https://cdn.example.com/a.png' }, { b64_json: 'eA==' }] } };
    },
  });
  check('多张与 url 模式', r2.ok && r2.images.length === 2 && r2.images[0].url === 'https://cdn.example.com/a.png' && r2.images[1].b64 === 'eA==', JSON.stringify(r2));

  // 3. 失败：非 200 + error.message
  const r3 = await generateImage(cfg, { prompt: '猫' }, {
    httpTransport: async () => ({ status: 400, body: { error: { message: 'bad prompt', type: 'invalid_request_error' } } }),
  });
  check('非 200 返回友好错误', r3.ok === false && /bad prompt/.test(r3.error), r3.error);

  // 4. 失败：data 为空
  const r4 = await generateImage(cfg, { prompt: '猫' }, {
    httpTransport: async () => ({ status: 200, body: { data: [] } }),
  });
  check('data 空 → 失败', r4.ok === false, r4.error);

  // 5. 网络异常 → ok:false
  const r5 = await generateImage(cfg, { prompt: '猫' }, {
    httpTransport: async () => { throw new Error('ECONNRESET'); },
  });
  check('网络异常不抛出、返回失败', r5.ok === false && /ECONNRESET/.test(r5.error), r5.error);

  // 6. 校验与入参
  const r6 = await generateImage(cfg, { prompt: '  ' }, { httpTransport: async () => ({ status: 200, body: { data: [] } }) });
  check('空 prompt 拒绝', r6.ok === false && /prompt 为空/.test(r6.error), r6.error);
  const r7 = await generateImage({ enabled: false, baseUrl: 'x', model: 'y' }, { prompt: '猫' }, { httpTransport: async () => ({ status: 200, body: {} }) });
  check('未启用拒绝', r7.ok === false && /未启用/.test(r7.error), r7.error);
  let threw = false;
  try { validateConfig({ enabled: true, baseUrl: '', model: 'x' }); } catch { threw = true; }
  check('validateConfig 缺 baseUrl 抛错', threw, '');

  if (failures.length) { console.log('IMAGE-GEN FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('IMAGE-GEN OK');
}
main().catch((err) => { console.error('TEST CRASH: ' + (err && err.stack || err)); process.exit(1); });
