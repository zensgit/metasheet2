import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const workflowPath = path.join(repoRoot, '.github/workflows/attendance-import-perf-longrun.yml')

test('attendance import perf longrun workflow can mint auth from deploy host', () => {
  const raw = readFileSync(workflowPath, 'utf8')

  assert.match(
    raw,
    /AUTH_TOKEN:\s+\$\{\{\s*secrets\.ATTENDANCE_ADMIN_JWT\s+\|\|\s+vars\.ATTENDANCE_ADMIN_JWT\s+\|\|\s+''\s*\}\}/,
  )
  assert.match(
    raw,
    /LOGIN_EMAIL:\s+\$\{\{\s*secrets\.ATTENDANCE_ADMIN_EMAIL\s+\|\|\s+vars\.ATTENDANCE_ADMIN_EMAIL\s+\|\|\s+''\s*\}\}/,
  )
  assert.match(
    raw,
    /LOGIN_PASSWORD:\s+\$\{\{\s*secrets\.ATTENDANCE_ADMIN_PASSWORD\s+\|\|\s+vars\.ATTENDANCE_ADMIN_PASSWORD\s+\|\|\s+''\s*\}\}/,
  )
  assert.match(raw, /DEPLOY_HOST:\s+\$\{\{\s*secrets\.DEPLOY_HOST\s*\}\}/)
  assert.match(raw, /DEPLOY_USER:\s+\$\{\{\s*secrets\.DEPLOY_USER\s*\}\}/)
  assert.match(raw, /DEPLOY_SSH_KEY_B64:\s+\$\{\{\s*secrets\.DEPLOY_SSH_KEY_B64\s*\}\}/)
  assert.match(raw, /\.\/scripts\/ops\/attendance-resolve-auth\.sh/)
  assert.match(raw, /\.\/scripts\/ops\/resolve-attendance-smoke-token\.sh/)
  assert.match(raw, /deploy-host-auth-fallback\.log/)
  assert.match(raw, /AUTH_TOKEN_EFFECTIVE=\$\{resolved_token\}/)
})

test('attendance import perf longrun trend summary does not cat an empty output path', () => {
  const raw = readFileSync(workflowPath, 'utf8')

  assert.match(raw, /report_markdown="\$\{\{\s*steps\.trend\.outputs\.report_markdown\s*\}\}"/)
  assert.match(raw, /\[\[ -n "\$\{report_markdown\}" && -f "\$\{report_markdown\}" \]\]/)
  assert.match(raw, /Trend report markdown was not produced/)
  assert.doesNotMatch(raw, /cat "\$\{\{\s*steps\.trend\.outputs\.report_markdown\s*\}\}" >> "\$GITHUB_STEP_SUMMARY"/)
})
