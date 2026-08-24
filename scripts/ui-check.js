// Electron UI check: boots dsh web with the generated patch (temp DSH_HOME),
// loads it in a real BrowserWindow with the app's preload, then verifies:
//  1. no page console errors (client bundle materializes cleanly)
//  2. window.__DSH_BOOT__ contains the desktop settings plugin
//  3. window.dshDesktop bridge is available on the harness page
//  4. the Settings panel opens and shows the "桌面端" section with 检查更新
// Usage: node_modules\.bin\electron scripts\ui-check.js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const PRELOAD = path.join(ROOT, 'preload', 'preload.js');
const TEST_HOME = path.join(os.tmpdir(), 'dsh-desktop-ui-check-' + Date.now());
const PORT = 37652;
const PATCH = path.join(TEST_HOME, 'web.patch.yml');

function log(msg) { console.log('[ui-check] ' + msg); }

/** 目录树删除：先摘除所有重解析点（junction/符号链接）自身，再递归删除，绝不跟随目标。 */
function safeRm(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { /* ignore */ } continue; }
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
function logError(msg) { console.error('[ui-check] ' + msg); }

let child = null;
let win = null;
const failures = [];
function check(name, ok, detail) {
  log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('timeout waiting ' + url));
        setTimeout(probe, 500);
      });
      req.setTimeout(3000, () => req.destroy());
    };
    probe();
  });
}

app.setPath('userData', path.join(os.tmpdir(), 'dsh-desktop-ui-check-userdata'));

async function main() {
  // 1. temp DSH_HOME + patch + client link
  safeRm(TEST_HOME);
  fs.mkdirSync(TEST_HOME, { recursive: true });
  const { generateWebPatch, ensureClientPackageLink } = require(path.join(ROOT, 'main', 'web-patch.js'));
  process.env.DSH_HOME = TEST_HOME;
  generateWebPatch({ file: PATCH, appDir: ROOT, enableDesktopMcp: true, mcpServers: [] });
  ensureClientPackageLink({ dshHome: TEST_HOME, appDir: ROOT, log: logError });

  // 2. spawn dsh web
  process.env.DSH_DESKTOP_RPC_URL = 'http://127.0.0.1:1';
  process.env.DSH_DESKTOP_RPC_TOKEN = 'ui-check-token';
  child = spawn('node', [BIN, 'web', '--patch', PATCH, '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write('[dsh-web] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[dsh-web-err] ' + d));
  child.on('exit', (code) => { log('dsh web exited: ' + code); });

  try {
    await waitForHttp('http://127.0.0.1:' + PORT, 90000);

    // 3. window with the app's preload
    const consoleErrors = [];
    win = new BrowserWindow({
      width: 1360, height: 900, show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 3) consoleErrors.push(String(message));
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => { consoleErrors.push('did-fail-load ' + code + ' ' + desc); });
    await win.loadURL('http://127.0.0.1:' + PORT);
    // let the client shell boot + initial selection settle
    await new Promise((r) => setTimeout(r, 12000));

    const boot = await win.webContents.executeJavaScript('(() => { try { return JSON.stringify(window.__DSH_BOOT__ || null); } catch (e) { return "ERR " + e; } })()');
    check('window.__DSH_BOOT__ present', typeof boot === 'string' && boot !== 'null' && boot !== 'ERR undefined', String(boot).slice(0, 80));
    check('boot graph has settings-update', typeof boot === 'string' && boot.includes('settings-update'), '');

    const bridge = await win.webContents.executeJavaScript('(() => ({ has: typeof window.dshDesktop !== "undefined", keys: window.dshDesktop ? Object.keys(window.dshDesktop) : [] }))()');
    check('window.dshDesktop bridge available', !!bridge.has, JSON.stringify(bridge.keys));

    // 4. open settings, navigate to 桌面端 section
    const openSettings = await win.webContents.executeJavaScript(`(() => {
      const all = [...document.querySelectorAll('button, div, span, li, a')];
      const candidates = all.filter((e) => {
        const t = (e.textContent || '').trim();
        const a = e.getAttribute && (e.getAttribute('aria-label') || '');
        return t === '设置' || t === 'Settings' || a === '设置' || a === 'Settings';
      });
      if (!candidates.length) {
        const avatar = all.find((e) => (e.getAttribute && (e.getAttribute('aria-label') || '').toLowerCase().includes('menu')));
        if (avatar) { avatar.click(); return 'clicked-menu-fallback'; }
        return 'no-settings-trigger';
      }
      const target = candidates[candidates.length - 1];
      target.click();
      return 'clicked';
    })()`);
    check('settings trigger clickable', openSettings === 'clicked', openSettings);
    await new Promise((r) => setTimeout(r, 1500));

    const nav = await win.webContents.executeJavaScript(`(() => {
      const els = [...document.querySelectorAll('button, div, span')];
      const found = els.filter((e) => (e.textContent || '').trim() === '桌面端');
      return found.length > 0 ? 'found' : 'missing';
    })()`);
    check('settings nav shows 桌面端 section', nav === 'found', nav);

    if (nav === 'found') {
      await win.webContents.executeJavaScript(`(() => {
        const els = [...document.querySelectorAll('button, div, span')];
        const el = els.find((e) => (e.textContent || '').trim() === '桌面端');
        if (el) el.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      const content = await win.webContents.executeJavaScript(`(() => document.body ? document.body.innerText.slice(0, 3000) : '')()`);
      check('section shows 检查更新 button', content.includes('检查更新'), content.includes('检查更新') ? '' : 'body text: ' + content.slice(0, 200));
      check('section shows version row', /当前版本/.test(content), '');
      check('section shows 更新状态 row', /更新状态/.test(content), '');
    }

    const realErrors = consoleErrors.filter((m) => !/Download the React DevTools/.test(m) && !/favicon/.test(m));
    check('no page console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } catch (err) {
    logError('test crashed: ' + (err && err.stack ? err.stack : err));
    failures.push('crash');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (child) {
      try {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        await new Promise((r) => killer.on('exit', r));
      } catch { try { child.kill(); } catch {} }
    }
    safeRm(TEST_HOME);
    safeRm(app.getPath('userData'));
  }

  if (failures.length) { log('UI-CHECK FAIL: ' + failures.join(', ')); app.exit(1); }
  else { log('UI-CHECK OK'); app.exit(0); }
}

app.whenReady().then(main).catch((err) => { logError('fatal: ' + err); app.exit(2); });