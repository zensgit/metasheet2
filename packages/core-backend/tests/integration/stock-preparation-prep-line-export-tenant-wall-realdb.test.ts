/**
 * 按项目导出物料 — the export's TENANT WALL against the REAL ownership registry (real DB).
 *
 * The materials export reads the deploy-global table-action target. Before the wall, an operator of
 * tenant B whose scope resolved cleanly to tenant B was served tenant A's material rows by naming one
 * of tenant A's project numbers, because nothing asked whose sheet the binding named. The export now
 * runs the carry's wall (plugin-integration-core http-routes.cjs
 * `assertStockPreparationTargetBelongsToTenant`), in its own PREP_LINE_EXPORT_TARGET_* vocabulary.
 *
 * This suite drives the ACTUAL `stockPreparationPrepLineExport` handler through:
 *   - real `ensureObject` (meta_sheets/meta_fields) and real `claimPluginObjectScope`
 *     (plugin_multitable_object_registry) — the same pair the host's plugin-scoped ensure runs;
 *   - the SHIPPED ownership port: `isSheetOwnedByProject` from plugin-scope.ts (the function
 *     index.ts wires) and the platform's own `getObjectSheetId`, reached THROUGH
 *     `createPluginScopedMultitableApi` exactly as the plugin reaches it;
 *   - real `createRecord` / `queryRecords` over meta_records, with every records read COUNTED.
 * Physical field ids are discovered from meta_fields, never recomputed from the id formula.
 *
 *   R-01 DEMO-MACHINE SHAPE: a sheet tenant A's ensure provisioned and the registry records, bound by
 *        hand with an action config that names no objectId (so the bound id is NOT the one derived
 *        for the action's objectId) — tenant A exports its rows, 200.
 *   R-02 OTHER TENANT: the same deployment, tenant B's operator (a real member of tenant B) — 409
 *        PREP_LINE_EXPORT_TARGET_TENANT_MISMATCH with ZERO records reads, no audit, no workbook, and
 *        no canary anywhere in what was sent.
 *   R-03 PRE-REGISTRY INSTALL: a sheet with NO registry row whose id IS the one derived for (tenant A,
 *        target.objectId) — tenant A exports through the derived-id fallback, 200.
 */
import { createRequire } from 'module'
import { randomUUID } from 'node:crypto'

import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import {
  ensureObject,
  getObjectSheetId,
  type MultitableProvisioningObjectDescriptor,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'
import { createRecord, queryRecords } from '../../src/multitable/records'
import {
  claimPluginObjectScope,
  createPluginScopedMultitableApi,
  isSheetOwnedByProject,
} from '../../src/multitable/plugin-scope'

const require = createRequire(import.meta.url)
const PLUGIN_LIB = '../../../../plugins/plugin-integration-core/lib'
// THE REGISTERED ROUTE, not the bare handler: registration is what maps a thrown refusal to its HTTP
// status and envelope, so this is exactly what a caller of the route receives.
const { registerIntegrationRoutes } = require(`${PLUGIN_LIB}/http-routes.cjs`) as {
  registerIntegrationRoutes: (input: {
    context: Record<string, unknown>
    services: Record<string, unknown>
    logger: Record<string, () => void>
  }) => void
}
const EXPORT_ROUTE = 'GET /api/integration/stock-preparation/prep-lines/export'
const {
  buildStockPreparationTargetDescriptor,
  sandboxStockPreparationTemplate,
} = require(`${PLUGIN_LIB}/stock-preparation-target-provisioning.cjs`) as {
  buildStockPreparationTargetDescriptor: (input: Record<string, unknown>) => MultitableProvisioningObjectDescriptor
  sandboxStockPreparationTemplate: (input: Record<string, unknown>) => unknown
}
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(`${PLUGIN_LIB}/stock-preparation-templates.cjs`) as {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: { objectId: string; fields: Array<{ id: string }> }
}
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(`${PLUGIN_LIB}/stock-preparation-table-actions.cjs`) as {
  PLM_STOCK_PREPARATION_ACTION_ID: string
}
const { STOCK_PREP_OPERATE, STOCK_PREP_READ } = require(`${PLUGIN_LIB}/stock-preparation-workbench-access.cjs`) as {
  STOCK_PREP_OPERATE: string
  STOCK_PREP_READ: string
}

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !dbUrl) {
  test('prep-line export tenant wall real-DB step must provide DATABASE_URL', () => {
    throw new Error('prep-line export tenant wall real-DB step is missing DATABASE_URL')
  })
}

