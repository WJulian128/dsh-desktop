'use strict';

// Office COM 通道单测（main/office-com.js）——exec 注入式，不依赖真实 Office。
// 用法：node scripts/test-office-com.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const com = require('../main/office-com');

let pass = 0;
let fail = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('PASS ' + name); pass += 1; })
    .catch((err) => { console.log('FAIL ' + name + ': ' + (err && err.message ? err.message : err)); fail += 1; });
}

(async () => {
  await check('queryAppPaths 解析 reg query 输出（两种大小写）', async () => {
    const fakeExec = (cmd, args) => {
      const key = args && args[1] || '';
      const stdout = key.includes('WINWORD')
        ? 'HKEY_LOCAL_MACHINE\\...\\App Paths\\WINWORD.EXE\n    (Default)    REG_SZ    C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE'
        : 'HKEY_LOCAL_MACHINE\\...\\App Paths\\EXCEL.EXE\n    (default)    REG_SZ    C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';
      return Promise.resolve({ stdout, stderr: '' });
    };
    const r = await com.queryAppPaths({ exec: fakeExec });
    assert.ok(r.winword.endsWith('WINWORD.EXE'));
    assert.ok(r.excel.endsWith('EXCEL.EXE'));
  });

  await check('detectOffice：注册表 + 常见路径合并（Word 可用）', async () => {
    const fakeExec = (cmd, args) => {
      const stdout = args && args[1] && args[1].includes('WINWORD')
        ? 'HKEY_LOCAL_MACHINE\\...\\WINWORD.EXE\n    (Default)    REG_SZ    C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE'
        : 'ERROR';
      if (stdout === 'ERROR') return Promise.reject(new Error('not found'));
      return Promise.resolve({ stdout, stderr: '' });
    };
    const r = await com.detectOffice({ exec: fakeExec });
    assert.strictEqual(r.word.available, true);
    assert.strictEqual(r.word.kind, 'ms-office');
  });

  await check('runWordPs：无 PowerShell 时报可读错误', async () => {
    com.setShellResolverForTest(() => null);
    try {
      const r = await com.runWordPs({ action: 'detect', ps: null });
      assert.strictEqual(r.ok, false);
      assert.ok(String(r.error).includes('PowerShell'));
    } finally {
      com.setShellResolverForTest(com.resolvePowerShell);
    }
  });

  await check('runWordPs：读脚本写出的 JSON 结果并传参正确', async () => {
    const calls = [];
    const jsonPathHolder = {};
    const fakeExec = (cmd, args, opts, cb) => {
      calls.push({ cmd, args });
      const jsonArg = args[args.indexOf('-Json') + 1];
      jsonPathHolder.p = jsonArg;
      fs.writeFileSync(jsonArg, '{"ok":true,"version":"16.0"}', 'utf8');
      cb(null, 'OK', '');
    };
    const r = await com.runWordPs({ action: 'export-pdf', inPath: 'C:\\a.docx', outPath: 'C:\\a.pdf', ps: 'pwsh.exe', exec: fakeExec });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.version, '16.0');
    assert.strictEqual(calls[0].cmd, 'pwsh.exe');
    const a = calls[0].args;
    assert.ok(a.includes('-File') && a.includes(com.SCRIPT));
    assert.ok(a.includes('-Action') && a.includes('export-pdf'));
    assert.ok(a.includes('-In') && a.includes('-Json'));
    assert.ok(fs.existsSync(jsonPathHolder.p) === false, '临时 JSON 应已清理');
  });

  await check('runWordPs：进程失败（ENOENT）转可读错误', async () => {
    const fakeExec = (cmd, args, opts, cb) => { cb(Object.assign(new Error('spawn pwsh ENOENT'), { code: 'ENOENT' }), '', ''); };
    const r = await com.runWordPs({ action: 'detect', ps: 'pwsh.exe', exec: fakeExec });
    assert.strictEqual(r.ok, false);
  });

  await check('runWordPs：超时转可读错误', async () => {
    const fakeExec = (cmd, args, opts, cb) => { cb(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), '', ''); };
    const r = await com.runWordPs({ action: 'detect', ps: 'pwsh.exe', exec: fakeExec });
    assert.strictEqual(r.ok, false);
    assert.ok(String(r.error).includes('超时'));
  });

  console.log('---- summary: ' + pass + '/' + (pass + fail) + ' passed ----');
  process.exit(fail > 0 ? 1 : 0);
})();
