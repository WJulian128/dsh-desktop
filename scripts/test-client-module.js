// 纯 Node 客户端模块单测：不依赖浏览器，直接加载 @dsh-desktop/settings-update 的
// client.js bundle，验证：
//  1. bundle 是合法的 __ModuleLoader__.load 格式（id 正确）
//  2. apply(ctx) 向 settings.section 注册了 7 个分区（三合一合并后）：
//     desktop / mcp / memory / schedule / system / backup / usage
//     （vision / desktop-plugins / subagents 不再作为独立分区）
//  3. 分区组件可用 React SSR 渲染，包含关键内容（含并入的卡组：多模态→桌面端、
//     插件→插件与 MCP、子代理→记忆与子代理）
//  4. shell.overlay 注册状态胶囊 + 环境信息抽屉；输入框常驻截图/附件按钮；
//     会话页头"环境信息"按钮
// 用法：node scripts\test-client-module.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'node_modules', '@dsh-desktop', 'settings-update', 'client.js');
const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 1. 加载 bundle（捕获 __ModuleLoader__.load 调用）
const code = fs.readFileSync(BUNDLE, 'utf8');
let captured = null;
global.window = {
  __ModuleLoader__: { load: (rec) => { captured = rec; } },
};
eval(code);
check('bundle calls __ModuleLoader__.load', !!captured, captured ? captured.id : 'no load call');
check('bundle id correct', !!captured && captured.id === '@dsh-desktop/settings-update', captured && captured.id);

// 2. 用 fake require 执行 factory，得到模块导出
const React = require('react');
const fakeRequire = (name) => {
  if (name === 'react') return React;
  if (name === '@deepseek-ai/dsh-client-ui-slots') {
    return { resolveSlotLabel: (label) => (typeof label === 'function' ? label() : label) };
  }
  throw new Error('unexpected require: ' + name);
};
const mod = captured.factory(fakeRequire);
check('factory exports apply', typeof mod.apply === 'function', '');
check('factory exports inject', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject));

// 3. 执行 apply(ctx)，捕获 slots.inject 注册
const registrations = [];
const ctx = {
  get: () => undefined,
  slots: {
    register: (options, component) => ({ options, component }),
    inject: (name, factory) => { registrations.push({ slot: name, registration: factory() }); },
  },
};
mod.apply(ctx);
const sections = registrations.filter((r) => r.slot === 'settings.section').map((r) => r.registration);
const overlays = registrations.filter((r) => r.slot === 'shell.overlay').map((r) => r.registration);
const composerDock = registrations.filter((r) => r.slot === 'conversation.composer.dock').map((r) => r.registration);
const inputLeft = registrations.filter((r) => r.slot === 'conversation.input.left').map((r) => r.registration);
const headerActions = registrations.filter((r) => r.slot === 'conversation.session.header.actions').map((r) => r.registration);
check('registers 8 settings.section entries', sections.length === 8, 'count=' + sections.length);
check('no shell.overlay occupants (panels live in composer dock)', overlays.length === 0, 'count=' + overlays.length);
check('status pill + right panels (env+sched always-on) in composer.dock',
  composerDock.length === 2 &&
  composerDock.some((o) => o.options && o.options.id === 'desktop-status-pill') &&
  composerDock.some((o) => o.options && o.options.id === 'desktop-right-panels'),
  'count=' + composerDock.length);
check('registers composer screenshot + attach + interject buttons',
  inputLeft.length === 3 &&
  inputLeft.some((o) => o.options && o.options.id === 'desktop-screenshot') &&
  inputLeft.some((o) => o.options && o.options.id === 'desktop-attach') &&
  inputLeft.some((o) => o.options && o.options.id === 'desktop-interject'),
  'count=' + inputLeft.length);
check('no header toggle buttons (panels always-on, toggles removed)',
  headerActions.length === 0,
  'count=' + headerActions.length);

