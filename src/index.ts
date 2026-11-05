/**
 * dsh-observer — the companion session (副脑), as its own plugin.
 *
 * WHY IT IS A SEPARATE PLUGIN
 *
 * The follower used to live inside dsh-graft-slice, which meant the graft plugin knew about
 * observers, their storage and their UI. That is the coupling this package exists to remove:
 * graft now only announces `graft/session-transferred`, and this plugin decides what (if
 * anything) follows.
 *
 * THE ONE DESIGN RULE (from 副会话Observer-架构方案-v0.1.md §2)
 *
 * The observer is a FOLLOWER, not a second tape. It is never retired and never sliced; a
 * transfer only rewrites one pointer inside `observer-bindings.json`. That is what keeps the
 * pair free of the four deadlock cycles a "mutual graft" would introduce.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * v1.3.0 — THE PHYSICAL INJECTION PATH LIVES IN ITS OWN MODULE.
 *
 * `observer_spawn_main` no longer creates a live session and appends to it. That path could not
 * work on this host: a `developer/message` must match the OPEN turn/step, and a freshly created
 * session has no open turn at all. The incubation now prepares a DETACHED session, builds and
 * validates a whole tape in memory, and writes it through `sessionPersistence.create` +
 * `handle.append` + `handle.flush` — the same writer dsh-graft-slice uses for its cold targets.
 *
 * It lives in `src/core/observer-inject.ts` because it is a different job from pointer
 * bookkeeping, and because `src/index.ts` is already over a thousand lines of policy and prose.
 */
/**
 * v1.9.0 — THE WRITE PATH MOVED TO THE 彼岸 LAYER.
 *
 * `./core/observer-inject.js` is KEPT ON DISK AS AN ARCHIVE and is no longer imported here. What this
 * file still takes from it is exactly two READ-ONLY helpers:
 *
 *   `resolveInheritedCwdAsync` — the cwd donor chain (header → session.cwd → workingDirectory →
 *      durable header). It is a READ, it is tested, and the layer deliberately does not own it: the
 *      layer refuses a session with no cwd, but deciding WHICH cwd a main inherits is the observer's
 *      business (it is the session that hatched it).
 *   `shortSessionTag` — a pure string helper for sidebar labels.
 *
 * Everything else on the write path (tape shape, persistence transaction, cold-read verification,
 * rollback, ignition) now comes from `paradise.session` / `paradise.deleteSession`, reached through
 * `paradise-write.ts`.
 *
 * Two more read-only helpers are still taken from the archived module, and both are deliberate:
 *
 *   `resolveService` — the "resolve by the method you are about to call" rule. The write path no
 *      longer needs it (the layer resolves its own services), but the READ paths here do: the
 *      supervisor's prompt channel, the confirmation gate's log read, the tool registry, the rename
 *      channel. Moving them is the NEXT migration, not this one.
 *   `InjectError` — the error type the confirmation gate still throws, because its `stage`
 *      vocabulary is what the tool result reports. The write path now throws plain `Error`s carrying
 *      the same two properties; unifying the two is also a later step.
 */
import { InjectError, resolveInheritedCwdAsync, resolveService, shortSessionTag } from './core/observer-inject.js'
/**
 * v1.8.0 — THE DURABLE-LOG READER NOW LIVES IN `dsh-paradise` (彼岸层).
 *
 * `src/core/disk-log.ts` was deleted, not deprecated: two copies of "decode every zstd frame" is
 * exactly the drift the 彼岸 layer exists to end, and the read half is the zero-risk piece the
 * architecture draft (§9 item B) recommends extracting first.
 *
 * `paradise-bridge.ts` is the seam. It loads the layer LAZILY (a static bare import would survive
 * into this single-file bundle and make an absent package fatal to the whole plugin), caches the
 * answer including a failure, and maps paradise's reading back into `DiskLogReport` — the receipt
 * shape this plugin has always printed, so the migration changed no user-facing field.
 */
import {
  PARADISE_MISSING_CONSEQUENCE,
  ensureParadise,
  escapeSessionDirName,
  inspectSessionLog,
  paradiseStatus,
  resetParadiseCache,
  unavailableBinding,
} from './core/paradise-bridge.js'
/**
 * v1.9.0 — THE WRITE SEAM, and the reason it is a separate module.
 *
 * `paradise-write.ts` narrows the layer's write surface to the four calls this plugin makes and turns
 * "the layer is missing / too old / refuses" into a STATED reason the incubation reports, instead of
 * a crash deep inside a half-built artifact.
 */
import { ensureWriteAdapter, writePathStatus } from './core/paradise-write.js'
import { ASK_TOOL_NAME, checkConfirmation, confirmationRefusal, findAskEvidence } from './core/confirmation.js'
/**
 * v1.9.0 — ONLY THE PROMPT TEXT AND THE MARKER COME FROM THE ARCHIVED IGNITION MODULE.
 *
 * The channel itself (`sessionController.prompt` + AbortSignal + idempotence + mode fallback) lives in
 * `dsh-paradise/src/adapters/dsh/trigger.ts` now. Importing the rest here would leave a second ignition
 * implementation inside this bundle — the duplication the layer exists to remove — and an unused import
 * is how that duplication quietly survives a refactor.
 */
import { DEFAULT_IGNITION_PROMPT, IGNITION_MARKER } from './core/ignition.js'
import {
  OBSERVER_MISSION_TEXT,
  SPAWN_MAIN_DESCRIPTION,
  TRIGGER_SECTION_NAME,
  TRIGGER_SECTION_TEXT,
  permitsExecution,
} from './core/policy.js'
/**
 * v1.7.0 — THE SUPERVISOR (监理).
 *
 * `monitor.ts` is the pure state machine (streak / stall / cooldown / cap) and `supervisor.ts` is
 * the half that acts: it steers a correction into the running main and calls `memory_harvest` when
 * a node completes or the main goes quiet. This file only WIRES them, because the decisions there
 * are testable without a host and the wiring here is not.
 */
import {
  createSupervisor,
  DEFAULT_SUPERVISOR_IDLE_MS,
  SUPERVISOR_DUTY_TEXT,
  type Supervisor,
} from './core/supervisor.js'
import {
  FAILURE_STREAK_LIMIT,
  STALL_TURNS_LIMIT,
  NUDGE_COOLDOWN_MS,
  NUDGE_MIN_SEQ_GAP,
  NUDGE_CAP,
  NUDGE_MARKER,
  HARVEST_COOLDOWN_MS,
  DEFAULT_MONITOR_OPTIONS,
  createMonitorState,
  describeMonitorState,
  failureNudgeText,
  harvestGate,
  stallNudgeText,
  stepMonitor,
  todoItemsFromArguments,
} from './core/monitor.js'

/** Cordis plugin name. */
export const name = 'dsh-observer'

/**
 * Version probe. Printed at IMPORT time so the Host log proves which copy is live — the
 * Client half is cached separately, and "did my build reach the app?" must be answerable
 * without guessing.
 */
export const VERSION = '1.9.0'
console.log(`[dsh-observer] host version ${VERSION}`)

/**
 * Hard dependencies.
 *
 * v1.3.0 — `sessions`, `sessionPersistence` and `sessionQuery` are now REQUIRED, not optional.
 *
 * The incubation writes a COLD tape through the store-owned writer. On this host a service read
 * that was not declared can throw `cannot get property … without inject`, so declaring them is
 * what turns "the injection silently degraded" into "the entry would not activate". `workspaceRegistry`
 * stays late-bound: a headless/base profile has no registry, and losing the sidebar grouping must
 * not cost the user their main session.
 */
export const inject = ['tools', 'sessionController', 'sessions', 'sessionPersistence', 'sessionQuery']

