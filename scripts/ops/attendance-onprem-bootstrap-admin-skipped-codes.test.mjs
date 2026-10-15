import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

/**
 * Bootstrap admin direct grants: report the codes that are not in the permission catalogue.
 *
 * `attendance-onprem-bootstrap-admin.sh` and its PowerShell twin `multitable-onprem-bootstrap-admin.ps1`
 * grant the bootstrap admin a fixed list of permission codes with
 * `INSERT ... SELECT ... FROM permissions p WHERE p.code IN (...)`, so a code that is not in the
 * catalogue is silently not granted. Right after that grant both twins now run ONE read-only query
 * that lists those codes and print them. The step is diagnostics only:
 *   - the grant INSERT and the code list are unchanged,
 *   - the query is a read-only SELECT, byte-identical in sh and ps1,
 *   - its code list is the same as the grant's code list (both twins),
 *   - nothing is printed when every code is in the catalogue,
 *   - a failing query never changes the exit status (it is reported and the run continues),
 *   - the query runs with the psql flags the step depends on (`-v ON_ERROR_STOP=1 -A -t -X`): without
 *     ON_ERROR_STOP a failing statement exits 0 and the step would be silent, so the stub logs each
 *     call's argv and the flags are asserted for the skipped-codes call.
 *
 * Hermetic and VALUES-FREE: synthetic env fixtures built here, `psql` replaced by a PATH stub that
 * answers from env, `node` wrapped so the bcrypt step never needs node_modules, VERIFY_LOGIN=0 so no
 * backend is involved. No database, no Docker, no npm dependency. The PowerShell cases run only where
 * `pwsh` exists (GitHub's ubuntu runners ship it); the static cases always run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OPS = path.join(ROOT, 'scripts', 'ops')
const SH_SCRIPT = path.join(OPS, 'attendance-onprem-bootstrap-admin.sh')
const PS1_SCRIPT = path.join(OPS, 'multitable-onprem-bootstrap-admin.ps1')

const read = file => readFileSync(file, 'utf8').split('\r\n').join('\n')

const SYNTHETIC_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2'
const SYNTHETIC_EMAIL = 'synthetic-admin@ci.invalid'
const SYNTHETIC_PASSWORD = 'synthetic-admin-password-1'

// The bootstrap admin's direct-grant codes, in the order both twins list them.
const GRANT_CODES = [
  'attendance:read',
  'attendance:write',
  'attendance:approve',
  'attendance:admin',
  'permissions:read',
  'permissions:write',
  'roles:read',
  'roles:write',
]

// The read-only query, pinned VERBATIM: any change to either twin must change this literal.
const EXPECTED_SKIPPED_CODES_SQL =
  "SELECT string_agg(t.code, ',' ORDER BY t.code) FROM unnest(ARRAY["
  + GRANT_CODES.map(code => `'${code}'`).join(', ')
  + "]) AS t(code) WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.code = t.code);"

const SKIPPED_MESSAGE_PREFIX = 'Permission codes not in catalogue (skipped; admin role bypass covers them): '
const CHECK_DESCRIPTION = 'read-only check for permission codes not in catalogue'
const CHECK_FAILED_MESSAGE =
  'Permission codes not in catalogue: the read-only check failed (non-fatal; the grants above are unchanged)'
const CHECK_SHAPE_MESSAGE =
  'Permission codes not in catalogue: the read-only check returned an unexpected shape (non-fatal; the grants above are unchanged)'

const HAS_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bootstrap-skipped-codes-'))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  const psqlLog = path.join(dir, 'psql.log')

  // psql stub: both twins feed SQL on stdin. The admin upsert and the grant are answered by shape;
  // the skipped-codes query only on an EXACT match with the pinned literal (passed in via env).
  // Each call is logged as ONE record: its argv (unit-separator joined), a `=====` line, its SQL.
  const psql = path.join(bin, 'psql')
  writeFileSync(
    psql,
    [
      '#!/usr/bin/env bash',
      'sql="$(cat)"',
      'argv="$(printf \'%s\\037\' "$@")"',
      `printf '%s\\n=====\\n%s\\n-----\\n' "$argv" "$sql" >> ${JSON.stringify(psqlLog)}`,
      'case "$sql" in',
      `  *"INSERT INTO users"*) echo "${SYNTHETIC_ADMIN_ID}" ;;`,
      '  *"INSERT INTO user_roles"*) : ;;',
      '  *)',
      '    if [[ "$sql" == "$PINNED_SKIPPED_CODES_SQL" ]]; then',
      '      [[ "${STUB_SKIPPED_CODES_FAIL:-0}" == "1" ]] && { echo "stub failure" >&2; exit 3; }',
      '      echo "${STUB_SKIPPED_CODES:-}"',
      '    else',
      '      echo "UNEXPECTED_SQL" >&2; exit 9',
      '    fi ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(psql, 0o755)

  // node wrapper: the bcrypt hashing step would need node_modules; answer it with a fixed fake hash
  // and hand every other invocation (uuid) to the real node.
  const node = path.join(bin, 'node')
  writeFileSync(
    node,
    [
      '#!/usr/bin/env bash',
      'for arg in "$@"; do',
      '  if [[ "$arg" == *bcryptjs* ]] || { [[ -f "$arg" ]] && grep -q bcryptjs "$arg"; }; then',
      '    printf "%s" "\\$2a\\$12\\$synthetic.fake.hash.for.contract.tests.only"',
      '    exit 0',
      '  fi',
      'done',
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      '',
    ].join('\n'),
  )
  chmodSync(node, 0o755)

  const envFile = path.join(dir, 'app.env')
  writeFileSync(
    envFile,
    [
      'DATABASE_URL=postgresql://synthetic@127.0.0.1:1/synthetic_contract_db',
      `JWT_SECRET=${'s'.repeat(48)}`,
      'BCRYPT_SALT_ROUNDS=12',
      `ENCRYPTION_KEY=${'3f'.repeat(32)}`,
      `ENCRYPTION_SALT=${'4e'.repeat(32)}`,
      'ATTENDANCE_IMPORT_REQUIRE_TOKEN=1',
      '',
    ].join('\n'),
  )

  return {
    dir,
    bin,
    psql,
    envFile,
    readCalls: () => {
      let log
      try {
        log = read(psqlLog)
      } catch {
        return []
      }
      return log
        .split('\n-----\n')
        .filter(record => record.trim())
        .map(record => {
          const at = record.indexOf('\n=====\n')
          assert.ok(at >= 0, 'psql stub log record without an argv/SQL separator')
          return { argv: record.slice(0, at).split('\x1f').slice(0, -1), sql: record.slice(at + '\n=====\n'.length) }
        })
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function runAsync(command, args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.on('error', reject)
    child.on('close', status => resolve({ status, output }))
  })
}

function baseEnv(fixture, extra) {
  return {
    PATH: `${fixture.bin}:${process.env.PATH}`,
    HOME: process.env.HOME ?? '',
    PINNED_SKIPPED_CODES_SQL: EXPECTED_SKIPPED_CODES_SQL,
    ...extra,
  }
}

function runSh(fixture, stub) {
  return runAsync('bash', [SH_SCRIPT], {
    cwd: fixture.dir,
    env: baseEnv(fixture, {
      ENV_FILE: fixture.envFile,
      ADMIN_EMAIL: SYNTHETIC_EMAIL,
      ADMIN_PASSWORD: SYNTHETIC_PASSWORD,
      ADMIN_NAME: 'Synthetic Contract Admin',
      VERIFY_LOGIN: '0',
      ...stub,
    }),
  })
}

const psQuote = value => `'${String(value).replaceAll("'", "''")}'`

function runPs1(fixture, stub) {
  const args = [
    ['RootDir', fixture.dir],
    ['EnvFile', fixture.envFile],
    ['ApiBase', 'http://127.0.0.1:1/api'],
    ['PsqlPath', fixture.psql],
    ['AdminEmail', SYNTHETIC_EMAIL],
    ['AdminPassword', SYNTHETIC_PASSWORD],
    ['VerifyLogin', '0'],
  ]
    .map(([name, value]) => `-${name} ${psQuote(value)}`)
    .join(' ')
  const command = `try { & ${psQuote(PS1_SCRIPT)} ${args}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
  return runAsync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: fixture.dir,
    env: baseEnv(fixture, stub),
  })
}

/** Only the pre-existing users upsert and role/permission grant write; the new query is a SELECT. */
function assertSqlShape(calls) {
  const sqlChunks = calls.map(call => call.sql)
  const writers = sqlChunks.filter(chunk => /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(chunk))
  assert.equal(writers.length, 2, 'only the pre-existing users upsert and role/permission grant may write')
  assert.equal(sqlChunks.filter(chunk => chunk === EXPECTED_SKIPPED_CODES_SQL).length, 1)
  // The query runs AFTER the grant it reports on.
  const grantIndex = sqlChunks.findIndex(chunk => chunk.includes('INSERT INTO user_permissions'))
  const checkIndex = sqlChunks.indexOf(EXPECTED_SKIPPED_CODES_SQL)
  assert.ok(grantIndex >= 0 && checkIndex > grantIndex, 'the read-only check must follow the grant')
  assertSkippedCodesPsqlFlags(calls)
}

