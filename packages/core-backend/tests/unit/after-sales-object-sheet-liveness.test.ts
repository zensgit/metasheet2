/**
 * #5835 — the after-sales plugin must not answer a MISSING object sheet with the RULE-DERIVED sheet id.
 *
 * `plugins/plugin-after-sales/lib/multitable-helpers.cjs` `findObjectSheetId` used to fall back to
 * `provisioning.getObjectSheetId(projectId, objectId)` whenever `findObjectSheet` came back null, and
 * every route then read and wrote records with that derived id. Since #5834 the core record ops refuse
 * a deleted sheet, so nothing leaked — but the operator saw a bare 404 per request and could not tell
 * "someone deleted the table" from "no such record". These tests pin the replacement: a values-free
 * OBJECT_SHEET_UNAVAILABLE with a reason, mapped by the plugin's route layer to a guided Chinese hint,
 * with NO record call against the derived id, ever.
 *
 * ── SCOPE, exactly ────────────────────────────────────────────────────────────
 * "every route" means every route that resolves an object sheet THROUGH `findObjectSheetId`, and the
 * population is DERIVED FROM THE PLUGIN SOURCE (`tests/utils/after-sales-object-sheet-route-scan.ts`),
 * not from the literal table below: the ledger test asserts the scan's guarded set equals
 * SHEET_ROUTES and its unguarded-but-reaching set equals EXEMPT_ROUTES, so a 22nd route added without
 * the mapping reds here instead of silently answering 500. The four `/parts` routes ARE exempt by
 * name, with their reason (the web client keys on AFTER_SALES_OBJECT_UNAVAILABLE to hide the parts
 * tab); they keep their own code/status/message and are asserted separately, `details.reason`
 * included.
 *
 * ── WHICH CASES ARE LOAD-BEARING ──────────────────────────────────────────────
 * Per route, the DELETED and ABSENT cases die if the fix is reverted. The `throws` case and the LIVE
 * case are CONTROLS: they hold on the pre-#5835 tree too, and are labelled as such. Same for the
 * "legacy host with no liveness capability" and "installer composes no id" tests.
 *
 * All in-memory: the plugin is driven through its registered handlers with fake multitable seams. No
 * DB, no supertest, no `request(app)`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { scanAfterSalesObjectSheetRoutes } from '../utils/after-sales-object-sheet-route-scan'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../../../../plugins/plugin-after-sales/index.cjs') as {
  activate: (context: unknown) => Promise<void>
  deactivate: () => Promise<void>
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const helpers = require('../../../../plugins/plugin-after-sales/lib/multitable-helpers.cjs') as {
  OBJECT_SHEET_UNAVAILABLE_CODE: string
  OBJECT_SHEET_UNAVAILABLE_REASONS: { ABSENT: string; DELETED: string; UNKNOWN: string }
  isObjectSheetUnavailableError: (err: unknown) => boolean
  findObjectSheetId: (
    provisioning: unknown,
    projectId: string,
    objectId: string,
  ) => Promise<string>
}

const TENANT_ID = 'tenant_42'
const APP_ID = 'after-sales'
const PROJECT_ID = `${TENANT_ID}:${APP_ID}`
const OBJECT_IDS = ['serviceTicket', 'serviceRecord', 'installedAsset', 'customer', 'partItem', 'followUp']

/** The id the OLD code fell back to. No record call may ever carry it. */
const derivedSheetId = (objectId: string) => `derived_sheet__${objectId}`
const liveSheetId = (objectId: string) => `live_sheet__${objectId}`

/**
 * The user-facing hints, pinned here because they are the point of the fix.
 *
 * The DELETED hint must NOT advise 重新开通: a soft-deleted sheet still owns the deterministic id, so
 * `ensureSheet` inserts nothing, reads back null and throws — the install then fails and flips the
 * ledger to 'failed' (pinned in "a re-install cannot repair a DELETED object sheet" below).
 */
const HINT_DELETED = '售后对象表已删除，请先恢复该表后重试；重新开通无法修复已删除的表，如无法恢复请联系管理员'
const HINT_ABSENT = '售后对象表尚未开通，请先开通售后应用后重试；若开通失败，该表可能曾被删除，请联系管理员恢复'
const HINT_UNKNOWN = '售后对象表当前不可用，请确认售后应用已开通且对象表未被删除'

/** The part-inventory refusal, unchanged by #5835 except for the added `details.reason`. */
const PART_ITEM_UNAVAILABLE_MESSAGE =
  'After-sales part inventory is unavailable for the current install state'

type SheetMode = 'live' | 'missing' | 'throws'

/** Logical sample rows per object, so a read-then-write route has a complete record to work from. */
const LOGICAL_SAMPLES: Record<string, Record<string, unknown>> = {
  serviceTicket: {
    ticketNo: 'TK-2001',
    title: 'Existing ticket',
    source: 'phone',
    priority: 'high',
    status: 'new',
    refundStatus: 'none',
    refundAmount: 0,
  },
  serviceRecord: {
    ticketNo: 'TK-2001',
    visitType: 'onsite',
    scheduledAt: '2026-04-09T09:00:00Z',
    technicianName: 'Tech One',
    workSummary: 'Replaced capacitor',
    result: 'resolved',
  },
  installedAsset: {
    assetCode: 'AST-1001',
    serialNo: 'SN-1001',
    model: 'Compressor X1',
    location: 'Plant 1',
    installedAt: '2026-04-01T09:00:00Z',
    status: 'active',
  },
  customer: { customerCode: 'CUS-1001', name: 'Alice Plant', status: 'active' },
  partItem: { partNo: 'PRT-1001', name: 'Starter Capacitor', status: 'available', stockQty: 3 },
  followUp: {
    ticketNo: 'TK-2001',
    customerName: 'Alice Plant',
    dueAt: '2026-04-10T09:00:00Z',
    followUpType: 'phone',
    status: 'open',
  },
}

