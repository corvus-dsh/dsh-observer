# dsh-observer v1.3.0 修复报告 — 孵化落不到原目录 / 方案没注入

> 日期：2026-11-05
> 工作区：`D:\workspace\dsh-observer`
> 结论先行：**两条病因都已定位到具体代码行，并按 dsh-graft-slice 的物理注入路径重写。**
> `dsh-observer` 测试 **65 → 101 全绿**，构建**字节可复现**，`dsh-graft-slice` 542/542 未受影响。
> **需要重启宿主**（profile 以 `link:D:/workspace/dsh-observer` 装载，重启即读到新的 `index.js`）。

---

## 0. 一页纸结论

| 你的要求 | 落地情况 |
|---|---|
| 一、强制继承工作区，拿不到就拒绝创建 | ✅ 四段式 cwd 解析（header → session.cwd → workingDirectory → 持久化 header），空/相对/取不到一律抛 `CWD_REQUIRED`，**一个 id 都不预留** |
| 二、移植 graft-slice 的物理注入 | ✅ 新建 `src/core/observer-inject.ts`，`materializeTape` / `buildInjectionTape` / `assertInjectTape` / `persistence.create(header,{inheritedEventCount:0})` + `handle.append` + `flush` + `close` + 冷读校验，**逐条对应** |
| 三、外层 try/catch + 原样抛 stack + 失败回滚清垃圾 | ✅ 工具返回值带 `stage`/`code`/`error`/`stack`/`rollback`；删不掉就写 `[孵化失败]`；绑定表写失败先回滚主脑再抛错 |
| 跑通测试 | ✅ 101/101（新增 36 条专测注入内核与失败路径） |

**必须提前说清一处与指令的偏离，理由不是偏好**（详见 §3）。

---

## 1. 两条病因（都定位到行了）

### 1.1 工作区没继承

旧 `spawnMainFromObserver` 的创建调用是：

```ts
const created = await controller.create({ cwd: located.cwd })   // ← 依赖 caller 传参
```

`located` 来自 `resolveMainCwd()`，而它只查两处：`sessions.get(id).header.cwd` 与 `session.cwd`。
发起会话**不是 live** 时（例如刚重启、或它自己是冷产物），这两处都是空 → `located.cwd === ''`
→ 旧代码只是**返回一句中文**，调用方若忽略返回值，就得到一个没有归属的会话。

### 1.2 方案没注入

旧路径是 `sessionController.create()` + `sessions.get(newId).append('developer/message', …)`。
DSH 对 step-scoped 事件按**当前打开的 turn/step** 校验（`requireStep`）：

```ts
requireStep() {
  if (this.turn === null || this.step === null
      || data.turn !== this.turn || data.step !== this.step) throw …
}
```

`sessionController.create()` 建出的会话**没有打开的 turn**（`turn === null`），所以
`developer/message`（或 `{turn:0,step:0}`）**必然被拒**；旧代码把异常 `catch` 成一条提示，
于是"已孵化主脑"的回复对应着一个**只有元数据、没有方案**的会话。

> 这两个病根与《副脑插件架构复盘》里的 D3 是同一条：归属只有宿主权威；而注入必须走 store 的写入者，
> 不是 `Session.append`。

---

## 2. 代码结构

```
dsh-observer/
  src/core/observer-inject.ts   ← 新增 996 行：cwd 解析 + tap 构建 + 校验 + 写入 + 回滚
  src/index.ts                  ← 1494 行：spawn_main 改为一行 injectColdSession 调用
  scripts/bundle.mjs            ← 新增：抄自 dsh-graft-slice/scripts/bundle.mjs 的组合器
  scripts/build.mjs             ← 改为调用组合器（原来只支持单文件、拒绝相对 import）
  index.js                      ← 113,399 字节，1 个内联模块，字节可复现
```