/**
 * The skipped-codes call runs with `-v ON_ERROR_STOP=1 -A -t -X`, each as its own argv element.
 * ON_ERROR_STOP is load-bearing: without it a failing statement exits 0 and the step is silent
 * (the "check failed" branch is never reached). -A/-t keep the answer a bare list; -X skips psqlrc.
 */
function assertSkippedCodesPsqlFlags(calls) {
  const checkCalls = calls.filter(call => call.sql === EXPECTED_SKIPPED_CODES_SQL)
  assert.equal(checkCalls.length, 1, 'exactly one psql call runs the skipped-codes query')
  const { argv } = checkCalls[0]
  const stopAt = argv.findIndex((arg, index) => arg === '-v' && argv[index + 1] === 'ON_ERROR_STOP=1')
  assert.ok(stopAt >= 0, `skipped-codes psql call must pass -v ON_ERROR_STOP=1 (argv: ${JSON.stringify(argv.slice(1))})`)
  for (const flag of ['-A', '-t', '-X']) {
    assert.ok(argv.includes(flag), `skipped-codes psql call must pass ${flag} (argv: ${JSON.stringify(argv.slice(1))})`)
  }
}

function assertValuesFree(output) {
  const lines = output.split('\n').filter(line => line.includes('Permission codes not in catalogue'))
  for (const line of lines) {
    for (const value of [SYNTHETIC_ADMIN_ID, SYNTHETIC_EMAIL, SYNTHETIC_PASSWORD]) {
      assert.ok(!line.includes(value), 'the skipped-codes output must be values-free')
    }
  }
}

