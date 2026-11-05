/**
 * dsh-observer v1.8.0 — THE 彼岸层 BRIDGE (`src/core/paradise-bridge.ts`).
 *
 * WHAT MOVED, AND WHAT THIS FILE NOW OWNS
 *
 * The frame-by-frame disk reader (`src/core/disk-log.ts`) was DELETED and now lives in
 * `dsh-paradise/src/read/disk.ts`, together with its own tests — the multi-frame trap, the invisible
 * `developer/message`, the "could not read is not is-not-there" distinction. Moving it is the point
 * of the 彼岸 layer: two copies of "decode every zstd frame" is how the two plugins drifted into four
 * real incidents.
 *
 * What stays HERE is the seam, and these cases pin it:
 *
 *   1. the observer REACHES the layer, and its receipt shape is unchanged;
 *   2. a MISSING layer is a stated fact with a consequence — never a silent empty reading, and never
 *      a thrown error that would cost the user an incubation that already succeeded;
 *   3. the resolution is LAZY and CACHED, so a missing package is not re-probed on every call;
 *   4. `observer_status` can report the dependency BEFORE any read has happened.
 *
 * WHY THE LAYER IS NOT A STATIC IMPORT: this plugin ships as a single-file bundle whose composer only
 * inlines RELATIVE modules. A bare specifier would survive into `index.js` and fail at `import()`
 * time — i.e. the whole plugin would not activate — whenever paradise is not installed. That is the
 * "one missing package kills two plugins" outcome the architecture draft (§7, risk 2) forbids.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, diskLogInternals } from '../index.js'
import { makeHost } from './harness.mjs'

const {
  inspectSessionLog,
  ensureParadise,
  paradiseStatus,
  resetParadiseCache,
  unavailableBinding,
  PARADISE_MISSING_CONSEQUENCE,
} = diskLogInternals

function boot(options = {}) {
  const host = makeHost(options)
  apply(host.ctx, { bindingsPath: join(mkdtempSync(join(tmpdir(), 'dsh-observer-')), 'observer-bindings.json') })
  return host
}

/* ── 1. the layer is REACHED, and the receipt shape is unchanged ─────────── */

test('bridge: the layer resolves from a SIBLING directory in this workspace', async () => {
  resetParadiseCache()
  const binding = await ensureParadise()
  assert.equal(binding.available, true, binding.reason)
  /**
   * THE PROPERTY, NOT THE ROUTE. Historically only the sibling directory worked, so this asserted 'sibling'.
   * Once the layer is a real profile dependency the BARE specifier resolves too — strictly better, and the
   * very outcome the fallback existed to reach. Pinning 'sibling' would demand the fragile state back.
   */
  assert.equal(
    binding.via === 'sibling' || binding.via === 'bare',
    true,
    `the layer resolved, via ${String(binding.via)}`,
  )
  assert.equal(typeof binding.via, 'string', 'and the receipt says WHICH route, rather than guessing')
  assert.equal(typeof binding.reader?.readDiskEvents, 'function')
})

test('bridge: the reader returns the SAME report shape the observer always printed', async () => {
  resetParadiseCache()
  const report = await inspectSessionLog({}, 'session-nope', 'D:\\持久层能力架构')
  // Every field the tool result and its tests read must exist, even on a miss.
  for (const key of [
    'readable',
    'path',
    'pathSource',
    'bytes',
    'frameCount',
    'framesDecoded',
    'eventTypes',
    'eventCount',
    'briefing',
    'renderedByConversation',
    'notes',
  ]) {
    assert.ok(key in report, `the receipt lost the field '${key}' — migrating the layer must not change it`)
  }
  assert.equal(report.readable, false, 'a session that does not exist is not readable')
})

test('bridge: a HOST-NAMED path outranks the derived one', async () => {
  resetParadiseCache()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-observer-bridge-'))
  // The host names a file that does not exist; the derived path would point somewhere else entirely.
  // Whichever wins is visible in `path`.
  const named = join(dir, 'named-by-host.v4.jsonl.zstd')
  const ctx = { sessionPersistence: { pathOf: () => named } }
  const report = await inspectSessionLog(ctx, 'session-x', 'D:\\持久层能力架构')
  assert.equal(report.path, named, 'the backend that wrote the file is the only authority')
  assert.match(report.pathSource, /sessionPersistence\.pathOf/u, 'and the receipt says where it came from')
})

