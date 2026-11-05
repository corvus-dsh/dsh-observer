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
 * WHAT THIS FILE IS NOT: it introduces no switch, no feature flag, no `legacy/` fork. The old
 * `observer-inject.ts` is kept as an archive that nothing imports (the user's explicit instruction),
 * so there is exactly one live path — this one.
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
    trigger: { text: string; mode: 'queue' | 'interrupt'; origin: string },
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
