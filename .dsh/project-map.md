# dsh-desktop 项目地图

## 项目定位
DeepSeek Harness 桌面端（Electron 应用）：原生窗口运行 dsh web，内置更新检查、多厂商模型调度、本地视觉模型、记忆/子代理/定时任务/系统体检等桌面能力；通过 main/mcp-server.mjs（stdio MCP）+ 桌面端 HTTP RPC 向 harness 内模型暴露 `mcp__dsh_desktop__*` 工具。含 GitHub 集成、UI 内省能力（读自己窗口 DOM 精确定位/点击/验证）、外部机器人桥（QQ 官方机器人双向对话 + 企业微信单向推送）。

## 模块划分
- `main/`（主进程，40+ 模块）：main.js 总装（IPC/RPC/菜单/托盘/启动/自动接续 + client-debug 诊断通道 + UI 内省 RPC + 截图链路 + 机器人桥接线 + **升级事务/启动冒烟/一键回滚**）；harness.js 服务控制（行缓冲 + webUrl 捕获 + 最近输出环形缓冲）；web-patch.js 生成 web.patch.yml 注入客户端插件与 MCP；harness-rpc.js /api RPC 双风格信封自适应（纯函数）；upgrade-guard.js 升级防护状态与启动失败分类（纯函数）；boot-preflight.js 启动前自检（profiles 插件链接 + 本地依赖自愈）；plugin-deps.js 插件本地依赖补装；mcp-server.mjs 内置 MCP 工具（stdio）；desktop-rpc.js 桌面端 HTTP RPC 服务；github.js GitHub 设备码登录/仓库/搜索/重命名/可见性；ui-introspect.js UI 内省注入脚本构造器；notify.js 任务完成通知（回合结束判定）
- `main/bot-gateway/`：外部机器人桥——qq-gateway.js（QQ 官方 v2 API + WebSocket 网关）、wechat-push.js（企业微信 webhook 推送）、reply-bridge.js（注入会话→等回复→回推）
- `preload/preload.js`：contextBridge 暴露 window.dshDesktop（dsh:* IPC + onPanelRefresh + github* 桥 + openExternal + clientDebug + onRescueProgress + bot* 桥）
- `renderer/`：加载页/终端/Git 窗（git-diff.html）/截图选区（capture.html 冻结画面+选区）
- `packages/settings-update/`：设置页（10 分区，含「GitHub 与 Git」「机器人」）+ 右侧常驻面板客户端插件（client.js；导出 _parseGitSummary 供单测；截图按钮 + 拒收补救 + 插话按钮）
- `packages/subagent-approval/`、`packages/llm-openai-compat/`：子代理审批桥 / 通用 OpenAI 兼容厂商 adapter
- `scripts/`：测试（test-*.js/mjs，35 项）+ **check-harness-contract.js（官方契约体检，升级前后必跑）** + scripts/office-com/word.ps1（Word COM 自动化，纯 ASCII）+ 打包冒烟 + install-skills.mjs + rewrite-history.js
- `UPGRADE-PLAYBOOK.md`：harness 升级处置手册（升级前后 checklist / 故障树 / 官方契约清单）——每次 dsh 升级参照执行
- **Office 能力（双通道）**：main/office-docx.js（文件级：docx 读/markdown→docx/xlsx 读写，mammoth+docx+exceljs）+ main/office-com.js（Word/WPS COM：detect/verify/export-pdf/open，exec 注入可测）；RPC 'office' 单口分发 → 8 个 MCP 工具

## 入口
- Electron 入口：main/main.js（package.json "main"）
- harness：node_modules/@deepseek-ai/dsh/lib/bin.js（BIN_PATH；打包模式用 %APPDATA%\dsh-desktop\dsh）
- 开发启动：npm start；打包：npm run pack（解包）/ npm run dist（NSIS+便携，release/）
- 测试命令：node scripts/test-*.js（全部独立可跑）

