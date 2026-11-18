/**
 * ── v237 (B2-T4b): 声明必须绑定「被测量的那一次」 ───────────────────────────────────────────────
 *
 * ── THE VULNERABILITY (reproduced 2026-11-18, `dsh-observer`, HEAD=63387fe which carries
 *    `[bundle-change]`) ───────────────────────────────────────────────────────────────────────────
 *
 *   1. add ONE comment line to `src/core/monitor.ts` — no declaration anywhere
 *   2. `node scripts/build.mjs`            ⇒ artifact changed (244581 → 244641)
 *   3. `node scripts/bundle-purity-guard.mjs`
 *      ⇒ BUNDLE CHANGED — DECLARED via [bundle-change].
 *      ⇒ exit 0                            ← an UNDECLARED change was waived
 *
 * And the guard printed, in that same run:
 *
 *     "Nothing was waived silently: an UNDECLARED bundle change still fails on the next line of this gate."
 *
 * — a sentence that was false in the run that printed it. That is the real damage: the gate did not
 * merely fail to catch the change, it ASSERTED the change could not happen.
 *
 * ── ROOT CAUSE, ONE LINE ────────────────────────────────────────────────────────────────────────
 *
 *     declared = /\[bundle-change\]/.test(env + gitLog -1)
 *
 * `git log -1` is "the declaration on the LATEST COMMIT". The measurement is "working tree vs
 * `--before`". After committing and then continuing to edit, those two point at different things:
 *
 *     CI (run right after push)  | HEAD == the pushed commit | tree clean | declaration APPLIES
 *     local, commit-then-edit    | HEAD == the OLD commit     | tree dirty | declaration DOES NOT
 *
 * ── WHAT THE FIX MUST PRESERVE ──────────────────────────────────────────────────────────────────
 *
 * A commit-message declaration is still honoured — but only when the tree is CLEAN over the measured
 * paths, i.e. "the artifact being measured IS that commit's artifact". Banning commit-message
 * declarations outright would send developers back to the documented dead end ("export a CI variable
 * by hand", `verify-bundle.mjs:248-258`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GUARD = 'scripts/bundle-purity-guard.mjs'
const INSTRUMENT = 'scripts/verify-bundle-purity.mjs'

/** The paths whose cleanliness decides whether a commit-message declaration applies. */
const MEASURED_PATHS = ['src', 'index.js']

