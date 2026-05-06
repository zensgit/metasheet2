import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('resolver can use deploy-host fallback without explicit tenant for backend singleton auto-discovery', async () => {
  const tmp = makeTmpDir()
  const githubEnv = path.join(tmp, 'github-env')
  const binDir = path.join(tmp, 'bin')
  const sshArgsPath = path.join(tmp, 'ssh-args')
  try {
    mkdirSync(binDir)
    const sshPath = path.join(binDir, 'ssh')
    writeFileSync(sshPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_SSH_ARGS_PATH"
cat >/dev/null
printf 'K3_WISE_SMOKE_TENANT_ID=tenant-auto\\n'
printf 'header.payload.signature\\n'
`)
    chmodSync(sshPath, 0o755)

    const result = await runResolver({
      GITHUB_ENV: githubEnv,
      HOME: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      FAKE_SSH_ARGS_PATH: sshArgsPath,
      K3_WISE_TOKEN_AUTO_DISCOVER_TENANT: 'true',
      DEPLOY_HOST: 'deploy.example.test',
      DEPLOY_USER: 'deployer',
      DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
    })

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /METASHEET_TENANT_ID is empty/)
    assert.match(result.stdout, /K3 WISE smoke tenant scope resolved from deploy-host backend runtime: tenant-auto/)
    assert.match(result.stdout, /K3 WISE smoke token resolved from deploy-host backend runtime/)
    const githubEnvText = readFileSync(githubEnv, 'utf8')
    assert.match(githubEnvText, /K3_WISE_SMOKE_TENANT_ID=tenant-auto/)
    assert.match(githubEnvText, /K3_WISE_SMOKE_TOKEN<<EOF\nheader\.payload\.signature\nEOF/)
    const sshArgs = readFileSync(sshArgsPath, 'utf8')
    assert.match(sshArgs, /K3_WISE_SMOKE_TENANT_AUTO_DISCOVER=true/)
    assert.doesNotMatch(sshArgs, /\.ssh\/deploy_key/)
    assert.equal(existsSync(path.join(tmp, '.ssh', 'deploy_key')), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolver cleans up temporary deploy SSH key after fallback execution', async () => {
  const tmp = makeTmpDir()
  const githubEnv = path.join(tmp, 'github-env')
  const binDir = path.join(tmp, 'bin')
  const sshArgsPath = path.join(tmp, 'ssh-args')
  const sshKeyPathFile = path.join(tmp, 'ssh-key-path')
  try {
    mkdirSync(binDir)
    const sshPath = path.join(binDir, 'ssh')
    writeFileSync(sshPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_SSH_ARGS_PATH"
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-i" ]]; then
    shift
    printf '%s\\n' "$1" > "$FAKE_SSH_KEY_PATH"
    if [[ ! -f "$1" ]]; then
      echo "missing ssh key" >&2
      exit 9
    fi
    mode="$(stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1")"
    if [[ "$mode" != "600" ]]; then
      echo "bad ssh key mode: $mode" >&2
      exit 10
    fi
  fi
  shift
done
cat >/dev/null
printf 'K3_WISE_SMOKE_TENANT_ID=tenant-auto\\n'
printf 'header.payload.signature\\n'
`)
    chmodSync(sshPath, 0o755)

    const result = await runResolver({
      GITHUB_ENV: githubEnv,
      HOME: tmp,
      TMPDIR: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      FAKE_SSH_ARGS_PATH: sshArgsPath,
      FAKE_SSH_KEY_PATH: sshKeyPathFile,
      K3_WISE_TOKEN_AUTO_DISCOVER_TENANT: 'true',
      DEPLOY_HOST: 'deploy.example.test',
      DEPLOY_USER: 'deployer',
      DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
    })

    assert.equal(result.status, 0, result.stderr)
    const usedKeyPath = readFileSync(sshKeyPathFile, 'utf8').trim()
    assert.match(usedKeyPath, new RegExp(`^${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/k3wise-smoke-ssh-key\\.`))
    assert.equal(existsSync(usedKeyPath), false)
    assert.equal(existsSync(path.join(tmp, '.ssh', 'deploy_key')), false)
    assert.doesNotMatch(readFileSync(sshArgsPath, 'utf8'), /\.ssh\/deploy_key/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('resolver keeps missing tenant as a skip reason when tenant auto-discovery is disabled', async () => {
  const result = await runResolver({
    K3_WISE_TOKEN_AUTO_DISCOVER_TENANT: 'false',
    DEPLOY_HOST: 'deploy.example.test',
    DEPLOY_USER: 'deployer',
    DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
  })

  assert.equal(result.status, 0)
  assert.match(result.stderr, /K3_WISE_TOKEN_AUTO_DISCOVER_TENANT=true/)
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
