# dsh-desktop 项目地图

## 项目定位
DeepSeek Harness 桌面端（Electron 应用）：原生窗口运行 dsh web，内置更新检查、多厂商模型调度、本地视觉模型、记忆/子代理/定时任务/系统体检等桌面能力；通过 main/mcp-server.mjs（stdio MCP）+ 桌面端 HTTP RPC 向 harness 内模型暴露 `mcp__dsh_desktop__*` 工具。含 GitHub 集成与 UI 内省能力（读自己窗口 DOM 精确定位/点击/验证）。

## 模块划分
- `main/`（主进程，40+ 模块）：main.js 总装（IPC/RPC/菜单/托盘/启动/自动接续 + client-debug 诊断通道 + UI 内省 RPC）；harness.js 服务控制；web-patch.js 生成 web.patch.yml 注入客户端插件与 MCP；mcp-server.mjs 内置 MCP 工具（stdio）；desktop-rpc.js 桌面端 HTTP RPC 服务；github.js GitHub 设备码登录/仓库/搜索/重命名/可见性；ui-introspect.js UI 内省注入脚本构造器（快照/点击/读文本，纯 Node 可测）
- `preload/preload.js`：contextBridge 暴露 window.dshDesktop（dsh:* IPC + onPanelRefresh + github* 桥 + openExternal + clientDebug）
- `renderer/`：加载页/终端/Git 窗（git-diff.html）/截图选区
- `packages/settings-update/`：设置页（9 分区，含「GitHub 与 Git」）+ 右侧常驻面板客户端插件（client.js；导出 _parseGitSummary 供单测）
- `packages/subagent-approval/`、`packages/llm-openai-compat/`：子代理审批桥 / 通用 OpenAI 兼容厂商 adapter
- `scripts/`：测试（test-*.js/mjs）+ 打包冒烟 + install-skills.mjs + rewrite-history.js

## 入口
- Electron 入口：main/main.js（package.json "main"）
- harness：node_modules/@deepseek-ai/dsh/lib/bin.js（BIN_PATH；打包模式用 %APPDATA%\dsh-desktop\dsh）
- 开发启动：npm start；打包：npm run pack（解包）/ npm run dist（NSIS+便携，release/）
- 测试命令：node scripts/test-*.js（全部独立可跑）

## 关键约定
- ⚠️ 编码红线：.ps1/.js 源文件禁止 PowerShell 5.1 Get-Content/Set-Content 往返；.ps1 含中文必须带 UTF-8 BOM 或纯 ASCII；改文件一律用 read/edit/write 工具或 Node 显式 utf8
- **代码一致性**：多轮编码按 code-consistency skill 工作——约定快照 `.dsh/code-conventions.md`（每轮写码前必读、新决策回写、memory 同步）
- 客户端插件源码在 packages/settings-update/；harness 实际打包 $DSH_HOME/profiles/node_modules/@dsh-desktop/settings-update 副本（桌面端启动时同步），改源码必须重启桌面端
- 改 main 进程代码需重启桌面端生效；restart_app 带 task 自动接续
- 纯 Node 模块放 main/ 顶层并配 scripts/ 单测；网络调用走注入式 transport（github.js setTransportForTest）
- **主线程零解压**：zstd 解压重活一律 worker/child 化
- **UI 内省约定**：操作桌面端自己窗口优先 mcp__dsh_desktop__ui_snapshot/ui_click/ui_text/ui_capture（DOM 定位，不猜坐标、不靠 OCR）；外部窗口才用 computer_* 屏幕工具；computer_screenshot 支持 target:'self' 截自己窗口
- MCP 工具走 desktop-rpc（Bearer token）；RPC 在 main.js startRpc()，MCP 侧在 mcp-server.mjs registerTool
- 面板实时化：主进程关键事件经 dsh:panel-refresh 推送；面板数据可用 client-debug 回报日志排查
- 会话存储：$DSH_HOME/sessions/<workspaceKey>/<sessionId>/session.jsonl.zstd；子代理 session 记录顶层带 origin:'subagent'+parentSession
- Git/GitHub：远程 github.com/WJulian128/dsh-desktop（完全公开）；token 存 $DSH_HOME/.github-auth.json；push 禁 force、pull --ff-only
- 历史已重写（wj021 全部清除）；勿把个人路径/用户名写进提交
- 规范块 agents-norms v5

