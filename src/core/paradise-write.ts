/**
 * THE PARADISE WRITE PATH — the observer's ONE door to the 彼岸 layer's verbs.
 *
 * WHY THIS FILE EXISTS RATHER THAN A BARE `import` IN index.ts
 *
 * Same reason as `paradise-bridge.ts`: this plugin ships as a SINGLE-FILE bundle whose composer
 * inlines only RELATIVE modules, so a static bare import of `dsh-paradise` would survive into
 * `index.js` and fail at `import()` time whenever the layer is absent — taking the whole plugin down
 * with it. So the layer is reached LAZILY, the answer is CACHED including a failure, and every entry
 * point here degrades with a STATED reason rather than crashing.
 *
 * WHY THE ADAPTER IS BUILT PER CALL AND NOT KEPT
 *
 * `createDshAdapters(ctx)` binds the host's services. The observer's `ctx` is the same object for the
 * life of the plugin, but building the adapter is cheap and stateless — and a cached adapter would
 * pin the capability probe to whatever the host looked like at first use. Capabilities are meant to
 * reflect the host NOW.
 *
 * WHAT THIS FILE IS NOT: it introduces no switch, no feature flag, no `legacy/` fork. The old write
 * path was deleted on 2026-11-09 (批次 C-2) — its four still-used read-only helpers moved to
 * `src/core/read-helpers.ts` — so there is exactly one live path: this one.
 */

import {
  ensureParadise,
  paradiseStatus,
  type ParadiseBinding,
} from './paradise-bridge.js'

/** The subset of the adapter surface this plugin calls. Structural, so a rename breaks here first. */
interface SessionAdapterLike {
  readonly name: string
  readonly capabilities: {
    create: boolean
    trigger: boolean
    injectIntoIdle: boolean
    injectIntoRunning: boolean
    readLog: boolean
    subscribe: boolean
    verifyDeletion: boolean
    unavailable: ReadonlyArray<{ capability: string; consequence: string }>
  }
  create(input: {
    cwd: string
    title?: string
    id?: string
    /**
     * 新会话继承哪一个会话的 provider/model/preset/policy。
     *
     * 这个字段一直**真的被传**（`src/index.ts` 的孵化路径），但接口里没声明 ——
     * 于是 `tsc` 报 2353「对象字面量只能指定已知属性」。也就是说：**类型欠账，不是代码欠账**。
     * 没有这段声明，调用方写对了也会被报错，而读代码的人会以为那个字段是笔误。
     */
    inheritFrom?: string
    /** 孵化时随会话一起注入的条目（可见性与原文由调用方决定）。 */
    items?: ReadonlyArray<{
      visibility: string
      text: string
      origin?: string
    }>
  }): Promise<{
    ok: boolean
    stage: string
    warnings: string[]
    session?: { id: string; cwd: string }
    rendered?: ReadonlyArray<{ id: string; requested: string; rendered: boolean; reason: string }>
    types?: string[]
    appended?: number
    verified?: boolean
    contentSeq?: number | null
    contentSourceKind?: string
    workspaceAttached?: boolean
    clientAnnounced?: boolean
    error?: { code: string; stage: string; message: string }
  }>
  trigger(
    session: { id: string; cwd: string },
    trigger: {
      text: string
      mode: 'queue' | 'interrupt'
      origin: string
      /**
       * The marker(s) paradise must use for BOTH stamping and the idempotence check.
       *
       * A LIST, current first: an already-ignited session carries the marker in force when it was
       * created, and a rename must not make it invisible. See core/ignition.ts for why this is not
       * a default.
       */
      marker?: string | readonly string[]
    },
  ): Promise<{
    ok: boolean
    stage: string
    channel?: string
    alreadyTriggered?: true
    warnings: string[]
    error?: { code: string; stage: string; message: string }
  }>
}

interface ParadiseLayerLike {
  createDshAdapters(ctx: any, config?: { dataDir?: string }): {
    name: string
    session: SessionAdapterLike
  }
  deleteSession(
    ctx: any,
    sessionId: string,
    reason: string,
  ): Promise<{
    ok: boolean
    stage: string
    removed: boolean
    verified: 'absent' | 'present' | 'unverifiable'
    marked: boolean
    notes: string[]
    warnings: string[]
  }>
}

