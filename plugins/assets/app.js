// 骨架页：证明"页面 → host → 插件进程 → 返回"桥接可用。
// D5 起本文件由 SPA 构建产物替换。

const status = document.getElementById("status");

async function probe() {
  try {
    const stat = await window.ora.invoke("session/stat", {});
    const list = await window.ora.invoke("session/list", {});
    status.textContent = `桥接可用 ✓ stat=${JSON.stringify(stat)} sessions=${list.entries.length}`;
  } catch (error) {
    status.textContent = `桥接探测失败：${error}`;
  }
}

probe();
