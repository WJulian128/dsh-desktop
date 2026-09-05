# harness 升级处置手册（dsh-desktop）

> 2026-09-05 0.1.1-rc.2 → 0.1.2-rc.1 事故后的固化经验。任何一次 @deepseek-ai/dsh
> 升级（更新按钮 / 静默自动更新 / 手动 npm install）前后请按本手册操作。
> 配套命令：`node scripts\check-harness-contract.js`（官方契约体检，只读+链接自愈）。

## 0. 为什么需要本手册（事故复盘一句话版）

升级事故链：npm 重写 node_modules 时 harness 仍在运行 → 撞上半更新依赖 →
0.1.2-rc.1 起 loader entry 导入失败 = 致命 → “更新后启动不了”。
叠加 0.1.2-rc.1 的破坏性 API 变更（token 认证 / Typert RPC / 插件依赖解析）。
防错补丁已把大部分环节自动化（停服更新、启动自检自愈、冒烟+一键回滚、RPC 双风格自适应），
本手册负责“自动化没覆盖的最后一公里”：**人工确认官方契约是否仍成立**。

## 1. 升级前 Checklist（5 分钟）

1. 工作区 git 干净（`git status`），关键改动已提交推送；
2. 跑基线体检：`node scripts\check-harness-contract.js` → 期望 PASS 全绿（WARN 可接受，FAIL 必须先处置）；
3. 更新弹窗会展示官方 release notes（“本次更新内容”），重点看破坏性变更（Breaking）段落；
4. 确认当前版本已记为可用：日志 `[upgrade] 冒烟通过…记为可用版本`（对应设置键 lastKnownGoodVersion）。

## 2. 升级后 Checklist（自动 + 人工）

> 更新交互（2026-09 起）：点“更新”后由**主进程后台流水线**全自动执行——预检→停服→
> 安装→自动加载新版本→核心验证；失败自动回滚上一版本（熔断一次）；过程无弹窗
> （界面仅“更新中…”），结果走系统通知，手动触发时补一次结果弹窗（含官方变更摘要）。
> 无需手动重启；进行中的回合由 auto-resume 自动接续。MCP 工具
> dsh_desktop_apply_update 支持 force=true 重装当前版本（修复损坏安装）。

1. 启动日志干净序列（%APPDATA%\dsh-desktop\logs\dsh-web.log）：
   `[boot-preflight] 插件链接 3/3 可用`（仅一次）→ 各插件/MCP loaded → `dsh web: …?token=…` →
   `[upgrade] 冒烟通过（v…，N 个会话），记为可用版本`；
2. 跑体检：`node scripts\check-harness-contract.js` → 全绿；
3. 功能抽查（各 10 秒）：
   - 设置页右侧双面板在刷新（日志持续出现 `[git-summary] ok` = EnvPanel 轮询活着）；
   - 对话正常收发（auto-resume/派发走官方 RPC：日志 `[auto-resume] 已通过官方 RPC 发送到会话`）；
   - 记忆抽取在跑（日志 `[memory] 开始抽取记忆…`）；
4. 若升级后首启冒烟失败且无事务上下文（非流水线触发）：会弹一次“启动/验证异常”
   回滚询问；选择“保留当前版本”后同版本不再打扰（dismissRollbackVersion）。
   流水线上下文内失败已自动回滚，不需要人工处理。

## 3. 故障树（症状 → 检查 → 处置）

| 症状 | 检查（日志关键词） | 处置 |
|---|---|---|
| 启动即退出/反复重启 | `plugin tree failed to load` / `failed to import loader entry` / `ERR_MODULE_NOT_FOUND` / `Cannot find package` | 更新中断或依赖/链接坏：先跑 `check-harness-contract.js` 定位；按提示修链接或 `npm install`；仍失败走一键回滚 |
| 页面/API 401 | `dsh web authentication required` | launch token 静默轮换（数十秒有效窗口，实测）：重启桌面端即可；运行中自动自愈链已接管（URL 重打印→重铸 cookie→自动重启） |
| 官方 RPC 404/参数错 | 日志 `style-mismatch` / `args-mismatch`（harness-rpc 会自试另一风格/参数名） | 若双风格都失败：API 又变了 → 改 harness-rpc.js（见 §4 契约清单） |
| 功能静默坏（无报错） | 通知/记忆/面板停止 | 会话帧格式漂移？跑探针条目 6；帧类型假设清单见 §4 |
| 截图补救不触发 | — | 官方拒图文案变了？跑探针条目 4；改 packages/settings-update/client.js 的精确文案 |
| 更新失败 | `[updater] …失败` | 已自动回滚 package.json；日志给重试提示；`updateGuard=failed` 下次启动可重试 |

## 4. 官方契约清单（升级后最可能失效的耦合点）

