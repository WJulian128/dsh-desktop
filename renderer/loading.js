'use strict';

(function () {
const el = (id) => document.getElementById(id);
const d = window.dshDesktop;
if (!d) {
  el('status').textContent = '此页面需要通过桌面应用打开（预加载桥接不可用）。';
  return;
}

const PHASES = {
  starting: '正在启动 harness…',
  'waiting-server': '正在启动服务并等待就绪…',
  ready: '服务已就绪，正在加载界面…',
  error: '启动失败',
  updating: '正在更新 harness…',
};

function render(state) {
  if (!state) return;
  let status = PHASES[state.phase] || state.phase;
  if (state.updating) status = '正在更新 harness… ' + ((state.updateProgress && state.updateProgress.text) || '');
  el('status').textContent = status;
  el('meta').textContent =
    '工作区：' + (state.workspace || '—') + '\n' +
    'harness：v' + (state.installed || '…') + '\n' +
    '数据目录：' + (state.dshHome || '—');
  const failed = state.phase === 'error';
  el('spinner').hidden = failed && !state.updating;
  el('error').hidden = !failed;
  if (failed) el('error').textContent = state.error || '未知错误';
  el('retry').hidden = !failed;
}

d.onState(render);
d.getState().then(render);

el('retry').addEventListener('click', () => d.retry());
el('logs').addEventListener('click', () => d.openLogs());
el('workspace').addEventListener('click', () => d.chooseWorkspace());
})();
