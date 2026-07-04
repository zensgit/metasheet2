import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * Delegation (委托) SELF-SERVICE — real-DB API. Exercises the participant-gated
 * /api/approval-delegations/mine routes (approvals:read floor) against real Postgres.
 *
 * The two NEW boundaries this slice introduces (design-lock §3):
 *   1. create-own FORCES delegator = actor (never reads body.delegatorUserId), and
 *   2. disable-own on ANOTHER's row is 403 (not 404) — the SELECT-then-check discriminator.
 *
 * A regular approval participant (non-admin, holds only approvals:read) can manage
 * their OWN delegation and see their own history, but can never touch someone else's.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const ACTOR = `del-self-actor-${TS}`
const OTHER = `del-self-other-${TS}`
const DELEGATEE = `del-self-to-${TS}`
const NOPERM = `del-self-noperm-${TS}`
const ADMIN = `del-self-admin-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tok(base: string, userId: string, roles: string, perms: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
  return ((await res.json()) as { token: string }).token
}
async function req(base: string, path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

const WINDOW = { startAt: new Date(Date.now() - 3600_000).toISOString(), endAt: new Date(Date.now() + 3600_000).toISOString() }

describeIfDatabase('delegation (委托) self-service — real-DB API', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let actorTok = ''
  let adminTok = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const seedPool = poolManager.get()
    // ACTOR: a non-admin participant whose only grant is approvals:read (legacy
    // users.permissions path — approvals is a NON-namespaced resource so no admission
    // row is needed). This proves the participant floor admits a self-service user.
    await seedPool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '["approvals:read"]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = '["approvals:read"]'::jsonb, is_admin = FALSE, is_active = TRUE`,
      [ACTOR, `${ACTOR}@example.test`],
    )
    // NOPERM: a non-admin with an UNRELATED grant — must be rejected by the floor.
    await seedPool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '["multitable:read"]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = '["multitable:read"]'::jsonb, is_admin = FALSE, is_active = TRUE`,
      [NOPERM, `${NOPERM}@example.test`],
    )
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    actorTok = await tok(base, ACTOR, 'user', 'approvals:read')
    adminTok = await tok(base, ADMIN, 'admin', '*:*')
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      await pool.query(`DELETE FROM approval_delegations WHERE delegator_user_id LIKE $1`, [`%-${TS}`])
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[ACTOR, NOPERM]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // Floor: a non-admin WITHOUT approvals:read is rejected; a participant is admitted.
  it('gates /mine on the approvals:read participant floor', async () => {
    const noPermTok = await tok(base, NOPERM, 'user', 'multitable:read')
    expect((await req(base, '/api/approval-delegations/mine', noPermTok)).status).toBe(403)
    expect((await req(base, '/api/approval-delegations/mine', actorTok)).status).toBe(200)
  })

  // Boundary 1 — create FORCES delegator = actor (body.delegatorUserId is ignored).
  it('creates own delegation with delegator forced to the actor (ignores body.delegatorUserId)', async () => {
    const created = await req(base, '/api/approval-delegations/mine', actorTok, {
      method: 'POST',
      body: { delegatorUserId: OTHER, delegateeUserId: DELEGATEE, scope: 'all', ...WINDOW },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const rec = ((await created.json()) as { data: { id: string; delegatorUserId: string; delegateeUserId: string } }).data
    expect(rec.delegatorUserId).toBe(ACTOR)
    expect(rec.delegatorUserId).not.toBe(OTHER)
    expect(rec.delegateeUserId).toBe(DELEGATEE)

    // list own — the row is present and active
    const listed = await req(base, '/api/approval-delegations/mine', actorTok)
    const rows = ((await listed.json()) as { data: Array<{ id: string; delegatorUserId: string; active: boolean }> }).data
    expect(rows.every((r) => r.delegatorUserId === ACTOR)).toBe(true)
    expect(rows.find((r) => r.id === rec.id)).toMatchObject({ active: true })

    // disable own → 200; then it stays visible as history (active:false)
    expect((await req(base, `/api/approval-delegations/mine/${rec.id}`, actorTok, { method: 'DELETE' })).status).toBe(200)
    const afterList = await req(base, '/api/approval-delegations/mine', actorTok)
    const afterRows = ((await afterList.json()) as { data: Array<{ id: string; active: boolean }> }).data
    expect(afterRows.find((r) => r.id === rec.id)).toMatchObject({ active: false })
  })

  // Boundary 2 — disable another's delegation is 403 (NOT 404); it also never appears in own list.
  it('rejects disabling ANOTHER user delegation with 403 (not 404)', async () => {
    // seed OTHER's delegation via the admin route (delegator = OTHER)
    const seeded = await req(base, '/api/approval-delegations', adminTok, {
      method: 'POST',
      body: { delegatorUserId: OTHER, delegateeUserId: DELEGATEE, scope: 'all', ...WINDOW },
    })
    expect(seeded.status, await seeded.clone().text()).toBe(201)
    const otherId = ((await seeded.json()) as { data: { id: string } }).data.id

    // ACTOR cannot see OTHER's row in their own list
    const ownList = await req(base, '/api/approval-delegations/mine', actorTok)
    const ownRows = ((await ownList.json()) as { data: Array<{ id: string }> }).data
    expect(ownRows.find((r) => r.id === otherId)).toBeUndefined()

    // ACTOR disabling OTHER's row → 403 (found-but-not-owner), never a masking 404
    expect((await req(base, `/api/approval-delegations/mine/${otherId}`, actorTok, { method: 'DELETE' })).status).toBe(403)

    // OTHER's row is untouched (still active) — the 403 did not soft-delete it
    const stillActive = (
      await poolManager.get().query<{ active: boolean }>(`SELECT active FROM approval_delegations WHERE id = $1`, [otherId])
    ).rows[0]
    expect(stillActive?.active).toBe(true)
  })

  // Unknown id → 404 (distinct from the 403 above).
  it('returns 404 disabling a non-existent delegation', async () => {
    expect(
      (await req(base, `/api/approval-delegations/mine/00000000-0000-0000-0000-000000000000`, actorTok, { method: 'DELETE' })).status,
    ).toBe(404)
  })
})
