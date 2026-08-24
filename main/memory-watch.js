'use strict';
const fs = require('node:fs');
const https = require('node:https');
const { startCompletionWatcher, findNewestSessionFile, runScanTask } = require('./notify');
const { decompressFrames, resolveDeepSeekKey } = require('./usage');
const { mergeIntoFile, extractConversationText } = require('./memory-store');

/**
 * 会话收尾自动记忆：
 * 在"整轮对话彻底完成"后，把本会话中值得长期沉淀的知识（项目事实、决策、
 * 踩坑、用户偏好、重大结论）自动抽取进记忆图谱（server-memory 兼容 JSONL）。
 *
 * 设计要点：
 *  - 复用 notify 的回合完成判定（尾部 assistant/message 才触发，工具往返不触发）；
 *  - 用 DeepSeek chat API 做抽取（便宜模型 deepseek-chat），严格 JSON 输出；
 *  - 实体/观察按"完全相等"去重合并进现有图谱，绝不重复建实体；
 *  - 已抽取过的会话不重复抽取（记录最后一条 user/message 时间，有新内容才再抽）；
 *  - 一切失败静默降级（只记日志），绝不影响主流程。
 */

const EXTRACT_MODEL = 'deepseek-chat'; // 官方便宜模型，抽取任务足够
const MAX_INPUT_CHARS = 16000;         // 每轮抽取窗口上限（滑动窗口：只抽游标后的新增，逐轮覆盖全部）
const MAX_OUTPUT_TOKENS = 8192;        // 抽取输出上限（deepseek-chat 最大 8K；再截断走 WINDOW_STEPS 降窗重试）
const WINDOW_STEPS = [MAX_INPUT_CHARS, 8000, 4000]; // 输入窗口逐级缩小：输出截断/解析失败时用更小窗口重试，避免整轮抽取丢失
const EXTRACT_TIMEOUT_MS = 60000;      // 单次抽取请求超时
const MIN_USER_MESSAGES = 1;           // 至少 1 条用户消息才值得抽取（防空会话）

/** 构建抽取请求的 system/user 内容（纯函数，便于测试）。
 *  记忆分两部分：全局记忆（跨项目长期有效，务必抓住）+ 项目记忆（按需精炼，只要让助手
 *  明白项目有什么即可，细节需要时去项目里查，绝不全记）。 */
function buildExtractRequest(conversationText) {
  const system = [
    '你是长期记忆提取器。从用户与 AI 助手的对话中提取值得长期记住的知识，输出为知识图谱实体。',
    '记忆分两部分，规则不同：',
    '【全局记忆】entityType 用 "global" —— 跨项目长期有效、无论做什么项目都需要的知识：',
    '  1) 用户偏好与工作方式（如"完成任务后必须自动验证"、"界面必须流畅不卡"、"接续任务优先级最高"）；',
    '  2) 与具体项目无关的通用教训与踩坑；',
    '  3) 全局约定（记忆纪律、模型与成本路由、多代理协议等）。',
    '  这类信息必须抓住，宁可从对话中仔细识别真正的偏好，也不要漏掉。',
    '【项目记忆】entityType 用 "project" / "tech" / "decision" / "pitfall" —— 某个具体项目的知识：',
    '  1) 只提炼"让助手能明白这个项目是什么"的要点：项目定位、技术栈、模块结构与入口、构建/测试命令、关键约定、重大决策与理由；',
    '  2) 克制精炼：每个项目最多 3~5 个实体、每个实体最多 3~4 条观察；',
    '  3) 细节（具体代码、临时状态、一次性操作、过程性讨论）一律不记——需要时去项目里查。',
    '不要提取：寒暄、情绪化表达、可随时重新推理的内容、与长期知识无关的对话。',
    '实体命名：项目/技术/文件用英文短名（如 dsh-desktop、web-patch.js）；抽象主题可用简短中文（如 用户偏好）。',
    '实体名必须是名词短语，不要用整句话当实体名，不要包含引号。',
    '观察必须是独立可读的事实句（一句话一条），不要重复实体名，不要编号。',
    '同一个实体已有观察时，输出新观察即可（合并去重由系统完成）。',
    '如果没有任何值得记住的内容，两个数组都输出空数组。',
    '只输出一个 JSON 对象，不要输出任何解释文字。格式：',
    '{"entities":[{"name":"实体名","entityType":"global|project|tech|decision|pitfall|preference|concept","observations":["事实1","事实2"]}],"relations":[{"from":"实体A","to":"实体B","relationType":"关系类型"}]}',
  ].join('\n');
  return { system, user: conversationText };
}

