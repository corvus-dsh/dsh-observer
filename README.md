# dsh-observer — 副脑（跟随者会话）

副脑是一个与主会话**强绑定**的独立会话，但它在转生链里**不是节点**：主会话切走时，副脑只改一个指针，不参与切片、不退休。这是四轮讨论后定下的路线 A（跟随者指针），目的就是绕开「互相转生」的四个死锁循环：

1. A 退休等 B 转移、B 转移等 A 退休；
2. 两把源锁顺序不一致导致互锁；
3. 转生期间读主日志读到半截；
4. 点火 → 目标又触发自身转生。

## 边界

- **本包拥有** `observer-bindings.json`（绑定指针 + 一次性焦点请求）。
- `dsh-graft-slice` **不含任何副脑代码**，只在切片成功后广播：

```ts
ctx.emit('graft/session-transferred', { sourceSessionId, newSessionId, at })
```

- 本包监听该事件，自行把指针从旧主会话改到新主会话。两个插件之间没有 import。

## 工具

| 工具 | 作用 |
|---|---|
| `observer_create` | 为主会话创建一个副脑（普通会话 + 写入指针 + 一条 mission 消息） |
| `observer_status` | 只读查看绑定；`ackFocus: true` 消费一次性焦点请求 |

## 已知限制

- 副脑会话**不能**再成为主会话（拒绝「副脑的副脑」）；
- 焦点牵引（把窗口切到新主会话）由客户端消费 `focus` 完成，因为 `uiWorkspace` 是 Client 服务；
- 本版本尚未注册到 profile，需要时在 `cordis.patch.yml` 里加一行 `dsh-observer`。
