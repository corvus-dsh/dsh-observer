/**
 * ── LONG-TERM LEDGER: WHO THE MAIN SESSIONS WERE, AND WHAT EACH WAS TOLD ─────────────────────────
 *
 * v0.40 (B3 / F7). Until this module the observer was SINGLE-SESSION and IN-MEMORY: `MonitorState`
 * disappears with the process, so "the previous generation also did this" was not merely unimplemented
 * — it was unknowable. A nudge could only ever be about the session in front of it.
 *
 * ── WHY THIS LEDGER LIVES HERE AND NOWHERE ELSE ──────────────────────────────────────────────
 *
 * The four repositories hold zero static imports and zero file coupling between them. The observer
 * therefore CANNOT read the task graph to ask "has this generation moved the plan" — that is a new
 * cross-repo coupling and it is explicitly out of scope (§5.5). What it CAN know is what IT observed:
 * which mains it followed, in what order, and which correction kinds each one needed. That is this
 * file, and it is the only source for "上一代也这样".
 *
 * ── WHY THE COMPARISON IS BY `kind`, NOT BY TEXT ──────────────────────────────────────────────
 *
 * The sentences drift (they have been reworded twice in this repository's history). Comparing text
 * would make "same problem" depend on wording, and the first reword would silently turn every repeat
 * into a first occurrence. `kind` is the shape of the problem: failure streak, stall, or no plan.
 *
 * ── WHY A CAP, AND WHY THE EVICTION MUST BE DETERMINISTIC ────────────────────────────────────
 *
 * This is a growing side-store, and an unbounded one becomes the next bloat source (`graftTargets` is
 * capped for the same reason). Eviction is by `lastServiceAt` then `sessionId`: a test that runs the
 * same input twice must get the same survivors, or "which history was kept" becomes luck.
 */

/** The shapes a correction can take. Shared vocabulary with `MonitorAction['trigger']`. */
export type NudgeKind = 'failure' | 'stall' | 'graph'

/** One main session, as the observer remembers it. */
export interface MainRecord {
  sessionId: string
  /** 1 for the first main the observer followed; incremented along the replacement chain. */
  generation: number
  /** The main this one replaced, or `''` for the first. This is the ONLY chain link we claim. */
  sourceSessionId: string
  /** Last time a correction or harvest touched this record (ms). Used for eviction, not display. */
  lastServiceAt: number
  nudges: number
  /** Every shape this main has been corrected for. A set, so a repeat is a repeat. */
  nudgedKinds: string[]
}

export interface LongTermLedger {
  version: 1
  records: MainRecord[]
}

/** How many mains the ledger keeps. Small on purpose: this answers "the previous one", not history. */
export const LONG_TERM_CAP = 24

export function emptyLedger(): LongTermLedger {
  return { version: 1, records: [] }
}

const isKind = (value: unknown): value is NudgeKind => value === 'failure' || value === 'stall' || value === 'graph'

/**
 * Parse whatever was on disk. Torn rows are DROPPED one by one, and an unreadable document yields an
 * empty ledger — rule ⑤: a broken ledger must degrade to "the previous generation is unknown", never to
 * "supervision stops". A supervisor that goes silent because its notebook is damaged is worse than one
 * with no notebook.
 */
export function parseLedger(raw: unknown): LongTermLedger {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyLedger()
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.records)) return emptyLedger()
  const out: MainRecord[] = []
  for (const item of record.records) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : ''
    if (sessionId.length === 0) continue
    out.push({
      sessionId,
      generation: Number.isFinite(Number(entry.generation)) && Number(entry.generation) > 0 ? Number(entry.generation) : 1,
      sourceSessionId: typeof entry.sourceSessionId === 'string' ? entry.sourceSessionId : '',
      lastServiceAt: Number.isFinite(Number(entry.lastServiceAt)) ? Number(entry.lastServiceAt) : 0,
      nudges: Number.isFinite(Number(entry.nudges)) && Number(entry.nudges) > 0 ? Number(entry.nudges) : 0,
      nudgedKinds: Array.isArray(entry.nudgedKinds)
        ? entry.nudgedKinds.filter((kind): kind is string => typeof kind === 'string')
        : [],
    })
  }
  return { version: 1, records: out }
}

export function findRecord(ledger: LongTermLedger, sessionId: string): MainRecord | undefined {
  return ledger.records.find((record) => record.sessionId === sessionId)
}

