# dsh-observer — 副脑 / 孵化主脑

<!-- INSTALL:BEGIN -->
## 安装

两条路都可用。**按你需要选一条**，不要混装同一插件。

## 路线 A：npm registry（beta 通道）

四个包都发布在 `@corvus-dsh/*` 作用域下，当前通道是 **beta**：

```bash
dsh plugin add @corvus-dsh/dsh-paradise@beta
dsh plugin add @corvus-dsh/dsh-memory@beta
dsh plugin add @corvus-dsh/dsh-graft-slice@beta
dsh plugin add @corvus-dsh/dsh-observer@beta
```

先确认 registry 上是哪一版：

```bash
npm view @corvus-dsh/dsh-paradise@beta version
```

## 路线 B：GitHub 直装

```bash
dsh plugin add github:corvus-dsh/dsh-paradise
dsh plugin add github:corvus-dsh/dsh-memory
dsh plugin add github:corvus-dsh/dsh-graft-slice
dsh plugin add github:corvus-dsh/dsh-observer
```

## 两条路的区别（选之前先读这三行）

| | registry（路线 A） | GitHub 直装（路线 B） |
|---|---|---|
| 拿到的是什么 | **已发布、已固化**的产物 | **仓库当前状态**（可能含未发布提交） |
| 复现某版本 | 可以：`@corvus-dsh/dsh-paradise@0.9.1-beta.1` | 不可以（要 checkout 对应 tag 再装） |
| 适合 | 部署、回归、报 bug 时给出确切版本 | 跟进最新修复、本地开发 |

**顺序有意义**：`dsh-paradise` 是内核，其余三个都依赖它提供的协议。先装内核，后装业务插件。

## 装完确认

```bash
dsh plugin list
```

应该看到四行，`fiberPhase` 都是 `active`：

```
include:dsh-paradise       dsh-paradise        active
include:dsh-graft-slice    dsh-graft-slice     active
include:dsh-memory         dsh-memory          active
include:dsh-observer       dsh-observer        active
```

如果某个是 `null` 或显示「异常」，看宿主日志里该包的启动错误——最常见的原因是 Node 版本低于 22.5。

## 卸载

```bash
dsh plugin remove dsh-observer
dsh plugin remove dsh-graft-slice
dsh plugin remove dsh-memory
dsh plugin remove dsh-paradise
```

## 从源码运行（不装插件）

如果只是想跑独立宿主和 Web UI，不需要 DSH：

```bash
git clone https://github.com/corvus-dsh/dsh-paradise
cd dsh-paradise
node dist/harness-server.js
# 浏览器打开 http://127.0.0.1:38080
```

详见《星火 OS 独立运行指南》。

## 要求

| 项 | 版本 |
|---|---|
| Node | ≥ 22.5.0（`node:sqlite` 需要） |
| DSH | ≥ 0.2.1-rc.5 |
| 外部依赖 | **零**。全部只用 Node 内置模块 |

## 为什么包名带作用域

npm 上的**裸名** `dsh-memory` 和 `dsh-observer` 已被第三方注册，包内容与我们无关。
我们不愿为一个名字支付赎金，也不愿让用户装到别人的包，所以改用作用域命名
（`@corvus-dsh/*`）——**请始终用带作用域的名字**，裸名指向的不是本项目的包。
<!-- INSTALL:END -->


> **`v1.9.0`（2026-11-05）— 写路径切换到彼岸层：本插件成为 `dsh-paradise` 的第一个真实业务消费者**
>
> 孵化 = `paradise.session.create(items)` + `paradise.session.trigger`；回滚 = `paradise.deleteSession`。
> `observer-inject.ts` 曾是历史存档（写路径已迁入彼岸层）——**该文件已于 2026-11-09 删除**，其中仍被使用的只读助手已全部迁到 `src/core/read-helpers.ts`。
> 仍从它导入。**零开关、零共享状态、一条活路径**。
>
> ⚠️ **依赖性质变了**：彼岸层从"可选"变成"孵化必需"。缺层不再降级为"磁盘核对跳过"，
> 而是**拒绝孵化**并给出 `PARADISE_WRITE_UNAVAILABLE` + stage——因为写路径本身就是那一层。

## v1.9.0：三个调用点换了，回执字段一个没变

