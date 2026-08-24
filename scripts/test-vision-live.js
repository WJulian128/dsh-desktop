// 本地视觉模型真实端到端测试：走 main/vision.js 完整链路（预处理 + 流式 + 超时）
// 对本地 Ollama（127.0.0.1:11434）已拉取的视觉模型发一张带文字/编号的合成图，
// 验证识别成功、流式增量完整、耗时合理。Ollama 未运行或没有视觉模型时 SKIP（退出 0）。
// 这是"本地多模态不出问题"的守门测试：改完 vision 链路先跑它。
// 用法：node scripts\test-vision-live.js [--max-sec 480]
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { describeImage, preprocessImage } = require('../main/vision.js');

const BASE = 'http://127.0.0.1:11434';
const MAX_SEC = (() => {
  const i = process.argv.indexOf('--max-sec');
  return i >= 0 && Number(process.argv[i + 1]) > 0 ? Math.round(Number(process.argv[i + 1])) : 480;
})();

function httpJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('响应不是合法 JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
  });
}

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

async function main() {
  let tags;
  try { tags = await httpJson(BASE + '/api/tags'); } catch (err) {
    console.log('SKIP: 本地 Ollama 未运行（' + (err && err.message) + '）。启动后重跑本测试。');
    return;
  }
  const visionModels = (tags.models || []).filter((m) => /vl|vision|llava|multimodal|image/i.test(String(m.name || '')));
  if (!visionModels.length) {
    console.log('SKIP: Ollama 在运行但尚未拉取视觉模型。在设置 → 多模态里拉取后重跑。');
    return;
  }
  const model = visionModels[0].name;
  const vision = { enabled: true, baseUrl: BASE + '/v1', apiKey: '', model };
  console.log('模型: ' + model + '（超时上限 ' + MAX_SEC + 's）');

  // 合成测试图：深底 + 大号编号 8888（数字渲染不依赖中文字体），1920×1080 模拟截图尺寸
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">' +
    '<rect width="1920" height="1080" fill="#1e1e2e"/>' +
    '<text x="960" y="520" font-size="180" fill="#ffffff" text-anchor="middle" font-family="Arial">VISION-LIVE-8888</text>' +
    '<text x="960" y="700" font-size="64" fill="#a6e3a1" text-anchor="middle" font-family="Arial">ticket 42</text>' +
    '</svg>';
  const img = await sharp(Buffer.from(svg)).png().toBuffer();
  const meta = await sharp(img).metadata();
  check('synthetic image created', meta.width === 1920 && meta.height === 1080, meta.width + 'x' + meta.height);

  // 预处理断言（不依赖 Ollama）：长边缩到 1280
  const pre = await preprocessImage(img);
  const preMeta = await sharp(pre.data).metadata();
  check('preprocess shrinks 1920x1080 to 1280x720', preMeta.width === 1280 && preMeta.height === 720, preMeta.width + 'x' + preMeta.height);

  const tmp = path.join(os.tmpdir(), 'dsh-vision-live-' + Date.now() + '.png');
  fs.writeFileSync(tmp, img);

  // 流式 + 计时（真实推理；注意 qwen2.5vl 等 CPU 模型可能 1~8 分钟）
  const deltas = [];
  const t0 = Date.now();
  try {
    const desc = await describeImage(vision, {
      path: tmp,
      question: '这张图里的编号（VISION-LIVE 后面的数字）是多少？逐字输出图片中的所有文字。',
      stream: true,
      onDelta: (t) => deltas.push(t),
      timeoutMs: MAX_SEC * 1000,
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log('耗时: ' + elapsed + 's（增量块数 ' + deltas.length + '，输出 ' + desc.length + ' 字符）');
    check('inference completed within timeout', elapsed < MAX_SEC, '');
    check('streamed deltas reassemble the full answer', deltas.join('') === desc && deltas.length >= 1, deltas.length + ' chunks');
    check('OCR found expected number', /8888/.test(desc), desc.slice(0, 160));
  } catch (err) {
    console.log('识别失败: ' + (err && err.message) + '（耗时 ' + Math.round((Date.now() - t0) / 1000) + 's）');
    check('inference did not error', false, (err && err.message) || String(err));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  }

  if (failures.length) { console.log('VISION-LIVE FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('VISION-LIVE OK');
}

main().catch((err) => { console.error('VISION-LIVE CRASH:', err); process.exit(2); });