| # | 契约 | 桌面端依赖位置 | 验证 |
|---|---|---|---|
| 1 | web 页面 token 认证（URL ?token= → dsh-auth-* cookie，30 天，与 token 解耦） | main.js rpcCall / refreshRpcAuth / harness.js webUrl 解析 / smoke | 探针非直接；看启动冒烟日志 |
| 2 | /api 端点=namespace/method（session/list、session/prompt、session/create、workspace/create），信封 {args:{参数名}}；session.list 参数名 _request、其余 request | main/harness-rpc.js（ARGS_KEY_OVERRIDES / classifyResponse / 双风格回退） | 探针条目 6 之外看 rpcCall 日志；新增端点在此登记 |
| 3 | loader entry 名：@dsh-desktop/settings-update / llm-openai-compat / subagent-approval；依赖从插件真实目录向上解析 | web-patch.js 行 + main/boot-preflight.js DESKTOP_PLUGINS + plugin-deps.js | 探针条目 1/2/3 |
| 4 | 截图拒收 toast 精确文案：`当前模型不支持图片` / `图片发送失败（`（i18n key image.modelUnsupported/image.sendFailed） | packages/settings-update/client.js 匹配常量 | 探针条目 4 |
| 5 | 会话存储：$DSH_HOME/sessions/<wsKey>/<sessionId>/session.jsonl.zstd（拼接 zstd 帧 JSONL）；帧类型 turn/start、step/start、step/end、turn/end、assistant/chunk、assistant/message、tool/call、tool/result、tool-call-chunks、reasoning-chunks、text-chunks、user/message；顶层 session 帧带 origin:'subagent' | notify.js / memory-watch / reply-bridge / transcript-check / vision / subagent-* / context-watch / panel-stream | 探针条目 6 + 人工抽样 |
| 6 | MCP 行（@deepseek-ai/dsh-mcp-client stdio）与内置 memory/sequential-thinking 本地入口 | web-patch.js builtinMcps | 探针条目 5 |
| 7 | dsh web CLI 参数：--host/--port/--no-open/--patch；打印 `dsh web: <url>` | main/harness.js | 启动日志 |
| 8 | 更新事务与回滚（npm install --save-exact 语义；updateGuard prev/applied；lastKnownGoodVersion；dismissRollbackVersion） | main/updater.js + main.js + main/upgrade-guard.js | 单元测试 + 升级实测 |

## 5. 常见命令速查

- 体检：`node scripts\check-harness-contract.js`
- 读启动日志：Get-Content "$env:APPDATA\dsh-desktop\logs\dsh-web.log" -Tail 120
- 重跑全量单测：scripts\test-*.js（沙箱受限时 spawn 类测试需提权，见项目地图陷阱）
- 手动回滚：应用内“回滚到 v<prev>”按钮（优先）；或 npm install @deepseek-ai/dsh@<旧版> --save-exact（开发模式）

## 6. 官方变更杂记（0.1.2-rc.1 升级调研沉淀，防止重复踩坑）

- **官方 release notes 很完整**（GitHub tag dsh-v<版本>，中英双语）：https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1 —— 升级前必读。
- **dsh-credentials 的 npm latest 标签陈旧**（仍指向 0.0.1-rc.1，2026-08-10 的早期抽象包）：装它必须按显式版本（桌面端 package.json 已固定 ^0.1.2-rc.1，勿改成 latest）。同类情况：装任何 @deepseek-ai/dsh-* 都用与 dsh 主版本一致的显式版本号。
- **token 认证官方措辞是“网络访问 Web 界面时一次性 token 鉴权”，但实测本机回环同样强制 401/cookie**——以实测为准（0.1.2-rc.1+ 一律按带 token 处理）。
- **Headless stdout/stderr 语义变更**（0.1.2-rc.1+：进度→stderr、stdout 只出最终结果）：桌面端 terminal 的 headless.js 已按 stream 区分转发展示，无破坏；若未来新增解析 headless 输出的代码，必须分清两路。
- **官方移除可选 SQLite 会话后端、Session.events 改为 seq/eventAt()/snapshotEvents()**：桌面端不依赖（全部走 $DSH_HOME/sessions 文件 JSONL 读取），但升级后仍应跑探针条目 6 + 人工帧抽样兜底。
- **0.1.2-rc.1 官方清单摘要**（对桌面端有集成含义的）：Remote 网关统一 RPC（APIProxy 移除，即 Typert 网关化——官方未用 Typert 字样）；peer 依赖裁剪（对应插件依赖自包含改造）；cordis-plugin-loader 1.0.3 / cordis 4.0.2；Windows 目录选择器编码修复；Node 24.0–24.11.1 启动失败修复；统一经 dsh Profile 启动各模式。
- 社区（非官方）有 oh-my-dsh/dsh-plugin-upgrade-skill 可参考，不引入依赖。
