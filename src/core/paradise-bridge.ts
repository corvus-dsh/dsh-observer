/**
 * THE PARADISE BRIDGE — how the observer reaches the 彼岸层 without becoming hostage to it.
 *
 * WHY A BRIDGE AND NOT A PLAIN IMPORT
 *
 * `dsh-paradise` is a separate package and a separate bundle entry, and the architecture draft (§7,
 * risk 2) names the exact danger: if the layer fails to activate, the plugins that depend on it must
 * not simply die — but the OPPOSITE failure is worse and quieter, because a caller that keeps running
 * on a path it believes is supported returns empty readings that look like real answers.
 *
 * So the rules this file implements:
 *
 *   1. A STATIC `import from 'dsh-paradise'` is not used. This plugin ships as a SINGLE-FILE bundle
 *      whose composer only inlines RELATIVE modules; a bare specifier would survive into the artifact
 *      and fail at `import()` time — i.e. the whole plugin would not activate — if the layer were
 *      absent. That is precisely the "one missing package kills two plugins" outcome to avoid.
 *   2. The layer is loaded LAZILY, at the moment a reading is needed, and the result is CACHED. The
 *      first failure is remembered too, so a missing layer does not cost a filesystem probe per call.
 *   3. TWO RESOLUTION CANDIDATES, in order: the bare specifier (a real dependency install) and the
 *      SIBLING directory (`../dsh-paradise/index.js`), which is how this workspace actually lays the
 *      two repositories out. Both are tried; neither is assumed.
 *   4. A MISSING LAYER IS A STATED FACT. `available: false` with the reason, never a silent empty
 *      reading. The caller decides whether that is fatal — and for a DIAGNOSTIC it is not fatal: the
 *      incubation already succeeded, and losing the disk cross-check must not cost the user their
 *      session.
 *   5. THE OBSERVER'S OWN RECEIPT SHAPE SURVIVES. `DiskLogReport` is what the tool result prints and
 *      what its tests assert, so the adapter maps paradise's `DiskReading` INTO it. Migrating a layer
 *      must not silently change a user-facing receipt.
 */

/** What the observer needs from the layer. Structural, so a shape change is a type error here. */
interface ParadiseReader {
  readDiskEvents(
    sessionId: string,
    cwd?: string,
    options?: {
      pathProbe?: unknown
      /**
       * v1.8.1 — THE PATH DERIVATION IS NOW AN OPTION, NOT AN IMPORT.
       *
       * `read/disk.ts` stopped knowing a directory layout: the escaping and the `sessions/<escaped
       * cwd>/…` scheme are facts about ONE runtime, so they moved to that runtime's adapter. The
       * reader instead takes a deriver. Without passing one here the bridge silently lost the
       * derived-path fallback — which is exactly what a host that names no path needs.
       */
      derivePath?: (input: { sessionId: string; cwd: string }) => { path: string; source: string; notes: string[] }
    },
  ): ParadiseDiskReading
  escapeSessionDirName(cwd: string): string
  /** The runtime's own layout deriver, exposed by the layer for callers that need it. */
  sessionLogPath?(input: {
    cwd: string
    sessionId: string
    home?: string
    env?: Record<string, string | undefined>
  }): { path: string; source: string; notes: string[] }
}

/** The subset of paradise's `DiskReading` this adapter reads. Mirrors `read/disk.ts`. */
interface ParadiseDiskReading {
  readable: boolean
  path: string
  pathSource: string
  bytes: number
  frameCount: number
  framesDecoded: number
  eventTypes: string[]
  eventCount: number
  briefing: {
    seq: number
    type: string
    role: string
    sourceKind: string
    surfaceOp: string | undefined
    textLength: number
    textHead: string
    carriesTurnStep: boolean
  } | null
  renderedByConversation: boolean
  notes: string[]
}

/** The receipt shape the observer has always printed. Kept identical on purpose. */
export interface DiskLogReport {
  readable: boolean
  path: string
  pathSource: string
  bytes: number
  frameCount: number
  framesDecoded: number
  eventTypes: string[]
  eventCount: number
  briefing: {
    seq: number
    type: string
    role: string
    sourceKind: string
    surfaceOp: string | undefined
    textLength: number
    textHead: string
    carriesTurnStep: boolean
  } | null
  renderedByConversation: boolean
  notes: string[]
}

export interface ParadiseBinding {
  available: boolean
  /** Which specifier worked: `dsh-paradise` (installed) or the sibling directory. */
  via: 'bare' | 'sibling' | ''
  /** Why it is unavailable, when it is. Always names what to install or place. */
  reason: string
  reader?: ParadiseReader
  /**
   * The WHOLE module, for callers that need more than the reader — the write path
   * (`paradise-write.ts`) uses `createDshAdapters` / `deleteSession` from here.
   *
   * Kept as `unknown`-shaped on purpose: this bridge does not want to mirror the layer's whole
   * surface, so the writer narrows it where it is used and a shape change fails there.
   */
  layer?: any
}

