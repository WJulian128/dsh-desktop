// Host 半边：官方"停止"按钮联动。
//
// 用户点击对话框里的官方停止按钮（session.cancel）后，被取消回合会在会话日志
// 落盘 turn/end { reason: { kind: "aborted" } }。这里监听 session/event 检测到
// aborted 记录时，递归终止该会话树下的全部运行中子代理——否则子代理会在后台
// 继续跑，完成后通过 steering 唤醒本对话，表现为"点了停止过一会又运行"。
//
// 权限：subagents.interrupt(target, { kind: 'user', parentSessionId }) 允许非
// agent 调用方以"目标子代理的直接父会话"身份中断其当前回合（keepInbox 保留
// 队列）。子代理被中断时同样会落盘 aborted，事件级联自动覆盖孙代子代理。
export function apply(ctx) {
  ctx.on("session/event", async (session, event) => {
    try {
      if (!event || event.type !== "turn/end") return;
      const reason = event.data && event.data.reason;
      if (!reason || reason.kind !== "aborted") return; // 只有被取消（用户停止）才联动
      const sessionId = session && session.id;
      if (!sessionId) return;
      const subs = ctx.get("subagents");
      if (!subs || typeof subs.listChildren !== "function") return;
      await interruptRunningChildren(subs, sessionId, 0);
    } catch {
      // 监听失败绝不影响 harness 主流程
    }
  });
}

/** 递归终止某会话的直接运行中子代理（孙代由子代理自身的 aborted 事件级联覆盖）。 */
async function interruptRunningChildren(subs, parentSessionId, depth) {
  if (depth > 8) return; // 防御：超深树不再深入
  let children;
  try {
    children = await subs.listChildren(parentSessionId);
  } catch {
    return; // 列表不可用（如会话已销毁）直接放弃
  }
  for (const child of children || []) {
    if (!child || child.activity !== "running" || !child.id) continue;
    try {
      // user 授权：以直接父会话身份中断（仅校验 direct parent，孙代由事件级联）
      await subs.interrupt(child.id, { kind: "user", parentSessionId });
    } catch {
      // 单个失败（如已停止/权限变化）不阻断其余
    }
    // 仅对 running child 递归一层：child 自己的 aborted 事件会处理它的后代
    await interruptRunningChildren(subs, child.id, depth + 1);
  }
}
