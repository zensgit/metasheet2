import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  STAMP_PATTERN,
  isStampedId,
  jwtSubject,
  assertNotAdminRoleId,
  resolveEnvConfig,
} from './staging-tasks-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'staging-tasks-smoke.mjs')

test('node --check parses the smoke script', () => {
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, `node --check failed: ${result.stderr}`)
})

test('tasks env contract: BASE_URL/DATABASE_URL/DEPLOY_SHA required, STAMP regex-locked, defaults applied', () => {
  const missing = resolveEnvConfig({})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((msg) => msg.includes('BASE_URL and DATABASE_URL')))
  assert.ok(missing.errors.some((msg) => msg.includes('DEPLOY_SHA is required')))

  const placeholder = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: '<fill-from-staging-build>',
  })
  assert.equal(placeholder.ok, false)
  assert.ok(placeholder.errors.some((msg) => msg.includes('DEPLOY_SHA is required')))

  const good = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082/',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
  })
  assert.equal(good.ok, true)
  assert.equal(good.config.baseUrl, 'http://127.0.0.1:8082', 'trailing slash stripped')
  assert.equal(good.config.orgId, 'default', 'org defaults to the SAME deterministic org every other window smoke uses')
  assert.match(good.config.stamp, STAMP_PATTERN)
  assert.ok(good.config.stamp.startsWith('tasks-smoke-'))

  const badStamp = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    STAMP: 'mp6-smoke-wrong-family',
  })
  assert.equal(badStamp.ok, false)
  assert.ok(badStamp.errors.some((msg) => msg.includes('STAMP must match')))
})

test('STAMP_PATTERN only accepts the tasks-smoke- family', () => {
  assert.match('tasks-smoke-gh123456789a1', STAMP_PATTERN)
  assert.doesNotMatch('mp6-smoke-gh123456789a1', STAMP_PATTERN)
  assert.doesNotMatch('tasks-smoke-', STAMP_PATTERN)
})

test('isStampedId requires the exact prefix plus a nonempty suffix', () => {
  assert.equal(isStampedId('tasks-smoke-gh1a1', 'tasks-smoke-'), true)
  assert.equal(isStampedId('tasks-smoke-', 'tasks-smoke-'), false)
  assert.equal(isStampedId('other-gh1a1', 'tasks-smoke-'), false)
  assert.equal(isStampedId(null, 'tasks-smoke-'), false)
})

test('jwtSubject reads id/sub/userId out of an unsigned-inspection JWT payload', () => {
  const payload = Buffer.from(JSON.stringify({ id: 'tasks-smoke-gh1a1' })).toString('base64url')
  const token = `header.${payload}.sig`
  assert.equal(jwtSubject(token), 'tasks-smoke-gh1a1')
  assert.equal(jwtSubject('not-a-jwt'), null)
  assert.equal(jwtSubject(''), null)
})

test('assertNotAdminRoleId refuses a role id ending "_admin" — the exact escalation shape namespace-admission.ts treats as implicit delegated-admin control', () => {
  assert.equal(assertNotAdminRoleId('tasks-smoke-gh1a1-role'), 'tasks-smoke-gh1a1-role')
  assert.throws(() => assertNotAdminRoleId('tasks_admin'), /refusing to use a role id ending "_admin"/)
  assert.throws(() => assertNotAdminRoleId('tasks-smoke-gh1a1_admin'), /refusing to use a role id ending "_admin"/)
})

test('MUTATION: a role id ending "_admin" reaching the smoke\'s own ROLE_ID computation would be caught at construction, not silently used', () => {
  // The smoke script computes ROLE_ID = assertNotAdminRoleId(`${STAMP}-role`) at module scope —
  // this test pins that the guard function itself throws for the exact family the smoke would
  // otherwise construct if a future edit dropped the "-role" suffix in favor of something that
  // could end in "_admin" (e.g. a hypothetical `${STAMP}-tasks_admin`).
  assert.throws(() => assertNotAdminRoleId(`tasks-smoke-gh1a1-tasks_admin`), /refusing to use a role id ending "_admin"/)
})
