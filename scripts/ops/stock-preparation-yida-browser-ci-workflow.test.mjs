import { requiredSuiteJobBody } from './plugin-tests-workflow-contract.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile as writeFixtureFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertNoEnvironmentFiles } from './run-stock-preparation-yida-browser-ci.mjs'

// Caller contracts only. The executable adapter records argv/environment; it never
// runs the launcher, Vitest, PG or Chromium and does not produce a whole-72 receipt.
const root = fileURLToPath(new URL('../../', import.meta.url))
const workflow = readFileSync(new URL('../../.github/workflows/plugin-tests.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const stepId = 'stock-preparation-yida-owner-real-db'
const runner = 'scripts/ops/run-stock-preparation-yida-browser-ci.mjs'
const contracts = ['scripts/ops/stock-preparation-yida-browser-ci.test.mjs',
  'scripts/ops/stock-preparation-yida-browser-ci-workflow.test.mjs']
const probePrefix = 'YIDA_CALLER_SYNTHETIC_PROBE '
const linuxShell = { skip: process.platform !== 'linux' ? 'GitHub Linux bash caller; source contract still runs on Windows' : false }

function extractStep(source, selectedId = stepId) {
  const lines = source.split('\n')
  const matches = lines.flatMap((line, index) => line === `        id: ${selectedId}` ? [index] : [])
  assert.equal(matches.length, 1, 'caller step must occur exactly once')
  const idIndex = matches[0]
  let start = idIndex
  while (start >= 0 && !lines[start].startsWith('      - name: ')) start--
  assert.ok(start >= 0, 'caller step name must be extractable')
  let end = idIndex + 1
  while (end < lines.length && !/^      - |^  \S/u.test(lines[end])) end++
  const block = lines.slice(start, end)
  const runIndex = block.indexOf('        run: |')
  assert.ok(runIndex >= 0, 'caller must have a literal run block')
  const body = []
  for (const line of block.slice(runIndex + 1)) {
    if (!line.trim()) { body.push(''); continue }
    if (!line.startsWith('          ')) break
    body.push(line.slice(10))
  }
  assert.ok(body.some(line => line.trim()), 'caller run block cannot be empty')
  return { header: block.slice(0, runIndex).join('\n'), run: body.join('\n').trimEnd() + '\n' }
}

const step = extractStep(workflow)
const expectedContractTests = Number(/^EXPECTED_YIDA_CONTRACT_TESTS=([1-9][0-9]*)$/mu.exec(step.run)?.[1])

const candidateStep = extractStep(workflow, 'stock-preparation-pinned-browser-install')
const candidateArchiveSha = '691d6469ab37218a362aaffff974fd378985d1428c2a690c6dbeb73501bbe51d'
const candidateBinarySha = '43624de70dc3b379406282ec4a1365d9ba574c9741e4ab099d915b7e92811925'

test('fixed candidate installer precedes the sole YiDa selector without changing other browser defaults', () => {
  assert.match(candidateStep.header, /if: matrix.node-version == '20.x'/u)
  assert.match(candidateStep.run, /set -euo pipefail/u)
  assert(candidateStep.run.includes('https://storage.googleapis.com/chromium-browser-snapshots/Linux_x64/1719529/chrome-linux.zip'))
  assert(candidateStep.run.includes(candidateArchiveSha))
  assert.match(candidateArchiveSha, /^[a-f0-9]{64}$/u)
  assert(candidateStep.run.includes(candidateBinarySha))
  assert(!candidateStep.run.includes('--location'))
  const defaultPosition = workflow.indexOf('pnpm exec playwright install --with-deps chromium')
  const fixedPosition = workflow.indexOf('id: stock-preparation-pinned-browser-install')
  const ownerPosition = workflow.indexOf('id: stock-preparation-yida-owner-real-db')
  assert(defaultPosition > 0 && defaultPosition < fixedPosition && fixedPosition < ownerPosition)
  assert(step.run.includes(runner + ' --pg-bin "$yida_pg_bin" --browser-candidate upstream-1719529'))
  assert.equal((workflow.match(/--browser-candidate(?:=| )upstream-1719529/gu) ?? []).length, 1)
  assert(!workflow.includes('id: stock-preparation-plm-full-app\n'))
  assert(!candidateStep.header.includes('continue-on-error'))
})

function installerProbe({ corruptArchive = false, corruptBinary = false, downloadFails = false, existing = false,
  mutate = source => source } = {}) {
  const scratch = path.join(root, 'tmp', 'candidate-installer-contract-' + randomUUID())
  mkdirSync(scratch, { recursive: true })
  const workspace = path.join(scratch, 'workspace'), tools = path.join(scratch, 'tools'), payload = path.join(scratch, 'payload')
  mkdirSync(workspace); mkdirSync(tools); mkdirSync(path.join(payload, 'chrome-linux'), { recursive: true })
  const binary = path.join(payload, 'chrome-linux/chrome')
  writeFileSync(binary, 'synthetic-official-binary-contract\n', { mode: 0o700 })
  const binarySha = createHash('sha256').update(readFileSync(binary)).digest('hex')
  const archive = path.join(scratch, 'fixture.zip')
  function pack() {
    const result = spawnSync('/usr/bin/zip', ['-q', archive, 'chrome-linux/chrome',
      ...(corruptArchive ? ['extra.txt'] : [])], { cwd: payload })
    assert.equal(result.status, 0)
  }
  // Archive negative adds an unrelated entry: the binary guard cannot mask a
  // removed archive guard. Binary negative updates the accepted archive digest.
  const accepted = path.join(scratch, 'accepted.zip')
  const base = spawnSync('/usr/bin/zip', ['-q', accepted, 'chrome-linux/chrome'], { cwd: payload })
  assert.equal(base.status, 0)
  if (corruptArchive) writeFileSync(path.join(payload, 'extra.txt'), 'synthetic-extra\n')
  if (corruptBinary) writeFileSync(binary, 'synthetic-tampered-binary\n', { mode: 0o700 })
  pack()
  const archiveSha = createHash('sha256').update(readFileSync(corruptArchive ? accepted : archive)).digest('hex')
  const marker = path.join(scratch, 'node-called')
  writeFileSync(path.join(tools, 'curl'), '#!/bin/bash\nset -eu\n'
    + (downloadFails ? 'exit 22\n' : 'while test "$#" -gt 0; do if test "$1" = --output; then cp "$SYNTHETIC_ZIP" "$2"; exit 0; fi; shift; done\nexit 2\n'), { mode: 0o700 })
  writeFileSync(path.join(tools, 'node'), '#!/bin/bash\nprintf done > "$SYNTHETIC_NODE_MARKER"\n', { mode: 0o700 })
  const target = path.join(scratch, 'browser-fix-probe/upstream-1719529')
  if (existing) { mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, 'keep'), 'untouched') }
  const script = mutate(candidateStep.run.replace(candidateArchiveSha, archiveSha).replace(candidateBinarySha, binarySha))
  const result = spawnSync('/bin/bash', ['-c', script], { cwd: workspace,
    env: { PATH: tools + ':/usr/bin:/bin', GITHUB_WORKSPACE: workspace, SYNTHETIC_ZIP: archive, SYNTHETIC_NODE_MARKER: marker },
    encoding: 'utf8', timeout: 10000 })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  return { status: result.status, published: existsSync(path.join(target, 'chrome-linux/chrome')),
    nodeCalled: existsSync(marker), originalKept: existing && readFileSync(path.join(target, 'keep'), 'utf8') === 'untouched' }
}

