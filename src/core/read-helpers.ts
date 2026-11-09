/**
 * THE READ-ONLY HELPERS — everything this plugin still needs from the archived write path.
 *
 * ── WHY THIS FILE EXISTS (批次 C-2, 2026-11-09) ────────────────────────────────────────────────
 *
 * `core/observer-inject.ts` was this plugin's ORIGINAL write path: 1,314 lines that created a cold
 * session, appended a tape, flushed, verified by cold read, and rolled back. When the write path moved
 * into `dsh-paradise`, that file became half-dead: ~1,200 lines of write machinery nobody calls, plus
 * FOUR helpers `src/index.ts` still imports. So the whole file stayed inlined into the shipped bundle
 * and could neither be deleted nor cleaned.
 *
 * This file carries those four helpers — `InjectError`, `resolveService`, `shortSessionTag`,
 * `resolveInheritedCwdAsync` — plus the three private helpers they need. BEHAVIOUR IS UNCHANGED: same
 * bodies, same codes, same messages, same order of fallbacks. The archived file is gone and
 * `bundle.mjs`'s reachability walk drops it automatically, because nothing imports it any more.
 *
 * ── WHY MOVE RATHER THAN IMPORT FROM `dsh-paradise` ────────────────────────────────────────────
 *
 * A `shortSessionTag` and a service resolver DO exist in the layer, and copying them looks like
 * duplication. It is not the same thing:
 *
 *   - the layer does not EXPORT its adapter-level `service()`; reaching it would mean importing another
 *     package's internals — the coupling the layer exists to remove;
 *   - a cross-package import of a 4-line string helper buys a hard dependency for nothing;
 *   - `InjectError` carries THIS plugin's `stage`/`code` vocabulary, which the layer does not own;
 *   - `resolveInheritedCwdAsync` walks the observer-specific cwd donor chain (live session → header →
 *     `workingDirectory` → durable `sessionQuery`), which is this plugin's policy, not a physical fact.
 *
 * ── THE PRIVATE HELPERS CAME ALONG, AND THAT IS THE POINT ─────────────────────────────────────
 *
 * `asRecord` and `isAbsoluteCwd` are duplicated from the archived file rather than imported from
 * elsewhere for the same reason: they are three lines each, and a shared home for them would be a new
 * module whose only purpose is to serve one caller.
 */

/* ── the error type ───────────────────────────────────────────────────────────────────────── */

/**
 * A refusal from this plugin's write path, carrying the STEP it failed in.
 *
 * The CODE is prefixed to the message on purpose. A log line reading
 * `[STEP_OUTSIDE_TURN] developer/message 的 turn/step 与打开的 1/1 不一致` can be grepped, quoted in a
 * bug report and asserted in a test; a Chinese sentence alone cannot. The stack is preserved by the
 * Error base class, so nothing is lost by adding the prefix.
 */
export class InjectError extends Error {
  code: string
  stage: string

  constructor(code: string, stage: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'InjectError'
    this.code = code
    this.stage = stage
  }
}

/* ── shape helpers ────────────────────────────────────────────────────────────────────────── */

function asRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Windows drive, UNC, or POSIX absolute. A relative cwd is a bug, not a path. */
export function isAbsoluteCwd(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/* ── service resolution ───────────────────────────────────────────────────────────────────── */

/**
 * Resolve a host service.
 *
 * BOTH forms are real on this host: `ctx.get('sessions')` is what the client-side half uses, while an
 * entry that declares a service in `inject` also gets it as a direct property (`ctx.sessions`) — which
 * is what `dsh-graft-slice` relies on for `ctx.sessions.prepare`. Accepting either means the plugin
 * works under both wirings instead of depending on which one a given build populates.
 *
 * `method` makes the choice SEMANTIC rather than positional: several services expose different faces
 * through the two accessors (the tool registry's direct property may carry only `register`, while
 * `get('tools')` is where `execute` lives). Preferring the accessor that actually has the method is
 * what stops a "service is present but useless" half-failure, which is indistinguishable from a
 * missing service in a log.
 */
export function resolveService(ctx: any, name: string, method?: string): any {
  const candidates: any[] = []
  try {
    const direct = ctx?.[name]
    if (direct !== undefined && direct !== null) candidates.push(direct)
  } catch {
    // A property getter that throws is simply not a candidate.
  }
  try {
    const viaGet = ctx?.get?.(name)
    if (viaGet !== undefined && viaGet !== null) candidates.push(viaGet)
  } catch {
    // Same for `get`.
  }
  if (candidates.length === 0) return undefined
  if (method === undefined) return candidates[0]
  return candidates.find((candidate) => typeof candidate?.[method] === 'function')
}

/* ── session tag ──────────────────────────────────────────────────────────────────────────── */

/**
 * The short, human-facing tag of a session id.
 *
 * WHY IT STRIPS THE STEM: a raw `session-<uuid>` has a CONSTANT eight-character prefix on this host, so
 * `slice(0, 8)` yields the constant `session-` and every incubated main would carry an identical,
 * meaningless sidebar title. The stem is stripped first, and the fallback is the tail, which is where
 * the entropy actually is.
 */
export function shortSessionTag(sessionId: string, length = 8): string {
  const stemless = String(sessionId ?? '').replace(/^session-/u, '')
  const head = stemless.slice(0, length)
  return head.length > 0 ? head : String(sessionId ?? '').slice(-length)
}

/* ── the cwd donor chain ──────────────────────────────────────────────────────────────────── */

export interface InjectContext {
  get?: (name: string) => unknown
  [key: string]: any
}

/**
 * Resolve the working directory of `sessionId` — the session being hatched FROM.
 *
 * Order matters and mirrors the host's own answer:
 *   1. the LIVE session header (`session.header.cwd`) — immutable creation metadata;
 *   2. `session.cwd` — what a live session exposes directly;
 *   3. `workingDirectory.get(session)` — the service that owns the EFFECTIVE directory, including a
 *      later `cd`, so it is consulted before the durable copy;
 *   4. `sessionQuery.readSession(id).session.cwd` — the durable header, for a session that is not live
 *      in this process.
 *
 * An empty or relative result REFUSES. The caller must not create anything without a placement: an
 * orphan session is worse than an error, because it looks like success in the sidebar.
 */
export function resolveInheritedCwd(
  ctx: InjectContext,
  sessionId: string,
): { cwd: string; source: string; attempts: string[] } {
  const attempts: string[] = []
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id.length === 0) {
    throw new InjectError('CWD_UNAVAILABLE', 'resolve-cwd', '没有发起会话 id，无法确定工作目录')
  }

  const accept = (value: unknown, source: string): { cwd: string; source: string; attempts: string[] } | undefined => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      attempts.push(`${source}=<empty>`)
      return undefined
    }
    const trimmed = value.trim()
    if (!isAbsoluteCwd(trimmed)) {
      attempts.push(`${source}=${JSON.stringify(trimmed)}<not-absolute>`)
      return undefined
    }
    return { cwd: trimmed, source, attempts }
  }

  const sessions = resolveService(ctx, 'sessions', 'get')
  const live = asRecord(sessions) && typeof sessions.get === 'function' ? sessions.get(id) : undefined

  if (asRecord(live)) {
    const header = asRecord(live.header) ? live.header : undefined
    const fromHeader = accept(header?.cwd, 'live.header.cwd')
    if (fromHeader !== undefined) return fromHeader
    const fromLive = accept(live.cwd, 'live.cwd')
    if (fromLive !== undefined) return fromLive
    const workingDirectory = resolveService(ctx, 'workingDirectory', 'get')
    if (asRecord(workingDirectory) && typeof workingDirectory.get === 'function') {
      try {
        const fromService = accept(workingDirectory.get(live), 'workingDirectory.get(live)')
        if (fromService !== undefined) return fromService
      } catch (error) {
        attempts.push(`workingDirectory.get=<threw ${String((error as any)?.message ?? error)}>`)
      }
    }
  } else {
    attempts.push('sessions.get=<unavailable or not found>')
  }

  throw new InjectError(
    'CWD_UNAVAILABLE',
    'resolve-cwd',
    `拿不到发起会话 ${id} 的工作目录，拒绝创建没有归属的主脑（已尝试：${attempts.join(' · ')}）`,
  )
}

/**
 * The async form: try the live chain, then fall back to the DURABLE header.
 *
 * WHY THE FALLBACK EXISTS: the originating session may have been sliced and retired before the
 * companion is created, in which case `sessions.get()` has nothing and only the persisted log can
 * answer. Every attempt is collected so the refusal names what was actually tried — "I could not find
 * a cwd" is not actionable; "live chain empty, durable read returned <empty>" is.
 */
export async function resolveInheritedCwdAsync(
  ctx: InjectContext,
  sessionId: string,
): Promise<{ cwd: string; source: string; attempts: string[] }> {
  try {
    return resolveInheritedCwd(ctx, sessionId)
  } catch (error) {
    if (!(error instanceof InjectError)) throw error
    const attempts = [error.message]
    const query = resolveService(ctx, 'sessionQuery', 'readSession')
    if (asRecord(query) && typeof query.readSession === 'function') {
      try {
        const snapshot = await query.readSession(sessionId)
        const value = asRecord(snapshot) ? (snapshot as any).session?.cwd : undefined
        if (typeof value === 'string' && value.trim().length > 0 && isAbsoluteCwd(value.trim())) {
          return { cwd: value.trim(), source: 'sessionQuery.readSession().session.cwd', attempts }
        }
        attempts.push(`sessionQuery.readSession().session.cwd=${JSON.stringify(value ?? null)}<unusable>`)
      } catch (readError) {
        attempts.push(`sessionQuery.readSession=<threw ${String((readError as any)?.message ?? readError)}>`)
      }
    } else {
      attempts.push('sessionQuery=<unavailable>')
    }
    throw new InjectError(
      'CWD_UNAVAILABLE',
      'resolve-cwd',
      `拿不到发起会话 ${sessionId} 的工作目录，拒绝创建没有归属的主脑（已尝试：${attempts.join(' · ')}）`,
    )
  }
}
