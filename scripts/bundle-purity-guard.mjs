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

/**
 * ── v0.39 (B2-T4b): A DECLARATION IS ONLY AS GOOD AS WHAT IT IS BOUND TO ────────────────────────
 *
 * THE VULNERABILITY, REPRODUCED 2026-11-18 with HEAD=63387fe (which carries `[bundle-change]`):
 *
 *   1. add ONE comment line to `src/core/monitor.ts` — no declaration anywhere
 *   2. `node scripts/build.mjs`            ⇒ artifact changed (244581 → 244641)
 *   3. `node scripts/bundle-purity-guard.mjs`
 *      ⇒ BUNDLE CHANGED — DECLARED via [bundle-change].   ⇒ exit 0
 *
 * An UNDECLARED change was waived — and the gate printed, in that same run, "Nothing was waived
 * silently: an UNDECLARED bundle change still fails on the next line of this gate." That sentence was
 * false in the run that printed it, which is worse than the miss itself: it asserted the miss could
 * not happen.
 *
 * ROOT CAUSE. `git log -1` is the declaration on the LATEST COMMIT; the measurement is "working tree
 * vs `before`". After committing and then continuing to edit, those point at different things:
 *
 *   CI (right after a push)   → HEAD == the pushed commit, tree clean → the declaration APPLIES
 *   local, commit-then-edit   → HEAD == the OLD commit, tree dirty    → it DOES NOT
 *
 * THE RULE, therefore: the declaration must be bound to THE ARTIFACT BEING MEASURED.
 *
 *   environment variable          → always counts: it is set for THIS run, which is the only thing a
 *                                   CI checkout can offer (no author message is in reach there)
 *   commit message (`git log -1`) → counts ONLY when the tree is clean over the measured paths,
 *                                   i.e. "the artifact being measured IS that commit's artifact"
 *
 * WHY NOT BAN COMMIT-MESSAGE DECLARATIONS OUTRIGHT: committing and then running `npm run check` is the
 * ordinary local path. Banning it sends the developer back to "export a CI variable by hand", the
 * documented dead end in `dsh-graft-slice/scripts/verify-bundle.mjs:248-258` — a gate people learn to
 * skip, which this repository calls a comment (⑯).
 *
 * WHY NOT "SKIP WHEN `src/` CHANGED": that rule goes mute exactly when it matters, because an
 * accidental artifact rebuild normally rides along with a `src/` change.
 */
const MEASURED_PATHS = ['src', 'index.js']

