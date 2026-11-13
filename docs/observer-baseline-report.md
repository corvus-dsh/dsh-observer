# dsh-observer 基线报告（阶段 6 · 第 1 仓 · 只做仪器移植与校准）

> **本仓没有搬任何家族，也没有改任何 `src/` 代码。** 改动只在 `scripts/`、`test/`、`README.md`，
> 以及新增 `MODULE-REGISTRY.md`。
>
> 边界：不 publish、不动 `desktop` profile、不碰 memory / paradise。

---

## 一、移植了什么

| 仪器 | 来源 | 在 observer 上的状态 |
|---|---|---|
| `check-cycles.mjs` | graft-slice | ✅ 跑通，且有 **can-red 7/7** |
| `type-check.mjs` | graft-slice | ✅ 跑通，**ARTIFACT 判定改为现测**（见第三节） |
| `type-budget.mjs` | graft-slice | ✅ 基线已生成并粘贴，两张表都生效 |
| `verify-pure-move.mjs` | graft-slice | ✅ 干净树报 `VACUOUS` exit 2；`--self-test` PASS |
| `verify-bundle-purity.mjs` | graft-slice | ✅ 跑通（`--before HEAD~1` 报 VACUOUS，因两版产物相同） |
| 打包门禁 `test/pack-coverage.test.mjs` | graft-slice `v146` | ✅ 2/2 通过 |
| 模块登记门禁 `test/module-registry.test.mjs` | graft-slice `v145` | ✅ **先红后绿**：3 失败 → 建表 → 3 通过 |

**为什么模块登记表另起文件**：observer 没有 `ARCHITECTURE.md`，所以表放在 `MODULE-REGISTRY.md`
（9 个 `src/core` 模块全部登记，双向核对 + 依赖列存在性 + 光凭表不成环）。

---

## 二、runner 实测基线

```
$ node --test test/*.test.mjs
ℹ tests 215   ℹ pass 215   ℹ fail 0   ℹ skipped 0   ℹ todo 0
exit 0
```

**既有红名单：空。** 三步的数：移植前 **204** → 移植后 **209**（+5 = 模块登记 3 + 打包 2）
→ 倒置后 **215**（+3 = `test/binding-store-fs-boundary.test.mjs` 的 IO 边界三条）。
**没有任何一步引入红。**

`preflight.mjs` / `check-readme-counts.mjs` / `check-cycles.mjs` / `type-budget.mjs` / `type-check.mjs` 全部 exit 0。

**移植当场被它自己的门禁抓住两次**（同一道门禁，两次都是我忘了同步）：

- `L140 / L337 README 声明测试数 204 / 204，实测 209`；
- 倒置后同样两条报 `声明 212 / 212，实测 215`。

两次都同步了，现报 `all 7 checkable fact(s) match`。这条值得记：
**observer 原本就有一道能抓测试数的门禁**，不需要我另造。

---

## 二·补、订正：「双 Node 矩阵」我上次报错了

> **订正（2026-11-13）**：上一轮我在这份报告里写「observer 仓没有双 Node 矩阵，只有单 job」。
> **这是错的。** `ci.yml` 第 18–19 行写着 `node: [22.x, 24.x]`。

| run | sha | `total_count` | jobs | 非 success |
|---|---|---|---|---|
| 43381283071 | `abb1a8e`（本轮倒置） | **2** | `build-and-test (22.x)` success · `build-and-test (24.x)` success | **0** |
| 43375811610 | `c0d9eaf` | **2** | `build-and-test (24.x)` success · `build-and-test (22.x)` success | **0** |
| 43375302429 | `6dbd928` | **2** | `build-and-test (22.x)` success · `build-and-test (24.x)` success | **0** |

**`abb1a8e` 那次我还逐 step 核过**（光看 job 的 `conclusion` 只能证明"整段没红"）：

```
build-and-test (22.x) : 12 个 step + 4 个 post step 全 success
   9. Build                                              : success
  10. The build must not leave the committed artifact stale : success   ← 产物与 src 一致
  11. Syntax-check the shipped entry point                : success
  12. Test                                                : success
（24.x 同形）
```

第 10 步是这条 CI 真正值钱的地方：它重建后 diff，所以「我本地跑绿了但提交了旧 `index.js`」
这种失败在 CI 上直接红。本轮 `index.js` 是重建后提交的，这一步通过就是证据。

**怎么数 job —— 一句可复算的判据**（完整版见 `dsh-observer/docs/CI-JOB-判据.md`）：

> 「双 Node 绿」= `ci.yml` 的 `matrix.node` 有 2 个取值，**且**该 sha 的
> `/repos/<owner>/<repo>/actions/runs/<runId>/jobs` 返回 `total_count: 2`、
> 两个 job 名分别带 `(22.x)` 与 `(24.x)`、`conclusion` 全为 `success`、非 success 计数为 0。

