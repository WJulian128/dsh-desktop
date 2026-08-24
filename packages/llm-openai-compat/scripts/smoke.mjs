/**
 * Smoke test for @dsh-desktop/llm-openai-compat.
 *
 * Stands up a mock OpenAI-compatible SSE endpoint (/v1/chat/completions) with
 * node:http, points the adapter at it via `baseURL`, resolves the API key from
 * a temporary `apiKeyEnv` environment variable, then drives the adapter's
 * stream() directly (no cordis ctx needed) and verifies:
 *   - streamed text + reasoning_content deltas are assembled
 *   - usage is parsed (disjoint input tokens / cache reads / output tokens)
 *   - finish reason maps to `{kind: 'stop'}`
 *   - the wire request carries model / stream / include_usage / tools / auth
 *   - the advisory catalog (listModels / resolveModel) honors config
 *   - configured `effort` is sent as top-level `reasoning_effort` (instance
 *     default, overridable per request); unconfigured instances omit the field
 *
 * Monorepo resolution: dsh-llm and friends live in the repo root's
 * node_modules (some nested under @deepseek-ai/dsh). Node's ESM resolver walks
 * up from this package, so the script bootstraps junction links under
 * packages/llm-openai-compat/node_modules pointing at the real installs —
 * created idempotently, never touching anything outside this package.
 *
 * Run: node scripts/smoke.mjs  (exit 0 = pass, non-zero = fail)
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoRoot = join(pkgRoot, "..", "..");

/** Packages this adapter imports directly and where they are installed. */
const DEPENDENCY_TARGETS = [
  ["@deepseek-ai/dsh-llm", join(repoRoot, "node_modules", "@deepseek-ai", "dsh-llm")],
  ["@deepseek-ai/dsh-credentials", join(repoRoot, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-credentials")],
  ["@deepseek-ai/dsh-launch-environment", join(repoRoot, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-launch-environment")],
  ["@deepseek-ai/dsh-settings", join(repoRoot, "node_modules", "@deepseek-ai", "dsh-settings")],
  ["@deepseek-ai/dsh-timeout", join(repoRoot, "node_modules", "@deepseek-ai", "dsh-timeout")],
  ["@deepseek-ai/schemastery", join(repoRoot, "node_modules", "@deepseek-ai", "schemastery")],
  ["eventsource-parser", join(repoRoot, "node_modules", "eventsource-parser")],
];

/** Ensure node_modules/<name> resolves to the real install (junction on Windows). */
function bootstrapLinks() {
  for (const [name, target] of DEPENDENCY_TARGETS) {
    if (!existsSync(target)) {
      throw new Error(`smoke: dependency target missing for ${name}: ${target}`);
    }
    const link = join(pkgRoot, "node_modules", name);
    if (existsSync(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    try {
      symlinkSync(target, link, "junction");
      console.log(`smoke: linked node_modules/${name} -> ${target}`);
    } catch (error) {
      // Re-check: a concurrent run may have created it between existsSync and symlink.
      if (error.code !== "EEXIST") throw error;
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`smoke: ASSERTION FAILED — ${message}`);
}

bootstrapLinks();

const { OpenAiCompatAdapter, resolveAdapterOptions } = await import("../lib/index.js");

const EXPECTED_TEXT = "Hello from MiMo! 这是中文。";
const EXPECTED_REASONING = "let me think carefully";

/** Mock OpenAI-compatible SSE server; records every request for assertions. */
const requests = [];
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ body, authorization: req.headers.authorization ?? null, raw });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": "req_mock_123",
  });
  const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  res.write(": mock keep-alive comment\n\n");
  res.write(chunk({
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }));
  res.write(chunk({
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model,
    choices: [{ index: 0, delta: { reasoning_content: EXPECTED_REASONING }, finish_reason: null }],
  }));
  res.write(chunk({
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model,
    choices: [{ index: 0, delta: { content: "Hello from MiMo! " }, finish_reason: null }],
  }));
  res.write(chunk({
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model,
    choices: [{ index: 0, delta: { content: "这是中文。" }, finish_reason: null }],
  }));
  res.write(chunk({
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }));
  // Trailing usage-only chunk (OpenAI shape), then the sentinel.
  res.write(chunk({
    id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model,
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 9, prompt_cache_hit_tokens: 5 },
  }));
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const API_KEY_ENV = "SMOKE_MIMO_API_KEY";
process.env[API_KEY_ENV] = "sk-mock-key-123";

const config = {
  providerName: "mimo",
  displayName: "MiMo Mock",
  baseURL: `http://127.0.0.1:${port}/v1/`, // trailing slash must be tolerated
  apiKeyEnv: API_KEY_ENV,
  models: [
    { id: "MiMo-7B-R1", name: "MiMo-7B-R1", contextWindow: 4096 },
    { id: "MiMo-7B-R1-Vision", inputModalities: ["text", "image"] },
  ],
  maxTokens: 2048,
  defaultContextWindow: 8192,
  streamIdleTimeoutMs: 10000,
  retryPolicy: { mode: "normal", backoff: { initialDelayMs: 50, maxDelayMs: 200, jitterRatio: 0.1 } },
};

const connection = resolveAdapterOptions(config);
console.log(`smoke: resolved connection baseURL=${connection.baseURL} providerName=${connection.providerName} apiKeyEnv=${connection.apiKeyEnv}`);

const resolveKey = async (conn) => {
  const value = process.env[conn.apiKeyEnv];
  if (!value) throw new Error(`smoke: ${conn.apiKeyEnv} not set in process.env`);
  return value;
};
const makeAdapter = (conn) => new OpenAiCompatAdapter({
  options: () => conn,
  resolveApiKey: resolveKey,
  providerName: conn.providerName,
  displayName: conn.displayName,
});
const drain = async (iterable) => {
  for await (const _ of iterable) { /* consume */ }
};
const adapter = makeAdapter(connection);

// 1) Advisory catalog honors config.
const listed = await adapter.listModels("mimo");
assert(listed.length === 2, `listModels returned ${listed.length} models, expected 2`);
assert(listed[0].name === "MiMo-7B-R1", "listed model name does not match config");
const listedInfo = await adapter.resolveModel("mimo", "MiMo-7B-R1");
assert(listedInfo.context.contextWindow === 4096, `listed contextWindow=${listedInfo.context.contextWindow}, expected 4096`);
assert(listedInfo.defaultMaxTokens === 2048, `listed defaultMaxTokens=${listedInfo.defaultMaxTokens}, expected 2048`);
const passThrough = await adapter.resolveModel("mimo", "unlisted-model");
assert(passThrough.name === "unlisted-model" && passThrough.inputModalities[0] === "text", "unlisted pass-through metadata wrong");
assert(passThrough.context.contextWindow === 8192, `unlisted contextWindow=${passThrough.context.contextWindow}, expected default 8192`);
console.log("smoke: catalog OK (2 listed models, listed contextWindow=4096, unlisted falls back to 8192)");

// 2) Stream the mock endpoint and assemble chunks.
const chunks = [];
let text = "";
let reasoning = "";
let usage;
let finishReason;
for await (const chunk of adapter.stream({
  provider: "mimo",
  model: "MiMo-7B-R1",
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: [{ type: "text", text: "Say hello in Chinese." }] }],
  tools: [{ name: "get_time", description: "Get current time", parameters: { type: "object", properties: {} } }],
  maxTokens: 2048,
})) {
  chunks.push(chunk);
  switch (chunk.type) {
    case "text-delta": text += chunk.text; break;
    case "reasoning-delta": reasoning += chunk.text; break;
    case "usage": usage = chunk.usage; break;
    case "finish": finishReason = chunk.reason; break;
    default: break;
  }
}

