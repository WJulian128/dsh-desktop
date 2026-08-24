'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

/**
 * 备份与迁移：把用户打磨好的 harness（设置、skills、AGENTS.md、记忆、MCP/视觉配置）
 * 打包成一个 zip，在新电脑上导入恢复。纯 Node 逻辑，不依赖 Electron，可单测。
 */

function ps(args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', ...args], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
}

/**
 * 把备份文件收集到 staging 目录。
 * @param {string} staging 暂存目录（调用方保证为空/已创建）
 * @param {object} opts
 * @param {string} opts.settingsFile 桌面端 settings.json 路径
 * @param {string} opts.dshHome DSH_HOME
 * @param {string} opts.workspace 工作区
 * @param {string} opts.installDir harness 安装目录（appDir 或打包更新目录）
 * @param {string} opts.appDir 桌面端应用目录
 * @param {boolean} opts.includeCredentials 是否包含 API 密钥
 * @param {boolean} [opts.includeSessions=false] 是否包含会话历史与记忆图谱
 */
function collectBackupFiles(staging, { settingsFile, dshHome, workspace, installDir, appDir, includeCredentials, includeSessions }) {
  const put = (src, rel) => {
    if (!src || !fs.existsSync(src)) return;
    const dest = path.join(staging, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  };
  put(settingsFile, 'settings.json');
  put(path.join(dshHome, 'AGENTS.md'), 'dsh-home/AGENTS.md');
  if (includeCredentials) put(path.join(dshHome, '.credentials.yaml'), 'dsh-home/.credentials.yaml');
  put(path.join(dshHome, 'settings.yaml'), 'dsh-home/settings.yaml');
  put(path.join(workspace, 'AGENTS.md'), 'workspace/AGENTS.md');
  put(path.join(workspace, 'memory.json'), 'workspace/memory.json'); // 兼容旧版备份
  put(path.join(dshHome, 'memory', 'memory.jsonl'), 'dsh-home/memory/memory.jsonl');
  put(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'dsh-home/profiles/web/cordis.patch.yml');
  const skillsDir = path.join(dshHome, 'skills');
  if (fs.existsSync(skillsDir)) {
    fs.cpSync(skillsDir, path.join(staging, 'dsh-home/skills'), { recursive: true });
  }
  const presetsDir = path.join(dshHome, '.agent-presets');
  if (fs.existsSync(presetsDir)) {
    fs.cpSync(presetsDir, path.join(staging, 'dsh-home/.agent-presets'), { recursive: true });
  }
  if (includeSessions) {
    const sessionsDir = path.join(dshHome, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      // 会话目录可能很大，直接整目录复制（zstd 已压缩，不再二次压缩）。
      fs.cpSync(sessionsDir, path.join(staging, 'dsh-home/sessions'), { recursive: true });
    }
  }
  const dshPkg = path.join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (fs.existsSync(dshPkg)) put(dshPkg, 'manifest/dsh-package.json');
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
    exportedAt: new Date().toISOString(),
    appVersion: (() => {
      try { return JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
    })(),
    includeCredentials: !!includeCredentials,
    includeSessions: !!includeSessions,
  }, null, 2) + '\n', 'utf8');
}

/** 压缩 staging 到 zip（PowerShell Compress-Archive，Windows 自带）。 */
function compressStaging(staging, out) {
  // 注意：必须用 -Path 而非 -LiteralPath —— LiteralPath 不展开 `*`，会静默产出空 zip。
  const result = ps(['Compress-Archive -Path ' + JSON.stringify(path.join(staging, '*')) + ' -DestinationPath ' + JSON.stringify(out) + ' -Force']);
  if (!fs.existsSync(out)) {
    throw new Error('压缩备份失败：' + String(result && result.stderr || '').slice(0, 200));
  }
}