test('actual install bash checks archive before extraction and binary before exclusive publication', linuxShell, () => {
  const positive = installerProbe()
  assert.equal(positive.status, 0)
  assert.equal(positive.published, true)
  assert.equal(positive.nodeCalled, true)
  for (const options of [{ corruptArchive: true }, { corruptBinary: true }, { downloadFails: true }, { existing: true }]) {
    const negative = installerProbe(options)
    assert.notEqual(negative.status, 0)
    assert.equal(negative.published, false)
    assert.equal(negative.nodeCalled, false)
    if (options.existing) assert.equal(negative.originalKept, true)
  }
})

test('archive and binary digest removal each defeats its isolated negative oracle', linuxShell, () => {
  const archive = installerProbe({ corruptArchive: true, mutate: source => source.replace(
    /printf '%s  %s\\n' '[a-f0-9]{64}' \\\n  "\$candidate_stage\/chrome-linux.zip" \| sha256sum --check --status/u, ':') })
  assert.equal(archive.status, 0, 'archive guard mutant must reach otherwise successful install')
  assert.equal(archive.published, true)
  const binary = installerProbe({ corruptBinary: true, mutate: source => source.replace(
    /printf '%s  %s\\n' '[a-f0-9]{64}' \\\n  "\$candidate_stage\/extracted\/chrome-linux\/chrome" \| sha256sum --check --status/u, ':') })
  assert.equal(binary.status, 0, 'binary guard mutant must reach otherwise successful install')
  assert.equal(binary.published, true)
})

