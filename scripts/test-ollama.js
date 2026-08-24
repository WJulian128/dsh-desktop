// Ollama 集成模块测试：mock 本地 Ollama API（/api/version、/api/tags），
// 验证 getStatus 的状态判定与模型解析（安装/下载/拉取需真实网络与磁盘，不做）。
// 用法：node scripts\test-ollama.js
'use strict';
const http = require('node:http');
const { getStatus, VISION_MODELS, isLocalOllama } = require('../main/ollama.js');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

async function main() {
  const mock = http.createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.11.2' }));
    } else if (req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:3b', size: 2306867200 }, { name: 'llava:7b', size: 4700000000 }] }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
  const port = mock.address().port;

  try {
    const status = await getStatus({ port });
    check('running detected', status.running === true, '');
    check('models parsed', Array.isArray(status.models) && status.models.length === 2 && status.models[0].name === 'qwen2.5vl:3b', JSON.stringify(status.models));
    check('apiBase uses port', status.apiBase.includes(String(port)), status.apiBase);

    const offline = await getStatus({ port: 1 });
    check('offline => running=false', offline.running === false, 'serverError=' + offline.serverError);
    check('offline still reports installed field', typeof offline.installed === 'boolean', '');

    check('vision model presets', VISION_MODELS.length >= 4 && VISION_MODELS.some((m) => m.name === 'qwen2.5vl:7b') && VISION_MODELS.some((m) => m.name === 'qwen2.5vl:3b'), VISION_MODELS.map((m) => m.name).join(','));

    // isLocalOllama：纯函数（不触碰网络/真实 Ollama），判断 baseUrl 是否指向本地 Ollama。
    check('isLocalOllama 127.0.0.1:11434/v1', isLocalOllama('127.0.0.1:11434/v1') === true, '');
    check('isLocalOllama http://127.0.0.1:11434 (无 /v1 后缀)', isLocalOllama('http://127.0.0.1:11434') === true, '');
    check('isLocalOllama localhost:11434', isLocalOllama('localhost:11434') === true, '');
    check('isLocalOllama http://localhost:11434/v1', isLocalOllama('http://localhost:11434/v1') === true, '');
    check('isLocalOllama 第三方 baseUrl 为 false', isLocalOllama('https://api.other.com/v1') === false, '');
    check('isLocalOllama 本地但端口错误为 false', isLocalOllama('http://127.0.0.1:8080/v1') === false, '');
    check('isLocalOllama 空串为 false', isLocalOllama('') === false, '');
    check('isLocalOllama 空白串为 false', isLocalOllama('   ') === false, '');
    check('isLocalOllama null 为 false', isLocalOllama(null) === false, '');
  } finally {
    await new Promise((resolve) => mock.close(() => resolve()));
  }

  if (failures.length) { console.log('OLLAMA FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('OLLAMA OK');
}

main().catch((err) => { console.error('OLLAMA CRASH:', err); process.exit(2); });
