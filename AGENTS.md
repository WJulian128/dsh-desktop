# AGENTS.md — 项目工作指南

本文件会被 harness 自动加载（类似 CLAUDE.md）。这是 DeepSeek Harness 桌面端的开发工作区。

## 工作方式（重要）

- **大代码库高效工作**：遵循 `long-code` skill——先查 memory MCP 与项目地图，grep/定点读代替整文件重读；读过的关键结论写入 memory，避免重复消耗 token。
- **需求模糊时**：遵循 `brainstorm` skill——先给 2-4 个具体方案（含成本/收益）让用户选，不要直接开干。
- **多代理并行**：遵循 `multi-agent` skill——任务可切分、互不依赖、每块够大才用 subagent/workflow 并行；产出必须逐项验收，效果不好就不并行。**大任务派发子代理前必须先 `ask_user_question` 询问用户**（全局 AGENTS.md「子代理决策协议」：询问→拆解→并行派发→list_agents 监督→send_message 纠正→interrupt_agent 终止→逐项验收→汇总报告）。
- **上下文接近上限时**：遵循 `handoff` skill——先把目标/进度/下一步写入 `.dsh/handoff.md` 与 memory 的 `task-progress`，再提示用户点状态胶囊的「➕ 接续」开新对话无缝续做。
- **办公任务**（写作/总结/汇报/翻译）：遵循 `office` skill。

## 桌面端约定

- Electron 应用：`main/`（主进程）、`preload/`（contextBridge）、`renderer/`（加载页/终端/Git 窗/截图选区）、`packages/settings-update/`（设置页客户端插件源码）、`scripts/`（测试）。
- 注入 harness 的能力走 `main/web-patch.js` 生成的 `%APPDATA%\dsh-desktop\web.patch.yml`；设置页客户端插件的源码在 `packages/settings-update/`（`node_modules/@dsh-desktop/settings-update` 是指向它的 junction，勿直接改 node_modules 里的副本）。
- 改动 main 进程代码后需重启桌面端生效；改客户端插件（client.js）后重启服务即可。
- 打包：`npm run pack`（解包验证）/ `npm run dist`（NSIS 安装包 + 便携版，产出在 `release/`）；asar:false。打包冒烟：`powershell -File scripts\test-packaged-boot.ps1`。
- 测试：`node scripts\test-client-module.js`、`node scripts\test-mcp-server.mjs`、`node scripts\test-vision.js`、`node scripts\test-vision-live.js`（真实 Ollama 端到端；改视觉链路必跑）、`node scripts\test-ollama.js`、`node scripts\test-usage.js`、`node scripts\test-memory.js`、`node scripts\test-subagent-center.js`、`node scripts\test-task-dispatch.js`、`node scripts\test-quiet-hours.js`、`node scripts\test-updater.js`、`node scripts\test-scan-worker.js`、`node scripts\test-notify.js`、`node scripts\test-schedule.js`、`node scripts\test-system.js`、`node scripts\test-win-control.js`、`node scripts\test-backup.js`、`node scripts\test-context-watch.js`、`scripts\test-patch-boot.ps1`（冒烟见 `scripts\smoke-test.ps1`）。
- ⚠️ 编码红线：任何 .ps1/.js 源文件不要经过 PowerShell 5.1 的 `Get-Content`/`Set-Content` 往返（UTF-8 无 BOM 会被当 GBK 读，中文变成乱码并破坏语法）；.ps1 含中文必须带 UTF-8 BOM 或干脆纯 ASCII；改文件一律用 read/edit/write 工具或 Node 显式 utf8。

## 可用的 MCP 工具（自动注册，按需自主调用）

