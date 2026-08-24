// 安装精选 skills 到 ~/.dsh/skills（多来源精选，真正有用的子集）。
// 来源 1：obra/superpowers（核心库，先 clone 到临时目录）
// 来源 2：obra/superpowers-skills（合并库，调试/思考/测试类精选）
// 来源 3：mattpocock/skills（工程类精选）
// 用法：node scripts\install-skills.mjs [superpowers核心目录] [superpowers-skills目录] [mattpocock目录]
// 已按 DSH Desktop / Windows 环境适配：frontmatter 归一化（name 转小写 slug、描述裁剪 ≤300 字）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CORE_SRC = process.argv[2] || path.join(os.tmpdir(), 'dsh-skills-src', 'skills');
const SP_SRC = process.argv[3] || path.join(os.tmpdir(), 'sp-skills', 'skills');
const MP_SRC = process.argv[4] || path.join(os.tmpdir(), 'mp-skills', 'skills');
const DEST = path.join(os.homedir(), '.dsh', 'skills');

const MAX_DESC = 300;

// 核心库精选（第 1 批已装，重复执行幂等）
const CORE_PICK = [
  'systematic-debugging',
  'writing-plans',
  'executing-plans',
  'requesting-code-review',
  'receiving-code-review',
  'verification-before-completion',
  'test-driven-development',
  'subagent-driven-development',
  'using-git-worktrees',
  'finishing-a-development-branch',
  'writing-skills',
];

// 第 2 批：自主研判补充（调试/思考/测试/架构/协作，按"对本环境真正有用"精选）
const SP_PICK = [
  'debugging/root-cause-tracing',
  'debugging/defense-in-depth',
  'problem-solving/when-stuck',
  'problem-solving/simplification-cascades',
  'testing/condition-based-waiting',
  'testing/testing-anti-patterns',
  'research/tracing-knowledge-lineages',
];
const MP_PICK = [
  'engineering/resolving-merge-conflicts',
  'engineering/research',
  'engineering/codebase-design',
  'productivity/writing-for-agents',
  'productivity/grill-me',
];

function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 解析 frontmatter（兼容两种形态：标准 name/description 与带空格 name + 附加字段）。 */
function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) throw new Error('no frontmatter');
  const fm = m[1];
  const nameMatch = /^name:\s*(.+)$/m.exec(fm);
  if (!nameMatch) throw new Error('no name');
  const descMatch = /^description:\s*(.+)$/m.exec(fm);
  let desc = descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  if (desc.length > MAX_DESC) desc = desc.slice(0, MAX_DESC - 1) + '…';
  const skillName = slugify(nameMatch[1]);
  const newFm = '---\nname: ' + skillName + '\ndescription: ' + desc + '\n---\n';
  return { skillName, body: text.slice(m[0].length), newFm };
}

function installOne(entry, src) {
  const file = path.join(src, entry, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error('missing source: ' + file);
  const { skillName, body, newFm } = parseSkill(fs.readFileSync(file, 'utf8'));
  const dir = path.join(DEST, skillName);
  fs.mkdirSync(dir, { recursive: true });
  let extra = '';
  if (skillName === 'subagent-driven-development') {
    extra = '\n\n> **DSH Desktop（Windows）适配**：本机无 bash；三个辅助脚本已转成 PowerShell，' +
      '统一用 `pwsh -File scripts\\sdd-workspace.ps1` / `scripts\\task-brief.ps1` / `scripts\\review-package.ps1` ' +
      '执行（参数顺序与原 bash 版一致）。\n';
  }
  fs.writeFileSync(path.join(dir, 'SKILL.md'), newFm + extra + body, 'utf8');
  return skillName;
}

let installed = 0;
for (const entry of CORE_PICK) {
  try { console.log('installed: ' + installOne(entry, CORE_SRC)); installed++; }
  catch (err) { console.log('SKIP ' + entry + ': ' + err.message); }
}
for (const entry of SP_PICK) {
  try { console.log('installed: ' + installOne(entry, SP_SRC)); installed++; }
  catch (err) { console.log('SKIP ' + entry + ': ' + err.message); }
}
for (const entry of MP_PICK) {
  try { console.log('installed: ' + installOne(entry, MP_SRC)); installed++; }
  catch (err) { console.log('SKIP ' + entry + ': ' + err.message); }
}
console.log('INSTALL-SKILLS OK: ' + installed + ' skills -> ' + DEST);
