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
    assert.match(raw, /\$\{METASHEET_BASE_URL%\/\}\/metrics\/prom/)
    assert.doesNotMatch(raw, /\/api\/metrics\/prom/)
    assert.doesNotMatch(raw, /ATTENDANCE_ADMIN_JWT/)
    assert.doesNotMatch(raw, /Authorization: Bearer \$ATTENDANCE_ADMIN_JWT/)
  })
}

test('regression workflow uploads deploy-host metrics token fallback diagnostics', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /\/tmp\/phase5-metrics-token-fallback\.log/)
})

test('regression workflow resolves a valid nightly PR branch name', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /id: nightly_date/)
  assert.match(raw, /echo "date=\$\(date -u '\+%Y%m%d'\)" >> "\$GITHUB_OUTPUT"/)
  assert.match(raw, /branch: chore\/phase5-nightly-\$\{\{ steps\.nightly_date\.outputs\.date \}\}/)
  assert.doesNotMatch(raw, /branch: chore\/phase5-nightly-\$\(date/)
})

test('regression workflow can write nightly artifact pull requests', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /\npermissions:\n  contents: write\n  pull-requests: write\n/)
  assert.match(raw, /uses: peter-evans\/create-pull-request@v5/)
})

test('regression workflow limits nightly artifact PR contents', () => {
  const raw = readWorkflow('.github/workflows/phase5-nightly-validation-regression.yml')

  assert.match(raw, /add-paths:\s+\|\n\s+results\/nightly\/\*\.json\n\s+claudedocs\/PHASE5_WEEKLY_TREND\.md\n\s+claudedocs\/PHASE5_SLO_SUGGESTIONS\.json/)
  assert.doesNotMatch(raw, /add-paths:[\s\S]*node_modules/)
  assert.doesNotMatch(raw, /add-paths:[\s\S]*package\.json/)
})

test('baseline rotation workflow pins pnpm before installing dependencies', () => {
  const raw = readWorkflow('.github/workflows/phase5-baseline-rotation.yml')

  assert.match(raw, /node-version:\s+'18'/)
  assert.match(raw, /corepack enable/)
  assert.match(raw, /corepack prepare pnpm@10\.16\.1 --activate/)
  assert.match(raw, /pnpm install --frozen-lockfile/)
})

test('attendance remote metrics reuses metrics scrape auth fallback', () => {
  const raw = readWorkflow('.github/workflows/attendance-remote-metrics-prod.yml')

  assert.match(raw, /uses: actions\/checkout@v4/)
  assert.match(raw, /METRICS_AUTH_HEADER_SECRET:\s+\$\{\{\s*secrets\.METRICS_AUTH_HEADER\s*\}\}/)
  assert.match(raw, /DEPLOY_COMPOSE_FILE:\s+\$\{\{\s*secrets\.DEPLOY_COMPOSE_FILE\s*\}\}/)
  assert.match(raw, /METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED=false bash scripts\/ops\/resolve-metrics-scrape-token\.sh/)
  assert.match(raw, /METRICS_AUTH_HEADER="Authorization: Bearer \$metrics_token"/)
  assert.match(raw, /METRICS_AUTH_HEADER=\$\(quote_for_remote "\$\{METRICS_AUTH_HEADER\}"\)/)
  assert.match(raw, /METRICS_AUTH_HEADER="\$\{METRICS_AUTH_HEADER\}" scripts\/ops\/attendance-check-metrics\.sh/)
  assert.match(raw, /metrics_auth_configured/)
  assert.doesNotMatch(raw, /ATTENDANCE_ADMIN_JWT/)
})
