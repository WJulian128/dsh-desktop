# DeepSeek Harness 桌面端（DSH Desktop）

一个类似 Codex / Claude Code 的独立桌面客户端：在**原生窗口**里运行 DeepSeek Harness 的完整 Web 界面，不再是“先开终端跑 `dsh web`、再开浏览器”的方式；同时内置**更新检查与一键自动更新**，始终能拿到最新的 harness。

## 特点

- **原生桌面窗口**：启动时自动拉起 `dsh web`，窗口直接加载 harness 界面，无需手动开浏览器。
- **对话热启动**：关闭桌面端后再次打开，**上一次的对话自动继续**。桌面端固定复用同一个本地端口（origin 稳定），harness 前端记住的“当前会话”得以恢复；会话数据本身持久化在 `~/.dsh/sessions`，网页版与桌面端可交替使用。
- **MCP 服务器**：桌面端内置 `dsh_desktop` MCP 服务器，harness 能**自主搜索并调用**所需工具：
  - 模型侧工具名：`mcp__dsh_desktop__*`（获取状态、检查更新、应用更新、打开目录/日志、终端模式、重启应用、切换工作区、**图片识别 describe_image**、**API 余额/用量**）；
  - 网页搜索已由 harness 的 `standard` 预设默认启用，配合 MCP 工具，harness 需要什么就自己查、自己调；
  - 还可在设置里追加任意 MCP 服务器（stdio 或 streamable-http）。
- **设置页集成**：harness 设置页新增九个桌面端分区（齿轮 → 桌面端 / MCP 服务器 / 插件 / 多模态 / 记忆 / 定时任务 / 系统环境 / 备份与迁移 / 用量与账单）：
  - **桌面端**：版本/工作区/数据目录，一键 **检查更新 / 立即更新**，**权限与沙箱模式**切换（只读/工作区写/完全访问）、任务完成通知开关、项目说明（AGENTS.md）入口、Git 变更窗口；
  - **MCP 服务器**：内置 `dsh_desktop` 开关，自定义 MCP 服务器**增删改 / 启停**（stdio 或 streamable-http），改完一键“应用更改并重启服务”；
  - **插件**：桌面端扩展开关，harness 插件（web profile）的**安装 / 卸载**（基于 `dsh plugin`，输出流式显示）与已加载插件清单；
  - **多模态**：配置**其他家视觉模型**（OpenAI 兼容接口，内置 9 家服务商预设一键选填：OpenAI / 智谱 / 阿里百炼 / 硅基流动 / Kimi / 火山方舟 / OpenRouter / Ollama / 自定义）；另内置 **Ollama 一键集成**——自动下载官方便携包（约 700MB）、启动本地服务、拉取视觉模型（推荐 qwen2.5vl:7b 约 5.9GB，另有 3b/llava/llama-vision）并一键启用，**零 apiKey、图片识别完全本地**。启用后 harness 可用 `mcp__dsh_desktop__describe_image` 描述图片（附件引用/本地文件/URL）再继续；
  - **记忆**：查看/打开模型长期记忆（memory MCP 知识图谱：实体数/关系数），可一键"让模型记住"指定内容——大项目自动建项目地图，跨会话免重复读代码；
  - **用量与账单**：查询 **DeepSeek API 余额**（官方 /user/balance 接口）、统计本工作区 **token 用量与估算成本**（解析本地会话日志）。
- **状态栏胶囊**（右下角不挡内容，默认收起只显示权限模式与状态，悬停展开）：权限模式（点击循环切换）、默认模型、MCP 数、harness 版本、更新状态（点击检查/更新）、设置入口。
- **预装编程 MCP**（已写入设置，重启生效）：`fetch`（抓取网页/文档）、`memory`（项目长期记忆，存工作区 memory.json）、`sequential-thinking`（复杂问题分步推理）、`git`（git 只读操作）自动启用；`github`（仓库操作，填入 GITHUB_TOKEN 后在 设置 → MCP 服务器 启用）。
- **工作技能包（skills，已装到 ~/.dsh/skills）**：
  - `long-code`：大代码库省 token 工作法（先查记忆、grep 定点读、维护项目地图，避免重复读代码）；
  - `multi-agent`：多代理并行编排与质检（值得才并行、逐项验证产出）；
  - `brainstorm`：需求模糊时主动给出 2-4 个方案再动手；
  - `office`：办公写作/总结/汇报/翻译；
  - `handoff`：上下文接近上限时写交接文件，配合新对话无缝接续。
