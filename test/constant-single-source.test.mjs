/**
 * P1-4 (audit 2026-11-08) — ONE NUMBER, ONE DECLARATION.
 *
 * `monitor.ts` declared `IDLE_HARVEST_MS = 90_000` and `HARVEST_LIMIT = 3` for the two decisions
 * the SUPERVISOR actually makes, but `supervisor.ts` re-declared `90_000` itself and passed a bare
 * `limit: 3`. Two copies of one number is not a style issue:
 *
 *   - the first symptom was `monitor.ts` being flagged as DEAD EXPORTS — because nothing read them;
 *   - whoever tunes the idle window would have tuned one copy, and the suite would stay green
 *     because no test ever compared the two;
 *   - and the behaviour that drifts is "how long a quiet main must wait before a harvest", which is
 *     the whole point of the supervisor.
 *
 * These assertions are what make the next edit fail loudly instead of silently forking the value.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HARVEST_LIMIT, IDLE_HARVEST_MS } from '../src/core/monitor.ts'
/**
 * Read through the TEST SEAM, not the package entry: `DEFAULT_SUPERVISOR_IDLE_MS` is exported from
 * the bundle only inside `supervisorInternals`, which is the surface this workspace already uses for
 * seams. Widening the public API just to assert one constant would be the wrong trade.
 */
import { supervisorInternals } from '../index.js'

const { DEFAULT_SUPERVISOR_IDLE_MS } = supervisorInternals

const here = dirname(fileURLToPath(import.meta.url))
const supervisorSource = readFileSync(join(here, '..', 'src', 'core', 'supervisor.ts'), 'utf8')

test('P1-4: the supervisor idle window IS the monitor constant, not a copy', () => {
  assert.equal(
    DEFAULT_SUPERVISOR_IDLE_MS,
    IDLE_HARVEST_MS,
    'the exported default must be the same value as the monitor constant',
  )
})

test('P1-4: the supervisor source declares no numeric literal for the idle window', () => {
  /**
   * A VALUE EQUALITY CHECK IS NOT ENOUGH. `const X = 90_000` would satisfy the assertion above and
   * still be a second copy that drifts the moment someone edits `monitor.ts`. The source must not
   * CONTAIN the literal at all — only the alias.
   */
  const offenders = supervisorSource
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => /90_?000|60\.?000/.test(entry.line) && !entry.line.trim().startsWith('*') && !entry.line.trim().startsWith('//'))
  assert.deepEqual(
    offenders.map((entry) => `${entry.number}: ${entry.line.trim()}`),
    [],
    'a numeric literal here is a second copy of IDLE_HARVEST_MS',
  )
})

test('P1-4: the supervisor harvest call uses HARVEST_LIMIT, not a bare 3', () => {
  // The tool call argument is the other literal that used to be duplicated.
  assert.match(supervisorSource, /arguments:\s*\{\s*limit:\s*HARVEST_LIMIT\s*\}/u)
  assert.doesNotMatch(
    supervisorSource,
    /arguments:\s*\{\s*limit:\s*\d+\s*\}/u,
    'a numeric limit here is a second copy of HARVEST_LIMIT',
  )
})

test('P1-4: both constants are still real values, not accidentally undefined', () => {
  // The failure this catches: an import that resolves to undefined makes the supervisor silently
  // fall back to its OWN default, which is the bug this whole change removes.
  assert.equal(typeof IDLE_HARVEST_MS, 'number')
  assert.ok(IDLE_HARVEST_MS > 0)
  assert.equal(HARVEST_LIMIT, 3)
})
