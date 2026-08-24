'use strict';
const d = window.dshDesktop;
const out = document.getElementById('out');
const input = document.getElementById('input');
const runBtn = document.getElementById('run');
const cancelBtn = document.getElementById('cancel');
let running = false;

function append(text) {
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}

if (!d) {
  append('此页面需要通过桌面应用打开（预加载桥接不可用）。\n');
  runBtn.disabled = true;
} else {
  d.onHeadlessData(({ text }) => append(text));
  d.onHeadlessExit(({ code, error }) => {
    running = false;
    runBtn.disabled = false;
    cancelBtn.disabled = true;
    append(error
      ? '\n\n[错误] ' + error + '\n'
      : '\n\n[进程已结束，退出码 ' + (code ?? '?') + ']\n');
  });
  d.getState().then((state) => {
    if (!state) return;
    document.getElementById('ws').textContent = state.workspace || '—';
    document.getElementById('meta').textContent = 'dsh --profile headless · harness v' + (state.installed || '?');
  });
}

async function run() {
  const task = input.value.trim();
  if (!task || running || !d) return;
  running = true;
  runBtn.disabled = true;
  cancelBtn.disabled = false;
  append('\n$ dsh --profile headless ' + JSON.stringify(task) + '\n\n');
  input.value = '';
  const res = await d.headlessRun(task);
  if (!res.ok) {
    running = false;
    runBtn.disabled = false;
    cancelBtn.disabled = true;
    append('\n[错误] ' + (res.error || '无法启动') + '\n');
  }
}

runBtn.addEventListener('click', run);
cancelBtn.addEventListener('click', () => d && d.headlessCancel());
document.getElementById('web').addEventListener('click', () => d && d.showMain());
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
});
