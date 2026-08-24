'use strict';
/**
 * UI 内省（ui-introspect）：桌面端主进程通过 webContents.executeJavaScript 直接
 * 读取/操作自己窗口内的页面 DOM——结构化元素清单（含精确坐标）、按文本/选择器点击、
 * 读文本、截自己窗口的图（capturePage，不受其他窗口遮挡/叠放影响）。
 *
 * 解决"截图定位差"顽疾：不再靠屏幕截图 + OCR 猜坐标，改为：
 *   uiSnapshot（元素清单+rect）→ 决策 → uiClick（文本/选择器精确点击）→ uiText/uiCapture（验证）。
 * 本模块是纯 Node：导出注入脚本构造器与结果归一化函数，可单测（fake DOM）。
 */

const TEXT_CAP = 60;
const ELEMENTS_LIMIT = 400;

/** 生成快照脚本源码（元素清单：可点击控件 + 坐标 + 文本/aria/title 标签）。 */
function snapshotScript() {
  return `(function () {
  var out = { url: location.href, title: document.title, vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio || 1, elements: [] };
  var TEXT_CAP = ${TEXT_CAP};
  var nodes = document.querySelectorAll('button, a, [role="button"], input, textarea, select, summary, [contenteditable="true"]');
  for (var i = 0; i < nodes.length && out.elements.length < ${ELEMENTS_LIMIT}; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    var st = window.getComputedStyle(el);
    if (!st || st.visibility === 'hidden' || st.display === 'none') continue;
    var raw = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText !== undefined ? el.innerText : (el.value || '')) || '').trim();
    out.elements.push({
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      text: String(raw).slice(0, TEXT_CAP),
      id: el.id || '',
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });
  }
  return out;
})()`;
}

/** 生成点击脚本：按 selector（优先）或 text（label 包含匹配，第 index 个）点击。 */
function clickScript({ selector, text, index = 0 }) {
  const sel = selector ? JSON.stringify(String(selector)) : 'null';
  const txt = text ? JSON.stringify(String(text)) : 'null';
  return `(function () {
  var sel = ${sel}, txt = ${txt}, idx = ${Number(index) || 0};
  var nodes = sel ? document.querySelectorAll(sel) : document.querySelectorAll('button, a, [role="button"], input[type="submit"], summary, [contenteditable="true"]');
  var seen = 0;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var label = (el.getAttribute('aria-label') || el.getAttribute('title') || (el.innerText !== undefined ? el.innerText : (el.value || '')) || '').trim();
    var hit = sel ? true : (txt && label && label.indexOf(txt) !== -1);
    if (!hit) continue;
    if (seen === idx) {
      el.click();
      return { ok: true, tag: el.tagName ? el.tagName.toLowerCase() : '?', text: String(label).slice(0, 80) };
    }
    seen++;
  }
  return { ok: false, error: 'not found', candidates: seen };
})()`;
}

/** 生成读文本脚本：selector → 元素 innerText（上限 4000 字）。 */
function textScript(selector, cap = 4000) {
  return `(function () {
  var el = document.querySelector(${JSON.stringify(String(selector || ''))});
  if (!el) return { ok: false, error: 'selector not found' };
  var t = el.innerText !== undefined ? el.innerText : (el.value || el.textContent || '');
  return { ok: true, text: String(t).slice(0, ${Number(cap) || 4000}) };
})()`;
}

/** 归一化快照结果（防脏数据）。 */
function normalizeSnapshot(raw) {
  const out = { url: '', title: '', vw: 0, vh: 0, dpr: 1, elements: [] };
  if (!raw || typeof raw !== 'object') return out;
  out.url = String(raw.url || '').slice(0, 300);
  out.title = String(raw.title || '').slice(0, 200);
  out.vw = Number(raw.vw) || 0;
  out.vh = Number(raw.vh) || 0;
  out.dpr = Number(raw.dpr) || 1;
  if (Array.isArray(raw.elements)) {
    for (const e of raw.elements) {
      if (!e || typeof e !== 'object') continue;
      out.elements.push({
        tag: String(e.tag || '?'),
        text: String(e.text || '').slice(0, TEXT_CAP),
        id: String(e.id || ''),
        cls: String(e.cls || '').slice(0, 60),
        x: Number(e.x) || 0, y: Number(e.y) || 0, w: Number(e.w) || 0, h: Number(e.h) || 0,
      });
    }
  }
  return out;
}

module.exports = { snapshotScript, clickScript, textScript, normalizeSnapshot, TEXT_CAP, ELEMENTS_LIMIT };
