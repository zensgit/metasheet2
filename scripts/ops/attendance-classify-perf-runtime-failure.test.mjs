import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'attendance-classify-perf-runtime-failure.mjs')

function runClassifier(logText) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'attendance-runtime-classify-'))
  const perfLog = path.join(tempRoot, 'perf.log')
  const outputFile = path.join(tempRoot, 'perf-runtime-failure.json')
  writeFileSync(perfLog, logText, 'utf8')

  const result = spawnSync('node', [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PERF_LOG: perfLog,
      OUTPUT_FILE: outputFile,
    },
    encoding: 'utf8',
  })

  return { ...result, outputFile }
}

test('classifier marks async commit timeout with gateway errors as runtime unstable', () => {
  const result = runClassifier([
    '[attendance-import-perf] WARN: GET /attendance/import/jobs/f0e9 returned HTTP 502; retry 1/2 in 1000ms',
    '[attendance-import-perf] Failed: async commit job poll timed out after transient errors (last status=502)',
    '[attendance-import-perf] scenario=100000-commit',
    '[attendance-import-perf] Failed: async commit job timed out',
    '',
  ].join('\n'))

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.equal(existsSync(result.outputFile), true)

  const payload = JSON.parse(readFileSync(result.outputFile, 'utf8'))
  assert.equal(payload.classification, 'async_commit_runtime_unstable')
  assert.deepEqual(
    payload.signals.sort(),
    ['async_commit_poll_timeout', 'async_commit_timeout', 'http_502'].sort(),
  )
  assert.equal(payload.failureLine, '[attendance-import-perf] Failed: async commit job timed out')
})

test('classifier marks async commit timeout without gateway evidence separately', () => {
  const result = runClassifier('[attendance-import-perf] Failed: async commit job timed out\n')

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  const payload = JSON.parse(readFileSync(result.outputFile, 'utf8'))
  assert.equal(payload.classification, 'async_commit_timeout')
  assert.deepEqual(payload.signals, ['async_commit_timeout'])
})

test('classifier skips capacity mismatch so the dedicated classifier owns that case', () => {
  const result = runClassifier('[attendance-import-perf] Failed: async commit job failed: CSV exceeds max rows (20000)\n')

  assert.notEqual(result.status, 0)
  assert.equal(existsSync(result.outputFile), false)
})
