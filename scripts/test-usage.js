const fs = require('fs');
const os = require('os');
const path = require('path');
const { workspaceSessionKey, scanWorkspaceUsage, resolveDeepSeekKey } = require('../main/usage.js');
const workspace = 'C:/Users/user/Desktop/DeepseekHarness';
const key = workspaceSessionKey(workspace);
console.log('key:', key);
const root = path.join('C:/Users/user/.dsh', 'sessions', key);
console.log('root exists:', fs.existsSync(root));
if (fs.existsSync(root)) console.log('entries:', fs.readdirSync(root).join(', '));
const r = scanWorkspaceUsage({ dshHome: 'C:/Users/user/.dsh', workspace, usagePrices: null });
console.log('sessions:', r.sessions.length, 'total:', JSON.stringify(r.total));
for (const s of r.sessions.slice(0, 3)) console.log('-', s.sessionId, s.title || '', s.error || '');

// 计费时段（DeepSeek 官方峰谷定价，北京时间）单元测试
const { resolvePriceTier, isPeakHour, nextTierSwitch } = require('../main/usage.js');
const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}
const t = (iso) => new Date(iso);
check('Mon 09:00 peak (boundary)', isPeakHour(t('2026-08-24T09:00:00+08:00')) === true, '');
check('Mon 10:00 peak', isPeakHour(t('2026-08-24T10:00:00+08:00')) === true, '');
check('Mon 12:00 valley (boundary)', isPeakHour(t('2026-08-24T12:00:00+08:00')) === false, '');
check('Mon 12:30 valley', isPeakHour(t('2026-08-24T12:30:00+08:00')) === false, '');
check('Mon 15:00 peak', isPeakHour(t('2026-08-24T15:00:00+08:00')) === true, '');
check('Mon 18:00 valley (boundary)', isPeakHour(t('2026-08-24T18:00:00+08:00')) === false, '');
check('Mon 08:59 valley', isPeakHour(t('2026-08-24T08:59:00+08:00')) === false, '');
check('Sat 10:00 valley (weekend)', isPeakHour(t('2026-08-22T10:00:00+08:00')) === false, '');
check('Sun 15:00 valley (weekend)', isPeakHour(t('2026-08-23T15:00:00+08:00')) === false, '');
const pk = resolvePriceTier(t('2026-08-24T10:00:00+08:00'));
check('peak tier label/price', pk.tier === 'peak' && pk.label === '高峰时段' && pk.multiplier === 1 && pk.prices.input === 3.0, JSON.stringify(pk));
const vl = resolvePriceTier(t('2026-08-22T10:00:00+08:00'));
check('valley tier half price', vl.tier === 'valley' && vl.multiplier === 0.5 && vl.prices.input === 1.5, JSON.stringify(vl));
const nx = nextTierSwitch(t('2026-08-24T10:00:00+08:00'));
check('Mon 10:00 next switch is 12:00 valley', nx.tier === 'valley' && Math.abs(nx.at - t('2026-08-24T12:00:00+08:00').getTime()) < 60000, JSON.stringify(nx));
// 自定义峰谷单价（官方调价后无需改代码）
const { resolveTierPrices } = require('../main/usage.js');
const custom = resolveTierPrices({ peak: { input: 4.0, cacheHit: 0.2, output: 12.0 }, valley: { input: 2.0 } });
check('custom peak prices applied', custom.peak.input === 4.0 && custom.peak.cacheHit === 0.2 && custom.peak.output === 12.0, JSON.stringify(custom));
check('custom valley fallback for missing fields', custom.valley.input === 2.0 && custom.valley.cacheHit === 0.05 && custom.valley.output === 4.5, JSON.stringify(custom));
check('null configured uses defaults', JSON.stringify(resolveTierPrices(null)) === JSON.stringify(resolveTierPrices(undefined)), '');
const pkCustom = resolvePriceTier(t('2026-08-24T10:00:00+08:00'), { peak: { input: 4.0, cacheHit: 0.2, output: 12.0 } });
check('resolvePriceTier honors custom peak', pkCustom.prices.input === 4.0 && pkCustom.prices.cacheHit === 0.2 && pkCustom.prices.output === 12.0, JSON.stringify(pkCustom.prices));
const vlCustom = resolvePriceTier(t('2026-08-22T10:00:00+08:00'), { valley: { input: 2.0, cacheHit: 0.08, output: 6.0 } });
check('resolvePriceTier honors custom valley', vlCustom.prices.input === 2.0 && vlCustom.prices.output === 6.0, JSON.stringify(vlCustom.prices));
if (failures.length) { console.log('USAGE-TIER FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('USAGE-TIER OK');

// 凭证解析：官方 refs 结构与旧顶层结构都要能读到
const credHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cred-'));
fs.writeFileSync(path.join(credHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-refs-abc123\n', 'utf8');
check('resolveDeepSeekKey reads refs format', resolveDeepSeekKey(credHome) === 'sk-refs-abc123', resolveDeepSeekKey(credHome));
fs.writeFileSync(path.join(credHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-top-abc123\n', 'utf8');
check('resolveDeepSeekKey reads top-level format', resolveDeepSeekKey(credHome) === 'sk-top-abc123', resolveDeepSeekKey(credHome));
check('resolveDeepSeekKey env wins', resolveDeepSeekKey(credHome, { DEEPSEEK_API_KEY: 'sk-env' }) === 'sk-env', '');
fs.rmSync(credHome, { recursive: true, force: true });
console.log('USAGE-CRED OK');
