import z from "@deepseek-ai/schemastery";
import { CONTEXT_WINDOW_EXCEEDED_CODE, CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, RetryPolicySchema, assertUsableApiKey, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { deepEqualJson, installSettingsSection } from "@deepseek-ai/dsh-settings";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";
//#region lib/types/serialize.js
/**
* Serialize harness messages into OpenAI-compatible chat completions. The wire
* format is the OpenAI streaming shape (delta.content / delta.reasoning_content
* / delta.tool_calls); reasoning text from a prior assistant turn is passed back
* as `reasoning_content` so MiMo-style providers keep their reasoning signature.
* @module llm-openai-compat/serialize
*/
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Reject image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The OpenAI-compatible adapter is text-only; image content is not supported.", "UNSUPPORTED_CONTENT");
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
	const text = flattenText(message.content);
	const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	return {
		role: "assistant",
		content: text,
		...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
}
/**
* Serialize the conversation. `tool-result` blocks become standalone
* `{role: 'tool'}` messages; the harness puts each tool result in its own
* user-role message, so a mixed user message contributes its text first and
* its tool results as separate wire messages after.
* @param messages - the harness conversation, in order.
* @returns the wire messages; order preserved, each tool result expanded into its own entry.
*/
function serializeMessages(messages) {
	const wire = [];
	for (const message of messages) {
		assertTextOnly(message.content);
		if (message.role === "system") {
			wire.push({
				role: "system",
				content: flattenText(message.content)
			});
			continue;
		}
		if (message.role === "assistant") {
			wire.push(serializeAssistant(message));
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (text.length > 0 || toolResults.length === 0) wire.push({
			role: "user",
			content: text
		});
		for (const result of toolResults) wire.push({
			role: "tool",
			tool_call_id: result.toolCallId,
			content: flattenText(result.content) || "(no output)"
		});
	}
	return wire;
}
/**
* Resolve the wire `reasoning_effort` value: an explicit request-level effort
* wins over the instance-configured default; when neither is set the field is
* omitted entirely, so providers that reject unknown fields never see it.
* @param options - the harness request (may carry `reasoningEffort`).
* @param connectionEffort - instance-level `config.effort`, or undefined.
* @returns a legal OpenAI reasoning effort, or undefined to omit the field.
*/
function resolveEffort(options, connectionEffort) {
	const effort = options.reasoningEffort ?? connectionEffort;
	if (effort !== void 0 && !REASONING_EFFORTS.includes(effort)) throw new LlmError(`OpenAI-compatible providers accept reasoning effort ${REASONING_EFFORTS.map((value) => `"${value}"`).join(", ")}; got "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
	return effort;
}
/**
 * Resolve the wire `max_tokens`: the request's maxTokens is clamped to the
 * instance-configured ceiling (config.maxTokens, default 8192). Generic
 * OpenAI-compatible endpoints (MiMo, GLM, ...) reject large values like
 * DeepSeek's 256000 with HTTP 400, so a conservative ceiling keeps them
 * usable while providers that support more can raise the config value.
 * @param options - the harness request (may carry `maxTokens`).
 * @param connectionMaxTokens - instance-level ceiling from config.maxTokens.
 * @returns the wire value, or undefined when neither side set one.
 */
function resolveMaxTokens(options, connectionMaxTokens) {
	if (options.maxTokens === void 0) return connectionMaxTokens === void 0 ? void 0 : connectionMaxTokens;
	if (connectionMaxTokens === void 0) return options.maxTokens;
	return Math.min(options.maxTokens, connectionMaxTokens);
}
/** Assemble request fields shared by every conversion path. */
function requestWithMessages(options, messages, effort, connectionMaxTokens) {
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	const resolvedEffort = resolveEffort(options, effort);
	const resolvedMaxTokens = resolveMaxTokens(options, connectionMaxTokens);
	return {
		model: options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...resolvedEffort === void 0 ? {} : { reasoning_effort: resolvedEffort },
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...resolvedMaxTokens === void 0 ? {} : { max_tokens: resolvedMaxTokens },
		...options.stop !== void 0 ? { stop: options.stop } : {}
	};
}
/**
* Build the full wire request. Always streaming (`stream: true`, usage
* reporting on); optional fields are omitted rather than sent as null, so
* provider defaults apply.
* @param options - the harness request (model, history, system, tools, sampling).
* @param effort - instance-level `config.effort`, or undefined.
* @returns the chat-completions request body.
*/
function serializeRequest(options, effort, connectionMaxTokens) {
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: options.system
	});
	messages.push(...serializeMessages(options.messages));
	return requestWithMessages(options, messages, effort, connectionMaxTokens);
}
//#endregion
//#region lib/types/sse.js
/**
* Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
* value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
* without it (truncated response — the model call cannot be trusted).
* @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
* @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
* @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
*/
async function* parseSse(stream, onComment) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
	for await (const { data } of events) {
		yield data;
		if (data === "[DONE]") return;
	}
	throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/translate.js
/**
* Translate OpenAI-compatible SSE payloads with one stateful harness block per
* content, reasoning, or tool call index. An empty initial reasoning delta does
* not open a block. Finish reason and the latest usage are deferred until
* `[DONE]`, covering both finish-attached and trailing usage-only shapes while
* ensuring no chunk follows `finish`.
* @module llm-openai-compat/translate
*/
/**
* Map the wire finish_reason vocabulary to the harness FinishReason.
* @param reason - the wire `finish_reason` string.
* @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
*/
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/**
* Map wire usage fields to the harness TokenUsage convention: input tokens are
* DISJOINT from cache reads (`prompt_tokens` on the wire often INCLUDES cache
* hits), so cache reads are subtracted out of `inputTokens`.
* @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
* @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
*/
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
* Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
* @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
* @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
*   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
*   `EMPTY_RESPONSE` error finish instead of a successful empty message.
*/
async function* translate(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			if (pendingUsage) yield {
				type: "usage",
				usage: pendingUsage
			};
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += reasoning;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: reasoning
				};
			}
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += content;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: content
				};
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (call.id !== void 0) block.callId = call.id;
				if (call.function?.name !== void 0) block.name = call.function.name;
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
	}
	throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/adapter.js
/**
* `OpenAiCompatAdapter`: fetch + SSE against an OpenAI-compatible
* chat-completions endpoint, emitting harness StreamChunks. The adapter is
* transport-only: connection facts arrive through a thunk resolved once per
* operation and the bearer token through a per-request resolver, so the
* registering plugin owns validation, layering, and credential policy.
*
* @module llm-openai-compat/adapter
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Default combined request/response context capacity. */
const DEFAULT_CONTEXT_WINDOW = 1e6;
/** Default per-request output-token cap. Conservative 8192: generic OpenAI-compatible
 *  endpoints (MiMo, GLM, ...) reject large values like DeepSeek's 256000 with HTTP 400;
 *  providers that support more can raise config.maxTokens. */
const DEFAULT_MAX_TOKENS = 8192;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
function providerRetryAfterMs(value) {
	if (value === null) return void 0;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1e3;
		return Number.isFinite(delay) && delay > 0 ? delay : void 0;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
function requestId(headers) {
	const value = headers.get("x-request-id");
	return value === null || value.length === 0 ? void 0 : ProviderRequestId(value);
}
/**
* Map an HTTP status to a stable LlmError code.
* @param status - status of a non-2xx provider response.
* @param error - parsed provider error body, when available.
* @returns the normalized harness error code.
*/
function httpErrorCode(status, error) {
	if (status === 401 || status === 403) return "AUTH";
	if (status === 413) return "INVALID_REQUEST";
	const detail = [
		error?.code,
		error?.type,
		error?.message
	].filter(Boolean).join(" ");
	if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) {
		if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
		return "INVALID_REQUEST";
	}
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
/** Detached advisory catalog entry. */
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name ?? model.id,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.inputModalities ?? ["text"]
	};
}
/**
* The configurable OpenAI-compatible `LlmAdapter`. One instance serves every
* model name it was registered under (the harness model name IS the wire model
* name). The provider route, endpoint, API-key reference, and catalog all come
* from the plugin config, so the same class backs any number of providers.
*
* One stable signal reaches both initial fetch and body reads. Caller aborts
* map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
*/
var OpenAiCompatAdapter = class extends LlmAdapter {
	config;
	constructor(config) {
		super();
		this.config = config;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.config.displayName
		};
	}
	providerRetryPolicy(_provider) {
		return this.config.options().retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve(this.modelInfoFor(this.config.options(), provider, model));
	}
	modelInfoFor(connection, provider, model) {
		const configured = connection.models.find((entry) => entry.id === model);
		const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
		return {
			...configured === void 0 ? {
				provider,
				id: model,
				name: model,
				inputModalities: ["text"]
			} : modelInfo(provider, configured),
			context: { contextWindow },
			defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens
		};
	}
	prepareCall(provider, model, _signal) {
		const connection = this.config.options();
		return Promise.resolve({
			model: this.modelInfoFor(connection, provider, model),
			stream: (options) => this.streamWithConnection(options, connection)
		});
	}
	stream(options) {
		return this.streamWithConnection(options, this.config.options());
	}
	async *streamWithConnection(options, connection) {
		const env = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			const apiKey = await this.config.resolveApiKey(connection);
			const consumer = new AbortController();
			const watchdog = __addDisposableResource(env, idleWatchdog(options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]), connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE), false);
			const iterator = this.request(options, watchdog.signal, connection, apiKey, () => {
				watchdog.pulse();
			})[Symbol.asyncIterator]();
			let exhausted = false;
			try {
				while (true) {
					const result = await watchdog.next(iterator);
					if (result.done) {
						exhausted = true;
						return;
					}
					yield result.value;
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) throw new LlmError(`OpenAI-compatible stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("OpenAI-compatible request aborted by caller", "ABORTED", { cause: error });
				if (error instanceof LlmError) throw error;
				throw new LlmError(`OpenAI-compatible API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
			} finally {
				consumer.abort("OpenAI-compatible stream consumer stopped");
				if (!exhausted && iterator.return !== void 0) try {
					await iterator.return();
				} catch (_abortedTransportTeardown) {}
			}
		} catch (e) {
			env.error = e;
			env.hasError = true;
		} finally {
			__disposeResources(env);
		}
	}
	async *request(options, signal, connection, apiKey, onActivity) {
		const headers = {
			"authorization": `Bearer ${apiKey}`,
			"content-type": "application/json",
			"accept": "text/event-stream",
			...attributionHeaders()
		};
		const payload = JSON.stringify(serializeRequest(options, connection.effort, connection.maxTokens));
		let response;
		try {
			response = await fetch(`${connection.baseURL}/chat/completions`, {
				method: "POST",
				headers,
				body: payload,
				signal
			});
		} catch (error) {
			if (signal.aborted) throw error;
			throw new LlmError(`OpenAI-compatible API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
		}
		if (!response.ok) {
			let message = `OpenAI-compatible API error (HTTP ${response.status})`;
			let providerError;
			const rawResponse = await response.text();
			try {
				providerError = JSON.parse(rawResponse).error;
				if (providerError?.message) message = providerError.message;
			} catch {}
			const delay = providerRetryAfterMs(response.headers.get("retry-after"));
			const id = requestId(response.headers);
			throw new LlmError(message, httpErrorCode(response.status, providerError), {
				cause: new Error(rawResponse.length > 0 ? rawResponse : `OpenAI-compatible HTTP ${response.status}`),
				status: response.status,
				...delay === void 0 ? {} : { providerRetryAfterMs: delay },
				...id === void 0 ? {} : { requestId: id }
			});
		}
		if (!response.body) throw new LlmError("OpenAI-compatible API returned no response body", "EMPTY_RESPONSE");
		yield* translate(parseSse(response.body, onActivity));
	}
};
//#endregion
//#region lib/types/index.js
/**
* Register one {@link OpenAiCompatAdapter} for the configured provider route on
* `ctx.llm`. The provider name, endpoint, API-key reference, and model catalog
* come entirely from the composition `config`, so the same package can be
* mounted once per vendor (MiMo, Qwen, GLM, …) — each row registers its own
* route. Connection facts resolve per request instead of being frozen at load:
* the plugin layers its `cordis.yml` entry config under the optional
* `llm-openai-compat-<providerName>` user-settings section (`ctx.settings`) and
* resolves the API key through the optional credential seam (`ctx.credentials`),
* falling back to the launching environment (`process.env`). The one
* registration-captured fact — the retry policy — re-registers the route in
* place when it changes.
* @module @dsh-desktop/llm-openai-compat
*/
const name = "llm-openai-compat";
const inject = ["llm"];
/** Settings namespace pattern enforced by dsh-settings. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/** Provider route used when `config.providerName` is omitted. */
const DEFAULT_PROVIDER_NAME = "openai-compat";
/** API-key environment variable used when `config.apiKeyEnv` is omitted. */
const DEFAULT_API_KEY_ENV = "OPENAI_COMPAT_API_KEY";
const MODEL_MODALITIES = ["text", "image"];
/** Legal values for the optional instance-level `config.effort` (OpenAI `reasoning_effort`). */
const REASONING_EFFORTS = ["off", "low", "high", "max"];
const catalogModel = z.object({
	id: z.string().required(),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(["text"])
});
const Config = z.object({
	providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
	displayName: z.string().min(1),
	baseURL: z.string().required(),
	effort: z.union(["off", "low", "high", "max"]),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	models: z.array(catalogModel).default([]),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	retryPolicy: RetryPolicySchema
});
/**
* Derive a unique settings namespace per provider instance so multiple mounted
* rows never collide in the user settings document. Entry-only route identity:
* `providerName` / `displayName` cannot be overridden through settings.
* @param providerName - configured provider route key.
* @returns a dsh-settings namespace (`llm-openai-compat-<slug>`).
*/
function settingsNamespaceFor(providerName) {
	const slug = String(providerName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const candidate = `llm-openai-compat-${slug}`;
	return NAMESPACE_PATTERN.test(candidate) ? candidate : "llm-openai-compat";
}
/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models) {
	const seen = /* @__PURE__ */ new Set();
	return (models ?? []).map((model) => {
		if (typeof model.id !== "string" || model.id.length === 0) throw new Error("llm-openai-compat: catalog model ids must be non-empty strings");
		if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-openai-compat: catalog model "${model.id}" has an empty name`);
		if (model.description !== void 0 && model.description.length === 0) throw new Error(`llm-openai-compat: catalog model "${model.id}" has an empty description`);
		if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error(`llm-openai-compat: catalog model "${model.id}" contextWindow must be a positive integer`);
		if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error(`llm-openai-compat: catalog model "${model.id}" maxTokens must be a positive integer`);
		const inputModalities = model.inputModalities ?? ["text"];
		if (inputModalities.length === 0) throw new Error(`llm-openai-compat: catalog model "${model.id}" inputModalities must not be empty`);
		if (inputModalities.some((modality) => !MODEL_MODALITIES.includes(modality))) throw new Error(`llm-openai-compat: catalog model "${model.id}" inputModalities must contain only "text" and "image"`);
		if (new Set(inputModalities).size !== inputModalities.length) throw new Error(`llm-openai-compat: catalog model "${model.id}" inputModalities must not contain duplicates`);
		if (seen.has(model.id)) throw new Error(`llm-openai-compat: duplicate catalog model "${model.id}"`);
		seen.add(model.id);
		return {
			id: model.id,
			...model.name === void 0 ? {} : { name: model.name },
			...model.description === void 0 ? {} : { description: model.description },
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
			inputModalities: [...inputModalities]
		};
	});
}
/**
* The one explicit resolve step from raw config to validated connection facts.
* Programmatic construction may bypass Schemastery normalization, so every
* default and bound is re-judged here — for the composition entry at load
* (fail loud) and for each settings snapshot at its first use.
* @param config - raw plugin config or resolved settings snapshot.
* @returns validated connection facts plus the credential reference.
*/
function resolveAdapterOptions(config) {
	const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME;
	if (typeof providerName !== "string" || providerName.length === 0) throw new Error("llm-openai-compat: providerName must be a non-empty string");
	const displayName = config.displayName ?? providerName;
	if (typeof displayName !== "string" || displayName.length === 0) throw new Error("llm-openai-compat: displayName must be a non-empty string");
	const baseURL = config.baseURL;
	if (typeof baseURL !== "string" || baseURL.length === 0) throw new Error('llm-openai-compat: baseURL is required (for example "https://api.mimo.example/v1")');
	if (config.effort !== void 0 && !REASONING_EFFORTS.includes(config.effort)) throw new Error(`llm-openai-compat: effort must be one of ${REASONING_EFFORTS.map((value) => `"${value}"`).join(", ")}`);
	if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) throw new Error("llm-openai-compat: defaultContextWindow must be a positive integer");
	if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) throw new Error("llm-openai-compat: maxTokens must be a positive safe integer");
	const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
	if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`llm-openai-compat: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	return {
		providerName,
		displayName,
		baseURL: baseURL.replace(/\/+$/u, ""),
		...config.effort === void 0 ? {} : { effort: config.effort },
		apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
		maxTokens: config.maxTokens ?? 8192,
		defaultContextWindow: config.defaultContextWindow ?? 1e6,
		models: resolveModels(config.models),
		streamIdleTimeoutMs,
		retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-openai-compat: retryPolicy")
	};
}
function apply(ctx, config) {
	let current = () => config;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		try {
			const next = resolveAdapterOptions(raw);
			lastRaw = raw;
			lastGood = next;
			return next;
		} catch (error) {
			if (lastGood === void 0) throw error;
			lastRaw = raw;
			ctx.logger.error("llm-openai-compat: keeping the last good configuration after an invalid settings section");
			ctx.logger.error(error);
			return lastGood;
		}
	};
	const entry = options();
	const providerName = entry.providerName;
	const displayName = entry.displayName;
	const NS = settingsNamespaceFor(providerName);
	const resolveApiKey = async (connection) => {
		const ref = connection.apiKeyEnv;
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const hit = await credentials.resolve(ref);
			if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-openai-compat", ref);
		} else {
			const ambient = launchEnvironmentOf(ctx).get(ref);
			if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-openai-compat", ref);
		}
		throw new LlmError(`llm-openai-compat: no API key for provider route "${providerName}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`, "MISSING_CREDENTIAL");
	};
	const adapter = new OpenAiCompatAdapter({
		options,
		resolveApiKey,
		providerName,
		displayName
	});
	ctx.llm.registerConfigurableProviders([{
		provider: providerName,
		displayName,
		settingsNs: NS,
		settingsPath: []
	}]);
	const registration = ctx.llm.registerAdapter([providerName], adapter);
	let registeredPolicy = entry.retryPolicy;
	const ensureRegistrationFacts = () => {
		const policy = options().retryPolicy;
		if (deepEqualJson(policy, registeredPolicy)) return;
		registration.replace([providerName]);
		registeredPolicy = policy;
	};
	installSettingsSection(ctx, NS, Config, config, {
		setSource: (source) => {
			current = source;
		},
		onChange: ensureRegistrationFacts
	});
}
//#endregion
export { Config, DEFAULT_API_KEY_ENV, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_PROVIDER_NAME, DEFAULT_STREAM_IDLE_TIMEOUT_MS, OpenAiCompatAdapter, apply, inject, name, resolveAdapterOptions };