**我错在哪（机制层面，不是措辞）**：我看了 runs 列表里每个 run 的 `jobs_url` 字段**存在**，
就据此判断「只有一个 job」。`jobs_url` 是一个**地址**，它的存在与 job 数量无关 ——
每个 run 都有这个字段。正确做法是取它指向的**内容**，看 `total_count`。

这属于本项目反复记录的那一族：**用「字段存在」当「内容正确」**。
同族的旧例：用「文件存在」当「安装成功」、用「跑过了」当「通过了」、用「0 条失败」当「测过了」。

---

## 三、type-check 三分法：**实测 2 + 5 + 0，不是 1 + 5 + 1**

> **本节数字随本轮两次改动变过两次，下表是最终态。三个时点都列出来，因为「数字变了」本身需要交代。**

| 时点 | 总数 | CODE HEALTH | ENVIRONMENT | ARTIFACT |
|---|---|---|---|---|
| 移植后（原始） | **7** | **2** | **5** | **0** |
| 修掉 2353 + 2345 后 | **5** | **0** | **5** | 0 |
| 倒置后（最终态） | **6** | **0** | **6** | **0** |

### 为什么倒置后 ENVIRONMENT 从 5 变 6（这 1 条要说清）

不是新缺陷，是**模块拆分把同一个 import 变成了两个文件各一份**：

| 时点 | 2307（缺 node 内置类型） | 2580（缺 `process` 全局） |
|---|---|---|
| 倒置前 | `index.ts` ×2（`node:fs`、`node:path`） | `index.ts` ×3 |
| 倒置后 | `index.ts` ×1（只剩 `node:path`）+ `binding-store.ts` ×2（`node:fs`、`node:path`） = **3** | `index.ts` ×2 + `binding-store.ts` ×1 = **3** |

`node:path` 现在被两个文件各导入一次，于是 2307 多算 1 条。**装了 `@types/node` 这 6 条会一起消失**，
所以它不是缺陷、也不该被"修"（`type-budget.mjs` 的注释里写死了这条规矩：不许改代码去消 ENVIRONMENT）。

### 每条诊断的定性（最终态）

| code | 位置 | 定性 |
|---|---|---|
| 2307 ×3 | `binding-store.ts:32,33`、`index.ts:18` | **ENVIRONMENT**：`node:fs` / `node:path` 缺类型（零依赖） |
| 2580 ×3 | `binding-store.ts:150`、`index.ts:349` ×2 | **ENVIRONMENT**：`process` 全局缺类型 |
| ~~2345~~ | ~~`index.ts:731`~~ | **已修**：`followTransfer` 改判别联合（见 §七） |
| ~~2353~~ | ~~`index.ts:1545`~~ | **已修**：`SessionAdapterLike.create` 补 `inheritFrom?`（见 §七） |

### 你问的「ARTIFACT 那 1 条是什么」—— 它不存在

`strict:{false:7, true:7}` 总数相同，说明**没有编译器口径产物**。之前 recon 表给的 1 起因于
**分类器的缺陷**，不是 observer 的代码：

- `type-check.mjs` 的 ARTIFACT 判定是**手写白名单**（`COMPILER_ARTIFACT`），里面只登记了
  graft-slice 的那一条 2339；
- observer 的 2353 不在白名单里，于是被算成 CODE HEALTH —— 这一侧是对的；
- 但按「code + **完整 message**」比对 `strict:true` 时，同一条 2353 的**措辞变了**：

```
strict:false  … does not exist in type '{ cwd: string; title?: string; id?: string; }'
strict:true   … does not exist in type '{ cwd: string; title?: string | undefined; id?: string | undefined; }'
```

所以在 strict:true 里找不到「同一个 message」，2353 被误判成 ARTIFACT，于是得到 `1 + 5 + 1`。

### 修法与等价性检验

把 observer 副本的 `isArtifact` 改成**现测**：一条诊断是 ARTIFACT ⟺ 它在 `strict:false` 下出现、
且 `strict:true` 下**同一文件同一行同一 code** 不出现（手写白名单保留，用来标「行号也会变」的特例）。

> 行号在这里可以用：两次编译针对**同一份文件、同一批行号**，行号是「同一次运行内两次编译之间的对齐键」，
> 不是「跨编辑的身份」。这与项目里反复踩到的「用行号当跨编辑身份」是两件事。

**等价性**：把同一套现测逻辑套到 graft-slice 上 ——
`35 = CODE 1 + ENV 33 + ARTIFACT 1`，与官方白名单口径**完全相同**。
所以这不是「换了标准让數字好看」，而是在 observer 上修正了一个被措辞变化骗过的判定。