function extractTestJob(source) {
  return requiredSuiteJobBody(source, 'runtime-db').split('\n')
}

function mutateOwnerJob(from, to) {
  const body = requiredSuiteJobBody(workflow, 'runtime-db')
  assert.ok(body.includes(from), 'mutation must target the owner proof job')
  return workflow.replace(body, body.replace(from, to))
}

function assertTestJobRunner(source) {
  const job = extractTestJob(source)
  assert.deepEqual(job.filter(line => /^    runs-on:/u.test(line)), ['    runs-on: ubuntu-22.04'],
    'required test job must have one literal ubuntu-22.04 runner pin')
}

function extractCheckoutPatterns(source) {
  const job = extractTestJob(source)
  const checkout = job.indexOf('      - name: Checkout repository')
  assert.ok(checkout >= 0)
  let next = checkout + 1
  while (next < job.length && !job[next].startsWith('      - name: ')) next++
  const block = job.slice(checkout, next)
  assert.ok(block.includes('        uses: actions/checkout@v4'))
  assert.equal(block.filter(line => line === '          sparse-checkout-cone-mode: false').length, 1,
    'exact file exclusion requires non-cone checkout')
  const index = block.indexOf('          sparse-checkout: |')
  assert.ok(index >= 0, 'checkout must select all source except the exact legacy env')
  const patterns = []
  for (const line of block.slice(index + 1)) {
    if (!line.startsWith('            ')) break
    patterns.push(line.slice(12))
  }
  assert.deepEqual(patterns, ['/*', '!/packages/core-backend/.env'],
    'checkout cannot omit tests, sources, other env names or arbitrary trees')
  return patterns
}

const checkoutPatterns = extractCheckoutPatterns(workflow)

test('required test job pins one literal ubuntu-22.04 runner for the compatibility probe', () => {
  assertTestJobRunner(workflow)
  const pin = '    runs-on: ubuntu-22.04\n'
  for (const mutation of [
    mutateOwnerJob(pin, '    runs-on: ubuntu-latest\n'),
    mutateOwnerJob(pin, '    runs-on: ubuntu-24.04\n'),
    mutateOwnerJob(pin, '    runs-on: ${{ matrix.runner }}\n'),
    mutateOwnerJob(pin, pin + pin),
    mutateOwnerJob(pin, ''),
  ]) {
    assert.notEqual(mutation, workflow, 'mutation must change the actual workflow runner pin')
    assert.throws(() => assertTestJobRunner(mutation))
  }
})

test('required job excludes only the exact tracked runtime env in its fresh checkout', () => {
  assert.deepEqual(checkoutPatterns, ['/*', '!/packages/core-backend/.env'])
  for (const mutation of [
    mutateOwnerJob('sparse-checkout-cone-mode: false', 'sparse-checkout-cone-mode: true'),
    mutateOwnerJob('!/packages/core-backend/.env', '!/packages/core-backend/.env*'),
    mutateOwnerJob('!/packages/core-backend/.env', '!/packages/core-backend/tests'),
    mutateOwnerJob('            /*\n', '            /scripts/\n'),
  ]) {
    assert.notEqual(mutation, workflow)
    assert.throws(() => extractCheckoutPatterns(mutation))
  }
})