interface ObserverBindings {
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

interface ObserverPair {
  /** The session that plans, monitors and hands off. */
  observerSessionId: string
  /** The session that does the work. */
  mainSessionId: string
  at: number
  /** Where the plan came from, so a later reader knows how the pair was formed. */
  origin: 'incubated' | 'summoned'
}

interface PluginContextLike {
  get?: (name: string) => any
  logger?: { info?: (message: string) => void; warn?: (message: string) => void }
  on?: (event: string, listener: (...args: any[]) => any) => unknown
  tools?: { register: (definition: any) => unknown }
  /** v1.3.0: the physical injection announces a COLD session so the Web UI lists it. */
  emit?: (event: string, payload: unknown) => unknown
}

const EMPTY: ObserverBindings = { bindings: {}, reverse: {}, focus: null, pairs: {}, pairOf: {} }

let bindingsPath = ''
let state: ObserverBindings = { bindings: {}, reverse: {}, focus: null, pairs: {}, pairOf: {} }

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Atomically write a file: temp + rename, so a reader never sees half a document. */
function writeAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

/**
 * Build the ONE error shape the incubation reports, and build it in ONE place.
 *
 * WHY THIS EXISTS: the tool handler renders `孵化失败（stage=<stage>）：<message>`, so a message that
 * itself begins with `孵化失败@<stage>：` produces the doubled headline an earlier release spent a
 * round removing. Both the write path here and the departed injection core had their own spelling of
 * it; a single constructor means a future edit cannot reintroduce the doubling by accident.
 *
 * `code` is embedded in brackets inside the message because that is what makes the host log greppable
 * without a structured reader — and it is embedded EXACTLY ONCE for the same reason.
 */
function stageError(stage: string, code: string, message: string): Error {
  const alreadyBracketed = message.includes(`[${code}]`)
  const error = new Error(alreadyBracketed ? message : `[${code}] ${message}`)
  ;(error as any).stage = stage
  ;(error as any).code = code
  return error
}

const EMPTY_STATE = (): ObserverBindings => ({ bindings: {}, reverse: {}, focus: null, pairs: {}, pairOf: {} })

function load(): void {
  // Start from empty on EVERY load: the module-level state must describe THIS file, and a
  // mount that reuses a previous process-level copy would leak bindings across profiles
  // (and across tests).
  state = EMPTY_STATE()
  try {
    const parsed = JSON.parse(readFileSync(bindingsPath, 'utf8'))
    if (!isRecord(parsed)) return
    const next = EMPTY_STATE()
    if (isRecord(parsed.bindings)) {
      for (const [main, observer] of Object.entries(parsed.bindings)) {
        if (typeof observer === 'string' && observer.length > 0) next.bindings[main] = observer
      }
    }
    if (isRecord(parsed.reverse)) {
      for (const [observer, main] of Object.entries(parsed.reverse)) {
        if (typeof main === 'string' && main.length > 0) next.reverse[observer] = main
      }
    }
    if (isRecord(parsed.focus) && typeof parsed.focus.sessionId === 'string') {
      next.focus = { sessionId: parsed.focus.sessionId, at: Number(parsed.focus.at) || 0 }
    }
    // v1.2.0 — the pair table. A row is only accepted when both members are non-empty strings and
    // they differ: a self-pair would make every role question answer "both".
    if (isRecord(parsed.pairs)) {
      for (const [key, value] of Object.entries(parsed.pairs)) {
        if (!isRecord(value)) continue
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
    if (isRecord(parsed.pairOf)) {
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
    mkdirSync(dirname(bindingsPath), { recursive: true })
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

/** Stable key for a pair. Order-independent, so a role swap cannot orphan the row. */
function pairKeyOf(a: string, b: string): string {
  return [a, b].sort().join('|')
}

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

/**
 * Follow a transfer: rewrite the pointer inside this plugin, and leave a focus note.
 *
 * This is the WHOLE cross-plugin coupling: a listener on an event name. It never calls into
 * graft, never blocks it, and a profile without graft simply never receives the event.
 *
 * v1.2.0 — BOTH HALVES FOLLOW, AND NOBODY WAITS.
 *
 * The first version only handled "the MAIN was transferred". With pairs, either half can be
 * grafted (the companion is a session like any other, so it can hit the watermark on its own).
 * The move is a POINTER REWRITE in either direction — there is no lock, no retirement of the
 * other half, and no wait for it. That is what keeps the mutual-graft deadlock impossible: a
 * deadlock needs two parties that each wait, and here neither party waits for anything.
 */
function followTransfer(
  sourceSessionId: string,
  newSessionId: string,
): { followed: boolean; role: 'main' | 'observer' | ''; otherSessionId: string } {
  const pair = pairOf(sourceSessionId)
  if (pair === undefined) return { followed: false, role: '', otherSessionId: '' }

  const wasObserver = pair.observerSessionId === sourceSessionId
  const role: 'main' | 'observer' = wasObserver ? 'observer' : 'main'
  const otherSessionId = wasObserver ? pair.mainSessionId : pair.observerSessionId
  const key = state.pairOf[sourceSessionId]
  if (key !== undefined) delete state.pairs[key]
  delete state.pairOf[sourceSessionId]
  // The legacy maps must not keep pointing at the retired id.
  if (wasObserver) delete state.reverse[sourceSessionId]
  else delete state.bindings[sourceSessionId]

  const written =
    role === 'observer'
      ? recordPair(newSessionId, otherSessionId, pair.origin)
      : recordPair(otherSessionId, newSessionId, pair.origin)
  if (!written.ok) return { followed: false, role: '', otherSessionId: '' }

  // A focus note only makes sense for the MAIN half: that is the session the user should see.
  const visible = role === 'main' ? newSessionId : otherSessionId
  state.focus = { sessionId: visible, at: Date.now() }
  save()
  return { followed: true, role, otherSessionId }
}

function takeFocus(): { sessionId: string; at: number } | null {
  const focus = state.focus
  if (focus === null) return null
  state.focus = null
  save()
  return focus
}

export function apply(ctx: PluginContextLike, config: Record<string, unknown> = {}): void {
  const configured = typeof config.bindingsPath === 'string' ? config.bindingsPath : ''
  bindingsPath = configured.length > 0 ? configured : join(process.env.DSH_PROFILE_DIR ?? process.cwd(), 'data', 'dsh-observer', 'observer-bindings.json')
  load()

  /**
   * v1.7.0 — THE SUPERVISOR TABLE.
   *
   * One entry per INCUBATED MAIN, keyed by the main's own id, because that is the id every event of
   * the feed is scoped to. It is deliberately in-memory only: supervision is a live activity, and a
   * restarted process reconstructs it lazily (see `supervisePair`) rather than pretending a stale
   * timer survived.
   */
  const supervisors = new Map<string, Supervisor>()

  /** Resolve a scope id out of the (session, event) pair the feed hands over. */
  const scopeSessionId = (args: any[], event: any): string => {
    const fromEvent = typeof event?.data?.sessionId === 'string' ? event.data.sessionId : ''
    if (fromEvent.length > 0) return fromEvent
    const scope = args.length >= 2 ? args[0] : undefined
    if (typeof scope?.id === 'string') return scope.id
    if (typeof scope?.sessionId === 'string') return scope.sessionId
    return ''
  }

  /**
   * Start (or restart) supervision of one pair.
   *
   * WHY THE DEPENDENCIES ARE RESOLVED HERE AND NOT INSIDE THE SUPERVISOR: this file owns the
   * `resolveService` policy for the whole plugin — which service name, probed by which method — and
   * a second copy inside `supervisor.ts` would be a second opinion about what "available" means.
   */
  const supervisePair = (observerSessionId: string, mainSessionId: string, reason: string): Supervisor => {
    const previous = supervisors.get(mainSessionId)
    if (previous !== undefined) previous.dispose()
    const supervisor = createSupervisor(observerSessionId, mainSessionId, {
      logger: ctx.logger,
      controller: resolveService(ctx, 'sessionController', 'prompt'),
      tools: resolveService(ctx, 'tools', 'execute'),
      idleMs: DEFAULT_SUPERVISOR_IDLE_MS,
    })
    supervisors.set(mainSessionId, supervisor)
    ctx.logger?.info?.(
      `[dsh-observer] 监理启动：主脑 ${mainSessionId} ← 副脑 ${observerSessionId}（${reason}）`,
    )
    return supervisor
  }

  /**
   * v1.7.0 — A SUPERVISOR WATCHING A RETIRED ID IS A SUPERVISOR WATCHING NOTHING, AND A RETIRED
   * MAIN IS THE ONE THING `memory_harvest` CAN ACTUALLY MINE.
   *
   * The order is deliberate:
   *
   *   1. MINE the old main, while its id is still the watched one. `memory_harvest` reads the
   *      handoff ledger, where a just-sliced session appears; a live main does not, which is why
   *      the `completed`/`idle` paths usually come back empty and THIS one does not.
   *   2. DISPOSE its supervisor — a timer pointed at a retired id is a supervisor watching nothing
   *      while looking healthy.
   *   3. SUPERVISE the new ids.
   *
   * Only a MAIN transfer mines: when the OBSERVER half is sliced, the main is still alive and
   * calling the harvest "replaced" would spend the one slot that the real retirement needs.
   */
  const resupervise = async (
    role: 'main' | 'observer',
    sourceSessionId: string,
    newSessionId: string,
    otherSessionId: string,
  ): Promise<void> => {
    const oldMainId = role === 'main' ? sourceSessionId : otherSessionId
    const newMainId = role === 'main' ? newSessionId : otherSessionId
    const newObserverId = role === 'main' ? otherSessionId : newSessionId

    const watched = supervisors.get(oldMainId)
    if (watched !== undefined) {
      if (role === 'main') await watched.onReplaced()
      watched.dispose()
      supervisors.delete(oldMainId)
    }
    // Any supervisor left naming either id is stale too (a repeated event, a partially applied
    // transfer); dropping it is cheaper than reasoning about which one is the "real" one.
    for (const [key, supervisor] of [...supervisors.entries()]) {
      const touches =
        supervisor.mainSessionId === oldMainId ||
        supervisor.mainSessionId === newMainId ||
        supervisor.observerSessionId === oldMainId ||
        supervisor.observerSessionId === newMainId
      if (!touches) continue
      supervisor.dispose()
      supervisors.delete(key)
    }

    supervisePair(newObserverId, newMainId, `${role} transferred`)
    ctx.logger?.info?.(
      `[dsh-observer] 监理已重建：主脑 ${newMainId} ← 副脑 ${newObserverId}` +
        `（${role} 转生自 ${sourceSessionId}；旧主脑 ${oldMainId}` +
        `${role === 'main' ? ' 已尝试提炼' : ' 未退休，不提炼'}）`,
    )
  }

  /**
   * v1.7.0 — REHYDRATE THE SUPERVISORS OF PAIRS THAT ALREADY EXIST.
   *
   * The supervisor table is in memory, so without this a restarted process would supervise only
   * mains hatched in THIS process — and a pair from yesterday would sit there looking supervised
   * while nothing watched it. That is the same class of lie as a `{ok:true}` receipt.
   *
   * Nothing is sent here: a fresh supervisor only arms its idle timer, and its first `observe()`
   * happens when the main's next event arrives. The idle timer of a genuinely dead pair fires once,
   * the harvest gate refuses it (`turnsClosed === 0`), and the log says so — which is the honest
   * outcome for a pair that has been quiet since before the restart.
   */
  for (const pair of Object.values(state.pairs)) {
    try {
      supervisePair(pair.observerSessionId, pair.mainSessionId, 'restored at mount')
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-observer] 恢复监理失败（${pair.observerSessionId} → ${pair.mainSessionId}）：` +
          `${String((error as any)?.message ?? error)}`,
      )
    }
  }

  /**
   * v1.0.6 — THE BINDING IS DERIVED FROM THE TITLE, NOT REQUESTED THROUGH A COMMAND.
   *
   * `commands.execute` is BROADCAST: the host renders every command invocation as a row in the
   * conversation, whatever the handler returns. The user saw it for `observer-state`,
   * `observer-create` and finally `observer-bind` — an empty reply removes the TEXT but not the
   * ROW. So the command channel is abandoned entirely for binding.
   *
   * Instead the Client renames the companion through a plain Remote call
   * (`remote.session.rename`, which is not a command and prints nothing):
   *
   *     [副脑] 跟随 <full main session id>
   *
   * The host then reads its OWN event feed. `session/event` fires post-commit for every appended
   * event, so a `session/title` carrying the marker is the moment to write the pointer and inject
   * the setting. Nothing is polled, nothing is broadcast, and the title doubles as the marker the
   * Client uses to hide the summon chip.
   */
  const COMPANION_TITLE = /^\[副脑\]\s*跟随\s+(\S+)/u

  ctx.on?.('session/event', (...args: any[]) => {
    try {
      // `session/event` is scoped: (session, event). Read defensively so a shape change cannot
      // throw inside a post-commit feed.
      const event = args.length >= 2 ? args[1] : args[0]
      if (!isRecord(event)) return
      /**
       * v1.7.0 — FEED THE SUPERVISOR FIRST, AND IN A DETACHED CALL.
       *
       * `observe()` may deliver a steer prompt or start a harvest, both of which take real time.
       * Awaiting it here would block the host's post-commit feed — a listener that stalls the log
       * writer is worse than a missed hint. It is `void`ed, and every failure inside it is caught
       * and logged by the supervisor itself.
       */
      const scopedId = scopeSessionId(args, event)
      const supervised = scopedId.length > 0 ? supervisors.get(scopedId) : undefined
      if (supervised !== undefined) void supervised.observe(event)

      /**
       * v1.0.7 — PROVE THE FEED IS ALIVE.
       *
       * The whole event-derived binding rests on this listener actually receiving events. A silent
       * listener makes a broken binding indistinguishable from a broken client, so every title
       * that arrives is logged with its text and both candidate session ids. If the user renames a
       * companion and this line never appears, the feed is the problem — not the parser.
       */
      if (event.type === 'session/title') {
        const seenTitle = typeof event.data?.title === 'string' ? event.data.title : ''
        ctx.logger?.info?.(
          `[dsh-observer] 宿主捕获到 title 事件: ${JSON.stringify(seenTitle)} ` +
            `(scope.id=${JSON.stringify(args[0]?.id ?? args[0]?.sessionId ?? null)} ` +
            `data.sessionId=${JSON.stringify(event.data?.sessionId ?? null)})`,
        )
      }
      if (event.type !== 'session/title') return
      const title = typeof event.data?.title === 'string' ? event.data.title : ''
      const matched = COMPANION_TITLE.exec(title)
      if (matched === null) return
      const mainSessionId = matched[1]
      const observerSessionId =
        typeof event.data?.sessionId === 'string'
          ? event.data.sessionId
          : typeof args[0]?.id === 'string'
            ? args[0].id
            : typeof args[0]?.sessionId === 'string'
              ? args[0].sessionId
              : ''
      if (observerSessionId.length === 0 || mainSessionId === observerSessionId) {
        ctx.logger?.warn?.(
          `[dsh-observer] 副脑标题已到手但拿不到观察者 sessionId（main=${mainSessionId}）；` +
            '绑定与设定注入被跳过',
        )
        return
      }
      // Already bound to the same pair: a repeated title event must not re-inject the setting.
      if (observerOf(mainSessionId) === observerSessionId) return

      state.bindings[mainSessionId] = observerSessionId
      state.reverse[observerSessionId] = mainSessionId
      const written = save()
      if (!written.ok) {
        ctx.logger?.warn?.(`[dsh-observer] title-derived bind failed to persist: ${written.error}`)
        return
      }
      ctx.logger?.info?.(`[dsh-observer] bound ${mainSessionId} -> ${observerSessionId} from its title`)
      void injectSetting(observerSessionId, missionText(mainSessionId)).then((injected) => {
        ctx.logger?.info?.(
          injected.ok
            ? `[dsh-observer] setting injected via ${injected.via}`
            : `[dsh-observer] setting injection FAILED: ${injected.detail}`,
        )
      })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-observer] title-derived bind failed: ${String((error as any)?.message ?? error)}`)
    }
  })

  /**
   * THE transfer event. Grafted plugins announce, this one listens; nothing is imported in either
   * direction. Registered defensively: a host without the event bus must not fail to mount.
   */
  ctx.on?.('graft/session-transferred', (payload: any) => {
    try {
      const source = typeof payload?.sourceSessionId === 'string' ? payload.sourceSessionId : ''
      const target = typeof payload?.newSessionId === 'string' ? payload.newSessionId : ''
      if (source.length === 0 || target.length === 0) return
      const result = followTransfer(source, target)
      if (result.followed) {
        // Both halves can be grafted; the log says WHICH one moved, so a pair that follows twice
        // is legible instead of looking like a duplicate event.
        ctx.logger?.info?.(
          `[dsh-observer] ${result.role} half moved ${source} -> ${target}; ` +
            `the other half is ${result.otherSessionId}`,
        )
        /**
         * v1.7.0 — A SUPERVISOR WATCHING A RETIRED ID IS A SUPERVISOR WATCHING NOTHING.
         *
         * The pair pointer was just rewritten, so the supervision is rebuilt against the new ids —
         * and, when the MAIN is the half that moved, the retired main is mined first. Without this
         * the observer would keep steering prompts at a session that no longer exists, reporting
         * `ok` all the way.
         *
         * `void`ed on purpose: this listener must never block the transfer that triggered it. The
         * promise is also CATCHED, because `resupervise` may await a harvest and an unhandled
         * rejection inside an event listener is the one failure mode that can take the host down.
         */
        void resupervise(result.role, source, target, result.otherSessionId).catch((error) => {
          ctx.logger?.warn?.(
            `[dsh-observer] 监理重建失败（${result.role} ${source} -> ${target}）：` +
              `${String((error as any)?.message ?? error)}`,
          )
        })
      }
    } catch (error) {
      // A listener must never break the transfer that triggered it.
      ctx.logger?.warn?.(`[dsh-observer] follow failed: ${String((error as any)?.message ?? error)}`)
    }
  })

  /**
   * Create a companion session.
   *
   * `mode: 'bind'`    — a follower for `mainSessionId`; the pointer is written and VERIFIED.
   * `mode: 'consult'` — a pre-discussion companion with NO binding (the blank-page case: there
   *                     is no session yet, so binding it to nothing is the honest answer).
   *
   * v0.1.8 P0 — NO FALSE SUCCESS. Every early return is `ok:false` with a reason, and after
   * writing the pointer the file is re-read: if the binding is not on disk, the reply says so
   * instead of claiming victory. That is exactly the bug the UI surfaced as
   * `回执 {"ok":true}，但绑定表里没有该会话的副脑`.
   */
  const createObserver = async (
    mainSessionId: string,
    mode: 'bind' | 'consult',
  ): Promise<{ ok: boolean; observerSessionId: string; text: string }> => {
    if (mode === 'bind') {
      if (mainSessionId.length === 0) {
        return { ok: false, observerSessionId: '', text: '没有可绑定的主会话 id：请在会话里执行，或传入 mainSessionId。' }
      }
      if (mainOfObserver(mainSessionId).length > 0) {
        return { ok: false, observerSessionId: '', text: '这是一个副脑会话：它跟随主会话，不能再给它召唤副脑。' }
      }
      const existing = observerOf(mainSessionId)
      if (existing.length > 0) {
        return { ok: true, observerSessionId: existing, text: `该会话已有副脑：${existing}（未重复创建）。` }
      }
    }

    const controller = resolveService(ctx, 'sessionController', 'create')
    if (!isRecord(controller) || typeof controller.create !== 'function') {
      return { ok: false, observerSessionId: '', text: 'sessionController.create 不可用：当前宿主不支持创建会话。' }
    }

    let observerSessionId = ''
    try {
      const created = await controller.create({})
      observerSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (observerSessionId.length === 0) {
        return { ok: false, observerSessionId: '', text: `会话创建返回了空 id：${JSON.stringify(created)}` }
      }
    } catch (error) {
      return { ok: false, observerSessionId: '', text: `创建副脑会话失败：${String((error as any)?.message ?? error)}` }
    }

    if (mode === 'bind') {
      state.bindings[mainSessionId] = observerSessionId
      state.reverse[observerSessionId] = mainSessionId
      const written = save()
      if (!written.ok) {
        delete state.bindings[mainSessionId]
        delete state.reverse[observerSessionId]
        return {
          ok: false,
          observerSessionId,
          text: `副脑会话已创建（${observerSessionId}），但绑定表写入失败：${written.error}（路径 ${written.path}）`,
        }
      }
      // Verify against DISK, not against the in-memory copy the write came from.
      load()
      if (observerOf(mainSessionId) !== observerSessionId) {
        return {
          ok: false,
          observerSessionId,
          text: `绑定表回读校验失败：${written.path} 中没有 ${mainSessionId} → ${observerSessionId}`,
        }
      }
    }

    const mission =
      mode === 'bind'
        ? missionText(mainSessionId)
        : '[系统设定] 你是一个前置需求分析副脑（尚未绑定任何主会话）。' +
          '职责：帮用户理清需求、指出遗漏与风险，必要时给出 2~3 个方案对比。' +
          '确认方案后，请输出一段可直接粘贴到主会话的最终 Prompt，并在末尾提示用户「复制到主会话开始执行」。'

    /**
     * v1.0.5 — WRITE THE SETTING PHYSICALLY, AND TITLE THE SESSION.
     *
     * The role is appended as a `developer/message` (context, never a turn), so the companion
     * opens as a quiet blank page; the TITLE carries `[副脑]` so the Client can hide the summon
     * chip by reading its own local session snapshot — no RPC, no page storage.
     */
    const marked = await markCompanion(mainSessionId, observerSessionId, mission)
    if (!marked.injected || !marked.renamed) {
      ctx.logger?.warn?.(`[dsh-observer] companion setup incomplete: ${marked.detail}`)
    }

    return {
      ok: true,
      observerSessionId,
      text:
        mode === 'bind'
          ? `已召唤副脑 ${observerSessionId}，绑定到 ${mainSessionId}。` +
            (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : '')
          : `已开启前置磋商副脑 ${observerSessionId}（未绑定主会话）。` +
            (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : ''),
    }
  }

  /**
   * WRITE A SETTING INTO A **LIVE** SESSION — as a COMPLETE, CLOSED SKELETON.
   *
   * SCOPE (v1.3.0): this is the COMPANION path only — the session made by
   * `sessionController.create`, which is LIVE by construction. The incubated MAIN does NOT come
   * here any more; it is a COLD artifact written by `src/core/observer-inject.ts`. Keeping the two
   * separate is the whole point: a live session may be appended to through the store writer, a
   * prepared one may not.
   *
   * v1.0.5 — WHY `prompt` IS NOT USED.
   *
   * `sessionController.prompt` is a USER PROMPT: it admits a turn, so the companion opened already
   * running (and burned quota doing it). A companion must open as a quiet blank page carrying its
   * background, waiting for the human. `developer/message` is CONTEXT — it never admits a turn.
   *
   * v1.2.2 — WHY `{ turn: 0, step: 0 }` COULD NEVER WORK, AND WHAT REPLACED IT.
   *
   * DSH validates surface events against the turn/step that is OPEN on the log. `developer/message`
   * belongs to `STEP_EVENT_TYPES`, so its `data.turn` / `data.step` must equal the session's current
   * open pair:
   *
   *     if (STEP_EVENT_TYPES.has(event.type)) this.requireStep(event, data)
   *     requireStep() { if (this.turn === null || this.step === null
   *                        || data.turn !== this.turn || data.step !== this.step) throw … }
   *
   * A freshly created session has NO open turn at all (`turn === null`), so every write was
   * rejected and the `catch` degraded it to a message — which is why three incubated mains each
   * ended up with five metadata events and zero `developer/message`.
   *
   * The fix is a legal, CLOSED skeleton written in one go:
   * turn/start → step/start → developer/message → step/end → turn/end. The message sits inside an
   * open step (so it validates) and the turn is CLOSED (so the session is asleep when it opens).
   *
   * `surfaceOp: 'append'` is required on a message event and forbidden on skeleton events — the
   * same rule the injection core's `assertInjectTape` enforces for the cold tape.
   */
  const injectSetting = async (
    targetSessionId: string,
    text: string,
  ): Promise<{ ok: boolean; via: string; detail: string }> => {
    /** One closed turn, one closed step, one developer message inside it. */
    const buildSkeleton = (createdAt: number): Array<Record<string, unknown>> => {
      const turn = 1
      const step = 1
      const message = {
        id: `observer-setting-${targetSessionId}`,
        role: 'developer',
        content: [{ type: 'text', text }],
        source: { kind: 'system-prompt' },
      }
      return [
        { type: 'turn/start', seq: 0, time: createdAt, data: { turn } },
        { type: 'step/start', seq: 1, time: createdAt + 1, data: { turn, step } },
        { type: 'developer/message', seq: 2, time: createdAt + 2, data: { turn, step, message }, surfaceOp: 'append' },
        { type: 'step/end', seq: 3, time: createdAt + 3, data: { turn, step } },
        { type: 'turn/end', seq: 4, time: createdAt + 4, data: { turn, reason: { kind: 'completed' } } },
      ]
    }

    /**
     * Channel 1: the LIVE session. `append` here goes through the same store-owned writer the host
     * uses, and it validates each event, so the skeleton must already be legal — which it is.
     *
     * A live session that ALREADY has an open turn cannot accept a turn/start. In that case the
     * correct write is a developer message bound to the OPEN pair, so the open pair is read first.
     */
    try {
      const sessions = resolveService(ctx, 'sessions', 'get')
      const live = isRecord(sessions) && typeof sessions.get === 'function' ? sessions.get(targetSessionId) : undefined
      if (live !== undefined && typeof (live as any).append === 'function') {
        const open = (() => {
          try {
            const value = (live as any).openTurnStep
            if (isRecord(value)) return value as { turn: number; step: number }
            if (typeof (live as any).open === 'function') {
              const probed = (live as any).open()
              if (isRecord(probed)) return probed as { turn: number; step: number }
            }
            return undefined
          } catch {
            return undefined
          }
        })()
        const message = {
          id: `observer-setting-${targetSessionId}`,
          role: 'developer',
          content: [{ type: 'text', text }],
          source: { kind: 'system-prompt' },
        }
        if (open !== undefined && typeof open.turn === 'number' && typeof open.step === 'number') {
          // There is an open turn: bind to it instead of opening a second one.
          ;(live as any).append('developer/message', { turn: open.turn, step: open.step, message }, { surfaceOp: 'append' })
          return { ok: true, via: 'live-open-step', detail: '' }
        }
        // No open turn: this session is idle, so the skeleton is the correct write.
        for (const event of buildSkeleton(Date.now())) {
          const { type, data, surfaceOp } = event as { type: string; data: Record<string, unknown>; surfaceOp?: string }
          ;(live as any).append(type, data, surfaceOp === undefined ? undefined : { surfaceOp })
        }
        return { ok: true, via: 'live-skeleton', detail: '' }
      }
    } catch (error) {
      // Fall through to the persistence channel before reporting a failure.
      ctx.logger?.warn?.(`[dsh-observer] live setting append failed: ${String((error as any)?.message ?? error)}`)
    }

    /** Channel 2: durable but not live. Same skeleton, written through the store-owned handle. */
    try {
      // The method asked for is the method CALLED. Resolving on `create` and then calling `open`
      // let a service that has one but not the other resolve to a candidate that cannot do the
      // work — the resolver picked on a capability the caller never used.
      const persistence = resolveService(ctx, 'sessionPersistence', 'open')
      if (isRecord(persistence) && typeof persistence.open === 'function') {
        const handle = await persistence.open(targetSessionId)
        if (handle !== undefined && typeof handle.append === 'function') {
          await handle.append(buildSkeleton(Date.now()))
          if (typeof handle.flush === 'function') await handle.flush()
          if (typeof handle.close === 'function') await handle.close()
          return { ok: true, via: 'persistence', detail: '' }
        }
        return { ok: false, via: '', detail: `sessionPersistence.open(${targetSessionId}) 没有返回可写的 handle` }
      }
      return { ok: false, via: '', detail: `sessionPersistence 不可用，且 ${targetSessionId} 不在 live store 中` }
    } catch (error) {
      // The reason carries the target id: a previous version reported a message that belonged to
      // another call, which sent the investigation in the wrong direction for an hour.
      return { ok: false, via: '', detail: `${targetSessionId}: ${String((error as any)?.message ?? error)}` }
    }
  }

  /**
   * TITLE THE COMPANION, and write its setting into the log.
   *
   * The title is the marker the Client reads from its own snapshot to hide the summon chip, so a
   * failed rename is reported rather than hidden.
   */
  const markCompanion = async (
    mainSessionId: string,
    observerSessionId: string,
    setting: string,
  ): Promise<{ renamed: boolean; injected: boolean; detail: string }> => {
    const controller = resolveService(ctx, 'sessionController', 'rename')
    let renamed = false
    const problems: string[] = []

    if (isRecord(controller) && typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId: observerSessionId, title: `[副脑] 跟随 ${shortSessionTag(mainSessionId, 12)}…` })
        renamed = true
      } catch (error) {
        problems.push(`重命名失败：${String((error as any)?.message ?? error)}`)
      }
    } else {
      problems.push('sessionController.rename 不可用')
    }

    const injected = await injectSetting(observerSessionId, setting)
    if (!injected.ok) problems.push(`设定写入失败（${injected.detail}）`)

    return { renamed, injected: injected.ok, detail: problems.join('；') }
  }

