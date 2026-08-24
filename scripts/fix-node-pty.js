// 打包前置修补：node-pty 的 binding.gyp（及其依赖的 winpty.gyp）可能强制要求
// Spectre 缓解库（'SpectreMitigation': 'Spectre'），本机 VS2022 未安装该组件时
// 会导致 @electron/rebuild 失败（MSB8040）。移除该设置后按默认（无 /Qspectre）编译。
// 幂等：每次 npm install（postinstall）都会运行，仅当行存在时才修改；
// node-pty 1.2+ 不再内置 winpty 源码（改用预编译 conpty.dll），缺失文件自动跳过。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ptyDir = path.join(root, 'node_modules', 'node-pty');
let changed = 0;
let skipped = 0;

/** 递归收集 node-pty 下所有 .gyp / .gypi 文件（版本结构变化也不漏）。 */
function collectGypFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectGypFiles(full, out);
    else if (entry.name.endsWith('.gyp') || entry.name.endsWith('.gypi')) out.push(full);
  }
  return out;
}

const files = collectGypFiles(ptyDir, []);
if (!files.length) {
  console.log('[fix-node-pty] node-pty not installed or has no .gyp files, nothing to do');
  process.exit(0);
}
for (const target of files) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') { skipped++; continue; } // 版本结构变化，文件不存在则跳过
    console.error('[fix-node-pty] failed on ' + target + ': ' + err.message);
    process.exitCode = 1;
    continue;
  }
  if (!text.includes("'SpectreMitigation'")) {
    console.log('[fix-node-pty] already clean: ' + target);
    continue;
  }
  const fixed = text.replace(/[ \t]*'SpectreMitigation'\s*:\s*'Spectre'\s*,?\r?\n/g, '\n');
  fs.writeFileSync(target, fixed, 'utf8');
  changed++;
  console.log('[fix-node-pty] patched: ' + target);
}
if (!process.exitCode) {
  console.log('[fix-node-pty] done, changed ' + changed + ' file(s)' + (skipped ? ', skipped ' + skipped + ' missing' : ''));
}
