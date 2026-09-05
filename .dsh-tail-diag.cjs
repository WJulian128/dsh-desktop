// 临时诊断：查看会话尾部记录序列（用户消息/助手消息/拒图/识别注入）
'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');
const f = process.argv[2];
const b = fs.readFileSync(f);
const chunks = [];
for (let i = 0; i + 4 <= b.length; i++) {
  if (b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd) {
    try {
      const o = zlib.zstdDecompressSync(b.subarray(i));
      if (o.length && o[0] === 0x7b) chunks.push(o);
    } catch { /* magic false positive */ }
  }
}
const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.trim());
const tail = lines.slice(-80);
let last = 0;
const textOf = (content) => {
  if (!Array.isArray(content)) return String(content || '');
  return content.map((x) => {
    if (!x) return '';
    if (x.type === 'text') return String(x.text || '');
    if (x.type === 'image' || x.type === 'image_url') return '[image]';
    if (x.type === 'tool-call') return '[tool:' + String(x.name || '?') + ']';
    return '[' + String(x.type || '?') + ']';
  }).join(' | ');
};
for (const l of tail) {
  try {
    const j = JSON.parse(l);
    const t = j.type;
    const time = j.time || 0;
    if (last && time > last + 15000) console.log('---- (gap) ----');
    last = time;
    if (t === 'user/message' || t === 'assistant/message') {
      const msg = (j.data && (j.data.message || j.data)) || {};
      console.log(new Date(time).toLocaleTimeString(), t === 'user/message' ? 'USER:' : 'ASST:', textOf(msg.content).slice(0, 200));
    } else if (t === 'user/prompt') {
      console.log(new Date(time).toLocaleTimeString(), 'PROMPT:', String(JSON.stringify(j.data || '')).slice(0, 200));
    }
  } catch { /* skip */ }
}
