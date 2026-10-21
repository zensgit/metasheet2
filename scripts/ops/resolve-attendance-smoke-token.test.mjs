import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'resolve-attendance-smoke-token.sh')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'resolve-attendance-smoke-token-'))
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

function runNodeSource(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {},
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

function runBashSource(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-s'], {
      stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdin.end(source)
  })
}

function extractEmbeddedNode(remoteScript) {
  const match = remoteScript.match(/node --input-type=module - <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/)
  assert.ok(match, 'embedded Node program was not found in captured SSH stdin')
  return match[1]
}

async function runEmbeddedNode(remoteScript, { organizationId, activeMembership }) {
  const embeddedNode = extractEmbeddedNode(remoteScript)
  const instrumentedNode = embeddedNode
    .replace("import pg from 'pg'", 'const pg = globalThis.__pg')
    .replace(
      "import { authService } from '/app/packages/core-backend/dist/src/auth/AuthService.js'",
      'const { authService } = globalThis.__auth',
    )
  assert.notEqual(instrumentedNode, embeddedNode, 'embedded imports must be replaced by test mocks')

  const userRow = {
    id: 'synthetic-admin',
    email: 'synthetic-admin@example.invalid',
    username: 'synthetic-admin',
    name: 'Synthetic Admin',
    mobile: null,
    role: 'admin',
    permissions: ['attendance:admin'],
    is_active: true,
    must_change_password: false,
    tenant_id: organizationId,
    has_rbac_admin: true,
  }
  const harness = `
const evidence = { queryText: '', queryParams: null, tokenUser: null }
globalThis.__pg = {
  Client: class {
    async connect() {}
    async query(queryText, queryParams) {
      evidence.queryText = queryText
      evidence.queryParams = queryParams
      const membershipBound = queryText.includes('JOIN user_orgs uo')
        && queryText.includes('uo.org_id = $1')
        && queryText.includes('uo.is_active = true')
        && queryText.includes('u.is_active = true')
        && Array.isArray(queryParams)
        && queryParams.length === 1
        && queryParams[0] === ${JSON.stringify(organizationId)}
      return { rows: membershipBound && ${JSON.stringify(activeMembership)} ? [${JSON.stringify(userRow)}] : [] }
    }
    async end() {}
  },
}
globalThis.__auth = {
  authService: {
    createToken(user) {
      evidence.tokenUser = user
      return 'header.payload.signature'
    },
  },
}
process.env.DATABASE_URL = 'postgres://stubbed.invalid/db'
process.env.ATTENDANCE_SMOKE_ORG_ID = ${JSON.stringify(organizationId)}
${instrumentedNode}
console.log('__EVIDENCE__' + JSON.stringify(evidence))
`
  return runNodeSource(harness)
}

test('attendance token resolver exits zero without deploy inputs when fallback is optional', async () => {
  const result = await runResolver()

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /DEPLOY_HOST\/DEPLOY_USER\/DEPLOY_SSH_KEY_B64 are incomplete/)
})

test('attendance token resolver fails without deploy inputs when fallback is required', async () => {
  const result = await runResolver({ ATTENDANCE_TOKEN_RESOLVE_REQUIRED: 'true' })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /::error::ATTENDANCE_ADMIN_JWT is invalid and DEPLOY_HOST\/DEPLOY_USER\/DEPLOY_SSH_KEY_B64 are incomplete/)
})

