/**
 * ── 绑定表持久化层（从 index.ts 倒置出来的工厂）──────────────────────────────────────────────
 *
 * 为什么要这一步：`index.ts` 里这张表原本靠两个**模块级** `let`（`bindingsPath` / `state`）
 * 工作，于是搬任何一个函数都要把它们一起带走 —— `closure.mjs` 报 `mutable: [bindingsPath, state]`，
 * 按判据那不是"闭包"，是"共享状态"，因此不可搬。
 *
 * 倒置的做法：把两个 `let` 收进**工厂闭包**，调用方只依赖返回的接口。
 * 于是模块级不再有可变绑定（`closure.mjs` 的 `mutable` 归 `none`）——
 * **这是作用域变化，不是状态消失**：`state` 仍然存在，只是从进程级单例变成每个 store 实例一份。
 *
 * ── 被搬代码的逐字保真 ──────────────────────────────────────────────────────────────────────────
 *
 * 函数体、注释、命名、对象字面量的换行方式**全部照抄** `index.ts` 里的原文（含 `isRecord` /
 * `EMPTY_STATE` 这些名字）。只有两类行是有意不同的，且都记在下面对应位置：
 *
 *   1. 整体缩进 +2（它们现在在工厂函数体里）；
 *   2. 四个 `node:fs` 调用改成 `fs.`（IO 边界这一件事，见下）。
 *
 * 这样做的理由不是洁癖：`verify-pure-move` 是本轮唯一能证明"没有夹带行为改动"的机器判据，
 * 它按内容行多重集比对。多一个顺手改名，红里就多一条与倒置无关的噪声，判据就从"证据"退化成"印象"。
 *
 * ── IO 边界 ────────────────────────────────────────────────────────────────────────────────────
 *
 * 所有文件系统访问走 `BindingFsLike`，它**刻意收窄**到本模块真正用到的五个方法
 * （read / write / rename / mkdir / exists）。收窄的理由：给的越少，实现越难偷偷承担别的事，
 * 测试也越容易构造。`writeAtomic` 的 temp+rename 语义原样保留 —— 它是"读者永远看不到半份文档"的保证。
 *
 * `mkdirSync` 也必须走边界：它曾被漏掉一次，而真实 fs 的 mkdir 会重建目录，
 * 于是"测试断言真实目录零文件"这条会失效。`test/binding-store-fs-boundary.test.mjs` 钉住这一点。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ObserverBindings {
  /** mainSessionId -> observerSessionId */
  bindings: Record<string, string>
  /** observerSessionId -> mainSessionId */
  reverse: Record<string, string>
  /**
   * A one-shot focus request, left by a transfer.
   *
   * v1.0.4 NOTE: with every client state read removed, nothing consumes this any more. It is kept
   * because it is one durable fact about a handoff (and `observer_status` can still read it), not
   * because something currently acts on it.
   */
  focus: { sessionId: string; at: number } | null
  /**
   * v1.2.0 — THE PAIR, STORED BOTH WAYS WITH ROLES.
   *
   * The first design stored `main -> observer` and its inverse, which is enough to answer "who
   * follows whom" but not "which half is which". Incubation inverts the roles at runtime (a blank
   * session becomes the OBSERVER, and the session it hatches becomes the MAIN), so the role has to
   * be a stored fact rather than something re-derived from position.
   *
   * One row per PAIR, keyed by the pair's own stable key, so a transfer can rewrite the members
   * without touching the role assignment.
   */
  pairs: Record<string, ObserverPair>
  /** sessionId -> pair key. A session belongs to at most one pair. */
  pairOf: Record<string, string>
}

export interface ObserverPair {
  /** The session that plans, monitors and hands off. */
  observerSessionId: string
  /** The session that does the work. */
  mainSessionId: string
  at: number
  /** Where the plan came from, so a later reader knows how the pair was formed. */
  origin: 'incubated' | 'summoned'
}

/**
 * 本模块用到的**全部** IO。刻意不用 `typeof import('node:fs')` ——
 * 那会把几十个方法都暴露给实现，测试也无法断言"只用了这几个"。
 */