/** Which object a fake sheet id belongs to — live or derived, so a leak would still be readable. */
const objectOfSheetId = (sheetId: unknown) =>
  OBJECT_IDS.find((objectId) => sheetId === liveSheetId(objectId) || sheetId === derivedSheetId(objectId))

/** The sample row keyed the way the multitable seam keys it: `${projectId}:${objectId}:${fieldId}`. */
function physicalSample(sheetId: unknown): Record<string, unknown> {
  const objectId = objectOfSheetId(sheetId)
  if (!objectId) return {}
  return Object.fromEntries(
    Object.entries(LOGICAL_SAMPLES[objectId] || {}).map(([fieldId, value]) => [
      `${PROJECT_ID}:${objectId}:${fieldId}`,
      value,
    ]),
  )
}

type RecordCall = { fn: string; sheetId: unknown }

class FakeResponse {
  statusCode = 200
  body: any = null

  status(code: number) {
    this.statusCode = code
    return this
  }

  json(payload: any) {
    this.body = payload
    return this
  }
}

interface Harness {
  context: unknown
  routes: Map<string, (req: any, res: FakeResponse) => Promise<void>>
  recordCalls: RecordCall[]
  findObjectSheet: ReturnType<typeof vi.fn>
  getObjectSheetId: ReturnType<typeof vi.fn>
  isSheetOwnedByProject: ReturnType<typeof vi.fn>
  ensureObject: ReturnType<typeof vi.fn>
  setSheetMode: (mode: SheetMode) => void
  setRegistryClaimed: (claimed: boolean) => void
  seedInstalled: () => void
  /** status of the install ledger row the plugin reads back, or null when there is none */
  ledgerStatus: () => string | null
}

