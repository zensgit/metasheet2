import { createHash } from 'crypto'
import http from 'http'
import net from 'net'
import * as path from 'path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'

import { ICoreAPI } from '../../src/di/identifiers'
import type { MetaSheetServer } from '../../src/index'

type HttpResponse = { status: number; body?: unknown; raw: string }
type ExpectedField = { name: string; type: string }

async function waitFor<T>(
  producer: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3000
  const intervalMs = options.intervalMs ?? 50
  const start = Date.now()

  while (true) {
    const value = await producer()
    if (predicate(value)) return value
    if (Date.now() - start >= timeoutMs) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

function stableMetaId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha1')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 24)
  return `${prefix}_${digest}`.slice(0, 50)
}

const TENANT_ID = 'default'
const APP_ID = 'after-sales'
const PROJECT_ID = `${TENANT_ID}:${APP_ID}`
const OBJECT_IDS = ['serviceTicket', 'installedAsset', 'customer', 'serviceRecord', 'partItem', 'followUp']
const VIEW_IDS = [
  { objectId: 'serviceTicket', viewId: 'ticket-board' },
  { objectId: 'installedAsset', viewId: 'installedAsset-grid' },
  { objectId: 'customer', viewId: 'customer-grid' },
  { objectId: 'serviceRecord', viewId: 'serviceRecord-calendar' },
  { objectId: 'partItem', viewId: 'partItem-grid' },
  { objectId: 'followUp', viewId: 'followUp-grid' },
]

const SHEET_IDS = OBJECT_IDS.map((objectId) => stableMetaId('sheet', PROJECT_ID, objectId))
const META_VIEW_IDS = VIEW_IDS.map(({ objectId, viewId }) =>
  stableMetaId('view', PROJECT_ID, objectId, viewId),
)
const stFieldId = (objectId: string, fieldId: string) =>
  stableMetaId('fld', PROJECT_ID, objectId, fieldId)

function getServerCoreApi(server: MetaSheetServer): any {
  return (server as unknown as { injector: { get: (token: unknown) => unknown } }).injector.get(ICoreAPI)
}

const EXPECTED_OBJECTS = [
  {
    objectId: 'serviceTicket',
    sheetName: 'Service Ticket',
    fields: [
      { name: 'Ticket No', type: 'string' },
      { name: 'Title', type: 'string' },
      { name: 'Source', type: 'select' },
      { name: 'Priority', type: 'select' },
      { name: 'Status', type: 'select' },
      { name: 'SLA Due At', type: 'date' },
      { name: 'Refund Amount', type: 'number' },
      { name: 'Refund Status', type: 'select' },
    ],
    view: { id: 'ticket-board', name: 'Ticket Board', type: 'kanban' },
  },
  {
    objectId: 'installedAsset',
    sheetName: 'Installed Asset',
    fields: [
      { name: 'Asset Code', type: 'string' },
      { name: 'Serial No', type: 'string' },
      { name: 'Model', type: 'string' },
      { name: 'Location', type: 'string' },
      { name: 'Installed At', type: 'date' },
      { name: 'Warranty Until', type: 'date' },
      { name: 'Status', type: 'select' },
    ],
    view: { id: 'installedAsset-grid', name: 'Installed Assets', type: 'grid' },
  },
  {
    objectId: 'customer',
    sheetName: 'Customer',
    fields: [
      { name: 'Customer Code', type: 'string' },
      { name: 'Name', type: 'string' },
      { name: 'Phone', type: 'string' },
      { name: 'Email', type: 'string' },
      { name: 'Status', type: 'select' },
    ],
    view: { id: 'customer-grid', name: 'Customers', type: 'grid' },
  },
  {
    objectId: 'serviceRecord',
    sheetName: 'Service Record',
    fields: [
      { name: 'Ticket No', type: 'string' },
      { name: 'Visit Type', type: 'select' },
      { name: 'Scheduled At', type: 'date' },
      { name: 'Completed At', type: 'date' },
      { name: 'Technician Name', type: 'string' },
      { name: 'Work Summary', type: 'string' },
      { name: 'Result', type: 'select' },
    ],
    view: { id: 'serviceRecord-calendar', name: 'Service Schedule', type: 'calendar' },
  },
  {
    objectId: 'partItem',
    sheetName: 'Part Item',
    fields: [
      { name: 'Part No', type: 'string' },
      { name: 'Name', type: 'string' },
      { name: 'Category', type: 'select' },
      { name: 'Stock Qty', type: 'number' },
      { name: 'Status', type: 'select' },
    ],
    view: { id: 'partItem-grid', name: 'Parts', type: 'grid' },
  },
  {
    objectId: 'followUp',
    sheetName: 'Follow Up',
    fields: [
      { name: 'Ticket No', type: 'string' },
      { name: 'Customer Name', type: 'string' },
      { name: 'Due At', type: 'date' },
      { name: 'Follow Up Type', type: 'select' },
      { name: 'Owner Name', type: 'string' },
      { name: 'Status', type: 'select' },
      { name: 'Summary', type: 'string' },
    ],
    view: { id: 'followUp-grid', name: 'Follow Ups', type: 'grid' },
  },
] as const

async function assertSheetFields(
  pool: Pool,
  objectId: string,
  expectedSheetName: string,
  expectedFields: ExpectedField[],
) {
  const sheetId = stableMetaId('sheet', PROJECT_ID, objectId)
  const sheetRes = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM meta_sheets WHERE id = $1',
    [sheetId],
  )
  expect(sheetRes.rows).toEqual([{ id: sheetId, name: expectedSheetName }])

  const fieldRes = await pool.query<{ name: string; type: string }>(
    `SELECT name, type
     FROM meta_fields
     WHERE sheet_id = $1
     ORDER BY "order" ASC, id ASC`,
    [sheetId],
  )
  expect(fieldRes.rows).toEqual(expectedFields)
}

