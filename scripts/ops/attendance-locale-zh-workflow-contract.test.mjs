import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const workflowPath = path.join(repoRoot, '.github/workflows/attendance-locale-zh-smoke-prod.yml')

test('attendance locale zh smoke workflow resolves auth before real smoke', () => {
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
  assert.match(raw, /AUTH_RESOLVE_ALLOW_INSECURE_HTTP:/)
  assert.match(raw, /DEPLOY_HOST:\s+\$\{\{\s*secrets\.DEPLOY_HOST\s*\}\}/)
  assert.match(raw, /DEPLOY_USER:\s+\$\{\{\s*secrets\.DEPLOY_USER\s*\}\}/)
  assert.match(raw, /DEPLOY_SSH_KEY_B64:\s+\$\{\{\s*secrets\.DEPLOY_SSH_KEY_B64\s*\}\}/)
  assert.match(raw, /- name: Resolve valid auth token/)
  assert.match(raw, /\.\/scripts\/ops\/attendance-resolve-auth\.sh/)
  assert.match(raw, /\.\/scripts\/ops\/resolve-attendance-smoke-token\.sh/)
  assert.match(raw, /\.\/scripts\/ops\/attendance-write-auth-error\.sh/)
  assert.match(raw, /AUTH_TOKEN_EFFECTIVE=\$\{resolved_token\}/)
  assert.match(raw, /AUTH_TOKEN:\s+\$\{\{\s+env\.AUTH_TOKEN_EFFECTIVE\s+\}\}/)
  assert.match(raw, /output\/playwright\/attendance-locale-zh-smoke\/auth-error\.txt/)
  assert.match(raw, /deploy-host-auth-fallback\.log/)
})

test('attendance locale zh smoke workflow keeps drill before resolver and real smoke', () => {
  const raw = readFileSync(workflowPath, 'utf8')
  const drillIndex = raw.indexOf('- name: Drill failure injection')
  const installIndex = raw.indexOf('- name: Install dependencies')
  const resolverIndex = raw.indexOf('- name: Resolve valid auth token')
  const smokeIndex = raw.indexOf('- name: Run zh locale smoke')

  assert.notEqual(drillIndex, -1)
  assert.notEqual(installIndex, -1)
  assert.notEqual(resolverIndex, -1)
  assert.notEqual(smokeIndex, -1)
  assert.ok(drillIndex < installIndex)
  assert.ok(installIndex < resolverIndex)
  assert.ok(resolverIndex < smokeIndex)
  assert.match(raw, /if:\s+\$\{\{\s+env\.DRILL_FAIL != 'true'\s+\}\}\n\s+id: resolve-auth-token/)
  assert.match(raw, /if:\s+\$\{\{\s+env\.DRILL_FAIL != 'true'\s+\}\}\n\s+env:\n\s+AUTH_TOKEN:/)
})

test('attendance locale zh smoke waits for async holiday badges while probing months', () => {
  const raw = readFileSync(path.join(repoRoot, 'scripts/verify-attendance-locale-zh-smoke.mjs'), 'utf8')

  assert.match(raw, /const holidayBadgeProbeWaitMsRaw = Number\(process\.env\.HOLIDAY_BADGE_WAIT_MS \|\| 10000\)/)
  assert.match(raw, /const holidayBadgeProbeWaitMs = Number\.isFinite\(holidayBadgeProbeWaitMsRaw\) && holidayBadgeProbeWaitMsRaw > 0/)
  assert.match(raw, /await target\.waitFor\(\{ timeout: holidayBadgeProbeWaitMs \}\)/)
  assert.match(raw, /await target\.first\(\)\.waitFor\(\{ timeout: holidayBadgeProbeWaitMs \}\)/)
})

// A10 (A-class batch 2, 2026-08-22): `Attendance Locale zh Smoke (Prod)` has failed on every run
// since 2026-07-23 waiting on `#attendance-from-date` — #4501 (8112810cd2, 2026-07-21) moved the
// date/org/user history filters inside a collapsed-by-default <details data-attendance-history-filters>
// disclosure that the probe never opens. Pin BOTH halves of the fix so a rename on either side
// breaks this test instead of silently reopening the gap: the probe script must open the
// disclosure by its data-attendance-history-filters hook before waiting on the filter fields, and
// the product file must still carry that same hook on a real <details>/<summary> pair for the
// probe to find.
test('attendance locale zh smoke expands the collapsed history-filters disclosure before waiting on the filter fields', () => {
  const scriptRaw = readFileSync(path.join(repoRoot, 'scripts/verify-attendance-locale-zh-smoke.mjs'), 'utf8')

  assert.match(scriptRaw, /async function expandHistoryFilters\(page, timeout = timeoutMs\) \{/)
  assert.match(scriptRaw, /page\.locator\('\[data-attendance-history-filters\]'\)/)
  assert.match(scriptRaw, /await details\.locator\('summary'\)\.first\(\)\.click\(\)/)
  // called before the #attendance-from-date wait it exists to unblock, not after.
  const expandCallIndex = scriptRaw.indexOf('await expandHistoryFilters(page)')
  const fromDateWaitIndex = scriptRaw.indexOf("await page.locator('#attendance-from-date').waitFor(")
  assert.notEqual(expandCallIndex, -1, 'expected a call to expandHistoryFilters(page)')
  assert.notEqual(fromDateWaitIndex, -1, 'expected the #attendance-from-date waitFor this fix unblocks')
  assert.ok(expandCallIndex < fromDateWaitIndex, 'expandHistoryFilters must run before the #attendance-from-date wait')
})

test('AttendanceEmployeeWorkspace still exposes the data-attendance-history-filters hook the probe pins', () => {
  const componentPath = path.join(repoRoot, 'apps/web/src/views/attendance/AttendanceEmployeeWorkspace.vue')
  const raw = readFileSync(componentPath, 'utf8')

  assert.match(raw, /<details class="attendance-ew__history-filters" data-attendance-history-filters>/)
  // the disclosure must still open via its own <summary>, not via a v-bind default the product
  // side could flip silently — this fix does not touch that default-open decision.
  const detailsIndex = raw.indexOf('data-attendance-history-filters')
  const summaryIndex = raw.indexOf('<summary', detailsIndex)
  const closeIndex = raw.indexOf('</details>', detailsIndex)
  assert.notEqual(detailsIndex, -1)
  assert.notEqual(summaryIndex, -1)
  assert.notEqual(closeIndex, -1)
  assert.ok(summaryIndex > detailsIndex && summaryIndex < closeIndex, 'expected a <summary> inside the data-attendance-history-filters <details>')
  assert.doesNotMatch(
    raw.slice(detailsIndex - 80, detailsIndex),
    /:open=|v-bind:open=/,
    'the <details> default-open state must stay a static (owner) decision, not something this fix silently flips',
  )
})