assert(requests.length === 1, `mock received ${requests.length} requests, expected 1 so far`);
const wire0 = requests[0];
assert(wire0.authorization === "Bearer sk-mock-key-123", `authorization header wrong: ${wire0.authorization}`);
assert(wire0.body.model === "MiMo-7B-R1", `wire model wrong: ${wire0.body.model}`);
assert(wire0.body.stream === true, "wire stream must be true");
assert(wire0.body.stream_options?.include_usage === true, "wire stream_options.include_usage must be true");
assert(Array.isArray(wire0.body.tools) && wire0.body.tools.length === 1, "wire tools missing");
assert(wire0.body.tools[0].function.name === "get_time", "wire tool name wrong");
assert(wire0.body.messages.length === 2 && wire0.body.messages[0].role === "system", "wire system message wrong");
assert(wire0.body.messages[1].role === "user" && wire0.body.messages[1].content === "Say hello in Chinese.", "wire user message wrong");
assert(wire0.body.max_tokens === 2048, "wire max_tokens wrong");
assert(!("reasoning_effort" in wire0.body), "unconfigured effort must NOT send reasoning_effort");

assert(text === EXPECTED_TEXT, `assembled text ${JSON.stringify(text)} != ${JSON.stringify(EXPECTED_TEXT)}`);
assert(reasoning === EXPECTED_REASONING, `assembled reasoning ${JSON.stringify(reasoning)} != ${JSON.stringify(EXPECTED_REASONING)}`);
assert(usage !== undefined, "no usage chunk emitted");
assert(usage.inputTokens === 7, `usage.inputTokens=${usage.inputTokens}, expected 7 (12 prompt_tokens - 5 cache hits)`);
assert(usage.cacheReadTokens === 5, `usage.cacheReadTokens=${usage.cacheReadTokens}, expected 5`);
assert(usage.outputTokens === 9, `usage.outputTokens=${usage.outputTokens}, expected 9`);
assert(finishReason?.kind === "stop", `finish reason=${JSON.stringify(finishReason)}, expected stop`);
assert(chunks.some((c) => c.type === "block-start" && c.blockType === "text"), "no text block-start emitted");
assert(chunks.some((c) => c.type === "block-start" && c.blockType === "reasoning"), "no reasoning block-start emitted");
assert(chunks.some((c) => c.type === "block-end" && c.block.type === "text"), "no text block-end emitted");
const lastType = chunks[chunks.length - 1]?.type;
assert(lastType === "finish", `last chunk is ${lastType}, expected finish (nothing after finish)`);