function createHarness(): Harness {
  const routes = new Map<string, (req: any, res: FakeResponse) => Promise<void>>()
  const recordCalls: RecordCall[] = []
  let sheetMode: SheetMode = 'live'
  let registryClaimed = true
  const ledgerRows: Record<string, unknown>[] = []

  const database = {
    async query(sql: string, params: unknown[] = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT')) {
        const [tenantId, appId] = params as [string, string]
        return ledgerRows.filter((row) => row.tenant_id === tenantId && row.app_id === appId)
      }
      if (normalized.startsWith('INSERT INTO')) {
        const [
          tenantId,
          appId,
          projectId,
          templateId,
          templateVersion,
          mode,
          status,
          createdObjectsJson,
          createdViewsJson,
          warningsJson,
          displayName,
          configJson,
        ] = params as string[]
        const now = new Date()
        const existingIndex = ledgerRows.findIndex(
          (row) => row.tenant_id === tenantId && row.app_id === appId,
        )
        const nextRow = {
          id: 'fake-uuid-1',
          tenant_id: tenantId,
          app_id: appId,
          project_id: projectId,
          template_id: templateId,
          template_version: templateVersion,
          mode,
          status,
          created_objects_json: createdObjectsJson,
          created_views_json: createdViewsJson,
          warnings_json: warningsJson,
          display_name: displayName,
          config_json: configJson,
          last_install_at: now,
          created_at: now,
        }
        if (existingIndex >= 0) {
          ledgerRows[existingIndex] = nextRow
        } else {
          ledgerRows.push(nextRow)
        }
        return [nextRow]
      }
      return []
    },
  }

  const getObjectSheetId = vi.fn((_projectId: string, objectId: string) => derivedSheetId(objectId))
  const getFieldId = vi.fn(
    (projectId: string, objectId: string, fieldId: string) => `${projectId}:${objectId}:${fieldId}`,
  )
  const findObjectSheet = vi.fn(async (input: { projectId: string; objectId: string }) => {
    if (sheetMode === 'throws') {
      throw new Error('multitable lookup failed')
    }
    if (sheetMode === 'missing') {
      return null
    }
    return {
      id: liveSheetId(input.objectId),
      baseId: 'base_legacy',
      name: input.objectId,
      description: null,
    }
  })
  const isSheetOwnedByProject = vi.fn(async () => registryClaimed)
  const resolveFieldIds = vi.fn(
    async (input: { projectId: string; objectId: string; fieldIds: string[] }) =>
      Object.fromEntries(
        input.fieldIds.map((fieldId) => [fieldId, `${input.projectId}:${input.objectId}:${fieldId}`]),
      ),
  )
  /**
   * Models the REAL `ensureObject` -> `ensureSheet` semantics (core-backend
   * src/multitable/provisioning.ts): `INSERT ... ON CONFLICT (id) DO NOTHING` against the
   * deterministic id, then `loadActiveSheet` (`deleted_at IS NULL`) and
   * `throw new Error('Failed to ensure sheet: <id>')` when that read comes back null.
   *
   * So a SOFT-DELETED object sheet (the row still owns the id: sheetMode 'missing' AND the registry
   * still claims it) cannot be re-provisioned, while a never-provisioned object (nothing claims the
   * id) is created normally. A fake that always succeeds would let this spec "prove" that
   * re-installing repairs a deleted table — it does not.
   */
  const ensureObject = vi.fn(async (input: { descriptor: Record<string, unknown> }) => {
    const objectId = String(input.descriptor.id)
    if (sheetMode === 'missing' && registryClaimed) {
      throw new Error(`Failed to ensure sheet: ${derivedSheetId(objectId)}`)
    }
    return {
      baseId: 'base_legacy',
      sheet: {
        id: liveSheetId(objectId),
        baseId: 'base_legacy',
        name: String(input.descriptor.name || objectId),
        description: null,
      },
      fields: [],
    }
  })
  const ensureView = vi.fn(async (input: { sheetId: string; descriptor: Record<string, unknown> }) => ({
    id: `view_${String(input.descriptor.id)}`,
    sheetId: input.sheetId,
    name: 'View',
    type: 'grid',
    filterInfo: {},
    sortInfo: {},
    groupInfo: {},
    hiddenFieldIds: [],
    config: {},
  }))

  const track = (fn: string, input: { sheetId?: unknown }) => {
    recordCalls.push({ fn, sheetId: input ? input.sheetId : undefined })
  }
  const listRecords = vi.fn(async (input: { sheetId: string }) => {
    track('listRecords', input)
    return []
  })
  const queryRecords = vi.fn(
    async (input: { sheetId: string; filters?: Record<string, unknown> }) => {
      track('queryRecords', input)
      // Echo the filter back as one record: the ticket lookup behind
      // POST /service-records then finds its ticket on the LIVE sheet.
      return [{ id: 'rec_query_001', version: 1, data: { ...(input.filters || {}) } }]
    },
  )
  const createRecord = vi.fn(async (input: { sheetId: string; data: Record<string, unknown> }) => {
    track('createRecord', input)
    return { id: 'rec_created_001', version: 1, data: { ...input.data } }
  })
  const getRecord = vi.fn(async (input: { sheetId: string; recordId: string }) => {
    track('getRecord', input)
    return { id: input.recordId, version: 1, data: physicalSample(input.sheetId) }
  })
  const patchRecord = vi.fn(
    async (input: { sheetId: string; recordId: string; changes: Record<string, unknown> }) => {
      track('patchRecord', input)
      return { id: input.recordId, version: 2, data: { ...input.changes } }
    },
  )
  const deleteRecord = vi.fn(async (input: { sheetId: string; recordId: string }) => {
    track('deleteRecord', input)
    return { id: input.recordId, version: 1, deleted: true }
  })

  const context = {
    metadata: { name: 'plugin-after-sales' },
    api: {
      database,
      http: {
        addRoute(method: string, path: string, handler: (req: any, res: FakeResponse) => Promise<void>) {
          routes.set(`${method} ${path}`, handler)
        },
      },
      tenant: {
        getTenantId: vi.fn(() => undefined),
        requireTenantId: vi.fn(() => {
          throw new Error('tenant context not set')
        }),
      },
      multitable: {
        provisioning: {
          getObjectSheetId,
          getFieldId,
          findObjectSheet,
          isSheetOwnedByProject,
          resolveFieldIds,
          ensureObject,
          ensureView,
        },
        records: {
          listRecords,
          queryRecords,
          createRecord,
          getRecord,
          patchRecord,
          deleteRecord,
        },
      },
      events: {
        on: vi.fn((eventName: string) => `sub:${eventName}`),
        off: vi.fn(),
        emit: vi.fn(),
      },
    },
    services: {
      notification: { send: vi.fn(async () => ({ ok: true })) },
      automationRegistry: { upsertRules: vi.fn(async () => ({ ok: true })), listRules: vi.fn(async () => []) },
      rbacProvisioning: { applyRoleMatrix: vi.fn(async () => ({ ok: true })) },
      platformAppInstances: {
        upsertInstance: vi.fn(async (input: Record<string, unknown>) => input),
        getInstance: vi.fn(async () => null),
        listInstances: vi.fn(async () => []),
      },
    },
    communication: {
      register: vi.fn(),
      call: vi.fn(async () => ({ ok: true })),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }

  return {
    context,
    routes,
    recordCalls,
    findObjectSheet,
    getObjectSheetId,
    isSheetOwnedByProject,
    ensureObject,
    setSheetMode: (mode: SheetMode) => {
      sheetMode = mode
    },
    setRegistryClaimed: (claimed: boolean) => {
      registryClaimed = claimed
    },
    ledgerStatus: () => {
      const row = ledgerRows.find((entry) => entry.tenant_id === TENANT_ID && entry.app_id === APP_ID)
      return row && typeof row.status === 'string' ? row.status : null
    },
    seedInstalled: () => {
      ledgerRows.push({
        id: 'fake-uuid-1',
        tenant_id: TENANT_ID,
        app_id: APP_ID,
        project_id: PROJECT_ID,
        template_id: 'after-sales-default',
        template_version: '0.1.0',
        mode: 'enable',
        status: 'installed',
        created_objects_json: JSON.stringify(OBJECT_IDS),
        created_views_json: JSON.stringify(['ticket-board']),
        warnings_json: JSON.stringify([]),
        display_name: 'After-sales',
        config_json: JSON.stringify({}),
        last_install_at: new Date(),
        created_at: new Date(),
      })
    },
  }
}