test('attendance token resolver refuses deploy fallback without an explicit smoke organization', async () => {
  const tmp = makeTmpDir()
  const binDir = path.join(tmp, 'bin')
  const sshInvokedPath = path.join(tmp, 'ssh-invoked')
  try {
    mkdirSync(binDir)
    const sshPath = path.join(binDir, 'ssh')
    writeFileSync(sshPath, `#!/usr/bin/env bash
touch "$FAKE_SSH_INVOKED_PATH"
exit 99
`)
    chmodSync(sshPath, 0o755)

    const result = await runResolver({
      HOME: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      ATTENDANCE_TOKEN_RESOLVE_REQUIRED: 'true',
      FAKE_SSH_INVOKED_PATH: sshInvokedPath,
      DEPLOY_HOST: 'sensitive-host.invalid',
      DEPLOY_USER: 'deployer',
      DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
      DEPLOY_KNOWN_HOSTS: 'sensitive-host.invalid ssh-ed25519 AAAAfakePinnedHostKey',
    })

    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /::error::ATTENDANCE_SMOKE_ORG_ID is required/)
    assert.doesNotMatch(result.stderr, /sensitive-host\.invalid/)
    assert.equal(existsSync(sshInvokedPath), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('attendance token resolver mints a tenant-bound token through deploy-host fallback', async () => {
  const tmp = makeTmpDir()
  const binDir = path.join(tmp, 'bin')
  const sshArgsPath = path.join(tmp, 'ssh-args')
  const sshStdinPath = path.join(tmp, 'ssh-stdin')
  const organizationId = 'synthetic-org-acceptance'
  try {
    mkdirSync(binDir)
    const sshPath = path.join(binDir, 'ssh')
    writeFileSync(sshPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$FAKE_SSH_ARGS_PATH"
cat > "$FAKE_SSH_STDIN_PATH"
printf 'header.payload.signature\\n'
`)
    chmodSync(sshPath, 0o755)

    const result = await runResolver({
      HOME: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      FAKE_SSH_ARGS_PATH: sshArgsPath,
      FAKE_SSH_STDIN_PATH: sshStdinPath,
      DEPLOY_HOST: 'deploy.example.test',
      DEPLOY_USER: 'deployer',
      DEPLOY_SSH_KEY_B64: Buffer.from('fake-key').toString('base64'),
      DEPLOY_KNOWN_HOSTS: 'deploy.example.test ssh-ed25519 AAAAfakePinnedHostKey',
      ATTENDANCE_SMOKE_ORG_ID: organizationId,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'header.payload.signature')
    assert.match(result.stderr, /token minted from deploy-host backend runtime/)
    assert.doesNotMatch(result.stderr, /header\.payload\.signature/)
    const sshArgs = readFileSync(sshArgsPath, 'utf8')
    assert.doesNotMatch(sshArgs, /\.ssh\/deploy_key/)
    assert.match(sshArgs, /ATTENDANCE_SMOKE_ORG_ID=synthetic-org-acceptance/)

    const remoteScript = readFileSync(sshStdinPath, 'utf8')
    const deployDir = path.join(tmp, 'metasheet2')
    const dockerArgsPath = path.join(tmp, 'docker-args')
    const dockerStdinPath = path.join(tmp, 'docker-stdin')
    mkdirSync(deployDir)
    const dockerPath = path.join(binDir, 'docker')
    writeFileSync(dockerPath, `#!/usr/bin/env bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  exit 0
fi
printf '%s\\n' "$@" > "$FAKE_DOCKER_ARGS_PATH"
cat > "$FAKE_DOCKER_STDIN_PATH"
printf 'header.payload.signature\\n'
`)
    chmodSync(dockerPath, 0o755)
    const remoteResult = await runBashSource(remoteScript, {
      HOME: tmp,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      DEPLOY_PATH: 'metasheet2',
      DEPLOY_COMPOSE_FILE: 'docker-compose.app.yml',
      ATTENDANCE_SMOKE_TOKEN_EXPIRY: '7m',
      ATTENDANCE_SMOKE_ORG_ID: organizationId,
      FAKE_DOCKER_ARGS_PATH: dockerArgsPath,
      FAKE_DOCKER_STDIN_PATH: dockerStdinPath,
    })
    assert.equal(remoteResult.status, 0, remoteResult.stderr)
    assert.equal(remoteResult.stdout, 'header.payload.signature\n')
    const dockerArgs = readFileSync(dockerArgsPath, 'utf8').trim().split('\n')
    assert.ok(dockerArgs.includes('env'))
    assert.ok(dockerArgs.includes('JWT_EXPIRY=7m'))
    assert.ok(dockerArgs.includes(`ATTENDANCE_SMOKE_ORG_ID=${organizationId}`))
    assert.match(readFileSync(dockerStdinPath, 'utf8'), /const organizationId = process\.env\.ATTENDANCE_SMOKE_ORG_ID/)

    const embeddedResult = await runEmbeddedNode(remoteScript, {
      organizationId,
      activeMembership: true,
    })
    assert.equal(embeddedResult.status, 0, embeddedResult.stderr)
    const evidenceLine = embeddedResult.stdout
      .split('\n')
      .find((line) => line.startsWith('__EVIDENCE__'))
    assert.ok(evidenceLine, embeddedResult.stdout)
    const evidence = JSON.parse(evidenceLine.slice('__EVIDENCE__'.length))
    assert.deepEqual(evidence.queryParams, [organizationId])
    assert.match(evidence.queryText, /JOIN user_orgs uo/)
    assert.match(evidence.queryText, /uo\.org_id = \$1/)
    assert.match(evidence.queryText, /uo\.is_active = true/)
    assert.match(evidence.queryText, /u\.is_active = true/)
    assert.equal(evidence.tokenUser.tenantId, organizationId)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('embedded deploy resolver fails closed when active organization membership is absent', async () => {
  const source = readFileSync(scriptPath, 'utf8')
  const remoteScriptMatch = source.match(/<<'EOF'\n([\s\S]*?)\nEOF/)
  assert.ok(remoteScriptMatch, 'remote SSH script was not found')
  const organizationId = 'sensitive-synthetic-org'

  const result = await runEmbeddedNode(remoteScriptMatch[1], {
    organizationId,
    activeMembership: false,
  })

  assert.equal(result.status, 4)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /No active admin membership found/)
  assert.doesNotMatch(result.stderr, new RegExp(organizationId))
})

test('attendance token resolver cleans up temporary deploy SSH key after fallback execution', async () => {
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
printf 'header.payload.signature\\n'
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
      DEPLOY_KNOWN_HOSTS: 'deploy.example.test ssh-ed25519 AAAAfakePinnedHostKey',
      ATTENDANCE_SMOKE_ORG_ID: 'synthetic-org-cleanup',
    })

    assert.equal(result.status, 0, result.stderr)
    const usedKeyPath = readFileSync(sshKeyPathFile, 'utf8').trim()
    assert.match(
      usedKeyPath,
      new RegExp(`^${tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/attendance-smoke-ssh-key\\.`),
    )
    assert.equal(existsSync(usedKeyPath), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
