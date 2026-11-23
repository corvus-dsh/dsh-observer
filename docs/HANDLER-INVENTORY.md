# handler-inventory · dsh-observer

> 生成物：`node scripts/handler-inventory.mjs --write`。**不要手改** —— 它每次从头扫源码。
> `facts` / `movable` / `why` 来自 `docs/handler-inventory.json`（判断，不可机械提取）。

## tool · 5

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `observer_bind` | src/index.ts:1301-1335 | 35 | 写：把一个 observer 会话绑定到一个主会话（follower 指针） | 是 | 绑定存储已是独立模块（binding-store）；这里只剩接线。 |
| 2 | `observer_create` | src/index.ts:2037-2091 | 55 | 写：创建副脑会话 + 绑定指针（经宿主 sessions.create） | 是 | 与 observer_bind 共用绑定存储；两个一起搬，否则「谁写指针」有两个所有者。 |
| 3 | `observer_consult` | src/index.ts:2098-2118 | 21 | 写：开一个未绑定的前置磋商会话 | 是 | 同上。 |
| 4 | `observer_spawn_main` | src/index.ts:2133-2273 | 141 | 写：孵化一个主脑会话并点火（sessionController.prompt）+ 记录 pair | 是 | 点火是副作用最大的一个；搬出时判据必须钉住「点火失败不算成功」（已有 probe 覆盖）。 |
| 5 | `observer_status` | src/index.ts:2275-2380 | 106 | 只读：监督态（失败连击 / 停滞轮数 / 纠偏次数 / 建图证据 / 彼岸层状态） | 是 | 纯诊断；它读的是 describeMonitorState 的产物（G-10 刚把 sawAttempt/sawWrite 都暴露出来），搬出时那个读数形状不许变。 |

## command · 1

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `observer-spawn` | src/index.ts:2008-2033 | 26 | 写：命令行入口孵化主脑（与 observer_spawn_main 同一动作的另一扇门） | 是 | 与 tool 同源；两扇门必须调同一个函数，否则「孵化」有两个实现。 |

## event · 2

| # | 名称 | 位置 | 行数 | 读/写的事实 | 可搬 | 理由 |
|---|---|---|---:|---|---|---|
| 1 | `session/event` | src/index.ts:712-793 | 82 | 读写：喂给 monitor 的事件流（tool/call、tool/result、turn/end…），并驱动纠偏决策 | 难 | monitor 是纯函数但状态由这里持有；搬出前必须先抽出「监督状态」的单一所有者。 |
| 2 | `graft/session-transferred` | src/index.ts:799-835 | 37 | 写：迁移发生时改写 follower 指针 / 监督归属 | 是 | 依赖较少，但它的指针写入必须与 binding-store 同源，否则「指针」有两个所有者。 |

## adapter-entry · 0

**这一类是 0，理由是事实：** observer 不注册 adapter 项：它经 paradise-bridge / paradise-write 两个通道与彼岸层通信，是**调用方**而不是提供方。适配层在 dsh-paradise。这一格是 0 是事实，不是漏扫。

