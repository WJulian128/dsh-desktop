// 端到端 MCP 测试：真实 SDK MCP 客户端 ↔ main/mcp-server.mjs（stdio）↔ 桌面端 RPC。
// 验证：MCP 握手/工具发现/工具调用，以及 RPC 的 token 鉴权与调用链路。
// 用法：node scripts\test-mcp-server.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'main', 'mcp-server.mjs');
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 1. 模拟桌面端 RPC 服务（token 鉴权，回显调用）
//    describeImage 支持可配延迟（验证 describe_image 走专用长超时，不被 120s 默认掐断）
let describeImageDelay = 0;
const rpc = createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { ok: false, error: 'not found' });
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + TOKEN) return send(401, { ok: false, error: 'unauthorized' });
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return send(400, { ok: false, error: 'bad json' }); }
    if (payload.method === 'getState') return send(200, { ok: true, result: { installed: '0.1.0-rc.6', latest: '0.1.0-rc.7', hasUpdate: true, phase: 'ready' } });
    if (payload.method === 'checkUpdates') return send(200, { ok: true, result: { installed: '0.1.0-rc.6', latest: '0.1.0-rc.7', hasUpdate: true } });
    if (payload.method === 'openFolder') return send(200, { ok: true, result: { path: (payload.params && payload.params.path) || null } });
    if (payload.method === 'describeImage') return setTimeout(() => send(200, { ok: true, result: { description: '这是一张截图：显示了一个按钮', elapsedMs: 2143 } }), describeImageDelay);
    if (payload.method === 'getBalance') return send(200, { ok: true, result: { isAvailable: true, balanceInfos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '10.00', topped_up_balance: '2.34' }] } });
    if (payload.method === 'getUsage') return send(200, { ok: true, result: { total: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, reasoningTokens: 400 }, estimatedCostUsd: 0.1234, sessions: [] } });
    if (payload.method === 'computerScreen') return send(200, { ok: true, result: { width: 1920, height: 1080 } });
    if (payload.method === 'computerScreenshot') return send(200, { ok: true, result: { path: 'C:\\ws\\.dsh-attachments\\screen-1.png', width: 1920, height: 1080, description: '屏幕显示一个终端窗口', descriptionElapsedMs: 2345 } });
    if (payload.method === 'computerWindow' && payload.params && payload.params.action === 'list') return send(200, { ok: true, result: { windows: [{ hwnd: 123, title: '记事本', x: 0, y: 0, w: 800, h: 600 }] } });
    if (payload.method === 'computerClipboard') return send(200, { ok: true, result: { text: '剪贴板内容' } });
    if (payload.method === 'computerMouse' || payload.method === 'computerKeyboard' || payload.method === 'computerLaunch' || payload.method === 'computerWindow') return send(200, { ok: true, result: { ok: true } });
    if (payload.method === 'scheduleList') return send(200, { ok: true, result: [{ id: 'sched-1', label: '早会提醒', kind: 'reminder', mode: 'daily', at: '09:00', task: '开会', enabled: true, lastRun: null }] });
    if (payload.method === 'scheduleAdd') return send(200, { ok: true, result: { id: 'sched-2', label: (payload.params && payload.params.task && payload.params.task.label) || '新建' } });
    if (payload.method === 'scheduleRemove' || payload.method === 'scheduleToggle') return send(200, { ok: true, result: { ok: true } });
    if (payload.method === 'systemDoctor') return send(200, { ok: true, result: [{ id: 'longpath', title: '长路径支持', ok: true, detail: '已启用', fix: null }, { id: 'utf8', title: '控制台 UTF-8', ok: false, detail: '未设置', fix: { type: 'simple', id: 'utf8' } }] });
    if (payload.method === 'systemFix') return send(200, { ok: true, result: { ok: true, detail: '已修复' } });
    if (payload.method === 'systemEnvList') return send(200, { ok: true, result: { PATH: 'C:\\a;C:\\b' } });
    if (payload.method === 'systemEnvSet' || payload.method === 'systemEnvRemove') return send(200, { ok: true, result: { ok: true } });
    if (payload.method === 'projectMapGet') return send(200, { ok: true, result: { ok: true, exists: true, map: '# 地图\n- 模块A', updatedAt: 1700000000000, tracked: 3, staleCount: 1, staleFiles: ['src/a.js'], gitHeadChanged: false } });
    if (payload.method === 'projectMapStatus') return send(200, { ok: true, result: { ok: true, exists: true, updatedAt: 1700000000000, tracked: 3, staleCount: 1, staleFiles: ['src/a.js'], gitHeadChanged: false } });
    if (payload.method === 'projectMapSet') return send(200, { ok: true, result: { ok: true, scanned: 5, skipped: 1, tracked: 5 } });
    if (payload.method === 'editClaim') return send(200, { ok: true, result: { ok: true, claimed: ['src/a.js'], conflicts: [{ file: 'src/b.js', sessionId: 'session-x', label: '另一个对话' }] } });
    if (payload.method === 'editRelease') return send(200, { ok: true, result: { ok: true, released: ['src/a.js'] } });
    if (payload.method === 'editStatus') return send(200, { ok: true, result: { ok: true, mine: [{ file: 'src/a.js', sessionId: 'session-1', claimedAt: 1, expiresAt: 2 }], others: [{ file: 'src/b.js', sessionId: 'session-x', claimedAt: 1, expiresAt: 2 }], total: 2 } });
    if (payload.method === 'editJournal') return send(200, { ok: true, result: { ok: true, entries: [{ time: 1700000000000, action: 'claim', sessionId: 'session-1', files: ['src/a.js'] }] } });
    if (payload.method === 'gitStatus') return send(200, { ok: true, result: { ok: true, output: '## main...origin/main\n M src/a.js' } });
    if (payload.method === 'gitDiff') return send(200, { ok: true, result: { ok: true, output: 'diff --git a/x b/x' } });
    if (payload.method === 'gitLog') return send(200, { ok: true, result: { ok: true, output: 'abc123 初始提交' } });
    if (payload.method === 'gitCommit') return send(200, { ok: true, result: { ok: true, output: '[main abc123] 提交' } });
    if (payload.method === 'gitBranch') return send(200, { ok: true, result: { ok: true, output: '* main' } });
    if (payload.method === 'gitCheckout') return send(200, { ok: true, result: { ok: true, output: 'Switched to branch x' } });
    if (payload.method === 'gitRestore') return send(200, { ok: true, result: { ok: true, output: '' } });
    if (payload.method === 'gitStash') return send(200, { ok: true, result: { ok: true, output: 'stash@{0}' } });
    if (payload.method === 'gitInit') return send(200, { ok: true, result: { ok: true, output: 'Initialized' } });
    if (payload.method === 'githubStatus') return send(200, { ok: true, result: { ok: true, authed: true, login: 'octocat', branch: 'main', remote: 'origin\thttps://github.com/octocat/repo.git (fetch)' } });
    if (payload.method === 'githubLoginStart') return send(200, { ok: true, result: { ok: true, userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5 } });
    if (payload.method === 'githubLoginPoll') return send(200, { ok: true, result: { ok: true, pending: false, login: 'octocat' } });
    if (payload.method === 'githubRemoteSetup') return send(200, { ok: true, result: { ok: true, repo: { name: 'repo', fullName: 'octocat/repo', htmlUrl: 'https://github.com/octocat/repo', isPrivate: true }, pushed: 'pushed' } });
    if (payload.method === 'githubSearchCode') return send(200, { ok: true, result: { ok: true, total: 1, items: [{ name: 'a.js', path: 'src/a.js', repository: 'o/r', htmlUrl: 'https://github.com/o/r/blob/main/a.js' }] } });
    if (payload.method === 'githubSetVisibility') return send(200, { ok: true, result: { ok: true, fullName: 'WJulian128/dsh-desktop', htmlUrl: 'https://github.com/WJulian128/dsh-desktop', visibility: 'public', isPrivate: false } });
    if (payload.method === 'gitPush') return send(200, { ok: true, result: { ok: true, output: 'pushed main' } });
    if (payload.method === 'gitPull') return send(200, { ok: true, result: { ok: true, output: 'Already up to date.' } });
    if (payload.method === 'gitMerge') return send(200, { ok: true, result: { ok: true, output: 'Fast-forward' } });
    if (payload.method === 'gitRemoteList') return send(200, { ok: true, result: { ok: true, output: 'origin\thttps://github.com/o/r.git (fetch)' } });
    send(200, { ok: true, result: { echo: payload.method, params: payload.params } });
  });
});

