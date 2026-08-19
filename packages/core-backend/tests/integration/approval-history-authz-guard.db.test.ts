import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * GET /api/approvals/:id/history — guard alignment, real-DB acceptance.
 *
 * `/history` (routes/approval-history.ts) now carries the SAME guard the sibling detail route
 * (`GET /api/approvals/:id`, routes/approvals.ts) has always applied: `authenticate` followed by
 * `rbacGuard('approvals', 'read')`. Neither route adds a per-instance predicate on top of that — this
 * suite proves the shared guard is load-bearing (a principal without `approvals:read` is denied,
 * values-free, before any `approval_records` row is read) and that legitimate readers — a principal
 * holding `approvals:read`, and an admin — are unaffected, whether or not they are the instance's
 * requester.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/**
 * Mints a dev-token with EXPLICIT roles/perms claims. The suite runs under
 * `vitest.integration.config.ts`, whose `tests/setup.integration.ts` sets `RBAC_TOKEN_TRUST=true`
 * for the process — so these claims are trusted directly (AuthService.buildTrustedTokenUser) rather
 * than resolved from any `users`/`user_permissions` row, which is what lets this suite mint a
 * precisely-scoped non-privileged principal without seeding RBAC tables.
 */
async function devToken(baseUrl: string, userId: string, roles: string, perms: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

async function getHistory(baseUrl: string, id: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/approvals/${encodeURIComponent(id)}/history`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describeIfDatabase('GET /api/approvals/:id/history — guard alignment with GET /api/approvals/:id', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdInstanceIds: string[] = []

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    try {
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
    } finally {
      await server?.stop()
    }
  })

  /** Seeds a minimal instance directly (no template/workflow scaffolding needed for an authz probe)
   *  with one `approval_records` row carrying a distinctive `comment` marker, so a response body can
   *  be asserted to contain — or not contain — that exact marker. */
  async function seedInstanceWithComment(requesterId: string, marker: string): Promise<string> {
    const id = `hist-guard-${TS}-${Math.random().toString(36).slice(2, 8)}`
    await pool().query(
      `INSERT INTO approval_instances (id, status, requester_snapshot) VALUES ($1, 'approved', $2::jsonb)`,
      [id, JSON.stringify({ id: requesterId })],
    )
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, comment, to_status, to_version)
       VALUES ($1, 'comment', $2, 'Requester', $3, 'approved', 1)`,
      [id, requesterId, marker],
    )
    createdInstanceIds.push(id)
    return id
  }

  it('DISCRIMINATING NEGATIVE: denies a principal without approvals:read — values-free (no record/comment text, no instance id) in the body', async () => {
    const outsiderId = `hist-guard-outsider-${TS}`
    const requesterId = `hist-guard-req-a-${TS}`
    const marker = `MARKER-A-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    // Non-admin role, and perms EXPLICITLY empty (not omitted — an omitted `perms` query param
    // would fall back to the dev-token route's own default of '*:*'; an omitted `roles` would
    // default to 'admin'. Both are passed and neither grants approvals:read.)
    const token = await devToken(baseUrl, outsiderId, 'viewer', '')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(403)
    const bodyText = await response.text()
    expect(bodyText).not.toContain(marker)
    expect(bodyText).not.toContain(instanceId)
    expect(bodyText).not.toContain(requesterId)
    expect(JSON.parse(bodyText)).toEqual({ error: 'Insufficient permissions' })
  })

  it('POSITIVE CONTROL: the SAME shape of principal, granted approvals:read, reads the history — isolates the guard as the cause of the negative above', async () => {
    const grantedId = `hist-guard-granted-${TS}`
    const requesterId = `hist-guard-req-b-${TS}`
    const marker = `MARKER-B-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const token = await devToken(baseUrl, grantedId, 'viewer', 'approvals:read')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { items: Array<{ comment: string | null }> } }
    expect(body.data.items.some((item) => item.comment === marker)).toBe(true)
  })

  it('admin reader path still works (matches the sibling detail route\'s admin bypass)', async () => {
    const requesterId = `hist-guard-req-c-${TS}`
    const marker = `MARKER-C-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const token = await devToken(baseUrl, `hist-guard-admin-${TS}`, 'admin', '*:*')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { items: Array<{ comment: string | null }> } }
    expect(body.data.items.some((item) => item.comment === marker)).toBe(true)
  })

  it('the instance requester, holding approvals:read, still reads their own history', async () => {
    const requesterId = `hist-guard-req-d-${TS}`
    const marker = `MARKER-D-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const token = await devToken(baseUrl, requesterId, 'viewer', 'approvals:read')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { items: Array<{ comment: string | null }> } }
    expect(body.data.items.some((item) => item.comment === marker)).toBe(true)
  })

  it('requires authentication (no token) — unchanged by the guard alignment', async () => {
    const requesterId = `hist-guard-req-e-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, `MARKER-E-${TS}`)

    const response = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instanceId)}/history`)
    expect(response.status).toBe(401)
  })
})