function buildReq(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'user_42',
      tenantId: TENANT_ID,
      role: 'admin',
      roles: ['admin'],
      perms: ['*:*', 'after_sales:admin'],
    },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }
}

/**
 * Every HTTP route that resolves an object sheet through `findObjectSheetId`, with the object it
 * resolves FIRST (the one a refusal must name) and what it does with the sheet.
 */
const SHEET_ROUTES: Array<{
  key: string
  objectId: string
  io: 'read' | 'write' | 'read+write'
  req: Record<string, unknown>
}> = [
  { key: 'GET /api/after-sales/tickets', objectId: 'serviceTicket', io: 'read', req: {} },
  {
    key: 'POST /api/after-sales/tickets',
    objectId: 'serviceTicket',
    io: 'write',
    req: { body: { ticket: { ticketNo: 'TK-2001', title: 'No cooling output', priority: 'high', source: 'phone' } } },
  },
  {
    key: 'PATCH /api/after-sales/tickets/:ticketId',
    objectId: 'serviceTicket',
    io: 'read+write',
    req: {
      params: { ticketId: 'rec_ticket_001' },
      body: { ticket: { title: 'Updated compressor diagnosis', priority: 'urgent', source: 'wechat', status: 'assigned' } },
    },
  },
  {
    key: 'DELETE /api/after-sales/tickets/:ticketId',
    objectId: 'serviceTicket',
    io: 'write',
    req: { params: { ticketId: 'rec_ticket_001' } },
  },
  {
    key: 'POST /api/after-sales/installed-assets',
    objectId: 'installedAsset',
    io: 'write',
    req: { body: { installedAsset: { assetCode: 'AST-1001' } } },
  },
  {
    key: 'PATCH /api/after-sales/installed-assets/:installedAssetId',
    objectId: 'installedAsset',
    io: 'read+write',
    req: {
      params: { installedAssetId: 'rec_asset_001' },
      body: { installedAsset: { assetCode: 'AST-1001-UPDATED', status: 'expired' } },
    },
  },
  {
    key: 'DELETE /api/after-sales/installed-assets/:installedAssetId',
    objectId: 'installedAsset',
    io: 'write',
    req: { params: { installedAssetId: 'rec_asset_001' } },
  },
  { key: 'GET /api/after-sales/installed-assets', objectId: 'installedAsset', io: 'read', req: {} },
  { key: 'GET /api/after-sales/service-records', objectId: 'serviceRecord', io: 'read', req: {} },
  {
    key: 'POST /api/after-sales/customers',
    objectId: 'customer',
    io: 'write',
    req: { body: { customer: { customerCode: 'CUS-1001', name: 'Alice Plant' } } },
  },
  { key: 'GET /api/after-sales/customers', objectId: 'customer', io: 'read', req: {} },
  {
    key: 'PATCH /api/after-sales/customers/:customerId',
    objectId: 'customer',
    io: 'read+write',
    req: {
      params: { customerId: 'rec_customer_001' },
      body: { customer: { customerCode: 'CUS-1001', name: 'Alice Plant' } },
    },
  },
  {
    key: 'DELETE /api/after-sales/customers/:customerId',
    objectId: 'customer',
    io: 'write',
    req: { params: { customerId: 'rec_customer_001' } },
  },
  {
    key: 'POST /api/after-sales/follow-ups',
    objectId: 'followUp',
    io: 'write',
    req: {
      body: {
        followUp: {
          ticketNo: 'TK-2001',
          customerName: 'Alice Plant',
          dueAt: '2026-04-10T09:00:00Z',
          followUpType: 'phone',
        },
      },
    },
  },
  {
    key: 'PATCH /api/after-sales/follow-ups/:followUpId',
    objectId: 'followUp',
    io: 'read+write',
    req: {
      params: { followUpId: 'rec_follow_up_001' },
      body: {
        followUp: {
          customerName: 'Charlie Logistics',
          dueAt: '2026-04-12T09:30:00Z',
          followUpType: 'message',
          status: 'done',
        },
      },
    },
  },
  {
    key: 'DELETE /api/after-sales/follow-ups/:followUpId',
    objectId: 'followUp',
    io: 'write',
    req: { params: { followUpId: 'rec_follow_up_001' } },
  },
  { key: 'GET /api/after-sales/follow-ups', objectId: 'followUp', io: 'read', req: {} },
  {
    // Resolves the TICKET sheet first (ticketNo lookup), then the serviceRecord sheet.
    key: 'POST /api/after-sales/service-records',
    objectId: 'serviceTicket',
    io: 'read+write',
    req: {
      body: {
        serviceRecord: { ticketNo: 'TK-SR-001', visitType: 'onsite', scheduledAt: '2026-04-09T09:00:00Z' },
      },
    },
  },
  {
    key: 'PATCH /api/after-sales/service-records/:serviceRecordId',
    objectId: 'serviceRecord',
    io: 'read+write',
    req: {
      params: { serviceRecordId: 'rec_service_001' },
      body: {
        serviceRecord: {
          visitType: 'remote',
          scheduledAt: '2026-04-09T11:00:00Z',
          technicianName: 'Tech Updated',
          workSummary: 'Follow-up remote diagnostics',
          result: 'partial',
        },
      },
    },
  },
  {
    key: 'DELETE /api/after-sales/service-records/:serviceRecordId',
    objectId: 'serviceRecord',
    io: 'write',
    req: { params: { serviceRecordId: 'rec_service_001' } },
  },
  {
    key: 'POST /api/after-sales/tickets/:ticketId/refund-request',
    objectId: 'serviceTicket',
    io: 'read+write',
    req: {
      params: { ticketId: 'rec_ticket_001' },
      body: { refundAmount: 88.5, requesterName: 'Alice', reason: 'Damaged fan motor' },
    },
  },
]

