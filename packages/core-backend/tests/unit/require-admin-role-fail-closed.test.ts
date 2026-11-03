/**
 * W5-D — requireAdminRole() fail-closed pins.
 *
 * The gate (`src/guards/audit-integration.ts:requireAdminRole`) awaits the REAL
 * `isAdmin()` from `src/rbac/service.ts` on every request — no user.id => 403
 * (:121-145); isAdmin() resolves false => 403 ADMIN_REQUIRED (:150-177);
 * isAdmin() throws => 503 RBAC_CHECK_FAILED (:187-196).
 *
 * This spec does NOT mock `isAdmin` itself (unlike admin-safety-confirm-authz.test.ts
 * / admin-snapshot-delete-authz.test.ts, which stub the whole function). It mocks only
 * the layer isAdmin sits on — `pool`/`query` from `../db/pg` — so the real isAdmin
 * branch logic in rbac/service.ts actually executes, and pins what it *really* returns
 * for the three "can't resolve a role" shapes named in the task:
 *   ① user exists but `user_roles` has no matching row  -> rows.length === 0
 *   ② pool is null / unavailable                        -> early-return guard
 *   ③ RBAC_OPTIONAL=1 and the role table is missing      -> degraded catch branch
 *
 * Real isAdmin (src/rbac/service.ts:19-34):
 *   export async function isAdmin(userId, runQuery = query) {
 *     if (runQuery === query && !pool) return false                 // ② :20
 *     try {
 *       const { rows } = await runQuery('SELECT 1 FROM user_roles...') // ① :22-23
 *       return rows.length > 0
 *     } catch (error) {
 *       if (isDatabaseSchemaError(error) && allowDegradation) {       // ③ :25-31
 *         return false
 *       }
 *       throw error                                                   // -> guard's 503
 *     }
 *   }
 * `allowDegradation` (service.ts:17) is `process.env.RBAC_OPTIONAL === '1'` captured
 * ONCE at module load, so scenario ③ needs a fresh module instance loaded AFTER the
 * env var is set (vi.resetModules() + dynamic import), not the file's static import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'

// ---------------------------------------------------------------------------
// Mock only `../../src/db/pg` (one layer below isAdmin), never `../../src/rbac/service`.
// `dbState` is mutated per-test; the mock factory reads it live on every property
// access so tests don't need vi.resetModules() except for the RBAC_OPTIONAL case.
// ---------------------------------------------------------------------------
const dbState: {
  pool: unknown
  query: ReturnType<typeof vi.fn>
} = {
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  query: vi.fn(),
}

vi.mock('../../src/db/pg', () => ({
  get pool() {
    return dbState.pool
  },
  query: (...args: unknown[]) => dbState.query(...args),
}))

import { requireAdminRole } from '../../src/guards/audit-integration'

function buildApp(user: { id?: string; email?: string } | undefined, guard: () => RequestHandler = requireAdminRole) {
  const handlerCalled = vi.fn()
  const app = express()
  app.get(
    '/protected',
    (req, _res, next) => {
      ;(req as unknown as { user?: typeof user }).user = user
      next()
    },
    guard(),
    (_req, res) => {
      handlerCalled()
      res.status(200).json({ ok: true })
    }
  )
  return { app, handlerCalled }
}

function schemaMissingError(): Error & { code: string } {
  return Object.assign(new Error('relation "user_roles" does not exist'), { code: '42P01' })
}

// #4154 tripwire (tests/unit/supertest-app-mode-tripwire.test.ts): supertest must never receive an
// express app directly (`request(app)` binds a fresh ephemeral-port listener per request, the
// cross-talk mechanism). One pinned server for the whole suite; each test swaps the installed app.
const pinned = usePinnedServer()

describe('requireAdminRole() — fail-closed pins (real isAdmin, mocked at pool/query layer)', () => {
  const ADMIN_USER = { id: 'u-admin', email: 'admin@example.com' }

  beforeEach(() => {
    dbState.pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    dbState.query = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ---------------------------------------------------------------------
  // ① user exists but user_roles has no matching row
  // ---------------------------------------------------------------------
  it('① user_roles has no admin row -> 403 ADMIN_REQUIRED, handler not called (audit-integration.ts:150-177 via rbac/service.ts:22-23 rows.length===0)', async () => {
    dbState.query.mockResolvedValueOnce({ rows: [] })
    const { app, handlerCalled } = buildApp(ADMIN_USER)
    pinned.setApp(app)

    const res = await request(pinned.url()).get('/protected')

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' })
    expect(handlerCalled).not.toHaveBeenCalled()
    expect(dbState.query).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------
  // ② pool is null / unavailable
  // ---------------------------------------------------------------------
  it('② pool is null -> 403 ADMIN_REQUIRED, handler not called, query never reached (rbac/service.ts:20 early-return guard)', async () => {
    dbState.pool = null
    const { app, handlerCalled } = buildApp(ADMIN_USER)
    pinned.setApp(app)

    const res = await request(pinned.url()).get('/protected')

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' })
    expect(handlerCalled).not.toHaveBeenCalled()
    expect(dbState.query).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // ③ RBAC_OPTIONAL=1 and user_roles table is missing (degraded)
  // ---------------------------------------------------------------------
  it('③ RBAC_OPTIONAL=1 + missing user_roles table -> 403 ADMIN_REQUIRED, handler not called (rbac/service.ts:25-31 degraded catch)', async () => {
    const prevOptional = process.env.RBAC_OPTIONAL
    process.env.RBAC_OPTIONAL = '1'
    dbState.pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    dbState.query.mockRejectedValueOnce(schemaMissingError())

    vi.resetModules()
    try {
      const { requireAdminRole: freshRequireAdminRole } = await import('../../src/guards/audit-integration')
      const { app, handlerCalled } = buildApp(ADMIN_USER, freshRequireAdminRole)
      pinned.setApp(app)

      const res = await request(pinned.url()).get('/protected')

      expect(res.status).toBe(403)
      expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' })
      expect(handlerCalled).not.toHaveBeenCalled()
    } finally {
      process.env.RBAC_OPTIONAL = prevOptional
      vi.resetModules()
    }
  })

  // ---------------------------------------------------------------------
  // Positive control: user_roles has an admin row -> 200, handler called
  // ---------------------------------------------------------------------
  it('positive control: user_roles has an admin row -> 200, handler called (rbac/service.ts:22-23 rows.length>0 -> audit-integration.ts:180-186)', async () => {
    dbState.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
    const { app, handlerCalled } = buildApp(ADMIN_USER)
    pinned.setApp(app)

    const res = await request(pinned.url()).get('/protected')

    expect(res.status).toBe(200)
    expect(handlerCalled).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------
  // isAdmin throws a non-schema error (not degraded) -> propagates -> 503
  // ---------------------------------------------------------------------
  it('query throws a non-schema error -> 503 RBAC_CHECK_FAILED, handler not called (rbac/service.ts:32 rethrow -> audit-integration.ts:187-196)', async () => {
    dbState.query.mockRejectedValueOnce(new Error('connection terminated unexpectedly'))
    const { app, handlerCalled } = buildApp(ADMIN_USER)
    pinned.setApp(app)

    const res = await request(pinned.url()).get('/protected')

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: 'RBAC_CHECK_FAILED' })
    expect(handlerCalled).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // Existing branch (not part of the three isAdmin shapes, but guarded by
  // the same function): no req.user at all -> 403 before isAdmin is ever called.
  // ---------------------------------------------------------------------
  it('no req.user -> 403 ADMIN_REQUIRED without calling isAdmin/query (audit-integration.ts:121-145)', async () => {
    const { app, handlerCalled } = buildApp(undefined)
    pinned.setApp(app)

    const res = await request(pinned.url()).get('/protected')

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'ADMIN_REQUIRED' })
    expect(handlerCalled).not.toHaveBeenCalled()
    expect(dbState.query).not.toHaveBeenCalled()
  })
})