const PLUGIN_NAME = 'plugin-integration-core'
const TOKEN = randomUUID().replace(/-/g, '').slice(0, 10)
const TENANT_A = `tenant_wall_a_${TOKEN}`
const TENANT_B = `tenant_wall_b_${TOKEN}`
const STAGING_A = `${TENANT_A}:integration-core`
const STAGING_B = `${TENANT_B}:integration-core`
const CANONICAL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
// The sandbox twin tenant A's own ensure provisions: a restamped copy of the canonical template.
const SANDBOX_OBJECT_ID = `plm_stock_preparation_sandbox_w${TOKEN}`
const PROJECT_NO = `PRJ-WALL-${TOKEN}`
// Canaries — synthetic, unmistakable, planted only in tenant A's sheets.
const A_MATERIAL = `ZZWALLAMATERIAL${TOKEN}ZZ`
const A_LEGACY_MATERIAL = `ZZWALLALEGACY${TOKEN}ZZ`

const OPERATOR_A = { id: `u_wall_a_${TOKEN}`, tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
const OPERATOR_B = { id: `u_wall_b_${TOKEN}`, tenantId: TENANT_B, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] }
const MEMBERSHIPS: Record<string, string[]> = { [OPERATOR_A.id]: [TENANT_A], [OPERATOR_B.id]: [TENANT_B] }

type TestResponse = {
  statusCode: number
  body: unknown
  sentBuffer: Buffer | null
  headers: Record<string, string>
  status(code: number): TestResponse
  json(body: unknown): TestResponse
  setHeader(name: string, value: string): TestResponse
  send(payload: Buffer): TestResponse
}

function response(): TestResponse {
  return {
    statusCode: 200,
    body: null,
    sentBuffer: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { this.sentBuffer = payload; return this },
  }
}

function everythingSent(res: TestResponse): string {
  return [
    JSON.stringify(res.body),
    res.sentBuffer ? res.sentBuffer.toString('utf8') : '',
    JSON.stringify(res.headers),
  ].join('\n')
}

function unused(name: string): () => never {
  return () => {
    throw new Error(`unexpected service call: ${name}`)
  }
}

function inert(methods: string[]): Record<string, () => never> {
  return Object.fromEntries(methods.map((method) => [method, unused(method)]))
}