await new Promise((resolve, reject) => {
  rpc.once('error', reject);
  rpc.listen(0, '127.0.0.1', resolve);
});
const rpcUrl = 'http://127.0.0.1:' + rpc.address().port;
console.log('[test] rpc url: ' + rpcUrl);

// 2. 通过 SDK 客户端拉起 mcp-server.mjs 并连接
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env, DSH_DESKTOP_RPC_URL: rpcUrl, DSH_DESKTOP_RPC_TOKEN: TOKEN },
  stderr: 'pipe',
});
transport.onmessage = () => {};
transport.onerror = (err) => { console.error('[test] transport error:', err); };

let childHandle = null;
try {
  // 捕获 server 的 stderr，确认其启动日志
  const transportWithStderr = transport;
  // StdioClientTransport 内部持有子进程；我们通过 spawn 检查连接即可。
  const client = new Client({ name: 'dsh-desktop-test', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = (tools.tools || []).map((t) => t.name);
  check('tools discovered', names.length > 0, names.join(', '));
  check('has dsh_desktop_get_state', names.includes('dsh_desktop_get_state'), '');
  check('has dsh_desktop_check_updates', names.includes('dsh_desktop_check_updates'), '');
  check('has dsh_desktop_apply_update', names.includes('dsh_desktop_apply_update'), '');
  check('has dsh_desktop_open_folder', names.includes('dsh_desktop_open_folder'), '');
  check('has dsh_desktop_switch_workspace', names.includes('dsh_desktop_switch_workspace'), '');
  check('has dsh_desktop_describe_image', names.includes('dsh_desktop_describe_image'), '');
  check('has dsh_desktop_api_balance', names.includes('dsh_desktop_api_balance'), '');
  check('has dsh_desktop_api_usage', names.includes('dsh_desktop_api_usage'), '');
  check('has dsh_desktop_computer_screenshot', names.includes('dsh_desktop_computer_screenshot'), '');
  check('has dsh_desktop_computer_screen', names.includes('dsh_desktop_computer_screen'), '');
  check('has dsh_desktop_computer_mouse', names.includes('dsh_desktop_computer_mouse'), '');
  check('has dsh_desktop_computer_keyboard', names.includes('dsh_desktop_computer_keyboard'), '');
  check('has dsh_desktop_computer_window', names.includes('dsh_desktop_computer_window'), '');
  check('has dsh_desktop_computer_clipboard', names.includes('dsh_desktop_computer_clipboard'), '');
  check('has dsh_desktop_computer_launch', names.includes('dsh_desktop_computer_launch'), '');
  check('has dsh_desktop_schedule', names.includes('dsh_desktop_schedule'), '');
  check('has dsh_desktop_system_doctor', names.includes('dsh_desktop_system_doctor'), '');
  check('has dsh_desktop_system_fix', names.includes('dsh_desktop_system_fix'), '');
  check('has dsh_desktop_system_env', names.includes('dsh_desktop_system_env'), '');
  check('has dsh_desktop_project_map_get', names.includes('dsh_desktop_project_map_get'), '');
  check('has dsh_desktop_project_map_status', names.includes('dsh_desktop_project_map_status'), '');
  check('has dsh_desktop_project_map_set', names.includes('dsh_desktop_project_map_set'), '');
  check('has dsh_desktop_edit_claim', names.includes('dsh_desktop_edit_claim'), '');
  check('has dsh_desktop_edit_release', names.includes('dsh_desktop_edit_release'), '');
  check('has dsh_desktop_edit_status', names.includes('dsh_desktop_edit_status'), '');
  check('has dsh_desktop_edit_journal', names.includes('dsh_desktop_edit_journal'), '');
  check('has dsh_desktop_git_status', names.includes('dsh_desktop_git_status'), '');
  check('has dsh_desktop_git_commit', names.includes('dsh_desktop_git_commit'), '');
  check('has dsh_desktop_git_checkout', names.includes('dsh_desktop_git_checkout'), '');
  check('has dsh_desktop_git_restore', names.includes('dsh_desktop_git_restore'), '');
  check('has dsh_desktop_git_init', names.includes('dsh_desktop_git_init'), '');
  check('has dsh_desktop_github_status', names.includes('dsh_desktop_github_status'), '');
  check('has dsh_desktop_github_login', names.includes('dsh_desktop_github_login'), '');
  check('has dsh_desktop_github_login_wait', names.includes('dsh_desktop_github_login_wait'), '');
  check('has dsh_desktop_github_remote_setup', names.includes('dsh_desktop_github_remote_setup'), '');
  check('has dsh_desktop_github_search_code', names.includes('dsh_desktop_github_search_code'), '');
  check('has dsh_desktop_git_push', names.includes('dsh_desktop_git_push'), '');
  check('has dsh_desktop_git_pull', names.includes('dsh_desktop_git_pull'), '');
  check('has dsh_desktop_git_merge', names.includes('dsh_desktop_git_merge'), '');
  check('has dsh_desktop_github_set_visibility', names.includes('dsh_desktop_github_set_visibility'), '');

  const doctor = await client.callTool({ name: 'dsh_desktop_system_doctor', arguments: {} });
  const doctorText = (doctor.content || []).map((c) => c.text || '').join('\n');
  check('system_doctor formats', doctorText.includes('长路径支持') && doctorText.includes('1/2'), doctorText.slice(0, 150));

  const fix = await client.callTool({ name: 'dsh_desktop_system_fix', arguments: { fix: { type: 'simple', id: 'utf8' } } });
  const fixText = (fix.content || []).map((c) => c.text || '').join('\n');
  check('system_fix works', fixText.includes('修复完成'), fixText);

  const env = await client.callTool({ name: 'dsh_desktop_system_env', arguments: { action: 'list' } });
  const envText = (env.content || []).map((c) => c.text || '').join('\n');
  check('system_env list formats', envText.includes('PATH') && envText.includes('共 2 项'), envText.slice(0, 150));

  const schedList = await client.callTool({ name: 'dsh_desktop_schedule', arguments: { action: 'list' } });
  const schedText = (schedList.content || []).map((c) => c.text || '').join('\n');
  check('schedule list formats', schedText.includes('早会提醒') && schedText.includes('每天 09:00'), schedText.slice(0, 150));

  const schedAdd = await client.callTool({ name: 'dsh_desktop_schedule', arguments: { action: 'add', task: { label: '测试', kind: 'reminder', mode: 'once', at: '10:30', task: '喝水' } } });
  const schedAddText = (schedAdd.content || []).map((c) => c.text || '').join('\n');
  check('schedule add', schedAddText.includes('测试'), schedAddText);

  const shot = await client.callTool({ name: 'dsh_desktop_computer_screenshot', arguments: {} });
  const shotText = (shot.content || []).map((c) => c.text || '').join('\n');
  check('computer_screenshot returns path + description', shotText.includes('screen-1.png') && shotText.includes('终端窗口'), shotText.slice(0, 120));
  check('computer_screenshot reports vision elapsed', shotText.includes('耗时 2s'), shotText.slice(0, 160));

  const screen = await client.callTool({ name: 'dsh_desktop_computer_screen', arguments: {} });
  const screenText = (screen.content || []).map((c) => c.text || '').join('\n');
  check('computer_screen formats resolution', screenText.includes('1920×1080'), screenText);

  const winList = await client.callTool({ name: 'dsh_desktop_computer_window', arguments: { action: 'list' } });
  const winText = (winList.content || []).map((c) => c.text || '').join('\n');
  check('computer_window list formats', winText.includes('记事本') && winText.includes('[123]'), winText.slice(0, 120));

  const clip = await client.callTool({ name: 'dsh_desktop_computer_clipboard', arguments: { action: 'get' } });
  const clipText = (clip.content || []).map((c) => c.text || '').join('\n');
  check('computer_clipboard get', clipText.includes('剪贴板内容'), clipText);

  const image = await client.callTool({ name: 'dsh_desktop_describe_image', arguments: { ref: 'sha256:' + 'a'.repeat(64) } });
  const imageText = (image.content || []).map((c) => c.text || '').join('\n');
  check('describe_image returns description', imageText.includes('截图'), imageText.slice(0, 80));
  check('describe_image reports vision elapsed', imageText.includes('耗时 2s'), imageText.slice(0, 140));

  const imageQ = await client.callTool({ name: 'dsh_desktop_describe_image', arguments: { path: 'C:\\x.png', question: '报错内容是什么？', region: { x: 0, y: 0, width: 100, height: 50 } } });
  const imageQText = (imageQ.content || []).map((c) => c.text || '').join('\n');
  check('describe_image accepts question + region', imageQText.includes('截图'), imageQText.slice(0, 80));

  // describe_image 走专用视觉超时（DSH_VISION_RPC_TIMEOUT_MS 可覆盖，默认 8 分钟）：
  // 本地视觉推理可达数分钟，120s 默认 RPC 超时会把识别掐断——这里验证超时链路确实独立生效。
  const slowClient = async (envExtra) => {
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, DSH_DESKTOP_RPC_URL: rpcUrl, DSH_DESKTOP_RPC_TOKEN: TOKEN, ...envExtra },
      stderr: 'pipe',
    });
    const c = new Client({ name: 'dsh-desktop-test-slow', version: '1.0.0' });
    await c.connect(t);
    return c;
  };
  describeImageDelay = 2500;
  {
    const c = await slowClient({ DSH_VISION_RPC_TIMEOUT_MS: '1000' });
    const r = await c.callTool({ name: 'dsh_desktop_describe_image', arguments: { path: 'C:\\x.png' } });
    const t = (r.content || []).map((x) => x.text || '').join('\n');
    check('describe_image honors vision timeout (too short => timeout error)', t.includes('超时'), t.slice(0, 100));
    await c.close();
  }
  {
    const c = await slowClient({ DSH_VISION_RPC_TIMEOUT_MS: '6000' });
    const r = await c.callTool({ name: 'dsh_desktop_describe_image', arguments: { path: 'C:\\x.png' } });
    const t = (r.content || []).map((x) => x.text || '').join('\n');
    check('describe_image succeeds when vision timeout is enough', t.includes('截图'), t.slice(0, 80));
    await c.close();
  }
  describeImageDelay = 0;

  const balance = await client.callTool({ name: 'dsh_desktop_api_balance', arguments: {} });
  const balanceText = (balance.content || []).map((c) => c.text || '').join('\n');
  check('api_balance formats balance', balanceText.includes('CNY') && balanceText.includes('12.34'), balanceText.slice(0, 120));

  const usage = await client.callTool({ name: 'dsh_desktop_api_usage', arguments: {} });
  const usageText = (usage.content || []).map((c) => c.text || '').join('\n');
  check('api_usage formats tokens', usageText.includes('1,000') && usageText.includes('$0.1234'), usageText.slice(0, 200));

  const state = await client.callTool({ name: 'dsh_desktop_get_state', arguments: {} });
  const text = (state.content || []).map((c) => c.text || '').join('\n');
  check('get_state returns rpc result', text.includes('0.1.0-rc.7'), text.slice(0, 120));

  const checkRes = await client.callTool({ name: 'dsh_desktop_check_updates', arguments: { checkPrereleases: true } });
  const checkText = (checkRes.content || []).map((c) => c.text || '').join('\n');
  check('check_updates passes params through', checkText.includes('0.1.0-rc.7'), checkText.slice(0, 120));

  const folder = await client.callTool({ name: 'dsh_desktop_open_folder', arguments: { path: 'C:\\test' } });
  const folderText = (folder.content || []).map((c) => c.text || '').join('\n');
  check('open_folder echoes path', folderText.includes('C:\\test'), folderText.slice(0, 120));

  const pmGet = await client.callTool({ name: 'dsh_desktop_project_map_get', arguments: {} });
  const pmGetText = (pmGet.content || []).map((c) => c.text || '').join('\n');
  check('project_map_get formats map + stale', pmGetText.includes('地图') && pmGetText.includes('src/a.js'), pmGetText.slice(0, 150));

  const pmSet = await client.callTool({ name: 'dsh_desktop_project_map_set', arguments: { map: '# 新地图' } });
  const pmSetText = (pmSet.content || []).map((c) => c.text || '').join('\n');
  check('project_map_set reports stats', pmSetText.includes('5') && pmSetText.includes('1'), pmSetText.slice(0, 120));

  const claim = await client.callTool({ name: 'dsh_desktop_edit_claim', arguments: { files: ['src/a.js'] } });
  const claimText = (claim.content || []).map((c) => c.text || '').join('\n');
  check('edit_claim reports conflicts', claimText.includes('冲突') && claimText.includes('src/b.js'), claimText.slice(0, 150));

  const ecStatus = await client.callTool({ name: 'dsh_desktop_edit_status', arguments: {} });
  const ecText = (ecStatus.content || []).map((c) => c.text || '').join('\n');
  check('edit_status lists mine + others', ecText.includes('src/a.js') && ecText.includes('其他会话占用'), ecText.slice(0, 150));

  const gitSt = await client.callTool({ name: 'dsh_desktop_git_status', arguments: {} });
  const gitStText = (gitSt.content || []).map((c) => c.text || '').join('\n');
  check('git_status formats porcelain', gitStText.includes('main'), gitStText.slice(0, 120));

  const gitCm = await client.callTool({ name: 'dsh_desktop_git_commit', arguments: { message: '修复 bug' } });
  const gitCmText = (gitCm.content || []).map((c) => c.text || '').join('\n');
  check('git_commit passes message', gitCmText.includes('abc123'), gitCmText.slice(0, 120));

  const ghStatus = await client.callTool({ name: 'dsh_desktop_github_status', arguments: {} });
  const ghText = (ghStatus.content || []).map((c) => c.text || '').join('\n');
  check('github_status formats login + branch + remote', ghText.includes('octocat') && ghText.includes('main') && ghText.includes('github.com'), ghText.slice(0, 150));

  const ghPush = await client.callTool({ name: 'dsh_desktop_git_push', arguments: {} });
  const ghPushText = (ghPush.content || []).map((c) => c.text || '').join('\n');
  check('git_push formats output', ghPushText.includes('pushed main'), ghPushText.slice(0, 100));

  await client.close();
} catch (err) {
  check('mcp client session', false, (err && err.message) || String(err));
} finally {
  await new Promise((resolve) => { rpc.close(() => resolve()); });
  if (childHandle) { try { childHandle.kill(); } catch {} }
}

if (failures.length) { console.log('MCP-E2E FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('MCP-E2E OK');