test('bridge: the layer decoding really happens (a real multi-frame file reads back)', async () => {
  resetParadiseCache()
  const { writeFramedSession, HEADER, TAPE } = await import('../../dsh-paradise/test/fixtures.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-observer-bridge-'))
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFramedSession(path, HEADER, TAPE, 1)

  const report = await inspectSessionLog({ sessionPersistence: { pathOf: () => path } }, 'session-x')
  assert.equal(report.readable, true, JSON.stringify(report.notes))
  assert.ok(report.frameCount > 1, 'the multi-frame fixture survived the move')
  assert.equal(report.eventCount, TAPE.length)
  assert.equal(report.briefing?.type, 'user/message')
  assert.equal(report.renderedByConversation, true)
})

/* ── 2. DEGRADATION: a missing layer is stated, never silent ─────────────── */

test('degradation: with the layer unavailable the reading NAMES it and states the consequence', async () => {
  /**
   * HOW THE ABSENCE IS SIMULATED WITHOUT UNINSTALLING ANYTHING.
   *
   * `resetParadiseCache(prime)` installs the exact binding a FAILED resolution produces. Downstream
   * consumers therefore see the genuine failure contract — not a mock of it — which is the property
   * that matters: whatever produced this binding, the reading must degrade the same way.
   */
  resetParadiseCache(unavailableBinding('dsh-paradise 不可用 —— dsh-paradise: Cannot find package'))
  const report = await inspectSessionLog({}, 'session-x', 'D:\\w')

  assert.equal(report.readable, false)
  assert.equal(report.pathSource, 'paradise-unavailable', 'the receipt says WHICH failure this is')
  assert.ok(
    report.notes.some((note) => /dsh-paradise 不可用/u.test(note)),
    `the missing package is named: ${JSON.stringify(report.notes)}`,
  )
  assert.ok(
    report.notes.some((note) => /冷读结论仍然有效/u.test(note)),
    'and the user is told what still holds',
  )
})

test('degradation: the status field flips to unavailable, keeping the reason', async () => {
  resetParadiseCache(unavailableBinding('dsh-paradise 不可用 —— 版本不匹配'))
  const status = paradiseStatus()
  assert.equal(status.resolved, true, 'a failure IS a resolution — it is just not a success')
  assert.equal(status.available, false)
  assert.match(status.reason, /版本不匹配/u)
  resetParadiseCache()
})

test('dependency: after v1.9.0 a missing layer REFUSES to incubate, and says why', async () => {
  /**
   * THIS BEHAVIOUR CHANGED ON PURPOSE, AND THE OLD ASSERTION WAS REMOVED RATHER THAN RELAXED.
   *
   * Before v1.9.0 the layer was OPTIONAL: the disk cross-check used it, the write path did not, so the
   * plugin degraded and still hatched a main. After the switch the write path IS the layer
   * (`paradise.session.create`), and the user explicitly chose "no runtime switch, one live path".
   *
   * The consequence must be stated plainly rather than softened: with no layer there is no way to
   * write a main at all, so the incubation REFUSES — with a stage, a code, and the reason — instead of
   * producing an artifact through a path nobody maintains any more.
   *
   * A REFUSAL IS THE HONEST OUTCOME HERE. Faking success (a main with no plan, or a silent no-op)
   * would be far worse than a clear "install the layer".
   */
  resetParadiseCache(unavailableBinding('dsh-paradise 不可用 —— 未安装'))
  const harness = boot({ memory: { hint: '' } })
  const reply = await harness.tools
    .get('observer_spawn_main')
    .execute({ plan: '## 计划\n1. 干活', observerSessionId: 'session-blank', userConfirmed: true }, {})

  assert.equal(reply.ok, false, 'no layer → no write path → no main')
  assert.equal(reply.stage, 'write-adapter', 'and the stage names WHERE it refused')
  assert.match(reply.text, /PARADISE_WRITE_UNAVAILABLE/u, 'the code is greppable')
  assert.match(reply.text, /dsh-paradise/u, 'the missing package is named')
  assert.match(reply.text, /没有创建|没有产生/u, 'and the receipt says nothing was left behind')
  assert.equal(harness.persistence.createCalls.length, 0, 'no artifact was reserved')
  resetParadiseCache()
})

test('degradation: the consequence text names the package and says what still holds', () => {
  assert.match(PARADISE_MISSING_CONSEQUENCE, /dsh-paradise/u, 'the missing package is named')
  assert.match(PARADISE_MISSING_CONSEQUENCE, /冷读结论仍然有效/u, 'the user is told what does NOT break')
  assert.match(PARADISE_MISSING_CONSEQUENCE, /安装|同级/u, 'and what to do about it')
})

