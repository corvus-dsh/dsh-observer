#!/usr/bin/env node
/**
 * BUNDLE-PURITY GUARD — the CI-shaped wrapper around `verify-bundle-purity.mjs`.
 *
 * ── WHY A WRAPPER, AND NOT JUST CALLING THE INSTRUMENT ──────────────────────────────────────────
 *
 * `verify-bundle-purity.mjs` exits **2** for TWO different situations, both measured on this repo:
 *
 *   1. `--before HEAD~1` on a commit that did not touch `index.js`
 *      ⇒ `VACUOUS — index.js is byte-identical at HEAD~1 and undefined`  (the norm: most commits
 *        change `src/` plumbing or docs, not the built artifact);
 *   2. a shallow clone where `HEAD~1` does not exist at all
 *      ⇒ `cannot measure: index.js missing at HEAD~1`.
 *
 * Both are RESOURCE conditions, per the house rule written down in `test/v201` and in graft-slice's
 * `docs/维护手册.md` §四: **缺少资源是「跳过」，不是「通过」**. The instrument is RIGHT to exit 2 — a
 * purity check with nothing to compare cannot pass, and pretending otherwise is how a gate becomes a
 * comment.
 *
 * But a CI step that is red whenever the artifact did not change is a gate that cries wolf, and the
 * documented outcome of that is: somebody switches it off. So the translation happens HERE, once, in
 * one place, loudly:
 *
 *   exit 2  → print `RESOURCE: … not checked this run` + the instrument's own reason + exit 0
 *   exit 1  → NOT PURE → exit 1   (a real regression still fails the push)
 *   exit 0  → PURE    → exit 0
 *
 * The rule "report RESOURCE and exit 0, but the LOG MUST SAY the check did not happen" is the one the
 * user ruled on 2026-11-12; this file does not invent a new policy, it applies it.
 *
 * ── CAN THIS WRAPPER ITSELF BE VACUOUS? ─────────────────────────────────────────────────────────
 *
 * Yes, by construction — and that is the whole point of the exit-2 branch, so the answer must be
 * provable rather than asserted. Measured on this repo while writing it:
 *
 *   `--before 5d32faf~1`  ⇒ exit 1 (BUNDLE NOT PURE, 2 lines: `path: () => bindingsPath,` …)
 *   `--before 0e04cd6~1`  ⇒ exit 1 (BUNDLE NOT PURE, 5 lines added, 4 removed)
 *   `--before 7abbd73~1`  ⇒ exit 1 (BUNDLE NOT PURE, 460+ lines — that commit really moved code)
 *   `--before HEAD~1`     ⇒ exit 2 → RESOURCE, because HEAD~1 did not change `index.js`
 *
 * The three exit-1 runs are the proof that the red path is reachable; they are recorded in
 * `docs/gate-wiring.md` together with the command that reproduces them.
 *
 * Usage:
 *   node scripts/bundle-purity-guard.mjs                # CI: compares HEAD~1 → working tree
 *   node scripts/bundle-purity-guard.mjs --before <ref>  # same check against another ref
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const INSTRUMENT = join(REPO, 'scripts', 'verify-bundle-purity.mjs')

const argOf = (flag) => {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const before = argOf('--before') ?? 'HEAD~1'

/** A shallow clone legitimately has no HEAD~1. Say so; do not pass silently. */
const refExists = (ref) => {
  const probe = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: REPO,
    encoding: 'utf8',
  })
  return probe.status === 0
}

const isShallow = () => {
  const probe = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: REPO, encoding: 'utf8' })
  return (probe.stdout ?? '').trim() === 'true'
}

const resource = (why) => {
  console.log(`RESOURCE — bundle purity NOT CHECKED this run: ${why}`)
  console.log('  This is a RESOURCE condition, not a pass: nothing was compared, so nothing is proven.')
  console.log('  Reproduce locally with a full clone: node scripts/bundle-purity-guard.mjs --before HEAD~1')
  process.exit(0)
}

if (!refExists(before)) {
  resource(`${before} does not exist in this checkout${isShallow() ? ' (shallow clone)' : ''}`)
}

let result
try {
  result = execFileSync(process.execPath, [INSTRUMENT, '--before', before], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  process.stdout.write(result)
  console.log(`PURE — bundle code-line multiset unchanged from ${before}.`)
  process.exit(0)
} catch (error) {
  const out = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
  process.stdout.write(out)
  if (error?.status === 2) {
    resource(`the instrument could not measure against ${before} (see its message above)`)
  }
  if (error?.status === 1) {
    console.error(`\nBUNDLE PURITY FAILED against ${before}: the build changed CODE, not just position.`)
    console.error('If this commit is a pure move, the difference is a plumbing normalisation bug — fix')
    console.error('the normaliser in scripts/verify-bundle-purity.mjs, do NOT delete this step.')
    process.exit(1)
  }
  console.error(`\nBUNDLE PURITY DID NOT RUN: unexpected exit ${error?.status ?? 'unknown'}.`)
  process.exit(1)
}