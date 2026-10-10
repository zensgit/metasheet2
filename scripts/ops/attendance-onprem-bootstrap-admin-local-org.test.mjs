import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

/**
 * W1-6 fresh-install local org bootstrap (owner ruling 2026-10-10 「W1-6 按此形状实现」).
 *
 * Pins the step that `attendance-onprem-bootstrap-admin.sh` and its PowerShell twin
 * `multitable-onprem-bootstrap-admin.ps1` run after the admin login:
 *   - it runs ONLY when user_orgs and directory_integrations are both empty (fresh install),
 *   - it writes nothing itself: its only SQL is read-only counts, and the anchor + membership come
 *     from the EXISTING route POST /api/admin/directory/local/accounts called with the logged-in
 *     admin's own id,
 *   - upgrade installs (either table non-empty) are left untouched,
 *   - every failure exits non-zero with a values-free message, and a partial state (anchor without
 *     membership) is reported, not hidden,
 *   - the sh and ps1 flows carry the same gate, SQL, route and messages.
 *
 * Hermetic and VALUES-FREE: synthetic env fixtures built here, `psql` replaced by a PATH stub that
 * answers from env, `node` wrapped so the bcrypt step never needs node_modules, and the backend
 * replaced by an in-process loopback HTTP server. No database, no Docker, no npm dependency.
 * The PowerShell cases run only where `pwsh` exists (GitHub's ubuntu runners ship it); the
 * static parity cases always run.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const OPS = path.join(ROOT, 'scripts', 'ops')
const SH_SCRIPT = path.join(OPS, 'attendance-onprem-bootstrap-admin.sh')
const PS1_SCRIPT = path.join(OPS, 'multitable-onprem-bootstrap-admin.ps1')

const read = file => readFileSync(file, 'utf8').split('\r\n').join('\n')

const SYNTHETIC_ADMIN_ID = '00000000-0000-4000-8000-0000000000a1'
const SYNTHETIC_TOKEN = 'synthetic-session-token-not-a-jwt'
const SYNTHETIC_EMAIL = 'synthetic-admin@ci.invalid'
const SYNTHETIC_PASSWORD = 'synthetic-admin-password-1'
const ROUTE_PATH = '/api/admin/directory/local/accounts'

const HAS_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'local-org-bootstrap-'))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  const psqlLog = path.join(dir, 'psql.log')

  // psql stub: every caller in both scripts feeds SQL on stdin. Log it, answer by statement shape.
  const psql = path.join(bin, 'psql')
  writeFileSync(
    psql,
    [
      '#!/usr/bin/env bash',
      'sql="$(cat)"',
      `printf '%s\\n-----\\n' "$sql" >> ${JSON.stringify(psqlLog)}`,
      'case "$sql" in',
      `  *"INSERT INTO users"*) echo "${SYNTHETIC_ADMIN_ID}" ;;`,
      '  *"INSERT INTO user_roles"*) : ;;',
      '  *"FROM directory_integrations);"*)',
      '    [[ "${STUB_EMPTINESS_FAIL:-0}" == "1" ]] && { echo "stub failure" >&2; exit 3; }',
      '    echo "${STUB_EMPTINESS:-0:0}" ;;',
      "  *\"provider = 'local'\"*)",
      '    [[ "${STUB_POSTCONDITION_FAIL:-0}" == "1" ]] && { echo "stub failure" >&2; exit 3; }',
      '    echo "${STUB_POSTCONDITION:-1:1:1}" ;;',
      '  *) echo "UNEXPECTED_SQL" >&2; exit 9 ;;',
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(psql, 0o755)

  // node wrapper: the bcrypt hashing step would need node_modules; answer it with a fixed fake
  // hash and hand every other invocation (uuid, token parse, JSON body) to the real node.
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
    readSql: () => {
      try {
        return read(psqlLog).split('\n-----\n').filter(chunk => chunk.trim())
      } catch {
        return []
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function withBackend({ routeStatus = 200, loginToken = SYNTHETIC_TOKEN }, fn) {
  const calls = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => {
      raw += chunk
    })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? '', body: raw })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        res.statusCode = 200
        res.end(JSON.stringify({ success: true, data: loginToken ? { token: loginToken } : {} }))
        return
      }
      if (req.method === 'POST' && req.url === ROUTE_PATH) {
        res.statusCode = routeStatus
        res.end(JSON.stringify(routeStatus === 200 ? { ok: true, data: { account: {} } } : { ok: false }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const apiBase = `http://127.0.0.1:${server.address().port}/api`
  try {
    return await fn({ apiBase, calls })
  } finally {
    await new Promise(resolve => server.close(resolve))
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
    ...extra,
  }
}

function runSh(fixture, { apiBase = '', verifyLogin = '1', stub = {} } = {}) {
  return runAsync('bash', [SH_SCRIPT], {
    cwd: fixture.dir,
    env: baseEnv(fixture, {
      ENV_FILE: fixture.envFile,
      ADMIN_EMAIL: SYNTHETIC_EMAIL,
      ADMIN_PASSWORD: SYNTHETIC_PASSWORD,
      ADMIN_NAME: 'Synthetic Contract Admin',
      API_BASE: apiBase,
      VERIFY_LOGIN: verifyLogin,
      ...stub,
    }),
  })
}

const psQuote = value => `'${String(value).replaceAll("'", "''")}'`

function runPs1(fixture, { apiBase = 'http://127.0.0.1:1/api', verifyLogin = '1', stub = {} } = {}) {
  // Invoke through a tiny wrapper so a terminating `throw` surfaces as its plain message on stderr
  // (pwsh's default error view wraps and colours long messages) and as exit status 1.
  const args = [
    ['RootDir', fixture.dir],
    ['EnvFile', fixture.envFile],
    ['ApiBase', apiBase],
    ['PsqlPath', fixture.psql],
    ['AdminEmail', SYNTHETIC_EMAIL],
    ['AdminPassword', SYNTHETIC_PASSWORD],
    ['VerifyLogin', verifyLogin],
  ]
    .map(([name, value]) => `-${name} ${psQuote(value)}`)
    .join(' ')
  const command = `try { & ${psQuote(PS1_SCRIPT)} ${args}; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
  return runAsync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: fixture.dir,
    env: baseEnv(fixture, stub),
  })
}

/** The step's own lines (prefix `Local org bootstrap`) must never echo the admin id, token or email. */
function assertStepLinesValuesFree(output) {
  const stepLines = output.split('\n').filter(line => line.includes('Local org bootstrap'))
  assert.ok(stepLines.length > 0, `no local org bootstrap line in output:\n${output}`)
  for (const line of stepLines) {
    for (const value of [SYNTHETIC_ADMIN_ID, SYNTHETIC_TOKEN, SYNTHETIC_EMAIL, SYNTHETIC_PASSWORD]) {
      assert.ok(!line.includes(value), 'local org bootstrap output must be values-free')
    }
  }
}

