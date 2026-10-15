import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  FROZEN_SHA,
  SOURCE_PATHS,
  WEB_RUNNER_PATH,
  LedgerError,
  assertLedgerMatch,
  buildLedger,
  canonicalDigest,
  checkWorktree,
  generateBaseline,
  loadBaseline,
  readFrozenFiles,
  readWorktreeFiles,
  validateBaseline,
} from './ci-execution-ledger.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const baselinePath = fileURLToPath(new URL('./fixtures/ci-execution-ledger-p0/baseline.json', import.meta.url))
const modulePath = fileURLToPath(new URL('./ci-execution-ledger.mjs', import.meta.url))

function codeOf(fn) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof LedgerError)
    assert.equal(err.message, err.code)
    assert.equal(err.message.includes('://'), false)
    assert.equal(err.message.includes('${{'), false)
    return err.code
  }
  assert.fail('expected LedgerError')
}

test('frozen git objects match the independent baseline', () => {
  const files = readFrozenFiles(root)
  const candidate = buildLedger(files)
  const baseline = loadBaseline(baselinePath)
  assert.equal(candidate.frozenSha, FROZEN_SHA)
  assert.equal(candidate.webRunner.shellParsed, false)
  assert.equal(candidate.webRunner.runtimeCasesCollected, false)
  assert.equal(candidate.webRunner.binding, 'exact-source-hash')
  assert.equal(candidate.invocationContexts.length > 0, true)
  for (const ctx of candidate.invocationContexts) {
    assert.equal(ctx.runnerSha256, candidate.webRunner.sha256)
    assert.equal(typeof ctx.occurrence, 'string')
  }
  const occurrences = candidate.invocationContexts.map((ctx) => ctx.occurrence)
  assert.equal(new Set(occurrences).size, occurrences.length)
  assertLedgerMatch(candidate, baseline)
  const text = readFileSync(baselinePath, 'utf8')
  assert.equal(text.includes('://'), false)
  assert.equal(text.includes('${{'), false)
  assert.equal(text.includes('localhost'), false)
})

test('check reads worktree bytes while generate stays on frozen git', () => {
  const baseline = loadBaseline(baselinePath)
  const frozen = readFrozenFiles(root)
  const work = readWorktreeFiles(root)
  assertLedgerMatch(buildLedger(frozen), baseline)
  checkWorktree(root, baselinePath)
  const runner = Buffer.from(work[WEB_RUNNER_PATH])
  work[WEB_RUNNER_PATH] = Buffer.concat([runner, Buffer.from('\n')])
  assert.equal(codeOf(() => assertLedgerMatch(buildLedger(work), baseline)), 'LEDGER_BASELINE_MISMATCH')
  assert.equal(Buffer.compare(readFrozenFiles(root)[WEB_RUNNER_PATH], runner), 0)
  const generated = generateBaseline({ repoRoot: root, destination: baselinePath, write: false })
  assert.equal(generated.ledgerDigest, baseline.ledgerDigest)
  assert.equal(readFileSync(modulePath, 'utf8').includes('checkWorktree(repoRoot, destination)'), true)
})

test('generate without write does not touch the baseline', () => {
  const before = statSync(baselinePath).mtimeMs
  const ledger = generateBaseline({ repoRoot: root, destination: baselinePath, write: false })
  assert.equal(statSync(baselinePath).mtimeMs, before)
  assertLedgerMatch(ledger, loadBaseline(baselinePath))
})

