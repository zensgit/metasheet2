'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createStockPreparationAuditStore } = require('../lib/stock-preparation-audit-store.cjs')
const { lockProjectActivity, withProjectDeleteActivity } = require('../lib/stock-preparation-project-delete-activity.cjs')

// The Pg acceptance fixture runs the real collectors. These tests isolate the transaction and
// exercise its binding, error consumption, revalidation and audit with deterministic planner rows.
function loadService() {
  const stubs = new Map()
  for (const [part, key] of [['sheets', 'Sheets'], ['business', 'Business'], ['runtime', 'Runtime']]) {
    const path = require.resolve(`../lib/stock-preparation-project-delete-${part}.cjs`)
    stubs.set(path, require.cache[path])
    require.cache[path] = { exports: {
      [`plan${key}`]: async tx => {
        const [row] = await tx.query('plan ' + part)
        return { identityPresent: !!row, fingerprint: row?.fingerprint || 'empty', tables: [], counts: { [part]: row ? 1 : 0 } }
      },
      [`delete${key}`]: async tx => tx.query('delete ' + part),
      SHEET_LOCK_TABLES: ['meta_records'], BUSINESS_LOCK_TABLES: ['integration_stock_prep_handoff'],
      existsProjectRoot: async tx => (await tx.query('plan sheets')).length > 0,
    } }
  }
  try { return require('../lib/stock-preparation-project-delete.cjs').createStockPreparationProjectDelete } finally {
    for (const [path, original] of stubs) {
      if (original) require.cache[path] = original
      else delete require.cache[path]
    }
  }
}
const createService = loadService()
const scope = { tenantId: 'T', projectNo: 'P', actor: 'A' }
const codes = { busy: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY', stale: 'STOCK_PREPARATION_PROJECT_DELETE_STALE', challenge: 'STOCK_PREPARATION_PROJECT_DELETE_CHALLENGE_INVALID', failed: 'STOCK_PREPARATION_PROJECT_DELETE_FAILED' }

function fixture() {
  const h = { data: { sheets: 'one', business: 'two', runtime: 'three', audit: [], claims: [] }, mayDelete: true, now: Date.now(), events: [] }
  const database = {
    async transaction(run) {
      const data = structuredClone(h.data)
      const result = await run({ async query(sql, params) {
        h.events.push(sql)
        if (sql.startsWith('SET ')) return []
        if (h.dbDenied) {
          assert.ok(h.events.includes('SET LOCAL row_security = off'))
          throw Object.assign(new Error('sensitive role details'), { code: '42501' })
        }
        if (sql.startsWith('SELECT pg_try')) return [{ locked: !h.locked }]
        if (sql.startsWith('LOCK TABLE')) {
          assert.match(sql, /"plugin_kv" IN EXCLUSIVE MODE NOWAIT$/)
          if (h.sqlBusy) throw Object.assign(new Error('SQL values must be hidden'), { code: '55P03' })
          return []
        }
        if (sql.startsWith('plan ')) {
          const fp = data[sql.slice(5)]
          return fp ? [{ fingerprint: fp }] : []
        }
        if (sql.startsWith('delete ')) {
          if (sql === h.failAt) throw new Error('sensitive storage message')
          delete data[sql.slice(7)]
          return []
        }
        if (sql.startsWith('INSERT INTO integration_stock_prep_project_delete_challenges')) {
          const [id, tenant, project, actor, fingerprint, code_digest, ttl] = params
          const expires_at = new Date(h.now + ttl * 1000).toISOString()
          data.claims = data.claims.filter(c => !(c.tenant === tenant && c.project === project && c.actor === actor))
          data.claims.push({ id, tenant, project, actor, fingerprint, code_digest, expires_at })
          return [{ expires_at }]
        }
        if (sql.startsWith('DELETE FROM integration_stock_prep_project_delete_challenges WHERE id IN')) return []
        if (sql.startsWith('DELETE FROM integration_stock_prep_project_delete_challenges')) {
          assert.match(sql, /WHERE id = \$1 AND tenant_id = \$2 AND project_no = \$3 AND actor = \$4 AND expires_at > clock_timestamp\(\)/)
          const [id, tenant, project, actor] = params
          const ix = data.claims.findIndex(c => c.id === id && c.tenant === tenant && c.project === project && c.actor === actor && Date.parse(c.expires_at) > h.now)
          return ix < 0 ? [] : data.claims.splice(ix, 1)
        }
        if (sql.startsWith('INSERT INTO "integration_stock_prep_audit"')) {
          if (h.failAt === 'audit') throw new Error('sensitive audit error')
          if (h.failAt === 'suppressed_audit') return []
          data.audit.push(params)
          return [{ id: params[0] }]
        }
        if (sql.startsWith('SELECT to_regclass(')) return [{ installed: !h.preMigration }]
        if (sql.startsWith('SELECT EXISTS (SELECT 1 FROM integration_stock_prep_audit')) return [{ present: data.audit.length > 0 }]
        throw new Error('unexpected statement')
      } })
      h.data = data
      return result
    },
  }
  const auditStore = createStockPreparationAuditStore({ db: { insertOne() { assert.fail('outside transaction') }, select() {} }, idGenerator: () => 'audit-1' })
  h.service = createService({ database, auditStore, authorizeWithin: async (_tx, current) => {
    assert.equal(typeof current.actor, 'string')
    if (!h.mayDelete) throw Object.assign(new Error('secret'), { code: 'FORBIDDEN', status: 403 })
  } })
  return h
}
function confirmation(preview, extra = {}) { return { ...scope, challengeId: preview.challengeId, verificationCode: preview.verificationCode, ...extra } }
const reject = (call, code, status = 409) => assert.rejects(call, error => error.code === code && error.status === status && !/secret|sensitive/.test(error.message))

test('code is bound to actor, tenant, project and latest preview; a wrong answer consumes it', async () => {
  const h = fixture()
  const p = await h.service.preview(scope)
  assert.match(p.verificationCode, /^[A-F0-9]{8}$/)
  assert.equal(Date.parse(p.expiresAt) - h.now, 300_000)
  assert.equal(h.data.claims[0].code_digest.length, 64)
  for (const change of [{ tenantId: 'other' }, { projectNo: 'other' }, { actor: 'other' }]) {
    await reject(h.service.confirm(confirmation(p, change)), codes.challenge)
    assert.equal(h.data.claims.length, 1)
  }
  const p2 = await h.service.preview(scope)
  assert.notEqual(p.challengeId, p2.challengeId)
  await reject(h.service.confirm(confirmation(p)), codes.challenge)
  await reject(h.service.confirm(confirmation(p2, { verificationCode: 'wrong' })), codes.challenge)
  await reject(h.service.confirm(confirmation(p2)), codes.challenge)
  assert.equal(h.data.claims.length, 0)
  assert.deepEqual(h.data.audit, [])
})

test('enforces DB expiry, live role, and both lock refusals before writes', async () => {
  const h = fixture()
  const p = await h.service.preview(scope)
  h.mayDelete = false
  await reject(h.service.confirm(confirmation(p)), 'FORBIDDEN', 403)
  h.mayDelete = true
  h.locked = true
  await reject(h.service.confirm(confirmation(p)), codes.busy)
  h.locked = false
  h.sqlBusy = true
  await reject(h.service.preview(scope), codes.busy)
  h.sqlBusy = false
  h.now = Date.parse(p.expiresAt)
  await reject(h.service.confirm(confirmation(p)), codes.challenge)
  assert.deepEqual(h.data.audit, [])
  assert.equal(h.data.sheets, 'one')
})

test('pre-migration scheduled pulls skip private-table reads and projects with no removal marker skip the root lookup', async () => {
  const h = fixture()
  h.preMigration = true
  assert.equal(await h.service.isDeleted(scope), false)
  assert.ok(!h.events.some(sql => sql.includes('FROM integration_stock_prep_audit')))
  h.preMigration = false
  h.events.length = 0
  assert.equal(await h.service.isDeleted(scope), false)
  assert.ok(h.events.some(sql => sql.includes('FROM integration_stock_prep_audit')))
  assert.ok(!h.events.includes('plan sheets'))
})

test('restricted DB role refuses preview, confirmation and scheduled preflight when visibility or privileges are incomplete', async () => {
  const h = fixture()
  const p = await h.service.preview(scope)
  const before = structuredClone(h.data)
  h.dbDenied = true
  for (const action of [() => h.service.preview(scope), () => h.service.confirm(confirmation(p)), () => h.service.isDeleted(scope)]) {
    h.events.length = 0
    await reject(action(), 'STOCK_PREPARATION_PROJECT_DELETE_UNAVAILABLE', 503)
    assert.deepEqual(h.data, before)
  }
})

test('an equal-count content change invalidates and consumes the prior preview', async () => {
  const h = fixture()
  const p = await h.service.preview(scope)
  h.data.business = 'same count, different content'
  await reject(h.service.confirm(confirmation(p)), codes.stale)
  h.data.business = 'two'
  await reject(h.service.confirm(confirmation(p)), codes.challenge)
  assert.deepEqual(h.data.audit, [])
})

test('mid-purge, audit failure, and a suppressed audit insert each roll back all changes; successful replay cannot write twice', async () => {
  const h = fixture()
  const p = await h.service.preview(scope)
  const before = structuredClone(h.data)
  for (const failure of ['delete business', 'audit', 'suppressed_audit']) {
    h.failAt = failure
    await reject(h.service.confirm(confirmation(p)), codes.failed, 500)
    assert.deepEqual(h.data, before)
  }
  h.failAt = null
  const counts = { sheets: 1, business: 1, runtime: 1 }
  assert.deepEqual(await h.service.confirm(confirmation(p)), { tenantId: 'T', projectNo: 'P', counts, auditId: 'audit-1' })
  assert.deepEqual(h.data.audit, [['audit-1', 'T', null, 'P', 'project_delete', null, 'confirmed', 'A', JSON.stringify({ counts })]])
  assert.equal(await h.service.isDeleted(scope), true)
  h.data.sheets = 'recreated empty sheet'
  assert.equal(await h.service.isDeleted(scope), false)
  await reject(h.service.confirm(confirmation(p)), codes.challenge)
})

test('activity holds shared project/tenant fallback keys across work and refuses a conflicting deletion before entering it', async () => {
  const events = []
  const tx = { query: async (sql, values) => { events.push([sql.includes('_shared'), ...values]); return [{ locked: true }] } }
  const database = { transaction: async work => { events.push('begin'); await work(tx); events.push('commit') } }
  await withProjectDeleteActivity(database, scope, async () => events.push('work'))
  await withProjectDeleteActivity(database, { tenantId: 'T', projectNo: null }, async () => events.push('legacy_work'))
  await lockProjectActivity(tx, scope, false)
  assert.deepEqual(events, ['begin', [true, 6991, '["T","P"]'], 'work', 'commit', 'begin', [true, 6991, '["T",null]'], 'legacy_work', 'commit', [false, 6991, '["T",null]'], [false, 6991, '["T","P"]']])
  const unavailable = { transaction: work => work({ query: async () => [{ locked: false }] }) }
  await reject(withProjectDeleteActivity(unavailable, scope, () => assert.fail('busy operation ran')), codes.busy)
})
