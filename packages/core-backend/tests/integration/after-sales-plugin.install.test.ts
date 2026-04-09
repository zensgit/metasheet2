import { createHash } from 'crypto'
import http from 'http'
import { createRequire } from 'module'
import net from 'net'
import * as path from 'path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'

import type { MetaSheetServer } from '../../src/index'
import { notificationService } from '../../src/services/NotificationService'

type HttpResponse = { status: number; body?: unknown; raw: string }
type ExpectedField = { name: string; type: string }
const require = createRequire(import.meta.url)

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
const SUPERVISOR_USER_ID = 'after-sales-service-record-supervisor-it'
const SUPERVISOR_EMAIL = 'after-sales-supervisor-it@example.com'
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
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [SUPERVISOR_USER_ID])
    await pool.query('DELETE FROM users WHERE id = $1', [SUPERVISOR_USER_ID])
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

  async function seedSupervisorRecipient() {
    if (!pool) return
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE
       SET email = EXCLUDED.email,
           name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           is_active = TRUE,
           is_admin = FALSE`,
      [SUPERVISOR_USER_ID, SUPERVISOR_EMAIL, 'Service Record Supervisor', 'integration-test', 'supervisor'],
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [SUPERVISOR_USER_ID, 'supervisor'],
    )
  }

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

    const repoRoot = path.join(__dirname, '../../../../')
    const installerModule = require(path.join(
      repoRoot,
      'plugins',
      'plugin-after-sales',
      'lib',
      'installer.cjs',
    ))
    const originalRunInstall = installerModule.runInstall
    let failOnce = true
    installerModule.runInstall = async (input: any) => {
      if (!failOnce) {
        return originalRunInstall(input)
      }
      failOnce = false
      const originalEnsureObject = input.context.api.multitable.provisioning.ensureObject
      input.context.api.multitable.provisioning.ensureObject = async () => {
        throw new Error('simulated provisioning failure')
      }
      try {
        return await originalRunInstall(input)
      } finally {
        input.context.api.multitable.provisioning.ensureObject = originalEnsureObject
      }
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
      installerModule.runInstall = originalRunInstall
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

  it('updates a ticket through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-ticket-update-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Ticket Update Flow',
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
          ticketNo: 'TK-3001-U',
          title: 'Needs update',
          source: 'web',
          priority: 'normal',
        },
      }),
    })
    expect(createRes.status).toBe(201)

    const createdTicketId = ((createRes.body as any).data?.ticket?.id ?? '') as string
    expect(createdTicketId).toBeTruthy()

    const updateRes = await requestJson(`${baseUrl}/api/after-sales/tickets/${createdTicketId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          title: 'Updated after diagnostic visit',
          source: 'wechat',
          priority: 'urgent',
          status: 'assigned',
        },
      }),
    })
    expect(updateRes.status).toBe(200)
    expect((updateRes.body as any).data?.ticket?.data).toMatchObject({
      ticketNo: 'TK-3001-U',
      title: 'Updated after diagnostic visit',
      source: 'wechat',
      priority: 'urgent',
      status: 'assigned',
    })

    const serviceTicketSheetId = stableMetaId('sheet', PROJECT_ID, 'serviceTicket')
    const updatedRecordRes = await waitFor(
      () => pool!.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdTicketId, serviceTicketSheetId],
      ),
      (result) =>
        result.rows.length === 1 &&
        result.rows[0].data?.[stFieldId('serviceTicket', 'status')] === 'assigned' &&
        result.rows[0].data?.[stFieldId('serviceTicket', 'title')] === 'Updated after diagnostic visit',
    )
    expect(updatedRecordRes.rows[0].data).toMatchObject({
      [stFieldId('serviceTicket', 'ticketNo')]: 'TK-3001-U',
      [stFieldId('serviceTicket', 'title')]: 'Updated after diagnostic visit',
      [stFieldId('serviceTicket', 'source')]: 'wechat',
      [stFieldId('serviceTicket', 'priority')]: 'urgent',
      [stFieldId('serviceTicket', 'status')]: 'assigned',
    })

    const listRes = await requestJson(
      `${baseUrl}/api/after-sales/tickets?status=assigned&search=${encodeURIComponent('Updated after diagnostic visit')}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    expect(listRes.status).toBe(200)
    expect((listRes.body as any).data?.tickets?.[0]).toMatchObject({
      id: createdTicketId,
      data: expect.objectContaining({
        ticketNo: 'TK-3001-U',
        status: 'assigned',
      }),
    })
  })

  it('marks refund status as rejected when the approval action rejects the request', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-refund-reject-it&roles=admin&perms=*:*`,
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
        mode: 'enable',
        displayName: 'After Sales IT',
        config: {
          defaultSlaHours: 24,
          urgentSlaHours: 4,
          followUpAfterDays: 7,
        },
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
          ticketNo: 'TK-3002',
          title: 'Refund should be rejected',
          priority: 'normal',
          source: 'phone',
        },
      }),
    })
    expect(createRes.status).toBe(201)

    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        ticket?: {
          id?: string
        }
      }
    }
    const createdTicketId = createBody.data?.ticket?.id
    expect(createdTicketId).toBeTruthy()

    const serviceTicketSheetId = stableMetaId('sheet', PROJECT_ID, 'serviceTicket')

    const refundRes = await requestJson(
      `${baseUrl}/api/after-sales/tickets/${createdTicketId}/refund-request`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refundAmount: 66.6,
          requesterName: 'After Sales Admin',
          reason: 'Rejected refund request',
        }),
      },
    )
    expect(refundRes.status).toBe(202)

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
            approval?: {
              id?: string
              status?: string
            }
          }
        }
        return body.ok === true && body.data?.approval?.status === 'pending'
      },
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(refundStatusRes.status).toBe(200)

    const approvalId = ((refundStatusRes.body as any).data?.approval?.id ?? '') as string
    expect(approvalId).toBeTruthy()

    const rejectRes = await requestJson(
      `${baseUrl}/api/approvals/${approvalId}/actions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reject',
          comment: 'finance rejected',
        }),
      },
    )
    expect(rejectRes.status).toBe(200)
    expect((rejectRes.body as any).status).toBe('rejected')

    const rejectedRecordRes = await waitFor(
      () => pool!.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdTicketId, serviceTicketSheetId],
      ),
      (result) =>
        result.rows.length === 1 &&
        result.rows[0].data?.[stFieldId('serviceTicket', 'refundStatus')] === 'rejected',
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(rejectedRecordRes.rows[0].data[stFieldId('serviceTicket', 'refundStatus')]).toBe('rejected')

    const rejectedStatusRes = await waitFor(
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
        return body.ok === true && body.data?.approval?.status === 'rejected'
      },
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(rejectedStatusRes.status).toBe(200)
    expect((rejectedStatusRes.body as any).data?.approval).toMatchObject({
      id: approvalId,
      status: 'rejected',
    })
  })

  it('creates and lists service records through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-service-record-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Service Record Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createTicketRes = await requestJson(`${baseUrl}/api/after-sales/tickets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          ticketNo: 'TK-3002',
          title: 'Indoor unit vibration during service visit',
          source: 'phone',
          priority: 'normal',
        },
      }),
    })
    expect(createTicketRes.status).toBe(201)

    await seedSupervisorRecipient()

    const sendSpy = vi.spyOn(notificationService, 'send')

    const createRes = await requestJson(`${baseUrl}/api/after-sales/service-records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceRecord: {
          ticketNo: 'TK-3002',
          visitType: 'onsite',
          scheduledAt: '2026-04-09T10:00:00Z',
          completedAt: '2026-04-09T11:15:00Z',
          technicianName: 'Tech One',
          workSummary: 'Replaced compressor capacitor',
          result: 'resolved',
        },
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        projectId?: string
        serviceRecord?: {
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
      event: 'service.recorded',
    })
    expect(createBody.data?.serviceRecord?.data).toMatchObject({
      ticketNo: 'TK-3002',
      visitType: 'onsite',
      scheduledAt: '2026-04-09T10:00:00Z',
      completedAt: '2026-04-09T11:15:00Z',
      technicianName: 'Tech One',
      workSummary: 'Replaced compressor capacitor',
      result: 'resolved',
    })

    const serviceRecordSheetId = stableMetaId('sheet', PROJECT_ID, 'serviceRecord')
    const recordRes = await waitFor(
      () => pool.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at DESC LIMIT 1',
        [serviceRecordSheetId],
      ),
      (result) => result.rows.length === 1,
    )
    expect(recordRes.rows).toHaveLength(1)
    expect(recordRes.rows[0].data).toMatchObject({
      [stFieldId('serviceRecord', 'ticketNo')]: 'TK-3002',
      [stFieldId('serviceRecord', 'visitType')]: 'onsite',
      [stFieldId('serviceRecord', 'scheduledAt')]: '2026-04-09T10:00:00Z',
      [stFieldId('serviceRecord', 'completedAt')]: '2026-04-09T11:15:00Z',
      [stFieldId('serviceRecord', 'technicianName')]: 'Tech One',
      [stFieldId('serviceRecord', 'workSummary')]: 'Replaced compressor capacitor',
      [stFieldId('serviceRecord', 'result')]: 'resolved',
    })

    const listRes = await requestJson(`${baseUrl}/api/after-sales/service-records?ticketNo=TK-3002&result=resolved&search=capacitor`, {
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
        serviceRecords?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.projectId).toBe(PROJECT_ID)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.serviceRecords?.[0]).toMatchObject({
      id: createBody.data?.serviceRecord?.id,
      data: expect.objectContaining({
        ticketNo: 'TK-3002',
        visitType: 'onsite',
        result: 'resolved',
      }),
    })

    const sentNotifications = await waitFor(
      async () => sendSpy.mock.calls.map(([notification]) => notification),
      (notifications) => notifications.length === 2,
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(sentNotifications).toHaveLength(2)
    expect(sentNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'service.recorded',
          channel: 'feishu',
          metadata: expect.objectContaining({
            topic: 'after-sales.service.recorded',
            event: 'service.recorded',
          }),
          recipients: [{ id: SUPERVISOR_USER_ID, type: 'user' }],
        }),
        expect.objectContaining({
          type: 'service.recorded',
          channel: 'email',
          metadata: expect.objectContaining({
            topic: 'after-sales.service.recorded',
            event: 'service.recorded',
          }),
          recipients: [{ id: SUPERVISOR_EMAIL, type: 'email' }],
        }),
      ]),
    )
    sendSpy.mockRestore()
  })

  it('creates and deletes tickets through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-ticket-delete-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Ticket Delete Flow',
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
          ticketNo: 'TK-3003',
          title: 'Delete me after validation',
          source: 'web',
          priority: 'normal',
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
      }
    }
    expect(createBody.ok).toBe(true)
    expect(createBody.data?.ticket?.data).toMatchObject({
      ticketNo: 'TK-3003',
      title: 'Delete me after validation',
      status: 'new',
    })

    const createdTicketId = createBody.data?.ticket?.id
    expect(createdTicketId).toBeTruthy()

    const deleteRes = await requestJson(`${baseUrl}/api/after-sales/tickets/${createdTicketId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body).toMatchObject({
      ok: true,
      data: {
        projectId: PROJECT_ID,
        ticketId: createdTicketId,
        deleted: true,
      },
    })

    const serviceTicketSheetId = stableMetaId('sheet', PROJECT_ID, 'serviceTicket')
    const deletedRecordRes = await waitFor(
      () => pool!.query<{ id: string }>(
        'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdTicketId, serviceTicketSheetId],
      ),
      (result) => result.rows.length === 0,
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(deletedRecordRes.rows).toHaveLength(0)

    const listRes = await requestJson(`${baseUrl}/api/after-sales/tickets?status=new`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)
    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        tickets?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(0)
    expect(listBody.data?.tickets ?? []).toEqual([])
  })

  it('creates and deletes service records through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-service-record-delete-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Service Record Delete Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createTicketRes = await requestJson(`${baseUrl}/api/after-sales/tickets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          ticketNo: 'TK-3004',
          title: 'Delete service record after visit',
          source: 'phone',
          priority: 'normal',
        },
      }),
    })
    expect(createTicketRes.status).toBe(201)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/service-records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceRecord: {
          ticketNo: 'TK-3004',
          visitType: 'remote',
          scheduledAt: '2026-04-09T12:00:00Z',
          completedAt: '2026-04-09T12:30:00Z',
          technicianName: 'Tech Delete',
          workSummary: 'Temporary cleanup visit',
          result: 'partial',
        },
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        serviceRecord?: {
          id?: string
          version?: number
          data?: Record<string, unknown>
        }
      }
    }
    expect(createBody.ok).toBe(true)
    const createdServiceRecordId = createBody.data?.serviceRecord?.id
    expect(createdServiceRecordId).toBeTruthy()

    const deleteRes = await requestJson(`${baseUrl}/api/after-sales/service-records/${createdServiceRecordId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body).toMatchObject({
      ok: true,
      data: {
        projectId: PROJECT_ID,
        serviceRecordId: createdServiceRecordId,
        deleted: true,
      },
    })

    const serviceRecordSheetId = stableMetaId('sheet', PROJECT_ID, 'serviceRecord')
    const deletedRecordRes = await waitFor(
      () => pool.query<{ id: string }>(
        'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdServiceRecordId, serviceRecordSheetId],
      ),
      (result) => result.rows.length === 0,
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(deletedRecordRes.rows).toHaveLength(0)

    const listRes = await requestJson(`${baseUrl}/api/after-sales/service-records?ticketNo=TK-3004`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)
    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        serviceRecords?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(0)
    expect(listBody.data?.serviceRecords ?? []).toEqual([])
  })

  it('updates service records through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-service-record-update-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Service Record Update Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createTicketRes = await requestJson(`${baseUrl}/api/after-sales/tickets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ticket: {
          ticketNo: 'TK-3005',
          title: 'Update service record after visit',
          source: 'phone',
          priority: 'normal',
        },
      }),
    })
    expect(createTicketRes.status).toBe(201)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/service-records`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceRecord: {
          ticketNo: 'TK-3005',
          visitType: 'onsite',
          scheduledAt: '2026-04-09T12:00:00Z',
          completedAt: '2026-04-09T12:45:00Z',
          technicianName: 'Tech Baseline',
          workSummary: 'Initial onsite visit',
          result: 'resolved',
        },
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        serviceRecord?: {
          id?: string
        }
      }
    }
    const createdServiceRecordId = createBody.data?.serviceRecord?.id
    expect(createdServiceRecordId).toBeTruthy()

    const updateRes = await requestJson(`${baseUrl}/api/after-sales/service-records/${createdServiceRecordId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceRecord: {
          visitType: 'remote',
          scheduledAt: '2026-04-09T13:00:00Z',
          completedAt: '',
          technicianName: 'Tech Updated',
          workSummary: 'Remote follow-up diagnostics',
          result: 'partial',
        },
      }),
    })

    expect(updateRes.status).toBe(200)
    expect((updateRes.body as any).data?.serviceRecord?.data).toMatchObject({
      ticketNo: 'TK-3005',
      visitType: 'remote',
      scheduledAt: '2026-04-09T13:00:00Z',
      technicianName: 'Tech Updated',
      workSummary: 'Remote follow-up diagnostics',
      result: 'partial',
    })

    const serviceRecordSheetId = stableMetaId('sheet', PROJECT_ID, 'serviceRecord')
    const updatedRecordRes = await waitFor(
      () => pool.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdServiceRecordId, serviceRecordSheetId],
      ),
      (result) =>
        result.rows.length === 1 &&
        result.rows[0].data?.[stFieldId('serviceRecord', 'visitType')] === 'remote' &&
        result.rows[0].data?.[stFieldId('serviceRecord', 'completedAt')] == null,
    )
    expect(updatedRecordRes.rows[0].data).toMatchObject({
      [stFieldId('serviceRecord', 'ticketNo')]: 'TK-3005',
      [stFieldId('serviceRecord', 'visitType')]: 'remote',
      [stFieldId('serviceRecord', 'scheduledAt')]: '2026-04-09T13:00:00Z',
      [stFieldId('serviceRecord', 'completedAt')]: null,
      [stFieldId('serviceRecord', 'technicianName')]: 'Tech Updated',
      [stFieldId('serviceRecord', 'workSummary')]: 'Remote follow-up diagnostics',
      [stFieldId('serviceRecord', 'result')]: 'partial',
    })

    const listRes = await requestJson(`${baseUrl}/api/after-sales/service-records?result=partial&search=Remote%20follow-up`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)
    expect((listRes.body as any).data?.serviceRecords?.[0]).toMatchObject({
      id: createdServiceRecordId,
      data: expect.objectContaining({
        ticketNo: 'TK-3005',
        result: 'partial',
      }),
    })
  })

  it('creates installed assets through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-installed-asset-create-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Installed Asset Create Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/installed-assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        installedAsset: {
          assetCode: 'AST-5001',
          serialNo: 'SN-5001',
          model: 'Compressor Z',
          location: 'Plant 5',
          installedAt: '2026-04-12T08:00:00Z',
          warrantyUntil: '2027-04-12',
          status: 'active',
        },
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        installedAsset?: {
          id?: string
          version?: number
          data?: Record<string, unknown>
        }
      }
    }
    expect(createBody.ok).toBe(true)
    expect(createBody.data?.installedAsset?.data).toMatchObject({
      assetCode: 'AST-5001',
      serialNo: 'SN-5001',
      model: 'Compressor Z',
      location: 'Plant 5',
      installedAt: '2026-04-12T08:00:00Z',
      warrantyUntil: '2027-04-12',
      status: 'active',
    })

    const createdInstalledAssetId = createBody.data?.installedAsset?.id
    expect(createdInstalledAssetId).toBeTruthy()

    const installedAssetSheetId = stableMetaId('sheet', PROJECT_ID, 'installedAsset')
    const createdRecordRes = await pool.query<{ id: string; version: number; data: Record<string, unknown> }>(
      'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
      [createdInstalledAssetId, installedAssetSheetId],
    )
    expect(createdRecordRes.rows).toHaveLength(1)
    expect(createdRecordRes.rows[0]?.data).toMatchObject({
      [stFieldId('installedAsset', 'assetCode')]: 'AST-5001',
      [stFieldId('installedAsset', 'serialNo')]: 'SN-5001',
      [stFieldId('installedAsset', 'model')]: 'Compressor Z',
      [stFieldId('installedAsset', 'location')]: 'Plant 5',
      [stFieldId('installedAsset', 'installedAt')]: '2026-04-12T08:00:00Z',
      [stFieldId('installedAsset', 'warrantyUntil')]: '2027-04-12',
      [stFieldId('installedAsset', 'status')]: 'active',
    })

    const listRes = await requestJson(`${baseUrl}/api/after-sales/installed-assets?status=active&search=AST-5001`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)

    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        installedAssets?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.installedAssets ?? []).toHaveLength(1)
    expect(listBody.data?.installedAssets?.[0]).toMatchObject({
      id: createdInstalledAssetId,
      data: {
        assetCode: 'AST-5001',
        serialNo: 'SN-5001',
        model: 'Compressor Z',
        location: 'Plant 5',
        installedAt: '2026-04-12T08:00:00Z',
        warrantyUntil: '2027-04-12',
        status: 'active',
      },
    })
  })

  it('updates installed assets through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-installed-asset-update-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Installed Asset Update Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/installed-assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        installedAsset: {
          assetCode: 'AST-5003',
          serialNo: 'SN-5003',
          model: 'Compressor Baseline',
          location: 'Plant 7',
          installedAt: '2026-04-13T08:00:00Z',
          warrantyUntil: '2027-04-13',
          status: 'active',
        },
      }),
    })
    expect(createRes.status).toBe(201)

    const createdInstalledAssetId = ((createRes.body as {
      data?: { installedAsset?: { id?: string } }
    })?.data?.installedAsset?.id)
    expect(createdInstalledAssetId).toBeTruthy()

    const updateRes = await requestJson(
      `${baseUrl}/api/after-sales/installed-assets/${encodeURIComponent(String(createdInstalledAssetId))}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          installedAsset: {
            assetCode: 'AST-5003-UPDATED',
            serialNo: '',
            model: 'Compressor Updated',
            location: 'Plant 8',
            installedAt: '2026-04-13T10:15:00Z',
            warrantyUntil: '',
            status: 'expired',
          },
        }),
      },
    )

    expect(updateRes.status).toBe(200)
    const updateBody = updateRes.body as {
      ok?: boolean
      data?: {
        installedAsset?: {
          id?: string
          data?: Record<string, unknown>
        }
      }
    }
    expect(updateBody.ok).toBe(true)
    expect(updateBody.data?.installedAsset?.data).toMatchObject({
      assetCode: 'AST-5003-UPDATED',
      model: 'Compressor Updated',
      location: 'Plant 8',
      installedAt: '2026-04-13T10:15:00Z',
      status: 'expired',
    })

    const installedAssetSheetId = stableMetaId('sheet', PROJECT_ID, 'installedAsset')
    const updatedRecordRes = await pool.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2',
      [createdInstalledAssetId, installedAssetSheetId],
    )
    expect(updatedRecordRes.rows).toHaveLength(1)
    expect(updatedRecordRes.rows[0]?.data).toMatchObject({
      [stFieldId('installedAsset', 'assetCode')]: 'AST-5003-UPDATED',
      [stFieldId('installedAsset', 'model')]: 'Compressor Updated',
      [stFieldId('installedAsset', 'location')]: 'Plant 8',
      [stFieldId('installedAsset', 'installedAt')]: '2026-04-13T10:15:00Z',
      [stFieldId('installedAsset', 'status')]: 'expired',
    })
    expect(updatedRecordRes.rows[0]?.data?.[stFieldId('installedAsset', 'serialNo')] ?? null).toBeNull()
    expect(updatedRecordRes.rows[0]?.data?.[stFieldId('installedAsset', 'warrantyUntil')] ?? null).toBeNull()

    const listRes = await requestJson(
      `${baseUrl}/api/after-sales/installed-assets?status=expired&search=AST-5003-UPDATED`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    expect(listRes.status).toBe(200)

    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        installedAssets?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.installedAssets ?? []).toHaveLength(1)
    expect(listBody.data?.installedAssets?.[0]).toMatchObject({
      id: createdInstalledAssetId,
      data: {
        assetCode: 'AST-5003-UPDATED',
        status: 'expired',
      },
    })
  })

  it('creates and deletes installed assets through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-installed-asset-delete-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Installed Asset Delete Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/installed-assets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        installedAsset: {
          assetCode: 'AST-5002',
          serialNo: 'SN-5002',
          model: 'Compressor Delete',
          location: 'Plant 6',
          installedAt: '2026-04-13T08:00:00Z',
          warrantyUntil: '2027-04-13',
          status: 'active',
        },
      }),
    })
    expect(createRes.status).toBe(201)

    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        installedAsset?: {
          id?: string
        }
      }
    }
    const createdInstalledAssetId = createBody.data?.installedAsset?.id
    expect(createdInstalledAssetId).toBeTruthy()

    const deleteRes = await requestJson(`${baseUrl}/api/after-sales/installed-assets/${createdInstalledAssetId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(deleteRes.status).toBe(200)
    expect(deleteRes.body).toMatchObject({
      ok: true,
      data: {
        projectId: PROJECT_ID,
        installedAssetId: createdInstalledAssetId,
        deleted: true,
      },
    })

    const installedAssetSheetId = stableMetaId('sheet', PROJECT_ID, 'installedAsset')
    const deletedRecordRes = await waitFor(
      () => pool.query<{ id: string }>(
        'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdInstalledAssetId, installedAssetSheetId],
      ),
      (result) => result.rows.length === 0,
      { timeoutMs: 5000, intervalMs: 100 },
    )
    expect(deletedRecordRes.rows).toHaveLength(0)

    const listRes = await requestJson(`${baseUrl}/api/after-sales/installed-assets?status=active&search=AST-5002`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)
    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        installedAssets?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(0)
    expect(listBody.data?.installedAssets ?? []).toEqual([])
  })

  it('lists customers through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-customer-list-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Customer List Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const customerSheetId = stableMetaId('sheet', PROJECT_ID, 'customer')
    const aliceId = 'rec_customer_alice'
    const bobId = 'rec_customer_bob'

    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version)
       VALUES ($1, $2, $3::jsonb, 1), ($4, $2, $5::jsonb, 1)`,
      [
        aliceId,
        customerSheetId,
        JSON.stringify({
          [stFieldId('customer', 'customerCode')]: 'CUS-5001',
          [stFieldId('customer', 'name')]: 'Alice Plant',
          [stFieldId('customer', 'phone')]: '13800138000',
          [stFieldId('customer', 'email')]: 'alice@example.com',
          [stFieldId('customer', 'status')]: 'active',
        }),
        bobId,
        JSON.stringify({
          [stFieldId('customer', 'customerCode')]: 'CUS-5002',
          [stFieldId('customer', 'name')]: 'Bob Warehouse',
          [stFieldId('customer', 'phone')]: '13900139000',
          [stFieldId('customer', 'email')]: 'bob@example.com',
          [stFieldId('customer', 'status')]: 'inactive',
        }),
      ],
    )

    const listRes = await requestJson(`${baseUrl}/api/after-sales/customers?status=active&search=Alice`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)

    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        customers?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.customers ?? []).toHaveLength(1)
    expect(listBody.data?.customers?.[0]).toMatchObject({
      id: aliceId,
      data: {
        customerCode: 'CUS-5001',
        name: 'Alice Plant',
        phone: '13800138000',
        email: 'alice@example.com',
        status: 'active',
      },
    })
  })

  it('lists follow-ups through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-follow-up-list-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Follow-up List Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const followUpSheetId = stableMetaId('sheet', PROJECT_ID, 'followUp')
    const followUpAliceId = 'rec_follow_up_alice'
    const followUpBobId = 'rec_follow_up_bob'

    await pool.query(
      `INSERT INTO meta_records (id, sheet_id, data, version)
       VALUES ($1, $2, $3::jsonb, 1), ($4, $2, $5::jsonb, 1)`,
      [
        followUpAliceId,
        followUpSheetId,
        JSON.stringify({
          [stFieldId('followUp', 'ticketNo')]: 'TK-5001',
          [stFieldId('followUp', 'customerName')]: 'Alice Plant',
          [stFieldId('followUp', 'dueAt')]: '2026-04-10T09:00:00Z',
          [stFieldId('followUp', 'followUpType')]: 'visit',
          [stFieldId('followUp', 'ownerName')]: 'CSR Chen',
          [stFieldId('followUp', 'status')]: 'pending',
          [stFieldId('followUp', 'summary')]: 'Call Alice after onsite capacitor replacement',
        }),
        followUpBobId,
        JSON.stringify({
          [stFieldId('followUp', 'ticketNo')]: 'TK-5002',
          [stFieldId('followUp', 'customerName')]: 'Bob Warehouse',
          [stFieldId('followUp', 'dueAt')]: '2026-04-11T09:00:00Z',
          [stFieldId('followUp', 'followUpType')]: 'phone',
          [stFieldId('followUp', 'ownerName')]: 'CSR Li',
          [stFieldId('followUp', 'status')]: 'done',
          [stFieldId('followUp', 'summary')]: 'Completed warehouse status check',
        }),
      ],
    )

    const listRes = await requestJson(
      `${baseUrl}/api/after-sales/follow-ups?status=pending&ticketNo=TK-5001&search=capacitor`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    expect(listRes.status).toBe(200)

    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        followUps?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.followUps ?? []).toHaveLength(1)
    expect(listBody.data?.followUps?.[0]).toMatchObject({
      id: followUpAliceId,
      data: {
        ticketNo: 'TK-5001',
        customerName: 'Alice Plant',
        dueAt: '2026-04-10T09:00:00Z',
        followUpType: 'visit',
        ownerName: 'CSR Chen',
        status: 'pending',
        summary: 'Call Alice after onsite capacitor replacement',
      },
    })
  })

  it('creates follow-ups through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-follow-up-create-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Follow-up Create Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/follow-ups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        followUp: {
          ticketNo: 'TK-5003',
          customerName: 'Charlie Logistics',
          dueAt: '2026-04-12T09:30:00Z',
          followUpType: 'message',
          ownerName: 'CSR Wang',
          summary: 'Send follow-up message after delivery confirmation',
        },
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        projectId?: string
        followUp?: {
          id?: string
          version?: number
          data?: Record<string, unknown>
        }
      }
    }
    expect(createBody.ok).toBe(true)
    expect(createBody.data?.followUp?.data).toMatchObject({
      ticketNo: 'TK-5003',
      customerName: 'Charlie Logistics',
      dueAt: '2026-04-12T09:30:00Z',
      followUpType: 'message',
      ownerName: 'CSR Wang',
      status: 'pending',
      summary: 'Send follow-up message after delivery confirmation',
    })

    const followUpSheetId = stableMetaId('sheet', PROJECT_ID, 'followUp')
    const createdFollowUpId = createBody.data?.followUp?.id
    expect(createdFollowUpId).toBeTruthy()

    const recordRes = await waitFor(
      () => pool.query<{ id: string; version: number; data: Record<string, unknown> }>(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdFollowUpId, followUpSheetId],
      ),
      (result) => result.rows.length === 1,
    )
    expect(recordRes.rows).toHaveLength(1)
    expect(recordRes.rows[0].data).toMatchObject({
      [stFieldId('followUp', 'ticketNo')]: 'TK-5003',
      [stFieldId('followUp', 'customerName')]: 'Charlie Logistics',
      [stFieldId('followUp', 'dueAt')]: '2026-04-12T09:30:00Z',
      [stFieldId('followUp', 'followUpType')]: 'message',
      [stFieldId('followUp', 'ownerName')]: 'CSR Wang',
      [stFieldId('followUp', 'status')]: 'pending',
      [stFieldId('followUp', 'summary')]: 'Send follow-up message after delivery confirmation',
    })

    const listRes = await requestJson(
      `${baseUrl}/api/after-sales/follow-ups?status=pending&ticketNo=TK-5003&search=delivery`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    expect(listRes.status).toBe(200)
    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        followUps?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.followUps?.[0]).toMatchObject({
      id: createdFollowUpId,
      data: {
        ticketNo: 'TK-5003',
        customerName: 'Charlie Logistics',
        followUpType: 'message',
        status: 'pending',
      },
    })
  })

  it('creates and deletes follow-ups through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-follow-up-delete-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Follow-up Delete Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/follow-ups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        followUp: {
          ticketNo: 'TK-5004',
          customerName: 'Delete Me Follow-up',
          dueAt: '2026-04-18T08:00:00Z',
          followUpType: 'phone',
          ownerName: 'CSR Chen',
          summary: 'Delete this follow-up after verification',
        },
      }),
    })
    expect(createRes.status).toBe(201)

    const createdFollowUpId = (
      createRes.body as {
        data?: {
          followUp?: {
            id?: string
          }
        }
      }
    ).data?.followUp?.id
    expect(createdFollowUpId).toBeTruthy()

    const deleteRes = await requestJson(
      `${baseUrl}/api/after-sales/follow-ups/${encodeURIComponent(String(createdFollowUpId))}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    expect(deleteRes.status).toBe(200)
    expect((deleteRes.body as any).data).toMatchObject({
      projectId: PROJECT_ID,
      followUpId: createdFollowUpId,
      deleted: true,
    })

    const followUpSheetId = stableMetaId('sheet', PROJECT_ID, 'followUp')
    const recordRes = await waitFor(
      () => pool.query<{ id: string }>(
        'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [createdFollowUpId, followUpSheetId],
      ),
      (result) => result.rows.length === 0,
    )
    expect(recordRes.rows).toHaveLength(0)
  })

  it('creates customers through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-customer-create-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Customer Create Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/customers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: {
          customerCode: 'CUS-5003',
          name: 'Charlie Logistics',
          phone: '13700137000',
          email: 'charlie@example.com',
          status: 'active',
        },
      }),
    })

    expect(createRes.status).toBe(201)
    const createBody = createRes.body as {
      ok?: boolean
      data?: {
        customer?: {
          id?: string
          version?: number
          data?: Record<string, unknown>
        }
      }
    }
    expect(createBody.ok).toBe(true)
    expect(createBody.data?.customer?.data).toMatchObject({
      customerCode: 'CUS-5003',
      name: 'Charlie Logistics',
      phone: '13700137000',
      email: 'charlie@example.com',
      status: 'active',
    })

    const createdCustomerId = createBody.data?.customer?.id
    expect(createdCustomerId).toBeTruthy()

    const customerSheetId = stableMetaId('sheet', PROJECT_ID, 'customer')
    const createdRecordRes = await pool.query<{ id: string; version: number; data: Record<string, unknown> }>(
      'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
      [createdCustomerId, customerSheetId],
    )
    expect(createdRecordRes.rows).toHaveLength(1)
    expect(createdRecordRes.rows[0]?.data).toMatchObject({
      [stFieldId('customer', 'customerCode')]: 'CUS-5003',
      [stFieldId('customer', 'name')]: 'Charlie Logistics',
      [stFieldId('customer', 'phone')]: '13700137000',
      [stFieldId('customer', 'email')]: 'charlie@example.com',
      [stFieldId('customer', 'status')]: 'active',
    })

    const listRes = await requestJson(`${baseUrl}/api/after-sales/customers?status=active&search=Charlie`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)

    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        customers?: Array<{
          id?: string
          data?: Record<string, unknown>
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(1)
    expect(listBody.data?.customers ?? []).toHaveLength(1)
    expect(listBody.data?.customers?.[0]).toMatchObject({
      id: createdCustomerId,
      data: {
        customerCode: 'CUS-5003',
        name: 'Charlie Logistics',
        status: 'active',
      },
    })
  })

  it('updates customers through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-customer-update-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Customer Update Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/customers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: {
          customerCode: 'CUS-5005',
          name: 'Customer Baseline',
          phone: '13500135000',
          email: 'baseline@example.com',
          status: 'active',
        },
      }),
    })
    expect(createRes.status).toBe(201)

    const createdCustomerId = ((createRes.body as {
      data?: { customer?: { id?: string } }
    })?.data?.customer?.id)
    expect(createdCustomerId).toBeTruthy()

    const updateRes = await requestJson(
      `${baseUrl}/api/after-sales/customers/${encodeURIComponent(String(createdCustomerId))}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          customer: {
            name: 'Customer Updated',
            phone: '',
            email: 'updated@example.com',
          },
        }),
      },
    )

    expect(updateRes.status).toBe(200)
    const updateBody = updateRes.body as {
      ok?: boolean
      data?: {
        customer?: {
          id?: string
          data?: Record<string, unknown>
        }
      }
    }
    expect(updateBody.ok).toBe(true)
    expect(updateBody.data?.customer?.data).toMatchObject({
      customerCode: 'CUS-5005',
      name: 'Customer Updated',
      email: 'updated@example.com',
      status: 'active',
    })

    const customerSheetId = stableMetaId('sheet', PROJECT_ID, 'customer')
    const updatedRecordRes = await pool.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2',
      [createdCustomerId, customerSheetId],
    )
    expect(updatedRecordRes.rows).toHaveLength(1)
    expect(updatedRecordRes.rows[0]?.data).toMatchObject({
      [stFieldId('customer', 'customerCode')]: 'CUS-5005',
      [stFieldId('customer', 'name')]: 'Customer Updated',
      [stFieldId('customer', 'phone')]: null,
      [stFieldId('customer', 'email')]: 'updated@example.com',
      [stFieldId('customer', 'status')]: 'active',
    })
  })

  it('deletes customers through the real after-sales routes', async () => {
    if (!baseUrl || !pool) return

    const tokenRes = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=after-sales-customer-delete-it&roles=admin&perms=*:*`,
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
        displayName: 'After Sales Customer Delete Flow',
      }),
    })
    expect(installRes.status).toBe(200)

    const createRes = await requestJson(`${baseUrl}/api/after-sales/customers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customer: {
          customerCode: 'CUS-5004',
          name: 'Delete Me Customer',
          phone: '13600136000',
          email: 'delete-me@example.com',
          status: 'active',
        },
      }),
    })
    expect(createRes.status).toBe(201)

    const createdCustomerId = (
      createRes.body as {
        data?: {
          customer?: {
            id?: string
          }
        }
      }
    ).data?.customer?.id
    expect(createdCustomerId).toBeTruthy()

    const deleteRes = await requestJson(
      `${baseUrl}/api/after-sales/customers/${encodeURIComponent(String(createdCustomerId))}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    )
    expect(deleteRes.status).toBe(200)

    const deleteBody = deleteRes.body as {
      ok?: boolean
      data?: {
        customerId?: string
        deleted?: boolean
      }
    }
    expect(deleteBody.ok).toBe(true)
    expect(deleteBody.data).toMatchObject({
      customerId: createdCustomerId,
      deleted: true,
    })

    const customerSheetId = stableMetaId('sheet', PROJECT_ID, 'customer')
    const deletedRecordRes = await pool.query<{ id: string }>(
      'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2',
      [createdCustomerId, customerSheetId],
    )
    expect(deletedRecordRes.rows).toHaveLength(0)

    const listRes = await requestJson(`${baseUrl}/api/after-sales/customers?status=active&search=Delete%20Me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(listRes.status).toBe(200)

    const listBody = listRes.body as {
      ok?: boolean
      data?: {
        count?: number
        customers?: Array<{
          id?: string
        }>
      }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.data?.count).toBe(0)
    expect(listBody.data?.customers ?? []).toEqual([])
  })
})
