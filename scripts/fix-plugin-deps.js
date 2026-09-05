// 确保本地插件的自身 dependencies 已本地安装（harness 0.1.2-rc.1 起 Loader 以
// 插件真实目录加载，ESM 从插件目录向上解析依赖；若插件只依赖根提升，
// 升级/重装 node_modules 后可能 ERR_MODULE_NOT_FOUND → loader entry 失败 →
// 整个 harness 起不来——2026-09 升级事故根因之一）。
// 幂等：本地能解析到时直接跳过；本脚本与主进程启动前自检（main/boot-preflight.js）
// 共用同一实现（main/plugin-deps.js），这里只做 postinstall 的 CLI 包装。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const bootPreflight = require('../main/boot-preflight');

const root = path.join(__dirname, '..');
const summary = bootPreflight.ensureLocalPluginDeps({ appDir: root, log: (t) => console.log(t) });
const failed = summary.filter((r) => r.action === 'failed');
console.log('[fix-plugin-deps] 检查完毕：' + summary.map((r) => r.name + '=' + r.action).join(', '));
// 漏掉 packages 目录（打包/精简检出）不算失败
if (failed.length && fs.existsSync(path.join(root, 'packages'))) {
  console.error('[fix-plugin-deps] 插件依赖补装失败（不影响根安装，启动前自检会再试）');
  process.exit(1);
}
process.exit(0);
