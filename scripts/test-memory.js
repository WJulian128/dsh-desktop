// 自动记忆单测（纯 Node，不依赖 Electron / 网络）：
//  1. memory-store：JSONL 读写、实体/观察合并去重、删除、会话文本提取
//  2. memory-watch：抽取请求构建、模型输出解析（含围栏/杂质容错）
// 用法：node scripts\test-memory.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../main/memory-store');
const { buildExtractRequest, parseExtractResult, extractWithWindowRetry, extractPlan, advanceSeen } = require('../main/memory-watch');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test-'));
const file = path.join(root, 'memory.jsonl');

// 1. 空文件读取
let g = store.readGraph(file);
check('readGraph on missing file returns empty', g.entities.length === 0 && g.relations.length === 0, '');

// 2. 合并写入
const r1 = store.mergeIntoFile(file, [
  { name: 'dsh-desktop', entityType: 'project', observations: ['用 electron-builder 打包', 'asar:false'] },
], [{ from: 'dsh-desktop', to: 'electron-builder', relationType: 'builds-with' }]);
check('first merge adds entity+obs+relation', r1.addedEntities === 1 && r1.addedObservations === 2 && r1.addedRelations === 1, JSON.stringify(r1));
check('graph counts after merge', r1.entityCount === 1 && r1.relationCount === 1, '');

// 3. 同名实体追加去重观察
const r2 = store.mergeIntoFile(file, [
  { name: 'dsh-desktop', entityType: 'project', observations: ['asar:false', 'node-pty 需重编'] },
], []);
check('same-name entity reuses, adds only new obs', r2.addedEntities === 0 && r2.addedObservations === 1, JSON.stringify(r2));
const text2 = fs.readFileSync(file, 'utf8');
check('serialized JSONL is valid', text2.includes('"type":"entity"') && text2.trim().split('\n').length === 2, text2.trim());

// 4. 观察精确去重（完全相等不再追加）
const r3 = store.mergeIntoFile(file, [{ name: 'dsh-desktop', observations: ['asar:false'] }], []);
check('identical observation deduped', r3.addedObservations === 0, JSON.stringify(r3));

// 5. 删除实体连带关系 / 删除观察
let d = store.deleteFromFile(file, ['dsh-desktop'], []);
check('delete entity removes it', d.entityCount === 0 && d.relationCount === 0, JSON.stringify(d));
store.mergeIntoFile(file, [{ name: 'x', observations: ['o1', 'o2'] }], []);
d = store.deleteFromFile(file, [], [{ entityName: 'x', observations: ['o1'] }]);
g = store.readGraph(file);
check('delete observation keeps entity + other obs', g.entities.length === 1 && JSON.stringify(g.entities[0].observations) === JSON.stringify(['o2']), JSON.stringify(g.entities));