/**
 * AN INJECTED ADAPTER PROVIDER — how this plugin runs where there is no host.
 *
 * WHY THIS IS NOT A FEATURE FLAG: the name of the thing this plugin depends on is "two verbs" (`create`
 * and `trigger`), not "the host's service container". A deployment that already HAS those verbs — a bare
 * machine running the layer's raw adapters — should be able to say so, and the plugin should then behave
 * exactly as it does inside a host. That is the whole of "host-independent": not a second code path, but
 * the same path fed from somewhere else.
 *
 * WHAT IT DOES NOT CHANGE: with no provider installed, resolution goes to `ensureParadise()` and the
 * host's own factory, exactly as before. Every existing test keeps exercising that path.
 */
export type WriteAdapterProvider = (ctx: any) =>
  | { ok: boolean; reason?: string; session?: SessionAdapterLike; deletes?: ParadiseLayerLike['deleteSession']; layerName?: string }
  | null

let provider: WriteAdapterProvider | undefined

/** Install (or clear) the provider. `null` from it means "no opinion, resolve as usual". */
export function setWriteAdapterProvider(next: WriteAdapterProvider | undefined): void {
  provider = next
}

/** Is a provider installed? Diagnostics print this so "why is it not using the host" is answerable. */
export function hasWriteAdapterProvider(): boolean {
  return provider !== undefined
}

/**
 * Resolve the layer's write surface.
 *
 * Returns `undefined` with a stated reason when the layer is missing or does not expose the write
 * API — the caller then reports "the write path is unavailable" instead of failing deep inside a
 * half-built incubation.
 */
export async function ensureWriteAdapter(ctx: any): Promise<{
  ok: boolean
  reason: string
  session?: SessionAdapterLike
  deletes?: ParadiseLayerLike['deleteSession']
  layerName?: string
}> {
  /**
   * THE PROVIDER IS CHECKED FIRST, and a `null` answer falls through rather than being treated as a
   * failure: a caller may own only SOME contexts (a test owns its own `{}`, production owns the real
   * one), and forcing it to fabricate an answer for the rest would push a stub into a live path.
   */
  if (provider !== undefined) {
    const injected = provider(ctx)
    if (injected !== null) {
      if (injected.ok !== true) return { ok: false, reason: injected.reason ?? '注入的适配器不可用' }
      if (injected.session === undefined) return { ok: false, reason: '注入的适配器没有提供 session' }
      return {
        ok: true,
        reason: '',
        session: injected.session,
        ...(injected.deletes === undefined ? {} : { deletes: injected.deletes }),
        ...(injected.layerName === undefined ? {} : { layerName: injected.layerName }),
      }
    }
  }

  const binding: ParadiseBinding = await ensureParadise()
  if (!binding.available) {
    return { ok: false, reason: binding.reason }
  }
  const layer = (binding as any).layer as ParadiseLayerLike | undefined
  if (layer === undefined || typeof layer.createDshAdapters !== 'function') {
    return {
      ok: false,
      reason:
        'dsh-paradise 已加载，但没有暴露 createDshAdapters —— 版本过旧（需要 >= 0.3.0，写层在其中）',
    }
  }
  if (typeof layer.deleteSession !== 'function') {
    return {
      ok: false,
      reason: 'dsh-paradise 缺少 deleteSession —— 回滚将不可用，拒绝在没有清理能力时写入',
    }
  }
  try {
    const adapters = layer.createDshAdapters(ctx)
    return {
      ok: true,
      reason: '',
      session: adapters.session,
      deletes: layer.deleteSession,
      layerName: adapters.name,
    }
  } catch (error) {
    return { ok: false, reason: `createDshAdapters 抛错：${String((error as any)?.message ?? error)}` }
  }
}

/** The layer's availability, for `observer_status` — the same three-valued answer as the read bridge. */
export function writePathStatus(): {
  resolved: boolean
  available: boolean
  reason: string
  consequence: string
} {
  const status = paradiseStatus()
  return {
    resolved: status.resolved,
    available: status.available,
    reason: status.reason,
    consequence: status.consequence,
  }
}
