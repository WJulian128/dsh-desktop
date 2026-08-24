'use strict';
const path = require('node:path');
const fs = require('node:fs');

/**
 * 生成注入 harness web profile 的 --patch 覆盖文件（YAML）：
 *  - 内置 dsh_desktop MCP 服务器（dsh-mcp-client 行，stdio 拉起 main/mcp-server.mjs）
 *  - 用户在设置里声明的额外 MCP 服务器
 *  - 桌面端设置分区客户端（@dsh-desktop/settings-update，注册 harness 设置页“桌面端”分区）
 *
 * `!!js process.env.*` 表达式由 harness Loader 求值，值来自桌面端注入 dsh web
 * 子进程的环境变量（DSH_DESKTOP_RPC_URL / DSH_DESKTOP_RPC_TOKEN）。
 */

/** 从 PATH 解析 node 可执行文件绝对路径（MCP stdio 服务器由它拉起）。 */
function resolveNodeExecutable() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, 'node' + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch { /* 继续找 */ }
    }
  }
  return null;
}

/** 单值 YAML 标量（单引号包裹，反斜杠保持字面量，单引号翻倍转义）。 */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const s = String(value);
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Provider 的环境变量名：`<ID大写>_API_KEY`（如 mimo → MIMO_API_KEY）。
 * harness 启动时主进程按同名键把 apiKey 注入 dsh web 子进程环境，
 * llm-openai-compat 插件通过 apiKeyEnv 读取，两边必须用同一套命名规则。
 */
function providerEnvKey(id) {
  return String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
}

/** 递归输出 YAML 值；{ __js: 'expr' } 会输出为 `!!js expr`（由 Loader 求值）。 */
function emitYamlValue(value, indent) {
  if (value && typeof value === 'object' && typeof value.__js === 'string' && Object.keys(value).length === 1) {
    return '!!js ' + value.__js;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const pad = ' '.repeat(indent);
    return '\n' + value.map((item) => pad + '- ' + emitYamlValue(item, indent + 2)).join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const pad = ' '.repeat(indent);
    return '\n' + entries.map(([k, v]) => pad + k + ': ' + emitYamlValue(v, indent + 2)).join('\n');
  }
  return yamlScalar(value);
}

/**
 * 构造 patch 行集合。
 * @param {object} options
 * @param {string} options.appDir - 桌面端应用目录（定位 main/mcp-server.mjs）
 * @param {string} [options.dshHome] - DSH_HOME（记忆文件等受控数据的存放根目录）
 * @param {boolean} [options.enableDesktopMcp=true]
 * @param {Array} [options.mcpServers=[]]
 * @param {Array} [options.apiProviders=[]] - 多厂商 LLM Provider（enabled 的注入为 llm-openai-compat 插件行）
 * @returns {Array<{id: string, name: string, config?: object}>}
 */
