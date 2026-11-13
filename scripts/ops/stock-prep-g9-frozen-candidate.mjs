#!/usr/bin/env node
// Batch-refresh step 6 S6-9a (register rows R-91; 批次标识 R-65) — THE G9 FROZEN-CANDIDATE RUNNER (step-6 design §9.5).
//
// S6-9 flipped CONTINUATION_SUPPORT_VERSION 0 -> 1 and re-pinned the tests pinned to 0. Its acceptance is the G9 matrix run on
// a FROZEN candidate: one sha, tagged, with the full CI dispatched on the TAG (the repo's ci-on-fixed-commit-via-tag
// pattern: a run on refs/tags/<tag> is not cancelled by later pushes to main, and tests exactly the tagged commit). The
// real-DB half of the matrix is the cases module packages/core-backend/tests/integration/stock-preparation-g9-acceptance-
// realdb.cases.ts, which prints one `[G9] <id> ok <json>` line per passed case; the ids are
// packages/core-backend/tests/integration/stock-preparation-g9-matrix.json's `realDb` list.
//
// MODES (no mode writes anything unless named so; this script reads NO environment variable — git and gh use the
// caller's own authentication, which this script never sees, prints or stores):
//   --plan --sha <sha> [--tag <name>]       print the exact freeze + dispatch commands, run nothing (the default mode)
//   --dispatch --sha <sha> [--tag <name>]   WRITES: create the annotated tag at <sha>, push it, dispatch plugin-tests.yml
//                                           and stock-prep-powershell51.yml on refs/tags/<tag>. Owner/coordinator only.
//                                           When refs/tags/<tag> ALREADY exists (a release tag cut from the frozen
//                                           commit, S6-9) it is never re-created or moved: it must resolve to <sha> here
//                                           AND on origin (else a refusal before anything is written), and only the two
//                                           dispatches run. A NEW tag whose name deploy.yml's push filter v*.*.*
//                                           matches is refused before anything is planned (a push would deploy).
//   --collect --tag <name> [--out <dir>]    read the tag's runs (gh run list --branch <tag>); when plugin-tests.yml is
//                                           complete, save its whole log and evaluate it as --parse-log does, expecting
//                                           the TAG'S OWN COMMIT (`git rev-parse <tag>^{commit}`, never a run's headSha)
//   --parse-log <file> --expect-sha <sha>   evaluate a saved log: every realDb id needs one `[G9] <id> ok` line, no vitest
//                                           FAIL line may name a G9 case or ANY test under the matrix's `describe` (the
//                                           census test, a hook), the matrix's `hostFile` (the p4 host) must not report a
//                                           failed test, no vitest summary may count a failure (R-3), and THE TESTED
//                                           COMMIT must be <sha> (40-hex,
//                                           mandatory for a PASS): every job checkout's `git log -1 --format=%H` answer
//                                           (actions/checkout prints it) — at least one, all equal to <sha>. A sha merely
//                                           MENTIONED in the log (a merge subject, a branch name) never counts: a
//                                           pull_request run tests the merge commit, not the head it names.
//   --old-build-drill --sha <sha>           print the U07 old-build half (design §7.5): a pre-step-6 build against a
//                                           database migrated by the candidate and carrying the G9-U07 artifacts
//   --self-test                             the parser against synthetic logs (green, missing id, red case, caret ANSI)
//
// OWNER-GATED ITEMS: every verdict (PASS or not) prints the matrix's `manual` entries marked `ownerGated` with their
// sentence - today G9-U03-LEGACY-TENANTLESS-ADMIN, a PRE-EXISTING product path G9-U03 pins and never certifies (ruled
// 2026-11-11, option A: the tenant-claim flag is a pilot-enable precondition, pilot readiness v6) - so no G9 PASS hides them.
//
// WHY BOTH WORKFLOWS: since #6187 the required `stock-prep PowerShell 5.1 acceptance` context comes from
// stock-prep-powershell51.yml, not plugin-tests.yml. Both carry workflow_dispatch, so no workflow file is edited here.
// The required contexts that run ONLY on pull requests never run on a tag: they come from the S6-9 PR at the SAME sha
// (the matrix file's manual item PR-ONLY-CONTEXTS), and this runner says so in every verdict.
//
// Values-free: ids, shas, run ids and closed words only. Usage example (coordinator, at S6-9):
//   node scripts/ops/stock-prep-g9-frozen-candidate.mjs --plan --sha <40-hex>
//   node scripts/ops/stock-prep-g9-frozen-candidate.mjs --dispatch --sha <40-hex>
//   node scripts/ops/stock-prep-g9-frozen-candidate.mjs --collect --tag s6-9-g9-<sha12>

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
export const MATRIX_PATH = join(REPO_ROOT, 'packages/core-backend/tests/integration/stock-preparation-g9-matrix.json')
export const WORKFLOWS = Object.freeze(['plugin-tests.yml', 'stock-prep-powershell51.yml'])
const MIGRATION_106 = 'packages/core-backend/migrations/106_extend_integration_stock_prep_refresh_execution_for_recovery.sql'
const MIGRATION_108 = 'packages/core-backend/migrations/108_create_integration_stock_prep_sheet_repair.sql'
const SHA_PATTERN = /^[0-9a-f]{40}$/
// .github/workflows/deploy.yml runs "Deploy to Production" on `push: tags: 'v*.*.*'` (a GitHub filter `*` matches any
// character but `/`). The runner never creates or pushes a tag this matches.
const DEPLOY_TAG_PATTERN = /^v[^/]*\.[^/]*\.[^/]*$/

