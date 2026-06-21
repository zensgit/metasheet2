import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const WORKFLOW_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'attendance-import-perf-highscale.yml')

function workflowRaw() {
  return readFileSync(WORKFLOW_PATH, 'utf8')
}

test('highscale workflow keeps capacity mismatch as the first classifier', () => {
  const raw = workflowRaw()
  const capacityIndex = raw.indexOf('attendance-classify-perf-capacity-mismatch.mjs')
  const runtimeIndex = raw.indexOf('attendance-classify-perf-runtime-failure.mjs')

  assert.ok(capacityIndex > 0, 'capacity classifier missing')
  assert.ok(runtimeIndex > 0, 'runtime classifier missing')
  assert.ok(capacityIndex < runtimeIndex, 'capacity classifier must run before runtime classifier')
  assert.match(raw, /mismatch_file="\$\{log_dir\}\/perf-capacity-mismatch\.json"/)
})

test('highscale workflow writes runtime classification into issue output and artifacts', () => {
  const raw = workflowRaw()

  assert.match(raw, /runtime_file="\$\{log_dir\}\/perf-runtime-failure\.json"/)
  assert.match(raw, /echo "classification=\$\{runtime_classification\}" >> "\$GITHUB_OUTPUT"/)
  assert.match(raw, /High-scale perf benchmark classified as runtime failure\./)
  assert.match(raw, /PERF_CLASSIFICATION: \$\{\{ needs\.perf\.outputs\.classification \|\| '' \}\}/)
})

test('highscale workflow writes perf-summary.json under the uploaded artifact tree', () => {
  const raw = workflowRaw()

  assert.match(raw, /OUTPUT_DIR="\$\{log_dir\}"/)
  assert.match(raw, /output\/playwright\/attendance-import-perf-highscale\/\*\*/)
  assert.doesNotMatch(raw, /run_once "\$attempt[12]_log" node \.\/scripts\/ops\/attendance-import-perf\.mjs/)
})
