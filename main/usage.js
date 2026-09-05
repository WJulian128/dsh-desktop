'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const yaml = require('js-yaml');

/**
 * 用量统计 + API 余额查询：
 *  - 解析 $DSH_HOME/sessions/<workspace-key>/ 下的 zstd JSONL 会话日志
 *    （物理格式为拼接的 zstd 帧，按帧扫描 + 单帧解压），汇总 token 用量与估算成本。
 *  - 查询 DeepSeek 官方余额接口 GET https://api.deepseek.com/user/balance
 *    （key 取自 $DSH_HOME/.credentials.yaml 或环境变量 DEEPSEEK_API_KEY）。
 */

/** workspace 目录 -> 会话存储目录名（与 harness 的 key 规则一致：--路径--，连续分隔符折为一个 -）。 */
function workspaceSessionKey(workspace) {
  const normalized = path.normalize(String(workspace));
  return '--' + normalized.replace(/[\\/:]+/g, '-') + '--';
}

/** 扫描拼接 zstd 帧并全量解压（逐候选 magic 处尝试单帧解压，接受以 { 开头的输出）。 */
function decompressFrames(buffer) {
  const chunks = [];
  const len = buffer.length;
  for (let i = 0; i + 4 <= len; i++) {
    if (buffer[i] !== 0x28 || buffer[i + 1] !== 0xb5 || buffer[i + 2] !== 0x2f || buffer[i + 3] !== 0xfd) continue;
    try {
      const out = zlib.zstdDecompressSync(buffer.subarray(i));
      if (out.length > 0 && out[0] === 0x7b) chunks.push(out);
    } catch { /* 压缩数据内出现的 magic 误报，跳过 */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 从环境或 $DSH_HOME/.credentials.yaml 解析 DEEPSEEK_API_KEY。
 *  兼容两种 YAML 结构：官方新格式 refs: { DEEPSEEK_API_KEY: ... } 与旧顶层格式。 */
function resolveDeepSeekKey(dshHome, env = process.env) {
  const fromEnv = env.DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  try {
    const file = path.join(dshHome, '.credentials.yaml');
    if (fs.existsSync(file)) {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
      const refs = doc.refs && typeof doc.refs === 'object' ? doc.refs : {};
      const key = refs.DEEPSEEK_API_KEY || doc.DEEPSEEK_API_KEY;
      if (typeof key === 'string' && key.trim()) return key.trim();
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 查询 DeepSeek 余额。返回 { ok, balanceInfos?, error? }。 */
function queryBalance({ dshHome, timeoutMs = 20000 }) {
  const key = resolveDeepSeekKey(dshHome);
  if (!key) return Promise.resolve({ ok: false, error: '未找到 DEEPSEEK_API_KEY（.credentials.yaml 或环境变量）' });
  return new Promise((resolve) => {
    const req = https.get('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'User-Agent': 'dsh-desktop-usage' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const doc = JSON.parse(body);
          if (res.statusCode !== 200 || doc.is_available === undefined) {
            resolve({ ok: false, error: '余额接口返回异常（HTTP ' + res.statusCode + '）：' + (doc.error && doc.error.message ? doc.error.message : body.slice(0, 200)) });
            return;
          }
          resolve({
            ok: true,
            isAvailable: !!doc.is_available,
            balanceInfos: Array.isArray(doc.balance_infos) ? doc.balance_infos : [],
          });
        } catch (err) {
          resolve({ ok: false, error: '解析余额响应失败：' + (err && err.message ? err.message : err) });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: '请求余额接口失败：' + (err && err.message ? err.message : err) }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('余额接口超时')));
  });
}

/** 默认成本单价（$/1M tokens，DeepSeek 参考价；可在 settings.usagePrices 覆盖）。 */
const DEFAULT_PRICES = { input: 0.27, output: 1.1, cacheHit: 0.07 };

function resolvePrices(usagePrices) {
  const p = usagePrices && typeof usagePrices === 'object' ? usagePrices : {};
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  return {
    input: num(p.input, DEFAULT_PRICES.input),
    output: num(p.output, DEFAULT_PRICES.output),
    cacheHit: num(p.cacheHit, DEFAULT_PRICES.cacheHit),
  };
}

/** 统计一个会话文件：token 合计（usage 事件出现在 assistant/chunk 的 chunk.type === "usage"）。
 *  lastUsage 为最后一次请求的 usage——即当前上下文尺寸（缓存命中 + 未命中输入），
 *  与累计 usage（历史全部请求的总额，用于计费）语义不同。 */
function scanSessionFile(file) {
  const buffer = fs.readFileSync(file);
  const text = decompressFrames(buffer);
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  let lastUsage = null;
  let title = null;
  let createdAt = null;
  let lastTime = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record && record.type === 'session' && createdAt === null && record.createdAt) createdAt = record.createdAt;
    if (record && record.time) lastTime = record.time;
    if (record && record.type === 'session/title' && record.data && typeof record.data.title === 'string' && record.data.title) {
      title = record.data.title;
    }
    if (record && record.type === 'assistant/chunk' && record.data && record.data.chunk && record.data.chunk.type === 'usage' && record.data.chunk.usage) {
      const u = record.data.chunk.usage;
      usage.inputTokens += typeof u.inputTokens === 'number' ? u.inputTokens : 0;
      usage.outputTokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0;
      usage.cacheReadTokens += typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0;
      usage.reasoningTokens += typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0;
      lastUsage = {
        inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : 0,
        outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
        cacheReadTokens: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0,
        reasoningTokens: typeof u.reasoningTokens === 'number' ? u.reasoningTokens : 0,
      };
    }
  }
  return { usage, lastUsage, title, createdAt, lastTime };
}

/** 统计某工作区全部会话用量。 */
function scanWorkspaceUsage({ dshHome, workspace, usagePrices }) {
  const prices = resolvePrices(usagePrices);
  const root = path.join(dshHome, 'sessions', workspaceSessionKey(workspace));
  const sessions = [];
  let total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'session.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      try {
        const scanned = scanSessionFile(file);
        for (const key of Object.keys(total)) total[key] += scanned.usage[key];
        // lastUsage = 该会话最后一次请求的 usage（当前上下文尺寸：inputTokens+cacheReadTokens
        // 为上下文内容、outputTokens/reasoningTokens 为最近一次输出）——供面板“用量归因”展示
        sessions.push({
          sessionId: entry.name,
          title: scanned.title,
          createdAt: scanned.createdAt,
          lastTime: scanned.lastTime,
          usage: scanned.usage,
          lastUsage: scanned.lastUsage || null,
        });
      } catch (err) {
        sessions.push({ sessionId: entry.name, error: (err && err.message) || String(err), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } });
      }
    }
  }
  sessions.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
  // harness 语义：usage.inputTokens 为缓存未命中输入，cacheReadTokens 为缓存命中。
  const cacheHit = total.cacheReadTokens;
  const cacheMiss = total.inputTokens;
  const cost = cacheMiss / 1e6 * prices.input + cacheHit / 1e6 * prices.cacheHit + total.outputTokens / 1e6 * prices.output;
  return {
    workspace,
    sessions,
    total: {
      ...total,
      cacheHitTokens: cacheHit,
      cacheMissTokens: cacheMiss,
    },
    estimatedCostUsd: Math.round(cost * 10000) / 10000,
    prices,
  };
}

