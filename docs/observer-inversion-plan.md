# #2 依赖倒置方案（立项，不动源）

> 目标族：`#2`（13 声明 / 201 行）—— observer 的**绑定表持久化层**。
> 当前 `move-gate` 报 `B: 96 行 / 7 声明 / mutable: ["bindingsPath", "state"]`，因此**不可搬**。
> 本文只给方案与预判，**不动一行源码**，也没搬任何族。

---

## 一、为什么它现在不可搬（把卡点说准）

```ts
let bindingsPath = ''                                          // L227  模块级 let
let state: ObserverBindings = { … }                             // L228  模块级 let

function load(): void           { … }      // L262  读 bindingsPath、写 state
function save(): boolean        { … }      // L323  读 bindingsPath、读 state
function writeAtomic(path, v)   { … }      // L235  唯一碰文件系统的地方
function pairOf(id)             { … }      // L350  读 state
function mainOfObserver(id)     { … }      // L338  读 state
function observerOf(id)         { … }      // L333  读 state
function recordPair(…)          { … }      // L377  读/写 state
function takeFocus()            { … }      // L493  读/写 state
const EMPTY / EMPTY_STATE                   // L225/L260  空表字面量
```

**卡点不是"函数多"，而是它们共享两个模块级 `let`。** 搬走任何一个函数，都必须把 `state`
和 `bindingsPath` 一起带走；而这两个又被剩下的函数共用 ⇒ 闭包从 53 涨到 96 行 7 声明。

这正是 `move-gate` 的 B 档在报的东西：`mutable: [...]` 不是"注意一下"，是**停止信号**。

---

## 二、两个方案

### 方案 A：工厂闭包（`createBindingStore(path)` 返回一组成员函数）

```ts
// src/core/binding-store.ts（新模块）
export interface BindingStore {
  load(): void
  save(): boolean
  pairOf(sessionId: string): ObserverPair | undefined
  mainOfObserver(observerSessionId: string): string | undefined
  observerOf(mainSessionId: string): string | undefined
  recordPair(main: string, observer: string, origin: Origin): { ok: boolean }
  takeFocus(): { sessionId: string; at: number } | null
  snapshot(): ObserverBindings          // 只读访问，给 status 用
}

export function createBindingStore(options: {
  bindingsPath: string
  fs?: { readFileSync; writeFileSync; renameSync }   // ← 可替换的边界
}): BindingStore {
  let state: ObserverBindings = EMPTY_STATE()        // ← let 进闭包，不再模块级
  function load() { … }                              //    任何函数都能读写 state
  …
  return { load, save, pairOf, mainOfObserver, observerOf, recordPair, takeFocus, snapshot }
}
```

**改动面**：

| 位置 | 改什么 |
|---|---|
| 新增 `src/core/binding-store.ts` | 7 个函数 + 2 个类型 + 1 个 `let`（进闭包） |
| `src/index.ts` 的 `apply` | 建一次 `const store = createBindingStore({ bindingsPath })`，把裸调用改成 `store.load()` 等 |
| 所有读 `state` 的地方（`observer_status` 等） | 改成 `store.snapshot()` |
| 测试 | 现有测试通过 `apply()` 间接触达，**基本不受影响**；新测试可 `createBindingStore({bindingsPath, fs: fake})` 直接单测 |

**优点**：`let` 被封进闭包 ⇒ `move-gate` 的 B 档 `mutable` 变 `none`；调用方只依赖 `BindingStore`
接口，不依赖实现。**缺点**：`apply` 里要建 store，`apply` 的闭包会变大（但 `apply` 是根，本来就不搬）。

### 方案 B：显式上下文对象（把 `state` 当参数传）

```ts
export interface BindingCtx { bindingsPath: string; state: ObserverBindings; fs: FsLike }
export function load(ctx: BindingCtx): void
export function save(ctx: BindingCtx): boolean
export function pairOf(ctx: BindingCtx, id: string): ObserverPair | undefined
…
```

**改动面**：每个函数加一个 `ctx` 参数；**每个调用点都要改**（`apply` 内约 20 处 + 测试若干）。
没有 `let`、没有闭包，`mutable` 也是 `none`。

**优点**：最"纯"，函数是普通函数，可逐个单测、可逐个搬。**缺点**：改动面最大（所有调用点），
且调用方必须自己持有 `state` —— 也就是**把可变状态推给了调用者**，`apply` 里会出现
`const ctx = { bindingsPath, state: EMPTY_STATE(), fs }`，等于把问题挪了个位置。

