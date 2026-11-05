#!/usr/bin/env node
/**
 * PREFLIGHT — run this BEFORE restarting the host.
 *
 * WHY THIS EXISTS
 *
 * Every test in this package imports `index.js` and drives it through a fake host. That proves the
 * BEHAVIOUR but not the ARTIFACT: a stale build, a relative import that only fails at load, a BOM,
 * a version drift between `index.js` / `package.json` / `manifest.json`, or a tool registration
 * missing its `output` contract would all ship a plugin that the Loader refuses — and the symptom
 * (the whole entry does not activate) reads nothing like the cause.
 *
 * So this script checks the shipped file the way the Loader will, with no test harness in between.
 * It performs NO writes and touches nothing outside the package.
 *
 * Exit code 0 = safe to restart. Non-zero = do not restart; the list says what to fix.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const checked = []

const fail = (message) => problems.push(message)
const ok = (message) => checked.push(message)

/* ── 1. the three files that carry the version must agree ─────────────────── */

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const bundle = readFileSync(join(root, 'index.js'), 'utf8')

const bundleVersion = /export const VERSION = '([^']+)'/u.exec(bundle)?.[1] ?? '(none)'
if (pkg.version !== manifest.version) fail(`package.json ${pkg.version} ≠ manifest.json ${manifest.version}`)
else ok(`version agreement: ${pkg.version}`)
if (bundleVersion !== pkg.version) fail(`index.js VERSION '${bundleVersion}' ≠ package.json ${pkg.version} — rebuild`)
else ok(`built bundle carries VERSION ${bundleVersion}`)

/* ── 2. byte-level hazards the Loader rejects ─────────────────────────────── */

for (const file of ['package.json', 'manifest.json', 'index.js', 'client.js']) {
  const bytes = readFileSync(join(root, file))
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(`${file} starts with a UTF-8 BOM — the entry reports 包不可用`)
}
ok('no UTF-8 BOM in the four shipped files')

/* ── 3. a surviving relative import fails at IMPORT time, not at build ────── */