test('actual Git sparse checkout preserves all fixture sources and still rejects another env', linuxShell, async () => {
  const fixture = path.join(root, 'tmp', 'yida-workflow-checkout-' + randomUUID())
  const seed = path.join(fixture, 'seed'), checkout = path.join(fixture, 'checkout')
  const ownership = JSON.stringify({ owner: 'yida-workflow-checkout-contract', pid: process.pid, fixture })
  const files = ['package.json', '.env.example', '.github/workflows/plugin-tests.yml',
    'packages/core-backend/.env', 'packages/core-backend/.env.example', 'packages/core-backend/package.json',
    'packages/core-backend/tests/synthetic.test.ts', 'packages/core-backend/src/synthetic.ts',
    'apps/web/src/synthetic.ts', 'plugins/synthetic/index.cjs', 'scripts/ops/synthetic.mjs']
  mkdirSync(seed, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(fixture, 'owner.json'), ownership, { mode: 0o600 })
  const git = (cwd, args, input) => {
    const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.autocrlf=false', ...args], {
      cwd, input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: fixture, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, 'SYNTHETIC_CHECKOUT_GIT_FAILED')
    return result.stdout
  }
  try {
    for (const file of files) {
      mkdirSync(path.dirname(path.join(seed, file)), { recursive: true, mode: 0o700 })
      // Like the launcher filename contract, create only our owned synthetic fixtures;
      // never open an env file for content verification or import it into a process.
      await writeFixtureFile(path.join(seed, file), 'synthetic fixture only\n', { mode: 0o600 })
    }
    git(seed, ['init', '--quiet'])
    git(seed, ['add', '--force', '--', ...files])
    git(seed, ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'synthetic sparse checkout fixture'])
    git(fixture, ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', '--', seed, checkout])
    git(checkout, ['sparse-checkout', 'init', '--no-cone'])
    git(checkout, ['sparse-checkout', 'set', '--no-cone', '--stdin'], checkoutPatterns.join('\n') + '\n')
    git(checkout, ['checkout', '--quiet', 'HEAD'])
    assert.equal(existsSync(path.join(checkout, 'packages/core-backend/.env')), false)
    assert.equal(existsSync(path.join(seed, 'packages/core-backend/.env')), true, 'original env is untouched')
    for (const file of files.filter(file => file !== 'packages/core-backend/.env')) {
      if (path.basename(file).startsWith('.env')) assert.equal(existsSync(path.join(checkout, file)), true)
      else assert.equal(readFileSync(path.join(checkout, file), 'utf8'), 'synthetic fixture only\n')
    }
    assertNoEnvironmentFiles([checkout, path.join(checkout, 'packages/core-backend'), path.join(checkout, 'apps/web')])
    await writeFixtureFile(path.join(checkout, 'packages/core-backend/.env.local'), 'synthetic-unused\n', { mode: 0o600 })
    assert.throws(() => assertNoEnvironmentFiles([path.join(checkout, 'packages/core-backend')]),
      /YIDA_BROWSER_CI_ENVIRONMENT_FILE_PRESENT/u)
  } finally {
    assert.equal(path.dirname(fixture), path.join(root, 'tmp'))
    assert.match(path.basename(fixture), /^yida-workflow-checkout-[a-f0-9-]{36}$/u)
    assert.equal(readFileSync(path.join(fixture, 'owner.json'), 'utf8'), ownership)
    rmSync(fixture, { recursive: true, force: false })
  }
})

