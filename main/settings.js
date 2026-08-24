'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  workspace: null,          // 工作区目录；null 表示首次启动时询问
  autoUpdate: true,         // 启动时自动检查更新，发现新版本则弹窗提示
  silentAutoUpdate: false,  // 为 true 时不询问，直接更新并重启
  checkPrereleases: false,  // 同时考虑 next 标签（预发布版）
  showUpdateBadge: true,    // 在界面右上角显示“发现新版本”角标
  updateGuard: null,        // 更新事务标记 { version, startedAt, status: 'in-progress'|'failed'|'ok' }；null 表示无进行中的更新
  serverPort: null,         // 固定端口：热启动依赖同一 origin（localStorage 记住当前会话）
  enableDesktopMcp: true,   // 内置 dsh_desktop MCP 服务器（harness 可自主调用桌面能力）
  mcpServers: [],           // 额外 MCP 服务器（serverName/transport/command/args/url/env...）
  permissionMode: 'workspace-write', // 沙箱/审批模式：read-only | workspace-write | danger-full-access
  notifyOnComplete: true,   // 任务完成时发原生通知（窗口不在前台时）
  recentWorkspaces: [],     // 最近使用的工作区（菜单快速切换）
  vision: null,             // 多模态图片识别模型：{ enabled, baseUrl, apiKey, model }（仅处理图片）
  usagePrices: null,        // 成本估算单价（$/1M tokens）：{ input, output, cacheHit, cacheMiss }；null 用默认
  autoStart: false,         // 开机自启
  closeToTray: true,        // 关闭窗口时最小化到托盘而不是退出
  contextWarningEnabled: true,  // 上下文接近上限时提醒（弹通知 + 状态胶囊警示）
  contextWarningTokens: 100000, // 上下文告警阈值（当前会话累计 tokens）
  quietHoursEnabled: false,     // 通知免打扰：开启后深夜时段不弹原生通知（保留 flashFrame 与日志）
  quietHoursStart: '23:00',     // 免打扰开始时间（"HH:MM"，24 小时制）
  quietHoursEnd: '07:00',       // 免打扰结束时间（"HH:MM"，24 小时制）
  memoryAutoEnabled: true,      // 会话收尾自动记忆（整轮对话完成后自动抽取知识入图谱）
  memoryLastSeen: null,         // 自动记忆进度 { sessionId, lastUserTime }，避免重复抽取
  tierPrices: null,             // 自定义峰谷单价（元/百万 tokens）：{ peak:{input,cacheHit,output}, valley:{...} }；null 用官方默认
  apiProviders: [],             // 多厂商 LLM API Provider（OpenAI 兼容端点，注入 harness 作为 provider 供子代理选用）
};

/**
 * 设置读写。支持文件热加载：每次 get() 前检查文件 mtime，外部编辑（如手工改
 * settings.json 配置 MCP/视觉模型）在下一次读取时自动生效，不再被内存旧值覆盖。
 * 本类每次 set() 都立即落盘，因此磁盘文件永远是最新状态，热加载是安全的。
 */
class Settings {
  constructor(file) {
    this.file = file;
    this.mtimeMs = 0;
    this.data = { ...DEFAULTS };
    this.load();
  }
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      // 容忍 UTF-8 BOM 与尾部空白
      const clean = raw.replace(/^\uFEFF/, '');
      this.data = { ...DEFAULTS, ...JSON.parse(clean) };
      try { this.mtimeMs = fs.statSync(this.file).mtimeMs; } catch { this.mtimeMs = Date.now(); }
    } catch {
      // 首次运行或文件损坏时使用默认值（不覆盖磁盘上的坏文件，等待用户修复）
      this.mtimeMs = Date.now();
    }
  }
  get(key) {
    try {
      const m = fs.statSync(this.file).mtimeMs;
      if (m > this.mtimeMs) this.load();
    } catch { /* 文件不存在等 */ }
    return this.data[key];
  }
  set(key, value) { this.data[key] = value; this.save(); }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', 'utf8');
      try { this.mtimeMs = fs.statSync(this.file).mtimeMs; } catch { this.mtimeMs = Date.now(); }
    } catch { /* 写入失败不阻断启动 */ }
  }
}

module.exports = { Settings, DEFAULTS };