**graft-slice 的分类器没有改**（那是被门禁保护的行为，改动需单独裁定）。

---

## 四、can-red 注入证明（**这是本报告最重要的一节**）

observer 的四项指标当前全是「恰好没事」的形状：**0 环、0 泄漏、类型 7 条、模块 9 个全登记**。
一个从未红过的判别器只是「还没遇到」，不是「已知可用」。所以逐项注入：

| 仪器 | 注入 | 结果 |
|---|---|---|
| `check-cycles` | ① 一条解析不到的 import；② 两个模块互 import 成真环 | **7/7 PASS**：两种都 exit 1、都点名、都说明「部分图证明不了什么」；真实树注入后仍绿 |
| `type-check` | 往副本塞 `export const broken: number = "not a number"` | PASS：诊断数上升 |
| 模块登记门禁 | 往副本加一个未登记的 `__unregistered.ts` | PASS：门禁变红并**点名该文件** |
| `type-budget` | 把基线表从 `['index.ts', 2]` 降到 `0` | PASS：表确实驱动判决（不是装饰） |
| `verify-bundle-purity` | 沙箱 git 仓库里造三版产物 | **5/5 PASS**（见下） |
| `verify-pure-move` | 沙箱 git 仓库里造位移/留副本/只改 import | **5/5 PASS**（见下） |

### 4.1 `verify-bundle-purity` 的真红（5/5）

沙箱是一个**独立 git 仓库**，脚本复制进去跑（它按自己的位置推导 REPO，所以只看沙箱）：

| 情形 | 期望 | 实际 |
|---|---|---|
| 只改 export 形态（`export function` → 裸 `export`） | **不**红 | `BUNDLE PURE` exit 0 ✓ |
| 真改一行代码（`return 2` → `return 3`） | **红** | exit 1，报 `NOT PURE` 并**指出那一行** ✓ |
| 同一个 ref 和自己比 | `VACUOUS` exit 2 | exit 2 ✓ |

### 4.2 `verify-pure-move` 的真红（5/5）

| 情形 | 期望 | 实际 |
|---|---|---|
| 真位移（同一行搬到子目录） | `IDENTICAL` | exit 0 ✓ |
| 搬走了但**留下一份副本** | **红** | exit 1，且失败原因写的是「ADDED or DUPLICATED」 ✓ |
| 只改 `import` 行 | **不**红（设计边界） | `IDENTICAL` exit 0 ✓ —— 这个缺口由 `verify-import-edges` 补，不是缺陷 |
| 工作树等于 ref | `VACUOUS` exit 2 | exit 2 ✓ |

**一次自造的假红被自己抓住**：最后一条最初 FAIL，因为我在上一情形里给文件加了 `import` 行却没恢复，
于是「工作树等于 ref」这个前提根本不成立 —— 用例本身是错的。修的是**用例**，不是仪器。

### 4.3 一次假红被自己抓住（模块登记门禁）

模块登记门禁最初「红了但原因不对」—— 测试靠 `ROOT = dirname(dirname(import.meta.url))` 找仓库根，
我把测试放在沙箱根目录，ROOT 就解析到上一层，于是报的是「表不存在」而不是「模块未登记」。
**红了不等于红对了。** 改成在沙箱里保留 `test/` 子目录层级后才算真证明。

### 4.4 IO 边界的 can-red（新增，2 条注入各 1 次真红）

`test/binding-store-fs-boundary.test.mjs` 的核心断言是「真实临时目录里**零文件**」，
所以它必须能因为「绕开注入参数直接摸真盘」而红。两种绕法各注入一次：

| 注入 | 期望红哪条 | 实际 |
|---|---|---|
| `fs.mkdirSync(...)` → 裸 `mkdirSync(...)`（**计划里最初漏掉的那个 IO 点**） | 调用序列那条 | ✖ `the fake received the exact call sequence` — 期望 4 个调用、实际少一个 `mkdirSync` ✓ |
| `fs.writeFileSync(temp, …)` → 裸 `writeFileSync(temp, …)` | **磁盘为空那条** | ✖ 三条全红，第一条就是 `no file may appear on the real disk` ✓ |

两次注入后都从备份还原并复跑 3/3 绿。

> **诚实说明一处**：第一次注入时，"磁盘为空"那条**没有红**（只红了调用序列）——
> 因为 mkdir 只是建目录，真正的文件是 write 创建的。所以两条注入是**分开的必要证据**：
> mkdir 那条只有调用序列能抓，write 那条两条都能抓。我没有拿"红了三条"去当"两条都证明了"。

---

## 五、`verify-pure-move` 这次是**红**的 —— 红在哪几行、属于哪一类

倒置是「换作用域」（函数从模块顶层搬进工厂函数体），不是平级搬家。所以工具按内容行多重集比对时**必然红**：

