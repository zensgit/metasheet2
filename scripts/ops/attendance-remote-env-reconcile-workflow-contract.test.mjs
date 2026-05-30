import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'attendance-remote-env-reconcile-prod.yml')

test('remote env reconcile applies CSV cap through the shared runtime verifier', () => {
  const raw = readFileSync(workflowPath, 'utf8')

  assert.match(raw, /scripts\/ops\/attendance-reconcile-csv-cap\.sh/)
  assert.match(raw, /RESTART_BACKEND=true/)
  assert.match(raw, /CSV_MAX_ROWS="\$\{CSV_MAX_ROWS\}"/)
  assert.doesNotMatch(raw, /ERROR: failed to verify \$\{key\} in \$\{env_file\}/)
  assert.doesNotMatch(raw, /python3 - "\$env_file" "\$\{value\}"/)
})