/**
 * The generation number a NEW main inherits from the one it replaced.
 *
 * `0` when the chain is unknown (a main the observer never saw before), and callers must treat that as
 * "no generation claim" rather than printing 「第 0 代」 — the same rule graft's ledger follows.
 */
export function generationFor(ledger: LongTermLedger, sourceSessionId: string): number {
  if (sourceSessionId.length === 0) return 1
  const prior = findRecord(ledger, sourceSessionId)
  return prior === undefined ? 0 : prior.generation + 1
}

/**
 * Insert or update one record and enforce the cap.
 *
 * Deterministic eviction: oldest `lastServiceAt` first, ties broken by `sessionId` ascending. A random
 * or insertion-order eviction would make "which history survived" depend on timing, and a test that
 * runs twice would disagree with itself.
 */
export function upsertRecord(
  ledger: LongTermLedger,
  patch: {
    sessionId: string
    sourceSessionId?: string
    generation?: number
    at: number
    nudgedKind?: NudgeKind
  },
): LongTermLedger {
  const existing = findRecord(ledger, patch.sessionId)
  const kinds = new Set(existing?.nudgedKinds ?? [])
  /** A kind already recorded is NOT added twice: the repeat is the fact, not the count. */
  if (patch.nudgedKind !== undefined && isKind(patch.nudgedKind)) kinds.add(patch.nudgedKind)
  const merged: MainRecord = {
    sessionId: patch.sessionId,
    generation:
      patch.generation !== undefined && patch.generation > 0
        ? patch.generation
        : existing?.generation ?? 1,
    sourceSessionId:
      patch.sourceSessionId !== undefined
        ? patch.sourceSessionId
        : existing?.sourceSessionId ?? '',
    lastServiceAt: patch.at,
    nudges: (existing?.nudges ?? 0) + (patch.nudgedKind === undefined ? 0 : 1),
    nudgedKinds: [...kinds].sort(),
  }
  const others = ledger.records.filter((record) => record.sessionId !== patch.sessionId)
  const next = [...others, merged].sort((left, right) => {
    if (right.lastServiceAt !== left.lastServiceAt) return right.lastServiceAt - left.lastServiceAt
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
  })
  return { version: 1, records: next.slice(0, LONG_TERM_CAP) }
}

/**
 * ── THE CROSS-GENERATION FACT ────────────────────────────────────────────────────────────────
 *
 * `undefined` when history cannot answer — no record for the previous main, no chain link, or the
 * previous main was never corrected for THIS shape. All three are "don't know", and saying 「上一代也
 * 这样」 without knowing would be a fabricated accusation about a session the reader cannot check.
 */
export function priorGenerationNudge(
  ledger: LongTermLedger,
  sessionId: string,
  kind: NudgeKind,
  /**
   * The chain link the CALLER already knows (the binding store's pair record), used when the current
   * session has no row yet.
   *
   * ── WHY THIS PARAMETER EXISTS (measured, not guessed) ────────────────────────────────────────
   *
   * A correction is spoken BEFORE the corrected session's row is written (the write records that a
   * correction happened). So on the second generation's FIRST nudge the row for the current session
   * does not exist — and a lookup that insisted on reading the chain from that row answered "no
   * previous generation" at exactly the moment the sentence was needed. `v243 ⑦` caught it: the
   * wiring was silent about history that was sitting in the file one line away.
   */
  chainFromCaller?: string,
): { generation: number; at: number } | undefined {
  const current = findRecord(ledger, sessionId)
  const chain = current !== undefined && current.sourceSessionId.length > 0
    ? current.sourceSessionId
    : chainFromCaller ?? ''
  if (chain.length === 0) return undefined
  const prior = findRecord(ledger, chain)
  if (prior === undefined) return undefined
  if (!prior.nudgedKinds.includes(kind)) return undefined
  return { generation: prior.generation, at: prior.lastServiceAt }
}

/**
 * The one sentence appended to a correction, when history has something to say.
 *
 * ONE line, appended once — the test pins that a repeat does not stack. It names the shape by its
 * human word rather than by the internal key, and it does NOT claim the same cause: two main sessions
 * can stall for different reasons, and 「同样的原因」 would be a fact this file cannot see.
 */
export function crossGenerationLine(previous: { generation: number }, kind: NudgeKind): string {
  const label =
    kind === 'failure' ? '同一个工具连续失败' : kind === 'stall' ? 'TODO 板上长时间没有推进' : '多步工作却从未建立任务图'
  return `上一代（第 ${previous.generation} 代）也这样：${label}。这可能是任务本身的问题，而不只是这一次的做法；先确认是同一处卡点再继续。`
}