/**
 * NAMED EXEMPTIONS — routes that reach `findObjectSheetId` but deliberately do NOT answer
 * OBJECT_SHEET_UNAVAILABLE.
 *
 * The part inventory resolves through `requireProvisionedObjectSheetId`, which refuses with
 * AFTER_SALES_OBJECT_UNAVAILABLE first: partItem is the one object a PARTIAL install legitimately
 * leaves unprovisioned, and the web client keys on that code to hide the parts tab
 * (apps/web/src/views/AfterSalesView.vue, with four pinned assertions in
 * after-sales-plugin-routes.test.ts). Code, status and message therefore stay as they were.
 *
 * RESIDUAL, deliberate and named: the web still renders no message for that code, so a DELETED parts
 * table remains invisible to the operator in the UI. What #5835 adds here is `details.reason`, so
 * support can tell "never provisioned" from "someone deleted it" out of the API response — asserted
 * below.
 */
const EXEMPT_ROUTES: Array<{ key: string; reason: string; req: Record<string, unknown> }> = [
  {
    key: 'POST /api/after-sales/parts',
    reason: 'part inventory keeps the install-state contract the web tab hides on',
    req: { body: { partItem: { partNo: 'PRT-1001', name: 'Starter Capacitor' } } },
  },
  {
    key: 'GET /api/after-sales/parts',
    reason: 'part inventory keeps the install-state contract the web tab hides on',
    req: {},
  },
  {
    key: 'PATCH /api/after-sales/parts/:partItemId',
    reason: 'part inventory keeps the install-state contract the web tab hides on',
    req: {
      params: { partItemId: 'rec_part_001' },
      body: { partItem: { partNo: 'PRT-1001', name: 'Starter Capacitor', status: 'available' } },
    },
  },
  {
    key: 'DELETE /api/after-sales/parts/:partItemId',
    reason: 'part inventory keeps the install-state contract the web tab hides on',
    req: { params: { partItemId: 'rec_part_001' } },
  },
]