/** 解析模型返回的 JSON（容忍 ```json 围栏与前后杂质）。 */
function parseExtractResult(raw) {
  const text = String(raw || '').trim();
  let json = text;
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) json = fence[1].trim();
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');
  if (start >= 0 && end > start) json = json.slice(start, end + 1);
  const doc = JSON.parse(json);
  return {
    entities: Array.isArray(doc.entities) ? doc.entities : [],
    relations: Array.isArray(doc.relations) ? doc.relations : [],
  };
}

/** 调用 DeepSeek chat completions 做抽取。失败时 reject。 */
function callExtract({ key, system, user, model = EXTRACT_MODEL, timeoutMs = EXTRACT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '以下是需要提取记忆的对话：\n\n' + user },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      stream: false,
    });
    const req = https.request('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
        Accept: 'application/json',
        'User-Agent': 'dsh-desktop-memory-watch',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error('抽取接口返回 HTTP ' + res.statusCode + '：' + body.slice(0, 300)));
            return;
          }
          const doc = JSON.parse(body);
          const choice = doc.choices && doc.choices[0];
          const content = choice && choice.message && choice.message.content;
          if (typeof content !== 'string' || !content.trim()) {
            reject(new Error('抽取接口返回空内容'));
            return;
          }
          const finishReason = (choice && choice.finish_reason) || '';
          let parsed;
          try {
            parsed = parseExtractResult(content);
          } catch (err) {
            // 输出被 max_tokens 截断时 JSON 必然解析失败——标记 code 供上层降窗重试
            const truncated = finishReason === 'length';
            const e = new Error((truncated ? '抽取输出被截断（max_tokens 超限）' : '解析抽取响应失败：')
              + (err && err.message ? err.message : err));
            e.code = truncated ? 'TRUNCATED' : 'PARSE_FAIL';
            reject(e);
            return;
          }
          resolve({ entities: parsed.entities, relations: parsed.relations, finishReason });
        } catch (err) {
          reject(new Error('解析抽取响应失败：' + (err && err.message ? err.message : err)));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('抽取请求超时')));
    req.write(payload);
    req.end();
  });
}

/**
 * 带窗口降级重试的抽取：模型输出被截断（finish_reason=length）或 JSON 解析失败时，
 * 用更小的输入窗口（WINDOW_STEPS 逐级缩小）重新提取对话并重试，避免整轮抽取静默丢失。
 * 非截断类错误（网络/HTTP/超时）直接抛出，不降窗。
 * @param {object} opts
 * @param {string} opts.key DeepSeek API key
 * @param {(maxChars: number) => Promise<object|null>} opts.extractConv 按窗口大小提取对话文本
 * @param {object} [opts.firstConv] 首次（16000 窗口）已提取的对话，避免重复提取
 * @param {Function} [opts.callFn] 模型调用（默认 callExtract；测试可注入）
 * @param {(text: string) => void} [opts.log]
 * @returns {Promise<object|null>} { conv, entities, relations, attempts }；全部窗口失败返回 null（已记录日志）
 */
async function extractWithWindowRetry({ key, extractConv, firstConv, callFn = callExtract, log = () => {} }) {
  let conv = firstConv || null;
  for (let step = 0; step < WINDOW_STEPS.length; step++) {
    if (step > 0) {
      conv = await extractConv(WINDOW_STEPS[step]);
      if (!conv || typeof conv.userCount !== 'number' || conv.error) break;
    }
    const { system, user } = buildExtractRequest('【用户】\n' + conv.userText + '\n\n【助手】\n' + conv.assistantText);
    try {
      const r = await callFn({ key, system, user });
      return { conv, entities: r.entities, relations: r.relations, attempts: step + 1 };
    } catch (err) {
      const code = err && err.code;
      if ((code !== 'TRUNCATED' && code !== 'PARSE_FAIL') || step >= WINDOW_STEPS.length - 1) throw err;
      log('[memory] 抽取输出被截断/解析失败，缩小窗口至 ' + WINDOW_STEPS[step + 1] + ' 字符重试');
    }
  }
  return null;
}