const RUNNERS = [
  { name: 'sh', run: runSh, enabled: true },
  { name: 'ps1', run: runPs1, enabled: HAS_PWSH },
]

for (const { name, run, enabled } of RUNNERS) {
  const opts = enabled ? {} : { skip: 'pwsh not available on this host' }

  test(`${name}: codes missing from the catalogue are printed after the grant, exit 0`, opts, async () => {
    const fixture = makeFixture()
    try {
      const missing = 'permissions:read,permissions:write,roles:read,roles:write'
      const result = await run(fixture, { STUB_SKIPPED_CODES: missing })
      assert.equal(result.status, 0, result.output)
      assert.ok(result.output.includes(`${SKIPPED_MESSAGE_PREFIX}${missing}`), result.output)
      assert.doesNotMatch(result.output, /read-only check failed|unexpected shape/)
      assertSqlShape(fixture.readCalls())
      assertValuesFree(result.output)
    } finally {
      fixture.cleanup()
    }
  })

  test(`${name}: nothing is printed when every code is in the catalogue, exit 0`, opts, async () => {
    const fixture = makeFixture()
    try {
      const result = await run(fixture, { STUB_SKIPPED_CODES: '' })
      assert.equal(result.status, 0, result.output)
      assert.ok(!result.output.includes(SKIPPED_MESSAGE_PREFIX), result.output)
      assert.doesNotMatch(result.output, /read-only check failed|unexpected shape/)
      assertSqlShape(fixture.readCalls())
    } finally {
      fixture.cleanup()
    }
  })

  test(`${name}: a failing read-only check is reported and does not change the exit status`, opts, async () => {
    const fixture = makeFixture()
    try {
      const result = await run(fixture, { STUB_SKIPPED_CODES_FAIL: '1' })
      assert.equal(result.status, 0, result.output)
      assert.ok(result.output.includes(CHECK_FAILED_MESSAGE), result.output)
      assert.ok(!result.output.includes(SKIPPED_MESSAGE_PREFIX), result.output)
      assert.match(result.output, /Admin bootstrap OK|Local org bootstrap: skipped/)
      assertSqlShape(fixture.readCalls())
    } finally {
      fixture.cleanup()
    }
  })

  test(`${name}: an unexpected answer shape is reported, not echoed, and does not change the exit status`, opts, async () => {
    const fixture = makeFixture()
    try {
      const result = await run(fixture, { STUB_SKIPPED_CODES: 'not a code list; DROP' })
      assert.equal(result.status, 0, result.output)
      assert.ok(result.output.includes(CHECK_SHAPE_MESSAGE), result.output)
      assert.ok(!result.output.includes('DROP'), result.output)
      assert.ok(!result.output.includes(SKIPPED_MESSAGE_PREFIX), result.output)
    } finally {
      fixture.cleanup()
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Static parity (always runs).
// ---------------------------------------------------------------------------------------------

function extractShSql(source, name) {
  const match = source.match(new RegExp(`^${name}="([^\\n]*)"$`, 'm'))
  assert.ok(match, `sh SQL constant not found: ${name}`)
  return match[1].trim()
}

function extractPs1Sql(source, name) {
  const match = source.match(new RegExp(`^\\$${name} = @'\\n([\\s\\S]*?)\\n'@$`, 'm'))
  assert.ok(match, `ps1 SQL here-string not found: ${name}`)
  return match[1].trim()
}

/** The quoted codes of the grant's `WHERE p.code IN (...)` list, in source order. */
function grantCodes(source, label) {
  const matches = [...source.matchAll(/INSERT INTO user_permissions[\s\S]*?WHERE p\.code IN \(([\s\S]*?)\)/g)]
  assert.equal(matches.length, 1, `${label}: expected exactly one direct-grant INSERT`)
  return [...matches[0][1].matchAll(/'([^']+)'/g)].map(match => match[1])
}

/** The quoted codes of the read-only query's ARRAY[...] list, in source order. */
function queryCodes(sql) {
  const match = sql.match(/unnest\(ARRAY\[([^\]]*)\]\)/)
  assert.ok(match, 'query has no unnest(ARRAY[...]) list')
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])
}

test('parity: sh and ps1 carry the same read-only skipped-codes query, pinned verbatim', () => {
  const shSql = extractShSql(read(SH_SCRIPT), 'BOOTSTRAP_GRANT_SKIPPED_CODES_SQL')
  const ps1Sql = extractPs1Sql(read(PS1_SCRIPT), 'bootstrapGrantSkippedCodesSql')
  assert.equal(shSql, EXPECTED_SKIPPED_CODES_SQL)
  assert.equal(ps1Sql, EXPECTED_SKIPPED_CODES_SQL)
  assert.match(shSql, /^SELECT\b/)
  assert.doesNotMatch(shSql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
})

test('parity: the query lists exactly the codes each twin grants (no drift between grant and report)', () => {
  const sh = read(SH_SCRIPT)
  const ps1 = read(PS1_SCRIPT)
  assert.deepEqual(grantCodes(sh, 'sh'), GRANT_CODES)
  assert.deepEqual(grantCodes(ps1, 'ps1'), GRANT_CODES)
  assert.deepEqual(queryCodes(extractShSql(sh, 'BOOTSTRAP_GRANT_SKIPPED_CODES_SQL')), GRANT_CODES)
  assert.deepEqual(queryCodes(extractPs1Sql(ps1, 'bootstrapGrantSkippedCodesSql')), GRANT_CODES)
})

test('parity: the grant itself is unchanged -- still an INSERT ... SELECT filtered by the catalogue', () => {
  for (const source of [read(SH_SCRIPT), read(PS1_SCRIPT)]) {
    assert.match(
      source,
      /INSERT INTO user_permissions \(user_id, permission_code\)\nSELECT :'v_user_id', p\.code\nFROM permissions p\nWHERE p\.code IN \(/,
    )
    assert.match(source, /\)\nON CONFLICT \(user_id, permission_code\) DO NOTHING;/)
  }
})

test('parity: sh and ps1 print the same values-free messages', () => {
  const sh = read(SH_SCRIPT)
  const ps1 = read(PS1_SCRIPT)
  for (const message of [SKIPPED_MESSAGE_PREFIX.trimEnd(), CHECK_DESCRIPTION, CHECK_FAILED_MESSAGE, CHECK_SHAPE_MESSAGE]) {
    assert.ok(sh.includes(message), `sh is missing message: ${message}`)
    assert.ok(ps1.includes(message), `ps1 is missing message: ${message}`)
  }
})