**为什么要换打包器**：旧的 `build.mjs` 硬性规定 `src/index.ts` 不能有相对 import，
所以注入逻辑只能塞进已经 1300 行的 `index.ts`。换成 graft 同款组合器后，
`src/core/*.ts` 会被按依赖顺序内联进同一个作用域（graft 的 `index.js` 就是这么产出的），
于是"index.ts 太长就新建 observer-inject.ts"这条要求才真正成立。

---

## 3. 注入序列：一处刻意偏离，附证据

### 写入的真实顺序（`src/core/observer-inject.ts`，测试逐条断言）

| # | 事件 | turn/step | surfaceOp |
|---|---|---|---|
| 0 | `turn/start` | 1 / — | — |
| 1 | `step/start` | 1 / 1 | — |
| 2 | **`system/message`** | 1 / 1 | `append` ← 第一个 **surface 节点** |
| 3 | **`developer/message`** | 1 / 1 | `append` ← 方案 + 记忆武器库 |
| 4 | `session/title` | — | — |
| 5 | `step/end` | 1 / 1 | — |
| 6 | `turn/end` | 1 / 1，`reason:{kind:'completed'}` | — |
| 7+ | `permission/preset`、`sandbox/mode`、`approval/policy`、`model/selection` | — | — |

写入方式严格按要求：

```ts
sessions.prepare(id, { meta: { cwd } })                       // 零继承、detached
sessionPersistence.create(prepared.header, { inheritedEventCount: 0 })
handle.append(events) → handle.flush() → handle.close()
sessionQuery.readSession(id)                                  // 冷读校验
```

### 偏离：`system/message` 是第一个 **surface 事件**，但不是第一个**事件**

指令要求"第一事件：受保护的 system/message"。**按字面执行会让整条 tape 被宿主拒绝**，原因有三层：

1. `system/message` 自身携带 `{ turn, step }`，属于 step-scoped 消息。写在 `turn/start` 之前，
   写入时 `turn === null` —— 正是 §1.2 那条 `requireStep` 拒绝路径；冷读（restore）用同一套规则。
2. **真实宿主就是我这个顺序**。实测 `dsh-graft-slice/test/fixtures/real-session.v4.jsonl.zstd`
   （DSH 自己产出的 v4 日志）：`turn/start`=seq 4、`step/start`=seq 6、`system/message`=seq 7。
3. **graft 源码也是这个顺序**，并且注释写明了原因：
   `buildInjectionEvents()` 先 push `turn/start`、`step/start`，再 push system head，注释为
   "v4 restore requires the first surface node to be a protected system head"。

"受保护的 surface head"约束的是**第一个 surface 节点**，不是文件里的第一个事件。本实现满足前者，
字面顺序违反后者。已在 `assertInjectTape` 里把这条规则写成断言（`RED_LINE_SYSTEM_HEAD`），
`test/cold-inject.test.mjs` 覆盖。

---

## 4. 失败即抛出，回滚不留垃圾

### 4.1 错误一定带出真实堆栈

工具返回值新增 `stage` / `code` / `error` / `stack` / `rollback` / `warnings`，`text` 里直接贴原始堆栈。
实测输出（`_scratch/observer-failure-evidence.mjs`）：

```
================ sessionPersistence missing ================
ok       : false
stage    : persistence.create
sessionId: ""
rollback : null
孵化失败（stage=persistence.create）：[PERSISTENCE_REQUIRED] ctx.sessionPersistence.create 不可用：
没有持久化句柄就无法写出冷主脑（live append 会撞 SessionStore）
--- original stack ---
InjectError: [PERSISTENCE_REQUIRED] …
    at injectColdSession (index.js:659:11)
```

```
================ flush throws after create ================
ok       : false
stage    : flush
rollback : {"removed":false,"marked":true,
            "notes":["persistence.discardPrepared","artifact still present after every removal attempt","marked [孵化失败]"]}
孵化失败（stage=flush）：[INJECT_FAILED] ENOSPC: no space left on device
```

