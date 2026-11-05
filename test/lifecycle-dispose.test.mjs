/**
 * LIFECYCLE: the listeners this plugin registers must be reclaimable by the loader.
 *
 * The observer registers two: `session/event` (to notice a main session moving) and
 * `graft/session-transferred` (to move the follower pointer). Both must be on the PLUGIN context, or
 * a detached copy of it, so the loader's own disposal reclaims them — a listener left behind would
 * keep following a session after the plugin was unloaded.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('lifecycle: every `.on(` call site registers on the plugin context', () => {
  const lines = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8').split('\n')
  const offenders = []
  lines.forEach((line, index) => {
    if (!/\.on\??\(/u.test(line)) return
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return
    if (/\bctx\.on\??\(/u.test(line)) return
    offenders.push(`${index + 1}: ${trimmed}`)
  })
  assert.deepEqual(
    offenders,
    [],
    `a listener registered on anything other than the plugin context is never disposed:\n${offenders.join('\n')}`,
  )
})

test('lifecycle: the follower pointer is not held in a module-level collection', () => {
  /**
   * THE OBSERVER-SPECIFIC VERSION OF THE LEAK: the follower pointer is durable state (a file / a
   * ledger), not an in-process callback list. Keeping handlers in an array "to remove them later"
   * would retain them past the unload and re-register them on the next load, so every event would be
   * handled twice.
   */
  const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')
  for (const pattern of [/const\s+handlers\s*=\s*\[\]/u, /const\s+listeners\s*=\s*\[\]/u, /const\s+unsubscribes\s*=\s*\[\]/u]) {
    assert.equal(pattern.test(source), false, `module-level handler collection found: ${pattern}`)
  }
})
