import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()

const workflows = [
  '.github/workflows/attendance-branch-protection-prod.yml',
  '.github/workflows/attendance-branch-policy-drift-prod.yml',
]

const currentRequiredChecks = 'contracts (strict),contracts (dashboard),pr-validate,test (20.x),contracts (openapi)'

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

test('branch protection checker sends a single graphql query field', () => {
  const raw = readFileSync(path.join(repoRoot, 'scripts/ops/attendance-check-branch-protection.sh'), 'utf8')
  const queryFieldCount = [...raw.matchAll(/-f query=/g)].length

  assert.equal(queryFieldCount, 1)
  assert.match(raw, /requiredStatusCheckContexts/)
})

test('branch policy drift schedule fallback matches the current main protection contract', () => {
  const raw = readFileSync(
    path.join(repoRoot, '.github/workflows/attendance-branch-policy-drift-prod.yml'),
    'utf8',
  )

  assert.match(
    raw,
    new RegExp(`REQUIRED_CHECKS_CSV: \\\$\\{\\{ inputs\\.required_checks_csv \\|\\| '${currentRequiredChecks.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' \\}\\}`),
  )
  assert.match(raw, /REQUIRE_PR_REVIEWS:\s+\$\{\{\s*inputs\.require_pr_reviews\s+\|\|\s+'false'\s*\}\}/)
})

test('post-merge verifier dispatches current shared-prod policy defaults', () => {
  const raw = readFileSync(
    path.join(repoRoot, 'scripts/ops/attendance-post-merge-verify.sh'),
    'utf8',
  )

  assert.match(raw, new RegExp(`REQUIRED_CHECKS_CSV="\\$\\{REQUIRED_CHECKS_CSV:-${currentRequiredChecks.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}"`))
  assert.match(raw, /REQUIRE_PR_REVIEWS="\$\{REQUIRE_PR_REVIEWS:-false\}"/)
  assert.match(raw, /EXPECT_PRODUCT_MODE="\$\{EXPECT_PRODUCT_MODE:-platform\}"/)
  assert.doesNotMatch(raw, /REQUIRE_PR_REVIEWS="\$\{REQUIRE_PR_REVIEWS:-true\}"/)
  assert.doesNotMatch(raw, /EXPECT_PRODUCT_MODE="\$\{EXPECT_PRODUCT_MODE:-attendance\}"/)
})
