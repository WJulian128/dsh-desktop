# dsh-desktop 项目地图

## 项目定位
DeepSeek Harness 桌面端（Electron 应用）：原生窗口运行 dsh web，内置更新检查、多厂商模型调度、本地视觉模型、记忆/子代理/定时任务/系统体检等桌面能力；通过 main/mcp-server.mjs（stdio MCP）+ 桌面端 HTTP RPC 向 harness 内模型暴露 `mcp__dsh_desktop__*` 工具。

## 模块划分
- `main/`（主进程，40+ 模块）：main.js 总装（IPC/RPC/菜单/托盘/启动/自动接续）；harness.js 服务控制；web-patch.js 生成 web.patch.yml 注入客户端插件与 MCP；mcp-server.mjs 内置 MCP 工具（stdio）；desktop-rpc.js 桌面端 HTTP RPC 服务
- `preload/preload.js`：contextBridge 暴露 window.dshDesktop（全部 dsh:* IPC 通道 + onPanelRefresh 面板实时刷新信号）
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
- 纯 Node 模块（无 Electron 依赖）放 main/ 顶层并配 scripts/ 单测：project-map、workspace-guard、agents-norms、git-runner、subagent-stream、subagent-center、transcript-check、memory-store、usage、notify 等
- **主线程零解压**：所有会话文件（zstd JSONL）的解压重活一律放 worker（subagent-worker / panel-stream-worker / scan-worker / usage-scan-child / activity-scan-child），主进程只做尾帧小窗口快检——这是"启动不卡"的硬约定
- MCP 工具走 desktop-rpc（Bearer token）；RPC handler 在 main.js startRpc() 注册，MCP 侧在 mcp-server.mjs registerTool
- 面板实时化：主进程关键事件（编辑占用/项目地图/Git/切工作区）经 dsh:panel-refresh 推送（broadcastPanelRefresh），客户端节流刷新
- 会话存储：$DSH_HOME/sessions/<workspaceKey>/<sessionId>/session.jsonl.zstd（拼接 zstd 帧 JSONL）；主会话 dir 名带 session- 前缀，子代理 session 记录顶层带 origin:'subagent'+parentSession
- Git 基线：2026-08-24 已 git init（main 分支），.gitignore 排除 node_modules/release/build/dump/日志/.dsh 运行时状态（.dsh/project-map.md 例外入仓共享）；任务块完成用 git_commit 落提交可回溯

## 已知陷阱
- PowerShell 管道 + Select-Object -First 1 会提前关管道杀死原生命令导致 $LASTEXITCODE=-1（用 Out-String 完整消费）
- 子代理会话文件也是"最新写入"，notify/memory 需排除子代理（isSubagentSessionFile）
- 自动接续防重复：接续消息共享固定模板前缀，匹配必须用去前缀后的唯一部分（任务文本），不能用前 20 字
- 自动接续假成功：粘贴可能被页面静默丢弃——粘贴后必须验证文字进入输入框；发送成功以 transcript（user/message 或 inbox）为准，"输入框清空"不能作为成功证据
- zstd 压缩可压掉重复内容（3MB 'x' → 400B），测试大文件场景要用随机内容
- git 操作用 git-runner.js 白名单封装（main/git-runner.js），不要手拼危险命令

## 重点文件职责摘要
- main/project-map.js：项目代码地图存储与 stale 指纹判定（.dsh/project-map.md + state.json；saveMap 增量合并指纹，tracked 返回合并后总数）
- main/workspace-guard.js：多会话编辑占用（claims.json，30min 过期）+ 变更日志（change-journal.jsonl）
- main/agents-norms.js：把地图/并发/Git 纪律作为版本化块幂等写入全局与项目 AGENTS.md（v3）
- main/git-runner.js：runGit + gitSummary + 白名单安全操作（init/status/diff/log/commit/branch/checkout/restore/stash）
- main/subagent-stream.js：子代理推理流读取（缓存+增量续读，listSubagentStream 输出 parentSession）
- main/panel-stream-worker.js：面板流 worker（list/since/contains 三任务），缓存常驻 worker；主线程经 panelStreamTask 派发
- main/transcript-check.js：会话 transcript 内容检查（sessionContainsText 尾帧快检/全量两种模式，只匹配 user/message 与 inbox，绝不匹配 tool/call）
- main/vision.js：视觉识别 + readCurrentModel（尾帧快检优先，尾部无模型记录才回退全量解压）
- main/mcp-server.mjs：registerTool 注册全部 dsh_desktop_* 工具（call() 走桌面 RPC，text() 6000 字截断）
- main/main.js：startRpc() 注册 RPC（变更事件广播面板刷新）；injectAndSendOnce/autoResumeInject 自动接续（粘贴验证 + transcript 确认 + 幂等重试）；web-ready 经 rpcPromptCurrentSession（20s 窗口）直发优先
- packages/settings-update/client.js：SchedPanel 按 props.sessionId 过滤子代理（parentSession）；EnvPanel 含 Git/项目地图/编辑占用行（5s 高频 + 推送；usage 60s/activity 20s 降频）
- renderer/git-diff.html：Git 变更窗（分支/提交/回滚/复制 + 其他会话占用警告横幅）
- scripts/test-project-map.js、test-workspace-guard.js、test-transcript-check.js：新模块单测
- .gitignore：排除依赖/构建产物/本地运行时状态；保留 .dsh/project-map.md 共享
