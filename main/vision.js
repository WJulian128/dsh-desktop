'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const sharp = require('sharp');
const { decompressFrames } = require('./usage');

/**
 * 多模态图片识别：把一张图片（文件路径 / URL / harness 附件引用）交给配置的
 * 视觉模型（OpenAI 兼容接口），返回文字描述，供文本模型使用。
 *
 * 注意力对齐设计（跨模型看图的关键优化）：
 *  - 调用方把「当前要解决的问题」作为 question 一并传入 → 视觉模型的注意力被
 *    任务条件化，只描述与问题相关的部分，而不是泛泛而谈；
 *  - 支持 region 局部裁剪放大 → 主模型可对细节“zoom-in”二次询问（像人一样先
 *    看全局再凑近看局部），而不是一次看完；
 *  - 提示词要求「逐字转录文字优先 + 结构化描述」，文字是唯一无损的信息通道。
 *
 * harness 附件引用形如文本内嵌 `sha256:<64hex>`，存储于
 * $DSH_HOME/attachments/v1/objects/<前2位>/<64hex>。
 */

const ATTACHMENT_RE = /sha256:([a-f0-9]{64})/;
const IMAGE_MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** 从文本中提取附件引用 id。 */
function extractAttachmentId(text) {
  const match = ATTACHMENT_RE.exec(String(text || ''));
  return match ? match[1] : null;
}

/** 由附件 id 解析存储文件路径。 */
function attachmentPath(dshHome, sha256) {
  return path.join(dshHome, 'attachments', 'v1', 'objects', sha256.slice(0, 2), sha256);
}

/** 解析图片来源：返回 { data, mediaType }。支持 path / url / 附件引用（ref）/ dataUrl。 */
async function resolveImageSource({ path: filePath, url, ref, dataUrl, dshHome, maxBytes = 15 * 1024 * 1024 }) {
  let data = null;
  let mediaType = null;
  if (ref) {
    const id = extractAttachmentId(ref);
    if (!id) throw new Error('附件引用格式无效：需包含 sha256:<64位十六进制>');
    const p = attachmentPath(dshHome, id);
    if (!fs.existsSync(p)) throw new Error('附件不存在（可能已清理）：' + id.slice(0, 12) + '…');
    data = fs.readFileSync(p);
    mediaType = IMAGE_MEDIA_TYPES[path.extname(p).slice(1).toLowerCase()] || 'image/png';
  } else if (filePath) {
    const p = path.resolve(String(filePath));
    if (!fs.existsSync(p)) throw new Error('文件不存在：' + p);
    data = fs.readFileSync(p);
    mediaType = IMAGE_MEDIA_TYPES[path.extname(p).slice(1).toLowerCase()] || 'image/png';
  } else if (dataUrl) {
    // 粘贴/附件图（无本地路径）由页面 File 转 dataUrl 传入（截图补救 P1.5）
    const m = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
    if (!m) throw new Error('dataUrl 格式无效（需 data:<mime>;base64,<data>）');
    data = Buffer.from(m[2], 'base64');
    const ext = Object.keys(IMAGE_MEDIA_TYPES).find((k) => IMAGE_MEDIA_TYPES[k] === (m[1] || ''));
    mediaType = m[1] && (m[1] === 'image/jpeg' || m[1] === 'image/webp' || m[1] === 'image/gif' || m[1] === 'image/png')
      ? m[1]
      : (ext ? IMAGE_MEDIA_TYPES[ext] : 'image/png');
  } else if (url) {
    data = await fetchUrl(url, maxBytes);
    mediaType = 'image/jpeg';
  } else {
    throw new Error('需要提供 path、url、附件引用（ref）或 dataUrl');
  }
  if (data.length === 0) throw new Error('图片为空');
  if (data.length > maxBytes) throw new Error('图片过大（>15MB）');
  return { data, mediaType };
}

function fetchUrl(url, maxBytes, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'dsh-desktop-vision' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('下载图片失败：HTTP ' + res.statusCode)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('图片过大（>15MB）')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载图片超时')));
  });
}

