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
// are covered by tests/integration/attendance-outdoor-punch.test.ts and
// tests/integration/attendance-files-acl.test.ts — those need a real Postgres row to filter against
// and can't be faked here. This file only proves the ordering/error-handling shape.

const kyselyMocks = vi.hoisted(() => {
  const state = {
    // F3: loadFileRecord now selects the full row (owner_id + deleted_at + storage_key + url + meta +
    // created_at). An `active` row has deleted_at === null.
    ownerRows: [] as Array<Record<string, unknown>>,
    updateShouldThrow: false,
    updateError: new Error('injected tombstone UPDATE failure'),
    callOrder: [] as string[],
    // F9 design-lock GF9-3 (owner CHANGES-REQUESTED P2-2): the `${derivedKey}` value passed to the
    // atomic tombstone UPDATE's `COALESCE(storage_key, ...)`, so tests can assert it directly instead of
    // parsing the SQL text.
    tombstoneValues: [] as unknown[],
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
          kyselyMocks.state.tombstoneValues = _values
          if (kyselyMocks.state.updateShouldThrow) {
            throw kyselyMocks.state.updateError
          }
          return { rows: [] }
        }
        // F5 GF5-7: the physical-delete-confirmed stamp, written after a successful (or ENOENT)
        // storage.deleteByKey call.
        if (text.includes('UPDATE files SET blob_purged_at')) {
          kyselyMocks.state.callOrder.push('blob-purged-update')
          return { rows: [] }
        }
        if (text.includes('SELECT owner_id, deleted_at, storage_key')) {
          return { rows: kyselyMocks.state.ownerRows }
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
  // F5 GF5-7: the active-branch physical delete now goes through deleteByKey, not delete(id).
  deleteByKey: vi.fn(async (_key: string) => {
    kyselyMocks.state.callOrder.push('storage-deleteByKey')
  }),
}))

vi.mock('../../src/services/StorageService', () => ({
  StorageServiceImpl: {
    createLocalService: () => ({
      exists: storageMocks.exists,
      delete: storageMocks.delete,
      deleteByKey: storageMocks.deleteByKey,
    }),
  },
}))

const authMocks = vi.hoisted(() => ({
  user: { id: 'owner-1' } as Record<string, unknown> | undefined,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = authMocks.user as never
    next()
  },
}))

vi.mock('../../src/rbac/service', () => ({
  isAdmin: async () => false,
}))

import { Logger } from '../../src/core/logger'
import { filesRouter } from '../../src/routes/files'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()

