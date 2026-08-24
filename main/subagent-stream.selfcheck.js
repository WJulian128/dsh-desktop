'use strict';
/**
 * subagent-stream 自检：
 *  a. 打印从真实会话文件观察到的 assistant/chunk 结构样例（实现前的字段确认依据）；
 *  b. 调用 listSubagentStream 打印前 5 个子代理的 { label, provider, model, status, lastText, reasoningText }；
 *  c. 对其中一个 running 会话调 streamSince(sinceSeq=0) 打印增量长度，并验证二次轮询增量与 not found 分支。
 * 用法：node main\subagent-stream.selfcheck.js
 *      （可用 DSH_HOME / DSH_WORKSPACE 环境变量覆盖默认值）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decompressFrames, workspaceSessionKey } = require('./usage');
const { listSubagentStream, streamSince } = require('./subagent-stream');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const WORKSPACE = process.env.DSH_WORKSPACE || path.join(__dirname, '..');
const ROOT = path.join(DSH_HOME, 'sessions', workspaceSessionKey(WORKSPACE));

const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// ---------- (a) 真实结构样例 ----------
console.log('===== (a) 真实会话中的 assistant/chunk / assistant/message 结构样例 =====');
(() => {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
  let picked = null;
  for (const d of dirs) {
    const file = path.join(ROOT, d.name, 'session.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    const text = decompressFrames(fs.readFileSync(file));
    const records = [];
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { records.push(JSON.parse(l)); } catch { /* skip */ }
    }
    const session = records.find((r) => r && r.type === 'session');
    if (session && session.origin === 'subagent') { picked = { dir: d.name, records }; break; }
  }
  if (!picked) { console.log('未找到子代理会话'); return; }
  console.log('样例来源会话:', picked.dir, '（共', picked.records.length, '条）');
  const chunkTypes = {};
  for (const r of picked.records) {
    if (r.type === 'assistant/chunk' && r.data && r.data.chunk) {
      chunkTypes[r.data.chunk.type] = (chunkTypes[r.data.chunk.type] || 0) + 1;
    }
  }
  console.log('assistant/chunk 的 chunk.type 分布:', JSON.stringify(chunkTypes));
  let shown = 0;
  for (const r of picked.records) {
    if (r.type !== 'assistant/chunk' || shown >= 3) continue;
    console.log(`  assistant/chunk 样例${++shown}: seq=${r.seq} chunk=${JSON.stringify(r.data.chunk)}`);
  }
  const m = picked.records.find((r) => r.type === 'assistant/message');
  if (m) {
    const blocks = m.data && m.data.message ? m.data.message.content.map((b) => `{type:${b.type},text:"${clip(b.text, 40)}"}`) : [];
    console.log('  assistant/message 样例: seq=' + m.seq + ' content=[' + blocks.join(', ') + ']');
  }
  const te = picked.records.find((r) => r.type === 'turn/end');
  console.log('  turn/end 样例:', te ? JSON.stringify(te) : '（无）');
})();

// ---------- (b) listSubagentStream ----------
console.log('\n===== (b) listSubagentStream 前 5 个子代理 =====');
const list = listSubagentStream({ dshHome: DSH_HOME, workspace: WORKSPACE });
console.log('共', list.length, '个子代理会话');
for (const it of list.slice(0, 5)) {
  console.log(`  - ${it.label} | provider=${it.provider} | model=${it.model} | status=${it.status} | updatedAt=${new Date(it.updatedAt).toISOString()}`);
  console.log(`    lastText: ${clip(it.lastText, 200)}`);
  console.log(`    reasoningText: ${clip(it.reasoningText, 200)}`);
}

// ---------- (c) streamSince ----------
console.log('\n===== (c) streamSince 增量读取 =====');
const running = list.find((x) => x.status === 'running');
if (running) {
  console.log('对 running 会话', running.sessionId, '调 streamSince(sinceSeq=0)');
  const s0 = streamSince({ dshHome: DSH_HOME, workspace: WORKSPACE, sessionId: running.sessionId, sinceSeq: 0 });
  console.log('  首次: ok=' + s0.ok + ' seq=' + s0.seq + ' done=' + s0.done +
    ' text.length=' + s0.text.length + ' reasoning.length=' + s0.reasoning.length);
  console.log('  text 前 120 字:', clip(s0.text, 120));
  console.log('  reasoning 前 120 字:', clip(s0.reasoning, 120));
  const s1 = streamSince({ dshHome: DSH_HOME, workspace: WORKSPACE, sessionId: running.sessionId, sinceSeq: s0.seq });
  console.log('  二次轮询(sinceSeq=' + s0.seq + '): ok=' + s1.ok + ' seq=' + s1.seq + ' done=' + s1.done +
    ' 新增 text=' + s1.text.length + ' reasoning=' + s1.reasoning.length);
  const nf = streamSince({ dshHome: DSH_HOME, workspace: WORKSPACE, sessionId: 'no-such-session-id', sinceSeq: 0 });
  console.log('  无该会话 →', JSON.stringify(nf));
} else {
  console.log('当前无 running 子代理会话，跳过 (c)；现有状态:', list.map((x) => x.status).join(','));
}
