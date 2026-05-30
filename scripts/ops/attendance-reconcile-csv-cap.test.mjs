import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'attendance-reconcile-csv-cap.sh')

function makeTmpDir() {
  return mkdtempSync(path.join(tmpdir(), 'attendance-reconcile-csv-cap-'))
}

function runScript(env = {}) {
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

test('reconciles CSV cap and normalizes literal newline env files without printing secrets', async () => {
  const tmp = makeTmpDir()
  const envFile = path.join(tmp, 'app.env')
  try {
    writeFileSync(
      envFile,
      'NODE_ENV=production\\nJWT_SECRET=\\nBCRYPT_SALT_ROUNDS=12\\nATTENDANCE_IMPORT_CSV_MAX_ROWS=20000\\n',
    )

    const result = await runScript({
      ENV_FILE: envFile,
      CSV_MAX_ROWS: '100000',
      DEPLOY_JWT_SECRET: 'secret-that-must-not-print',
      RUN_ATTENDANCE_PREFLIGHT: 'false',
      RESTART_BACKEND: 'false',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /ensured ATTENDANCE_IMPORT_CSV_MAX_ROWS=100000/)
    assert.match(result.stdout, /JWT_SECRET injected/)
    assert.match(result.stdout, /BCRYPT_SALT_ROUNDS present/)
    assert.doesNotMatch(result.stdout, /secret-that-must-not-print/)
    assert.doesNotMatch(result.stderr, /secret-that-must-not-print/)
    const envText = readFileSync(envFile, 'utf8')
    assert.match(envText, /^ATTENDANCE_IMPORT_CSV_MAX_ROWS=100000$/m)
    assert.match(envText, /^JWT_SECRET=secret-that-must-not-print$/m)
    assert.doesNotMatch(envText, /\\n/)
    assert.equal(existsSync(`${envFile}.bak.`), false)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('can ensure metrics scrape token without printing its value', async () => {
  const tmp = makeTmpDir()
  const envFile = path.join(tmp, 'app.env')
  try {
    writeFileSync(
      envFile,
      'NODE_ENV=production\nJWT_SECRET=already-strong-secret-value-123456\nBCRYPT_SALT_ROUNDS=12\n',
    )

    const result = await runScript({
      ENV_FILE: envFile,
      CSV_MAX_ROWS: '100000',
      ENSURE_METRICS_SCRAPE_TOKEN: 'true',
      DEPLOY_METRICS_SCRAPE_TOKEN: 'metrics-secret-that-must-not-print',
      RUN_ATTENDANCE_PREFLIGHT: 'false',
      RESTART_BACKEND: 'false',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /METRICS_SCRAPE_TOKEN injected/)
    assert.doesNotMatch(result.stdout, /metrics-secret-that-must-not-print/)
    assert.doesNotMatch(result.stderr, /metrics-secret-that-must-not-print/)
    const envText = readFileSync(envFile, 'utf8')
    assert.match(envText, /^METRICS_SCRAPE_TOKEN=metrics-secret-that-must-not-print$/m)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('recreates backend and verifies runtime CSV cap', async () => {
  const tmp = makeTmpDir()
  const envFile = path.join(tmp, 'app.env')
  const composeFile = path.join(tmp, 'docker-compose.yml')
  const binDir = path.join(tmp, 'bin')
  const dockerLog = path.join(tmp, 'docker.log')
  try {
    writeFileSync(envFile, 'JWT_SECRET=already-strong-secret-value-123456\nBCRYPT_SALT_ROUNDS=12\n')
    writeFileSync(composeFile, 'services:\n  backend:\n    image: test\n')
    mkdirSync(binDir)
    const dockerPath = path.join(binDir, 'docker')
    writeFileSync(dockerPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "up" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "exec" ]]; then
  printf '100000'
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 9
`)
    chmodSync(dockerPath, 0o755)

    const result = await runScript({
      PATH: `${binDir}:${process.env.PATH || ''}`,
      FAKE_DOCKER_LOG: dockerLog,
      ENV_FILE: envFile,
      COMPOSE_FILE: composeFile,
      CSV_MAX_ROWS: '100000',
      RUN_ATTENDANCE_PREFLIGHT: 'false',
      RESTART_BACKEND: 'true',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /recreating backend to apply env/)
    assert.match(result.stdout, /runtime ATTENDANCE_IMPORT_CSV_MAX_ROWS=100000/)
    const dockerCalls = readFileSync(dockerLog, 'utf8')
    assert.match(dockerCalls, /compose -f .* up -d --no-deps --force-recreate backend/)
    assert.match(dockerCalls, /compose -f .* exec -T backend sh -lc/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('verifies backend runtime metrics scrape token when requested', async () => {
  const tmp = makeTmpDir()
  const envFile = path.join(tmp, 'app.env')
  const composeFile = path.join(tmp, 'docker-compose.yml')
  const binDir = path.join(tmp, 'bin')
  try {
    writeFileSync(envFile, 'JWT_SECRET=already-strong-secret-value-123456\nBCRYPT_SALT_ROUNDS=12\n')
    writeFileSync(composeFile, 'services:\n  backend:\n    image: test\n')
    mkdirSync(binDir)
    const dockerPath = path.join(binDir, 'docker')
    writeFileSync(dockerPath, `#!/usr/bin/env bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "up" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "exec" ]]; then
  if [[ "$*" == *"METRICS_SCRAPE_TOKEN"* ]]; then
    printf 'runtime-metrics-token'
  else
    printf '100000'
  fi
  exit 0
fi
exit 9
`)
    chmodSync(dockerPath, 0o755)

    const result = await runScript({
      PATH: `${binDir}:${process.env.PATH || ''}`,
      ENV_FILE: envFile,
      COMPOSE_FILE: composeFile,
      CSV_MAX_ROWS: '100000',
      ENSURE_METRICS_SCRAPE_TOKEN: 'true',
      RUN_ATTENDANCE_PREFLIGHT: 'false',
      RESTART_BACKEND: 'true',
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /METRICS_SCRAPE_TOKEN generated and persisted/)
    assert.match(result.stdout, /runtime METRICS_SCRAPE_TOKEN present/)
    assert.doesNotMatch(result.stdout, /runtime-metrics-token/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('fails when backend runtime cap does not match the reconciled env file', async () => {
  const tmp = makeTmpDir()
  const envFile = path.join(tmp, 'app.env')
  const composeFile = path.join(tmp, 'docker-compose.yml')
  const binDir = path.join(tmp, 'bin')
  try {
    writeFileSync(envFile, 'JWT_SECRET=already-strong-secret-value-123456\nBCRYPT_SALT_ROUNDS=12\n')
    writeFileSync(composeFile, 'services:\n  backend:\n    image: test\n')
    mkdirSync(binDir)
    const dockerPath = path.join(binDir, 'docker')
    writeFileSync(dockerPath, `#!/usr/bin/env bash
if [[ "$1" == "compose" && "$2" == "version" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "up" ]]; then
  exit 0
fi
if [[ "$1" == "compose" && "$4" == "exec" ]]; then
  printf '20000'
  exit 0
fi
exit 9
`)
    chmodSync(dockerPath, 0o755)

    const result = await runScript({
      PATH: `${binDir}:${process.env.PATH || ''}`,
      ENV_FILE: envFile,
      COMPOSE_FILE: composeFile,
      CSV_MAX_ROWS: '100000',
      RUN_ATTENDANCE_PREFLIGHT: 'false',
      RESTART_BACKEND: 'true',
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /backend runtime ATTENDANCE_IMPORT_CSV_MAX_ROWS mismatch/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
