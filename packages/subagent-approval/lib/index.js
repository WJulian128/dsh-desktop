/**
 * 子代理工具审批桥（host 插件，注入 harness 组合）：
 *  - 子代理会话强制 `ask` 审批策略（无论父会话是 ask 还是 never/full access）；
 *  - 子代理的审批请求（skill / MCP / 沙箱升权等）由「父代理模型」决定：
 *    以父会话的模型路由（v1：DeepSeek 官方 flash）发起一次只读 LLM 调用，
 *    模型回复 allow → allowed-once，其余/失败/超时 → denied（fail-closed）。
 *
 * 依赖 seam：
 *  - @deepseek-ai/dsh-user-approval 的 setApprovalPolicy（按会话写审批策略）
 *  - ctx.on('approval/request', (req, next) => ...) 瀑布监听（根 ctx 注册，按 agent 分发）
 *  - 父模型调用：OpenAI 兼容 chat/completions（v1 固定 DeepSeek 官方端点，
 *    key 解析：process.env.DEEPSEEK_API_KEY → $DSH_HOME/.credentials.yaml）
 */

import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';

const name = 'subagent-approval';
const inject = ['sessions', 'tools'];

const PARENT_BASE_URL = 'https://api.deepseek.com/v1';
const PARENT_MODEL = 'deepseek-v4-flash';
const PARENT_TIMEOUT_MS = 60 * 1000;
const PARENT_MAX_TOKENS = 40;

/** 读取 DeepSeek key：env → $DSH_HOME/.credentials.yaml（refs.DEEPSEEK_API_KEY / 顶层）。 */
function resolveDeepSeekKey(env = process.env, dshHome = env.DSH_HOME || join(homedir(), '.dsh')) {
  if (typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.trim()) return env.DEEPSEEK_API_KEY.trim();
  try {
    const file = join(dshHome, '.credentials.yaml');
    const raw = readFileSync(file, 'utf8');
    // 极简 YAML 取值（本文件只关心 DEEPSEEK_API_KEY，官方格式 refs: { DEEPSEEK_API_KEY: ... }）
    const m = raw.match(/^\s*(?:refs:\s*)?(?:-\s*)?DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)/m);
    if (m && m[1]) return m[1];
  } catch { /* 忽略 */ }
  return null;
}

/** 调父代理模型，返回 'allow' | 'deny'（失败/超时一律 deny）。 */
function askParentModel({ subLabel, toolName, reason, key, signal }) {
  return new Promise((resolve) => {
    const system = 'You are the approval authority for a coding agent. A subagent wants to use a tool. Reply with exactly one word: allow or deny. Consider necessity and safety.';
    const user = `Subagent: ${subLabel}\nRequested tool: ${toolName}\nReason: ${reason || '(no reason provided)'}`;
    const body = JSON.stringify({
      model: PARENT_MODEL,
      stream: false,
      max_tokens: PARENT_MAX_TOKENS,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const req = httpsRequest(PARENT_BASE_URL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      agent: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve('deny'); return; }
        try {
          const doc = JSON.parse(data);
          const content = doc.choices && doc.choices[0] && doc.choices[0].message && doc.choices[0].message.content;
          const word = String(content || '').trim().toLowerCase();
          resolve(word === 'allow' ? 'allow' : 'deny');
        } catch { resolve('deny'); }
      });
    });
    req.on('error', () => resolve('deny'));
    req.setTimeout(PARENT_TIMEOUT_MS, () => { req.destroy(); resolve('deny'); });
    if (signal) {
      const onAbort = () => { req.destroy(); resolve('deny'); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end(body);
  });
}

/** 是否子代理会话。子代理的 origin/parentSession/delegationDepth 在 session.header 上
 *  （内存 session 对象本身不带这些字段，实测 header={ origin:'subagent', parent, depth }）。 */
function isSubagentSession(session) {
  if (!session) return false;
  if (session.origin === 'subagent') return true;
  if (session.header && session.header.origin === 'subagent') return true;
  if (session.parentSession && session.parentSession !== session.id) return true;
  if (session.header && session.header.parentSession
    && session.header.parentSession !== (session.header.id || session.id)) return true;
  return false;
}

