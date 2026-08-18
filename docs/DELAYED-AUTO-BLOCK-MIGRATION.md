# 延迟自动 X 拉黑：商店版数据迁移

商店版和侧载版扩展 ID 不同，`chrome.storage.local` 互不相通。本功能没有图形化
导入器；如需复用商店版的本地隐藏历史，按本文手动迁移。

只迁移以下两个键，不要复制完整存储，避免带入 GitHub Token 等无关数据：

```text
xss:blocked
xss:blocklist:v2
```

## 1. 导出商店版数据

打开商店版设置页，在该页面的 DevTools Console 执行：

```js
(async () => {
  const keys = ["xss:blocked", "xss:blocklist:v2"];
  const data = await chrome.storage.local.get(keys);
  const payload = {
    schema: "mxga-local-history-v1",
    exportedAt: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `mxga-local-history-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
})();
```

导出后先禁用商店版扩展，不要让两个版本同时处理 X 页面。

## 2. 导入侧载版

打开侧载版设置页，在其 DevTools Console 执行：

```js
(() => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const payload = JSON.parse(await file.text());
    if (payload?.schema !== "mxga-local-history-v1") {
      throw new Error("不是受支持的 MXGA 本地历史文件");
    }

    const incomingBlocked = payload.data?.["xss:blocked"];
    const incomingRecords = payload.data?.["xss:blocklist:v2"];
    if (!Array.isArray(incomingBlocked) || !incomingBlocked.every((x) => typeof x === "string")) {
      throw new Error("xss:blocked 格式无效");
    }
    if (
      !Array.isArray(incomingRecords) ||
      !incomingRecords.every(
        (x) => x && typeof x === "object" && typeof x.id === "string" && typeof x.handle === "string",
      )
    ) {
      throw new Error("xss:blocklist:v2 格式无效");
    }

    const current = await chrome.storage.local.get(["xss:blocked", "xss:blocklist:v2"]);
    const blocked = [...new Set([...(current["xss:blocked"] ?? []), ...incomingBlocked])];
    const records = new Map((current["xss:blocklist:v2"] ?? []).map((x) => [x.id, x]));
    for (const row of incomingRecords) if (!records.has(row.id)) records.set(row.id, row);
    await chrome.storage.local.set({
      "xss:blocked": blocked,
      "xss:blocklist:v2": [...records.values()],
    });
    console.info(`MXGA 迁移完成：${blocked.length} 个隐藏 ID，${records.size} 条处理记录`);
  };
  input.click();
})();
```

## 3. 核对

1. 刷新侧载版设置页，核对处理记录数量；
2. 打开或刷新已登录的 X 页面；
3. 确认当前 X 账号后，再开启延迟自动拉黑；
4. 确认商店版保持禁用。

新版会在首次读取时把仅存在于 `xss:blocked`、但缺少处理记录的孤立数据重建为“自动
修复”记录。数字 ID、`h:<handle>` 和合法 handle 可以进入历史记录队列；格式无效、
无法确定 X 目标的值会保留为“无法处理”，需要在处理记录中恢复显示或人工核对。
迁移文件可能包含公开 handle、头像 URL、判定理由和触发推文快照；不要提交到 Git、
上传 GitHub 或发送给第三方，核对完成后可删除。