const byId = {};
for (const reg of sections) {
  const options = reg.options;
  check('section ' + options.id + ' has id + order + label',
    !!options && typeof options.id === 'string' && typeof options.order === 'number' && typeof options.label === 'function',
    JSON.stringify({ id: options.id, order: options.order }));
  byId[options.id] = reg;
}
for (const id of ['desktop', 'mcp', 'memory', 'schedule', 'system', 'backup', 'usage', 'providers']) {
  check('has ' + id + ' section', !!byId[id], '');
  if (byId[id]) {
    check('section ' + id + ' label non-empty', typeof byId[id].options.label() === 'string' && byId[id].options.label().length > 0, byId[id].options.label());
  }
}
// 三合一合并：vision / desktop-plugins / subagents 不再作为独立分区
for (const id of ['vision', 'desktop-plugins', 'subagents']) {
  check('no standalone ' + id + ' section', !byId[id], '');
}

// 4. SSR 渲染分区（stub window.dshDesktop）
const sampleState = {
  phase: 'ready', installed: '0.1.0-rc.6', latest: '0.1.0-rc.6', updateAvailable: false,
  workspace: 'C:\\ws', dshHome: 'C:\\Users\\x\\.dsh', url: 'http://127.0.0.1:1234',
  checking: false, updating: false,
  quietHoursEnabled: false, quietHoursStart: '23:00', quietHoursEnd: '07:00',
  port: '1234',
};
global.window.dshDesktop = {
  getState: () => Promise.resolve(sampleState),
  onState: () => () => {},
  checkForUpdates: () => {}, applyUpdate: () => {}, openLogs: () => {},
  chooseWorkspace: () => {}, restartApp: () => {},
  listMcpServers: () => Promise.resolve({ servers: [], enableDesktopMcp: true }),
  saveMcpServer: () => Promise.resolve({ ok: true, servers: [] }),
  removeMcpServer: () => Promise.resolve({ ok: true, servers: [] }),
  toggleMcpServer: () => Promise.resolve({ ok: true, servers: [] }),
  setBuiltinMcp: () => Promise.resolve({ ok: true, enableDesktopMcp: true }),
  applyMcp: () => Promise.resolve({ ok: true }),
  getDesktopPlugins: () => Promise.resolve({ ok: true, enableDesktopMcp: true, mcpServers: 0, settingsUi: true }),
  installPlugin: () => Promise.resolve({ ok: true }),
  removePlugin: () => Promise.resolve({ ok: true }),
  cancelPlugin: () => Promise.resolve({ ok: true }),
  onPluginOutput: () => () => {},
  getVision: () => Promise.resolve({ ok: true, vision: { enabled: false, baseUrl: '', model: '' }, hasKey: false }),
  saveVision: () => Promise.resolve({ ok: true }),
  testVision: () => Promise.resolve({ ok: true, sample: 'ok' }),
  getUsage: () => Promise.resolve({ ok: true, summary: { total: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 30, reasoningTokens: 10 }, estimatedCostUsd: '0.01', sessions: [] } }),
  getBalance: () => Promise.resolve({ ok: true }),
  setPermissionMode: () => Promise.resolve({ ok: true }),
  setNotifyOnComplete: () => Promise.resolve({ ok: true }),
  setQuietHours: () => Promise.resolve({ ok: true, enabled: false, start: '23:00', end: '07:00' }),
  openAgentsFile: () => Promise.resolve({ ok: true }),
  gitSummary: () => Promise.resolve({ ok: true, workspace: 'C:\\ws', output: '# git status\n## main...origin/main [ahead 1, behind 2]\n M file.txt\n?? new.txt\n\n# git diff --stat\n file.txt | 2 +-\n1 file changed\n\n# git diff\n（无未暂存改动）' }),
  openGitDiffWindow: () => Promise.resolve({ ok: true }),
  subagentsList: () => Promise.resolve({ ok: true, items: [
    { sessionId: 'x1', parentSession: 'sess-1', label: '测试子代理', status: 'running', provider: 'spawn', agentModel: 'deepseek-v4-flash', durationMs: 65000 },
    { sessionId: 'x2', parentSession: 'sess-1', label: '旧任务', status: 'done', provider: 'spawn', agentModel: 'mimo-v2.5', durationMs: 1000 },
    { sessionId: 'x3', parentSession: 'other-sess', label: '别的会话', status: 'running', provider: 'spawn', agentModel: 'm', durationMs: 500 },
  ], summary: { running: 2, done: 1, stopped: 0, totalTokens: 0 } }),
};

