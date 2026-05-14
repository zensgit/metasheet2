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