```
$ node scripts/verify-pure-move.mjs --against 6dbd928
ref     : 6dbd928   content lines: 4582
tree    : working   content lines: 4757

FIRST DIFFERENCE (APPEARED: 0 → 1 occurrences)
  "            at: Number(value.at) || 0,"
exit 1
```

`verify-pure-move` 只打印**第一条**（这是它的设计）。要回答"红在哪几行"，我用它**自己导出的**
`isContentLine` / `normaliseContentLine`（不另立一套口径）逐条列全并分桶：
`_scratch/pure-move-explain.mjs`，结果 **UNEXPLAINED = 0**。

| 桶 | 消失 | 新增 | 是什么 |
|---|---|---|---|
| `1-io-boundary` | 4 | 9 | 五个 fs 调用改走注入参数（**#2 的唯一目的**） |
| `2-new-module-surface` | 3 | 45 | 新模块的接口 / 工厂返回对象 / 边界类型（倒置前不存在） |
| `3-state-access` | 24 | 44 | 直接读写模块级 `state` → `store()` / mutator |
| `4-comment` | 0 | 86 | 注释随新位置（模块头、接口注释、以及删死 API 的说明） |
| `5-structural` | 0 | 15 | 花括号行（工厂内多了一层嵌套函数；多重集只数次数） |
| `6-private-helper-rename` | 7 | 9 | `isRecord` → `isPlainRecord`（**见下，这条是构建逼出来的**） |
| `7-store-accessor` | 1 | 6 | `index.ts` 的懒取 store / 路径参数化 / 快照读取 |

> 上表是 `5d32faf`（删死 API 后）的实测。`2-new-module-surface` 此前是 49，减到 45 ——
> 正好是 `setFromSnapshot` 与 `path()` 各 2 行（接口声明 + 返回对象）。

**另一个量**（`_scratch/pure-move-indent.mjs`，剥掉行首缩进后重数）：

| 口径 | 消失 | 新增 |
|---|---|---|
| 保留缩进（工具口径） | 149 | **324** |
| 剥掉缩进 | 39 | **214** |
| **纯粹由缩进造成** | **110** | **110** |

也就是说：**红的 324 行新增里有 110 行只是缩进 +2**，与内容无关。剩余部分逐条在桶里，无一条落空。
（消失侧 149 − 39 = 110 也对得上：同一批行被缩进改了，两侧各记一次。）

### `isRecord` → `isPlainRecord` 是**构建逼出来的**，不是风格选择

第一版我照抄 `index.ts` 的名字，结果 `bundle.mjs` 会把被引用模块**压平**进同一个 `index.js`：

```
SyntaxError: Identifier 'isRecord' has already been declared
→ 19 个测试文件全红
```

`tsc` 与 `node --check` 都看不见这条 —— 只有真的 `build.mjs` 一次才会炸。所以三行守卫**复制 + 改名**，
这条理由写在模块注释里，也在分桶表里占一桶。

---

## 六、倒置的实测数字（不是估算）

| 项 | 实测值 | 命令 |
|---|---|---|
| 倒置前 #2 整族 | `323 行 / mutable: [bindingsPath, state] / OUTSIDE 0` | `closure.mjs --block src/index.ts 177 499` |
| **倒置后 `binding-store.ts`** | **`345 行 / OUTSIDE 0 / mutable: none`** | `closure.mjs --block src/core/binding-store.ts 1 345` |
| `index.ts` | 2,385 → **2,235 行**（−150） | `git show <ref>:src/index.ts \| 计行` |

**`mutable: none` = 作用域变化，不是状态消失。** `closure.mjs` 只报**模块级** `let/var`；
`state` 现在是工厂闭包里的 `let`，每个 store 实例一份，而不是进程级单例。
**这条写进了提交信息**，因为读表的人若不看这句，会以为状态消失了。

### 行为等价：同一批输入，两侧 JSON 逐字段比对

倒置前的快照在 `git worktree` 检出的 `6dbd928` 那棵树上跑（`SNAPSHOT_REPO` 环境变量指过去），
两棵树吃**完全相同**的输入：

```
before keys: createBindingStoreForTest, recordPair, loadExisting, incubation, debugState, followTransfer
after  keys: createBindingStoreForTest, emptyLoad, recordPair, lookups, save, loadExisting, incubation, debugState, followTransfer

── criterion 1: behaviour fields must be IDENTICAL ──
  SAME  incubation
  SAME  debugState
  SAME  followTransfer

── criterion 2: fields that DID NOT EXIST before are now real ──
  OK    createBindingStoreForTest: placeholder→real
  OK    recordPair: placeholder→real
  OK    loadExisting: placeholder→real
  OK    emptyLoad: absent→real
  OK    lookups: absent→real
  OK    save: absent→real

── criterion 3: no unexplained keys ──
  SAME  no keys outside the two lists above

INVERSION BEHAVIOUR-EQUIVALENT
```