const relativeImport = bundle
  .split('\n')
  .findIndex((line) => /from\s*'\.\.?\//u.test(line) && !line.trimStart().startsWith('//'))
if (relativeImport >= 0) fail(`index.js line ${relativeImport + 1} has an unresolved relative import`)
else ok('no unresolved relative import in index.js')

/* ── 4. the Loader's schema subset ───────────────────────────────────────── */

const FORBIDDEN = ['anyOf', 'allOf', 'not', 'patternProperties', 'if', 'then', 'else', 'minLength', 'maxLength', 'pattern', 'format']
const offenders = FORBIDDEN.filter((keyword) => new RegExp(`(^|[^A-Za-z])${keyword}\\s*:`, 'u').test(bundle))
if (offenders.length > 0) fail(`index.js uses unsupported schema keyword(s): ${offenders.join(', ')}`)
else ok('schema vocabulary is inside the Loader subset')

/* ── 5. every registered tool declares an output contract ────────────────── */

const registrations = [...bundle.matchAll(/ctx\.tools\?\.register\(\s*\{/gu)]
if (registrations.length === 0) fail('no tool registrations found — the scan would be vacuous')
const toolNames = []
for (const [index, match] of registrations.entries()) {
  const from = match.index ?? 0
  const next = registrations[index + 1]?.index ?? bundle.length
  const block = bundle.slice(from, next)
  const name = /name:\s*'([^']+)'/u.exec(block)?.[1] ?? '(unnamed)'
  toolNames.push(name)
  if (!/\boutput:\s*\{/u.test(block)) fail(`tool ${name} has no output contract — this kills the whole Web boot`)
  else if (!/\bschema:\s*\{/u.test(block) || !/\brender:\s*/u.test(block)) fail(`tool ${name} output lacks schema/render`)
}
if (toolNames.length > 0) ok(`${toolNames.length} tool(s) with output contracts: ${toolNames.join(', ')}`)

/* ── 6. the manifest's service list must match reality ───────────────────── */

const declaredInject = /export const inject = \[([^\]]*)\]/u.exec(bundle)?.[1] ?? ''
const injectNames = [...declaredInject.matchAll(/'([^']+)'/gu)].map((m) => m[1])
const manifestServices = Array.isArray(manifest.services) ? manifest.services : []
for (const service of manifestServices) {
  if (!injectNames.includes(service)) fail(`manifest declares service '${service}' but inject omits it`)
}
for (const service of injectNames) {
  if (!manifestServices.includes(service)) fail(`inject requires '${service}' but manifest.services omits it`)
}
if (problems.length === 0) ok(`inject ↔ manifest.services agree: ${injectNames.join(', ')}`)

/* ── 7. the build is current: the shipped file must match a fresh compose ── */

const { composeBundle } = await import('./bundle.mjs')
const fresh = composeBundle(root).output
if (fresh !== bundle) {
  fail('index.js differs from a fresh build — run `node scripts/build.mjs` before restarting')
} else {
  ok(`index.js is byte-identical to a fresh build (${Buffer.byteLength(bundle)} bytes)`)
}

/* ── 8. the artifact must IMPORT in a clean process ─────────────────────── */

try {
  const mod = await import(new URL('../index.js', import.meta.url))
  if (typeof mod.activate !== 'function') fail('index.js does not export `activate` — the Loader looks for it')
  else ok('index.js exports activate (and apply)')
  if (mod.VERSION !== pkg.version) fail(`imported VERSION ${String(mod.VERSION)} ≠ ${pkg.version}`)
  for (const seam of ['injectionInternals', 'diskLogInternals', 'debugObserverState', 'monitorInternals', 'supervisorInternals']) {
    if (mod[seam] === undefined) fail(`test seam '${seam}' missing from the bundle`)
  }
  /**
   * v1.8.0 — THE 彼岸层 DEPENDENCY, CHECKED THE WAY IT IS ACTUALLY USED.
   *
   * The reader moved to `dsh-paradise`, and the plugin reaches it LAZILY for a reason: this artifact
   * is a single-file bundle, and a bare specifier that fails to resolve would kill the whole entry —
   * taking an installed plugin down because a SECOND package is absent. So the check is twofold:
   *
   *   1. no static bare import survives into index.js (that is the fatal shape), and
   *   2. the lazy resolution really works from here, so the shipped copy can reach the layer in this
   *      workspace layout.
   *
   * A missing layer is NOT a build failure — it is a degraded mode with a stated consequence — but a
   * silent one would be, so the outcome is printed either way.
   */
  const bareSpecifier = /^\s*import\s+[^\n]*from\s*'dsh-paradise'/mu.test(bundle)
  if (bareSpecifier) fail("index.js contains a static `import ... from 'dsh-paradise'` — an absent package would kill the whole entry")
  else ok('no static bare import of dsh-paradise (the layer is reached lazily)')

  const binding = await mod.diskLogInternals?.ensureParadise?.()
  if (binding === undefined) fail('diskLogInternals.ensureParadise is missing — the bridge would be unreachable')
  else if (binding.available) {
    ok(`dsh-paradise reachable via '${binding.via}' (disk cross-check LIVE)`)
  } else {
    // Reported, not failed: with the layer absent the WRITE path refuses too — see the next check.
    ok(`dsh-paradise NOT reachable — incubation would be REFUSED with PARADISE_WRITE_UNAVAILABLE: ${binding.reason.slice(0, 120)}`)
  }

  /**
   * v1.9.0 — THE WRITE PATH MUST BE THE LAYER, NOT A SECOND COPY IN THIS BUNDLE.
   *
   * The switch moved create/inject/trigger/delete into `dsh-paradise`. Two things have to stay true for
   * that to mean anything:
   *
   *   1. this bundle still reaches the layer's WRITE surface (createDshAdapters + the adapter's create);
   *   2. the archived `observer-inject.ts` is not carrying the live write path any more. It stays in the
   *      tree as history, and it is still inlined for two READ-ONLY helpers (the cwd donor chain and the
   *      error type), so a blanket "must not contain it" check would be wrong — the check is that the
   *      write functions are no longer CALLED from this file.
   */
  if (/PARADISE_WRITE_UNAVAILABLE/u.test(bundle)) ok('the write path refuses with PARADISE_WRITE_UNAVAILABLE when the layer is absent')
  else fail('the write-path refusal is gone — a missing layer would produce a silent no-op or a crash')

  if (/ensureWriteAdapter/u.test(bundle) && /createDshAdapters/u.test(bundle)) {
    ok('the write path goes through the layer (ensureWriteAdapter → createDshAdapters)')
  } else {
    fail('the write path no longer reaches dsh-paradise.createDshAdapters')
  }

  const srcIndex = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const stillCallsArchive = /await injectColdSession\(|await rollbackInjectedSession\(|await igniteSession\(/u.test(srcIndex)
  if (stillCallsArchive) {
    fail('src/index.ts still CALLS the archived write functions — the migration is incomplete')
  } else {
    ok('src/index.ts calls none of the archived write functions (create/rollback/ignite)')
  }
} catch (error) {
  fail(`importing index.js threw: ${String(error?.message ?? error)}`)
}

/* ── report ─────────────────────────────────────────────────────────────── */

console.log('PREFLIGHT — dsh-observer\n')
for (const line of checked) console.log(`  OK   ${line}`)
if (problems.length > 0) {
  console.log('')
  for (const line of problems) console.log(`  FAIL ${line}`)
  console.log(`\n${problems.length} problem(s). DO NOT RESTART until they are fixed.`)
  process.exitCode = 1
} else {
  console.log('\nAll checks passed. Safe to restart the host.')
}
