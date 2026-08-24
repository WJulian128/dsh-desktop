/*
 * DSH Desktop 客户端插件（Codex 风格重设计）：
 *  - 设置页 8 个分区（三合一合并后）：
 *    "桌面端"（90）：版本与更新、权限与沙箱模式、通知/自启/托盘、AGENTS.md/Git/截图附件、
 *      上下文告警、通知免打扰 + 多模态卡组（图片识别，原独立 vision 分区并入）
 *    "插件与 MCP"（85）：插件卡组（桌面端扩展 + harness 插件安装/卸载/清单）+
 *      MCP 服务器（内置 dsh_desktop 开关 + 用户 MCP 服务器增删改/启停）
 *    "记忆与子代理"（74）：自动记忆/知识图谱 + 子代理卡组（进度总览）
 *    "定时任务"（73）/ "系统环境"（72）/ "备份与迁移"（71）/ "用量与账单"（70）
 *    "模型调度"（60）：多厂商 LLM 接入（厂商列表/测通/余额/应用重启）+ 调度面板
 *  - 状态栏多厂商胶囊：enabled 厂商各一个（dot + 名称缩写 + 余额），点击打开控制台/设置页
 *  - 状态栏胶囊（右下角，常驻显示全部状态，不再 hover 展开）
 *  - 输入框常驻工具按钮组：截图 + 附加文件
 *  - 会话页头"环境信息"按钮 + 右侧抽屉面板（工作区/Git/子代理/上下文/计费时段）
 *
 * 设计语言（Codex）：极简单色、灰阶 + 单一克制的蓝；去掉逐行分隔线，改用卡片内
 * 行间距；状态一律"小圆点 + 文字"（绿=开启/成功，灰=关闭，黄=警示）；按钮细边框
 * 圆角，主按钮 #2f81f7；全部使用 harness 主题 token，深浅主题自适应。
 *
 * 格式：window.__ModuleLoader__.load({ id, factory }），与 harness 内置客户端插件
 * 一致的懒加载 CJS 表格式。桌面能力经 window.dshDesktop（preload 桥）调用。
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/settings-update",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let slots = require("@deepseek-ai/dsh-client-ui-slots");

    const h = react.createElement;

    /* ---------- 语义色（全部走 harness token） ---------- */
    const SUCCESS = "var(--dsw-alias-state-success-primary, #3fb950)";
    const DANGER = "var(--dsw-alias-state-danger-primary, #f85149)";
    const BUSINESS = "var(--dsw-alias-state-business-primary, #d29922)";
    const MUTED = "var(--dsw-alias-label-tertiary)";

    /* ---------- 计费时段（DeepSeek 官方峰谷定价，北京时间；空闲=高峰半价） ---------- */
    const tierOf = (now) => {
      const d = new Date(now);
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      const get = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : null; };
      const wd = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')] || 0;
      const h = parseInt(get('hour'), 10), m = parseInt(get('minute'), 10);
      const minutes = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
      const isWeekday = wd >= 1 && wd <= 5;
      const peak = isWeekday && ((minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080));
      const next = (() => {
        const cand = [];
        if (isWeekday) for (const t of [540, 720, 840, 1080]) if (t > minutes) cand.push(t - minutes);
        if (!cand.length) {
          let days = 1;
          for (let w = (wd % 7) + 1; w !== wd; w = (w % 7) + 1, days++) { if (w >= 1 && w <= 5) break; }
          cand.push(days * 1440 + 540 - minutes);
        }
        return Math.min(...cand);
      })();
      return { peak, nextMinutes: next };
    };

    /* ---------- 样式（Codex：极简、单色、留白） ---------- */
    const st = {
      grid: { display: "flex", flexDirection: "column", gap: "20px" },
      title: { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: "500", lineHeight: "24px", padding: "2px 0 0" },
      groupTitle: {
        color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", fontWeight: "600",
        lineHeight: "16px", letterSpacing: "0.08em", padding: "0 2px",
      },
      card: {
        display: "flex", flexDirection: "column", gap: "10px", maxWidth: "720px",
        background: "var(--dsw-alias-bg-layer-1)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "12px", padding: "16px 20px",
      },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", minHeight: "36px" },
      label: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px", flex: "none" },
      value: { color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px", textAlign: "right", minWidth: 0, overflowWrap: "anywhere" },
      name: { color: "var(--dsw-alias-label-primary)", fontSize: "13px", lineHeight: "20px" },
      sub: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", overflowWrap: "anywhere" },
      status: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      stack: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
      actions: { display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap", padding: "4px 0 0" },
      btn: {
        cursor: "pointer", border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)",
        borderRadius: "8px", padding: "5px 14px", font: "inherit",
        fontSize: "13px", lineHeight: "20px", display: "inline-flex", alignItems: "center", gap: "6px",
      },
      btnSmall: { padding: "3px 10px", fontSize: "12px", lineHeight: "18px", borderRadius: "6px" },
      btnPrimary: { background: "#2f81f7", borderColor: "transparent", color: "#ffffff" },
      btnDanger: { color: "var(--dsw-alias-state-danger-primary, #f85149)" },
      btnDisabled: { opacity: "0.5", cursor: "default" },
      dot: { width: "8px", height: "8px", borderRadius: "999px", display: "inline-block", flex: "none" },
      dotWrap: { display: "inline-flex", alignItems: "center", gap: "6px", flex: "none" },
      hint: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", padding: "2px 0 0" },
      note: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: "20px", padding: "4px 0" },
      msgOk: { color: "var(--dsw-alias-state-success-primary, #3fb950)", fontSize: "12px", lineHeight: "18px", padding: "2px 0 0" },
      msgErr: { color: "var(--dsw-alias-state-danger-primary, #f85149)", fontSize: "12px", lineHeight: "18px", padding: "2px 0 0" },
      form: {
        border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px",
        background: "var(--dsw-alias-bg-layer-1)", padding: "16px 20px",
        display: "flex", flexDirection: "column", gap: "12px", maxWidth: "720px",
      },
      field: { display: "flex", flexDirection: "column", gap: "6px" },
      fieldLabel: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px" },
      input: {
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
        height: "34px", font: "inherit", color: "var(--dsw-alias-label-primary)",
        borderRadius: "8px", padding: "0 12px", fontSize: "13px", lineHeight: "1.5", width: "100%", boxSizing: "border-box",
      },
      textarea: {
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
        font: "inherit", color: "var(--dsw-alias-label-primary)", borderRadius: "8px",
        padding: "8px 12px", fontSize: "13px", lineHeight: "1.5", width: "100%", boxSizing: "border-box",
        resize: "vertical", minHeight: "52px", fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
      },
      select: {
        border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)",
        height: "34px", font: "inherit", color: "var(--dsw-alias-label-primary)",
        borderRadius: "8px", padding: "0 10px", fontSize: "13px", width: "100%", boxSizing: "border-box",
      },
      mono: { fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace", fontSize: "12px" },
      output: {
        background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "8px", padding: "10px 12px", whiteSpace: "pre-wrap",
        fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace", fontSize: "12px",
        lineHeight: "1.5", maxHeight: "180px", overflow: "auto", color: "var(--dsw-alias-label-secondary)",
      },
    };

    /* ---------- 工具 ---------- */
    const api = () => (typeof window !== "undefined" ? window.dshDesktop : undefined);

    /** 插件清单拉取器（依赖 ctx.get("remote")，由 apply() 注入；McpSection → PluginsBlock 使用）。 */
    let inventoryFetcher = null;

    function parseKvLines(text) {
      const out = {};
      for (const line of String(text || "").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const i = t.indexOf("=");
        if (i <= 0) continue;
        out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      return out;
    }
    function toKvLines(obj) {
      return Object.entries(obj || {}).map(([k, v]) => k + "=" + v).join("\n");
    }
    function parseArgLines(text) {
      return String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
    }
    function toArgLines(args) {
      return (args || []).join("\n");
    }
    function moduleShortName(moduleName) {
      const s = String(moduleName || "");
      return (s.startsWith("@") ? s.slice(s.indexOf("/") + 1) : s)
        .replace(/^cordis:/, "").replace(/^cordis-plugin-/, "")
        .replace(/^dsh-(?:host-|client-)?/, "");
    }
    const emptyDraft = () => ({
      serverName: "", transport: "stdio", command: "", argsText: "", envText: "",
      cwd: "", url: "", headersText: "", enabled: true,
    });
    const fmtNum = (n) => Number(n || 0).toLocaleString();

    /* ---------- 多厂商（模型调度）工具 ---------- */
    /** 厂商短名（状态栏胶囊用）：小米 MiMo → MiMo；其余取展示名（过长时首词 + 其余首字母）。 */
    const providerAbbrev = (p) => {
      const id = String((p && p.provider) || '').toLowerCase();
      if (id.indexOf('mimo') >= 0) return 'MiMo';
      const n = String((p && p.name) || '');
      const parts = n.split(/[-_ .]+/).filter(Boolean);
      if (!parts.length) return '?';
      if (n.length <= 10) return n;
      return parts[0].slice(0, 4) + parts.slice(1).map((x) => (x[0] || '')).join('').toUpperCase();
    };
    /** providersBalance 的 balance 字段 → "¥123.45"。 */
    const fmtProviderBalance = (b) => {
      if (!b) return '—';
      const num = Number(b.total || 0);
      if (!Number.isFinite(num)) return '—';
      const c = String(b.currency || '');
      const prefix = c === 'CNY' ? '¥' : (c === 'USD' ? '$' : (c ? c + ' ' : ''));
      return prefix + num.toFixed(2);
    };
    /** providersBalance 结果 → 展示文本（不支持查询 / 查询失败 / 数字）。 */
    const providerBalanceText = (b) => {
      if (!b) return '…';
      if (b.error) return '查询失败';
      if (b.supported !== true) return '不支持查询';
      return fmtProviderBalance(b.balance);
    };
    const emptyProviderDraft = () => ({
      name: '', provider: '', baseUrl: '', apiKey: '', modelsText: '', enabled: true, note: '',
      efforts: [], // 思考强度实例：['fast'] / ['deep'] / ['fast','deep']
    });

    /* ---------- 通用小组件 ---------- */
    const dot = (color, key) => h("span", { key, style: { ...st.dot, background: color } });
    const dotText = (color, text, textStyle) => h("span", { style: st.dotWrap },
      dot(color),
      h("span", { style: { ...(textStyle || {}), fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" } }, text));
    const row = (label, control, key) => h("div", { key, style: st.row }, h("span", { style: st.label }, label), control);
    const stack = (title, sub, titleStyle) => h("div", { style: st.stack },
      h("span", { style: { ...st.name, ...(titleStyle || {}) } }, title),
      sub != null && sub !== "" ? h("span", { style: st.sub }, sub) : null);
    const btn = (label, onClick, opts = {}) => h("button", {
      type: "button",
      key: opts.key || undefined,
      className: "dsh-set-btn" + (opts.primary ? " dsh-set-btn-primary" : ""),
      style: {
        ...st.btn, ...(opts.small ? st.btnSmall : {}),
        ...(opts.primary ? st.btnPrimary : {}), ...(opts.danger ? st.btnDanger : {}),
        ...(opts.disabled ? st.btnDisabled : {}), ...(opts.style || {}),
      },
      disabled: !!opts.disabled,
      title: opts.title || undefined,
      onClick: () => { try { onClick(); } catch (err) {} },
    }, label);
    const statusChip = (on, onText, offText, onClick, busy) => btn(
      [dot(on ? SUCCESS : MUTED, "d"), h("span", { key: "t" }, on ? onText : offText)],
      onClick, { small: true, disabled: !!busy });

    /** 全局注入一次：按钮 hover / 表单控件 focus（Codex 蓝）样式。 */
    function ensureGlobalStyles() {
      try {
        if (typeof document === "undefined" || !document.head) return;
        if (document.getElementById("dsh-desktop-settings-styles")) return;
        const el = document.createElement("style");
        el.id = "dsh-desktop-settings-styles";
        el.textContent =
          ".dsh-set-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3);}" +
          ".dsh-set-btn-primary:hover:not(:disabled){background:#1f6feb;}" +
          ".dsh-set-input:focus,.dsh-set-select:focus,.dsh-set-textarea:focus{outline:none;border-color:#2f81f7;}" +
          "@keyframes dshVisionPulse{0%,100%{opacity:1}50%{opacity:0.3}}";
        document.head.appendChild(el);
      } catch (err) { /* 忽略 */ }
    }

    /* ================= 桌面端（版本与更新 + 上下文告警） ================= */
    function DesktopSection() {
      const [state, setState] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [qhDraft, setQhDraft] = react.useState(null);

      react.useEffect(() => {
        let disposed = false;
        const d = api();
        if (!d) return undefined;
        let off = null;
        try { off = d.onState((s) => { if (!disposed) setState(s); }); } catch (err) { if (!disposed) setError(String((err && err.message) || err)); }
        d.getState().then((s) => { if (!disposed) setState(s); }).catch((err) => { if (!disposed) setError(String((err && err.message) || err)); });
        return () => { disposed = true; if (off) { try { off(); } catch (ignored) {} } };
      }, []);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开（网页版不提供该分区）。"));
      }

      const checking = !!(state && state.checking);
      const updating = !!(state && state.updating);
      const hasUpdate = !!(state && state.updateAvailable);
      const busy = checking || updating;
      const installed = (state && state.installed) || "…";
      const latest = (state && state.latest) || "…";

      let statusText = "—";
      let statusTone = MUTED;
      if (updating) statusText = "正在更新…" + ((state.updateProgress && state.updateProgress.text) || "");
      else if (checking) statusText = "正在检查…";
      else if (hasUpdate) { statusText = "发现新版本 v" + latest; statusTone = BUSINESS; }
      else if (state && state.installed && state.latest) { statusText = "已是最新版本"; statusTone = SUCCESS; }

      const MODES = [
        { id: 'read-only', label: '只读' },
        { id: 'workspace-write', label: '工作区写' },
        { id: 'danger-full-access', label: '完全访问' },
      ];
      const mode = (state && state.permissionMode) || 'workspace-write';
      const setMode = (id) => {
        if (id === mode) return;
        if (window.confirm('切换权限模式将重启 harness 服务，页面会刷新。继续？')) {
          try { api().setPermissionMode(id); } catch (err) {}
        }
      };
      const notifyOn = state ? state.notifyOnComplete !== false : true;
      const autoStart = !!(state && state.autoStart);
      const closeToTray = state ? state.closeToTray !== false : true;

      /* ---- 上下文告警（Codex 式：状态 + 开关 + 阈值） ---- */
      const warnRaw = state && state.contextWarning;
      const warn = (warnRaw && typeof warnRaw === "object") ? warnRaw : (warnRaw ? {} : null);
      const warnUsed = warn
        ? (warn.used != null ? warn.used : (warn.current != null ? warn.current : (warn.tokens != null ? warn.tokens : null)))
        : null;
      const warnLimit = warn
        ? (warn.limit != null ? warn.limit : (warn.max != null ? warn.max : (state && state.contextWarningTokens ? state.contextWarningTokens : null)))
        : null;
      const warnOn = state ? state.contextWarningEnabled !== false : true;
      const warnTokens = (state && state.contextWarningTokens) || 700000;
      const saveWarnTokens = (e) => {
        const n = Number(String((e && e.target && e.target.value) || "").trim());
        if (!Number.isFinite(n) || n < 1000) return;
        try { api().setContextWarningTokens(n); } catch (err) {}
      };

      /* ---- 通知免打扰（深夜不弹原生通知，保留窗口闪烁与日志） ---- */
      const qhEnabled = state ? state.quietHoursEnabled === true : false;
      const qhStart = (state && state.quietHoursStart) || "23:00";
      const qhEnd = (state && state.quietHoursEnd) || "07:00";
      const qhDraftStart = (qhDraft && qhDraft.start) || qhStart;
      const qhDraftEnd = (qhDraft && qhDraft.end) || qhEnd;
      const saveQuietHours = () => {
        try {
          api().setQuietHours({ enabled: qhEnabled, start: qhDraftStart, end: qhDraftEnd });
          setState({ ...(state || {}), quietHoursEnabled: qhEnabled, quietHoursStart: qhDraftStart, quietHoursEnd: qhDraftEnd });
          setQhDraft(null);
        } catch (err) {}
      };

      return h("div", { style: st.grid },
        h("div", { style: st.title }, "桌面端"),
        h("div", { style: st.card },
          row("当前版本", h("span", { style: st.value }, "v" + installed)),
          row("更新状态", h("span", { style: { ...st.value, color: statusTone } }, statusText)),
          h("div", { style: st.actions },
            btn("检查更新", () => api().checkForUpdates(), { disabled: busy }),
            hasUpdate ? btn("立即更新", () => api().applyUpdate(), { primary: true, disabled: updating }) : null),
          h("p", { style: st.hint }, "检查 npm registry 上 @deepseek-ai/dsh 的最新版本；点击“立即更新”将安装新版本并自动重启应用。")),

        h("div", { style: st.card },
          row("权限与沙箱模式",
            h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
              MODES.map((m) => btn(m.label, () => setMode(m.id), { small: true, primary: m.id === mode, key: m.id })))),
          row("任务完成通知", statusChip(notifyOn, "已开启", "已关闭", () => {
            try { api().setNotifyOnComplete(!notifyOn); setState({ ...state, notifyOnComplete: !notifyOn }); } catch (err) {}
          })),
          row("开机自启", statusChip(autoStart, "已开启", "已关闭", () => {
            try { api().setAutoStart(!autoStart); setState({ ...state, autoStart: !autoStart }); } catch (err) {}
          })),
          row("关闭到托盘（不退出，常驻右下角）", statusChip(closeToTray, "已开启", "已关闭", () => {
            try { api().setCloseToTray(!closeToTray); setState({ ...state, closeToTray: !closeToTray }); } catch (err) {}
          })),
          row("项目说明（AGENTS.md）",
            h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
              btn("工作区", () => api().openAgentsFile('workspace'), { small: true }),
              btn("全局", () => api().openAgentsFile('global'), { small: true }))),
          row("Git 变更", btn("查看 diff", () => api().openGitDiffWindow(), { small: true })),
          row("截图与附件",
            h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
              btn("快速截图", () => api().screenshot(), { small: true }),
              btn("附加文件", () => api().attachFiles(), { small: true }),
              btn("打开附件目录", () => api().openAttachmentsDir(), { small: true }))),
          row("上下文接续", btn("新对话接续任务", () => api().continueConversation(), { small: true }))),

        h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: st.groupTitle }, "上下文告警"),
          h("div", { style: st.card },
            row("状态", warn
              ? h("div", { style: { display: "flex", alignItems: "center", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" } },
                h("span", { style: { color: BUSINESS, fontSize: "12px", lineHeight: "18px" } },
                  "上下文接近上限：" + (warnUsed != null ? fmtNum(warnUsed) : "?") + " / " + (warnLimit != null ? fmtNum(warnLimit) : "?") + " tokens"),
                btn("新对话接续", () => api().continueConversation(), { small: true }))
              : h("span", { style: st.status }, "未触发")),
            row("告警开关", statusChip(warnOn, "已开启", "已关闭", () => {
              try { api().setContextWarningEnabled(!warnOn); setState({ ...(state || {}), contextWarningEnabled: !warnOn }); } catch (err) {}
            })),
            row("告警阈值（tokens）",
              h("input", {
                className: "dsh-set-input", type: "number", min: 1000, step: 1000,
                key: "warn-tokens-" + warnTokens,
                defaultValue: String(warnTokens),
                placeholder: "700000",
                style: { ...st.input, width: "160px", height: "30px" },
                onBlur: saveWarnTokens,
                onKeyDown: (e) => { if (e.key === "Enter") saveWarnTokens(e); },
              })),
            h("p", { style: st.hint }, "DeepSeek 官方模型上下文窗口 100 万 tokens。建议接续点：60-70 万开始收尾当前任务，70%（默认阈值 70 万）主动「新对话接续」（交接文件+记忆无损）——长上下文后期成本剧增、信息召回下降、易被自动压缩；85 万以上必须处理。达到阈值时状态栏胶囊亮起（显示百分比），点击即可接续。阈值可自行调整。"))),

        h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: st.groupTitle }, "通知免打扰"),
          h("div", { style: st.card },
            row("免打扰开关", statusChip(qhEnabled, "已开启", "已关闭", () => {
              try {
                const next = !qhEnabled;
                api().setQuietHours({ enabled: next, start: qhDraftStart, end: qhDraftEnd });
                setState({ ...(state || {}), quietHoursEnabled: next });
              } catch (err) {}
            })),
            row("开始时间", h("input", {
              className: "dsh-set-input", type: "time",
              key: "qh-start",
              value: qhDraftStart,
              onChange: (e) => setQhDraft({ ...(qhDraft || {}), start: String(e.target.value || "") }),
              style: { ...st.input, width: "150px", height: "30px" },
            })),
            row("结束时间", h("input", {
              className: "dsh-set-input", type: "time",
              key: "qh-end",
              value: qhDraftEnd,
              onChange: (e) => setQhDraft({ ...(qhDraft || {}), end: String(e.target.value || "") }),
              style: { ...st.input, width: "150px", height: "30px" },
            })),
            h("div", { style: st.actions }, btn("保存免打扰设置", saveQuietHours, { primary: true, small: true })),
            h("p", { style: st.hint }, "免打扰时段内不弹原生通知（任务完成 / 上下文告警 / 定时任务等），但窗口闪烁与日志照常保留。支持跨午夜，如 23:00-07:00；开始=结束视为全天免打扰。"))),

        h(VisionBlock),

        h("div", { style: st.card },
          row("工作区", h("span", { style: st.value }, (state && state.workspace) || "—")),
          row("数据目录（DSH_HOME）", h("span", { style: st.value }, (state && state.dshHome) || "—")),
          row("服务地址", h("span", { style: st.value }, (state && state.url) || "—"))),

        h("div", { style: st.card },
          row("快捷操作",
            h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" } },
              btn("打开工作区", () => api().chooseWorkspace(), { small: true }),
              btn("打开日志", () => api().openLogs(), { small: true }),
              btn("重启应用", () => api().restartApp(), { small: true, danger: true })))),

        error ? h("div", { style: st.msgErr }, "桌面端桥接错误：" + error) : null);
    }

    /* ================= 插件与 MCP 服务器管理 ================= */
    function McpSection() {
      const [servers, setServers] = react.useState([]);
      const [builtin, setBuiltin] = react.useState(true);
      const [formOpen, setFormOpen] = react.useState(false);
      const [editName, setEditName] = react.useState(null);
      const [draft, setDraft] = react.useState(emptyDraft());
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);

      const showMsg = (tone, text) => { setMsg({ tone, text }); };

      const refresh = react.useCallback(async () => {
        const d = api();
        if (!d) return;
        try {
          const r = await d.listMcpServers();
          setServers(r.servers || []);
          setBuiltin(!!r.enableDesktopMcp);
        } catch (err) { showMsg("error", "读取 MCP 配置失败：" + String((err && err.message) || err)); }
      }, []);

      react.useEffect(() => { refresh(); }, [refresh]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const openAdd = () => { setEditName(null); setDraft(emptyDraft()); setFormOpen(true); };
      const openEdit = (s) => {
        setEditName(s.serverName);
        setDraft({
          serverName: s.serverName, transport: s.transport || "stdio",
          command: s.command || "", argsText: toArgLines(s.args), envText: toKvLines(s.env),
          cwd: s.cwd || "", url: s.url || "", headersText: toKvLines(s.headers),
          enabled: s.enabled !== false,
        });
        setFormOpen(true);
      };

      const save = async () => {
        const d = api();
        const name = String(draft.serverName || "").trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { showMsg("error", "serverName 需为 1-32 位字母、数字、下划线或短横线"); return; }
        if (draft.transport === "stdio" && !String(draft.command || "").trim()) { showMsg("error", "stdio 传输需要填写 command"); return; }
        if (draft.transport === "streamable-http" && !String(draft.url || "").trim()) { showMsg("error", "HTTP 传输需要填写 url"); return; }
        setBusy(true);
        try {
          const server = { serverName: name, transport: draft.transport, enabled: draft.enabled };
          if (draft.transport === "stdio") {
            server.command = String(draft.command || "").trim();
            const args = parseArgLines(draft.argsText);
            if (args.length) server.args = args;
            const env = parseKvLines(draft.envText);
            if (Object.keys(env).length) server.env = env;
            if (String(draft.cwd || "").trim()) server.cwd = String(draft.cwd).trim();
          } else {
            server.url = String(draft.url || "").trim();
            const headers = parseKvLines(draft.headersText);
            if (Object.keys(headers).length) server.headers = headers;
          }
          const r = await d.saveMcpServer(server);
          if (!r.ok) showMsg("error", r.error || "保存失败");
          else { setServers(r.servers || []); setFormOpen(false); showMsg("ok", "已保存 " + name + "（点击“应用更改并重启服务”生效）"); }
        } catch (err) { showMsg("error", String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const remove = async (name) => {
        if (!window.confirm("确定删除 MCP 服务器 " + name + " ？")) return;
        try {
          const r = await api().removeMcpServer(name);
          if (r.ok) { setServers(r.servers || []); showMsg("ok", "已删除 " + name + "（重启服务后生效）"); }
        } catch (err) { showMsg("error", String((err && err.message) || err)); }
      };

      const toggle = async (name, enabled) => {
        try {
          const r = await api().toggleMcpServer(name, enabled);
          if (r.ok) { setServers(r.servers || []); showMsg("ok", (enabled ? "已启用 " : "已停用 ") + name + "（重启服务后生效）"); }
        } catch (err) { showMsg("error", String((err && err.message) || err)); }
      };

      const toggleBuiltin = async (enabled) => {
        setBusy(true);
        try {
          const r = await api().setBuiltinMcp(enabled);
          if (r.ok) { setBuiltin(r.enableDesktopMcp); showMsg("ok", (enabled ? "已启用" : "已停用") + " 内置 dsh_desktop（重启服务后生效）"); }
        } catch (err) { showMsg("error", String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const apply = async () => {
        if (!window.confirm("应用 MCP 更改将重启 harness 服务，页面会刷新。继续？")) return;
        setBusy(true);
        showMsg("ok", "正在重启服务，页面即将刷新…");
        try { await api().applyMcp(); } catch (err) { /* 页面刷新会中断调用 */ }
      };

      const field = (label, control) => h("label", { style: st.field },
        h("span", { style: st.fieldLabel }, label), control);

      const setD = (key) => (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));

      const form = formOpen ? h("div", { style: st.form },
        h("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: "13px", fontWeight: "500", lineHeight: "20px" } },
          editName ? "编辑服务器 " + editName : "添加 MCP 服务器"),
        field("serverName（1-32 位字母数字 _ -，模型工具前缀 mcp__<serverName>__*）",
          h("input", { className: "dsh-set-input", style: st.input, value: draft.serverName, onChange: setD("serverName"), placeholder: "如 github / my-server", disabled: !!editName })),
        field("传输方式", h("select", { className: "dsh-set-select", style: st.select, value: draft.transport, onChange: setD("transport") },
          h("option", { value: "stdio" }, "stdio（本地子进程）"),
          h("option", { value: "streamable-http" }, "streamable-http（远程 URL）"))),
        draft.transport === "stdio"
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
            field("command（可执行文件）", h("input", { className: "dsh-set-input", style: st.input, value: draft.command, onChange: setD("command"), placeholder: "如 npx / node" })),
            field("args（每行一个参数）", h("textarea", { className: "dsh-set-textarea", style: st.textarea, value: draft.argsText, onChange: setD("argsText"), placeholder: "-y\n@modelcontextprotocol/server-github" })),
            field("env（每行 KEY=VALUE）", h("textarea", { className: "dsh-set-textarea", style: st.textarea, value: draft.envText, onChange: setD("envText"), placeholder: "GITHUB_TOKEN=xxx" })),
            field("cwd（可选）", h("input", { className: "dsh-set-input", style: st.input, value: draft.cwd, onChange: setD("cwd") })))
          : h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
            field("url", h("input", { className: "dsh-set-input", style: st.input, value: draft.url, onChange: setD("url"), placeholder: "http://localhost:3000/mcp" })),
            field("headers（每行 KEY=VALUE，可选）", h("textarea", { className: "dsh-set-textarea", style: st.textarea, value: draft.headersText, onChange: setD("headersText"), placeholder: "Authorization=Bearer xxx" }))),
        h("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
          h("input", { type: "checkbox", checked: draft.enabled, onChange: (e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked })) }),
          h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px" } }, "启用该服务器")),
        h("div", { style: st.actions },
          btn("保存", save, { disabled: busy }),
          btn("取消", () => setFormOpen(false))))
        : null;

      const serverRows = servers.length === 0
        ? h("p", { style: st.note }, "尚未配置额外的 MCP 服务器。")
        : h("div", { style: st.card }, servers.map((s) => {
          const on = s.enabled !== false;
          const summary = s.transport === "streamable-http"
            ? (s.url || "")
            : ((s.command || "") + (s.args && s.args.length ? " " + s.args.join(" ") : ""));
          return h("div", { key: s.serverName, style: st.row },
            stack(s.serverName, summary, { fontWeight: "500", ...st.mono && {} }),
            h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
              btn(on ? "停用" : "启用", () => toggle(s.serverName, !on), { small: true }),
              btn("编辑", () => openEdit(s), { small: true }),
              btn("删除", () => remove(s.serverName), { small: true, danger: true })));
        }));

      return h("div", { style: st.grid },
        h("div", { style: st.title }, "插件与 MCP"),
        h(PluginsBlock, { list: inventoryFetcher }),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
          h("div", { style: st.groupTitle }, "MCP 服务器"),
          h("div", { style: st.card },
            row("内置 dsh_desktop（桌面能力）",
              h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                dotText(builtin ? SUCCESS : MUTED, builtin ? "已启用" : "已停用"),
                btn(builtin ? "停用" : "启用", () => toggleBuiltin(!builtin), { small: true, disabled: busy }))),
            row("工具命名", h("span", { style: st.value }, "mcp__dsh_desktop__*"))),
          h("div", { style: st.groupTitle }, "自定义服务器"),
          serverRows,
          h("div", { style: st.actions },
            btn("添加服务器", openAdd, { small: true }),
            btn("应用更改并重启服务", apply, { primary: true, disabled: busy })),
          form,
          msg ? h("div", { style: msg.tone === "error" ? st.msgErr : st.msgOk }, msg.text) : null,
          h("p", { style: st.hint }, "自定义服务器保存到 %APPDATA%\\dsh-desktop\\settings.json 的 mcpServers；修改后点击“应用更改并重启服务”生效。harness 可自主调用 mcp__<serverName>__* 工具。")));
    }

    /* ================= 插件卡组（并入"插件与 MCP"分区） ================= */
    function PluginsBlock(props) {
      const listInventory = props.list;
      const [inventory, setInventory] = react.useState(null);
      const [invError, setInvError] = react.useState(null);
      const [desktop, setDesktop] = react.useState(null);
      const [pkg, setPkg] = react.useState("");
      const [opBusy, setOpBusy] = react.useState(false);
      const [output, setOutput] = react.useState("");
      const [msg, setMsg] = react.useState(null);

      react.useEffect(() => {
        const d = api();
        if (!d) return undefined;
        let off = null;
        try {
          off = d.onPluginOutput((p) => { if (p && p.text) setOutput((prev) => (prev + p.text).slice(-30000)); });
        } catch (err) { /* 忽略 */ }
        d.getDesktopPlugins().then((r) => { if (r && r.ok) setDesktop(r); }).catch(() => {});
        return () => { if (off) { try { off(); } catch (ignored) {} } };
      }, []);

      react.useEffect(() => {
        if (!listInventory) return undefined;
        let current = true;
        listInventory().then((value) => {
          if (current) setInventory((value && value.entries) || []);
        }, (err) => {
          if (current) setInvError(String((err && err.message) || err));
        });
        return () => { current = false; };
      }, [listInventory]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const runOp = async (kind, name) => {
        const target = String(name || "").trim();
        if (!target) { setMsg("请输入插件包名"); return; }
        setOpBusy(true); setOutput(""); setMsg(null);
        try {
          const r = kind === "install" ? await api().installPlugin(target) : await api().removePlugin(target);
          setMsg(r && r.ok
            ? (kind === "install" ? "已安装 " + target + "（重启服务后生效）" : "已移除 " + target + "（重启服务后生效）")
            : ("操作失败" + (r && r.code !== undefined ? "（退出码 " + r.code + "）" : "") + "，详见上方输出"));
        } catch (err) { setMsg("操作失败：" + String((err && err.message) || err)); }
        finally { setOpBusy(false); }
      };

      const removeFromInventory = async (moduleName) => {
        if (!window.confirm("确定从 web profile 移除插件 " + moduleName + " ？\n\n注意：移除核心/必需插件可能导致客户端无法启动，请谨慎操作。")) return;
        setOutput(""); setMsg(null); setOpBusy(true);
        try {
          const r = await api().removePlugin(moduleName);
          setMsg(r && r.ok ? "已移除 " + moduleName + "（重启服务后生效）" : "移除失败，详见上方输出");
        } catch (err) { setMsg("移除失败：" + String((err && err.message) || err)); }
        finally { setOpBusy(false); }
      };

      const toggleBuiltin = async (enabled) => {
        try {
          const r = await api().setBuiltinMcp(enabled);
          if (r && r.ok) setDesktop((prev) => ({ ...(prev || {}), enableDesktopMcp: r.enableDesktopMcp }));
        } catch (err) { /* 忽略 */ }
      };

      const builtinOn = !!(desktop && desktop.enableDesktopMcp);
      const inventoryRows = invError
        ? h("p", { style: st.msgErr }, "读取插件清单失败：" + invError)
        : inventory === null
          ? h("p", { style: st.note }, "正在读取插件清单…")
          : inventory.length === 0
            ? h("p", { style: st.note }, "暂无插件。")
            : h("div", { style: st.card }, inventory.map((entry) => {
              const on = !!entry.enabled;
              return h("div", { key: entry.entryId, style: st.row },
                stack(moduleShortName(entry.moduleName), entry.entryId, { ...st.mono }),
                h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", alignItems: "center", flexWrap: "wrap" } },
                  dotText(on ? SUCCESS : MUTED, on ? "已启用" : "已停用"),
                  btn("卸载", () => removeFromInventory(entry.moduleName), { small: true, danger: true, disabled: opBusy })));
            }));

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("div", { style: st.groupTitle }, "桌面端扩展"),
        h("div", { style: st.card },
          row("设置页扩展（桌面端 / MCP 服务器 / 插件 分区）", dotText(SUCCESS, "已启用")),
          row("内置 dsh_desktop MCP 服务器",
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
              dotText(builtinOn ? SUCCESS : MUTED, builtinOn ? "已启用" : "已停用"),
              btn(builtinOn ? "停用" : "启用", () => toggleBuiltin(!builtinOn), { small: true })))),
        h("div", { style: st.groupTitle }, "harness 插件（web profile）"),
        h("div", { style: st.card },
          row("安装 / 卸载",
            h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
              h("input", {
                className: "dsh-set-input",
                style: { ...st.input, width: "260px", height: "32px" },
                value: pkg, placeholder: "包名，如 @deepseek-ai/dsh-xxx",
                onChange: (e) => setPkg(e.target.value),
              }),
              btn("安装", () => runOp("install", pkg), { small: true, disabled: opBusy }),
              btn("卸载输入包", () => runOp("remove", pkg), { small: true, danger: true, disabled: opBusy }),
              btn("取消", () => { try { api().cancelPlugin(); } catch (err) {} }, { small: true, disabled: !opBusy })))),
        output ? h("pre", { style: st.output }, output) : null,
        h("div", { style: st.groupTitle }, "已加载插件（卸载需谨慎）"),
        inventoryRows,
        msg ? h("div", { style: /失败|请输入/.test(msg) ? st.msgErr : st.msgOk }, msg) : null,
        h("p", { style: st.hint }, "安装/卸载通过 dsh plugin（pnpm）操作 web profile，需要 pnpm 可用；输出见上方。完整的插件配置与状态见「设置 → 插件」。" +
          (desktop && desktop.patchDropped ? " 注：注入补丁当前因启动失败被跳过（见日志）。" : "")));
    }

    /* ================= 状态栏胶囊（Codex 风格 status line，右下角，常驻显示全部状态） ================= */
    function StatusPill() {
      const [state, setState] = react.useState(null);
      const [visionState, setVisionState] = react.useState(null); // { configured, ollamaRunning }
      const [providers, setProviders] = react.useState(null); // providersList 结果（多厂商胶囊）
      const [provBals, setProvBals] = react.useState({}); // provider id -> providersBalance 结果
      react.useEffect(() => {
        let disposed = false;
        const d = api();
        if (!d) return undefined;
        let off = null;
        try { off = d.onState((s) => { if (!disposed) setState(s); }); } catch (err) { /* 忽略 */ }
        d.getState().then((s) => { if (!disposed) setState(s); }).catch(() => {});
        const refreshVision = () => {
          if (!d) return;
          // 视觉源判断：云端 API（xiaomimimo 等）不需要本地 Ollama，显示"视觉 ✓"而非"Ollama 未运行"警告
          const probeOllama = (configured, cloud) => {
            if (cloud) { setVisionState({ configured: !!configured, ollamaRunning: null, cloud: true }); return; }
            if (!d || typeof d.ollamaStatus !== 'function') { setVisionState({ configured: !!configured, ollamaRunning: null }); return; }
            d.ollamaStatus().then((r) => {
              if (!disposed) setVisionState({ configured: !!configured, ollamaRunning: !!(r && r.ok && r.status && r.status.running) });
            }).catch(() => { if (!disposed) setVisionState({ configured: !!configured, ollamaRunning: null }); });
          };
          if (typeof d.getVision === 'function') {
            d.getVision().then((r) => {
              const v = r && r.ok && r.vision;
              const base = String((v && v.baseUrl) || '').toLowerCase();
              // https 云端端点视为云端视觉（本地 Ollama 为 http://127.0.0.1:11434）
              const cloud = base.startsWith('https://');
              probeOllama(!!(v && v.enabled), cloud);
            }).catch(() => probeOllama(false, false));
          } else probeOllama(false, false);
        };
        // 多厂商列表（状态栏胶囊：enabled 厂商各一个；余额与 DeepSeek 余额一起每分钟刷新）
        const refreshProviders = () => {
          if (!d || typeof d.providersList !== 'function') return;
          d.providersList().then((r) => {
            if (disposed || !r || !r.ok) return;
            setProviders(r.providers || []);
            if (typeof d.providersBalance !== 'function') return;
            for (const p of (r.providers || [])) {
              if (p.enabled === false) continue;
              d.providersBalance(p.id).then((br) => { if (!disposed && br) setProvBals((prev) => ({ ...prev, [p.id]: br })); }).catch(() => {});
            }
          }).catch(() => {});
        };
        refreshVision();
        refreshProviders();
        // 每分钟刷新一次（计费时段倒计时 + 本地视觉状态 + 多厂商余额）
        const ticker = setInterval(() => { if (!disposed) { setState((prev) => ({ ...(prev || {}) })); refreshVision(); refreshProviders(); } }, 60000);
        // 窗口重新聚焦时立即刷新厂商余额（长时间最小化/挂机后回来数据可能已过期）
        const onFocus = () => { refreshProviders(); };
        window.addEventListener('focus', onFocus);
        return () => {
          disposed = true;
          if (off) { try { off(); } catch (ignored) {} }
          clearInterval(ticker);
          window.removeEventListener('focus', onFocus);
        };
      }, []);
      if (!api()) return null;

      const MODE_LABELS = { 'read-only': '只读', 'workspace-write': '工作区写', 'danger-full-access': '完全访问' };
      const MODE_SHORT = { 'read-only': '只读', 'workspace-write': '可写', 'danger-full-access': '完全' };
      const MODE_DOT = { 'read-only': MUTED, 'workspace-write': SUCCESS, 'danger-full-access': DANGER };
      const MODE_ORDER = ['read-only', 'workspace-write', 'danger-full-access'];
      const mode = (state && state.permissionMode) || 'workspace-write';
      const hasUpdate = !!(state && state.updateAvailable);
      const updating = !!(state && state.updating);
      const mcpCount = (state && state.mcpServers && state.mcpServers.length) || 0;
      const installed = (state && state.installed) || null;
      const warn = !!(state && state.contextWarning);

      // 状态行样式：输入框下方的非悬浮行（不遮挡任何内容），与 composer 同宽居中。
      const pillStyle = {
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: '4px 14px',
        maxWidth: '720px', margin: '0 auto', padding: '2px 12px 6px',
        font: '12px/1.5 system-ui', color: 'var(--dsw-alias-label-primary)',
        userSelect: 'none', cursor: 'default',
      };
      const chip = (label, onClick, title, tone) => h('span', {
        onClick,
        title: title || '',
        style: {
          cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap',
          color: tone || 'var(--dsw-alias-label-secondary)',
          display: 'inline-flex', alignItems: 'center', gap: '5px',
        },
      }, label);

      const cycleMode = () => {
        const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
        if (window.confirm('切换权限模式到「' + MODE_LABELS[next] + '」将重启 harness 服务，页面会刷新。继续？')) {
          try { api().setPermissionMode(next); } catch (err) {}
        }
      };

      const openSettings = () => {
        try {
          const buttons = [...document.querySelectorAll('button')];
          const target = buttons.find((b) => (b.textContent || '').includes('设置')) || buttons.find((b) => (b.getAttribute('aria-label') || '').includes('设置'));
          if (target) target.click();
        } catch (err) { /* 忽略 */ }
      };

      const updateChip = updating
        ? chip('更新中', null, '', BUSINESS)
        : hasUpdate
          ? chip('更新 v' + state.latest, () => { try { api().applyUpdate(); } catch (err) {} }, '点击更新', BUSINESS)
          : chip('\u2713', () => { try { api().checkForUpdates(); } catch (err) {} }, '已是最新，点击检查更新', SUCCESS);

      const warnPct = warn ? Math.round(((state.contextWarning.tokens || 0) / (state.contextWarning.threshold || 700000)) * 100) : 0;
      const warnChip = warn
        ? chip(
          [dot(BUSINESS, "d"), '上下文 ' + warnPct + '%'],
          () => { try { api().continueConversation(); } catch (err) {} },
          '上下文 ' + (state.contextWarning.tokens || 0).toLocaleString() + ' / ' + (state.contextWarning.threshold || 800000).toLocaleString() + ' tokens，点击新对话接续', BUSINESS)
        : null;

      // 计费时段徽标（常驻显示，点击打开设置页）
      const tierNow = tierOf(Date.now());
      const tierChip = chip(
        [dot(tierNow.peak ? BUSINESS : SUCCESS, tierNow.peak ? '峰' : '闲'), tierNow.peak ? '高峰·×2' : '闲时·5折'],
        openSettings,
        tierNow.peak
          ? '当前高峰时段（价格 ×2），约 ' + tierNow.nextMinutes + ' 分钟后转空闲；点击查看计费详情'
          : '当前空闲时段（5 折），约 ' + tierNow.nextMinutes + ' 分钟后转高峰；点击查看计费详情',
        tierNow.peak ? BUSINESS : SUCCESS);

      // 本地视觉状态灯：配置启用+服务运行=绿灯；启用但服务未运行=黄灯；未启用=灰灯；
      // 云端视觉（https 端点，如小米 MiMo）→ 绿勾（无需本地 Ollama）
      const visionChip = (() => {
        if (!visionState || !visionState.configured) {
          return chip([dot(MUTED, 'v'), '视觉'], openSettings, '本地视觉未启用（点击查看多模态配置）');
        }
        if (visionState.cloud === true) {
          return chip([dot(SUCCESS, 'v'), '视觉 ✓'], openSettings, '视觉模型走云端 API（无需本地 Ollama；点击查看多模态配置）');
        }
        if (visionState.ollamaRunning === true) {
          return chip([dot(SUCCESS, 'v'), '视觉 ✓'], openSettings, '本地视觉就绪（qwen2.5vl 服务运行中）');
        }
        return chip([dot(BUSINESS, 'v'), '视觉 !'], openSettings, '本地视觉已配置但 Ollama 未运行（点击查看）');
      })();

      // 多厂商胶囊（enabled 厂商各一个：dot + 名称缩写 + 余额；
      // balanceKind 支持查询的显示数字，不支持（如小米 MiMo）显示 ✓；点击：MiMo→控制台，其他→设置页）
      const fmtBalance = (v, c) => {
        const num = Number(v || 0);
        const prefix = c === 'CNY' ? '¥' : (c === 'USD' ? '$' : ((c || '') + ' '));
        return prefix + num.toFixed(2);
      };
      const providersChip = (() => {
        if (!providers || !Array.isArray(providers)) return [];
        const enabled = providers.filter((p) => p.enabled !== false && !p.effort);
        if (!enabled.length) return [];
        const out = [];
        for (const p of enabled) {
          const pid = String((p && p.provider) || '').toLowerCase();
          const isMimo = pid.indexOf('mimo') >= 0;
          const b = provBals[p.id];
          let balText = '—';
          if (b) {
            if (b.error) balText = '?';
            else if (b.supported !== true) balText = '\u2713';
            else if (b.balance) balText = fmtBalance(b.balance.total, b.balance.currency);
          }
          out.push(chip([dot(SUCCESS, 'p' + p.id), providerAbbrev(p) + ' ' + balText],
            () => { if (isMimo) { try { api().openMimoConsole(); } catch (err) {} } else openSettings(); },
            (p.name || p.provider) + '（' + pid + '）：' +
            (b && b.error ? '余额查询失败' : (b && b.supported !== true ? '无余额查询接口，请在控制台查看' : (b && b.balance ? '余额 ' + balText : '余额查询中…'))) +
            '；点击' + (isMimo ? '打开小米控制台' : '打开设置页「模型调度」分区')));
        }
        return out;
      })();

      return h('div', {
        style: pillStyle,
        'data-dsh-desktop-pill': 'true',
      },
        // 权限模式（短标签，点击循环切换）→ 上下文告警（有告警时）→ 计费时段 → 更新 → 多厂商（含 DeepSeek 余额）→ 本地视觉 → 版本 → MCP 数
        // （默认模型由官方模型选择器展示，这里不再重复，避免显示过时信息）
        chip([dot(MODE_DOT[mode], "d"), MODE_SHORT[mode]], cycleMode, '权限模式（点击切换）'),
        warnChip,
        tierChip,
        updateChip,
        ...(providersChip || []),
        visionChip,
        installed ? chip('v' + installed, null, 'harness 版本') : null,
        chip('MCP ' + mcpCount, null, 'MCP 服务器数'),
        // 接续按钮：紧贴 MCP 胶囊右侧（同一状态行），新对话无损交接当前任务
        h('span', { key: 'sep', style: { color: 'var(--dsw-alias-border-l2)' } }, '|'),
        h('button', {
          key: 'continue',
          type: 'button',
          title: '新对话接续当前任务：先写 .dsh/handoff.md 交接文件，再开新对话无缝续做（上下文重置，无损）',
          'aria-label': '接续',
          onClick: () => { try { api().continueConversation(); } catch (err) {} },
          style: {
            cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1)',
            background: 'transparent', color: 'var(--dsw-alias-label-primary)', borderRadius: '8px',
            padding: '0 10px', font: 'inherit', fontSize: '12px', lineHeight: '20px',
            display: 'inline-flex', alignItems: 'center', gap: '4px',
          },
        }, '\u27f3', h('span', { key: 'ct' }, '接续')));
    }

    /* ================= 多模态卡组（并入"桌面端"分区；官方原生图片通道 + 本地视觉模型兜底） ================= */
    function VisionBlock() {
      const [vision, setVision] = react.useState(null);
      const [draft, setDraft] = react.useState({ enabled: false, baseUrl: '', apiKey: '', model: '' });
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [hasKey, setHasKey] = react.useState(false);
      const [ollamaState, setOllamaState] = react.useState(null);
      const [ollamaLog, setOllamaLog] = react.useState('');
      const [ollamaBusy, setOllamaBusy] = react.useState(false);
      const [pullModelName, setPullModelName] = react.useState('qwen2.5vl:3b');

      const OLLAMA_MODELS = [
        { name: 'qwen2.5vl:3b', label: 'qwen2.5vl:3b（约 2.2GB，推荐 CPU 场景：比 7b 快数倍，中文识别够用）' },
        { name: 'qwen2.5vl:7b', label: 'qwen2.5vl:7b（约 5.9GB，识别最准，但纯 CPU 单次推理可能 1~8 分钟）' },
        { name: 'llava:7b', label: 'llava:7b（约 4.7GB）' },
        { name: 'llama3.2-vision:11b', label: 'llama3.2-vision:11b（约 7.9GB，英文强）' },
      ];

      const refreshOllama = react.useCallback(() => {
        const d = api();
        if (!d || !d.ollamaStatus) return;
        d.ollamaStatus().then((r) => { if (r && r.ok) setOllamaState(r.status); }).catch(() => {});
      }, []);

      react.useEffect(() => {
        const d = api();
        if (!d) return;
        d.getVision().then((r) => {
          if (r && r.ok) {
            setVision(r.vision);
            setHasKey(r.hasKey);
            setDraft({ ...r.vision, apiKey: '' });
          }
        }).catch(() => {});
        const offP = d.onOllamaProgress ? d.onOllamaProgress((p) => { if (p && p.text) setOllamaLog((prev) => p.text + '\n' + prev); }) : () => {};
        const offO = d.onOllamaOutput ? d.onOllamaOutput((p) => { if (p && p.text) setOllamaLog((prev) => p.text + '\n' + prev); }) : () => {};
        refreshOllama();
        const timer = setInterval(refreshOllama, 10000);
        return () => { offP(); offO(); clearInterval(timer); };
      }, [refreshOllama]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const showMsg = (tone, text) => setMsg({ tone, text });
      const setD = (key) => (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));

      const save = async () => {
        setBusy(true);
        try {
          const payload = { ...draft };
          if (!String(payload.apiKey).trim() && hasKey && vision) payload.apiKey = vision.apiKey; // 未改动时保留已存 key
          const r = await api().saveVision(payload);
          if (!r.ok) showMsg('error', r.error || '保存失败');
          else {
            showMsg('ok', '已保存（重启服务后生效）');
            setVision(r.vision);
            setHasKey(true);
            setDraft({ ...r.vision, apiKey: '' });
          }
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const test = async () => {
        setBusy(true);
        try {
          const r = await api().testVision();
          if (r.ok) showMsg('ok', '连接成功，模型回复示例：' + (r.sample || '（空）'));
          else showMsg('error', r.error || '连接失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      /* ---- Ollama 本地模型操作 ---- */
      const ollamaOp = async (fn, label) => {
        setOllamaBusy(true);
        setOllamaLog('');
        try {
          const r = await fn();
          if (!r.ok) showMsg('error', r.error || (label + '失败'));
          else showMsg('ok', label + '成功');
          refreshOllama();
          return r;
        } catch (err) { showMsg('error', String((err && err.message) || err)); return { ok: false }; }
        finally { setOllamaBusy(false); }
      };
      const doInstall = () => ollamaOp(() => api().ollamaInstall(), '安装 Ollama');
      const doStart = () => ollamaOp(() => api().ollamaStart(), '启动 Ollama');
      const doPull = () => ollamaOp(() => api().ollamaPull(pullModelName), '拉取模型');
      const doUse = (modelName) => ollamaOp(async () => {
        const r = await api().ollamaUseVision(modelName);
        if (r.ok) {
          setDraft((prev) => ({ ...prev, baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: modelName }));
          setHasKey(false);
          setVision(r.vision);
        }
        return r;
      }, '启用本地视觉模型');

      const ollamaInstalled = !!(ollamaState && ollamaState.installed);
      const ollamaRunning = !!(ollamaState && ollamaState.running);
      const ollamaModels = (ollamaState && ollamaState.models) || [];

      const ollamaBlock = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("div", { style: st.groupTitle }, "本地视觉模型（一键集成，无需 apiKey）"),
        h("div", { style: st.card },
          row("状态",
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
              dotText(ollamaRunning ? SUCCESS : MUTED,
                !ollamaInstalled ? '未安装' : (ollamaRunning ? '运行中' : '已安装 · 未运行')),
              ollamaState && ollamaState.version ? h("span", { style: st.status }, 'v' + ollamaState.version) : null)),
          row("已拉取模型", h("span", { style: st.value }, ollamaModels.length ? ollamaModels.map((m) => m.name).join('、') : '—')),
          h("div", { style: st.actions },
            !ollamaInstalled
              ? btn("1. 安装 Ollama（约 700MB）", doInstall, { primary: true, disabled: ollamaBusy })
              : null,
            ollamaInstalled && !ollamaRunning
              ? btn("启动服务", doStart, { disabled: ollamaBusy })
              : null,
            ollamaInstalled
              ? h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
                h("select", { className: "dsh-set-select", style: { ...st.select, width: "300px" }, value: pullModelName, onChange: (e) => setPullModelName(e.target.value) },
                  OLLAMA_MODELS.map((m) => h("option", { key: m.name, value: m.name }, m.label))),
                btn("2. 拉取模型", doPull, { disabled: ollamaBusy }),
                ollamaModels.length
                  ? btn("3. 启用为图片模型（" + ollamaModels[0].name + "）", () => doUse(ollamaModels[0].name), { primary: true, disabled: ollamaBusy })
                  : null)
              : null),
          ollamaLog ? h("pre", { style: st.output }, ollamaLog.slice(0, 4000)) : null,
          h("p", { style: st.hint }, "软件内置 Ollama 便携版管理：一键下载（官方包，约 700MB）、启动本地服务并拉取视觉模型；模型按需下载，qwen2.5vl:3b 约 2.2GB、CPU 也能跑。启用后图片识别完全本地完成、零 apiKey、不消耗 DeepSeek 额度；Ollama 服务随桌面端退出而停止。")));

      const field = (label, control) => h("label", { style: st.field }, h("span", { style: st.fieldLabel }, label), control);

      // 常见 OpenAI 兼容服务商预设：用户只需选服务商 + 模型，填 apiKey 即可。
      const VISION_PRESETS = [
        { id: 'deepseek-vision', label: 'DeepSeek 官方 Vision（推荐，key 自动复用 .credentials.yaml）', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash-vision-exp'] },
        { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'] },
        { id: 'zhipu', label: '智谱 GLM（国内）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4v-plus', 'glm-4v-flash', 'glm-4.1v-thinking-flash'] },
        { id: 'dashscope', label: '阿里云百炼 Qwen-VL（国内）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct'] },
        { id: 'siliconflow', label: '硅基流动 SiliconFlow（国内）', baseUrl: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen2.5-VL-72B-Instruct', 'Pro/Qwen/Qwen2.5-VL-7B-Instruct', 'deepseek-ai/deepseek-vl2'] },
        { id: 'moonshot', label: 'Moonshot Kimi（国内）', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'kimi-latest'] },
        { id: 'volcengine', label: '火山方舟 豆包（国内）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-1.5-vision-pro-32k-250115'] },
        { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'google/gemini-2.0-flash-001', 'qwen/qwen-2.5-vl-72b-instruct'] },
        { id: 'ollama', label: 'Ollama（本地，无需 key）', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5vl:3b', 'qwen2.5vl:7b', 'llava:7b'] },
        { id: 'custom', label: '自定义（手动填写）', baseUrl: '', models: [] },
      ];
      const presetOf = (baseUrl) => VISION_PRESETS.find((p) => p.baseUrl && p.baseUrl === String(baseUrl || '').trim()) || null;
      const activePreset = presetOf(draft.baseUrl);
      const selectPreset = (id) => {
        const p = VISION_PRESETS.find((x) => x.id === id);
        if (!p) return;
        setDraft((prev) => ({
          ...prev,
          baseUrl: p.baseUrl,
          model: (p.models && p.models[0]) || prev.model || '',
          providerId: id,
        }));
      };
      const presetModels = activePreset && activePreset.models && activePreset.models.length ? activePreset.models : (draft.model ? [draft.model] : []);

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("div", { style: st.groupTitle }, "多模态（图片识别）"),
        h("div", { style: st.card },
          row("官方多模态模型", h("span", { style: st.value }, "deepseek-v4-flash-vision-exp（模型选择器中可选）")),
          row("图片通道", h("span", { style: st.value }, "harness 原生直传，自动走 Files API，无需本分区配置")),
          row("本分区职责", h("span", { style: st.value }, "仅兜底纯文本模型（deepseek-v4-flash / v4-pro 等）的图片识别"))),
        ollamaBlock,
        h("div", { style: st.card },
          row("启用图片识别",
            h("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
              h("input", { type: "checkbox", checked: !!draft.enabled, onChange: (e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked })) }),
              h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px" } }, draft.enabled ? "已启用" : "已停用"))),
          row("职责", h("span", { style: st.value }, "仅处理图片，不参与对话"))),
        h("div", { style: st.form },
          field("服务商（选择后自动填好地址与可选模型）",
            h("select", { className: "dsh-set-select", style: st.select, value: (draft.providerId || (activePreset && activePreset.id) || 'custom'), onChange: (e) => selectPreset(e.target.value) },
              VISION_PRESETS.map((p) => h("option", { key: p.id, value: p.id }, p.label)))),
          field("baseUrl（接口地址）",
            h("input", { className: "dsh-set-input", style: st.input, value: draft.baseUrl, onChange: setD("baseUrl"), placeholder: "https://api.openai.com/v1" })),
          field("model（视觉模型）",
            presetModels.length
              ? h("select", { className: "dsh-set-select", style: st.select, value: draft.model, onChange: setD("model") },
                presetModels.map((m) => h("option", { key: m, value: m }, m)))
              : h("input", { className: "dsh-set-input", style: st.input, value: draft.model, onChange: setD("model"), placeholder: "如 gpt-4o-mini / qwen-vl-max" })),
          field("apiKey" + (hasKey ? "（已保存，留空则不修改）" : "") + (activePreset && activePreset.id === 'ollama' ? "（Ollama 本地服务无需填写）" : "") + (activePreset && activePreset.id === 'deepseek-vision' ? "（留空自动使用 .credentials.yaml 的 DEEPSEEK_API_KEY）" : ""),
            h("input", { className: "dsh-set-input", style: st.input, type: "password", value: draft.apiKey, onChange: setD("apiKey"), placeholder: hasKey ? '••••••••' : 'sk-...' })),
          h("div", { style: st.actions },
            btn("保存", save, { disabled: busy }),
            btn("测试连接", test, { disabled: busy }))),
        msg ? h("div", { style: msg.tone === "error" ? st.msgErr : st.msgOk }, msg.text) : null,
        h("p", { style: st.hint }, "图片处理双轨：① 官方多模态模型（deepseek-v4-flash-vision-exp）由 harness 原生接收图片（自动走 Files API 上传并复用），无需本分区配置；② 纯文本模型（deepseek-v4-flash / deepseek-v4-pro）不接收图片，agent 遇到图片附件会调用 mcp__dsh_desktop__describe_image，由本分区配置的视觉模型（Ollama 或其他家）描述后再继续。建议在「桌面端 → 项目说明」里把该用法写进 AGENTS.md。视觉模型仅在纯文本模型遇到图片时被调用，正常对话完全走 DeepSeek。国内服务商需去对应平台申请 apiKey。"));
    }

    /* ================= 用量与账单 ================= */
    function UsageSection() {
      const [balance, setBalance] = react.useState(null);
      const [usage, setUsage] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [, setTick] = react.useState(0);
      // 自定义峰谷单价草稿（官方调价后手动更新，不用改代码）
      const [tierCustom, setTierCustom] = react.useState(false);
      const [tierDraft, setTierDraft] = react.useState(null);
      const [tierMsg, setTierMsg] = react.useState(null);
      // 每分钟刷新计费时段倒计时
      react.useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);
      react.useEffect(() => {
        if (!usage || !usage.tier) return;
        setTierCustom(!!usage.tier.custom);
        setTierDraft(usage.tier.custom ? {
          peak: { ...usage.tier.prices },
          valley: { input: 1.5, cacheHit: 0.05, output: 4.5 },
        } : null);
      }, [usage]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const showMsg = (tone, text) => setMsg({ tone, text });

      const loadBalance = async () => {
        setBusy(true);
        setBalance(null);
        try {
          const r = await api().getBalance();
          if (r.ok) setBalance(r);
          else showMsg('error', r.error || '查询失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const loadUsage = async () => {
        setBusy(true);
        setUsage(null);
        try {
          const r = await api().getUsage();
          if (r.ok) setUsage(r.summary);
          else showMsg('error', r.error || '统计失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const balanceBlock = balance
        ? h("div", { style: st.card },
          row("账户状态", dotText(balance.isAvailable ? SUCCESS : DANGER, balance.isAvailable ? "可用" : "不可用", { color: "var(--dsw-alias-label-primary)" })),
          (balance.balanceInfos || []).map((info) => row("余额（" + (info.currency || '?') + "）",
            h("span", { style: st.value }, String(info.total_balance ?? '—') + "（赠送 " + String(info.granted_balance ?? '—') + " / 充值 " + String(info.topped_up_balance ?? '—') + "）"),
            info.currency || '?')))
        : null;

      const sessionRows = usage
        ? (usage.sessions || []).slice(0, 6).map((s) => h("div", {
          key: s.sessionId,
          style: { display: "flex", justifyContent: "space-between", gap: "8px", padding: "2px 0" },
        },
        h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", minWidth: 0, overflowWrap: "anywhere" } }, s.title || s.sessionId.slice(0, 8)),
        h("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", whiteSpace: "nowrap" } },
          "入 " + fmtNum(s.usage.inputTokens) + " / 出 " + fmtNum(s.usage.outputTokens))))
        : null;

      const usageBlock = usage
        ? h("div", { style: st.card },
          row("输入（缓存未命中）", h("span", { style: st.value }, fmtNum(usage.total.inputTokens) + " tokens")),
          row("输入（缓存命中）", h("span", { style: st.value }, fmtNum(usage.total.cacheReadTokens) + " tokens")),
          row("输出", h("span", { style: st.value }, fmtNum(usage.total.outputTokens) + " tokens")),
          row("推理", h("span", { style: st.value }, fmtNum(usage.total.reasoningTokens) + " tokens")),
          row("估算成本", h("span", { style: { ...st.value, color: BUSINESS } }, "$" + usage.estimatedCostUsd)),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", paddingTop: "4px" } }, sessionRows))
        : null;

      /* ---- 计费时段（使用共享 tierOf） ---- */
      const tierState = tierOf(Date.now());
      const tierPrices = tierState.peak ? { input: 3.0, cacheHit: 0.10, output: 9.0 } : { input: 1.5, cacheHit: 0.05, output: 4.5 };
      const tierCard = h("div", { style: st.card },
        row("当前计费时段", h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          dotText(tierState.peak ? BUSINESS : SUCCESS, tierState.peak ? "高峰时段（价格 ×2）" : "空闲时段（5 折）"))),
        row("时段规则", h("span", { style: st.value }, "高峰：周一至周五 9:00-12:00、14:00-18:00（北京时间）；其余时间（含周末全天）为空闲")),
        row("单价（元/百万 tokens）", h("span", { style: st.value }, "输入未命中 " + tierPrices.input + " / 缓存命中 " + tierPrices.cacheHit + " / 输出 " + tierPrices.output)),
        row("距下次切换", h("span", { style: st.value }, "约 " + tierState.nextMinutes + " 分钟后 → " + (tierState.peak ? "空闲时段" : "高峰时段"))),
        row("省钱建议", h("span", { style: st.value }, tierState.peak ? "当前为高峰时段，批量重活可挪到空闲时段（约省一半）" : "当前为空闲时段，适合跑大批量任务")));

      /* ---- 自定义峰谷单价（官方调价时可手动更新，不用等改代码） ---- */
      const numField = (label, value, onChange) => h("label", { style: { ...st.field, flex: 1 } },
        h("span", { style: st.fieldLabel }, label),
        h("input", { className: "dsh-set-input", style: st.input, type: "number", step: "0.01", min: "0", value: value === undefined ? '' : String(value), onChange: onChange }));
      const priceRow = (tierName, draft, setDraft) => h("div", { style: { display: "flex", gap: "8px" } },
        h("span", { style: { ...st.fieldLabel, paddingTop: "10px", flex: "none", width: "34px" } }, tierName),
        numField("输入未命中", draft && draft.input, (e) => setDraft({ ...draft, input: Number(e.target.value) })),
        numField("缓存命中", draft && draft.cacheHit, (e) => setDraft({ ...draft, cacheHit: Number(e.target.value) })),
        numField("输出", draft && draft.output, (e) => setDraft({ ...draft, output: Number(e.target.value) })));
      const savePrices = async () => {
        setBusy(true);
        try {
          const r = await api().setUsageTierPrices(tierCustom, tierDraft);
          if (r.ok) { setTierMsg('已保存（官方默认：高峰 3.0/0.10/9.0，空闲 1.5/0.05/4.5，元/百万 tokens）'); loadUsage(); }
          else setTierMsg('保存失败：' + (r.error || ''));
        } catch (err) { setTierMsg('保存失败：' + String((err && err.message) || err)); }
        finally { setBusy(false); }
      };
      const priceCard = h("div", { style: st.card },
        row("自定义峰谷单价", statusChip(tierCustom, "已启用", "官方默认", () => setTierCustom(!tierCustom), false)),
        tierCustom ? h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", paddingTop: "4px" } },
          priceRow("高峰", tierDraft && tierDraft.peak, (v) => setTierDraft({ ...tierDraft, peak: v })),
          priceRow("空闲", tierDraft && tierDraft.valley, (v) => setTierDraft({ ...tierDraft, valley: v })),
          h("div", { style: st.actions },
            btn("保存单价", savePrices, { small: true, primary: true, disabled: busy })),
          tierMsg ? h("p", { style: st.msgOk }, tierMsg) : null)
        : h("p", { style: st.hint }, "官方调价后想立即按新价格估算，可在此启用自定义单价（元/百万 tokens，DeepSeek 峰谷计费）。"));

      return h("div", { style: st.grid },
        h("div", { style: st.title }, "用量与账单"),
        h("div", { style: st.actions },
          btn("查询 API 余额", loadBalance, { disabled: busy }),
          btn("统计本工作区用量", loadUsage, { disabled: busy })),
        tierCard,
        priceCard,
        balanceBlock,
        usageBlock,
        msg ? h("div", { style: msg.tone === "error" ? st.msgErr : st.msgOk }, msg.text) : null,
        h("p", { style: st.hint }, "余额来自 DeepSeek 官方接口（.credentials.yaml 中的 DEEPSEEK_API_KEY）；用量解析本地会话日志，成本按 settings.json 的 usagePrices 单价估算（默认 DeepSeek 参考价，可自行调整）。"));
    }

    /* ================= 输入框常驻工具按钮组（截图 + 附加文件） ================= */
    /** conversation 服务引用（apply 时从 ctx 获取；ScreenshotButton 注入草稿图片用）。 */
    let convService = null;
    let envGitSig = null; // env-git 诊断日志去重签名（避免 5s 轮询刷爆主进程日志）

    function ScreenshotButton(props) {
      const disabled = !api() || !api().screenshot;
      const inputActions = (props && props.inputActions) || null;
      const pendingShots = react.useRef([]); // [{ path, imageIds }] 待补救的截图（支持多张）
      const descCache = react.useRef({}); // path -> { description, elapsedMs, model }（截图预识别结果）
      // 始终指向最新的 inputActions（每次渲染都是新对象，旧闭包里的是过期引用）
      const iaRef = react.useRef(inputActions);
      iaRef.current = inputActions;
      const latestInputActions = () => iaRef.current || inputActions;

      // 预识别结果缓存：主进程在截图时已开始识别，完成后推送到这里；
      // 发送被拒的补救流程直用（零等待，无"识别中"占位被误发的风险）。
      react.useEffect(() => {
        const d = api();
        if (!d || typeof d.onScreenshotDesc !== 'function') return undefined;
        const off = d.onScreenshotDesc((payload) => {
          try {
            if (!payload || !payload.path || !payload.description) return;
            descCache.current[payload.path] = { description: payload.description, elapsedMs: payload.elapsedMs, model: payload.model };
          } catch { /* 忽略 */ }
        });
        return off;
      }, []);

      // 截图就绪 → 把 data URL 转成 File 注册为官方草稿图片，并经 inputActions.addImages
      // 加入输入框（只 createDraftImages 不会显示，必须走 shell.addImages(ids) 通知 UI）。
      // 失败降级：注入文字引用（可 read_image 查看原图）。
      react.useEffect(() => {
        const d = api();
        if (!d || typeof d.onScreenshotReady !== 'function') return undefined;
        const off = d.onScreenshotReady((payload) => {
          try {
            if (!payload || !payload.dataUrl) return;
            fetch(payload.dataUrl)
              .then((res) => res.blob())
              .then((blob) => {
                const file = new File([blob], 'screenshot-' + (payload.ts || Date.now()) + '.png', { type: 'image/png' });
                if (!convService || typeof convService.createDraftImages !== 'function') throw new Error('conversation \u670d\u52a1\u4e0d\u53ef\u7528');
                if (!inputActions || typeof inputActions.addImages !== 'function') throw new Error('inputActions \u4e0d\u53ef\u7528');
                const images = convService.createDraftImages([file]);
                if (!inputActions.addImages(images.map((it) => it.id)) && typeof convService.releaseDraftImages === 'function') {
                  convService.releaseDraftImages(images);
                } else {
                  // 记录待补救信息：纯文本模型发送时 harness 会拒绝图片，检测到后自动转本地识别
                  // 多张截图依次入队，补救时全部处理，绝不漏图
                  pendingShots.current.push({ path: payload.path || '', imageIds: images.map((it) => it.id) });
                }
              })
              .catch(() => {
                // 降级：注入文字引用（多模态模型可用 read_image 查看原图）
                try { d.injectText('\u3010\u622a\u56fe\u3011\u5df2\u4fdd\u5b58\uff1a' + (payload && payload.path || '') + '\uff08\u53ef\u7528 read_image \u67e5\u770b\u539f\u56fe\uff09'); } catch { /* 忽略 */ }
              });
          } catch { /* 忽略 */ }
        });
        return off;
      }, [inputActions]);

      // 截图发送被拒（纯文本模型不支持图片）→ 发送瞬间补救：删除图片草稿 → 逐张识别 →
      // 汇总描述填入并自动重发。支持多张截图/附件：全部识别，绝不漏图。
      // 拒绝文案可能渲染在 shadow DOM / 常驻复用的 toast 节点里：
      // ① MutationObserver 只覆盖 document 树（shadow root 内不可见），并补 characterData（复用节点改写文案）；
      // ② 800ms 兜底轮询深扫全部 shadow root 的文本节点，匹配数较基线新增即触发。
      react.useEffect(() => {
        if (!inputActions) return undefined;
        const d = api();
        const debug = (step, val) => {
          if (!d || typeof d.clientDebug !== 'function') return;
          try { d.clientDebug({ src: 'rescue', step, val }); } catch { /* 忽略 */ }
        };
        const doRescue = () => {
          const shots = pendingShots.current.slice();
          pendingShots.current = [];
          if (!shots.length) return;
          if (shots[0].done) return; // 防重复
          shots.forEach((s) => { s.done = true; });
          debug('start', { n: shots.length });
          // 过滤：用户已从草稿删掉的图不再识别（draftImages 只返回仍存活的附件）
          let finalShots = [];
          try {
            if (convService && typeof convService.draftImages === 'function') {
              finalShots = shots.filter((s) => convService.draftImages(s.imageIds).length === s.imageIds.length);
            }
          } catch { finalShots = []; }
          if (!finalShots.length) finalShots = shots; // 全被拒绝流程释放 → 兜底全用
          debug('filtered', { kept: finalShots.length, total: shots.length });
          // 先保存用户输入的话（补救不能把用户的话挤掉：用户原话在前，截图描述在后）
          let userText = '';
          try {
            const el = document.querySelector('textarea[data-phase]');
            const v = el ? (el.value !== undefined ? el.value : (el.textContent || '')) : '';
            userText = String(v || '').trim();
          } catch { userText = ''; }
          try {
            for (const s of shots) {
              for (const id of s.imageIds) { if (typeof inputActions.removeImage === 'function') inputActions.removeImage(id); }
            }
          } catch { /* 忽略 */ }
          // 占位提示：识别与发送都在主进程完成，页面不参与发送
          const placeholder = '\u3010\u622a\u56fe\u3011\u89c6\u89c9\u8bc6\u522b\u4e2d\u2026\uff08\u5171 ' + finalShots.length +
            ' \u5f20\uff0c\u5b8c\u6210\u540e\u81ea\u52a8\u53d1\u9001\u5230\u5bf9\u8bdd\uff09';
          const act0 = latestInputActions();
          if (act0 && typeof act0.setDraft === 'function') {
            try { act0.setDraft(userText ? userText + '\n\n' + placeholder : placeholder); } catch { /* 忽略 */ }
          }
          // 主进程补救：识别全部图片 + 官方 RPC 直发进当前会话——免疫页面重载/重渲染，
          // 根治"识别完不自动发送"（此前页面侧 Promise/输入框提交随重渲染被掐死）。
          if (d && typeof d.screenshotRescue === 'function') {
            d.screenshotRescue({ shots: finalShots.map((s) => ({ path: s.path })), userText })
              .then((r) => {
                debug('rescue-rpc', { ok: !!(r && r.ok), sent: !!(r && r.sent) });
                // 消息已由主进程发出：清掉占位草稿
                const act2 = latestInputActions();
                if (act2 && typeof act2.setDraft === 'function') {
                  try { act2.setDraft(''); } catch { /* 忽略 */ }
                }
              })
              .catch((err) => debug('rescue-rpc-error', String((err && err.message) || err).slice(0, 120)));
          } else {
            debug('rescue-rpc-missing', '');
          }
        };
        const rejectRe = /\u4e0d\u652f\u6301\u56fe\u7247|\u56fe\u7247\u53d1\u9001\u5931\u8d25/;
        let observer = null;
        try {
          observer = new MutationObserver((muts) => {
            for (const m of muts) {
              const nodes = [];
              for (const node of m.addedNodes) nodes.push(node);
              // toast 常驻复用节点改写文案时没有 addedNodes——characterData 变更检查 target 本身
              if (m.type === 'characterData' && m.target) nodes.push(m.target);
              for (const node of nodes) {
                const txt = node && (node.nodeType === 3 || node.nodeType === 1) ? node.textContent : '';
                if (txt && rejectRe.test(txt)) {
                  debug('reject-seen', String(txt).slice(0, 60));
                  doRescue();
                  return;
                }
              }
            }
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        } catch { observer = null; }
        // 兜底轮询：深扫全 DOM（含 shadow root）文本节点，拒绝提示出现在 shadow 树里也逃不掉。
        // 计数比基线增加才触发（历史残留计入基线，不误报）；回落时同步基线防后续误判。
        let baselineReject = -1;
        const countRejectTexts = () => {
          let n = 0;
          const walk = (root) => {
            if (!root || n > 300) return;
            for (const child of root.childNodes) {
              if (child.nodeType === 3) {
                if (rejectRe.test(child.nodeValue || '')) n++;
              } else if (child.nodeType === 1) {
                walk(child);
                if (child.shadowRoot) walk(child.shadowRoot);
              }
            }
          };
          walk(document.body);
          return n;
        };
        const pollTimer = setInterval(() => {
          try {
            const n = countRejectTexts();
            if (baselineReject === -1) { baselineReject = n; return; }
            if (n > baselineReject) {
              debug('reject-poll', { n, baseline: baselineReject });
              baselineReject = n;
              doRescue();
            } else if (n < baselineReject) {
              baselineReject = n;
            }
          } catch { /* 忽略 */ }
        }, 800);
        // 安全阀：120s 后清理（用户没发送则图片保持显示、识别结果丢弃）
        const timeout = setTimeout(() => { pendingShots.current = []; }, 120000);
        return () => {
          clearTimeout(timeout);
          clearInterval(pollTimer);
          if (observer) { try { observer.disconnect(); } catch { /* 忽略 */ } }
        };
      }, [inputActions]);

      return h('button', {
        type: 'button',
        title: '快速截图并粘贴到对话框（框选屏幕区域）',
        'aria-label': '快速截图',
        disabled,
        onClick: () => { try { api().screenshot(); } catch (err) {} },
        style: {
          cursor: disabled ? 'default' : 'pointer', border: 'none', background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)', width: '28px', height: '28px',
          borderRadius: '8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '15px', lineHeight: 1, padding: 0, opacity: disabled ? '0.4' : 1,
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'; },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
      }, '\u{1f4f7}');
    }

    function AttachButton() {
      const disabled = !api() || !api().attachFiles;
      return h('button', {
        type: 'button',
        title: '附加文件到对话',
        'aria-label': '附加文件到对话',
        disabled,
        onClick: () => { try { api().attachFiles(); } catch (err) {} },
        style: {
          cursor: disabled ? 'default' : 'pointer', border: 'none', background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)', width: '34px', height: '34px',
          borderRadius: '8px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '17px', lineHeight: 1, padding: 0, opacity: disabled ? '0.4' : 1,
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'; },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
      }, '\u{1f4ce}');
    }

    /* ================= 插话按钮（输入框旁：立即发送，并把这条消息插到队列最前） ================= */
    // 官方 queue dock 的「插话发送」按钮：消息进队列后可把该行置顶。参考 main.js auto-resume 的
    // DOM 操作：querySelector('[data-queue-dock]') → 展开折叠的 header → 找 title/aria-label 含
    // /插话发送|Steer queued message/i 的按钮 → 沿父链 textContent 匹配 MARK 后 click。
    // 不打断正在运行的子代理回合（harness 不支持也不应打断），只保证处理顺序最前。
    function InterjectButton(props) {
      const inputActions = (props && props.inputActions) || null;
      const [hasText, setHasText] = react.useState(false);
      const [busy, setBusy] = react.useState(false);

      const readText = () => {
        try {
          const el = document.querySelector('textarea[data-phase]');
          return el ? String((el.value !== undefined ? el.value : (el.textContent || '')) || '').trim() : '';
        } catch { return ''; }
      };
      // 实时跟踪输入框是否有内容（决定 disabled；官方 textarea 可能随重渲染替换，用轮询兜底）
      react.useEffect(() => {
        const update = () => setHasText(!!readText());
        update();
        const iv = setInterval(update, 400);
        const el = document.querySelector('textarea[data-phase]');
        if (el) { try { el.addEventListener('input', update); } catch { /* 忽略 */ } }
        return () => { clearInterval(iv); if (el) { try { el.removeEventListener('input', update); } catch { /* 忽略 */ } } };
      }, []);

      /** 队列 dock 中找「插话发送」按钮并点击该行（MARK 匹配）。true=已置顶；'no-dock'=队列已消费/无 dock。 */
      const steerQueue = (mark) => {
        try {
          const dock = document.querySelector('[data-queue-dock]');
          if (!dock) return 'no-dock';
          const hdr = dock.querySelector('button[aria-expanded="false"]');
          if (hdr) hdr.click(); // 队列多项时官方 dock 默认折叠，先展开 header
          const btns = [...dock.querySelectorAll('button')];
          for (const b of btns) {
            const t = (b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '');
            if (/插话发送|Steer queued message/i.test(t)) {
              let node = b;
              for (let d = 0; d < 6 && node; d++) {
                if ((node.textContent || '').includes(mark)) { b.click(); return true; }
                node = node.parentElement;
              }
            }
          }
        } catch { /* 忽略 */ }
        return false;
      };

      const interject = () => {
        if (busy) return;
        const text = readText();
        if (!text) return; // 空输入不动作（按钮 disabled 已提示）
        const mark = text.slice(0, 24);
        setBusy(true);
        try {
          // 1) 正常发送（Enter 语义，让消息进队列）：优先官方 inputActions.submit()，兜底 Enter keydown
          let sent = false;
          if (inputActions && typeof inputActions.submit === 'function') {
            try { inputActions.submit(); sent = true; } catch { sent = false; }
          }
          if (!sent) {
            try {
              const ta = document.querySelector('textarea[data-phase]');
              if (ta) {
                const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
                try { Object.defineProperty(ev, 'keyCode', { get: () => 13 }); Object.defineProperty(ev, 'which', { get: () => 13 }); } catch { /* 忽略 */ }
                ta.dispatchEvent(ev);
              }
            } catch { /* 忽略 */ }
          }
          // 2) 轮询「插话发送」把该消息置顶（最多 8 秒；队列已消费/单消息则静默成功，顺序无关紧要）
          let tries = 0;
          const iv = setInterval(() => {
            tries++;
            let done = tries >= 8;
            try {
              const r = steerQueue(mark);
              if (r === true || r === 'no-dock') done = true;
            } catch { /* 忽略 */ }
            if (done) { clearInterval(iv); setBusy(false); }
          }, 1000);
        } catch { setBusy(false); }
      };

      const disabled = busy || !hasText || !api();
      return h('button', {
        type: 'button',
        title: '插话：把这条消息排到队列最前，子代理完成后主模型立即处理',
        'aria-label': '插话',
        disabled,
        onClick: interject,
        style: {
          cursor: disabled ? 'default' : 'pointer',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          borderRadius: '8px', padding: '0 10px', font: 'inherit',
          fontSize: '12px', lineHeight: '20px',
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          opacity: disabled ? '0.4' : 1,
        },
      }, '\u21c9', h('span', { key: 't' }, busy ? '插话中…' : '插话'));
    }

    /* ================= 记忆（自动记忆 + 知识图谱管理） ================= */
    function MemorySection() {
      const [status, setStatus] = react.useState(null);
      const [graph, setGraph] = react.useState(null);
      const [note, setNote] = react.useState('');
      const [newName, setNewName] = react.useState('');
      const [newType, setNewType] = react.useState('concept');
      const [newObs, setNewObs] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);

      const refresh = react.useCallback(() => {
        const d = api();
        if (!d || !d.memoryStatus) return;
        d.memoryStatus().then((r) => { if (r && r.ok) setStatus(r); }).catch(() => {});
        if (d.memoryList) d.memoryList().then((r) => { if (r && r.ok) setGraph(r); }).catch(() => {});
      }, []);

      react.useEffect(() => { refresh(); const t = setInterval(refresh, 20000); return () => clearInterval(t); }, [refresh]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const showMsg = (tone, text) => setMsg({ tone, text });

      const toggleAuto = async () => {
        const next = !(status && status.autoEnabled);
        setBusy(true);
        try {
          const r = await api().memorySetAuto(next);
          if (r.ok) { setStatus((s) => ({ ...s, autoEnabled: r.enabled })); showMsg('ok', next ? '已开启自动记忆' : '已关闭自动记忆'); }
          else showMsg('error', r.error || '设置失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const removeEntity = async (name) => {
        if (!window.confirm('删除实体「' + name + '」及其全部观察和关系？')) return;
        setBusy(true);
        try {
          const r = await api().memoryDelete({ entities: [name] });
          if (r.ok) { refresh(); showMsg('ok', '已删除实体「' + name + '」'); }
          else showMsg('error', r.error || '删除失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const removeObservation = async (entityName, obs) => {
        setBusy(true);
        try {
          const r = await api().memoryDelete({ observations: [{ entityName, observations: [obs] }] });
          if (r.ok) { refresh(); }
          else showMsg('error', r.error || '删除失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const remember = () => {
        const text = String(note || '').trim();
        if (!text) { setMsg('请先填写要记住的内容'); return; }
        try {
          api().injectText('请把下面这段内容存入长期记忆（用 memory__create_entities / memory__add_observations，必要时建立关系；已有相关实体就追加观察，不要重复建实体）：\n' + text);
          setMsg(null);
          setNote('');
        } catch (err) { setMsg(String((err && err.message) || err)); }
      };

      const directAdd = async () => {
        const name = String(newName || '').trim();
        const obs = String(newObs || '').trim();
        if (!name) { showMsg('error', '请填写实体名称'); return; }
        setBusy(true);
        try {
          const r = await api().memoryAdd({
            entities: [{ name, entityType: newType || 'concept', observations: obs ? obs.split('\n').map((s) => s.trim()).filter(Boolean) : [] }],
          });
          if (r.ok) { refresh(); showMsg('ok', '已写入：+实体 ' + r.addedEntities + '，+观察 ' + r.addedObservations); setNewName(''); setNewObs(''); }
          else showMsg('error', r.error || '写入失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const entityCards = (graph && graph.entities && graph.entities.length)
        ? graph.entities.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')).map((e) => {
          const obsRows = (e.observations || []).length
            ? (e.observations || []).map((o, i) => h("div", { key: i, style: { display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "flex-start", padding: "3px 0" } },
              h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", minWidth: 0, overflowWrap: "anywhere", flex: 1 } }, o),
              btn("×", () => removeObservation(e.name, o), { small: true, danger: true, title: '删除这条观察' })))
            : [h("span", { key: "e", style: st.sub }, "（无观察）")];
          return h("div", { key: e.name, style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "10px 14px", display: "flex", flexDirection: "column", gap: "6px" } },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
              h("span", { style: { ...st.name, fontWeight: "500", minWidth: 0, overflowWrap: "anywhere" } }, e.name),
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flex: "none" } },
                h("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "999px", padding: "0 8px" } }, e.entityType || 'concept'),
                btn("删除", () => removeEntity(e.name), { small: true, danger: true }))),
            h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", paddingLeft: "4px" } }, obsRows));
        })
        : [h("p", { key: "empty", style: st.hint }, "图谱还是空的——模型在对话中会用 memory MCP 手动记录，或等自动记忆沉淀（每次对话完成后自动抽取）。")];

      const autoCard = h("div", { style: st.card },
        row("自动记忆", statusChip(status && status.autoEnabled, "已开启", "已关闭", toggleAuto, busy)),
        row("记忆文件", h("span", { style: st.value }, (status && status.path) || '—')),
        row("知识图谱", h("span", { style: st.value },
          status ? (status.entities || 0) + ' 个实体 · ' + (status.relations || 0) + ' 条关系' : '…')),
        row("最近抽取", h("span", { style: st.value },
          (status && status.lastSeen && status.lastSeen.lastUserTime)
            ? new Date(status.lastSeen.lastUserTime).toLocaleString() + '（' + String(status.lastSeen.sessionId || '').slice(0, 8) + '）'
            : '尚未抽取')),
        row("操作",
          h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
            btn("刷新", refresh, { small: true }),
            btn("打开文件", () => { try { api().memoryOpen(); } catch (err) {} }, { small: true }))));

      return h("div", { style: st.grid },
        h("div", { style: st.title }, "记忆与子代理"),
        h("div", { style: st.groupTitle }, "自动记忆（每轮对话完成后自动沉淀）"),
        autoCard,
        h("div", { style: st.groupTitle }, "知识图谱（" + ((graph && graph.entities) || []).length + " 个实体）"),
        h("div", { style: st.card }, entityCards),
        h("div", { style: st.groupTitle }, "手动添加"),
        h("div", { style: st.form },
          row("让模型整理后记住", h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end" } },
            btn("填入输入框", remember, { small: true }))),
          h("textarea", { className: "dsh-set-textarea", style: { ...st.textarea, minHeight: "64px" }, value: note, onChange: (e) => setNote(e.target.value), placeholder: "例如：这个项目用 pnpm 构建，测试命令是 pnpm test；入口在 src/index.ts" }),
          h("div", { style: { display: "flex", gap: "8px", alignItems: "flex-end" } },
            h("label", { style: { ...st.field, flex: 1 } },
              h("span", { style: st.fieldLabel }, "实体名称"),
              h("input", { className: "dsh-set-input", style: st.input, value: newName, onChange: (e) => setNewName(e.target.value), placeholder: "如 dsh-desktop" })),
            h("label", { style: { ...st.field, flex: "none", minWidth: "130px" } },
              h("span", { style: st.fieldLabel }, "类型"),
              h("select", { className: "dsh-set-select", style: st.select, value: newType, onChange: (e) => setNewType(e.target.value) },
                ["concept", "project", "tech", "decision", "pitfall", "preference"].map((t) => h("option", { key: t, value: t }, t))))),
          h("textarea", { className: "dsh-set-textarea", style: { ...st.textarea, minHeight: "56px" }, value: newObs, onChange: (e) => setNewObs(e.target.value), placeholder: "观察内容（每行一条，如：\n用 pnpm 构建\n测试命令 pnpm test" }),
          h("div", { style: st.actions },
            btn("直接写入图谱", directAdd, { small: true, primary: true, disabled: busy }))),
        h(SubagentsBlock),
        msg ? h("div", { style: msg.tone === "error" ? st.msgErr : st.msgOk }, msg.text) : null,
        h("p", { style: st.hint }, "自动记忆：每轮对话彻底完成后，用 deepseek-chat 抽取本会话中值得长期记住的内容（项目事实、决策、踩坑、偏好），" +
          "去重合并进图谱；开关随时可关。模型在对话中也会用 memory MCP 主动记录（特别是项目地图），两者互补。" +
          "记忆文件在 DSH_HOME/memory/memory.jsonl，随备份导出。"));
    }

    /* ================= 子代理卡组（并入"记忆与子代理"分区；并行任务进度总览） ================= */
    const fmtDuration = (ms) => {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + ' 秒';
      const m = Math.floor(s / 60);
      if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
      const h = Math.floor(m / 60);
      return h + ' 小时 ' + (m % 60) + ' 分';
    };
    const STATUS_META = {
      running: { color: SUCCESS, label: '运行中' },
      done: { color: 'var(--dsw-alias-label-tertiary)', label: '已完成' },
      stopped: { color: BUSINESS, label: '已停止（可能失败/被终止）' },
      empty: { color: MUTED, label: '无对话' },
    };
    /* ================= 子代理运行期提示（对话视为"未结束"） ================= */
    // 官方 harness 自带消息队列与 steering 引导：用户消息进入官方 FIFO，子代理完成后
    // 按序处理。桌面端无需拦截输入，只需把"子代理运行中"呈现为"会话进行中"的提示。
    const subagentBusyStore = {
      running: 0,       // 当前运行中的子代理数
      listeners: [],    // 状态订阅（组件重渲染）
    };
    const notifyBusy = () => { for (const fn of subagentBusyStore.listeners) { try { fn(); } catch { /* 忽略 */ } } };

    /** 输入框上方提示条：子代理运行中 → "会话进行中"，消息由官方队列自动按序处理。 */
    /* ================= 本地视觉识别卡片（环境信息侧边栏顶部；识别开始自动打开侧边栏） =================
     *  本地 CPU 视觉模型单次推理可达数分钟，期间对话无任何反馈会让用户误以为卡住。
     *  主进程把识别过程（开始/增量/完成/失败）经 dsh:vision-stream 推送；EnvPanel 订阅后
     *  自动展开，以紫色「本地视觉」徽标 + 脉冲圆点 + 计时 + 打字机式文本实时展示。 */
    function VisionStreamCard({ item }) {
      const [now, setNow] = react.useState(Date.now());
      react.useEffect(() => {
        if (item.phase === "done" || item.phase === "error") return undefined;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
      }, [item.phase]);
      const boxRef = react.useRef(null);
      react.useEffect(() => {
        if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
      }, [item.text]);
      const state = item.phase === "error" ? "error" : (item.phase === "done" ? "done" : "running");
      const cancelled = item.cancelled === true;
      const elapsed = (item.phase === "done" || item.phase === "error")
        ? (item.elapsedMs ? Math.round(item.elapsedMs / 1000) : 0)
        : Math.max(0, Math.round((now - (item.startedAt || now)) / 1000));
      const borderColor = state === "running" ? "#8b5cf6" : (state === "error" ? (cancelled ? BUSINESS : DANGER) : SUCCESS);
      // 视觉源标签：按模型名显示实际来源（本地 Ollama / 云端厂商），不再一律显示"本地视觉"
      const visionSourceLabel = (model) => {
        const m = String(model || '').toLowerCase();
        if (m.includes('qwen2.5vl') || m.includes('llava') || m.includes('moondream')) return '本地视觉';
        if (m.includes('mimo')) return '小米 MiMo';
        if (m.includes('deepseek') && m.includes('vision')) return 'DeepSeek Vision';
        if (m.includes('glm-4v')) return '智谱 GLM';
        if (m.includes('qwen-vl') || m.includes('qwen2-vl')) return '通义 Qwen-VL';
        if (m.includes('gpt-4o') || m.includes('gpt-4.1')) return 'OpenAI';
        return '视觉识别';
      };
      const sourceLabel = visionSourceLabel(item.model);
      return h("div", {
        style: {
          background: "var(--dsw-alias-bg-layer-1, #161b22)",
          border: "1px solid " + borderColor,
          borderRadius: "10px",
          padding: "8px 10px",
          fontSize: "12px",
          lineHeight: "17px",
          color: "var(--dsw-alias-label-primary)",
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: "5px", marginBottom: "3px" } },
          h("span", {
            style: {
              width: "7px", height: "7px", borderRadius: "50%", flex: "none", background: borderColor,
              ...(state === "running" ? { animation: "dshVisionPulse 1.2s ease-in-out infinite" } : {}),
            },
          }),
          h("span", {
            style: {
              fontSize: "10px", fontWeight: "700", letterSpacing: "0.04em", color: "#8b5cf6",
              border: "1px solid #8b5cf6", borderRadius: "4px", padding: "0 3px", lineHeight: "14px", flex: "none",
            },
          }, sourceLabel),
          h("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, item.model || "视觉模型"),
          // 识别中：提供「停止」按钮，点击取消本次视觉推理（主进程中断请求，云端/本地立即停止）
          state === "running"
            ? h("button", {
                type: "button",
                title: "停止本次视觉识别",
                onClick: () => { try { api().cancelVision(item.id); } catch (err) {} },
                style: {
                  cursor: "pointer", flex: "none", border: "1px solid var(--dsw-alias-border-l2)",
                  background: "transparent", color: "var(--dsw-alias-state-danger-primary, #f85149)",
                  borderRadius: "4px", padding: "0 6px", font: "inherit", fontSize: "10px", lineHeight: "16px",
                  display: "inline-flex", alignItems: "center", gap: "3px",
                },
              }, "■ 停止")
            : null,
          h("span", { style: { marginLeft: "auto", color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", fontVariantNumeric: "tabular-nums", flex: "none" } },
            state === "running" ? elapsed + "s" : (state === "done" ? "✓ " + elapsed + "s" : (cancelled ? "已停止" : "✗ " + elapsed + "s")))),
        state === "error"
          ? (cancelled
            ? h("div", { style: { color: BUSINESS } }, "已手动停止（视觉识别已取消）")
            : h("div", { style: { color: DANGER } }, "识别失败：" + (item.message || "未知错误")))
          : h("div", {
              ref: boxRef,
              style: {
                maxHeight: "120px", overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
                fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "11px",
                color: "var(--dsw-alias-label-secondary)",
              },
            }, item.text || (state === "running" ? ((item.model || "视觉模型") + " 识别中…") : "")),
      );
    }

    function SubagentQueueBar() {
      const [tick, setTick] = react.useState(0);
      react.useEffect(() => {
        let disposed = false;
        const listener = () => { if (!disposed) setTick((x) => x + 1); };
        subagentBusyStore.listeners.push(listener);
        return () => { disposed = true; subagentBusyStore.listeners = subagentBusyStore.listeners.filter((fn) => fn !== listener); };
      }, []);

      // 轮询子代理状态（5s；扫描已在主进程 worker/子进程化 + 30s 缓存，开销极小）
      react.useEffect(() => {
        if (typeof api !== 'function' || !api()) return undefined;
        let alive = true;
        const poll = async () => {
          try {
            const d = api();
            if (!d || !d.subagentsList) return;
            const r = await d.subagentsList();
            if (!alive || !r || !r.ok) return;
            const running = (r.summary && r.summary.running) || 0;
            if (running !== subagentBusyStore.running) {
              subagentBusyStore.running = running;
              notifyBusy();
            }
          } catch { /* 忽略：轮询失败不影响 */ }
        };
        poll();
        const t = setInterval(poll, 5000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      if (!subagentBusyStore.running) return null;
      const barStyle = {
        display: 'flex', alignItems: 'center', gap: '10px',
        maxWidth: '720px', borderRadius: '10px', padding: '8px 14px',
        background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)',
        fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
        margin: '0 auto 8px',
      };
      return h('div', { style: barStyle, 'data-dsh-desktop-queue': 'true' },
        h('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } },
          '🔧 ' + subagentBusyStore.running + ' 个子代理运行中 —— 会话视为进行中，您的消息将进入对话队列，子代理完成后按序处理。'
          + '（点官方「停止」会同时终止全部子代理）'));
    }

    function SubagentsBlock() {
      const [data, setData] = react.useState(null);
      const [msg, setMsg] = react.useState(null);

      const refresh = react.useCallback(() => {
        const d = api();
        if (!d || !d.subagentsList) return;
        d.subagentsList().then((r) => { if (r && r.ok) setData(r); }).catch(() => {});
      }, []);

      react.useEffect(() => { refresh(); const t = setInterval(refresh, 10000); return () => clearInterval(t); }, [refresh]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const summary = (data && data.summary) || null;
      const items = (data && data.items) || [];

      const itemCards = items.length
        ? items.map((it) => {
          const meta = STATUS_META[it.status] || STATUS_META.empty;
          const parent = it.parentTitle ? it.parentTitle : (it.parentSession ? String(it.parentSession).slice(0, 8) + '…' : '—');
          const tokens = (it.usage ? it.usage.inputTokens + it.usage.outputTokens + it.usage.cacheReadTokens : 0);
          return h("div", { key: it.sessionId, style: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px", padding: "10px 14px", display: "flex", flexDirection: "column", gap: "6px" } },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
              h("span", { style: { ...st.name, fontWeight: "500", minWidth: 0, overflowWrap: "anywhere" } }, it.label || it.sessionId),
              h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flex: "none" } },
                dotText(meta.color, meta.label),
                h("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "999px", padding: "0 8px" } }, it.agentModel || '?'),
                h("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l1)", borderRadius: "999px", padding: "0 8px" } }, it.mode === 'continuable' ? '可继续' : '一次性'))),
            h("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px 16px", paddingLeft: "2px" } },
              h("span", { style: st.sub }, "父会话：" + parent),
              h("span", { style: st.sub }, "耗时：" + fmtDuration(it.durationMs)),
              h("span", { style: st.sub }, "tokens：" + fmtNum(tokens)),
              it.lastTime ? h("span", { style: st.sub }, "最后活动：" + new Date(it.lastTime).toLocaleString()) : null));
        })
        : [h("p", { key: "empty", style: st.hint }, "还没有子代理活动——大任务派发子代理并行后，这里会实时显示每个子代理的进度。")];

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
        h("div", { style: st.groupTitle }, "子代理（进度总览）"),
        h("div", { style: st.card },
          row("运行中", h("span", { style: { ...st.value, color: SUCCESS } }, summary ? String(summary.running) : '…')),
          row("已完成", h("span", { style: st.value }, summary ? String(summary.done) : '…')),
          row("疑似停止", h("span", { style: { ...st.value, color: BUSINESS } }, summary ? String(summary.stopped) : '…')),
          row("累计 tokens", h("span", { style: st.value }, summary ? fmtNum(summary.totalTokens) : '…'))),
        h("div", { style: st.groupTitle }, "子代理列表（" + items.length + "）"),
        h("div", { style: st.card }, itemCards),
        msg ? h("div", { style: st.msgErr }, msg.text) : null,
        h("p", { style: st.hint }, "子代理不进入主对话列表（官方已省略侧边栏）——在父会话页头点击谱系导航可查看每个子代理的只读对话记录。" +
          "状态判定：运行中=正在工作；已完成=有最终答复；已停止=长时间无写入（可能失败或被终止）。"));
    }

    /* ================= 环境信息 / 调度面板（右侧常驻双面板：无开关按钮，始终展示） ================= */
    // 面板不再可收起：环境信息（上）+ 模型调度（下）固定占右侧 260px 列，主界面让位。
    // 原 envStore/schedStore/toggle 逻辑已删除（用户要求固定展示、取消按钮）。

    /* ---- 本地视觉识别流 store（EnvPanel 顶部卡片；识别开始自动打开侧边栏） ---- */
    const visionStreamStore = {
      items: [], // { id, model, startedAt, phase: running|done|error, text, message, elapsedMs }
      listeners: [],
      timers: {},
    };
    function visionStreamMutate(fn) {
      fn(visionStreamStore);
      const ls = visionStreamStore.listeners.slice();
      for (const l of ls) { try { l(); } catch (err) {} }
    }
    function useVisionStream() {
      const [, force] = react.useReducer((x) => x + 1, 0);
      react.useEffect(() => {
        const on = () => force();
        visionStreamStore.listeners.push(on);
        return () => {
          const i = visionStreamStore.listeners.indexOf(on);
          if (i >= 0) visionStreamStore.listeners.splice(i, 1);
        };
      }, []);
      return visionStreamStore.items;
    }

    /** 解析 dsh:git-summary 输出（# git status / ## 分支...上游 [ahead N, behind M] / 变更行）。非 Git 仓库返回 null。
     *  分支展示：只取 ... 前的本地分支名（main...origin/main → main）。
     *  ⚠️ 小节头判定必须是「# + 空格」（# git diff --stat 等）——分支行「## main...」也以 # 开头，
     *  若用 startsWith('#') 会把分支行当成小节头提前 break，导致永远解析失败（历史 bug）。 */
    function parseGitSummary(output) {
      const lines = String(output || '').split('\n');
      const start = lines.findIndex((l) => l.trim() === '# git status');
      const status = start >= 0 ? lines.slice(start + 1) : lines;
      const block = [];
      for (const l of status) { if (/^#\s/.test(l)) break; block.push(l); }
      const branchLine = block.find((l) => l.startsWith('## '));
      if (!branchLine) return null;
      const raw = branchLine.slice(3);
      const localBranch = raw.split('...')[0].split(/\s/)[0].trim() || raw;
      const m = raw.match(/\[ahead (\d+)(?:, behind (\d+))?\]/) || raw.match(/\[behind (\d+)\]/);
      const ahead = m && m[1] ? Number(m[1]) : 0;
      const behind = m && m[2] ? Number(m[2]) : 0;
      const changed = block.filter((l) => l.trim() && !l.startsWith('## ')).length;
      return { branch: localBranch, ahead, behind, changed };
    }

    /** 接续按钮已并入状态胶囊行（MCP 胶囊右侧）。 */
    function ContinueButton() {
      return h('button', {
        type: 'button',
        title: '新对话接续当前任务：先写 .dsh/handoff.md 交接文件，再开新对话无缝续做（上下文重置，无损）',
        'aria-label': '接续',
        onClick: () => { try { api().continueConversation(); } catch (err) {} },
        style: {
          cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1)',
          background: 'transparent', color: 'var(--dsw-alias-label-primary)', borderRadius: '8px',
          padding: '5px 12px', font: 'inherit', fontSize: '13px', lineHeight: '20px',
          display: 'inline-flex', alignItems: 'center', gap: '6px',
        },
      }, '\u27f3', h('span', { key: 't' }, '接续'));
    }

    // 环境信息右列（常驻窄列：压缩对话区一小部分宽度，不遮挡交互）
    /** 右侧常驻双面板的单个面板内容样式（外层 RightDock 负责 fixed 定位与分栏）。 */
    const panelBody = {
      flex: 1, minHeight: 0, overflowY: 'auto', boxSizing: 'border-box',
      padding: '12px 14px 18px',
      display: 'flex', flexDirection: 'column', gap: '10px',
      font: '12px/1.6 system-ui',
    };
    const envColumn = {
      ...panelBody,
      position: 'fixed', right: 0, top: 0, bottom: 0, width: '260px',
      background: 'var(--dsw-alias-bg-layer-1)',
      borderLeft: '1px solid var(--dsw-alias-border-l2)',
      zIndex: 2147483640,
    };
    const envGroupTitle = {
      color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', fontWeight: '600',
      lineHeight: '14px', letterSpacing: '0.08em', textTransform: 'uppercase',
      padding: '8px 2px 0', borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: '2px',
    };
    const envRow = (label, value, key) => h('div', { key, style: { display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', padding: '2px 2px', minWidth: 0 } },
      h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', flex: 'none' } }, label),
      h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '12px', textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' } }, value));

    /* ---- 会话活动足迹（本会话：工具调用 / 网页来源 / 本地文件来源） ---- */
    const TOOL_LABELS = {
      read: '读文件', edit: '修改文件', write: '写文件', grep: '代码搜索', glob: '查找文件',
      web_search: '网页搜索', skill: '加载技能', todo_write: '任务清单', pwsh: '执行命令',
      subagent: '子代理', subagent_fork: '子代理', job_output: '后台任务', job_kill: '停止任务',
      create_goal: '创建目标', get_goal: '读取目标', update_goal: '更新目标',
    };
    const MCP_TOOL_LABELS = {
      dsh_desktop_computer_screenshot: '屏幕截图', dsh_desktop_describe_image: '本地图片识别',
      dsh_desktop_get_state: '桌面状态', dsh_desktop_restart_app: '重启桌面', dsh_desktop_api_balance: 'API 余额',
      dsh_desktop_api_usage: '用量统计', dsh_desktop_schedule: '定时任务', dsh_desktop_computer_mouse: '鼠标操控',
      dsh_desktop_computer_keyboard: '键盘输入', dsh_desktop_computer_window: '窗口操作', dsh_desktop_computer_clipboard: '剪贴板',
      dsh_desktop_computer_launch: '启动应用', dsh_desktop_open_folder: '打开目录', dsh_desktop_open_logs: '打开日志',
      dsh_desktop_open_terminal: '终端模式', dsh_desktop_apply_update: '应用更新', dsh_desktop_check_updates: '检查更新',
      dsh_desktop_system_doctor: '系统体检', dsh_desktop_switch_workspace: '切换工作区',
    };
    const toolLabel = (name) => {
      if (TOOL_LABELS[name]) return TOOL_LABELS[name];
      if (name && name.indexOf('mcp__') === 0) {
        const raw = name.slice(5);
        return MCP_TOOL_LABELS[raw] || raw.split('__').pop().replace(/_/g, ' ');
      }
      if (name && name.indexOf('mcp__memory') === 0) return '记忆图谱';
      if (name && name.indexOf('mcp__sequential') === 0) return '分步推理';
      return name || '工具';
    };
    const fmtAgo = (t) => {
      const s = Math.max(0, Math.round((Date.now() - t) / 1000));
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      return Math.floor(s / 3600) + 'h';
    };

    function EnvPanel(props) {
      // 常驻面板（不再可收起）：session scope 官方渲染器把当前会话 id 作为 props.sessionId（字符串）传入
      const currentSessionId = (props && props.sessionId) || null;
      const [state, setState] = react.useState(null);
      const [git, setGit] = react.useState(null);
      const [usage, setUsage] = react.useState(null);
      const [act, setAct] = react.useState(null);
      const [map, setMap] = react.useState(null);      // 项目代码地图状态
      const [claims, setClaims] = react.useState(null); // 多会话编辑占用
      const [github, setGithub] = react.useState(null); // GitHub 集成状态
      const visionItems = useVisionStream();

      // 订阅本地视觉识别流：识别开始自动展开侧边栏（调用本地视觉模型即打开），
      // 完成/失败后延时移除卡片。与 open 无关——侧边栏收起时也接收，收到 start 即打开。
      react.useEffect(() => {
        const d = window.dshDesktop;
        if (!d || !d.onVisionStream) return undefined;
        const off = d.onVisionStream((ev) => {
          if (!ev || !ev.id) return;
          if (ev.phase === 'start') {
            visionStreamMutate((st) => {
              st.items = [...st.items.filter((x) => x.id !== ev.id),
                { id: ev.id, model: ev.model, startedAt: ev.startedAt, phase: 'running', text: '' }];
            });
            return;
          }
          visionStreamMutate((st) => {
            const old = st.items.find((x) => x.id === ev.id);
            if (!old) return;
            if (ev.phase === 'delta') old.text += (ev.text || '');
            // 流式重试：主进程重发前清空已展示的增量文本，避免重试内容重复拼接
            else if (ev.phase === 'reset') old.text = '';
            else if (ev.phase === 'done' || ev.phase === 'error') {
              old.phase = ev.phase;
              old.elapsedMs = ev.elapsedMs;
              old.message = ev.message || '';
              old.cancelled = ev.cancelled === true;
            }
          });
          if (ev.phase === 'done' || ev.phase === 'error') {
            const delay = ev.phase === 'error' ? 12000 : 8000;
            visionStreamStore.timers[ev.id] = setTimeout(() => {
              visionStreamMutate((st) => { st.items = st.items.filter((x) => x.id !== ev.id); });
              delete visionStreamStore.timers[ev.id];
            }, delay);
          }
        });
        return () => {
          off();
          Object.keys(visionStreamStore.timers).forEach((k) => clearTimeout(visionStreamStore.timers[k]));
        };
      }, []);

      // 布局让位：右侧双面板常驻，body 加右侧 padding（应用整体左移，对话完整可见）。
      // 由外层 RightDock 统一设置（这里不再处理）。

      react.useEffect(() => {
        let disposed = false;
        const d = api();
        let off = null;
        let offPush = null;
        let pushTimer = null;
        let lastPushAt = 0;
        if (d) {
          try { off = d.onState((s) => { if (!disposed) setState(s); }); } catch (err) { /* 忽略 */ }
          d.getState().then((s) => { if (!disposed) setState(s); }).catch(() => {});
          // 主进程事件推送（编辑占用/项目地图/Git 等变化）→ 面板即时刷新（1.5s 节流防抖）
          if (typeof d.onPanelRefresh === 'function') {
            offPush = d.onPanelRefresh(() => {
              if (disposed) return;
              const now = Date.now();
              const wait = Math.max(0, 1500 - (now - lastPushAt));
              if (pushTimer) clearTimeout(pushTimer);
              pushTimer = setTimeout(() => { lastPushAt = Date.now(); if (!disposed) refresh(true); }, wait);
            });
          }
        }
        let usageTick = 0;
        // cheapOnly：只刷 Git/项目地图/编辑占用（推送路径；跳过重的 usage/activity 扫描）
        const refresh = (cheapOnly) => {
          if (!d) return;
          usageTick++;
          if (d.gitSummary) d.gitSummary().then((r) => {
            if (disposed) return;
            setGit(r);
            // 诊断回报（只在签名变化时记录，避免 5s 轮询刷爆日志）
            if (typeof d.clientDebug === 'function') {
              try {
                const sig = [!!(r && r.ok), !!(r && r.notGit), (r && r.error) || '', (r && r.output) ? String(r.output).split('\n').filter((l) => l.trim()).slice(0, 4).join(' | ').slice(0, 200) : '(空输出)'].join('||');
                if (sig !== envGitSig) {
                  envGitSig = sig;
                  d.clientDebug({
                    src: 'env-git',
                    ok: !!(r && r.ok),
                    notGit: !!(r && r.notGit),
                    error: (r && r.error) || null,
                    head: (r && r.output) ? String(r.output).split('\n').filter((l) => l.trim()).slice(0, 4).join(' | ').slice(0, 300) : '(空输出)',
                  }).catch(() => {});
                }
              } catch { /* 诊断失败不影响面板 */ }
            }
          }).catch((err) => {
            if (!disposed) setGit({ ok: false, error: '客户端异常：' + ((err && err.message) || err) });
          });
          // 项目代码地图 + 编辑占用（轻量查询，与 git 同频高频刷新 + 事件推送）
          if (d.projectMapStatus) d.projectMapStatus().then((r) => { if (!disposed && r && r.ok) setMap(r); }).catch(() => {});
          if (d.editStatus) d.editStatus().then((r) => { if (!disposed && r && r.ok) setClaims(r); }).catch(() => {});
          if (cheapOnly) return;
          // usage 扫描较重（子进程化但仍消耗 IO）：每 12 轮（60s）一次，避免频繁唤醒
          if (usageTick % 12 === 0 && d.getUsage) d.getUsage().then((r) => { if (!disposed && r && r.ok) setUsage(r.summary || r); }).catch(() => {});
          // activity 扫描需解压会话文件：每 4 轮（20s）一次
          if (usageTick % 4 === 0 && d.activityGet) d.activityGet().then((r) => { if (!disposed && r && r.ok) setAct(r); }).catch(() => {});
          // GitHub 状态（含一次 /user API 调用）：20s 降频
          if (usageTick % 4 === 0 && d.githubStatus) d.githubStatus().then((r) => { if (!disposed && r && r.ok) setGithub(r); }).catch(() => {});
        };
        // 会话切换时立即全量刷新，之后每 5 秒刷新（Git/地图/占用轻量高频；usage/activity 降频）
        refresh(false);
        const timer = setInterval(() => refresh(false), 5000);
        return () => {
          disposed = true;
          if (off) { try { off(); } catch (ignored) {} }
          if (offPush) { try { offPush(); } catch (ignored) {} }
          if (pushTimer) clearTimeout(pushTimer);
          clearInterval(timer);
        };
      }, [currentSessionId]);

      if (!api()) {
        return h('div', { style: envColumn }, h('p', { style: st.hint }, '此面板仅可在 DSH 桌面端中使用。'));
      }

      const gitInfo = (git && git.ok && git.output) ? parseGitSummary(git.output) : null;
      // 只显示当前会话的信息：用量取当前会话的 usage
      const sessionSessions = ((usage && usage.sessions) || []).filter((s) => s.sessionId === currentSessionId);
      const sessionUsage = sessionSessions.length ? sessionSessions[0] : null;
      const sessionTitle = (sessionUsage && sessionUsage.title) || null;
      const sessionTokens = sessionUsage && sessionUsage.usage
        ? ((sessionUsage.usage.inputTokens || 0) + (sessionUsage.usage.cacheReadTokens || 0) + (sessionUsage.usage.outputTokens || 0))
        : null;
      const tierNow = tierOf(Date.now());

      // 本会话活动（平铺预构建，避免深层嵌套）：技能/MCP 调用、本轮来源、本轮产出
      const actRow = { display: 'flex', gap: '6px', alignItems: 'baseline' };
      const actIcon = { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', flex: 'none' };
      const actText = { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
      const actSub = { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px' };
      const actGroup = { display: 'flex', flexDirection: 'column', gap: '2px' };
      const actGroupBordered = { display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: '2px', borderTop: '1px solid var(--dsw-alias-border-l2)' };
      const actRows = [];
      if (act && act.ok !== false) {
        const smRows = [];
        for (const s of (act.skills || [])) {
          smRows.push(h('div', { key: 's' + s, style: actRow }, h('span', { style: actIcon }, '\u2699'), h('span', { style: actText }, 'skill · ' + s)));
        }
        for (const m of (act.mcpCalls || [])) {
          smRows.push(h('div', { key: 'm' + m, style: actRow }, h('span', { style: actIcon }, '\u25c9'), h('span', { style: actText }, toolLabel(m))));
        }
        if (smRows.length) actRows.push(h('div', { key: 'sm', style: actGroup }, h('span', { style: actSub }, '技能 / MCP 调用'), smRows));
        const srcRows = [];
        for (const p of (act.turnFiles || [])) {
          srcRows.push(h('div', { key: 'tf' + p, title: String(p), style: actRow }, h('span', { style: actIcon }, '\u{1f4c4}'), h('span', { style: actText }, String(p).split(/[\\/]/).pop())));
        }
        for (const u of (act.turnUrls || [])) {
          let label = u;
          try { const x = new URL(u); label = x.hostname + x.pathname.slice(0, 40); } catch { /* 保留原样 */ }
          srcRows.push(h('div', { key: 'tu' + u, style: actRow }, h('span', { style: actIcon }, '\u{1f517}'), h('span', { style: actText }, label)));
        }
        if (srcRows.length) actRows.push(h('div', { key: 'src', style: actGroupBordered }, h('span', { style: actSub }, '本轮来源'), srcRows));
        const outRows = [];
        for (const p of (act.turnOutputs || [])) {
          outRows.push(h('div', { key: 'to' + p, title: String(p), style: actRow }, h('span', { style: actIcon }, '\u270d'), h('span', { style: actText }, String(p).split(/[\\/]/).pop())));
        }
        if (outRows.length) actRows.push(h('div', { key: 'out', style: actGroupBordered }, h('span', { style: actSub }, '本轮产出'), outRows));
      }

      return h('div', { style: panelBody, 'data-dsh-desktop-env-panel': 'true' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0 0' } },
          h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: '600', lineHeight: '20px' } }, '环境信息')),

        // 本地视觉识别卡片（顶部）：识别中紫色脉冲 + 计时 + 流式文本；完成绿 ✓ / 失败红 ✗
        visionItems.length
          ? h('div', { key: 'vision', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            visionItems.map((it) => h(VisionStreamCard, { key: it.id, item: it })))
          : null,

        h('div', { style: envGroupTitle }, '本会话活动'),
        act === null
          ? h('p', { key: 'aload', style: { ...st.hint, padding: '2px' } }, '读取中…')
          : h('div', { key: 'a', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, actRows),

        h('div', { style: envGroupTitle }, '环境'),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          envRow('工作区', (state && state.workspace) || '—', 'ws'),
          envRow('harness', (state && state.installed) ? 'v' + state.installed : '—', 'ver'),
          envRow('端口', (state && state.port) || (state && state.url ? String(state.url).split(':').pop() : '—'), 'port')),

        h('div', { style: envGroupTitle }, 'Git'),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          git === null
            ? h('p', { key: 'g0', style: { ...st.hint, padding: '2px' } }, '读取中…')
            : !git.ok
              ? h('p', { key: 'g0', style: { ...st.hint, padding: '2px' } },
                /尚未选择工作区/.test(String(git.error || '')) ? '非 Git 工作区' : ('Git 读取失败：' + (git.error || '未知错误')))
              : gitInfo === null
                ? h('p', { key: 'g0', style: { ...st.hint, padding: '2px' } },
                  'Git 解析失败：' + String(git.output || '').split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ').slice(0, 120))
                : h('div', { key: 'g', style: { display: 'flex', flexDirection: 'column' } },
                  envRow('分支', gitInfo.branch, 'br'),
                  envRow('领先/落后', gitInfo.ahead + ' / ' + gitInfo.behind, 'ab'),
                  envRow('未提交变更', gitInfo.changed + ' 个文件', 'ch'))),

        h('div', { style: envGroupTitle }, '项目地图'),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          map === null
            ? h('p', { key: 'm0', style: { ...st.hint, padding: '2px' } }, '读取中…')
            : h('div', { key: 'm', style: { display: 'flex', flexDirection: 'column' } },
              envRow('地图', !map.exists ? '未建立' : (map.staleCount > 0 ? '需更新' : '已就绪'), 'pm'),
              map.exists ? envRow('待更新文件', map.staleCount + ' 个（共跟踪 ' + map.tracked + '）', 'pms') : null)),

        h('div', { style: envGroupTitle }, '编辑占用'),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          claims === null
            ? h('p', { key: 'c0', style: { ...st.hint, padding: '2px' } }, '读取中…')
            : h('div', { key: 'c', style: { display: 'flex', flexDirection: 'column' } },
              envRow('其他对话占用', claims.others && claims.others.length
                ? claims.others.length + ' 个文件'
                : '无', 'ec'),
              claims.others && claims.others.length
                ? h('p', { key: 'c1', style: { ...st.hint, padding: '2px 0 0', color: 'var(--dsw-alias-state-business-primary, #d29922)' } },
                  '⚠ ' + claims.others.map((c) => c.file.split(/[\\/]/).pop()).join('、') + ' 正在被其他对话修改')
                : null)),

        h('div', { style: envGroupTitle }, 'GitHub'),
        h('div', { style: { display: 'flex', flexDirection: 'column' } },
          github === null
            ? h('p', { key: 'gh0', style: { ...st.hint, padding: '2px' } }, '读取中…')
            : h('div', { key: 'gh', style: { display: 'flex', flexDirection: 'column' } },
              envRow('账号', github.authed ? github.login : '未登录', 'gha'),
              envRow('远程', github.remote ? String(github.remote).split('\n')[0].split('\t')[0].trim() : '未关联', 'ghr'),
              envRow('可见性', github.visibility === 'public' ? '公开' : (github.visibility === 'private' ? '私有' : '—'), 'ghv'))));
    }

    /* ================= 模型调度面板（右侧常驻双面板下半区；厂商总览 + 子代理实时输出） ================= */

    function SchedPanel(props) {
      // 只显示当前对话派发的子代理（parentSession === 当前会话 id），切换对话立即切换视图；
      // 不再显示其他对话（历史会话）开启的子代理，避免串台。
      const currentSessionId = (props && props.sessionId) || null;
      const [providers, setProviders] = react.useState(null); // providersList 结果
      const [tests, setTests] = react.useState({}); // id -> providersTest 结果
      const [bals, setBals] = react.useState({});   // id -> providersBalance 结果
      const [subs, setSubs] = react.useState(null); // subagentStreamList 结果
      const [expanded, setExpanded] = react.useState({}); // sessionId -> 展开推理/输出
      const [manualTick, setManualTick] = react.useState(0); // 手动刷新

      const testOne = (id) => {
        const d = api();
        if (!d || typeof d.providersTest !== 'function') return;
        setTests((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), busy: true } }));
        d.providersTest(id).then((r) => { if (r) setTests((prev) => ({ ...prev, [id]: { ...r, busy: false } })); })
          .catch(() => { setTests((prev) => ({ ...prev, [id]: { busy: false, error: '测试失败' } })); });
      };

      // 厂商总览（30s 轮询：列表 + 余额 + 测通）与子代理输出（2s 轮询）
      react.useEffect(() => {
        let disposed = false;
        const d = api();
        const loadProviders = async () => {
          if (!d || typeof d.providersList !== 'function') return;
          try {
            const r = await d.providersList();
            if (disposed || !r || !r.ok) return;
            const list = (r.providers || []).filter((p) => p.enabled !== false);
            setProviders(r.providers || []);
            if (typeof d.providersBalance === 'function') {
              for (const p of list) {
                d.providersBalance(p.id).then((br) => { if (!disposed && br) setBals((prev) => ({ ...prev, [p.id]: br })); }).catch(() => {});
              }
            }
            if (typeof d.providersTest === 'function') for (const p of list) testOne(p.id);
          } catch { /* 忽略 */ }
        };
        const loadSubs = async () => {
          if (!d || typeof d.subagentStreamList !== 'function') return;
          try {
            const r = await d.subagentStreamList();
            if (!disposed && r && r.ok) {
              // 变更检测：仅当子代理数量或任一 updatedAt 变化时才 setState，避免每轮全量重渲染卡片
              const next = r.items || [];
              setSubs((prev) => {
                if (Array.isArray(prev) && prev.length === next.length) {
                  let same = true;
                  for (let i = 0; i < next.length; i++) {
                    const a = prev[i], b = next[i];
                    if (!a || !b || a.sessionId !== b.sessionId || a.status !== b.status || a.updatedAt !== b.updatedAt || a.lastText !== b.lastText) { same = false; break; }
                  }
                  if (same) return prev;
                }
                return next;
              });
            }
          } catch { /* 忽略 */ }
        };
        // 启动错峰：页面就绪后延迟 2s 再开始子代理流轮询（避开启动期 IPC/解压峰值），3s 一轮
        const firstSubs = setTimeout(() => { if (!disposed) loadSubs(); }, 2000);
        loadProviders();
        const t1 = setInterval(loadProviders, 30000);
        const t2 = setInterval(loadSubs, 3000);
        // 主进程事件推送（Git/占用/地图等）→ 子代理列表立即刷新（1s 节流；厂商总览仍走 30s 轮询避免打厂商 API）
        let offPush = null;
        let pushTimer = null;
        let lastPushAt = 0;
        if (typeof d.onPanelRefresh === 'function') {
          offPush = d.onPanelRefresh(() => {
            if (disposed) return;
            const now = Date.now();
            const wait = Math.max(0, 1000 - (now - lastPushAt));
            if (pushTimer) clearTimeout(pushTimer);
            pushTimer = setTimeout(() => { lastPushAt = Date.now(); if (!disposed) loadSubs(); }, wait);
          });
        }
        return () => {
          disposed = true;
          clearTimeout(firstSubs); clearInterval(t1); clearInterval(t2);
          if (pushTimer) clearTimeout(pushTimer);
          if (offPush) { try { offPush(); } catch (ignored) {} }
        };
      }, [manualTick, currentSessionId]);

      if (!api()) {
        return h('div', { style: panelBody }, h('p', { style: st.hint }, '此面板仅可在 DSH 桌面端中使用。'));
      }

      const toggleExp = (sid) => setExpanded((prev) => ({ ...prev, [sid]: !prev[sid] }));

      // a. 厂商总览：dot 状态（测通结果）+ 名称 + 余额 + 模型数；点击行测通
      const provRows = (() => {
        if (!providers) return [h('p', { key: 'load', style: { ...st.hint, padding: '2px' } }, '读取中…')];
        const list = providers.filter((p) => p.enabled !== false && !p.effort);
        if (!list.length) return [h('p', { key: 'none', style: { ...st.hint, padding: '2px' } }, '未启用任何厂商（设置页「模型调度」分区接入）')];
        return list.map((p) => {
          const t = tests[p.id];
          const b = bals[p.id];
          const tone = t ? (t.busy ? BUSINESS : (t.available === true ? SUCCESS : DANGER)) : MUTED;
          const avail = t
            ? (t.busy ? '测试中…' : (t.available === true ? (t.latencyMs != null ? t.latencyMs + 'ms' : '可用') : (t.error ? '不可用' : '—')))
            : '未测试';
          const bal = b ? (b.error ? '?' : (b.supported !== true ? '✓' : fmtProviderBalance(b.balance))) : '…';
          return h('div', {
            key: p.id,
            title: '点击测通：' + (p.name || p.provider),
            onClick: () => testOne(p.id),
            style: {
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', padding: '6px 8px',
              display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', minWidth: 0,
            },
          },
            dot(tone, 't' + p.id),
            h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '11px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.name || p.provider),
            h('span', { style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', flex: 'none' } },
              bal + ' · ' + ((p.models && p.models.length) || 0) + ' 模型 · ' + avail));
        });
      })();

      // 厂商标识：按模型名映射厂商（deepseek→DeepSeek、mimo→小米 MiMo 等），并在 provider 名
      // 含 -fast/-deep 时标注思考强度——子代理卡片上直接可见"哪个厂商、什么强度"在跑。
      const vendorOfModel = (model) => {
        const m = String(model || '').toLowerCase();
        if (m.includes('mimo')) return '小米 MiMo';
        if (m.includes('deepseek')) return 'DeepSeek';
        if (m.includes('glm') || m.includes('zhipu')) return '智谱 GLM';
        if (m.includes('qwen') || m.includes('dashscope')) return '通义 Qwen';
        if (m.includes('gpt-')) return 'OpenAI';
        if (m.includes('gemini')) return 'Google';
        if (m.includes('kimi') || m.includes('moonshot')) return 'Moonshot';
        return null;
      };
      const providerEffort = (provider) => {
        const p = String(provider || '');
        if (p.endsWith('-fast')) return ' · fast';
        if (p.endsWith('-deep')) return ' · deep';
        return '';
      };
      // b. 子代理运行区：运行中卡片（可展开推理/输出）；done/stopped 灰色折叠行
      const subCards = (() => {
        // setSubs(r.items) 存的是数组；兼容数组与 { items } 两种形态
        const allItems = Array.isArray(subs) ? subs : ((subs && subs.items) || []);
        // 按当前对话过滤：只有 parentSession 等于当前会话 id 的子代理才属于本对话
        const items = currentSessionId
          ? allItems.filter((it) => it && it.parentSession === currentSessionId)
          : allItems;
        if (!items.length) return [h('p', { key: 'empty', style: { ...st.hint, padding: '2px' } },
          currentSessionId ? '本对话暂无子代理活动（运行中的子代理会实时显示在这里）。' : '暂无子代理活动（运行中的子代理会实时显示在这里）。')];
        return items.map((it) => {
          const meta = STATUS_META[it.status] || STATUS_META.empty;
          const running = it.status === 'running';
          const exp = !!expanded[it.sessionId];
          const last = String(it.lastText || '');
          const reasoning = String(it.reasoningText || '');
          const snippet = last.length > 500 ? last.slice(-500) : last; // 默认显示最近 500 字
          // 厂商标识：厂商名 + 模型 + 思考强度（provider 名带 -fast/-deep 时标注）
          const vendor = vendorOfModel(it.model) || '?';
          const badge = vendor + (it.model && vendor !== it.model ? ' · ' + it.model : '') + providerEffort(it.provider);
          const header = h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 } },
            dot(meta.color, 'd'),
            h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '11px', fontWeight: '600', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, it.label || it.sessionId),
            h('span', { style: { fontSize: '10px', lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '999px', padding: '0 6px', flex: 'none', whiteSpace: 'nowrap' } }, badge),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', flex: 'none' } }, meta.label),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', flex: 'none' } }, fmtAgo(it.updatedAt)));
          const body = running
            ? h('div', { key: 'b', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('div', {
                style: {
                  maxHeight: '200px', overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace", fontSize: '10px', lineHeight: '15px',
                  color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
                  borderRadius: '6px', padding: '5px 7px',
                },
              }, exp ? (reasoning ? reasoning + '\n\n' + last : last) : (snippet || '（等待输出…')),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                btn(exp ? '收起' : '展开' + (last.length > 500 ? '（全量 ' + last.length + ' 字）' : ''), () => toggleExp(it.sessionId), { small: true }),
                it.updatedAt ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px' } }, '更新 ' + new Date(it.updatedAt).toLocaleTimeString()) : null))
            : h('div', { key: 'b', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, snippet || '（无输出）');
          return h('div', { key: it.sessionId, style: { border: '1px solid ' + (running ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'), borderRadius: '10px', padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: '5px', opacity: running ? 1 : 0.65 } }, [header, body]);
        });
      })();

      return h('div', { style: panelBody, 'data-dsh-desktop-sched-panel': 'true' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0 0' } },
          h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px', fontWeight: '600', lineHeight: '20px' } }, '模型调度')),

        h('div', { style: { ...envGroupTitle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' } },
          h('span', {}, '厂商总览'),
          btn('刷新', () => setManualTick((t) => t + 1), { small: true })),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, provRows),

        h('div', { style: envGroupTitle }, '子代理运行'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, subCards));
    }

    /* ================= GitHub 与 Git（登录 / 远程 / 分支） ================= */
    function GithubSection() {
      const [status, setStatus] = react.useState(null);
      const [flow, setFlow] = react.useState(null); // 设备码登录进行中：{ verificationUri, userCode }
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const pollTimer = react.useRef(null);

      react.useEffect(() => {
        refresh();
        return () => { if (pollTimer.current) clearInterval(pollTimer.current); };
      }, []);

      const showMsg = (tone, text) => setMsg({ tone, text });
      const refresh = () => {
        const d = api();
        if (!d || !d.githubStatus) return;
        d.githubStatus().then((r) => { if (r && r.ok) setStatus(r); }).catch(() => {});
      };

      const startLogin = async () => {
        setBusy(true); showMsg(null);
        try {
          const r = await api().githubLoginStart();
          if (!r.ok) { showMsg('error', r.error || '发起失败'); return; }
          setFlow(r);
          showMsg('busy', '已生成登录码：打开 ' + r.verificationUri + ' 输入 ' + r.userCode + ' 并授权（scope: repo）。');
          pollTimer.current = setInterval(async () => {
            try {
              const p = await api().githubLoginPoll();
              if (!p.ok) { clearInterval(pollTimer.current); setFlow(null); showMsg('error', p.error || '登录失败'); refresh(); }
              else if (p.pending === false) { clearInterval(pollTimer.current); setFlow(null); showMsg('ok', '登录成功：' + p.login); refresh(); }
            } catch (err) {
              clearInterval(pollTimer.current); setFlow(null);
              showMsg('error', String((err && err.message) || err));
            }
          }, 4000);
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const remoteSetup = async () => {
        if (!window.confirm('将在 GitHub 创建私有仓库（默认用工作区目录名）并推送当前分支，继续？')) return;
        setBusy(true); showMsg(null);
        try {
          const r = await api().githubRemoteSetup({});
          if (!r.ok) { showMsg('error', r.error || '关联失败'); return; }
          showMsg('ok', r.repo ? ('已创建 ' + r.repo.fullName + ' 并推送') : '已推送到 origin');
          refresh();
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const logout = async () => {
        if (!window.confirm('断开 GitHub 登录？（不会删除远程仓库）')) return;
        try { await api().githubLogout(); refresh(); showMsg('ok', '已断开登录'); }
        catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const setVisibility = async (isPrivate) => {
        if (!isPrivate && !window.confirm('确认完全公开？任何人可下载/克隆；公开后被 fork 的副本不受控制。')) return;
        setBusy(true); showMsg(null);
        try {
          const r = await api().githubSetVisibility({ isPrivate });
          if (!r.ok) { showMsg('error', r.error || '切换失败'); return; }
          showMsg('ok', '已切换为' + (r.visibility === 'public' ? '完全公开' : '私有'));
          refresh();
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const toggleVisibilityBtn = (status && status.authed && status.remote)
        ? (status.visibility === 'public'
          ? btn('切换为私有', () => setVisibility(true), { disabled: busy })
          : btn('切换为完全公开', () => setVisibility(false), { danger: true, disabled: busy }))
        : null;

      const remoteLine = status && status.remote ? String(status.remote).split('\n')[0].trim() : null;

      return h("div", { style: st.grid },
        h("div", { style: st.card },
          h("div", { style: st.title }, "GitHub 与 Git"),
          h("div", { style: st.note }, "代码与 GitHub 互通：设备码快速登录、一键创建私有仓库并推送；分支/推送/拉取/合并由模型用 dsh_desktop_git_* / dsh_desktop_github_* 工具完成。"),
          h("div", { style: st.row },
            h("span", { style: st.label }, "登录状态"),
            h("span", { style: st.value }, status
              ? (status.authed ? (status.login + (status.name ? '（' + status.name + '）' : '')) : ('未登录' + (status.error ? '（' + status.error + '）' : '')))
              : '读取中…')),
          h("div", { style: st.row },
            h("span", { style: st.label }, "远程 origin"),
            h("span", { style: st.value }, remoteLine || '未关联')),
          h("div", { style: st.row },
            h("span", { style: st.label }, "当前分支"),
            h("span", { style: st.value }, (status && status.branch) || '—')),
          h("div", { style: st.row },
            h("span", { style: st.label }, "仓库可见性"),
            h("span", { style: st.value },
              status && status.visibility === 'public' ? '完全公开（任何人可下载）'
                : status && status.visibility === 'private' ? '私有'
                  : (status && status.remote ? '读取中…' : '未关联'))),
          flow
            ? h("div", { style: { ...st.form, borderColor: 'var(--dsw-alias-state-business-primary, #d29922)' } },
              h("div", { style: st.fieldLabel }, "登录码（打开网址输入后授权，自动完成）"),
              h("div", { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '22px', letterSpacing: '0.15em', padding: '8px 0', color: 'var(--dsw-alias-label-primary)' } }, flow.userCode),
              h("div", { style: st.row },
                btn('复制登录码', () => { try { navigator.clipboard.writeText(flow.userCode); } catch { /* 忽略 */ } }, { small: true }),
                btn('打开验证网址', () => { const d = api(); if (d && d.openExternal) d.openExternal(flow.verificationUri); }, { small: true, primary: true })))
            : null,
          msg ? h("p", { style: msg.tone === 'ok' ? st.msgOk : st.msgErr }, msg.text) : null,
          h("div", { style: st.actions },
            btn(flow ? '登录中…' : '快速登录（设备码）', startLogin, { primary: !status || !status.authed, disabled: !!flow || busy }),
            btn('一键关联远程仓库并推送', remoteSetup, { disabled: busy || !status || !status.authed }),
            toggleVisibilityBtn,
            btn('断开登录', logout, { disabled: !status || !status.authed, danger: true }))),
        h("p", { style: st.hint }, "分支工作流：较大任务用 git_checkout 开 feature 分支，完成后 git_merge 合并回主分支并 git_push；日常小改直接提交推送。登录后模型还可用 dsh_desktop_github_search_code 搜索 GitHub 代码参考实现。"));
    }

    /* ================= 定时任务 / 提醒 ================= */
    function ScheduleSection() {
      const [tasks, setTasks] = react.useState([]);
      const [draft, setDraft] = react.useState({ label: '', kind: 'reminder', mode: 'once', at: '09:00', everyMinutes: 60, task: '' });
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);

      const refresh = react.useCallback(() => {
        const d = api();
        if (!d || !d.scheduleList) return;
        d.scheduleList().then((r) => { if (r && r.ok) setTasks(r.tasks || []); }).catch(() => {});
      }, []);

      react.useEffect(() => { refresh(); const t = setInterval(refresh, 30000); return () => clearInterval(t); }, [refresh]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const showMsg = (tone, text) => setMsg({ tone, text });
      const setD = (key) => (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));

      const add = async () => {
        if (!String(draft.task || '').trim()) { showMsg('error', '请填写任务/提醒内容'); return; }
        setBusy(true);
        try {
          const r = await api().scheduleAdd(draft);
          if (!r.ok) showMsg('error', r.error || '添加失败');
          else { setTasks(r.tasks || []); setDraft({ ...draft, task: '', label: '' }); showMsg('ok', '已添加'); }
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const remove = async (id) => {
        if (!window.confirm('删除该定时任务？')) return;
        try { const r = await api().scheduleRemove(id); if (r.ok) setTasks(r.tasks || []); } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const toggle = async (id, enabled) => {
        try { const r = await api().scheduleToggle(id, enabled); if (r.ok) setTasks(r.tasks || []); } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const runNow = async (id) => {
        try { await api().scheduleRunNow(id); showMsg('ok', '已触发（提醒已弹通知；派发任务已填入对话框）'); } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const field = (label, control) => h("label", { style: st.field }, h("span", { style: st.fieldLabel }, label), control);

      const whenText = (t) => t.mode === 'interval' ? ('每 ' + t.everyMinutes + ' 分钟') : ((t.mode === 'daily' ? '每天 ' : '单次 ') + t.at);

      return h("div", { style: st.grid },
        h("div", { style: st.title }, "定时任务"),
        h("div", { style: st.card },
          tasks.length === 0
            ? h("p", { style: st.note }, "暂无定时任务。到点后：提醒=弹系统通知；派发任务=自动填入 harness 对话并发送。")
            : tasks.map((t) => h("div", { key: t.id, style: st.row },
              stack((t.label || '(未命名)') + ' · ' + (t.kind === 'task' ? '派发任务' : '提醒'),
                whenText(t) + ' — ' + String(t.task || '').slice(0, 60)),
              h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap", alignItems: "center" } },
                dotText(t.enabled !== false ? SUCCESS : MUTED, t.enabled !== false ? '已启用' : '已停用'),
                btn(t.enabled === false ? '启用' : '停用', () => toggle(t.id, t.enabled === false), { small: true }),
                btn('立即执行', () => runNow(t.id), { small: true }),
                btn('删除', () => remove(t.id), { small: true, danger: true })))),
          row("快速命令框", h("span", { style: st.value }, "托盘双击 / Ctrl+Shift+Space"))),
        h("div", { style: st.form },
          field("名称（可选）", h("input", { className: "dsh-set-input", style: st.input, value: draft.label, onChange: setD("label"), placeholder: "如：每天早会提醒" })),
          field("类型", h("select", { className: "dsh-set-select", style: st.select, value: draft.kind, onChange: setD("kind") },
            h("option", { value: "reminder" }, "提醒（到点弹通知）"),
            h("option", { value: "task" }, "派发任务（到点交给 harness 执行）"))),
          field("时间规则", h("select", { className: "dsh-set-select", style: st.select, value: draft.mode, onChange: setD("mode") },
            h("option", { value: "once" }, "单次（今天 HH:MM）"),
            h("option", { value: "daily" }, "每天 HH:MM"),
            h("option", { value: "interval" }, "每 N 分钟"))),
          draft.mode === 'interval'
            ? field("间隔（分钟）", h("input", { className: "dsh-set-input", style: st.input, type: "number", min: 1, value: String(draft.everyMinutes), onChange: setD("everyMinutes") }))
            : field("时间（HH:MM，24 小时制）", h("input", { className: "dsh-set-input", style: st.input, value: draft.at, onChange: setD("at"), placeholder: "09:00" })),
          field("任务 / 提醒内容", h("textarea", { className: "dsh-set-textarea", style: { ...st.textarea, minHeight: "56px" }, value: draft.task, onChange: setD("task"), placeholder: "提醒内容，或派发给 harness 的任务描述" })),
          h("div", { style: st.actions },
            btn("添加任务", add, { primary: true, disabled: busy }))),
        msg ? h("div", { style: msg.tone === 'error' ? st.msgErr : st.msgOk }, msg.text) : null,
        h("p", { style: st.hint }, "调度器每 20 秒检查一次；任务存于 settings.json 的 scheduledTasks（支持热加载）。" +
          "模型也可以自己建任务：对它说『每天 9 点提醒我…』，它会用 mcp__dsh_desktop__schedule 工具处理。"));
    }

    /* ================= Windows 系统环境 ================= */
    function SystemSection() {
      const [items, setItems] = react.useState(null);
      const [vars, setVars] = react.useState(null);
      const [envName, setEnvName] = react.useState('');
      const [envValue, setEnvValue] = react.useState('');
      const [ctxMenu, setCtxMenu] = react.useState(false);
      const [wingetLog, setWingetLog] = react.useState('');
      const [wingetBusy, setWingetBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);

      const refreshDoctor = react.useCallback(() => {
        const d = api();
        if (!d || !d.systemDoctor) return;
        d.systemDoctor().then((r) => { if (r && r.ok) setItems(r.items || []); }).catch(() => {});
      }, []);
      const refreshEnv = react.useCallback(() => {
        const d = api();
        if (!d || !d.systemEnvList) return;
        d.systemEnvList().then((r) => { if (r && r.ok) setVars(r.vars || {}); }).catch(() => {});
      }, []);
      const refreshCtx = react.useCallback(() => {
        const d = api();
        if (!d || !d.contextMenuStatus) return;
        d.contextMenuStatus().then((r) => { if (r && r.ok) setCtxMenu(!!r.registered); }).catch(() => {});
      }, []);

      react.useEffect(() => {
        refreshDoctor();
        refreshEnv();
        refreshCtx();
        const off = api().onSystemWingetOutput ? api().onSystemWingetOutput((p) => { if (p && p.text) setWingetLog((prev) => (prev + p.text + '\n').slice(-6000)); }) : () => {};
        const off2 = api().onSystemWingetExit ? api().onSystemWingetExit(() => { setWingetBusy(false); refreshDoctor(); }) : () => {};
        return () => { off(); off2(); };
      }, [refreshDoctor, refreshEnv, refreshCtx]);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const showMsg = (tone, text) => setMsg({ tone, text });

      const applyFix = async (fix) => {
        showMsg('ok', fix.type === 'admin' ? '正在提权执行（请留意 UAC 弹窗）…' : '正在修复…');
        try {
          const r = await api().systemFix(fix);
          if (r.ok) { showMsg('ok', r.detail || '修复完成'); refreshDoctor(); }
          else showMsg('error', r.error || '修复失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const envSet = async () => {
        if (!envName.trim()) { showMsg('error', '请填写变量名'); return; }
        try {
          const r = await api().systemEnvSet(envName.trim(), envValue);
          if (r.ok) { setVars(r.vars || {}); showMsg('ok', '已设置 ' + envName.trim()); setEnvValue(''); }
          else showMsg('error', r.error || '设置失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const envRemove = async (name) => {
        if (!window.confirm('删除用户环境变量 ' + name + ' ？')) return;
        try {
          const r = await api().systemEnvRemove(name);
          if (r.ok) { setVars(r.vars || {}); showMsg('ok', '已删除 ' + name); }
          else showMsg('error', r.error || '删除失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const wingetInstall = (id) => {
        setWingetBusy(true);
        setWingetLog('');
        try { api().systemWinget(id); } catch (err) { setWingetBusy(false); showMsg('error', String((err && err.message) || err)); }
      };

      const toggleCtx = async () => {
        try {
          const r = await api().contextMenuSet(!ctxMenu);
          if (r.ok) { setCtxMenu(!!r.registered); showMsg('ok', r.registered ? '已注册右键菜单' : '已移除右键菜单'); }
          else showMsg('error', r.error || '操作失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const WINGET_PACKS = [
        { id: 'Git.Git', label: 'Git' },
        { id: 'OpenJS.NodeJS.LTS', label: 'Node.js LTS' },
        { id: '7zip.7zip', label: '7-Zip' },
        { id: 'Microsoft.WindowsTerminal', label: 'Windows Terminal' },
        { id: 'Microsoft.PowerShell', label: 'PowerShell 7' },
      ];

      const field = (label, control) => h("label", { style: st.field }, h("span", { style: st.fieldLabel }, label), control);

      return h("div", { style: st.grid },
        h("div", { style: st.title }, "系统环境"),
        h("div", { style: st.groupTitle }, "环境体检（Windows 控制台常见坑）"),
        h("div", { style: st.card },
          items === null
            ? h("p", { style: st.note }, "正在体检…")
            : items.map((i) => h("div", { key: i.id, style: st.row },
              stack(h("span", { style: st.dotWrap }, dot(i.ok ? SUCCESS : DANGER), h("span", {}, i.title)), i.detail,
                { color: i.ok ? SUCCESS : DANGER }),
              i.fix
                ? btn(i.fix.type === 'admin' ? '🔓 修复（管理员）' : '一键修复', () => applyFix(i.fix),
                  { small: true, title: i.fix.type === 'admin' ? '需要管理员权限（UAC 弹窗）' : '' })
                : null)),
          h("div", { style: st.actions }, btn("重新体检", refreshDoctor, { small: true }))),
        h("div", { style: st.groupTitle }, "用户环境变量（HKCU\\Environment，免进系统设置）"),
        h("div", { style: st.card },
          vars === null
            ? h("p", { style: st.note }, "正在读取…")
            : Object.entries(vars).map(([name, value]) => h("div", { key: name, style: st.row },
              stack(name + (name === 'PATH' ? '（' + String(value).split(';').filter(Boolean).length + ' 项）' : ''),
                name === 'PATH' ? '点击编辑可查看/修改全部' : String(value).slice(0, 80), { ...st.mono, fontSize: "11px" }),
              h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
                btn("编辑", () => { setEnvName(name); setEnvValue(String(value)); }, { small: true }),
                btn("删除", () => envRemove(name), { small: true, danger: true })))),
          h("div", { style: { display: "flex", gap: "6px", padding: "8px 0", flexWrap: "wrap", alignItems: "center" } },
            h("input", { className: "dsh-set-input", style: { ...st.input, width: "180px", height: "30px" }, value: envName, placeholder: "变量名", onChange: (e) => setEnvName(e.target.value) }),
            h("input", { className: "dsh-set-input", style: { ...st.input, flex: 1, minWidth: "240px", height: "30px" }, value: envValue, placeholder: "变量值", onChange: (e) => setEnvValue(e.target.value) }),
            btn("设置", envSet, { small: true }))),
        h("div", { style: st.groupTitle }, "一键安装开发工具（winget）"),
        h("div", { style: st.card },
          h("div", { style: { display: "flex", gap: "6px", padding: "2px 0", flexWrap: "wrap" } },
            WINGET_PACKS.map((p) => btn("安装 " + p.label, () => wingetInstall(p.id), { small: true, disabled: wingetBusy, key: p.id }))),
          wingetLog ? h("pre", { style: st.output }, wingetLog.slice(0, 4000)) : null),
        h("div", { style: st.groupTitle }, "右键菜单集成（像 macOS 一样直接）"),
        h("div", { style: st.card },
          row("文件/文件夹右键 →「交给 DSH 处理」",
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
              dotText(ctxMenu ? SUCCESS : MUTED, ctxMenu ? '已注册' : '未注册'),
              btn(ctxMenu ? '移除' : '注册', toggleCtx, { small: true })))),
        msg ? h("div", { style: msg.tone === 'error' ? st.msgErr : st.msgOk }, msg.text) : null,
        h("p", { style: st.hint }, "右键任意文件/文件夹即可直接交给 harness 处理（读取/总结/建议）。环境体检与修复同样可以由模型执行：对它说『体检一下我的 Windows 环境并修复』，它会用 mcp__dsh_desktop__system_* 工具。"));
    }

    /* ================= 备份与迁移 ================= */
    function BackupSection() {
      const [busy, setBusy] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [includeSessions, setIncludeSessions] = react.useState(false);

      if (!api()) {
        return h("div", { style: st.card }, h("p", { style: st.hint }, "此设置页仅可在 DSH 桌面端中打开。"));
      }

      const showMsg = (tone, text) => setMsg({ tone, text });

      const doExport = async (includeCredentials) => {
        setBusy(true);
        showMsg('ok', (includeCredentials ? '正在导出（包含 API 密钥' : '正在导出') + (includeSessions ? '、会话历史' : '') + '）…');
        try {
          const r = await api().backupExport(includeCredentials, includeSessions);
          if (r.ok) showMsg('ok', '已导出到：' + r.path);
          else showMsg('error', r.error || '导出失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const doImport = async () => {
        try {
          const pick = await api().backupSelectFile();
          if (!pick || !pick.ok || !pick.file) return;
          setBusy(true);
          showMsg('ok', '正在导入 ' + pick.file + ' …');
          const r = await api().backupImport(pick.file);
          if (r.ok) showMsg('ok', '导入完成。重启应用生效。');
          else showMsg('error', r.error || '导入失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      return h("div", { style: st.grid },
        h("div", { style: st.title }, "备份与迁移"),
        h("div", { style: st.groupTitle }, "导出（把打磨好的 harness 打包带走）"),
        h("div", { style: st.card },
          row(stack("设置 · skills · AGENTS.md · 记忆 · MCP/视觉配置 → 单个 zip", "导出文件保存到下载目录，并自动在资源管理器中定位。"),
            h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
              btn("导出（不含密钥）", () => doExport(false), { small: true }),
              btn("导出（含 API 密钥）", () => doExport(true), { small: true, primary: true }))),
          row(stack("包含会话历史与记忆图谱", "勾选后同时备份全部对话历史（可能较大，导出更慢）。"),
            btn(includeSessions ? "已勾选" : "未勾选", () => setIncludeSessions(!includeSessions), { small: true })),
          h("p", { style: st.hint }, "推荐日常导出选择“不含密钥”；完整克隆（含 .credentials.yaml）才选“含密钥”，注意保管。换电脑前建议勾选“包含会话历史”，这样对话与记忆都不丢。" )),
        h("div", { style: st.groupTitle }, "导入（新电脑恢复）"),
        h("div", { style: st.card },
          row(stack("新电脑：安装 DSH 桌面端 → 导入 zip → 重启", "当前机器的 workspace/端口等本地项会被保留；导入前自动备份现有设置。"),
            h("div", { style: { display: "flex", gap: "6px", justifyContent: "flex-end", flexWrap: "wrap" } },
              btn("选择备份文件并导入…", doImport, { small: true, disabled: busy }))),
          h("p", { style: st.hint }, "zip 内容：settings.json（MCP/视觉/权限/定时任务）、skills/、AGENTS.md、memory.json、profile 补丁与安装信息。")),
        msg ? h("div", { style: msg.tone === 'error' ? st.msgErr : st.msgOk }, msg.text) : null);
    }

    /* ================= 多厂商模型调度（设置页分区 60） ================= */
    function ProvidersSection() {
      const [providers, setProviders] = react.useState(null);
      const [formOpen, setFormOpen] = react.useState(false);
      const [editId, setEditId] = react.useState(null);
      const [editingHasKey, setEditingHasKey] = react.useState(false);
      const [draft, setDraft] = react.useState(emptyProviderDraft());
      const [busy, setBusy] = react.useState(false);
      const [testing, setTesting] = react.useState(null); // 正在测通的 provider id
      const [tests, setTests] = react.useState({}); // id -> providersTest 结果
      const [bals, setBals] = react.useState({});   // id -> providersBalance 结果
      const [msg, setMsg] = react.useState(null);
      const didInitTest = react.useRef(false);

      const showMsg = (tone, text) => setMsg({ tone, text });

      const loadBalances = react.useCallback((list) => {
        const d = api();
        if (!d || typeof d.providersBalance !== 'function') return;
        for (const p of list) {
          d.providersBalance(p.id).then((r) => { if (r && r.ok) setBals((prev) => ({ ...prev, [p.id]: r })); }).catch(() => {});
        }
      }, []);

      const refresh = react.useCallback(async () => {
        const d = api();
        if (!d) return;
        if (typeof d.providersList !== 'function') { setProviders([]); return; }
        try {
          const r = await d.providersList();
          if (r && r.ok) {
            setProviders(r.providers || []);
            loadBalances(r.providers || []);
          }
        } catch (err) { showMsg('error', '读取厂商列表失败：' + String((err && err.message) || err)); }
      }, [loadBalances]);

      react.useEffect(() => {
        refresh();
        const t = setInterval(refresh, 30000);
        return () => clearInterval(t);
      }, [refresh]);

      async function testProvider(id) {
        const d = api();
        if (!d || typeof d.providersTest !== 'function') return;
        setTesting(id);
        setTests((prev) => ({ ...prev, [id]: { busy: true } }));
        try {
          const r = await d.providersTest(id);
          if (r) setTests((prev) => ({ ...prev, [id]: { ...r, busy: false } }));
        } catch (err) {
          setTests((prev) => ({ ...prev, [id]: { busy: false, error: String((err && err.message) || err) } }));
        } finally {
          setTesting(null);
        }
      }
      // 首次加载后自动测通一遍（静默），可用性列直接有结果
      react.useEffect(() => {
        if (!providers || didInitTest.current) return;
        didInitTest.current = true;
        for (const p of providers) testProvider(p.id);
      }, [providers]);

      if (!api()) {
        return h('div', { style: st.card }, h('p', { style: st.hint }, '此设置页仅可在 DSH 桌面端中打开。'));
      }

      const setD = (key) => (e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }));
      const field = (label, control) => h('label', { style: st.field }, h('span', { style: st.fieldLabel }, label), control);

      const availabilityText = (id) => {
        const t = tests[id];
        if (!t) return '未测试';
        if (t.busy) return '测试中…';
        if (t.available === true) return '可用' + (t.latencyMs != null ? '（' + t.latencyMs + 'ms，' + ((t.models && t.models.length) || 0) + ' 模型）' : '');
        return '不可用' + (t.error ? '：' + t.error : '');
      };

      const openAdd = () => { setEditId(null); setEditingHasKey(false); setDraft(emptyProviderDraft()); setFormOpen(true); };
      const openEdit = (p) => {
        setEditId(p.id);
        setEditingHasKey(!!p.hasKey);
        setDraft({
          name: p.name || '', provider: p.provider || '', baseUrl: p.baseUrl || '',
          apiKey: '', modelsText: (p.models || []).join(', '), enabled: p.enabled !== false, note: p.note || '',
          efforts: Array.isArray(p.efforts) ? p.efforts.filter((e) => e === 'fast' || e === 'deep') : [],
        });
        setFormOpen(true);
      };

      const save = async () => {
        const name = String(draft.name || '').trim();
        if (!name) { showMsg('error', '请填写厂商名称'); return; }
        if (!String(draft.provider || '').trim()) { showMsg('error', '请填写 provider 标识'); return; }
        if (!String(draft.baseUrl || '').trim()) { showMsg('error', '请填写 baseUrl'); return; }
        setBusy(true);
        try {
          const provider = {
            name,
            provider: String(draft.provider).trim(),
            baseUrl: String(draft.baseUrl).trim(),
            models: String(draft.modelsText || '').split(',').map((s) => s.trim()).filter(Boolean),
            enabled: draft.enabled !== false,
            note: String(draft.note || '').trim(),
            efforts: Array.isArray(draft.efforts) ? draft.efforts.filter((e) => e === 'fast' || e === 'deep') : [],
          };
          if (String(draft.apiKey || '').trim()) provider.apiKey = String(draft.apiKey).trim();
          if (editId) provider.id = editId;
          const r = await api().providersSave(provider);
          if (!r.ok) showMsg('error', r.error || '保存失败');
          else {
            showMsg('ok', '已保存 ' + name + '（点击「应用更改并重启服务」生效）');
            setFormOpen(false);
            refresh();
          }
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const removeProvider = async (id) => {
        if (!window.confirm('确定删除该厂商配置？')) return;
        try {
          const r = await api().providersRemove(id);
          if (r.ok) { showMsg('ok', '已删除（点击「应用更改并重启服务」生效）'); refresh(); }
          else showMsg('error', r.error || '删除失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
      };

      const applyProviders = async () => {
        if (!window.confirm('将重新生成 web.patch.yml 并重启 harness 服务，页面会刷新。继续？')) return;
        setBusy(true);
        try {
          const r = await api().providersApply();
          if (r && r.ok) showMsg('ok', '已应用，服务重启中…');
          else showMsg('error', (r && r.error) || '应用失败');
        } catch (err) { showMsg('error', String((err && err.message) || err)); }
        finally { setBusy(false); }
      };

      const cardRow = (p) => h('div', { key: p.id, style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
            dot(p.enabled !== false ? SUCCESS : MUTED),
            stack(h('span', { style: { ...st.name, fontWeight: '500' } }, p.name || p.provider), p.provider)),
          h('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center', flex: 'none' } },
            btn('测通', () => testProvider(p.id), { small: true, disabled: testing === p.id }),
            btn('编辑', () => openEdit(p), { small: true }),
            btn('删除', () => removeProvider(p.id), { small: true, danger: true }))),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 16px', paddingLeft: '2px' } },
          h('span', { style: st.sub }, '状态：' + (p.enabled !== false ? '已启用' : '已停用')),
          h('span', { style: st.sub }, '可用性：' + availabilityText(p.id)),
          h('span', { style: st.sub }, '余额：' + providerBalanceText(bals[p.id])),
          h('span', { style: st.sub }, '模型：' + ((p.models && p.models.length) ? p.models.join('、') : '—')),
          h('span', { style: st.sub }, 'apiKey：' + (p.hasKey ? '已配置' : '未配置')),
          p.note ? h('span', { style: st.sub }, '备注：' + p.note) : null));

      return h('div', { style: st.grid },
        h('div', { style: st.title }, '模型调度'),
        h('div', { style: st.groupTitle }, '厂商列表（' + (providers ? providers.length : '…') + '）'),
        h('div', { style: st.card },
          !providers
            ? h('p', { style: st.note }, '正在读取…')
            : providers.length === 0
              ? h('p', { style: st.note }, '暂无厂商。点击下方「添加厂商」接入 OpenAI 兼容接口（如小米 MiMo、DeepSeek、硅基流动等）。')
              : providers.map(cardRow),
          h('div', { style: st.actions },
            btn('添加厂商', openAdd, { small: true, primary: true }),
            btn('刷新列表', refresh, { small: true }))),

        formOpen ? h('div', { style: st.form },
          field('名称', h('input', { className: 'dsh-set-input', style: st.input, value: draft.name, onChange: setD('name'), placeholder: '如：小米 MiMo' })),
          field('provider（LLM provider 标识）', h('input', { className: 'dsh-set-input', style: st.input, value: draft.provider, onChange: setD('provider'), placeholder: '如 xiaomi-mimo / deepseek' })),
          field('baseUrl（OpenAI 兼容接口地址）', h('input', { className: 'dsh-set-input', style: st.input, value: draft.baseUrl, onChange: setD('baseUrl'), placeholder: 'https://api.example.com/v1' })),
          field('apiKey' + (editingHasKey ? '（已配置，留空则不修改）' : ''), h('input', { className: 'dsh-set-input', style: st.input, type: 'password', value: draft.apiKey, onChange: setD('apiKey'), placeholder: 'sk-...' })),
          field('models（逗号分隔）', h('input', { className: 'dsh-set-input', style: st.input, value: draft.modelsText, onChange: setD('modelsText'), placeholder: '如 deepseek-chat, deepseek-reasoner' })),
          field('思考强度实例（可选：额外注册 fast/deep 两个 provider，主模型派发时按 provider 名控制）',
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', fontSize: '13px' } },
                h('input', { type: 'checkbox', checked: (draft.efforts || []).includes('fast'), onChange: (e) => setDraft((prev) => ({ ...prev, efforts: e.target.checked ? [...((prev.efforts || []).filter((x) => x !== 'deep')), 'fast'] : (prev.efforts || []).filter((x) => x !== 'fast') })) }),
                'fast（effort=off，快速）'),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', fontSize: '13px' } },
                h('input', { type: 'checkbox', checked: (draft.efforts || []).includes('deep'), onChange: (e) => setDraft((prev) => ({ ...prev, efforts: e.target.checked ? [...(prev.efforts || []).filter((x) => x !== 'fast'), 'deep'] : (prev.efforts || []).filter((x) => x !== 'deep') })) }),
                'deep（effort=high，深度思考）'))),
          field('启用', h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked })) }),
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px' } }, draft.enabled ? '已启用' : '已停用'))),
          field('note（备注，可选）', h('textarea', { className: 'dsh-set-textarea', style: { ...st.textarea, minHeight: '48px' }, value: draft.note, onChange: setD('note'), placeholder: '备注信息（如控制台地址、额度说明）' })),
          h('div', { style: st.actions },
            btn('保存', save, { primary: true, disabled: busy }),
            btn('取消', () => setFormOpen(false), { small: true })),
          h('p', { style: st.hint }, '保存后需点击底部「应用更改并重启服务」才生效（重新生成 web.patch.yml 并重启 harness 服务，页面会刷新）。'))
          : null,

        h('div', { style: st.actions },
          btn('应用更改并重启服务', applyProviders, { primary: true, disabled: busy, title: '重新生成 web.patch.yml 并重启 harness 服务（页面会刷新）' })),

        msg ? h('div', { style: msg.tone === 'error' ? st.msgErr : st.msgOk }, msg.text) : null,
        h('p', { style: st.hint }, '厂商接入后，子代理可按 provider/model 分配运行（多厂商模型调度）。余额接口各厂商不一：DeepSeek 支持查询（显示数字），小米 MiMo 等不支持（显示 ✓ / 不支持查询）。「应用更改并重启服务」会重新生成 web.patch.yml 并重启 harness 服务，页面自动刷新。'));
    }

    /* ================= 右侧常驻双面板容器：环境信息 + 模型调度左右并排，无开关按钮，始终同步展示 ================= */
    function RightDock(props) {
      // 常驻让位：body 加右侧 padding（应用整体左移，对话完整可见；两面板固定占据让出的 520px 列）
      react.useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        document.body.style.paddingRight = '520px';
        return () => { if (typeof document !== 'undefined') document.body.style.paddingRight = ''; };
      }, []);
      return h('div', {
        style: {
          position: 'fixed', right: 0, top: 0, bottom: 0, width: '520px',
          background: 'var(--dsw-alias-bg-layer-1)',
          borderLeft: '1px solid var(--dsw-alias-border-l2)',
          zIndex: 2147483640,
          display: 'flex', flexDirection: 'row',
        },
        'data-dsh-desktop-right-panels': 'true',
      },
        h('div', { key: 'env', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--dsw-alias-border-l2)' } },
          h(EnvPanel, props)),
        h('div', { key: 'sched', style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
          h(SchedPanel, props)));
    }

    /* ---------- 注册 ---------- */
    const inject = ["slots"];

    function apply(ctx) {
      ensureGlobalStyles();
      try { convService = ctx.get('conversation') || null; } catch { convService = null; }
      // 截图草稿注入由 ScreenshotButton 组件完成（需要 session 级 inputActions：官方仅通过
      // slot 组件的 props.inputActions 暴露 shell.addImages——只调 createDraftImages 图片不会显示）。
      const listInventory = async () => {
        const remote = ctx.get("remote");
        const pi = remote && remote.pluginInventory;
        if (!pi || typeof pi.list !== "function") throw new Error("插件清单服务不可用");
        const result = await pi.list();
        if (!result.ok) throw new Error((result.error && (result.error.message || result.error.code)) || "读取插件清单失败");
        return result.value;
      };
      inventoryFetcher = listInventory; // 供 McpSection → PluginsBlock 使用
      // 官方优先：若官方版本已提供同 id 的设置分区，则跳过我们的注册，避免重复功能。
      const officialOwns = (id) => {
        try {
          return ctx.slots.entries("settings.section").some((e) => e && e.options && e.options.id === id);
        } catch { return false; }
      };
      const registerSection = (id, order, label, component, extra) => {
        ctx.slots.inject("settings.section", () => {
          if (officialOwns(id)) return null; // 官方功能优先
          return ctx.slots.register({ name: "settings.section", id, order, label, ...(extra || {}) }, component);
        });
      };
      // 状态行：输入框下方（conversation.composer.dock 官方状态行位置），不遮挡任何内容。
      // 状态行 = 权限/告警/时段/更新/余额/视觉/版本/MCP + 接续按钮；环境信息列与接续按钮
      // 都是 session scope（props.session 携带当前会话 id，随对话切换变化）。
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "desktop-status-pill",
        order: 20,
      }, StatusPill));
      // 右侧常驻双面板（环境信息 + 模型调度）：无开关按钮，始终同步展示；body 让位 260px。
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "desktop-right-panels",
        order: 15,
      }, RightDock));
      // 接续按钮已并入 StatusPill（MCP 胶囊右侧同一行），不再单独注册 dock 位。
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
        name: "conversation.input.dock",
        id: "desktop-subagent-queue",
        order: 10,
      }, SubagentQueueBar));
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "desktop-screenshot",
        order: 50,
      }, ScreenshotButton));
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "desktop-attach",
        order: 60,
      }, AttachButton));
      // 插话按钮：输入框旁，立即发送并把消息插到队列最前（官方 queue dock 的「插话发送」机制）
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "desktop-interject",
        order: 65,
      }, InterjectButton));
      registerSection("desktop", 90, () => "桌面端", DesktopSection);
      registerSection("mcp", 85, () => "插件与 MCP", McpSection);
      registerSection("github", 78, () => "GitHub 与 Git", GithubSection);
      registerSection("memory", 74, () => "记忆与子代理", MemorySection);
      registerSection("schedule", 73, () => "定时任务", ScheduleSection);
      registerSection("system", 72, () => "系统环境", SystemSection);
      registerSection("backup", 71, () => "备份与迁移", BackupSection);
      registerSection("usage", 70, () => "用量与账单", UsageSection);
      registerSection("providers", 60, () => "模型调度", ProvidersSection);
    }

    exports.apply = apply;
    exports.inject = inject;
    // 便于单测的内部状态（不影响官方加载器）
    exports._subagentBusy = subagentBusyStore;
    exports._parseGitSummary = parseGitSummary;
    return module.exports;
  },
});
