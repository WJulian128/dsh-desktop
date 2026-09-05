// 多模态模块测试：mock OpenAI 兼容服务端，验证 describeImage（文件/附件引用）与
// testVision 的请求构造与响应解析。用法：node scripts\test-vision.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describeImage, testVision, preprocessImage, attachmentPath, modelSupportsVision, readCurrentModel } = require('../main/vision.js');
const sharp = require('sharp');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

async function main() {

// 1. mock 视觉模型服务端
let lastRequest = null;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const doc = JSON.parse(body);
    lastRequest = { url: req.url, auth: req.headers.authorization, body: doc };
    if (doc.stream) {
      // OpenAI 兼容 SSE 流式：增量 delta.content，最后 data: [DONE]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = ['图片描', '述：一个蓝', '色按钮，写着“提交”。'];
      for (const p of parts) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '图片描述：一个蓝色按钮，写着“提交”。' } }] }));
  });
});
await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const baseUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
const vision = { enabled: true, baseUrl, apiKey: 'sk-test-vision', model: 'gpt-4o-mini' };

// 2. 临时图片文件 + 附件引用
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vision-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const filePath = path.join(tmp, 'shot.png');
fs.writeFileSync(filePath, png);

const dshHome = path.join(tmp, 'home');
const attId = 'a'.repeat(64);
const attFile = attachmentPath(dshHome, attId);
fs.mkdirSync(path.dirname(attFile), { recursive: true });
fs.writeFileSync(attFile, png);

