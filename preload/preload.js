'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('dshDesktop', {
  getState: () => ipcRenderer.invoke('dsh:state'),
  onState: (cb) => subscribe('dsh:state', cb),
  // 面板实时刷新信号（编辑占用/项目地图/Git 等主进程事件推送，页面即时刷新右侧双面板）
  onPanelRefresh: (cb) => subscribe('dsh:panel-refresh', cb),
  retry: () => ipcRenderer.invoke('dsh:retry'),
  chooseWorkspace: () => ipcRenderer.invoke('dsh:choose-workspace'),
  openLogs: () => ipcRenderer.invoke('dsh:open-logs'),
  checkForUpdates: () => ipcRenderer.invoke('dsh:update-check'),
  applyUpdate: () => ipcRenderer.invoke('dsh:update-apply'),
  showMain: () => ipcRenderer.invoke('dsh:show-main'),
  restartApp: () => ipcRenderer.invoke('dsh:restart'),
  // 仅重启 harness 服务（不退出桌面端）：客户端插件/web.patch/MCP 配置改动生效的较快路径
  restartService: () => ipcRenderer.invoke('dsh:restart-service'),
  headlessRun: (task) => ipcRenderer.invoke('dsh:headless-run', { task }),
  headlessCancel: () => ipcRenderer.invoke('dsh:headless-cancel'),
  onHeadlessData: (cb) => subscribe('dsh:headless-data', cb),
  onHeadlessExit: (cb) => subscribe('dsh:headless-exit', cb),

  // MCP 管理（设置页）
  listMcpServers: () => ipcRenderer.invoke('dsh:mcp-list'),
  saveMcpServer: (server) => ipcRenderer.invoke('dsh:mcp-save', { server }),
  removeMcpServer: (serverName) => ipcRenderer.invoke('dsh:mcp-remove', { serverName }),
  toggleMcpServer: (serverName, enabled) => ipcRenderer.invoke('dsh:mcp-toggle', { serverName, enabled }),
  setBuiltinMcp: (enableDesktopMcp) => ipcRenderer.invoke('dsh:mcp-set-builtin', { enableDesktopMcp }),
  applyMcp: () => ipcRenderer.invoke('dsh:mcp-apply'),

  // 插件管理（设置页）
  getDesktopPlugins: () => ipcRenderer.invoke('dsh:desktop-plugins'),
  installPlugin: (pkg) => ipcRenderer.invoke('dsh:plugin-install', { pkg }),
  removePlugin: (pkg) => ipcRenderer.invoke('dsh:plugin-remove', { pkg }),
  cancelPlugin: () => ipcRenderer.invoke('dsh:plugin-cancel'),
  onPluginOutput: (cb) => subscribe('dsh:plugin-output', cb),

  // 用量 / 余额 / 多模态 / 权限 / 通知 / Git（Codex·Claude 风格桌面功能）
  getUsage: () => ipcRenderer.invoke('dsh:usage-get'),
  setUsageTierPrices: (custom, tierPrices) => ipcRenderer.invoke('dsh:usage-set-prices', { custom, tierPrices }),
  getBalance: () => ipcRenderer.invoke('dsh:balance-get'),
  getVision: () => ipcRenderer.invoke('dsh:vision-get'),
  saveVision: (vision) => ipcRenderer.invoke('dsh:vision-save', { vision }),
  testVision: () => ipcRenderer.invoke('dsh:vision-test'),
  setPermissionMode: (mode) => ipcRenderer.invoke('dsh:permission-mode', { mode }),
  setNotifyOnComplete: (enabled) => ipcRenderer.invoke('dsh:notify-set', { enabled }),
  setAutoCommitRounds: (enabled) => ipcRenderer.invoke('dsh:auto-commit-set', { enabled }),
  setQuietHours: (payload) => ipcRenderer.invoke('dsh:quiet-hours-set', payload),
  openAgentsFile: (scope) => ipcRenderer.invoke('dsh:agents-file', { scope }),
  gitSummary: () => ipcRenderer.invoke('dsh:git-summary'),
  openGitDiffWindow: () => ipcRenderer.invoke('dsh:git-diff-window'),
  // 项目代码地图状态（右侧环境信息面板展示：是否建图 / 多少文件 stale）
  projectMapStatus: () => ipcRenderer.invoke('dsh:project-map-status'),
  // 多会话编辑占用状态（其他对话在改哪些文件）
  editStatus: () => ipcRenderer.invoke('dsh:edit-status'),
  // Git 窗操作：提交（带会话归属前缀）/ 回滚 / 分支
  gitCommit: (message) => ipcRenderer.invoke('dsh:git-commit', { message }),
  gitRestore: () => ipcRenderer.invoke('dsh:git-restore'),
  gitBranch: () => ipcRenderer.invoke('dsh:git-branch'),
  // Git 分支切换/新建（EnvPanel「建对话分支」按钮）
  gitCheckout: (payload) => ipcRenderer.invoke('dsh:git-checkout', payload),

  // 跨会话消息（P0-1）：查未读 / 标记已读 / 投递 / 交给本会话处理
  sessionInboxStatus: (payload) => ipcRenderer.invoke('dsh:session-inbox-status', payload),
  sessionInboxMarkRead: (payload) => ipcRenderer.invoke('dsh:session-inbox-mark-read', payload),
  sessionMessageSend: (payload) => ipcRenderer.invoke('dsh:session-message-send', payload),
  dispatchToHarness: (text) => ipcRenderer.invoke('dsh:dispatch-to-harness', { text }),

  // GitHub 集成（设置页 + 环境信息面板）
  githubStatus: () => ipcRenderer.invoke('dsh:github-status'),
  githubLoginStart: () => ipcRenderer.invoke('dsh:github-login-start'),
  githubLoginPoll: () => ipcRenderer.invoke('dsh:github-login-poll'),
  githubLogout: () => ipcRenderer.invoke('dsh:github-logout'),
  githubRemoteSetup: (payload) => ipcRenderer.invoke('dsh:github-remote-setup', payload),
  githubSetVisibility: (payload) => ipcRenderer.invoke('dsh:github-visibility-set', payload),
  openExternal: (url) => ipcRenderer.invoke('dsh:open-external', { url }),
  // 客户端诊断回报（面板实际收到的数据回传主进程日志，用于定位面板显示问题）
  clientDebug: (payload) => ipcRenderer.invoke('dsh:client-debug', payload),

  // Ollama 本地视觉模型集成
  ollamaStatus: () => ipcRenderer.invoke('dsh:ollama-status'),
  ollamaInstall: () => ipcRenderer.invoke('dsh:ollama-install'),
  ollamaStart: () => ipcRenderer.invoke('dsh:ollama-start'),
  ollamaPull: (model) => ipcRenderer.invoke('dsh:ollama-pull', { model }),
  ollamaUseVision: (model) => ipcRenderer.invoke('dsh:ollama-use-vision', { model }),
  onOllamaProgress: (cb) => subscribe('dsh:ollama-progress', cb),
  onOllamaOutput: (cb) => subscribe('dsh:ollama-output', cb),
  // 本地视觉识别过程流（浮层实时展示：开始/增量/完成/失败）
  onVisionStream: (cb) => subscribe('dsh:vision-stream', cb),
  // 运行框「停止」按钮：取消正在进行的本地视觉识别（按 id 精确取消）
  cancelVision: (id) => ipcRenderer.invoke('dsh:vision-cancel', { id }),
  // 小米 MiMo 视觉 API：状态探测（主进程校验 key，不暴露给页面）与打开控制台
  mimoStatus: () => ipcRenderer.invoke('dsh:mimo-status'),
  openMimoConsole: () => ipcRenderer.invoke('dsh:mimo-console'),
  // 会话活动足迹（工具调用 / 网页来源 / 本地文件来源）。
  // payload.sessionId：只查指定会话（右侧面板按当前对话展示）；缺省查最新活动会话。
  activityGet: (payload) => ipcRenderer.invoke('dsh:activity-get', payload),
  // 截图发送被拒（纯文本模型）时的补救：本地识别图片返回描述
  describeImagePath: (path) => ipcRenderer.invoke('dsh:describe-image-path', { path }),
  // 截图补救（主进程执行）：识别全部图片并经官方 RPC 直发进当前会话（免疫页面重载/重渲染）
  screenshotRescue: (payload) => ipcRenderer.invoke('dsh:screenshot-rescue', payload),
  // 截图补救进度：主进程每完成一张推送 { done, total }，页面更新输入框占位文案
  onRescueProgress: (cb) => subscribe('dsh:rescue-progress', cb),
  // 机器人桥：QQ 网关 / 企业微信推送的配置读写与测试
  botConfig: () => ipcRenderer.invoke('dsh:bot-config'),
  botConfigSet: (payload) => ipcRenderer.invoke('dsh:bot-config-set', payload),
  botTestQq: () => ipcRenderer.invoke('dsh:bot-test-qq'),
  botTestWechat: () => ipcRenderer.invoke('dsh:bot-test-wechat'),
  onBotState: (cb) => subscribe('dsh:bot-state', cb),
  // 文生图（云端 OpenAI 兼容 images/generations）
  imageGenConfig: () => ipcRenderer.invoke('dsh:image-gen-config'),
  imageGenConfigSet: (payload) => ipcRenderer.invoke('dsh:image-gen-config-set', payload),
  imageGenTest: () => ipcRenderer.invoke('dsh:image-gen-test'),

  // 截图 / 附件 / 新对话接续
  screenshot: () => ipcRenderer.invoke('dsh:screenshot'),
  attachFiles: () => ipcRenderer.invoke('dsh:attach-files'),
  openAttachmentsDir: () => ipcRenderer.invoke('dsh:open-attachments-dir'),
  injectText: (text) => ipcRenderer.invoke('dsh:inject-text', { text }),
  handoffStatus: () => ipcRenderer.invoke('dsh:handoff-status'),
  continueConversation: () => ipcRenderer.invoke('dsh:continue-conversation'),
  submitRegion: (region) => ipcRenderer.invoke('dsh:capture-region', region),
  cancelCapture: () => ipcRenderer.invoke('dsh:capture-cancel'),
  onCaptureBackdrop: (cb) => subscribe('dsh:capture-backdrop', cb),
  onCaptureReset: (cb) => subscribe('dsh:capture-reset', cb),
  onScreenshotReady: (cb) => subscribe('dsh:screenshot-ready', cb),
  // 截图预识别结果（截图时主进程已开始识别，纯文本模型发送被拒时补救可直用，零等待）
  onScreenshotDesc: (cb) => subscribe('dsh:screenshot-desc', cb),

  // 记忆（自动记忆 + 知识图谱管理）
  memoryStatus: () => ipcRenderer.invoke('dsh:memory-status'),
  memoryList: () => ipcRenderer.invoke('dsh:memory-list'),
  memoryDelete: (payload) => ipcRenderer.invoke('dsh:memory-delete', payload),
  memoryAdd: (payload) => ipcRenderer.invoke('dsh:memory-add', payload),
  memorySetAuto: (enabled) => ipcRenderer.invoke('dsh:memory-set-auto', { enabled }),
  memoryOpen: () => ipcRenderer.invoke('dsh:memory-open'),

  // 子代理中心（进度/状态/耗时/token）
  subagentsList: () => ipcRenderer.invoke('dsh:subagents-list'),
  // 子代理会话流（stream 读取）
  subagentStreamList: () => ipcRenderer.invoke('dsh:subagent-stream-list'),
  subagentStreamSince: (sessionId, sinceSeq) => ipcRenderer.invoke('dsh:subagent-stream-since', { sessionId, sinceSeq }),

  // 多厂商 LLM Provider 管理（设置页）
  providersList: () => ipcRenderer.invoke('dsh:providers-list'),
  providersSave: (provider) => ipcRenderer.invoke('dsh:providers-save', { provider }),
  providersRemove: (id) => ipcRenderer.invoke('dsh:providers-remove', { id }),
  providersTest: (id) => ipcRenderer.invoke('dsh:providers-test', { id }),
  providersBalance: (id) => ipcRenderer.invoke('dsh:providers-balance', { id }),
  providersApply: () => ipcRenderer.invoke('dsh:providers-apply'),

  // 开机自启 / 关闭到托盘
  setAutoStart: (enabled) => ipcRenderer.invoke('dsh:autostart-set', { enabled }),
  setCloseToTray: (enabled) => ipcRenderer.invoke('dsh:tray-set', { enabled }),

  // 快速命令框
  quickSubmit: (payload) => ipcRenderer.invoke('dsh:quick-submit', payload),
  quickCancel: () => ipcRenderer.invoke('dsh:quick-cancel'),
  quickToggle: () => ipcRenderer.invoke('dsh:quick-toggle'),

  // 定时任务 / 提醒
  scheduleList: () => ipcRenderer.invoke('dsh:schedule-list'),
  scheduleAdd: (task) => ipcRenderer.invoke('dsh:schedule-add', { task }),
  scheduleRemove: (id) => ipcRenderer.invoke('dsh:schedule-remove', { id }),
  scheduleToggle: (id, enabled) => ipcRenderer.invoke('dsh:schedule-toggle', { id, enabled }),
  scheduleRunNow: (id) => ipcRenderer.invoke('dsh:schedule-run-now', { id }),

  // Windows 系统环境
  systemDoctor: () => ipcRenderer.invoke('dsh:system-doctor'),
  systemFix: (fix) => ipcRenderer.invoke('dsh:system-fix', { fix }),
  systemEnvList: () => ipcRenderer.invoke('dsh:system-env-list'),
  systemEnvSet: (name, value) => ipcRenderer.invoke('dsh:system-env-set', { name, value }),
  systemEnvRemove: (name) => ipcRenderer.invoke('dsh:system-env-remove', { name }),
  systemWinget: (id) => ipcRenderer.invoke('dsh:system-winget', { id }),
  onSystemWingetOutput: (cb) => subscribe('dsh:system-winget-output', cb),
  onSystemWingetExit: (cb) => subscribe('dsh:system-winget-exit', cb),
  contextMenuStatus: () => ipcRenderer.invoke('dsh:context-menu-status'),
  contextMenuSet: (enabled) => ipcRenderer.invoke('dsh:context-menu-set', { enabled }),

  // 备份与迁移（换电脑时把打磨好的 harness 带走）
  backupExport: (includeCredentials, includeSessions) => ipcRenderer.invoke('dsh:backup-export', { includeCredentials, includeSessions }),
  backupImport: (file) => ipcRenderer.invoke('dsh:backup-import', { file }),
  backupSelectFile: () => ipcRenderer.invoke('dsh:backup-select-file'),

  // 上下文压力告警
  setContextWarningEnabled: (enabled) => ipcRenderer.invoke('dsh:context-warning-set', { enabled }),
  setContextWarningTokens: (tokens) => ipcRenderer.invoke('dsh:context-warning-tokens', { tokens }),
});

// 页面就绪通知：agent 主动重启桌面端后（restartApp 带任务摘要），主进程据此自动接续对话。
window.addEventListener('DOMContentLoaded', () => {
  try { ipcRenderer.send('dsh:web-ready'); } catch { /* 忽略 */ }
});