**两次假红被自己抓住**（都是归一化没做对，不是倒置有问题）：

1. 孵化正文里带着**随机 session id**，两侧必然不同 → 归一回 `<sessionId>`；
2. 归一只写在**比对端**、先 `slice(0,60)` 再归一 → id 被截成半截，正则匹配不到，仍然不同。
   改成**在截断之前归一**。教训：比对端的归一化挡不住"产出端已经把差异固化进字符串"。

---

## 七、两条 CODE HEALTH 已修（本轮）

| code | 修法 | can-red 证据 |
|---|---|---|
| **2353** | `SessionAdapterLike.create` 入参补 `inheritFrom?: string` + `items?`。**是类型欠账不是代码欠账** —— 调用方一直传对了 | 新增 `test/inherit-from.test.mjs`（3 条）。注入：注释掉 `inheritFrom` → 重建 → **2 条红**；恢复 → 3/3 绿 |
| **2345** | `FollowTransferResult` 改判别联合：`followed: true` 时 `role` 必为 `'main' \| 'observer'`。**没有加 `role === ''` 的运行时而变量判断** | 现有测试覆盖转移路径 |

**一处必须交代的取舍**：2345 最初用 `if (!result.followed)` 收窄，在 `strict:false` 下**不生效**
（布尔字面量在 loose 模式不参与控制流收窄），仍报 2339。改用 `if ('reason' in result)` ——
`in` 是结构化判断、不依赖 `strictNullChecks`，两个失败分支都有 `reason`、成功分支没有。
这不是绕过类型系统，是换一个**当前编译口径真的支持**的判别键。

---

## 八、结论与建议（不搬家族）

1. **仪器层在 observer 上可用**：7 件全部跑通，**6 件有 can-red 证据**（含新增的 IO 边界 2 条），
   runner **215/215** 全绿，无既有红。
2. **observer 的真实画像（最终态）**：11 个 `.ts`（`src/core` 10 个）、`index.ts` **2,235 行**、
   循环 0、类型 **0 CODE HEALTH + 6 ENV + 0 ARTIFACT**。**类型债已清零。**
3. **倒置带来的两个非零结果**：`binding-store.ts` 345 行、`OUTSIDE 0 / mutable none`；
   代价是 `index.ts` 里多了一层 `store()` 转发（21 处 `store().xxx`）—— 这是**作用域变化的账**，不是白拿。
4. **排序建议（只给依据）**：`index.ts` 仍占 **2,235 行**；但类型债已归零、绑定表已分离，
   下一个候选是 `apply` 内部那块（1,651 行）。**本轮不搬任何族。**

---

## 九、`families.mjs`：1876 vs 1877 那 1 行差 —— 查清并修掉了（不是解释掉）

你判断对：「WARNING 已经在了」不等于解释过。用 TypeScript 编译器 API 逐成员核对后，
发现差额是**两个方向相反的缺陷互相抵消**出来的：

| 缺陷 | 方向 | 行数 |
|---|---|---|
| `closure.mjs` 打印的 kind 含 `[let/var]`，而 families 的成员正则写 `\[(\w+)\]` —— **`/` 不是 `\w`**，两个模块级 `let` 整条被丢弃 | 和偏**小** | **+2** |
| `FollowTransferResult` 旧版多算 1 行（联合末行以 `|` 开头被跳过，读到空行才收尾） | 和偏**大** | **−1** |
| **合计** | | **1** |

所以那个「差 1」不是「差几个空行」，而是 **2 − 1**。上一版 NOTE 把差额解释成
「闭包内的空行 / 游离语句」——**那是错的**：闭包里那 2 行是两个 `let`。

修两处（成员正则 kind 允许 `[\w/]+`；`spanOf` 增加 `(?:let|var)` 分支）：

```
修前  1743 != 1745  →  NOTE「2 行属于非声明行」
修后  1745 == 1745  →  跨度之和 == 闭包总行数，逐成员与编译器 0 差
```

判据回到**严格相等**，不再保留 `<=`：一旦允许「少一点也正常」，这种互相抵消就永远藏得住。
那条「已知但未解释」的 NOTE 已**删除**——它不是被解释，是被修掉了。

> **这是本轮最值得记的一条**：两个 bug 只有单独修才看得见。合并成一个「差 1」，
> 它就伪装成了「一点空行」。任何「差额很小所以大概是噪声」的解释都该被这样拆开验一次。