const PACKAGE_NAME = 'dsh-paradise'

/**
 * The consequence a caller must print when the layer is missing.
 *
 * Stated as data so every caller says the SAME thing, and so a test can assert the sentence rather
 * than a paraphrase of it.
 */
export const PARADISE_MISSING_CONSEQUENCE =
  '磁盘逐帧核对不可用（冷读结论仍然有效）。' +
  `安装 ${PACKAGE_NAME} 后该项自动恢复：把 ${PACKAGE_NAME} 放在与 dsh-observer 同级的目录，` +
  '或在 profile 的依赖里加入它。'

let cached: ParadiseBinding | null = null
let inFlight: Promise<ParadiseBinding> | null = null

/** The specifiers tried, in order. Exported so a test can assert the resolution order. */
export function paradiseSpecifiers(): string[] {
  return [PACKAGE_NAME, `../${PACKAGE_NAME}/index.js`]
}

function isReader(value: unknown): value is ParadiseReader {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.readDiskEvents === 'function' && typeof candidate.escapeSessionDirName === 'function'
}

/**
 * Resolve the layer once, and remember the answer — including a failure.
 *
 * Never throws: the caller gets `available: false` and a reason it can print. A bridge that throws
 * here would turn a missing diagnostic into a failed incubation.
 */