## 关键约定
- ⚠️ 编码红线：.ps1/.js 源文件禁止 PowerShell 5.1 Get-Content/Set-Content 往返；.ps1 含中文必须带 UTF-8 BOM 或纯 ASCII；改文件一律用 read/edit/write 工具或 Node 显式 utf8
- **代码一致性**：多轮编码按 code-consistency skill 工作——约定快照 `.dsh/code-conventions.md`（每轮写码前必读、新决策回写、memory 同步）
- 客户端插件源码在 packages/（settings-update/llm-openai-compat/subagent-approval）；桌面端启动前由 boot-preflight.js 维护 $DSH_HOME/profiles/node_modules/@dsh-desktop/* junction——settings-update 目标优先 packages/ 源目录（node_modules file: 依赖可能被 npm 重装成普通拷贝，指向拷贝会吃不到源码改动）；改客户端插件源码后需重启桌面端
- **harness 升级/回滚纪律（2026-09-05 事故后）**：applyUpdate=后台自动流水线（无感，UI 仅"更新中…"）：预检→停服→npm install→自动加载新版本→冒烟验收（token cookie 换取 + session.list）→通过记 lastKnownGoodVersion；安装失败/冒烟未过且存在 prev → 自动回滚一次（熔断）；结果出口唯一 presentUpdateOutcome（通知 + userInitiated 时结果弹窗含官方变更摘要），不 relaunch；用户"保留当前版本"记 dismissRollbackVersion 同版本不再弹窗；启动前必跑 bootPreflight.runBootPreflight 自检（只在 startHarness 内，勿重复调用）；rpc applyUpdate 支持 force 重装当前版本
- **RPC 认证失效自愈链**：ready 后 harness 重新打印 'dsh web:' 新 URL → 同步 state.webUrl + 重铸 cookie；401 重铸失败且就绪超 20s → 自动重启 harness（10 分钟冷却、重启前 writeAutoResumeIfNeeded('rpc-auth') 保进行中回合可接续）；launchHarness 的 log 监听是唯一 URL 跟进点
- **/api RPC 双风格自适应**：一切官方 RPC 走 main.js rpcCall → harness-rpc.js（0.1.2-rc.1+：namespace/method + {args:{_request|request}}；旧版：点分 + payload 透传）；风格/参数名错误特征（gateway/bad-request、arguments-invalid、404）只重试一次并记忆；新增调用端点一律在 harness-rpc.js 的 ARGS_KEY_OVERRIDES 登记
- **本地插件依赖不靠根提升**：Loader 0.1.2-rc.1 起从插件真实目录向上解析；deps 声明在插件自身 package.json，缺失由 plugin-deps.js 本地补装（根 postinstall + 启动前自检共用）
- 改 main 进程代码需重启桌面端生效；restart_app 带 task 自动接续
- 纯 Node 模块放 main/ 顶层并配 scripts/ 单测；网络调用走注入式 transport（github.js setTransportForTest、bot-gateway 构造参数注入）
- **主线程零解压**：zstd 解压重活一律 worker/child 化
- **UI 内省约定**：操作桌面端自己窗口优先 mcp__dsh_desktop__ui_snapshot/ui_click/ui_text/ui_capture（DOM 定位，不猜坐标、不靠 OCR）；外部窗口才用 computer_* 屏幕工具；computer_screenshot 支持 target:'self' 截自己窗口
- MCP 工具走 desktop-rpc（Bearer token）；RPC 在 main.js startRpc()，MCP 侧在 mcp-server.mjs registerTool（handler 内 call('method', args)）
- 面板实时化：主进程关键事件经 dsh:panel-refresh 推送；面板数据可用 client-debug 回报日志排查
- 会话存储：$DSH_HOME/sessions/<workspaceKey>/<sessionId>/session.jsonl.zstd；子代理 session 记录顶层带 origin:'subagent'+parentSession
- Git/GitHub：远程 github.com/WJulian128/dsh-desktop（完全公开）；token 存 $DSH_HOME/.github-auth.json；push 禁 force、pull --ff-only
- **git 全局代理**：git config --global http.proxy/https.proxy = socks5h://127.0.0.1:7897（本机直连 github.com TCP 通但 TLS 握手被重置；代理软件退出则推送失败，重开代理即可）
- 历史已重写（wj021 全部清除）；勿把个人路径/用户名写进提交
- 规范块 agents-norms v5
- **截图补救拒绝文案精确匹配**：`当前模型不支持图片|图片发送失败（`（harness i18n image.modelUnsupported/image.sendFailed，位于 $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js）——绝不能用宽子串（对话流引用文案会误报）
- **机器人配置**：settings 键 qqBot{appId,appSecret,enabled} / wechatPush{webhookUrl,enabled,pushOnComplete}；QQ 凭据仅存本机 settings.yaml

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
- ⚠️ **完成通知判定**：harness 每次工具调用前都会落盘一条 assistant/message（文字段落，后一条 100% 是 tool/call）——判定"回合完成"必须要求 assistant/message 后跟回合结束帧（主会话 step/end、子代理 turn/end），否则思考/工具往返的静默间隙会误弹"任务完成"（2026-08-25 修复）
- ⚠️ **截图闪回**：2.5s 安全阀/延迟 show 回调必须校验 captureFlowToken（closeCaptureWindow 作废流程），否则快速截完图后窗口被重新弹出露出上一次冻结画面
- ⚠️ **UTF-8 截断**：按字节截断多字节文本时，结尾落在字符**首字节**（0xC0-0xF7）不会触发"去后续字节"循环 → 产生 U+FFFD。逐字符按字节预算拼接最稳（wechat-push.truncateUtf8Bytes 已踩坑修复）
- QQ 机器人：C2C 被动回复窗口 5 分钟（先占位回复保主动额度，每月仅 4 条/用户）；群 AT 被动窗口仅 5 秒（群回复必然走主动消息）；token 过期 7200s 需缓存刷新；Node ≥22 内置 WebSocket（无需 ws 依赖）
- ⚠️ **0.1.2-rc.1 web token 认证**：dsh web 子进程打印的完整 URL 带 ?token=，页面与 /api 都要先 GET 它换取 dsh-auth-* cookie（HMAC 签名、有效期 30 天、按 Host 绑定、与 launch token 解耦）。实测 launch token 会**静默轮换且不重打印 URL**（进程未重启也会；两轮重启测量有效窗口≈启动后数十秒，冒烟在 +1.5s 每次成功、外部无 cookie 探测在 +60~90s 已 401），但 cookie 一旦铸好就独立生效——桌面端只在启动早期换一次 cookie（launchHarness + 冒烟），之后 401 强制重换换不到时（token 已轮换）重启桌面端即可恢复
- ⚠️ **npm file: 依赖形态漂移（已修复）**：node_modules/@dsh-desktop/settings-update 可能是 junction 也可能是普通拷贝（npm 行为随版本/install-links 变）；boot-preflight.ensurePackageLink 自 2026-09-05 起把“链接是否指向当前最优候选（packages/ 源）”作为可用性判据——指向旧拷贝/悬挂一律重建，保证 packages/ 源码改动即时生效（曾实测 9/5 后 client.js 改动全部失效）
- ⚠️ **面板活动按会话取数**：EnvPanel「本会话活动」经 dsh:activity-get 携带 sessionId（主进程只扫该会话文件，返回附带 sessionId）；无 sessionId 回退最新活动会话并在标题标注「最近活动」；切会话 effect 先清旧活动防闪现串台。面板「会话」行显示官方注入的 props.sessionId（0.1.2 session 作用域槽位确实注入，实测 session-464a）
- ⚠️ **沙箱 EPERM 假失败**：在受限沙箱里跑 scripts/test-*.js，凡 spawn 外部进程（zstd/win-control/MCP stdio）的用例报 EPERM——不是代码回归，提权复验
- ⚠️ **loader entry 失败=致命**：0.1.2-rc.1 起插件树里任何 loader entry 导入失败都会让整个 harness 退出（旧版容忍）；升级后“启动不了”优先查 dsh-web.log 里的 plugin tree/loader entry/ERR_MODULE_NOT_FOUND