/** The commit the measurement is anchored to, with its subject — printed when it grants the waiver. */
const headCommit = (() => {
  try {
    const raw = execFileSync('git', ['--no-pager', 'log', '-1', '--pretty=%h%x09%s'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const [sha, subject = ''] = raw.split('\t')
    return { sha, subject }
  } catch {
    return { sha: '', subject: '' }
  }
})()

const headCommitMessage = (() => {
  try {
    return execFileSync('git', ['--no-pager', 'log', '-1', '--pretty=%B'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
})()

/**
 * Is the tree CLEAN over the measured paths?
 *
 * Only those paths count. A stray `scratch.log` next to the repository says nothing about whether the
 * artifact being measured belongs to the commit being cited, and letting it revoke a declaration would
 * make the gate fail for a reason unrelated to purity.
 */
const treeCleanOverMeasuredPaths = (() => {
  /**
   * ── WHY THIS FILTERS `git status` INSTEAD OF PASSING A PATHSPEC ──────────────────────────────
   *
   * `git status --porcelain -- src index.js` ERRORS (exit 128) when `src` matches nothing, and a
   * catch that reads "cannot ask ⇒ not clean" would then refuse every commit-message declaration in
   * such a repository. Ask for the whole status and filter by path HERE instead: `src` matches the
   * directory and anything under it, `index.js` matches exactly, and a rename line is judged by its
   * TARGET because that is where the file is.
   *
   * Same shape as `dsh-graft-slice/scripts/verify-bundle.mjs` on purpose — two repositories, one rule.
   */
  const isMeasuredPath = (path) => path === 'index.js' || path === 'src' || path.startsWith('src/')
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out.length === 0) return true
    for (const line of out.split('\n')) {
      const body = line.slice(3)
      const target = body.includes(' -> ') ? body.split(' -> ').pop() : body
      const path = target.replace(/^"|"$/gu, '')
      if (isMeasuredPath(path)) return false
    }
    return true
  } catch {
    /** Cannot ask at all ⇒ cannot claim the tree is clean ⇒ no commit-message waiver. Fail closed. */
    return false
  }
})()

const envMessage = `${process.env.GRAFT_COMMIT_MESSAGE ?? ''}\n${process.env.GITHUB_HEAD_COMMIT_MESSAGE ?? ''}`
/**
 * ── 注入点必须自述（lead §五十.4）───────────────────────────────────────────────────────────────
 *
 * `GRAFT_COMMIT_MESSAGE` 让这道门禁**以为**提交消息里有 `[bundle-change]` 声明。它改的是**入口证据**，
 * 不是被测产物——所以只打印「消息由环境提供」与长度，不打印内容。
 *
 * 为什么必须有这一行：一次「环境声明成立因此通过」与一次「真的在提交消息里声明了」打印出来的
 * 报告完全相同（`Declaration source: ENVIRONMENT VARIABLE`）。**没有这一行，读者无法区分
 * 「CI 按约定注入了」和「有人在本地为了让门禁过而注入了」**——而后者是一条不需要改代码的通过路径。
 */
if (process.env.GRAFT_COMMIT_MESSAGE !== undefined && process.env.GRAFT_COMMIT_MESSAGE !== '') {
  console.error(`bundle-purity-guard: commit message supplied from the environment, ${process.env.GRAFT_COMMIT_MESSAGE.length} char(s) (injected via GRAFT_COMMIT_MESSAGE)`)
}
const fromEnvironment = /\[bundle-change\]/u.test(envMessage)
/** The commit-message declaration is honoured ONLY when the measured artifact IS that commit's. */
const fromCommit = treeCleanOverMeasuredPaths && /\[bundle-change\]/u.test(headCommitMessage)
const declared = fromEnvironment || fromCommit

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
    /**
     * A DECLARED change is not a regression — it is the author saying "this commit means to change
     * the bundle". Say so LOUDLY, and NAME WHAT THE DECLARATION IS BOUND TO: "DECLARED" alone leaves
     * the reader unable to tell whether the waiver covers the change they are looking at, which is
     * exactly the state the old wording put them in.
     *
     * No sentence here may be true in one state and false in another. The old text asserted
     * "an UNDECLARED bundle change still fails" while this branch was waiving exactly such a change.
     */
    if (declared) {
      console.log('\nBUNDLE CHANGED — DECLARED via [bundle-change].')
      console.log('  The instrument is right that this is not a pure move; the declaration is the author')
      console.log('  stating that changing the bundle is the point of this commit.')
      if (fromEnvironment) {
        console.log('  Declaration source: ENVIRONMENT VARIABLE (GRAFT_COMMIT_MESSAGE /')
        console.log('  GITHUB_HEAD_COMMIT_MESSAGE) — set for this run, so it covers what this run measured.')
      }
      if (fromCommit) {
        console.log(`  Declaration source: COMMIT ${headCommit.sha} "${headCommit.subject}".`)
        console.log(`  It covers this change because the tree is clean over ${MEASURED_PATHS.join(', ')} —`)
        console.log('  the artifact just measured IS that commit\'s artifact.')
      }
      if (!treeCleanOverMeasuredPaths && !fromEnvironment) {
        /** Unreachable by construction; kept so a future edit cannot silently invert the logic. */
        console.log('  (Inconsistent state: declaration found but not attributable to this measurement.)')
      }
      process.exit(0)
    }
    console.error(`\nBUNDLE PURITY FAILED against ${before}: the build changed CODE, not just position.`)
    console.error('If this commit is a pure move, the difference is a plumbing normalisation bug — fix')
    console.error('the normaliser in scripts/verify-bundle-purity.mjs, do NOT delete this step.')
    console.error('If this commit MEANS to change the bundle (a feature), declare it: put')
    console.error('  [bundle-change]')
    console.error('in the commit message, WITH A CLEAN TREE over these paths, so the declaration is bound')
    console.error(`to the artifact being measured (${MEASURED_PATHS.join(', ')}); or set GRAFT_COMMIT_MESSAGE.`)
    if (!treeCleanOverMeasuredPaths && /\[bundle-change\]/u.test(headCommitMessage)) {
      /**
       * The precise trap from B2-T4b, named at the moment it bites: the author DID declare, but on the
       * previous commit, and then kept editing. Silence here reads as "your declaration was ignored".
       */
      console.error(`Note: commit ${headCommit.sha} declares [bundle-change], but the tree is DIRTY over`)
      console.error(`${MEASURED_PATHS.join(', ')} — the artifact measured here is not that commit's, so its`)
      console.error('declaration does not cover these edits. Commit them (or set GRAFT_COMMIT_MESSAGE).')
    }
    process.exit(1)
  }
  console.error(`\nBUNDLE PURITY DID NOT RUN: unexpected exit ${error?.status ?? 'unknown'}.`)
  process.exit(1)
}