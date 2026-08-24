'use strict';

// 活动足迹扫描子进程：解压 transcript 并解析技能/MCP 调用、本轮文件/网页来源、本轮产出。
// 独立进程运行，绝不阻塞 Electron 主进程（长会话文件可达 10MB+，主进程解压是卡顿来源）。
// 输出一行 JSON：{ ok: true, skills, mcpCalls, turnFiles, turnUrls, turnOutputs } | { ok: false, error }
const fs = require('node:fs');
const { decompressFrames } = require('./usage');

const file = String(process.argv[2] || '');
const FILE_TOOL_NAMES = new Set(['read', 'edit', 'write', 'grep', 'glob']);
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

try {
  if (!file || !fs.existsSync(file)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'no file' }));
    process.exit(0);
  }
  const text = decompressFrames(fs.readFileSync(file));
  const lines = text.split('\n').slice(-2500);
  const skills = [];
  const mcps = [];
  const callsByTurn = new Map(); // turn -> [ { name, args, callId } ]
  const resultsByTurn = new Map(); // turn -> [ { callId, text } ]
  let maxTurn = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r.type !== 'string' || !r.data) continue;
    if (r.type === 'tool/call') {
      const d = r.data;
      const turn = typeof d.turn === 'number' ? d.turn : 0;
      if (turn > maxTurn) maxTurn = turn;
      let args = null;
      if (typeof d.arguments === 'string') { try { args = JSON.parse(d.arguments); } catch { args = null; } }
      const name = String(d.name || '');
      if (!callsByTurn.has(turn)) callsByTurn.set(turn, []);
      callsByTurn.get(turn).push({ name, args, callId: d.callId });
      if (name === 'skill' && args && typeof args.name === 'string' && args.name && !skills.includes(args.name)) skills.push(args.name);
      if (name.indexOf('mcp__') === 0 && !mcps.includes(name)) mcps.push(name);
    } else if (r.type === 'tool/result') {
      try {
        const d = r.data;
        const turn = typeof d.turn === 'number' ? d.turn : 0;
        if (turn > maxTurn) maxTurn = turn;
        const msg = d.message;
        const callId = msg && msg.source && msg.source.callId;
        if (!resultsByTurn.has(turn)) resultsByTurn.set(turn, []);
        resultsByTurn.get(turn).push({ callId, text: JSON.stringify(msg && msg.content) || '' });
      } catch { /* 单条失败不影响整体 */ }
    }
  }
  const turnFiles = [];
  const turnUrls = [];
  const turnOutputs = [];
  const lastCalls = callsByTurn.get(maxTurn) || [];
  const lastResults = resultsByTurn.get(maxTurn) || [];
  const nameById = new Map();
  for (const c of lastCalls) {
    if (c.callId) nameById.set(c.callId, c.name);
    const p = c.args && (c.args.file_path || c.args.path);
    if (typeof p === 'string' && p) {
      if (c.name === 'write') { if (!turnOutputs.includes(p)) turnOutputs.push(p); }
      else if (FILE_TOOL_NAMES.has(c.name)) { if (!turnFiles.includes(p)) turnFiles.push(p); }
    }
  }
  for (const res of lastResults) {
    const callName = nameById.get(res.callId) || '';
    if (!/web_?search|fetch|browse/i.test(callName)) continue;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(res.text)) && turnUrls.length < 20) {
      const u = m[0].replace(/[),.;:]+$/, '');
      if (!turnUrls.includes(u)) turnUrls.push(u);
    }
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    skills: skills.slice(-5),
    mcpCalls: mcps.slice(-6),
    turnFiles: turnFiles.slice(-8),
    turnUrls: turnUrls.slice(-6),
    turnOutputs: turnOutputs.slice(-6),
  }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String((err && err.stack) || err) }));
}