console.log("smoke: stream OK");
console.log(`  text:      ${text}`);
console.log(`  reasoning: ${reasoning}`);
console.log(`  usage:     ${JSON.stringify(usage)}`);
console.log(`  finish:    ${JSON.stringify(finishReason)}`);
console.log("smoke: request OK");
console.log(`  POST ${connection.baseURL}/chat/completions (authorization: Bearer sk-mock-***)`);
console.log(`  model=${wire0.body.model} stream=${wire0.body.stream} include_usage=${wire0.body.stream_options.include_usage} tools=${wire0.body.tools.length} max_tokens=${wire0.body.max_tokens}`);

// 3) config.effort passthrough: instance default, request-level override, omission, invalid rejection.
const highConfig = {
  ...config,
  providerName: "mimo-high",
  displayName: "MiMo High",
  effort: "high",
};
const highConnection = resolveAdapterOptions(highConfig);
assert(highConnection.effort === "high", `highConnection.effort=${JSON.stringify(highConnection.effort)}, expected "high"`);
const highAdapter = makeAdapter(highConnection);
await drain(highAdapter.stream({
  provider: "mimo-high",
  model: "MiMo-7B-R1",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}));
await drain(highAdapter.stream({
  provider: "mimo-high",
  model: "MiMo-7B-R1",
  reasoningEffort: "max", // request-level effort must win over the instance default
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}));
await new Promise((resolve) => server.close(resolve));

assert(requests.length === 3, `mock received ${requests.length} requests, expected 3`);
assert(requests[1].body.reasoning_effort === "high", `instance effort default wrong: ${JSON.stringify(requests[1].body.reasoning_effort)}`);
assert(requests[2].body.reasoning_effort === "max", `request-level reasoningEffort must win: ${JSON.stringify(requests[2].body.reasoning_effort)}`);
let invalidRejected = false;
try {
  resolveAdapterOptions({ ...config, effort: "bogus" });
} catch {
  invalidRejected = true;
}
assert(invalidRejected, "resolveAdapterOptions must reject an invalid effort value");
console.log("smoke: effort OK (unconfigured omits reasoning_effort; effort:'high' sends it; request-level wins; invalid rejected)");
console.log("\nSMOKE PASS");