export interface BindingFsLike {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  renameSync(from: string, to: string): void
  mkdirSync(path: string, options: { recursive: true }): void
  existsSync(path: string): boolean
}

const nodeFs: BindingFsLike = { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync }

/**
 * ── 为什么这个三行守卫要**复制**，而不是从 index.ts 导入 ──────────────────────────────────────
 *
 * 它是 `index.ts` 里 `isRecord` 的逐字副本，只改了名字。两个理由：
 *
 *   1. 从 `core/` 反向 import `../index.js` 会和 index.ts 形成环 —— `check-cycles.mjs` 就是为这个存在的；
 *   2. 更硬的一条：`scripts/bundle.mjs` 把被引用的模块**压平**进同一个 `index.js`。
 *      两处同名 `function isRecord` 在扁平化后变成 `SyntaxError: Identifier 'isRecord' has already been declared`，
 *      而这条错误在 `tsc` 与 `node --check src/*.ts` 里都看不见 —— 只有真的构建一次才会炸。
 *      （这不是推测：我第一版就叫 `isRecord`，构建后 19 个测试文件全红，报的就是这个错。）
 *
 * 所以名字不同**不是风格选择**，是 bundle 扁平化的硬约束。三行代码重复，换一个不会崩的构建。
 */
function isPlainRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const EMPTY_STATE = (): ObserverBindings => ({ bindings: {}, reverse: {}, focus: null, pairs: {}, pairOf: {} })

/** Stable key for a pair. Order-independent, so a role swap cannot orphan the row. */
function pairKeyOf(a: string, b: string): string {
  return [a, b].sort().join('|')
}

/**
 * 工厂对外的全部接口。函数名与签名与 `index.ts` 早先的模块级函数一致 ——
 * 这是"调用点一行都不用改"的前提。
 */
export interface BindingStore {
  load(): void
  save(): { ok: boolean; path: string; error?: string }
  snapshot(): ObserverBindings
  observerOf(mainSessionId: string): string
  mainOfObserver(observerSessionId: string): string
  pairOf(sessionId: string): ObserverPair | undefined
  isObserverHalf(sessionId: string): boolean
  recordPair(observerSessionId: string, mainSessionId: string, origin: ObserverPair['origin']): { ok: boolean; error?: string; dissolved?: number }
  takeFocus(): { sessionId: string; at: number } | null
  setFromSnapshot(next: ObserverBindings): void
  /**
   * 在**同一份状态**上做一次受控改写，然后由调用方决定是否 `save()`。
   *
   * 为什么需要它：`followTransfer` 要一次性改 `pairs` / `pairOf` / `reverse` / `bindings` / `focus`
   * 五处，逐个提供 setter 会把一个原子操作拆成五次调用，中间还能被读到半成品。
   * 传一个 mutator 进去，语义与"直接改模块级 state"完全一致，但 `state` 本身不再暴露。
   */
  mutate(fn: (state: ObserverBindings) => void): void
  /** 只读地遍历 pairs（`Object.values(state.pairs)` 的替身）。 */
  pairs(): ObserverPair[]
  /** 旧式单写映射（title 派生绑定用）：`state.bindings[main] = observer; state.reverse[obs] = main`。 */
  bindLegacy(mainSessionId: string, observerSessionId: string): void
  path(): string
}

