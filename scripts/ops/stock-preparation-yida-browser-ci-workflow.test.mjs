import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Caller contracts only. The executable adapter records argv/environment; it never
// runs the launcher, Vitest, PG or Chromium and does not produce a whole-70 receipt.
const root = fileURLToPath(new URL('../../', import.meta.url))
const workflow = readFileSync(new URL('../../.github/workflows/plugin-tests.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const stepId = 'stock-preparation-yida-owner-real-db'
const runner = 'scripts/ops/run-stock-preparation-yida-browser-ci.mjs'
const contracts = ['scripts/ops/stock-preparation-yida-browser-ci.test.mjs',
  'scripts/ops/stock-preparation-yida-browser-ci-workflow.test.mjs']
const probePrefix = 'YIDA_CALLER_SYNTHETIC_PROBE '
const linuxShell = { skip: process.platform !== 'linux' ? 'GitHub Linux bash caller; source contract still runs on Windows' : false }

function extractStep(source) {
  const lines = source.split('\n')
  const matches = lines.flatMap((line, index) => line === `        id: ${stepId}` ? [index] : [])
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

function withProbe(callback, pgConfigMode = 'wrong-directory') {
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
    writeFileSync(adapter, `#!${executable}\nprocess.stdout.write(${JSON.stringify(probePrefix)} + JSON.stringify({ executable: process.argv[1], argv: process.argv.slice(2), env: process.env }) + '\\n')\n`, { mode: 0o700 })
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
        ['--test', ...contracts], [runner, '--pg-bin', pgBin],
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