### 选择：**方案 A**

理由：① 改动面小（`apply` 内是「加一次构造 + 改调用形式」，不是「每个调用点加参数」）；
② `state` 不再暴露给调用者（方案 B 会把它推出去）；③ 工厂天然带一个**可替换的 `fs` 边界**，
正好满足下一条要求。

---

## 三、IO 必须留在可替换的边界上（硬要求）

用户要求：**`load()` 的读盘与 `writeAtomic()` 的写盘必须留在可替换的边界上，否则测试会开始碰真实磁盘。**

方案 A 的做法：`createBindingStore({ bindingsPath, fs })` 的 `fs` 参数是**唯一的 IO 入口**：

```ts
/** 本模块用到的**全部** IO。刻意收窄：给的越少，实现越难偷偷承担别的事。 */
type BindingFsLike = {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  renameSync(from: string, to: string): void
  mkdirSync(path: string, options: { recursive: true }): void   // ← 见下，这条最初漏了
  existsSync(path: string): boolean
}
```

- 生产路径：`createBindingStore({ bindingsPath })` ⇒ 默认用 `node:fs`；
- 测试路径：`createBindingStore({ bindingsPath, fs: fakeFs })` ⇒ **完全不碰磁盘**。

`writeAtomic` 的 temp+rename 语义保持不变（它是"读者永远看不到半份文档"的保证），
只是三个系统调用走 `fs` 而不是直接 import。

### `mkdirSync` 是**计划里漏掉的第五个 IO 点**

本方案第一版只参数化了 `read / write / rename` 三个。但 `save()` 里在写之前还有一句：

```ts
mkdirSync(dirname(bindingsPath), { recursive: true })
```

它**不参数化就会绕过边界**：真实 fs 的 mkdir 会真的把目录建出来，
于是"测试断言真实临时目录零文件"这条会**失效**（目录不是文件，`readdirSync` 看不到它，
但边界已经破了）。落地时补进 `BindingFsLike`，并由 `test/binding-store-fs-boundary.test.mjs`
的调用序列断言钉住 —— 注入裸 `mkdirSync` 会让那条断言变红（已验证）。

**这条必须是硬约束，不能靠自觉**：`test/binding-store-fs-boundary.test.mjs` 三条：
① 真实临时目录**零文件**（`readdirSync` 后断言空 + 目标文件不存在 + 临时残留不存在）；
② fakeFs 收到**精确的调用序列**（`readFileSync → mkdirSync → writeFileSync → renameSync`，且 mkdir 带 `recursive: true`）；
③ 一个"全部拒绝"的 fs 让 `save()` 失败并**回滚内存状态**（错误路径也不能绕边界）。

---

## 四、倒置后的闭包与 mutable（**实测，不是估算**）

脚本 `_scratch/observer-inversion-measure.mjs`（只读源码，不改任何东西）。
**注意：这是「当前形态」的实测基线。倒置之后的数字只能在落地后用同一命令复测 ——
本文不预测那个数，因为预测值一旦写进文档就会变成"抄来的数"（母本上已经踩过 4 次数错）。**

### 实测：当前形态（倒置前）

| 区间 | `total if moved` | 模块级 mutable | OUTSIDE |
|---|---|---|---|
| **整个 #2 族**（`L177..L499`，从 `ObserverBindings` 到 `takeFocus`） | **323 行** | `["bindingsPath", "state"]` | **0** |
| 仅 `load`（`L262..L314`） | 59 行 | `["bindingsPath", "state"]` | 4：`EMPTY_STATE`, `bindingsPath`, `isRecord`, `state` |
| `save` + `writeAtomic`（`L225..L331`） | 135 行 | `["bindingsPath", "state"]` | 1：`ObserverBindings` |
| `pairOf` + `mainOfObserver` + `observerOf`（`L333..L354`） | 32 行 | `["state"]` | 2：`ObserverPair`, `state` |

**这张表最有信息量的一行是第一行**：整个 #2 族的 `OUTSIDE` 是 **0** ——
也就是说它**在依赖上已经是自包含的**，唯一挡住它的是那两个模块级 `let`。
换句话：**这不是"依赖不闭合"，是"状态没归位"**，所以倒置（把 `let` 收进工厂）就够了，
不需要拆函数、不需要重新分层。

### 倒置后的实测（**已落地，2026-11-13**）

```
$ node scripts/closure.mjs --block src/core/binding-store.ts 1 345
block core/binding-store.ts  L1..L345  (345 lines)
  local declarations      : 8
  OUTSIDE declarations    : 0  (0 lines)
  total lines if moved    : 345
  mutable                 : none
```

