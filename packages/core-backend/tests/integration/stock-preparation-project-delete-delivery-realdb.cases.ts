import { createRequire } from 'node:module'
import express from 'express'
import type { RequestHandler } from 'express'
import request from 'supertest'
import { expect } from 'vitest'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { authorizeStockPreparationProjectDeleteWithin } from '../../src/services/stock-preparation-project-delete-authority'
import type { PinnedServer } from '../utils/pinned-server'
import type { ProjectDeleteTestStack } from './stock-preparation-project-delete-realdb.cases'

const require = createRequire(import.meta.url)
const load = (name: string) => require(`../../../../plugins/plugin-integration-core/lib/${name}.cjs`)
const harness = require('../../../../plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')
const actionId = load('stock-preparation-table-actions').PLM_STOCK_PREPARATION_ACTION_ID
type Scope = { tenantId: string; projectNo: string; actor: string }

export async function exerciseProjectDeleteDelivery(pinned: PinnedServer, fixture: ProjectDeleteTestStack, scope: Scope) {
  const { context, registry, service, db, auditStore, records } = fixture
  const projectId = scope.tenantId + ':integration-core'
  const dedicated = await fixture.dedicated(scope, false)
  const registered = await fixture.shared(scope)
  const envObjectId = 'plm_stock_preparation_sandbox_trial'
  const deployment = await load('stock-preparation-target-provisioning').ensureStockPreparationSandboxTarget({
    context, projectId, objectId: envObjectId, permission: 'admin',
  })
  expect(deployment.ready).toBe(true)

  // The only external port is the synthetic in-memory PLM source. Plugin storage, the job token,
  // project registry, locks, audit, and multitable record writes all use production host bindings.
  const source = harness.makeSourceAdapter(scope.projectNo)
  const base = harness.baseServices(source.adapter)
  const projectWriteLock = load('stock-preparation-project-write-lock').createStockPreparationProjectWriteLock({ db })
  const continuationStore = load('stock-preparation-continuation-store').createStockPreparationContinuationStore({ db })
  const refresh = load('stock-preparation-refresh-governance').createStockPreparationRefreshGovernance({
    continuationStore, projectTargetStore: registry, projectWriteLock,
  })
  const app = express()
  const token = ['synthetic', Buffer.from(JSON.stringify({ tenantId: scope.tenantId })).toString('base64url'), 'synthetic'].join('.')
  app.use(express.json())
  app.use((req, res, next) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.sendStatus(401); return }
    const permissions = ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull', 'stock-prep:admin', 'multitable:read', 'multitable:write']
    Object.assign(req, { user: { id: scope.actor, tenantId: scope.tenantId, role: 'admin', roles: ['admin'], permissions, perms: permissions },
      authenticatedTenantId: scope.tenantId })
    next()
  })
  const pullResponses: { path: string; status: number; code?: string }[] = []
  const pullPrefix = '/api/integration/table-actions/:actionId/'
  load('http-routes').registerIntegrationRoutes({
    context: { ...context, storage: context.storage, config: {
      stockPreparationTableActions: [{ actionId, source: { externalSystemId: 'fixture-plm', kind: 'data-source:sql-readonly' }, target: deployment.target }],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envObjectId] },
    }, api: { ...context.api, http: {
      addRoute(method: string, route: string, handler: RequestHandler) {
        if (method.toUpperCase() !== 'POST') return
        if (![pullPrefix + 'dry-run', pullPrefix + 'apply'].includes(route)
          && !route.startsWith('/api/integration/stock-preparation/projects/:projectNo/')) return
        app.post(route, (req, res, next) => {
          if (route.startsWith(pullPrefix)) {
            const send = res.json.bind(res)
            res.json = body => {
              pullResponses.push({ path: route.slice(pullPrefix.length), status: res.statusCode, code: body?.error?.code })
              return send(body)
            }
          }
          return handler(req, res, next)
        })
      },
    } } },
    services: { ...base,
      externalSystemRegistry: { ...base.externalSystemRegistry, listExternalSystems: async () => [] },
      pipelineRegistry: { ...base.pipelineRegistry, listPipelines: async () => [] },
      stockPreparationProjectTargetStore: registry, stockPreparationProjectWriteLock: projectWriteLock,
      stockPreparationContinuationStore: continuationStore, stockPreparationRefreshGovernance: refresh,
      stockPreparationAuditStore: auditStore, stockPreparationProjectDelete: service,
      stockPreparationProjectDeleteAuthority: authorizeStockPreparationProjectDeleteWithin,
      stockPreparationPackInstallStore: load('stock-preparation-pack-install-store').createStockPreparationPackInstallStore({ db }),
      stockPreparationConfirmationDecisionLease: load('stock-preparation-confirmation-decisions').createConfirmationDecisionReconcileLease({ db }),
      tenantPrincipalDirectory: fixture.tenantPrincipalDirectory,
    },
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)
  const savedSchedule = Object.freeze({ MS_API: pinned.url(), MS_TOKEN: token, MS_TENANT_ID: scope.tenantId, MS_PROJECT_NOS: scope.projectNo })
  const scheduler = await import('../../../../scripts/ops/stock-preparation-scheduled-pull.mjs')
  const runSchedule = async () => {
    const lines: string[] = []
    const restore = scheduler.__setOutputSinksForTesting({ stdout: (line: string) => lines.push(line), stderr: () => {} })
    try {
      const exit = await scheduler.main(['--apply'], savedSchedule)
      expect(exit, lines.join('')).toBe(0)
    } finally { restore() }
    return lines.flatMap(line => line.trim().split('\n')).map(line => JSON.parse(line)).find(item => item.projectNo === scope.projectNo)
  }
  const old = process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
  process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = 'true'
  const post = (path: string) => request(pinned.url()).post(path).set('Authorization', 'Bearer ' + token)
  const prefix = '/api/integration/stock-preparation/projects/' + scope.projectNo
  try {
    const run = await runSchedule()
    expect(run).toMatchObject({ action: 'applied' })
    expect(pullResponses).toEqual([{ path: 'dry-run', status: 200, code: undefined }, { path: 'apply', status: 200, code: undefined }])
    const imported = await records.queryRecords({ sheetId: dedicated.sheetId })
    expect(imported).toHaveLength(1)
    expect(imported[0].data[dedicated.fields.componentCode]).toBe('SYN-0001')
    expect(source.calls.length).toBeGreaterThan(0)
    const sourceReads = source.calls.length

    const setting = await post(prefix + '/target/manual-rows').send({ confirmProjectNo: scope.projectNo, policy: 'allowed' })
    expect(setting.status).toBe(200)
    const manual = await post(`/api/multitable/sheets/${dedicated.sheetId}/manual-rows`).send({ data: {
      [dedicated.fields.componentCode]: 'SYN-MANUAL', [dedicated.fields.componentName]: 'Synthetic hand-filled part', [dedicated.fields.totalQuantity]: 2,
    } })
    expect(manual.status).toBe(200)
    const manualId = manual.body.data.record.id
    const filled = await records.getRecord({ sheetId: dedicated.sheetId, recordId: manualId })
    expect(filled.data[dedicated.fields.idempotencyKey]).toBe('manual:v1:' + manualId)

    const preview = await post(prefix + '/delete/preview').send({})
    expect(preview.status).toBe(200)
    const impact = preview.body.data
    expect(impact.counts).toMatchObject({ dedicatedRows: 2, dedicatedSheets: 1, projectRows: 1 })
    const result = await post(prefix + '/delete/confirm').send({ challengeId: impact.challengeId, code: impact.verificationCode })
    expect(result.status).toBe(200)
    expect(result.body.data.counts).toEqual(impact.counts)
    expect(await fixture.directory(scope)).toEqual([])
    for (const row of registered) {
      expect((await records.queryRecords({ sheetId: row.sheetId })).map(record => record.id)).not.toContain(row.recordId)
    }
    expect(pullResponses).toHaveLength(2)
    expect(source.calls).toHaveLength(sourceReads)
    const again = await runSchedule()
    expect(again).toMatchObject({ dryRunHttpStatus: 409, action: 'skipped_project_sheet_absent' })
    expect(pullResponses.slice(2)).toEqual([{ path: 'dry-run', status: 409, code: 'STOCK_PREPARATION_PROJECT_ABSENT' }])
    expect(source.calls).toHaveLength(sourceReads)
    const rebuilt = await fixture.dedicated(scope, false)
    expect(rebuilt.sheetId).toBe(dedicated.sheetId)
    expect(await records.queryRecords({ sheetId: rebuilt.sheetId })).toEqual([])
  } finally {
    if (old === undefined) delete process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
    else process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = old
  }
}
