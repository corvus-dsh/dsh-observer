/**
 * P1-3 (audit 2026-11-08) — THE `api-session/added` PAYLOAD IS A WIRE CONTRACT, AND THIS LOCKS IT.
 *
 * The companion this plugin incubates is written through the persistence layer and stays COLD, so
 * the host never announces it: the client learns about sessions exclusively from `api-session/added`,
 * which the host emits on `session/created` — for published sessions only. `observer-inject.ts`
 * therefore emits the same cold-shape summary itself.
 *
 * ── WHY THERE IS NO RUNTIME HALF HERE, STATED PLAINLY ─────────────────────────────────────────
 *
 * `sessionId` is a validated non-empty request field and `createdAt` is
 * `isFinite(header) ? header : (isFinite(request) ? request : Date.now())`. There is no input that
 * reaches the emit site with a bad payload, so a runtime test of the refusal branch would have to
 * mock the module's own internals — a test that asserts on its own fixture, not on the plugin.
 *
 * What is worth freezing is the SHAPE OF THE CALL SITE: the emit is reachable only through the
 * guard, the guard inspects the emitted object, and a refusal is reported in `warnings` rather than
 * dropped on the floor. That is the property that survives refactoring, and it is invisible at
 * runtime precisely because nothing can trip it today.
 *
 * The announcement itself is still covered end-to-end by `test/incubation.test.mjs`, which asserts a
 * real incubation reaches the client — this file must not duplicate that.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertSessionSummary } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * ── 批次 C-2 (2026-11-09): THE ASSERTION MOVED TO THE LIVE PATH ────────────────────────────────
 *
 * This test used to read `src/core/observer-inject.ts` and assert that the `api-session/added` emit was
 * reachable only through `assertSessionSummary`. That file is the ARCHIVED write path: since v1.9.0 the
 * companion is created through `dsh-paradise`, and the announcement is made by the LAYER's own writer
 * (`dsh-paradise/src/adapters/dsh/session-writer.ts`), which carries the same guard and its own test
 * (`dsh-paradise/test/v102-session-summary-guard.test.mjs`).
 *
 * So the old assertion was checking the structure of code that no longer runs. Two honest options were
 * available: keep reading the dead file (a test that certifies nothing), or point it at the live path.
 * This file now does the second: it asserts that THIS plugin's live write binding is the layer's writer,
 * and that no local emit survives here — which is the property the boundary actually depends on.
 */
const writeBridge = readFileSync(join(here, '..', 'src', 'core', 'paradise-write.ts'), 'utf8')

test('P1-3: a well-formed cold summary is accepted', () => {
  assert.equal(assertSessionSummary({ sessionId: 'session-abc', updatedAt: 1_700_000_000_000 }), true)
  assert.equal(assertSessionSummary({ sessionId: 's', updatedAt: 0 }), true)
})

test('P1-3: a sessionId the client cannot key by is refused', () => {
  /**
   * `resources.session = (summary) => summary.sessionId` is the transport's routing key. The host's
   * `assertJsonArgs` accepts every payload below, so without this predicate each one reaches the peer
   * as an undefined key — and the failure is on the far side of a socket, where no local log sees it.
   */
  for (const sessionId of [undefined, null, '', 0, 42, false, {}, []]) {
    assert.equal(
      assertSessionSummary({ sessionId, updatedAt: 1 }),
      false,
      `sessionId=${JSON.stringify(sessionId)} must be refused`,
    )
  }
})

test('P1-3: a non-finite updatedAt is refused — NaN included', () => {
  for (const updatedAt of [undefined, null, '1700000000000', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
    assert.equal(
      assertSessionSummary({ sessionId: 's', updatedAt }),
      false,
      `updatedAt=${String(updatedAt)} must be refused`,
    )
  }
})

test('P1-3: a non-object payload is refused rather than throwing', () => {
  for (const payload of [undefined, null, 'summary', 7, true]) {
    assert.equal(assertSessionSummary(payload), false)
  }
})

test('P1-3 STATIC: this plugin no longer announces cold sessions itself — the layer does', () => {
  /**
   * THE BOUNDARY, ASSERTED IN THE DIRECTION IT ACTUALLY RUNS.
   *
   * The announcement is the layer's job now: `dsh-paradise`'s session writer emits `api-session/added`
   * behind `assertSessionSummary`, and `dsh-paradise/test/v102-session-summary-guard.test.mjs` pins
   * that. What THIS repository must guarantee is the other half — that no local emit reappears and
   * bypasses the layer. A reintroduced `ctx.emit('api-session/added', …)` here would announce a
   * companion the layer does not know it wrote, with a payload nothing validated.
   */
  assert.equal(
    writeBridge.includes("ctx.emit('api-session/added'"),
    false,
    'the live write bridge must NOT emit api-session/added itself: the layer owns the announcement',
  )
  assert.match(
    writeBridge,
    /createDshAdapters|ensureWriteAdapter|paradise\.session/u,
    'the live path must still be the layer (create / trigger / delete via dsh-paradise)',
  )
  /**
   * And the guarded emit that USED to live in the archived file is gone with it: the file is deleted,
   * so this path cannot be read any more. Asserting its absence is what keeps a future edit from
   * resurrecting it as "the old code we still had somewhere".
   */
  const archived = (() => {
    try {
      return readFileSync(join(here, '..', 'src', 'core', 'observer-inject.ts'), 'utf8')
    } catch {
      return undefined
    }
  })()
  assert.equal(archived, undefined, 'the archived write path must stay deleted (批次 C-2)')
})
