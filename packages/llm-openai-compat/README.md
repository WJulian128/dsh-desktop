# @dsh-desktop/llm-openai-compat

可配置的**通用 OpenAI 兼容 chat-completions LLM adapter**，用于 DeepSeek Harness（DSH）的 LLM 路由。`providerName` / `baseURL` / `apiKeyEnv` / `models` 全部由 cordis 组合（composition）配置注入，**一个包可以按不同 config 挂载多个 provider 实例**（小米 MiMo、Qwen、GLM、任意 OpenAI 兼容网关…），每个实例在 `ctx.llm` 上注册一条独立 provider 路由，可被子代理等消费方通过 `provider: <providerName>` 选用。

实现直接裁剪自官方 `@deepseek-ai/dsh-llm-deepseek`（MIT）：保留直连 `fetch` + SSE（`eventsource-parser`）→ `StreamChunk` 协议的整条链路，移除 DeepSeek 专属的 thinking/reasoningEffort 强绑定与图片/Files API 逻辑，改为 text-only 的 OpenAI 兼容透传。

## 安装 / 挂载

包本体位于 `packages/llm-openai-compat/`，名称为 `@dsh-desktop/llm-openai-compat`（ESM，`main: lib/index.js`）。把包接入 harness 有两种方式（任选其一）：

1. **注册为 file: 依赖**（与 `@dsh-desktop/settings-update` 同款做法）：在仓库根 `package.json` 的 `dependencies` 加一行 `"@dsh-desktop/llm-openai-compat": "file:packages/llm-openai-compat"`，然后 `npm install`。npm 会按 package.json 里声明的 peerDependencies 把 `@deepseek-ai/dsh-llm` 等解析到顶层 `node_modules`（dsh-llm 已提升到顶层）。
2. **符号链接进 harness 解析目录**：harness Loader 从 `$DSH_HOME/profiles/node_modules` 平铺 fallback 目录按包名解析插件（桌面端 `main/web-patch.js` 的 `ensureClientPackageLink` 对 `@dsh-desktop/settings-update` 就是这么做的）。仿照它把 `$DSH_HOME/profiles/node_modules/@dsh-desktop/llm-openai-compat` 链接到本包真实目录即可；桌面端若启用了"多厂商 LLM Provider"设置，`web-patch.js` 会自动注入 `name: '@dsh-desktop/llm-openai-compat'` 的插件行（见下）。

> peerDependencies 与官方 `@deepseek-ai/dsh-llm-deepseek` 完全一致，dependencies 为 `eventsource-parser` 与 `@deepseek-ai/schemastery`——保证 harness 解析与官方 adapter 同构。

## 配置

插件行示例（`cordis.yml` 组合或 web-patch 注入）：

```yaml
- id: llm-mimo
  name: '@dsh-desktop/llm-openai-compat'
  config:
    providerName: mimo            # 注册到 ctx.llm 的 provider 路由名（子代理 provider: mimo）
    displayName: MiMo             # 模型选择器等 UI 显示名；缺省 = providerName
    baseURL: https://api.mimo.ai/v1   # 必填；尾部斜杠会被去除
    effort: high                  # 可选思考强度：off | low | high | max；配置后请求体顶层发 reasoning_effort
    apiKeyEnv: MIMO_API_KEY       # 环境变量名；默认 OPENAI_COMPAT_API_KEY
    models:                       # 咨询性目录；未列出的 model id 仍可透传使用
      - id: MiMo-7B-R1
        name: MiMo-7B-R1
        contextWindow: 4096       # 可选；缺省回落到 defaultContextWindow
        maxTokens: 2048           # 可选；该模型的输出上限
      - id: MiMo-7B-R1-Vision
        inputModalities: [text, image]  # 可选；仅用于目录展示，请求仍为 text-only
    maxTokens: 2048               # 可选；整条路由的默认输出上限（缺省 256000）
    defaultContextWindow: 8192    # 可选；缺省 1000000
    streamIdleTimeoutMs: 300000   # 可选；每次读取的空闲看门狗（缺省 5 分钟）
    retryPolicy:                  # 可选；缺省 normal 模式 5 次重试
      mode: normal                # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
```

