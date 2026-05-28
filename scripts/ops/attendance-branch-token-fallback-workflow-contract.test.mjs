import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

const workflows = [
  '.github/workflows/attendance-branch-protection-prod.yml',
  '.github/workflows/attendance-branch-policy-drift-prod.yml',
]

for (const workflow of workflows) {
  test(`${workflow} retries with github.token when configured token is stale`, () => {
    const raw = readFileSync(path.join(repoRoot, workflow), 'utf8')

    assert.match(raw, /GH_TOKEN:\s+\$\{\{\s*secrets\.ATTENDANCE_ADMIN_GH_TOKEN\s+\|\|\s+github\.token\s*\}\}/)
    assert.match(raw, /GH_TOKEN_FALLBACK:\s+\$\{\{\s*github\.token\s*\}\}/)
    assert.match(raw, /run_check_once\(\)\s+\{/)
    assert.match(raw, /grep -Eqi "Bad credentials\|HTTP 401" "\$log_file"/)
    assert.match(raw, /retrying with github\.token fallback/)
    assert.match(raw, /run_check_once "\$\{GH_TOKEN_FALLBACK\}" "github-token-fallback"/)
  })
}
