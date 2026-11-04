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

/**
 * v0.1.7 — COMMAND REPLY SHAPES.
 *
 * On the live page `/observer-create` answered `{"ok":true}`: a plain object, not
 * `{ kind, text }`. The strict unwrap reported "返回形状无法识别" and the summon looked broken
 * even though the binding had been written. The bridge must accept all three observed shapes,
 * and the summon must read the BINDING TABLE rather than the receipt.
 */
test('client: command replies are normalised, and the summon re-reads the binding table', () => {
  assert.match(bundle, /normaliseReply/u, 'one place normalises the reply')
  assert.match(bundle, /JSON\.stringify\(node\)/u, 'a plain object reply is treated as JSON text, not an error')
  const summon = bundle.slice(bundle.indexOf('const summon ='), bundle.indexOf('const jump ='))
  assert.match(summon, /observer-state/u, 'the summon asks the authority (the binding table) after creating')
  assert.match(summon, /绑定表里没有该会话的副脑/u, 'a receipt without a binding is reported, never assumed')
})

/**
 * v0.1.12 — THE QUEUED-COMMAND RECEIPT.
 *
 * The gateway answers `{ok:true, value:{commandId}}` and runs the command AFTERWARDS, so the
 * per-command output never returns to the caller. The first implementation read the binding
 * table once, immediately, lost the race, and told the user the plugin was not active — while
 * the binding was being written a moment later. The client must recognise that receipt shape
 * and POLL.
 */
test('client: an accepted-but-queued command is polled for, not treated as failure', () => {
  assert.match(bundle, /commandId/u, 'the async receipt shape is recognised')
  assert.match(bundle, /accepted/u, 'the reply carries an `accepted` flag')
  assert.match(bundle, /const poll = async/u, 'a polling helper exists')
  const summon = bundle.slice(bundle.indexOf('const summon ='), bundle.indexOf('const jump ='))
  assert.match(summon, /await poll\(/u, 'the summon waits for the binding instead of reading once')
  const consult = bundle.slice(bundle.indexOf('const consult ='), bundle.indexOf('const summon ='))
  assert.match(consult, /await poll\(/u, 'the consult waits for the new session instead of reading once')
})