- `mcp__dsh_desktop__*`：桌面能力（状态/更新/打开目录/日志/终端/重启/切换工作区/**图片识别**/API 余额与用量）。
- `mcp__dsh_desktop__project_map_*`：**项目代码地图**（长代码/大项目首次精读建图 + 更新后增量补图，见文末桌面端自动规范）。
- `mcp__dsh_desktop__edit_*`：多会话编辑占用/变更日志（改文件前认领、查冲突、可回溯）。
- `mcp__dsh_desktop__git_*`：Git 白名单操作（status/diff/log/commit/branch/checkout/restore/stash/init；git MCP 移除后由桌面端内置补齐）。外部仓库的 push/pull 用 `pwsh` 执行 `git` 命令。
- `mcp__memory__*`：项目长期记忆（知识图谱，存于 `~/.dsh/memory/memory.jsonl`，桌面端自动记忆与备份均以此为准）。
- `mcp__sequential-thinking__*`：复杂问题分步推理。
- 网页搜索：`web_search` 工具。

## 截图与附件

- 用户可用「工具」菜单或状态胶囊快速截图/附加文件。
- 图片：走 harness 附件管道。双轨机制——当前会话模型为官方多模态模型（`deepseek-v4-flash-vision-exp`）时图片由 harness 原生直传（Files API），无需额外处理；当前模型为纯文本模型（如 `deepseek-v4-flash`/`deepseek-v4-pro`）时，遇到图片附件引用（`sha256:<64位十六进制>`）、图片文件或图片 URL，调用 `mcp__dsh_desktop__describe_image` 获取文字描述后再继续。
- 其他附件：文件被复制到工作区 `.dsh-attachments/` 目录，对话框里会给清单；用 `read`/`grep` 等工具读取内容。

<!-- dsh-desktop-norms:v3:begin -->

## 桌面端自动规范（由 DSH Desktop 自动维护）

> 本块由桌面端自动写入/升级，覆盖后再次启动桌面端会重新补齐；想禁用可整块删除。
> 工具前缀 `mcp__dsh_desktop__*`（项目地图 / 编辑占用 / Git）来自桌面端内置 MCP。

### 1. 项目代码地图（长代码 / 大项目高效工作）

- **首次接触大型代码项目**：先调 `mcp__dsh_desktop__project_map_get`。无地图 → 按 `long-code` skill 做一次仔细精读，形成地图（项目定位、模块划分、入口、构建/测试命令、关键约定与陷阱、重点文件职责摘要），再用 `mcp__dsh_desktop__project_map_set` 保存。
- **之后每次开工**：先 `project_map_get`。地图齐全且无 stale 文件 → 直接按地图推进，**绝不整文件重复读**；有 stale → 只重读 stale 文件并 `project_map_set` 增量补图。
- **代码更新后同步补图**：改动提交后（或接手前）用 `mcp__dsh_desktop__project_map_status` 查哪些文件变了，重读并更新对应地图条目——做到"改到哪里、地图补到哪里"。

### 2. 多会话并发修改互不干扰 + 可回溯

- **改文件前先认领**：调 `mcp__dsh_desktop__edit_claim`（列出要改的文件）。同一任务后续扩文件再认领即可。
- **查冲突再动手**：`mcp__dsh_desktop__edit_status` 显示其他会话占用的文件；发现占用 → **不要直接覆盖**，先告知用户（哪个对话在改哪些文件），由用户协调或等待释放。
- **改完验证后释放**：`mcp__dsh_desktop__edit_release`；每次认领/释放自动记入 `.dsh/change-journal.jsonl`（`edit_journal` 可查），谁在何时动了什么文件全部可回溯。
- **快照兜底**：每个任务块完成后用 `mcp__dsh_desktop__git_commit` 提交（自动带会话 id 前缀）；无仓库先 `git_init`。任意时刻可用 `git_restore` 回滚。

### 3. Git 纪律

- 已完成的改动必须落提交：提交信息写清**做了什么、为什么**（不要只写 update/fix）。
- 破坏性/大面积操作（重构、批量删除/移动）前，先提交当前进度。
- 分支切换用 `mcp__dsh_desktop__git_checkout`（有未提交变更时自动 stash 保护）；回滚用 `git_restore` / `git_stash`，**不用 `reset --hard`、不用 `push --force`**。

### 4. 模型调度面板

- 右侧「模型调度 → 子代理运行」只显示**当前对话**派发的子代理；切换对话后面板内容随之切换。

<!-- dsh-desktop-norms:v3:end -->