const { renderToString } = require('react-dom/server');
const render = (component, props) => renderToString(React.createElement(component, props || {}));

try {
  const desktopHtml = render(byId.desktop.component, { close: () => {} });
  check('desktop section renders', true, '');
  for (const text of ['桌面端', '当前版本', '更新状态', '检查更新', '权限与沙箱模式', '任务完成通知', 'AGENTS.md', 'Git 变更', '截图与附件', '快速截图', '附加文件', '上下文接续', '新对话接续任务', '通知免打扰', '免打扰开关', '保存免打扰设置']) {
    check('desktop html contains ' + text, desktopHtml.includes(text), '');
  }
  // 三合一：多模态卡组并入桌面端
  for (const text of ['多模态（图片识别）', '本地视觉模型', '一键集成', '安装 Ollama', '启用图片识别', '服务商', 'OpenAI', 'mcp__dsh_desktop__describe_image']) {
    check('desktop html contains vision block ' + text, desktopHtml.includes(text), '');
  }

  const mcpHtml = render(byId.mcp.component, { close: () => {} });
  check('mcp section renders', true, '');
  for (const text of ['插件与 MCP', 'MCP 服务器', '内置 dsh_desktop', '添加服务器', '应用更改并重启服务', 'mcp__dsh_desktop__*']) {
    check('mcp html contains ' + text, mcpHtml.includes(text), '');
  }
  // 三合一：插件卡组并入 mcp（页内先插件卡组再 MCP 卡组）
  for (const text of ['桌面端扩展', '安装', '卸载', '已加载插件']) {
    check('mcp html contains plugins block ' + text, mcpHtml.includes(text), '');
  }

  const usageHtml = render(byId.usage.component, { close: () => {} });
  check('usage section renders', true, '');
  // SSR 单次渲染不执行 useEffect，用量数据为 null；“估算成本”行在点击统计后出现。
  for (const text of ['用量与账单', '查询 API 余额', '统计本工作区用量', 'usagePrices']) {
    check('usage html contains ' + text, usageHtml.includes(text), '');
  }

  const pillHtml = render(composerDock.find((o) => o.options.id === 'desktop-status-pill').component, {});
  check('status pill renders', true, '');
  // 状态行：位于输入框下方（非悬浮、不遮挡）；动作 chip 已移除；
  // SSR 下 useEffect 不执行（state=null），版本 chip 需运行时数据，这里只断言静态内容。
  check('pill shows permission mode (compact)', pillHtml.includes('可写'), pillHtml.slice(0, 160));
  check('pill is non-floating inline row', !/position\s*:\s*fixed/.test(pillHtml) && !/bottom:12px/.test(pillHtml), pillHtml.slice(0, 120));
  check('pill always shows update check mark', pillHtml.includes('\u2713'), pillHtml.slice(0, 200));
  check('pill always shows mcp count', pillHtml.includes('MCP 0'), pillHtml.slice(0, 200));
  check('pill no longer has action chips (continue lives inside pill row)', !pillHtml.includes('截图') && !pillHtml.includes('附件') && !pillHtml.includes('设置'), '');
  check('pill no longer shows default model (official selector shows it)', !pillHtml.includes('默认模型'), '');

  const memoryHtml = render(byId.memory.component, { close: () => {} });
  check('memory section renders', true, '');
  for (const text of ['记忆与子代理', '自动记忆', '知识图谱', '实体名称', '直接写入图谱']) {
    check('memory html contains ' + text, memoryHtml.includes(text), '');
  }
  // 三合一：子代理卡组并入 memory
  for (const text of ['子代理（进度总览）', '运行中', '已完成', '子代理列表']) {
    check('memory html contains subagents block ' + text, memoryHtml.includes(text), '');
  }

  const scheduleHtml = render(byId.schedule.component, { close: () => {} });
  check('schedule section renders', true, '');
  for (const text of ['定时任务', '派发任务', '每天', '添加任务']) {
    check('schedule html contains ' + text, scheduleHtml.includes(text), '');
  }

  const systemHtml = render(byId.system.component, { close: () => {} });
  check('system section renders', true, '');
  for (const text of ['系统环境', '环境体检', '用户环境变量', '一键安装开发工具', '右键菜单集成', '交给 DSH 处理']) {
    check('system html contains ' + text, systemHtml.includes(text), '');
  }

  const backupHtml = render(byId.backup.component, { close: () => {} });
  check('backup section renders', true, '');
  for (const text of ['备份与迁移', '导出（不含密钥）', '导出（含 API 密钥）', '选择备份文件并导入…', '新电脑']) {
    check('backup html contains ' + text, backupHtml.includes(text), '');
  }

  const shotHtml = render(inputLeft.find((o) => o.options.id === 'desktop-screenshot').component, {});
  check('screenshot button renders with aria-label', shotHtml.includes('快速截图'), shotHtml.slice(0, 200));

  const attachHtml = render(inputLeft.find((o) => o.options.id === 'desktop-attach').component, {});
  check('attach button renders with aria-label', attachHtml.includes('附加文件到对话'), attachHtml.slice(0, 200));

  // 右侧常驻双面板（环境信息 + 模型调度左右并排，无开关按钮，始终同步展示）
  // 官方渲染器注入的是 props.sessionId（字符串），不是 props.session 对象。
  const rightPanelsHtml = render(composerDock.find((o) => o.options.id === 'desktop-right-panels').component, { sessionId: 'sess-1' });
  check('right panels render env + sched titles', rightPanelsHtml.includes('环境信息') && rightPanelsHtml.includes('模型调度'), '');
  check('right panels are resident right column (520px, two side-by-side)', /right:0/.test(rightPanelsHtml) && /width:520px/.test(rightPanelsHtml), rightPanelsHtml.slice(0, 160));
  for (const text of ['会话', '工作区', 'harness', '端口', 'Git', '厂商总览']) {
    check('right panels html contains ' + text, rightPanelsHtml.includes(text), '');
  }
  check('env panel no longer shows subagent section (sched panel owns it)', !rightPanelsHtml.includes('子代理（本会话）'), '');
  check('right panels have no collapse buttons', !rightPanelsHtml.includes('收起'), '');

  // 子代理运行期提示（会话视为进行中；消息由官方队列处理，桌面端仅提示）
  const busyStore = mod._subagentBusy;
  check('subagent busy store exported', !!busyStore && typeof busyStore === 'object', '');
  const dockRegs = registrations.filter((r) => r.slot === 'conversation.input.dock').map((r) => r.registration);
  check('queue bar registered in input.dock', dockRegs.some((o) => o.options && o.options.id === 'desktop-subagent-queue'), '');
  const queueBar = dockRegs.find((o) => o.options && o.options.id === 'desktop-subagent-queue');
  check('queue bar renders null when idle', render(queueBar.component, {}) === '', '');
  busyStore.running = 1;
  const queueBarActive = render(queueBar.component, {});
  check('queue bar renders when subagents running', queueBarActive.includes('个子代理运行中') && queueBarActive.includes('对话队列'), queueBarActive.slice(0, 160));
  busyStore.running = 0;
} catch (err) {
  check('sections render without throwing', false, (err && err.message) || String(err));
}

if (failures.length) { console.log('CLIENT-MODULE FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('CLIENT-MODULE OK');