**副作用（如实报告）**：`bindingsPath` 现在有 2 个声明点（`core/binding-store.ts:143` /
`index.ts:200`），因此进入 AMBIGUOUS 列表。族表从 6 个分量变 5 个，第 2 族由
13 声明 / 202 行缩到 5 声明 / 45 行 —— 因为绑定表实现已不在 `index.ts` 里。

---

## 十、四档预判（倒置后复跑，**不搬任何族**）

```
apply: 18 declaration(s), 1745 lines
5 connected component(s), 1718 lines in the table

#1  1 decl / 1655 lines   apply
#2  5 decl /   45 lines   followTransfer, resetBindingStore, FollowTransferResult, store, bindingStore
#3  1 decl /    8 lines   PluginContextLike
#4  1 decl /    7 lines   stageError
#5  1 decl /    3 lines   isRecord
```

> ### ⚠️ 订正：这里曾经写 `mutable: [bindingStore]`，那是**错的**
>
> 那一版我拿 `move-gate` 的一行输出当结论：
>
> ```
> B 闭包 48 行 / 13 声明 / mutable: ["bindingStore (let/var)"], ["bindingStore (let/var)","bindingsPath (let/var)"]
> ```
>
> 这是**两个分组**（每个分量各一组），我把它们读成了一个集合，于是漏掉了 `bindingsPath`。
> 用 `closure --block` 直接量同一段，实测是：
>
> ```
> mutable : ["bindingStore (let/var)","bindingsPath (let/var)"]     ← 两个 let，不是一个
> ```
>
> **#2 当时是两个模块级 `let` 挡着，不是一个。** 这正是"多字段输出被当成单值读"的老毛病。

| 族 | A 大小（跨度和） | B 闭包（`move-gate --cluster` 实测） | 预判 |
|---|---|---|---|
| **#1** `apply` | 1,655 | 根，不搬 | 根节点 |
| **#2** | 45（倒置前 201） | **49 行 / 13 声明 / `mutable: [bindingStore]`** | **仍被一个 `let` 挡住** |
| #3 `PluginContextLike` | 8 | 8 / 1 / none | 可搬（纯类型） |
| #4 `stageError` | 7 | 7 / 1 / none | 可搬 |
| #5 `isRecord` | 3 | 3 / 1 / none | 可搬 |

### `bindingsPath` 已被并入 store 实例（2026-11-14）

上一格里的 `[bindingStore]` 之所以现在成立，是因为**又做了一步**：把 `bindingsPath` 删掉。

它本来就是**纯派生值**（`config.bindingsPath` 或 `DSH_PROFILE_DIR`），唯一用途是"造 store 时喂给工厂一次"。
`createBindingStore` 已经在自己的闭包里持有它（`const bindingsPath = options.bindingsPath`），
`index.ts` 那一层没有理由再留一份。删掉之后：

```
$ node scripts/closure.mjs --block src/index.ts 199 355
block index.ts  L199..L355  (157 lines)
  local declarations      : 14
    index.ts:bindingStore [let/var] MUTABLE          ← 只剩这一个
  OUTSIDE declarations    : 1  (1 lines)
    index.ts:ObserverPair [TypeAliasDeclaration]
  total lines if moved    : 158
  mutable                 : ["bindingStore (let/var)"]
```

`bindingStore` **消不掉**，而且理由要写准：它是**对象句柄**不是常量 ——
`apply()` 要能换一个（多 profile），`debugObserverState()` 在 `apply()` 之前就要能读到。
这个二态就是 `undefined` 的意义。`bindingsPath` 没有这个二态需求，所以它能删。

**一个必须交代的副作用**：`apply()` 里原本内联了一份同样的路径表达式，抽成
`defaultBindingsPath()` 之后两处共用；否则 `type-check` 的 ENVIRONMENT 会从 6 涨到 8
（`process` 在两个位置各算一次缺类型）。抽完之后仍回到 **6 = 0 CODE HEALTH + 6 ENV + 0 ARTIFACT**。

> **两种口径别混**：`families.mjs` 的「45 行」是**声明跨度和**（只数这些声明自己占的行）；
> `move-gate --cluster` 的「49 行」是**搬迁闭包**（这些声明 + 它们必须一起带走的声明）。
> 上一版表格把跨度和填进「B 闭包」栏，已改正。

### 倒置前后同一簇的 move-gate 对照（这才是本轮真正的收益）

```
倒置前（worktree @ c0d9eaf）  load, recordPair, followTransfer, save, pairOf, writeAtomic, takeFocus
  A  153 行
  B  203 行 / 15 声明 / mutable: [bindingsPath, state]

倒置后（本仓 @ abb1a8e）      load, save, observerOf, mainOfObserver, pairOf, recordPair,
                              isObserverHalf, takeFocus, store, resetBindingStore
  A   37 行
  B   48 行 / 13 声明 / mutable: [bindingStore, bindingsPath]      ← 当时是两个，不是一个

再把 bindingsPath 并进 store 后（@ 本笔）
  A   36 行
  B   49 行 / 13 声明 / mutable: [bindingStore]
```

