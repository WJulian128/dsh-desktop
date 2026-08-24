// 修复 settings.json：用 Node 读写（UTF-8 无 BOM），重建 mcpServers 等字段。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'settings.json');

// 从磁盘读取现有值；JSON 已损坏时回退到已知安全默认。
let data = null;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
} catch { data = {}; }
if (!data || typeof data !== 'object') data = {};

const next = {
  workspace: typeof data.workspace === 'string' && data.workspace ? data.workspace : 'C:\\Users\\user\\Desktop\\DeepseekHarness',
  autoUpdate: data.autoUpdate !== false,
  silentAutoUpdate: data.silentAutoUpdate === true,
  checkPrereleases: data.checkPrereleases === true,
  showUpdateBadge: data.showUpdateBadge !== false,
  serverPort: typeof data.serverPort === 'number' && data.serverPort > 0 ? data.serverPort : null,
  enableDesktopMcp: data.enableDesktopMcp !== false,
  mcpServers: [
    { serverName: 'fetch', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'], enabled: true, remark: '网页抓取：让 harness 自己读文档/API 页面' },
    { serverName: 'memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], enabled: true, remark: '项目长期记忆：知识图谱存于工作区 memory.json' },
    { serverName: 'sequential-thinking', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], enabled: true, remark: '复杂问题分步推理' },
    { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '请替换为你的 GitHub PAT' }, enabled: false, remark: 'GitHub 仓库操作：填入 GITHUB_TOKEN 后启用' },
  ],
  permissionMode: ['read-only', 'workspace-write', 'danger-full-access'].includes(data.permissionMode) ? data.permissionMode : 'workspace-write',
  notifyOnComplete: data.notifyOnComplete !== false,
  recentWorkspaces: Array.isArray(data.recentWorkspaces) ? data.recentWorkspaces : [],
  vision: data.vision && typeof data.vision === 'object' ? data.vision : null,
  usagePrices: data.usagePrices && typeof data.usagePrices === 'object' ? data.usagePrices : null,
};

fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');

// 验证
const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
const bytes = fs.readFileSync(file);
console.log('settings.json fixed: mcpServers=' + parsed.mcpServers.length + ', noBOM=' + (bytes[0] !== 0xef) + ', serverPort=' + parsed.serverPort);
console.log(parsed.mcpServers.map((s) => '- ' + s.serverName + (s.enabled ? ' (enabled)' : ' (disabled)')).join('\n'));
