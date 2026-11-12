#!/usr/bin/env node
// Batch-refresh step 6 S6-9a (register rows R-91; 批次标识 R-65) — THE G9 FROZEN-CANDIDATE RUNNER (step-6 design §9.5).
//
// S6-9 flips CONTINUATION_SUPPORT_VERSION 0 -> 1 and re-pins the tests pinned to 0. Its acceptance is the G9 matrix run on
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
const SHA_PATTERN = /^[0-9a-f]{40}$/

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

function planCommands(sha, tag) {
  return [
    ['git', ['tag', '-a', tag, sha, '-m', `S6-9 G9 frozen candidate ${sha.slice(0, 12)} (R-91)`]],
    ['git', ['push', 'origin', `refs/tags/${tag}`]],
    ...WORKFLOWS.map((workflow) => ['gh', ['workflow', 'run', workflow, '--ref', `refs/tags/${tag}`]]),
  ]
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
    console.log([
      'U07 old-build half (design §7.5 + B-22) — a dev database only, never a customer host:',
      `  1. candidate tree: git -c core.autocrlf=false archive ${sha}   (LF; check blob sha256)`,
      `  2. old tree:       git -c core.autocrlf=false archive ${added}^   (the parent of migration 106's first commit)`,
      '  3. a throwaway database: migrate it with the CANDIDATE tree, then produce the G9-U07 artifacts on it (an unfinished',
      '     execution; a puller close not yet settled; a change plan left confirmed; a recovery-written plan).',
      '  4. run the stop-condition queries (the 106 header query, parsed from the candidate\'s migration 106, and the 102-104',
      '     ones): each non-zero.',
      '  5. start the OLD tree against that database with RunMigrations 0: preview / apply / export of each artifact\'s project',
      '     are refused where the queries say so; no ADD or INACTIVE row is written (meta_records count and revisions equal).',
      '  6. evidence values-free (counts and codes); DROP the database.',
      '  Pending (S6-6, G9-S66-U07): a repair run left running joins step 3.',
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
  const commands = planCommands(sha, tag)
  if (!argv.includes('--dispatch')) {
    for (const [cmd, args] of commands) console.log([cmd, ...args].join(' '))
    console.log(`then: node scripts/ops/stock-prep-g9-frozen-candidate.mjs --collect --tag ${tag}`)
    return 0
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