### 字段说明

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `providerName` | 否 | `openai-compat` | 注册到 `ctx.llm` 的 provider 路由名；同一组合内不得重复（重复注册抛 `DUPLICATE_ADAPTER`） |
| `displayName` | 否 | = providerName | UI 展示名（`providerInfo` / `registerConfigurableProviders`） |
| `baseURL` | **是** | — | 端点根，如 `https://api.mimo.ai/v1`；请求发往 `${baseURL}/chat/completions`，尾部 `/` 自动去除 |
| `effort` | 否 | 不发送 | 实例级思考强度（OpenAI `reasoning_effort`）：`off` \| `low` \| `high` \| `max`。配置后请求体顶层发 `reasoning_effort: <effort>`；**未配置则完全不发该字段**（避免对不支持的厂商产生 400）。请求层显式传的 `reasoningEffort` 优先于实例默认；非法枚举值在 `resolveAdapterOptions` 抛错 |
| `apiKeyEnv` | 否 | `OPENAI_COMPAT_API_KEY` | 环境变量名（如 `MIMO_API_KEY`）。**只写变量名，不写密钥值** |
| `models` | 否 | `[]` | 咨询性模型目录 `[{id, name?, description?, contextWindow?, maxTokens?, inputModalities?}]`；`models: []` 表示不宣传任何模型，但未列出的 id 仍以 text-only 透传 |
| `maxTokens` | 否 | 256000 | 路由级默认输出上限；条目级 `maxTokens` 优先 |
| `defaultContextWindow` | 否 | 1000000 | `resolveModelInfo` 对无容量的条目/未列出的透传 id 返回的上下文容量 |
| `streamIdleTimeoutMs` | 否 | 300000 | 单次 provider 读取的空闲超时；超时抛 `LlmError('TIMEOUT')` |
| `retryPolicy` | 否 | normal×5 | 透传给 `dsh-llm-retry` 的 provider 级重试策略 |

### API Key 解析顺序

每次流式调用解析一次（与 deepseek adapter 相同）：

1. `ctx.credentials`（web「模型」设置页写入的凭据服务）——`credentials.resolve(apiKeyEnv)`；
2. 否则 `launchEnvironmentOf(ctx).get(apiKeyEnv)`，即 **`process.env`**（桌面端主进程会在启动 dsh web 子进程时按同名键注入 apiKey，如 `MIMO_API_KEY`）。

两处都没有 → `LlmError('MISSING_CREDENTIAL')`；值含无法放入 HTTP 头的字符 → `LlmError('INVALID_CREDENTIAL')`。密钥永不写入配置或日志。

### 多 provider 注册示例

同一包、两条插件行、两个独立路由：

```yaml
- id: llm-mimo
  name: '@dsh-desktop/llm-openai-compat'
  config:
    providerName: mimo
    displayName: MiMo
    baseURL: https://api.mimo.ai/v1
    apiKeyEnv: MIMO_API_KEY
    models:
      - id: MiMo-7B-R1
        contextWindow: 4096

- id: llm-qwen
  name: '@dsh-desktop/llm-openai-compat'
  config:
    providerName: qwen
    displayName: Qwen
    baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
    apiKeyEnv: QWEN_API_KEY
    models:
      - id: qwen-plus
        contextWindow: 128000
```

环境变量：

```powershell
$env:MIMO_API_KEY = "sk-xxxxxxxx"
$env:QWEN_API_KEY = "sk-yyyyyyyy"
```

子代理 / 请求侧选用（agent preset 或 `ctx.llm.stream`）：

```yaml
# 子代理 preset 里
model: MiMo-7B-R1
provider: mimo
```

### 多强度实例示例（同一端点，不同 effort）

设置页可按"模型 + 强度"注册多个实例：每条路由固定一个 `effort`，主模型按子代理需要的强度选 provider，adapter 自动把 `reasoning_effort` 放到请求体顶层（与 model/stream 同级）：

```yaml
- id: llm-mimo-fast
  name: '@dsh-desktop/llm-openai-compat'
  config:
    providerName: xiaomi-mimo-fast
    displayName: MiMo Fast
    baseURL: https://api.mimo.ai/v1
    apiKeyEnv: MIMO_API_KEY
    effort: low
    models:
      - id: MiMo-7B-R1

- id: llm-mimo-high
  name: '@dsh-desktop/llm-openai-compat'
  config:
    providerName: xiaomi-mimo-high
    displayName: MiMo High
    baseURL: https://api.mimo.ai/v1
    apiKeyEnv: MIMO_API_KEY
    effort: high
    models:
      - id: MiMo-7B-R1
```

请求层（`ctx.llm.stream` 的 `reasoningEffort` / agent 每次请求的 effort）可覆盖实例默认；两者都未配置时请求体**完全不发** `reasoning_effort`。

## 行为

