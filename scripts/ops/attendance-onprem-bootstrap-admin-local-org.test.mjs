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
// W1-6 owner ruling 2026-10-10: the bare-anchor leftover stays blocking; its copy names the leftover,
// what can leave it, and how an operator proceeds. Byte-identical in sh and ps1 (parity test below).
const BARE_ANCHOR_MESSAGE =
  'found a bare local org anchor (a local org anchor with no directory account, department or org membership; '
  + 'an interrupted run or a failed local-directory call on an earlier server version can leave one); nothing was written '
  + '-- on a fresh install, complete it by calling POST /api/admin/directory/local/accounts for the admin manually; '
  + 'on an existing deployment, re-run with VERIFY_LOGIN=0 (PowerShell: -VerifyLogin 0) to skip this step'

// The step's three read-only statements, pinned VERBATIM. They are the tenancy guard (gate r1
// P2-1): any semantic change to either twin must change these literals in the same PR, and the
// psql stub below answers ONLY these exact statements (anything else exits 9 = check failed).
const EXPECTED_EMPTINESS_SQL =
  "SELECT (SELECT count(*) FROM user_orgs) || ':' || (SELECT count(*) FROM directory_integrations);"
const EXPECTED_LEFTOVER_ANCHOR_SQL =
  "SELECT (SELECT count(*) FROM directory_integrations WHERE provider = 'local' AND org_id = 'default' AND status = 'active')" +
  " || ':' || (SELECT count(*) FROM directory_accounts)" +
  " || ':' || (SELECT count(*) FROM directory_account_links)" +
  " || ':' || (SELECT count(*) FROM directory_departments);"
const EXPECTED_POSTCONDITION_SQL =
  "SELECT (SELECT count(*) FROM directory_integrations WHERE provider = 'local' AND org_id = 'default' AND status = 'active')" +
  " || ':' || (SELECT count(*) FROM user_orgs WHERE user_id = :'v_user_id' AND is_active = TRUE)" +
  " || ':' || (SELECT count(*) FROM user_orgs WHERE user_id = :'v_user_id' AND is_active = TRUE AND org_id = 'default');"