- **截图与附件**：**输入框工具行常驻 📷 截图按钮**（点击即框选截图并自动贴进对话框）；菜单 **工具 → 快速截图**（Ctrl+Shift+A）与 **附加文件…**（Ctrl+Shift+O，任意文件复制到工作区 `.dsh-attachments/` 并把清单注入对话；单张图片直接贴图）；状态胶囊悬停也有 📷/📎 快捷入口。
- **自动工作习惯**（写进全局 `~/.dsh/AGENTS.md`，所有会话自动生效）：首次接触大项目自动按 `long-code` skill 建项目地图并维护 memory；需求模糊自动给方案；代码默认遵循 `code-standards`、关键改动 `code-review` 自查；上下文紧张自动写交接；图片自动走视觉识别；电脑操作自动按 `windows-control` 闭环。
- **Windows 电脑操控（Codex/Claude computer-use 风格）**：内置 `win-control.exe`（C# user32 助手，首次使用自动编译）与 `windows-control` skill，模型可自主调用 `mcp__dsh_desktop__computer_*` 工具：**看屏幕**（截图+本地视觉自动识别）、**鼠标**（移动/点击/双击/右键/拖动/滚动）、**键盘**（输入含中文/组合键）、**窗口**（列举/聚焦/最小化/最大化/移动/缩放/关闭）、**剪贴板**、**启动应用**——按"截图观察 → 最小动作 → 截图验证"闭环安全操作。
- **常驻丝滑体验**：系统**托盘**（打开主界面/新对话接续/截图/附件/终端/退出）；**全局快捷键**（Ctrl+Shift+A 截图、Ctrl+Shift+T 终端、Ctrl+Shift+F 呼出主界面、Ctrl+Shift+Space 快速命令框，应用不在前台也可用）；**关闭到托盘**（不退出，托盘常驻）；**开机自启**（设置页可开关）。
- **Windows 环境修复（把 Windows 变得像 macOS 一样顺）**：设置页「系统环境」——**环境体检**（Node/Git/winget、长路径、开发者模式、执行策略、控制台 UTF-8，一键修复，需管理员项走 UAC 提权）、**用户环境变量 GUI 管理**（免进系统设置对话框）、**winget 一键安装**开发工具（Git/Node/7-Zip/Terminal/PowerShell 7）、**右键菜单集成**（任意文件/文件夹右键 →「交给 DSH 处理」，直接派给 harness 读取/总结/建议）。模型也能自己修电脑：`mcp__dsh_desktop__system_doctor/fix/env` + `windows-ops` skill（Windows 干活避坑手册：编码/路径/文件占用/权限/命令替代）。
- **Spotlight 式快速命令框**：**双击托盘图标**或 Ctrl+Shift+Space 唤起屏幕上方命令框，输入任务回车**直接派发给 harness 对话**（Ctrl+Enter 只填入不发送），随时随地一句话开工。
- **定时任务与提醒**：设置页「定时任务」管理（单次/每天 HH:MM/每 N 分钟；**提醒**=到点弹系统通知，**派发任务**=到点自动把任务填入 harness 对话并发送）；模型也能自己建任务（对它说"每天 9 点提醒我…"，它会用 `mcp__dsh_desktop__schedule` 处理）。
- **新对话接续**：菜单 **工具 → 新对话接续当前任务**（Ctrl+Shift+N）或胶囊「➕ 接续」——配合 `handoff` skill：模型写交接（`.dsh/handoff.md`）后，一键新开会话并注入接续指令，压缩与新对话同时进行、任务不丢。
- **上下文告警（快满时先问你，而不是默默压缩）**：桌面端实时监测活动会话的 token 累计（默认阈值 10 万，设置 → 桌面端 → 上下文告警 可开关/调阈值）；接近上限时弹系统通知 + 状态胶囊变警示色，你点击「接续」开新对话（无损交接、预算重置），或让模型继续压缩（保连续性）。全局 `~/.dsh/AGENTS.md` 已同步规则：模型察觉上下文吃紧时会先写 handoff 并询问你选哪种、同时给出推荐。
- **Codex / Claude 风格桌面能力**：
  - 菜单 **模式**：权限与沙箱模式切换（Codex sandbox/approval）、任务完成通知（窗口后台时原生通知 + 任务栏闪烁）、API 余额/用量查询；
  - 菜单 **文件**：最近工作区快速切换、编辑项目说明（工作区/全局 AGENTS.md，harness 自动加载）；
  - 菜单 **视图**：查看 Git 变更（Ctrl+Shift+D，独立 diff 审查窗）。