> 证据跑通过程中还抓到并修掉了一个自己造的缺陷：错误码被两层各加一次前缀，模型读到
> `[INJECT_FAILED] [INJECT_FAILED] ENOSPC: …`。现在只有一层加码，且有测试专门盯它。

### 4.2 回滚是"诚实"的，不是"声称成功"

```ts
// rollbackInjectedSession
discardPrepared → remove/delete → sessions.remove
然后 stat 核实：真的没了才算 removed=true
删不掉 → open() 追加 session/title:「[孵化失败] <id>」
```

旧写法只要方法**返回**就把 `removed` 置真；现在 `removed` 是**核实得来的**。
宿主没有删除接口时，报告里会写 `artifact still present after every removal attempt`。

### 4.3 绑定表不会留下悬空指针

- 绑定**只在产物存在之后**写；
- `recordPair` 在 `save()` 失败时把内存表**原样恢复**（快照/回滚），所以 `ok:false` 真的等于"什么都没发生"；
- 若绑定写失败，先 `rollbackInjectedSession(main)` 再抛 `BINDING_WRITE_FAILED` ——
  不留下"没人指向的主脑"（它永远不会跟着副脑转生）。

---

## 5. 额外修掉的三处（都是同类"看起来成了"的缺陷）

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | 标题用 `sessionId.slice(0, 8)` | 宿主 id 形如 `session-697a0c0a-…`，前 8 位是恒定前缀 `session-` —— **每个主脑标题都一样** | `shortSessionTag()` 先剥 `session-` 前缀取熵；现在是 `[主脑] 由副脑孵化 · 395b82e7` |
| 2 | 服务只用 `ctx.get()` 读 | `inject` 声明过的服务在直接属性上（graft 用的就是 `ctx.sessions.prepare`），只认一种接线会在另一种宿主上"服务缺失" | `resolveService(ctx, name, method)`：两种都看，并按**方法**挑真正可用的那个（`tools` 的直接属性可能只有 `register`，`execute` 在 `get('tools')` 上） |
| 3 | `manifest.json` 仍写 `services: [tools, sessionController]`、tools 列表缺 `observer_spawn_main` | 声明与实际不符 | 补 `sessions`/`sessionPersistence`/`sessionQuery` 与五个工具名，并把红线写进 `redLines` |

---

## 6. 验收

### 6.1 测试

```
dsh-observer      : 101 / 101 全绿   （基线 65/65）
dsh-graft-slice   : 542 / 542 全绿   （未改动，回归对照）
dsh-memory        : 248 / 248        （未改动；有 1 条并发写用例偶发失败，见 §7）
```

新增 36 条，分布在：

- `test/cold-inject.test.mjs`（24 条）：越界/开环/缺 system head 的 tape 在**预留 id 之前**被拒；
  prepared session **从不被 append**；append/flush 失败回滚并上报堆栈；无 `sessionPersistence` 时**拒绝**而非退化；
  删不掉时必须标 `[孵化失败]`；错误码只出现一次；标题取 id 熵。
- `test/host-shape.test.mjs`（4 条）：只给 `ctx.get` / 只给直接属性两种接线都能孵化成功。
- `test/incubation.test.mjs`：从"断言 create 参数"改为"断言**写入磁盘的 tape**"。
- `test/memory-scheduling.test.mjs`：改为从冷 tape 里读方案，而不是从 live append 日志读。

### 6.2 物理证据（`_scratch/observer-evidence.mjs`）

```
prepare call      : [{ id: "session-395b82e7-…", options: { meta: { cwd: "D:\\workspace" } } }]
persistence order : create → append → flush → close
inheritedEventCount: 0
seq=0  turn/start          turn=1
seq=1  step/start          turn=1 step=1
seq=2  system/message      turn=1 step=1 surfaceOp=append  role=system
seq=3  developer/message   turn=1 step=1 surfaceOp=append  role=developer  text="# 执行计划…"
seq=4  session/title       surfaceOp=-  title="[主脑] 由副脑孵化 · 395b82e7"
seq=5  step/end            turn=1 step=1
seq=6  turn/end            turn=1
--- developer message verbatim ---
IDENTICAL to the plan passed in
live sessions created by the plugin: 0
```