/**
 * 启动自动记忆 watcher（复用 notify 的回合完成判定）。
 * @param {object} opts
 * @param {string} opts.sessionsDir $DSH_HOME/sessions
 * @param {string} opts.memoryFile 记忆 JSONL 文件绝对路径
 * @param {string} opts.dshHome DSH_HOME（解析 API key）
 * @param {() => boolean} opts.getEnabled 是否启用（每次触发时读，支持热改）
 * @param {() => object|null} opts.getLastSeen 上次抽取进度 { sessionId, lastUserTime }
 * @param {(v: object) => void} opts.setLastSeen 持久化抽取进度
 * @param {(text: string) => void} [opts.log]
 * @param {number} [opts.idleMs] 传给回合完成判定
 * @returns {{ stop(): void, lastRun: object|null }}
 */
function startAutoMemory({ sessionsDir, memoryFile, dshHome, getEnabled, getLastSeen, setLastSeen, log = () => {}, idleMs = 8000 }) {
  let busy = false;
  let lastRun = null;

  const handleComplete = async () => {
    if (busy) return; // 上一轮抽取尚未结束（例如 API 慢），跳过本轮
    if (!getEnabled()) { log('[memory] 自动记忆已关闭，跳过抽取'); return; }
    const key = resolveDeepSeekKey(dshHome);
    if (!key) { log('[memory] 未找到 DEEPSEEK_API_KEY，跳过自动记忆抽取'); return; }
    const active = findNewestSessionFile(sessionsDir, { skipSubagent: true }); // 跳过子代理会话：其完成/内容不应触发主记忆抽取
    if (!active) { log('[memory] 未找到会话文件，跳过抽取'); return; }
    busy = true; // 提前占位：worker 扫描期间也禁止并发进入，避免重复抽取
    try {
      const stat = fs.statSync(active.file);
      if (stat.size > 16 * 1024 * 1024) { log('[memory] 会话文件过大（' + stat.size + 'B），跳过抽取'); return; }
      const sessionId = pathSessionId(active.file);
      const lastSeen = getLastSeen();
      // 双游标增量抽取：
      //  - lastUserTime：尾部游标——抽"游标后新增"的最新内容（tailFirst），成功才推进；
      //  - headDoneTime：头部游标——首次全量大会话时旧内容可能超出单窗口，先抽尾部（最新价值最高），
      //    再把头部旧内容逐段补抽（headFirst），追平后清空。避免长会话全量重抽截断死循环与旧内容丢失。
      const plan = extractPlan(lastSeen, sessionId);
      // 解压 + 对话提取走 scan worker（重活不进主进程）；worker 不可用时回退主进程同步。
      const extractConv = (maxChars) => runScanTask('extract-conversation', { file: active.file, maxChars, fromTime: plan.fromTime, headFirst: plan.headFirst }, () => {
        const text = decompressFrames(fs.readFileSync(active.file));
        return extractConversationText(text, maxChars, plan.fromTime, plan.headFirst);
      }, log);
      const conv = await extractConv(MAX_INPUT_CHARS);
      if (!conv || typeof conv.userCount !== 'number' || conv.error) {
        log('[memory] 会话文本提取失败：' + (conv && conv.error ? conv.error : '空结果'));
        return;
      }
      if (conv.userCount < MIN_USER_MESSAGES || conv.lastUserTime <= plan.fromTime) {
        log('[memory] 会话 ' + sessionId + ' 无新增内容，跳过重复抽取');
        return;
      }
      log('[memory] 开始抽取记忆：会话 ' + sessionId + '（' + (plan.headFirst ? '补头' : '增量') + '，本轮 ' + conv.userCount + ' 条用户消息）');
      const extracted = await extractWithWindowRetry({ key, extractConv, firstConv: conv, log });
      if (!extracted) {
        log('[memory] 窗口降级重试后仍失败，放弃本轮抽取');
        return;
      }
      const merged = mergeIntoFile(memoryFile, extracted.entities, extracted.relations);
      const nextSeen = advanceSeen(plan, extracted.conv, lastSeen);
      if (nextSeen) setLastSeen(nextSeen);
      lastRun = { at: Date.now(), sessionId, ...merged };
      if (merged.addedEntities || merged.addedObservations || merged.addedRelations) {
        log('[memory] 已沉淀：+实体 ' + merged.addedEntities + '，+观察 ' + merged.addedObservations + '，+关系 ' + merged.addedRelations
          + '（图谱共 ' + merged.entityCount + ' 实体 / ' + merged.relationCount + ' 关系）');
      } else {
        log('[memory] 本轮无新增记忆（内容已存在或无需沉淀）');
      }
    } catch (err) {
      log('[memory] 自动记忆抽取失败（静默）：' + (err && err.message ? err.message : err));
    } finally {
      busy = false;
    }
  };

  const watcher = startCompletionWatcher({ sessionsDir, onComplete: handleComplete, idleMs, log });
  return {
    stop: () => watcher.stop(),
    get lastRun() { return lastRun; },
  };
}

