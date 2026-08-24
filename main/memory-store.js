'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * 记忆存储（与 @modelcontextprotocol/server-memory 的 JSONL 格式完全兼容）：
 *   - 实体行：{"type":"entity","name":"...","entityType":"...","observations":["..."]}
 *   - 关系行：{"type":"relation","from":"...","to":"...","relationType":"..."}
 * 读取时按行合并成图；写入采用临时文件 + rename 原子替换（避免半写文件）。
 * 所有函数均为纯 Node 逻辑，可单测。
 */

/** 读取知识图谱。文件不存在返回空图；坏行跳过。 */
function readGraph(file) {
  const graph = { entities: [], relations: [] };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return graph; // ENOENT 等一律视为空图
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'entity' && typeof item.name === 'string' && item.name) {
      graph.entities.push({
        name: item.name,
        entityType: typeof item.entityType === 'string' ? item.entityType : '',
        observations: Array.isArray(item.observations) ? item.observations.filter((o) => typeof o === 'string') : [],
      });
    } else if (item.type === 'relation' && typeof item.from === 'string' && typeof item.to === 'string' && typeof item.relationType === 'string') {
      graph.relations.push({ from: item.from, to: item.to, relationType: item.relationType });
    }
  }
  return graph;
}

/** 把图序列化为 JSONL 文本。 */
function serializeGraph(graph) {
  const lines = [];
  for (const e of graph.entities || []) {
    lines.push(JSON.stringify({ type: 'entity', name: e.name, entityType: e.entityType || '', observations: e.observations || [] }));
  }
  for (const r of graph.relations || []) {
    lines.push(JSON.stringify({ type: 'relation', from: r.from, to: r.to, relationType: r.relationType }));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** 原子写：临时文件 + rename。 */
function writeGraph(file, graph) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, serializeGraph(graph), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 把新实体/观察合并进图（实体同名则追加不重复的观察），返回新增统计。
 * 注意：观察去重是"完全相等"级别的——语义相似的观察由抽取侧自行避免。
 */
function mergeEntities(graph, entities) {
  const added = { entities: 0, observations: 0 };
  for (const ent of entities || []) {
    if (!ent || typeof ent.name !== 'string' || !ent.name.trim()) continue;
    const name = ent.name.trim();
    const existing = graph.entities.find((e) => e.name === name);
    const obs = Array.isArray(ent.observations) ? ent.observations.filter((o) => typeof o === 'string' && o.trim()) : [];
    if (!existing) {
      graph.entities.push({ name, entityType: typeof ent.entityType === 'string' && ent.entityType ? ent.entityType : 'concept', observations: obs });
      added.entities += 1;
      added.observations += obs.length;
      continue;
    }
    const fresh = obs.filter((o) => !existing.observations.includes(o));
    existing.observations.push(...fresh);
    added.observations += fresh.length;
  }
  return added;
}

/** 合并关系（三元组完全相同则跳过）。 */
function mergeRelations(graph, relations) {
  let added = 0;
  for (const rel of relations || []) {
    if (!rel || typeof rel.from !== 'string' || typeof rel.to !== 'string' || typeof rel.relationType !== 'string') continue;
    const dup = graph.relations.some((r) => r.from === rel.from && r.to === rel.to && r.relationType === rel.relationType);
    if (!dup) { graph.relations.push({ from: rel.from, to: rel.to, relationType: rel.relationType }); added += 1; }
  }
  return added;
}

/**
 * 读-合并-写一次完成（自动记忆写入口）。返回 { addedEntities, addedObservations, addedRelations, entityCount, relationCount }。
 */
function mergeIntoFile(file, entities, relations) {
  const graph = readGraph(file);
  const ent = mergeEntities(graph, entities);
  const rel = mergeRelations(graph, relations);
  writeGraph(file, graph);
  return { addedEntities: ent.entities, addedObservations: ent.observations, addedRelations: rel, entityCount: graph.entities.length, relationCount: graph.relations.length };
}

/**
 * 删除实体（连带删除以其为端点的关系）与删除指定观察。
 * @param {string} file 记忆文件
 * @param {string[]} entityNames 要删除的实体名
 * @param {Array<{entityName:string, observations:string[]}>} observationDeletions 要删除的观察
 */
function deleteFromFile(file, entityNames, observationDeletions) {
  const graph = readGraph(file);
  const names = (entityNames || []).filter((n) => typeof n === 'string' && n);
  if (names.length) {
    graph.entities = graph.entities.filter((e) => !names.includes(e.name));
    graph.relations = graph.relations.filter((r) => !names.includes(r.from) && !names.includes(r.to));
  }
  for (const del of observationDeletions || []) {
    const entity = graph.entities.find((e) => e.name === del.entityName);
    if (!entity) continue;
    const drop = (del.observations || []).filter((o) => typeof o === 'string');
    entity.observations = entity.observations.filter((o) => !drop.includes(o));
  }
  writeGraph(file, graph);
  return { entityCount: graph.entities.length, relationCount: graph.relations.length };
}

/**
 * 从解压后的会话 JSONL 文本中提取对话文本（user/message 与 assistant/message 的纯文本）。
 * 用于记忆抽取的输入。返回：
 *  { userText, assistantText, userCount, lastUserTime, allLatestTime, oldestIncludedTime, coveredAll }
 *  - lastUserTime：**窗口内**最新用户消息时间（游标应推进到的位置）；
 *  - allLatestTime：fromTime 之后全部用户消息的最新时间；
 *  - oldestIncludedTime：窗口内最旧用户消息时间；
 *  - coveredAll：窗口是否覆盖了 fromTime 起的全部内容（尾部窗口=最旧进入窗口；头部窗口=最新被纳入）。
 * @param {string} text 解压后的会话日志全文
 * @param {number} maxChars 单侧文本截断上限
 * @param {number} fromTime 游标：只收集此时间之后的消息（增量抽取）
 * @param {boolean} headFirst 窗口方向：false=保留最新（尾部，默认）；true=保留最旧（头部）。
 *   headFirst 用于"首次全量"大会话的头部顺序补抽——游标推进到窗口内最新，
 *   剩余旧内容由后续轮次继续补抽，保证旧内容不丢（tailFirst 会丢窗口外更旧部分）。
 */
function extractConversationText(text, maxChars = 24000, fromTime = 0, headFirst = false) {
  const userParts = [];      // { text, time }
  const assistantParts = []; // { text }
  let userCount = 0;
  let allLatestTime = 0;
  let afterFromFirstTime = 0; // fromTime 后第一条用户消息的 time（尾部窗口"覆盖全部"的参照）
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record.type !== 'string') continue;
    // 增量抽取：只收集 fromTime 之后的消息（上次抽取游标之后的新增部分）
    if (typeof record.time === 'number' && record.time <= fromTime) continue;
    if (record.type === 'user/message') {
      const content = record.data && Array.isArray(record.data.content) ? record.data.content : [];
      const textPart = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
      if (textPart) {
        if (!afterFromFirstTime) afterFromFirstTime = record.time;
        userParts.push({ text: textPart, time: record.time });
        userCount += 1;
        if (record.time > allLatestTime) allLatestTime = record.time;
      }
    } else if (record.type === 'assistant/message') {
      const msg = record.data && record.data.message ? record.data.message : null;
      const content = msg && Array.isArray(msg.content) ? msg.content : [];
      const textPart = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
      if (textPart) assistantParts.push({ text: textPart });
    }
  }
  // 窗口截取：headFirst 从最旧取（保留头部），否则从最新取（保留尾部）；超出部分丢弃。
  // 截断产生的"碎片消息"（最后一条只进了部分文本）带 partial 标记，游标不停在碎片上，
  // 让下一轮完整抽取该消息（避免其剩余部分永久丢失）。
  const sliceParts = (arr, cap, fromHead) => {
    const kept = [];
    let used = 0;
    const seq = fromHead ? arr : arr.slice().reverse();
    for (const p of seq) {
      const sep = used > 0 ? 1 : 0;
      if (used + p.text.length + sep > cap) {
        const avail = cap - used - sep;
        if (avail > 0) {
          const start = fromHead ? 0 : Math.max(0, p.text.length - avail);
          const end = fromHead ? avail : p.text.length;
          kept.push({ text: p.text.slice(start, end), time: p.time, partial: true });
        }
        break;
      }
      kept.push(p);
      used += p.text.length + sep;
    }
    return fromHead ? kept : kept.reverse();
  };
  const uKept = sliceParts(userParts, maxChars, headFirst);
  const aKept = sliceParts(assistantParts, maxChars, headFirst);
  const join = (arr) => arr.map((p) => p.text).join('\n');
  // 游标 = 从窗口尾向前第一条完整消息的 time（碎片消息留待下轮，避免跳过其剩余部分）
  let lastUserTime = 0;
  for (let i = uKept.length - 1; i >= 0; i--) {
    lastUserTime = uKept[i].time;
    if (!uKept[i].partial) break;
  }
  const oldestIncludedTime = uKept.length ? uKept[0].time : 0;
  const coveredAll = headFirst
    ? lastUserTime >= allLatestTime            // 头部窗口：最新被纳入 ⇔ 覆盖全部
    : oldestIncludedTime > 0 && oldestIncludedTime <= afterFromFirstTime; // 尾部窗口：最旧是游标后第一条 ⇔ 覆盖全部
  return {
    userText: join(uKept),
    assistantText: join(aKept),
    userCount,
    lastUserTime,
    allLatestTime,
    oldestIncludedTime,
    coveredAll,
  };
}

module.exports = {
  readGraph, writeGraph, serializeGraph, mergeEntities, mergeRelations, mergeIntoFile, deleteFromFile, extractConversationText,
};
