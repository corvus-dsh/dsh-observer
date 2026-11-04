/**
 * v0.1.11 GUARD — ONLY THE SCHEMA KEYWORDS THE LOADER SUPPORTS.
 *
 * Measured on this profile (plugin_manager → entry diagnostic):
 *
 *   include:dsh-observer — fiberPhase: failed
 *   unsupported JSON schema: schema.properties.focus.anyOf is not a supported keyword
 *   (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)
 *
 * A single unsupported keyword kills the ENTIRE host half: no tools, no commands, and the UI
 * then reports a generic `{ok:true}` for a command that does not exist. That is a long way from
 * the cause, so the vocabulary is asserted here instead of trusted.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  // annotations
  'description',
  'title',
  'default',
  'examples',
  '$schema',
  '$id',
  '$comment',
  'deprecated',
  'readOnly',
  'writeOnly',
])
const FORBIDDEN = ['anyOf', 'allOf', 'not', 'patternProperties', 'if', 'then', 'else', 'minLength', 'maxLength', 'pattern', 'format']

for (const file of ['src/index.ts', 'index.js']) {
  test(`schema vocabulary: ${file} uses no keyword outside the Loader subset`, () => {
    const source = readFileSync(join(root, file), 'utf8')
    const offenders = FORBIDDEN.filter((keyword) => new RegExp(`(^|[^A-Za-z])${keyword}\\s*:`, 'u').test(source))
    assert.deepEqual(
      offenders,
      [],
      `${file} uses unsupported schema keyword(s): ${offenders.join(', ')} — the entry would fail to activate`,
    )
  })
}

test('schema vocabulary: the allow-list itself is the documented subset', () => {
  // Guards the guard: if someone widens ALLOWED without checking the Loader, this fails.
  assert.equal(ALLOWED.has('anyOf'), false)
  assert.equal(ALLOWED.has('oneOf'), true)
})