// The adapter answers the contract call with a node --test style summary (default: the exact
// expected count) so the caller's count check is exercised without running the contracts.
function withProbe(callback, pgConfigMode = 'wrong-directory',
  { summary = `# tests ${expectedContractTests}\n# pass ${expectedContractTests}\n# fail 0\n# skipped 0\n# todo 0\n`, exitCode = 0 } = {}) {
  const temporaryRoot = path.join(root, 'tmp')
  const fixture = path.join(temporaryRoot, 'yida-workflow-caller-' + randomUUID())
  const bin = path.join(fixture, 'bin')
  const home = path.join(fixture, 'home')
  const adapter = path.join(fixture, 'node-adapter.cjs')
  const preload = path.join(fixture, 'ambient-preload.cjs')
  const marker = path.join(fixture, 'preload-executed')
  const pgConfigMarker = path.join(fixture, 'pg-config-executed')
  const ownership = JSON.stringify({ owner: 'yida-workflow-caller-contract', pid: process.pid, fixture })
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  mkdirSync(home, { mode: 0o700 })
  writeFileSync(path.join(fixture, 'owner.json'), ownership, { mode: 0o600 })
  try {
    const executable = realpathSync(process.execPath)
    assert.doesNotMatch(executable, /[\s\0]/u, 'probe Node shebang must be an absolute executable path')
    writeFileSync(adapter, `#!${executable}\nprocess.stdout.write(${JSON.stringify(probePrefix)} + JSON.stringify({ executable: process.argv[1], argv: process.argv.slice(2), env: process.env }) + '\\n')\n`
      + `if (process.argv[2] === '--test') { process.stdout.write(${JSON.stringify(summary)}); process.exitCode = ${Number(exitCode)} }\n`, { mode: 0o700 })
    chmodSync(adapter, 0o700)
    symlinkSync(adapter, path.join(bin, 'node'))
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'synthetic preload ran before callback\\n')\n`, { mode: 0o600 })
    const pgBin = realpathSync('/usr/lib/postgresql/14/bin')
    // The workflow installs PG14 explicitly; an ambient pg_config must never select its server tools.
    assert.ok(['wrong-directory', 'broken'].includes(pgConfigMode))
    const pgConfig = path.join(bin, 'pg_config')
    writeFileSync(pgConfig, `#!${executable}\nrequire('node:fs').writeFileSync(${JSON.stringify(pgConfigMarker)}, 'called\\n')\n${pgConfigMode === 'broken' ? 'process.exit(1)' : "process.stdout.write('/synthetic/wrong-pg-bin\\n')"}\n`, { mode: 0o700 })
    chmodSync(pgConfig, 0o700)
    const ambient = {
      HOME: home, PATH: bin + ':/usr/bin:/bin', LANG: 'ambient-locale', LC_ALL: 'ambient-locale', TZ: 'Pacific/Honolulu',
      NODE_OPTIONS: '--require ' + JSON.stringify(preload), DATABASE_URL: 'synthetic-db-url', EXPECT_DB: '1',
      PGHOST: 'synthetic-host', PGPORT: '1', PGUSER: 'synthetic-user', PGPASSWORD: 'synthetic-password',
      PGDATABASE: 'synthetic-database', PGSERVICE: 'synthetic-service', PGSERVICEFILE: 'synthetic-file',
      PGPASSFILE: 'synthetic-file', NODE_PG_FORCE_NATIVE: '1', JWT_SECRET: 'synthetic-secret',
      AUTHORITY_CODE: 'synthetic-code', APP_KEY: 'synthetic-key', GH_TOKEN: 'synthetic-token',
      DINGTALK_APP_SECRET: 'synthetic-secret', YIDA_OWNER_RUNTIME_ENABLED: 'true',
      YIDA_OWNER_SEND_ENABLED: 'true', PLM_AUTOPERSIST_ENABLED: 'true',
      PLAYWRIGHT_BROWSERS_PATH: 'synthetic-browser-cache', TMPDIR: 'synthetic-temp',
      YIDA_BROWSER_CI_OWNER: 'synthetic-forged-owner',
    }
    const expectedEnvironment = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' }
    function execute(run) {
      // Actions' default Linux shell uses bash --noprofile --norc -e -o pipefail.
      // Absolute utilities remain real; only command-v node resolves to our adapter.
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run], {
        cwd: root, env: ambient, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      })
      assert.ifError(result.error)
      const receipts = result.stdout.split('\n').filter(line => line.startsWith(probePrefix))
        .map(line => JSON.parse(line.slice(probePrefix.length)))
      return { ...result, receipts, preloadExecuted: existsSync(marker), pgConfigExecuted: existsSync(pgConfigMarker) }
    }
    function assertClean(result) {
      assert.equal(result.status, 0, 'CALLER_EXIT: ' + result.stderr)
      assert.equal(result.receipts.length, 2, 'CALLER_COUNT: contract and launcher must both execute')
      assert.equal(result.preloadExecuted, false, 'CALLER_PRELOAD: ambient NODE_OPTIONS executed before callback')
      assert.equal(result.pgConfigExecuted, false, 'CALLER_PG_CONFIG: ambient pg_config must not select server binaries')
      for (const receipt of result.receipts) {
        assert.equal(receipt.executable, adapter, 'CALLER_EXECUTABLE: resolved canonical Node must execute')
        assert.deepEqual(receipt.env, expectedEnvironment, 'CALLER_ENVIRONMENT: callback must start with only allowlisted variables')
      }
      assert.deepEqual(result.receipts.map(receipt => receipt.argv), [
        ['--test', ...contracts], [runner, '--pg-bin', pgBin, '--browser-candidate', 'upstream-1719529'],
      ], 'CALLER_ARGUMENTS: run both whole contract files then only the fixed launcher and PG directory')
    }
    callback({ execute, assertClean, pgBin, ambient })
  } finally {
    assert.equal(path.dirname(fixture), temporaryRoot)
    assert.match(path.basename(fixture), /^yida-workflow-caller-[a-f0-9-]{36}$/u)
    assert.equal(readFileSync(path.join(fixture, 'owner.json'), 'utf8'), ownership)
    rmSync(fixture, { recursive: true, force: false })
  }
}

