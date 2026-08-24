// 备份与迁移单测（纯 Node，不依赖 Electron）：
//  1. collectBackupFiles 收集 settings/skills/AGENTS.md/记忆/凭据（可选）到 staging
//  2. exportBackup 产出合法 zip（manifest.json 存在）
//  3. importBackup 合并设置（保留本机 workspace/端口）、恢复文件、备份现有 settings
// 用法：node scripts\test-backup.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectBackupFiles, exportBackup, importBackup } = require('../main/backup');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 1. 构造临时环境（假 dshHome / 工作区 / 设置 / 安装目录）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-test-'));
const dshHome = path.join(root, 'home');
const workspace = path.join(root, 'ws');
const installDir = path.join(root, 'install');
const settingsFile = path.join(root, 'appdata', 'settings.json');
const appDir = path.join(root, 'app');

const mk = (dir) => fs.mkdirSync(dir, { recursive: true });
mk(dshHome); mk(workspace); mk(installDir); mk(path.dirname(settingsFile)); mk(appDir);

fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-desktop', version: '9.9.9' }) + '\n', 'utf8');
fs.writeFileSync(settingsFile, JSON.stringify({
  workspace: 'C:\\old-ws', serverPort: 4321, recentWorkspaces: ['C:\\a', 'C:\\b'],
  mcpServers: [{ serverName: 'fetch', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-fetch'], enabled: true }],
  vision: { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen2.5vl:7b' },
  permissionMode: 'workspace-write',
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(dshHome, 'AGENTS.md'), '# 全局指南\n中文内容 ✓\n', 'utf8');
fs.writeFileSync(path.join(dshHome, 'settings.yaml'), 'agent-default-model: { model: deepseek-chat }\n', 'utf8');
fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-test-secret\n', 'utf8');
mk(path.join(dshHome, 'profiles', 'web'));
fs.writeFileSync(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), '- insert: []\n', 'utf8');
mk(path.join(dshHome, 'skills', 'windows-ops'));
fs.writeFileSync(path.join(dshHome, 'skills', 'windows-ops', 'SKILL.md'), '---\nname: windows-ops\n---\n内容\n', 'utf8');
mk(path.join(dshHome, '.agent-presets', 'preset-a'));
fs.writeFileSync(path.join(dshHome, '.agent-presets', 'preset-a', 'cordis.yml'), 'rows: []\n', 'utf8');
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# 项目指南\n', 'utf8');
fs.writeFileSync(path.join(workspace, 'memory.json'), JSON.stringify({ entities: [{ name: 'x' }], relations: [] }), 'utf8');
// 新记忆位置：DSH_HOME/memory/memory.jsonl（server-memory 兼容 JSONL）
mk(path.join(dshHome, 'memory'));
fs.writeFileSync(path.join(dshHome, 'memory', 'memory.jsonl'),
  '{"type":"entity","name":"dsh-desktop","entityType":"project","observations":["用 electron-builder 打包"]}\n' +
  '{"type":"relation","from":"dsh-desktop","to":"electron-builder","relationType":"builds-with"}\n', 'utf8');
// 会话目录（includeSessions 时备份）
mk(path.join(dshHome, 'sessions', '--C-Users-user-Desktop-Test--', 'session-abc'));
fs.writeFileSync(path.join(dshHome, 'sessions', '--C-Users-user-Desktop-Test--', 'session-abc', 'session.jsonl.zstd'), '\x28\xb5\x2f\xfd dummy', 'utf8');
mk(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh'));
fs.writeFileSync(path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: '0.1.0-rc.6' }), 'utf8');

const opts = { settingsFile, dshHome, workspace, installDir, appDir, includeCredentials: false };

// 2. collectBackupFiles
const staging = path.join(root, 'staging');
mk(staging);
collectBackupFiles(staging, opts);
const expectFile = (rel) => fs.existsSync(path.join(staging, rel));
check('collects settings.json', expectFile('settings.json'), '');
check('collects AGENTS.md (global)', expectFile('dsh-home/AGENTS.md'), '');
check('collects settings.yaml', expectFile('dsh-home/settings.yaml'), '');
check('collects workspace AGENTS.md', expectFile('workspace/AGENTS.md'), '');
check('collects memory.json', expectFile('workspace/memory.json'), '');
check('collects memory.jsonl (new location)', expectFile('dsh-home/memory/memory.jsonl'), '');
check('excludes sessions by default', !fs.existsSync(path.join(staging, 'dsh-home/sessions')), '');
check('collects profile patch', expectFile('dsh-home/profiles/web/cordis.patch.yml'), '');
check('collects skills', expectFile('dsh-home/skills/windows-ops/SKILL.md'), '');
check('collects agent presets', expectFile('dsh-home/.agent-presets/preset-a/cordis.yml'), '');
check('collects dsh version manifest', expectFile('manifest/dsh-package.json'), '');
check('excludes credentials when not requested', !expectFile('dsh-home/.credentials.yaml'), '');
check('writes manifest.json', expectFile('manifest.json'), '');
const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
check('manifest has appVersion + flags', manifest.appVersion === '9.9.9' && manifest.includeCredentials === false, JSON.stringify(manifest));

// 含凭据导出
const stagingCred = path.join(root, 'staging-cred');
mk(stagingCred);
collectBackupFiles(stagingCred, { ...opts, includeCredentials: true });
check('includes credentials when requested', fs.existsSync(path.join(stagingCred, 'dsh-home/.credentials.yaml')), '');

// 含会话历史导出
const stagingSess = path.join(root, 'staging-sess');
mk(stagingSess);
collectBackupFiles(stagingSess, { ...opts, includeSessions: true });
check('includes sessions when requested', fs.existsSync(path.join(stagingSess, 'dsh-home/sessions', '--C-Users-user-Desktop-Test--', 'session-abc', 'session.jsonl.zstd')), '');
check('includes memory.jsonl with sessions', fs.existsSync(path.join(stagingSess, 'dsh-home/memory/memory.jsonl')), '');

// 3. exportBackup → zip
const zip = exportBackup(opts);
check('export produces zip', fs.existsSync(zip) && zip.endsWith('.zip'), zip);
const zipSize = fs.statSync(zip).size;
check('zip non-trivial size', zipSize > 500, zipSize + ' bytes');

// 4. importBackup 到一台“新电脑”（新的 dshHome/workspace，现有 settings 带本机信息）
const newRoot = path.join(root, 'new-machine');
const newHome = path.join(newRoot, 'home');
const newWs = path.join(newRoot, 'ws');
const newSettings = path.join(newRoot, 'settings.json');
mk(newHome); mk(newWs);
fs.writeFileSync(newSettings, JSON.stringify({ workspace: 'C:\\new-ws', serverPort: 7777, recentWorkspaces: ['C:\\new-ws'], notifyOnComplete: false }, null, 2) + '\n', 'utf8');

importBackup(zip, { settingsFile: newSettings, dshHome: newHome, workspace: newWs });
const merged = JSON.parse(fs.readFileSync(newSettings, 'utf8').replace(/^\uFEFF/, ''));
check('import keeps local workspace', merged.workspace === 'C:\\new-ws', merged.workspace);
check('import keeps local port', merged.serverPort === 7777, String(merged.serverPort));
check('import keeps local recentWorkspaces', JSON.stringify(merged.recentWorkspaces) === JSON.stringify(['C:\\new-ws']), JSON.stringify(merged.recentWorkspaces));
check('import keeps local extra keys', merged.notifyOnComplete === false, '');
check('import merges mcpServers', Array.isArray(merged.mcpServers) && merged.mcpServers.length === 1 && merged.mcpServers[0].serverName === 'fetch', JSON.stringify(merged.mcpServers));
check('import merges vision', !!(merged.vision && merged.vision.model === 'qwen2.5vl:7b'), JSON.stringify(merged.vision));
check('import merges permissionMode', merged.permissionMode === 'workspace-write', merged.permissionMode);
check('import restores global AGENTS.md', fs.readFileSync(path.join(newHome, 'AGENTS.md'), 'utf8').includes('中文内容 ✓'), '');
check('import restores skills', fs.existsSync(path.join(newHome, 'skills', 'windows-ops', 'SKILL.md')), '');
check('import restores agent presets', fs.existsSync(path.join(newHome, '.agent-presets', 'preset-a', 'cordis.yml')), '');
check('import restores workspace AGENTS.md', fs.existsSync(path.join(newWs, 'AGENTS.md')), '');
check('import restores memory.json', JSON.parse(fs.readFileSync(path.join(newWs, 'memory.json'), 'utf8')).entities.length === 1, '');
const preImports = fs.readdirSync(newRoot).filter((f) => f.startsWith('settings.json.pre-import-'));
check('import backs up existing settings', preImports.length === 1, preImports.join(','));

// 5. 非备份 zip 拒绝导入
const badZip = path.join(root, 'bad.zip');
const { execFileSync } = require('node:child_process');
execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Compress-Archive -LiteralPath ' + JSON.stringify(path.join(root, 'app', 'package.json')) + ' -DestinationPath ' + JSON.stringify(badZip) + ' -Force'], { windowsHide: true });
let rejected = false;
try { importBackup(badZip, { settingsFile: newSettings, dshHome: newHome, workspace: newWs }); } catch (err) { rejected = /manifest\.json/.test(String(err.message)); }
check('import rejects non-backup zip', rejected, '');

// 6. 含会话的 zip 导入恢复（新机器上 memory 合并 + sessions 恢复）
const sessZip = exportBackup({ ...opts, includeSessions: true });
const newRoot2 = path.join(root, 'new-machine-2');
const newHome2 = path.join(newRoot2, 'home');
const newWs2 = path.join(newRoot2, 'ws');
mk(newHome2); mk(newWs2);
importBackup(sessZip, { settingsFile: path.join(newRoot2, 'settings.json'), dshHome: newHome2, workspace: newWs2 });
const restored = fs.readFileSync(path.join(newHome2, 'memory', 'memory.jsonl'), 'utf8');
check('import restores memory.jsonl', restored.includes('"name":"dsh-desktop"') && restored.includes('builds-with'), '');
check('import restores sessions', fs.existsSync(path.join(newHome2, 'sessions', '--C-Users-user-Desktop-Test--', 'session-abc', 'session.jsonl.zstd')), '');

// 清理
fs.rmSync(root, { recursive: true, force: true });

if (failures.length) { console.log('BACKUP FAIL: ' + failures.join(', ')); process.exit(1); }
console.log('BACKUP OK');
