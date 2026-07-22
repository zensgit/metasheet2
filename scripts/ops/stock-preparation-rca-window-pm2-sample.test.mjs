import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, 'stock-preparation-rca-window-pm2-sample.mjs')

function run(payload) {
  return spawnSync(process.execPath, [helper], { input: payload, encoding: 'utf8' })
}

function fixture(env = {}, topLevel = {}) {
  return JSON.stringify([{
    name: 'metasheet-backend',
    pm2_env: {
      status: 'online',
      restart_time: 4,
      pm_uptime: 1000,
      env,
      ...topLevel,
    },
  }])
}

test('projects only the six closed values-free fields', () => {
  const result = run(fixture({ PATH: 'secret-path', BUSINESS_VALUE: 'MAT-001' }))
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), {
    state: 'online',
    restartTime: 4,
    uptime: 1000,
    authTokenNonEmpty: false,
    adminTokenNonEmpty: false,
    plmAutoPersistEnabledTrue: false,
  })
  assert.doesNotMatch(result.stdout, /secret-path|MAT-001/)
})

test('detects case-variant token carriers on either PM2 environment bag', () => {
  const nested = JSON.parse(run(fixture({ metasheet_auth_token: 'x' })).stdout)
  const top = JSON.parse(run(fixture({}, { MeTaShEeT_AdMiN_ToKeN: 'y' })).stdout)
  assert.equal(nested.authTokenNonEmpty, true)
  assert.equal(top.adminTokenNonEmpty, true)
})

test('effective flag is true for any trimmed case-insensitive true value', () => {
  const nested = JSON.parse(run(fixture({ multitable_stock_prep_plm_autopersist_enabled: ' TRUE ' })).stdout)
  const top = JSON.parse(run(fixture({}, { MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED: 'TrUe' })).stdout)
  assert.equal(nested.plmAutoPersistEnabledTrue, true)
  assert.equal(top.plmAutoPersistEnabledTrue, true)
})

test('conflicting case variants fail safe to enabled when any variant is true', () => {
  const output = JSON.parse(run(fixture({
    MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED: 'false',
    multitable_stock_prep_plm_autopersist_enabled: 'true',
  })).stdout)
  assert.equal(output.plmAutoPersistEnabledTrue, true)
})

test('literal false, empty, and absent flag values remain off', () => {
  for (const value of ['false', ' FALSE ', '', '1']) {
    const output = JSON.parse(run(fixture({ MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED: value })).stdout)
    assert.equal(output.plmAutoPersistEnabledTrue, false)
  }
})

test('accepts the UTF-8 BOM emitted by Windows PowerShell 5.1 native stdin', () => {
  const result = run('\uFEFF' + fixture())
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(result.stdout).state, 'online')
})

test('duplicate target processes and malformed counters fail closed with no output', () => {
  const duplicate = run(JSON.stringify([JSON.parse(fixture())[0], JSON.parse(fixture())[0]]))
  const badCounter = run(fixture({}, { restart_time: '4' }))
  assert.equal(duplicate.status, 1)
  assert.equal(duplicate.stdout, '')
  assert.equal(badCounter.status, 1)
  assert.equal(badCounter.stdout, '')
})

test('unknown process state is coarsened', () => {
  const output = JSON.parse(run(fixture({}, { status: 'business-state-secret' })).stdout)
  assert.equal(output.state, 'unknown')
})
