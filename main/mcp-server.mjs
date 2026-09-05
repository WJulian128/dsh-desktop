/**
 * DSH Desktop 内置 MCP 服务器（stdio）。
 *
 * 由 harness（dsh web 进程）通过 dsh-mcp-client 以 stdio 传输拉起，向模型暴露
 * `mcp__dsh_desktop__*` 工具，让 harness 能自主调用桌面能力：检查更新、应用更新、
 * 打开目录/日志、终端模式、重启应用等。
 *
 * 本进程自身不做任何桌面操作——通过 HTTP 调用 Electron 主进程的 RPC 服务
 * （环境变量 DSH_DESKTOP_RPC_URL / DSH_DESKTOP_RPC_TOKEN，由桌面端注入）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolvePriceTier } = require("./usage.js");

const RPC_URL = process.env.DSH_DESKTOP_RPC_URL;
const RPC_TOKEN = process.env.DSH_DESKTOP_RPC_TOKEN;

function log(text) {
  try { process.stderr.write("[dsh-desktop-mcp] " + text + "\n"); } catch { /* ignore */ }
}

if (!RPC_URL || !RPC_TOKEN) {
  log("missing DSH_DESKTOP_RPC_URL/DSH_DESKTOP_RPC_TOKEN, exiting");
  process.exit(1);
}

/** 视觉识别等慢速 RPC 的调用超时（本地 CPU 视觉模型单次推理可达数分钟，冷启动还含模型加载）。
 *  可用环境变量覆盖，便于测试注入短超时；默认 8 分钟。 */
const VISION_RPC_TIMEOUT_MS = Number(process.env.DSH_VISION_RPC_TIMEOUT_MS) || 480000;

/** 调用桌面端 RPC；失败抛错（错误信息会作为 MCP 调用失败返回给模型）。
 *  timeoutMs：单次调用超时（默认 120s；视觉等慢速调用须传入更长值，否则本地推理会被中途掐断）。
 *  桌面端重启后的瞬断（fetch failed）自动重试一次，避免伪失败导致主进程推理空转后又被重复调用。 */
async function call(method, params = {}, timeoutMs = 120000) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(RPC_URL + "/rpc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + RPC_TOKEN,
        },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && err.name === "TimeoutError") {
        throw new Error("桌面端 RPC 超时（" + method + "，超过 " + Math.round(timeoutMs / 1000) + "s）：桌面端繁忙或该操作耗时过长");
      }
      lastErr = err;
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
      throw lastErr;
    }
    const payload = await res.json().catch(() => ({ ok: false, error: "bad rpc response" }));
    if (!payload.ok) throw new Error(payload.error || "desktop rpc failed: " + method);
    return payload.result;
  }
  throw lastErr || new Error("desktop rpc failed: " + method);
}

/** MCP 文本结果（Claude Code 经验：大型工具输出消耗大量上下文——超长结果截断并提示，
 *  需要更多细节时用 region 局部识别或分页读取，避免长对话上下文被工具输出撑爆）。 */
function text(text, { maxChars = 6000 } = {}) {
  const s = String(text ?? "");
  if (s.length <= maxChars) return { content: [{ type: "text", text: s }] };
  return {
    content: [{ type: "text", text: s.slice(0, maxChars) + "\n…（输出已截断：共 " + s.length + " 字符，仅保留前 " + maxChars + "；如需更多细节请用 region 局部识别或针对性查询）" }],
  };
}

const server = new McpServer({
  name: "dsh-desktop",
  version: "1.0.0",
});

server.registerTool(
  "dsh_desktop_get_state",
  {
    title: "获取桌面端状态",
    description:
      "返回 DSH 桌面端当前状态：已安装/最新 harness 版本、是否有可用更新、工作区路径、" +
      "数据目录（DSH_HOME）、服务地址与运行阶段。调用其它桌面工具前可先查此工具。",
    inputSchema: z.object({}),
  },
  async () => text(JSON.stringify(await call("getState"), null, 2)),
);

