// 在 settings.json 的 mcpServers 中追加 git 服务器（保持 UTF-8 无 BOM）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'settings.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const servers = Array.isArray(data.mcpServers) ? data.mcpServers : [];
if (!servers.some((s) => s && s.serverName === 'git')) {
  servers.push({
    serverName: 'git',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git'],
    enabled: true,
    remark: 'Git 仓库只读操作（status/diff/log/show），长代码任务看改动',
  });
  data.mcpServers = servers;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('git MCP added');
} else {
  console.log('git MCP already present');
}
const check = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('mcpServers:', check.mcpServers.map((s) => s.serverName + (s.enabled ? '' : ' (disabled)')).join(', '));