## 已知陷阱
- PowerShell 管道 + Select-Object -First 1 会提前关管道杀死原生命令导致 $LASTEXITCODE=-1（用 Out-String 完整消费）
- ⚠️ **git status 解析红线**：小节头判定必须用 `/^#\s/`（# + 空格）——分支行「## main...」也是 # 开头，用 startsWith('#') 会把它当小节头提前 break → 解析恒 null → 面板永远「非 Git 工作区」（2026-08-25 修复，test-client-module 4 项回归）
- 子代理会话文件也是"最新写入"，notify/memory 需排除子代理（isSubagentSessionFile）
- 自动接续防重复：匹配用去前缀唯一部分；发送成功以 transcript 为准
- zstd 压缩可压掉重复内容，测试大文件场景用随机内容
- git 操作用 git-runner.js 白名单封装；GitHub API 需 User-Agent 头；owner/repo 分段 encodeURIComponent
- GitHub 设备流：authorization_pending 轮询、slow_down 加大间隔、expired_token 重新发起
- ⚠️ 屏幕截图不可靠（ChatGPT 与 DSH 全屏重叠会截错窗口）——桌面端自己窗口用 ui_capture/target:self
- git status 分支行形态多变（无上游/ahead/behind），parseGitSummary 已全部兼容

## 重点文件职责摘要
- main/project-map.js：代码地图存储与 stale 指纹判定（.dsh/project-map.md + state.json）
- main/workspace-guard.js：多会话编辑占用 + 变更日志
- main/agents-norms.js：桌面端自动规范块 v5 幂等写入全局与项目 AGENTS.md
- main/github.js：设备码登录、token 存取、whoami/createRepo/renameRepo/setRepoVisibility/getRepo/searchCode、parseRepoFullName、suggestRepoName
- main/git-runner.js：runGit + gitSummary + 白名单安全操作（含 push/pull --ff-only/merge/remote）
- main/subagent-stream.js：子代理推理流读取（输出 parentSession）
- main/panel-stream-worker.js：面板流 worker（list/since/contains）
- main/transcript-check.js：会话 transcript 内容检查（尾帧快检/全量）
- main/vision.js：视觉识别 + readCurrentModel（尾帧快检优先）
- main/ui-introspect.js：UI 内省注入脚本（snapshotScript/clickScript/textScript/normalizeSnapshot）
- main/mcp-server.mjs：全部 dsh_desktop_* 工具（含 github_*、ui_snapshot/ui_click/ui_text/ui_capture）
- main/main.js：startRpc()（ui*/github*/git*/地图/占用）；registerDesktopFeatureIpc()；auto-resume 接续；computerScreenshot target:self
- packages/settings-update/client.js：parseGitSummary（/^#\s/ 小节头）；EnvPanel 五组（Git/地图/占用/GitHub）；SchedPanel 按 parentSession 过滤；GithubSection
- renderer/git-diff.html：Git 变更窗（提交/回滚/分支 + 占用警告）
- scripts/test-ui-introspect.js：UI 内省单测 11 项（fake DOM）
- scripts/test-client-module.js：bundle 加载 + 分区注册 + _parseGitSummary 回归
- scripts/test-github.js：github.js 单测（注入式 transport）
- scripts/install-skills.mjs：多来源 skills 安装器
- scripts/rewrite-history.js：filter-branch 历史重写助手
- .dsh/code-conventions.md：代码约定快照
- .gitignore：排除依赖/构建产物/本地运行时状态；保留 .dsh/project-map.md 共享
