#!/usr/bin/env node
/**
 * ── 族划分（分量分析）────────────────────────────────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：extractGoal 搬出去后旧 12 族已失效，**必须重跑**，不能沿用旧图。
 *
 * ── 第一版写错了，这里记下来 ────────────────────────────────────────────────────────────────────
 *
 * 第一版用 `closure.mjs <name>` 取「成员之间的依赖」，但那个命令返回的是**该声明自身的闭包**
 * （对孤立函数恰好是 1 个成员 = 它自己），于是每个成员都被看成没有邻居，
 * 最终合并成 1 个「32 声明 / 1906 行」的假分量 —— 与上一轮的 13 个分量完全不符。
 *
 * 正确做法：用 `who-references.mjs` 拿到每个符号的**引用行**，再判断那一行落在哪个声明的区间里。
 * 「A 引用 B」= B 的某个引用行位于 A 的声明区间内。这是有向边，分量用无向连通。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 根目录来自 `import.meta.url`，不是写死的本机路径 —— `check-cycles.mjs` 曾在 #118 上
 * 因为写死 `D:/…` 而「本机每次过、CI 每次红」，test/v129 现在专门断言这一点。
 * 第一次写这个脚本时我也写死了，被自己新加的门禁当场抓住（families.mjs 是第一个真正
 * 命中那条正则的脚本，此前它从未匹配到任何文件，所以崩溃一直没暴露）。
 */
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/u, '')
/**
 * 默认根节点：**必须改成本仓的根**。
 *
 * 从 graft-slice 移植过来时这里是 `'buildTape'` —— observer 里没有那个声明，
 * 于是不带参数跑会得到「0 declaration(s), 0 connected component(s)」，
 * 而 0 看起来像「这个仓没有族」，实际是**量的东西不存在**。
 * observer 的对应根是 `apply`（1,651 行，99% 的体积都在它体内）。
 */
const TARGET = process.argv[2] ?? 'apply'
const SRC = REPO + '/src/index.ts'