| observer 原来调用 | 现在调用 | 位置 |
|---|---|---|
| `injectColdSession(ctx, {...})` | `paradise.session.create({ cwd, title, inheritFrom, items })` | `paradise-write.ts` |
| `igniteSession(mainId, {...})` | `paradise.session.trigger(session, { text, mode })` | 同上 |
| `rollbackInjectedSession(ctx, id, why)` | `paradise.deleteSession(ctx, id, why)` | 同上 |

**回执映射是刻意保留的**：`briefingRole` / `briefingVisible` / `briefingEventSeq` / `briefingSourceKind`
全部从适配器的 `rendered[]` + `contentSeq` **推导**出来，而不是照抄请求。工具结果与既有测试读的字段没变。

### 切换中暴露的两个真实缺陷（都被测试当场抓住）

1. **协议 `create` 只接受 `title`，装不下 plan。** 第一版把 plan 当 title 传，落地成"会话里是它自己的名字"。
   → 协议 `create` 增加 `items?`，理由写进接口注释：**顺序写入的宿主上，内容必须在创建时放置**。
2. **运行时旋钮没继承。** 忘了传 `inheritFrom`，主脑会在不同 provider/model/preset 下开跑。
   → 协议 `create` 增加 `inheritFrom?`，同样写进注释。

这两个都不是"改一行调用点"能避免的——它们证明**切换本身就是一次协议检验**。

## v1.8.0：磁盘读取器迁入彼岸层

`src/core/disk-log.ts` 已删除。经 `src/core/paradise-bridge.ts` 懒加载 `dsh-paradise` 的读取器。
缺层时是**具名降级**（`pathSource: 'paradise-unavailable'`），回执 11 个字段不变。

## v1.7.0：副脑成为监理

只读监听主脑事件流；连续 3 次同工具失败或连续 5 轮不推进 TODO → **一条** steer 纠偏（三道限流）；
完成/空闲/被切片 → 后台 `memory_harvest`。决策在 `src/core/monitor.ts`（纯函数、可脱宿主测试）。

## 测试

**当前 215 / 215。** preflight 15 项，其中三项是 v1.9.0 新增的切换守卫：

- 产物里写路径必须经 `ensureWriteAdapter → createDshAdapters`；
- 缺层时必须 `PARADISE_WRITE_UNAVAILABLE`（不允许静默 no-op 或崩溃）；
- **`src/index.ts` 不得再调用任何归档的写函数**（`injectColdSession` / `rollbackInjectedSession` / `igniteSession`）。

### 测试数从 208 变 181，差额去哪了

不是能力损失，是**去处变了**：

| 原位置 | 内容 | 现在 |
|---|---|---|
| `cold-inject.test.mjs` 24 条 | tape 校验器逐条断言 | 重写为 11 条（断言**新路径**的属性）+ 迁入 paradise |
| `ignition.test.mjs` 19 条 | 点火通道内部 | 重写为 9 条（经回执断言）+ paradise `write-lifecycle` |
| `visibility.test.mjs` 4 条 | tape 形状 | 迁入 `dsh-paradise/test/shape-validation.test.mjs`（18 条） |

原则：**测试必须钉住会执行的那份代码**。钉住归档模块的测试，等于给死人做体检。

## 已知边界

1. **彼岸层现在是硬依赖。** 缺层 → 拒绝孵化（有 stage、有 code、有原因）。这是"零开关"的必然代价，也是它诚实的地方。
2. **~~`observer-inject.ts` 仍被 inlined~~ —— 已于 2026-11-09 收口。** 其中仍被使用的只读助手**已全部迁到 `src/core/read-helpers.ts`**，归档文件 `observer-inject.ts`（1,314 行）**已删除**，`bundle.mjs` 的可达性遍历不再内联它。（迁移面包含 `InjectError` / `resolveService` / `shortSessionTag` / `resolveInheritedCwd(Async)` / `isAbsoluteCwd` / `InjectContext`；此处**不计数**——数字会随实现增减而漂，`src/core/read-helpers.ts` 的 `grep '^export'` 是唯一准绳。）
3. **`inject` 只覆盖创建时放置**；向已存在会话追加仍未接线（层里如实报 `NOT_WIRED`）。
4. **graft-slice 已完成彼岸层切换**（create / 冷读校验 / 回滚 / trigger 全走 dsh-paradise）。本仓是它的下游观察者，不负责它的写入路径。