  /**
   * v1.2.1 — THE ARSENAL: ASK dsh-memory FOR THE SKILLS THAT FIT THIS PLAN.
   *
   * An incubated main should not start from zero experience. Before the plan is handed over, the
   * observer asks `dsh-memory` what it already knows about this kind of work and packs the answer
   * into the same `developer/message`. That turns the injected context into "the plan" plus "the
   * weapons and the known traps".
   *
   * HOW IT ASKS: `tools.execute` with `memory_search`. That is the same registry the model calls,
   * so no private API is invented, and a profile WITHOUT dsh-memory simply reports `UNKNOWN_TOOL`
   * — which is treated as "nothing remembered", not as a failure of the incubation.
   *
   * WHY `semantic:false`: the semantic pass needs an LLM round trip inside a tool call that is
   * already creating a session. Lexical recall is instant and deterministic; a missing skill is a
   * smaller cost than a stalled incubation. It is also the mode that works when the adjudicator's
   * model is rate-limited, which is exactly when a handoff is most likely to be attempted.
   *
   * The whole call is bounded and best-effort: any failure logs and returns empty, because losing
   * the arsenal must never cost the user their main session.
   */
  const findArsenal = async (
    query: string,
    workspace: string,
  ): Promise<{ ok: boolean; text: string; detail: string }> => {
    const tools = resolveService(ctx, 'tools', 'execute')
    if (!isRecord(tools) || typeof tools.execute !== 'function') {
      return { ok: false, text: '', detail: 'tools 服务不可用' }
    }
    const trimmed = query.trim()
    if (trimmed.length === 0) return { ok: false, text: '', detail: '方案为空，跳过检索' }
    try {
      const result = await tools.execute({
        callId: `observer-memory-${Date.now()}` as any,
        name: 'memory_search',
        arguments: {
          // The plan is long; the first 400 chars carry the intent that matters for recall.
          query: trimmed.slice(0, 400),
          semantic: false,
          ...(workspace.length > 0 ? { workspace } : {}),
        },
        signal: new AbortController().signal,
      })
      if (!isRecord(result) || result.isError === true) {
        const detail = isRecord(result) && isRecord(result.error) ? String(result.error.message ?? '') : '检索返回错误'
        return { ok: false, text: '', detail }
      }
      const value = result.value
      if (!isRecord(value)) return { ok: false, text: '', detail: '检索结果为空' }
      const hint = typeof value.hint === 'string' ? value.hint.trim() : ''
      if (hint.length === 0) return { ok: false, text: '', detail: '没有命中任何技能或负知识' }
      return { ok: true, text: hint, detail: '' }
    } catch (error) {
      // UNKNOWN_TOOL lands here on a profile without dsh-memory: absence, not failure.
      return { ok: false, text: '', detail: String((error as any)?.message ?? error) }
    }
  }

