'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { registerIntegrationRoutes } = require('../lib/http-routes.cjs')
const { baseServices, call } = require('./support/stock-preparation-project-sheet-harness.cjs')

const BASE = '/api/integration/stock-preparation'
const PREVIEW = BASE + '/projects/:projectNo/delete/preview'
const CONFIRM = BASE + '/projects/:projectNo/delete/confirm'
const ACCESS = BASE + '/project-delete/access'
const ACTION = 'plm.stock-preparation.pull-bom.v1'
const ADMIN = { id: 'synthetic-admin', tenantId: 'tenant-A', role: 'admin' }
const request = { user: ADMIN, params: { projectNo: 'P-1' }, authenticatedTenantId: 'tenant-A' }

function mount({ legacy = false } = {}) {
  const routes = new Map()
  const calls = []
  let adminGranted = true
  const deleted = new Set()
  let sourceUnavailable = false
  const answer = { projectNo: 'P-1', tenantId: 'tenant-A' }
  const services = {
    ...baseServices({}),
    stockPreparationProjectDelete: {
      async preview(input) { calls.push(['preview', input]); return { ...answer, challengeId: 'id', verificationCode: 'CODE' } },
      async confirm(input) { calls.push(['confirm', input]); deleted.add(input.projectNo); return answer },
    },
    async stockPreparationProjectDeletionStatus(scope) {
      calls.push(['deleted', scope]); return deleted.has(scope.projectNo)
    },
    stockPreparationSourceBindingStore: legacy ? { get: async () => {
      calls.push(['source'])
      if (sourceUnavailable) throw new Error('synthetic source failure')
      return null
    } } : undefined,
    async stockPreparationProjectDeleteAuthority(_tx, scope) {
      calls.push(['authority', scope])
      if (!adminGranted || scope.actor !== ADMIN.id) throw Object.assign(new Error('FORBIDDEN'), { status: 403, code: 'FORBIDDEN' })
    },
    tenantPrincipalDirectory: {
      async verifyTenantMembership(scope) {
        calls.push(['membership', scope])
        return { member: scope.tenantId === 'tenant-A' || (scope.userId === ADMIN.id && scope.tenantId === 'tenant-B') }
      },
    },
  }
  registerIntegrationRoutes({
    services,
    context: { services: { stockPreparationProjectWriterActivity: { withConnection: fn => fn({ query: async () => [{ locked: true, released: true }] }) } }, config: legacy ? { stockPreparationTableActions: [{
      actionId: ACTION,
      source: { externalSystemId: 'synthetic-source', kind: 'data-source:sql-readonly' },
      target: { sheetId: 'synthetic-sheet', objectId: 'plm_stock_preparation_sandbox_legacy', fieldIdMap: {} },
    }] } : {}, api: {
      database: { transaction: fn => fn({ query: async () => [{ locked: true }] }) },
      http: { addRoute: (method, path, handler) => routes.set(method + ' ' + path, handler) },
    } },
  })
  return { routes, calls, revoke: () => { adminGranted = false }, failSource: () => { sourceUnavailable = true } }
}