test('source and command mutations fail, then restored bytes match', () => {
  const files = readFrozenFiles(root)
  const baseline = loadBaseline(baselinePath)
  const runner = Buffer.from(files[WEB_RUNNER_PATH])
  files[WEB_RUNNER_PATH] = Buffer.concat([runner, Buffer.from('x')])
  assert.equal(codeOf(() => assertLedgerMatch(buildLedger(files), baseline)), 'LEDGER_BASELINE_MISMATCH')
  files[WEB_RUNNER_PATH] = runner
  assertLedgerMatch(buildLedger(files), baseline)
  const webPath = SOURCE_PATHS[1]
  const web = Buffer.from(files[webPath])
  files[webPath] = Buffer.from(web.toString('utf8').replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-22.04'))
  const mutated = buildLedger(files)
  assert.equal(codeOf(() => assertLedgerMatch(mutated, baseline)), 'LEDGER_BASELINE_MISMATCH')
  assert.notEqual(mutated.workflows[1].jobs[0].runnerHash, baseline.workflows[1].jobs[0].runnerHash)
  files[webPath] = web
  assertLedgerMatch(buildLedger(files), baseline)
})

test('command blocks stay bound without a shell parser or runtime claim', () => {
  const source = readFileSync(modulePath, 'utf8')
  assert.equal(source.includes('shellTokens'), false)
  assert.equal(source.includes('vitest'), false)
  const run = 'bash apps/web/scripts/run-required-web-tests.sh --reporter=dot'
  const files = {
    [SOURCE_PATHS[0]]: 'name: plugin\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n',
    [SOURCE_PATHS[1]]: `name: web\non: push\njobs:\n  web:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n      - run: ${run}\n`,
    [WEB_RUNNER_PATH]: 'printf ready\n',
  }
  const ledger = buildLedger(files)
  assert.equal(ledger.webRunner.shellParsed, false)
  assert.equal(ledger.webRunner.runtimeCasesCollected, false)
  assert.equal(ledger.invocationContexts.length, 2)
  assert.equal(ledger.invocationContexts[0].runHash, ledger.invocationContexts[1].runHash)
  assert.deepEqual(ledger.invocationContexts.map((ctx) => ctx.occurrence), ['1', '2'])
  const changed = { ...files, [WEB_RUNNER_PATH]: 'printf changed\n' }
  const next = buildLedger(changed)
  assert.notEqual(next.webRunner.sha256, ledger.webRunner.sha256)
  assert.notEqual(next.invocationContexts[0].runnerSha256, ledger.invocationContexts[0].runnerSha256)
  assert.equal(next.invocationContexts[0].runHash, ledger.invocationContexts[0].runHash)
})

test('malformed yaml, missing input, and bad baseline fail closed', () => {
  const files = readFrozenFiles(root)
  const secret = 'postgresql://user:secret@localhost:5432/app'
  files[SOURCE_PATHS[1]] = Buffer.from(`on: push\njobs: [\n  url: ${secret}\n`)
  assert.equal(codeOf(() => buildLedger(files)), 'LEDGER_MALFORMED_YAML')
  delete files[SOURCE_PATHS[1]]
  files[WEB_RUNNER_PATH] = Buffer.from('echo ok')
  assert.equal(codeOf(() => buildLedger(files)), 'LEDGER_MISSING_FILE')
  assert.equal(codeOf(() => loadBaseline(join(dirname(baselinePath), 'missing.json'))), 'LEDGER_MISSING_FILE')
  assert.equal(codeOf(() => loadBaseline(modulePath)), 'LEDGER_MALFORMED_SCHEMA')
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  try {
    const idle = join(dir, 'baseline.json')
    generateBaseline({ repoRoot: root, destination: idle, write: false })
    assert.throws(() => statSync(idle))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recomputed nested ledger shapes fail closed', () => {
  const original = loadBaseline(baselinePath)
  const reseal = (mutate) => {
    const body = structuredClone(original)
    mutate(body)
    delete body.ledgerDigest
    body.ledgerDigest = canonicalDigest(body)
    return body
  }
  for (const mutate of [
    (body) => { delete body.workflows },
    (body) => { body.invocationContexts = [null] },
    (body) => { body.sources[0].sha256 = 42 },
    (body) => { body.workflows[0].jobs = [null] },
    (body) => { body.sources[0] = null },
    (body) => { body.workflows[0].jobs[0].steps[0].id = 42 },
    (body) => { body.workflows[0].jobs[0].steps[0].id = true },
    (body) => { delete body.workflows[0].jobs[0].steps[0].id },
    (body) => { body.invocationContexts[0].index = String(body.invocationContexts[0].index) },
  ]) {
    assert.equal(codeOf(() => {
      const body = reseal(mutate)
      validateBaseline(body)
      assertLedgerMatch(body, body)
    }), 'LEDGER_MALFORMED_SCHEMA')
  }
  const files = {
    [SOURCE_PATHS[0]]: 'name: plugin\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n',
    [SOURCE_PATHS[1]]: 'name: web\non: push\njobs:\n  web:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash apps/web/scripts/run-required-web-tests.sh\n      - run: 123\n',
    [WEB_RUNNER_PATH]: 'printf ready\n',
  }
  assert.equal(codeOf(() => buildLedger(files)), 'LEDGER_MALFORMED_SCHEMA')
})

test('git stderr stays inside the child and cli errors are stable codes', () => {
  const marker = 'synthetic-sensitive-marker'
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFrozenFiles } from ${JSON.stringify(pathToFileURL(modulePath).href)}
    try { readFrozenFiles('/') } catch (err) { console.log(err.code) }
  `], { encoding: 'utf8', env: { ...process.env, GIT_DIR: `/${marker}` } })
  assert.equal(child.status, 0)
  assert.equal(child.stdout.trim(), 'LEDGER_MISSING_FILE')
  assert.equal(child.stderr.includes(marker), false)
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'))
  try {
    const cli = spawnSync(process.execPath, [modulePath], { encoding: 'utf8', cwd: dir })
    assert.equal(cli.status, 1)
    assert.equal(cli.stderr, 'LEDGER_MISSING_FILE\n')
    assert.equal(cli.stdout, '')
    assert.equal(cli.stderr.includes('at '), false)
    assert.equal(cli.stdout.includes(marker), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a workflow with no web runner reference is not an empty success', () => {
  const files = {
    [SOURCE_PATHS[0]]: 'name: plugin\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n',
    [SOURCE_PATHS[1]]: 'name: web\non: push\njobs:\n  web:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node --version\n',
    [WEB_RUNNER_PATH]: 'echo ok\n',
  }
  assert.equal(codeOf(() => buildLedger(files)), 'INVOCATION_EMPTY')
})

test('other frozen sha is rejected before git lookup', () => {
  assert.equal(codeOf(() => readFrozenFiles(root, 'a'.repeat(40))), 'LEDGER_BASELINE_MISMATCH')
})
