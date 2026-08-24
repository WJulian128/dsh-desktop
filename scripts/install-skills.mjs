// 安装精选 skills 到 ~/.dsh/skills（superpowers 核心库精选，真正有用的子集）。
// 来源：obra/superpowers（先 clone 到临时目录）。用法：node scripts\install-skills.mjs [源目录]
// 已按 DSH Desktop / Windows 环境适配：frontmatter 描述裁剪、脚本转 PowerShell。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = process.argv[2] || path.join(os.tmpdir(), 'dsh-skills-src', 'skills');
const DEST = path.join(os.homedir(), '.dsh', 'skills');

// 精选清单（跳过与既有技能重复/依赖 bash 服务端脚本的：brainstorming、dispatching-parallel-agents、using-superpowers）
const PICK = [
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

const MAX_DESC = 300;

function loadSkill(name) {
  const file = path.join(SRC, name, 'SKILL.md');
  if (!fs.existsSync(file)) throw new Error('missing source: ' + file);
  const text = fs.readFileSync(file, 'utf8');
  // 解析 frontmatter：--- 起止，name/description 行
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) throw new Error('no frontmatter: ' + name);
  let fm = m[1];
  const descMatch = /^description:\s*(.+)$/m.exec(fm);
  if (!descMatch) throw new Error('no description: ' + name);
  let desc = descMatch[1].trim().replace(/^["']|["']$/g, '');
  if (desc.length > MAX_DESC) desc = desc.slice(0, MAX_DESC - 1) + '…';
  // 重写 frontmatter：name 与裁剪后的 description，其余字段丢弃
  const nameMatch = /^name:\s*(\S+)\s*$/m.exec(fm);
  const skillName = nameMatch ? nameMatch[1] : name;
  const newFm = '---\nname: ' + skillName + '\ndescription: ' + desc + '\n---\n';
  const body = text.slice(m[0].length);
  return { skillName, body, newFm };
}

let installed = 0;
for (const name of PICK) {
  const { skillName, body, newFm } = loadSkill(name);
  const dir = path.join(DEST, skillName);
  fs.mkdirSync(dir, { recursive: true });
  let extra = '';
  if (skillName === 'subagent-driven-development') {
    // Windows 适配：脚本为 PowerShell 版本（scripts/*.ps1），用 pwsh 执行
    extra = '\n\n> **DSH Desktop（Windows）适配**：本机无 bash；三个辅助脚本已转成 PowerShell，' +
      '统一用 `pwsh -File scripts\\sdd-workspace.ps1` / `scripts\\task-brief.ps1` / `scripts\\review-package.ps1` ' +
      '执行（参数顺序与原 bash 版一致）。\n';
  }
  fs.writeFileSync(path.join(dir, 'SKILL.md'), newFm + extra + body, 'utf8');
  installed++;
  console.log('installed: ' + skillName);
}
console.log('INSTALL-SKILLS OK: ' + installed + ' skills -> ' + DEST);