/**
 * The repair ledger's rollback stop-condition query, parsed out of a migration 108 text (its header's ROLLBACK paragraph:
 * the comment line right after "Before rolling back, no run may be open:"), without its `;`. Throws when the header no
 * longer carries it in that shape — the drill never prints a copied query. Pure.
 */
export function repairStopQueryOf(migrationText) {
  const lines = String(migrationText).replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex((line) => /^--\s+.*Before rolling back, no run may be open:\s*$/.test(line))
  const query = at >= 0 && at + 1 < lines.length ? /^--\s+(SELECT count\(\*\) FROM integration_stock_prep_sheet_repair_run WHERE status = 'running');\s*$/.exec(lines[at + 1]) : null
  if (!query) throw new Error('migration 108 header: the rollback stop-condition query is not where the drill reads it')
  return query[1]
}

export function loadMatrix(path = MATRIX_PATH) {
  const matrix = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(matrix.realDb) || matrix.realDb.length === 0) throw new Error('matrix has no realDb ids')
  return matrix
}

export function defaultTag(sha) {
  return `s6-9-g9-${sha.slice(0, 12)}`
}

// Both colour-code forms: ESC bytes, and the caret text `gh run view --log` can carry (`^[[31m`).
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`(?:${ESC}|\\^\\[)\\[[0-9;]*[A-Za-z]`, 'g')
export function stripAnsi(text) {
  return String(text).replace(ANSI, '')
}

// actions/checkout prints `[command]/usr/bin/git log -1 --format=%H` and, on the next line, the commit it checked out.
// Both saved-log forms carry a prefix: the job-log API's `<timestamp> `, `gh run view --log`'s `<job>\t<step>\t<timestamp> `.
const TESTED_COMMAND = /\[command\]\S*git log -1 --format=%H\s*$/
const TESTED_ANSWER = /^(?:[^\t]*\t[^\t]*\t)?(?:\d{4}-\d\d-\d\dT[0-9:.]+Z )?([0-9a-f]{40})$/

/** Every job checkout's tested commit, in log order (one per `git log -1 --format=%H` the log carries; null = unreadable). */
export function testedCommitsOf(log) {
  const lines = stripAnsi(log).split('\n').map((line) => line.replace(/\r$/, ''))
  const commits = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!TESTED_COMMAND.test(lines[index])) continue
    const answer = index + 1 < lines.length ? TESTED_ANSWER.exec(lines[index + 1].trim()) : null
    commits.push(answer ? answer[1] : null)
  }
  return commits
}

/**
 * The vitest failure signals of one log (R-3): a FAIL line under the matrix's describe (any test of the G9 block - the
 * census, a hook - not only the id-named cases), a FAIL line or a per-file result line of the host file counting a
 * failure, and any `Tests` / `Test Files` summary counting one. Both reporters' forms (default `> file (N tests | k
 * failed)`, the summary's `FAIL  file > ...`), either log prefix, ESC or caret ANSI.
 */
export function failureSignalsOf(log, matrix) {
  const describe = typeof matrix.describe === 'string' && matrix.describe ? matrix.describe : null
  const hostFile = typeof matrix.hostFile === 'string' && matrix.hostFile ? matrix.hostFile : null
  const g9Fails = []
  const hostFails = []
  const summaries = []
  for (const raw of stripAnsi(log).split('\n')) {
    const line = raw.replace(/\r$/, '')
    const isFail = /\bFAIL\s+\S/.test(line)
    if (isFail && describe && line.includes(`> ${describe}`)) g9Fails.push(line.trim().slice(0, 200))
    if (hostFile && line.includes(hostFile)) {
      const counted = /\((\d+) tests?[^)]*?\|\s*(\d+) failed/.exec(line)
      if (isFail || (counted && Number(counted[2]) > 0)) hostFails.push(line.trim().slice(0, 200))
    }
    const summary = /\b(Test Files|Tests)\s+(\d+) failed\b/.exec(line)
    if (summary && Number(summary[2]) > 0) summaries.push(`${summary[1]} ${summary[2]} failed`)
  }
  return { g9Fails: [...new Set(g9Fails)], hostFails: [...new Set(hostFails)], summaries: [...new Set(summaries)] }
}

