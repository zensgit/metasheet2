'use strict'

/**
 * Chain-completeness guard for `plugin-elearning`.
 *
 * `scripts.test` is an explicit `&&` chain. A file that is never named in that
 * chain is never executed. This walker requires every `__tests__/*.test.cjs`
 * to appear as a whole `&&` segment equal to `node __tests__/<file>`.
 * echo / xnode / `|| true` / comments cannot satisfy equality.
 */

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const TESTS_DIR = __dirname
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json')
const INTENTIONALLY_UNCHAINED = Object.freeze({})
const MIN_SUITE_COUNT = 5

function listTestFiles() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((file) => /\.test\.(cjs|mjs)$/.test(file))
    .sort()
}

function chainScript() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  assert.equal(typeof pkg.scripts.test, 'string', 'package.json scripts.test must exist')
  return pkg.scripts.test
}

function chainSegments(script) {
  return script.split('&&').map((segment) => segment.trim())
}

function isChained(script, file) {
  return chainSegments(script).some((segment) => segment === `node __tests__/${file}`)
}

function main() {
  const files = listTestFiles()
  const script = chainScript()

  assert.ok(
    files.length >= MIN_SUITE_COUNT,
    `expected at least ${MIN_SUITE_COUNT} suites, saw ${files.length}`,
  )
  assert.ok(
    files.includes('test-chain-completeness.test.cjs'),
    'the walker must see this very file, otherwise it is scanning the wrong directory',
  )

  const unchained = files.filter((file) => !isChained(script, file) && !(file in INTENTIONALLY_UNCHAINED))
  assert.deepEqual(
    unchained,
    [],
    `these suites exist but are never executed by \`pnpm test\`: ${unchained.join(', ')}`,
  )

  for (const [file, reason] of Object.entries(INTENTIONALLY_UNCHAINED)) {
    assert.ok(files.includes(file), `INTENTIONALLY_UNCHAINED names a file that does not exist: ${file}`)
    assert.ok(typeof reason === 'string' && reason.trim().length > 0)
    assert.ok(!isChained(script, file), `INTENTIONALLY_UNCHAINED[${file}] is stale — the file IS in the chain`)
  }

  const victim = 'feature-flags.test.cjs'
  assert.equal(isChained(script, victim), true, 'isChained must find a chained file')
  assert.equal(
    isChained(script, 'definitely-not-a-real-suite.test.cjs'),
    false,
    'isChained must not report an absent file as chained',
  )
  assert.equal(
    isChained(script, 'test-chain-completeness.test.cjs'),
    true,
    'this completeness file must itself be chained',
  )

  const realCommand = `node __tests__/${victim}`
  assert.ok(script.includes(realCommand), `expected the chain to contain ${realCommand} to mutate`)
  for (const disabled of [
    `echo ${realCommand}`,
    `x${realCommand}`,
    `${realCommand} || true`,
    `# ${realCommand}`,
  ]) {
    assert.equal(
      isChained(script.replace(realCommand, disabled), victim),
      false,
      `isChained must report NOT-executed for \`${disabled}\``,
    )
  }

  console.log(
    `✓ test-chain-completeness: ${files.length} suites, all executed by \`pnpm test\`` +
      ` (${Object.keys(INTENTIONALLY_UNCHAINED).length} intentional exclusions)`,
  )
}

main()
