import { randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import { adminDirectoryRoutingPolicyRouter } from '../../src/routes/admin-directory-routing-policy'

/**
 * Canonical Org MVP — B5-c (routing-policy admin ROUTES), design lock Lock 3 + §7, real DB + HTTP.
 *
 * Pairs with the B5-a schema and B5-b resolver files: this file proves the actual admin surface —
 * platform-admin gating, the PATCH write point's validations + values-free audit, the clear path,
 * and the READ-ONLY preview (no policy row, no audit, both legs through the REAL resolver).
 *
 *   A. GET lists all 5 §6 purposes; with no rows, every purpose is 'legacy-default'.
 *   B. PATCH set: 200 + audit `directory.routing_policy.set`; GET flips to source='policy';
 *      PATCH null clears + audit `.clear`; GET back to legacy-default; clearing again → 200
 *      cleared:false with NO second audit (idempotent, audit only on real deletion).
 *   C. PATCH validations, each WITHOUT an audit row: unknown purpose 400; non-UUID 400; unlisted
 *      body field (org smuggling) 400; integration from another org 404; non-active target 409
 *      (a policy pointing at a broken target is rejected at WRITE time — B5-b would fail-close
 *      every consuming approval otherwise).
 *   D. PREVIEW (approval_routing): with NO current policy, a candidate=local preview reports the
 *      per-user diff (before = legacy latest-updated dingtalk source; after = local candidate) —
 *      and is READ-ONLY: zero policy rows written, zero audit rows.
 *   E. PREVIEW validations: unsupported purpose 400; non-UUID candidate 400; cross-org candidate
 *      404; inactive candidate 409.
 *   F. non-admin: all three routes 403 via the real RBAC path.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - remove the PATCH `status !== 'active'` check → C's 409 leg reds (broken policy accepted).
 *   - remove the preview's `overrideCanonicalIntegrationId` pass-through → D reds (after == before).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = 'default' // routes are single-tenant server-resolved; fixtures must live in 'default'
const newUserId = (suffix: string): string => `b5c-user-${STAMP}-${suffix}`

const adminApp = express()
adminApp.use(express.json())
adminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b5c-admin-${STAMP}`, role: 'admin' }
  next()
})
adminApp.use('/api/admin/directory/routing-policy', adminDirectoryRoutingPolicyRouter())

const nonAdminApp = express()
nonAdminApp.use(express.json())
nonAdminApp.use((req, _res, next) => {
  ;(req as express.Request & { user?: unknown }).user = { id: `b5c-nonadmin-${STAMP}` }
  next()
})
nonAdminApp.use('/api/admin/directory/routing-policy', adminDirectoryRoutingPolicyRouter())

const BASE = '/api/admin/directory/routing-policy'

async function auditCount(action: string, resourceId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE action = $1 AND resource_type = 'directory-routing-policy' AND resource_id = $2`,
    [action, resourceId],
  )
  return r.rows[0]?.n ?? 0
}

async function dingtalkIntegration(org: string, tag: string, status = 'active'): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [org, `DT b5c ${tag} ${STAMP}`, status, `corp-b5c-${STAMP}-${tag}`],
  )
  return r.rows[0].id
}

async function linkedAccount(integrationId: string, provider: string, userId: string, title: string): Promise<string> {
  const acc = await query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, title, is_active, raw)
     VALUES ($1, $2, $3, $3, $4, $5, true, '{}'::jsonb) RETURNING id`,
    [integrationId, provider, `${provider}:b5c:${STAMP}:${userId}:${integrationId.slice(0, 8)}`, userId, title],
  )
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
     VALUES ($1, $2, 'linked', 'manual')`,
    [acc.rows[0].id, userId],
  )
  return acc.rows[0].id
}

describeIfDatabase('Canonical Org MVP — B5-c routing-policy admin routes (real DB, HTTP)', () => {
  const cleanupAccountIds: string[] = []
  const cleanupIntegrationIds: string[] = []
  const cleanupUserIds: string[] = []
  const cleanupOrgIds: string[] = []

  afterEach(async () => {
    // the shared 'default' org's policy rows: always clear ours (purpose keyspace is tiny/shared)
    await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [orgId])
    await query(`DELETE FROM audit_logs WHERE resource_type = 'directory-routing-policy'`)
    for (const id of cleanupAccountIds.splice(0)) {
      await query(`DELETE FROM directory_accounts WHERE id = $1`, [id]) // links cascade
    }
    for (const id of cleanupIntegrationIds.splice(0)) {
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    }
    for (const org of cleanupOrgIds.splice(0)) {
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
    for (const id of cleanupUserIds.splice(0)) {
      await query(`DELETE FROM users WHERE id = $1`, [id])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A. GET lists all 5 purposes as legacy-default when no policy rows exist', async () => {
    const res = await request(adminApp).get(`${BASE}/`)
    expect(res.status).toBe(200)
    const purposes = res.body.data?.purposes ?? res.body.purposes
    expect(purposes).toHaveLength(5)
    for (const p of purposes) expect(p.source).toBe('legacy-default')
  })

  it('B. PATCH set → audit + GET shows policy; PATCH null clears (audited once, idempotent after)', async () => {
    const local = await getOrCreateLocalIntegration(orgId)
    const rid = `${orgId}:approval_routing`

    const set = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: local.id })
    expect(set.status).toBe(200)
    expect(await auditCount('directory.routing_policy.set', rid)).toBe(1)

    const listed = await request(adminApp).get(`${BASE}/`)
    const row = (listed.body.data?.purposes ?? listed.body.purposes).find((p: { purpose: string }) => p.purpose === 'approval_routing')
    expect(row.source).toBe('policy')
    expect(row.canonicalIntegrationId).toBe(local.id)
    expect(row.canonicalProvider).toBe('local')

    const clear = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: null })
    expect(clear.status).toBe(200)
    expect(clear.body.data?.cleared ?? clear.body.cleared).toBe(true)
    expect(await auditCount('directory.routing_policy.clear', rid)).toBe(1)

    const again = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: null })
    expect(again.status).toBe(200)
    expect(again.body.data?.cleared ?? again.body.cleared).toBe(false)
    expect(await auditCount('directory.routing_policy.clear', rid)).toBe(1) // no second audit
  })

  it('C. PATCH validations reject without auditing: bad purpose / non-UUID / smuggled field / cross-org / inactive target', async () => {
    const rid = `${orgId}:approval_routing`
    const bad1 = await request(adminApp).patch(`${BASE}/coffee_routing`).send({ canonicalIntegrationId: randomUUID() })
    expect(bad1.status).toBe(400)

    const bad2 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: 'not-a-uuid' })
    expect(bad2.status).toBe(400)

    const bad3 = await request(adminApp)
      .patch(`${BASE}/approval_routing`)
      .send({ canonicalIntegrationId: randomUUID(), orgId: 'evil-org' })
    expect(bad3.status).toBe(400) // unlisted field — org identity is never client-writable

    const otherOrg = `b5c-other-${STAMP}`
    cleanupOrgIds.push(otherOrg)
    const foreign = await dingtalkIntegration(otherOrg, 'xorg')
    const bad4 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: foreign })
    expect(bad4.status).toBe(404)

    const inactive = await dingtalkIntegration(orgId, 'inact', 'disabled')
    cleanupIntegrationIds.push(inactive)
    const bad5 = await request(adminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: inactive })
    expect(bad5.status).toBe(409) // broken-target policies are rejected at WRITE time

    expect(await auditCount('directory.routing_policy.set', rid)).toBe(0)
    const count = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_directory_routing_policy WHERE org_id = $1`, [orgId])
    expect(count.rows[0].n).toBe(0) // none of the rejects wrote a row
  })

  it('D. preview is a real diff AND read-only: no policy row, no audit; both legs through the real resolver', async () => {
    const user = newUserId('pv')
    cleanupUserIds.push(user)
    await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x')`, [user, `${user}@example.test`, user])
    const local = await getOrCreateLocalIntegration(orgId)
    const dt = await dingtalkIntegration(orgId, 'pv')
    cleanupIntegrationIds.push(dt)
    cleanupAccountIds.push(await linkedAccount(local.id, 'local', user, 'Local Title'))
    const dtAcc = await linkedAccount(dt, 'dingtalk', user, 'DingTalk Title')
    cleanupAccountIds.push(dtAcc)
    await query(`UPDATE directory_accounts SET updated_at = NOW() + interval '1 hour' WHERE id = $1`, [dtAcc])

    const res = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: local.id })
    expect(res.status).toBe(200)
    const body = res.body.data ?? res.body
    expect(body.current.source).toBe('legacy-default')
    const mine = body.rows.find((r: { userId: string }) => r.userId === user)
    expect(mine).toBeTruthy()
    expect(mine.before.title).toBe('DingTalk Title') // legacy latest-updated guessing
    expect(mine.after.title).toBe('Local Title') // as-if candidate were canonical
    expect(mine.changed).toBe(true)

    // READ-ONLY: zero policy rows, zero audit
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM org_directory_routing_policy WHERE org_id = $1`, [orgId])
    expect(rows.rows[0].n).toBe(0)
    const audits = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE resource_type = 'directory-routing-policy'`,
    )
    expect(audits.rows[0].n).toBe(0)
  })

  it('E. preview validations: unsupported purpose 400; non-UUID 400; cross-org 404; inactive 409', async () => {
    const e1 = await request(adminApp).get(`${BASE}/permission_scope/preview`).query({ candidate: randomUUID() })
    expect(e1.status).toBe(400)
    const e2 = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: 'nope' })
    expect(e2.status).toBe(400)
    const otherOrg = `b5c-other2-${STAMP}`
    cleanupOrgIds.push(otherOrg)
    const foreign = await dingtalkIntegration(otherOrg, 'pxorg')
    const e3 = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: foreign })
    expect(e3.status).toBe(404)
    const inactive = await dingtalkIntegration(orgId, 'pinact', 'disabled')
    cleanupIntegrationIds.push(inactive)
    const e4 = await request(adminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: inactive })
    expect(e4.status).toBe(409)
  })

  it('F. non-admin: 403 on list, set, and preview (real RBAC path)', async () => {
    const r1 = await request(nonAdminApp).get(`${BASE}/`)
    const r2 = await request(nonAdminApp).patch(`${BASE}/approval_routing`).send({ canonicalIntegrationId: randomUUID() })
    const r3 = await request(nonAdminApp).get(`${BASE}/approval_routing/preview`).query({ candidate: randomUUID() })
    expect(r1.status).toBe(403)
    expect(r2.status).toBe(403)
    expect(r3.status).toBe(403)
  })
})