function buildPatchRows({ appDir, dshHome, enableDesktopMcp = true, mcpServers = [], apiProviders = [] }) {
  const rows = [];
  const nodeExe = resolveNodeExecutable();

  if (enableDesktopMcp !== false) {
    rows.push({
      id: 'mcp-dsh-desktop',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'dsh_desktop',
        transport: 'stdio',
        command: nodeExe || process.execPath,
        args: [path.join(appDir, 'main', 'mcp-server.mjs')],
        env: {
          DSH_DESKTOP_RPC_URL: { __js: 'process.env.DSH_DESKTOP_RPC_URL' },
          DSH_DESKTOP_RPC_TOKEN: { __js: 'process.env.DSH_DESKTOP_RPC_TOKEN' },
          ...(nodeExe ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
        },
        // 本地视觉模型（qwen2.5vl:7b 等）单次推理可达 1~8 分钟（冷启动还含模型加载），
        // 默认工具超时（60s）会把它杀掉（表现为 describe_image 超时/视觉未生效）。
        // 三层超时必须满足：harness 工具超时 > MCP RPC 视觉超时（480s）> vision.js 请求超时（480s）。
        toolCallTimeoutMs: 600000,
      },
    });
  }

  // 内置 MCP 工具集（项目实际安装的官方 stdio 服务器）。优先直接跑本地安装的包
  // （node 拉起 node_modules/@modelcontextprotocol/*/dist/index.js，冷启动快、
  // 离线可用）。不要把未发布或未安装的包放进这里：否则缺包时会回退 npx，
  // 在启动阶段反复联网重试并刷 E404，拖慢甚至伪装成桌面端卡死。
  // 记忆文件的存储位置由 MEMORY_FILE_PATH 钉到受控目录，避免落在 npx 缓存里被清理/丢失。
  const builtinMcps = [
    {
      id: 'mcp-memory',
      serverName: 'memory',
      pkg: '@modelcontextprotocol/server-memory',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      env: dshHome ? { MEMORY_FILE_PATH: path.join(dshHome, 'memory', 'memory.jsonl') } : undefined,
    },
    {
      id: 'mcp-sequential-thinking',
      serverName: 'sequential-thinking',
      pkg: '@modelcontextprotocol/server-sequential-thinking',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
  ];
  const builtinNames = new Set(builtinMcps.map((m) => m.serverName));
  for (const mcp of builtinMcps) {
    // 本地入口：node_modules/@modelcontextprotocol/<pkg>/dist/index.js（各包 bin 指向它）
    const localEntry = path.join(appDir, 'node_modules', mcp.pkg, 'dist', 'index.js');
    let config;
    if (fs.existsSync(localEntry)) {
      config = {
        serverName: mcp.serverName,
        transport: 'stdio',
        command: nodeExe || process.execPath,
        args: [localEntry],
      };
      if (!nodeExe) config.env = { ...(config.env || {}), ELECTRON_RUN_AS_NODE: '1' };
    } else {
      // 本地入口缺失：回退 npx（保持历史行为，依赖网络/缓存）
      config = { serverName: mcp.serverName, transport: 'stdio', command: 'npx', args: mcp.args };
    }
    if (mcp.env) config.env = { ...(config.env || {}), ...mcp.env };
    rows.push({ id: mcp.id, name: '@deepseek-ai/dsh-mcp-client', config });
  }

  for (const srv of mcpServers || []) {
    if (!srv || !srv.serverName) continue;
    if (srv.enabled === false) continue; // 设置页里停用的服务器不注入
    const name = String(srv.serverName);
    if (builtinNames.has(name)) {
      // 与内置 MCP 同名：跳过用户配置，避免 loader id 重复导致整个补丁被拒绝。
      // eslint-disable-next-line no-console
      console.log('[web-patch] 跳过与内置 MCP 同名的用户配置：' + name);
      continue;
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      // eslint-disable-next-line no-console
      console.error('[web-patch] 忽略非法 serverName：' + name);
      continue;
    }
    const config = { serverName: name, transport: srv.transport === 'streamable-http' ? 'streamable-http' : 'stdio' };
    if (config.transport === 'streamable-http') {
      if (srv.url) config.url = String(srv.url);
      if (srv.headers && typeof srv.headers === 'object') config.headers = srv.headers;
    } else {
      if (srv.command) config.command = String(srv.command);
      if (Array.isArray(srv.args)) config.args = srv.args.map(String);
      if (srv.env && typeof srv.env === 'object') config.env = srv.env;
      if (srv.cwd) config.cwd = String(srv.cwd);
    }
    if (srv.failOnStartupError) config.failOnStartupError = true;
    if (typeof srv.toolCallTimeoutMs === 'number') config.toolCallTimeoutMs = srv.toolCallTimeoutMs;
    if (srv.reconnect && typeof srv.reconnect === 'object') config.reconnect = srv.reconnect;
    rows.push({ id: 'mcp-' + name, name: '@deepseek-ai/dsh-mcp-client', config });
  }

  // 多厂商 LLM Provider：每个启用的 OpenAI 兼容端点注入一个 llm-openai-compat 插件行。
  // apiKey 本身不写进 patch 文件——只写环境变量名（apiKeyEnv），值由主进程在
  // startHarness 时以同名键注入 dsh web 子进程环境（providerEnvKey 命名规则一致）。
  // 思考强度实例：provider.efforts（如 ['fast','deep']）→ 为每个强度额外注册一个
  // provider 实例（<provider>-<effort>，config.effort 映射 fast→off / balanced→不设 / deep→high），
  // 主模型派发子代理时通过 provider 名间接控制思考强度（harness 暂不支持按次 effort 参数）。
  const EFFORT_MAP = { fast: 'off', deep: 'high' };
  for (const p of apiProviders || []) {
    if (!p || p.enabled === false || !p.id || !p.provider || !p.baseUrl) continue;
    if (!Array.isArray(p.models) || !p.models.length) continue;
    const models = p.models.map((m) => ({ id: String(m) })).filter((m) => m.id);
    if (!models.length) continue;
    rows.push({
      id: 'llm-provider-' + String(p.id),
      name: '@dsh-desktop/llm-openai-compat',
      config: {
        providerName: String(p.provider),
        baseURL: String(p.baseUrl).replace(/\/+$/, ''),
        apiKeyEnv: providerEnvKey(p.id),
        models,
      },
    });
    // 额外思考强度实例（fast/deep；balanced 即基础实例，不重复注册）
    const efforts = Array.isArray(p.efforts) ? p.efforts.filter((e) => e === 'fast' || e === 'deep') : [];
    for (const effort of efforts) {
      rows.push({
        id: 'llm-provider-' + String(p.id) + '-' + effort,
        name: '@dsh-desktop/llm-openai-compat',
        config: {
          providerName: String(p.provider) + '-' + effort,
          baseURL: String(p.baseUrl).replace(/\/+$/, ''),
          apiKeyEnv: providerEnvKey(p.id),
          models,
          effort: EFFORT_MAP[effort],
        },
      });
    }
  }

  rows.push({ id: 'desktop-settings-ui', name: '@dsh-desktop/settings-update' });
  // 子代理工具审批桥：子代理 skill/MCP 请求向上审批（父代理模型批准），任何权限模式下生效。
  rows.push({ id: 'subagent-approval', name: '@dsh-desktop/subagent-approval' });
  return rows;
}

/** 把行集合渲染为 patch YAML 文本。 */
function renderPatchYaml(rows) {
  const lines = ['- insert:'];
  for (const row of rows) {
    lines.push('    - id: ' + yamlScalar(row.id));
    lines.push('      name: ' + yamlScalar(row.name));
    if (row.config) lines.push('      config:' + emitYamlValue(row.config, 8));
  }
  return lines.join('\n') + '\n';
}

/**
 * 生成并写入 patch 文件。
 * @param {object} options
 * @param {string} options.file - 目标文件绝对路径
 * @param {string} options.appDir - 桌面端应用目录
 * @param {string} [options.dshHome] - DSH_HOME
 * @param {boolean} [options.enableDesktopMcp=true]
 * @param {Array} [options.mcpServers=[]]
 * @param {Array} [options.apiProviders=[]]
 * @param {(text: string) => void} [options.log]
 * @returns {string} patch YAML 文本
 */
function generateWebPatch({ file, appDir, dshHome, enableDesktopMcp = true, mcpServers = [], apiProviders = [], log = () => {} }) {
  const rows = buildPatchRows({ appDir, dshHome, enableDesktopMcp, mcpServers, apiProviders });
  const text = renderPatchYaml(rows);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
  } catch (err) {
    log('[web-patch] 写入 patch 文件失败：' + (err && err.message ? err.message : err));
  }
  return text;
}