try {
  // 3. describeImage（文件路径）
  const desc = await describeImage(vision, { path: filePath, dshHome });
  check('describeImage returns text', typeof desc === 'string' && desc.includes('蓝色按钮'), desc.slice(0, 60));
  check('vision request has auth', lastRequest.auth === 'Bearer sk-test-vision', lastRequest.auth);
  const userMsg = lastRequest.body.messages.find((m) => m.role === 'user');
  const part = userMsg && userMsg.content && userMsg.content[0];
  check('vision request carries data-url image', !!part && part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'), part && part.image_url && part.image_url.url.slice(0, 30));
  check('vision request model correct', lastRequest.body.model === 'gpt-4o-mini', lastRequest.body.model);

  // 4. describeImage（附件引用）
  const descRef = await describeImage(vision, { ref: 'dsh-attachment sha256:' + attId, dshHome });
  check('describeImage resolves attachment ref', typeof descRef === 'string' && descRef.includes('蓝色按钮'), '');

  // 4a. describeImage（dataUrl：粘贴/附件图片无本地路径时的直通通道）
  const descData = await describeImage(vision, { dataUrl: 'data:image/png;base64,' + png.toString('base64'), dshHome });
  check('describeImage accepts dataUrl (pasted image)', typeof descData === 'string' && descData.includes('蓝色按钮'), String(descData).slice(0, 60));
  const userData = lastRequest.body.messages.find((m) => m.role === 'user');
  const dataPart = userData && userData.content && userData.content[0];
  check('dataUrl image forwarded to vision model', !!dataPart && dataPart.type === 'image_url' && dataPart.image_url.url.startsWith('data:image/png;base64,'), '');
  let dataRejected = false;
  try { await describeImage(vision, { dataUrl: 'not-a-data-url', dshHome }); } catch { dataRejected = true; }
  check('invalid dataUrl errors clearly', dataRejected, '');

  // 4b. 注意力对齐：question 任务条件化
  await describeImage(vision, { path: filePath, dshHome, question: '这个按钮的颜色是什么？' });
  const sysQ = lastRequest.body.messages.find((m) => m.role === 'system');
  const userQ = lastRequest.body.messages.find((m) => m.role === 'user');
  check('question carried to vision model', typeof sysQ.content === 'string' && sysQ.content.includes('Center your attention') && JSON.stringify(userQ.content).includes('这个按钮的颜色是什么？'), (sysQ && sysQ.content || '').slice(0, 120));
  check('transcript-first prompt rule present', typeof sysQ.content === 'string' && sysQ.content.includes('TRANSCRIBE ALL READABLE TEXT VERBATIM'), '');

  // 4c. 注意力对齐：region 局部裁剪放大
  await describeImage(vision, { path: filePath, dshHome, region: { x: 0, y: 0, width: 1, height: 1 }, question: '左上角像素是什么颜色？' });
  const userR = lastRequest.body.messages.find((m) => m.role === 'user');
  const imgPart = (userR.content || []).find((p) => p && p.type === 'image_url');
  const sysR = lastRequest.body.messages.find((m) => m.role === 'system');
  let croppedOk = false;
  if (imgPart && imgPart.image_url && imgPart.image_url.url.startsWith('data:image/png;base64,')) {
    const buf = Buffer.from(imgPart.image_url.url.slice('data:image/png;base64,'.length), 'base64');
    const meta = await sharp(buf).metadata();
    croppedOk = meta.width === 1 && meta.height === 1;
  }
  check('region crop produces 1x1 image', croppedOk, '');
  check('region note attached to prompt', typeof sysR.content === 'string' && sysR.content.includes('CROPPED REGION'), '');

  // 4d. 图片预处理：长边 > 1280 等比缩小（降低视觉 token 与 CPU 推理耗时），小图保持原样
  const big = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: { r: 210, g: 210, b: 210 } } }).png().toBuffer();
  const bigFile = path.join(tmp, 'big.png');
  fs.writeFileSync(bigFile, big);
  const pre = await preprocessImage(big);
  const preMeta = await sharp(pre.data).metadata();
  check('preprocessImage shrinks long edge to 1280', pre.mediaType === 'image/png' && preMeta.width === 1280 && preMeta.height === 720, preMeta.width + 'x' + preMeta.height);
  const preSmall = await preprocessImage(png);
  check('preprocessImage keeps small image unchanged', preSmall.mediaType === null && preSmall.data.equals(png), '');
  await describeImage(vision, { path: bigFile, dshHome });
  const userBig = lastRequest.body.messages.find((m) => m.role === 'user');
  const bigPart = (userBig.content || []).find((p) => p && p.type === 'image_url');
  let sentPreOk = false;
  if (bigPart && bigPart.image_url && bigPart.image_url.url.startsWith('data:image/png;base64,')) {
    const buf = Buffer.from(bigPart.image_url.url.slice('data:image/png;base64,'.length), 'base64');
    const m2 = await sharp(buf).metadata();
    sentPreOk = m2.width === 1280 && m2.height === 720;
  }
  check('describeImage sends preprocessed image to model', sentPreOk, '');

  // 4e. 流式识别：增量经 onDelta 回调（桌面端浮层实时展示识别过程的链路）
  const deltas = [];
  const descStream = await describeImage(vision, { path: filePath, dshHome, stream: true, onDelta: (t) => deltas.push(t) });
  check('streaming describeImage returns full text', descStream === '图片描述：一个蓝色按钮，写着“提交”。', descStream);
  check('streaming onDelta receives all increments in order', deltas.join('') === '图片描述：一个蓝色按钮，写着“提交”。' && deltas.length === 3, deltas.join('|'));

  // 5. 未启用时拒绝
  let rejected = false;
  try { await describeImage({ ...vision, enabled: false }, { path: filePath, dshHome }); } catch { rejected = true; }
  check('describeImage rejects when disabled', rejected, '');

  // 6. 无效引用报错
  let badRef = false;
  try { await describeImage(vision, { ref: 'sha256:' + 'b'.repeat(64), dshHome }); } catch { badRef = true; }
  check('unknown attachment ref errors', badRef, '');

  // 7. testVision
  const t = await testVision(vision);
  check('testVision works', t.ok === true && t.sample.includes('蓝色按钮'), t.sample);

  // 8. 模型多模态能力判定（截图分流依据）
  check('modelSupportsVision vision-exp', modelSupportsVision('deepseek-v4-flash-vision-exp') === true, '');
  check('modelSupportsVision flash text-only', modelSupportsVision('deepseek-v4-flash') === false, '');
  check('modelSupportsVision local qwen2.5vl', modelSupportsVision('qwen2.5vl:7b') === true, '');
  check('modelSupportsVision pro text-only', modelSupportsVision('deepseek-v4-pro') === false, '');
  check('modelSupportsVision null/empty', modelSupportsVision(null) === false && modelSupportsVision('') === false, '');

  // 9. readCurrentModel：从构造的会话文件读最后 request/context.model
  const sessRoot = path.join(tmp, 'sessions', '--C-test--');
  fs.mkdirSync(path.join(sessRoot, 's1'), { recursive: true });
  const zlib = require('node:zlib');
  const enc = (records) => zlib.zstdCompressSync(Buffer.from(records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
  const mkSession = (dir, records) => fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), enc(records));
  const mk = (dir) => { fs.mkdirSync(dir, { recursive: true }); return dir; };
  mkSession(mk(path.join(sessRoot, 's1')), [
    { type: 'session', id: 's1', createdAt: 1000 },
    { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000000 } },
    { type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } } },
  ]);
  check('readCurrentModel picks newest request model (header config)', readCurrentModel(path.join(tmp, 'sessions'), '--C-test--') === 'deepseek-v4-pro', String(readCurrentModel(path.join(tmp, 'sessions'), '--C-test--')));
  check('readCurrentModel empty dir returns null', readCurrentModel(path.join(tmp, 'sessions'), '--no-such--') === null, '');
} finally {
  await new Promise((resolve) => mock.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) { console.log('VISION FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('VISION OK');
}

main().catch((err) => { console.error('VISION CRASH:', err); process.exit(2); });
