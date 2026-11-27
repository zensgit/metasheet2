import { createRequire } from 'node:module'
import express from 'express'
import type { RequestHandler } from 'express'
import request from 'supertest'
import { expect } from 'vitest'
import { exerciseCreateDeleteOrdering, createRegistryPause } from './stock-preparation-project-delete-create-order-realdb.cases'
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
  const collision = { ...scope, projectNo: 'create-delete-race' }
  const pause = createRegistryPause(registry, collision)
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
  let loseConfirmResponse = false
  const pullResponses: { path: string; status: number; code?: string }[] = []
  const pullPrefix = '/api/integration/table-actions/:actionId/'
  load('http-routes').registerIntegrationRoutes({
    context: { ...context, storage: context.storage, config: {
      stockPreparationTableActions: [{ actionId, source: { externalSystemId: 'fixture-plm', kind: 'data-source:sql-readonly' }, target: deployment.target }],
      stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envObjectId] },
    }, api: { ...context.api, http: {
      addRoute(method: string, route: string, handler: RequestHandler) {
        if (method === 'GET' && route.endsWith('/receipt/:challengeId')) { app.get(route, handler); return }
        if (method.toUpperCase() !== 'POST') return
        if (![pullPrefix + 'dry-run', pullPrefix + 'apply'].includes(route)
          && !route.startsWith(pullPrefix + 'large-bom/expansion-jobs')
          && !route.startsWith('/api/integration/stock-preparation/projects/:projectNo/')) return
        app.post(route, (req, res, next) => {
          if (route.endsWith('/delete/confirm') && loseConfirmResponse) {
            res.json = body => {
              if (res.statusCode !== 200 || !body?.ok) throw Error('confirmation did not commit')
              res.socket?.destroy()
              return res
            }
          }
          if ([pullPrefix + 'dry-run', pullPrefix + 'apply'].includes(route)) {
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
      stockPreparationProjectTargetStore: pause.registry, stockPreparationProjectWriteLock: projectWriteLock,
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
    await exerciseCreateDeleteOrdering(fixture, collision, pause, () => post('/api/integration/stock-preparation/projects/' + collision.projectNo + '/target').send({}))
    const run = await runSchedule()
    expect(run).toMatchObject({ action: 'applied' })
    expect(pullResponses).toEqual([{ path: 'dry-run', status: 200, code: undefined }, { path: 'apply', status: 200, code: undefined }])
    const imported = await records.queryRecords({ sheetId: dedicated.sheetId })
    expect(imported).toHaveLength(1)
    expect(imported[0].data[dedicated.fields.componentCode]).toBe('SYN-0001')
    expect(source.calls.length).toBeGreaterThan(0)


    const setting = await post(prefix + '/target/manual-rows').send({ confirmProjectNo: scope.projectNo, policy: 'allowed' })
    expect(setting.status).toBe(200)
    const manual = await post(`/api/multitable/sheets/${dedicated.sheetId}/manual-rows`).send({ data: {
      [dedicated.fields.componentCode]: 'SYN-MANUAL', [dedicated.fields.componentName]: 'Synthetic hand-filled part', [dedicated.fields.totalQuantity]: 2,
    } })
    expect(manual.status).toBe(200)
    const manualId = manual.body.data.record.id
    const filled = await records.getRecord({ sheetId: dedicated.sheetId, recordId: manualId })
    expect(filled.data[dedicated.fields.idempotencyKey]).toBe('manual:v1:' + manualId)

    const tableAction = '/api/integration/table-actions/' + actionId
    const parameters = { projectNo: scope.projectNo }
    const dry = await post(tableAction + '/dry-run').send({ parameters }).expect(200)
    const oldToken = { dryRunToken: dry.body.data.dryRunToken, dryRunRevision: dry.body.data.revision }
    expect(oldToken.dryRunToken).toBeTruthy()
    const jobs = tableAction + '/large-bom/expansion-jobs'
    const queued = await post(jobs).send({ parameters }).expect(202)
    const oldJob = queued.body.data.jobId
    expect(oldJob).toBeTruthy()
    await post(prefix + '/delete/preview').send({}).expect(409)
    // The consumer may receive a duplicate delivery after cancellation and project recreation.
    await post(jobs + '/' + oldJob + '/cancel').send({}).expect(200)
    const sourceReads = source.calls.length
    const requestsBeforeDelete = pullResponses.length
    const preview = await post(prefix + '/delete/preview').send({})
    expect(preview.status).toBe(200)
    const impact = preview.body.data
    expect(impact.counts).toMatchObject({ dedicatedRows: 2, dedicatedSheets: 1, projectRows: 1 })
    const confirmation = { challengeId: impact.challengeId, code: impact.verificationCode }
    const receiptPath = prefix + '/delete/receipt/' + impact.challengeId
    const readReceipt = () => request(pinned.url()).get(receiptPath).set('Authorization', 'Bearer ' + token)
    await readReceipt().expect(404)
    loseConfirmResponse = true
    await expect(post(prefix + '/delete/confirm').send(confirmation)).rejects.toMatchObject({ code: 'ECONNRESET' })
    loseConfirmResponse = false
    const receipt = (await readReceipt().expect(200)).body.data
    expect(receipt).toMatchObject({ tenantId: scope.tenantId, projectNo: scope.projectNo, counts: impact.counts })
    expect(receipt.auditId).toBeTruthy()
    expect(await fixture.directory(scope)).toEqual([])
    for (const row of registered) {
      expect((await records.queryRecords({ sheetId: row.sheetId })).map(record => record.id)).not.toContain(row.recordId)
    }
    expect(pullResponses).toHaveLength(requestsBeforeDelete)
    expect(source.calls).toHaveLength(sourceReads)
    const again = await runSchedule()
    expect(again).toMatchObject({ dryRunHttpStatus: 409, action: 'skipped_project_sheet_absent' })
    expect(pullResponses.slice(requestsBeforeDelete)).toEqual([{ path: 'dry-run', status: 409, code: 'STOCK_PREPARATION_PROJECT_ABSENT' }])
    expect(source.calls).toHaveLength(sourceReads)
    const rebuilt = await fixture.dedicated(scope, false)
    expect(rebuilt.sheetId).toBe(dedicated.sheetId)
    expect(await records.queryRecords({ sheetId: rebuilt.sheetId })).toEqual([])
    const controlScope = { ...scope, projectNo: 'replay-control' }
    const control = await fixture.dedicated(controlScope)
    await records.createRecord({ sheetId: rebuilt.sheetId, data: { [rebuilt.fields.notes]: 'replacement row' } })
    const snapshot = () => Promise.all([records.queryRecords({ sheetId: rebuilt.sheetId }), records.queryRecords({ sheetId: control.sheetId }),
      registry.get(scope), registry.get(controlScope)])
    const beforeReplay = await snapshot()
    const sourceReadsBeforeReplay = source.calls.length
    const retryToken = await post(tableAction + '/apply').send({ parameters, confirm: oldToken }).expect(409)
    expect(retryToken.body.error.code).toBe('TABLE_ACTION_DRY_RUN_TOKEN_INVALID')
    const retryJob = await post(jobs + '/' + oldJob + '/run').send({}).expect(404)
    expect(retryJob.body.error.code).toMatch(/JOB_NOT_FOUND$/)
    const retryDelete = await post(prefix + '/delete/confirm').send(confirmation).expect(409)
    expect(retryDelete.body.error.code).toBe('STOCK_PREPARATION_PROJECT_DELETE_CHALLENGE_INVALID')
    expect(source.calls).toHaveLength(sourceReadsBeforeReplay)
    expect(await snapshot()).toEqual(beforeReplay)
    expect((await readReceipt().expect(200)).body.data).toEqual(receipt)
    const audit = await auditStore.list({ tenantId: scope.tenantId, projectId: scope.projectNo, action: 'project_delete' })
    expect(audit.entries).toHaveLength(1)
    expect(audit.entries[0]).toMatchObject({ id: receipt.auditId, subjectId: impact.challengeId, detail: { counts: impact.counts } })
  } finally {
    if (old === undefined) delete process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
    else process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED = old
  }
}