**闭包从 203 降到 49（−76%），可变绑定从 2 个降到 1 个。** 声明数只从 15 降到 13，
但行数大降 —— 因为拖着的那个"绑定表实现"已经不在 `index.ts` 里了。

**没有归零**：`bindingStore` 仍是模块级 `let`（必须留着，`apply()` 可能被多次调用、
且 `debugObserverState()` 在 apply 之前就要能读）。所以 #2 依然是 `REVIEW`，不是可搬候选。

**D 档（性能）也补测了**，此前是「未测」：

```
createBindingStore({bindingsPath}) x 200,000  →  147 ns/call
apply(host.ctx, {bindingsPath})    x 200      →  0.047 ms/call（含 harness 构造）
```

147 ns 是**可分辨的**（不是"测不出来"），但只占 `apply()` 的 **0.3%**，而 `apply()` 每次进程
只调 1–2 次。结论是「可分辨但可忽略」—— 与「不可分辨」不同，后者是没测到才说的话。
**这不等于"倒置没有成本"**：真正的成本是 21 处 `store().xxx` 转发的调用开销，
那部分嵌在原有热路径里，单独测出来的数不代表真实负载，所以我没有为它编一个数字。

**倒置的效果（两个口径分开说，别混）**：

| 口径 | 倒置前 | 倒置后 |
|---|---|---|
| 族 #2 **声明跨度和**（`families.mjs`） | 13 声明 / 201 行 | **5 声明 / 45 行**（22%） |
| 族 #2 **搬迁闭包**（`move-gate --cluster`，同一批函数） | 203 行 / 15 声明 | **49 行 / 13 声明**（−76%） |
| 族 #2 模块级 `mutable` | `[bindingsPath, state]` | **`[bindingStore]`** |

**这才是本轮真正的收益**：不是"族变小了"，而是**绑定表那 345 行已经不在待搬清单上** ——
它在 `core/binding-store.ts` 里，`OUTSIDE 0`、`mutable none`（见 §六）。

### #2 的可搬区间 —— 已实测（下方是**并入 `bindingsPath` 之前**的三档）

> ⚠️ 这三行 `mutable` 都是 `[bindingStore, bindingsPath]`，那是当时的事实。
> 并入之后同一段区间只剩 `[bindingStore]`（见上一节）。

```
$ node scripts/closure.mjs --block src/index.ts 199 341      # 整块（两个 let + 9 个薄壳 + 被引用的几个）
  L199..L341  (143 lines)
  local declarations : 15      OUTSIDE : 1 (1 line)
  total lines if moved : 144   mutable : [bindingStore, bindingsPath]

$ node scripts/closure.mjs --block src/index.ts 221 341      # 去掉两个 let，只搬 store() 薄壳区
  L221..L341  (121 lines)
  local declarations : 12      OUTSIDE : 3 (bindingsPath + bindingStore + 1)
  total lines if moved : 124   mutable : [bindingStore, bindingsPath]

$ node scripts/closure.mjs --block src/index.ts 199 231      # 只搬 let + store()/resetBindingStore 三件
  L199..L231  (33 lines)
  local declarations : 5       OUTSIDE : 0
  total lines if moved : 33    mutable : [bindingStore, bindingsPath]
```

**三档全都留在 `REVIEW`**，原因一致：`mutable` 里始终有 `bindingStore`。
最后一行最有意思 —— 33 行、`OUTSIDE 0`、依赖上完全自包含，**唯一卡点就是一个 `let`**。
这正是「这不是依赖不闭合，是状态没归位」的第二次验证（第一次是倒置前的整族 323 行 `OUTSIDE 0`）。

> **block 口径与 cluster 口径不同**：`--block` 数的是**一整段行区间内的声明**（所以 143 行里
> 混进了 `stageError` / `PluginContextLike` 这些不相干的东西）；`--cluster` 数的是
> **指定函数 + 它们的依赖闭包**（49 行）。判断"能不能搬"用 `--cluster`，定位"这段有多大"用 `--block`。
> 上面两张表都是脚本输出，没有一个是估的。

---

## 十一、本次改动清单

**已提交：**

```
fc6740c  feat(observer): 移植仪器层（7 件）+ can-red 全套证明 + 模块登记表
6dbd928  fix(observer): 修掉两条 CODE HEALTH，基线重冻 2 → 0
c0d9eaf  fix(observer): families 默认根与 spanOf 校准
abb1a8e  refactor(observer): #2 依赖倒置 —— 绑定表收进工厂闭包，IO 走可替换边界
5d32faf  fix(observer): 删掉我自己开的两扇无效门 —— 上一笔倒置里的死 API
```