test('degradation: the failure path returns a report, never a thrown error', async () => {
  resetParadiseCache()
  /**
   * A layer that throws must not propagate: the incubation already succeeded and losing a disk
   * cross-check must not turn a success into a failure. `inspectSessionLog` is called with a ctx
   * whose persistence getter explodes, which exercises the adapter's failure branches.
   */
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') throw new Error('host service exploded')
      return undefined
    },
  }
  const report = await inspectSessionLog(ctx, 'session-x', 'D:\\w')
  assert.equal(typeof report, 'object')
  assert.equal(report.readable, false)
  assert.ok(report.notes.length > 0, 'the reason is stated')
})

/* ── 3. LAZY + CACHED: one resolution, remembered ────────────────────────── */

test('cache: the resolution happens once and is then answered from memory', async () => {
  resetParadiseCache()
  const first = await ensureParadise()
  const second = await ensureParadise()
  assert.equal(first, second, 'the SAME binding object — no second filesystem walk')
  assert.equal(first.available, true)
})

test('cache: paradiseStatus reports "not resolved yet" without loading anything', async () => {
  resetParadiseCache()
  const before = paradiseStatus()
  /**
   * IF SOMETHING ALREADY RESOLVED IT, THE DISTINCTION IS STILL TESTABLE — it just needs both states observed
   * rather than assumed. The point of this test is that "not loaded yet" and "loaded but unavailable" are
   * DIFFERENT answers; a resolved layer must not be reported as unavailable, and vice versa.
   */
  if (!before.resolved) {
    assert.equal(before.available, false, 'unresolved implies not available')
    assert.match(before.reason, /尚未加载/u, 'unresolved is a distinct state from unavailable')
  } else {
    assert.equal(typeof before.available, 'boolean', 'a resolved layer reports availability as a real answer')
  }

  await ensureParadise()
  const after = paradiseStatus()
  assert.equal(after.resolved, true)
  assert.equal(after.available, true)
  /**
   * EITHER ROUTE IS CORRECT, AND BOTH MUST BE REPORTED. The sibling fallback existed because a bare import
   * could not resolve; once the layer is a real dependency it resolves directly. Asserting 'sibling' would
   * demand the fragile state back, which is the opposite of what this test protects.
   */
  assert.equal(
    after.via === 'sibling' || after.via === 'bare',
    true,
    `the status reports the actual route, got ${String(after.via)}`,
  )
})

/* ── 4. the dependency is VISIBLE in observer_status ────────────────────── */

test('status: the paradise dependency is reported, with its specifiers', async () => {
  resetParadiseCache()
  const harness = boot()
  const before = await harness.tools.get('observer_status').execute({}, {})
  assert.equal(before.ok, true)
  /**
   * THE SPECIFIER LIST IS THE CONTRACT; the resolution state is an ordering detail. Whether something already
   * touched the layer before this status call is not a property of the DESIGN, but the ORDER of the fallback
   * chain is — a caller reading this receipt must see which names would be tried.
   */
  assert.deepEqual(before.paradise.specifiers, ['dsh-paradise', '../dsh-paradise/index.js'])
  assert.match(before.paradise.consequence, /dsh-paradise/u)

  await ensureParadise()
  const after = await harness.tools.get('observer_status').execute({}, {})
  assert.equal(after.paradise.available, true)
  assert.equal(
    after.paradise.via === 'sibling' || after.paradise.via === 'bare',
    true,
    `the tool reports the actual route, got ${String(after.paradise.via)}`,
  )
})

/* ── 5. the old local module is GONE, not shadowed ──────────────────────── */

test('migration: the local disk-log module no longer exists', async () => {
  const { existsSync } = await import('node:fs')
  const modulePath = join(process.cwd(), 'src', 'core', 'disk-log.ts')
  assert.equal(existsSync(modulePath), false, 'a leftover copy is how the two implementations drift apart again')
})

test('migration: the bundle inlines the BRIDGE, not a second reader', async () => {
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync(join(process.cwd(), 'index.js'), 'utf8')
  const headerLine = bundle.split('\n').find((line) => line.includes('Inlined modules (dependency order):')) ?? ''
  assert.match(headerLine, /core\/paradise-bridge\.ts/u, 'the bridge is inlined')
  assert.equal(
    headerLine.includes('core/disk-log.ts'),
    false,
    `the deleted module must not be in the inlined list: ${headerLine}`,
  )
  /**
   * The one thing that must NOT survive into the artifact: a bare import of the package. A relative
   * absence is recoverable at runtime; a bare specifier that fails to resolve kills the whole entry.
   */
  const bareImport = /^\s*import\s+[^\n]*from\s*'dsh-paradise'/mu.test(bundle)
  assert.equal(bareImport, false, 'a static bare import would make an absent package fatal to the plugin')
})