## 许可

MIT

## 历史：v1.8.0 为什么用懒加载而不是 `import`

本插件是**单文件 bundle**，composer 只内联相对模块。一句 `import ... from 'dsh-paradise'` 会活到
产物里，缺包时在 `import()` 阶段失败 —— **整个插件不激活**。v1.9.0 之后彼岸层是写路径的必需依赖，
但"必需"不等于"静态导入"：缺层时应当是**拒绝孵化并说明原因**，而不是整个插件消失。

| 规则 | 做法 |
|---|---|
| 不用静态 bare import | 运行时 `await import(specifier)`，两个候选：`dsh-paradise` → `../dsh-paradise/index.js` |
| 懒 + 缓存 | 第一次需要时解析；**失败也缓存**，不会每次调用都去探文件系统 |
| 缺层 = 具名事实 | `PARADISE_WRITE_UNAVAILABLE` + stage，读路径则是 `pathSource: 'paradise-unavailable'` |
| 回执不变 | `DiskReading → DiskLogReport`、`WriteReceipt → injected` 两处映射，用户可见字段零变化 |
| 可观测 | `observer_status` 返回 `paradise: { resolved, available, via, reason, specifiers, consequence }` |

核心原则：**「读不到」绝不能打扮成「没有」，「写不了」也绝不能打扮成「成功了」**。

> **`v1.7.0`（2026-11-05）— 副脑不再孵化完就休眠：它成为监理（supervisor）**
>
> 三段式（调研 → 卡片确认 → 孵化）与自动点火已在 v1.5/1.6 稳住。v1.7.0 补上孵化**之后**的职责：
> 只读监听主脑的事件流，连续失败或停滞时投递一条纠偏提示，节点完成/空闲/被切片时后台调用
> `memory_harvest`。决策在 `src/core/monitor.ts`（纯函数、无时钟、无服务，可脱宿主测试），
> 投递在 `src/core/supervisor.ts`。

## v1.7.0 的结构

```
src/core/monitor.ts      纯状态机：失败连击 / TODO 停滞 / 冷却 / 上限 / 提炼闸门
src/core/supervisor.ts   投递：sessionController.prompt(steer) + tools.execute(memory_harvest)
src/index.ts             接线：孵化后启动监理、切片后先提炼再重建、observer_status 暴露状态
```

### 一、失败纠偏

| 触发 | 条件 | 动作 |
|---|---|---|
| 连续失败 | **同一个工具**连续 3 次失败结果 | 发一条纠偏，建议 `memory_search` 或换方案 |
| 停滞 | 连续 5 个 `turn/end` 且 TODO 清单**没有移动** | 发一条纠偏，建议先如实更新清单 |

三道限流，缺一不可：**冷却**（5 分钟）＋ **日志距离**（≥12 个事件）＋ **硬上限**（每个主脑最多 4 次）。
"重写一份一模一样的清单"不算推进，"另一次失败前有成功"会清零连击——这两条是防误报的核心。

### 二、投递形状（这里有一条硬约束）

纠偏**不走日志写入**。`developer/message` 是 step-scoped，宿主按该会话**当前打开的 turn/step**
校验；监理无从得知那一对，而 `{turn: 0, step: 0}` 是 v1.2.2 被拒的写法本身。
所以投递走宿主自己的通道 `sessionController.prompt(request, {mode: 'steer'})`——steer 落进
**正在进行的回合**，turn/step 由宿主负责；被拒绝时退化为 `queue`（下一回合开头到达）。

### 三、后台提炼（`memory_harvest`）

| 时机 | reason | 闸门 |
|---|---|---|
| 清单全部完成 | `completed` | 同一份完成清单只提炼一次 |
| 安静 90 秒 | `idle` | 还没关闭过任何回合则跳过 |
| 主脑被切片 | `replaced` | **绕过冷却**，但每个主脑只一次 |

第三条是真正能提炼到东西的那条：`memory_harvest` 读的是交接账本里的**已退休**会话，
活着的主脑不在其中。所以回执如实说明"扫描了 N 个已退休会话，本次有没有主脑"，
而不是一律报"记忆已提炼"。