### 6.3 形状比对（生产日志 vs 本实现）

用真实宿主日志 `dsh-graft-slice/test/fixtures/real-session.v4.jsonl.zstd` 做 key-set 对照：

```
MATCH  turn/start        data{turn}                        vs data{turn}
MATCH  step/start        data{step,turn}                   vs data{step,turn}
MATCH  system/message    data{message,step,turn}           vs data{message,step,turn}
                         message{content,id,role,source}   vs message{content,id,role,source}
MATCH  step/end          data{step,turn}                   vs data{step,turn}
MATCH  turn/end          data{reason,turn}                 vs data{reason,turn}
surfaceOp real: append   mine: append
turn/end  real: {"turn":1,"reason":{"kind":"completed"}}
          mine: {"turn":1,"reason":{"kind":"completed"}}
```

### 6.4 构建

- `node scripts/build.mjs` 连跑两次，`index.js` **字节一致**（hash 相同）；
- `node --check index.js` 通过；
- `package.json` / `manifest.json` / `index.js` / `client.js` / 两个源文件 **均无 BOM**；
- 版本 `1.2.1 → 1.3.0`，`package.json` 与 `manifest.json` 一致。

---

## 7. 缺口与未验证项（不粉饰）

1. **没有在真机宿主上跑过一次孵化。** 上面全部是"忠实模拟 0.2.2 生命周期"的宿主夹具
   （`test/harness.mjs` 里 `prepare()` 的 `append` 会真的抛 `cannot append outside a SessionStore`）。
   真机验证必须在你重启后做一次 `observer_spawn_main`，看三件事：
   · 宿主日志出现 `[dsh-observer] incubated main … verified=true workspaceAttached=true`；
   · 侧边栏出现 `[主脑] 由副脑孵化 · <tag>` 且落在当前工作区；
   · 打开新主脑，第一条 developer 上下文里就是方案原文（不是空白）。
2. **`sessionPersistence` 的真实签名未在真机核对。** 我按 graft 已验证的调用方式写
   （`create(header, { inheritedEventCount: 0 })` + `append(events)` + `flush()` + `close()`），
   graft 542 条绿测试就是这条路径的活证据；但 dsh-observer 自己的这条路径只在夹具上跑过。
3. **`workspaceRegistry` / `emit` 仍是尽力而为**：失败只记 `warnings`，不影响孵化成功。
   若真机上侧边栏显示"未分组"，看 `text` 里的 `部分步骤未完成：未能挂到…`。
4. **`dsh-memory` 有 1 条偶发失败**（`v0.25 P1: eight PROCESSES entering at once all keep their record`，
   8 个进程并发写，偶发 7/8 行）。与本次改动无关（该仓库 `git status` 干净、本轮未触碰），
   属既有并发写用例的 flake，已在报告中记录，未擅自修改。
5. **`scripts/bundle.mjs` 是复制而非共享模块**：graft 与 observer 各有一份。
   合并成 `packages/shared` 是下一步的整理项，不在本轮范围（跨仓库改依赖会扩大风险面）。

---

## 8. 重启清单

```
1. 完全退出 DeepSeek Harness（托盘也要退，避免 Electron 主进程驻留）
2. 重新启动
3. 宿主日志确认： [dsh-observer] host version 1.3.0
4. 在一个会话里让我调用 observer_spawn_main，传入已确认的方案
5. 核对 §7.1 的三件事
```

若第 3 步仍显示 `1.2.1`，说明装载的是 `node_modules` 旧副本而非 `D:\workspace\dsh-observer` ——
profile 的 `dependencies` 里是 `link:D:/workspace/dsh-observer`，正常应直接读到新 `index.js`。