server.registerTool(
  "dsh_desktop_list_providers",
  {
    title: "列出可用 LLM Provider（子代理调度）",
    description:
      "返回可用的 LLM Provider 实例清单（含内置 DeepSeek 与用户配置的厂商），每个实例含 provider 名、模型列表、思考强度（effort）与余额。" +
      "派发子代理时如需指定厂商/思考强度，用 provider 名（如 deepseek-official / xiaomi-mimo / xiaomi-mimo-fast / xiaomi-mimo-deep）作为 workflow/subagent 的 provider 参数。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("providersList");
    const lines = ["可用 LLM Provider（provider 名 → 模型 / 思考强度 / 余额）："];
    for (const p of (result && result.providers) || []) {
      if (p.enabled === false) continue;
      const effort = p.effort ? "（思考强度: " + p.effort + "）" : "";
      lines.push("- " + p.provider + effort + "：" + ((p.models || []).join(", ") || "?"));
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "dsh_desktop_check_updates",
  {
    title: "检查 harness 更新",
    description:
      "检查 npm registry 上 @deepseek-ai/dsh 的最新版本（对比已安装版本），返回 " +
      "{ installed, latest, hasUpdate }。只做检查，不安装。",
    inputSchema: z.object({
      checkPrereleases: z.boolean().optional().describe("是否同时考虑 next 预发布标签"),
    }),
  },
  async (args) => {
    const result = await call("checkUpdates", { checkPrereleases: args.checkPrereleases ?? false });
    return text(
      "检查结果：" +
      "\n- 已安装版本：" + (result.installed ?? "?") +
      "\n- 最新版本：" + (result.latest ?? "?") +
      "\n- 是否有更新：" + (result.hasUpdate ? "是" : "否") +
      (result.hasUpdate ? "\n需要时可用 dsh_desktop_apply_update 后台自动安装（无感，验证失败自动回滚）。" : ""),
    );
  },
);

server.registerTool(
  "dsh_desktop_apply_update",
  {
    title: "安装更新（后台自动）",
    description:
      "安装 @deepseek-ai/dsh（默认最新版）。后台自动执行：预检→停服→安装→自动加载→核心验证，失败自动回滚上一版本；过程无弹窗打扰（界面仅显示\"更新中…\"），完成后系统通知结果，无需手动重启。force=true 可重装当前版本（用于修复损坏的安装）。会先弹系统确认框，用户确认后执行。",
    inputSchema: z.object({
      force: z.boolean().optional().describe("true=即使无新版本也重装当前版本"),
    }),
  },
  async (args) => {
    const result = await call("applyUpdate", { force: !!(args && args.force) });
    return text("已提交更新请求" + (result && result.applied ? "（后台自动流水线执行中…）" : (result && result.reason === 'no update available' ? "（当前已是最新版本；需要重装请传 force:true）" : "（等待用户确认）")));
  },
);

/* ---- Office 工具（文件级 office-docx + Word/WPS COM 应用通道） ---- */

server.registerTool(
  "dsh_desktop_office_detect",
  {
    title: "检测办公软件环境",
    description:
      "检测本机 Office 环境（MS Office / WPS 的 Word、Excel 路径与 COM 可用性），返回各应用的可用状态。调用任何 word_* / docx / xlsx 工具前建议先检测。",
    inputSchema: z.object({}),
  },
  async () => {
    const r = await call("office", { op: "detect" });
    if (!r || r.ok !== true) return text("检测失败：" + ((r && r.error) || "未知错误"));
    const d = r.data || {};
    return text("办公软件环境：\n- Word：" + (d.word && d.word.available ? "可用（" + (d.word.kind || "?") + "）" : "未安装/未检测到") +
      "\n- Excel：" + (d.excel && d.excel.available ? "可用（" + (d.excel.kind || "?") + "）" : "未安装/未检测到") +
      "\n- PowerShell：" + (d.ps ? "可用" : "不可用"));
  },
);

server.registerTool(
  "dsh_desktop_docx_read",
  {
    title: "读取 Word 文档（.docx）",
    description:
      "读取 .docx 文件的全部文字内容（含表格文字），返回纯文本供分析/改写。附件中的 Word 文档先找到其本地路径（.dsh-attachments 或工作区）再调用。",
    inputSchema: z.object({
      path: z.string().describe(".docx 文件绝对路径"),
    }),
  },
  async (args) => {
    const r = await call("office", { op: "docxRead", args });
    if (!r || r.ok !== true) return text("读取失败：" + ((r && r.error) || "未知错误"));
    return text("文档内容（" + (r.data && r.data.text ? r.data.text.length : 0) + " 字符）：\n" + (r.data ? r.data.text : ""));
  },
);

server.registerTool(
  "dsh_desktop_docx_from_markdown",
  {
    title: "生成 Word 文档（markdown → .docx）",
    description:
      "把 markdown 文本保存为 .docx 文件（支持 # 标题 / - 与数字列表 / > 引用 / ```代码块 / | 表格 / **粗体** / *斜体* / `行内代码`）。适合把报告、纪要、方案等写作产出落成 Word 文件。outPath 建议写到当前工作区或 .dsh-attachments 目录。",
    inputSchema: z.object({
      text: z.string().describe("markdown 全文"),
      outPath: z.string().describe("输出 .docx 绝对路径（如 C:\\Users\\wj021\\Desktop\\报告.docx）"),
      title: z.string().optional().describe("可选：文档大标题"),
    }),
  },
  async (args) => {
    const r = await call("office", { op: "mdToDocx", args });
    if (!r || r.ok !== true) return text("生成失败：" + ((r && r.error) || "未知错误"));
    return text("已生成 Word 文档：\n" + (r.data && r.data.path ? r.data.path : ""));
  },
);

server.registerTool(
  "dsh_desktop_xlsx_read",
  {
    title: "读取 Excel 表格（.xlsx）",
    description:
      "读取 .xlsx 指定工作表（缺省第一个）为二维表格文本（首行一般是表头）。sheet 缺省时返回工作表名列表。",
    inputSchema: z.object({
      path: z.string().describe(".xlsx 文件绝对路径"),
      sheet: z.string().optional().describe("工作表名；缺省第一个工作表"),
    }),
  },
  async (args) => {
    const r = await call("office", { op: "xlsxRead", args });
    if (!r || r.ok !== true) return text("读取失败：" + ((r && r.error) || "未知错误"));
    const d = r.data || {};
    const head = "工作表：" + d.sheetName + "（可选：" + ((d.sheetNames || []).join(", ") || "—") + "）\n";
    const rows = (d.rows || []).map((row) => (row || []).map((c) => (c === null || c === undefined ? "" : String(c))).join("\t")).join("\n");
    return text(head + (rows || "（空表）"));
  },
);

server.registerTool(
  "dsh_desktop_xlsx_write",
  {
    title: "生成 Excel 表格（.xlsx）",
    description:
      "把二维数据写成 .xlsx 文件（可含多个工作表；每张表首行通常为表头）。适合把统计结果、清单、台账落成 Excel。",
    inputSchema: z.object({
      path: z.string().describe("输出 .xlsx 绝对路径"),
      sheets: z.array(z.object({
        name: z.string().optional().describe("工作表名（缺省 Sheet1）"),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("二维数据：每行一组值，首行通常为表头"),
      })).describe("工作表列表（至少一个）"),
    }),
  },
  async (args) => {
    const r = await call("office", { op: "xlsxWrite", args });
    if (!r || r.ok !== true) return text("生成失败：" + ((r && r.error) || "未知错误"));
    return text("已生成 Excel 文件：\n" + (r.data && r.data.path ? r.data.path : ""));
  },
);

server.registerTool(
  "dsh_desktop_word_export_pdf",
  {
    title: "Word 导出 PDF",
    description:
      "用本机 Word（COM 自动化，需已安装 MS Office/WPS）把 .docx 打开并另存为 PDF——排版、字体、分页与 Word 完全一致。Word 首次启动可能耗时 5~20 秒，请耐心等待。",
    inputSchema: z.object({
      docxPath: z.string().describe("源 .docx 绝对路径"),
      pdfPath: z.string().optional().describe("输出 .pdf 绝对路径（缺省与 docx 同目录同名）"),
    }),
  },
  async (args) => {
    const r = await call("office", { op: "wordExportPdf", args });
    if (!r || r.ok !== true) return text("导出失败：" + ((r && r.error) || "未知错误"));
    return text("导出完成" + (r.data && r.data.ok ? "（已用 Word 另存为 PDF）" : ""));
  },
);

server.registerTool(
  "dsh_desktop_word_open",
  {
    title: "用 Word 打开文档",
    description:
      "在 Word 中打开指定 .docx 供用户查看/编辑（应用窗口会显示）。若需要后续操控窗口（另存、打印等），结合电脑操控的窗口/键盘工具操作。",
    inputSchema: z.object({
      docxPath: z.string().describe(".docx 文件绝对路径"),
    }),
  },
  async (args) => {
    const r = await call("office", { op: "wordOpen", args });
    if (!r || r.ok !== true) return text("打开失败：" + ((r && r.error) || "未知错误"));
    return text("已在 Word 中打开：" + (args && args.docxPath ? args.docxPath : ""));
  },
);

server.registerTool(
  "dsh_desktop_office_verify",
  {
    title: "验证 Word COM 自动化可用",
    description:
      "真实创建 Word.Application 验证 COM 自动化可用（首次约数秒，会短暂静默启动 Word）。若失败说明未安装 MS Office/WPS 或 COM 被禁用，word_* 系列工具不可用。",
    inputSchema: z.object({}),
  },
  async () => {
    const r = await call("office", { op: "wordVerify" });
    if (!r || r.ok !== true) return text("验证失败：" + ((r && r.error) || "未知错误"));
    return text(r.data && r.data.ok ? "Word COM 自动化可用（版本 " + (r.data.version || "?") + "）" : "Word COM 不可用：" + ((r.data && r.data.error) || "未知错误"));
  },
);

server.registerTool(
  "dsh_desktop_open_folder",
  {
    title: "在资源管理器中打开目录",
    description: "在系统文件管理器中打开指定目录（默认打开当前工作区目录）。",
    inputSchema: z.object({
      path: z.string().optional().describe("要打开的绝对路径；缺省为当前工作区"),
    }),
  },
  async (args) => {
    const result = await call("openFolder", { path: args.path });
    return text("已打开目录：" + (result.path || "(工作区)"));
  },
);

server.registerTool(
  "dsh_desktop_open_logs",
  {
    title: "打开 harness 日志目录",
    description: "在系统文件管理器中打开桌面端日志目录（dsh-web.log 所在目录）。",
    inputSchema: z.object({}),
  },
  async () => text("已打开日志目录：" + JSON.stringify(await call("openLogs"))),
);

server.registerTool(
  "dsh_desktop_open_terminal",
  {
    title: "打开终端模式窗口",
    description: "打开桌面端的“终端模式”窗口（headless 快速执行任务）。",
    inputSchema: z.object({}),
  },
  async () => text("已打开终端模式窗口"),
);

server.registerTool(
  "dsh_desktop_restart_app",
  {
    title: "重启桌面应用",
    description:
      "重启 DSH 桌面端（保留会话数据，重启后自动恢复）。" +
      "agent 主动重启（如升级、改主进程代码）时强烈建议带 task 参数写当前任务摘要：" +
      "重启完成后桌面端会把该任务作为新消息自动发送，会话自己继续，无需用户手动接续。",
    inputSchema: z.object({
      task: z.string().optional().describe("重启后自动接续的任务描述（下一步要做什么）"),
    }),
  },
  async (args) => {
    try { await call("restartApp", { task: args && args.task }); } catch { /* 重启中连接断开属正常 */ }
    return text("正在重启应用…" + ((args && args.task) ? "（重启后自动接续任务）" : ""));
  },
);

server.registerTool(
  "dsh_desktop_switch_workspace",
  {
    title: "切换工作区",
    description: "切换 harness 工作区目录并重启服务（会话按工作区隔离）。",
    inputSchema: z.object({
      path: z.string().describe("新的工作区绝对路径"),
    }),
  },
  async (args) => {
    await call("switchWorkspace", { path: args.path });
    return text("已切换工作区到：" + args.path);
  },
);

server.registerTool(
  "dsh_desktop_describe_image",
  {
    title: "图片识别（多模态视觉模型，注意力对齐）",
    description:
      "用配置的多模态视觉模型描述一张图片，返回文字描述。当当前会话模型不支持图片（如 DeepSeek 纯文本模型）时，" +
      "遇到图片附件引用（形如 sha256:<64位十六进制>）、图片文件路径或图片 URL 就调用本工具，" +
      "拿到文字描述后再继续（多模态模型如 deepseek-v4-flash-vision-exp 可原生接收图片，无需本工具）；" +
      "拿到文字描述后再继续。图片来源三选一：ref（harness 附件引用）、path（本地文件绝对路径）、url。" +
      "注意力对齐：务必把 question 填成你当前要解决的问题（视觉模型会围绕问题描述，避免泛泛而谈）；" +
      "先全局看一次，细节看不清时用 region 对局部裁剪放大再问一次（x/y/width/height 为原图像素坐标）。" +
      "例如：截图报错先问『这个报错的完整内容是什么』，再 region 放大报错区域。",
    inputSchema: z.object({
      ref: z.string().optional().describe("harness 附件引用（含 sha256: 的文本）"),
      path: z.string().optional().describe("本地图片文件绝对路径"),
      url: z.string().optional().describe("图片 URL（http/https）"),
      question: z.string().optional().describe("你当前要解决的问题——视觉模型将围绕它组织注意力（强烈建议填写）"),
      region: z.object({
        x: z.number().describe("裁剪区域左上角 x（原图像素）"),
        y: z.number().describe("裁剪区域左上角 y（原图像素）"),
        width: z.number().describe("裁剪宽度"),
        height: z.number().describe("裁剪高度"),
      }).optional().describe("可选：只放大看这一块（先全局后局部）"),
    }),
  },
  async (args) => {
    const result = await call("describeImage", { path: args.path, url: args.url, ref: args.ref, question: args.question, region: args.region }, VISION_RPC_TIMEOUT_MS);
    const meta = result.elapsedMs ? "\n（本地视觉识别耗时 " + Math.round(result.elapsedMs / 1000) + "s）" : "";
    return text(result.description + meta);
  },
);

server.registerTool(
  "dsh_desktop_api_balance",
  {
    title: "查询 DeepSeek API 余额",
    description:
      "查询 DeepSeek 官方 API 账户余额（GET api.deepseek.com/user/balance，使用 .credentials.yaml 中的 DEEPSEEK_API_KEY）。返回账户可用状态与各币种余额。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("getBalance");
    const lines = ["账户状态：" + (result.isAvailable ? "可用" : "不可用")];
    for (const info of result.balanceInfos || []) {
      lines.push("- " + (info.currency || "?") + "：总额 " + (info.total_balance ?? "?") + "（赠送 " + (info.granted_balance ?? "?") + "，充值 " + (info.topped_up_balance ?? "?") + "）");
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "dsh_desktop_api_usage",
  {
    title: "查询 API 用量与成本",
    description:
      "统计当前工作区所有会话的 token 用量（输入/缓存命中/输出/推理）与估算成本（按 settings.json 的 usagePrices 单价，默认 DeepSeek 参考价）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("getUsage");
    const t = result.total;
    const tier = (result.summary && result.summary.tier) || resolvePriceTier();
    const lines = [
      "输入（缓存未命中）：" + (t.inputTokens || 0).toLocaleString() + " tokens",
      "输入（缓存命中）：" + (t.cacheReadTokens || 0).toLocaleString() + " tokens",
      "输出：" + (t.outputTokens || 0).toLocaleString() + " tokens",
      "推理：" + (t.reasoningTokens || 0).toLocaleString() + " tokens",
      "估算成本：$" + (result.estimatedCostUsd || 0),
      "会话数：" + (result.sessions || []).length,
      "当前计费时段：" + tier.label + "（" + tier.note + "；约 " + tier.minutesUntil + " 分钟后切换为" + tier.nextTier + "）",
    ];
    return text(lines.join("\n"));
  },
);

/* ---- Windows 电脑操控（Codex/Claude computer-use 风格） ---- */

server.registerTool(
  "dsh_desktop_computer_screenshot",
  {
    title: "电脑截图（看屏幕）",
    description:
      "截取屏幕（可选区域），保存到工作区 .dsh-attachments/ 并返回路径；本地视觉模型启用时自动附带文字识别结果。" +
      "这是电脑操控闭环的第一步：先看屏幕，再操作，再截图验证。" +
      "region 为物理像素坐标，与保存的截图文件同一坐标系（全屏 1920×1080 时 x/y 取 0..1919/0..1079）；越界自动裁剪，实际范围见返回的 crop。",
    inputSchema: z.object({
      region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe("可选：截图区域（物理像素，与截图文件同一坐标系）"),
    }),
  },
  async (args) => {
    const result = await call("computerScreenshot", { region: args.region }, VISION_RPC_TIMEOUT_MS);
    const secs = result.descriptionElapsedMs ? "（耗时 " + Math.round(result.descriptionElapsedMs / 1000) + "s）" : "";
    return text(
      "截图已保存：" + result.path +
      "（" + result.width + "×" + result.height + "）" +
      (result.crop ? "；实际裁剪 " + result.crop.x + "," + result.crop.y + " " + result.crop.width + "×" + result.crop.height : "") +
      (result.description ? "\n识别结果" + secs + "：\n" + result.description : (result.descriptionError ? "\n识别失败：" + result.descriptionError : "\n（本地视觉模型未启用，可自行 read 或用 dsh_desktop_describe_image 识别）")),
    );
  },
);

server.registerTool(
  "dsh_desktop_computer_screen",
  {
    title: "获取屏幕信息",
    description: "返回主屏幕物理分辨率（像素，与截图文件同一坐标系；所有电脑操控坐标均以此为准）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("computerScreen");
    return text("屏幕分辨率：" + result.width + "×" + result.height);
  },
);

server.registerTool(
  "dsh_desktop_computer_mouse",
  {
    title: "鼠标操控",
    description:
      "操控鼠标（屏幕物理像素坐标，与截图文件同一坐标系，直接使用截图上的坐标）：position 查当前坐标；move 移动；click/rightclick/doubleclick 点击；drag 拖动（从 x,y 位移 dx,dy）；scroll 垂直滚动（amount 正上负下，1≈一次滚轮）；hscroll 水平滚动。",
    inputSchema: z.object({
      action: z.enum(["position", "move", "click", "rightclick", "doubleclick", "drag", "scroll", "hscroll"]).describe("鼠标动作"),
      x: z.number().optional().describe("屏幕 x 坐标（物理像素，与截图一致）"),
      y: z.number().optional().describe("屏幕 y 坐标（物理像素，与截图一致）"),
      dx: z.number().optional().describe("drag 的 x 位移"),
      dy: z.number().optional().describe("drag 的 y 位移"),
      amount: z.number().optional().describe("滚动量（1≈一次滚轮）"),
    }),
  },
  async (args) => {
    const result = await call("computerMouse", args);
    return text(JSON.stringify(result));
  },
);

server.registerTool(
  "dsh_desktop_computer_keyboard",
  {
    title: "键盘操控",
    description:
      "键盘输入：type 输入文本（支持中文，UTF-8 直接键入）；press 按组合键（keys 用逗号分隔，如 \"ctrl,s\" 或 \"enter\"；支持 enter/tab/esc/backspace/delete/space/up/down/left/right/home/end/pageup/pagedown/f1-f12/ctrl/shift/alt/win/单字母/数字）。",
    inputSchema: z.object({
      action: z.enum(["type", "press"]).describe("type=输入文本；press=按按键"),
      text: z.string().optional().describe("type 动作的文本"),
      keys: z.string().optional().describe("press 动作的按键（逗号分隔）"),
    }),
  },
  async (args) => {
    const result = await call("computerKeyboard", args);
    return text(JSON.stringify(result));
  },
);

server.registerTool(
  "dsh_desktop_computer_window",
  {
    title: "窗口操控",
    description:
      "操控 Windows 窗口：list 列出可见窗口（hwnd/标题/位置/尺寸，位置为物理像素、与截图文件同一坐标系）；active 当前活动窗口；focus/minimize/maximize/restore/close 按标题（title 子串匹配）或 hwnd 操作；move/resize 设置位置尺寸（物理像素）。",
    inputSchema: z.object({
      action: z.enum(["list", "active", "focus", "minimize", "maximize", "restore", "move", "resize", "close"]).describe("窗口动作"),
      title: z.string().optional().describe("窗口标题（子串匹配）"),
      hwnd: z.string().optional().describe("窗口句柄（来自 list/active）"),
      x: z.number().optional(), y: z.number().optional(),
      w: z.number().optional(), h: z.number().optional(),
    }),
  },
  async (args) => {
    const result = await call("computerWindow", args);
    if (result && Array.isArray(result.windows)) {
      const lines = result.windows.map((w) => "- [" + w.hwnd + "] " + w.title + " @ " + w.x + "," + w.y + " " + w.w + "×" + w.h);
      return text("可见窗口：\n" + lines.join("\n"));
    }
    return text(JSON.stringify(result));
  },
);

server.registerTool(
  "dsh_desktop_computer_clipboard",
  {
    title: "剪贴板读写",
    description: "读取或写入系统剪贴板文本。",
    inputSchema: z.object({
      action: z.enum(["get", "set"]).describe("get=读取；set=写入"),
      text: z.string().optional().describe("set 动作的文本"),
    }),
  },
  async (args) => {
    const result = await call("computerClipboard", args);
    return text(result.text !== undefined ? result.text : JSON.stringify(result));
  },
);

server.registerTool(
  "dsh_desktop_computer_launch",
  {
    title: "启动应用",
    description: "按路径或系统可识别名称启动应用（如 C:\\Windows\\notepad.exe 或 calc）。",
    inputSchema: z.object({
      target: z.string().describe("可执行文件路径或应用名称"),
    }),
  },
  async (args) => {
    await call("computerLaunch", { target: args.target });
    return text("已启动：" + args.target);
  },
);

server.registerTool(
  "dsh_desktop_schedule",
  {
    title: "定时任务与提醒",
    description:
      "管理桌面端定时任务/提醒：list 查看；add 新建（mode: once=单次 at 时间 / daily=每天 at 时间 / interval=每 N 分钟；kind: reminder=到点弹通知 / task=到点把任务文本派发给 harness 自动执行）；remove 删除；toggle 启停。at 格式 HH:MM（24 小时制）。",
    inputSchema: z.object({
      action: z.enum(["list", "add", "remove", "toggle"]).describe("操作"),
      id: z.string().optional().describe("remove/toggle 的任务 id"),
      enabled: z.boolean().optional().describe("toggle 的目标状态"),
      task: z.object({
        label: z.string().optional().describe("任务名称"),
        kind: z.enum(["reminder", "task"]).optional().describe("reminder=仅提醒；task=到点派发给 harness 执行"),
        mode: z.enum(["once", "daily", "interval"]).optional().describe("once/daily 用 at；interval 用 everyMinutes"),
        at: z.string().optional().describe("HH:MM，如 09:00"),
        everyMinutes: z.number().optional().describe("interval 模式：每 N 分钟"),
        task: z.string().describe("任务/提醒内容"),
      }).optional().describe("add 时的任务规格"),
    }),
  },
  async (args) => {
    if (args.action === "list") {
      const tasks = await call("scheduleList");
      if (!tasks.length) return text("暂无定时任务。可用 add 新建。");
      const lines = tasks.map((t) => {
        const when = t.mode === 'interval' ? ('每 ' + t.everyMinutes + ' 分钟') : ((t.mode === 'daily' ? '每天 ' : '单次 ') + t.at);
        return "- [" + t.id + "] " + (t.label || '(未命名)') + " · " + (t.kind === 'task' ? '派发任务' : '提醒') + " · " + when + (t.enabled ? '' : '（已停用）');
      });
      return text("定时任务：\n" + lines.join("\n"));
    }
    if (args.action === "add") {
      const created = await call("scheduleAdd", { task: args.task });
      return text("已创建定时任务：" + (created.label || created.id));
    }
    if (args.action === "remove") {
      await call("scheduleRemove", { id: args.id });
      return text("已删除任务：" + args.id);
    }
    if (args.action === "toggle") {
      await call("scheduleToggle", { id: args.id, enabled: args.enabled !== false });
      return text("已" + (args.enabled !== false ? "启用" : "停用") + "任务：" + args.id);
    }
    return text("未知操作：" + args.action);
  },
);

server.registerTool(
  "dsh_desktop_system_doctor",
  {
    title: "Windows 环境体检",
    description:
      "检查 Windows 开发环境常见问题：Node/Git/winget 是否可用、长路径支持、开发者模式、PowerShell 执行策略、控制台 UTF-8 编码。返回每项的 ok/detail 与可用的修复（fix）。",
    inputSchema: z.object({}),
  },
  async () => {
    const items = await call("systemDoctor");
    const lines = items.map((i) => (i.ok ? "✓ " : "✗ ") + i.title + "：" + i.detail + (i.fix ? "（可用 dsh_desktop_system_fix 修复：" + i.fix.id + "）" : ""));
    return text("Windows 环境体检（" + items.filter((i) => i.ok).length + "/" + items.length + " 项正常）：\n" + lines.join("\n"));
  },
);

server.registerTool(
  "dsh_desktop_system_fix",
  {
    title: "修复 Windows 环境问题",
    description:
      "修复系统体检发现的常见问题。fix 形如 { type: 'simple'|'admin', id: 'longpath'|'devmode'|'execpolicy'|'utf8' }；admin 类会弹 UAC 提权确认，用户取消即失败。",
    inputSchema: z.object({
      fix: z.object({
        type: z.enum(["simple", "admin"]).describe("simple=无需管理员；admin=需要 UAC 提权"),
        id: z.enum(["longpath", "devmode", "execpolicy", "utf8"]).describe("修复项"),
      }).describe("来自 dsh_desktop_system_doctor 的 fix 字段"),
    }),
  },
  async (args) => {
    const result = await call("systemFix", { fix: args.fix });
    if (!result.ok) throw new Error(result.error || "修复失败");
    return text("修复完成：" + (result.detail || args.fix.id) + "\n建议重新运行 dsh_desktop_system_doctor 确认。");
  },
);

server.registerTool(
  "dsh_desktop_system_env",
  {
    title: "管理用户环境变量",
    description:
      "管理 Windows 用户级环境变量（HKCU\\Environment，新进程立即生效）：list 查看常用变量（含 PATH）；get/set/remove 读写。PATH 修改要小心：set 会整体覆盖，建议先 get 再拼接。",
    inputSchema: z.object({
      action: z.enum(["list", "get", "set", "remove"]).describe("操作"),
      name: z.string().optional().describe("变量名（get/set/remove）"),
      value: z.string().optional().describe("set 的新值"),
    }),
  },
  async (args) => {
    if (args.action === "list") {
      const vars = await call("systemEnvList");
      const names = Object.keys(vars);
      if (!names.length) return text("暂无常用用户环境变量。");
      return text("用户环境变量：\n" + names.map((n) => "- " + n + " = " + (n === 'PATH' ? '(共 ' + vars[n].split(';').filter(Boolean).length + ' 项，用 get 查看)' : String(vars[n]).slice(0, 200))).join("\n"));
    }
    if (args.action === "get") {
      const vars = await call("systemEnvList");
      return text(args.name + " = " + (vars[args.name] ?? "(未设置)"));
    }
    if (args.action === "set") {
      const result = await call("systemEnvSet", { name: args.name, value: args.value });
      if (!result.ok) throw new Error(result.error || "设置失败");
      return text("已设置用户环境变量 " + args.name);
    }
    if (args.action === "remove") {
      const result = await call("systemEnvRemove", { name: args.name });
      if (!result.ok) throw new Error(result.error || "删除失败");
      return text("已删除用户环境变量 " + args.name);
    }
    return text("未知操作：" + args.action);
  },
);

// ---- 项目代码地图（长代码/大项目：首次精读建图 + 更新后同步补图） ----

server.registerTool(
  "dsh_desktop_project_map_get",
  {
    title: "读取项目代码地图",
    description:
      "读取当前工作区的项目代码地图（.dsh/project-map.md）：首次面对长代码/大项目时先调本工具——" +
      "无地图则做一次仔细精读后建图（用 project_map_set 保存）；有地图且 staleFiles 为空则直接按地图推进、不要整文件重复读。" +
      "返回：地图正文（可能截断）、跟踪文件数、staleFiles（自上次建图后有改动的文件，需重读并增量补图）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("projectMapGet");
    if (!result.ok) throw new Error(result.error || "读取失败");
    const lines = [];
    lines.push(result.exists
      ? "项目地图已存在（更新于 " + new Date(result.updatedAt).toLocaleString() + "，跟踪 " + result.tracked + " 个文件）。"
      : "项目地图不存在——请按 long-code 方法首次仔细精读项目后，用 dsh_desktop_project_map_set 保存地图。");
    if (result.exists) {
      lines.push("stale 文件 " + result.staleCount + " 个" + (result.staleFiles.length ? "：" + result.staleFiles.join("、") : ""));
      if (result.gitHeadChanged) lines.push("提示：git HEAD 已变化但指纹未变，请按需核对。");
      lines.push("---- 地图正文 ----");
      lines.push(result.map || "（空）");
    }
    return text(lines.join("\n"), { maxChars: 8000 });
  },
);

server.registerTool(
  "dsh_desktop_project_map_status",
  {
    title: "查询代码地图同步状态",
    description:
      "轻量查询：代码地图是否存在、跟踪多少文件、哪些文件自上次建图后有改动（stale）。" +
      "代码更新后用它判断地图哪些部分需要补；返回不改动任何文件。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("projectMapStatus");
    if (!result.ok) throw new Error(result.error || "查询失败");
    if (!result.exists) return text("项目地图不存在（可用 dsh_desktop_project_map_get 建图指引）。");
    return text(
      "地图存在（更新于 " + new Date(result.updatedAt).toLocaleString() + "，跟踪 " + result.tracked + " 个文件）。\n" +
      "stale 文件 " + result.staleCount + " 个" + (result.staleFiles.length ? "：" + result.staleFiles.join("、") : "（地图全部最新）") +
      (result.gitHeadChanged ? "\ngit HEAD 已变化但指纹未变，请按需核对。" : ""),
    );
  },
);

server.registerTool(
  "dsh_desktop_project_map_set",
  {
    title: "保存/更新项目代码地图",
    description:
      "保存或增量更新项目代码地图（写入 .dsh/project-map.md 并记录文件指纹）。" +
      "map 为地图正文 Markdown：项目定位、模块划分、入口、构建/测试命令、关键约定与陷阱、重点文件职责摘要。" +
      "files 为本次精读覆盖的文件相对路径（缺省自动扫描工作区源码文件）；" +
      "只更新了部分模块时只传 map 全量正文 + 本次重读的文件，未传的旧指纹保留。",
    inputSchema: z.object({
      map: z.string().describe("地图正文（Markdown）"),
      files: z.array(z.string()).optional().describe("本次精读的文件相对路径；缺省自动扫描工作区"),
    }),
  },
  async (args) => {
    const result = await call("projectMapSet", { map: args.map, files: args.files });
    if (!result.ok) throw new Error(result.error || "保存失败");
    return text("地图已保存：本次指纹覆盖 " + result.scanned + " 个文件（跳过 " + result.skipped + "），当前跟踪 " + result.tracked + " 个。");
  },
);

// ---- 多会话编辑占用 + 变更日志（并发互不干扰 + 可回溯） ----

server.registerTool(
  "dsh_desktop_edit_claim",
  {
    title: "认领文件编辑权",
    description:
      "修改文件前先认领（多会话并发防护）：声明本会话要改的文件列表。" +
      "返回 conflicts 时表示这些文件已被其他会话占用——不要覆盖，先告知用户协调或等待释放。" +
      "同一任务新增文件可再次调用；占用 30 分钟自动过期。",
    inputSchema: z.object({
      files: z.array(z.string()).describe("要修改的文件相对路径列表"),
    }),
  },
  async (args) => {
    const result = await call("editClaim", { files: args.files });
    if (!result.ok) throw new Error(result.error || "认领失败");
    const lines = ["已认领 " + result.claimed.length + " 个文件。"];
    if (result.conflicts.length) {
      lines.push("⚠ 冲突（被其他会话占用，勿覆盖）：");
      for (const c of result.conflicts) lines.push("- " + c.file + "（会话 " + c.sessionId + (c.label ? " · " + c.label : "") + "）");
      lines.push("请告知用户有另一个对话正在改这些文件，协调后再动手。");
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "dsh_desktop_edit_release",
  {
    title: "释放文件编辑权",
    description: "改完并验证后释放本会话对文件的占用；files 缺省释放本会话全部占用。",
    inputSchema: z.object({
      files: z.array(z.string()).optional().describe("要释放的文件相对路径；缺省释放全部"),
    }),
  },
  async (args) => {
    const result = await call("editRelease", { files: args.files });
    if (!result.ok) throw new Error(result.error || "释放失败");
    return text("已释放 " + result.released.length + " 个文件。" + (result.released.length ? "：" + result.released.join("、") : "（无占用可释放）"));
  },
);

server.registerTool(
  "dsh_desktop_edit_status",
  {
    title: "查询文件编辑占用",
    description:
      "查询当前工作区的文件编辑占用：mine=本会话占用的文件；others=其他会话占用的文件。" +
      "改文件前先查，避免两个对话同时改同一文件互相覆盖。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("editStatus");
    if (!result.ok) throw new Error(result.error || "查询失败");
    const lines = ["文件编辑占用（共 " + result.total + " 项）："];
    if (result.mine.length) {
      lines.push("本会话占用 " + result.mine.length + " 个：" + result.mine.map((c) => c.file).join("、"));
    }
    if (result.others.length) {
      lines.push("⚠ 其他会话占用 " + result.others.length + " 个：");
      for (const c of result.others) lines.push("- " + c.file + "（会话 " + c.sessionId + (c.label ? " · " + c.label : "") + "）");
    }
    if (!result.mine.length && !result.others.length) lines.push("（当前无占用）");
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "dsh_desktop_edit_journal",
  {
    title: "查询变更日志",
    description: "查询工作区变更日志（.dsh/change-journal.jsonl）：谁在何时认领/释放/快照了哪些文件，完整可回溯。",
    inputSchema: z.object({
      limit: z.number().optional().describe("最近条数（默认 50）"),
    }),
  },
  async (args) => {
    const result = await call("editJournal", { limit: args.limit });
    if (!result.ok) throw new Error(result.error || "查询失败");
    const entries = result.entries || [];
    if (!entries.length) return text("（变更日志为空）");
    return text(entries.slice(0, 50).map((e) =>
      new Date(e.time).toLocaleString() + " [" + (e.action || "?") + "] " + (e.sessionId || "?") +
      (e.files && e.files.length ? " · " + e.files.slice(0, 12).join("、") + (e.files.length > 12 ? " 等" : "") : "")).join("\n"));
  },
);

// ---- Git（白名单安全操作，保证代码可回溯） ----

server.registerTool(
  "dsh_desktop_git_status",
  {
    title: "Git 状态",
    description: "当前工作区 git 状态（porcelain：分支、变更文件、未跟踪文件）。非 git 仓库会报错（可先 git_init）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("gitStatus");
    if (!result.ok) throw new Error(result.error || "git status 失败");
    return text(result.output || "（工作区干净）");
  },
);

server.registerTool(
  "dsh_desktop_git_diff",
  {
    title: "Git 差异",
    description: "查看差异：默认未暂存改动；staged=true 看暂存区；path 指定单个文件。",
    inputSchema: z.object({
      staged: z.boolean().optional().describe("看暂存区差异"),
      path: z.string().optional().describe("只看某个文件的相对路径"),
    }),
  },
  async (args) => {
    const result = await call("gitDiff", { staged: args.staged, path: args.path });
    if (!result.ok) throw new Error(result.error || "git diff 失败");
    return text(result.output || "（无差异）", { maxChars: 10000 });
  },
);

server.registerTool(
  "dsh_desktop_git_log",
  {
    title: "Git 提交日志",
    description: "最近 n 条提交（单行）。",
    inputSchema: z.object({
      n: z.number().optional().describe("条数（默认 20，上限 100）"),
    }),
  },
  async (args) => {
    const result = await call("gitLog", { n: args.n });
    if (!result.ok) throw new Error(result.error || "git log 失败");
    return text(result.output || "（无提交）");
  },
);

server.registerTool(
  "dsh_desktop_git_commit",
  {
    title: "Git 提交快照",
    description:
      "提交快照：git add -A + commit，消息自动加 [dsh:会话id] 前缀保证可回溯。" +
      "每个任务块完成后提交一次（提交信息写清做了什么、为什么）；paths 可只提交部分文件。",
    inputSchema: z.object({
      message: z.string().describe("提交说明（做什么、为什么）"),
      paths: z.array(z.string()).optional().describe("只提交这些相对路径；缺省全部"),
    }),
  },
  async (args) => {
    const result = await call("gitCommit", { message: args.message, paths: args.paths });
    if (!result.ok) throw new Error(result.error || "git commit 失败");
    return text(result.output || "已提交");
  },
);

server.registerTool(
  "dsh_desktop_git_branch",
  {
    title: "Git 分支列表",
    description: "列出本地分支（当前分支带 *）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("gitBranch");
    if (!result.ok) throw new Error(result.error || "git branch 失败");
    return text(result.output || "（无分支）");
  },
);

server.registerTool(
  "dsh_desktop_git_checkout",
  {
    title: "Git 切换/新建分支",
    description: "切换分支（create=true 新建并切换）。有未提交变更时自动 stash 保护（可用 git_stash action=pop 恢复）。",
    inputSchema: z.object({
      branch: z.string().describe("目标分支名"),
      create: z.boolean().optional().describe("新建分支"),
    }),
  },
  async (args) => {
    const result = await call("gitCheckout", { branch: args.branch, create: args.create });
    if (!result.ok) throw new Error(result.error || "checkout 失败");
    return text(result.output || "已切换");
  },
);

server.registerTool(
  "dsh_desktop_git_restore",
  {
    title: "Git 回滚恢复",
    description: "回滚改动：git restore。默认丢弃全部未暂存改动；staged=true 撤销暂存；path 只恢复某个文件。危险操作，回滚前确认。",
    inputSchema: z.object({
      staged: z.boolean().optional().describe("撤销暂存（git restore --staged）"),
      path: z.string().optional().describe("只恢复某个文件"),
    }),
  },
  async (args) => {
    const result = await call("gitRestore", { staged: args.staged, path: args.path });
    if (!result.ok) throw new Error(result.error || "git restore 失败");
    return text("已回滚。" + (result.output ? "\n" + result.output : ""));
  },
);

server.registerTool(
  "dsh_desktop_git_stash",
  {
    title: "Git 暂存栈",
    description: "stash 管理：action=list 列出；push 暂存当前改动（可带 message）；pop 恢复（index 从 0 开始，缺省最近一条）。",
    inputSchema: z.object({
      action: z.enum(["list", "push", "pop"]).describe("操作"),
      message: z.string().optional().describe("push 的备注"),
      index: z.number().optional().describe("pop 第 index 条（0 起，缺省最近）"),
    }),
  },
  async (args) => {
    const result = await call("gitStash", { action: args.action, message: args.message, index: args.index });
    if (!result.ok) throw new Error(result.error || "git stash 失败");
    return text(result.output || (args.action === "list" ? "（暂存栈为空）" : "已完成"));
  },
);

// ---- 跨会话消息（P0-1）：给另一个对话发消息 / 查看自己的未读（收件箱独立于官方会话文件） ----

server.registerTool(
  "dsh_desktop_send_session_message",
  {
    title: "跨会话发消息",
    description:
      "给另一个对话（会话）发一条跨会话消息：目标会话的右侧面板顶部会出现“来自本会话 X”折叠卡片，" +
      "展开后可见消息并可交给该会话处理（可配合 dsh_desktop_session_inbox_status 查询对方是否已读）。" +
      "典型用法：本会话完成了对方请求的某件事、或需要把结论/任务转交另一个对话时。" +
      "fromSessionId 缺省为当前激活会话（主进程自动判定）；给会话 id 相同（自己）发消息会被拒绝。" +
      "toSessionId 可从 EnvPanel「会话」行或会话列表/交接文件中获取（形如 session-xxxxxxxx-…）。",
    inputSchema: z.object({
      toSessionId: z.string().describe("目标会话 id（形如 session-xxxxxxxx-…）"),
      text: z.string().max(4000).describe("消息内容（≤4000 字符；对方展开卡片才能看到，不影响官方对话历史）"),
      fromSessionId: z.string().optional().describe("来源会话 id（缺省自动取当前激活会话）"),
    }),
  },
  async (args) => {
    const result = await call("sessionMessageSend", {
      toSessionId: args.toSessionId,
      text: args.text,
      fromSessionId: args.fromSessionId,
    });
    if (!result.ok) throw new Error(result.error || "发送失败");
    const sender = result.message && (result.message.fromTitle || result.message.from);
    return text("已投递到会话 " + args.toSessionId + " 的收件箱（" +
      (sender ? "来自 " + sender + "；" : "") +
      "对方面板顶部会出现折叠卡片，展开才可见消息内容）。");
  },
);

server.registerTool(
  "dsh_desktop_session_inbox_status",
  {
    title: "查询跨会话消息",
    description:
      "查询指定会话的跨会话消息收件箱：默认只返回未读消息（新→旧），includeRead=true 时含最近已读。" +
      "用它检查别的对话是否给自己发来了消息/交接；EnvPanel 顶部卡片显示的就是这里的数据。",
    inputSchema: z.object({
      sessionId: z.string().describe("要查询的会话 id"),
      includeRead: z.boolean().optional().describe("是否包含已读（缺省只查未读）"),
      limit: z.number().optional().describe("返回条数（缺省 20）"),
    }),
  },
  async (args) => {
    const result = await call("sessionInboxStatus", {
      sessionId: args.sessionId,
      includeRead: args.includeRead,
      limit: args.limit,
    });
    if (!result.ok) throw new Error(result.error || "查询失败");
    const lines = ["会话 " + args.sessionId + " 收件箱：未读 " + result.unread + " 条。"];
    if (!result.items.length) lines.push("（无" + (args.includeRead ? "消息" : "未读消息") + "）");
    for (const m of result.items) {
      const when = new Date(m.time).toLocaleString();
      lines.push("- [" + (m.read ? "已读" : "未读") + "] " + when + " 来自 " + (m.fromTitle || m.from) + "：" + m.text);
    }
    return text(lines.join("\n"), { maxChars: 8000 });
  },
);

server.registerTool(
  "dsh_desktop_session_inbox_mark_read",
  {
    title: "标记跨会话消息已读",
    description: "把指定会话收件箱的消息标记为已读：ids 缺省标记全部；也可只标记指定消息 id（从 inbox_status 的返回中取）。",
    inputSchema: z.object({
      sessionId: z.string().describe("会话 id"),
      ids: z.array(z.string()).optional().describe("只标记这些消息 id（缺省全部）"),
    }),
  },
  async (args) => {
    const result = await call("sessionInboxMarkRead", { sessionId: args.sessionId, ids: args.ids });
    if (!result.ok) throw new Error(result.error || "标记失败");
    return text(result.marked ? "已标记 " + result.marked + " 条为已读。" : "（没有需要标记的消息）");
  },
);

server.registerTool(
  "dsh_desktop_git_init",
  {
    title: "Git 初始化仓库",
    description: "在当前工作区 git init（提供可回溯的基础；已初始化则返回提示）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("gitInit");
    if (!result.ok) throw new Error(result.error || "git init 失败");
    return text(result.output || "已初始化");
  },
);

// ---- GitHub 集成（设备码登录 / 远程仓库 / 代码搜索 / 分支协作） ----

server.registerTool(
  "dsh_desktop_github_status",
  {
    title: "GitHub 登录与远程状态",
    description:
      "查询 GitHub 集成状态：是否登录（login）、本地仓库当前分支、origin 远程地址。" +
      "未登录时提示用户用 dsh_desktop_github_login 登录。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("githubStatus");
    if (!result.ok) throw new Error(result.error || "查询失败");
    const lines = [];
    if (result.authed) {
      lines.push("GitHub 已登录：" + result.login + (result.name ? "（" + result.name + "）" : "") + (result.htmlUrl ? " · " + result.htmlUrl : ""));
    } else {
      lines.push("GitHub 未登录——可调 dsh_desktop_github_login 快速登录（设备码）。");
    }
    lines.push("当前分支：" + (result.branch || "?"));
    lines.push("远程 origin：" + (result.remote ? result.remote.split("\n")[0] : "未关联——登录后用 dsh_desktop_github_remote_setup 一键创建私有仓库并推送"));
    if (result.visibility) {
      lines.push("仓库可见性：" + (result.visibility === 'public' ? '完全公开（任何人可下载）' : (result.visibility === 'private' ? '私有' : result.visibility)) + " · " + (result.repoHtmlUrl || ""));
      lines.push("切换可见性用 dsh_desktop_github_set_visibility（公开前确认无密钥/个人信息）。");
    }
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "dsh_desktop_github_login",
  {
    title: "GitHub 快速登录（设备码）",
    description:
      "发起 GitHub 设备码登录：返回验证网址与用户码。请把网址和用户码展示给用户（打开网址、输入用户码、授权），" +
      "然后调 dsh_desktop_github_login_wait 等待完成。无需 gh CLI、无需手动复制 token。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("githubLoginStart");
    if (!result.ok) throw new Error(result.error || "发起失败");
    return text(
      "请在浏览器完成授权（约 15 分钟有效）：\n" +
      "1. 打开 " + result.verificationUri + "\n" +
      "2. 输入用户码：" + result.userCode + "\n" +
      "3. 点授权（scope: repo，用于私有仓库与代码搜索）\n\n" +
      "完成后调用 dsh_desktop_github_login_wait 等待登录结果。",
    );
  },
);

server.registerTool(
  "dsh_desktop_github_login_wait",
  {
    title: "等待 GitHub 登录完成",
    description:
      "轮询等待设备码授权结果（调用前需已执行 dsh_desktop_github_login；用户完成授权后本调用返回登录成功）。最多等待约 10 分钟。",
    inputSchema: z.object({}),
  },
  async () => {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const r = await call("githubLoginPoll");
      if (r.ok && r.pending === false) {
        return text("GitHub 登录成功：" + r.login + (r.name ? "（" + r.name + "）" : "") + "\n接下来可用 dsh_desktop_github_remote_setup 一键关联远程仓库。");
      }
      if (!r.ok) throw new Error(r.error || "登录失败");
      await new Promise((res) => setTimeout(res, (r.slowDown ? 10 : 5) * 1000));
    }
    return text("等待超时：用户未在 10 分钟内完成授权。可重新调 dsh_desktop_github_login 再试。");
  },
);

server.registerTool(
  "dsh_desktop_github_remote_setup",
  {
    title: "一键关联 GitHub 远程仓库并推送",
    description:
      "已登录状态下：本地仓库无 origin 时自动创建同名私有 GitHub 仓库（默认私有，name 可指定）并关联，然后推送当前分支（-u origin）。" +
      "已有 origin 则直接推送。让代码与 GitHub 互通、分支真正用起来。",
    inputSchema: z.object({
      name: z.string().optional().describe("仓库名（缺省用工作区目录名）"),
      isPrivate: z.boolean().optional().describe("默认 true（私有）"),
    }),
  },
  async (args) => {
    const result = await call("githubRemoteSetup", { name: args.name, isPrivate: args.isPrivate });
    if (!result.ok) throw new Error(result.error || "关联失败");
    if (result.repo) {
      return text("已创建并关联远程仓库：\n" + result.repo.fullName + "（" + (result.repo.isPrivate ? "私有" : "公开") + "）\n" + result.repo.htmlUrl + "\n推送结果：" + String(result.pushed || "").slice(0, 600));
    }
    return text("已推送到 origin：" + String(result.pushed || "").slice(0, 600));
  },
);

server.registerTool(
  "dsh_desktop_github_search_code",
  {
    title: "GitHub 代码搜索",
    description:
      "搜索 GitHub 上的代码（需已登录）：q 用 GitHub 代码搜索语法，如 \"repo:owner/name keyword\"、" +
      "\"filename:config.js keyword\"、\"org:github language:javascript keyword\"。返回匹配文件与仓库，方便模型查找参考实现。",
    inputSchema: z.object({
      q: z.string().describe("搜索语法（如 repo:owner/name 关键词）"),
      perPage: z.number().optional().describe("条数（默认 10，上限 20）"),
    }),
  },
  async (args) => {
    const result = await call("githubSearchCode", { q: args.q, perPage: args.perPage });
    if (!result.ok) throw new Error(result.error || "搜索失败");
    const lines = ["GitHub 代码搜索结果（共 " + result.total + " 条，显示 " + (result.items || []).length + "）："];
    for (const it of result.items || []) {
      lines.push("- " + it.repository + " · " + it.path + " · " + it.htmlUrl);
    }
    return text(lines.join("\n"));
  },
);

// ---- Git 分支协作（push/pull/merge，全部禁 force） ----

server.registerTool(
  "dsh_desktop_github_set_visibility",
  {
    title: "切换仓库可见性",
    description:
      "切换 GitHub 远程仓库的可见性：private=true 私有（仅本人与协作者可见），private=false 完全公开（任何人可下载）。" +
      "⚠ 公开不可逆：公开后被他人 fork 的副本不受控制；公开前确认仓库不含密钥/个人信息。",
    inputSchema: z.object({
      private: z.boolean().describe("true=私有；false=完全公开"),
    }),
  },
  async (args) => {
    const result = await call("githubSetVisibility", { isPrivate: args.private });
    if (!result.ok) throw new Error(result.error || "切换失败");
    return text("仓库已切换为" + (result.visibility === 'public' ? '公开' : '私有') + "：" + result.fullName + "\n" + result.htmlUrl);
  },
);

server.registerTool(
  "dsh_desktop_git_push",
  {
    title: "Git 推送到远程",
    description: "推送当前分支到远程（-u origin <branch>；禁 force）。未关联远程先调 dsh_desktop_github_remote_setup。",
    inputSchema: z.object({
      branch: z.string().optional().describe("分支名（缺省当前分支）"),
    }),
  },
  async (args) => {
    const result = await call("gitPush", { branch: args.branch });
    if (!result.ok) throw new Error(result.error || "推送失败");
    return text(result.output || "已推送");
  },
);

server.registerTool(
  "dsh_desktop_git_pull",
  {
    title: "Git 拉取（仅快进）",
    description: "从远程拉取（--ff-only，绝不产生意外合并）。",
    inputSchema: z.object({
      branch: z.string().optional().describe("分支名（缺省当前分支）"),
    }),
  },
  async (args) => {
    const result = await call("gitPull", { branch: args.branch });
    if (!result.ok) throw new Error(result.error || "拉取失败");
    return text(result.output || "已更新");
  },
);

server.registerTool(
  "dsh_desktop_git_merge",
  {
    title: "Git 合并分支",
    description: "把指定分支合并进当前分支（优先快进）。冲突时按 resolving-merge-conflicts skill 处理。",
    inputSchema: z.object({
      branch: z.string().describe("要合并进来的分支名"),
    }),
  },
  async (args) => {
    const result = await call("gitMerge", { branch: args.branch });
    if (!result.ok) throw new Error(result.error || "合并失败");
    return text(result.output || "已合并");
  },
);

server.registerTool(
  "dsh_desktop_git_remote",
  {
    title: "Git 远程列表",
    description: "查看远程仓库列表（git remote -v）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("gitRemoteList");
    if (!result.ok) throw new Error(result.error || "读取失败");
    return text(result.output || "（无远程）");
  },
);

// ---- 外部机器人桥：企业微信推送 / 机器人状态 ----

server.registerTool(
  "dsh_desktop_wechat_push",
  {
    title: "企业微信推送",
    description:
      "把文本推送到配置的企业微信群机器人（markdown 格式，≤4096 字节自动截断）。单向推送：" +
      "只能发到群、收不到群消息。用于主动汇报/定时推送/任务完成通知。需先在桌面端设置页「机器人」分区配置 webhook 并开启。",
    inputSchema: z.object({
      text: z.string().describe("要推送的文本（markdown）"),
    }),
  },
  async (args) => {
    const result = await call("wechatPush", { text: args.text });
    if (!result.ok) throw new Error(result.error || "推送失败");
    return text("已推送到企业微信群");
  },
);

server.registerTool(
  "dsh_desktop_bot_status",
  {
    title: "机器人状态",
    description: "查询 QQ 机器人与企业微信推送的配置与连接状态。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("botStatus");
    return text(
      "QQ 机器人：" + (result.qq && result.qq.configured ? "已配置" : "未配置") +
        (result.qq && result.qq.enabled ? "、已启用、状态 " + result.qq.state + (result.qq.detail ? "（" + result.qq.detail + "）" : "") : "、未启用") +
      "\n企业微信：配置 " + (result.wechat && result.wechat.configured ? "有 webhook" : "无 webhook") +
        (result.wechat && result.wechat.enabled ? "、已启用" : "、未启用") +
        (result.wechat && result.wechat.pushOnComplete ? "、每轮完成自动推送" : ""),
    );
  },
);

// ---- 文生图（主模型写 prompt，云端生图模型执行） ----

server.registerTool(
  "dsh_desktop_generate_image",
  {
    title: "文生图",
    description:
      "调用配置的云端文生图模型（OpenAI 兼容 images/generations，如硅基流动 FLUX / 通义万相）生成图片。" +
      "主模型负责写好 prompt（中文即可，描述画面内容/风格/构图），生成结果保存到工作区 .dsh-attachments/ 并返回文件路径。" +
      "生成后用 dsh_desktop_open_folder 打开附件目录或 read_image 查看。需先在桌面端设置页「图片生成」块配置 baseUrl/apiKey/model。",
    inputSchema: z.object({
      prompt: z.string().describe("画面描述 prompt（中文，写清主体/场景/风格/光影/构图）"),
      size: z.string().optional().describe("尺寸（服务商支持值，如 1024x1024 / 768x1024 / 1440x720；缺省用配置默认）"),
      n: z.number().optional().describe("生成张数（1-4，默认 1）"),
    }),
  },
  async (args) => {
    const result = await call("imageGenerate", { prompt: args.prompt, size: args.size, n: args.n });
    if (!result.ok) throw new Error(result.error || "生成失败");
    const files = result.files || [];
    const lines = files.map((f, i) =>
      "第 " + (i + 1) + " 张已保存：" + f.path + (f.revisedPrompt ? "\n（服务商改写后的 prompt：" + f.revisedPrompt + "）" : ""));
    return text(lines.join("\n"));
  },
);

// ---- UI 内省（读桌面端自己窗口的 DOM：结构化定位/精确点击/读文本/自窗口截图） ----

server.registerTool(
  "dsh_desktop_ui_snapshot",
  {
    title: "UI 元素清单（桌面端窗口）",
    description:
      "读取桌面端自己窗口（harness 页面）的可点击元素清单：标签、类型、id/class 与精确坐标（页面坐标系）。" +
      "用于精确点击与状态验证——不要再用屏幕截图+OCR 猜坐标：先 snapshot 拿到元素，再 ui_click 按文本/选择器点击，最后 ui_text/ui_capture 验证。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("uiSnapshot");
    if (!result.ok) throw new Error(result.error || "读取失败");
    const els = (result.elements || []).slice(0, 60);
    const lines = ['视口 ' + result.vw + '×' + result.vh + '（dpr ' + result.dpr + '），共 ' + (result.elements || []).length + ' 个可点击元素，显示前 ' + els.length + '：'];
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      const id = e.text ? " '" + e.text.slice(0, 40) + "'" : '';
      lines.push(i + '. <' + e.tag + '>' + id + ' @(' + e.x + ',' + e.y + ' ' + e.w + '×' + e.h + ')' + (e.id ? ' #' + e.id : '') + (e.cls ? ' .' + e.cls.split(' ')[0] : ''));
    }
    return text(lines.join('\n'), { maxChars: 6000 });
  },
);

server.registerTool(
  "dsh_desktop_ui_click",
  {
    title: "UI 精确点击（桌面端窗口）",
    description:
      "在桌面端窗口内精确点击：text=按按钮/链接的文本匹配（取第 index 个，默认 0），selector=按 CSS 选择器。" +
      "先 dsh_desktop_ui_snapshot 看有哪些元素再点；点击后可用 ui_text/ui_capture 验证结果。",
    inputSchema: z.object({
      text: z.string().optional().describe("按文本匹配（aria-label/title/innerText 包含即命中）"),
      selector: z.string().optional().describe("按 CSS 选择器（优先于 text）"),
      index: z.number().optional().describe("第几个匹配（0 起，默认 0）"),
    }),
  },
  async (args) => {
    const result = await call("uiClick", { text: args.text, selector: args.selector, index: args.index });
    if (!result.ok) throw new Error(result.error || "点击失败");
    if (result.error === 'not found') {
      return text("未找到匹配元素（候选 " + (result.candidates || 0) + " 个）——先 dsh_desktop_ui_snapshot 确认元素的文本/位置。");
    }
    return text("已点击 <" + result.tag + ">" + (result.text ? " '" + result.text + "'" : ""));
  },
);

server.registerTool(
  "dsh_desktop_ui_text",
  {
    title: "读取 UI 元素文本",
    description: "读取桌面端窗口内某元素的文本内容（CSS 选择器）：用于验证点击结果/面板状态，比截图 OCR 可靠且零成本。",
    inputSchema: z.object({
      selector: z.string().describe("CSS 选择器（如 [data-dsh-desktop-env-panel]）"),
      cap: z.number().optional().describe("截断上限（默认 4000 字）"),
    }),
  },
  async (args) => {
    const result = await call("uiText", { selector: args.selector, cap: args.cap });
    if (!result.ok) throw new Error(result.error || "读取失败");
    if (result.error === 'selector not found') return text("选择器未找到元素：" + args.selector);
    return text(result.text || "（空）");
  },
);

server.registerTool(
  "dsh_desktop_ui_capture",
  {
    title: "截桌面端自己窗口的图",
    description:
      "截取桌面端窗口内容（capturePage，不受其他窗口叠放遮挡影响），保存到工作区附件目录并返回 PNG 路径。" +
      "返回路径后配合 mcp__dsh_desktop__describe_image 用 question 定点看图（先全局后 region 放大）。",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await call("uiCaptureSelf");
    if (!result.ok) throw new Error(result.error || "截图失败");
    return text("已保存：" + result.path + "\n尺寸：" + result.width + "×" + result.height + "\n可用 describe_image（path=" + result.path + "）按问题定点查看。");
  },
);

// ---- 生命周期 ----
const transport = new StdioServerTransport();
try {
  await server.connect(transport);
  log("connected, ready for MCP client");
} catch (err) {
  log("startup failed: " + (err && err.message ? err.message : String(err)));
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    try {
      await server.close();
      await transport.close();
    } catch { /* ignore */ }
    process.exit(0);
  });
}
