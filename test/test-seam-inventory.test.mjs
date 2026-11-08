/**
 * THE PUBLIC SURFACE, LOCKED — because "it is only for tests" is how a surface grows.
 *
 * ── WHY THIS FILE EXISTS (批次 3 第 1 组, 2026-11-08) ─────────────────────────────────────────────
 *
 * The audit found 39 test-only exports across the four bundles. Moving them into a separate
 * `test-internals.ts` is NOT available in this freeze: `bundle.mjs` inlines only what is reachable
 * from `src/index.ts`, so a module referenced solely by tests is never inlined into `index.js` and the
 * tests would receive `undefined` at RUNTIME — a failure mode that no build error announces.
 *
 * So the convergence is the other half of the same idea, and it is enforceable:
 *
 *   1. the boundary is stated in the SOURCE (the `THE TEST-SEAM SURFACE` block in `src/index.ts`),
 *      with the rule for adding a seam and the two names that are a cross-repository contract;
 *   2. the inventory is pinned HERE, as literals.
 *
 * MEASURED, NOT ASSUMED: this entry exports 16 names and NINE of them are seams. That proportion is
 * the reason the lock is worth having — and the reason the folding work is recorded as a costed item
 * rather than quietly declared done.
 *
 * WHAT THIS TEST DOES NOT DO: it does not claim the seams are inert. `injectionInternals` and
 * `diskLogInternals` are imported by `dsh-paradise`'s suite, so they are a live cross-repository test
 * contract; a rename would turn that suite red, which is exactly why the rule says "one coordinated
 * change with both sides updated".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as entry from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/** The seam names, most of which are objects — see the rule in the source block. */
const SEAMS = [
  'confirmationInternals',
  'debugFollowTransfer',
  'debugObserverState',
  'diskLogInternals',
  'ignitionInternals',
  'injectionInternals',
  'monitorInternals',
  'policyInternals',
  'supervisorInternals',
]

/** Everything else the entry exports: the plugin contract plus the one P1-3 predicate. */
const PRODUCTION = ['EMPTY', 'VERSION', 'activate', 'apply', 'assertSessionSummary', 'inject', 'name']

const seamShaped = (name) => /Internals$/u.test(name) || /^debug/u.test(name) || /ForTest$/u.test(name)

test('the entry’s export surface is EXACTLY the pinned inventory', () => {
  const actual = Object.keys(entry).sort()
  assert.deepEqual(
    actual,
    [...PRODUCTION, ...SEAMS].sort(),
    'the exported surface changed. If this is a NEW feature, add its name to PRODUCTION. If it is a ' +
      'TEST seam, fold it into an existing `*Internals` object first (rule 1 in the source block) — ' +
      'and only if that is impossible, add it to SEAMS with the reason in the commit message.',
  )
})

test('every seam-SHAPED name is registered — the convention cannot smuggle one in', () => {
  /**
   * The list above only works while the naming convention keeps up with it. This asserts the
   * convention itself, so a new `debugSomething` or `…ForTest` fails here even if nobody remembers to
   * update anything.
   */
  const unregistered = Object.keys(entry).filter((name) => seamShaped(name) && !SEAMS.includes(name))
  assert.deepEqual(unregistered, [], `unregistered seam-shaped export(s): ${unregistered.join(', ')}`)
  for (const name of SEAMS) {
    assert.ok(name in entry, `${name} is pinned as a seam but is no longer exported`)
  }
})

test('the boundary is DOCUMENTED in the source, and the document names all nine', () => {
  /**
   * A lock without the explanation reads like an arbitrary list. The block is the part a future
   * contributor actually needs, so its deletion is a failure too.
   */
  assert.match(source, /THE TEST-SEAM SURFACE/u, 'the boundary block must stay in src/index.ts')
  assert.match(source, /THEY ARE NOT PUBLIC API/u, 'and it must keep saying what these are')
  assert.match(source, /test\/test-seam-inventory\.test\.mjs/u, 'and point at this file')
  for (const name of SEAMS) {
    assert.ok(source.includes(name), `the boundary block must name ${name}`)
  }
  assert.match(
    source,
    /CROSS-REPOSITORY TEST CONTRACT/u,
    'the cross-repository coupling must stay recorded: a rename is not a local edit',
  )
})
