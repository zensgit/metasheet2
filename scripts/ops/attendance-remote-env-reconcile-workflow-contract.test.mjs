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

test('remote env reconcile can ensure metrics scrape token for Phase 5 fallback', () => {
  const raw = readFileSync(workflowPath, 'utf8')

  assert.match(raw, /ensure_metrics_scrape_token:/)
  assert.match(raw, /ENSURE_METRICS_SCRAPE_TOKEN: \$\{\{ github\.event\.inputs\.ensure_metrics_scrape_token \|\| 'true' \}\}/)
  assert.match(raw, /DEPLOY_METRICS_SCRAPE_TOKEN: \$\{\{ secrets\.METRICS_SCRAPE_TOKEN \|\| '' \}\}/)
  assert.match(raw, /ENSURE_METRICS_SCRAPE_TOKEN="\$\{ENSURE_METRICS_SCRAPE_TOKEN\}"/)
  assert.match(raw, /Ensure metrics scrape token:/)
})