describeIfDatabase('prep-line export tenant wall (real registry, real records, real route)', () => {
  let pool: Pool
  const createdSheetIds: string[] = []
  const recordsReads: string[] = []
  const registryCalls: Array<{ sheetId: string; projectId: string }> = []
  let handSheetId = ''
  let legacySheetId = ''
  let handFieldIdMap: Record<string, string> = {}
  let legacyFieldIdMap: Record<string, string> = {}

  const readQuery: MultitableProvisioningQueryFn = async (sql, params) => {
    const result = await pool.query(sql, params as unknown[])
    return { rows: result.rows, rowCount: result.rowCount }
  }

  async function inTransaction<T>(fn: (query: MultitableProvisioningQueryFn) => Promise<T>): Promise<T> {
    const client: PoolClient = await pool.connect()
    const query: MultitableProvisioningQueryFn = async (sql, params) => {
      const result = await client.query(sql, params as unknown[])
      return { rows: result.rows, rowCount: result.rowCount }
    }
    try {
      await client.query('BEGIN')
      const out = await fn(query)
      await client.query('COMMIT')
      return out
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async function discoverFieldIdMap(sheetId: string, descriptor: MultitableProvisioningObjectDescriptor): Promise<Record<string, string>> {
    const result = await pool.query('SELECT id, name FROM meta_fields WHERE sheet_id = $1', [sheetId])
    const idByName = new Map((result.rows as Array<{ id: string; name: string }>).map((row) => [row.name, row.id]))
    const map: Record<string, string> = {}
    for (const field of descriptor.fields) {
      const physical = idByName.get(field.name)
      if (!physical) throw new Error(`real meta_fields row missing for ${field.id}`)
      map[field.id] = physical
    }
    return map
  }

  async function seedRow(sheetId: string, fieldIdMap: Record<string, string>, componentName: string): Promise<void> {
    await inTransaction((query) => createRecord({
      query: query as never,
      sheetId,
      data: {
        [fieldIdMap.projectNo]: PROJECT_NO,
        [fieldIdMap.idempotencyKey]: `key_${componentName}`,
        [fieldIdMap.componentCode]: `DWG-${TOKEN}`,
        [fieldIdMap.componentName]: componentName,
        [fieldIdMap.totalQuantity]: 3,
        [fieldIdMap.active]: true,
      },
    }))
  }

  /** The host's plugin-facing multitable surface, as index.ts builds it, with records reads counted. */
  function pluginMultitable() {
    const raw = {
      provisioning: {
        getObjectSheetId: (projectId: string, objectId: string) => getObjectSheetId(projectId, objectId),
        isSheetOwnedByProject: async (sheetId: string, projectId: string) => {
          registryCalls.push({ sheetId, projectId })
          return isSheetOwnedByProject(readQuery as never, sheetId, projectId)
        },
      },
      records: {
        queryRecords: async (input: Record<string, unknown>) => {
          recordsReads.push(String(input.sheetId))
          return queryRecords({ query: readQuery as never, ...(input as { sheetId: string }) })
        },
      },
    }
    return createPluginScopedMultitableApi(raw as never, PLUGIN_NAME, {})
  }

  function mountExport(target: Record<string, unknown>) {
    const auditAppends: unknown[] = []
    const xlsxCalls: unknown[] = []
    const services = {
      externalSystemRegistry: inert(['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems']),
      adapterRegistry: inert(['createAdapter', 'listAdapterKinds']),
      pipelineRegistry: inert(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
      pipelineRunner: inert(['runPipeline']),
      deadLetterStore: inert(['listDeadLetters']),
      stagingInstaller: inert(['installStaging', 'listStagingDescriptors']),
      templateRegistry: inert(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
      readSourceConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      readSourceCompositionConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      bridgeAgentChecklistStore: inert(['saveVersion', 'approve', 'retire', 'getForApply']),
      stockPreparationAuditStore: {
        async append(entry: unknown) {
          auditAppends.push(entry)
          return { ok: true }
        },
      },
      stockPreparationXlsxExport: {
        async buildWorkbookBuffer(params: unknown) {
          xlsxCalls.push(params)
          return Buffer.from(JSON.stringify(params), 'utf8')
        },
      },
      tenantPrincipalDirectory: {
        async verifyTenantMembership(input: { userId?: string; tenantId?: string }) {
          return { member: (MEMBERSHIPS[String(input.userId)] || []).includes(String(input.tenantId)) }
        },
      },
    }
    const routes = new Map<string, (req: Record<string, unknown>, res: TestResponse) => Promise<unknown>>()
    const context = {
      api: {
        http: {
          addRoute(method: string, routePath: string, handler: (req: Record<string, unknown>, res: TestResponse) => Promise<unknown>) {
            routes.set(`${method.toUpperCase()} ${routePath}`, handler)
          },
        },
        multitable: pluginMultitable(),
      },
      storage: new Map(),
      config: {
        stockPreparationTableActions: [{
          actionId: PLM_STOCK_PREPARATION_ACTION_ID,
          source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
          target,
        }],
      },
    }
    registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
    const handler = routes.get(EXPORT_ROUTE)
    if (!handler) throw new Error('the export route was not registered')
    return { handler, auditAppends, xlsxCalls }
  }

  async function exportAs(mounted: ReturnType<typeof mountExport>, user: typeof OPERATOR_A): Promise<TestResponse> {
    recordsReads.length = 0
    registryCalls.length = 0
    const res = response()
    await mounted.handler({
      user,
      authenticatedTenantId: user.tenantId,
      body: {},
      query: { projectNo: PROJECT_NO },
      params: {},
    }, res)
    return res
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })

    // TENANT A'S OWN SANDBOX TWIN — provisioned and REGISTERED the way the host's plugin-scoped
    // ensure does it (ensureObject + claimPluginObjectScope, one transaction).
    const sandboxDescriptor = buildStockPreparationTargetDescriptor({
      template: sandboxStockPreparationTemplate({ objectId: SANDBOX_OBJECT_ID }),
      locale: 'en',
    })
    const sandbox = await inTransaction(async (query) => {
      const result = await ensureObject({ query, projectId: STAGING_A, baseId: null, descriptor: sandboxDescriptor })
      await claimPluginObjectScope(query as never, {
        pluginName: PLUGIN_NAME,
        projectId: STAGING_A,
        objectId: SANDBOX_OBJECT_ID,
        sheetId: result.sheet.id,
      })
      return result
    })
    handSheetId = sandbox.sheet.id
    createdSheetIds.push(handSheetId)
    handFieldIdMap = await discoverFieldIdMap(handSheetId, sandboxDescriptor)
    await seedRow(handSheetId, handFieldIdMap, A_MATERIAL)

    // TENANT A'S PRE-REGISTRY CANONICAL TABLE — provisioned with NO registry row (the raw ensure alone,
    // which is what an install that predates the registry has).
    const canonicalDescriptor = buildStockPreparationTargetDescriptor({ locale: 'en' })
    const canonical = await inTransaction((query) => ensureObject({ query, projectId: STAGING_A, baseId: null, descriptor: canonicalDescriptor }))
    legacySheetId = canonical.sheet.id
    createdSheetIds.push(legacySheetId)
    legacyFieldIdMap = await discoverFieldIdMap(legacySheetId, canonicalDescriptor)
    await seedRow(legacySheetId, legacyFieldIdMap, A_LEGACY_MATERIAL)
  })

  afterAll(async () => {
    if (!pool) return
    for (const sheetId of createdSheetIds) {
      await pool.query('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await pool.query('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await pool.query('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await pool.query('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    }
    await pool.end()
  })

  test('fixture facts: the hand-bound sheet is registered to tenant A and derived for NEITHER tenant\'s canonical objectId; the legacy one has no registry row', async () => {
    const registered = await pool.query(
      'SELECT project_id FROM plugin_multitable_object_registry WHERE sheet_id = $1',
      [handSheetId],
    )
    expect(registered.rows).toEqual([{ project_id: STAGING_A }])
    expect(handSheetId).not.toBe(getObjectSheetId(STAGING_A, CANONICAL_OBJECT_ID))
    expect(handSheetId).not.toBe(getObjectSheetId(STAGING_B, CANONICAL_OBJECT_ID))
    const legacyRegistered = await pool.query(
      'SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1',
      [legacySheetId],
    )
    expect(legacyRegistered.rows).toEqual([])
    expect(legacySheetId).toBe(getObjectSheetId(STAGING_A, CANONICAL_OBJECT_ID))
  })

  test('R-01 demo-machine shape: registry-proven, hand-bound, config names no objectId — tenant A exports its rows', async () => {
    // No objectId in the config: normalizeTarget defaults it to the CANONICAL id, whose derived sheet
    // is NOT the bound one — so only the registry can attribute this sheet to tenant A.
    const mounted = mountExport({ sheetId: handSheetId, fieldIdMap: handFieldIdMap })
    const res = await exportAs(mounted, OPERATOR_A)
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
    expect(everythingSent(res)).toContain(A_MATERIAL)
    expect(recordsReads.length).toBeGreaterThan(0)
    expect(new Set(recordsReads)).toEqual(new Set([handSheetId]))
    expect(registryCalls).toEqual([{ sheetId: handSheetId, projectId: STAGING_A }])
    expect(mounted.auditAppends).toHaveLength(1)
  })

  test('R-02 the other tenant\'s operator is refused before a single records read, and sees nothing', async () => {
    const mounted = mountExport({ sheetId: handSheetId, fieldIdMap: handFieldIdMap })
    const res = await exportAs(mounted, OPERATOR_B)
    expect(res.statusCode, JSON.stringify(res.body)).toBe(409)
    expect((res.body as { error?: { code?: string } }).error?.code).toBe('PREP_LINE_EXPORT_TARGET_TENANT_MISMATCH')
    expect(recordsReads, 'ZERO reads of the target sheet').toEqual([])
    expect(registryCalls, 'the registry was asked about tenant B\'s OWN staging project').toEqual([{ sheetId: handSheetId, projectId: STAGING_B }])
    expect(mounted.auditAppends).toEqual([])
    expect(mounted.xlsxCalls).toEqual([])
    const sent = everythingSent(res)
    expect(sent).not.toContain(A_MATERIAL)
    expect(sent).not.toContain(handSheetId)
    expect(sent).not.toContain(STAGING_A)
  })

  test('R-03 pre-registry install: no registry row, bound id IS the derived one — tenant A exports through the fallback', async () => {
    const mounted = mountExport({ sheetId: legacySheetId, objectId: CANONICAL_OBJECT_ID, fieldIdMap: legacyFieldIdMap })
    const res = await exportAs(mounted, OPERATOR_A)
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200)
    expect(everythingSent(res)).toContain(A_LEGACY_MATERIAL)
    expect(new Set(recordsReads)).toEqual(new Set([legacySheetId]))
    // ...and the same legacy sheet is still NOT tenant B's.
    const refused = await exportAs(mounted, OPERATOR_B)
    expect(refused.statusCode).toBe(409)
    expect(recordsReads).toEqual([])
  })
})
