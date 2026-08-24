'use strict';
/**
 * GitHub 集成（纯 Node，无 Electron 依赖）：
 *  - 设备码快速登录（Device Flow）：桌面端拉起 → 浏览器输码授权 → 轮询拿 token，
 *    无需安装 gh CLI、无需手动复制 token；
 *  - token 存 $DSH_HOME/.github-auth.json（工作区之外，绝不入库、绝不打日志）；
 *  - 创建私有远程仓库 + 关联 origin（推送起点）；
 *  - 代码搜索（/search/code，需要登录 token，供模型检索 GitHub 上的实现）。
 *
 * OAuth client_id 复用 GitHub CLI 的公开 client id（gh 官方用于本机设备流登录，
 * 第三方工具普遍复用；scope: repo）。
 * 所有网络调用走注入式 transport（默认 node:https），测试可替换。
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const CLIENT_ID = '178c6fc778ccc68e1d6a'; // gh CLI 公开 OAuth client id（设备流专用）
const SCOPE = 'repo';
const DEVICE_ENDPOINT = 'https://github.com/login/device/code';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

/** 注入式 HTTP transport（默认真实 https；测试替换）。签名：transport({ hostname, path, method, headers, body }) → Promise<{status, json}> */
let transport = null;
function defaultTransport(req) {
  return new Promise((resolve, reject) => {
    const data = req.body ? JSON.stringify(req.body) : null;
    const options = {
      hostname: req.hostname,
      path: req.path,
      method: req.method || 'GET',
      headers: {
        'User-Agent': 'dsh-desktop',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(req.headers || {}),
      },
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const r = https.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; if (raw.length > 4 * 1024 * 1024) res.destroy(); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw || '{}'); } catch { json = { raw }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('http timeout')));
    if (data) r.write(data);
    r.end();
  });
}

function setTransportForTest(fn) {
  transport = fn;
}

function http(req) {
  return (transport || defaultTransport)(req);
}

/* ---------- 设备码登录 ---------- */

/** 发起设备流：返回 { deviceCode, userCode, verificationUri, expiresIn, interval }。 */
async function deviceFlowStart() {
  const res = await http({
    hostname: 'github.com',
    path: '/login/device/code',
    method: 'POST',
    body: { client_id: CLIENT_ID, scope: SCOPE },
  });
  if (res.status !== 200 || !res.json || !res.json.device_code) {
    throw new Error('GitHub 设备流发起失败：' + JSON.stringify(res.json || {}).slice(0, 200));
  }
  return {
    deviceCode: res.json.device_code,
    userCode: res.json.user_code,
    verificationUri: String(res.json.verification_uri || 'https://github.com/login/device'),
    expiresIn: typeof res.json.expires_in === 'number' ? res.json.expires_in : 900,
    interval: typeof res.json.interval === 'number' ? res.json.interval : 5,
  };
}

/** 轮询一次设备流 token：{ pending:true } | { pending:false, token } ；失败抛错。 */
async function deviceFlowPoll(deviceCode) {
  const res = await http({
    hostname: 'github.com',
    path: '/login/oauth/access_token',
    method: 'POST',
    body: {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
  });
  const j = res.json || {};
  if (j.access_token) return { pending: false, token: j.access_token };
  const err = String(j.error || '');
  if (err === 'authorization_pending') return { pending: true };
  if (err === 'slow_down') return { pending: true, slowDown: true };
  throw new Error('GitHub 授权失败或已过期（' + (err || JSON.stringify(j).slice(0, 120)) + '），请重新发起登录');
}

/* ---------- 认证存储 ---------- */

function authFile(dshHome) {
  return path.join(dshHome, '.github-auth.json');
}

/** 读取 { token, login, authedAt } 或 null。 */
function readAuth(dshHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(authFile(dshHome), 'utf8'));
    if (raw && typeof raw.token === 'string' && raw.token) return raw;
    return null;
  } catch { return null; }
}

