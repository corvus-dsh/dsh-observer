/**
 * THE `api-session/added` WIRE SHAPE — the two fields a host can actually resolve a payload by.
 *
 * ── P1-3 (audit 2026-11-08) WHY THIS IS ITS OWN MODULE ────────────────────────────────────────
 *
 * This plugin emits `api-session/added` itself, because the companion it incubates is written
 * through the persistence layer and stays COLD: the host emits that event only for sessions
 * published into the live store, and publishing a cold target would make it visible and unopenable.
 * The event reaches peers through `dsh-api-remotes`, which keys it by
 * `resources: { session: summary => summary.sessionId }`, and the client applies it with
 * `handleSessionAdded` -> `mergeSummary`.
 *
 * The host's `assertJsonArgs` checks only that the payload is JSON-serialisable. It does NOT check
 * that `sessionId` is a string. A payload with a missing or non-string id therefore throws NOWHERE:
 * it arrives at the peer's access-control step as `undefined`, where the row is dropped at best and
 * an authorisation key is looked up at worst. No local test can see that failure, which is exactly
 * why the guard belongs at the emit site rather than in a validator nobody calls.
 *
 * THE SAME FUNCTION EXISTS IN `dsh-paradise` AND `dsh-graft-slice`, deliberately duplicated: the
 * four repositories have ZERO static imports between them (that is the property that lets any one of
 * them be uninstalled without the others failing at load). A shared package would trade that
 * property for four lines of code.
 *
 * It rejects nothing emitted today: `sessionId` comes from a validated non-empty request field and
 * `updatedAt` from a finite header timestamp or `Date.now()`. It exists for the NEXT caller.
 */
export function assertSessionSummary(payload: unknown): payload is { sessionId: string; updatedAt: number } {
  if (typeof payload !== 'object' || payload === null) return false
  const summary = payload as { sessionId?: unknown; updatedAt?: unknown }
  if (typeof summary.sessionId !== 'string' || summary.sessionId.length === 0) return false
  return typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
}
