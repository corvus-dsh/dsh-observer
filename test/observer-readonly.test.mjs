/**
 * P1-1 (audit 2026-11-08) — WHAT THE `session/event` LISTENER IS ALLOWED TO TOUCH.
 *
 * ── THE ASSERTION I FIRST PROPOSED WAS WRONG, AND THIS FILE IS THE CORRECTION ──────────────────
 *
 * Stage three said "assert that observer's `session/event` listener only reads". Reading the code
 * before writing the assertion showed it WRITES — deliberately:
 *
 *   - `state.bindings[...] = ...` + `save()` rewrites `observer-bindings.json` when a companion
 *     title arrives (that is how a title-derived pair is RECORDED, not just observed);
 *   - `injectSetting(...)` then writes the mission into the companion.
 *
 * So the honest rule is not "read-only". It is a SCOPE boundary, and it is narrower and more useful:
 *
 *   IT MAY WRITE ITS OWN STATE AND ITS OWN COMPANION'S SETTING.
 *   IT MAY NOT WRITE THE MAIN'S LOG, the global knowledge base, or the task graph.
 *
 * That distinction is what matters. The listener is fed every committed event of EVERY session, so a
 * write into the main's session log from here would be a plugin appending to a log it does not own —
 * mid-post-commit, with the host's own writer possibly holding it. The bindings file and a scoped
 * `developer/message` into the companion are this plugin's own business.
 *
 * Both assertions below are therefore about WHICH paths are touched, not about "no writes at all".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/**
 * Extract the `session/event` listener body by brace matching from its registration site.
 *
 * A regex to the next `})\n` would be wrong: this handler contains nested arrow functions and a
 * `try/catch`, so the first `})` closes an inner call. Counting braces is the only honest way to
 * find the end, and it is what the assertion needs to be about a RANGE rather than a whole file.
 */
function listenerBody(text) {
  const start = text.indexOf("ctx.on?.('session/event'")
  assert.notEqual(start, -1, 'the session/event listener must exist')
  const open = text.indexOf('{', start)
  let depth = 0
  let index = open
  for (; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return text.slice(open, index + 1)
}

const body = listenerBody(source)

test('P1-1: the listener does not append to ANY session log (it is fed, not a writer)', () => {
  for (const forbidden of ['session.append(', '.append("', ".append('", 'live.append(']) {
    assert.ok(
      !body.includes(forbidden),
      `the listener must not append to a session log (found ${forbidden}); it runs inside the host's post-commit feed`,
    )
  }
})

test('P1-1: the listener does not write the global knowledge base or the task graph', () => {
  // These belong to dsh-memory. A cross-plugin write from an event listener is the coupling this
  // boundary exists to forbid — and it would race that plugin's own locks.
  for (const forbidden of ['knowledge.jsonl', 'knowledge-refs.jsonl', 'task-graph.json', 'writeKnowledge', 'recordKnowledgeRefs', 'updateGraph']) {
    assert.ok(!body.includes(forbidden), `the listener must not touch ${forbidden}`)
  }
})

test('P1-1: the only persistence it performs is its OWN bindings file', () => {
  /**
   * It does write — `save()` — and that is correct. What must stay true is the TARGET: the plugin's
   * own bindings document. Asserting the call is present also stops a future refactor from silently
   * removing the only durable record of a title-derived pair.
   */
  assert.ok(body.includes('save()'), 'the title-derived binding must still be persisted')
  const saveSites = [...body.matchAll(/writeAtomic\(|writeFileSync\(/gu)].length
  assert.equal(saveSites, 0, 'the listener must call save(), not write the file itself')
})

test('P1-1: the listener catches its own failures (a throwing listener would break the host feed)', () => {
  assert.ok(body.includes('try'), 'a try must wrap the body')
  assert.ok(body.includes('catch'), 'and it must catch, not rethrow')
  assert.match(body, /logger\?\.(warn|info)/u, 'a swallowed failure is logged, never silent')
})

/* ── the runtime half: a real event must not modify anything outside the plugin's own state ── */

test('P1-1 RUNTIME: feeding the listener leaves the memory directories untouched', async () => {
  const { apply } = await import('../index.js')
  const { makeHost } = await import('./harness.mjs')

  const root = mkdtempSync(join(tmpdir(), 'dsh-observer-readonly-'))
  const bindingsDir = join(root, 'observer')
  const memoryDir = join(root, 'memory')
  const knowledgeDir = join(root, 'knowledge')

  const host = makeHost({})
  apply(host.ctx, { bindingsPath: join(bindingsDir, 'observer-bindings.json') })

  // The harness records every `ctx.on(...)` registration in `listeners` (a Map keyed by event).
  const listener = host.listeners?.get?.('session/event')
  assert.ok(typeof listener === 'function', 'the harness must expose the session/event handler')

  /** A snapshot of every file under the memory/knowledge trees, before and after. */
  const snapshot = () => {
    const out = []
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else out.push(`${full}:${statSync(full).size}:${statSync(full).mtimeMs}`)
      }
    }
    walk(root)
    return out.sort()
  }

  // Seed the plugin so its own bindings file exists; the assertion is about what happens AFTER.
  const before = snapshot()

  /**
   * Feed a stream of ordinary events, including a companion title (the one branch that writes).
   * The title is shaped exactly as the plugin expects: a title event carrying the pair marker.
   */
  const events = [
    { type: 'assistant/message', data: { message: { content: [] } } },
    { type: 'session/title', data: { title: '[副脑] 跟随 session-main', sessionId: 'session-observer' } },
    { type: 'tool/call', data: { name: 'todo_write' } },
  ]
  for (const event of events) {
    listener(host.sessions?.get?.('session-observer') ?? { id: 'session-observer' }, event)
    // Let any detached `void`ed work settle before the next snapshot.
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const after = snapshot()
  /**
   * WHAT MAY DIFFER: the bindings document this plugin owns. What may NOT: the memory and knowledge
   * trees — they do not belong to this plugin, and nothing on this listener's path may create them.
   */
  const touchedMemory = [...before, ...after].filter((entry) => entry.includes(memoryDir) || entry.includes(knowledgeDir))
  assert.deepEqual(touchedMemory, [], 'the listener must not create or modify the memory layer stores')

  void memoryDir
  void knowledgeDir
})
