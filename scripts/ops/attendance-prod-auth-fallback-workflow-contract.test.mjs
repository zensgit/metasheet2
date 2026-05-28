import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

const cases = [
  {
    workflow: '.github/workflows/attendance-strict-gates-prod.yml',
    outputDir: 'output/playwright/attendance-prod-acceptance',
    marker: 'attendance-strict-gates',
  },
  {
    workflow: '.github/workflows/attendance-import-perf-baseline.yml',
    outputDir: 'output/playwright/attendance-import-perf',
    marker: 'attendance-import-perf',
  },
  {
    workflow: '.github/workflows/attendance-import-perf-highscale.yml',
    outputDir: 'output/playwright/attendance-import-perf-highscale',
    marker: 'attendance-import-perf-highscale',
  },
]

for (const item of cases) {
  test(`${item.workflow} can mint attendance auth from deploy host`, () => {
    const raw = readFileSync(path.join(repoRoot, item.workflow), 'utf8')

    assert.match(
      raw,
      /AUTH_TOKEN:\s+\$\{\{\s*secrets\.ATTENDANCE_ADMIN_JWT\s+\|\|\s+vars\.ATTENDANCE_ADMIN_JWT\s+\|\|\s+''\s*\}\}/,
    )
    assert.match(raw, /DEPLOY_HOST:\s+\$\{\{\s*secrets\.DEPLOY_HOST\s*\}\}/)
    assert.match(raw, /DEPLOY_USER:\s+\$\{\{\s*secrets\.DEPLOY_USER\s*\}\}/)
    assert.match(raw, /DEPLOY_SSH_KEY_B64:\s+\$\{\{\s*secrets\.DEPLOY_SSH_KEY_B64\s*\}\}/)
    assert.match(raw, /DEPLOY_PATH:\s+\$\{\{\s*secrets\.DEPLOY_PATH\s*\}\}/)
    assert.match(raw, /DEPLOY_COMPOSE_FILE:\s+\$\{\{\s*secrets\.DEPLOY_COMPOSE_FILE\s*\}\}/)
    assert.match(raw, new RegExp(`${item.outputDir}/deploy-host-auth-fallback\\.log`))
    assert.match(raw, new RegExp(`\\[${item.marker}\\] configured auth failed; trying deploy-host token fallback`))
    assert.match(raw, /\.\/scripts\/ops\/attendance-resolve-auth\.sh/)
    assert.match(raw, /\.\/scripts\/ops\/resolve-attendance-smoke-token\.sh/)
    assert.match(raw, /\.\/scripts\/ops\/attendance-write-auth-error\.sh/)
    assert.match(raw, /ATTENDANCE_TOKEN_RESOLVE_REQUIRED=false/)
    assert.match(raw, /AUTH_TOKEN_EFFECTIVE=\$\{resolved_token\}/)
  })
}
