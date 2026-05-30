import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const workflowPaths = [
  '.github/workflows/phase5-nightly-validation-regression.yml',
  '.github/workflows/phase5-nightly-validation.yml',
  '.github/workflows/phase5-nightly.yml',
]

function readWorkflow(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

for (const workflowPath of workflowPaths) {
  test(`${workflowPath} derives app metrics auth from deploy-host METRICS_SCRAPE_TOKEN`, () => {
    const raw = readWorkflow(workflowPath)

    assert.match(raw, /DEPLOY_HOST:\s+\$\{\{\s*secrets\.DEPLOY_HOST\s*\}\}/)
    assert.match(raw, /DEPLOY_USER:\s+\$\{\{\s*secrets\.DEPLOY_USER\s*\}\}/)
    assert.match(raw, /DEPLOY_SSH_KEY_B64:\s+\$\{\{\s*secrets\.DEPLOY_SSH_KEY_B64\s*\}\}/)
    assert.match(raw, /METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED=false\s+bash scripts\/ops\/resolve-metrics-scrape-token\.sh/)
    assert.match(raw, /AUTH_HEADER="Authorization: Bearer \$metrics_token"/)
    assert.match(raw, /METRICS_AUTH_HEADER=\$AUTH_HEADER/)
    assert.doesNotMatch(raw, /ATTENDANCE_ADMIN_JWT/)
    assert.doesNotMatch(raw, /Authorization: Bearer \$ATTENDANCE_ADMIN_JWT/)
  })
}

test('regression workflow uploads deploy-host metrics token fallback diagnostics', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /\/tmp\/phase5-metrics-token-fallback\.log/)
})
