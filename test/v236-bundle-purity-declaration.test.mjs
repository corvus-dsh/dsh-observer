/**
 * ── v236 (B2-T4): 声明式放行本身必须能红、也能绿 ───────────────────────────────────────────────
 *
 * `bundle-purity-guard.mjs` 原来把「产物内容行变了」一律判红。这条规则对**功能提交**是错的：
 * 功能提交改产物是它的**目的**，不是回归。实测（2026-11-18）：
 *
 *   产物与 HEAD~1 逐字节相同 ⇒ VACUOUS → RESOURCE → exit 0   ← 当时 CI 绿的唯一原因
 *   产物因功能改动而不同      ⇒ NOT PURE → exit 1            ← 任何功能提交都会撞上
 *
 * 于是加了一个声明 `[bundle-change]`：作者说「这次改产物是有意的」。**一个放行机制如果自己不能被
 * 测，它就等于把门禁关掉了** —— 所以这个文件同时证明三件事：
 *
 *   ① 未声明 ⇒ 仍然红（门禁没有变成橡皮图章）
 *   ② 声明   ⇒ 绿，**且输出里必须写明这是声明放行**（不许静默通过）
 *   ③ 声明只从提交信息/环境读，不从「看起来像功能」推断（不猜）
 *
 * 手段：用**临时 git 仓库** + 一个最小的产物差异来跑真脚本。不做 mock —— mock 只能证明我以为
 * 它怎么工作，证明不了它真的怎么工作。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const GUARD = 'scripts/bundle-purity-guard.mjs'
const INSTRUMENT = 'scripts/verify-bundle-purity.mjs'

/**
 * Build a throwaway repository whose only content is the two scripts plus an `index.js` that we
 * change between commits. The scripts are COPIED, not imported: they read `index.js` from their own
 * parent directory, so the fixture needs real files in a real git history.
 */
function fixture({ commitMessage }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v236-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of [GUARD, INSTRUMENT]) {
    copyFileSync(join(REPO, file), join(root, file))
  }
  writeFileSync(join(root, 'index.js'), 'function a() {\n  return 1\n}\n', 'utf8')

  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  /** Change the CODE (not the position): one line differs in content. */
  writeFileSync(join(root, 'index.js'), 'function a() {\n  return 2\n}\n', 'utf8')
  git('add', '-A')
  git('commit', '-q', '-m', commitMessage(root))
  return root
}

/** Run the guard in a fixture, returning exit code and combined output. */
function runGuard(root, env = {}) {
  const result = spawnSync(process.execPath, [join(root, GUARD)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GRAFT_COMMIT_MESSAGE: '', GITHUB_HEAD_COMMIT_MESSAGE: '', ...env },
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

test('v236 ①: 未声明的产物改动 ⇒ 仍然 exit 1（门禁没有被放行机制变成橡皮图章）', () => {
  const root = fixture({ commitMessage: () => 'feat: 改了产物但没声明' })
  const { code, out } = runGuard(root)
  assert.equal(code, 1, `未声明必须仍然红，实测 exit=${code}\n${out.slice(0, 500)}`)
  assert.match(out, /BUNDLE PURITY FAILED/u)
  /** And the failure must TEACH the exit, or the next author has no move. */
  assert.match(out, /\[bundle-change\]/u, '失败信息必须告诉读者怎么声明')
})

test('v236 ②: 提交信息里声明 [bundle-change] ⇒ exit 0，且输出写明这是声明放行', () => {
  const root = fixture({ commitMessage: () => 'feat: 改了产物\n\n[bundle-change] 新增一个触发器，产物随之改变' })
  const { code, out } = runGuard(root)
  assert.equal(code, 0, `声明后必须绿，实测 exit=${code}\n${out.slice(0, 500)}`)
  /**
   * LOUD, NOT SILENT. A waived check that prints nothing is indistinguishable from a check that
   * passed, and the next reader would conclude the bundle really was pure.
   */
  assert.match(out, /BUNDLE CHANGED — DECLARED via \[bundle-change\]/u)
  assert.match(out, /not a pure move/u, '必须承认仪器说得对：这确实不是纯搬运')
})

test('v236 ③: 环境变量里的声明同样生效（CI 拿不到本地提交信息）', () => {
  /**
   * CI checks out with no author message in reach, so the workflow passes it in an env var. If only
   * the commit message were read, every CI run of a declared feature would be red — the gate would be
   * green locally and red in CI, which is the worst of both.
   */
  const root = fixture({ commitMessage: () => 'feat: 改了产物但没在信息里声明' })
  const { code, out } = runGuard(root, { GRAFT_COMMIT_MESSAGE: 'feat: x\n\n[bundle-change]' })
  assert.equal(code, 0, `环境变量声明必须生效，实测 exit=${code}\n${out.slice(0, 400)}`)
  assert.match(out, /DECLARED/u)
})

test('v236 ④: 产物没变时依然是 RESOURCE（不许把「没得比」当成「通过了」）', () => {
  /**
   * The pre-existing behaviour, pinned so the new declaration branch cannot have swallowed it. A
   * purity check with nothing to compare must SAY it did not run — the house rule is that a missing
   * resource is a skip, not a pass.
   */
  const root = mkdtempSync(join(tmpdir(), 'dsh-v236-same-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of [GUARD, INSTRUMENT]) copyFileSync(join(REPO, file), join(root, file))
  writeFileSync(join(root, 'index.js'), 'function a() {\n  return 1\n}\n', 'utf8')
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('commit', '-q', '--allow-empty', '-m', 'no artifact change')

  const { code, out } = runGuard(root)
  assert.equal(code, 0, 'RESOURCE 走 exit 0，但必须出声')
  assert.match(out, /RESOURCE/u, '「没检查」必须写出来，不许当成「通过」')
  assert.match(out, /NOT CHECKED/u)
  /** And it must NOT claim the bundle was pure. */
  assert.doesNotMatch(out, /BUNDLE CHANGED — DECLARED/u)
})