/**
 * 预处理图片以降低视觉模型编码开销：最长边超过 maxDim 时等比缩小（PNG 输出，
 * 避免 JPEG 伪影影响文字识别）。视觉 token 数与分辨率正相关（qwen2.5vl 等按
 * 28×28 patch 编码），全屏截图（2560×1440）缩到 1280 长边后 token 数约降 4 倍，
 * CPU 推理单次耗时可从数分钟降到一分钟级。预处理失败不阻断识别（原图兜底）。
 * 返回 { data, mediaType }；无需处理时 mediaType 为 null（调用方沿用原类型）。
 */
async function preprocessImage(data, maxDim = 1280) {
  try {
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) return { data, mediaType: null };
    if (Math.max(meta.width, meta.height) <= maxDim) return { data, mediaType: null };
    const out = await sharp(data).resize({
      width: meta.width >= meta.height ? maxDim : undefined,
      height: meta.height > meta.width ? maxDim : undefined,
      fit: 'inside',
      withoutEnlargement: true,
    }).png().toBuffer();
    return { data: out, mediaType: 'image/png' };
  } catch {
    return { data, mediaType: null };
  }
}

/** 调 OpenAI 兼容视觉模型。vision: { enabled, baseUrl, apiKey, model }。question 用于任务条件化注意力。
 *  本地 CPU 视觉模型（qwen2.5vl 等）单次推理可达 1~8 分钟，timeoutMs 必须足够宽松。
 *  stream: true 时走 SSE 流式并把增量文本回调给 onDelta（桌面端用于实时展示识别过程）。
 *  signal：客户端断开时取消推理（避免 MCP 层报错后主进程仍空转浪费 CPU）。
 *  onReset：流式重试前回调（UI 清空已展示的增量文本，避免重试文本重复拼接）。
 *  容错（保证"任何情况下尽量成功"）：
 *   - 流式模式最多尝试 3 次（网络抖动/SSE 提前结束/空流/HTTP 5xx 等可重试错误）；
 *   - 流式 3 次全败后自动降级非流式再试 2 次（非流式对云端更稳，已实测小米 200）；
 *   - 显存不足（CUDA OOM，本地模型）自动纯 CPU 重试一次（既有逻辑）。 */
async function requestVision(vision, dataUrl, { timeoutMs = 480000, question = '', regionNote = '', stream = false, onDelta = null, onReset = null, signal = null, options = null } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const retriable = (err) => {
    const msg = String((err && err.message) || '');
    // 可重试：网络层断开/超时、SSE 提前结束、空响应、HTTP 5xx 服务端偶发
    return /提前结束|超时|ECONNRESET|socket hang up|EPIPE|ENETUNREACH|ETIMEDOUT|empty|HTTP 50\d|HTTP 429/i.test(msg)
      || (err && err.code === 'TRANSPORT');
  };
  // 流式尝试上限（含首次）；流式全败后非流式兜底上限（含首次）
  const STREAM_TRIES = 3, PLAIN_TRIES = 2;
  let lastErr = null;
  const attempt = async (useStream, triesLeft, tryNum) => {
    if (signal && signal.aborted) throw (lastErr || new Error('请求已取消'));
    try {
      return await requestVisionInner(vision, dataUrl, { timeoutMs, question, regionNote, stream: useStream, onDelta, signal, options });
    } catch (err) {
      lastErr = err;
      if (signal && signal.aborted) throw err;
      if (retriable(err) && triesLeft > 1) {
        if (useStream && onReset) { try { onReset(); } catch { /* 忽略 */ } } // 清空 UI 增量，避免重试文本重复
        await sleep(600 * tryNum); // 退避：600ms / 1200ms …
        return attempt(useStream, triesLeft - 1, tryNum + 1);
      }
      if (useStream) {
        // 流式全败 → 非流式兜底（更稳，无增量问题）
        try { return await attempt(false, PLAIN_TRIES, 1); } catch (err2) { lastErr = err2; }
      }
      throw lastErr || err;
    }
  };
  try {
    return await attempt(!!stream, stream ? STREAM_TRIES : PLAIN_TRIES, 1);
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (/out.?of.?memory|out-of-memory|CUDA error|health resp|refused|ECONNRESET|connection reset/i.test(msg)) {
      // 显存不足或 llama-server 崩溃（health refused/ECONNRESET 等）：先尝试纯 CPU 重试一次；
      // 仍失败抛带 code 的错误交给调用方（桌面端会重启 Ollama 服务后重试）。
      try {
        return await requestVisionInner(vision, dataUrl, { timeoutMs, question, regionNote, stream, onDelta, signal, options: { num_gpu: 0 } });
      } catch (err2) {
        const e2 = new Error('本地视觉服务异常（' + msg.slice(0, 120) + '）');
        e2.code = 'OLLAMA_BROKEN';
        throw e2;
      }
    }
    throw err;
  }
}

