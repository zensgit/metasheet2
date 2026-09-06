import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const repoRoot = process.cwd()
const resolveAuthScript = path.join(repoRoot, 'scripts/ops/attendance-resolve-auth.sh')
const writeAuthErrorScript = path.join(repoRoot, 'scripts/ops/attendance-write-auth-error.sh')

function runBash(scriptPath, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      resolve({
        status: code,
        stdout,
        stderr,
      })
    })
  })
}

function makeCurlStub(dir) {
  const binDir = path.join(dir, 'bin')
  mkdirSync(binDir)
  const curlPath = path.join(binDir, 'curl')
  writeFileSync(curlPath, `#!/usr/bin/env bash
set -euo pipefail
out_file=""
payload=""
authorization=""
url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o)
      out_file="$2"
      shift 2
      ;;
    -d)
      payload="$2"
      shift 2
      ;;
    -H)
      if [[ "$2" == Authorization:* ]]; then
        authorization="$(printf '%s' "$2" | sed 's/^Authorization: //')"
      fi
      shift 2
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

case "$url" in
  */auth/me)
    case "$authorization" in
      'Bearer base.token')
        code="$FAKE_BASE_ME_CODE"
        body="$FAKE_BASE_ME_BODY"
        ;;
      'Bearer refreshed.token')
        code="$FAKE_REFRESHED_ME_CODE"
        body="$FAKE_REFRESHED_ME_BODY"
        ;;
      'Bearer login.token')
        code="$FAKE_LOGIN_ME_CODE"
        body="$FAKE_LOGIN_ME_BODY"
        ;;
      *)
        code="$FAKE_UNKNOWN_ME_CODE"
        body="$FAKE_UNKNOWN_ME_BODY"
        ;;
    esac
    ;;
  */auth/refresh-token)
    code="$FAKE_REFRESH_CODE"
    body="$FAKE_REFRESH_BODY"
    ;;
  */auth/login)
    code="$FAKE_LOGIN_CODE"
    body="$FAKE_LOGIN_BODY"
    if [[ -n "$FAKE_LOGIN_PAYLOAD_FILE" ]]; then
      printf '%s' "$payload" > "$FAKE_LOGIN_PAYLOAD_FILE"
    fi
    ;;
  *)
    code="404"
    body='{"success":false}'
    ;;
esac

printf '%s' "$body" > "$out_file"
printf '%s' "$code"
`)
  chmodSync(curlPath, 0o755)
  return binDir
}

function curlStubEnv(binDir, overrides = {}) {
  return {
    PATH: `${binDir}:${process.env.PATH || ''}`,
    API_BASE: 'https://stubbed-attendance.invalid/api',
    FAKE_BASE_ME_CODE: '401',
    FAKE_BASE_ME_BODY: '{"success":false}',
    FAKE_REFRESHED_ME_CODE: '401',
    FAKE_REFRESHED_ME_BODY: '{"success":false}',
    FAKE_LOGIN_ME_CODE: '401',
    FAKE_LOGIN_ME_BODY: '{"success":false}',
    FAKE_UNKNOWN_ME_CODE: '401',
    FAKE_UNKNOWN_ME_BODY: '{"success":false}',
    FAKE_REFRESH_CODE: '401',
    FAKE_REFRESH_BODY: '{"success":false}',
    FAKE_LOGIN_CODE: '401',
    FAKE_LOGIN_BODY: '{"success":false}',
    FAKE_LOGIN_PAYLOAD_FILE: '',
    ...overrides,
  }
}

