import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { exerciseProjectDeleteDelivery } from './stock-preparation-project-delete-delivery-realdb.cases'
import { usePinnedServer } from '../utils/pinned-server'
import { checkProjectDeleteRuntime } from './stock-preparation-project-delete-runtime-realdb.cases'
import { registerProjectDeleteAdoptionCases } from './stock-preparation-project-delete-adoption-realdb.cases'
import { defineStockPreparationProjectDeleteAuthorityRealDbCases } from './stock-preparation-project-delete-authority-realdb.cases'
import { defineProjectDeleteConcurrencyRealDbCases } from './stock-preparation-project-delete-concurrency-realdb.cases'
import { defineStockPreparationProjectDeleteWriterActivityRealDbCases } from './stock-preparation-project-delete-writer-activity-realdb.cases'
import { checkProjectDeleteYjs } from './stock-preparation-project-delete-yjs-realdb.cases'
import { MetaSheetServer } from '../../src/index'
import { authorizeStockPreparationProjectDeleteWithin } from '../../src/services/stock-preparation-project-delete-authority'
import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const lib = (name: string) => require(`../../../../plugins/plugin-integration-core/lib/${name}.cjs`)
const targets = lib('stock-preparation-project-targets')
const templates = lib('stock-preparation-templates')
const { deriveStockPreparationBaseId } = lib('stock-preparation-own-base')
const { ensureConfirmationDecisionTarget } = lib('stock-preparation-confirmation-decisions')
const { listOperatorProjectDirectory } = lib('stock-preparation-operator-project-directory')
const { sheetWriteScopeKey, createStockPreparationProjectWriteLock } = lib('stock-preparation-project-write-lock')
const q = (sql: string, values: unknown[] = []) => poolManager.get().query(sql, values)
const actor = `delete_admin_${randomUUID()}`
const otherAdmin = `delete_admin_${randomUUID()}`
const tenants = new Set<string>()
function tenant() {
  const id = `delete6991_${randomUUID().replaceAll('-', '')}`
  tenants.add(id)
  return id
}
const project = (tenantId: string, projectNo: string) => ({ tenantId, projectNo, actor })
type Scope = ReturnType<typeof project>
type Challenge = { challengeId: string; verificationCode: string }
const params = (scope: Scope, { challengeId, verificationCode }: Challenge) => ({ ...scope, challengeId, verificationCode })
const suffix = (name: string) => `plm_stock_preparation_${name}`
const ambiguous = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_AMBIGUOUS' }
const busy = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_BUSY' }
const badCode = { status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_CHALLENGE_INVALID' }

function stack() {
  const server = new MetaSheetServer({ port: 0, pluginDirs: [] })
  const plugin: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'project-delete-realdb' },
    plugin: { activate: async () => {} }, path: 'synthetic-project-delete', loadedAt: new Date(),
  }
  const context = (server as unknown as { createPluginContext(p: LoadedPlugin): PluginContext }).createPluginContext(plugin)
  const { database, multitable } = context.api
  if (!multitable?.records || !multitable.provisioning) throw new Error('real plugin provisioning and records APIs required')
  const { records, provisioning } = multitable
  const db = lib('db').createDb({ database })
  const registry = lib('stock-preparation-project-target-store').createStockPreparationProjectTargetStore({ db })
  const auditStore = lib('stock-preparation-audit-store').createStockPreparationAuditStore({ db })
  const service = lib('stock-preparation-project-delete').createStockPreparationProjectDelete({
    database, auditStore, authorizeWithin: authorizeStockPreparationProjectDeleteWithin,
  })
  const { call, baseServices } = require('../../../../plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')
  const tenantPrincipalDirectory = {
    async verifyTenantMembership({ userId, tenantId }: { userId: string; tenantId: string }) {
      const result = await q('SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active', [userId, tenantId])
      return { member: result.rows.length > 0 }
    },
  }
  const routes = new Map()
  lib('http-routes').registerIntegrationRoutes({
    context: { ...context, api: { ...context.api, http: {
      addRoute: (method: string, path: string, handler: unknown) => routes.set(method + ' ' + path, handler),
    } } },
    services: {
      ...baseServices({}), stockPreparationProjectDelete: service, stockPreparationProjectDeleteAuthority: authorizeStockPreparationProjectDeleteWithin,
      tenantPrincipalDirectory,
    },
  })
  async function submit(scope: Scope, action: 'preview' | 'confirm', body: Record<string, string> = {}) {
    const route = '/api/integration/stock-preparation/projects/:projectNo/delete/' + action
    const res = await call(routes, 'POST', route, { user: { id: scope.actor, tenantId: scope.tenantId },
      authenticatedTenantId: scope.tenantId, params: { projectNo: scope.projectNo }, body })
    expect(res.statusCode).toBe(200)
    return res.body.data
  }
  async function admitAdmins(tenantId: string) {
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active)
      SELECT id, $2, true FROM unnest($1::text[]) AS users(id)
      ON CONFLICT (user_id, org_id) DO NOTHING`, [[actor, otherAdmin], tenantId])
  }
  async function dedicated(scope: Scope, seed = true) {
    const projectId = `${scope.tenantId}:integration-core`
    await admitAdmins(scope.tenantId)
    const target = await targets.provisionProjectSheet({ ...scope, projectId, context, env: {} })
    await registry.create({ ...scope, ...target, createdBy: actor, maxPerTenant: 200 })
    const ids: string[] = []
    if (seed) {
      const field = target.fieldIdMap
      const imported = await records.createRecord({ sheetId: target.sheetId, data: {
        [field.projectNo]: scope.projectNo, [field.idempotencyKey]: 'synthetic-pull-row',
        [field.componentSourceId]: 'synthetic-component', [field.active]: true,
      } })
      const manual = await records.createRecord({ sheetId: target.sheetId, data: {
        [field.projectNo]: scope.projectNo, [field.notes]: 'synthetic hand-filled contents',
      } })
      await records.patchRecord({ sheetId: target.sheetId, recordId: manual.id, changes: {
        [field.idempotencyKey]: `manual:v1:${manual.id}`,
      } })
      ids.push(imported.id, manual.id)
    }
    return { sheetId: String(target.sheetId), fields: target.fieldIdMap as Record<string, string>, ids }
  }
  async function shared(scope: Scope) {
    const projectId = `${scope.tenantId}:integration-core`
    await admitAdmins(scope.tenantId)
    const id = (name: string) => `${name}-${scope.projectNo}`
    const sharedData: Record<string, Record<string, string | number>> = {
      project: { projectId: id('project'), sourceProjectNo: scope.projectNo, lastSyncRunId: id('run') },
      bom_snapshot_batch: { projectId: id('project'), snapshotBatchId: id('batch'), syncRunId: id('run'), snapshotVersion: 1 },
      bom_snapshot_line: { snapshotBatchId: id('batch'), snapshotLineId: id('line'), pathKey: id('path') },
      line: { projectId: id('project'), snapshotBatchId: id('batch'), snapshotLineId: id('line'), stockPrepLineId: id('prep') },
      exception_confirmation: { projectId: id('project'), exceptionId: id('exception'), stockPrepLineId: id('prep') },
      run: { runId: id('run'), runType: 'plm_sync', status: 'succeeded' },
      confirmation_decision: { projectNo: scope.projectNo, decisionId: id('decision') },
      project_overview: { projectNo: scope.projectNo },
    }
    const mvpIds = templates.STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((t: { objectId: string }) => t.objectId)
      .filter((objectId: string) => Object.keys(sharedData).some(kind => suffix(kind) === objectId))
    const ready = await lib('stock-preparation-mvp-provisioning').ensureStockPreparationMvpTargets({ context, projectId, permission: 'admin', objectIds: mvpIds })
    expect(ready.ready).toBe(true)
    const result: { kind: string; sheetId: string; recordId: string }[] = []
    for (const [kind, logicalData] of Object.entries(sharedData)) {
      const objectId = suffix(kind)
      const isOverview = kind === 'project_overview'
      if (isOverview) {
        await lib('stock-preparation-project-overview').ensureProjectOverviewSheet({ provisioning, projectId, tenantId: scope.tenantId, env: {} })
      } else if (kind === 'confirmation_decision') {
        // The registered ensure route places this anchor in the tenant's stock-preparation base.
        await ensureConfirmationDecisionTarget({
          context, projectId, permission: 'admin', tenantId: scope.tenantId, resolveOwnBase: true, env: {},
        })
      }
      const sheet = await provisioning.findObjectSheet({ projectId, objectId })
      if (!sheet?.id) throw new Error('shared fixture provisioning failed')
      const data = Object.fromEntries(Object.entries(logicalData).map(([key, value]) => [provisioning.getFieldId(projectId, objectId, key), value]))
      const row = isOverview
        ? await records.stockPreparationOverview!.createRecord({ projectId, data })
        : await records.createRecord({ sheetId: sheet.id, data })
      result.push({ kind, sheetId: sheet.id, recordId: row.id })
      if (kind === 'run') {
        const p = (key: string) => provisioning.getFieldId(projectId, objectId, key)
        const failed = await records.createRecord({ sheetId: sheet.id, data: {
          [p('runId')]: lib('stock-preparation-mvp-generation').generationRunId(id('project'), id('batch')),
          [p('runType')]: 'prep_generate', [p('status')]: 'failed',
        } })
        result.push({ kind, sheetId: sheet.id, recordId: failed.id })
      }
    }
    return result
  }
  async function directory(scope: Scope) {
    const rows = await listOperatorProjectDirectory({
      scope: { tenantId: scope.tenantId }, targetProjectId: `${scope.tenantId}:integration-core`, provisioning,
      recordsApi: records, projectNo: scope.projectNo, includePullTargets: true,
      projectTargets: await registry.list({ tenantId: scope.tenantId }),
    })
    return rows.projects.map((row: { projectNo: string }) => row.projectNo).filter((no: string) => no === scope.projectNo)
  }
  return { context, service, tenantPrincipalDirectory, submit, admitAdmins, dedicated, shared, directory, registry, auditStore, db, provisioning, records }
}

export type ProjectDeleteTestStack = ReturnType<typeof stack>

function genericApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: actor, roles: ['admin'], perms: [] } })
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

async function snapshot(scope: Scope, sheetId: string, ids: string[]) {
  const facts = await Promise.all([
    q('SELECT * FROM meta_sheets WHERE id = $1', [sheetId]),
    q('SELECT * FROM meta_fields WHERE sheet_id = $1 ORDER BY id', [sheetId]),
    q('SELECT * FROM meta_views WHERE sheet_id = $1 ORDER BY id', [sheetId]),
    q('SELECT * FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]),
    q('SELECT * FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [scope.tenantId, scope.projectNo]),
    q('SELECT * FROM meta_records WHERE id = ANY($1::text[]) ORDER BY id', [ids]),
    q('SELECT * FROM integration_stock_prep_audit WHERE tenant_id = $1 ORDER BY id', [scope.tenantId]),
  ])
  return facts.map(result => result.rows)
}

export function defineStockPreparationProjectDeleteRealDbCases() {
  describe.skipIf(!process.env.DATABASE_URL)('stock preparation project deletion on PostgreSQL', () => {
    const pinned = usePinnedServer()
    let fixture: ReturnType<typeof stack>
    const newScope = (projectNo: string) => project(tenant(), projectNo)
    registerProjectDeleteAdoptionCases(() => fixture, newScope)
    defineStockPreparationProjectDeleteAuthorityRealDbCases()
    defineStockPreparationProjectDeleteWriterActivityRealDbCases()
    defineProjectDeleteConcurrencyRealDbCases(() => fixture, newScope)
    const flag = 'STOCK_PREPARATION_PROJECT_DELETE_ENABLED'
    const original = process.env[flag]
    beforeAll(async () => {
      process.env[flag] = 'true'
      fixture = stack()
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin, activation_status)
        SELECT id, id || '@example.test', id, 'synthetic', 'admin', '[]'::jsonb, true, true, 'activated'
        FROM unnest($1::text[]) AS actors(id)`, [[actor, otherAdmin]])
    })

    afterAll(async () => {
      if (original === undefined) delete process.env[flag]
      else process.env[flag] = original
      if (!fixture) return
      const own = [...tenants]
      const stages = own.map(id => id + ':integration-core')
      const sheets = (await q('SELECT sheet_id FROM plugin_multitable_object_registry WHERE project_id = ANY($1::text[])', [stages])).rows.map(row => row.sheet_id)
      await poolManager.get().transaction(async ({ query }) => {
        for (const table of ['integration_stock_prep_project_delete_challenges', 'integration_stock_prep_source_binding',
          'integration_stock_prep_pull_batch_settings', 'integration_stock_prep_project_write_lock', 'integration_stock_prep_project_target']) {
          await query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::text[])`, [own])
        }
        for (const table of ['meta_record_revisions', 'meta_records', 'meta_views', 'meta_fields', 'plugin_multitable_object_registry']) {
          await query(`DELETE FROM ${table} WHERE sheet_id = ANY($1::text[])`, [sheets])
        }
        await query('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets])
        const baseIds = own.map(id => deriveStockPreparationBaseId(id))
        await query('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [baseIds])
        await query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [[actor, otherAdmin]])
        await query('DELETE FROM users WHERE id = ANY($1::text[])', [[actor, otherAdmin]])
      })
    })

    test.each(['pull only', 'registration only', 'both'])('clears precisely the %s project and retains both controls', async mode => {
      const local = tenant()
      const target = project(local, 'synthetic-target')
      const neighbor = project(local, 'synthetic-control')
      const foreign = project(tenant(), target.projectNo)
      const hasPull = mode !== 'registration only'
      const hasRegistration = mode !== 'pull only'
      const ownSheet = hasPull ? await fixture.dedicated(target) : null
      const ownShared = hasRegistration ? await fixture.shared(target) : []
      const controlFacts = []
      for (const control of [neighbor, foreign]) {
        const sheet = await fixture.dedicated(control)
        const shared = await fixture.shared(control)
        const ids = [...sheet.ids, ...shared.map(row => row.recordId)]
        controlFacts.push({ control, sheet, shared, ids, before: await snapshot(control, sheet.sheetId, ids) })
      }
      const api = request(genericApp())
      const oldLabel = 'synthetic-old-notes-field'
      const viewOf = (sheetId: string) => api.get('/api/multitable/view').query({ sheetId })
      const contextOf = (sheetId: string) => api.get('/api/multitable/context').query({ sheetId })
      const siblingIds = async () => {
        const res = await contextOf(controlFacts[0].sheet.sheetId)
        expect(res.status).toBe(200)
        return res.body.data.sheets.map((s: { id: string }) => s.id)
      }
      if (ownSheet) {
        await q('UPDATE meta_fields SET name = $2 WHERE id = $1 AND sheet_id = $3', [ownSheet.fields.notes, oldLabel, ownSheet.sheetId])
        const warm = await viewOf(ownSheet.sheetId)
        expect(warm.status).toBe(200)
        expect(warm.body.data.fields).toContainEqual(expect.objectContaining({ id: ownSheet.fields.notes, name: oldLabel }))
        const guarded = await api.delete(`/api/multitable/sheets/${ownSheet.sheetId}`)
        expect([guarded.status, guarded.body.error.code]).toEqual([409, 'SHEET_PLUGIN_MANAGED'])
        const localSheetBases = await q('SELECT base_id FROM meta_sheets WHERE id = ANY($1::text[])', [
          [ownSheet.sheetId, controlFacts[0].sheet.sheetId],
        ])
        const baseId = deriveStockPreparationBaseId(local)
        expect(localSheetBases.rows).toEqual([{ base_id: baseId }, { base_id: baseId }])
        expect(await siblingIds()).toContain(ownSheet.sheetId)
        expect((await contextOf(ownSheet.sheetId)).status).toBe(200)
      }
      expect(await fixture.directory(target)).toEqual([target.projectNo])
      const previousAudit = await fixture.auditStore.append({ ...target, action: 'project_board_read', projectId: target.projectNo })
      const preview = await fixture.submit(target, 'preview')
      expect(preview).toMatchObject({
        tenantId: local, projectNo: target.projectNo,
        counts: { dedicatedSheets: Number(hasPull), dedicatedRows: hasPull ? 2 : 0, projectTargets: Number(hasPull),
          projectRows: Number(hasRegistration), snapshotBatches: Number(hasRegistration), snapshotLines: Number(hasRegistration),
          preparationLines: Number(hasRegistration), exceptions: Number(hasRegistration), confirmationDecisions: Number(hasRegistration),
          overviewRows: Number(hasRegistration), runRows: hasRegistration ? 2 : 0 },
      })
      if (ownSheet) expect(preview.tables).toContainEqual({ sheetId: ownSheet.sheetId, name: expect.any(String), kind: 'dedicated', rowCount: 2 })
      for (const row of ownShared) expect(preview.tables).toContainEqual({ sheetId: row.sheetId, name: expect.any(String), kind: 'shared', rowCount: row.kind === 'run' ? 2 : 1 })
      const done = await fixture.submit(target, 'confirm', { challengeId: preview.challengeId, code: preview.verificationCode })
      expect(done).toEqual({ tenantId: local, projectNo: target.projectNo, counts: preview.counts, auditId: expect.any(String) })
      expect(await fixture.directory(target)).toEqual([])
      expect(await fixture.service.isDeleted(target)).toBe(true)
      const deletedIds = [...(ownSheet?.ids ?? []), ...ownShared.map(row => row.recordId)]
      expect((await q('SELECT id FROM meta_records WHERE id = ANY($1::text[])', [deletedIds])).rows).toEqual([])
      if (ownSheet) {
        expect((await snapshot(target, ownSheet.sheetId, ownSheet.ids)).slice(0, 6)).toEqual([[], [], [], [], [], []])
        expect((await contextOf(ownSheet.sheetId)).status).toBe(404)
        expect((await viewOf(ownSheet.sheetId)).status).toBe(404)
        expect(await siblingIds()).not.toContain(ownSheet.sheetId)
      }
      for (const { control, sheet, ids, before } of controlFacts) {
        expect((await snapshot(control, sheet.sheetId, ids)).slice(0, 6)).toEqual(before.slice(0, 6))
        expect(await fixture.directory(control)).toEqual([control.projectNo])
        expect(await fixture.service.isDeleted(control)).toBe(false)
        expect((await contextOf(sheet.sheetId)).status).toBe(200)
      }
      const evidence = (await q('SELECT action, tenant_id, project_id, actor, detail, created_at FROM integration_stock_prep_audit WHERE id = $1', [done.auditId])).rows[0]
      expect(evidence).toEqual({ action: 'project_delete', tenant_id: local, project_id: target.projectNo, actor, detail: { counts: preview.counts }, created_at: expect.any(Date) })
      expect((await q('SELECT id FROM integration_stock_prep_audit WHERE id = $1', [previousAudit.id])).rows).toEqual([{ id: previousAudit.id }])
      expect(JSON.stringify(evidence)).not.toContain(preview.verificationCode)
      expect(JSON.stringify(evidence)).not.toContain('synthetic hand-filled contents')

      if (mode === 'both') {
        const env = { MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED: 'true' }
        const preflight = () => targets.resolveProjectTargetForAction({ ...target, store: fixture.registry, provisioning: fixture.provisioning,
          projectId: `${local}:integration-core`, targetPurpose: 'write', env })
        await expect(preflight()).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_ABSENT' })
        const rebuilt = await fixture.dedicated(target, false)
        expect(rebuilt.sheetId).toBe(ownSheet?.sheetId)
        expect(await fixture.service.isDeleted(target)).toBe(false)
        expect(await fixture.records.queryRecords({ sheetId: rebuilt.sheetId })).toEqual([])
        const fresh = await viewOf(rebuilt.sheetId)
        expect(fresh.status).toBe(200)
        expect(fresh.body.data.rows).toEqual([])
        const field = fresh.body.data.fields.find((row: { id: string }) => row.id === rebuilt.fields.notes)
        expect(field).toMatchObject({ id: rebuilt.fields.notes, name: expect.any(String) })
        expect(field.name).not.toBe(oldLabel)
        expect((await q('SELECT id FROM meta_records WHERE id = ANY($1::text[])', [deletedIds])).rows).toEqual([])
      }
    }, 120000)

    test('delivery rehearsal pulls through the scheduler, fills a manual row over HTTP, deletes both sources and exercises the unchanged schedule', async () => {
      await exerciseProjectDeleteDelivery(pinned, fixture, project(tenant(), 'delivery'))
    }, 120000)

    test('deletes rich-text history and fences stale sessions after same-sheet recreation while preserving a control record', async () => {
      const scope = project(tenant(), 'rich-text-target')
      const target = await fixture.dedicated(scope)
      const control = await fixture.dedicated(project(scope.tenantId, 'rich-text-control'))
      const recycleAndRestore = async (recordId: string) => {
        const api = request(genericApp())
        expect((await api.delete(`/api/multitable/records/${recordId}`)).status).toBe(200)
        expect((await api.post(`/api/multitable/records/${recordId}/restore`).send({})).status).toBe(200)
      }
      await checkProjectDeleteYjs(scope, fixture.service, target.ids[0], control.ids[1], control.sheetId, async () => {
        const rebuilt = await fixture.dedicated(scope, false)
        expect(rebuilt.sheetId).toBe(target.sheetId)
        return rebuilt
      }, recycleAndRestore)
    }, 60000)

    test('purges scoped legacy and current job results and tokens, refusing both unfinished parent and checkpoint', async () => {
      const scope = project(tenant(), 'runtime')
      const own = await fixture.dedicated(scope)
      const legacy = await lib('stock-preparation-target-provisioning').ensureStockPreparationSandboxTarget({
        projectId: scope.tenantId + ':integration-core', objectId: 'plm_stock_preparation_sandbox', context: fixture.context, permission: 'admin',
      })
      expect(legacy.ready).toBe(true)
      const { sheetId, fieldIdMap } = legacy.target
      const create = (projectNo: string) => fixture.records.createRecord({ sheetId, data: { [fieldIdMap.projectNo]: projectNo } })
      const mine = await create(scope.projectNo)
      const theirs = await create('another-project')
      await checkProjectDeleteRuntime(scope, fixture.service, own.sheetId, sheetId, async () => {
        const rebuilt = await fixture.dedicated(scope, false)
        expect(rebuilt.sheetId).toBe(own.sheetId)
        return rebuilt.sheetId
      })
      expect((await fixture.records.queryRecords({ sheetId })).map(row => row.id)).toEqual([theirs.id])
      expect((await q('SELECT id FROM meta_records WHERE id = $1', [mine.id])).rows).toEqual([])
    }, 60000)

    test('rejects a changed row, a wrong/expired code, another scope, and a replay; concurrent claims succeed once', async () => {
      const scope = project(tenant(), 'binding')
      const sheet = await fixture.dedicated(scope)
      const first = await fixture.service.preview(scope)
      const input = params(scope, first)
      const otherTenant = tenant()
      await fixture.admitAdmins(otherTenant)
      for (const switched of [{ actor: otherAdmin }, { tenantId: otherTenant }, { projectNo: 'other-project' }]) {
        await expect(fixture.service.confirm({ ...input, ...switched })).rejects.toMatchObject(badCode)
      }
      const wrong = first.verificationCode === '00000000' ? 'FFFFFFFF' : '00000000'
      await expect(fixture.service.confirm({ ...input, verificationCode: wrong })).rejects.toMatchObject(badCode)
      await expect(fixture.service.confirm(input)).rejects.toMatchObject(badCode)
      const expired = await fixture.service.preview(scope)
      await q("UPDATE integration_stock_prep_project_delete_challenges SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.challengeId])
      await expect(fixture.service.confirm(params(scope, expired))).rejects.toMatchObject(badCode)
      const stale = await fixture.service.preview(scope)
      await fixture.records.patchRecord({ sheetId: sheet.sheetId, recordId: sheet.ids[0], changes: { [sheet.fields.notes]: 'changed without adding a row' } })
      await expect(fixture.service.confirm(params(scope, stale))).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_DELETE_STALE' })
      expect((await fixture.records.queryRecords({ sheetId: sheet.sheetId })).map(row => row.id).sort()).toEqual([...sheet.ids].sort())
      const current = params(scope, await fixture.service.preview(scope))
      const attempts = await Promise.allSettled([fixture.service.confirm(current), fixture.service.confirm(current)])
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1)
      await expect(fixture.service.confirm(current)).rejects.toMatchObject(badCode)
      expect((await q("SELECT action FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'project_delete'", [scope.tenantId])).rows).toEqual([{ action: 'project_delete' }])
    }, 60000)

    test('refuses an active lease, a concurrent grid write, and a dedicated row carrying another project number', async () => {
      const scope = project(tenant(), 'busy')
      const sheet = await fixture.dedicated(scope)
      const lock = createStockPreparationProjectWriteLock({ db: fixture.db })
      await lock.withProjectWriteLease(sheetWriteScopeKey(sheet.sheetId), { tenantId: scope.tenantId, purpose: 'small_apply', runId: 'delete-test' }, async () => {
        await expect(fixture.service.preview(scope)).rejects.toMatchObject(busy)
      })
      const input = params(scope, await fixture.service.preview(scope))
      await poolManager.get().transaction(async ({ query }) => {
        await query('UPDATE meta_records SET version = version WHERE id = $1', [sheet.ids[0]])
        await expect(fixture.service.confirm(input)).rejects.toMatchObject(busy)
      })
      await fixture.records.patchRecord({ sheetId: sheet.sheetId, recordId: sheet.ids[0], changes: { [sheet.fields.projectNo]: 'different-project' } })
      await expect(fixture.service.preview(scope)).rejects.toMatchObject(ambiguous)
      expect(await fixture.registry.get(scope)).toMatchObject({ sheetId: sheet.sheetId })
    }, 60000)

    test.each(['mid-delete', 'audit'])('rolls back the entire transaction upon a real %s refusal', async fault => {
      const scope = project(tenant(), 'rollback')
      const sheet = await fixture.dedicated(scope)
      const shared = await fixture.shared(scope)
      const ids = [...sheet.ids, ...shared.map(row => row.recordId)]
      const original = await snapshot(scope, sheet.sheetId, ids)
      const challenge = params(scope, await fixture.service.preview(scope))
      const fn = `project_delete_fault_${randomUUID().replaceAll('-', '')}`
      // Filter the trigger by a generated fixture id: even another test writing to the same database is unaffected.
      const isAudit = fault === 'audit'
      const relation = isAudit ? 'integration_stock_prep_audit' : 'meta_sheets'
      const event = isAudit ? 'INSERT' : 'DELETE'
      const condition = isAudit ? "NEW.action = 'project_delete' AND NEW.tenant_id = TG_ARGV[0]" : 'OLD.id = TG_ARGV[0]'
      const arg = isAudit ? scope.tenantId : sheet.sheetId
      if (!/^[A-Za-z0-9_]+$/.test(arg)) throw new Error('fixture trigger id invalid')
      await q(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic rollback'; END IF;
        RETURN ${isAudit ? 'NEW' : 'OLD'}; END; $body$`)
      try {
        await q(`CREATE TRIGGER ${fn} BEFORE ${event} ON ${relation} FOR EACH ROW EXECUTE FUNCTION ${fn}('${arg}')`)
        await expect(fixture.service.confirm(challenge)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_DELETE_FAILED' })
        expect(await snapshot(scope, sheet.sheetId, ids)).toEqual(original)
      } finally {
        await q(`DROP TRIGGER IF EXISTS ${fn} ON ${relation}`)
        await q(`DROP FUNCTION ${fn}()`)
      }
      await expect(fixture.service.confirm(challenge)).resolves.toMatchObject({ projectNo: scope.projectNo })
    }, 60000)

    test('deletion releases an archived-inclusive quota slot and preserves tenant settings byte-for-byte', async () => {
      const scope = project(tenant(), 'quota-target')
      const sheet = await fixture.dedicated(scope)
      const { tenantId } = scope
      await q(`INSERT INTO integration_stock_prep_project_target
        (id, tenant_id, project_no, sheet_id, object_id, status, archived_at)
        SELECT $1 || i, $1, 'other-' || i, $1 || '-sheet-' || i, $1 || '-object-' || i,
          CASE WHEN i = 1 THEN 'archived' ELSE 'active' END, CASE WHEN i = 1 THEN NOW() ELSE NULL END
        FROM generate_series(1, 199) i`, [tenantId])
      await q(`INSERT INTO integration_stock_prep_source_binding (id, tenant_id, action_id, external_system_id)
        VALUES ($1, $2, 'synth-action', 'synth-system')`, [randomUUID(), tenantId])
      await q(`INSERT INTO integration_stock_prep_pull_batch_settings
        (tenant_id, first_pull_batch_rule, label_format, landing_mode, band_placement)
        VALUES ($1, 'predecessor_suffix', 'ordinal', 'keep_current', 'right')`, [tenantId])
      const config = async () => Promise.all([
        q('SELECT * FROM integration_stock_prep_source_binding WHERE tenant_id = $1', [tenantId]).then(r => r.rows),
        q('SELECT * FROM integration_stock_prep_pull_batch_settings WHERE tenant_id = $1', [tenantId]).then(r => r.rows),
      ])
      const before = await config()
      expect(before.map(rows => rows.length)).toEqual([1, 1])
      const next = { tenantId, projectNo: 'next', sheetId: `${sheet.sheetId}_next`, objectId: 'next_object', maxPerTenant: targets.MAX_PROJECT_TARGETS_PER_TENANT }
      expect(await fixture.registry.count({ tenantId })).toBe(200)
      await expect(fixture.registry.create(next)).rejects.toMatchObject({ code: 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT' })
      await fixture.service.confirm(params(scope, await fixture.service.preview(scope)))
      expect(await fixture.registry.count({ tenantId })).toBe(199)
      const newSheet = await fixture.dedicated(project(tenantId, next.projectNo), false)
      expect(await fixture.registry.get(next)).toMatchObject({ sheetId: newSheet.sheetId })
      expect(await fixture.registry.count({ tenantId })).toBe(200)
      expect(await config()).toEqual(before)
    }, 60000)
  })
}