const HAS_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'local-org-bootstrap-'))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  const psqlLog = path.join(dir, 'psql.log')

  // psql stub: every caller in both scripts feeds SQL on stdin. Log it. The pre-existing admin
  // upserts are answered by shape; the step's three read-only statements only on an EXACT match
  // with the pinned literals (passed in via env, so no quoting of them inside this stub).
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
      '  *)',
      '    if [[ "$sql" == "$PINNED_EMPTINESS_SQL" ]]; then',
      '      [[ "${STUB_EMPTINESS_FAIL:-0}" == "1" ]] && { echo "stub failure" >&2; exit 3; }',
      '      echo "${STUB_EMPTINESS:-0:0}"',
      '    elif [[ "$sql" == "$PINNED_LEFTOVER_ANCHOR_SQL" ]]; then',
      '      [[ "${STUB_LEFTOVER_FAIL:-0}" == "1" ]] && { echo "stub failure" >&2; exit 3; }',
      '      echo "${STUB_LEFTOVER:-0:0:0:0}"',
      '    elif [[ "$sql" == "$PINNED_POSTCONDITION_SQL" ]]; then',
      '      [[ "${STUB_POSTCONDITION_FAIL:-0}" == "1" ]] && { echo "stub failure" >&2; exit 3; }',
      '      echo "${STUB_POSTCONDITION:-1:1:1}"',
      '    else',
      '      echo "UNEXPECTED_SQL" >&2; exit 9',
      '    fi ;;',
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
        if (routeStatus === 'drop') {
          // No HTTP response at all (what a connection reset looks like to both twins).
          req.socket.destroy()
          return
        }
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
    PINNED_EMPTINESS_SQL: EXPECTED_EMPTINESS_SQL,
    PINNED_LEFTOVER_ANCHOR_SQL: EXPECTED_LEFTOVER_ANCHOR_SQL,
    PINNED_POSTCONDITION_SQL: EXPECTED_POSTCONDITION_SQL,
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

  for (const [counts, leftover] of [
    ['1:0', null],
    ['3:2', null],
    // 0:1 = one integration and no membership: the leftover-anchor check runs, and every shape
    // other than a bare local anchor (1:0:0:0) is an ordinary upgrade / configured directory.
    ['0:1', '0:0:0:0'], // e.g. one DingTalk integration
    ['0:1', '1:0:0:1'], // a local anchor that already has a department
    ['0:1', '1:1:1:0'], // a local anchor that already has an account + link
  ]) {
    test(`${name}: upgrade install (${counts}${leftover ? `, leftover ${leftover}` : ''}) writes nothing and says so`, opts, async () => {
      const fixture = makeFixture()
      try {
        // No login token at all: on an upgrade install the step must still just skip (gate r1 NIT-3).
        await withBackend({ routeStatus: 200, loginToken: '' }, async ({ apiBase, calls }) => {
          const stub = { STUB_EMPTINESS: counts, ...(leftover ? { STUB_LEFTOVER: leftover } : {}) }
          const result = await run(fixture, { apiBase, stub })
          assert.equal(result.status, 0, result.output)
          assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
          assert.match(result.output, /Local org bootstrap: skipped: org membership or directory data already exists/)
          const sql = fixture.readSql()
          assert.equal(sql.filter(chunk => chunk === EXPECTED_POSTCONDITION_SQL).length, 0)
          assert.equal(sql.filter(chunk => chunk === EXPECTED_LEFTOVER_ANCHOR_SQL).length, leftover ? 1 : 0)
          assertStepLinesValuesFree(result.output)
          assertStepSqlReadOnly(sql)
        })
      } finally {
        fixture.cleanup()
      }
    })
  }

  test(`${name}: a bare local anchor is reported (blocking, exit 1), not mistaken for an upgrade`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:1', STUB_LEFTOVER: '1:0:0:0' } })
        // Owner ruling 2026-10-10 (W1-6): the leftover check stays BLOCKING -- exit status 1, pinned.
        assert.equal(result.status, 1, result.output)
        assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
        assert.ok(result.output.includes(BARE_ANCHOR_MESSAGE), result.output)
        // The copy says what the leftover is, what can leave it, and both ways forward.
        assert.match(result.output, /found a bare local org anchor \(a local org anchor with no directory account, department or org membership;/)
        assert.match(result.output, /an interrupted run or a failed local-directory call on an earlier server version can leave one/)
        assert.match(result.output, /on a fresh install, complete it by calling POST \/api\/admin\/directory\/local\/accounts for the admin manually/)
        assert.match(result.output, /on an existing deployment, re-run with VERIFY_LOGIN=0 \(PowerShell: -VerifyLogin 0\) to skip this step/)
        assert.equal(fixture.readSql().filter(chunk => chunk === EXPECTED_POSTCONDITION_SQL).length, 0)
        assert.doesNotMatch(result.output, /skipped: org membership or directory data already exists/)
        assertStepLinesValuesFree(result.output)
      })
    } finally {
      fixture.cleanup()
    }
  })

  // sh reads the VERIFY_LOGIN=0 environment variable; ps1 is driven with -VerifyLogin 0 (its parameter
  // defaults to '1', so on PowerShell the environment variable alone does not reach it -- which is why
  // the copy names the PowerShell form explicitly).
  test(`${name}: the escape hatch the bare-anchor copy recommends works -- VERIFY_LOGIN=0 skips the step (exit 0)`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
        const result = await run(fixture, {
          apiBase,
          verifyLogin: '0',
          stub: { STUB_EMPTINESS: '0:1', STUB_LEFTOVER: '1:0:0:0' },
        })
        assert.equal(result.status, 0, result.output)
        assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
        assert.match(result.output, /Local org bootstrap: skipped: it needs a logged-in admin session/)
        assert.ok(!result.output.includes(BARE_ANCHOR_MESSAGE), result.output)
        const sql = fixture.readSql()
        for (const pinned of [EXPECTED_EMPTINESS_SQL, EXPECTED_LEFTOVER_ANCHOR_SQL, EXPECTED_POSTCONDITION_SQL]) {
          assert.equal(sql.filter(chunk => chunk === pinned).length, 0)
        }
      })
    } finally {
      fixture.cleanup()
    }
  })

  for (const [label, stub, pattern] of [
    ['fails', { STUB_EMPTINESS: '0:1', STUB_LEFTOVER_FAIL: '1' }, /the read-only leftover-anchor check failed; nothing was written/],
    ['has an unexpected shape', { STUB_EMPTINESS: '0:1', STUB_LEFTOVER: 'garbage' }, /the read-only leftover-anchor check returned an unexpected shape; nothing was written/],
  ]) {
    test(`${name}: leftover-anchor check that ${label} exits non-zero before any route call`, opts, async () => {
      const fixture = makeFixture()
      try {
        await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
          const result = await run(fixture, { apiBase, stub })
          assert.notEqual(result.status, 0)
          assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
          assert.match(result.output, pattern)
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
          assert.match(result.output, /left a PARTIAL state \(anchors=1, admin memberships=0\); a re-run will not repair it/)
          assertStepLinesValuesFree(result.output)
        })
      } finally {
        fixture.cleanup()
      }
    })
  }

  test(`${name}: a non-200 route answer with a complete state reports it as complete, exit 0`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 409 }, async ({ apiBase }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION: '1:1:1' } })
        assert.equal(result.status, 0, result.output)
        assert.match(result.output, /the route returned HTTP 409, but the local org anchor and the admin membership are already complete/)
        assert.doesNotMatch(result.output, /PARTIAL/)
        assertStepLinesValuesFree(result.output)
      })
    } finally {
      fixture.cleanup()
    }
  })

  for (const post of ['0:1:1', '1:1:0', '2:1:1', '1:2:1']) {
    test(`${name}: an unexpected postcondition (${post}) exits non-zero without the PARTIAL advice`, opts, async () => {
      const fixture = makeFixture()
      try {
        await withBackend({ routeStatus: 200 }, async ({ apiBase }) => {
          const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION: post } })
          assert.notEqual(result.status, 0)
          const [anchors, memberships, inDefault] = post.split(':')
          assert.match(
            result.output,
            new RegExp(`HTTP 200 and left an unexpected org state \\(anchors=${anchors}, admin memberships=${memberships}, in default=${inDefault}\\); inspect it before re-running`),
          )
          assert.doesNotMatch(result.output, /PARTIAL|Local org bootstrap: OK/)
        })
      } finally {
        fixture.cleanup()
      }
    })
  }

  for (const [label, stub, detail] of [
    ['fails', { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION_FAIL: '1' }, 'failed'],
    ['has an unexpected shape', { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION: 'garbage' }, 'returned an unexpected shape'],
  ]) {
    test(`${name}: a postcondition check that ${label} reports the state as UNKNOWN, exit non-zero`, opts, async () => {
      const fixture = makeFixture()
      try {
        await withBackend({ routeStatus: 200 }, async ({ apiBase, calls }) => {
          const result = await run(fixture, { apiBase, stub })
          assert.notEqual(result.status, 0)
          assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 1)
          assert.ok(
            result.output.includes(`HTTP 200 and the read-only postcondition check ${detail}; the org state is UNKNOWN -- inspect it before re-running`),
            result.output,
          )
          assert.doesNotMatch(result.output, /PARTIAL|safe to re-run|Local org bootstrap: OK/)
          assertStepLinesValuesFree(result.output)
        })
      } finally {
        fixture.cleanup()
      }
    })
  }

  test(`${name}: no HTTP response from the route is reported as HTTP 000`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 'drop' }, async ({ apiBase }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0', STUB_POSTCONDITION: '0:0:0' } })
        assert.notEqual(result.status, 0)
        assert.match(result.output, /the route returned HTTP 000; no anchor and no membership were written \(safe to re-run\)/)
      })
    } finally {
      fixture.cleanup()
    }
  })

  test(`${name}: a login token of an unexpected shape exits non-zero before any route call`, opts, async () => {
    const fixture = makeFixture()
    try {
      await withBackend({ routeStatus: 200, loginToken: 'not a "token"' }, async ({ apiBase, calls }) => {
        const result = await run(fixture, { apiBase, stub: { STUB_EMPTINESS: '0:0' } })
        assert.notEqual(result.status, 0)
        assert.equal(calls.filter(call => call.url === ROUTE_PATH).length, 0)
        assert.match(result.output, /carried a session token of an unexpected shape; nothing was written/)
        assertStepLinesValuesFree(result.output)
      })
    } finally {
      fixture.cleanup()
    }
  })

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
    [extractShSql(sh, 'LOCAL_ORG_LEFTOVER_ANCHOR_SQL'), extractPs1Sql(ps1, 'localOrgLeftoverAnchorSql')],
    [extractShSql(sh, 'LOCAL_ORG_POSTCONDITION_SQL'), extractPs1Sql(ps1, 'localOrgPostconditionSql')],
  ]
  // Pinned verbatim (gate r1 P2-1): comparing the twins with each other is not enough.
  assert.equal(pairs[0][0], EXPECTED_EMPTINESS_SQL)
  assert.equal(pairs[1][0], EXPECTED_LEFTOVER_ANCHOR_SQL)
  assert.equal(pairs[2][0], EXPECTED_POSTCONDITION_SQL)
  for (const [shSql, ps1Sql] of pairs) {
    assert.equal(shSql, ps1Sql)
    assert.match(shSql, /^SELECT\b/)
    assert.doesNotMatch(shSql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i)
  }
})