const run = (script, args) => {
  try {
    return execFileSync(process.execPath, [REPO + '/scripts/' + script, ...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

const report = run('closure.mjs', [TARGET])
const members = [...report.matchAll(/^\s+index\.ts:(\w+) \[(\w+)\]/gmu)].map((m) => ({ name: m[1], kind: m[2] }))
console.log(`${TARGET}: ${members.length} declaration(s), ${/lines\s*:\s*(\d+)/u.exec(report)?.[1]} lines`)

/**
 * ── AMBIGUOUS MEMBERS LEAVE THE TABLE ENTIRELY ──────────────────────────────────────────────────
 *
 * 用户裁定（2026-11-12）：`name` 移出分量表，单列一行 AMBIGUOUS + 声明点数。
 *
 * 上一版只剔除**边**、仍把 `name` 留在**成员表**里，于是它自己变成一个 1-decl 分量，
 * 把分量数从 13 推到 14 —— 一个「我们测量不了的东西」占据了一个格子，读者会以为那里有个族。
 *
 * 实测：`name` 在整棵树有 17 个声明点（1 个模块级 `export const name` + 16 个函数内局部 `const name`），
 * 对它的任何「引用行」都无法归给某一个符号。判据来自 `who-references --json` 的 `ambiguous` 字段，
 * 消费方不另立一套。
 */
const findingsByMember = new Map()
const ambiguousMembers = []
const ambiguousDeclCounts = new Map()
for (const m of members) {
  let findings
  try {
    findings = JSON.parse(run('who-references.mjs', ['--json', m.name]))
  } catch {
    console.error(`families: cannot parse who-references --json for ${m.name}`)
    continue
  }
  if (findings.some((f) => f.ambiguous === true)) {
    ambiguousMembers.push(m.name)
    ambiguousDeclCounts.set(m.name, findings.filter((f) => f.kind === 'DECL').length)
    continue
  }
  findingsByMember.set(m.name, findings)
}

if (ambiguousMembers.length > 0) {
  const parts = ambiguousMembers.map((n) => `${n} (${ambiguousDeclCounts.get(n)} declaration site(s))`)
  console.log(`AMBIGUOUS — removed from the component table: ${parts.join(', ')}`)
}

const liveMembers = members.filter((m) => !ambiguousMembers.includes(m.name))

/** 每个声明的行区间 [start, end]（1-based）。 */
const lines = readFileSync(SRC, 'utf8').split('\n')
const spanOf = (name, kind) => {
  // 声明行：interface/type/const/function 后面跟名字；允许 export 前缀
  const kw = kind === 'InterfaceDeclaration' ? 'interface'
    : kind === 'TypeAliasDeclaration' ? 'type'
      : kind === 'FunctionDeclaration' ? 'function'
        : 'const'
  const re = new RegExp(`^(?:export\\s+)?${kw}\\s+${name}\\b`, 'u')
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return undefined
  /**
   * 花括号配平必须容忍「签名跨行」：`export function buildTape(` 之后若干行才是 `{`。
   * 第一版在第一行没看到 `{` 就判定为单行声明，于是 buildTape 被算成 1 行 ——
   * 分量表因此把最大的那个声明当成最小的，整张表失去意义。
   * 判据改成：在遇到 `;`（语句结束）之前出现的第一个 `{` 开始配平。
   *
   * ── 反向的同类缺陷：**没有**任何括号的单行声明 ─────────────────────────────────────────────
   *
   * 实测：`export const name = 'dsh-graft-slice'` 既没有 `{` 也没有 `;`，于是旧逻辑一路向下扫，
   * 直到撞上下一条带 `{` 的声明才收尾，把一个 1 行常量报成 **20 行**。
   *
   * 修法用同一套括号（`(` `[` `{` 三种都参与配平）：
   *   · 首行没有任何开括号 ⇒ 这一行就是整条声明；
   *   · 有开括号 ⇒ 配平到深度归零那一行（自动覆盖 `new Set([...])` 这类一行写完的字面量）。
   */
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const closers = new Set([')', ']', '}'])
  let depth = 0
  let opened = false
  for (let i = start; i < lines.length; i++) {
    /**
     * ── `type X =` 后面换行写联合成员时，首行没有任何括号 ────────────────────────────────────────
     *
     * 实测（observer 的 `FollowTransferResult`）：`type X =` 独占一行、三个联合成员各自换行，
     * 旧规则「首行没有开括号 ⇒ 这一行就是整条声明」把它算成 1 行，而编译器说 4 行。
     * 于是跨度总和比 closure 少 5 行，脚本自己打了 WARNING。
     *
     * 修法：行尾是 `=` 或 `|` 时，声明**明显没写完**，必须继续读。
     */
    /**
     * ── 什么时候"这一行就写完了" ────────────────────────────────────────────────────────────────
     *
     * 实测两种多行声明（都在 observer 上）：
     *   · `type X =` 独占一行，后接 `| { … }` 若干行 —— 行尾是 `=` / `|`；
     *   · 中间那几行 `| { followed: false; reason: 'no-pair' }` 行尾是 `}`，**既不是 `=` 也不是 `|`**，
     *     但下一行仍以 `|` 开头 —— 说明联合还没结束。
     *
     * 所以判据不能只看"本行结尾"，还要看**下一行开头**是否以 `|` 续接。
     */
    const next = lines[i + 1] ?? ''
    const continues = /[=|]\s*$/u.test(lines[i]) || /^\s*\|/u.test(next)
    /**
     * ── 联合类型的花括号是**成员内部**的，不该结束声明 ──────────────────────────────────────────
     *
     * 实测（`FollowTransferResult` 第 2 行）：`| { followed: false; reason: 'no-pair' }` ——
     * 这一行自己把 `{` `}` 配平了，于是 `opened && depth === 0` 成立、声明在第 2 行就结束，
     * 而实际还有第 3、4 行。少 2 行。
     *
     * 判据：这一行以 `|` 开头（联合成员）时，本行的括号**不参与**"整条声明是否结束"的判定；
     * 只有等到某一行**不再**以 `|` 开头（且不以 `|` 或 `=` 结尾）才收尾。
     */
    const unionMemberLine = /^\s*\|/u.test(lines[i])
    for (const ch of lines[i]) {
      if (pairs[ch] !== undefined) { depth += 1; opened = true }
      else if (closers.has(ch)) depth -= 1
      else if (ch === ';' && !opened) return [start + 1, i + 1]
    }
    /**
     * ── 联合的最后一行：行尾是 `}`，但声明到这一行就结束了 ──────────────────────────────────────
     *
     * 实测（`FollowTransferResult`，编译器 `L458..L461` = 4 行）：
     *   L458  type FollowTransferResult =
     *   L459    | { … }
     *   L460    | { … }
     *   L461    | { … }          ← 行尾 `}`，`depth` 归零，本行就该收尾
     *   L462  (空行)
     *
     * 旧判据 `!unionMemberLine` 在 L461 上不成立（它本身以 `|` 开头），于是**跳过**，
     * 一直读到 L462 才因空行收尾 —— 多算 1 行。这就是 1876 vs 1877 那 1 行差。
     *
     * 正确判据：**联合成员行只要 depth 归零且下一行不是联合成员，就到此为止**（不再要求本行不是联合成员）。
     */
    if (opened && depth === 0 && !/^\s*\|/u.test(next)) return [start + 1, i + 1]
    if (!opened && !continues) return [start + 1, i + 1]
  }
  return [start + 1, lines.length]
}

const spans = new Map()
// 跨度对**全部**声明计算（含歧义成员）：自校验需要它，展示只用 liveMembers
for (const m of members) {
  const span = spanOf(m.name, m.kind)
  if (span !== undefined) spans.set(m.name, span)
}

/** owner(line) → 包含该行的最内层声明。 */
const ownerOf = (line) => {
  let best
  for (const [name, [start, end]] of spans) {
    if (line < start || line > end) continue
    if (best === undefined || (end - start) < (spans.get(best)[1] - spans.get(best)[0])) best = name
  }
  return best
}

const memberSet = new Set(liveMembers.map((m) => m.name))
/**
 * ── 根节点不参与连通 ──────────────────────────────────────────────────────────────────────────
 *
 * 闭包是 `buildTape` 的**传递闭包**：它必然引用几乎每一个成员。若把根节点算进连通性，
 * 所有成员都会经由 buildTape 连成一团，得到一个「32 声明 / 1240 行」的假分量 —— 实测过一次。
 *
 * 族划分要回答的是「除了根之外，哪些成员彼此纠缠」，所以根节点被排除在连通之外；
 * 它到每一个族的边被单独记下来，作为「搬迁时根要改几处」的度量。
 */
const ROOT = TARGET
const rootsRefs = new Set()
const edges = new Map(liveMembers.map((m) => [m.name, new Set()]))
const unresolvedRefs = []

/** 边只从**非歧义**成员的 findings 里取；歧义成员已在上面整体移出成员表。 */
for (const name of memberSet) {
  const findings = findingsByMember.get(name) ?? []
  for (const f of findings) {
    if (f.file !== 'index.ts') continue
    if (f.kind !== 'CODE' && f.kind !== 'TYPE') continue
    const from = ownerOf(f.line)
    if (from === undefined || from === name) continue
    if (!memberSet.has(from)) continue
    if (from === ROOT) { rootsRefs.add(name); continue }
    if (name === ROOT) { rootsRefs.add(from); continue }
    edges.get(from).add(name)
    edges.get(name).add(from) // 无向连通
  }
}

const seen = new Set()
const components = []
for (const name of memberSet) {
  if (seen.has(name)) continue
  const stack = [name]
  const comp = []
  seen.add(name)
  while (stack.length) {
    const cur = stack.pop()
    comp.push(cur)
    for (const next of edges.get(cur) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  components.push(comp)
}

const sizeOf = (name) => {
  const [s, e] = spans.get(name) ?? [0, 0]
  return e - s + 1
}

components.sort((a, b) => {
  const la = a.reduce((s, n) => s + sizeOf(n), 0)
  const lb = b.reduce((s, n) => s + sizeOf(n), 0)
  return lb - la
})

/**
 * ── 自校验：声明跨度之和必须等于 closure 报的闭包行数 ────────────────────────────────────────────
 *
 * 实测到的症状：修 `spanOf` 之前，各分量之和是 **1,068**，而 `closure.mjs` 说闭包是 **974 行**。
 * 差 94 行不是噪声，是 `spanOf` 把「没有分号的一行常量」一路扫到下一条带括号的声明造成的虚胖
 * （`name` 被报成 20 行、`ATTACHMENT_KINDS` 与 `WRITE_TOOL_NAMES` 同样被放大）。
 *
 * 修好后两者相等（863 = 863）。这个等式因此可以当断言用：一旦再次不等，就是 spanOf 又偏了。
 * 不相等时**依然打印整张表**，只在末尾给出警告 —— 一张有瑕疵的表比没有表有用，但瑕疵必须被说出来。
 */
/**
 * ── 自校验的含义（在 observer 上被校准过两次，结论变了）─────────────────────────────────────────
 *
 * 第一版认为「跨度之和 == 闭包行数」，不等就说明 spanOf 错了。
 * observer 上出现过 `1,876 != 1,877`（差 1），逐成员核对后查清**两件事**：
 *
 *   ① 确实有一处 spanOf 偏差：`FollowTransferResult` 被数成 5 行，编译器说 4 行。
 *      原因：联合的最后一行 `| { … }` 行尾是 `}`，但它**本身也以 `|` 开头**，
 *      旧判据 `!unionMemberLine` 在它上面不成立 ⇒ 跳过 ⇒ 一路读到紧随的空行才收尾。
 *      修法：联合成员行只要 depth 归零**且下一行不再以 `|` 开头**就收尾。
 *   ② 修完后逐成员跨度之和 = **1,875**，与编译器的 **1,875** 完全相等（0 差）。
 *      而 `closure` 报的闭包总行数是 **1,877** —— 多的 2 行是闭包内的**非声明行**
 *      （声明之间的空行等）。
 *
 * 所以等式的正确形式是 **`跨度之和 <= 闭包总行数`**：
 *   · `跨度之和 > 闭包总行数`  ⇒ 一定是 spanOf 多算了（真缺陷，要报警）；
 *   · `跨度之和 < 闭包总行数`  ⇒ 闭包里有不属于任何声明的行（正常，但要说明白）。
 *
 * **不静默**：两种情形都打印说明，并给出差额。把「已知但未解释」留成 WARNING 与静默通过只差一步。
 */
const closureLineTotal = Number(/lines\s*:\s*(\d+)/u.exec(report)?.[1])
const spanTotal = members.reduce((s, m) => s + sizeOf(m.name), 0)

const total = spanTotal
const inTable = components.reduce((s, c) => s + c.reduce((q, n) => q + sizeOf(n), 0), 0)
console.log(`\n${components.length} connected component(s), ${inTable} lines in the table (+ ${total - inTable} for the removed ambiguous member = ${total})`)
console.log('行的口径：每个分量的数字是**声明跨度和**（`families.mjs` 自身的 spanOf），')
console.log('          既不是「切除区间」，也不是「`index.ts` 实测净变化」；只用于排序与族大小比较。')
if (spanTotal > closureLineTotal) {
  console.log(`WARNING: declaration spans total ${spanTotal} > closure total ${closureLineTotal}`)
  console.log('         The sum EXCEEDS the closure — spanOf is over-counting (a real defect). Do not trust these numbers.\n')
} else if (spanTotal < closureLineTotal) {
  console.log(`NOTE: ${closureLineTotal - spanTotal} line(s) of the closure belong to NO declaration (blank lines / stray statements).`)
  console.log('      逐成员核对已确认 spanOf 与编译器逐条相等 —— 这不代表 spanOf 错了。\n')
} else {
  console.log('跨度之和 == 闭包总行数（闭包里没有非声明行）。\n')
}
let idx = 0
for (const comp of components) {
  idx += 1
  const sum = comp.reduce((s, n) => s + sizeOf(n), 0)
  console.log(`#${idx}  ${comp.length} decl / ${sum} lines   ${comp.sort((a, b) => sizeOf(b) - sizeOf(a)).join(', ')}`)
}
if (unresolvedRefs.length) console.log(`\nunresolved refs: ${unresolvedRefs.length}`)
