# dsh-desktop 项目地图

## 项目定位
DeepSeek Harness 桌面端（Electron 应用）：原生窗口运行 dsh web，内置更新检查、多厂商模型调度、本地视觉模型、记忆/子代理/定时任务/系统体检等桌面能力；通过 main/mcp-server.mjs（stdio MCP）+ 桌面端 HTTP RPC 向 harness 内模型暴露 `mcp__dsh_desktop__*` 工具。

## 模块划分
- `main/`（主进程，40+ 模块）：main.js 总装（IPC/RPC/菜单/托盘/启动）；harness.js 服务控制；web-patch.js 生成 web.patch.yml 注入客户端插件与 MCP；mcp-server.mjs 内置 MCP 工具（stdio）；desktop-rpc.js 桌面端 HTTP RPC 服务
- `preload/preload.js`：contextBridge 暴露 window.dshDesktop（全部 dsh:* IPC 通道）
- `renderer/`：加载页/终端/Git 窗（git-diff.html）/截图选区
- `packages/settings-update/`：设置页 + 右侧常驻面板客户端插件（client.js，React，经 web-patch 注入）
- `packages/subagent-approval/`、`packages/llm-openai-compat/`：子代理审批桥 / 通用 OpenAI 兼容厂商 adapter
- `scripts/`：测试（test-*.js/mjs）+ 打包冒烟（test-packaged-boot.ps1、smoke-test.ps1）+ install-skills.mjs

## 入口
- Electron 入口：main/main.js（package.json "main"）
- harness：node_modules/@deepseek-ai/dsh/lib/bin.js（BIN_PATH；打包模式用 %APPDATA%\dsh-desktop\dsh）
- 开发启动：npm start；打包：npm run pack（解包）/ npm run dist（NSIS+便携，release/）
- 测试命令：node scripts/test-*.js（全部独立可跑）

## 关键约定
- ⚠️ 编码红线：.ps1/.js 源文件禁止 PowerShell 5.1 Get-Content/Set-Content 往返（UTF-8 无 BOM 被当 GBK）；.ps1 含中文必须带 UTF-8 BOM 或纯 ASCII；改文件一律用 read/edit/write 工具或 Node 显式 utf8
- 客户端插件源码在 packages/settings-update/，node_modules/@dsh-desktop/settings-update 是指向它的 junction，勿改 node_modules 副本
- 改 main 进程代码需重启桌面端生效；改 client.js 重启服务即可（mcp__dsh_desktop__restart_app 带 task 可自动接续）
- 纯 Node 模块（无 Electron 依赖）放 main/ 顶层并配 scripts/ 单测：project-map、workspace-guard、agents-norms、git-runner、subagent-stream、subagent-center、memory-store、usage、notify 等
- MCP 工具走 desktop-rpc（Bearer token）；RPC handler 在 main.js startRpc() 注册，MCP 侧在 mcp-server.mjs registerTool
- 会话存储：$DSH_HOME/sessions/<workspaceKey>/<sessionId>/session.jsonl.zstd（拼接 zstd 帧 JSONL）；主会话 dir 名带 session- 前缀，子代理 session 记录有 origin:'subagent'+parentSession
- Git 基线：2026-08-24 已 git init（main 分支），.gitignore 排除 node_modules/release/build/dump/日志/.dsh 运行时状态（.dsh/project-map.md 例外入仓共享）；任务块完成用 git_commit 落提交可回溯

## 已知陷阱
- PowerShell 管道 + Select-Object -First 1 会提前关管道杀死原生命令导致 $LASTEXITCODE=-1（用 Out-String 完整消费）
- 子代理会话文件也是"最新写入"，notify/memory 需排除子代理（isSubagentSessionFile）
- git 操作用 git-runner.js 白名单封装（main/git-runner.js），不要手拼危险命令

## 重点文件职责摘要
- main/project-map.js：项目代码地图存储与 stale 指纹判定（.dsh/project-map.md + state.json）
- main/workspace-guard.js：多会话编辑占用（claims.json，30min 过期）+ 变更日志（change-journal.jsonl）
- main/agents-norms.js：把地图/并发/Git 纪律作为版本化块幂等写入全局与项目 AGENTS.md（v3）
- main/git-runner.js：runGit + gitSummary + 白名单安全操作（init/status/diff/log/commit/branch/checkout/restore/stash）
- main/subagent-stream.js：子代理推理流读取（缓存+增量续读，listSubagentStream 输出 parentSession）
- main/mcp-server.mjs：registerTool 注册全部 dsh_desktop_* 工具（call() 走桌面 RPC，text() 6000 字截断）
- main/main.js：startRpc() 注册 RPC；registerDesktopFeatureIpc() 注册 git/项目地图/编辑占用 IPC；main() 启动时 ensureNorms
- packages/settings-update/client.js：SchedPanel 按 props.sessionId 过滤子代理（parentSession）；EnvPanel 含 Git/项目地图/编辑占用行
- renderer/git-diff.html：Git 变更窗（分支/提交/回滚/复制 + 其他会话占用警告横幅）
- scripts/test-project-map.js、test-workspace-guard.js：新模块单测
- .gitignore：排除依赖/构建产物/本地运行时状态；保留 .dsh/project-map.md 共享