test('attendance-write-auth-error.sh writes fallback values when meta is missing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-error-'))
  const output = path.join(dir, 'auth-error.txt')
  try {
    const result = await runBash(writeAuthErrorScript, ['/tmp/not-exist-auth-meta.txt', output], {
      API_BASE: 'http://example.invalid/api',
    })
    assert.equal(result.status, 0)
    const text = readFileSync(output, 'utf8')
    assert.match(text, /auth_me_last_http=unknown/)
    assert.match(text, /refresh_last_http=unknown/)
    assert.match(text, /login_last_http=unknown/)
    assert.match(text, /API_BASE=http:\/\/example\.invalid\/api/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-write-auth-error.sh writes values from auth resolve meta', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-meta-'))
  const metaFile = path.join(dir, 'meta.txt')
  const output = path.join(dir, 'auth-error.txt')
  try {
    writeFileSync(
      metaFile,
      [
        'AUTH_SOURCE=refresh',
        'AUTH_ME_LAST_HTTP=401',
        'AUTH_REFRESH_LAST_HTTP=200',
        'AUTH_LOGIN_LAST_HTTP=000',
        'AUTH_LOGIN_EMAIL_PRESENT=true',
        'AUTH_LOGIN_PASSWORD_PRESENT=false',
      ].join('\n'),
      'utf8',
    )
    const result = await runBash(writeAuthErrorScript, [metaFile, output], {
      API_BASE: 'https://attendance.example/api',
    })
    assert.equal(result.status, 0)
    const text = readFileSync(output, 'utf8')
    assert.match(text, /auth_me_last_http=401/)
    assert.match(text, /refresh_last_http=200/)
    assert.match(text, /login_last_http=000/)
    assert.match(text, /login_email_present=true/)
    assert.match(text, /login_password_present=false/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh blocks remote http api base by default', async () => {
  const result = await runBash(resolveAuthScript, [], {
    API_BASE: 'http://example.com/api',
    AUTH_TOKEN: 'abc.def.ghi',
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /must use HTTPS/i)
})

test('attendance-resolve-auth.sh keeps refresh/login diagnostics without subshell loss', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-resolve-'))
  const metaFile = path.join(dir, 'auth-resolve-meta.txt')
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_TOKEN: 'abc.def.ghi',
        LOGIN_EMAIL: 'admin@example.com',
        LOGIN_PASSWORD: 'demo-password',
        AUTH_RESOLVE_META_FILE: metaFile,
      }),
    )

    assert.equal(result.status, 1)
    const meta = readFileSync(metaFile, 'utf8')
    assert.match(meta, /^AUTH_ME_LAST_HTTP=401$/m)
    assert.match(meta, /^AUTH_REFRESH_LAST_HTTP=401$/m)
    assert.match(meta, /^AUTH_LOGIN_LAST_HTTP=401$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh preserves HTTP-200 compatibility when no tenant is expected', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-compatible-'))
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_TOKEN: 'base.token',
        FAKE_BASE_ME_CODE: '200',
        FAKE_BASE_ME_BODY: 'not-json',
      }),
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'base.token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh accepts a token only when auth-me matches the expected tenant', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-tenant-match-'))
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_TOKEN: 'base.token',
        AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        FAKE_BASE_ME_CODE: '200',
        FAKE_BASE_ME_BODY: '{"success":true,"data":{"user":{"tenantId":"synthetic-org"}}}',
      }),
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'base.token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const [name, body] of [
  ['wrong', '{"success":true,"data":{"user":{"tenantId":"other-org"}}}'],
  ['missing', '{"success":true,"data":{"user":{}}}'],
  ['unsuccessful', '{"success":false,"data":{"user":{"tenantId":"sensitive-expected-tenant"}}}'],
  ['invalid', 'not-json'],
]) {
  test(`attendance-resolve-auth.sh rejects ${name} auth-me tenant evidence without leaking values`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `attendance-auth-tenant-${name}-`))
    try {
      const binDir = makeCurlStub(dir)
      const result = await runBash(
        resolveAuthScript,
        [],
        curlStubEnv(binDir, {
          AUTH_TOKEN: 'base.token',
          AUTH_EXPECTED_TENANT_ID: 'sensitive-expected-tenant',
          FAKE_BASE_ME_CODE: '200',
          FAKE_BASE_ME_BODY: body,
        }),
      )

      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /no valid auth token/)
      assert.doesNotMatch(result.stderr, /sensitive-expected-tenant|other-org|base\.token|stubbed-attendance/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('attendance-resolve-auth.sh validates a refreshed token against the expected tenant', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-refresh-tenant-'))
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_TOKEN: 'base.token',
        AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        FAKE_REFRESH_CODE: '200',
        FAKE_REFRESH_BODY: '{"data":{"token":"refreshed.token"}}',
        FAKE_REFRESHED_ME_CODE: '200',
        FAKE_REFRESHED_ME_BODY: '{"success":true,"data":{"user":{"tenantId":"synthetic-org"}}}',
      }),
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'refreshed.token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh rejects a refreshed token for the wrong tenant', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-refresh-wrong-tenant-'))
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_TOKEN: 'base.token',
        AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        FAKE_REFRESH_CODE: '200',
        FAKE_REFRESH_BODY: '{"data":{"token":"refreshed.token"}}',
        FAKE_REFRESHED_ME_CODE: '200',
        FAKE_REFRESHED_ME_BODY: '{"success":true,"data":{"user":{"tenantId":"other-org"}}}',
      }),
    )

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh fails closed without logging an invalid refresh body', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-refresh-invalid-body-'))
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_TOKEN: 'base.token',
        AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        FAKE_REFRESH_CODE: '200',
        FAKE_REFRESH_BODY: 'sensitive-invalid-refresh-body',
      }),
    )

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, /sensitive-invalid-refresh-body|parse error/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh binds password login to the expected tenant and verifies it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-login-tenant-'))
  const payloadFile = path.join(dir, 'login-payload.json')
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        LOGIN_EMAIL: 'admin@example.invalid',
        LOGIN_PASSWORD: 'stubbed-password',
        FAKE_LOGIN_CODE: '200',
        FAKE_LOGIN_BODY: '{"data":{"token":"login.token"}}',
        FAKE_LOGIN_ME_CODE: '200',
        FAKE_LOGIN_ME_BODY: '{"success":true,"data":{"user":{"tenantId":"synthetic-org"}}}',
        FAKE_LOGIN_PAYLOAD_FILE: payloadFile,
      }),
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'login.token')
    assert.deepEqual(JSON.parse(readFileSync(payloadFile, 'utf8')), {
      email: 'admin@example.invalid',
      password: 'stubbed-password',
      tenantId: 'synthetic-org',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh leaves unrelated password-login payloads tenant-neutral', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-login-compatible-'))
  const payloadFile = path.join(dir, 'login-payload.json')
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        LOGIN_EMAIL: 'admin@example.invalid',
        LOGIN_PASSWORD: 'stubbed-password',
        FAKE_LOGIN_CODE: '200',
        FAKE_LOGIN_BODY: '{"data":{"token":"login.token"}}',
        FAKE_LOGIN_ME_CODE: '200',
        FAKE_LOGIN_ME_BODY: 'not-json',
        FAKE_LOGIN_PAYLOAD_FILE: payloadFile,
      }),
    )

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'login.token')
    assert.deepEqual(JSON.parse(readFileSync(payloadFile, 'utf8')), {
      email: 'admin@example.invalid',
      password: 'stubbed-password',
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh fails closed without logging an invalid login body', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-login-invalid-body-'))
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        LOGIN_EMAIL: 'admin@example.invalid',
        LOGIN_PASSWORD: 'stubbed-password',
        FAKE_LOGIN_CODE: '200',
        FAKE_LOGIN_BODY: 'sensitive-invalid-login-body',
      }),
    )

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, /sensitive-invalid-login-body|parse error/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attendance-resolve-auth.sh rejects a successful login whose auth-me tenant differs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-auth-login-wrong-tenant-'))
  try {
    const binDir = makeCurlStub(dir)
    const result = await runBash(
      resolveAuthScript,
      [],
      curlStubEnv(binDir, {
        AUTH_EXPECTED_TENANT_ID: 'synthetic-org',
        LOGIN_EMAIL: 'admin@example.invalid',
        LOGIN_PASSWORD: 'stubbed-password',
        FAKE_LOGIN_CODE: '200',
        FAKE_LOGIN_BODY: '{"data":{"token":"login.token"}}',
        FAKE_LOGIN_ME_CODE: '200',
        FAKE_LOGIN_ME_BODY: '{"success":true,"data":{"user":{"tenantId":"other-org"}}}',
      }),
    )

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