  /** Compose the context an incubated main wakes up with: the plan, then the arsenal. */
  const composeMainBriefing = (plan: string, arsenal: string): string => {
    if (arsenal.length === 0) return plan
    return (
      `${plan}\n\n` +
      '---\n' +
      '[记忆调度] 以下来自 dsh-memory 的既有经验，按本方案的意图自动检索所得：\n' +
      '作用有两层 —— 复用已验证的做法，避开记录在案的坑。若某条与当前代码库不符，以实际代码为准。\n\n' +
      arsenal
    )
  }

  /**
   * The role text. `[系统设定]` is the header a developer message carries so the model reads it as
   * standing context rather than as an instruction the user typed.
   */
  const missionText = (mainSessionId: string): string => OBSERVER_MISSION_TEXT(mainSessionId)

  /**
   * v1.4.0 — THE TRIGGER RULE RIDES IN THE SYSTEM PROMPT, NOT ONLY IN THE TOOL DESCRIPTION.
   *
   * WHY, concretely: a session received 「请先制定计划，然后孵化主脑来执行」 and did the work itself.
   * The old tool description said to call it only when the work was "too large for a single context
   * window", so the reader ran that test, disagreed, and acted on its own judgement — then treated
   * the user's SECOND identical message as "a re-prompt (possibly a template reminder)".
   *
   * A rule that lives only in a tool description is re-read only when the model considers the tool.
   * `systemPrompt.section()` is rendered from live state on EVERY request and is structurally
   * immune to compaction — `SystemPromptProjection.project()` overrides surface node 0 with the
   * rendered prompt, which is why graft puts its red lines here. This plugin had NO section at all
   * before this version, which is why the only statement of its trigger was one paragraph of prose
   * that a size heuristic could outvote.
   *
   * Scope note: the section applies to every session in the profile, because a rule that only
   * switches on after the first hatch cannot prevent the first wrong decision. It is short (about
   * 200 characters of Chinese) so it costs little on every request.
   */
  const registerTriggerSection = (): void => {
    const systemPrompt = (() => {
      try {
        return resolveService(ctx, 'systemPrompt', 'section')
      } catch {
        return undefined
      }
    })()
    if (!isRecord(systemPrompt) || typeof systemPrompt.section !== 'function') {
      // Not fatal: the tool description still carries the rule; the section is the belt-and-braces
      // copy that survives compaction. Report it, because "silently absent" is the failure mode.
      ctx.logger?.warn?.(
        '[dsh-observer] ctx.systemPrompt.section() unavailable; the incubation trigger rule rides in the tool description only',
      )
      return
    }
    const base =
      typeof systemPrompt.getSectionOrder === 'function'
        ? Number(systemPrompt.getSectionOrder('PLAN_POLICY')) || 0
        : 0
    try {
      systemPrompt.section({
        name: TRIGGER_SECTION_NAME,
        // Just below PLAN_POLICY: a trigger rule is a policy, not a persona.
        order: Math.max(0, base - 1),
        text: () => TRIGGER_SECTION_TEXT,
      })
      ctx.logger?.info?.('[dsh-observer] trigger-rule section registered (observer:trigger)')
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-observer] could not register the trigger section: ${String((error as any)?.message ?? error)}`,
      )
    }
  }
  registerTriggerSection()

  /**
   * v1.0.1 — BIND-ONLY ENTRY (the "B plan" for the client).
   *
   * The Client now CREATES the session itself (`sessions.create`, the only client API that
   * returns `Promise<SessionId>` — `uiWorkspace.startSession` returns void). This entry only
   * records the pointer and sends the mission, so it takes both ids as arguments and creates
   * nothing. Kept as a TOOL rather than a command because the command channel's reply wrapping
   * is unreliable in this host.
   */
  const bindExisting = async (
    mainSessionId: string,
    observerSessionId: string,
  ): Promise<{ ok: boolean; observerSessionId: string; text: string }> => {
    if (mainSessionId.length === 0 || observerSessionId.length === 0) {
      return { ok: false, observerSessionId: '', text: '缺少 mainSessionId 或 observerSessionId。' }
    }
    if (mainOfObserver(mainSessionId).length > 0) {
      return { ok: false, observerSessionId: '', text: '这是一个副脑会话：它不能再绑定副脑。' }
    }
    const existing = observerOf(mainSessionId)
    if (existing.length > 0 && existing !== observerSessionId) {
      delete state.reverse[existing]
    }
    state.bindings[mainSessionId] = observerSessionId
    state.reverse[observerSessionId] = mainSessionId
    const written = save()
    if (!written.ok) {
      delete state.bindings[mainSessionId]
      delete state.reverse[observerSessionId]
      return { ok: false, observerSessionId, text: `绑定表写入失败：${written.error}（路径 ${written.path}）` }
    }
    load()
    if (observerOf(mainSessionId) !== observerSessionId) {
      return { ok: false, observerSessionId, text: `回读校验失败：${written.path} 中没有该绑定` }
    }
    /**
     * v1.0.4: send the role as an ordinary message and title the session `[副脑] …`. The title is
     * what hides the summon chip inside the companion, read by the Client from its local snapshot.
     */
    const marked = await markCompanion(mainSessionId, observerSessionId, missionText(mainSessionId))
    if (!marked.injected || !marked.renamed) {
      ctx.logger?.warn?.(`[dsh-observer] companion setup incomplete: ${marked.detail}`)
    }
    return {
      ok: true,
      observerSessionId,
      text:
        `已绑定 ${mainSessionId} → ${observerSessionId}。` +
        (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : ''),
    }
  }

  ctx.tools?.register({
    name: 'observer_bind',
    description:
      'Record a follower pointer for an ALREADY-CREATED session and send it the mission. Pair of the ' +
      'Client-side create: the Client owns `sessions.create`, this owns the durable pointer.',
    parameters: {
      type: 'object',
      properties: {
        mainSessionId: { type: 'string', description: 'Session being observed.' },
        observerSessionId: { type: 'string', description: 'The session that will follow it.' },
      },
      required: ['mainSessionId', 'observerSessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          observerSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args: { mainSessionId?: unknown; observerSessionId?: unknown }) => {
      const main = typeof args?.mainSessionId === 'string' ? args.mainSessionId.trim() : ''
      const observer = typeof args?.observerSessionId === 'string' ? args.observerSessionId.trim() : ''
      return bindExisting(main, observer)
    },
  })

  /**
   * v1.0.9 — THE HOST CREATES THE COMPANION. THIS IS THE ONE COMMAND, AND IT IS ON PURPOSE.
   *
   * The Client's `sessions.create` cannot place a session in a workspace on this build (the local
   * summary carries no `cwd`, so the create went out bare and the UI fell into the
   * "选择工作区" empty draft). The Host can do it properly because it can read the MAIN session's own
   * header — the authoritative `cwd` — and hand it to its own create call.
   *
   * A command is the only generic client→host channel this Host offers a third-party client half,
   * and `commands.execute` IS broadcast: this costs ONE row per summon, which the user explicitly
   * accepted. Everything else about the companion (placement, title, setting, pointer) happens on
   * the Host; the Client only asks and then opens the id it is given.
   */
  const resolveMainCwd = (mainSessionId: string): { cwd: string; source: string } => {
    try {
      const sessions = resolveService(ctx, 'sessions', 'get')
      const live = isRecord(sessions) && typeof sessions.get === 'function' ? sessions.get(mainSessionId) : undefined
      const candidates: Array<[string, unknown]> = [
        ['session.header.cwd', (live as any)?.header?.cwd],
        ['session.cwd', (live as any)?.cwd],
      ]
      for (const [source, value] of candidates) {
        if (typeof value === 'string' && value.length > 0) return { cwd: value, source }
      }
      // The working-directory service is the owner of a Session's effective directory.
      const workingDirectory = resolveService(ctx, 'workingDirectory', 'get')
      if (isRecord(workingDirectory) && typeof workingDirectory.get === 'function' && live !== undefined) {
        const path = workingDirectory.get(live as any)
        if (typeof path === 'string' && path.length > 0) return { cwd: path, source: 'workingDirectory.get' }
      }
      return { cwd: '', source: 'unavailable' }
    } catch (error) {
      return { cwd: '', source: `error: ${String((error as any)?.message ?? error)}` }
    }
  }

  const spawnCompanion = async (
    mainSessionId: string,
  ): Promise<{ ok: boolean; sessionId: string; text: string }> => {
    if (mainSessionId.length === 0) {
      return { ok: false, sessionId: '', text: '没有可绑定的主会话 id' }
    }
    if (mainOfObserver(mainSessionId).length > 0) {
      return { ok: false, sessionId: '', text: '这是一个副脑会话：它不能再召唤副脑' }
    }
    const existing = observerOf(mainSessionId)
    if (existing.length > 0) {
      return { ok: true, sessionId: existing, text: `该会话已有副脑 ${existing}` }
    }

    const located = resolveMainCwd(mainSessionId)
    ctx.logger?.info?.(`[dsh-observer] main cwd for ${mainSessionId}: ${JSON.stringify(located.cwd)} (${located.source})`)
    if (located.cwd.length === 0) {
      return { ok: false, sessionId: '', text: `拿不到主会话的工作目录（${located.source}），拒绝创建没有归属的会话` }
    }

    const controller = resolveService(ctx, 'sessionController', 'create')
    if (!isRecord(controller) || typeof controller.create !== 'function') {
      return { ok: false, sessionId: '', text: 'sessionController.create 不可用' }
    }

    let observerSessionId = ''
    try {
      const created = await controller.create({ cwd: located.cwd })
      observerSessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
    } catch (error) {
      return { ok: false, sessionId: '', text: `创建副脑会话失败：${String((error as any)?.message ?? error)}` }
    }
    if (observerSessionId.length === 0) {
      return { ok: false, sessionId: '', text: 'sessionController.create 返回了空 id' }
    }

    state.bindings[mainSessionId] = observerSessionId
    state.reverse[observerSessionId] = mainSessionId
    const written = recordPair(observerSessionId, mainSessionId, 'summoned')
    if (!written.ok) {
      delete state.bindings[mainSessionId]
      delete state.reverse[observerSessionId]
      return { ok: false, sessionId: observerSessionId, text: `绑定表写入失败：${written.error}` }
    }

    const marked = await markCompanion(mainSessionId, observerSessionId, missionText(mainSessionId))
    return {
      ok: true,
      sessionId: observerSessionId,
      text:
        `已创建副脑 ${observerSessionId}（cwd=${located.cwd}）` +
        (marked.detail.length > 0 ? `（部分步骤未完成：${marked.detail}）` : ''),
    }
  }

  /**
   * v1.2.0 — INCUBATE A MAIN SESSION FROM A CONSULTING ONE.
   *
   * THE ARCHITECTURE THIS IMPLEMENTS
   *
   *   A blank session starts with NO ROLE. The user talks to it; it clarifies requirements. When the
   *   work turns out to be big enough that one context window will not hold it, that session calls
   *   this tool and becomes the OBSERVER: the plan it just negotiated is handed to a NEWLY CREATED
   *   session, which becomes the MAIN. Small tasks never come here — the consulting session simply
   *   does the work itself.
   *
   * WHY THE PLAN TRAVELS AS A `developer/message`
   *
   * The plan is context the user already agreed to, not a prompt they typed. A prompt would admit a
   * turn, so the new main would start working before the user even looked at it; a developer message
   * lands as standing context and leaves the session asleep until the user speaks. This is the same
   * mechanism the companion setting uses, for the same reason.
   *
   * PLACEMENT COMES FROM THE CALLING SESSION, never from a guess: `resolveMainCwd` reads the
   * consulting session's own header, so the incubated main lands in the same workspace.
   */
  const spawnMainFromObserver = async (
    observerSessionId: string,
    plan: string,
    /** v1.6.0: the caller's assertion that the user approved this plan. */
    confirmation: { claimed: boolean; skipped?: boolean } = { claimed: false },
  ): Promise<{
    ok: boolean
    sessionId: string
    text: string
    /** v1.3.1: the diagnostic fields the tool result publishes. */
    stage?: string
    briefingRole?: 'user' | 'developer'
    briefingVisible?: boolean
    briefingEventSeq?: number | null
    briefingSourceKind?: string
    /** v1.5.0: whether the main was actually woken, and through which channel. */
    ignition?: { attempted: boolean; ok: boolean; channel?: string; reason?: string; alreadyIgnited?: true }
    /** v1.6.0: what the confirmation check found. */
    confirmation?: { ok: boolean; evidence: string; askedAtSeq: number | null; detail: string }
    diskLog?: unknown
  }> => {
    if (observerSessionId.length === 0) {
      return { ok: false, sessionId: '', text: '没有可用的发起会话 id' }
    }
    if (plan.trim().length === 0) {
      return { ok: false, sessionId: '', text: '方案为空：请先把确认过的执行计划作为 plan 传入' }
    }

    // One pair per session: a session that already carries a MAIN role must not hatch another one.
    // This comes BEFORE the confirmation gate on purpose: a structural impossibility outranks a
    // missing confirmation, and reporting the wrong one sends the session off to ask a pointless
    // question and retry.
    const existing = pairOf(observerSessionId)
    if (existing !== undefined && existing.observerSessionId !== observerSessionId) {
      return { ok: false, sessionId: '', text: '这个会话已经是主脑：不能再孵化主脑' }
    }

    /**
     * v1.6.0 — THE CONFIRMATION GATE, BEFORE ANYTHING IS CREATED.
     *
     * This is the only check whose failure must leave NO trace: no session, no reservation, no
     * binding row. The acceptance run that motivated it produced a fully working main built on a
     * plan the user had never seen — a failure that looks like success everywhere except at the
     * point that matters.
     *
     * The check is a FACT lookup (was `ask_user_question` called in this session?) plus the
     * caller's explicit assertion. It is not proof of consent — the answer arrives as a tool
     * result — but a session that never asked cannot produce the evidence, and that is the case
     * this gate has to catch.
     */
    let confirmationReport: { ok: boolean; evidence: string; askedAtSeq: number | null; detail: string } = {
      ok: false,
      evidence: 'not-asked',
      askedAtSeq: null,
      detail: '未执行检查',
    }
    {
      const queryForEvidence = resolveService(ctx, 'sessionQuery', 'readSession')
      const verdict = await checkConfirmation({
        claimed: confirmation.claimed === true,
        skipped: confirmation.skipped === true,
        sessionId: observerSessionId,
        readLog:
          isRecord(queryForEvidence) && typeof queryForEvidence.readSession === 'function'
            ? (id: string) => queryForEvidence.readSession(id)
            : undefined,
      })
      if (!verdict.ok) {
        ctx.logger?.warn?.(
          `[dsh-observer] incubation REFUSED for ${observerSessionId}: confirmation ${verdict.evidence} (${verdict.detail})`,
        )
        throw new InjectError('CONFIRMATION_REQUIRED', 'confirm', confirmationRefusal(verdict))
      }
      if (verdict.evidence === 'unverifiable' && verdict.warning.length > 0) {
        ctx.logger?.warn?.(`[dsh-observer] confirmation unverified: ${verdict.warning}`)
      }
      ctx.logger?.info?.(`[dsh-observer] confirmation check: ${verdict.evidence} — ${verdict.detail}`)
      confirmationReport = {
        ok: verdict.ok,
        evidence: verdict.evidence,
        askedAtSeq: verdict.askedAtSeq,
        detail: verdict.detail,
      }
    }

    /**
     * v1.2.3 — RE-INCUBATION IS A REPLACEMENT, SAID OUT LOUD.
     *
     * A consulting session may legitimately hatch again (the first main died, or the plan changed).
     * `recordPair` dissolves the old pair, but the caller deserves to know the previous main is no
     * longer bound — otherwise a stale `[主脑]` session sits in the sidebar with nothing pointing at
     * it and no explanation.
     */
    const replacedMainId =
      existing !== undefined && existing.observerSessionId === observerSessionId ? existing.mainSessionId : ''

    const located = resolveMainCwd(observerSessionId)
    ctx.logger?.info?.(
      `[dsh-observer] spawn_main from ${observerSessionId}: cwd=${JSON.stringify(located.cwd)} (${located.source})`,
    )
    if (located.cwd.length === 0) {
      // v1.3.0: a refusal is an ERROR with a stage, not a politely formatted sentence. The tool
      // result then carries `stage: 'resolve-cwd'` and the exact donor chain that failed, so
      // "why did nothing happen?" is answerable without reading the host log.
      throw new InjectError(
        'CWD_REQUIRED',
        'resolve-cwd',
        `拿不到发起会话 ${observerSessionId} 的工作目录（已尝试：${located.source}），拒绝创建没有归属的主脑`,
      )
    }

    // v1.3.0: `sessionController` is NO LONGER the creator. The main is a COLD artifact written
    // through `sessionPersistence`; the controller is only needed to rename the OBSERVER half,
    // which is cosmetic. Its absence is therefore a warning, not a reason to refuse the work.
    const controller = resolveService(ctx, 'sessionController', 'rename')

    // v1.2.1 — ask dsh-memory what this plan already has answers for, BEFORE handing it over.
    const arsenal = await findArsenal(plan, located.cwd)
    ctx.logger?.info?.(
      arsenal.ok
        ? `[dsh-observer] arsenal for the incubated main: ${arsenal.text.length} chars of skills/negatives`
        : `[dsh-observer] no arsenal: ${arsenal.detail}`,
    )
    const briefing = composeMainBriefing(plan, arsenal.ok ? arsenal.text : '')
    /**
     * The sidebar name for a COLD main.
     *
     * A host id looks like `session-697a0c0a-7048-…`, so `slice(0, 8)` is the constant stem
     * `session-`. `{main}` is replaced by the injection core with THIS main's own id tag, which is
     * the only part that distinguishes it from the previous incubation.
     */
    const mainTitle = '[主脑] 由副脑孵化 · {main}'

    /**
     * v1.9.0 — THE INCUBATION NOW GOES THROUGH THE 彼岸 LAYER.
     *
     * This block used to call `injectColdSession` from `./core/observer-inject.js`. That module is
     * kept on disk as an ARCHIVE and is no longer imported: the write path is
     * `paradise.session.create(items)`, and the layer owns the skeleton, the surface rules, the
     * cold-read verification and the rollback.
     *
     * THE ERROR CONTRACT IS PRESERVED DELIBERATELY. The layer answers a RECEIPT (`ok: false` with
     * `code` + `stage`) rather than throwing, so this block converts it back into the exception the
     * tool handler has always reported — same shape, same stage vocabulary, same verbatim stack. A
     * migration that changed the failure surface would have made every past incident report
     * unrecognisable.
     */
    const writer = await ensureWriteAdapter(ctx)
    if (!writer.ok || writer.session === undefined) {
      /**
       * THE STAGE AND THE CODE, NOT THE HEADLINE.
       *
       * The tool handler ALREADY renders `孵化失败（stage=…）：<message>`, so a message that began with
       * `孵化失败@…` produced `孵化失败（stage=append）：孵化失败@append：…` — the doubled prefix an
       * earlier release spent a round removing. So these throws carry `[CODE] message` and the stage on
       * the error object, and the headline is composed exactly once, at the boundary.
       */
      throw stageError('write-adapter', 'PARADISE_WRITE_UNAVAILABLE', `写路径不可用 —— ${writer.reason}。主脑没有创建，也没有产生需要清理的会话。`)
    }
    const writeAdapter = writer.session
    if (!writeAdapter.capabilities.create) {
      const missing = writeAdapter.capabilities.unavailable
        .filter((entry) => entry.capability === 'create')
        .map((entry) => entry.consequence)
        .join('；')
      throw stageError(
        'prepare',
        'WRITE_CAPABILITY_ABSENT',
        `本宿主无法写出冷会话 —— ${missing || '未知原因'}。已按红线拒绝，未创建任何会话。`,
      )
    }

    // The cwd is resolved through the injection core's own resolver (still imported for this ONE
    // purpose — it is a read-only cwd chain, not a write path), so the placement and the artifact
    // agree by construction.
    let resolvedCwd = located.cwd
    let resolvedCwdSource = located.source
    try {
      const inherited = await resolveInheritedCwdAsync(ctx, observerSessionId)
      resolvedCwd = inherited.cwd
      resolvedCwdSource = inherited.source
    } catch (error) {
      ctx.logger?.warn?.(
        `[dsh-observer] injector cwd resolver found nothing (${String((error as any)?.message ?? error)}); ` +
          `keeping ${JSON.stringify(resolvedCwd)} from ${resolvedCwdSource}`,
      )
    }
    if (resolvedCwd.trim().length === 0) {
      throw stageError(
        'resolve-cwd',
        'CWD_REQUIRED',
        `拒绝创建没有归属的主脑：发起会话 ${observerSessionId} 的工作目录为空`,
      )
    }

    /**
     * THE CONTENT AND THE TITLE ARE DIFFERENT THINGS, AND THE ADAPTER NEEDS BOTH.
     *
     * `items` is the PLAN — the thing the main must act on, placed as a visible message.
     * `title` is the sidebar label. Passing the plan as a title (which the first draft of this
     * migration did) produces a session whose transcript contains its own name and no work: the
     * tests caught it immediately because the briefing check reads the plan text verbatim.
     */
    const created = await writeAdapter.create({
      cwd: resolvedCwd,
      title: mainTitle,
      /**
       * INHERIT FROM THE OBSERVER, so the main resumes under the same provider/model/preset/policy.
       * Without this a freshly hatched main silently runs under different policy than the session that
       * hatched it — the kind of change nobody notices until a cost or permission surprise.
       */
      inheritFrom: observerSessionId,
      items: [
        {
          visibility: 'visible',
          text: briefing,
          origin: 'plugin:observer:briefing',
        },
      ],
    })
    if (!created.ok || created.session === undefined) {
      const code = created.error?.code ?? 'CREATE_FAILED'
      const stage = created.stage || 'create'
      const wrapped = stageError(stage, code, created.error?.message ?? '创建失败')
      ;(wrapped as any).warnings = created.warnings
      throw wrapped
    }

    /**
     * THE RECEIPT SHAPE THE REST OF THIS FUNCTION READS.
     *
     * Adapted rather than aliased so the fields keep their MEANING: `briefingRole` is derived from
     * what the adapter says it actually placed, never assumed from the request.
     */
    const injected = {
      sessionId: created.session.id,
      cwd: created.session.cwd,
      cwdSource: resolvedCwdSource,
      appended: created.appended ?? 0,
      verified: created.verified === true,
      workspaceAttached: created.workspaceAttached === true,
      types: created.types ?? [],
      warnings: created.warnings,
      briefingRole: (created.rendered?.[0]?.rendered === true ? 'user' : 'developer') as 'user' | 'developer',
      briefingVisible: created.rendered?.[0]?.rendered === true,
      briefingEventSeq: created.contentSeq ?? null,
      briefingSourceKind: created.contentSourceKind ?? '',
    }

    const mainSessionId = injected.sessionId
    const problems: string[] = []

    // Only NOW is the pair recorded: a binding written before the artifact exists is how a
    // sidebar row survived a failure and pointed at a session with no plan in it.
    const written = recordPair(observerSessionId, mainSessionId, 'incubated')
    if (!written.ok) {
      // The artifact is good but the pointer is not durable. Un-bind and destroy the artifact:
      // an unbound main is invisible to `followTransfer` and would never move with its observer.
      // `recordPair` restored the in-memory table on failure, so there is no row to remove here.
      const rolled = await writer.deletes!(ctx, mainSessionId, `绑定表写入失败：${written.error ?? 'unknown'}`)
      const failure = stageError(
        'record-pair',
        'BINDING_WRITE_FAILED',
        `绑定表写入失败：${written.error ?? 'unknown'}` +
          `（主脑 ${mainSessionId} 已回滚：removed=${String(rolled.removed)}, marked=${String(rolled.marked)}, ` +
          `notes=${rolled.notes.join(', ') || 'none'}）`,
      )
      ;(failure as any).rollback = rolled
      throw failure
    }

    ctx.logger?.info?.(
      `[dsh-observer] incubated main ${mainSessionId}: ${injected.appended} events, ` +
        `verified=${String(injected.verified)}, workspaceAttached=${String(injected.workspaceAttached)}, ` +
        `cwd=${injected.cwd} (${injected.cwdSource})`,
    )
    problems.push(...injected.warnings)
    if (!injected.verified) problems.push('写入未经冷读校验（sessionQuery 不可用）')
    if (!injected.workspaceAttached) problems.push('未能挂到发起会话的工作区分组（侧边栏可能显示未分组）')

    /**
     * v1.9.0 — IGNITION GOES THROUGH THE SAME ADAPTER.
     *
     * `igniteSession` is replaced by `paradise.session.trigger`, which is the same chain (marker,
     * idempotence check against the target's own log, required AbortSignal, mode fallback) moved into
     * the layer. The receipt is adapted back into the shape this function reports, so the tool result
     * and its tests keep reading the same fields.
     *
     * ORDERING IS UNCHANGED AND IS THE WHOLE FAILURE MODE: ignition runs after the artifact is
     * durable, verified, and bound. If it ran first, the main could start working and fail before
     * anything knew it existed.
     *
     * A FAILED IGNITION STILL DOES NOT UNDO THE INCUBATION. The session is real, carries the plan and
     * is openable by hand; the failure is REPORTED rather than turned into a rollback.
     */
    const ignition = await (async (): Promise<{
      attempted: boolean
      ok: boolean
      channel?: string
      reason?: string
      alreadyIgnited?: true
    }> => {
      if (!writeAdapter.capabilities.trigger) {
        return {
          attempted: false,
          ok: false,
          reason: '本宿主没有 prompt 通道（sessionController.prompt 未挂载）',
        }
      }
      try {
        const result = await writeAdapter.trigger(
          { id: mainSessionId, cwd: injected.cwd },
          {
            text: DEFAULT_IGNITION_PROMPT,
            mode: 'queue',
            origin: 'plugin:observer:ignition',
          },
        )
        if (result.ok) {
          ctx.logger?.info?.(
            `[dsh-observer] ignited ${mainSessionId} via ${result.channel ?? 'none'}` +
              `${result.alreadyTriggered === true ? ' (already ignited)' : ''}`,
          )
          return {
            attempted: true,
            ok: true,
            ...(result.channel === undefined ? {} : { channel: result.channel }),
            ...(result.alreadyTriggered === true ? { alreadyIgnited: true as const } : {}),
          }
        }
        ctx.logger?.warn?.(
          `[dsh-observer] ignition FAILED for ${mainSessionId}: ${result.error?.message ?? 'unknown'}`,
        )
        return {
          attempted: true,
          ok: false,
          reason: `[${result.error?.code ?? 'TRIGGER_FAILED'}] ${result.error?.message ?? 'unknown'}`,
        }
      } catch (error) {
        // `trigger` is designed not to throw; if it somehow does, the incubation still stands.
        ctx.logger?.warn?.(
          `[dsh-observer] ignition threw for ${mainSessionId}: ${String((error as any)?.message ?? error)}`,
        )
        return { attempted: false, ok: false, reason: String((error as any)?.message ?? error) }
      }
    })()
    if (!ignition.ok) {
      problems.push(
        `自动点火失败（主脑已创建、可手动打开）：${ignition.reason ?? '未知原因'}` +
          (ignition.attempted ? '' : '（没有可用的点火通道）'),
      )
    }

    /**
     * v1.7.0 — THE OBSERVER STOPS BEING A BYSTANDER THE MOMENT THE MAIN EXISTS.
     *
     * Started AFTER the artifact is durable, verified, bound and ignited — in that order, so the
     * supervisor never watches a session that failed to come into being. It is started even when
     * ignition failed: a main that the user opens by hand is still a main that needs a supervisor.
     *
     * The role text is rewritten in the SAME breath, because the duty and the supervision are one
     * fact stated twice: `SUPERVISOR_DUTY_TEXT` tells the observer what the plugin now does on its
     * behalf, and `supervisePair` is that claim being true.
     */
    const supervisor = supervisePair(observerSessionId, mainSessionId, 'incubated')
    const duty = await injectSetting(
      observerSessionId,
      `${missionText(mainSessionId)}\n\n${SUPERVISOR_DUTY_TEXT}`,
    )
    if (!duty.ok) {
      problems.push(`监理职责写入副脑失败（${duty.detail}）`)
    }

    // Title the OBSERVER half. The MAIN's title is already inside its tape (a cold session has
    // no live append to rename it with, and `session/title` in the tape is what the sidebar
    // reads on load).
    if (isRecord(controller) && typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId: observerSessionId, title: `[副脑] 孵化 ← ${shortSessionTag(mainSessionId, 12)}` })
      } catch (error) {
        problems.push(`重命名 ${observerSessionId} 失败：${String((error as any)?.message ?? error)}`)
      }
    } else {
      problems.push('sessionController.rename 不可用')
    }

    /**
     * v1.3.1 — THE DIAGNOSTIC TRAVELS WITH THE SUCCESS.
     *
     * "看不见注入消息" was true while the injection was ALSO true: the write had always worked and
     * the render never showed it. So a successful incubation now reports, in the tool result, the
     * stage it completed AND what the artifact contains — including a durable-log read (every zstd
     * frame, not the first) and whether the briefing's event type is one the conversation actually
     * renders. A green result that cannot answer those questions is how the last round was spent.
     *
     * v1.8.0: the read itself now happens in `dsh-paradise` (`read/disk.ts`), so this call is ASYNC.
     * The receipt fields below are UNCHANGED — the adapter maps the layer's reading back into the
     * `DiskLogReport` shape this plugin has always printed, so migrating the layer moved no field
     * the user or a test can see. What DID change is the failure shape: a missing layer now yields
     * `pathSource: 'paradise-unavailable'` plus the sentence that says what still holds.
     */
    const diskLog = await inspectSessionLog(ctx, mainSessionId, injected.cwd)
    const visible = injected.briefingRole === 'user'
    const text = [
      `stage: inject_success`,
      `已孵化主脑 ${mainSessionId}（cwd=${injected.cwd} via ${injected.cwdSource}）。`,
      `注入：${injected.appended} 个事件，角色=${injected.briefingRole}` +
        `（${visible ? '会话里可见' : '仅上下文，不可见'}），冷读校验 ${injected.verified ? '通过' : '跳过'}。`,
      `方案事件：seq=${String(injected.briefingEventSeq)}，source.kind=${JSON.stringify(injected.briefingSourceKind)}，` +
        `${injected.briefingVisible ? '属于会话会渲染的类型' : '不是会话渲染的类型（这就是看不见的原因）'}。`,
      `自动点火：${ignition.ok
        ? `${ignition.alreadyIgnited === true ? '该主脑已在运行（此前已点火）' : '已触发'}（via ${ignition.channel ?? 'n/a'}）`
        : `失败 —— ${ignition.reason ?? '未知原因'}${ignition.attempted ? '' : '（无可用点火通道）'}；主脑已创建，可手动打开`}`,
      `需求对齐：${confirmationReport.evidence === 'asked'
        ? `已核实（seq=${String(confirmationReport.askedAtSeq)} 调用过 ask_user_question）`
        : confirmationReport.evidence === 'unverifiable'
          ? '未核实（无法读取会话日志，按调用方声明处理）'
          : '未完成'}`,
      `用户确认：${confirmation.claimed === true ? '调用方声明已确认' : '未声明（跳过确认）'}`,
      /**
       * v1.5.0 — WHICH SURFACES THE TRANSCRIPT WILL SHOW, AND WHAT THE DISK ACTUALLY HOLDS.
       *
       * Two lessons are baked into these two lines:
       *
       *   - "the model can read it" and "the user can see it" are DIFFERENT facts. The acceptance
       *     run showed the plan in the thinking while the transcript stayed empty, so the receipt
       *     names the surfaces the plan landed on instead of asserting "visible".
       *   - "could not read" is not "is not there". An earlier version printed
       *     `磁盘核对：没有找到承载方案的消息` even when the file was never opened, which answered a
       *     question it had not actually asked. The three outcomes are now distinct.
       */
      `磁盘日志：${diskLog.readable
        ? `${diskLog.bytes} 字节 / ${diskLog.frameCount} 个 zstd 帧 / ${diskLog.eventCount} 个事件` +
          `（${diskLog.eventTypes.join(' → ')}）`
        : `未读取（${diskLog.pathSource}${diskLog.notes.length > 0 ? '；' + diskLog.notes[diskLog.notes.length - 1] : ''}）` +
          `—— 以上"方案事件"一行来自冷读，不是磁盘`}`,
      !diskLog.readable
        ? diskLog.pathSource === 'paradise-unavailable' || diskLog.pathSource === 'paradise-error'
          ? `磁盘核对：跳过（${PARADISE_MISSING_CONSEQUENCE}）`
          : '磁盘核对：跳过（读不到日志，不作结论；以上冷读结论仍然有效）。'
        : diskLog.briefing === null
          ? '磁盘核对：日志可读，但里面没有承载方案的消息 —— 这才是"没写进去"。'
          : `磁盘核对：${diskLog.briefing.type} seq=${diskLog.briefing.seq}，${diskLog.briefing.textLength} 字符，` +
            `role=${diskLog.briefing.role}，渲染=${diskLog.renderedByConversation}。`,
      `本会话成为副脑 ${observerSessionId}。`,
      `监理：已启动（监听 ${supervisor.mainSessionId} 的只读事件流；连续失败/停滞会自动纠偏，` +
        `完成或空闲会自动提炼记忆）。` +
        (duty.ok ? '' : `职责文本写入失败：${duty.detail}`),
      replacedMainId.length > 0 && replacedMainId !== mainSessionId
        ? `上一个主脑 ${replacedMainId} 的绑定已解除（它仍在侧边栏，只是不再是本会话的主脑）。`
        : '',
      problems.length > 0 ? `部分步骤未完成：${problems.join('；')}` : '',
    ]
      .filter((line) => line.length > 0)
      .join('\n')

    return {
      ok: true,
      stage: 'inject_success',
      sessionId: mainSessionId,
      briefingRole: injected.briefingRole,
      briefingVisible: injected.briefingVisible,
      briefingEventSeq: injected.briefingEventSeq,
      briefingSourceKind: injected.briefingSourceKind,
      ignition,
      confirmation: confirmationReport,
      diskLog,
      text,
    }
  }

  const commands = resolveService(ctx, 'commands', 'register')
  if (isRecord(commands) && typeof commands.register === 'function') {
    commands.register({
      name: 'observer-spawn',
      description: '由宿主创建副脑：/observer-spawn <mainSessionId>',
      handler: async (invocation: any) => {
        try {
          const raw =
            invocation?.rawInput ?? invocation?.line ?? invocation?.args?.rawInput ?? invocation?.text ?? ''
          const mainSessionId = String(raw).replace(/^\/\S+\s*/u, '').trim()
          const result = await spawnCompanion(mainSessionId)
          /**
           * Success answers with the BARE ID (the client uses it to open the session); a failure
           * answers with the REASON. Returning the id unconditionally — which the first version
           * did — threw every error message away and left the client with an empty string and no
           * way to say what went wrong.
           */
          return {
            kind: result.ok ? ('success' as const) : ('error' as const),
            text: result.ok ? result.sessionId : result.text,
          }
        } catch (error) {
          const detail = String((error as any)?.message ?? error)
          ctx.logger?.warn?.(`[dsh-observer] observer-spawn threw: ${detail}`)
          return { kind: 'error' as const, text: `副脑创建失败：${detail}` }
        }
      },
    })
    ctx.logger?.info?.('[dsh-observer] one command registered: observer-spawn (host-side creation)')
  }

  ctx.tools?.register({
    name: 'observer_create',
    description:
      'Summon a companion observer (副脑) for the CURRENT session. The Host resolves the session\'s own ' +
      'working directory, creates the companion THERE, gives it a [系统设定] background, titles it ' +
      '[副脑] … and records the follower pointer. Returns the new session id so the caller can open it. ' +
      'The observer is never retired and never sliced — a transfer only rewrites its pointer.',
    parameters: {
      type: 'object',
      properties: { mainSessionId: { type: 'string', description: 'Session to observe. Default: the calling session.' } },
      additionalProperties: false,
    },
    /**
     * v0.1.3 P0 — an explicit OUTPUT contract is mandatory on 0.2.2; without it the whole
     * entry fails to activate (and takes the Web boot with it).
     */
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          observerSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    /**
     * v1.1.0 — PLAN B: THE TOOL IS THE ENTRY POINT.
     *
     * The UI chip is gone (the gateway makes every command broadcast, so a button could never be
     * silent and a client-side create could never place the session). The MODEL calls this tool
     * instead: a tool result travels straight back to the model, so the new id is readable — which
     * is exactly the property the command channel lacks.
     *
     * `spawnCompanion` does the real work: resolve the main session's own cwd, create the companion
     * there, title it, write the setting as a `developer/message` (context, so the agent stays
     * asleep) and record the pointer. The id is answered under BOTH `sessionId` and
     * `observerSessionId` so either name is usable by the caller.
     */
    execute: async (args: { mainSessionId?: unknown }, exec: any) => {
      const explicit = typeof args?.mainSessionId === 'string' ? args.mainSessionId.trim() : ''
      const mainSessionId = explicit.length > 0 ? explicit : typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      const spawned = await spawnCompanion(mainSessionId)
      return {
        ok: spawned.ok,
        sessionId: spawned.sessionId,
        observerSessionId: spawned.sessionId,
        text: spawned.text,
      }
    },
  })

  /**
   * The blank-page entry: a companion to THINK WITH before there is anything to bind to.
   * Deliberately not a follower — it has no main session yet, and pretending otherwise would
   * be the same class of lie as the `{ok:true}` receipt.
   */
  ctx.tools?.register({
    name: 'observer_consult',
    description:
      'Open a pre-discussion companion (前置需求磋商副脑) that is NOT bound to any session: it clarifies ' +
      'requirements and, once agreed, emits a final Prompt to paste into the main session.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          observerSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => createObserver('', 'consult'),
  })

  /**
   * v1.4.0 — THE TRIGGER POLICY MOVED OUT OF THIS COMMENT AND INTO THE DESCRIPTION.
   *
   * What this replaces: "call it only after the user has CONFIRMED a plan AND the work is too large
   * for a single context window". A live session read that, received an explicit order to hatch,
   * measured the task, disagreed with the user, and did the work itself — twice, the second time
   * treating the repeated order as a template reminder. The wording was the cause: it made the
   * user's instruction a FACTOR in a judgement instead of the judgement's premise.
   *
   * The text now lives in `src/core/policy.ts` so the tool description and the system-prompt
   * section are written once and cannot drift apart — that drift is exactly the class of defect
   * this project keeps finding between its two plugins.
   */
  ctx.tools?.register({
    name: 'observer_spawn_main',
    description: SPAWN_MAIN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            'The agreed execution plan, verbatim: goal, constraints, steps, verification. Becomes the main ' +
            'session\'s standing context and is shown to the user in the new window, so write it for the ' +
            'executor rather than as a chat reply.',
        },
        observerSessionId: {
          type: 'string',
          description: 'The consulting session that is hatching the main. Default: the calling session.',
        },
        /**
         * v1.6.0 — THE GATE, AS A REQUIRED ARGUMENT.
         *
         * A description is a probability. An argument the caller must assert, which the handler
         * refuses without, is the closest thing a tool schema offers to a barrier. Two acceptance
         * runs failed in opposite directions while the rule lived only in prose.
         */
        userConfirmed: {
          type: 'boolean',
          description:
            'Set to true ONLY after you have shown the plan through ask_user_question AND the user ' +
            'explicitly replied 确认 / 同意 / 开始 / 可以 (or picked the confirm option). The Host ' +
            'verifies that ask_user_question was actually called in this session; without this ' +
            'argument, or without that evidence, the incubation is REFUSED.',
        },
        skipConfirmation: {
          type: 'boolean',
          description:
            'Set to true ONLY when the user explicitly said to skip confirmation for this handoff ' +
            '(「不用确认」「跳过确认」「别问了直接孵化」). Words about hatching alone are NOT this.',
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          mainSessionId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    /**
     * v1.3.0 — THE REAL ERROR REACHES THE MODEL, WITH ITS STACK, IN THE TOOL RESULT.
     *
     * `spawnMainFromObserver` now throws instead of returning a polite half-success: the failure
     * is the only honest answer when the plan was not written. A thrown error inside a tool
     * handler is not guaranteed to preserve its text on the way to the model, so it is ALSO
     * answered as `ok:false` with the stack verbatim. Both channels carry the same cause; neither
     * swallows it.
     */
    execute: async (args: { plan?: unknown; observerSessionId?: unknown; userConfirmed?: unknown; skipConfirmation?: unknown }, exec: any) => {
      const plan = typeof args?.plan === 'string' ? args.plan : ''
      const explicit = typeof args?.observerSessionId === 'string' ? args.observerSessionId.trim() : ''
      const observerSessionId = explicit.length > 0 ? explicit : typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      try {
        const spawned = await spawnMainFromObserver(observerSessionId, plan, {
          claimed: args?.userConfirmed === true,
          skipped: args?.skipConfirmation === true,
        })
        /**
         * v1.3.1 — THE SUCCESS PATH CARRIES THE SAME DIAGNOSTIC FIELD AS THE FAILURE PATH.
         *
         * The failure result has always named its `stage`; the success result did not, so "did it
         * get to injection, and what does the artifact contain?" could only be answered by reading
         * the host log. `stage`, the briefing role and the disk-log report are copied out here.
         */
        return {
          ok: spawned.ok,
          stage: spawned.stage ?? (spawned.ok ? 'inject_success' : 'unknown'),
          sessionId: spawned.sessionId,
          mainSessionId: spawned.sessionId,
          briefingRole: spawned.briefingRole ?? '',
          briefingVisible: spawned.briefingVisible === true,
          briefingEventSeq: spawned.briefingEventSeq ?? null,
          briefingSourceKind: spawned.briefingSourceKind ?? '',
          /**
           * v1.5.0: the ignition outcome travels too. Without it, "did the main actually start?"
           * is answerable only by watching the session, which is exactly the ambiguity this round
           * exists to remove.
           */
          ignition: spawned.ignition ?? null,
          confirmation: spawned.confirmation ?? null,
          diskLog: spawned.diskLog ?? null,
          text: spawned.text,
        }
      } catch (error) {
        const message = String((error as any)?.message ?? error)
        const stack = typeof (error as any)?.stack === 'string' ? (error as any).stack : ''
        const stage = typeof (error as any)?.stage === 'string' ? (error as any).stage : 'unknown'
        const rollback = (error as any)?.rollback
        const warnings: string[] = Array.isArray((error as any)?.warnings) ? (error as any).warnings : []
        ctx.logger?.warn?.(`[dsh-observer] observer_spawn_main failed: ${message}\n${stack}`)
        return {
          ok: false,
          sessionId: '',
          mainSessionId: '',
          stage,
          rollback: rollback === undefined ? null : rollback,
          warnings,
          error: message,
          stack,
          text:
            `孵化失败（stage=${stage}）：${message}\n\n` +
            `原始堆栈：\n${stack || '(no stack)'}\n\n` +
            (rollback === undefined
              ? '（失败发生在任何会话落盘之前，没有产生需要清理的会话。）'
              : `回滚结果：removed=${String(rollback?.removed)} marked=${String(rollback?.marked)} ` +
                `notes=${Array.isArray(rollback?.notes) ? rollback.notes.join(', ') : 'none'}`) +
            (warnings.length > 0 ? `\n\n过程中的告警：\n- ${warnings.join('\n- ')}` : ''),
        }
      }
    },
  })

  ctx.tools?.register({
    name: 'observer_status',
    description:
      'Read the follower pointer (who observes whom), the supervisor state for every incubated main ' +
      '(failure streak, stalled turns, nudge count, harvest count), the 彼岸层 (dsh-paradise) status ' +
      'plus any pending focus request. Read-only. ackFocus consumes that one-shot request so the UI ' +
      'can say "I have moved the window".',
    parameters: {
      type: 'object',
      properties: { ackFocus: { type: 'boolean', description: 'Consume the pending focus request.' } },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          bindings: { type: 'object' },
          reverse: { type: 'object' },
          // Nullable on purpose: "no pending focus" is a real, normal state. The Loader's
          // schema subset has NO `anyOf` — using it fails activation with
          // "unsupported JSON schema … anyOf is not a supported keyword" and the entry dies
          // (the whole plugin half never mounts). `oneOf` IS supported.
          focus: { oneOf: [{ type: 'object' }, { type: 'null' }] },
          focusConsumed: { type: 'boolean' },
          /** v1.7.0: one entry per supervised main. An empty map means nothing was incubated. */
          supervisors: { type: 'object' },
          /**
           * v1.8.0: the 彼岸层's live status. `resolved: false` means no read has happened yet;
           * `available: false` means the layer is missing and says what that costs.
           */
          paradise: { type: 'object' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args: { ackFocus?: unknown }) => {
      const pending = state.focus
      if (args?.ackFocus === true) takeFocus()
      const supervisorView: Record<string, unknown> = {}
      for (const [mainId, supervisor] of supervisors.entries()) supervisorView[mainId] = supervisor.describe()
      return {
        ok: true,
        bindings: { ...state.bindings },
        reverse: { ...state.reverse },
        focus: pending === null ? null : { ...pending },
        supervisors: supervisorView,
        paradise: paradiseStatus(),
        ...(args?.ackFocus === true ? { focusConsumed: true } : {}),
      }
    },
  })
}

/** Test seam: the in-process state, so a test can assert without touching disk. */
export function debugObserverState(): ObserverBindings {
  return JSON.parse(JSON.stringify(state))
}

/**
 * v1.3.0 test seam: the pure tape functions of the injection core.
 *
 * v1.9.0 — THE VALIDATORS ARE NO LONGER IN THIS BUNDLE. They live in `dsh-paradise`, which is where
 * the write path went, and their behavioural tests moved with them (`dsh-paradise/test/disk.test.mjs`,
 * `write-lifecycle.test.mjs`, `conformance.test.mjs`). What remains here is the seam for the pieces
 * this bundle still owns:
 *
 *   - `resolveInheritedCwdAsync` — the cwd donor chain, still the observer's decision;
 *   - `ensureWriteAdapter` / `writePathStatus` — the WRITE seam, so a test can assert the layer is
 *     reached and what this plugin does when it is not;
 *   - `deleteSession` — the layer's rollback, exposed so a test can drive the failure paths.
 *
 * Keeping an empty or half-populated `injectionInternals` would have been worse than removing the
 * dead entries: a test asserting on a function that no longer participates in the write path is a
 * test that certifies nothing.
 */
export const injectionInternals = {
  resolveInheritedCwdAsync,
  ensureWriteAdapter,
  writePathStatus,
}

/**
 * v1.3.1 test seam: the durable-log reader — v1.8.0: now a THIN FORWARDER to `dsh-paradise`.
 *
 * Kept, not removed, for two reasons:
 *
 *   1. The shape is what `inspectSessionLog` has always returned, and the reader's own behavioural
 *      tests (multi-frame decoding, invisible-role reporting, "unreadable is not missing") live in
 *      `dsh-paradise` now — so what remains here is the BRIDGE's contract, which is exactly what a
 *      test should cover from this side: does the observer reach the layer, and what does it print
 *      when the layer is not there.
 *   2. `resetParadiseCache` is the seam that makes the degradation case testable without uninstalling
 *      anything.
 */
export const diskLogInternals = {
  inspectSessionLog,
  escapeSessionDirName,
  ensureParadise,
  paradiseStatus,
  resetParadiseCache,
  unavailableBinding,
  PARADISE_MISSING_CONSEQUENCE,
}

/**
 * v1.4.0 test seam: the trigger policy.
 *
 * These are WORDS, and words regress silently — a paraphrase during a later edit can restore the
 * exact wording that let a session outvote its user. Exposing them lets the tests assert on the
 * sentences the model actually reads, instead of on a summary of them.
 */
export const policyInternals = {
  OBSERVER_MISSION_TEXT,
  SPAWN_MAIN_DESCRIPTION,
  TRIGGER_SECTION_NAME,
  TRIGGER_SECTION_TEXT,
  permitsExecution,
}

/**
 * v1.5.0 test seam: the ignition channel — v1.9.0: MOST OF IT MOVED TO THE LAYER.
 *
 * Ignition now runs through `paradise.session.trigger`, whose own tests
 * (`dsh-paradise/test/write-lifecycle.test.mjs`) cover the three failure modes this seam used to
 * expose: a missing AbortSignal, a double admission, and "unknown" reported as "already done".
 *
 * What remains reachable here is what this plugin still OWNS: the prompt text it hands to the layer
 * (so a test can assert the main is told to START rather than to summarise) and the marker, which is
 * the contract between the two sides.
 *
 * NOTE what is NOT here any more: `igniteSession`, `alreadyIgnited`, `ignitionDeadline`,
 * `describePromptFailure`, `isIgnitionText`. Leaving them exported would have meant this bundle still
 * carrying a second ignition implementation — the exact duplication the 彼岸 layer exists to end.
 */
export const ignitionInternals = {
  DEFAULT_IGNITION_PROMPT,
  IGNITION_MARKER,
}

/**
 * v1.6.0 test seam: the confirmation gate.
 *
 * The gate exists because two acceptance runs failed in opposite directions while the rule lived
 * only in prose. A gate nobody can test is prose with extra steps, so its pieces are reachable here.
 */
export const confirmationInternals = {
  ASK_TOOL_NAME,
  checkConfirmation,
  confirmationRefusal,
  findAskEvidence,
}

/**
 * v1.7.0 test seam: the supervisor.
 *
 * The two halves are exposed separately on purpose: `monitorInternals` is the PURE decision machine
 * (no clock, no services) and `supervisorInternals` is the delivery half. A test can pin "3
 * failures in a row produce exactly one correction" without a host, and "the correction went out
 * through steer" with one.
 */
export const monitorInternals = {
  FAILURE_STREAK_LIMIT,
  STALL_TURNS_LIMIT,
  NUDGE_COOLDOWN_MS,
  NUDGE_MIN_SEQ_GAP,
  NUDGE_CAP,
  NUDGE_MARKER,
  HARVEST_COOLDOWN_MS,
  DEFAULT_MONITOR_OPTIONS,
  createMonitorState,
  describeMonitorState,
  failureNudgeText,
  harvestGate,
  stallNudgeText,
  stepMonitor,
  todoItemsFromArguments,
}

export const supervisorInternals = {
  DEFAULT_SUPERVISOR_IDLE_MS,
  SUPERVISOR_DUTY_TEXT,
  createSupervisor,
}

/**
 * Test seam: follow a transfer without an event bus.
 *
 * `observerSessionId` is kept in the answer for older tests that only asked about the companion
 * half; `role` and `otherSessionId` describe what actually moved in v1.2.0.
 */
export function debugFollowTransfer(
  sourceSessionId: string,
  newSessionId: string,
): { followed: boolean; role: 'main' | 'observer' | ''; otherSessionId: string; observerSessionId: string } {
  const result = followTransfer(sourceSessionId, newSessionId)
  return {
    ...result,
    observerSessionId: result.role === 'observer' ? newSessionId : result.role === 'main' ? result.otherSessionId : '',
  }
}

export { EMPTY }

/**
 * v0.1.3: `manifest.json` names `activate`, and the Loader looks for it. Exporting the alias
 * is what turns "导入失败" into a successful import — the entry loader checks this name
 * before it ever calls the function.
 */
export const activate = apply
