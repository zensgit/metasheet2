import { createHash } from 'crypto'
import http from 'http'
import net from 'net'
import * as path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'

import type { MetaSheetServer } from '../../src/index'

type HttpResponse = { status: number; body?: unknown; raw: string }

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

describe('after-sales plugin install integration', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool | undefined
  let schemaReady = false

  async function cleanupAfterSalesInstallArtifacts() {
    if (!pool || !schemaReady) return
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
         UNION ALL SELECT to_regclass('public.meta_records') AS name`,
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

    const installedAssetSheetId = stableMetaId('sheet', PROJECT_ID, 'installedAsset')
    const installedAssetViewId = stableMetaId('view', PROJECT_ID, 'installedAsset', 'installedAsset-grid')

    const sheetRes = await pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM meta_sheets WHERE id = $1',
      [installedAssetSheetId],
    )
    expect(sheetRes.rows).toEqual([
      {
        id: installedAssetSheetId,
        name: 'Installed Asset',
      },
    ])

    const fieldRes = await pool.query<{ name: string; type: string }>(
      `SELECT name, type
       FROM meta_fields
       WHERE sheet_id = $1
       ORDER BY "order" ASC, id ASC`,
      [installedAssetSheetId],
    )
    expect(fieldRes.rows).toEqual([
      { name: 'Asset Code', type: 'string' },
      { name: 'Serial No', type: 'string' },
      { name: 'Model', type: 'string' },
      { name: 'Location', type: 'string' },
      { name: 'Installed At', type: 'date' },
      { name: 'Warranty Until', type: 'date' },
      { name: 'Status', type: 'select' },
    ])

    const viewRes = await pool.query<{ id: string; name: string; type: string }>(
      'SELECT id, name, type FROM meta_views WHERE id = $1',
      [installedAssetViewId],
    )
    expect(viewRes.rows).toEqual([
      {
        id: installedAssetViewId,
        name: 'Installed Assets',
        type: 'grid',
      },
    ])
  })
})