/**
 * 确保桌面端客户端插件（@dsh-desktop/settings-update）对 harness 可解析。
 *
 * harness 从 profile 目录按父级上溯解析插件包，落在 `$DSH_HOME/profiles/node_modules`
 * 的平铺 fallback 目录（dsh 启动时会用安装包依赖闭包维护符号链接，且从不删除已有
 * 链接）。桌面端自己的包不在该闭包里，因此这里预先创建一条 junction/符号链接，
 * 让 Loader 与客户端模块扫描器都能找到它。
 * @param {object} options
 * @param {string} options.dshHome - DSH_HOME
 * @param {string} options.appDir - 桌面端应用目录
 * @param {(text: string) => void} [options.log]
 * @returns {boolean} 是否确保可用
 */
function ensureClientPackageLink({ dshHome, appDir, log = () => {} }) {
  const link = path.join(dshHome, 'profiles', 'node_modules', '@dsh-desktop', 'settings-update');
  const target = path.join(appDir, 'node_modules', '@dsh-desktop', 'settings-update');
  // 关键：解析出真实目录再建链接。Windows 上“junction → junction”链式路径在部分
  // FS 操作（Node ESM 解析、npm reify）下不可靠，直接指向最终真实目录最稳妥。
  let realTarget = target;
  try { realTarget = fs.realpathSync(target); } catch { /* 目标缺失时退回原路径 */ }
  const targetComplete = () => {
    try {
      return fs.existsSync(path.join(target, 'package.json'))
        && fs.existsSync(path.join(target, 'lib', 'index.js'))
        && fs.existsSync(path.join(target, 'client.js'));
    } catch { return false; }
  };
  try {
    // 目标包不完整（例如开发中先建链接后补文件）时绝不创建/保留链接，
    // 否则 loader 解析不到 package.json 会把包目录当普通目录找 index.js，
    // 导致整个 harness 插件树加载失败、客户端启动失败。
    if (!targetComplete()) {
      log('[web-patch] 目标包不完整，跳过链接：' + target);
      return false;
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    let existing = null;
    try { existing = fs.lstatSync(link); } catch { /* 不存在 */ }
    if (existing) {
      if (!existing.isSymbolicLink()) {
        log('[web-patch] ' + link + ' 已存在但不是符号链接，跳过（请手动处理）');
        return false;
      }
      // 自愈：链接目标可达且包完整则保留；悬挂/指向旧目录则删除重建。
      let usable = false;
      try {
        const real = fs.realpathSync(link);
        usable = fs.existsSync(path.join(real, 'package.json')) && fs.existsSync(path.join(real, 'lib', 'index.js'));
      } catch { /* 悬挂链接 */ }
      if (usable) return true;
      log('[web-patch] 修复不可用的客户端插件链接：' + link);
      try { fs.unlinkSync(link); } catch { /* 忽略 */ }
    }
    fs.symlinkSync(realTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
    log('[web-patch] 已创建客户端插件链接：' + link + ' -> ' + realTarget);
    return true;
  } catch (err) {
    log('[web-patch] 创建客户端插件链接失败：' + (err && err.message ? err.message : err));
    return false;
  }
}

module.exports = { generateWebPatch, buildPatchRows, renderPatchYaml, resolveNodeExecutable, ensureClientPackageLink, providerEnvKey };