- **备份与迁移**：一键把 settings.json（MCP/视觉/权限/定时任务）、`~/.dsh/skills`、AGENTS.md、记忆、profile 补丁打包成 zip（可选含 API 密钥）；新电脑装上 DSH 桌面端后导入即恢复全部打磨成果——**换电脑零成本**。
- **更新能力**：
  - 启动后自动检查 npm registry 上 `@deepseek-ai/dsh` 的最新版本；
  - 发现新版本时，界面右上角出现角标 **“发现新版本 vX — 点击更新”**，并弹窗提示；
  - 一键确认后自动执行 `npm install @deepseek-ai/dsh@<新版>` 并**自动重启**加载新 harness；
  - 菜单 **帮助 → 检查更新…** 或设置页 **桌面端 → 检查更新** 均可手动检查。
- **工作区**：首次启动选择工作区目录（可记忆），菜单 **文件 → 切换工作区…** 随时更换；harness 以该目录为 workspace 根。
- **终端模式**：菜单 **视图 → 终端模式**（或 Ctrl+T）打开一个类似 codex 的命令窗口，输入任务即运行 `dsh --profile headless "<任务>"`，结果流式输出。
- **日志**：harness 运行日志写入 `%APPDATA%\dsh-desktop\logs\dsh-web.log`。

## 运行

### 开发模式（快速迭代）

要求：已安装 Node.js 18+（含 npm）。

双击 **`启动桌面端.bat`**，或在终端里：

```bat
cd /d 你的工作区路径
npm install   （仅首次）
npm start
```

改动 `main/` 后重启桌面端生效；改动 `packages/settings-update/client.js` 后重启服务即可（`node_modules/@dsh-desktop/settings-update` 是指向 `packages/` 的 junction，改一处即生效）。

### 打包成真正的 .exe（分发给别人 / 换电脑）

```bat
npm run pack   :: electron-builder --dir：解包目录（快速验证打包布局）
npm run dist   :: electron-builder --win：产出 NSIS 安装包 + 便携版 exe
```

产物在 `release/`：`DSH Desktop-Setup-1.0.0.exe`（安装版，可选安装目录）与 `DSH Desktop-1.0.0-portable.exe`（免安装便携版）。

应用图标使用 **harness 官方灰色鲸鱼**（取自官方 web 前端 favicon.svg，冻结在 `build/icon.svg`）。`node scripts/generate-icons.js` 会重新生成 `build/icon.png`（1024，electron-builder 自动转 .ico）与 `renderer/icon.png`（256，窗口/托盘/加载页共用）；harness 更新后如需跟随官方新图标，重跑一次即可。

打包模式的行为（与开发模式完全一致，仅路径不同）：