/** The matrix's owner-gated manual items, as printed in every verdict. */
export function ownerGatedOf(matrix) {
  return (matrix.manual || []).filter((entry) => entry && entry.ownerGated === true).map((entry) => `${entry.id}: ${entry.what}`)
}

/**
 * Evaluate one CI log against the matrix. `ok` only when every realDb id printed exactly one ok line, no vitest FAIL
 * line names a G9 case, no test under the G9 describe failed, the host file reports no failed test and no vitest
 * summary counts a failure (failureSignalsOf), `expectSha` is a 40-hex sha, and the log's tested commits
 * (testedCommitsOf) are at least one and ALL equal to it. Pure; values-free answer.
 */
export function evaluateLog(rawLog, matrix, { expectSha = null } = {}) {
  const log = stripAnsi(rawLog)
  const seen = new Map()
  for (const match of log.matchAll(/\[G9\] (\S+) ok /g)) seen.set(match[1], (seen.get(match[1]) || 0) + 1)
  const missing = matrix.realDb.filter((id) => !seen.has(id))
  const duplicated = matrix.realDb.filter((id) => (seen.get(id) || 0) > 1)
  const unknown = [...seen.keys()].filter((id) => !matrix.realDb.includes(id))
  const failedCases = []
  for (const line of log.split('\n')) {
    if (!/\bFAIL\s+tests\//.test(line)) continue
    // A case names its id as `> <id> ` — or `+ <id> ` for an extension id riding another case (`G9-U03 + G9-S65-U03`).
    for (const id of matrix.realDb) if (line.includes(`> ${id} `) || line.includes(`+ ${id} `)) failedCases.push(id)
  }
  const signals = failureSignalsOf(log, matrix)
  const tested = testedCommitsOf(log)
  let shaVerdict
  if (typeof expectSha !== 'string' || !SHA_PATTERN.test(expectSha)) shaVerdict = 'expect_sha_missing_or_not_40_hex'
  else if (tested.length === 0) shaVerdict = 'no_tested_commit_in_log'
  else if (tested.some((commit) => commit !== expectSha)) shaVerdict = 'tested_commit_differs'
  else shaVerdict = 'tested_commit_matches'
  const testsFailed = signals.g9Fails.length > 0 || signals.hostFails.length > 0 || signals.summaries.length > 0
  const ok = missing.length === 0 && duplicated.length === 0 && failedCases.length === 0 && !testsFailed && shaVerdict === 'tested_commit_matches'
  return {
    ok,
    expectSha: typeof expectSha === 'string' ? expectSha : null,
    shaVerdict,
    testedCommits: [...new Set(tested.map((commit) => commit || 'unreadable'))],
    checkouts: tested.length,
    passed: matrix.realDb.filter((id) => seen.get(id) === 1),
    missing,
    duplicated,
    unknown,
    failedCases: [...new Set(failedCases)],
    g9DescribeFailures: signals.g9Fails,
    hostFileFailures: signals.hostFails,
    failedSummaries: signals.summaries,
    pending: matrix.pending.map((entry) => `${entry.id} (${entry.owner})`),
    manual: matrix.manual.map((entry) => entry.id),
    ownerGated: ownerGatedOf(matrix),
  }
}

function run(cmd, args, { allowFail = false } = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 })
  if (result.status !== 0 && !allowFail) throw new Error(`${cmd} ${args[0]} exited ${result.status}: ${(result.stderr || '').trim().split('\n').slice(-1)[0]}`)
  return result
}

/**
 * The freeze + dispatch commands for <sha> on <tag>. `existingTagCommit` is what refs/tags/<tag> resolves to here (null
 * when the tag does not exist). A NEW tag is created at <sha> and pushed; an EXISTING tag (a release tag cut from the
 * frozen commit, S6-9) is never re-created or moved: it must already resolve to <sha> (else a refusal), and only the two
 * workflow dispatches are planned (the tag must be on the remote already: `git ls-remote --tags origin <tag>`). Pure.
 */
