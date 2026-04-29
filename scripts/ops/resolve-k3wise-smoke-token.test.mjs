import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'resolve-k3wise-smoke-token.sh')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'resolve-k3wise-smoke-token-'))
}

function runResolver(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => {
      resolve({ status, stdout, stderr })
    })
  })
}

test('resolver prefers configured smoke token and writes it to GitHub env', async () => {
  const tmp = makeTmpDir()
  const githubEnv = path.join(tmp, 'github-env')
  try {
    const token = 'header.payload.signature'
    const result = await runResolver({
      GITHUB_ENV: githubEnv,
      K3_WISE_TOKEN_OUTPUT_ENV: 'RESOLVED_TOKEN',
      METASHEET_K3WISE_SMOKE_TOKEN_SECRET: token,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /::add-mask::header\.payload\.signature/)
    assert.match(result.stdout, /K3 WISE smoke token resolved from METASHEET_K3WISE_SMOKE_TOKEN/)
    assert.equal(readFileSync(githubEnv, 'utf8'), `RESOLVED_TOKEN<<EOF\n${token}\nEOF\n`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolver exits zero without inputs when auth is optional', async () => {
  const tmp = makeTmpDir()
  const githubEnv = path.join(tmp, 'github-env')
  try {
    const result = await runResolver({ GITHUB_ENV: githubEnv })

    assert.equal(result.status, 0)
    assert.match(result.stderr, /METASHEET_TENANT_ID is empty/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolver fails without tenant when auth is required', async () => {
  const result = await runResolver({ K3_WISE_TOKEN_RESOLVE_REQUIRED: 'true' })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /::error::METASHEET_K3WISE_SMOKE_TOKEN is not set and METASHEET_TENANT_ID is empty/)
})

test('resolver exits zero without deploy SSH inputs when fallback is optional', async () => {
  const result = await runResolver({ METASHEET_TENANT_ID: 'tenant-smoke' })

  assert.equal(result.status, 0)
  assert.match(result.stderr, /DEPLOY_HOST\/DEPLOY_USER\/DEPLOY_SSH_KEY_B64 are incomplete/)
})

test('resolver fails without deploy SSH inputs when fallback is required', async () => {
  const result = await runResolver({
    METASHEET_TENANT_ID: 'tenant-smoke',
    K3_WISE_TOKEN_RESOLVE_REQUIRED: 'yes',
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /::error::METASHEET_K3WISE_SMOKE_TOKEN is not set and DEPLOY_HOST\/DEPLOY_USER\/DEPLOY_SSH_KEY_B64 are incomplete/)
})
