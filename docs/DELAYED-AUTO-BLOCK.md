# 延迟自动 X 拉黑（个人 Chrome 构建）

本文档描述 `codex/delayed-auto-block` 分支中的个人侧载功能。第一版只验收
Chrome / Chromium，不承诺 Firefox、Safari 行为一致。

## 目标与边界

本地隐藏只影响当前扩展；X 原生拉黑由 X 账号保存，因而会在手机和其他设备上
生效。本功能把两者拆成两个阶段：账号先立即在本地隐藏，再由已登录的 X 页面
低频执行原生拉黑。

功能默认关闭。关闭开关只暂停调度，不删除队列、历史记录或已经保存的成功状态，
也不会解除 X 上已经完成的拉黑。

### 动作分流

| 原动作 | 延迟拉黑处理 |
|---|---|
| 仅标记 | 不入队 |
| 明确选择本地隐藏 | 入队 |
| X 静音 | 不入队，不升级为拉黑 |
| X 拉黑成功 | 记录成功并去重 |
| X 拉黑失败 | 入队重试 |
| 被 `autoTierMode="hide"` 安全封顶为本地隐藏 | 不入队，不绕过封顶策略 |

新记录保存结构化的请求动作、实际动作和延迟拉黑资格。旧记录没有这些字段：
明确的静音记录排除，明确的拉黑成功记录跳过，其余具有数字 userId 或合法 handle
的历史记录默认加入。这意味着少数历史状态不明账号可能被重复拉黑一次；成功状态
写入后不会继续重复。

### 目标身份

- 有数字 userId 时始终使用不可变的 `user_id`；
- 未提取到数字 ID 时，使用规范化且通过格式校验的 `screen_name`（handle）兜底；
- handle 只接受 1～15 位字母、数字和下划线，其他记录不自动处理；
- 同一 handle 后续获得数字 ID 时，队列切换到数字 ID，并继承已有成功状态以避免重复；
- 设置页会明确标出使用 handle 兜底的记录。

handle 可以改名，也可能在旧账号放弃后被其他账号重新使用。因此，很久以前且只有
handle 的历史记录无法保证仍指向当时的账号；扩展只能拉黑该 handle 的当前持有者。
额外查询 X 接口只能解析当前持有者，无法恢复原账号身份，所以本版本不增加无效的
拉黑前查询请求。

## 权限与 X 账号校验

开启开关时，扩展先检查 `x.com` / `twitter.com` 网站权限：

- 已有权限时不重复弹窗；
- 权限缺失时由 Chrome 显示授权请求；
- 用户拒绝时开关保持关闭；
- 该权限复用现有 X 静音/拉黑的 `ensureXPermission()`，不是新的 OAuth 权限。

权限用于在当前已登录的 X 页面调用 X 原生拉黑接口。扩展不保存 X 密码、Cookie
或 CSRF Token；请求直接从 X 页面发往 X，不经过项目服务器。

开启时还会自动保存最近由 X 页面识别到的当前账号 handle。每次发送前重新读取
页面当前登录账号；未登录、无法识别或 handle 不一致时立即暂停。这个轻量绑定不
是接口要求，而是防止持久队列在用户切换 X 账号后由错误账号执行。

如果需要有意更换绑定账号：先关闭开关，在目标 X 账号页面刷新一次，再回设置页
重新开启。重新开启属于明确的重新绑定操作。

## 调度和熔断

- 始终一次一个，不并发；
- 两次尝试随机间隔 45～75 秒，均值约 60 秒；
- 滚动一小时最多 60 次；
- 滚动 24 小时最多 360 次；
- 所有 POST 尝试都计数，包括失败请求；
- 多个 X 标签页通过 Web Locks 共用一个调度器；
- 页面关闭、浏览器退出或电脑休眠时暂停，下次打开匹配账号的 X 页面后继续；
- `401` / `403` 停止，必须关闭再重新开启；
- `429` 至少冷却一小时，并尊重更长的 `Retry-After`；
- 网络错误、`408` / `425` / `5xx` 最多尝试三次，退避 5 / 15 分钟；
- 其他客户端错误记为失败，不无限重试。

上述 60/小时和 360/24小时只约束延迟队列。用户明确配置的即时 X 静音/拉黑仍走
项目原有的前台限速；若目标是降低账号动作频率，应把自动类别动作设为“本地隐藏”，
再由本功能统一延迟拉黑，不要同时配置大量即时 X 动作。

X 没有公布批量拉黑的安全频率。这些限制只是降低突发请求，不能保证账号不被
限制。X 的内部网页接口也可能随时变化。

## 本地存储

主要键：

| 键 | 用途 |
|---|---|
| `xss:blocked` | 本地隐藏快速 ID 集合 |
| `xss:blocklist:v2` | 处理记录与结构化动作 |
| `xss:delayed-block:states:v2` | 数字 ID / handle 目标的队列与成功状态 |
| `xss:delayed-block:meta:v1` | 请求时间戳、暂停原因和下次运行时间 |
| `xss:settings` | 开关和绑定 handle |

旧的 `xss:delayed-block:states:v1` 数字 ID 状态会在首次队列写入时自动迁移到 v2。

卸载扩展、清除扩展数据或删除 Chrome 配置会丢失这些本地状态，但不会解除 X
服务端已经完成的拉黑。成功响应与本地写入之间如果恰好发生页面崩溃，下一次可能
重复尝试一次；不读取 X 服务端拉黑列表时无法提供严格的 exactly-once。

设置页“恢复显示”只删除本地处理记录和本地隐藏，不会解除 X 静音/拉黑。调度器
在每次发送前重新检查记录，已恢复显示的账号不会再作为待处理候选。

## 从商店版迁移旧记录

商店版与侧载版扩展 ID 不同，`chrome.storage.local` 相互隔离。只迁移下面两个键，
不要导出全部存储，避免复制 GitHub Token 等无关凭据：

```text
xss:blocked
xss:blocklist:v2
```

### 1. 从原商店扩展导出

打开原扩展设置页，在该页面的 DevTools Console 执行：

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

导出完成后先禁用原商店扩展，不要立刻卸载。

### 2. 导入侧载扩展

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

导入后刷新侧载扩展设置页，核对处理记录数量，再打开 X 页面并开启延迟拉黑。

迁移文件可能包含公开 handle、头像 URL、判定理由和触发推文快照。不要把它放进
Git 仓库、提交到 GitHub 或发送给第三方；核对完成后可删除。