export function planCommands(sha, tag, existingTagCommit = null) {
  if (!SHA_PATTERN.test(String(sha))) throw new Error('planCommands needs a 40-hex sha')
  if (existingTagCommit !== null && existingTagCommit !== sha) {
    throw new Error(`refs/tags/${tag} already exists and resolves to ${existingTagCommit}, not ${sha}: refusing to move or reuse it`)
  }
  const dispatch = WORKFLOWS.map((workflow) => ['gh', ['workflow', 'run', workflow, '--ref', `refs/tags/${tag}`]])
  if (existingTagCommit === sha) return dispatch
  // A NEW tag is created AND PUSHED: a name deploy.yml's `push: tags: v*.*.*` matches would fire "Deploy to
  // Production" on that push. Refused here, before any command is planned (the dispatch-only path pushes nothing).
  if (DEPLOY_TAG_PATTERN.test(String(tag))) {
    throw new Error(`refs/tags/${tag} would match deploy.yml's push tag filter v*.*.* (a production deploy on push): refusing to create or push it; use the default s6-9-g9-<sha12> or another name`)
  }
  return [
    ['git', ['tag', '-a', tag, sha, '-m', `S6-9 G9 frozen candidate ${sha.slice(0, 12)} (R-91)`]],
    ['git', ['push', 'origin', `refs/tags/${tag}`]],
    ...dispatch,
  ]
}

/**
 * The commit refs/tags/<tag> resolves to on the REMOTE, from a `git ls-remote --tags origin refs/tags/<tag>
 * refs/tags/<tag>^{}` answer: an annotated tag's peeled `^{}` line, else a lightweight tag's own line; null when the
 * answer names no such ref. The ref field must equal the name exactly. Pure.
 */
export function remoteTagCommitOf(lsRemoteOutput, tag) {
  const entries = String(lsRemoteOutput).replace(/\r\n/g, '\n').split('\n').map((line) => line.trim().split('\t')).filter((parts) => parts.length === 2)
  const peeled = entries.find(([, ref]) => ref === `refs/tags/${tag}^{}`)
  const plain = entries.find(([, ref]) => ref === `refs/tags/${tag}`)
  const commit = (peeled || plain || [null])[0]
  return commit && SHA_PATTERN.test(commit) ? commit : null
}

/** --dispatch on an EXISTING tag: refuse (throw) unless origin has the tag at <sha>. Pure. */
export function assertRemoteTagAt(lsRemoteOutput, tag, sha) {
  const remote = remoteTagCommitOf(lsRemoteOutput, tag)
  if (remote !== sha) throw new Error(`refs/tags/${tag} on origin resolves to ${remote || 'nothing'}, not ${sha}: push the tag (or fix --sha) first`)
  return remote
}

/** What refs/tags/<tag> resolves to in this checkout (its commit), or null when no such tag exists here. */
function existingTagCommitOf(tag) {
  const resolved = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { allowFail: true })
  const commit = resolved.status === 0 ? resolved.stdout.trim() : ''
  return SHA_PATTERN.test(commit) ? commit : null
}

function printVerdict(verdict) {
  console.log(JSON.stringify(verdict, null, 2))
  console.log(`tested commit(s): ${verdict.testedCommits.join(', ') || 'none found'} (expected ${verdict.expectSha || 'none given'}: ${verdict.shaVerdict})`)
  if (verdict.g9DescribeFailures.length || verdict.hostFileFailures.length || verdict.failedSummaries.length) {
    console.log(`failed tests in the log: ${verdict.g9DescribeFailures.length} under the G9 describe, ${verdict.hostFileFailures.length} host-file line(s), summaries: ${verdict.failedSummaries.join('; ') || 'none'}`)
  }
  console.log(verdict.ok
    ? 'G9 real-DB half: PASS on this log. Still required: the PR-only contexts from the S6-9 PR at the same sha, the pending ids above, the manual items and the OWNER-GATED items below.'
    : 'G9 real-DB half: NOT PASSED on this log.')
  // Every verdict, PASS or not: the owner-gated items no G9 PASS covers.
  for (const item of verdict.ownerGated) console.log(`OWNER-GATED (not covered by this verdict): ${item}`)
}

