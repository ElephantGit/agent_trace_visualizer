// 骨架页：证明"页面 → host → 插件进程 → 返回"桥接可用。
//
// 探测用 session/list：浏览模式不要求面板绑定会话；session/stat、session/read
// 与 parse/replay 需要绑定会话（面板从聊天打开时由 host 注入 sessionId）。

const status = document.getElementById("status");

async function probe() {
  try {
    const list = await window.ora.invoke("session/list", {});
    status.textContent = `桥接可用 ✓ 会话列表返回 ${list.entries.length} 条（浏览模式无需会话绑定）`;
  } catch (error) {
    status.textContent = `桥接探测失败：${error?.message ?? error}`;
  }
}

probe();