function apply(ctx) {
  console.error('[subagent-approval] plugin loaded'); // 启动标记（验证加载）
  // 1) 子代理会话强制 ask：任何权限模式下，子代理的工具请求都必须走审批链。
  //    harness 会在子代理 seed 恢复/权限 pin 阶段写入 delegation 继承策略
  //    （approval/policy: { policy: 'never', source: 'delegation' }，继承父会话 full access），
  //    因此三重保障：
  //    a. session/created 立即设置（origin 已就绪时）
  //    b. 延迟轮询（origin 延迟落盘时）
  //    c. 反击监听：任何 delegation 写入被事件捕获后立即改回 ask（最可靠）
  ctx.on('session/created', (session) => {
    try {
      if (isSubagentSession(session)) { setApprovalPolicy(session, 'ask'); return; }
    } catch (err) {
      ctx.logger?.warn?.(`[subagent-approval] 设置子代理审批策略失败: ${err && err.message}`);
    }
    // 延迟兜底：轮询 origin（最多 3 秒，200ms 间隔）
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      try {
        if (isSubagentSession(session)) {
          clearInterval(timer);
          setApprovalPolicy(session, 'ask');
        } else if (tries >= 15) {
          clearInterval(timer);
        }
      } catch { /* 忽略 */ }
    }, 200);
  }, { global: true });

  // c. 反击：delegation 继承写入后立即改回 ask（seed 恢复/权限 pin 晚于 session/created）
  //    事件负载形状为 { policy, source }（SessionEventMap），无 data 包装
  ctx.on('approval/policy', (session, event) => {
    try {
      if (event && event.source === 'delegation' && isSubagentSession(session)) {
        setApprovalPolicy(session, 'ask');
      }
    } catch { /* 忽略 */ }
  }, { global: true });
  // 兜底：session/event 通道（若 approval/policy 只经该通道派发）
  ctx.on('session/event', (session, event) => {
    try {
      if (event && event.type === 'approval/policy' && event.data && event.data.source === 'delegation' && isSubagentSession(session)) {
        setApprovalPolicy(session, 'ask');
      }
    } catch { /* 忽略 */ }
  }, { global: true });

  // 3) parent_approve 工具（方案 A：工具层审批，软约束）
  //    子代理在调用 skill / MCP 等工具前先申请父代理批准；父代理模型决定 allow/deny。
  //    工具描述同时作为提示约束（模型看到描述后会先申请再调用目标工具）。
  ctx.tools.register(defineTool({
    name: 'parent_approve',
    description: '子代理专用审批工具：调用任何 skill、MCP 或敏感工具之前，必须先调用本工具向父代理（主模型）申请批准。传入计划使用的工具名与理由，父代理批准后返回 approved=true；未获批准（approved=false）时不得调用目标工具。主会话无需使用本工具。',
    parameters: {
      tool: { type: 'string', required: true, description: '计划使用的工具名（如 skill / mcp__xxx）' },
      reason: { type: 'string', required: true, description: '使用理由（一句话说明必要性）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          approved: { type: 'boolean', required: true },
          tool: { type: 'string' },
          reply: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.reply || (value.approved ? '已批准。' : '已拒绝。') }],
    },
    async execute(args, exec) {
      const session = exec && exec.agent && exec.agent.session;
      if (!isSubagentSession(session)) {
        return { ok: false, approved: false, reply: '本工具仅供子代理使用。' };
      }
      const key = resolveDeepSeekKey();
      if (!key) {
        ctx.logger?.warn?.('[subagent-approval] parent_approve 无 DEEPSEEK_API_KEY，拒绝（fail-closed）');
        return { ok: true, approved: false, reply: '父代理审批不可用（缺少 DEEPSEEK_API_KEY），已拒绝。' };
      }
      const subLabel = session.title || session.id || 'subagent';
      const outcome = await askParentModel({
        subLabel: String(subLabel).slice(0, 120),
        toolName: String(args.tool || '?').slice(0, 80),
        reason: String(args.reason || '').slice(0, 300),
        key,
        signal: exec && exec.signal,
      });
      ctx.logger?.info?.(`[subagent-approval] parent_approve 子代理 ${subLabel.slice(0, 40)} → ${args.tool} → ${outcome}`);
      return {
        ok: true,
        approved: outcome === 'allow',
        tool: String(args.tool || ''),
        reply: outcome === 'allow'
          ? '已批准：允许使用 ' + args.tool + '。可以继续。'
          : '已拒绝：不允许使用 ' + args.tool + '。请说明必要性或改用其他方式。',
      };
    },
  }));

  // 2) 审批桥：拥有子代理的审批请求，问父代理模型，返回 allowed-once / denied。
  const approval = ctx.get('approval');
  if (!approval) {
    ctx.logger?.warn?.('[subagent-approval] 无 approval seam，审批桥未启用');
    return;
  }
  ctx.on('approval/request', async (req, next) => {
    const session = req && req.agent && req.agent.session;
    if (!isSubagentSession(session)) return next(); // 非子代理：交给官方/UI 审批链
    if (req.signal && req.signal.aborted) return 'cancelled';
    const key = resolveDeepSeekKey();
    if (!key) {
      ctx.logger?.warn?.('[subagent-approval] 无 DEEPSEEK_API_KEY，子代理审批拒绝（fail-closed）');
      return 'denied';
    }
    const subLabel = session.title || session.id || 'subagent';
    const outcome = await askParentModel({
      subLabel: String(subLabel).slice(0, 120),
      toolName: String(req.toolName || '?'),
      reason: String(req.reason || '').slice(0, 300),
      key,
      signal: req.signal,
    });
    ctx.logger?.info?.(`[subagent-approval] 子代理 ${subLabel.slice(0, 40)} 请求 ${req.toolName} → ${outcome}`);
    return outcome === 'allow' ? 'allowed-once' : 'denied';
  });

}

export { apply, name, inject };