`abb1a8e` 的 8 个文件：

```
M  src/index.ts                               （2,385 → 2,235 行；绑定表实现移出，改 21 处 store() 转发）
A  src/core/binding-store.ts                  （新模块，IO 走 BindingFsLike）
A  test/binding-store-fs-boundary.test.mjs    （3 条：真实目录零文件 / 调用序列 / 拒绝路径）
M  scripts/families.mjs                       （成员正则 let/var + spanOf 分支 + 判据改回严格相等）
M  MODULE-REGISTRY.md                         （登记 binding-store.ts）
M  README.md                                  （测试数 212→215 + 新增「绑定表住在哪」一节）
A  docs/CI-JOB-判据.md                        （怎么数 job：三步可复算）
M  index.js                                   （重建产物）
```

### `5d32faf` 之后又有一步：`bindingsPath` 并进 store（本轮最后一笔）

```
closure --block src/index.ts 199 355
  L199..L355  (157 lines)
  local declarations : 14
    index.ts:bindingStore [let/var] MUTABLE
  OUTSIDE declarations : 1  (index.ts:ObserverPair)
  total lines if moved : 158
  mutable              : ["bindingStore (let/var)"]
```

从 `["bindingStore","bindingsPath"]` 变成 `["bindingStore"]` —— **两个 let 变成一个**。
`bindingsPath` 是纯派生值，删掉它不改变任何行为（快照比对重跑仍 `BEHAVIOUR-EQUIVALENT`）。

### `5d32faf`：我自己引入的死 API，删掉而不是留着

`abb1a8e` 里我给 `BindingStore` 多写了两个成员，查调用方时发现**两个都是 0 处**：

```
store().setFromSnapshot(...)   0
store().path()                 0
```

- `setFromSnapshot(next)` 等于把 `state` 的**写权限外包**给调用方 —— 而倒置的全部意义
  就是"减少能改这张表的人"。留着它，等于自己又把那扇门打开；
- `path()` 没人读（`save()` 的返回值里已带 `path`）。

删掉后：`binding-store.ts` 文件 **352 行 / 可搬 345 行**，`OUTSIDE 0 / mutable none` 不变。
**行为等价重新跑了一遍**（没有沿用上一笔的结论）—— 参照物变了就要重新量：

```
criterion 1  SAME incubation / SAME debugState / SAME followTransfer
criterion 2  createBindingStoreForTest / recordPair / loadExisting / emptyLoad / lookups / save  全部 real
criterion 3  no unexplained keys
→ INVERSION BEHAVIOUR-EQUIVALENT
```

**顺带订正上一笔的一个数**：我在 `abb1a8e` 的提交信息里写「19 处 `store().xxx` 转发」，
实测 **21 处**（漏数了两处 `store().mutate(...)`）。两个数都已在本报告改正。

---

## 十二、未验证表（本轮结束时仍然没核的）

| 项 | 状态 |
|---|---|
| `5d32faf` 的 CI 结果 | **未取到** —— GitHub API 对本机 IP 限流（`API rate limit exceeded`），本机无 `gh`、无 `GITHUB_TOKEN`。`abb1a8e` 的双 Node 已核（run 43381283071，`total_count 2`，两 job success，12 个 step 全 success）。**这一条我不能报绿。** |
| `verify-pure-move` 在 `5d32faf` 上重跑 | **已重跑**：仍红（`FIRST DIFFERENCE: APPEARED "at: Number(value.at) || 0,"`），分桶 **UNEXPLAINED 0**，只有 `2-new-module-surface` 从 49 降到 45（删两个成员 = 4 行）。 |
| graft-slice 的 `families.mjs` 同一个 `let/var` 正则缺陷 | **已修**（2026-11-14）。成员正则 → `[\w/]+`，`spanOf` 加 `let/var` 分支，并把「差值为 0 时静默」改成明确打印。复测：`跨度之和 == 闭包总行数（870 == 870）`，逐成员与编译器 0 差。 |
| D 档性能在别的机器上是否同量级 | 未测。只有本机一个数（147 ns/call）。 |
| `#2` 的 `bindingStore` 消不掉是否真的无解 | 未验证。判断是「必须由调用方持有 store」，但没试过其它方案（如把 store 传进 `apply` 的 config）。 |

**边界**：**一个族都没搬**；不 publish、不碰 memory / paradise、不动 desktop profile。

> **两处自我更正**（都记在正文对应位置）：
> ① §二·补 订正了「无双 Node 矩阵」——那条错是我上一轮写的，依据只是 `jobs_url` 字段存在；
> ② §九 订正了「差 1 行是非声明行」——那不是解释，是两个缺陷相抵，现已修掉。
> 判据都写在文档里可复算，不再是印象。
