// GitHub 集成模块测试（main/github.js）：
// 设备流发起/轮询解析（含 slow_down/错误）、仓库名推导、认证读写、状态汇总（注入式 transport 模拟）。
// 用法：node scripts\test-github.js
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const github = require('../main/github');

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures.push(name);
}

// 注入式 transport：按请求路径返回预设响应
const responses = {
  '/login/device/code': { status: 200, json: { device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } },
  '/login/oauth/access_token': { status: 200, json: { access_token: 'tok-1' } },
  '/user': { status: 200, json: { login: 'octocat', name: 'Octo Cat', html_url: 'https://github.com/octocat' } },
  '/user/repos': { status: 201, json: { name: 'DeepseekHarness', full_name: 'octocat/DeepseekHarness', html_url: 'https://github.com/octocat/DeepseekHarness', clone_url: 'https://github.com/octocat/DeepseekHarness.git', ssh_url: 'git@github.com:octocat/DeepseekHarness.git', private: true } },
  '/search/code?q=test%20q&per_page=10': { status: 200, json: { total_count: 2, items: [{ name: 'a.js', path: 'src/a.js', repository: { full_name: 'o/r' }, html_url: 'https://github.com/o/r/blob/main/src/a.js' }] } },
};
github.setTransportForTest(async (req) => {
  const key = req.path;
  if (!(key in responses)) return { status: 404, json: { message: 'not found' } };
  return responses[key];
});

(async () => {
  // 1. 设备流发起（不含 deviceCode 泄漏由调用方处理，这里验证解析）
  {
    const flow = await github.deviceFlowStart();
    check('deviceFlowStart parses', flow.userCode === 'ABCD-1234' && flow.verificationUri === 'https://github.com/login/device' && flow.interval === 5, JSON.stringify(flow));
  }
  // 2. 轮询：pending 与成功
  {
    responses['/login/oauth/access_token'] = { status: 200, json: { error: 'authorization_pending' } };
    const p1 = await github.deviceFlowPoll('dev-1');
    check('poll pending', p1.pending === true, '');
    responses['/login/oauth/access_token'] = { status: 200, json: { error: 'slow_down' } };
    const p2 = await github.deviceFlowPoll('dev-1');
    check('poll slowDown', p2.pending === true && p2.slowDown === true, '');
    responses['/login/oauth/access_token'] = { status: 200, json: { access_token: 'tok-1' } };
    const p3 = await github.deviceFlowPoll('dev-1');
    check('poll success', p3.pending === false && p3.token === 'tok-1', '');
    responses['/login/oauth/access_token'] = { status: 200, json: { error: 'expired_token' } };
    let threw = false;
    try { await github.deviceFlowPoll('dev-1'); } catch { threw = true; }
    check('poll expired throws', threw === true, '');
  }
  // 3. 认证读写
  {
    const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-test-'));
    check('readAuth empty -> null', github.readAuth(dshHome) === null, '');
    github.writeAuth(dshHome, { token: 'tok-x', login: 'octocat', authedAt: 1 });
    check('readAuth roundtrip', github.readAuth(dshHome).token === 'tok-x', '');
    github.clearAuth(dshHome);
    check('clearAuth removes', github.readAuth(dshHome) === null, '');
    const st0 = await github.status(dshHome);
    check('status unauthenticated', st0.authed === false, JSON.stringify(st0));
    github.writeAuth(dshHome, { token: 'tok-1', login: 'octocat', authedAt: 1 });
    const st1 = await github.status(dshHome);
    check('status authenticated', st1.authed === true && st1.login === 'octocat', JSON.stringify(st1));
    fs.rmSync(dshHome, { recursive: true, force: true });
  }
  // 4. 创建仓库 + 搜索
  {
    const repo = await github.createRepo('tok-1', { name: 'DeepseekHarness', isPrivate: true });
    check('createRepo returns urls', repo.cloneUrl.includes('octocat') && repo.isPrivate === true, JSON.stringify(repo));
    const search = await github.searchCode('tok-1', 'test q', 10);
    check('searchCode maps items', search.total === 2 && search.items[0].repository === 'o/r' && search.items[0].htmlUrl.includes('blob'), JSON.stringify(search));
  }
  // 5. 仓库名推导
  {
    check('suggestRepoName basic', github.suggestRepoName('C:\\Users\\me\\Desktop\\My-Project_1') === 'My-Project_1', '');
    check('suggestRepoName sanitize', github.suggestRepoName('C:\\bad name!') === 'bad-name', github.suggestRepoName('C:\\bad name!'));
    check('suggestRepoName empty fallback', github.suggestRepoName('') === 'workspace', '');
  }

  if (failures.length) { console.log('GITHUB FAIL: ' + failures.join(', ')); process.exit(1); }
  console.log('GITHUB OK');
})();