test('project cleanup checks current platform authority and tenant independently on access, preview and confirmation', async t => {
  const { routes, calls, revoke } = mount()
  t.after(() => { delete process.env.STOCK_PREPARATION_PROJECT_DELETE_ENABLED })
  for (const flag of ['false', 'TRUE', '1', ' true ']) {
    process.env.STOCK_PREPARATION_PROJECT_DELETE_ENABLED = flag
    assert.deepEqual((await call(routes, 'GET', ACCESS, request)).body, { ok: true, data: { mayDelete: false } })
    for (const route of [PREVIEW, CONFIRM]) assert.equal((await call(routes, 'POST', route, request)).statusCode, 404)
  }
  assert.deepEqual(calls, [])
  process.env.STOCK_PREPARATION_PROJECT_DELETE_ENABLED = 'true'
  for (const permissions of [['stock-prep:admin'], ['stock-prep:pull', 'stock-prep:operate', 'stock-prep:read'], ['integration:admin'], ['table:admin'], ['role:admin']]) {
    const user = { id: 'synthetic-member', tenantId: 'tenant-A', permissions }
    assert.deepEqual((await call(routes, 'GET', ACCESS, { ...request, user })).body, { ok: true, data: { mayDelete: false } })
    for (const route of [PREVIEW, CONFIRM]) assert.equal((await call(routes, 'POST', route, { ...request, user })).statusCode, 403)
  }
  for (const override of [
    { query: { tenantId: 'tenant-B' } }, { body: { tenantId: 'tenant-B' } },
    { headers: { 'x-tenant-id': 'tenant-B' } },
    { user: { ...ADMIN, tenantId: 'tenant-B' } },
    { user: { ...ADMIN, tenantId: 'tenant-B' }, authenticatedTenantId: undefined },
    { user: { ...ADMIN, tenantId: undefined }, authenticatedTenantId: undefined },
  ]) {
    for (const route of [PREVIEW, CONFIRM]) {
      const res = await call(routes, 'POST', route, { ...request, ...override })
      assert.equal(res.statusCode, 403)
    }
  }
  for (const [route, override] of [
    [PREVIEW, { body: { injected: true } }], [PREVIEW, { params: { projectNo: 'invalid!' } }],
    [CONFIRM, { body: { challengeId: 'id', code: 'CODE', injected: true } }], [CONFIRM, { body: [] }],
  ]) assert.equal((await call(routes, 'POST', route, { ...request, ...override })).statusCode, 422)

  // An administrator really belongs to both A and B. A token without its own tenant has only
  // the middleware's header-derived user.tenantId. Neither legitimate membership selects one.
  for (const tenantId of ['tenant-A', 'tenant-B']) {
    const headerOnly = { ...request, user: { ...ADMIN, tenantId }, authenticatedTenantId: undefined, headers: { 'x-tenant-id': tenantId } }
    assert.deepEqual((await call(routes, 'GET', ACCESS, headerOnly)).body, { ok: true, data: { mayDelete: false } })
    for (const route of [PREVIEW, CONFIRM]) {
      const response = await call(routes, 'POST', route, { ...headerOnly, body: route === CONFIRM ? { challengeId: 'id', code: 'CODE' } : {} })
      assert.equal(response.statusCode, 403)
      assert.equal(response.body.error.code, 'OPERATOR_SCOPE_TENANT_REQUIRED')
    }
  }
  assert.deepEqual(calls.filter(([action]) => action === 'preview' || action === 'confirm'), [])
  assert.deepEqual((await call(routes, 'GET', ACCESS, request)).body, { ok: true, data: { mayDelete: true } })
  const scope = { actor: ADMIN.id, tenantId: 'tenant-A', projectNo: 'P-1', boundTarget: null }
  assert.equal((await call(routes, 'POST', PREVIEW, request)).headers['Cache-Control'], 'no-store')
  assert.deepEqual(calls.at(-1), ['preview', scope])
  const confirm = { ...request, body: { challengeId: 'id', code: 'CODE' } }
  assert.equal((await call(routes, 'POST', CONFIRM, confirm)).statusCode, 200)
  assert.deepEqual(calls.at(-1), ['confirm', { ...scope, challengeId: 'id', verificationCode: 'CODE' }])
  revoke()
  assert.equal((await call(routes, 'POST', CONFIRM, confirm)).statusCode, 403)
  assert.equal(calls.filter(([action]) => action === 'confirm').length, 1)
})

test('disabled MVP persistence preserves its feature refusal before checking tenant scope', async t => {
  const flag = 'MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED'
  const previous = process.env[flag]
  process.env[flag] = 'false'
  t.after(() => { if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous })
  const { routes } = mount()
  const reply = await call(routes, 'POST', '/api/integration/table-actions/:actionId/mvp-persist', {
    user: { id: 'synthetic', role: 'admin' }, params: { actionId: ACTION }, body: {},
  })
  assert.equal(reply.statusCode, 403)
  assert.equal(reply.body.error.code, 'STOCK_PREPARATION_TABLE_ACTION_MVP_PERSIST_DISABLED')
})

test('a committed deletion still stops the legacy scheduler after the cleanup switch is turned off', async t => {
  const { routes, calls, failSource } = mount({ legacy: true })
  const { PROJECT_SHEETS_ENABLED_ENV } = require('../lib/stock-preparation-project-targets.cjs')
  const previous = process.env[PROJECT_SHEETS_ENABLED_ENV]
  delete process.env[PROJECT_SHEETS_ENABLED_ENV]
  process.env.STOCK_PREPARATION_PROJECT_DELETE_ENABLED = 'true'
  t.after(() => {
    delete process.env.STOCK_PREPARATION_PROJECT_DELETE_ENABLED
    if (previous !== undefined) process.env[PROJECT_SHEETS_ENABLED_ENV] = previous
  })
  const dryRun = (projectNo) => call(routes, 'POST', '/api/integration/table-actions/:actionId/dry-run', {
    ...request, params: { actionId: ACTION }, body: { parameters: { projectNo } },
  })
  const preview = await call(routes, 'POST', PREVIEW, request)
  assert.equal(preview.statusCode, 200)
  const { challengeId, verificationCode } = preview.body.data
  const confirmed = await call(routes, 'POST', CONFIRM, { ...request, body: { challengeId, code: verificationCode } })
  assert.equal(confirmed.statusCode, 200)
  delete process.env.STOCK_PREPARATION_PROJECT_DELETE_ENABLED
  assert.equal((await call(routes, 'POST', PREVIEW, request)).statusCode, 404)
  // A broken source binding must not turn a retained, skipped schedule into a failed source run.
  failSource()
  calls.length = 0
  const absent = await dryRun('P-1')
  assert.equal(absent.statusCode, 409)
  assert.equal(absent.body.error.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
  const [, scope] = calls.find(([name]) => name === 'deleted')
  assert.deepEqual([scope.tenantId, scope.projectNo, scope.boundTarget.sheetId], ['tenant-A', 'P-1', 'synthetic-sheet'])
  assert.equal(calls.some(([name]) => name === 'source'), false)
  const sibling = await dryRun('P-2')
  assert.ok(calls.some(([name]) => name === 'source'))
  assert.notEqual(sibling.body.error?.code, 'STOCK_PREPARATION_PROJECT_ABSENT')
})