export async function ensureParadise(): Promise<ParadiseBinding> {
  if (cached !== null) return cached
  if (inFlight !== null) return inFlight
  inFlight = (async (): Promise<ParadiseBinding> => {
    const failures: string[] = []
    for (const specifier of paradiseSpecifiers()) {
      try {
        const mod: any = await import(/* @vite-ignore */ specifier)
        if (!isReader(mod)) {
          failures.push(`${specifier}: 已加载但没有 readDiskEvents/escapeSessionDirName（版本不匹配？）`)
          continue
        }
        const binding: ParadiseBinding = {
          available: true,
          via: specifier === PACKAGE_NAME ? 'bare' : 'sibling',
          reason: '',
          reader: mod as ParadiseReader,
          layer: mod,
        }
        cached = binding
        return binding
      } catch (error) {
        failures.push(`${specifier}: ${String((error as any)?.message ?? error)}`)
      }
    }
    const binding: ParadiseBinding = {
      available: false,
      via: '',
      reason: `${PACKAGE_NAME} 不可用 —— ${failures.join(' | ')}`,
    }
    cached = binding
    return binding
  })()
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

/**
 * Test seam: forget a cached resolution so a degradation test can re-probe.
 *
 * When `prime` is given, that binding becomes the cached answer instead — which is how a test can
 * exercise the DEGRADED path without uninstalling a real package. It primes the exact shape a failed
 * resolution produces, so every downstream consumer sees the genuine failure contract rather than a
 * mock of it.
 */
export function resetParadiseCache(prime?: ParadiseBinding): void {
  cached = prime === undefined ? null : prime
  inFlight = null
}

/** The binding a failed resolution produces. Exported so a test primes the real shape. */
export function unavailableBinding(reason: string): ParadiseBinding {
  return { available: false, via: '', reason }
}

/**
 * Ask the host where the file is, in the shape paradise's `pathProbe` expects.
 *
 * This preserves the observer's ORIGINAL resolution order exactly: a backend that can name the file
 * it wrote is the only authority, and the derivation is only the fallback. Moving the byte-reading
 * to another package must not quietly change which path wins.
 */
function buildProbe(ctx: any, notes: string[]): (sessionId: string) => { path: string; source: string; notes: string[] } {
  return (sessionId: string) => {
    const persistence = (() => {
      try {
        return ctx?.sessionPersistence ?? ctx?.get?.('sessionPersistence')
      } catch {
        return undefined
      }
    })()
    if (typeof persistence === 'object' && persistence !== null) {
      for (const method of ['pathOf', 'pathFor', 'logPath', 'filePath']) {
        if (typeof (persistence as any)[method] !== 'function') continue
        try {
          const value = (persistence as any)[method](sessionId)
          if (typeof value === 'string' && value.trim().length > 0) {
            return { path: value.trim(), source: `sessionPersistence.${method}()`, notes }
          }
        } catch (error) {
          notes.push(`sessionPersistence.${method} 抛错：${String((error as any)?.message ?? error)}`)
        }
        break
      }
    }
    const paths = (() => {
      try {
        return ctx?.paths ?? ctx?.get?.('paths')
      } catch {
        return undefined
      }
    })()
    if (typeof paths === 'object' && paths !== null) {
      notes.push(
        `paths 服务可用，但它是插件数据目录（${String((paths as any).data ?? (paths as any).home ?? '?')}），` +
          '不是会话日志目录',
      )
    }
    return { path: '', source: 'unavailable', notes }
  }
}

function emptyReport(pathSource: string, notes: string[]): DiskLogReport {
  return {
    readable: false,
    path: '',
    pathSource,
    bytes: 0,
    frameCount: 0,
    framesDecoded: 0,
    eventTypes: [],
    eventCount: 0,
    briefing: null,
    renderedByConversation: false,
    notes: [...notes],
  }
}

/**
 * Read one session's durable log, through the 彼岸层.
 *
 * ASYNC because the layer is loaded on demand: a synchronous read would force a static import, and a
 * static import is what makes an absent package fatal to the whole plugin.
 *
 * Never throws. A missing layer produces `readable: false` with a note that NAMES the package and
 * says what still holds — which is the honest degradation the draft asks for (§9 item C).
 */
/**
 * A REPLACEABLE LOG READER — the seam that lets this monitor run where there is no host.
 *
 * THE PROBLEM, STATED AS IT ACTUALLY BIT
 *
 * `inspectSessionLog` reached the durable log through `readDiskEvents`, which is a FILE-SHAPED API: it
 * takes a session id and a cwd, derives a directory layout, opens a compressed frame file, and decodes it.
 * Every one of those steps is a fact about ONE host. A bare machine has none of them — it has `.jsonl`
 * files and a `SessionAdapter` that already knows how to read them.
 *
 * WHAT THIS INTERFACE IS: one question — "what does this session's log contain, as EVENTS?" — because
 * that is the only thing the monitor consumes. The briefing summary is derived HERE from the events, so a
 * reader does not have to know what a briefing is.
 *
 * WHY THE DERIVATION MOVED INTO THE READER: with a provider installed there are no paths to derive, no
 * frames to decode, and no cwd to escape into a directory name. Asking a JSONL reader for those would
 * force it to fabricate answers.
 */
export interface SessionLogReader {
  /** A short name for diagnostics — "which reader answered?". */
  readonly name: string
  /**
   * Read one session's events.
   *
   * MUST NOT throw: an absent session is `readable: false` with a note. A monitor that throws because a
   * session is missing cannot report on the sessions that are present.
   */
  read(sessionId: string): Promise<{
    readable: boolean
    path: string
    pathSource: string
    events: ReadonlyArray<{ seq?: number; type: string; data?: unknown }>
    notes: readonly string[]
  }>
}

let readerProvider: SessionLogReader | undefined

/** Install (or clear) the reader. With none installed, resolution goes to the layer, exactly as shipped. */
export function setSessionLogReader(next: SessionLogReader | undefined): void {
  readerProvider = next
}

/** Is a reader installed? Diagnostics print this so "why is it not reading the host log" is answerable. */
export function hasSessionLogReader(): boolean {
  return readerProvider !== undefined
}

/**
 * DERIVE THE BRIEFING FROM EVENTS.
 *
 * This is the piece that used to come out of the frame decoder for free. It is deliberately the SAME rule
 * the host reader applies — first message-shaped event, its first non-empty line — because the observer's
 * receipt prints this text and a bare machine must not produce a different-looking report.
 */
function briefingOf(events: ReadonlyArray<{ seq?: number; type: string; data?: unknown }>): DiskLogReport['briefing'] {
  const MESSAGE_TYPES = ['user/message', 'assistant/message', 'developer/message', 'system/message']
  for (const event of events) {
    if (!MESSAGE_TYPES.includes(event.type)) continue
    const data = (event.data ?? {}) as Record<string, unknown>
    const message = (data.message ?? data) as Record<string, unknown>
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => String(block.text))
      .join('\n')
      .trim()
    if (text.length === 0) continue
    const source = (message.source ?? data.source ?? {}) as Record<string, unknown>
    return {
      seq: Number(event.seq ?? 0),
      type: event.type,
      role: String(message.role ?? (event.type === 'user/message' ? 'user' : 'assistant')),
      sourceKind: String(source.kind ?? ''),
      surfaceOp: undefined,
      textLength: text.length,
      textHead: text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 200) ?? '',
      carriesTurnStep: false,
    }
  }
  return null
}

