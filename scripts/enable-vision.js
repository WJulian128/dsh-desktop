// 把本地 Ollama 视觉模型写入多模态设置（settings.json），并真实测试一次识别。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { testVision } = require('../main/vision.js');

const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'settings.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
data.vision = { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5vl:7b' };
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('vision settings written:', JSON.stringify(data.vision));

// 真实端到端测试（1x1 像素图 → 本地 qwen2.5vl:7b）
(async () => {
  try {
    const t = await testVision(data.vision);
    console.log('E2E VISION OK, sample:', t.sample);
  } catch (err) {
    console.log('E2E VISION FAIL:', (err && err.message) || String(err));
    process.exit(2);
  }
})();