| 项 | 倒置前 | 倒置后（实测） |
|---|---|---|
| `total lines if moved` | 323（#2 整族） | **345**（整个新模块，含两个 export interface 与 IO 边界声明） |
| `mutable` | `["bindingsPath", "state"]` | **`none`** |
| `OUTSIDE declarations` | 0 | **0** |
| `src/index.ts` 行数 | 2,385 | **2,235**（−150） |

**形状三条全部成立**，且 `total` 比计划里说的"≈模块自身行数"更严格地等于它 —— 因为 `OUTSIDE 0`。

### 关于 `mutable` 归零的前提（这一条必须说清）

`closure.mjs` 的 `mutable` 列只报**模块级** `let/var`。方案 A 把 `state` 移进工厂函数体后，
它就不再是模块级的，于是报 `none`。

**这不是钻口径空子**：闭包内的 `let` 与模块级 `let` 在"能不能搬"上确实不同 ——
前者随工厂实例走、一个实例一份；后者是进程级单例。提交信息里写明这一句，
否则读表的人会以为"状态消失了"，实际只是从模块级搬进了闭包。

**代价值得单独记**：`index.ts` 里现在有 **19 处 `store().xxx`** 转发（每个原模块级函数一个薄壳 + 调用点）。
这是"状态归位"的账，不是白拿 —— 但如果将来有人看到 19 处转发就想再收一层，
要记得收掉它只会把 `let` 逼回模块级。

### 四档预判 vs 落地实测（对照）

| 档 | 预判 | 落地实测 | 对/错 |
|---|---|---|---|
| **A 大小** | YES | 345 行（文件 352 行，含 IO 边界接口） | ✓ |
| **B 闭包** | `OUTSIDE 0 / mutable none` | `OUTSIDE 0 / mutable none` | ✓ |
| **C1 一句话** | YES | 「把绑定表读进内存、原子写回磁盘」 | ✓ |
| **C2 调用者** | 0 生产 / 多个测试 | 生产 1 处（`apply`）+ 新测试 1 文件直连 | ✓ |
| **C3 outside** | 应变 YES | OUTSIDE 0 | ✓ |
| **C4 容器局部** | YES（0） | 0 | ✓ |
| **D 性能** | 未测 | **构造 147 ns/次；apply() 0.047 ms/次** | ✓ 可分辨但可忽略 |

**D 档的实测口径**（这台机器，Node 24.21.0）：

```
createBindingStore({bindingsPath}) x 200,000  →  147 ns/call
apply(host.ctx, {bindingsPath})    x 200      →  0.047 ms/call   （含 harness 构造）
```

147 ns 是**可分辨的**（不是"测不出来"），但相对 `apply()` 0.047 ms 是 **0.3%**，
而 `apply()` 每次进程只调 1–2 次（多 profile 时略多）。所以结论是「可分辨但可忽略」，
不是「不可分辨」—— 两者不同，后者是没测到才说的话。

**这个数说明的是"构造很便宜"，不是"整个倒置没有成本"**：真正的成本是 `index.ts` 里
19 处 `store().xxx` 转发（每处一次函数调用 + 一次 undefined 判断）。那部分没有单独测，
因为它嵌在原有的调用热路径里，分离出来测出来的数也不代表真实负载。

---

## 六、纪律（用户明确要求）

1. **不许在倒置的同时夹带行为改动。** `can-red` 的参照是"倒置前 vs 倒置后行为完全相同"；
   一旦混进行为改动，`verify-pure-move` 与差分测试都失去参照。
   所以倒置必须满足：**同一批输入下，`load/save/recordPair/pairOf/takeFocus` 的输出逐字段相同**。
2. **`writeAtomic` 的 temp+rename 语义不变**（它是原子性的保证，不是实现细节）。
3. **`fs` 边界是唯一的 IO 入口**，生产路径与测试路径只差这一个参数。
4. 落地时用 `closure.mjs --block` **复测**，与本文的预测值对照；不一致就说明预测错了，以实测为准。

---

## 七、边界

不 publish、不碰 memory / paradise、**没搬任何族**。本文原为立项文档（`src/` 零改动）；
**2026-11-13 已按方案 A 落地**，落地后本文补了「实测」与「预判 vs 实测」两节，
`src/` 的改动只有：绑定表移入 `src/core/binding-store.ts` + `index.ts` 改 19 处 `store()` 转发。
