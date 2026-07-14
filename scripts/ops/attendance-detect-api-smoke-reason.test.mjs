import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
)
const SCRIPT_PATH = path.join(
  ROOT_DIR,
  'scripts',
  'ops',
  'attendance-detect-api-smoke-reason.sh',
)

function detectReason(logText) {
  const tempRoot = mkdtempSync(
    path.join(os.tmpdir(), 'attendance-api-smoke-reason-'),
  )
  const logPath = path.join(tempRoot, 'gate-api-smoke.log')
  writeFileSync(logPath, logText, 'utf8')

  return spawnSync('bash', [SCRIPT_PATH, logPath], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  })
}

test('classifies a duplicate request caused by a reused smoke work date', () => {
  const result = detectReason(
    '[attendance-smoke-api] Failed: POST /attendance/requests: HTTP 409 {"ok":false,"error":{"code":"DUPLICATE_REQUEST"}}\n',
  )

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.equal(result.stdout.trim(), 'REQUEST_DATE_COLLISION')
})

test('classifies exhausted deterministic date candidates as a request collision', () => {
  const result = detectReason(
    '[attendance-smoke-api] Failed: No available smoke work date found across 1 deterministic candidate(s)\n',
  )

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.equal(result.stdout.trim(), 'REQUEST_DATE_COLLISION')
})

test('keeps unmatched API smoke failures explicitly unknown', () => {
  const result = detectReason(
    '[attendance-smoke-api] Failed: unexpected response\n',
  )

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
  assert.equal(result.stdout.trim(), 'UNKNOWN')
})
