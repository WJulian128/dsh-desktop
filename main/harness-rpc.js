'use strict';

/**
 * harness /api RPC 的“端点 / 信封”双风格适配层（纯函数，不发起网络请求）。
 *
 * 背景（0.1.1-rc.2 → 0.1.2-rc.1 升级事故）：桌面端主进程直连官方 /api 的通道
 * 在 0.1.2-rc.1 被重构为 Typert 网关，端点与信封都不兼容旧版，且新版对
 * “风格不匹配”不提供任何兼容：
 *  - 新风格（Typert 网关，0.1.2-rc.1+）：
 *      POST /api/<namespace>/<method>（如 /api/session/list）
 *      body { type:'client-request', rpcId, method:'session/list',
 *             payload:{ args:{ <参数名>: X } } }
 *      参数名必须等于 Typert 描述符里的 wire 名（网关在“执行前”严格校验，
 *      失败返回 arguments-invalid，尚未产生副作用，重试安全）：
 *      session.list 的签名是 list(_request, signal)，其余已知端点
 *      （session.prompt / session.create / workspace.create）的参数名都是 request。
 *  - 旧风格（0.1.1-rc.2 及更早）：
 *      POST /api/<namespace>.<method>（如 /api/session.list）
 *      body { type:'client-request', rpcId, method:'session.list', payload: X }
 *      （payload 直接透传，无 args 包装）
 *
 * 主进程 rpcCall 以本模块为准：按当前版本风格发一次；响应特征表明是
 * “风格 / 参数名不匹配”（区别于业务错误）时换另一风格 / 另一参数名重试一次，
 * 成功后把组合记忆到本进程——让“升级后 API 再变”最多只付出一次试错，
 * 而不是整条通道失效（见 main.js rpcCall）。
 */

/** 已知端点 → Typert 参数名覆盖表；缺省 'request'（其余端点经实测定）。 */
const ARGS_KEY_OVERRIDES = { 'session.list': '_request' };

/** 归一化逻辑方法名（'session.list' 与 'session/list' 都归成 ns/name）。 */
function splitMethod(method) {
  const m = String(method || '');
  const slash = m.indexOf('/');
  const dot = m.indexOf('.');
  if (slash >= 0 && (dot < 0 || slash < dot)) {
    return { namespace: m.slice(0, slash), name: m.slice(slash + 1) };
  }
  if (dot >= 0) {
    return { namespace: m.slice(0, dot), name: m.slice(dot + 1) };
  }
  return { namespace: '', name: m };
}

/** Typert 网关（新风格）要求的 wire 参数名；session.list 的签名是 list(_request, signal)。 */
function argsKeyFor(method) {
  const { namespace, name } = splitMethod(method);
  return ARGS_KEY_OVERRIDES[namespace + '.' + name] || 'request';
}

/** 同一端点的候选参数名（描述符改名时先试记忆/默认，失败换备选）。 */
function argsKeyCandidates(method) {
  const primary = argsKeyFor(method);
  return primary === 'request' ? ['request', '_request'] : ['_request', 'request'];
}

/**
 * 构造一次 /api POST 请求（不发网络）。
 * @param {string} method 逻辑方法名（session.list / session/list 均可）
 * @param {unknown} payload 业务载荷
 * @param {'new'|'legacy'} style 端点风格
 * @param {string} [argsKey] 新风格下的参数名（缺省按 argsKeyFor 推断；旧风格忽略）
 * @returns {{path:string, body:string, json:object}} path 为含 /api 前缀的 URL 路径
 */
function buildRequest(method, payload, style, argsKey) {
  const { namespace, name } = splitMethod(method);
  const logical = namespace + '.' + name;
  if (style === 'legacy') {
    const json = {
      type: 'client-request',
      rpcId: randomId(),
      method: logical,
      payload,
    };
    return { path: '/api/' + logical, json, body: JSON.stringify(json) };
  }
  // 默认新风格：Typert 网关
  const wire = namespace + '/' + name;
  const key = argsKey || argsKeyFor(logical);
  const json = {
    type: 'client-request',
    rpcId: randomId(),
    method: wire,
    payload: { args: { [key]: payload } },
  };
  return { path: '/api/' + wire, json, body: JSON.stringify(json) };
}

/** 随机 rpcId（无 crypto 依赖的轻量实现，唯一性足够）。 */
function randomId() {
  return 'rpc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/**
 * 判读一次响应的“错误类别”，决定可否安全换风格/换参数名重试。
 * @param {number} status HTTP 状态码
 * @param {string} [bodyText] 响应原文（JSON 或纯文本）
 * @returns {'ok'|'unauthorized'|'style-mismatch'|'args-mismatch'|'business'|'other'}
 *   - style-mismatch：端点/信封风格不对（404、gateway/bad-request、not found），
 *     换另一风格重试是安全的（校验发生在执行前）；
 *   - args-mismatch：新风格下参数名/参数形状不符（arguments-invalid），
 *     换候选参数名重试一次是安全的；
 *   - unauthorized：401，需要先换认证 cookie 再重试；
 *   - business：网关已受理并返回业务错误（ok:false 且非风格/参数错误），不重试；
 *   - ok：result.ok === true。
 */
function classifyResponse(status, bodyText) {
  const text = String(bodyText || '');
  if (status === 401) return 'unauthorized';
  let result = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && parsed.result) result = parsed.result;
  } catch { /* 非 JSON：走文本标记 */ }
  if (result && result.ok === true) return 'ok';
  if (status === 404) return 'style-mismatch'; // 端点不存在：多半是风格/版本不对
  const error = result && result.error;
  const errorCode = error && typeof error.code === 'string' ? error.code : '';
  const errorMessage = error && typeof error.message === 'string' ? error.message : '';
  const haystack = (errorCode + ' ' + errorMessage + ' ' + text).toLowerCase();
  if (errorCode === 'gateway/bad-request' || haystack.includes('does not match endpoint')) {
    return 'style-mismatch';
  }
  if (errorCode === 'gateway/arguments-invalid' || errorCode === 'gateway/invalid-request'
    || haystack.includes('do not match the descriptor')
    || haystack.includes('args must be a plain object')
    || haystack.includes('remote payload must contain exactly one plain-object args field')) {
    return 'args-mismatch';
  }
  if (result) return 'business'; // 网关受理但业务失败：绝不重试
  return 'other';
}

module.exports = {
  splitMethod,
  argsKeyFor,
  argsKeyCandidates,
  buildRequest,
  classifyResponse,
};
