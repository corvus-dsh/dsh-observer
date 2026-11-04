/**
 * v0.1.5 GUARD — THE CLIENT LOADER CONTRACT.
 *
 * The button was invisible for three rounds because the module called
 *
 *     window.__ModuleLoader__.load({ id, inject, apply })
 *
 * — no `factory`. The loader accepts it and registers NOTHING: the host never receives a
 * plugin object, the slot stays empty, and the console shows only the module-load line. Both
 * sibling plugins use the factory form, which is why their panels appear.
 *
 * This test pins the shape, because a static string check is the only thing that runs in
 * `node --test` (the Client half needs a browser).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

test('client: the module is registered through __ModuleLoader__.load with a factory', () => {
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/u, 'the module registers itself with the loader')
  assert.match(bundle, /id:\s*'dsh-observer'/u, 'under its package name')
  assert.match(
    bundle,
    /factory\s*\(\s*require\s*,\s*styles\s*,\s*host\s*\)/u,
    'the factory form is mandatory: load({ id, inject, apply }) registers nothing',
  )
  // A factory returns the plugin object, so the loader needs `return {` inside it.
  assert.match(bundle, /return\s*\{\s*\n\s*\/\*\*/u, 'the factory returns the plugin object')
})

test('client: the plugin object declares SERVICE keys, not package names', () => {
  // The header comment shows the shape as `return { inject: [...], apply(ctx) {...} }`, so the
  // FIRST match is prose. The plugin object is the LAST one in the file.
  const matches = [...bundle.matchAll(/inject:\s*\[([^\]]*)\]/gu)]
  assert.ok(matches.length > 0, 'the plugin object declares inject')
  const keys = matches[matches.length - 1][1]
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean)
  for (const required of ['slots', 'remote', 'remote.commands']) {
    assert.ok(keys.includes(required), `inject must include the SERVICE key '${required}'`)
  }
  assert.equal(
    keys.some((key) => key.startsWith('@')),
    false,
    'package names do not grant service access — that is what the property guard rejected',
  )
})

test('client: no class components (the sandbox React throws on React.Component)', () => {
  assert.doesNotMatch(bundle, /extends\s+React\.Component/u, 'a class component breaks registration at load time')
})

test('client: the turn-tail entry takes sessionId from props and never guesses one', () => {
  assert.match(bundle, /conversation\.chat\.turnTail/u, 'registers on the conversation slot')
  assert.match(bundle, /props\?\.sessionId|props\.sessionId/u, 'reads sessionId from the slot props')
  // The dangerous fallback that could bind a companion to somebody else's session.
  assert.doesNotMatch(bundle, /session\.list\(/u, 'no "first id in the list" fallback is allowed here')
})