test('required owner step resolves Node and PG before two clean-environment calls', () => {
  assert.match(step.header, /^        if: matrix\.node-version == '20\.x'$/mu)
  assert.doesNotMatch(step.header, /^        (?:env|continue-on-error|working-directory):/mu)
  assert.match(workflow, /uses: ankane\/setup-postgres@v1\n        with:\n          postgres-version: 14\n/u)
  assert.match(step.run, /^if ! yida_node_command="\$\(command -v node 2>\/dev\/null\)" \|\| test -z "\$yida_node_command"; then$/mu)
  assert.match(step.run, /^if ! yida_node="\$\(\/usr\/bin\/readlink -f "\$yida_node_command" 2>\/dev\/null\)" \|\| test -z "\$yida_node"; then$/mu)
  assert.match(step.run, /^if ! yida_pg_bin="\$\(\/usr\/bin\/readlink -f \/usr\/lib\/postgresql\/14\/bin 2>\/dev\/null\)" \|\| test -z "\$yida_pg_bin"; then$/mu)
  assert.doesNotMatch(step.run, /pg_config --bindir/u)
  assert.equal((step.run.match(/\/usr\/bin\/env -i HOME="\$HOME" PATH=\/usr\/bin:\/bin LANG=C\.UTF-8 LC_ALL=C\.UTF-8 TZ=UTC/gu) ?? []).length, 2)
  assert.ok(step.run.indexOf('test -x "$yida_tool"') < step.run.indexOf('/usr/bin/env -i '), 'preflight must finish before the first Node callback')
  assert.doesNotMatch(step.run, /DATABASE_URL|EXPECT_DB|\|\|\s*true/u)
})