/** 从会话文件路径提取 sessionId。 */
function pathSessionId(file) {
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : String(file);
}

/**
 * 抽取模式决策（纯函数）。双游标：
 *  - lastSeen.lastUserTime：尾部游标（已抽到的最新位置）；
 *  - lastSeen.headDoneTime：头部游标（首次全量大会话时旧内容逐段补抽的位置，追平后清空）。
 * 头部未追平（headDoneTime < lastUserTime）→ 本轮补头（headFirst，fromTime=headDoneTime）；
 * 否则 → 尾部增量（tailFirst，fromTime=lastUserTime；无游标时 fromTime=0 即首次全量）。
 * @param {object|null} lastSeen 上次抽取进度
 * @param {string} sessionId 当前会话 id
 * @returns {{ fromTime: number, headFirst: boolean, headPending: boolean }}
 */
function extractPlan(lastSeen, sessionId) {
  const same = lastSeen && lastSeen.sessionId === sessionId;
  const lastUserTime = same ? (Number(lastSeen.lastUserTime) || 0) : 0;
  const headDoneTime = same ? (Number(lastSeen.headDoneTime) || 0) : 0;
  const headPending = headDoneTime > 0 && headDoneTime < lastUserTime;
  return { fromTime: headPending ? headDoneTime : lastUserTime, headFirst: headPending, headPending };
}

/**
 * 抽取完成后推进游标（纯函数）。conv 来自 extractConversationText：
 *  - 补头轮：headDoneTime 推进到窗口内最新；追平（lastUserTime >= allLatestTime）则清空，
 *    尾部游标 lastUserTime 保持不变（补头不涉及尾部内容）；
 *  - 抽尾轮：lastUserTime 推进到窗口内最新；若本次是首次（游标原本为 0）且窗口未覆盖全部
 *    内容（coveredAll=false，说明还有更旧内容未抽），标记 headDoneTime=0 让后续轮次补抽头部。
 * @param {{fromTime: number, headFirst: boolean, headPending: boolean}} plan extractPlan 的结果
 * @param {{lastUserTime: number, allLatestTime: number, coveredAll: boolean}} conv 提取结果
 * @param {object|null} prevSeen 抽取前的游标
 * @returns {object|null} 新游标 { sessionId, lastUserTime, headDoneTime? }；无会话信息返回 null
 */
function advanceSeen(plan, conv, prevSeen) {
  const sessionId = (prevSeen && prevSeen.sessionId) || '';
  if (!sessionId) return null;
  if (conv.lastUserTime <= plan.fromTime) {
    // 没有实际推进（理论上已被调用方过滤），原样保留游标
    return { sessionId, lastUserTime: Number(prevSeen.lastUserTime) || 0, headDoneTime: prevSeen.headDoneTime };
  }
  if (plan.headPending) {
    const done = conv.lastUserTime >= conv.allLatestTime;
    return { sessionId, lastUserTime: Number(prevSeen.lastUserTime) || 0, headDoneTime: done ? undefined : conv.lastUserTime };
  }
  const next = { sessionId, lastUserTime: conv.lastUserTime };
  if (plan.fromTime === 0 && !conv.coveredAll) next.headDoneTime = 0; // 首次全量：还有更旧内容未抽，标记补头
  return next;
}

module.exports = { startAutoMemory, buildExtractRequest, parseExtractResult, callExtract, extractWithWindowRetry, extractPlan, advanceSeen, EXTRACT_MODEL, WINDOW_STEPS };
