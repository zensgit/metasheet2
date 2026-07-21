/**
 * GHSA-h8mf — the legacy destructive snapshot endpoints must carry the SAME security stack as their
 * canonical admin twins in admin-routes.ts: platform-admin + audit (protectAdminOperation) AND the
 * SafetyGuard confirmation (requireSafetyCheck).
 *
 * Being a platform admin is NOT sufficient for a destructive operation here. RESTORE_SNAPSHOT is
 * RiskLevel.CRITICAL, CLEANUP_SNAPSHOTS is HIGH, DELETE_SNAPSHOT is MEDIUM — all require a safety
 * confirmation token (x-safety-token / body._safetyToken). The route's `confirm_full` field is ordinary
 * request data used for restore-SCOPE validation; it is NOT a safety token and cannot stand in for one.
 *
 * NOTHING is mocked here except the RBAC lookup, the audit pool and the snapshot service: the SafetyGuard
 * is the REAL one, so this proves the stack is actually wired, not merely present in the source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { isAdmin } from '../../src/rbac/service'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/db/pg', () => ({ pool: null }))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/services/SnapshotService', () => ({
  RESTORABLE_ITEM_TYPES: ['view', 'view_state', 'table_row'],
  snapshotService: {
    restoreSnapshot: vi.fn().mockResolvedValue({ success: true, itemsRestored: 1, duration: 0.1 }),
    deleteSnapshot: vi.fn().mockResolvedValue(true),
    cleanupExpired: vi.fn().mockResolvedValue({ deleted: 0, freed: 0, skipped: 0 }),
    getSnapshot: vi.fn().mockResolvedValue({ id: 's1' }),
    listSnapshots: vi.fn().mockResolvedValue([]),
    createSnapshot: vi.fn().mockResolvedValue({ id: 's1' }),
    setSnapshotLock: vi.fn().mockResolvedValue(true),
    setProtectionLevel: vi.fn().mockResolvedValue(true),
    setReleaseChannel: vi.fn().mockResolvedValue(true),
    addTags: vi.fn().mockResolvedValue(true),
    removeTags: vi.fn().mockResolvedValue(true),
  },
}))

import { snapshotsRouter } from '../../src/routes/snapshots'
import { snapshotService } from '../../src/services/SnapshotService'

function buildApp(user: { id: string }): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: { id: string } }).user = user
    next()
  })
  app.use(snapshotsRouter())
  return app
}

// Every destructive legacy endpoint + a body that is otherwise completely valid, so the ONLY thing
// standing between the caller and the destructive service call is the SafetyGuard confirmation.
const DESTRUCTIVE: Array<{
  name: string
  method: 'post' | 'delete'
  path: string
  body?: unknown
  service: keyof typeof snapshotService
}> = [
  {
    name: 'restore (CRITICAL)',
    method: 'post',
    path: '/api/snapshots/s1/restore',
    body: { restore_type: 'full', confirm_full: true },
    service: 'restoreSnapshot',
  },
  { name: 'delete (MEDIUM)', method: 'delete', path: '/api/snapshots/s1', service: 'deleteSnapshot' },
  { name: 'cleanup (HIGH)', method: 'post', path: '/api/snapshots/cleanup', body: {}, service: 'cleanupExpired' },
]

const pinned = usePinnedServer()

describe('snapshots router — legacy destructive endpoints sit behind the SafetyGuard (GHSA-h8mf)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it.each(DESTRUCTIVE)(
    'platform-admin WITHOUT a safety token cannot $name — 403 SAFETY_CHECK_REQUIRED and the service is NOT called',
    async ({ method, path, body, service }) => {
      const app = buildApp({ id: 'u-admin' })
      pinned.setApp(app)
      const req = request(pinned.url())[method](path)
      const res = await (body !== undefined ? req.send(body as object) : req)

      // Admin alone is not enough: the SafetyGuard demands a confirmation token.
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('SAFETY_CHECK_REQUIRED')
      // The destructive work must not have happened.
      expect(snapshotService[service]).toHaveBeenCalledTimes(0)
    },
  )

  it('the SafetyGuard 403 hands back a confirmation token (the real second factor, not confirm_full)', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    const res = await request(pinned.url())
      .post('/api/snapshots/s1/restore')
      .send({ restore_type: 'full', confirm_full: true })
      .expect(403)

    // confirm_full:true was supplied and is irrelevant to the safety layer — a token is what is required.
    expect(res.body?.confirmation?.token).toBeTruthy()
    expect(res.body?.assessment?.riskLevel).toBeTruthy()
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledTimes(0)
  })

  it('a NON-destructive mutation (create) is not gated by the SafetyGuard — the gate is scoped, not blanket', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots').send({ view_id: 'v1', name: 'n' }).expect(201)
    expect(snapshotService.createSnapshot).toHaveBeenCalledTimes(1)
  })
})
