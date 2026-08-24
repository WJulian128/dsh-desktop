'use strict';
/**
 * 桌面端自动规范（agents-norms）：
 * 把「项目地图 / 多会话并发互不干扰 + 可回溯 / Git 纪律」等规则写进
 * 全局（$DSH_HOME/AGENTS.md）与项目（工作区/AGENTS.md）规范文件，
 * 让每个会话（不只当前对话）都自动遵守。
 *
 * 合并策略（绝不破坏用户手写内容）：
 *  - 文件不存在 → 新建，内容 = 规范块（用户后续可加自己的内容）；
 *  - 文件存在但无规范块 → 追加规范块；
 *  - 文件存在且有旧版本规范块 → 仅替换旧块为新版本；
 *  - 已是当前版本 → 不动。
 * 规范块以版本化注释标记包围：<!-- dsh-desktop-norms:vN:begin --> ... :end -->。
 * 纯 Node 逻辑、无 Electron 依赖，可单测。
 */
const fs = require('node:fs');
const path = require('node:path');

const NORM_VERSION = 3;

function marker(version, side) {
  return '<!-- dsh-desktop-norms:v' + version + ':' + side + ' -->';
}

function normBlock() {
  return [
    marker(NORM_VERSION, 'begin'),
    '',
    '## 桌面端自动规范（由 DSH Desktop 自动维护）',
    '',
    '> 本块由桌面端自动写入/升级，覆盖后再次启动桌面端会重新补齐；想禁用可整块删除。',
    '> 工具前缀 `mcp__dsh_desktop__*`（项目地图 / 编辑占用 / Git）来自桌面端内置 MCP。',
    '',
    '### 1. 项目代码地图（长代码 / 大项目高效工作）',
    '',
    '- **首次接触大型代码项目**：先调 `mcp__dsh_desktop__project_map_get`。无地图 → 按 `long-code` skill 做一次仔细精读，形成地图（项目定位、模块划分、入口、构建/测试命令、关键约定与陷阱、重点文件职责摘要），再用 `mcp__dsh_desktop__project_map_set` 保存。',
    '- **之后每次开工**：先 `project_map_get`。地图齐全且无 stale 文件 → 直接按地图推进，**绝不整文件重复读**；有 stale → 只重读 stale 文件并 `project_map_set` 增量补图。',
    '- **代码更新后同步补图**：改动提交后（或接手前）用 `mcp__dsh_desktop__project_map_status` 查哪些文件变了，重读并更新对应地图条目——做到"改到哪里、地图补到哪里"。',
    '',
    '### 2. 多会话并发修改互不干扰 + 可回溯',
    '',
    '- **改文件前先认领**：调 `mcp__dsh_desktop__edit_claim`（列出要改的文件）。同一任务后续扩文件再认领即可。',
    '- **查冲突再动手**：`mcp__dsh_desktop__edit_status` 显示其他会话占用的文件；发现占用 → **不要直接覆盖**，先告知用户（哪个对话在改哪些文件），由用户协调或等待释放。',
    '- **改完验证后释放**：`mcp__dsh_desktop__edit_release`；每次认领/释放自动记入 `.dsh/change-journal.jsonl`（`edit_journal` 可查），谁在何时动了什么文件全部可回溯。',
    '- **快照兜底**：每个任务块完成后用 `mcp__dsh_desktop__git_commit` 提交（自动带会话 id 前缀）；无仓库先 `git_init`。任意时刻可用 `git_restore` 回滚。',
    '',
    '### 3. Git 纪律',
    '',
    '- 已完成的改动必须落提交：提交信息写清**做了什么、为什么**（不要只写 update/fix）。',
    '- 破坏性/大面积操作（重构、批量删除/移动）前，先提交当前进度。',
    '- 分支切换用 `mcp__dsh_desktop__git_checkout`（有未提交变更时自动 stash 保护）；回滚用 `git_restore` / `git_stash`，**不用 `reset --hard`、不用 `push --force`**。',
    '',
    '### 4. 模型调度面板',
    '',
    '- 右侧「模型调度 → 子代理运行」只显示**当前对话**派发的子代理；切换对话后面板内容随之切换。',
    '',
    marker(NORM_VERSION, 'end'),
    '',
  ].join('\n');
}

/**
 * 确保目标 AGENTS.md 含当前版本规范块。
 * @param {string} file 目标文件绝对路径
 * @returns {{ status:'created'|'appended'|'updated'|'unchanged'|'error', error?:string }}
 */
function ensureNorms(file) {
  try {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      text = '';
    }
    const block = normBlock();
    const beginIdx = text.indexOf('<!-- dsh-desktop-norms:v');
    if (!text.trim()) {
      fs.writeFileSync(file, block, 'utf8');
      return { status: 'created' };
    }
    if (beginIdx === -1) {
      fs.writeFileSync(file, text.replace(/\s*$/, '\n\n') + block, 'utf8');
      return { status: 'appended' };
    }
    // 已有规范块：找到 begin 与对应的 end，整块替换
    const beginLineEnd = text.indexOf('\n', beginIdx);
    const beginMarker = text.slice(beginIdx, beginLineEnd === -1 ? text.length : beginLineEnd).trim();
    const versionMatch = /v(\d+):begin/.exec(beginMarker);
    const version = versionMatch ? Number(versionMatch[1]) : 0;
    if (version === NORM_VERSION && text.indexOf(marker(NORM_VERSION, 'end')) !== -1) {
      return { status: 'unchanged' };
    }
    const endMarker = /<!-- dsh-desktop-norms:v\d+:end -->/;
    const endMatch = endMarker.exec(text);
    let newText;
    if (endMatch) {
      const endPos = endMatch.index + endMatch[0].length;
      newText = text.slice(0, beginIdx) + block.trimEnd() + '\n' + text.slice(endPos);
    } else {
      newText = text.slice(0, beginIdx) + block.trimEnd() + '\n' + text.slice(beginLineEnd === -1 ? text.length : beginLineEnd + 1);
    }
    fs.writeFileSync(file, newText, 'utf8');
    return { status: 'updated', fromVersion: version };
  } catch (err) {
    return { status: 'error', error: (err && err.message) || String(err) };
  }
}

module.exports = { ensureNorms, normBlock, NORM_VERSION };
