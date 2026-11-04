/**
 * dsh-observer — the Client half is plain ESM, so these assertions are the only guard
 * `node --test` can offer. Every rule below is written from a specific failure.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * Comments are stripped for the "must not appear" assertions: this file documents the bans
 * (`no setInterval`, `never calls remote.session.list()`) and prose must not fail the guard.
 */
const code = bundle.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1')

test('client: registered through __ModuleLoader__.load with a factory and the PLAIN id', () => {
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/u, 'the module registers itself with the loader')
  /**
   * The id must stay `dsh-observer`. v0.1.14 renamed it to `dsh-observer-v14` (and served a
   * versioned file) to defeat a cache; the next start died with
   * `desktop welcome: Web authentication failed`.
   */
  assert.match(bundle, /^\s*id:\s*'dsh-observer',$/mu, 'the module id is the plain package name')
  assert.doesNotMatch(bundle, /id:\s*'dsh-observer-v\d+/u, 'a versioned id broke Web authentication')
  assert.match(
    bundle,
    /factory\s*\(\s*require\s*,\s*styles\s*,\s*host\s*\)/u,
    'the factory form is mandatory: load({ id, inject, apply }) registers nothing',
  )
})

test('client: the plugin object declares SERVICE keys, not package names', () => {
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
    'package names do not grant service access',
  )
})

test('client: no class components (the sandbox React throws on React.Component)', () => {
  assert.doesNotMatch(bundle, /extends\s+React\.Component/u)
})

test('client: the entry takes sessionId from props and never guesses one', () => {
  assert.match(bundle, /conversation\.chat\.turnTail/u, 'registers on the conversation slot')
  assert.match(bundle, /props\?\.sessionId|props\.sessionId/u, 'reads sessionId from the slot props')
  assert.doesNotMatch(code, /session\.list\(/u, 'no "first id in the list" fallback is allowed here')
})

/**
 * v0.1.15 — CLICK-ONLY BY ORDER OF THE USER.
 *
 * Every command call prints a `observer-state: …` row into the conversation. A poll loop
 * therefore floods the transcript, and in this host the flood is the user's biggest complaint.
 * The chip makes one call per click; nothing may run on a timer or enumerate sessions.
 */
test('client: no polling of any kind', () => {
  assert.doesNotMatch(code, /setInterval/u, 'no timer-driven reads')
  assert.doesNotMatch(code, /const poll = async/u, 'the polling helper was removed on purpose')
  assert.doesNotMatch(code, /sessionIds\(/u, 'the client must not enumerate sessions while waiting')
})

test('client: exactly one command call per click', () => {
  const act = bundle.slice(bundle.indexOf('const act = async'), bundle.indexOf('const jump ='))
  assert.equal(
    (act.match(/callHost\(/gu) ?? []).length,
    1,
    'one callHost per click — a second call is a second transcript row',
  )
  assert.match(act, /observer-create|observer-consult/u, 'it calls the create/consult command')
})

test('client: a companion session hides the chip entirely (no nesting)', () => {
  assert.match(bundle, /reverse\[sessionId\]/u, 'the reverse index is consulted to detect "I am a companion"')
  assert.match(bundle, /if \(isObserver\) return null/u, 'the chip does not render in a companion session')
})

test('client: a JSON error blob is never rendered verbatim', () => {
  assert.match(bundle, /const friendly = /u, 'one place turns host failures into a sentence')
  assert.match(bundle, /console\.error\('\[dsh-observer\] host failure:'/u, 'the detail goes to the console')
  assert.match(bundle, /点击重试/u, 'the chip offers an action instead of dumping JSON')
})