test('parity: sh and ps1 call the same existing route and gate on the same counts', () => {
  const sh = read(SH_SCRIPT)
  const ps1 = read(PS1_SCRIPT)
  assert.match(sh, /LOCAL_ORG_ROUTE_PATH="\/admin\/directory\/local\/accounts"/)
  assert.match(ps1, /\$localOrgRoutePath = '\/admin\/directory\/local\/accounts'/)
  assert.match(sh, /"\$emptiness_counts" != "0:0"/)
  assert.match(ps1, /\$emptinessCounts -ne '0:0'/)
  assert.match(sh, /"\$emptiness_counts" == "0:1"/)
  assert.match(ps1, /\$emptinessCounts -eq '0:1'/)
  assert.match(sh, /"\$leftover_counts" == "1:0:0:0"/)
  assert.match(ps1, /\$leftoverCounts -eq '1:0:0:0'/)
  assert.match(sh, /--max-time 30/)
  assert.match(ps1, /-TimeoutSec 30/)
  // The sh twin hands the bearer header to curl on stdin (-K -), never on argv.
  assert.match(sh, /printf 'header = "Authorization: Bearer %s"\\n' "\$admin_session_token"/)
  assert.doesNotMatch(sh, /-H "Authorization: Bearer/)
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
    'no org membership and no directory integration found (fresh install); creating the local org anchor and the admin membership via POST',
    'OK: local org anchor and admin membership created (one active anchor, exactly one active membership)',
    'but the local org anchor and the admin membership are already complete (one active anchor, exactly one active membership; another run may have created them); nothing else was written',
    'no anchor and no membership were written (safe to re-run)',
    'a re-run will not repair it -- complete it by calling POST /api/admin/directory/local/accounts for the admin manually',
    BARE_ANCHOR_MESSAGE,
    'the read-only leftover-anchor check failed; nothing was written',
    'the read-only leftover-anchor check returned an unexpected shape; nothing was written',
    'the admin login response carried a session token of an unexpected shape; nothing was written',
    'the read-only postcondition check returned an unexpected shape; the org state is UNKNOWN -- inspect it before re-running',
    'the org state is UNKNOWN -- inspect it before re-running',
    'left an unexpected org state',
    'read-only emptiness check',
    'read-only leftover-anchor check',
    'read-only postcondition check',
  ]) {
    assert.ok(sh.includes(message), `sh is missing step message: ${message}`)
    assert.ok(ps1.includes(message), `ps1 is missing step message: ${message}`)
  }
})