export function createBindingStore(options: { bindingsPath: string; fs?: BindingFsLike }): BindingStore {
  const bindingsPath = options.bindingsPath
  const fs = options.fs ?? nodeFs

  let state: ObserverBindings = { bindings: {}, reverse: {}, focus: null, pairs: {}, pairOf: {} }

  /** Atomically write a file: temp + rename, so a reader never sees half a document. */
  function writeAtomic(path: string, value: unknown): void {
    const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(temp, path)
  }

  function load(): void {
    // Start from empty on EVERY load: the module-level state must describe THIS file, and a
    // mount that reuses a previous process-level copy would leak bindings across profiles
    // (and across tests).
    state = EMPTY_STATE()
    try {
      const parsed = JSON.parse(fs.readFileSync(bindingsPath, 'utf8'))
      if (!isPlainRecord(parsed)) return
      const next = EMPTY_STATE()
      if (isPlainRecord(parsed.bindings)) {
        for (const [main, observer] of Object.entries(parsed.bindings)) {
          if (typeof observer === 'string' && observer.length > 0) next.bindings[main] = observer
        }
      }
      if (isPlainRecord(parsed.reverse)) {
        for (const [observer, main] of Object.entries(parsed.reverse)) {
          if (typeof main === 'string' && main.length > 0) next.reverse[observer] = main
        }
      }
      if (isPlainRecord(parsed.focus) && typeof parsed.focus.sessionId === 'string') {
        next.focus = { sessionId: parsed.focus.sessionId, at: Number(parsed.focus.at) || 0 }
      }
      // v1.2.0 — the pair table. A row is only accepted when both members are non-empty strings and
      // they differ: a self-pair would make every role question answer "both".
      if (isPlainRecord(parsed.pairs)) {
        for (const [key, value] of Object.entries(parsed.pairs)) {
          if (!isPlainRecord(value)) continue
          const observerSessionId = typeof value.observerSessionId === 'string' ? value.observerSessionId : ''
          const mainSessionId = typeof value.mainSessionId === 'string' ? value.mainSessionId : ''
          if (observerSessionId.length === 0 || mainSessionId.length === 0) continue
          if (observerSessionId === mainSessionId) continue
          next.pairs[key] = {
            observerSessionId,
            mainSessionId,
            at: Number(value.at) || 0,
            origin: value.origin === 'summoned' ? 'summoned' : 'incubated',
          }
        }
      }
      if (isPlainRecord(parsed.pairOf)) {
        for (const [sessionId, key] of Object.entries(parsed.pairOf)) {
          if (typeof key !== 'string' || key.length === 0) continue
          if (next.pairs[key] === undefined) continue // no dangling index
          next.pairOf[sessionId] = key
        }
      }
      // `missions` / `missionsSent` from 1.0.2–1.0.3 are deliberately NOT read: the staged-injection
      // design is gone, and a legacy key must not resurrect it.
      state = next
    } catch {
      // Absent (first run) or torn: start empty. A stale pointer is repairable; a crash is not.
    }
  }

  /**
   * Persist the binding table. Returns false when the file could NOT be written.
   *
   * v0.1.8 P0: this used to swallow the error, which is how a reply of `{ok:true}` reached the
   * UI while `observer-bindings.json` had not been touched. A caller must be able to tell the
   * difference between "stored" and "only in memory", so the failure is reported upward.
   */
  function save(): { ok: boolean; path: string; error?: string } {
    try {
      fs.mkdirSync(dirname(bindingsPath), { recursive: true })
      writeAtomic(bindingsPath, state)
      return { ok: true, path: bindingsPath }
    } catch (error) {
      return { ok: false, path: bindingsPath, error: String((error as any)?.message ?? error) }
    }
  }

  function observerOf(mainSessionId: string): string {
    const observer = state.bindings[mainSessionId]
    return typeof observer === 'string' ? observer : ''
  }

  function mainOfObserver(observerSessionId: string): string {
    const main = state.reverse[observerSessionId]
    return typeof main === 'string' ? main : ''
  }

  /* ── v1.2.0: the pair table ─────────────────────────────────────────────────── */

  function pairOf(sessionId: string): ObserverPair | undefined {
    const key = state.pairOf[sessionId]
    if (key === undefined) return undefined
    return state.pairs[key]
  }

  /**
   * Record (or re-record) a pair, keeping the legacy one-way maps in step for old readers.
   *
   * v1.2.3 — THE INVARIANT IS ENFORCED HERE, NOT ASSUMED.
   *
   * The first version wrote `pairs[key]` and overwrote `pairOf[member]`, but left every PREVIOUS row
   * that named the same session in `pairs`. Incubating three times from one consulting session
   * therefore produced three rows sharing an observer, and `pairOf` kept only the newest — a state
   * where "which pair does this session belong to?" had three answers.
   *
   * A re-record now DISSOLVES the older pairs first: any row naming either member is removed, along
   * with its index entries. One session, one pair, always.
   *
   * v1.3.0 — A FAILED WRITE IS NOT ALLOWED TO LEAVE A POINTER IN MEMORY.
   *
   * `save()` can fail (an unwritable path, a full disk). The old version returned `ok:false` and
   * left the mutated `state` in place, so the running process believed a pair existed that the file
   * had never heard of — `observer_status` would answer with it, and the next `load()` would erase
   * it. The state is now snapshotted before any mutation and restored verbatim on failure, so
   * `ok:false` really means "nothing happened".
   */
  function recordPair(
    observerSessionId: string,
    mainSessionId: string,
    origin: ObserverPair['origin'],
  ): { ok: boolean; error?: string; dissolved?: number } {
    if (observerSessionId.length === 0 || mainSessionId.length === 0 || observerSessionId === mainSessionId) {
      return { ok: false, error: 'pair members must be two distinct non-empty session ids' }
    }

    const before = JSON.stringify(state)
    let dissolved = 0
    for (const [existingKey, existing] of Object.entries(state.pairs)) {
      const sharesMember =
        existing.observerSessionId === observerSessionId ||
        existing.observerSessionId === mainSessionId ||
        existing.mainSessionId === observerSessionId ||
        existing.mainSessionId === mainSessionId
      if (!sharesMember) continue
      delete state.pairs[existingKey]
      for (const member of [existing.observerSessionId, existing.mainSessionId]) {
        if (state.pairOf[member] === existingKey) delete state.pairOf[member]
      }
      // The legacy maps are pointers INTO a pair; a dissolved pair must not leave them dangling.
      if (state.bindings[existing.mainSessionId] === existing.observerSessionId) {
        delete state.bindings[existing.mainSessionId]
      }
      if (state.reverse[existing.observerSessionId] === existing.mainSessionId) {
        delete state.reverse[existing.observerSessionId]
      }
      dissolved += 1
    }

    const key = pairKeyOf(observerSessionId, mainSessionId)
    state.pairs[key] = { observerSessionId, mainSessionId, at: Date.now(), origin }
    state.pairOf[observerSessionId] = key
    state.pairOf[mainSessionId] = key
    // Legacy maps, kept so `observer_status` and older readers see the same world.
    state.bindings[mainSessionId] = observerSessionId
    state.reverse[observerSessionId] = mainSessionId
    const written = save()
    if (written.ok) return { ok: true, dissolved }
    // Restore EXACTLY what was there: a half-dissolved table is worse than an unchanged one.
    state = JSON.parse(before)
    return { ok: false, error: written.error }
  }

  /** True when the session is the OBSERVER half of a pair. */
  function isObserverHalf(sessionId: string): boolean {
    const pair = pairOf(sessionId)
    return pair !== undefined && pair.observerSessionId === sessionId
  }

  function takeFocus(): { sessionId: string; at: number } | null {
    const focus = state.focus
    if (focus === null) return null
    state.focus = null
    save()
    return focus
  }

  return {
    load,
    save,
    snapshot: () => JSON.parse(JSON.stringify(state)),
    observerOf,
    mainOfObserver,
    pairOf,
    isObserverHalf,
    recordPair,
    takeFocus,
    /** 供 `resetBindingStore` / 测试替换整张表（原 index.ts 里直接赋值 `state`）。 */
    setFromSnapshot: (next: ObserverBindings) => { state = next },
    /** 见接口注释：一次受控改写，替代外部直接持有 `state`。 */
    mutate: (fn) => { fn(state) },
    pairs: () => Object.values(state.pairs),
    /** 原 index.ts 里散落的 `state.bindings[main] = …; state.reverse[obs] = …` 两行合一。 */
    bindLegacy: (mainSessionId, observerSessionId) => {
      state.bindings[mainSessionId] = observerSessionId
      state.reverse[observerSessionId] = mainSessionId
    },
    path: () => bindingsPath,
  }
}
