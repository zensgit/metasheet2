import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import {
  buildCommonApprovalTemplatePresetPayload,
  COMMON_APPROVAL_TEMPLATE_PRESETS,
} from '../../../../apps/web/src/approvals/commonTemplatePresets'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQUESTER = `preset-admin-${TS}`

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

describeIfDatabase('common approval template presets — real-DB backend acceptance', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let token = ''

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
    await server.start()
    const address = server.getAddress()
    if (!address) throw new Error('server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
    token = await authToken(baseUrl, REQUESTER)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const templateIds = (await pool.query(
        'SELECT id FROM approval_templates WHERE key LIKE $1',
        [`%-realdb-${TS}-%`],
      )).rows.map((row) => row.id as string)
      if (templateIds.length > 0) {
        await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
    } catch {
      // Best-effort cleanup; do not mask the test failure.
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it.each(COMMON_APPROVAL_TEMPLATE_PRESETS)(
    '$id preset posts through createTemplate and stays draft',
    async (preset) => {
      const payload = buildCommonApprovalTemplatePresetPayload(preset.id, {
        keySuffix: `realdb-${TS}-${preset.id}`,
      })

      const response = await jsonRequest(baseUrl, '/api/approval-templates', token, {
        method: 'POST',
        body: payload,
      })
      expect(response.status, await response.clone().text()).toBe(201)
      const body = await response.json() as {
        key: string
        name: string
        category: string | null
        status: string
        formSchema: { fields: Array<{ id: string; type: string }> }
        approvalGraph: { nodes: Array<{ type: string }> }
      }

      expect(body.key).toBe(payload.key)
      expect(body.name).toBe(payload.name)
      expect(body.category).toBe(payload.category)
      expect(body.status).toBe('draft')
      expect(body.formSchema.fields.length).toBe(payload.formSchema.fields.length)
      expect(body.approvalGraph.nodes.map((node) => node.type)).toEqual(
        payload.approvalGraph.nodes.map((node) => node.type),
      )
    },
  )
})
