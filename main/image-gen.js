'use strict';
/**
 * 文生图模块（纯 Node 可测）：调用 OpenAI 兼容的 images/generations 接口。
 * 覆盖绝大多数国内云端文生图服务商（硅基流动 / 通义万相 compatible-mode / 智谱 / OpenAI 官方等）：
 *   POST {baseUrl}/images/generations
 *   body: { model, prompt, n, size, response_format }
 *   response: { data: [{ b64_json | url, revised_prompt? }] }
 * 依赖注入（测试用）：httpTransport({method,url,headers,body}) → {status,body}。
 */
const DEFAULT_TIMEOUT_MS = 180000; // 生图较慢，3 分钟超时

function defaultTransport({ method, url, headers, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }))
    .finally(() => clearTimeout(timer));
}

/** 校验配置完整性。 */
function validateConfig(cfg) {
  if (!cfg || cfg.enabled === false) throw new Error('图片生成未启用（设置 → 图片生成）');
  if (!cfg.model || !cfg.baseUrl) throw new Error('图片生成配置不完整（需要 baseUrl、model；多数服务商还需 apiKey）');
}

/**
 * 生成图片。
 * @param {object} cfg { enabled, baseUrl, apiKey, model, size }
 * @param {object} input { prompt, size?, n? }
 * @param {object} [opts] { httpTransport, log }
 * @returns {Promise<{ok:true, images:[{b64?:string, url?:string, revisedPrompt?:string}]}|{ok:false, error:string}>}
 */
async function generateImage(cfg, input, opts = {}) {
  const http = opts.httpTransport || defaultTransport;
  const log = opts.log || (() => {});
  try {
    validateConfig(cfg);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  const prompt = String((input && input.prompt) || '').trim();
  if (!prompt) return { ok: false, error: 'prompt 为空' };
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const size = String((input && input.size) || cfg.size || '1024x1024');
  const n = Math.min(Math.max(1, Number((input && input.n) || 1)), 4);
  const headers = {};
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + String(cfg.apiKey).trim();
  try {
    const t0 = Date.now();
    const res = await http({
      method: 'POST',
      url: base + '/images/generations',
      headers,
      body: { model: cfg.model, prompt, n, size, response_format: 'b64_json' },
    });
    const body = res.body || {};
    if (res.status !== 200 || !Array.isArray(body.data) || !body.data.length) {
      const msg = (body.error && (body.error.message || body.error.msg)) || JSON.stringify(body).slice(0, 200);
      return { ok: false, error: '生成失败（HTTP ' + res.status + '）：' + msg };
    }
    const images = body.data.map((d) => ({ b64: d.b64_json || undefined, url: d.url || undefined, revisedPrompt: d.revised_prompt || undefined }));
    log('[image-gen] 生成 ' + images.length + ' 张，耗时 ' + (Date.now() - t0) + 'ms（' + cfg.model + ' ' + size + '）');
    return { ok: true, images };
  } catch (err) {
    return { ok: false, error: '生成请求失败：' + ((err && err.message) || err) };
  }
}

module.exports = { generateImage, validateConfig, DEFAULT_TIMEOUT_MS };