/** Every SQL statement the step issues is a read-only count; only the pre-existing admin/grant upserts write. */
function assertStepSqlReadOnly(sqlChunks) {
  const writers = sqlChunks.filter(chunk => /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(chunk))
  assert.equal(writers.length, 2, 'only the pre-existing users upsert and role/permission grant may write')
  for (const chunk of sqlChunks) {
    if (/user_orgs|directory_integrations/.test(chunk)) {
      assert.match(chunk, /^\s*SELECT\b/, 'org/anchor SQL must be a read-only SELECT')
    }
  }
}

const RUNNERS = [
  { name: 'sh', run: runSh, enabled: true },
  { name: 'ps1', run: runPs1, enabled: HAS_PWSH },
]

for (const { name, run, enabled } of RUNNERS) {
  const opts = enabled ? {} : { skip: 'pwsh not available on this host' }

  test(`${name}: fresh install calls the existing local-accounts route once with the admin's own id`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION: '1:1:1' } })
        assert.equal(result.status, 0, result.output)
        const routeCalls = calls.filter(call => call.url === ROUTE_PATH)
        assert.equal(routeCalls.length, 1)
        assert.equal(routeCalls[0].method, 'POST')
        assert.equal(routeCalls[0].auth, `Bearer ${SYNTHETIC_TOKEN}`)
        assert.deepEqual(JSON.parse(routeCalls[0].body), { localUserId: SYNTHETIC_ADMIN_ID })
        assert.match(result.output, /Local org bootstrap: OK/)
        assertStepLinesValuesFree(result.output)
        assertStepSqlReadOnly(fixture.readSql())
      })
    } finally {
      fixture.cleanup()
    }
  })

  for (const counts of ['1:0', '0:1', '3:2']) {
    test(`${name}: upgrade install (${counts}) writes nothing and says so`, opts, async () => {
      const fixture = makeFixture()
      try {
        await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
          const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: counts } })
          assert.equal(result.status, 0, result.output)
          assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
          assert.match(result.output, /Local org bootstrap: skipped: org membership or directory data already exists/)
          assert.equal(fixture.readSql().filter(chunk => chunk.includes("provider = 'local'")).length, 0)
          assertStepLinesValuesFree(result.output)
        })
      } finally {
        fixture.cleanup()
      }
    })
  }

  test(`${name}: route failure with nothing written exits non-zero and says it is safe to re-run`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 500 }, async ({ apiBase }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION: '0:0:0' } })
        assert.notEqual(result.status, 0)
        assert.match(result.output, /HTTP 500; no anchor and no membership were written \(safe to re-run\)/)
        assertStepLinesValuesFree(result.output)
      })
    } finally {
      fixture.cleanup()
    }
  })

  for (const [routeStatus, post] of [
    [200, '1:0:0'],
    [500, '1:0:0'],
  ]) {
    test(`${name}: anchor without membership (HTTP ${routeStatus}) is reported as PARTIAL, exit non-zero`, opts, async () => {
      const fixture = makeFixture()
      try {
        await withBackend({ routeStatus }, async ({ apiBase }) => {
          const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION: post } })
          assert.notEqual(result.status, 0)
          assert.match(result.output, /left a PARTIAL state \(anchors=1\); a re-run will skip/)
          assertStepLinesValuesFree(result.output)
        })
      } finally {
        fixture.cleanup()
      }
    })
  }

  test(`${name}: emptiness check failure exits non-zero before any route call`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS_FAIL: '1' } })
        assert.notEqual(result.status, 0)
        assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
        assert.match(result.output, /Local org bootstrap: the read-only emptiness check failed; nothing was written/)
      })
    } finally {
      fixture.cleanup()
    }
  })

  test(`${name}: unexpected emptiness shape exits non-zero before any route call`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: 'garbage' } })
        assert.notEqual(result.status, 0)
        assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
        assert.match(result.output, /returned an unexpected shape; nothing was written/)
      })
    } finally {
      fixture.cleanup()
    }
  })

  test(`${name}: login response without a token exits non-zero before any route call`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 200, loginToken: '' }, async ({ apiBase, calls }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0' } })
        assert.notEqual(result.status, 0)
        assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
        assert.match(result.output, /carried no session token; nothing was written/)
      })
    } finally {
      fixture.cleanup()
    }
  })

  test(`${name}: without a login session the step is skipped and touches nothing`, opts, async () => {
    const fixture = makeFixture()
    try {
      const result = await run(fixture, { verifyLogin: '0', stub: { STUB_EMPTINESS: '0:0' } })
      assert.equal(result.status, 0, result.output)
      assert.match(result.output, /Local org bootstrap: skipped: it needs a logged-in admin session/)
      const sql = fixture.readSql()
      assert.equal(sql.filter(chunk => /user_orgs|directory_integrations/.test(chunk)).length, 0)
    } finally {
      fixture.cleanup()
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Static parity (always runs): the two twins must carry the same gate, SQL, route and messages.
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

test('parity: sh and ps1 issue byte-identical read-only SQL', () => {
  const sh = read(SH_SCRIPT)
  const ps1 = read(PS1_SCRIPT)
  const pairs = [
    [extractShSql(sh, 'LOCAL_ORG_EMPTINESS_SQL'), extractPs1Sql(ps1, 'localOrgEmptinessSql')],
    [extractShSql(sh, 'LOCAL_ORG_POSTCONDITION_SQL'), extractPs1Sql(ps1, 'localOrgPostconditionSql')],
  ]
  for (const [shSql, ps1Sql] of pairs) {
    assert.equal(shSql, ps1Sql)
    assert.match(shSql, /^SELECT\b/)
    assert.doesNotMatch(shSql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
  }
})

test('parity: sh and ps1 call the same existing route and gate on the same counts', () => {
  const sh = read(SH_SCRIPT)
  const ps1 = read(PS1_SCRIPT)
  assert.match(sh, /\/admin\/directory\/local\/accounts/)
  assert.match(ps1, /\/admin\/directory\/local\/accounts/)
  assert.match(sh, /"\$emptiness_counts" != "0:0"/)
  assert.match(ps1, /\$emptinessCounts -ne '0:0'/)
  assert.match(sh, /"\$postcondition_counts" == "1:1:1"/)
  assert.match(ps1, /\$postconditionCounts -eq '1:1:1'/)
  // Neither twin may write the anchor or the membership itself.
  for (const source of [sh, ps1]) {
    assert.doesNotMatch(source, /INSERT INTO (user_orgs|directory_integrations|directory_accounts|directory_account_links)/)
    assert.doesNotMatch(source, /UPDATE (user_orgs|directory_integrations)/)
  }
})

test('parity: sh and ps1 print the same values-free step messages', () => {
  const sh = read(SH_SCRIPT)
  const ps1 = read(PS1_SCRIPT)
  for (const message of [
    'skipped: org membership or directory data already exists (upgrade or directory already configured); nothing was written',
    'the admin login response carried no session token; nothing was written',
    'the read-only emptiness check failed; nothing was written',
    'the read-only emptiness check returned an unexpected shape; nothing was written',
    'fresh install detected (no org membership, no directory integration); creating the local org anchor and the admin membership via POST',
    'OK: local org anchor and admin membership created (one active anchor, exactly one active membership)',
    'no anchor and no membership were written (safe to re-run)',
    'a re-run will skip -- complete it by calling POST /api/admin/directory/local/accounts for the admin manually',
    'the org state is UNKNOWN -- inspect it before re-running',
  ]) {
    assert.ok(sh.includes(message), `sh is missing step message: ${message}`)
    assert.ok(ps1.includes(message), `ps1 is missing step message: ${message}`)
  }
})