test('required owner step checks the exact contract subtest count before the launcher', () => {
  assert.equal((step.run.match(/^EXPECTED_YIDA_CONTRACT_TESTS=/gmu) ?? []).length, 1)
  assert.ok(Number.isInteger(expectedContractTests) && expectedContractTests > 1)
  const check = step.run.indexOf('[ "$yida_contract_tests" -eq "$EXPECTED_YIDA_CONTRACT_TESTS" ] || {')
  assert.ok(check > 0 && check < step.run.indexOf(runner), 'count check must precede the launcher')
  const zero = step.run.indexOf('for yida_contract_key in skipped todo; do')
  assert.ok(zero > check && zero < step.run.indexOf(runner), 'skipped/todo check must precede the launcher')
  assert.ok(step.run.includes('[ "$yida_contract_value" -eq 0 ] || {'))
  // Positive form only: a negative test whose `[` errors would skip the refusal.
  assert.doesNotMatch(step.run, /\[ "\$yida_contract_\w+" -ne /u)
})

for (const [name, contract, refusal] of [
  ['one subtest fewer', { summary: `# tests ${expectedContractTests - 1}\n` }, /^YIDA_CALLER_CONTRACT_COUNT: \d+ subtests ran, expected exactly \d+$/mu],
  ['one subtest more', { summary: `# tests ${expectedContractTests + 1}\n` }, /^YIDA_CALLER_CONTRACT_COUNT: \d+ subtests ran, expected exactly \d+$/mu],
  ['a file that exits 0 early (one passing test)', { summary: '# tests 1\n# pass 1\n' }, /^YIDA_CALLER_CONTRACT_COUNT: 1 subtests ran, expected exactly \d+$/mu],
  ['no summary line', { summary: '' }, /^YIDA_CALLER_CONTRACT_COUNT: no 'tests <N>' summary line found$/mu],
  ['a non-zero contract exit', { exitCode: 1 }, /^YIDA_CALLER_CONTRACT: node --test exited non-zero \(output above\)$/mu],
  ['an out-of-range count', { summary: '# tests 99999999999999999999\n# skipped 0\n# todo 0\n' }, /^YIDA_CALLER_CONTRACT_COUNT: 99999999999999999999 subtests ran, expected exactly \d+$/mu],
  ['a skipped subtest', { summary: `# tests ${expectedContractTests}\n# skipped 1\n# todo 0\n` }, /^YIDA_CALLER_CONTRACT_COUNT: 1 subtests skipped, expected 0$/mu],
  ['a todo subtest', { summary: `# tests ${expectedContractTests}\n# skipped 0\n# todo 1\n` }, /^YIDA_CALLER_CONTRACT_COUNT: 1 subtests todo, expected 0$/mu],
  ['no skipped summary line', { summary: `# tests ${expectedContractTests}\n# todo 0\n` }, /^YIDA_CALLER_CONTRACT_COUNT: no 'skipped <N>' summary line found$/mu],
  ['no todo summary line', { summary: `# tests ${expectedContractTests}\n# skipped 0\n` }, /^YIDA_CALLER_CONTRACT_COUNT: no 'todo <N>' summary line found$/mu],
]) {
  test(`actual workflow bash refuses ${name} before the launcher`, linuxShell, () => {
    withProbe(({ execute }) => {
      const result = execute(step.run)
      assert.notEqual(result.status, 0, 'CALLER_CONTRACT_COUNT: a contract run without the exact count must not pass')
      assert.match(result.stderr, refusal)
      assert.deepEqual(result.receipts.map(receipt => receipt.argv[0]), ['--test'], 'launcher must not run')
    }, 'wrong-directory', contract)
  })
}

test('actual workflow bash clears hostile ambient state before either Node callback', linuxShell, () => {
  withProbe(({ execute, assertClean }) => assertClean(execute(step.run)))
})

for (const mode of ['wrong-directory', 'broken']) {
  test(`actual workflow selects installed PG14 with ${mode} ambient pg_config`, linuxShell, () => {
    withProbe(({ execute, assertClean }) => assertClean(execute(step.run)), mode)
  })
}

for (const index of [0, 1]) {
  test(`removing env -i from Node call ${index + 1} executes ambient preload before the callback`, linuxShell, () => {
    withProbe(({ execute, assertClean }) => {
      let seen = 0
      const mutation = step.run.replaceAll('/usr/bin/env -i ', match => seen++ === index ? '/usr/bin/env ' : match)
      assert.notEqual(mutation, step.run, 'mutation must change a real workflow command')
      const result = execute(mutation)
      assert.equal(result.status, 0, 'mutation reaches synthetic callbacks')
      assert.equal(result.preloadExecuted, true, 'real Node preload must detect the missing environment boundary')
      assert.equal(result.receipts[index].env.DATABASE_URL, 'synthetic-db-url')
      assert.equal(result.receipts[index].env.YIDA_OWNER_SEND_ENABLED, 'true')
      assert.throws(() => assertClean(result), /CALLER_PRELOAD/u)
    })
  })
}

for (const [name, mutate] of [
  ['wrong launcher', run => run.replace(runner, 'scripts/ops/synthetic-wrong-launcher.mjs')],
  ['sentinel-only filter', run => run.replace(`${runner} --pg-bin`, `${runner} --testNamePattern sentinel --pg-bin`)],
  ['extra whole-file selector', run => run.replace(`${runner} --pg-bin`, `${runner} tests/synthetic-only.test.ts --pg-bin`)],
  ['missing PG argument', run => run.replace(' --pg-bin "$yida_pg_bin"', '')],
  ['missing browser selector', run => run.replace(' --browser-candidate upstream-1719529', '')],
  ['different browser selector', run => run.replace(' --browser-candidate upstream-1719529', ' --browser-candidate upstream-other')],
  ['missing whole contract file', run => run.replace(' \\\n  ' + contracts[1], '')],
]) {
  test(`actual callback arguments reject ${name}`, linuxShell, () => {
    withProbe(({ execute, assertClean }) => {
      const mutation = mutate(step.run)
      assert.notEqual(mutation, step.run, 'mutation must change a real workflow command')
      const result = execute(mutation)
      assert.equal(result.status, 0, 'argument mutation reaches synthetic callbacks')
      assert.throws(() => assertClean(result), /CALLER_ARGUMENTS/u)
    })
  })
}

for (const [role, executable] of [
  ['node', '$yida_node'], ['initdb', '$yida_pg_bin/initdb'], ['pg_ctl', '$yida_pg_bin/pg_ctl'],
  ['postgres', '$yida_pg_bin/postgres'], ['unshare', '/usr/bin/unshare'],
  ['setpriv', '/usr/bin/setpriv'], ['python3', '/usr/bin/python3'], ['ip', '/usr/sbin/ip'],
]) {
  test(`missing ${role} in the actual preflight stops with a fixed role before any Node callback`, linuxShell, () => {
    withProbe(({ execute }) => {
      const mutation = step.run.replace(`${role}:${executable}`, `${role}:/synthetic/missing-executable`)
      assert.notEqual(mutation, step.run)
      const result = execute(mutation)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(`^YIDA_CALLER_PREFLIGHT: ${role}$`, 'mu'))
      assert.doesNotMatch(result.stderr, /\/synthetic\/missing-executable/u)
      assert.deepEqual(result.receipts, [])
      assert.equal(result.preloadExecuted, false)
      assert.equal(result.pgConfigExecuted, false)
    })
  })
}

for (const [role, resolution] of [
  ['node-resolution', 'command -v node'],
  ['node-canonical', '/usr/bin/readlink -f "$yida_node_command"'],
  ['pg-bin-canonical', '/usr/bin/readlink -f /usr/lib/postgresql/14/bin'],
]) {
  for (const replacement of ['/bin/false', '/bin/true']) {
    test(`${role} rejects ${replacement === '/bin/false' ? 'failed' : 'empty'} resolution before any Node callback`, linuxShell, () => {
      withProbe(({ execute }) => {
        const mutation = step.run.replace(resolution, replacement)
        assert.notEqual(mutation, step.run)
        const result = execute(mutation)
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, new RegExp(`^YIDA_CALLER_PREFLIGHT: ${role}$`, 'mu'))
        assert.deepEqual(result.receipts, [])
        assert.equal(result.preloadExecuted, false)
        assert.equal(result.pgConfigExecuted, false)
      })
    })
  }
}
