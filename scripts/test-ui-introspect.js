// ui-introspect 单测：用 fake DOM 执行注入脚本字符串，验证
// snapshot（元素清单+坐标）/ click（按文本、index、选择器、未命中）/ text（读取与截断）/ 归一化。
// 用法：node scripts\test-ui-introspect.js
'use strict';
const { snapshotScript, clickScript, textScript, normalizeSnapshot } = require('../main/ui-introspect');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

function fakeEl(opts = {}) {
  let clicked = false;
  return {
    tagName: (opts.tag || 'button').toUpperCase(),
    innerText: opts.innerText !== undefined ? opts.innerText : (opts.text || ''),
    value: opts.value !== undefined ? opts.value : '',
    id: opts.id || '',
    className: opts.cls || '',
    getBoundingClientRect: () => ({ x: opts.x || 0, y: opts.y || 0, width: opts.w || 100, height: opts.h || 30 }),
    getAttribute: (n) => (n === 'aria-label' ? (opts.aria || null) : (n === 'title' ? (opts.title || null) : null)),
    click() { clicked = true; },
    wasClicked: () => clicked,
  };
}

function fakeEnv(els) {
  return {
    document: {
      querySelectorAll: () => els,
      querySelector: () => els[0] || null,
    },
    window: {
      innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
      getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    },
    location: { href: 'http://localhost/page' },
  };
}

const run = (code, env) => new Function('document', 'window', 'location', 'return ' + code)(env.document, env.window, env.location);

(async () => {
  // 1. snapshot
  {
    const els = [
      fakeEl({ tag: 'button', text: '保存', aria: '保存按钮', x: 10, y: 20, w: 80, h: 30, id: 'save', cls: 'btn primary' }),
      fakeEl({ tag: 'a', text: '文档链接', x: 100, y: 50, w: 90, h: 24 }),
      fakeEl({ tag: 'input', value: '搜索词', x: 0, y: 0, w: 200, h: 32 }),
    ];
    const raw = run(snapshotScript(), fakeEnv(els));
    check('snapshot url/vw', raw.url === 'http://localhost/page' && raw.vw === 1280 && raw.vh === 800, JSON.stringify({ url: raw.url, vw: raw.vw }));
    check('snapshot elements count', raw.elements.length === 3, '');
    const first = raw.elements[0];
    check('snapshot first element fields', first.tag === 'button' && first.text === '保存按钮' && first.x === 10 && first.y === 20 && first.w === 80 && first.id === 'save', JSON.stringify(first));
    const norm = normalizeSnapshot(raw);
    check('normalizeSnapshot roundtrip', norm.elements.length === 3 && norm.elements[0].tag === 'button', '');
    check('normalizeSnapshot dirty input safe', normalizeSnapshot(null).elements.length === 0 && normalizeSnapshot({ elements: [{ tag: 'x' }] }).elements[0].text === '', '');
  }
  // 2. click 按文本 + index
  {
    const a = fakeEl({ text: '保存' }), b = fakeEl({ text: '保存' }), c = fakeEl({ text: '取消' });
    const env = fakeEnv([a, b, c]);
    const r1 = run(clickScript({ text: '保存', index: 1 }), env);
    check('click text index=1 hits second', r1.ok === true && b.wasClicked() && !a.wasClicked() && r1.text === '保存', JSON.stringify(r1));
    const r2 = run(clickScript({ text: '不存在' }), env);
    check('click text miss -> not found', r2.ok === false && r2.error === 'not found' && r2.candidates === 0, JSON.stringify(r2));
    const r3 = run(clickScript({ selector: '#save' }), env);
    check('click selector path', r3.ok === true && a.wasClicked(), JSON.stringify(r3));
    const r4 = run(clickScript({ text: '保存', index: 5 }), env);
    check('click index beyond -> not found with candidates', r4.ok === false && r4.candidates === 2, JSON.stringify(r4));
  }
  // 3. text 读取与截断
  {
    const long = 'x'.repeat(100);
    const el = fakeEl({ text: long });
    const env = fakeEnv([el]);
    const r1 = run(textScript('#panel', 30), env);
    check('textScript cap truncates', r1.ok === true && r1.text.length === 30, String(r1.text && r1.text.length));
    const emptyEnv = fakeEnv([]);
    const r2 = run(textScript('#nothing'), emptyEnv);
    check('textScript missing selector -> error', r2.ok === false && r2.error === 'selector not found', JSON.stringify(r2));
  }

  if (failures.length) { console.log('UI-INTROSPECT FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('UI-INTROSPECT OK');
})();
