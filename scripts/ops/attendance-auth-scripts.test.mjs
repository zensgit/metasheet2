import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const repoRoot = process.cwd()
const resolveAuthScript = path.join(repoRoot, 'scripts/ops/attendance-resolve-auth.sh')
const writeAuthErrorScript = path.join(repoRoot, 'scripts/ops/attendance-write-auth-error.sh')

function runBash(scriptPath, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath, ...args], {
      env: { ...process.env, ...env },
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

async function withAuthStubServer(handler, run) {
  const server = createServer(handler)
  server.keepAliveTimeout = 1
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    return await run(port)
  } finally {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    }
    await new Promise((resolve) => server.close(resolve))
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
    await withAuthStubServer((req, res) => {
      res.setHeader('connection', 'close')
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/auth/me') {
        res.statusCode = 401
        res.end(JSON.stringify({ success: false }))
        return
      }
      if (req.url === '/api/auth/refresh-token') {
        res.statusCode = 401
        res.end(JSON.stringify({ success: false }))
        return
      }
      if (req.url === '/api/auth/login') {
        res.statusCode = 401
        res.end(JSON.stringify({ success: false }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ success: false }))
    }, async (port) => {
      const result = await runBash(resolveAuthScript, [], {
        API_BASE: `http://127.0.0.1:${port}/api`,
        AUTH_RESOLVE_ALLOW_INSECURE_HTTP: '1',
        AUTH_TOKEN: 'abc.def.ghi',
        LOGIN_EMAIL: 'admin@example.com',
        LOGIN_PASSWORD: 'demo-password',
        AUTH_RESOLVE_META_FILE: metaFile,
      })

      assert.equal(result.status, 1)
      const meta = readFileSync(metaFile, 'utf8')
      assert.match(meta, /^AUTH_ME_LAST_HTTP=401$/m)
      assert.match(meta, /^AUTH_REFRESH_LAST_HTTP=401$/m)
      assert.match(meta, /^AUTH_LOGIN_LAST_HTTP=401$/m)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