/**
 * DeepSeek 官方峰谷计费（2026-08 现行，来源 api-docs.deepseek.com/zh-cn/quick_start/pricing）：
 *  - 高峰时段：北京时间 周一至周五 9:00-12:00、14:00-18:00；
 *  - 其余时间（含周末全天）为空闲时段，价格为高峰的一半。
 *  单价（元/百万 tokens，deepseek-chat 列）：输入缓存命中 0.05/0.10，输入未命中 1.5/3.0，输出 4.5/9.0。
 */
const CNY_TIER_PRICES = {
  peak: { input: 3.0, cacheHit: 0.10, output: 9.0 },
  valley: { input: 1.5, cacheHit: 0.05, output: 4.5 },
};

const TIER_TZ = 'Asia/Shanghai';

/** 校验用户自定义的峰谷单价表（settings.tierPrices），非法字段回退默认值。 */
function resolveTierPrices(configured) {
  const c = configured && typeof configured === 'object' ? configured : {};
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  return {
    peak: {
      input: num(c.peak && c.peak.input, CNY_TIER_PRICES.peak.input),
      cacheHit: num(c.peak && c.peak.cacheHit, CNY_TIER_PRICES.peak.cacheHit),
      output: num(c.peak && c.peak.output, CNY_TIER_PRICES.peak.output),
    },
    valley: {
      input: num(c.valley && c.valley.input, CNY_TIER_PRICES.valley.input),
      cacheHit: num(c.valley && c.valley.cacheHit, CNY_TIER_PRICES.valley.cacheHit),
      output: num(c.valley && c.valley.output, CNY_TIER_PRICES.valley.output),
    },
  };
}