function gitIn(root, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * A throwaway repository holding only the two scripts and an `index.js` we control.
 *
 * `headDeclared` decides whether the COMMITTED message carries `[bundle-change]`;
 * `worktreeChanged` decides whether the artifact is then edited WITHOUT committing it.
 */
function fixture({ headDeclared = false, worktreeChanged = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v237-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of [GUARD, INSTRUMENT]) copyFileSync(join(REPO, file), join(root, file))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = (): number => 1\n', 'utf8')
  writeFileSync(join(root, 'index.js'), 'function a() {\n  return 1\n}\n', 'utf8')

  gitIn(root, 'init', '-q')
  gitIn(root, 'add', '-A')
  gitIn(root, 'commit', '-q', '-m', 'base')

  const message = headDeclared ? 'feat: 有意的产物改动\n\n[bundle-change] 新增行为' : 'feat: 未声明'
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = (): number => 2\n', 'utf8')
  writeFileSync(join(root, 'index.js'), 'function a() {\n  return 2\n}\n', 'utf8')
  gitIn(root, 'add', '-A')
  gitIn(root, 'commit', '-q', '-m', message)

  if (worktreeChanged) {
    /** Edited AFTER the commit and left uncommitted: the measured artifact is NOT that commit's. */
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = (): number => 3\n', 'utf8')
    writeFileSync(join(root, 'index.js'), 'function a() {\n  return 3\n}\n', 'utf8')
  }
  return root
}

function runGuard(root, env = {}) {
  const result = spawnSync(process.execPath, [join(root, GUARD)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GRAFT_COMMIT_MESSAGE: '', GITHUB_HEAD_COMMIT_MESSAGE: '', ...env },
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const headSubject = (root) => gitIn(root, 'log', '-1', '--pretty=%s').trim()
const headSha = (root) => gitIn(root, 'log', '-1', '--pretty=%h').trim()

// ── ① 复现漏洞：HEAD 带声明，但工作树另有未声明的改动 ⇒ 必须 exit 1 ────────────────────────────

test('v237 ①: HEAD 带声明、工作树另有未声明改动 ⇒ exit 1（这一条在修之前必须红）', () => {
  const root = fixture({ headDeclared: true, worktreeChanged: true })
  const { code, out } = runGuard(root)
  /**
   * THE ASSERTION THE OLD CODE FAILED. `git log -1` sees `[bundle-change]`, so the old guard waived a
   * change that nobody declared — and then printed that it could not have done that.
   */
  assert.equal(code, 1, `工作树脏 ⇒ 提交信息的声明不适用，必须 exit 1；实测 exit=${code}\n${out.slice(0, 700)}`)
  assert.match(out, /BUNDLE PURITY FAILED/u, '必须报出失败，而不是放行')
  assert.doesNotMatch(out, /DECLARED via \[bundle-change\]/u, '这一句在当前状态下是假的，不许出现')
})

// ── ② 环境变量声明总是算数 ──────────────────────────────────────────────────────────────────

test('v237 ②: 同样的脏工作树，但用环境变量声明 ⇒ exit 0，且输出点名「环境变量」', () => {
  const root = fixture({ headDeclared: false, worktreeChanged: true })
  const { code, out } = runGuard(root, { GRAFT_COMMIT_MESSAGE: 'feat: x\n\n[bundle-change]' })
  assert.equal(code, 0, `环境变量是为这一次运行而设的，必须生效；实测 exit=${code}\n${out.slice(0, 500)}`)
  /** The reader must be told WHICH source granted the waiver — "DECLARED" alone is not enough. */
  assert.match(out, /环境变量|environment/iu, `必须点名声明来自环境变量：${out.slice(0, 600)}`)
})

// ── ③ 工作树干净 + HEAD 带声明 ⇒ 算数，且点名该提交 ──────────────────────────────────────────

test('v237 ③: 工作树干净、HEAD 带声明 ⇒ exit 0，且输出点名该提交的 sha 与标题', () => {
  const root = fixture({ headDeclared: true, worktreeChanged: false })
  const { code, out } = runGuard(root)
  assert.equal(code, 0, `干净工作树下提交信息的声明有效；实测 exit=${code}\n${out.slice(0, 500)}`)
  const subject = headSubject(root)
  const sha = headSha(root)
  assert.ok(out.includes(sha), `必须点名是哪个提交（sha ${sha}）：${out.slice(0, 500)}`)
  assert.ok(out.includes(subject), `必须点名该提交的标题（${subject}）：${out.slice(0, 500)}`)
})

// ── ④ 产物没变 ⇒ 仍是 RESOURCE ──────────────────────────────────────────────────────────────

test('v237 ④: 产物没变 ⇒ 仍是 RESOURCE exit 0（「没得比」不许当成「通过了」，保留 v236 ④）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v237-same-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of [GUARD, INSTRUMENT]) copyFileSync(join(REPO, file), join(root, file))
  writeFileSync(join(root, 'index.js'), 'function a() {\n  return 1\n}\n', 'utf8')
  gitIn(root, 'init', '-q')
  gitIn(root, 'add', '-A')
  gitIn(root, 'commit', '-q', '-m', 'base')
  gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'no artifact change')

  const { code, out } = runGuard(root)
  assert.equal(code, 0, 'RESOURCE 走 exit 0，但必须出声')
  assert.match(out, /RESOURCE/u, '「没检查」必须写出来')
  assert.match(out, /NOT CHECKED/u)
  assert.doesNotMatch(out, /DECLARED/u)
})

/** ① 的判据本身（工作树是否干净）必须只看被测量的路径，不是整个仓库。 */
test('v237 ①b: 「干净」只看被测量路径 —— 无关文件（如临时日志）不算脏', () => {
  const root = fixture({ headDeclared: true, worktreeChanged: false })
  writeFileSync(join(root, 'scratch.log'), 'noise\n', 'utf8')
  const status = spawnSync('git', ['status', '--porcelain', '--', ...MEASURED_PATHS], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal((status.stdout ?? '').trim(), '', '无关文件不许让判据变脏')
  const { code } = runGuard(root)
  assert.equal(code, 0, `证明结论：一个临时日志不该撤销一个已声明的功能提交`)
})