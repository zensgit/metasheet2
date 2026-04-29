import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'attendance-remote-docker-gc-prod.yml')

test('remote Docker GC summary caps snippets without pipefail-sensitive head pipeline', () => {
  const raw = readFileSync(workflowPath, 'utf8')

  assert.ok(raw.includes('name: Attendance Remote Docker GC (Prod)'))
  assert.ok(raw.includes('set -euo pipefail'))
  assert.ok(raw.includes('^=== DOCKER GC START ===$'))
  assert.ok(raw.includes('printing && count < 120 { print; count++ }'))
  assert.ok(!raw.includes("' \"$gc_log\" | head -n 120"))
})
