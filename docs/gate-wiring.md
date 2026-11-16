# 门禁接线台账（observer）

> 立此文件的直接原因：这个仓有 4 个门禁脚本**从来没有入口** —— 不在 `package.json`、不在 CI、
> 不在 `test/`、也不被别的脚本调用。**一个没人跑的门禁是一句注释。**
>
> 本文件登记每个门禁现在**由谁触发**、跑不动时**报什么**、以及**为什么某一条故意不接 CI**。

---

## 一、接线前 / 接线后

| 脚本 | 接线前 | 接线后 |
|---|---|---|
| `type-budget.mjs` | 无入口 | `npm run check` + CI `Gates` 步（RESOURCE 包裹） |
| `check-cycles.mjs` | 无入口 | `npm run check` + CI `Gates` 步 |
| `check-readme-counts.mjs` | 无入口 | `npm run check` + CI `Gates` 步 |
| `verify-bundle-purity.mjs` | 无入口，**且裸跑必 exit 2** | `npm run check` 经 `bundle-purity-guard.mjs` 包裹 + CI `Bundle purity` 步 |
| `verify-pure-move.mjs` | 无入口 | **不接 CI 门**（见第四节，附 40 次实测）；`--self-test` 进 `npm run check` |

---

## 二、`verify-bundle-purity` 为什么需要一个包裹脚本

仪器**正确地**在两种情况下 exit 2，而在本仓这两种都是常态：

```
$ node scripts/verify-bundle-purity.mjs --before HEAD~1
VACUOUS — index.js is byte-identical at HEAD~1 and undefined; nothing to compare.   [exit 2]
```

`HEAD~1` 是本仓最近一笔 gate 修复，**没有动 `index.js`**（它只改了 `scripts/`）。CI 上每次 push
都拿 `HEAD~1` 比，绝大多数提交都属于这一类 ⇒ 裸接这一步会**每次都红**。

另一条同形状：浅克隆里 `HEAD~1` 根本不存在。

两种都是 RESOURCE（`test/v201` 与 graft-slice `docs/维护手册.md` §四的口径：**缺少资源是「跳过」，
不是「通过」**）。所以 `scripts/bundle-purity-guard.mjs` 只做一次翻译，且**必须出声**：

| 仪器 exit | 包裹脚本行为 |
|---|---|
| 0 | `PURE — …` ⇒ exit 0 |
| 1 | `BUNDLE PURITY FAILED …` ⇒ **exit 1**（真回归照样失败） |
| 2 | `RESOURCE — bundle purity NOT CHECKED this run: <原因>` ⇒ exit 0，**日志明说没检查** |

### 这个包裹脚本本身不是空转（实测三行证据）

```
$ node scripts/bundle-purity-guard.mjs --before 5d32faf~1   → exit 1
  BUNDLE NOT PURE — 2 distinct line(s) differ:
    1 -> 0   "path: () => bindingsPath,"
    1 -> 0   "setFromSnapshot: (next ) => { state = next },"

$ node scripts/bundle-purity-guard.mjs --before 0e04cd6~1   → exit 1
  BUNDLE NOT PURE — 9 distinct line(s) differ

$ node scripts/bundle-purity-guard.mjs --before 7abbd73~1   → exit 1
  BUNDLE NOT PURE — 602 distinct line(s) differ（那一笔真的搬了代码）

$ node scripts/bundle-purity-guard.mjs --before deadbeef1234 → exit 0，RESOURCE（不存在）
$ node scripts/bundle-purity-guard.mjs                      → exit 0，RESOURCE（HEAD~1 未动产物）
```

红路径可达，绿路径只在「真的比过了」时出现。

---

## 三、`type-budget` 在 CI 上是 RESOURCE，不是绿

`package.json` 声明零依赖 ⇒ CI 上没有 `typescript` ⇒ `type-budget.mjs` **exit 2**（设计如此：
「a RESOURCE condition, not a pass」）。

CI 这一步因此写成与 graft-slice 相同的形状：**exit 2 ⇒ `::warning::` + 说明「本次没检查」+ exit 0；
其它非 0 ⇒ 真失败**。本机（`D:\持久层能力架构\node_modules\typescript` 在上级目录）是真跑过的，
基线 6 → 0 见 `docs/observer-baseline-report.md`。

---

## 四、`verify-pure-move` 的处置：**没有适用对象，不是漏接线**（附实测）

派工单要求写清这一条，两个候选答案都要有证据：

**候选 A「漏了接线」** —— 如果这个仓有过纯位移提交，那么不给它入口就是漏。
**候选 B「没有适用对象」** —— 如果这个仓从未有过纯位移提交，那么给它一个 CI 入口只能产出
`VACUOUS` 或 `NOT PURE`，两种都不是它想回答的问题。

**实测（`git log` 最近 40 笔，逐笔 `--against <sha>~1`）**：

```
total=40  PURE=0  RESOURCE/VACUOUS=2  NOT-PURE=38
```

**结论：候选 B。** 依据不止是计数，而是那 38 笔的**性质**：它们是功能修复、重构、版本号、
gate 同步 —— 每一笔都在改代码。本仓唯一一次接近「搬移」的提交 `7abbd73`
（4 个只读助手搬进 `read-helpers.ts`）**同时删掉了 `observer-inject.ts`**，对 `src/` 的内容行
多重集是 460+ 行差异：它是「搬迁 + 删文件」，不是纯位移。

所以：

- **不**给它造一个假用例（派工单明确禁止），也**不**把它接成 CI 门 —— 对每一笔真实提交它
  都会红或空转，那是「每次都叫的狼」；
- 但它的**自检**进 `npm run check`：`node scripts/verify-pure-move.mjs --self-test` —— 这证明的是
  「这个判据能红」（实测：`SELF-TEST PASS`，三组用例里第二组故意制造重复行，报
  `FIRST DIFFERENCE (APPEARED: 1 → 2 occurrences)`）；
- 将来若真要做一次纯位移，跑法写在脚本头部：`node scripts/verify-pure-move.mjs --against <父提交>`；
  那天到了，把这一步接进 CI 是**一行的决定**，理由会随提交一起进历史。

> 与 `verify-bundle-purity` 的区别值得写下一句：后者比的是**产物**的内容行多重集，且它是
> 每次提交都能问的问题（「这次构建有没有改代码」）；前者比的是 `src/`，它只在**声称是搬移**
> 的提交上才有意义。这就是为什么一个接 CI、一个不接。
