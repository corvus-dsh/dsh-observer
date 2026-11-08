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
const injectSource = readFileSync(join(here, '..', 'src', 'core', 'observer-inject.ts'), 'utf8')

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

test('P1-3 STATIC: the single emit site is reachable only through the guard, and refusal is reported', () => {
  const marker = "'api-session/added'"
  const sites = []
  for (let at = injectSource.indexOf(marker); at !== -1; at = injectSource.indexOf(marker, at + 1)) sites.push(at)
  assert.equal(sites.length, 1, 'observer announces a cold companion from exactly one place')

  const emitAt = sites[0]
  const guardAt = injectSource.lastIndexOf('assertSessionSummary(', emitAt)
  assert.notEqual(guardAt, -1, 'the emit must be preceded by assertSessionSummary(summary)')
  const between = injectSource.slice(guardAt, emitAt)
  assert.match(between, /^assertSessionSummary\(summary\)/u, 'the guard must inspect the emitted object')
  assert.match(between, /\}\s*else\s*\{/u, 'the emit must sit in the else branch of the guard')
  assert.match(between, /warnings\.push\(/u, 'a skipped announcement must be reported, never silent')
  assert.match(
    injectSource.slice(Math.max(0, emitAt - 12), emitAt + 45),
    /ctx\.emit\('api-session\/added', summary\)/u,
    'the payload must be the named object the guard checked',
  )
})