describe('plugin-after-sales object-sheet liveness (#5835)', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = createHarness()
    harness.seedInstalled()
    await plugin.activate(harness.context)
  })

  const run = async (key: string, req: Record<string, unknown>) => {
    const handler = harness.routes.get(key)
    expect(handler, `route not registered: ${key}`).toBeTruthy()
    const res = new FakeResponse()
    await handler!(buildReq(req), res)
    return res
  }

  const derivedCalls = () =>
    harness.recordCalls.filter((call) =>
      OBJECT_IDS.some((objectId) => call.sheetId === derivedSheetId(objectId)),
    )

  describe('route ledger (derived from the plugin source)', () => {
    const scan = scanAfterSalesObjectSheetRoutes()

    it('reads every registration in the plugin source', () => {
      // Fail closed: a registration whose verb, path or handler the scanner cannot read would hide a
      // route from the closure below.
      expect(scan.opaque).toEqual([])
      // The scan sees exactly the routes the plugin registers at runtime — neither side is a subset.
      expect([...scan.routeKeys].sort()).toEqual([...harness.routes.keys()].sort())
      expect(new Set(scan.routeKeys).size).toBe(scan.routeKeys.length)
    })

    it('every route that reaches findObjectSheetId is mapped here or exempt BY NAME', () => {
      // THIS is the closure: the population is a fact about plugins/plugin-after-sales/index.cjs, not
      // about this file. A 22nd route that resolves an object sheet and forgets the
      // `isObjectSheetUnavailableError(err)` branch answers 500 INTERNAL_ERROR (worse than the 404 the
      // same state produced before #5835, since the helper now throws) — and reds right here.
      expect([...scan.guardedKeys].sort()).toEqual([...SHEET_ROUTES.map((entry) => entry.key)].sort())
      expect([...scan.unguardedReachingKeys].sort()).toEqual(
        [...EXEMPT_ROUTES.map((entry) => entry.key)].sort(),
      )
      expect([...scan.reachingKeys].sort()).toEqual(
        [...SHEET_ROUTES.map((entry) => entry.key), ...EXEMPT_ROUTES.map((entry) => entry.key)].sort(),
      )
      for (const entry of EXEMPT_ROUTES) {
        expect(entry.reason.length, `exemption without a reason: ${entry.key}`).toBeGreaterThan(20)
        const scanned = scan.routes.find((route) => route.key === entry.key)
        // An exemption is not "no mapping": it must still answer the install-state refusal.
        expect(scanned?.mapsObjectUnavailable, `exempt route without a refusal: ${entry.key}`).toBe(true)
      }
    })

    it('the behaviour table matches the derived population and every route is registered', () => {
      expect(SHEET_ROUTES).toHaveLength(21)
      expect(new Set(SHEET_ROUTES.map((entry) => entry.key)).size).toBe(21)
      expect(EXEMPT_ROUTES).toHaveLength(4)
      for (const entry of [...SHEET_ROUTES, ...EXEMPT_ROUTES]) {
        expect(harness.routes.get(entry.key), `route not registered: ${entry.key}`).toBeTruthy()
      }
    })
  })

  describe.each(SHEET_ROUTES)('$key ($io)', ({ key, objectId, req }) => {
    it('refuses a DELETED object sheet with the guided hint and never queries the derived id', async () => {
      harness.setSheetMode('missing')
      harness.setRegistryClaimed(true)

      const res = await run(key, req)

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: {
          code: 'OBJECT_SHEET_UNAVAILABLE',
          message: HINT_DELETED,
          details: { objectId, reason: 'deleted' },
        },
      })
      expect(harness.recordCalls).toEqual([])
      expect(derivedCalls()).toEqual([])
    })

    it('refuses an ABSENT object sheet with the provisioning hint and never queries the derived id', async () => {
      harness.setSheetMode('missing')
      harness.setRegistryClaimed(false)

      const res = await run(key, req)

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: {
          code: 'OBJECT_SHEET_UNAVAILABLE',
          message: HINT_ABSENT,
          details: { objectId, reason: 'absent' },
        },
      })
      expect(harness.recordCalls).toEqual([])
      expect(derivedCalls()).toEqual([])
    })

    it('control: a THROWING sheet lookup fails closed (holds on the pre-#5835 tree too)', async () => {
      harness.setSheetMode('throws')

      const res = await run(key, req)

      // CONTROL, not a proof of the fix: `findObjectSheet` throwing propagated before #5835 as well
      // (the fallback sat on the null branch), so an in-memory revert of the new throw leaves this
      // case byte-identical. It stays as a regression guard for the property it does pin — a
      // transient lookup failure is NOT reported as "your table was deleted", and does not fall
      // through to the derived id either.
      expect(res.statusCode).toBe(500)
      expect(res.body?.error?.code).toBe('INTERNAL_ERROR')
      expect(harness.recordCalls).toEqual([])
      expect(derivedCalls()).toEqual([])
    })

    it('control: a LIVE object sheet still serves the request off the live id', async () => {
      harness.setSheetMode('live')

      const res = await run(key, req)

      expect(res.statusCode).toBeLessThan(400)
      expect(res.body?.ok).toBe(true)
      expect(harness.recordCalls.length).toBeGreaterThan(0)
      expect(derivedCalls()).toEqual([])
      expect(harness.recordCalls.some((call) => call.sheetId === liveSheetId(objectId))).toBe(true)
    })
  })

  /**
   * The NAMED exemptions, asserted rather than assumed.
   *
   * These four keep AFTER_SALES_OBJECT_UNAVAILABLE with its original status and English message,
   * because apps/web AfterSalesView keys on that code to hide the parts tab (four pinned assertions
   * in after-sales-plugin-routes.test.ts). What #5835 adds is `details.reason`, so a DELETED parts
   * table is distinguishable from a partial install IN THE RESPONSE.
   *
   * RESIDUAL, on purpose: the web renders no message for that code, so the operator still just loses
   * the tab. That is named here (and in the PR body) instead of being hidden by a coverage claim.
   */
  describe.each(EXEMPT_ROUTES)('$key (exempt: part inventory)', ({ key, req }) => {
    it('refuses a DELETED parts sheet with the install-state code AND a reason, never the derived id', async () => {
      harness.setSheetMode('missing')
      harness.setRegistryClaimed(true)

      const res = await run(key, req)

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: {
          code: 'AFTER_SALES_OBJECT_UNAVAILABLE',
          message: PART_ITEM_UNAVAILABLE_MESSAGE,
          details: { objectId: 'partItem', reason: 'deleted' },
        },
      })
      expect(harness.recordCalls).toEqual([])
      expect(derivedCalls()).toEqual([])
    })

    it('refuses an ABSENT parts sheet with the same code and the absent reason', async () => {
      harness.setSheetMode('missing')
      harness.setRegistryClaimed(false)

      const res = await run(key, req)

      expect(res.statusCode).toBe(409)
      expect(res.body).toEqual({
        ok: false,
        error: {
          code: 'AFTER_SALES_OBJECT_UNAVAILABLE',
          message: PART_ITEM_UNAVAILABLE_MESSAGE,
          details: { objectId: 'partItem', reason: 'absent' },
        },
      })
      expect(harness.recordCalls).toEqual([])
      expect(derivedCalls()).toEqual([])
    })

    it('control: a LIVE parts sheet still serves the request off the live id', async () => {
      harness.setSheetMode('live')

      const res = await run(key, req)

      expect(res.statusCode).toBeLessThan(400)
      expect(res.body?.ok).toBe(true)
      expect(derivedCalls()).toEqual([])
      expect(harness.recordCalls.some((call) => call.sheetId === liveSheetId('partItem'))).toBe(true)
    })
  })

  describe('provisioning is the only path that may compose a sheet id by rule', () => {
    it('installs (and CREATES the sheets) for an ABSENT object, without any derived-id record call', async () => {
      // ABSENT = nothing claims the deterministic id, so `ensureSheet` really does insert and read
      // back a live row. This is the repair the ABSENT hint points at, and it works.
      harness.setSheetMode('missing')
      harness.setRegistryClaimed(false)

      const res = await run('POST /api/after-sales/projects/install', {
        body: { templateId: 'after-sales-default', mode: 'reinstall' },
      })

      expect(res.statusCode).toBeLessThan(400)
      expect(harness.ensureObject).toHaveBeenCalled()
      expect(harness.ledgerStatus()).toBe('installed')
      // Install goes through provisioning.ensureObject, which CREATES/adopts the sheet — it never
      // asks findObjectSheetId, so the refusal above cannot block THIS repair.
      expect(derivedCalls()).toEqual([])
    })

    it('a re-install CANNOT repair a DELETED object sheet — it fails and flips the ledger to failed', async () => {
      // The caller-chain fact the DELETED hint must respect (#5835 review): a soft-deleted row still
      // owns the deterministic id, so core `ensureSheet` (`INSERT ... ON CONFLICT (id) DO NOTHING`
      // then `loadActiveSheet` with `deleted_at IS NULL`) inserts nothing, reads back null and throws
      // `Failed to ensure sheet: <id>` — modelled by the harness's ensureObject. The installer turns
      // ANY object failure into a status='failed' ledger row + core-object-failed, after which
      // `isOperationalAfterSalesStatus` is false and every route answers AFTER_SALES_NOT_INSTALLED,
      // i.e. the guided hint becomes UNREACHABLE. Advising 重新开通 for 'deleted' would therefore send
      // the operator into a repair that provably fails and erases the hint.
      harness.setSheetMode('missing')
      harness.setRegistryClaimed(true)

      const before = await run('GET /api/after-sales/tickets', {})
      expect(before.statusCode).toBe(409)
      expect(before.body.error.code).toBe('OBJECT_SHEET_UNAVAILABLE')
      expect(before.body.error.message).toBe(HINT_DELETED)

      const res = await run('POST /api/after-sales/projects/install', {
        body: { templateId: 'after-sales-default', mode: 'reinstall' },
      })

      expect(res.statusCode).toBe(500)
      expect(res.body.error.code).toBe('core-object-failed')
      expect(harness.ledgerStatus()).toBe('failed')

      // And the hint is gone from that point on — the install state now shadows it.
      const after = await run('GET /api/after-sales/tickets', {})
      expect(after.statusCode).toBe(409)
      expect(after.body.error.code).toBe('AFTER_SALES_NOT_INSTALLED')
      expect(derivedCalls()).toEqual([])

      // So the DELETED hint names RESTORE, and says in as many words that re-installing does not fix
      // it. (Reverting the hint to the earlier '请恢复该表或重新开通售后应用后重试' reds here.)
      expect(HINT_DELETED).toContain('恢复')
      expect(HINT_DELETED).toContain('重新开通无法修复')
    })

    it('the installer never composes an object sheet id at all', () => {
      // Structural: the CREATE path is explicit and separate — it owns no derived-id read/write.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { join } = require('node:path') as typeof import('node:path')
      const source = readFileSync(
        join(__dirname, '../../../../plugins/plugin-after-sales/lib/installer.cjs'),
        'utf8',
      )
      expect(source).not.toContain('getObjectSheetId')
      expect(source).not.toContain('findObjectSheetId')
    })
  })

  describe('findObjectSheetId (seam)', () => {
    const provisioning = (overrides: Record<string, unknown> = {}) => ({
      getObjectSheetId: vi.fn((_projectId: string, objectId: string) => derivedSheetId(objectId)),
      isSheetOwnedByProject: vi.fn(async () => true),
      findObjectSheet: vi.fn(async () => null),
      ...overrides,
    })

    it('throws OBJECT_SHEET_UNAVAILABLE(deleted) when the registry still claims the sheet', async () => {
      const api = provisioning()
      await expect(helpers.findObjectSheetId(api, PROJECT_ID, 'serviceTicket')).rejects.toMatchObject({
        code: 'OBJECT_SHEET_UNAVAILABLE',
        reason: 'deleted',
        meta: { objectId: 'serviceTicket', reason: 'deleted' },
      })
    })

    it('throws OBJECT_SHEET_UNAVAILABLE(absent) when nothing claims the sheet', async () => {
      const api = provisioning({ isSheetOwnedByProject: vi.fn(async () => false) })
      await expect(helpers.findObjectSheetId(api, PROJECT_ID, 'followUp')).rejects.toMatchObject({
        code: 'OBJECT_SHEET_UNAVAILABLE',
        reason: 'absent',
      })
    })

    it('throws OBJECT_SHEET_UNAVAILABLE(unknown) when the host cannot classify, and still refuses', async () => {
      const noPredicate = provisioning()
      delete (noPredicate as Record<string, unknown>).isSheetOwnedByProject
      await expect(helpers.findObjectSheetId(noPredicate, PROJECT_ID, 'customer')).rejects.toMatchObject({
        code: 'OBJECT_SHEET_UNAVAILABLE',
        reason: 'unknown',
      })

      const failingPredicate = provisioning({
        isSheetOwnedByProject: vi.fn(async () => {
          throw new Error('registry read failed')
        }),
      })
      await expect(helpers.findObjectSheetId(failingPredicate, PROJECT_ID, 'customer')).rejects.toMatchObject({
        code: 'OBJECT_SHEET_UNAVAILABLE',
        reason: 'unknown',
      })
    })

    it('never carries the project id, the derived sheet id or a tenant in its message', async () => {
      const api = provisioning()
      const err = await helpers
        .findObjectSheetId(api, PROJECT_ID, 'serviceTicket')
        .then(() => null, (e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      const rendered = `${(err as Error).message} ${JSON.stringify((err as { meta?: unknown }).meta)}`
      expect(rendered).not.toContain(PROJECT_ID)
      expect(rendered).not.toContain(TENANT_ID)
      expect(rendered).not.toContain(derivedSheetId('serviceTicket'))
    })

    it('propagates a lookup throw untouched and never composes the derived id', async () => {
      const getObjectSheetId = vi.fn((_projectId: string, objectId: string) => derivedSheetId(objectId))
      const api = provisioning({
        getObjectSheetId,
        findObjectSheet: vi.fn(async () => {
          throw new Error('multitable lookup failed')
        }),
      })
      const err = await helpers
        .findObjectSheetId(api, PROJECT_ID, 'serviceTicket')
        .then(() => null, (e: Error) => e)
      expect((err as Error).message).toBe('multitable lookup failed')
      expect(helpers.isObjectSheetUnavailableError(err)).toBe(false)
      expect(getObjectSheetId).not.toHaveBeenCalled()
    })

    it('still derives the id on a host with NO liveness capability at all', async () => {
      // Not a fallback for a missing sheet: `findObjectSheet` is absent, so there is no liveness
      // verdict to honour. Shipped hosts implement it.
      const legacy = {
        getObjectSheetId: vi.fn((_projectId: string, objectId: string) => derivedSheetId(objectId)),
      }
      await expect(helpers.findObjectSheetId(legacy, PROJECT_ID, 'serviceTicket')).resolves.toBe(
        derivedSheetId('serviceTicket'),
      )
    })
  })

  describe('hint wording', () => {
    /** A FUTURE thrower: some other helper (or a re-throw) that carries the code but is not ours. */
    const throwCoded = (patch: Record<string, unknown>) => {
      harness.findObjectSheet.mockImplementation(async () => {
        const err = new Error(
          `object sheet ${derivedSheetId('serviceTicket')} of project ${PROJECT_ID} was removed`,
        ) as Error & Record<string, unknown>
        err.code = 'OBJECT_SHEET_UNAVAILABLE'
        Object.assign(err, patch)
        throw err
      })
    }

    it('maps each reason to its own guided Chinese hint', async () => {
      harness.setSheetMode('missing')

      harness.setRegistryClaimed(true)
      const deleted = await run('GET /api/after-sales/tickets', {})
      harness.setRegistryClaimed(false)
      const absent = await run('GET /api/after-sales/tickets', {})

      expect(deleted.body.error.message).toBe(HINT_DELETED)
      expect(absent.body.error.message).toBe(HINT_ABSENT)
      expect(deleted.body.error.message).not.toBe(absent.body.error.message)
      expect(HINT_UNKNOWN).not.toBe(HINT_DELETED)
    })

    it('the ABSENT hint does not promise that 开通 alone succeeds', async () => {
      harness.setSheetMode('missing')
      harness.setRegistryClaimed(false)

      const res = await run('GET /api/after-sales/tickets', {})

      expect(res.body.error.message).toBe(HINT_ABSENT)
      // An object whose sheet was ALREADY soft-deleted when the registry backfill ran has no claim
      // (migration zzzz20260408160000 joins `meta_sheets ... AND deleted_at IS NULL`), so it reaches
      // the operator as 'absent' although it WAS provisioned once. The hint therefore carries the
      // "if 开通 fails, the table may have been deleted" caveat instead of asserting a history it
      // cannot know.
      expect(HINT_ABSENT).toContain('若开通失败')
      expect(HINT_ABSENT).toContain('恢复')
    })

    it('renders from the reason alone: a thrower that leaks ids reaches the operator values-free', async () => {
      // VALUES-FREE asserted on what the product produced, not on this file's own literals: the
      // thrower's message carries the derived sheet id AND the project id, and its meta.objectId is a
      // sheet id rather than a logical object.
      throwCoded({
        reason: 'deleted',
        meta: {
          objectId: derivedSheetId('serviceTicket'),
          projectId: PROJECT_ID,
          tenantId: TENANT_ID,
        },
      })

      const res = await run('GET /api/after-sales/tickets', {})

      expect(res.statusCode).toBe(409)
      expect(res.body.error.message).toBe(HINT_DELETED)
      // Not in the app's declared objects -> not echoed.
      expect(res.body.error.details).toEqual({ objectId: null, reason: 'deleted' })
      const rendered = JSON.stringify(res.body)
      expect(rendered).not.toContain(PROJECT_ID)
      expect(rendered).not.toContain(TENANT_ID)
      expect(rendered).not.toContain(derivedSheetId('serviceTicket'))
      expect(rendered).not.toContain('was removed')
      expect(harness.recordCalls).toEqual([])
    })

    it.each(['constructor', '__proto__', 'toString', 'valueOf', 'bogus'])(
      'reason %s is not a hint: it falls back to the unknown wording with a string message',
      async (reason) => {
        // A truthiness lookup (`HINTS[reason]`) would find these on Object.prototype and ship a
        // FUNCTION (JSON.stringify drops it: no message at all) or `{}` for '__proto__'.
        throwCoded({ reason, meta: { objectId: 'serviceTicket' } })

        const res = await run('GET /api/after-sales/tickets', {})

        expect(res.statusCode).toBe(409)
        expect(typeof res.body.error.message).toBe('string')
        expect(res.body.error.message).toBe(HINT_UNKNOWN)
        expect(res.body.error.details).toEqual({ objectId: 'serviceTicket', reason: 'unknown' })
      },
    )
  })
})