- 应用安装为**真实文件**（`resources/app`，禁用 asar），harness、内置 MCP 服务器、设置页插件全部走真实路径，无任何虚拟文件系统坑；
- harness 本体随应用打包（`resources/app/node_modules/@deepseek-ai/dsh`），**新电脑无需安装 Node.js**：无 Node 时全部子进程自动退回 Electron 自带 Node（`ELECTRON_RUN_AS_NODE`）；
- 检查更新/一键更新改为安装到 `%APPDATA%\dsh-desktop\dsh`（安装目录不可写），**无系统 npm 时用打包进去的 npm**，更新后自动重启；
- 设置、会话、skills 仍在 `%APPDATA%\dsh-desktop\` 与 `~/.dsh`，与开发模式共享同一份数据。

### 换电脑迁移（把打磨好的 harness 带走）

1. 旧电脑：菜单 **工具 → 备份与迁移**（或 设置 → 备份与迁移）→ **导出（不含密钥）**，得到一个 zip（含 settings.json、skills、AGENTS.md、记忆、profile 补丁、安装信息；需要完整克隆 API 密钥时选"含密钥"）；
2. 新电脑：安装 `DSH Desktop-Setup-*.exe`，启动后导入 zip → 重启，全部配置即恢复（本机的 workspace/端口自动保留）。

## 更新机制说明

- 版本来源：<https://registry.npmjs.org/@deepseek-ai/dsh>（`latest` 标签，可选 `next` 预发布标签）。
- 更新的是**应用目录里的 harness**（`node_modules/@deepseek-ai/dsh` 与 `package.json` 的版本声明），更新后自动重启生效。
- 设置文件：`%APPDATA%\dsh-desktop\settings.json`（菜单 帮助 → 打开设置文件），字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspace` | 首次询问 | 工作区目录 |
| `autoUpdate` | `true` | 启动检查到新版本时弹窗提示 |
| `silentAutoUpdate` | `false` | 为 `true` 时不询问，直接更新并重启 |
| `checkPrereleases` | `false` | 同时考虑 `next` 预发布标签 |
| `showUpdateBadge` | `true` | 界面右上角显示更新角标 |
| `serverPort` | 首次分配 | **固定端口**：对话热启动依赖它保持同一 origin（localStorage 记住当前会话）；被占用时自动换新并保存 |
| `enableDesktopMcp` | `true` | 是否启用内置 `dsh_desktop` MCP 服务器 |
| `mcpServers` | `[]` | 额外 MCP 服务器列表，每项见下 |
| `permissionMode` | `workspace-write` | 权限/沙箱模式：`read-only` / `workspace-write` / `danger-full-access`（切换后重启服务生效） |
| `notifyOnComplete` | `true` | 任务完成时发原生通知（窗口不在前台时） |
| `contextWarningEnabled` | `true` | 上下文接近上限时提醒（弹通知 + 状态胶囊警示） |
| `contextWarningTokens` | `100000` | 上下文告警阈值（当前会话累计 tokens；设置 → 桌面端 → 上下文告警 可调） |
| `recentWorkspaces` | `[]` | 最近使用的工作区（菜单 文件 → 最近工作区） |
| `vision` | `null` | 多模态图片识别配置：`{ enabled, baseUrl, apiKey, model }`（OpenAI 兼容接口，专职识别图片） |
| `usagePrices` | `null` | 成本估算单价（$/1M tokens）：`{ input, output, cacheHit }`；null 用 DeepSeek 参考价 |

### 额外 MCP 服务器（mcpServers）

编辑 `settings.json` 的 `mcpServers` 数组（改完重启应用生效），每项：

```json
{
  "serverName": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "xxx" }
}
```

`transport` 为 `streamable-http` 时改用 `url` / `headers`。模型将看到 `mcp__<serverName>__<工具名>`。可选字段：`cwd`、`failOnStartupError`、`toolCallTimeoutMs`、`reconnect`；`enabled: false` 表示停用（不注入）。也可以在**设置页 → MCP 服务器**里可视化增删改与启停。

## 目录结构

