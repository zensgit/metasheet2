import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'integration-k3wise-onprem-preflight.mjs')

const VALID_DB_URL = 'postgres://demo_user:demo_password_value@127.0.0.1:65432/demo_db'
const VALID_JWT = 'a'.repeat(48)
const SHORT_JWT = 'shortsecret'
const LIVE_K3_PASSWORD = 'k3-password-hunter2'
const LIVE_K3_USERNAME = 'k3-test-user'
const LIVE_K3_ACCT_ID = 'AIS_TEST_LIVE'
const LIVE_K3_URL = 'http://127.0.0.1:65431/K3API/'

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'ms2-k3-onprem-preflight-'))
}

function runScript(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      // strip PATH fragments unrelated to the test, but keep system PATH so
      // node/pnpm resolve normally if a check ever needed them
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      ...env,
    },
  })
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function readOutputs(outputDir) {
  return {
    json: JSON.parse(readFileSync(path.join(outputDir, 'preflight.json'), 'utf8')),
    md: readFileSync(path.join(outputDir, 'preflight.md'), 'utf8'),
  }
}

function findCheck(json, id) {
  return json.checks.find((c) => c.id === id)
}

function assertNoLeak(haystack, secrets) {
  for (const secret of secrets) {
    assert.ok(
      !haystack.includes(secret),
      `secret value "${secret}" leaked into output:\n${haystack}`,
    )
  }
}

