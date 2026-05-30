import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'resolve-metrics-scrape-token.sh')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'resolve-metrics-scrape-token-'))
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

test('metrics token resolver exits zero without deploy inputs when fallback is optional', async () => {
  const result = await runResolver()

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /DEPLOY_HOST\/DEPLOY_USER\/DEPLOY_SSH_KEY_B64 are incomplete/)
})

test('metrics token resolver fails without deploy inputs when fallback is required', async () => {
  const result = await runResolver({ METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED: 'true' })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /::error::METRICS_AUTH_HEADER is not set and DEPLOY_HOST\/DEPLOY_USER\/DEPLOY_SSH_KEY_B64 are incomplete/)
})

test('metrics token resolver reads token through deploy-host fallback without logging it', async () => {
  const tmp = makeTmpDir()
  const binDir = path.join(tmp, 'bin')
  const sshArgsPath = path.join(tmp, 'ssh-args')
  try {
    mkdirSync(binDir)
    const sshPath = path.join(binDir, 'ssh')
    writeFileSync(sshPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_SSH_ARGS_PATH"
cat >/dev/null
printf 'remote prelude\\n'
printf '__METRICS_SCRAPE_TOKEN_BEGIN__metrics-secret__METRICS_SCRAPE_TOKEN_END__\\n'
`)
    chmodSync(sshPath, 0o755)

    const result = await runResolver({
      HOME: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      FAKE_SSH_ARGS_PATH: sshArgsPath,
      DEPLOY_HOST: 'deploy.example.test',
      DEPLOY_USER: 'deployer',
      DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'metrics-secret')
    assert.match(result.stderr, /token resolved from deploy-host backend runtime/)
    assert.doesNotMatch(result.stderr, /metrics-secret/)
    assert.doesNotMatch(readFileSync(sshArgsPath, 'utf8'), /\.ssh\/deploy_key/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('metrics token resolver cleans up temporary deploy SSH key after fallback execution', async () => {
  const tmp = makeTmpDir()
  const binDir = path.join(tmp, 'bin')
  const sshKeyPathFile = path.join(tmp, 'ssh-key-path')
  try {
    mkdirSync(binDir)
    const sshPath = path.join(binDir, 'ssh')
    writeFileSync(sshPath, `#!/usr/bin/env bash
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
printf '__METRICS_SCRAPE_TOKEN_BEGIN__metrics-secret__METRICS_SCRAPE_TOKEN_END__\\n'
`)
    chmodSync(sshPath, 0o755)

    const result = await runResolver({
      HOME: tmp,
      TMPDIR: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      FAKE_SSH_KEY_PATH: sshKeyPathFile,
      DEPLOY_HOST: 'deploy.example.test',
      DEPLOY_USER: 'deployer',
      DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
    })

    assert.equal(result.status, 0, result.stderr)
    const usedKeyPath = readFileSync(sshKeyPathFile, 'utf8').trim()
    assert.match(
      usedKeyPath,
      new RegExp(`^${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/metrics-scrape-ssh-key\\.`),
    )
    assert.equal(existsSync(usedKeyPath), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('metrics token resolver fails when required fallback cannot find a token sentinel', async () => {
  const tmp = makeTmpDir()
  const binDir = path.join(tmp, 'bin')
  try {
    mkdirSync(binDir)
    const sshPath = path.join(binDir, 'ssh')
    writeFileSync(sshPath, `#!/usr/bin/env bash
cat >/dev/null
printf 'no token here\\n'
`)
    chmodSync(sshPath, 0o755)

    const result = await runResolver({
      HOME: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED: 'true',
      DEPLOY_HOST: 'deploy.example.test',
      DEPLOY_USER: 'deployer',
      DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
    })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /::error::failed to resolve METRICS_SCRAPE_TOKEN/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
