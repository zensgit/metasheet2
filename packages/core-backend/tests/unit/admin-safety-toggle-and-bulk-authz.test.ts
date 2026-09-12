/**
 * #5655 — admin-routes 的安全开关与 bulk 写/删必须是「平台 admin」，而不是「过了确认层」。
 *
 * 越权面（修前实读）：
 *  - `POST /api/admin/safety/enable`  (admin-routes.ts) 零中间件。
 *  - `POST /api/admin/safety/disable` 只挂 `requireSafetyCheck({ operation: RESET_METRICS })`，
 *    而 RESET_METRICS 在 SafetyGuard 的 RISK_MAP 里是 LOW，`requiresConfirmation` 只对
 *    MEDIUM/HIGH/CRITICAL 为真 —— 也就是说这条端点「一次请求、零令牌」即可通过，任何已认证的
 *    非 admin 都能把全局确认层关掉（`SafetyGuard.checkOperation`：disabled 时对一切 allowed:true）。
 *  - 关掉之后，`PUT /api/admin/data/bulk` 与 `DELETE /api/admin/data/bulk` 对任意已认证用户开放，
 *    表名白名单含 `data_sources` 等，过滤条件完全由 `req.body.filters` 给、无租户注入。
 *
 * `requireSafetyCheck`（guards/middleware.ts）内没有任何角色判断 —— 它是确认流程，不是授权门。
 * 本 spec 断言这些端点的 **第一个** 中间件是 fail-closed 的 `requireAdminRole()`：非 admin 拿到
 * 403 `ADMIN_REQUIRED`（而不是 403 `SAFETY_CHECK_REQUIRED` + 一枚可用令牌），且 kysely 的
 * `updateTable` / `deleteFrom` 一次都不会被调用。
 *
 * 对 admin 的行为必须不变：admin 打 bulk 仍是 403 `SAFETY_CHECK_REQUIRED` 并回令牌（确认层照旧）。
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// --------------------------------------------------------------------------
// Hoisted mock state
// --------------------------------------------------------------------------
const rbacState = vi.hoisted(() => ({
  isAdmin: vi.fn(async (_userId: string) => false),
}))

const dbState = vi.hoisted(() => {
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    chain.set = () => chain
    chain.where = () => chain
    chain.values = () => chain
    chain.returning = () => chain
    chain.returningAll = () => chain
    chain.selectAll = () => chain
    chain.select = () => chain
    chain.execute = async () => []
    chain.executeTakeFirst = async () => undefined
    return chain
  }
  return {
    makeChain,
    updateTable: vi.fn(() => makeChain()),
    deleteFrom: vi.fn(() => makeChain()),
  }
})

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacState.isAdmin,
}))

// No database in this lane: `pool: null` makes logSafetyOperation a no-op warn and keeps
// isAdmin's real implementation irrelevant (it is mocked above anyway).
vi.mock('../../src/db/pg', () => ({ pool: null }))

// 与 admin-snapshot-delete-authz.test.ts 同款：切断 SnapshotService → audit → AuditRepository 这条
// 在 import 期就要求真实连接池的链（`new AuditRepository(pool!)` 会直接抛 'Database pool not initialized'）。
vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))

// Spy on the two write entry points the bulk routes use; every other kysely method degrades to an
// inert chainable so that importing admin-routes (and its transitive route modules) still works.
vi.mock('../../src/db/kysely', () => {
  const db = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'updateTable') return dbState.updateTable
        if (prop === 'deleteFrom') return dbState.deleteFrom
        if (prop === 'then') return undefined
        return () => dbState.makeChain()
      },
    },
  )
  return { db, transaction: vi.fn() }
})

import { initSafetyGuard, getSafetyGuard } from '../../src/guards'
import { initAdminRoutes } from '../../src/routes/admin-routes'

const NON_ADMIN = { id: 'u-non-admin', email: 'non-admin@example.invalid' }

function buildApp(user: { id: string; email: string } = NON_ADMIN): Express {
  const app = express()
  app.use(express.json())
  // Authenticated, but NOT an admin — exactly the caller this fix is about.
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user
    next()
  })
  app.use('/api/admin', initAdminRoutes({}))
  return app
}

const BULK_UPDATE_BODY = {
  table: 'data_sources',
  updates: { name: 'pwned' },
  filters: { id: 'ds-1' },
  estimatedCount: 1,
}
const BULK_DELETE_BODY = {
  table: 'data_sources',
  filters: { id: 'ds-1' },
  estimatedCount: 1,
}

describe('#5655 admin 安全开关与 bulk 写/删的授权门', () => {
  const pinned = usePinnedServer()

  beforeEach(() => {
    vi.clearAllMocks()
    rbacState.isAdmin.mockResolvedValue(false)
    // initAdminRoutes 内部会按环境变量重建 SafetyGuard 单例；这里显式钉死 enabled:true，
    // 并且每个用例重建一次（单例会跨用例污染，尤其是 /safety/disable 那条）。
    const app = buildApp()
    initSafetyGuard({ enabled: true })
    pinned.setApp(app)
  })

  describe('非 admin', () => {
    it('POST /safety/disable → 403 ADMIN_REQUIRED，且确认层仍然开着', async () => {
      const res = await request(pinned.url()).post('/api/admin/safety/disable').send({})
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
      // 关键：确认层没有被关掉。
      expect(getSafetyGuard().isEnabled()).toBe(true)
    })

    it('POST /safety/enable → 403 ADMIN_REQUIRED', async () => {
      const res = await request(pinned.url()).post('/api/admin/safety/enable').send({})
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
    })

    it('PUT /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 updateTable 零调用', async () => {
      const res = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(res.status).toBe(403)
      // 必须是授权门先答，而不是确认层答 SAFETY_CHECK_REQUIRED（后者会回一枚可用令牌）。
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
      expect(res.body?.confirmation).toBeUndefined()
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })

    it('DELETE /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 deleteFrom 零调用', async () => {
      const res = await request(pinned.url()).delete('/api/admin/data/bulk').send(BULK_DELETE_BODY)
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
      expect(res.body?.confirmation).toBeUndefined()
      expect(dbState.deleteFrom).not.toHaveBeenCalled()
    })

    // 修前基线（整链复现）：非 admin 先 POST /safety/disable 拿到 200 把确认层关掉，
    // 随后 PUT /data/bulk 直达 `updateTable(...).set(updates)`。修后这条整链必须在第一步就断。
    it('整链：先关确认层再 bulk 写 —— 两步都被授权门挡住，updateTable 零调用', async () => {
      const disable = await request(pinned.url()).post('/api/admin/safety/disable').send({})
      expect(disable.status).toBe(403)
      expect(disable.body?.code).toBe('ADMIN_REQUIRED')
      expect(getSafetyGuard().isEnabled()).toBe(true)

      const bulk = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(bulk.status).toBe(403)
      expect(bulk.body?.code).toBe('ADMIN_REQUIRED')
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })

    // 同文件其余「只靠 requireSafetyCheck」的写/破坏性端点：一并补门。
    // 其中 RESET_METRICS 组（LOW 风险）修前连令牌都不需要，是彻底敞开的。
    const OTHER_WRITE_ENDPOINTS: Array<[string, 'post' | 'delete', string]> = [
      ['POST /cache/clear', 'post', '/api/admin/cache/clear'],
      ['POST /metrics/reset', 'post', '/api/admin/metrics/reset'],
      ['POST /dlq/:id/retry', 'post', '/api/admin/dlq/m-1/retry'],
      ['DELETE /dlq/:id', 'delete', '/api/admin/dlq/m-1'],
      ['POST /dlq/retry-all', 'post', '/api/admin/dlq/retry-all'],
      ['POST /dlq/cleanup', 'post', '/api/admin/dlq/cleanup'],
      ['POST /ratelimits/:key/reset', 'post', '/api/admin/ratelimits/tenant-a/reset'],
      ['POST /ratelimits/reset-all', 'post', '/api/admin/ratelimits/reset-all'],
    ]

    it.each(OTHER_WRITE_ENDPOINTS)('%s → 403 ADMIN_REQUIRED', async (_label, method, path) => {
      const res = await request(pinned.url())[method](path).send({})
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
    })
  })

  describe('admin —— 行为不变', () => {
    beforeEach(() => {
      rbacState.isAdmin.mockResolvedValue(true)
    })

    it('PUT /data/bulk 仍然是 403 SAFETY_CHECK_REQUIRED 并回确认令牌', async () => {
      const res = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('SAFETY_CHECK_REQUIRED')
      expect(res.body?.assessment?.riskLevel).toBe('high')
      expect(typeof res.body?.confirmation?.token).toBe('string')
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })

    it('DELETE /data/bulk 仍然是 403 SAFETY_CHECK_REQUIRED 并回确认令牌', async () => {
      const res = await request(pinned.url()).delete('/api/admin/data/bulk').send(BULK_DELETE_BODY)
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('SAFETY_CHECK_REQUIRED')
      expect(typeof res.body?.confirmation?.token).toBe('string')
      expect(dbState.deleteFrom).not.toHaveBeenCalled()
    })

    it('POST /safety/disable 对 admin 仍然放行（LOW 风险、无需确认）', async () => {
      const res = await request(pinned.url()).post('/api/admin/safety/disable').send({})
      expect(res.status).toBe(200)
      expect(res.body?.success).toBe(true)
      expect(getSafetyGuard().isEnabled()).toBe(false)
    })

    it('POST /safety/enable 对 admin 仍然放行', async () => {
      initSafetyGuard({ enabled: false })
      const res = await request(pinned.url()).post('/api/admin/safety/enable').send({})
      expect(res.status).toBe(200)
      expect(res.body?.success).toBe(true)
      expect(getSafetyGuard().isEnabled()).toBe(true)
    })
  })

  describe('fail-closed', () => {
    it('RBAC 抛错时 PUT /data/bulk 答 503 而不是放行', async () => {
      rbacState.isAdmin.mockRejectedValue(new Error('rbac down'))
      const res = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(res.status).toBe(503)
      expect(res.body?.code).toBe('RBAC_CHECK_FAILED')
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })
  })
})