/** 解压 zip 到 staging（返回 staging 目录）。 */
function extractZip(zip, staging) {
  const result = ps(['Expand-Archive -LiteralPath ' + JSON.stringify(zip) + ' -DestinationPath ' + JSON.stringify(staging) + ' -Force']);
  if (!fs.existsSync(path.join(staging, 'manifest.json'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error('备份文件缺少 manifest.json，可能不是 DSH 备份' + (result && result.stderr ? '（' + String(result.stderr).slice(0, 200) + '）' : ''));
  }
}

/**
 * 导出备份 zip。
 * @param {object} opts
 * @param {string} opts.settingsFile
 * @param {string} opts.dshHome
 * @param {string} opts.workspace
 * @param {string} opts.installDir
 * @param {string} opts.appDir
 * @param {boolean} opts.includeCredentials
 * @param {boolean} [opts.includeSessions=false] 是否包含会话历史与记忆图谱
 * @returns {string} zip 路径（下载目录 dsh-harness-backup-<日期>.zip）
 */
function exportBackup({ settingsFile, dshHome, workspace, installDir, appDir, includeCredentials, includeSessions }) {
  const staging = path.join(os.tmpdir(), 'dsh-backup-' + Date.now());
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    collectBackupFiles(staging, { settingsFile, dshHome, workspace, installDir, appDir, includeCredentials, includeSessions });
    const out = path.join(os.homedir(), 'Downloads', 'dsh-harness-backup-' + new Date().toISOString().slice(0, 10) + '.zip');
    fs.rmSync(out, { force: true });
    compressStaging(staging, out);
    return out;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * 导入备份 zip：合并设置（保留本机 workspace/端口/最近工作区），覆盖 skills/AGENTS.md/
 * 记忆/profile 补丁。导入前自动备份现有 settings.json。
 */
function importBackup(zip, { settingsFile, dshHome, workspace }) {
  const staging = path.join(os.tmpdir(), 'dsh-backup-import-' + Date.now());
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    extractZip(zip, staging);
    if (fs.existsSync(settingsFile)) {
      fs.copyFileSync(settingsFile, settingsFile + '.pre-import-' + Date.now());
    }
    const incomingPath = path.join(staging, 'settings.json');
    if (fs.existsSync(incomingPath)) {
      const incoming = JSON.parse(fs.readFileSync(incomingPath, 'utf8').replace(/^\uFEFF/, ''));
      delete incoming.workspace;
      delete incoming.serverPort;
      delete incoming.recentWorkspaces;
      const current = fs.existsSync(settingsFile)
        ? JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, ''))
        : {};
      const merged = { ...current, ...incoming };
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    }
    const copyRel = (rel, dest) => {
      const src = path.join(staging, rel);
      if (!fs.existsSync(src)) return;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    };
    copyRel('dsh-home/AGENTS.md', path.join(dshHome, 'AGENTS.md'));
    copyRel('dsh-home/settings.yaml', path.join(dshHome, 'settings.yaml'));
    copyRel('workspace/AGENTS.md', path.join(workspace, 'AGENTS.md'));
    copyRel('workspace/memory.json', path.join(workspace, 'memory.json'));
    copyRel('dsh-home/profiles/web/cordis.patch.yml', path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'));
    // 记忆图谱（JSONL）：目标已有则按实体合并（同名实体观察并集），避免导入覆盖丢失。
    const memorySrc = path.join(staging, 'dsh-home/memory/memory.jsonl');
    if (fs.existsSync(memorySrc)) {
      const memoryDest = path.join(dshHome, 'memory', 'memory.jsonl');
      fs.mkdirSync(path.dirname(memoryDest), { recursive: true });
      try {
        const { readGraph, mergeIntoFile } = require('./memory-store');
        if (fs.existsSync(memoryDest)) {
          const incoming = readGraph(memorySrc);
          mergeIntoFile(memoryDest, incoming.entities, incoming.relations);
        } else {
          fs.copyFileSync(memorySrc, memoryDest);
        }
      } catch (err) {
        // 合并失败时退化为直接覆盖（至少不丢备份内容）
        try { fs.copyFileSync(memorySrc, memoryDest); } catch { /* 忽略 */ }
      }
    }
    // 会话历史：按工作区键目录合并复制。
    const sessionsSrc = path.join(staging, 'dsh-home/sessions');
    if (fs.existsSync(sessionsSrc)) {
      try {
        fs.cpSync(sessionsSrc, path.join(dshHome, 'sessions'), { recursive: true });
      } catch { /* 会话复制失败不阻断导入 */ }
    }
    const skillsSrc = path.join(staging, 'dsh-home/skills');
    if (fs.existsSync(skillsSrc)) fs.cpSync(skillsSrc, path.join(dshHome, 'skills'), { recursive: true });
    const presetsSrc = path.join(staging, 'dsh-home/.agent-presets');
    if (fs.existsSync(presetsSrc)) fs.cpSync(presetsSrc, path.join(dshHome, '.agent-presets'), { recursive: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { collectBackupFiles, exportBackup, importBackup, compressStaging, extractZip };
