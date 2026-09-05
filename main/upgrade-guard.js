'use strict';

/**
 * 升级防护的事务状态与启动失败分类（纯函数，无 IO）。
 *
 * 事故复盘（0.1.1-rc.2 → 0.1.2-rc.1）：
 *  1. 更新期间 harness 仍在运行，npm 重写 node_modules 的窗口里任何重启都会撞上
 *     半更新依赖（ERR_MODULE_NOT_FOUND / 插件树加载失败），而新版 Loader 把
 *     “loader entry 导入失败”当成致命错误，表现为反复“启动不了”；
 *  2. 新版 web 页面与 /api 全部要求 token 认证，端点/信封格式也变了，升级后首启
 *     不验证这些能力，等到功能用到时才发现整条通道已失效。
 *
 * 对策（settings 键：updateGuard / lastKnownGoodVersion）：
 *  - updateGuard.status：in-progress（安装中）→ applied（安装完成、待启动冒烟）→
 *    冒烟通过后清除；失败标记 failed（下次启动提示可重试，不自动重装）。
 *  - lastKnownGoodVersion：最近一次“启动冒烟通过”的 harness 版本。
 *    installed ≠ lastGood ⇒ 版本变了 ⇒ ready 后必须跑冒烟（认证 cookie 换取 +
 *    session/list 核心 RPC）；冒烟失败且 guard.applied ⇒ 提示一键回滚到 guard.prev。
 */

/** settings 键名（与 main.js 共用，集中避免拼写漂移）。 */
const KEYS = {
  UPDATE_GUARD: 'updateGuard',
  LAST_GOOD: 'lastKnownGoodVersion',
};

/**
 * 构造 in-progress 事务记录（安装开始前写入；prev 是回滚依据，必须保留到冒烟通过）。
 * @param {{installed?:string|null, target:string}} input
 */
function guardForUpdate({ installed, target }) {
  return {
    version: target,
    prev: installed || null,
    startedAt: new Date().toISOString(),
    status: 'in-progress',
  };
}

/** 安装成功、进程重启前的状态：等 ready 后的启动冒烟来验收。 */
function markApplied(guard) {
  return { ...(guard || {}), status: 'applied' };
}

/**
 * 是否需要启动冒烟：无已知可用版本，或已安装版本 ≠ 上次冒烟通过的版本。
 * 把'0.0.0'（无安装的哨兵值）也视为无已知版本。
 */
function shouldSmoke(installed, lastGood) {
  const v = String(installed || '');
  const good = String(lastGood || '');
  return !!v && v !== '0.0.0' && (!good || good === '0.0.0' || v !== good);
}

/**
 * 升级后首启失败的三方会诊。
 * @param {{installed?:string, lastGood?:string|null, guard?:object|null}} input
 * @returns {{newVersion:boolean, prev:string|null, promptRollback:boolean, reason:string}}
 */
function triageUpgradeBootFailure({ installed, lastGood, guard }) {
  const versionChanged = shouldSmoke(installed, lastGood);
  const guardActive = !!(guard && guard.status === 'applied' && guard.version && guard.version === installed);
  const newVersion = guardActive && versionChanged;
  const prev = (guardActive && guard.prev) || null;
  return {
    newVersion,
    prev,
    promptRollback: newVersion && !!prev,
    reason: newVersion
      ? 'harness 版本（' + installed + '）与上次可用版本（' + (lastGood || '未知') + '）不一致，升级后首次启动/验证失败'
      : (guardActive
        ? '同版本重装后的启动/验证失败（无版本变更，不回滚）'
        : '非版本变更导致的启动失败'),
  };
}

/** 启动失败文本 → 分类与处理建议（供日志与错误页提示）。 */
function classifyBootFailure(text) {
  const haystack = String(text || '').toLowerCase();
  if (haystack.includes('eaddrinuse') || haystack.includes('address already in use')) {
    return { kind: 'port-busy', hint: '端口被占用；重启桌面端会自动换端口重试。', retry: 'restart' };
  }
  if (haystack.includes('plugin tree failed to load')) {
    return { kind: 'plugin-tree', hint: '插件树整体加载失败（Loader 入口或补丁行解析问题）。', retry: 'drop-patch' };
  }
  if (haystack.includes('failed to import loader entry') || haystack.includes('failed to apply loader entry')) {
    return { kind: 'loader-entry', hint: '补丁注入的插件条目无法加载（包缺失/链接失效/依赖不全，见日志最近输出）。', retry: 'repair-then-retry' };
  }
  if (haystack.includes('err_module_not_found') || haystack.includes('cannot find package')
    || haystack.includes('cannot find module')) {
    return { kind: 'module-not-found', hint: '依赖缺失：更新中断或 node_modules 不完整，可重试；仍失败请重新 npm install。', retry: 'repair-then-retry' };
  }
  if (haystack.includes('waiting for service') || haystack.includes('就绪超时')) {
    return { kind: 'timeout', hint: '服务就绪超时。', retry: 'retry' };
  }
  return { kind: 'other', hint: '', retry: 'retry' };
}

module.exports = {
  KEYS,
  guardForUpdate,
  markApplied,
  shouldSmoke,
  triageUpgradeBootFailure,
  classifyBootFailure,
};