function requestVisionInner(vision, dataUrl, { timeoutMs = 480000, question = '', regionNote = '', stream = false, onDelta = null, signal = null, options = null } = {}) {
  const base = String(vision.baseUrl || '').replace(/\/+$/, '');
  const endpoint = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    return Promise.reject(new Error('视觉模型 baseUrl 需以 http(s):// 开头'));
  }
  const hasQuestion = String(question || '').trim().length > 0;
  const systemPrompt = [
    'You are the vision module of a coding agent. A text-only model (DeepSeek) is working on a task and needs to know what is in this image.',
    'Rules, in order:',
    '1. TRANSCRIBE ALL READABLE TEXT VERBATIM first (titles, buttons, code, errors, filenames, numbers) — text is the only lossless channel, never paraphrase or skip it.',
    '2. Then describe structure factually: layout, elements, colors, positions, what looks selected/highlighted/erroring.',
    '3. ' + (hasQuestion
      ? 'A QUESTION about the image is attached. Center your attention on answering it; the transcript and description only need to cover what is relevant to it. Answer the question explicitly at the end.'
      : 'No specific question was provided. Give a dense, information-complete summary that lets the text model continue without ever seeing the image.'),
    regionNote || '',
    'For logos, icons, or brand marks: describe the shape and colors precisely, then list the 2-3 most likely software/app names it could be. Never just say "some software".',
    'Reply in the same language as the question if present, otherwise the user language. Output only the report, no preamble.',
  ].filter(Boolean).join('\n');
  const userContent = [
    ...(hasQuestion ? [{ type: 'text', text: 'Question to answer: ' + String(question).trim() }] : []),
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
  const payload = {
    model: vision.model,
    stream: !!stream,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    ...(options ? { options } : {}),
  };
  const body = JSON.stringify(payload);
  const mod = endpoint.startsWith('https:') ? https : http;
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': 'dsh-desktop-vision',
  };
  // 本地 Ollama 无需鉴权；在线服务商才带 Bearer。
  if (vision.apiKey) headers.Authorization = 'Bearer ' + vision.apiKey;
  return new Promise((resolve, reject) => {
    const req = mod.request(endpoint, {
      method: 'POST',
      headers,
      signal: signal || undefined,
      // 禁用 keep-alive 连接复用：云端（小米等）在复用连接上偶发空流/提前关闭，
      // 每次新连接隔离连接状态，从根上规避该问题（建立新连接成本可忽略）。
      agent: false,
    }, (res) => {
      if (res.statusCode !== 200) {
        let errText = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { errText += chunk; });
        res.on('end', () => reject(new Error('视觉模型接口返回 HTTP ' + res.statusCode + '：' + errText.slice(0, 300))));
        return;
      }
      if (!stream) {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          try {
            const doc = JSON.parse(text);
            const content = doc.choices && doc.choices[0] && doc.choices[0].message && doc.choices[0].message.content;
            if (typeof content !== 'string' || !content.trim()) reject(new Error('视觉模型返回空内容'));
            else resolve(content.trim());
          } catch (err) {
            reject(new Error('解析视觉模型响应失败：' + (err && err.message ? err.message : err)));
          }
        });
        return;
      }
      // SSE 流式（OpenAI 兼容）：逐行 data: {...}，增量 delta.content 经 onDelta 回调，
      // 供桌面端把识别过程实时展示到对话页面（本地模型推理可达数分钟，避免用户误以为卡住）。
      let buf = '';
      let full = '';
      let sawDone = false;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || !line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { sawDone = true; continue; }
          try {
            const doc = JSON.parse(data);
            const delta = doc.choices && doc.choices[0] && doc.choices[0].delta;
            const text = delta && delta.content;
            if (typeof text === 'string' && text) {
              full += text;
              if (onDelta) { try { onDelta(text); } catch { /* 回调异常不影响识别 */ } }
            }
          } catch { /* 跳过无法解析的行 */ }
        }
      });
      res.on('end', () => {
        if ((sawDone || full.trim()) && full.trim()) resolve(full.trim());
        else reject(new Error('视觉模型流式响应提前结束（收到 ' + full.length + ' 字符增量，sawDone=' + sawDone + '）'));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('视觉模型请求超时')));
    req.end(body);
  });
}