> **`v1.3.0`（2026-11-05）— 孵化改为「冷 tape 物理注入」：工作区强制继承、方案真正落盘**
>
> 上一版（1.2.x）用 `sessionController.create()` 建会话、再用 `sessions.get(id).append()` 写方案。
> 这条路在本宿主上**根本走不通**，两个后果都实测到了：工作区没继承（落到「选择工作区」孤儿页），
> 方案也没写进去（`developer/message` 是 step-scoped，新建会话没有打开的 turn，宿主直接拒绝）。

## v1.3.0 的两处手术

### 一、强制继承工作区

cwd 依次从**发起会话自己**身上取，取不到就**拒绝创建**，绝不产生孤儿会话：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `sessions.get(id).header.cwd` | 不可变的创建元数据，最权威 |
| 2 | `sessions.get(id).cwd` | live 会话直接暴露的字段 |
| 3 | `workingDirectory.get(session)` | 有效目录（含用户后来的 `cd`） |
| 4 | `sessionQuery.readSession(id).session.cwd` | 非 live 会话的持久化 header |

返回值必须通过 `isAbsoluteCwd`（盘符 / UNC / `/` 开头）。空、相对路径、取不到 —— 三者都抛
`CWD_REQUIRED`，并且**一个 id 都不会被预留**。`sessions.prepare(id, { meta: { cwd } })` 返回后还会
再校验一次 `prepared.header.cwd === cwd`（不等即 `CWD_MISMATCH`）。

### 二、移植 graft-slice 的物理注入

主脑是**冷产物**，唯一的写入者是 store 自带的句柄（与 `dsh-graft-slice` 同一套）：

```
sessions.prepare(id, { meta: { cwd } })        ← 零继承、detached，不进 live store
buildInjectTape → materializeInjectTape → assertInjectTape   ← 全在内存里校验
sessionPersistence.create(prepared.header, { inheritedEventCount: 0 })
handle.append(events) → handle.flush() → handle.close()
sessionQuery.readSession(id)                   ← 冷读校验：读回来的就是我们写进去的
```

写出的序列（写路径已迁入彼岸层，由 `dsh-paradise` 的 `adapters/dsh/inject.ts` 构建与校验；本仓测试仍逐条断言宿主侧契约）：

| # | 事件 | turn/step | surfaceOp |
|---|---|---|---|
| 0 | `turn/start` | 1 / — | — |
| 1 | `step/start` | 1 / 1 | — |
| 2 | `system/message` | 1 / 1 | `append` ← **第一个 surface 节点（受保护 head）** |
| 3 | `developer/message` | 1 / 1 | `append` ← 方案 + 武器库 |
| 4 | `session/title` | — | — |
| 5 | `step/end` | 1 / 1 | — |
| 6 | `turn/end` | 1 / 1，`reason: { kind: 'completed' }` | — |
| 7+ | `permission/preset` · `sandbox/mode` · `approval/policy` · `model/selection` | — | — |

> **关于「第一事件」的一处刻意偏离，理由不是偏好。**
> `system/message` 必须是第一个 **surface 节点**，但它不能是第一个 **事件**：它自身携带
> `{ turn, step }`，宿主按「当前打开的那对 turn/step」校验（`requireStep`），冷读也是同一套规则。
> 写在 `turn/start` 之前，等于 `turn === null` 时写一条 step-scoped 消息 —— 正是 v1.2.2 被拒的那类写入。
> 真实宿主也是这个顺序：`dsh-graft-slice/test/fixtures/real-session.v4.jsonl.zstd` 里
> `turn/start`=seq 4、`step/start`=seq 6、`system/message`=seq 7。这条规则现由彼岸层的
> `assertInjectTape`（`dsh-paradise/src/adapters/dsh/inject.ts`）写成断言，`test/cold-inject.test.mjs` 逐条覆盖。

## 失败即抛出，回滚不留垃圾

`observer_spawn_main` 的成功路径只有一条；任何一步失败都会：

1. **保留原始堆栈**原样带出（`孵化失败@<stage> [<code>]：<原始 message>` + `原始堆栈`），
   工具返回值同时给出 `ok:false` / `stage` / `error` / `stack` / `rollback`；
2. 若会话已经 `create` 过，先 **回滚**：`discardPrepared` → `remove`/`delete` → `sessions.remove`，
   并在删除后用 `stat` **核实**它真的没了（删不掉就写 `[孵化失败]` 标题，绝不留一个"看起来能用"的空壳）；