/** 取北京时间（Asia/Shanghai）的 { weekday(1-7), minutes(0-1439) }。 */
function beijingClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIER_TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : null;
  };
  const weekdayMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  return {
    weekday: weekdayMap[get('weekday')] || 0,
    minutes: (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0),
  };
}

/** 判断是否高峰：周一至周五且 (9:00-12:00) 或 (14:00-18:00)。 */
function isPeakHour(date = new Date()) {
  const { weekday, minutes } = beijingClock(date);
  if (weekday >= 1 && weekday <= 5) {
    if (minutes >= 9 * 60 && minutes < 12 * 60) return true;
    if (minutes >= 14 * 60 && minutes < 18 * 60) return true;
  }
  return false;
}

/** 下一个时段切换点（Date）。边界窗口用分界时刻。 */
function nextTierSwitch(date = new Date()) {
  const { weekday, minutes } = beijingClock(date);
  const windows = [
    { start: 9 * 60, end: 12 * 60 },
    { start: 14 * 60, end: 18 * 60 },
  ];
  const isWeekday = weekday >= 1 && weekday <= 5;
  // 今天剩余的分界点：先找今天所有窗口边界 > minutes，再考虑下一自然日。
  const today = date.getTime();
  const boundaries = [];
  if (isWeekday) {
    for (const w of windows) {
      if (w.start > minutes) boundaries.push({ at: today + (w.start - minutes) * 60000, tier: 'peak' });
      if (w.end > minutes) boundaries.push({ at: today + (w.end - minutes) * 60000, tier: 'valley' });
    }
  }
  if (!boundaries.length) {
    // 下一个自然日（北京）00:00
    const tomorrowNoon = new Date(today + 24 * 3600 * 1000);
    const { weekday: tw } = beijingClock(tomorrowNoon);
    // 明天若是工作日则 9:00 进高峰，否则全天闲时（再顺延）
    let cursor = tomorrowNoon;
    for (let i = 0; i < 8; i++) {
      const c = beijingClock(cursor);
      if (c.weekday >= 1 && c.weekday <= 5) {
        boundaries.push({ at: cursor.getTime() + (9 * 60 - c.minutes) * 60000, tier: 'peak' });
        break;
      }
      cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
    }
  }
  boundaries.sort((a, b) => a.at - b.at);
  return boundaries[0] || { at: today + 3600 * 1000, tier: 'peak' };
}

/** 当前计费时段信息。@param {object} [tierPrices] 自定义单价表（settings.tierPrices），缺省用默认。 */
function resolvePriceTier(date = new Date(), tierPrices) {
  const peak = isPeakHour(date);
  const next = nextTierSwitch(date);
  const minutesUntil = Math.max(0, Math.round((next.at - date.getTime()) / 60000));
  const { weekday } = beijingClock(date);
  const prices = resolveTierPrices(tierPrices)[peak ? 'peak' : 'valley'];
  return {
    tier: peak ? 'peak' : 'valley',
    label: peak ? '高峰时段' : '空闲时段',
    multiplier: peak ? 1 : 0.5,
    prices,
    nextTier: next.tier === 'peak' ? '高峰时段' : '空闲时段',
    minutesUntil,
    weekday,
    note: peak
      ? '当前为高峰时段（周一至五 9:00-12:00 / 14:00-18:00），价格为空闲时段 2 倍'
      : '当前为空闲时段（含周末全天），价格仅为高峰的一半',
  };
}

module.exports = { scanWorkspaceUsage, queryBalance, resolveDeepSeekKey, decompressFrames, workspaceSessionKey, scanSessionFile, resolvePriceTier, isPeakHour, nextTierSwitch, CNY_TIER_PRICES, resolveTierPrices };