/**
 * 描述一张图片。返回文字描述。
 * input.question：任务条件化的注意力——把要回答的问题带给视觉模型；
 * input.region：{ x, y, width, height } 局部裁剪放大（像素，基于原图），
 * 让主模型对细节“zoom-in”二次询问。
 */
async function describeImage(vision, input) {
  if (!vision || vision.enabled === false) throw new Error('多模态图片识别未启用（设置 → 多模态）');
  if (!vision.model || !vision.baseUrl) throw new Error('多模态配置不完整（需要 baseUrl、model；本地 Ollama 无需 apiKey）');
  const dshHome = input && input.dshHome;
  let { data, mediaType } = await resolveImageSource({ ...input, dshHome });
  let regionNote = '';
  const region = input && input.region;
  if (region && typeof region === 'object') {
    const x = Math.max(0, Math.round(Number(region.x) || 0));
    const y = Math.max(0, Math.round(Number(region.y) || 0));
    const width = Math.max(1, Math.round(Number(region.width) || 0));
    const height = Math.max(1, Math.round(Number(region.height) || 0));
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) throw new Error('无法读取图片尺寸，无法裁剪');
    const cx = Math.min(x, meta.width - 1);
    const cy = Math.min(y, meta.height - 1);
    const cw = Math.min(width, meta.width - cx);
    const ch = Math.min(height, meta.height - cy);
    data = await sharp(data).extract({ left: cx, top: cy, width: cw, height: ch }).png().toBuffer();
    mediaType = 'image/png';
    regionNote = 'NOTE: This is a CROPPED REGION of a larger image (source region: x=' + cx + ', y=' + cy + ', w=' + cw + ', h=' + ch + ' of a ' + meta.width + 'x' + meta.height + ' image). Focus on the detail inside this crop.';
  }
  // 统一预处理：长边 > 1280 等比缩小，显著降低本地模型的图像编码 token 与推理耗时。
  const pre = await preprocessImage(data);
  if (pre.mediaType) { data = pre.data; mediaType = pre.mediaType; }
  const dataUrl = 'data:' + mediaType + ';base64,' + data.toString('base64');
  return requestVision(vision, dataUrl, {
    question: (input && input.question) || '',
    regionNote,
    timeoutMs: input && input.timeoutMs ? input.timeoutMs : 480000,
    stream: !!(input && input.stream),
    onDelta: input && input.onDelta,
    signal: input && input.signal,
    options: input && input.options,
  });
}

