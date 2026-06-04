import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = path.join(repoRoot, 'scripts', 'ops', 'attendance-check-metrics.sh')

const metricsFixture = [
  '# HELP attendance_api_errors_total Total attendance API errors',
  '# TYPE attendance_api_errors_total counter',
  '# HELP attendance_rate_limited_total Total attendance rate-limited requests',
  '# TYPE attendance_rate_limited_total counter',
  '# HELP attendance_operation_requests_total Total attendance operation requests',
  '# TYPE attendance_operation_requests_total counter',
  '# HELP attendance_operation_latency_seconds Attendance operation latency',
  '# TYPE attendance_operation_latency_seconds histogram',
  '# HELP attendance_import_upload_bytes_total Total attendance upload bytes',
  '# TYPE attendance_import_upload_bytes_total counter',
  '# HELP attendance_import_upload_rows_total Total attendance upload rows',
  '# TYPE attendance_import_upload_rows_total counter',
].join('\n')

function runCheck(env = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'attendance-check-metrics-'))
  const binDir = path.join(tmp, 'bin')
  const argsPath = path.join(tmp, 'curl-args.txt')
  mkdirSync(binDir)
  const curlPath = path.join(binDir, 'curl')
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FAKE_CURL_ARGS_PATH"
cat <<'EOF'
${metricsFixture}
EOF
`,
    'utf8',
  )
  chmodSync(curlPath, 0o755)

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: `${binDir}:${process.env.PATH || ''}`,
        HOME: process.env.HOME || '',
        FAKE_CURL_ARGS_PATH: argsPath,
        METRICS_URL: 'http://127.0.0.1:8900/metrics/prom',
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
      let args = ''
      try {
        args = readFileSync(argsPath, 'utf8')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
      resolve({ status, stdout, stderr, args })
    })
  })
}

test('attendance metrics check passes configured auth header to curl', async () => {
  const result = await runCheck({
    METRICS_AUTH_HEADER: 'Authorization: Bearer metrics-secret',
    METRICS_SCRAPE_TOKEN: 'unused-token',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Using metrics auth header/)
  assert.match(result.args, /^-H$/m)
  assert.match(result.args, /^Authorization: Bearer metrics-secret$/m)
  assert.doesNotMatch(result.args, /unused-token/)
})

test('attendance metrics check falls back to x-metrics-token when no auth header exists', async () => {
  const result = await runCheck({
    METRICS_SCRAPE_TOKEN: 'metrics-secret',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Using metrics scrape token/)
  assert.match(result.args, /^-H$/m)
  assert.match(result.args, /^x-metrics-token: metrics-secret$/m)
})
