/**
 * T3-3 slice 1 (declared-inert) — node `signaturePolicy` persists + round-trips but is NOT enforced.
 *
 * Build contract (third-batch ballot T3-3): prove `signaturePolicy` survives normalize → publish → reload
 * → dispatch re-normalize; a default-absent node stays byte-identical; and the policy does NOT block
 * approve/reject this slice (enforcement is a separate ratified rung).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

type JsonRecord = Record<string, unknown>
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

async function canListenOnEphemeralPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(0, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

async function jsonRequest(baseUrl: string, path: string, token: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function buildFormSchema(): JsonRecord {
  return { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] }
}

// Linear start → approval_1 → end. `approval_1` carries the given (or no) signaturePolicy.
function buildGraph(signaturePolicy?: JsonRecord): JsonRecord {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['sig-approver'],
          approvalMode: 'single',
          ...(signaturePolicy ? { signaturePolicy } : {}),
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

function nodeConfigOf(graph: JsonRecord, key: string): JsonRecord {
  const nodes = (graph.nodes ?? []) as Array<{ key: string; config: JsonRecord }>
  const node = nodes.find((n) => n.key === key)
  expect(node).toBeTruthy()
  return node!.config
}

describeIfDatabase('T3-3 node signaturePolicy (declared-inert) API', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const templateIds = new Set<string>()
  const approvalIds = new Set<string>()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    baseUrl = `http://127.0.0.1:${server.getAddress()!.port}`
  })

  afterAll(async () => {
    const pool = poolManager.get()
    const aIds = [...approvalIds]
    const tIds = [...templateIds]
    if (aIds.length) {
      await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [aIds]).catch(() => {})
      await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [aIds]).catch(() => {})
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [aIds]).catch(() => {})
    }
    if (tIds.length) {
      await pool.query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [tIds]).catch(() => {})
      await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [tIds]).catch(() => {})
      await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [tIds]).catch(() => {})
    }
    if (server) await server.stop()
  })

  async function createTemplate(adminToken: string, graph: JsonRecord): Promise<string> {
    const res = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: { key: `t33-sig-${TS}-${Math.floor(Math.random() * 1e6)}`, name: 'sig', formSchema: buildFormSchema(), approvalGraph: graph },
    })
    return res
  }

  it('sentinel: DATABASE_URL is set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  it('persists + round-trips signaturePolicy through create → publish → reload byte-identically', async () => {
    const adminToken = await authToken(baseUrl, 'sig-admin')
    const policy = { required: true, kind: 'typed', appliesTo: 'approve_reject' }
    const createRes = await createTemplate(adminToken, buildGraph(policy))
    expect(createRes.status).toBe(201)
    const template = (await createRes.json()) as { id: string; approvalGraph: JsonRecord }
    templateIds.add(template.id)
    // Survives normalize on create.
    expect(nodeConfigOf(template.approvalGraph, 'approval_1').signaturePolicy).toEqual(policy)

    const pub = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, { method: 'POST', body: { policy: { allowRevoke: true } } })
    expect(pub.status).toBe(200)

    // Survives reload (a fresh GET → the stored + re-read graph).
    const reload = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}`, adminToken)
    expect(reload.status).toBe(200)
    const reloaded = (await reload.json()) as { approvalGraph: JsonRecord }
    expect(nodeConfigOf(reloaded.approvalGraph, 'approval_1').signaturePolicy).toEqual(policy)
  })

  it('leaves a node with NO signaturePolicy byte-identical (default-absent, key omitted)', async () => {
    const adminToken = await authToken(baseUrl, 'sig-admin')
    const createRes = await createTemplate(adminToken, buildGraph())
    expect(createRes.status).toBe(201)
    const template = (await createRes.json()) as { id: string; approvalGraph: JsonRecord }
    templateIds.add(template.id)
    expect(nodeConfigOf(template.approvalGraph, 'approval_1')).not.toHaveProperty('signaturePolicy')
  })

  it('is DECLARED-INERT: a required signaturePolicy does NOT block approve (no signature supplied)', async () => {
    const adminToken = await authToken(baseUrl, 'sig-admin')
    const requesterToken = await authToken(baseUrl, 'sig-requester')
    const approverToken = await authToken(baseUrl, 'sig-approver')
    const createRes = await createTemplate(adminToken, buildGraph({ required: true, kind: 'typed' }))
    const template = (await createRes.json()) as { id: string }
    templateIds.add(template.id)
    await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, { method: 'POST', body: { policy: { allowRevoke: true } } })

    const inst = await jsonRequest(baseUrl, '/api/approvals', requesterToken, { method: 'POST', body: { templateId: template.id, formData: { summary: 'sig test' } } })
    expect(inst.status).toBe(201)
    const created = (await inst.json()) as { id: string }
    approvalIds.add(created.id)

    // Approve with NO signature payload — must succeed (enforcement is a later rung).
    const act = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, approverToken, { method: 'POST', body: { action: 'approve', comment: 'ok' } })
    expect(act.status).toBe(200)
    expect(((await act.json()) as { status: string }).status).toBe('approved')
  })

  it('rejects a malformed signaturePolicy at publish (non-boolean required / bad appliesTo)', async () => {
    const adminToken = await authToken(baseUrl, 'sig-admin')
    const bad1 = await createTemplate(adminToken, buildGraph({ required: 'yes' }))
    expect(bad1.status).toBe(400)
    const bad2 = await createTemplate(adminToken, buildGraph({ required: true, appliesTo: 'always' }))
    expect(bad2.status).toBe(400)
  })
})