/** 测试视觉模型连通性：发送 1x1 像素 PNG（冷启动含模型加载，超时同样放宽）。 */
async function testVision(vision) {
  if (!vision || !vision.model || !vision.baseUrl) throw new Error('多模态配置不完整（本地 Ollama 无需 apiKey）');
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const text = await requestVision(vision, 'data:image/png;base64,' + pixel.toString('base64'), { timeoutMs: 480000 });
  return { ok: true, sample: text.slice(0, 200) };
}

/** 判断模型是否支持多模态（纯函数，启发式：模型名含 vision/vl/multimodal）。 */
function modelSupportsVision(modelName) {
  if (!modelName || typeof modelName !== 'string') return false;
  const m = String(modelName).toLowerCase();
  return m.includes('vision') || m.includes('vl-') || m.includes('vl:') || m.includes('multimodal') || m.includes('image');
}

/**
 * 读取指定工作区当前（最新）会话实际使用的模型名（纯 Node，无 Electron 依赖）。
 * 数据源：会话 JSONL 中最近一条 request/context.model（或 request/header.config.model）。
 * 反映会话级模型切换（比 settings.yaml 默认模型更准确）。失败返回 null。
 * 性能：先做尾帧快检（只解压尾部 ≤256KB 的最后 24 帧，最近一轮的模型记录必然在尾部）；
 * 尾帧无模型记录时才回退全量解压——避免启动/面板轮询时全量解压数十 MB JSON 卡主线程。
 */
function readCurrentModel(sessionsRoot, workspaceKey) {
  try {
    const root = path.join(sessionsRoot, workspaceKey);
    if (!fs.existsSync(root)) return null;
    let best = null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'session.jsonl.zstd');
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
    }
    if (!best) return null;
    // 尾帧快检：最近一轮的 request/context 与 request/header 一定在尾部帧里
    const tailModel = modelFromTailFrames(best.file, 256 * 1024, 24);
    if (tailModel) return tailModel;
    // 回退：全量扫描（罕见场景：尾部只有 UI 同步事件无模型记录）
    const text = decompressFrames(fs.readFileSync(best.file));
    let model = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r.type !== 'string') continue;
      if (r.type === 'request/context' && r.data && typeof r.data.model === 'string' && r.data.model) {
        model = r.data.model;
      } else if (r.type === 'request/header' && r.data && r.data.header && r.data.header.config
        && typeof r.data.header.config.model === 'string' && r.data.header.config.model) {
        model = r.data.header.config.model;
      }
    }
    return model;
  } catch { return null; }
}

/** 从会话文件尾部最后 maxFrames 个 zstd 帧里找最近一条模型记录（无则返回 null）。 */
function modelFromTailFrames(file, tailBytes, maxFrames) {
  try {
    const st = fs.statSync(file);
    if (st.size <= tailBytes) return null; // 小文件直接走全量路径，省两次解压
    const start = st.size - tailBytes;
    const buf = Buffer.alloc(tailBytes);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    const magic = [0x28, 0xb5, 0x2f, 0xfd];
    const positions = [];
    for (let i = buf.length - 4; i >= 0; i--) {
      if (buf[i] === magic[0] && buf[i + 1] === magic[1] && buf[i + 2] === magic[2] && buf[i + 3] === magic[3]) {
        positions.push(i);
        if (positions.length >= maxFrames) break;
      }
    }
    let model = null;
    for (const pos of positions) {
      try {
        const r = JSON.parse(zlib.zstdDecompressSync(buf.subarray(pos)).toString('utf8'));
        if (!r || typeof r.type !== 'string') continue;
        if (r.type === 'request/context' && r.data && typeof r.data.model === 'string' && r.data.model) {
          model = r.data.model;
        } else if (r.type === 'request/header' && r.data && r.data.header && r.data.header.config
          && typeof r.data.header.config.model === 'string' && r.data.header.config.model) {
          model = r.data.header.config.model;
        }
      } catch { /* 尾部可能含未写完的帧，跳过 */ }
    }
    return model;
  } catch { return null; }
}

module.exports = { describeImage, testVision, preprocessImage, extractAttachmentId, attachmentPath, modelSupportsVision, readCurrentModel };
