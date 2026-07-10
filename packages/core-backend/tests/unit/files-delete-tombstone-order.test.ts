import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// F2 files-acl-tombstone design-lock (2026-07-10): route-level, mocked-db coverage for the
// tombstone-first delete ORDERING itself — the part that can't be observed from a real-DB E2E test
// without genuinely breaking a live Postgres mid-test. Mirrors the existing mocked-`db`-module route
// test convention (see tests/unit/plm-workbench-routes.test.ts), just with `kysely`'s `sql` tag mocked
// instead of the builder chain, because files.ts's delete route uses raw `sql` template calls (matching
// the design-lock's own literal SQL), not `db.updateTable(...)`.
//
// The real-DB downstream consequences of a *successful* tombstone (G2 rejects the id, download 404s)
// are covered by tests/integration/attendance-outdoor-punch.test.ts — those need a real Postgres row to
// filter against and can't be faked here. This file only proves the ordering/error-handling shape.

const kyselyMocks = vi.hoisted(() => {
  const state = {
    hasActiveRow: true,
    updateShouldThrow: false,
    updateError: new Error('injected tombstone UPDATE failure'),
    callOrder: [] as string[],
  }
  return { state }
})

vi.mock('kysely', async (importOriginal) => {
  const actual = await importOriginal<typeof import('kysely')>()
  const sqlMock = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join(' ')
    return {
      execute: async (_executor: unknown) => {
        if (text.includes('UPDATE files SET deleted_at')) {
          kyselyMocks.state.callOrder.push('tombstone-update')
          if (kyselyMocks.state.updateShouldThrow) {
            throw kyselyMocks.state.updateError
          }
          return { rows: [] }
        }
        if (text.includes('SELECT owner_id FROM files')) {
          return { rows: kyselyMocks.state.hasActiveRow ? [{ owner_id: 'owner-1' }] : [] }
        }
        // upload's INSERT and any other raw sql call this test doesn't exercise
        return { rows: [] }
      },
    }
  }
  return { ...actual, sql: sqlMock }
})

vi.mock('../../src/db/db', () => ({ db: {} }))

const storageMocks = vi.hoisted(() => ({
  exists: vi.fn(async () => true),
  delete: vi.fn(async () => {
    kyselyMocks.state.callOrder.push('storage-delete')
  }),
}))

vi.mock('../../src/services/StorageService', () => ({
  StorageServiceImpl: {
    createLocalService: () => ({
      exists: storageMocks.exists,
      delete: storageMocks.delete,
    }),
  },
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { id: 'owner-1' } as never
    next()
  },
}))

import { Logger } from '../../src/core/logger'
import { filesRouter } from '../../src/routes/files'

describe('files.ts DELETE — F2 tombstone-first ordering (mocked db + storage)', () => {
  beforeEach(() => {
    kyselyMocks.state.hasActiveRow = true
    kyselyMocks.state.updateShouldThrow = false
    kyselyMocks.state.callOrder = []
    storageMocks.exists.mockClear()
    storageMocks.delete.mockClear()
    storageMocks.delete.mockImplementation(async () => {
      kyselyMocks.state.callOrder.push('storage-delete')
    })
  })

  function buildApp() {
    const app = express()
    app.use(express.json())
    app.use(filesRouter())
    return app
  }

  it('(a) tombstone UPDATE throws → 500, storage is never touched, no tombstone side effect observed', async () => {
    kyselyMocks.state.updateShouldThrow = true
    const app = buildApp()

    const res = await request(app).delete('/api/files/photo-1')

    expect(res.status).toBe(500)
    expect(storageMocks.delete).not.toHaveBeenCalled()
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update'])
  })

  it('(b) storage.delete throws → 200 + logger.warn(id), but the tombstone UPDATE already ran first', async () => {
    storageMocks.delete.mockImplementation(async () => {
      kyselyMocks.state.callOrder.push('storage-delete')
      throw new Error('injected storage delete failure')
    })
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')
    const app = buildApp()

    const res = await request(app).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 'photo-1' })
    // ordering proof: tombstone-first, not storage-first — a reverted implementation (storage.delete
    // before the UPDATE) would flip this order and would also call storage.delete unconditionally
    // even when the UPDATE was set up to fail (see test (a) above).
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update', 'storage-delete'])
    const warnCall = warnSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('photo-1'))
    expect(warnCall).toBeDefined()
  })

  it('normal path (no injected failure): tombstone UPDATE then storage.delete, 200', async () => {
    const app = buildApp()

    const res = await request(app).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 'photo-1' })
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update', 'storage-delete'])
  })
})
