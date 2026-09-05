'use strict';

/**
 * 启动前自检自愈（0.1.1-rc.2 → 0.1.2-rc.1 升级事故的防错补丁，纯 Node）。
 *
 * 事故链路：npm 更新期间 harness 仍在运行/反复重启，恰好撞上 node_modules 被改写
 * 的窗口 → profiles 里桌面端插件的 junction 目标短暂缺失 / 插件依赖只剩“根提升”
 * 一条路可解析 → 0.1.2-rc.1 Loader 把 loader entry 导入失败升级为致命错误 →
 * “更新之后启动不了”。
 *
 * 本模块在每次启动 harness 前做两件幂等自愈（都失败只记日志，不抛错；真正的
 * 兜底是 main.js 的 patchDropped 降级与升级回滚）：
 *  1. ensureProfilePluginLinks：$DSH_HOME/profiles/node_modules/@dsh-desktop/* 的
 *     junction 必须存在、指向完整目标、不是悬挂链接——升级重写 node_modules 后
 *     目标缺失会直接废掉整棵插件树；
 *  2. ensureLocalPluginDeps：桌面端本地插件的 dependencies 无法从插件真实目录
 *     向上解析时，在插件目录本地补装（与根 postinstall 的 fix-plugin-deps 同逻辑）。
 *
 * 注：settings-update 的链接目标优先 packages/ 源目录（开发模式源码即时生效——
 * npm 重装可能把 node_modules 里的 file: 依赖从 junction 变成普通拷贝，若链接指向
 * 拷贝，改完 packages/ 里的源码要等下次 npm install 才生效；2026-09 升级事故后
 * 已实际观察到拷贝形态）。打包环境没有 packages/ 源目录时自动回退 node_modules
 * 里的安装副本。
 */

const fs = require('node:fs');
const path = require('node:path');
const pluginDeps = require('./plugin-deps');

/** 桌面端注入 harness 的本地插件清单（与 main/web-patch.js 的 buildPatchRows 一致）。 */
const DESKTOP_PLUGINS = [
  {
    name: '@dsh-desktop/settings-update',
    candidates: ['packages/settings-update', 'node_modules/@dsh-desktop/settings-update'],
    requiredFiles: ['package.json', 'lib/index.js', 'client.js'],
    localDeps: false,
  },
  {
    name: '@dsh-desktop/llm-openai-compat',
    candidates: ['packages/llm-openai-compat'],
    requiredFiles: ['package.json', 'lib/index.js'],
    localDeps: true,
  },
  {
    name: '@dsh-desktop/subagent-approval',
    candidates: ['packages/subagent-approval'],
    requiredFiles: ['package.json', 'lib/index.js'],
    localDeps: true,
  },
];

/** 插件目录在 profiles/node_modules 下的落点。 */
function profileLinkPath(dshHome, pkgName) {
  return path.join(dshHome, 'profiles', 'node_modules', pkgName);
}

/**
 * 从候选相对路径里挑第一个“完整可用”的真实目标目录（junction 目标指向真实目录）。
 * @returns {{realDir:string}|null}
 */
function resolvePluginTarget(appDir, candidates, requiredFiles) {
  for (const rel of candidates) {
    const candidate = path.join(appDir, rel);
    let real = candidate;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    if (targetComplete(real, requiredFiles)) return { realDir: real };
  }
  return null;
}

/** 包目录是否具备 loader 导入所需的最小文件集。 */
function targetComplete(dir, requiredFiles) {
  try {
    return requiredFiles.every((f) => fs.statSync(path.join(dir, f)).isFile());
  } catch {
    return false;
  }
}

/**
 * 确保单个桌面端插件在 profiles/node_modules 下的 junction 可用：
 * 目标缺失/悬挂/指向不完整目录 → 重建；已存在且指向完整目标 → 不动。
 * @returns {boolean} 链接可用
 */
function ensurePackageLink({ dshHome, appDir, pkg, log = () => {} }) {
  const link = profileLinkPath(dshHome, pkg.name);
  const target = resolvePluginTarget(appDir, pkg.candidates, pkg.requiredFiles);
  if (!target) {
    log('[web-patch] ' + pkg.name + ' 目标包不完整/缺失，跳过链接（loader 将无法解析该插件）');
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    let existing = null;
    try { existing = fs.lstatSync(link); } catch { /* 不存在 */ }
    if (existing) {
      if (!existing.isSymbolicLink()) {
        log('[web-patch] ' + link + ' 已存在但不是符号链接，跳过（请手动处理）');
        return false;
      }
      let usable = false;
      try {
        const real = fs.realpathSync(link);
        usable = targetComplete(real, pkg.requiredFiles);
      } catch { /* 悬挂链接 */ }
      if (usable) return true;
      log('[web-patch] 修复不可用的客户端插件链接：' + link);
      try { fs.unlinkSync(link); } catch { /* 忽略 */ }
    }
    // junction → 真实目录（链式 junction 在 Node ESM 解析下不可靠，绝不再套一层）
    fs.symlinkSync(target.realDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    log('[web-patch] 已创建客户端插件链接：' + link + ' -> ' + target.realDir);
    return true;
  } catch (err) {
    log('[web-patch] 创建客户端插件链接失败：' + (err && err.message ? err.message : err));
    return false;
  }
}

/** 维护全部桌面端插件的 profiles 链接；返回 {total, ok}。 */
function ensureProfilePluginLinks({ dshHome, appDir, log = () => {} }) {
  let total = 0;
  let ok = 0;
  for (const pkg of DESKTOP_PLUGINS) {
    total += 1;
    if (ensurePackageLink({ dshHome, appDir, pkg, log })) ok += 1;
  }
  return { total, ok };
}

/**
 * 桌面端本地插件依赖自愈（llm-openai-compat / subagent-approval）。
 * @returns {Array<{name:string, action:string, missing?:string[]}>}
 */
function ensureLocalPluginDeps({ appDir, nodeExe, log = () => {} }) {
  const results = [];
  for (const pkg of DESKTOP_PLUGINS) {
    if (!pkg.localDeps) continue;
    const target = resolvePluginTarget(appDir, pkg.candidates, pkg.requiredFiles);
    if (!target) {
      results.push({ name: pkg.name, action: 'no-target' });
      continue;
    }
    const outcome = pluginDeps.ensureLocalDeps(target.realDir, appDir, { nodeExe, log });
    results.push({ name: pkg.name, action: outcome.action, missing: outcome.missing });
  }
  return results;
}

/** 启动前自检入口（同步；从不抛错）。返回汇总文本。 */
function runBootPreflight({ dshHome, appDir, nodeExe, log = () => {} }) {
  const links = ensureProfilePluginLinks({ dshHome, appDir, log });
  const depResults = ensureLocalPluginDeps({ appDir, nodeExe, log });
  const depFailed = depResults.filter((r) => r.action === 'failed' || r.action === 'no-target');
  const summary = '插件链接 ' + links.ok + '/' + links.total + ' 可用'
    + (depFailed.length ? '；依赖自愈失败：' + depFailed.map((r) => r.name).join(',') : '');
  log('[boot-preflight] ' + summary);
  return { ok: links.ok === links.total && depFailed.length === 0, links, depResults, summary };
}

module.exports = {
  DESKTOP_PLUGINS,
  profileLinkPath,
  resolvePluginTarget,
  targetComplete,
  ensurePackageLink,
  ensureProfilePluginLinks,
  ensureLocalPluginDeps,
  runBootPreflight,
};