/** 原子写认证信息。 */
function writeAuth(dshHome, auth) {
  const file = authFile(dshHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function clearAuth(dshHome) {
  try { fs.rmSync(authFile(dshHome), { force: true }); } catch { /* 忽略 */ }
}

/* ---------- API 调用 ---------- */

/** 带 token 调 api.github.com。 */
async function api(token, method, apiPath, body) {
  const res = await http({
    hostname: 'api.github.com',
    path: apiPath,
    method,
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body,
  });
  return res;
}

/** 当前登录用户。 */
async function whoami(token) {
  const res = await api(token, 'GET', '/user');
  if (res.status !== 200 || !res.json || typeof res.json.login !== 'string') {
    throw new Error('GitHub 用户信息读取失败（HTTP ' + res.status + '）');
  }
  return { login: res.json.login, name: res.json.name || null, htmlUrl: res.json.html_url || ('https://github.com/' + res.json.login) };
}

/** 创建仓库（默认私有）。返回 { name, htmlUrl, cloneUrl, sshUrl }。 */
async function createRepo(token, { name, description, isPrivate = true }) {
  const res = await api(token, 'POST', '/user/repos', {
    name,
    description: description || 'Created by DSH Desktop',
    private: isPrivate === true,
    auto_init: false,
  });
  if (res.status !== 201 && res.status !== 200) {
    const err = res.json && (res.json.message || res.json.errors);
    throw new Error('创建仓库失败：' + JSON.stringify(err).slice(0, 200));
  }
  const j = res.json;
  return { name: j.name, fullName: j.full_name, htmlUrl: j.html_url, cloneUrl: j.clone_url, sshUrl: j.ssh_url, isPrivate: j.private };
}

/** 重命名仓库（PATCH /repos/{owner}/{repo}）。返回新仓库信息（cloneUrl 会变化，需同步 git remote set-url）。 */
async function renameRepo(token, fullName, newName) {
  const parts = String(fullName || '').split('/');
  const owner = encodeURIComponent(String(parts[0] || '').trim());
  const repoName = encodeURIComponent(String(parts[1] || '').trim());
  if (!owner || !repoName) throw new Error('fullName 需为 owner/repo 形式');
  const res = await api(token, 'PATCH', '/repos/' + owner + '/' + repoName, { name: newName });
  if (res.status !== 200) {
    const err = res.json && (res.json.message || res.json.errors);
    throw new Error('重命名失败：' + JSON.stringify(err).slice(0, 200));
  }
  const j = res.json;
  return { name: j.name, fullName: j.full_name, htmlUrl: j.html_url, cloneUrl: j.clone_url, isPrivate: j.private };
}

/** 代码搜索（需要登录；q 为 GitHub 代码搜索语法）。 */
async function searchCode(token, q, perPage = 10) {
  const res = await api(token, 'GET', '/search/code?q=' + encodeURIComponent(q) + '&per_page=' + Math.min(perPage, 20));
  if (res.status !== 200) {
    throw new Error('代码搜索失败（HTTP ' + res.status + '）：' + JSON.stringify(res.json && res.json.message).slice(0, 160));
  }
  const items = (res.json.items || []).map((it) => ({
    name: it.name,
    path: it.path,
    repository: it.repository ? it.repository.full_name : '?',
    htmlUrl: it.html_url,
  }));
  return { total: res.json.total_count || 0, items };
}

/** 汇总状态：{ authed, login, name, htmlUrl, hasToken }（不含 token）。 */
async function status(dshHome) {
  const auth = readAuth(dshHome);
  if (!auth) return { authed: false, login: null };
  try {
    const u = await whoami(auth.token);
    return { authed: true, login: u.login, name: u.name, htmlUrl: u.htmlUrl };
  } catch {
    return { authed: false, login: auth.login || null, error: 'token 已失效，请重新登录' };
  }
}

/* ---------- 仓库名推导（纯函数，便于测试） ---------- */

/** 从工作区路径推导合法 GitHub 仓库名（小写字母数字与 . _ -；保留原大小写）。 */
function suggestRepoName(workspace) {
  const base = path.basename(String(workspace || '')).trim() || 'workspace';
  // GitHub 允许大小写/.-_；去掉非法字符，限制 100 字符
  const cleaned = base.replace(/[^\w.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'workspace';
  return cleaned.slice(0, 100);
}

module.exports = {
  deviceFlowStart,
  deviceFlowPoll,
  readAuth,
  writeAuth,
  clearAuth,
  whoami,
  createRepo,
  renameRepo,
  searchCode,
  status,
  suggestRepoName,
  setTransportForTest,
  CLIENT_ID,
  DEVICE_ENDPOINT,
  TOKEN_ENDPOINT,
  API_BASE,
};
