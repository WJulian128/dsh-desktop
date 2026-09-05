'use strict';

// 启动前自检自愈单测（main/boot-preflight.js + main/plugin-deps.js）。
// 临时目录自建/自清理，不依赖运行中的桌面端。
// 用法：node scripts/test-boot-preflight.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const preflight = require('../main/boot-preflight');
const pluginDeps = require('../main/plugin-deps');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
    pass += 1;
  } catch (err) {
    console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err));
    fail += 1;
  }
}

/** 建一个“完整插件包”目录（package.json + 入口文件）。 */
function makePackage(dir, name, { files = ['package.json', 'lib/index.js'] } = {}) {
  fs.mkdirSync(path.join(dir, name, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify({ name, main: 'lib/index.js' }), 'utf8');
  fs.writeFileSync(path.join(dir, name, 'lib', 'index.js'), 'export default 1;\n', 'utf8');
  if (files.includes('client.js')) fs.writeFileSync(path.join(dir, name, 'client.js'), 'export default 2;\n', 'utf8');
  return path.join(dir, name);
}

/** 当前测试用的隔离环境（appDir + dshHome）。 */
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preflight-'));
  const appDir = path.join(root, 'app');
  const dshHome = path.join(root, 'home');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dshHome, { recursive: true });
  return { root, appDir, dshHome };
}

/** 写入一份“全插件齐全”的 app/packages。 */
function populatePackages(appDir, { withClient = true } = {}) {
  makePackage(path.join(appDir, 'packages'), 'settings-update', { files: withClient ? ['package.json', 'lib/index.js', 'client.js'] : ['package.json'] });
  makePackage(path.join(appDir, 'packages'), 'llm-openai-compat');
  makePackage(path.join(appDir, 'packages'), 'subagent-approval');
}