3. **绑定表只在产物存在之后写**；写失败会先把刚写的主脑回滚掉再抛错，`recordPair` 自身在
   `save()` 失败时把内存表恢复原样 —— `ok:false` 就意味着"什么都没发生"。

## 工作区里的另一半

- 冷会话通过 `workspaceRegistry.resolveByPath(cwd)` + `attachSession(id)` 挂回发起会话的分组；
- 再 `emit('api-session/added', …)` 通告客户端（Web UI 只从这个事件认识会话），
  失败都记为 `warnings`，不影响孵化成功。
- **载荷先过 `assertSessionSummary`（P1-3）**：宿主的 `assertJsonArgs` 只校验载荷可 JSON 序列化，
  **不校验 `sessionId` 是字符串**——而客户端与 `dsh-api-remotes` 都拿它当 key（`resources.session`）。
  不合格的载荷会被**跳过**并记 warning，绝不发出去：那是一个在远端静默丢弃、本地看不到任何征兆的失败。

## 工具一览

| 工具 | 作用 |
|---|---|
| `observer_spawn_main` | **孵化入口**：把已确认的方案以冷 tape 注入新主脑，本会话成为副脑 |
| `observer_create` | 反向：主脑召唤一个跟随它的副脑（走 live 路径 + 关闭骨架） |
| `observer_bind` | 为已存在的会话补写指针（手工/历史场景） |
| `observer_status` | 只读绑定表 + **每个主脑的监理状态**；`ackFocus: true` 消费一次性焦点请求 |
| `observer_consult` | 开一个不绑定主会话的「前置需求磋商副脑」 |
| `observer-spawn`（命令） | 手动入口；命令通道每次会留一行，这是该通道的固有代价 |

## 服务依赖

`inject = ['tools', 'sessionController', 'sessions', 'sessionPersistence', 'sessionQuery']`

- `sessions` / `sessionPersistence` / `sessionQuery` 是**必需**的：没有合法写入者就拒绝孵化，
  绝不退化回 live append。
- `sessionController` 现在用于给**副脑一半**改标题、给**主脑**投递纠偏（`prompt(steer)`）与点火，
  缺了只记一条警告（点火失败会写进回执，不会静默）。
- `workspaceRegistry` 保持晚绑定：headless profile 没有它，丢侧边栏分组不能代价是丢主脑。
- 服务读取统一走 `resolveService(ctx, name, method)`：同时接受 `ctx.<name>` 与 `ctx.get(name)`，
  并按**方法**挑选真正可用的那个访问器（工具注册表的直接属性可能只有 `register`，
  而 `execute` 在 `get('tools')` 上）。
- **可选依赖 `dsh-paradise`**：磁盘交叉核对经由它。缺了不影响孵化、点火、监理，只在回执里具名
  降级（见上方 v1.8.0 一节）。

## 绑定表住在哪（v1.10.0 依赖倒置）

`observer-bindings.json` 的读写**只有一处实现**：`src/core/binding-store.ts` 的 `createBindingStore()`。

```
createBindingStore({ bindingsPath, fs? }) → { load, save, snapshot, observerOf, mainOfObserver,
                                              pairOf, isObserverHalf, recordPair, takeFocus,
                                              mutate, pairs, bindLegacy, setFromSnapshot, path }
```

**为什么要有这一层**：这张表原来靠 `src/index.ts` 里两个**模块级** `let`（`bindingsPath` / `state`）工作，
于是任何「搬走这块代码」的尝试都同时搬走一个进程级单例，`closure.mjs` 直接报
`mutable: [bindingsPath, state]`。把两个 `let` 收进工厂闭包后，模块级不再有可变绑定。

> **`mutable: none` 是作用域变化，不是状态消失。** `state` 仍然存在，只是从「进程级单例」
> 变成「每个 store 实例一份」。`index.ts` 里保留一个模块级 `let bindingStore` 来记住当前实例
> （`apply()` 可能被多次调用，每次都要换成指向新 `bindingsPath` 的 store）。

**IO 边界**：所有文件系统访问走 `BindingFsLike`（`readFileSync` / `writeFileSync` / `renameSync` /
`mkdirSync` / `existsSync` 五个，**刻意收窄**）。生产路径不传 `fs` 就用 `node:fs`；
测试传一个 fake 就**完全不碰磁盘** —— `test/binding-store-fs-boundary.test.mjs` 断言
「一个完整的 `save()` 之后，真实临时目录里零文件」，并且注入裸 `node:fs` 调用会让它变红（已验证）。

