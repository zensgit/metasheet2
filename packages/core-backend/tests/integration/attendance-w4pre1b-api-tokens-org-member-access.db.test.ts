/**
 * W4-PRE-1b item E follow-up (#4526 review, P3) — `api-tokens.ts`'s `requireOrgMemberAccess`
 * (the dual `user_orgs.is_active=true AND users.is_active=true` filter added for item E) proven
 * through the REAL endpoint (`GET /api/multitable/dingtalk-groups?orgId=...`) against a REAL
 * Postgres. The PR's own regression coverage for this exact fix
 * (`dingtalk-group-destination-routes.api.test.ts`) only asserts the literal SQL TEXT was passed
 * to a MOCKED `query` — it cannot catch a wrong JOIN condition or a swapped `AND`/`OR` that still
 * happens to contain the same substrings. This file drives the real SQL against real rows instead.
 *
 * Auth: only the session-auth middleware is stubbed (reads the caller's id from a test-only
 * header so each test can use its own NS-scoped user, matching the `multitable-oapi-token-
 * create-scope.api.test.ts` precedent) — never `isAdmin`/`role: 'admin'`, so `isAdminRequest`'s
 * platform-admin bypass in `requireOrgReadAccess` stays false and every request actually reaches
 * `requireOrgMemberAccess`'s own `user_orgs`/`users` query.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: { headers: Record<string, unknown>; user?: unknown }, _res: unknown, next: () => void) => {
    const testUserId = req.headers['x-test-user-id']
    req.user = { id: typeof testUserId === 'string' ? testUserId : '' }
    next()
  }
  return { authenticate, authMiddleware: authenticate, default: authenticate }
})

import { apiTokensRouter } from '../../src/routes/api-tokens'
import { query } from '../../src/db/pg'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const NS = `w4pre1boma${TS}`
const ORG = `${NS}-org`

describeIfDatabase('W4-PRE-1b item E — api-tokens.ts requireOrgMemberAccess dual is_active filter (real DB, real endpoint)', () => {
  let app: Express
  const userIds: string[] = []

  async function seedUser(tag: string, isActive: boolean): Promise<string> {
    const id = `${NS}-u-${tag}`
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $3, 'Fixture', 'x', 'user', '[]'::jsonb, $4, false, NOW(), NOW())`,
      [id, `${id}@example.test`, id, isActive],
    )
    userIds.push(id)
    return id
  }

  async function seedMembership(userId: string, isActive: boolean): Promise<void> {
    await query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)`,
      [userId, ORG, isActive],
    )
  }

  beforeAll(() => {
    app = express()
    app.use(express.json())
    app.use(apiTokensRouter())
  })

  afterAll(async () => {
    if (userIds.length) {
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [userIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
    }
  })

  it('active user_orgs + active user → passes the gate (200, not 403)', async () => {
    const userId = await seedUser('active', true)
    await seedMembership(userId, true)

    const res = await request(app)
      .get('/api/multitable/dingtalk-groups')
      .query({ orgId: ORG })
      .set('x-test-user-id', userId)

    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
  })

  it('active user_orgs + DEACTIVATED user (users.is_active=false) → 403 FORBIDDEN — the exact item-E defect', async () => {
    const userId = await seedUser('deactivated', false)
    await seedMembership(userId, true)

    const res = await request(app)
      .get('/api/multitable/dingtalk-groups')
      .query({ orgId: ORG })
      .set('x-test-user-id', userId)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('DEACTIVATED user_orgs (is_active=false) + active user → 403 FORBIDDEN — pre-existing leg, still correct', async () => {
    const userId = await seedUser('unbound', true)
    await seedMembership(userId, false)

    const res = await request(app)
      .get('/api/multitable/dingtalk-groups')
      .query({ orgId: ORG })
      .set('x-test-user-id', userId)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('no user_orgs row at all → 403 FORBIDDEN', async () => {
    const userId = await seedUser('nomembership', true)

    const res = await request(app)
      .get('/api/multitable/dingtalk-groups')
      .query({ orgId: ORG })
      .set('x-test-user-id', userId)

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