export async function inspectSessionLog(ctx: any, sessionId: string, cwd?: string): Promise<DiskLogReport> {
  /**
   * THE INJECTED READER WINS. This is the whole of "monitoring works without a host".
   *
   * It is checked BEFORE `ensureParadise()`, and that order is deliberate: on a bare machine the layer is
   * importable but its HOST ADAPTER is the wrong tool — resolving it first would load a reader that cannot
   * open a `.jsonl` and then report the session as unreadable.
   */
  if (readerProvider !== undefined) {
    let answer: Awaited<ReturnType<SessionLogReader['read']>>
    try {
      answer = await readerProvider.read(sessionId)
    } catch (error) {
      return emptyReport('reader-error', [
        `注入的读取器（${readerProvider.name}）抛错：${String((error as any)?.message ?? error)}`,
      ])
    }
    const events = Array.isArray(answer.events) ? answer.events : []
    const types = [...new Set(events.map((event) => String(event.type)))]
    return {
      readable: answer.readable,
      path: answer.path,
      pathSource: answer.pathSource,
      bytes: 0,
      frameCount: events.length,
      framesDecoded: events.length,
      eventTypes: types,
      eventCount: events.length,
      briefing: briefingOf(events),
      /**
       * RENDERABILITY IS NOT KNOWABLE HERE, and saying `false` is the honest answer: a reader that reports
       * events has no idea what a view would draw. The host path answers this properly; the bare path says
       * it does not know.
       */
      renderedByConversation: false,
      notes: [...answer.notes, `读取器：${readerProvider.name}`],
    }
  }

  const binding = await ensureParadise()
  if (!binding.available || binding.reader === undefined) {
    const report = emptyReport('paradise-unavailable', [
      binding.reason,
      PARADISE_MISSING_CONSEQUENCE,
    ])
    return report
  }
  const notes: string[] = []
  const probe = buildProbe(ctx, notes)
  /**
   * THE DERIVED-PATH FALLBACK, RESTORED.
   *
   * The layer's reader no longer knows a directory layout (that moved into the runtime's adapter), so
   * a caller that only has `cwd` must SUPPLY the deriver. The layer publishes the runtime's own
   * `sessionLogPath` for exactly this: the caller does not re-implement the scheme, it hands the
   * layer's own function back to it.
   */
  const derivePath =
    typeof binding.reader.sessionLogPath === 'function'
      ? ({ sessionId, cwd }: { sessionId: string; cwd: string }) =>
          binding.reader!.sessionLogPath!({ cwd, sessionId })
      : undefined
  let reading: ParadiseDiskReading
  try {
    reading = binding.reader.readDiskEvents(sessionId, cwd, {
      pathProbe: probe,
      ...(derivePath === undefined ? {} : { derivePath }),
    })
  } catch (error) {
    // The layer promises not to throw; if it somehow does, the diagnostic degrades, never the caller.
    return emptyReport('paradise-error', [
      `${PACKAGE_NAME}.readDiskEvents 抛错：${String((error as any)?.message ?? error)}`,
      PARADISE_MISSING_CONSEQUENCE,
    ])
  }
  return {
    readable: reading.readable,
    path: reading.path,
    pathSource: reading.pathSource,
    bytes: reading.bytes,
    frameCount: reading.frameCount,
    framesDecoded: reading.framesDecoded,
    eventTypes: [...reading.eventTypes],
    eventCount: reading.eventCount,
    briefing: reading.briefing === null ? null : { ...reading.briefing },
    renderedByConversation: reading.renderedByConversation,
    notes: [...reading.notes, ...notes],
  }
}

/**
 * The host's directory escaping, from the layer.
 *
 * ASYNC, and that is not incidental: the layer is loaded on demand (rule 1 above), so there is no
 * synchronous handle to it available at module scope. A caller that wants the derived directory name
 * awaits this. When the layer is missing the answer is a clearly-marked placeholder rather than a
 * thrown error — a sidebar label is not worth failing a hatch over.
 */
export async function escapeSessionDirName(cwd: string): Promise<{ value: string; available: boolean; reason: string }> {
  const binding = await ensureParadise()
  if (!binding.available || binding.reader === undefined) {
    return { value: `--unknown(${String(cwd).length} chars)--`, available: false, reason: binding.reason }
  }
  return { value: binding.reader.escapeSessionDirName(cwd), available: true, reason: '' }
}

/**
 * What this plugin believes about the layer RIGHT NOW, without loading anything.
 *
 * WHY A CALLER NEEDS THIS: `observer_status` must be able to say "the disk cross-check is running on
 * paradise 0.1.0" or "the layer is not installed, and here is what that costs" — BEFORE anyone has
 * triggered a read. Reporting `unknown` for a fact we can state is the same class of dishonesty as a
 * silent empty reading. It never probes: only what `ensureParadise()` has already established.
 */
export function paradiseStatus(): {
  resolved: boolean
  available: boolean
  via: string
  reason: string
  specifiers: string[]
  consequence: string
} {
  return {
    resolved: cached !== null,
    available: cached?.available === true,
    via: cached?.via ?? '',
    reason: cached?.reason ?? '尚未加载（第一次需要磁盘核对时才会解析）',
    specifiers: paradiseSpecifiers(),
    consequence: PARADISE_MISSING_CONSEQUENCE,
  }
}