function selfTest() {
  const owner = 'tenantless platform admin can preview and apply into a named tenant while the tenant-claim flag is off — ruled 2026-11-11: option A — the flag is a pilot-enable precondition; the legacy path stays for non-pilot use while the flag is off'
  const matrix = {
    realDb: ['S3A-02', 'G9-U08'],
    pending: [{ id: 'G9-S65-V5', owner: 'S6-5' }],
    manual: [{ id: 'U09' }, { id: 'G9-U03-LEGACY-TENANTLESS-ADMIN', ownerGated: true, what: owner }],
    describe: 'G9 frozen-candidate acceptance',
    hostFile: 'stock-preparation-p4-repair-once-realdb.test.ts',
  }
  const sha = 'a'.repeat(40)
  const base = 'b'.repeat(40)
  const merge = 'c'.repeat(40)
  const stamp = '2026-11-10T05:32:45.8992399Z'
  // The job-log API form, and the `gh run view --log` form (job / step / timestamp, CRLF) of one checkout.
  const checkout = (commit) => `${stamp} [command]/usr/bin/git log -1 --format=%H\n${stamp} ${commit}\n`
  const ghCheckout = (job, commit) => `${job}\tCheckout repository\t${stamp} [command]/usr/bin/git log -1 --format=%H\r\n${job}\tCheckout repository\t${stamp} ${commit}\r\n`
  const cases = '[G9] S3A-02 ok {}\n[G9] G9-U08 ok {"a":1}\n Tests 2 passed'
  const green = `${checkout(sha)}${cases}`
  // A pull_request run: the checkout tested the MERGE commit; the head and the base appear only in its subject.
  const prRun = `${stamp} HEAD is now at ${merge.slice(0, 7)} Merge ${sha} into ${base}\n${checkout(merge)}${cases}`
  const caret = `${checkout(sha)}^[[32m[G9] S3A-02 ok {}^[[39m\n[G9] G9-U08 ok {}\n^[[31m FAIL  tests/integration/x.test.ts > a > G9-U08 (U08) the run^[[39m`
  const twoJobs = `${ghCheckout('db (20.x)', sha)}${ghCheckout('unit (20.x)', sha)}${cases}`
  const mixedJobs = `${ghCheckout('db (20.x)', sha)}${ghCheckout('unit (20.x)', merge)}${cases}`
  const unreadable = `${stamp} [command]/usr/bin/git log -1 --format=%H\n${stamp} not-a-sha\n${cases}`
  const verdictOf = (log, expectSha) => evaluateLog(log, matrix, { expectSha })
  // R-3: every ok line printed, yet a test under the G9 describe (the census, a hook) failed, or the host file / a vitest
  // summary counts a failure outside G9.
  const host = 'tests/integration/stock-preparation-p4-repair-once-realdb.test.ts'
  const g9Path = `${host} > stock-prep project write lock > S3A step-4 lanes > G9 frozen-candidate acceptance (S6-9a, R-91 / R-65): the matrix`
  const censusRed = `${green}\n FAIL  ${g9Path} > G9 census: every real-DB id of the matrix has exactly one case`
  const hookRed = `${green}\n^[[31m FAIL ^[[39m ${g9Path} > (afterAll hook)`
  const hostRed = `${green}\n ❯ ${host}  (210 tests | 1 failed | 3 skipped) 109220ms\n FAIL  ${host} > stock-prep project write lock > S8-08 the gate on the real stack`
  const hostSummaryRed = `${green}\n Test Files  1 failed (1)\n      Tests  1 failed | 206 passed | 3 todo (210)`
  const dotGreen = `${green}\n ✓ ${host}  (210 tests | 3 skipped) 109220ms\n Test Files  269 passed (269)\n      Tests  3541 passed | 2 skipped | 3 todo (3546)`
  const checks = [
    ['green (the tested commit is the expected one)', verdictOf(green, sha).ok === true && verdictOf(green, sha).testedCommits.join() === sha],
    ['missing id', verdictOf(`${checkout(sha)}[G9] S3A-02 ok {}`, sha).missing.join() === 'G9-U08'],
    ['duplicate id', verdictOf(`${green}\n[G9] S3A-02 ok {}`, sha).duplicated.join() === 'S3A-02'],
    ['red case through caret ANSI', verdictOf(caret, sha).failedCases.join() === 'G9-U08' && verdictOf(caret, sha).ok === false],
    ['wrong sha', verdictOf(green, base).ok === false && verdictOf(green, base).shaVerdict === 'tested_commit_differs'],
    ['no --expect-sha is never a pass', verdictOf(green, null).ok === false && verdictOf(green, null).shaVerdict === 'expect_sha_missing_or_not_40_hex'],
    ['short sha refused', verdictOf(green, sha.slice(0, 12)).ok === false && verdictOf(green, 'a').ok === false],
    ['head named only in a merge subject', verdictOf(prRun, sha).ok === false && verdictOf(prRun, sha).testedCommits.join() === merge],
    ['base named only in a merge subject', verdictOf(prRun, base).ok === false],
    ['the merge commit the run did test', verdictOf(prRun, merge).ok === true],
    ['sha named, no checkout line', verdictOf(`sha ${sha}\n${cases}`, sha).shaVerdict === 'no_tested_commit_in_log' && verdictOf(`sha ${sha}\n${cases}`, sha).ok === false],
    ['gh run view form, every job tested it', verdictOf(twoJobs, sha).ok === true && verdictOf(twoJobs, sha).checkouts === 2],
    ['one job tested another commit', verdictOf(mixedJobs, sha).ok === false],
    ['checkout answer unreadable', verdictOf(unreadable, sha).ok === false && verdictOf(unreadable, sha).testedCommits.join() === 'unreadable'],
    ['R-3: a failed test under the G9 describe (the census) refuses, every ok line notwithstanding', verdictOf(censusRed, sha).ok === false && verdictOf(censusRed, sha).g9DescribeFailures.length === 1 && verdictOf(censusRed, sha).missing.length === 0],
    ['R-3: a failed G9 hook through caret ANSI refuses', verdictOf(hookRed, sha).ok === false && verdictOf(hookRed, sha).g9DescribeFailures.length === 1],
    ['R-3: the host file counting a failed test outside G9 refuses', verdictOf(hostRed, sha).ok === false && verdictOf(hostRed, sha).hostFileFailures.length === 2 && verdictOf(hostRed, sha).failedCases.length === 0],
    ['R-3: a "Tests N failed" summary refuses', verdictOf(hostSummaryRed, sha).ok === false && verdictOf(hostSummaryRed, sha).failedSummaries.join() === 'Test Files 1 failed,Tests 1 failed'],
    ['R-3: a green host line and a green summary still pass', verdictOf(dotGreen, sha).ok === true && verdictOf(dotGreen, sha).hostFileFailures.length === 0 && verdictOf(dotGreen, sha).failedSummaries.length === 0],
    ['owner-gated item listed on a PASS and on a refusal', verdictOf(green, sha).ownerGated.join() === `G9-U03-LEGACY-TENANTLESS-ADMIN: ${owner}` && verdictOf(censusRed, sha).ownerGated.length === 1],
    ['a red case carrying a riding id flags both', evaluateLog(`${checkout(sha)}[G9] S3A-02 ok {}\n FAIL  tests/integration/x.test.ts > a > S3A-02 + G9-U08 (U08) the run`, matrix, { expectSha: sha }).failedCases.join() === 'S3A-02,G9-U08'],
    // S6-9: a frozen candidate may already carry a release tag. A NEW tag is created and pushed; an EXISTING tag at the
    // same commit is dispatched only; an existing tag at ANOTHER commit is refused (never moved, never reused).
    ['new tag: tag, push, then both dispatches', (() => {
      const plan = planCommands(sha, 's6-9-g9-x')
      return plan.length === 4 && plan[0][1][0] === 'tag' && plan[1][1][0] === 'push' && plan.slice(2).every(([cmd, args]) => cmd === 'gh' && args.includes('refs/tags/s6-9-g9-x'))
    })()],
    ['existing tag at the sha: the two dispatches only', (() => {
      const plan = planCommands(sha, 'r-main-1', sha)
      return plan.length === 2 && plan.every(([cmd, args]) => cmd === 'gh' && args[0] === 'workflow' && args.includes('refs/tags/r-main-1'))
    })()],
    ['existing tag at another commit: refused', (() => {
      try { planCommands(sha, 'r-main-1', base); return false } catch (error) { return /refusing to move or reuse it/.test(error.message) }
    })()],
    // Review of #6887 (must-fix): a NEW tag the runner would create and push may not match deploy.yml's v*.*.* filter.
    ['a new v*.*.* tag is refused (v1.2.3)', (() => {
      try { planCommands(sha, 'v1.2.3'); return false } catch (error) { return /deploy\.yml/.test(error.message) }
    })()],
    ['a new v*.*.* tag is refused (v2.5.0-onprem-x)', (() => {
      try { planCommands(sha, 'v2.5.0-onprem-x'); return false } catch (error) { return /deploy\.yml/.test(error.message) }
    })()],
    ['a new non-deploy tag still plans tag + push (s6-9-g9-x, onprem-r85)', planCommands(sha, 's6-9-g9-x').length === 4 && planCommands(sha, 'onprem-r85').length === 4],
    ['an EXISTING v*.*.* tag at the sha: dispatch only, nothing pushed', (() => {
      const plan = planCommands(sha, 'v9.9.9', sha)
      return plan.length === 2 && plan.every(([cmd]) => cmd === 'gh')
    })()],
    // --dispatch on an existing tag: origin must have it at the sha (the annotated tag's peeled line wins).
    ['remote tag check: annotated at the sha passes, its tag-object line is not the commit', (() => {
      const tagObject = 'd'.repeat(40)
      const answer = `${tagObject}\trefs/tags/r-main-1\n${sha}\trefs/tags/r-main-1^{}\n`
      return assertRemoteTagAt(answer, 'r-main-1', sha) === sha && remoteTagCommitOf(answer, 'r-main-1') === sha
    })()],
    ['remote tag check: lightweight at the sha passes (CRLF answer)', assertRemoteTagAt(`${sha}\trefs/tags/r-main-1\r\n`, 'r-main-1', sha) === sha],
    ['remote tag check: annotated at another commit refused', (() => {
      try { assertRemoteTagAt(`${sha}\trefs/tags/r-main-1\n${base}\trefs/tags/r-main-1^{}\n`, 'r-main-1', sha); return false } catch (error) { return /not a{40}/.test(error.message) }
    })()],
    ['remote tag check: absent, or only a longer name ending the same, refused', (() => {
      let absent = false
      let suffix = false
      try { assertRemoteTagAt('', 'r-main-1', sha) } catch { absent = true }
      try { assertRemoteTagAt(`${sha}\trefs/tags/x-r-main-1\n`, 'r-main-1', sha) } catch { suffix = true }
      return absent && suffix
    })()],
    ['the 108 stop query is parsed from the header, never copied', (() => {
      const header = '-- ROLLBACK. the two tables then stay, inert. Before rolling back, no run may be open:\r\n--   SELECT count(*) FROM integration_stock_prep_sheet_repair_run WHERE status = \'running\';\r\n-- must answer 0.'
      let refused = false
      try { repairStopQueryOf(header.replace('Before rolling back', 'Before rollback')) } catch { refused = true }
      return repairStopQueryOf(header) === 'SELECT count(*) FROM integration_stock_prep_sheet_repair_run WHERE status = \'running\'' && refused
    })()],
  ]
  for (const [name, passed] of checks) console.log(`${passed ? 'ok' : 'NOT OK'} ${name}`)
  return checks.every(([, passed]) => passed)
}