test('exit 1 when DATABASE_URL is missing, with clear hint', () => {
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--skip-tcp', '--skip-migrations', '--out-dir', out],
      { JWT_SECRET: VALID_JWT },
    )
    assert.equal(result.status, 1, `expected exit 1; stdout=${result.stdout}\nstderr=${result.stderr}`)
    assert.match(result.stdout, /FAIL \(exit 1/)
    assert.match(result.stdout, /\[fail\s+\] env\.database-url/)
    const { json } = readOutputs(out)
    const check = findCheck(json, 'env.database-url')
    assert.equal(check.status, 'fail')
    assert.match(check.details.hint, /DATABASE_URL/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('exit 1 when JWT_SECRET is too short, with explicit length hint', () => {
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--skip-tcp', '--skip-migrations', '--out-dir', out],
      { DATABASE_URL: VALID_DB_URL, JWT_SECRET: SHORT_JWT },
    )
    assert.equal(result.status, 1, `expected exit 1; stdout=${result.stdout}\nstderr=${result.stderr}`)
    const { json } = readOutputs(out)
    const check = findCheck(json, 'env.jwt-secret')
    assert.equal(check.status, 'fail')
    assert.match(check.details.hint, /too short/i)
    assert.equal(check.details.length, SHORT_JWT.length)
    // The actual secret value MUST NOT appear anywhere
    assert.ok(!result.stdout.includes(SHORT_JWT))
    assert.ok(!JSON.stringify(json).includes(SHORT_JWT))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('exit 0 in mock mode with valid env, K3 endpoint not required', () => {
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--skip-tcp', '--skip-migrations', '--out-dir', out],
      { DATABASE_URL: VALID_DB_URL, JWT_SECRET: VALID_JWT },
    )
    assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout}\nstderr=${result.stderr}`)
    assert.match(result.stdout, /PASS \(exit 0/)
    const { json, md } = readOutputs(out)
    assert.equal(json.decision, 'PASS')
    assert.equal(json.exitCode, 0)
    // Mock mode must NOT require K3 inputs — these must show as 'skip'
    assert.equal(findCheck(json, 'k3.live-config').status, 'skip')
    assert.equal(findCheck(json, 'k3.live-reachable').status, 'skip')
    assert.equal(findCheck(json, 'gate.file-present').status, 'skip')
    assert.match(md, /Mode: `mock`/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('exit 2 (GATE_BLOCKED) when --live and K3 env is missing', () => {
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--live', '--skip-tcp', '--skip-migrations', '--out-dir', out],
      { DATABASE_URL: VALID_DB_URL, JWT_SECRET: VALID_JWT },
    )
    assert.equal(result.status, 2, `expected exit 2; stdout=${result.stdout}\nstderr=${result.stderr}`)
    assert.match(result.stdout, /GATE_BLOCKED \(exit 2/)
    const { json } = readOutputs(out)
    const liveConfig = findCheck(json, 'k3.live-config')
    assert.equal(liveConfig.status, 'gate-blocked')
    assert.deepEqual(
      liveConfig.details.missing.sort(),
      ['K3_ACCT_ID', 'K3_API_URL', 'K3_PASSWORD', 'K3_USERNAME'].sort(),
    )
    const gate = findCheck(json, 'gate.file-present')
    assert.equal(gate.status, 'gate-blocked')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('exit 1 (FAIL) takes precedence over exit 2 (GATE_BLOCKED)', () => {
  // If JWT is too short AND live mode is missing K3 config, FAIL must win.
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--live', '--skip-tcp', '--skip-migrations', '--out-dir', out],
      { DATABASE_URL: VALID_DB_URL, JWT_SECRET: SHORT_JWT },
    )
    assert.equal(result.status, 1, `expected exit 1; stdout=${result.stdout}\nstderr=${result.stderr}`)
    const { json } = readOutputs(out)
    assert.equal(json.decision, 'FAIL')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('Postgres TCP probe: ECONNREFUSED yields clear diagnostic', async () => {
  const tmp = makeTmpDir()
  const port = await reservePort() // guaranteed-free port
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--timeout-ms', '1500', '--out-dir', out],
      {
        DATABASE_URL: `postgres://demo:demo@127.0.0.1:${port}/demo`,
        JWT_SECRET: VALID_JWT,
      },
    )
    assert.equal(result.status, 1, `expected exit 1; stdout=${result.stdout}\nstderr=${result.stderr}`)
    const { json } = readOutputs(out)
    const tcpCheck = findCheck(json, 'pg.tcp-reachable')
    assert.equal(tcpCheck.status, 'fail')
    assert.equal(tcpCheck.details.host, '127.0.0.1')
    assert.equal(tcpCheck.details.port, port)
    assert.match(tcpCheck.details.code, /ECONNREFUSED|EUNKNOWN/)
    assert.match(tcpCheck.details.hint, /Postgres|TCP/)
    // Migration check must cascade-skip when pg is unreachable, NOT spawn pnpm.
    const migr = findCheck(json, 'pg.migrations-aligned')
    assert.equal(migr.status, 'skip')
    assert.match(migr.details.reason, /unreachable/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('migration alignment check explains alignment status when skipped', () => {
  // --skip-migrations must produce a check with a human-readable reason.
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--skip-tcp', '--skip-migrations', '--out-dir', out],
      { DATABASE_URL: VALID_DB_URL, JWT_SECRET: VALID_JWT },
    )
    assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout}\nstderr=${result.stderr}`)
    const { json, md } = readOutputs(out)
    const migr = findCheck(json, 'pg.migrations-aligned')
    assert.equal(migr.status, 'skip')
    assert.equal(migr.details.reason, '--skip-migrations')
    assert.equal(migr.label, 'Code migrations aligned with DB')
    // Must be present in MD too
    assert.match(md, /pg\.migrations-aligned/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('migration alignment check skips with explanation when DATABASE_URL is missing', () => {
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--skip-tcp', '--out-dir', out],
      { JWT_SECRET: VALID_JWT },
    )
    // exit 1 because DATABASE_URL is missing
    assert.equal(result.status, 1)
    const { json } = readOutputs(out)
    const migr = findCheck(json, 'pg.migrations-aligned')
    assert.equal(migr.status, 'skip')
    assert.match(migr.details.reason, /DATABASE_URL not set/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('output redacts real secret values in stdout, JSON, and MD', () => {
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--live', '--skip-tcp', '--skip-migrations', '--out-dir', out],
      {
        DATABASE_URL: VALID_DB_URL,
        JWT_SECRET: VALID_JWT,
        K3_API_URL: LIVE_K3_URL,
        K3_ACCT_ID: LIVE_K3_ACCT_ID,
        K3_USERNAME: LIVE_K3_USERNAME,
        K3_PASSWORD: LIVE_K3_PASSWORD,
      },
    )
    // We don't care about exit code here (will be exit 1 because the K3
    // endpoint TCP probe will refuse since nothing listens at 65431).
    // What matters: real secret values must never appear in output.
    const { json, md } = readOutputs(out)
    const jsonText = JSON.stringify(json)
    const secrets = [
      'demo_password_value',  // DATABASE_URL password
      VALID_JWT,              // JWT_SECRET value
      LIVE_K3_PASSWORD,       // K3 password
    ]
    assertNoLeak(result.stdout, secrets)
    assertNoLeak(jsonText, secrets)
    assertNoLeak(md, secrets)

    // Username and acctId are NOT secrets and may appear in the live-config
    // detail block when the GATE has supplied them — confirm they do, so
    // operators can see what they registered.
    const liveConfig = findCheck(json, 'k3.live-config')
    assert.equal(liveConfig.status, 'pass')
    assert.equal(liveConfig.details.acctId, LIVE_K3_ACCT_ID)
    assert.equal(liveConfig.details.passwordPresent, true)
    assert.equal(liveConfig.details.usernamePresent, true)
    assert.equal(liveConfig.details.apiUrl, LIVE_K3_URL)
    // The username field must be a presence boolean, not the value
    assert.ok(!('username' in liveConfig.details))
    assert.ok(!('password' in liveConfig.details))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('output sanitizes secret query params in K3_API_URL across stdout, JSON, and MD', () => {
  // Some K3 deployments place auth tokens in the API URL query string. The
  // raw values must never appear in any output channel — including
  // preflight.json (which does not pass through redactString at write time and
  // therefore relies on sanitizeUrl at storage time).
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const accessToken = 'AT-leak-VALUE-9988'
    const queryPassword = 'PW-leak-VALUE-7766'
    const sign = 'SIGN-leak-VALUE-5544'
    const apiKey = 'AK-leak-VALUE-3322'
    const sessionId = 'SID-leak-VALUE-1100'
    const k3ApiUrl =
      `http://k3.example.test:8080/K3API/?access_token=${accessToken}` +
      `&password=${queryPassword}&sign=${sign}&api_key=${apiKey}` +
      `&session_id=${sessionId}`
    const result = runScript(
      ['--live', '--skip-tcp', '--skip-migrations', '--out-dir', out],
      {
        DATABASE_URL: VALID_DB_URL,
        JWT_SECRET: VALID_JWT,
        K3_API_URL: k3ApiUrl,
        K3_ACCT_ID: LIVE_K3_ACCT_ID,
        K3_USERNAME: LIVE_K3_USERNAME,
        K3_PASSWORD: LIVE_K3_PASSWORD,
      },
    )
    // Exit code is irrelevant here (will likely fail on K3 reachability or
    // gate-blocked on the gate file). What matters: leak-free across all
    // three output channels.
    const { json, md } = readOutputs(out)
    const jsonText = JSON.stringify(json)
    const queryParamSecrets = [accessToken, queryPassword, sign, apiKey, sessionId]

    assertNoLeak(result.stdout, queryParamSecrets)
    assertNoLeak(jsonText, queryParamSecrets)
    assertNoLeak(md, queryParamSecrets)

    // Confirm the JSON kept the URL shape so operators can still see what
    // host/path was registered, with the secret slots replaced.
    const liveConfig = findCheck(json, 'k3.live-config')
    assert.equal(liveConfig.status, 'pass')
    assert.match(liveConfig.details.apiUrl, /^http:\/\/k3\.example\.test:8080\/K3API\//)
    assert.match(liveConfig.details.apiUrl, /access_token=(?:%3C|<)redacted(?:%3E|>)/i)
    assert.match(liveConfig.details.apiUrl, /password=(?:%3C|<)redacted(?:%3E|>)/i)
    assert.match(liveConfig.details.apiUrl, /sign=(?:%3C|<)redacted(?:%3E|>)/i)
    assert.match(liveConfig.details.apiUrl, /api_key=(?:%3C|<)redacted(?:%3E|>)/i)
    assert.match(liveConfig.details.apiUrl, /session_id=(?:%3C|<)redacted(?:%3E|>)/i)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('rejects unknown CLI argument with non-zero exit', () => {
  const result = runScript(['--definitely-not-a-flag'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /unknown argument/)
})

test('rejects out-of-range --timeout-ms', () => {
  const result = runScript(['--timeout-ms', '50'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /timeout-ms/)
})

test('migration alignment check gracefully skips when pnpm/tsx is not on PATH', () => {
  // Simulate an on-prem box that has node but no pnpm/tsx installed.
  // The migration check should report `skip` with an actionable hint, not
  // propagate a `spawn ENOENT` as a `fail`.
  // We use --skip-tcp so the migration check is reached without standing up
  // a real Postgres listener (which complicates teardown on macOS).
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      ['--skip-tcp', '--out-dir', out],
      {
        // Empty PATH guarantees pnpm cannot be resolved by spawn().
        PATH: '/nonexistent-bin-dir',
        DATABASE_URL: VALID_DB_URL,
        JWT_SECRET: VALID_JWT,
      },
    )
    assert.equal(result.status, 0, `expected exit 0; stdout=${result.stdout}\nstderr=${result.stderr}`)
    const { json } = readOutputs(out)
    const migr = findCheck(json, 'pg.migrations-aligned')
    assert.equal(migr.status, 'skip')
    assert.match(migr.details.reason, /pnpm.*not on PATH/i)
    assert.match(migr.details.hint, /pnpm install/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('--gate-file pointing at nonexistent path fails (not gate-blocked)', () => {
  const tmp = makeTmpDir()
  try {
    const out = path.join(tmp, 'r')
    const result = runScript(
      [
        '--live',
        '--skip-tcp',
        '--skip-migrations',
        '--gate-file',
        path.join(tmp, 'no-such-gate.json'),
        '--out-dir',
        out,
      ],
      {
        DATABASE_URL: VALID_DB_URL,
        JWT_SECRET: VALID_JWT,
        K3_API_URL: LIVE_K3_URL,
        K3_ACCT_ID: LIVE_K3_ACCT_ID,
        K3_USERNAME: LIVE_K3_USERNAME,
        K3_PASSWORD: 'p1',
      },
    )
    assert.equal(result.status, 1, `expected exit 1; stdout=${result.stdout}\nstderr=${result.stderr}`)
    const { json } = readOutputs(out)
    assert.equal(findCheck(json, 'gate.file-present').status, 'fail')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