## 重点文件职责摘要
- main/project-map.js：代码地图存储与 stale 指纹判定（.dsh/project-map.md + state.json）
- main/workspace-guard.js：多会话编辑占用 + 变更日志
- main/agents-norms.js：桌面端自动规范块 v5 幂等写入全局与项目 AGENTS.md
- main/github.js：设备码登录、token 存取、whoami/createRepo/renameRepo/setRepoVisibility/getRepo/searchCode、parseRepoFullName、suggestRepoName
- main/git-runner.js：runGit + gitSummary + 白名单安全操作（含 push/pull --ff-only/merge/remote）
- main/subagent-stream.js：子代理推理流读取（输出 parentSession）
- main/panel-stream-worker.js：面板流 worker（list/since/contains）
- main/transcript-check.js：会话 transcript 内容检查（尾帧快检/全量）
- main/vision.js：视觉识别（describeImage/preprocessImage 长边 1280 降采样）+ readCurrentModel（尾帧快检优先）
- main/ui-introspect.js：UI 内省注入脚本（snapshotScript/clickScript/textScript/normalizeSnapshot）
- main/notify.js：任务完成通知——classifyLastRecord 要求 assistant/message 后跟 step/end|turn/end 才 round-done；CONVERSATION_TYPES 含 tool-call-chunks；startCompletionWatcher 静默 idleMs 判定 + scan worker 异步尾部扫描
- main/bot-gateway/qq-gateway.js：QQ 官方机器人网关——getAccessToken（7200s 缓存）、getGatewayUrl、WebSocket 状态机（Hello→Identify→READY/心跳/RESUME 重连退避）、事件归一化（C2C/群AT/频道，去 <@!id> 提及）、sendText 三类目标；注入式 httpTransport/wsFactory 可测
- main/bot-gateway/wechat-push.js：企微 webhook markdown 推送（errcode 45009 限流不重试、其他错误重试一次、truncateUtf8Bytes 4096 字节逐字符截断）
- main/bot-gateway/reply-bridge.js：ReplyBridge（注入→轮询会话文件→extractReplyAfter 等 step/end 提取回复，串行队列防错位）+ findSessionFile
- main/mcp-server.mjs：全部 dsh_desktop_* 工具（github_*、ui_*、wechat_push、bot_status、更新三件套、office/docx/xlsx/word 八件套等；每工具先 call('method') 走 desktop-rpc）
- main/main.js：startRpc()（ui*/github*/git*/地图/占用/wechatPush/botStatus/office/docx/xlsx/word 分发）；registerDesktopFeatureIpc()（含 bot-config/set/test 系列）；auto-resume 接续；computerScreenshot target:self；**截图链路**：dsh:screenshot（captureFlowToken 防闪回）→ capture-region → screenshot-ready；screenshot-rescue 并行识别 + rescue-progress；**机器人桥接线**：applyBotConfig/readBotConfig、handleQqMessage（占位→注入→分段回推）、pushLatestReplyToWechat（notify onComplete 触发）；**升级防护接线**：applyUpdate（后台流水线：installOnce/bootAndSmoke/自动回滚熔断 + presentUpdateOutcome 结果出口）、checkUpdateGuard（applied 等冒烟）、postBootSmoke/promptRollback/afterBootFailure、startHarness 前 runBootPreflight
- main/harness.js：HarnessController（行缓冲解析子进程输出、捕获 'dsh web: ' token URL、recentLog 环形缓冲供失败诊断、webUrl 最多等 8s）+ pickFreePort/waitForHttp
- main/harness-rpc.js：buildRequest/classifyResponse/argsKeyFor/splitMethod（双风格端点信封 + 响应错误分类，纯函数）
- main/upgrade-guard.js：guardForUpdate/markApplied/shouldSmoke/triageUpgradeBootFailure/classifyBootFailure + KEYS（updateGuard/lastKnownGoodVersion）
- main/boot-preflight.js：DESKTOP_PLUGINS 清单 + ensurePackageLink/ensureProfilePluginLinks/ensureLocalPluginDeps/runBootPreflight（启动前自检自愈，纯 Node 可单测）
- main/plugin-deps.js：resolvableFrom/missingDeps/ensureLocalDeps/installPluginDeps（npm 运行器探测，run 可注入）
- main/web-patch.js：generateWebPatch/buildPatchRows/renderPatchYaml（MCP + llm 行 + settings-update/subagent-approval 行）；ensureClientPackageLink 委托给 boot-preflight
- scripts/test-harness-rpc.js：RPC 信封/分类单测（14 项）
- scripts/test-upgrade-guard.js：升级防护判定单测（20 项：guard/冒烟判定/triage/rollbackDecision/失败分类）
- scripts/test-boot-preflight.js：链接自愈/依赖补装单测（11 项，含"指向旧拷贝→重建到 packages"漂移回归）
- main/office-docx.js：Office 文件级通道（纯 Node）：readDocxText（mammoth）、markdownToDocx（docx 包；标题/列表/引用/代码/表格/行内样式解析 parseMarkdown/parseInline 可测）、readXlsx/writeXlsx（exceljs）
- main/office-com.js：Office 应用通道（COM）：detectOffice（注册表 App Paths + 常见路径 + PS 探测）、verifyWordCom/exportDocxToPdf/openInWord（调 scripts/office-com/word.ps1，stdout 仅 OK/ERR、JSON 落临时文件）；exec/shellResolver 注入可测（setShellResolverForTest）
- scripts/office-com/word.ps1：Word COM 自动化（detect/export-pdf/open；SaveAs2 PDF=17；纯 ASCII 红线）
- scripts/test-office-docx.js：docx/xlsx 往返单测（6 项）
- scripts/test-office-com.js：COM 通道单测（6 项，注入式）
- scripts/check-harness-contract.js：官方契约体检（升级前后必跑：dsh/bin/插件目标/profiles 链接/本地依赖/i18n 截图文案/web.patch 行/会话帧可解压；退出码 0/2/1）
- UPGRADE-PLAYBOOK.md：升级处置手册（checklist/故障树/契约清单/官方变更杂记）
- packages/settings-update/client.js：parseGitSummary（/^#\s/ 小节头）；EnvPanel 五组；SchedPanel；GithubSection；**BotSection（机器人分区）**：QQ 凭据+状态实时+测试+注册指引折叠、企微 webhook+推送策略+测试；**截图补救**：ScreenshotButton + MutationObserver 精确文案 + 800ms shadow 轮询 + onRescueProgress 占位更新
- renderer/capture.html：截图选区页（冻结背景 + 蓝色选区 + cdebug 全链路日志）
- renderer/git-diff.html：Git 变更窗（提交/回滚/分支 + 占用警告）
- scripts/test-notify.js：notify 判定单测（22 项，含工具前段落拒绝判定）
- scripts/test-qq-gateway.js：QQ 网关协议单测（19 项：token/网关地址/Identify/READY/事件归一化/RESUME/sendText/stop 清理）
- scripts/test-wechat-push.js：企微 webhook 推送单测（10 项：errcode/重试/截断/URL 校验）
- scripts/test-bot-bridge.js：回复桥单测（11 项：extractReplyAfter/findSessionFile/端到端/串行队列）
- scripts/test-scan-worker.js：scan worker 端到端
- scripts/test-ui-introspect.js：UI 内省单测 11 项（fake DOM）
- scripts/test-client-module.js：bundle 加载 + 10 分区注册 + _parseGitSummary 回归
- scripts/test-github.js：github.js 单测（注入式 transport）
- scripts/install-skills.mjs：多来源 skills 安装器
- scripts/rewrite-history.js：filter-branch 历史重写助手
- .dsh/code-conventions.md：代码约定快照
- .gitignore：排除依赖/构建产物/本地运行时状态；保留 .dsh/project-map.md 共享
