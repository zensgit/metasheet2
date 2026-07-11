import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8')

const productionFlow = read('scripts/verify-attendance-production-flow.mjs')
const fullFlow = read('scripts/verify-attendance-full-flow.mjs')
const attendanceView = read('apps/web/src/views/AttendanceView.vue')
const gateContractRunner = read('scripts/ops/attendance-run-gate-contract-case.sh')

function functionSlice(raw, name, nextDeclaration) {
  const start = raw.indexOf(`async function ${name}`)
  const end = raw.indexOf(`\n${nextDeclaration}`, start + 1)
  assert.notEqual(start, -1, `${name} must exist`)
  assert.ok(end > start, `${name} must have a bounded function body`)
  return raw.slice(start, end)
}

test('attendance import payload remains inside the collapsed advanced panel contract', () => {
  const toggle = attendanceView.indexOf('data-testid="attendance-import-advanced-toggle"')
  const advanced = attendanceView.indexOf('data-testid="attendance-import-advanced"', toggle + 1)
  const payload = attendanceView.indexOf('id="attendance-import-payload"', advanced + 1)

  assert.notEqual(toggle, -1)
  assert.notEqual(advanced, -1)
  assert.notEqual(payload, -1)
  assert.ok(toggle < advanced)
  assert.ok(advanced < payload)
  assert.match(attendanceView.slice(advanced - 120, advanced + 120), /v-show="importAdvancedOpen"/)
})

for (const [name, raw] of [
  ['production flow', productionFlow],
  ['full flow', fullFlow],
]) {
  test(`${name} expands advanced import options before using the payload`, () => {
    const helper = functionSlice(raw, 'ensureImportAdvancedOptionsVisible', name === 'production flow'
      ? 'async function waitForJsonResponse'
      : 'function squashWhitespace')

    assert.match(helper, /payloadInput\.isVisible\(\)\.catch/)
    assert.match(helper, /attendance-import-advanced-toggle/)
    assert.match(helper, /const expanded = await toggle\.getAttribute\('aria-expanded'\)/)
    assert.match(helper, /if \(expanded !== 'true'\)/)
    assert.match(helper, /await toggle\.click\(\)/)
    assert.match(helper, /attendance-import-advanced/)
    assert.match(helper, /payloadInput\.waitFor\(\{ state: 'visible', timeout: waitMs \}\)/)
    assert.match(helper, /return payloadInput/)
  })
}

test('production flow opens advanced options after loading the import template', () => {
  const loadTemplate = productionFlow.indexOf("uiText.loadTemplate) }).click()")
  const expand = productionFlow.indexOf('await ensureImportAdvancedOptionsVisible(importSection)', loadTemplate)
  const buildCsv = productionFlow.indexOf('// Prepare a tiny CSV', loadTemplate)

  assert.notEqual(loadTemplate, -1)
  assert.notEqual(expand, -1)
  assert.notEqual(buildCsv, -1)
  assert.ok(loadTemplate < expand)
  assert.ok(expand < buildCsv)
})

test('full flow opens advanced options in retry and recovery entry points', () => {
  const retry = functionSlice(fullFlow, 'assertAdminRetryState', 'async function assertAdminSettingsSaveCycle')
  const recovery = functionSlice(fullFlow, 'assertImportJobRecoveryFlow', 'async function run')

  assert.match(retry, /const payloadInput = await ensureImportAdvancedOptionsVisible\(importSection\)/)
  assert.match(recovery, /const payloadInput = await ensureImportAdvancedOptionsVisible\(importSection\)/)
})

test('required strict contract case executes this verifier contract', () => {
  const strictCase = gateContractRunner.slice(
    gateContractRunner.indexOf('if [[ "$CASE_ID" == "strict" ]]'),
    gateContractRunner.indexOf('if [[ "$CASE_ID" == "openapi" ]]'),
  )

  assert.match(strictCase, /node --test \.\/scripts\/ops\/attendance-strict-import-advanced-contract\.test\.mjs/)
})