```
DeepseekHarness/
├─ main/                  Electron 主进程
│  ├─ main.js             窗口、菜单、IPC、更新流程编排、固定端口、RPC/MCP/插件管理接线
│  ├─ harness.js          dsh web 子进程托管（--patch 注入、探活、进程树清理）
│  ├─ web-patch.js        生成注入 web profile 的补丁（MCP 行 + 设置分区客户端行）
│  ├─ mcp-server.mjs      内置 MCP stdio 服务器（SDK 实现，暴露 mcp__dsh_desktop__* 工具）
│  ├─ desktop-rpc.js      桌面端 RPC 服务（token 鉴权，供 MCP 服务器调用桌面能力）
│  ├─ plugin-cli.js       dsh plugin（pnpm）转发器：harness 插件安装/卸载
│  ├─ usage.js            用量统计（zstd 会话日志解析）+ DeepSeek 余额查询
│  ├─ vision.js           多模态图片识别（OpenAI 兼容视觉模型，附件引用/文件/URL）
│  ├─ ollama.js           Ollama 本地视觉模型集成（官方便携包下载/解压/服务/拉取模型）
│  ├─ notify.js           任务完成通知（会话写入突发检测）
│  ├─ git-runner.js       Git 变更审查（status/diff）
│  ├─ updater.js          registry 版本检查 + npm 安装更新（打包模式内置 npm 运行器）
│  ├─ backup.js           备份与迁移（zip 导出/导入，纯 Node 可单测）
│  ├─ headless.js         终端模式（headless profile）运行器
│  ├─ schedule.js         定时任务/提醒调度器
│  ├─ system.js           Windows 环境体检/修复/环境变量/右键菜单
│  ├─ win-control.js/.cs  Windows 电脑操控助手（C# user32，运行时编译）
│  └─ settings.js         设置读写（文件热加载：外部编辑 settings.json 即时生效）
├─ preload/preload.js     安全的 contextBridge 桥接（window.dshDesktop：状态/更新/MCP/插件/用量/多模态/权限）
├─ renderer/              加载页、终端模式、Git 变更审查窗、截图选区、快速命令框
├─ packages/settings-update/
│                         harness 设置页客户端插件源码（九个分区 + 状态栏胶囊 + 截图按钮）
├─ build/                 图标源（icon.svg 官方鲸鱼冻结件 / icon.png 打包用）
├─ scripts/               测试脚本（见下）
├─ electron-builder.yml   打包配置（asar:false，NSIS + 便携版）
├─ 启动桌面端.bat          一键启动脚本
└─ package.json           app 清单（依赖 @deepseek-ai/dsh）
```

## 测试

- `scripts/test-patch-boot.ps1`：临时 DSH_HOME 启动 `dsh web` + 注入补丁，校验客户端 bundle 分发与 MCP 服务器连接。
- `scripts/test-client-module.js`：纯 Node 单测，校验设置页九个分区（桌面端 / MCP 服务器 / 插件 / 多模态 / 记忆 / 定时任务 / 系统环境 / 备份与迁移 / 用量与账单）与状态栏胶囊、截图按钮的注册与渲染（无需浏览器）。
- `scripts/test-mcp-server.mjs`：端到端 MCP 测试（SDK 客户端 ↔ 内置 MCP 服务器 ↔ 桌面端 RPC，含图片识别/余额/用量工具）。
- `scripts/test-vision.js`：多模态模块测试（mock OpenAI 兼容服务端，文件/附件引用/错误路径）。
- `scripts/test-ollama.js`：Ollama 集成模块测试（mock 本地 API，状态判定与模型解析）。
- `scripts/test-usage.js`：用量统计测试（真实会话日志：zstd 解压、token 汇总、成本估算）。
- `scripts/test-schedule.js`：定时任务调度器纯函数测试（once/daily/interval 触发语义）。
- `scripts/test-system.js`：Windows 环境体检/环境变量/右键菜单状态测试。
- `scripts/test-win-control.js`：电脑操控助手测试（编译、屏幕/窗口/剪贴板/鼠标）。
- `scripts/test-backup.js`：备份与迁移测试（收集、zip 导出、新机器导入合并、非法 zip 拒绝）。
- `scripts/test-context-watch.js`：上下文压力告警测试（阈值决策、活动会话识别、真实 zstd 会话触发/回落）。
- `scripts/test-packaged-boot.ps1`：打包模式冒烟——用打包出的 exe + ELECTRON_RUN_AS_NODE 直接跑打包后的 dsh web，验证 HTTP 就绪（不启动 GUI、不触碰真实 DSH_HOME）。
- `scripts/smoke-test.ps1`：完整冒烟——两次启动验证固定端口稳定、补丁生成、MCP 连接（会结束正在运行的桌面端进程，请先关闭）。