async function assertView(
  pool: Pool,
  objectId: string,
  viewId: string,
  expectedName: string,
  expectedType: string,
) {
  const metaViewId = stableMetaId('view', PROJECT_ID, objectId, viewId)
  const viewRes = await pool.query<{ id: string; name: string; type: string }>(
    'SELECT id, name, type FROM meta_views WHERE id = $1',
    [metaViewId],
  )
  expect(viewRes.rows).toEqual([{ id: metaViewId, name: expectedName, type: expectedType }])
}

describe('after-sales plugin install integration', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool | undefined
  let schemaReady = false

  async function cleanupAfterSalesInstallArtifacts() {
    if (!pool || !schemaReady) return
    await pool.query(
      `DELETE FROM approval_records
       WHERE instance_id IN (
         SELECT id FROM approval_instances WHERE source_system = 'after-sales'
       )`,
    )
    await pool.query(
      `DELETE FROM approval_assignments
       WHERE instance_id IN (
         SELECT id FROM approval_instances WHERE source_system = 'after-sales'
       )`,
    )
    await pool.query(
      `DELETE FROM approval_instances WHERE source_system = 'after-sales'`,
    )
    await pool.query('DELETE FROM meta_views WHERE id = ANY($1::text[])', [META_VIEW_IDS])
    await pool.query('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [SHEET_IDS])
    await pool.query('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [SHEET_IDS])
    await pool.query('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [SHEET_IDS])
    await pool.query(
      'DELETE FROM plugin_after_sales_template_installs WHERE tenant_id = $1 AND app_id = $2',
      [TENANT_ID, APP_ID],
    )
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return

    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) return

    pool = new Pool({ connectionString: process.env.DATABASE_URL })

    try {
      const tables = await pool.query<{ name: string | null }>(
        `SELECT to_regclass('public.plugin_after_sales_template_installs') AS name
         UNION ALL SELECT to_regclass('public.meta_bases') AS name
         UNION ALL SELECT to_regclass('public.meta_sheets') AS name
         UNION ALL SELECT to_regclass('public.meta_fields') AS name
         UNION ALL SELECT to_regclass('public.meta_views') AS name
         UNION ALL SELECT to_regclass('public.meta_records') AS name
         UNION ALL SELECT to_regclass('public.approval_instances') AS name
         UNION ALL SELECT to_regclass('public.approval_records') AS name
         UNION ALL SELECT to_regclass('public.approval_assignments') AS name`,
      )
      if (tables.rows.some((row) => !row.name)) return
      schemaReady = true

      await cleanupAfterSalesInstallArtifacts()

      const repoRoot = path.join(__dirname, '../../../../')
      const { MetaSheetServer } = await import('../../src/index')
      server = new MetaSheetServer({
        port: 0,
        host: '127.0.0.1',
        pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-after-sales')],
      })
      await server.start()

      const address = server.getAddress()
      if (!address || typeof address === 'string') return
      baseUrl = `http://127.0.0.1:${address.port}`
    } catch {
      baseUrl = ''
    }
  })

  afterAll(async () => {
    if (server) {
      await server.stop()
    }
    if (pool) {
      await cleanupAfterSalesInstallArtifacts()
      await pool.end()
    }
  })

  beforeEach(async () => {
    // Reset ledger and multitable artifacts between tests so each `it` block
    // starts from a clean (tenant_id, app_id) state. Without this, the second
    // and third tests would inherit the ledger row written by the first test
    // and the `mode='enable'` install path would hit `already-installed`.
    await cleanupAfterSalesInstallArtifacts()
  })

  it('installs the after-sales template into real multitable tables and exposes current state', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-install-it&roles=admin&perms=*:*`,
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()

    const installRes = await requestJson(`${baseUrl}/api/after-sales/projects/install`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId: 'after-sales-default',
        displayName: 'After Sales Integration',
        config: {
          defaultSlaHours: 24,
          urgentSlaHours: 4,
          followUpAfterDays: 7,
        },
      }),
    })

    expect(installRes.status).toBe(200)
    const installBody = installRes.body as {
      ok?: boolean
      data?: {
        projectId?: string
        installResult?: {
          status?: string
          createdObjects?: string[]
          createdViews?: string[]
        }
      }
    }
    expect(installBody.ok).toBe(true)
    expect(installBody.data?.projectId).toBe(PROJECT_ID)
    expect(installBody.data?.installResult?.status).toBe('installed')
    expect(installBody.data?.installResult?.createdObjects).toEqual(OBJECT_IDS)
    expect(installBody.data?.installResult?.createdViews).toEqual(VIEW_IDS.map((item) => item.viewId))

    const currentRes = await requestJson(`${baseUrl}/api/after-sales/projects/current`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(currentRes.status).toBe(200)
    const currentBody = currentRes.body as {
      ok?: boolean
      data?: {
        status?: string
        projectId?: string
        displayName?: string
      }
    }
    expect(currentBody.ok).toBe(true)
    expect(currentBody.data).toMatchObject({
      status: 'installed',
      projectId: PROJECT_ID,
      displayName: 'After Sales Integration',
    })

    const ledgerRes = await pool.query<{
      tenant_id: string
      app_id: string
      project_id: string
      status: string
      display_name: string
    }>(
      `SELECT tenant_id, app_id, project_id, status, display_name
       FROM plugin_after_sales_template_installs
       WHERE tenant_id = $1 AND app_id = $2`,
      [TENANT_ID, APP_ID],
    )
    expect(ledgerRes.rows).toEqual([
      {
        tenant_id: TENANT_ID,
        app_id: APP_ID,
        project_id: PROJECT_ID,
        status: 'installed',
        display_name: 'After Sales Integration',
      },
    ])

    for (const objectDef of EXPECTED_OBJECTS) {
      await assertSheetFields(pool, objectDef.objectId, objectDef.sheetName, [...objectDef.fields])
      await assertView(pool, objectDef.objectId, objectDef.view.id, objectDef.view.name, objectDef.view.type)
    }
  })

  it('rejects install for non-admin callers', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-non-admin&roles=user&perms=after_sales:read`,
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()

    const installRes = await requestJson(`${baseUrl}/api/after-sales/projects/install`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId: 'after-sales-default',
        displayName: 'Forbidden Install',
      }),
    })

    expect(installRes.status).toBe(403)
    expect(installRes.body).toEqual({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Admin access required',
      },
    })
  })

  it('persists failed install state and recovers via reinstall after a transient provisioning failure', async () => {
    if (!baseUrl || !pool || !server) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-reinstall-it&roles=admin&perms=*:*`,
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()

    const coreApi = getServerCoreApi(server)
    const originalEnsureObject = coreApi.multitable.provisioning.ensureObject
    let failOnce = true
    coreApi.multitable.provisioning.ensureObject = async (input: unknown) => {
      if (failOnce) {
        failOnce = false
        throw new Error('simulated provisioning failure')
      }
      return originalEnsureObject(input)
    }

    try {
      const failedInstallRes = await requestJson(`${baseUrl}/api/after-sales/projects/install`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          templateId: 'after-sales-default',
          displayName: 'After Sales Retry Failure',
        }),
      })

      expect(failedInstallRes.status).toBe(500)
      expect(failedInstallRes.body).toMatchObject({
        ok: false,
        error: {
          code: 'core-object-failed',
        },
      })

      const failedCurrentRes = await requestJson(`${baseUrl}/api/after-sales/projects/current`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      expect(failedCurrentRes.status).toBe(200)
      expect((failedCurrentRes.body as any).data).toMatchObject({
        status: 'failed',
        projectId: PROJECT_ID,
        displayName: 'After Sales Retry Failure',
      })

      const failedLedgerRes = await pool.query<{
        tenant_id: string
        app_id: string
        project_id: string
        mode: string
        status: string
        warnings_json: unknown
      }>(
        `SELECT tenant_id, app_id, project_id, mode, status, warnings_json
         FROM plugin_after_sales_template_installs
         WHERE tenant_id = $1 AND app_id = $2`,
        [TENANT_ID, APP_ID],
      )
      expect(failedLedgerRes.rows).toHaveLength(1)
      expect(failedLedgerRes.rows[0]).toMatchObject({
        tenant_id: TENANT_ID,
        app_id: APP_ID,
        project_id: PROJECT_ID,
        mode: 'enable',
        status: 'failed',
      })
      expect(Array.isArray(failedLedgerRes.rows[0].warnings_json)).toBe(true)
      expect((failedLedgerRes.rows[0].warnings_json as unknown[]).length).toBeGreaterThan(0)
    } finally {
      coreApi.multitable.provisioning.ensureObject = originalEnsureObject
    }

    const reinstallRes = await requestJson(`${baseUrl}/api/after-sales/projects/install`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId: 'after-sales-default',
        mode: 'reinstall',
        displayName: 'After Sales Retry Success',
      }),
    })

    expect(reinstallRes.status).toBe(200)
    expect((reinstallRes.body as any).data).toMatchObject({
      projectId: PROJECT_ID,
      installResult: {
        status: 'installed',
        createdObjects: OBJECT_IDS,
        createdViews: VIEW_IDS.map((item) => item.viewId),
      },
    })

    const currentRes = await requestJson(`${baseUrl}/api/after-sales/projects/current`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(currentRes.status).toBe(200)
    expect((currentRes.body as any).data).toMatchObject({
      status: 'installed',
      projectId: PROJECT_ID,
      displayName: 'After Sales Retry Success',
    })

    const repairedLedgerRes = await pool.query<{
      tenant_id: string
      app_id: string
      project_id: string
      mode: string
      status: string
      display_name: string
    }>(
      `SELECT tenant_id, app_id, project_id, mode, status, display_name
       FROM plugin_after_sales_template_installs
       WHERE tenant_id = $1 AND app_id = $2`,
      [TENANT_ID, APP_ID],
    )
    expect(repairedLedgerRes.rows).toEqual([
      {
        tenant_id: TENANT_ID,
        app_id: APP_ID,
        project_id: PROJECT_ID,
        mode: 'reinstall',
        status: 'installed',
        display_name: 'After Sales Retry Success',
      },
    ])
  })

  it('creates a ticket and requests refund through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-ticket-it&roles=admin&perms=*:*`,
    )
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()

    const installRes = await requestJson(`${baseUrl}/api/after-sales/projects/install`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateId: 'after-sales-default',
        displayName: 'After Sales Ticket Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/tickets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          ticketNo: 'TK-3001',
          title: 'Outdoor unit not starting',
          source: 'phone',
          priority: 'high',
          assigneeCandidates: [{ id: 'tech_001', type: 'user' }],
        },
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        ticket?: {
          id?: string
          version?: number
          data?: Record<string, unknown>
        }
        event?: {
          accepted?: boolean
          event?: string
        }
      }
    }
    expect(createBody.ok).toBe(true)
    expect(createBody.data?.event).toEqual({
      accepted: true,
      event: 'ticket.created',
    })
    expect(createBody.data?.ticket?.data).toMatchObject({
      ticketNo: 'TK-3001',
      title: 'Outdoor unit not starting',
      source: 'phone',
      priority: 'high',
      status: 'new',
    })

    const listRes = await requestJson(`${baseUrl}/api/after-sales/tickets?status=new`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)
    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        projectId?: string
        count?: number
        tickets?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.projectId).toBe(PROJECT_ID)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.tickets?.[0]).toMatchObject({
      id: createBody.data?.ticket?.id,
      data: expect.objectContaining({
        ticketNo: 'TK-3001',
        status: 'new',
      }),
    })

    const createdTicketId = createBody.data?.ticket?.id
    expect(createdTicketId).toBeTruthy()

    const serviceTicketSheetId = stableMetaId('sheet', PROJECT_ID, 'serviceTicket')
    const recordRes = await waitFor(
      () => pool!.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdTicketId, serviceTicketSheetId],
      ),
      (result) => result.rows.length === 1,
    )
    expect(recordRes.rows).toHaveLength(1)
    expect(recordRes.rows[0].data).toMatchObject({
      [stFieldId('serviceTicket', 'ticketNo')]: 'TK-3001',
      [stFieldId('serviceTicket', 'title')]: 'Outdoor unit not starting',
      [stFieldId('serviceTicket', 'priority')]: 'high',
      [stFieldId('serviceTicket', 'status')]: 'new',
    })

    const refundRes = await requestJson(
      `${baseUrl}/api/after-sales/tickets/${createdTicketId}/refund-request`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refundAmount: 88.5,
          requesterName: 'After Sales Admin',
          reason: 'Damaged inverter board',
        }),
      },
    )

    expect(refundRes.status).toBe(202)
    const refundBody = refundRes.body as {
      ok?: boolean
      data?: {
        ticket?: {
          id?: string
          version?: number
          data?: Record<string, unknown>
        }
        event?: {
          accepted?: boolean
          event?: string
        }
      }
    }
    expect(refundBody.ok).toBe(true)
    expect(refundBody.data?.event).toEqual({
      accepted: true,
      event: 'ticket.refundRequested',
    })
    expect(refundBody.data?.ticket?.data).toMatchObject({
      ticketNo: 'TK-3001',
      refundAmount: 88.5,
      refundStatus: 'pending',
    })

    const patchedRecordRes = await waitFor(
      () => pool!.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdTicketId, serviceTicketSheetId],
      ),
      (result) =>
        result.rows.length === 1 &&
        Number(result.rows[0].data?.[stFieldId('serviceTicket', 'refundAmount')]) === 88.5,
    )
    expect(Number(patchedRecordRes.rows[0].data[stFieldId('serviceTicket', 'refundAmount')])).toBe(88.5)
    expect(patchedRecordRes.rows[0].data[stFieldId('serviceTicket', 'refundStatus')]).toBe('pending')
    expect(Number(patchedRecordRes.rows[0].version)).toBeGreaterThanOrEqual(2)

    const refundStatusRes = await waitFor(
      () =>
        requestJson(`${baseUrl}/api/after-sales/tickets/${createdTicketId}/refund-approval`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      (result) => {
        if (result.status !== 200) return false
        const body = result.body as {
          ok?: boolean
          data?: {
            projectId?: string
            approval?: {
              id?: string
              status?: string
              workflowKey?: string | null
              businessKey?: string | null
              assignments?: Array<{
                assigneeId?: string
                sourceStep?: number
                isActive?: boolean
              }>
            }
          }
        }
        return (
          body.ok === true &&
          body.data?.approval?.status === 'pending' &&
          body.data?.approval?.workflowKey === 'after-sales-refund' &&
          body.data?.approval?.businessKey ===
            `after-sales:${PROJECT_ID}:ticket:${createdTicketId}:refund` &&
          (body.data?.approval?.assignments?.length || 0) === 2
        )
      },
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(refundStatusRes.status).toBe(200)
    const refundStatusBody = refundStatusRes.body as {
      ok?: boolean
      data?: {
        projectId?: string
        approval?: {
          id?: string
          status?: string
          workflowKey?: string | null
          businessKey?: string | null
          assignments?: Array<{
            assigneeId?: string
            sourceStep?: number
            isActive?: boolean
          }>
        }
      }
    }
    expect(refundStatusBody.ok).toBe(true)
    expect(refundStatusBody.data?.approval).toMatchObject({
      status: 'pending',
      workflowKey: 'after-sales-refund',
      businessKey: `after-sales:${PROJECT_ID}:ticket:${createdTicketId}:refund`,
      assignments: [
        {
          assigneeId: 'finance',
          sourceStep: 1,
          isActive: true,
        },
        {
          assigneeId: 'supervisor',
          sourceStep: 2,
          isActive: true,
        },
      ],
    })

    const approvalId = refundStatusBody.data?.approval?.id
    expect(approvalId).toBeTruthy()

    const approveRes = await requestJson(
      `${baseUrl}/api/approvals/${approvalId}/actions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'approve',
          comment: 'finance approved',
        }),
      },
    )
    expect(approveRes.status).toBe(200)
    expect((approveRes.body as any).status).toBe('approved')

    const approvedRecordRes = await waitFor(
      () => pool!.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdTicketId, serviceTicketSheetId],
      ),
      (result) =>
        result.rows.length === 1 &&
        result.rows[0].data?.[stFieldId('serviceTicket', 'refundStatus')] === 'approved',
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(approvedRecordRes.rows[0].data[stFieldId('serviceTicket', 'refundStatus')]).toBe('approved')

    const approvedStatusRes = await waitFor(
      () =>
        requestJson(`${baseUrl}/api/after-sales/tickets/${createdTicketId}/refund-approval`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      (result) => {
        if (result.status !== 200) return false
        const body = result.body as {
          ok?: boolean
          data?: {
            approval?: {
              id?: string
              status?: string
            }
          }
        }
        return body.ok === true && body.data?.approval?.status === 'approved'
      },
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(approvedStatusRes.status).toBe(200)
    expect((approvedStatusRes.body as any).data?.approval).toMatchObject({
      id: approvalId,
      status: 'approved',
    })
  })
})