/* ---- 链接创建/自愈 ---- */
check('ensureProfilePluginLinks：齐全时创建 3 条 junction', () => {
  const { root, appDir, dshHome } = makeEnv();
  try {
    populatePackages(appDir);
    const logs = [];
    const r = preflight.ensureProfilePluginLinks({ dshHome, appDir, log: (s) => logs.push(s) });
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.ok, 3);
    for (const name of ['settings-update', 'llm-openai-compat', 'subagent-approval']) {
      const link = path.join(dshHome, 'profiles', 'node_modules', '@dsh-desktop', name);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), name + ' 应为链接');
      assert.ok(fs.existsSync(path.join(fs.realpathSync(link), 'package.json')), name + ' realpath 可达');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('ensureProfilePluginLinks：悬挂链接自动修复', () => {
  const { root, appDir, dshHome } = makeEnv();
  try {
    populatePackages(appDir);
    const linkDir = path.join(dshHome, 'profiles', 'node_modules', '@dsh-desktop');
    fs.mkdirSync(linkDir, { recursive: true });
    // 制造一条指向不存在目标的悬挂 junction
    fs.symlinkSync(path.join(appDir, 'packages', 'nowhere'), path.join(linkDir, 'llm-openai-compat'), 'junction');
    const r = preflight.ensureProfilePluginLinks({ dshHome, appDir, log: () => {} });
    assert.strictEqual(r.ok, 3);
    const real = fs.realpathSync(path.join(linkDir, 'llm-openai-compat'));
    assert.ok(fs.existsSync(path.join(real, 'package.json')), '悬挂链接应被重建指向完整包');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('ensurePackageLink：链接指向旧候选（node_modules 拷贝）→ 重建指向 packages 源', () => {
  const { root, appDir, dshHome } = makeEnv();
  try {
    populatePackages(appDir); // packages/settings-update（最优候选）
    // 制造 node_modules 里的“旧拷贝”候选（完整但优先级更低）
    makePackage(path.join(appDir, 'node_modules', '@dsh-desktop'), 'settings-update', { files: ['package.json', 'lib/index.js', 'client.js'] });
    const linkDir = path.join(dshHome, 'profiles', 'node_modules', '@dsh-desktop');
    fs.mkdirSync(linkDir, { recursive: true });
    // 手工把链接指向旧拷贝（模拟 npm 重装后的漂移现场）
    fs.symlinkSync(path.join(appDir, 'node_modules', '@dsh-desktop', 'settings-update'),
      path.join(linkDir, 'settings-update'), 'junction');
    const pkg = preflight.DESKTOP_PLUGINS.find((p) => p.name === '@dsh-desktop/settings-update');
    const ok = preflight.ensurePackageLink({ dshHome, appDir, pkg, log: () => {} });
    assert.strictEqual(ok, true);
    const real = path.resolve(fs.realpathSync(path.join(linkDir, 'settings-update'))).toLowerCase();
    const expected = path.resolve(path.join(appDir, 'packages', 'settings-update')).toLowerCase();
    assert.strictEqual(real, expected, '链接应重建到 packages 源目录而非 node_modules 拷贝');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('ensurePackageLink：目标缺失时跳过且不抛错', () => {
  const { root, appDir, dshHome } = makeEnv();
  try {
    const pkg = preflight.DESKTOP_PLUGINS[0];
    const ok = preflight.ensurePackageLink({ dshHome, appDir, pkg, log: () => {} });
    assert.strictEqual(ok, false);
    assert.ok(!fs.existsSync(path.join(dshHome, 'profiles')), '不应留下空链接');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('ensurePackageLink：已有普通目录而非链接 → 跳过（不破坏现场）', () => {
  const { root, appDir, dshHome } = makeEnv();
  try {
    populatePackages(appDir);
    const link = path.join(dshHome, 'profiles', 'node_modules', '@dsh-desktop', 'settings-update');
    fs.mkdirSync(link, { recursive: true }); // 普通目录占位
    const pkg = preflight.DESKTOP_PLUGINS.find((p) => p.name === '@dsh-desktop/settings-update');
    const ok = preflight.ensurePackageLink({ dshHome, appDir, pkg, log: () => {} });
    assert.strictEqual(ok, false);
    assert.ok(fs.statSync(link).isDirectory() && !fs.lstatSync(link).isSymbolicLink(), '现场保持不变');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---- 插件依赖自愈 ---- */
check('missingDeps：从插件目录向上可解析（含根 node_modules）则不算缺失', () => {
  const { root, appDir } = makeEnv();
  try {
    const pkgDir = makePackage(path.join(appDir, 'packages'), 'sample');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ dependencies: { 'dep-a': '^1.0.0' } }), 'utf8');
    // 只在根 node_modules 提供（模拟根提升布局）
    fs.mkdirSync(path.join(appDir, 'node_modules', 'dep-a'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'node_modules', 'dep-a', 'package.json'), '{"name":"dep-a","version":"1.0.0"}', 'utf8');
    assert.deepStrictEqual(pluginDeps.missingDeps(pkgDir, appDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('missingDeps：任何祖先都解析不到才报缺失', () => {
  const { root, appDir } = makeEnv();
  try {
    const pkgDir = makePackage(path.join(appDir, 'packages'), 'sample');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ dependencies: { 'ghost-dep': '^1.0.0' } }), 'utf8');
    assert.deepStrictEqual(pluginDeps.missingDeps(pkgDir, appDir), ['ghost-dep']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('ensureLocalDeps：缺失时经注入 run 补装并复检通过（action=installed）', () => {
  const { root, appDir } = makeEnv();
  try {
    const pkgDir = makePackage(path.join(appDir, 'packages'), 'sample');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'sample', dependencies: { 'ghost-dep': '^1.0.0' } }), 'utf8');
    const calls = [];
    const fakeRun = (cmd, args, opts) => {
      calls.push({ cmd, args: args.filter((a) => !a.startsWith('--')), cwd: opts.cwd });
      // 模拟 npm 安装成功：补装到插件本地 node_modules
      fs.mkdirSync(path.join(pkgDir, 'node_modules', 'ghost-dep'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'node_modules', 'ghost-dep', 'package.json'), '{"name":"ghost-dep"}', 'utf8');
      return { status: 0, stderr: '', stdout: '' };
    };
    const out = pluginDeps.ensureLocalDeps(pkgDir, appDir, { log: () => {}, run: fakeRun });
    assert.strictEqual(out.action, 'installed');
    assert.deepStrictEqual(out.missing, ['ghost-dep']);
    assert.ok(calls.length === 1 && calls[0].cwd === pkgDir, '应在插件目录本地执行 npm install');
    assert.ok(calls[0].args.includes('install'), '应带 install 参数');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('ensureLocalDeps：依赖齐备时不触发安装（action=none）', () => {
  const { root, appDir } = makeEnv();
  try {
    const pkgDir = makePackage(path.join(appDir, 'packages'), 'sample');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8');
    let ran = false;
    const out = pluginDeps.ensureLocalDeps(pkgDir, appDir, { log: () => {}, run: () => { ran = true; return { status: 0 }; } });
    assert.strictEqual(out.action, 'none');
    assert.strictEqual(ran, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('ensureLocalDeps：补装仍缺 → failed（不假装成功）', () => {
  const { root, appDir } = makeEnv();
  try {
    const pkgDir = makePackage(path.join(appDir, 'packages'), 'sample');
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ dependencies: { 'ghost-dep': '^1.0.0' } }), 'utf8');
    const out = pluginDeps.ensureLocalDeps(pkgDir, appDir, { log: () => {}, run: () => ({ status: 0, stderr: '', stdout: '' }) });
    assert.strictEqual(out.action, 'failed');
    assert.deepStrictEqual(out.missing, ['ghost-dep']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('runBootPreflight：全流程不抛错且返回汇总（环境不齐全时 ok=false）', () => {
  const { root, appDir, dshHome } = makeEnv();
  try {
    populatePackages(appDir);
    const out = preflight.runBootPreflight({ dshHome, appDir, log: () => {} });
    assert.strictEqual(typeof out.summary, 'string');
    assert.ok(out.summary.length > 0);
    const empty = preflight.runBootPreflight({ dshHome: path.join(root, 'empty-home'), appDir: path.join(root, 'empty-app'), log: () => {} });
    assert.strictEqual(empty.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log('---- summary: ' + pass + '/' + (pass + fail) + ' passed ----');
process.exit(fail > 0 ? 1 : 0);