function argValue(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) return selfTest() ? 0 : 1
  const matrix = loadMatrix()
  const sha = argValue(argv, '--sha')
  if (argv.includes('--parse-log')) {
    const expectSha = argValue(argv, '--expect-sha')
    if (!expectSha || !SHA_PATTERN.test(expectSha)) throw new Error('--parse-log needs --expect-sha <40-hex>: the commit the log must have TESTED')
    const verdict = evaluateLog(readFileSync(argValue(argv, '--parse-log'), 'utf8'), matrix, { expectSha })
    printVerdict(verdict)
    return verdict.ok ? 0 : 1
  }
  if (argv.includes('--old-build-drill')) {
    if (!sha || !SHA_PATTERN.test(sha)) throw new Error('--old-build-drill needs --sha <40-hex>')
    const added = run('git', ['log', '--diff-filter=A', '--format=%H', sha, '--', MIGRATION_106]).stdout.trim().split('\n').filter(Boolean).pop()
    const stop108 = repairStopQueryOf(run('git', ['show', `${sha}:${MIGRATION_108}`]).stdout)
    console.log([
      'U07 old-build half (design §7.5 + B-22) — a dev database only, never a customer host:',
      `  1. candidate tree: git -c core.autocrlf=false archive ${sha}   (LF; check blob sha256)`,
      `  2. old tree:       git -c core.autocrlf=false archive ${added}^   (the parent of migration 106's first commit)`,
      '  3. a throwaway database: migrate it with the CANDIDATE tree, then make these artifacts through the candidate\'s real',
      '     routes (the G9-U07 / G9-S66-U07 recipes, stopped before settling; one project each unless named):',
      '       - an unfinished execution (103);',
      '       - a landed close not yet settled (106);',
      '       - B-22: a transparent close over an unsettled succeeded subject, on a project settled earlier (106);',
      '       - a change plan left confirmed (104), and a recovery-written plan (104);',
      '       - an open hold (103; a trial on a written plan before its review opens one);',
      '       - a claim_active continuation (102; a confirmed continuation candidate), plus a copy applied and settled;',
      '       - a repair retire on a doubled sheet, pilot off, whose finish never ran: its run row left `running` (108);',
      '       - optional: an active remnant acknowledgement (107, informational only).',
      '  4. run the stop-condition queries (the 106 header query, parsed from the candidate\'s migration 106; the 102-104',
      '     ones; the 107 one, informational; and the 108 header query, parsed from the candidate\'s migration 108):',
      `       ${stop108};`,
      '     With step 3\'s artifacts every blocking query (102, 103 x2, 104, 106, 108) is expected to read non-zero (102',
      '     non-zero not yet witnessed on a dev rehearsal). While any of them is',
      '     non-zero the rollback is REFUSED. That is the operator stop rule (design §7.5): no build refuses for it. Clear',
      '     first (runbook §7.2; the 108 run through the owner-approved verify_and_close_run, runbook §6.5), then re-run (0).',
      '  5. U07-OLD-BUILD criterion (restated 2026-11-13, register R-91: the old build is NOT expected to refuse writes).',
      '     With the artifacts present, start the OLD tree on one clone of that database with RunMigrations 0 and the',
      '     candidate on its twin clone. Per artifact project, BEFORE any preview or apply: read the derived state and the',
      '     export code and reason; then preview, and apply where a token is minted. Expected:',
      '       - export is refused on every artifact project left unsettled (the 103, 104 and 106 ones) in both builds (the',
      '         reasons may differ);',
      '       - on the B-22 project the old build passes C1 and is refused at C2 (SHEET_CHANGED_SINCE_SETTLEMENT; read from',
      '         code, not yet witnessed). This is the hazard. The stop rule contains it (every blocking query 0 before a',
      '         rollback), with C2 as the backstop;',
      '       - the old build writes no row the candidate would not: its rows are content-equal apart from the RUN timestamp;',
      '       - on the continuation project the continued rows are untouched: 0 INACTIVE, no copy. Its copy is settled, so its',
      '         export is expected to answer 200 in both builds (not yet witnessed);',
      '       - the non-governed repair project exports 200 in both builds (migration 108 header: no export reads it).',
      '     Then clear through the CANDIDATE\'s routes until every blocking query reads 0, and re-run the OLD tree. It must',
      '     answer as the candidate does: 0 ADD and 0 INACTIVE on an unchanged source, and export 200 on settled projects.',
      '  6. evidence values-free (counts and codes); DROP the databases.',
    ].join('\n'))
    return 0
  }
  if (argv.includes('--collect')) {
    const tag = argValue(argv, '--tag')
    if (!tag) throw new Error('--collect needs --tag <name>')
    // The TAG's commit is the one the dispatch must have tested; a run's own headSha is not evidence of that.
    const resolved = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { allowFail: true })
    const tagSha = resolved.status === 0 ? resolved.stdout.trim() : ''
    if (!SHA_PATTERN.test(tagSha)) throw new Error(`--collect: refs/tags/${tag} does not resolve to a commit here (fetch the tag first)`)
    const runs = WORKFLOWS.map((workflow) => {
      const listed = JSON.parse(run('gh', ['run', 'list', '--workflow', workflow, '--branch', tag, '--limit', '1', '--json', 'databaseId,status,conclusion,headSha']).stdout || '[]')
      return { workflow, run: listed[0] || null }
    })
    console.log(JSON.stringify(runs, null, 2))
    const plugin = runs[0].run
    if (!plugin || plugin.status !== 'completed') {
      console.log('plugin-tests.yml has not completed on this tag yet.')
      return 2
    }
    const out = argValue(argv, '--out') || join(REPO_ROOT, 'artifacts', 'g9')
    mkdirSync(out, { recursive: true })
    const file = join(out, `plugin-tests-${plugin.databaseId}.log`)
    writeFileSync(file, run('gh', ['run', 'view', String(plugin.databaseId), '--log']).stdout)
    const verdict = evaluateLog(readFileSync(file, 'utf8'), matrix, { expectSha: tagSha })
    verdict.workflows = runs.map((entry) => ({ workflow: entry.workflow, conclusion: entry.run ? entry.run.conclusion : null, sha: entry.run ? entry.run.headSha : null }))
    verdict.ok = verdict.ok && runs.every((entry) => entry.run && entry.run.conclusion === 'success' && entry.run.headSha === tagSha)
    printVerdict(verdict)
    return verdict.ok ? 0 : 1
  }
  if (!sha || !SHA_PATTERN.test(sha)) throw new Error('--plan / --dispatch need --sha <40-hex>')
  const tag = argValue(argv, '--tag') || defaultTag(sha)
  const existing = existingTagCommitOf(tag)
  const commands = planCommands(sha, tag, existing)
  if (!argv.includes('--dispatch')) {
    if (existing) console.log(`refs/tags/${tag} exists here at ${existing} (= --sha): no tag is created or pushed; dispatch only`)
    for (const [cmd, args] of commands) console.log([cmd, ...args].join(' '))
    console.log(`then: node scripts/ops/stock-prep-g9-frozen-candidate.mjs --collect --tag ${tag}`)
    return 0
  }
  if (existing) {
    // An existing tag is dispatched on the REMOTE: it must be there, at the same commit (an annotated tag's peeled line).
    assertRemoteTagAt(run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).stdout, tag, sha)
  }
  for (const [cmd, args] of commands) {
    console.log(`> ${[cmd, ...args].join(' ')}`)
    run(cmd, args)
  }
  console.log(`dispatched; collect with --collect --tag ${tag}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`stock-prep-g9-frozen-candidate: ${error && error.message}`)
    process.exitCode = 1
  }
}