## 测试

```
node scripts/build.mjs && node --test test/*.test.mjs
```

**当前：215 / 215。** 覆盖：

- **冷 tape 物理注入**（`incubation.test.mjs`）：cwd 来自发起会话 header、`persistence.create`
  带 `inheritedEventCount: 0`、事件序列与 `surfaceOp` 逐条断言、turn 必须闭合、
  冷读校验通过、通告与工作区挂载、运行时常量作为 log-only 事件跟在 turn 之后；
- **注入内核**（`cold-inject.test.mjs`）：越界/开环/无 system head 的 tape 在**预留 id 之前**就被拒；
  prepared session 从不被 `append`；append/flush 失败会回滚且堆栈原样上报；
  无 `sessionPersistence` 时**拒绝**而不退化；删不掉时必须标记 `[孵化失败]`；
- **宿主形态**（`host-shape.test.mjs`）：只给 `ctx.get` / 只给直接属性两种接线都能孵化成功；
- **记忆调度**（`memory-scheduling.test.mjs`）：武器库追加在方案之后、`semantic:false`、
  没有 dsh-memory 照样孵化；
- **监理**（`monitor.test.mjs`，27 条）：连续 3 次同工具失败/连续 5 轮不推进 TODO 各产生**一条**
  纠偏；成功清零、不同工具各自计数、重写同一份清单不算推进；冷却 + 日志距离 + 上限三道限流；
  投递走 `sessionController.prompt(steer)` 而**绝不写主脑日志**；`memory_harvest` 报告
  到底提炼了谁；切片主脑会先提炼再重建监理；重启后旧配对自动恢复监理；
- **彼岸层桥接**（`paradise-bridge.test.mjs`，14 条）：层能从同级目录解析、回执 11 个字段一个不少、
  宿主给的路径优先于推导、真实多帧文件端到端读出、**缺包降级指名道姓且不破坏孵化**、
  解析只做一次并缓存、`observer_status` 在读取发生前就能报告依赖状态、
  本地 `disk-log.ts` 确实已删除且产物里没有 bare import；
- **配对与转生**：任意一半被切片只改指针、一个会话只属一个配对、重新孵化会解散旧配对；
- **包契约**：无 BOM、版本一致、每个工具的 `output` 契约完备、schema 词汇在 Loader 子集内。

**测试专用出口（批次 3 第 1 组）：** 入口导出 16 个名字，其中 **9 个是 test seam**——
`injectionInternals`、`diskLogInternals`、`policyInternals`、`ignitionInternals`、`confirmationInternals`、
`monitorInternals`、`supervisorInternals`、`debugObserverState`、`debugFollowTransfer`。
它们**不是公开 API**：形态、名字、是否存在都不保证跨版本，改它们不算破坏性变更。
`test/test-seam-inventory.test.mjs` 把整个导出面钉成**字面量清单**，所以新增 seam 必须是有意动作——
优先折进已有的 `*Internals` 对象（多一个函数不花新名字），其次才新增顶层名字并在 commit 里写明理由。

其中 `injectionInternals` 与 `diskLogInternals` **同时是跨仓测试契约**：`dsh-paradise` 的测试套件在用，
`scripts/preflight.mjs` 还会断言 `diskLogInternals` 存在。重命名或折叠它们不是本地改动，而是**两仓 CI 的耦合**——
要做就得两边一次改完、一起推。本批次因此只做了「声明收敛 + 清单锁」，折叠作为**已计价项**记录（见源码里的 seam 边界块）。

## 配置

```yaml
- id: dsh-observer
  name: dsh-observer
  config:
    bindingsPath: "C:\\Users\\<you>\\.dsh\\profiles\\<profile>\\data\\dsh-observer\\observer-bindings.json"
```

`bindingsPath` 建议显式给出：desktop 宿主不把 `DSH_PROFILE_DIR` 传给 Electron 主进程时会回落到默认路径。

## 已知结构性限制（为什么没有按钮）

详见同级文档《副脑插件架构复盘与底层缺陷报告-2026-11-05.md》：D1 无插件自有 Remote、
D2 `commands.execute` 是广播、D3 归属只有宿主权威。因此入口是**模型工具**，不是 UI 按钮。

## 许可

MIT