describe('files.ts DELETE — F2 tombstone-first ordering (mocked db + storage)', () => {
  beforeEach(() => {
    kyselyMocks.state.ownerRows = [{ owner_id: 'owner-1', deleted_at: null, storage_key: 'uuid-x/photo.jpg', url: null, meta: {}, created_at: new Date() }]
    kyselyMocks.state.updateShouldThrow = false
    kyselyMocks.state.callOrder = []
    authMocks.user = { id: 'owner-1' }
    storageMocks.exists.mockClear()
    storageMocks.delete.mockClear()
    storageMocks.deleteByKey.mockClear()
    storageMocks.delete.mockImplementation(async () => {
      kyselyMocks.state.callOrder.push('storage-delete')
    })
    storageMocks.deleteByKey.mockImplementation(async (_key: string) => {
      kyselyMocks.state.callOrder.push('storage-deleteByKey')
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

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(500)
    expect(storageMocks.delete).not.toHaveBeenCalled()
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update'])
  })

  it('(b) storage.deleteByKey throws (non-ENOENT) → 200 + logger.warn(id), tombstone UPDATE already ran, blob_purged_at is NOT stamped', async () => {
    storageMocks.deleteByKey.mockImplementation(async (_key: string) => {
      kyselyMocks.state.callOrder.push('storage-deleteByKey')
      throw new Error('injected storage delete failure')
    })
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 'photo-1' })
    // ordering proof: tombstone-first, not storage-first — a reverted implementation (storage delete
    // before the UPDATE) would flip this order and would also call storage.deleteByKey unconditionally
    // even when the UPDATE was set up to fail (see test (a) above). blob_purged_at is never stamped
    // (F5 GF5-7) — the row stays a candidate for the background sweep to retry.
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update', 'storage-deleteByKey'])
    const warnCall = warnSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('photo-1'))
    expect(warnCall).toBeDefined()
  })

  it('normal path (no injected failure): tombstone UPDATE, then storage.deleteByKey(resolved storage_key), then blob_purged_at stamp, 200', async () => {
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 'photo-1' })
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update', 'storage-deleteByKey', 'blob-purged-update'])
    // F5 GF5-7 root-cause fix: deletes by the row's persisted storage_key, NOT storage.delete(id) —
    // proves the route no longer depends on the id-keyed in-memory disk-scan index.
    expect(storageMocks.deleteByKey).toHaveBeenCalledWith('uuid-x/photo.jpg')
    expect(storageMocks.delete).not.toHaveBeenCalled()
    // GF9-3: a row that already has a persisted storage_key never has anything folded into COALESCE —
    // the fallback param is null, so `COALESCE(storage_key, null)` is a no-op that preserves it.
    expect(kyselyMocks.state.tombstoneValues[0]).toBeNull()
  })

  it('GF9-3 (owner CHANGES-REQUESTED P2-2) — a NULL storage_key with a resolvable url: the url-derived key is folded into the SAME atomic tombstone UPDATE via COALESCE, resolved BEFORE tombstoning (not written back afterward)', async () => {
    kyselyMocks.state.ownerRows = [{
      owner_id: 'owner-1',
      deleted_at: null,
      storage_key: null,
      url: 'http://localhost:8900/files/legacy/photo.jpg',
      meta: {},
      created_at: new Date(),
    }]
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 'photo-1' })
    // single tombstone UPDATE call (not tombstone + a second separate writeback UPDATE) carries the
    // derived key as its COALESCE fallback value.
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update', 'storage-deleteByKey', 'blob-purged-update'])
    expect(kyselyMocks.state.tombstoneValues[0]).toBe('legacy/photo.jpg')
    // the SAME resolved key (not the stale null) is what deleteByKey is called with.
    expect(storageMocks.deleteByKey).toHaveBeenCalledWith('legacy/photo.jpg')
  })

  it('GF9-3 — NULL storage_key + resolvable url + deleteByKey fails (non-ENOENT): the tombstone UPDATE still persisted the derived key (via COALESCE) so the row is NOT stuck with storage_key=NULL for the F5 sweep', async () => {
    kyselyMocks.state.ownerRows = [{
      owner_id: 'owner-1',
      deleted_at: null,
      storage_key: null,
      url: 'http://localhost:8900/files/legacy/photo.jpg',
      meta: {},
      created_at: new Date(),
    }]
    storageMocks.deleteByKey.mockImplementation(async (_key: string) => {
      kyselyMocks.state.callOrder.push('storage-deleteByKey')
      throw new Error('injected storage delete failure')
    })
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    // the tombstone UPDATE (which already wrote the COALESCE-derived storage_key) ran BEFORE the failed
    // deleteByKey — the persisted value does not depend on deleteByKey succeeding.
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update', 'storage-deleteByKey'])
    expect(kyselyMocks.state.tombstoneValues[0]).toBe('legacy/photo.jpg')
    // blob_purged_at is never stamped on a failed delete — the row is left for the compensating sweep,
    // which can now find it because storage_key is no longer NULL.
    expect(kyselyMocks.state.callOrder).not.toContain('blob-purged-update')
  })

  it('GF5-3/GF5-7 — a POISONED storage_key skips the physical delete entirely: no deleteByKey call, no blob_purged_at stamp, still 200', async () => {
    kyselyMocks.state.ownerRows = [{ owner_id: 'owner-1', deleted_at: null, storage_key: '!f3-collision:photo-1', url: null, meta: {}, created_at: new Date() }]
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 'photo-1' })
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update'])
    expect(storageMocks.deleteByKey).not.toHaveBeenCalled()
    const warnCall = warnSpy.mock.calls.find(([msg]) => typeof msg === 'string' && msg.includes('photo-1') && msg.includes('no safe storage key'))
    expect(warnCall).toBeDefined()
    // GF9-3 ⚠ — a poisoned key is never washed via the url-fallback COALESCE: resolved is null for a
    // poison row, so the fallback param is null too (no write-back, not even the poisoned value itself).
    expect(kyselyMocks.state.tombstoneValues[0]).toBeNull()
  })

  it('GF5-7 — a NULL storage_key with no resolvable url skips the physical delete: no deleteByKey call, no blob_purged_at stamp, still 200', async () => {
    kyselyMocks.state.ownerRows = [{ owner_id: 'owner-1', deleted_at: null, storage_key: null, url: null, meta: {}, created_at: new Date() }]
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, id: 'photo-1' })
    expect(kyselyMocks.state.callOrder).toEqual(['tombstone-update'])
    expect(storageMocks.deleteByKey).not.toHaveBeenCalled()
    // GF9-3 — nothing resolvable to fold back either: fallback param stays null.
    expect(kyselyMocks.state.tombstoneValues[0]).toBeNull()
  })

  it('cross-user (non-owner, non-admin) delete request never reaches the tombstone UPDATE or storage at all — 404', async () => {
    authMocks.user = { id: 'someone-else' }
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'File not found' })
    expect(kyselyMocks.state.callOrder).toEqual([])
    expect(storageMocks.delete).not.toHaveBeenCalled()
  })

  it('no active files row (legacy/no-DB-row object) + non-admin caller → 404, no storage call', async () => {
    kyselyMocks.state.ownerRows = []
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/legacy-1')

    expect(res.status).toBe(404)
    expect(storageMocks.exists).not.toHaveBeenCalled()
    expect(storageMocks.delete).not.toHaveBeenCalled()
  })

  it('F3 G7 — a tombstoned (deleted) record is 404 even for ADMIN; never re-tombstoned, never touches storage', async () => {
    // admin via the legacy JWT role claim; the row exists but is already tombstoned (deleted_at set).
    authMocks.user = { id: 'admin-user', role: 'admin' }
    kyselyMocks.state.ownerRows = [{ owner_id: 'someone-else', deleted_at: new Date(), storage_key: 'uuid-x/photo.jpg', url: null, meta: {}, created_at: new Date() }]
    const app = buildApp()

    pinned.setApp(app)
    const res = await request(pinned.url()).delete('/api/files/photo-1')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'File not found' })
    // never reached the tombstone UPDATE or any storage call — deleted is a hard 404 at the ACL gate.
    expect(kyselyMocks.state.callOrder).toEqual([])
    expect(storageMocks.exists).not.toHaveBeenCalled()
    expect(storageMocks.delete).not.toHaveBeenCalled()
  })
})