// 6. 会话文本提取（构造最小会话 JSONL）
const convLines = [
  JSON.stringify({ type: 'session', time: 1, createdAt: 1 }),
  JSON.stringify({ type: 'user/message', time: 100, data: { content: [{ type: 'text', text: '请优化记忆功能' }] } }),
  JSON.stringify({ type: 'assistant/chunk', time: 200, data: { chunk: { type: 'usage', usage: {} } } }),
  JSON.stringify({ type: 'assistant/message', time: 300, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考过程（应被忽略）' }, { type: 'text', text: '结论：自动记忆已设计完成' }] } } }),
  JSON.stringify({ type: 'tool/call', time: 400 }),
  JSON.stringify({ type: 'user/message', time: 500, data: { content: [{ type: 'text', text: '好的，继续' }] } }),
];
const conv = store.extractConversationText(convLines.join('\n'), 24000);
check('extract counts user messages', conv.userCount === 2, JSON.stringify(conv));
check('extract lastUserTime is newest user msg', conv.lastUserTime === 500, String(conv.lastUserTime));
check('extract user text order preserved', conv.userText.includes('请优化记忆功能') && conv.userText.includes('好的，继续'), conv.userText);
check('extract assistant text ignores reasoning', conv.assistantText.includes('自动记忆已设计完成') && !conv.assistantText.includes('思考过程'), conv.assistantText);

// 7. 长文本截断（保留尾部）
const longText = Array.from({ length: 60 }, (_, i) => '第' + (i + 1) + '条内容填充'.repeat(30)).join('\n');
const convCut = store.extractConversationText(JSON.stringify({ type: 'user/message', time: 1, data: { content: [{ type: 'text', text: longText }] } }), 2000);
check('extract truncates to cap', convCut.userText.length <= 2000 && convCut.userText.includes('第60条'), String(convCut.userText.length));

// 8. 抽取请求构建
const req = buildExtractRequest('对话内容示例');
check('buildExtractRequest has system+user', typeof req.system === 'string' && req.system.length > 200 && req.user === '对话内容示例', '');
check('extract prompt demands JSON schema', req.system.includes('"entities"') && req.system.includes('relations'), '');

// 9. 模型输出解析（围栏 / 杂质 / 空结果）
const p1 = parseExtractResult('```json\n{"entities":[{"name":"a","entityType":"project","observations":["o1"]}],"relations":[]}\n```');
check('parse fenced json', p1.entities.length === 1 && p1.entities[0].name === 'a', JSON.stringify(p1));
const p2 = parseExtractResult('好的，这是结果：{"entities":[],"relations":[]} 完毕');
check('parse json with surrounding text', p2.entities.length === 0, JSON.stringify(p2));
const p3 = parseExtractResult('{"entities":[{"name":"b","observations":["x"]}]}');
check('parse minimal entity', p3.entities[0].entityType === undefined && p3.relations.length === 0, JSON.stringify(p3));
let threw = false;
try { parseExtractResult('完全不是 JSON'); } catch { threw = true; }
check('parse rejects garbage', threw, '');

// 10. 窗口降级重试：输出截断（TRUNCATED）→ 缩小窗口重试成功
(async () => {
  const conv1 = { userText: 'u1', assistantText: 'a1', userCount: 3, lastUserTime: 100 };
  const conv2 = { userText: 'u2', assistantText: 'a2', userCount: 3, lastUserTime: 100 };
  const calls = [];
  const ret1 = await extractWithWindowRetry({
    key: 'k',
    firstConv: conv1,
    extractConv: async (maxChars) => { calls.push(maxChars); return conv2; },
    callFn: async (opts) => {
      if (calls.length === 0) { const e = new Error('截断'); e.code = 'TRUNCATED'; throw e; }
      return { entities: [{ name: 'x', observations: ['o'] }], relations: [] };
    },
  });
  check('retry shrinks window after truncation', calls.length === 1 && calls[0] === 8000 && ret1.attempts === 2, JSON.stringify(calls));
  check('retry returns extracted entities', ret1.entities.length === 1 && ret1.entities[0].name === 'x', JSON.stringify(ret1.entities));
  check('retry keeps newest lastUserTime', ret1.conv.lastUserTime === 100, '');

  // 11. 全部窗口都解析失败 → 抛出（不吞错）
  const calls2 = [];
  let threwAll = false;
  try {
    await extractWithWindowRetry({
      key: 'k',
      firstConv: conv1,
      extractConv: async (maxChars) => { calls2.push(maxChars); return conv2; },
      callFn: async () => { const e = new Error('bad json'); e.code = 'PARSE_FAIL'; throw e; },
    });
  } catch { threwAll = true; }
  check('all windows fail throws', threwAll && calls2.length === 2 && calls2[0] === 8000 && calls2[1] === 4000, JSON.stringify(calls2));

  // 12. 非截断类错误（网络/HTTP）不降窗直接抛
  const calls3 = [];
  let threwNet = false;
  try {
    await extractWithWindowRetry({
      key: 'k',
      firstConv: conv1,
      extractConv: async (maxChars) => { calls3.push(maxChars); return conv2; },
      callFn: async () => { throw new Error('HTTP 500'); },
    });
  } catch (e) { threwNet = e && e.message === 'HTTP 500'; }
  check('network error does not shrink window', threwNet && calls3.length === 0, JSON.stringify(calls3));

  // 13. 首次成功不重复提取
  const calls4 = [];
  const ret4 = await extractWithWindowRetry({
    key: 'k',
    firstConv: conv1,
    extractConv: async (maxChars) => { calls4.push(maxChars); return conv2; },
    callFn: async () => ({ entities: [], relations: [] }),
  });
  check('first success no re-extract', calls4.length === 0 && ret4.attempts === 1, '');

  // 14. headFirst 窗口：从最旧取（首次全量补头），游标=窗口内最新，coveredAll 反映是否覆盖全部
  const headLines = [100, 200, 300, 400].map((t) => JSON.stringify({ type: 'user/message', time: t, data: { content: [{ type: 'text', text: '消息' + t }] } })).join('\n');
  const h1 = store.extractConversationText(headLines, 8, 0, true); // 每条约 60 字符，cap 8 只够 1 条
  check('headFirst keeps oldest window', h1.userText.includes('消息100') && !h1.userText.includes('消息400'), JSON.stringify(h1.userText));
  check('headFirst lastUserTime = window newest', h1.lastUserTime === 100 && h1.allLatestTime === 400, String(h1.lastUserTime) + '/' + h1.allLatestTime);
  check('headFirst coveredAll=false when truncated', h1.coveredAll === false, String(h1.coveredAll));
  const h2 = store.extractConversationText(headLines, 400, 0, true);
  check('headFirst coveredAll=true when fits', h2.coveredAll === true && h2.lastUserTime === 400, String(h2.coveredAll) + '/' + h2.lastUserTime);
  // tailFirst coveredAll：超窗 false，够放 true
  const t1 = store.extractConversationText(headLines, 8, 0, false);
  check('tailFirst keeps newest window', t1.userText.includes('消息400') && !t1.userText.includes('消息100'), JSON.stringify(t1.userText));
  check('tailFirst coveredAll=false when truncated', t1.coveredAll === false, String(t1.coveredAll));
  const t2 = store.extractConversationText(headLines, 400, 0, false);
  check('tailFirst coveredAll=true when fits', t2.coveredAll === true && t2.lastUserTime === 400, String(t2.coveredAll));
  // fromTime 过滤在 headFirst 下生效（补头续抽）
  const h3 = store.extractConversationText(headLines, 8, 100, true);
  check('headFirst respects fromTime', h3.userText.includes('消息200') && !h3.userText.includes('消息100') && h3.lastUserTime === 200, JSON.stringify(h3.userText));

  // 15. extractPlan 双游标决策
  const p1 = extractPlan(null, 's');
  check('plan no lastSeen -> tailFirst from 0', p1.fromTime === 0 && p1.headFirst === false, JSON.stringify(p1));
  const p2 = extractPlan({ sessionId: 's', lastUserTime: 500 }, 's');
  check('plan tail cursor -> fromTime=500', p2.fromTime === 500 && p2.headFirst === false, JSON.stringify(p2));
  const p3 = extractPlan({ sessionId: 's', lastUserTime: 500, headDoneTime: 200 }, 's');
  check('plan head pending -> headFirst from headDoneTime', p3.headFirst === true && p3.fromTime === 200 && p3.headPending === true, JSON.stringify(p3));
  const p4 = extractPlan({ sessionId: 's', lastUserTime: 500, headDoneTime: 500 }, 's');
  check('plan head caught up -> tailFirst', p4.headFirst === false && p4.fromTime === 500, JSON.stringify(p4));
  const p5 = extractPlan({ sessionId: 'other', lastUserTime: 500, headDoneTime: 200 }, 's');
  check('plan other session resets', p5.fromTime === 0 && p5.headFirst === false, JSON.stringify(p5));

  // 16. advanceSeen 游标推进
  const a1 = advanceSeen({ headPending: true, fromTime: 200 }, { lastUserTime: 350, allLatestTime: 400, coveredAll: false }, { sessionId: 's', lastUserTime: 500, headDoneTime: 200 });
  check('advance head pending keeps tail cursor', a1.lastUserTime === 500 && a1.headDoneTime === 350, JSON.stringify(a1));
  const a2 = advanceSeen({ headPending: true, fromTime: 200 }, { lastUserTime: 400, allLatestTime: 400, coveredAll: true }, { sessionId: 's', lastUserTime: 500, headDoneTime: 200 });
  check('advance head caught up clears headDoneTime', a2.lastUserTime === 500 && a2.headDoneTime === undefined, JSON.stringify(a2));
  const a3 = advanceSeen({ headPending: false, fromTime: 0 }, { lastUserTime: 400, allLatestTime: 400, coveredAll: false }, { sessionId: 's', lastUserTime: 0 });
  check('advance first tail marks headDoneTime=0', a3.lastUserTime === 400 && a3.headDoneTime === 0, JSON.stringify(a3));
  const a4 = advanceSeen({ headPending: false, fromTime: 400 }, { lastUserTime: 600, allLatestTime: 600, coveredAll: true }, { sessionId: 's', lastUserTime: 400 });
  check('advance incremental tail no head mark', a4.lastUserTime === 600 && a4.headDoneTime === undefined, JSON.stringify(a4));
  const a5 = advanceSeen({ headPending: false, fromTime: 0 }, { lastUserTime: 400, allLatestTime: 400, coveredAll: true }, null);
  check('advance without prevSeen returns null', a5 === null, String(a5));
})().then(() => {

// 清理
fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.log('MEMORY FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('MEMORY OK');
});
