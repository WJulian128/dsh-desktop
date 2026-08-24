'use strict';
// 多厂商 LLM Provider 管理 — 契约验证脚本
// 覆盖：settings.apiProviders 读写 / apiKey 脱敏 / providerEnvKey 命名 /
//       web.patch.yml 生成（enabled 行注入、disabled 跳过、MCP 行不受影响）/
//       buildChildEnv 同款 env 注入逻辑 / providers-test 的 /v1/models 错误路径
//       （真实请求 https://api.xiaomimimo.com/v1/models，假 key 验证 401/失败分支）
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { Settings } = require('../main/settings.js');
const { buildPatchRows, renderPatchYaml, providerEnvKey } = require('../main/web-patch.js');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// --- 1) settings.apiProviders 读写（Settings 类 + 临时文件） ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-providers-'));
const settings = new Settings(path.join(tmp, 'settings.json'));
check('默认 apiProviders 为空数组', Array.isArray(settings.get('apiProviders')) && settings.get('apiProviders').length === 0);

const mimo = {
  id: 'mimo', name: '小米 MiMo', provider: 'xiaomi-mimo',
  baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-fake-test-key-1234',
  models: ['mimo-v2.5', 'mimo-v2.5-pro'], enabled: true, balanceKind: 'none', note: '',
};
const genId = 'p' + Date.now().toString(36); // 与 main.js 生成规则一致
const second = {
  id: genId, name: '我的端点', provider: 'openai-compat',
  baseUrl: 'https://example.com/v1/', apiKey: 'sk-second-key-9999',
  models: ['gpt-4o-mini'], enabled: false, balanceKind: 'deepseek', note: '备选',
};
settings.set('apiProviders', [mimo, second]);
const reread = new Settings(path.join(tmp, 'settings.json')); // 新实例模拟磁盘读回/热加载
const list = reread.get('apiProviders');
check('写回并可读回（含生成 id 与 balanceKind）',
  list.length === 2 && list[1].id === genId && list[1].balanceKind === 'deepseek');

// --- 2) apiKey 脱敏 + hasKey（providersListPayload 同款逻辑） ---
const masked = list.map((p) => ({ ...p, apiKey: p.apiKey ? '****' + String(p.apiKey).slice(-4) : '', hasKey: !!p.apiKey }));
check('apiKey 脱敏为 ****+后4位', masked[0].apiKey === '****1234' && masked[0].hasKey === true);
const maskedJson = JSON.stringify(masked);
check('完整 key 不泄露', !maskedJson.includes('sk-fake-test-key-1234') && !maskedJson.includes('sk-second-key-9999'));

// --- 3) providerEnvKey 命名（web-patch.js 导出，main.js 同款） ---
check('providerEnvKey: mimo -> MIMO_API_KEY', providerEnvKey('mimo') === 'MIMO_API_KEY');
check('providerEnvKey: 生成 id -> 大写 + _API_KEY', providerEnvKey(genId) === genId.toUpperCase() + '_API_KEY');
check('providerEnvKey: 非法字符清洗', providerEnvKey('my-provider') === 'MY_PROVIDER_API_KEY');

// --- 4) web.patch.yml 生成 ---
const rows = buildPatchRows({ appDir: path.join(tmp, 'app'), dshHome: tmp, apiProviders: [mimo, second] });
const llmRows = rows.filter((r) => r.id && r.id.startsWith('llm-provider-'));
check('patch 行：仅 enabled 的 mimo 注入', llmRows.length === 1 && llmRows[0].id === 'llm-provider-mimo');
check('patch 行：name 为 @dsh-desktop/llm-openai-compat', llmRows[0].name === '@dsh-desktop/llm-openai-compat');
check('patch 行：desktop-settings-ui 仍在', rows.some((r) => r.id === 'desktop-settings-ui'));
check('patch 行：MCP 行未受影响', rows.some((r) => r.id === 'mcp-dsh-desktop'));
const llm = llmRows[0];
check('patch config: providerName/baseURL/apiKeyEnv',
  llm.config.providerName === 'xiaomi-mimo'
  && llm.config.baseURL === 'https://api.xiaomimimo.com/v1'
  && llm.config.apiKeyEnv === 'MIMO_API_KEY');
check('patch config: models 映射为 {id}',
  JSON.stringify(llm.config.models) === JSON.stringify([{ id: 'mimo-v2.5' }, { id: 'mimo-v2.5-pro' }]));
const patchText = renderPatchYaml(rows);
check('patch 文本不含 apiKey 明文', !patchText.includes('sk-fake') && !patchText.includes('sk-second'));
console.log('\n===== web.patch.yml 生成结果 =====');
console.log(patchText);

// --- 5) env 注入模拟（buildChildEnv 同款循环：enabled 且有 key 才注入） ---
const env = {};
for (const p of list) {
  if (!p || p.enabled === false || !p.id || !p.apiKey) continue;
  env[providerEnvKey(p.id)] = p.apiKey;
}
check('env 注入：MIMO_API_KEY 有值', env.MIMO_API_KEY === 'sk-fake-test-key-1234');
check('env 注入：disabled 的 provider 不注入', !((genId.toUpperCase() + '_API_KEY') in env));
console.log('env 注入键：' + Object.keys(env).join(', ') + '（值已注入，不打印）');

// --- 6) providers-test 的 /v1/models 错误路径（真实请求 + 假 key） ---
// 与 main.js dsh:providers-test / fetchJson 同款逻辑（Bearer + 15s 超时 + available 语义）。
function fetchJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'dsh-desktop', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('解析失败：' + (err && err.message))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
  });
}

(async () => {
  const startedAt = Date.now();
  let result;
  try {
    const body = await fetchJson(String(mimo.baseUrl).replace(/\/+$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + mimo.apiKey }, timeoutMs: 15000,
    });
    const models = Array.isArray(body && body.data) ? body.data.map((m) => m && m.id).filter(Boolean) : [];
    result = { ok: true, available: true, models, latencyMs: Date.now() - startedAt };
  } catch (err) {
    result = {
      ok: true, available: false, models: [], latencyMs: Date.now() - startedAt,
      error: (err && err.message) || String(err),
    };
  }
  console.log('\n===== providers-test 结果（假 key vs https://api.xiaomimimo.com/v1/models） =====');
  console.log(JSON.stringify(result, null, 2));
  check('假 key 应返回 available:false', result.available === false);
  check('假 key 应带 error 且 latencyMs 为数字', typeof result.error === 'string' && typeof result.latencyMs === 'number');

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) { console.log('\nTEST-PROVIDERS FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('\nTEST-PROVIDERS OK');
})();