## harness 官方更新后的兼容性（重要）

桌面端的改动分两类，延续性不同：

| 类别 | 内容 | 官方更新后 |
|---|---|---|
| **桌面端自有代码** | `main/`、`preload/`、`renderer/`、`@dsh-desktop/settings-update` 客户端插件 | **不受影响**——更新只替换 `node_modules/@deepseek-ai/dsh`，桌面端代码与插件原样保留；插件在 profiles fallback 里的链接每次启动自动自愈 |
| **注入配置** | `web.patch.yml`（MCP 行 + 客户端行） | **每次启动重新生成**——新版本依然挂载我们的 MCP 与设置分区（补丁引用的是持久化在 settings.json 的配置） |
| **harness 内部能力** | settings 页分区、状态胶囊、输入框截图按钮 | 走官方插槽 API（settings.section / shell.overlay / conversation.input.left）。**官方优先**：注册前检测同名分区，若官方已提供同 id 的功能（如官方自己的"MCP 服务器"页），我们的注册自动让位；即使插槽 API 变化，注册静默失效也不会影响启动 |
| **skills / MCP / 设置** | `~/.dsh/skills/*`、`~/.dsh/AGENTS.md`、settings.json | 与 harness 版本无关，永久生效；官方若内置同名 skill，按名字覆盖策略处理（用户目录同名优先或官方优先，视官方规则） |

原则：**官方推出同功能时以官方为准**（客户端插件自动检测并隐藏自己重复的入口）；桌面端独占的能力（窗口、更新、截图、附件、本地 Ollama、余额/用量）官方没有，会一直保留。

## 常见问题

- **端口冲突？** 桌面端优先复用上次的固定端口（保证热启动），被占用时自动换新端口，不与网页版（默认 3080）冲突。
- **更新失败？** 多为网络问题；可手动执行 `npm install @deepseek-ai/dsh@latest` 后重启应用。
- **想回到网页版？** 终端运行 `npx @deepseek-ai/dsh web` 即可，数据互通。
- **注入补丁导致启动失败？** 桌面端会自动去掉补丁重试一次，保证客户端始终可用；日志（`logs\dsh-web.log`）会记录原因。
- **图片怎么处理？** DeepSeek 模型不支持图片输入。推荐：设置 → 多模态 → **本地视觉模型** 一键安装 Ollama 并拉取模型（qwen2.5vl:7b 约 5.9GB，零 apiKey）；或选任一在线服务商（OpenAI/智谱/百炼/硅基流动等）。启用后 harness 可用 `mcp__dsh_desktop__describe_image` 自主识别图片（附件引用/文件/URL）；建议把该用法写进 桌面端 → 项目说明（AGENTS.md）。直接在输入框粘贴图片目前仍会被 DeepSeek 拒绝，属于已知限制（后续版本计划在请求链路自动改写）。
- **改了 settings.json 没生效？** 设置支持文件热加载（外部编辑即时生效）；如仍不生效请重启应用。注意用支持 UTF-8 的编辑器保存，避免中文乱码。
- **打包成 .exe？** 已支持：`npm run dist` 产出 `release/DSH Desktop-Setup-<版本>.exe`（安装版）与便携版 exe（见上文"打包成真正的 .exe"）。开发迭代仍用 `npm start`，两条路并存、数据互通。