- **流式**：`stream: true` + `stream_options.include_usage: true` 始终开启；SSE 由 `eventsource-parser` 分帧。
- **effort 透传**：配置了 `effort` 的实例，请求体顶层发 OpenAI 标准字段 `reasoning_effort: <effort>`（仅此一个，不额外发 DeepSeek 的 `thinking` 参数）；未配置则完全不发。请求层显式 `reasoningEffort` 优先；非法值抛 `UNSUPPORTED_REASONING_EFFORT`。
- **delta 透传**：`delta.content` 与 `delta.reasoning_content` 都透传为 harness `StreamChunk`（`text-delta` / `reasoning-delta` + 对应 `block-start`/`block-end`）；`delta.tool_calls` 按 index 聚合为 `tool-call` 块，参数保持原始 JSON 字符串。历史上带推理的 assistant 轮次会把 `reasoning_content` 回写进后续请求（MiMo 等厂商可据此恢复推理签名）。
- **usage**：`prompt_tokens` 若含缓存命中（`prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`），按 harness 的**不相交计数**约定从 `inputTokens` 中扣减，另报 `cacheReadTokens`；`completion_tokens_details.reasoning_tokens` 透传为 `reasoningTokens`。usage 可能在 finish chunk 或独立尾 chunk 到达，统一推迟到 `[DONE]` 再发，保证 `usage` 先于 `finish`、`finish` 后无任何 chunk。
- **错误映射**（非 2xx → 稳定 `LlmError` 码）：
  - 401/403 → `AUTH`
  - 429（非配额）→ `RATE_LIMIT`；识别为配额/余额耗尽 → `QUOTA`
  - 400 识别为上下文溢出 → `CONTEXT_WINDOW_EXCEEDED`；其他 400 与 413 → `INVALID_REQUEST`
  - 5xx → `SERVER`；其余 → `HTTP_<status>`
  - 预响应传输失败（DNS/拒连/TLS/代理）→ `TRANSPORT`；调用方中止 → `ABORTED`；空闲看门狗 → `TIMEOUT`
  - SSE 无 `[DONE]` 提前结束 → `STREAM_CLOSED`；坏 JSON → `MALFORMED_RESPONSE`；完成流无任何内容块 → `finish {kind:'error', code: EMPTY_RESPONSE}`（默认策略会重试）
  - 保留 `retry-after`（秒/日期）→ `providerRetryAfterMs`，`x-request-id` → `requestId`
- **text-only**：请求中的图片内容一律抛 `UNSUPPORTED_CONTENT`（不会静默丢弃）；目录里的 `inputModalities: [text, image]` 仅作展示，不代表本 adapter 会上传图片。
- **动态配置**：`baseURL` / `apiKeyEnv` / `effort` / `models` / `maxTokens` / `defaultContextWindow` / `streamIdleTimeoutMs` / `retryPolicy` 可经用户设置文档的 `llm-openai-compat-<providerName>` 分区覆盖（`ctx.settings`），下一次请求即生效；`providerName` / `displayName` 是**入口级**路由身份，只能在插件行 config 里定，settings 覆盖会被忽略。`retryPolicy` 变化会就地 `registration.replace` 重注册路由。

## 冒烟测试

```powershell
node scripts/smoke.mjs
```

脚本用 `node:http` 起一个 mock OpenAI SSE 端点（`POST /v1/chat/completions`，返回标准 SSE chunk：内容 + `reasoning_content` + `finish_reason: stop` + 尾部 usage-only chunk + `[DONE]`），把 `baseURL` 指向 mock、`apiKeyEnv` 指向临时环境变量，直接实例化 `OpenAiCompatAdapter`（无需 cordis ctx）驱动 `stream()`，断言：文本与推理透传、usage 不相交解析、finish 映射、线上请求体（auth/model/stream/include_usage/tools）与咨询性目录。

> 仓库内直接运行前，脚本会幂等地在 `packages/llm-openai-compat/node_modules/` 下创建 junction 链接指向仓库顶层（或 `@deepseek-ai/dsh` 嵌套目录）已安装的 `@deepseek-ai/dsh-llm`、`dsh-credentials`、`dsh-launch-environment`、`dsh-settings`、`dsh-timeout`、`schemastery`、`eventsource-parser`，使 Node ESM 能解析 monorepo 依赖；不触碰包目录以外的任何文件。若已按"安装 / 挂载"方式 npm install 过（peer 已解析到顶层），这些链接会被跳过。

## 与 @deepseek-ai/dsh-llm-deepseek 的差异

| 维度 | deepseek 官方 adapter | 本包 |
| --- | --- | --- |
| Provider 路由 | 硬编码 `deepseek-official` 单路由 | `config.providerName`（默认 `openai-compat`），一包多实例 |
| 端点 | `$DEEPSEEK_BASE_URL` → 公共 API | `config.baseURL`（必填） |
| API Key | `DEEPSEEK_API_KEY` | `config.apiKeyEnv`（任意环境变量名） |
| 模型目录 | DeepSeek V4 默认集 | `config.models`，缺省 `[]` |
| thinking/reasoningEffort | 强绑定（`thinking.type`/`reasoning_effort`、off/low/high/max 校验） | 移除 thinking 强绑定；`config.effort` 可选透传为顶层 `reasoning_effort`（缺省不发），`reasoning_content` 作 delta 透传与历史回写 |
| 图片 / Files API | `/files` 上传、index、配额回收、base64 回退 | 全部移除（text-only） |
| 请求头 | 附加 `x-deepseek-harness-*` 系列 | 仅 `attributionHeaders()` 基线 |
| 保留 | — | SSE 解析、StreamChunk 翻译、usage 解析、错误映射（AUTH/QUOTA/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED/INVALID_REQUEST/SERVER/TRANSPORT/TIMEOUT/ABORTED/STREAM_CLOSED/MALFORMED/EMPTY_RESPONSE）、`retryPolicy` 透传、空闲看门狗、settings 动态配置 |

## 许可

MIT。本包为对 `@deepseek-ai/dsh-llm-deepseek`（MIT）的裁剪改写，保留其源码结构与大量原文注释。
