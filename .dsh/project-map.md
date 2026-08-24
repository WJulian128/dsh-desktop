# dsh-desktop 项目地图

## 项目定位
DeepSeek Harness 桌面端（Electron 应用）：原生窗口运行 dsh web，内置更新检查、多厂商模型调度、本地视觉模型、记忆/子代理/定时任务/系统体检等桌面能力；通过 main/mcp-server.mjs（stdio MCP）+ 桌面端 HTTP RPC 向 harness 内模型暴露 `mcp__dsh_desktop__*` 工具。含 GitHub 集成：设备码登录、私有远程仓库、代码搜索、分支协作。

## 模块划分
- `main/`（主进程，40+ 模块）：main.js 总装（IPC/RPC/菜单/托盘/启动/自动接续）；harness.js 服务控制；web-patch.js 生成 web.patch.yml 注入客户端插件与 MCP；mcp-server.mjs 内置 MCP 工具（stdio）；desktop-rpc.js 桌面端 HTTP RPC 服务；github.js GitHub 设备码登录/仓库/搜索/重命名（纯 Node 可测）
- `preload/preload.js`：contextBridge 暴露 window.dshDesktop（全部 dsh:* IPC 通道 + onPanelRefresh 面板实时刷新信号 + github* 桥 + openExternal）
- `renderer/`：加载页/终端/Git 窗（git-diff.html）/截图选区
- `packages/settings-update/`：设置页（9 分区，含「GitHub 与 Git」）+ 右侧常驻面板客户端插件（client.js，React，经 web-patch 注入）
- `packages/subagent-approval/`、`packages/llm-openai-compat/`：子代理审批桥 / 通用 OpenAI 兼容厂商 adapter
- `scripts/`：测试（test-*.js/mjs）+ 打包冒烟 + install-skills.mjs（多来源 skills 安装器）

## 入口
- Electron 入口：main/main.js（package.json "main"）
- harness：node_modules/@deepseek-ai/dsh/lib/bin.js（BIN_PATH；打包模式用 %APPDATA%\dsh-desktop\dsh）
- 开发启动：npm start；打包：npm run pack（解包）/ npm run dist（NSIS+便携，release/）
- 测试命令：node scripts/test-*.js（全部独立可跑）

## 关键约定
- ⚠️ 编码红线：.ps1/.js 源文件禁止 PowerShell 5.1 Get-Content/Set-Content 往返（UTF-8 无 BOM 被当 GBK）；.ps1 含中文必须带 UTF-8 BOM 或纯 ASCII；改文件一律用 read/edit/write 工具或 Node 显式 utf8
- **代码一致性**：多轮编码按 code-consistency skill 工作——约定快照在 `.dsh/code-conventions.md`（每轮写码前必读、新决策回写、memory 实体同步）
- 客户端插件源码在 packages/settings-update/，node_modules/@dsh-desktop/settings-update 是指向它的 junction，勿改 node_modules 副本
- 改 main 进程代码需重启桌面端生效；改 client.js 重启服务即可（restart_app 带 task 自动接续）
- 纯 Node 模块（无 Electron 依赖）放 main/ 顶层并配 scripts/ 单测；网络调用走注入式 transport（github.js setTransportForTest）
- **主线程零解压**：zstd 解压重活一律 worker/child 化（panel-stream-worker / scan-worker / usage-scan-child / activity-scan-child）
- MCP 工具走 desktop-rpc（Bearer token）；RPC handler 在 main.js startRpc() 注册，MCP 侧在 mcp-server.mjs registerTool
- 面板实时化：主进程关键事件经 dsh:panel-refresh 推送，客户端节流刷新
- 会话存储：$DSH_HOME/sessions/<workspaceKey>/<sessionId>/session.jsonl.zstd；子代理 session 记录顶层带 origin:'subagent'+parentSession
- Git/GitHub：token 存 $DSH_HOME/.github-auth.json（绝不入库/打日志）；push 禁 force、pull --ff-only；设备码 client_id 复用 gh CLI 公开 id（scope: repo）；仓库默认私有
- 规范块 agents-norms v5：项目地图/多会话防护/Git+GitHub+分支工作流/调度面板/多轮代码一致性

## 已知陷阱
- PowerShell 管道 + Select-Object -First 1 会提前关管道杀死原生命令导致 $LASTEXITCODE=-1（用 Out-String 完整消费）
- 子代理会话文件也是"最新写入"，notify/memory 需排除子代理（isSubagentSessionFile）
- 自动接续防重复：匹配必须用去前缀后的唯一部分；发送成功以 transcript 为准，"输入框清空"不能作为成功证据
- zstd 压缩可压掉重复内容（3MB 'x' → 400B），测试大文件场景要用随机内容
- git 操作用 git-runner.js 白名单封装；GitHub API 需 User-Agent 头
- GitHub 设备流：authorization_pending 继续轮询、slow_down 加大间隔、expired_token 重新发起
- git status 分支行形态多变：`## main`（无上游）/ `## main...origin/main`（无差异）/ `## main...origin/main [ahead 1]`（有领先）/ `[behind N]`（仅落后）——parseGitSummary 已兼容，分支展示只取 ... 前本地名
- 面板 Git 组「非 Git 工作区」排查：dsh:git-summary IPC 有诊断日志（[git-summary] ok/失败 + head），先看日志再改代码

## 重点文件职责摘要
- main/project-map.js：项目代码地图存储与 stale 指纹判定（.dsh/project-map.md + state.json）
- main/workspace-guard.js：多会话编辑占用（claims.json，30min 过期）+ 变更日志（change-journal.jsonl）
- main/agents-norms.js：桌面端自动规范块 v5 幂等写入全局与项目 AGENTS.md（启动时自动补齐）
- main/github.js：设备码登录（deviceFlowStart/Poll）、token 存取（.github-auth.json）、whoami/createRepo/renameRepo/searchCode/status、suggestRepoName
- main/git-runner.js：runGit + gitSummary + 白名单安全操作（init/status/diff/log/commit/branch/checkout/restore/stash + currentBranch/remoteList/remoteAdd/push/pull --ff-only/merge）
- main/subagent-stream.js：子代理推理流读取（缓存+增量续读，输出 parentSession）
- main/panel-stream-worker.js：面板流 worker（list/since/contains），缓存常驻 worker
- main/transcript-check.js：会话 transcript 内容检查（尾帧快检/全量，只匹配 user/message 与 inbox）
- main/vision.js：视觉识别 + readCurrentModel（尾帧快检优先）
- main/mcp-server.mjs：registerTool 注册全部 dsh_desktop_* 工具（含 github_status/login/login_wait/remote_setup/search_code 与 git_push/pull/merge/remote）
- main/main.js：startRpc() 注册 RPC（github* + git*）；registerDesktopFeatureIpc() 注册 github IPC + git-summary 诊断日志；auto-resume 接续
- packages/settings-update/client.js：SchedPanel 按 parentSession 过滤；EnvPanel 含 Git/项目地图/编辑占用/GitHub 组（parseGitSummary 兼容无括号分支行）；GithubSection 设置分区
- renderer/git-diff.html：Git 变更窗（分支/提交/回滚/复制 + 占用警告横幅）
- scripts/test-github.js：github.js 单测（注入式 transport）
- scripts/install-skills.mjs：多来源 skills 安装器
- .dsh/code-conventions.md：代码约定快照
- .gitignore：排除依赖/构建产物/本地运行时状态；保留 .dsh/project-map.md 共享
