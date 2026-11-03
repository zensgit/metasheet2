import fs from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import {
  createDataSourcePluginFacade,
  createDataSourceSealedSnapshotConnectionFacade,
  createDataSourceWritePluginFacade,
  DATA_SOURCE_REFUSAL_REASON_KEY,
  DATA_SOURCE_REFUSAL_REASONS,
  DATA_SOURCE_NOT_FOUND_CODE,
  DATA_SOURCE_NOT_READ_ONLY_CODE,
  DATA_SOURCE_NOT_C6_WRITE_TARGET_CODE,
  DATA_SOURCE_NOT_WRITABLE_CODE,
  DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
  DATA_SOURCE_QUERY_INVALID_CODE,
  DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE,
  DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE,
  DataSourceUnavailableError,
  MISSING_PRINCIPAL_MESSAGE,
  requestTimeoutDisabledMessage,
  writeTargetNotC6Message,
  writeTargetReadOnlyMessage,
  writableSourceMessage,
} from '../../src/data-adapters/data-source-plugin-facade'
import type { DataSourceManager } from '../../src/data-adapters/DataSourceManager'

interface AdapterStubOptions {
  connected?: boolean
  healthy?: boolean
  readOnly?: boolean
  c6WriteTarget?: boolean
  genericQueryDisabled?: boolean
  // W-5: lets a test build a sqlserver-typed stub with an arbitrary connection posture (e.g.
  // requestTimeoutMs) without disturbing every OTHER test's postgres default.
  type?: string
  connection?: Record<string, unknown>
  credentials?: Record<string, unknown>
  // 对接总览: the display descriptor reads getName()/getType(), so a test can give the stub a name
  // distinct from its id and prove the descriptor reports the adapter's own, not the requested id.
  name?: string
}

function adapterStub(opts: AdapterStubOptions = {}) {
  return {
    isConnected: () => opts.connected ?? true,
    testConnection: vi.fn(async () => opts.healthy ?? true),
    isReadOnly: () => opts.readOnly ?? true,
    getName: () => opts.name ?? 'pg',
    getType: () => opts.type ?? 'postgres',
    getConfig: vi.fn(() => ({
      id: 'pg',
      name: 'pg',
      type: opts.type ?? 'postgres',
      connection: opts.connection ?? {},
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      options: {
        ...(opts.readOnly === undefined ? {} : { readOnly: opts.readOnly }),
        ...(opts.c6WriteTarget === undefined ? {} : { c6WriteTarget: opts.c6WriteTarget }),
        ...(opts.genericQueryDisabled === undefined ? {} : { genericQueryDisabled: opts.genericQueryDisabled }),
      },
    })),
    getSchema: vi.fn(async (_schema?: string) => ({ tables: [], views: [] })),
    getTableInfo: vi.fn(async (table: string, _schema?: string) => ({ name: table, columns: [] })),
  }
}

interface ManagerStubOptions {
  adapter?: ReturnType<typeof adapterStub>
  deny?: boolean
  scope?: {
    ownerId: string
    workspaceId: string | null
    tenantId: string | null
    scopeKind: 'legacy_private' | 'private' | 'workspace'
  }
  // Refusal reasons (#6067 §5 R1). The load-state accessor exists on the stub ONLY when a case asks
  // for it, so every case written before it keeps running against a manager that has none — which
  // is exactly the shape the facade must tolerate.
  loadState?: unknown
  loadStateThrows?: Error
  scopeMissing?: boolean
  getDataSourceThrows?: boolean
}

function managerStub(opts: ManagerStubOptions = {}) {
  const adapter = opts.adapter ?? adapterStub()
  const withLoadState = 'loadState' in opts || opts.loadStateThrows !== undefined
  const getLoadState = vi.fn((_id: string) => {
    if (opts.loadStateThrows) throw opts.loadStateThrows
    return opts.loadState
  })
  const stub = {
    ...(withLoadState ? { getLoadState } : {}),
    // Mirror DataSourceManager's uniform not-found wording verbatim — the wrapper must re-raise it
    // unchanged (no existence leak), so the test asserts against the real message shape.
    assertAccess: vi.fn((id: string, _owner: string | undefined) => {
      if (opts.deny) throw new Error(`Data source with id '${id}' not found`)
    }),
    getScope: vi.fn(() => (opts.scopeMissing ? undefined : opts.scope ?? {
      ownerId: 'owner-1',
      workspaceId: null,
      tenantId: 'tenant-1',
      scopeKind: 'private',
    })),
    getDataSource: vi.fn((id: string) => {
      if (opts.getDataSourceThrows) throw new Error(`Data source with id '${id}' not found`)
      return adapter
    }),
    connectDataSource: vi.fn(async () => undefined),
    select: vi.fn(async () => ({ data: [{ id: 1 }], metadata: {} })),
    insert: vi.fn(async (_id: string, _table: string, rows: unknown[]) => ({ data: rows, metadata: {} })),
    update: vi.fn(async (_id: string, _table: string, data: unknown, where: unknown) => ({ data: [{ data, where }], metadata: {} })),
  }
  return { stub, adapter, getLoadState, manager: stub as unknown as DataSourceManager }
}

describe('createDataSourcePluginFacade', () => {
  it('is read-only by construction — exposes only read methods plus the bind probe and the display descriptor, no write/credential surface', () => {
    const facade = createDataSourcePluginFacade(() => managerStub().manager)
    // `assertReferenceable` (P2-A bind probe, #5401) and `describe` (对接总览 display descriptor)
    // both joined this list. Both belong to the read-only class: no mutation, no credentials,
    // principal-gated — see their own describe blocks below.
    expect(Object.keys(facade).sort()).toEqual([
      'assertReferenceable', 'describe', 'getSchema', 'getTableInfo', 'resolveConnectionRegistration', 'select', 'test',
    ])
    const surface = facade as unknown as Record<string, unknown>
    for (const forbidden of [
      'insert', 'update', 'delete', 'create', 'remove', 'rotate', 'connect', 'disconnect',
      'credentials', 'query', 'addDataSource', 'updateDataSource', 'removeDataSource',
    ]) {
      expect(surface).not.toHaveProperty(forbidden)
    }
  })

  describe('resolveConnectionRegistration (canonical values-free registration)', () => {
    it('returns only id/type/tenantId/scopeKind and never connects or reads config', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connected: false }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      const result = await facade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-1',
        principal: 'owner-1',
      })
      expect(result).toEqual({ id: 'pg', type: 'sqlserver', tenantId: 'tenant-1', scopeKind: 'private' })
      expect(Object.keys(result).sort()).toEqual(['id', 'scopeKind', 'tenantId', 'type'])
      expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
      expect(m.stub.connectDataSource).not.toHaveBeenCalled()
      expect(m.adapter.getConfig).not.toHaveBeenCalled()
    })

    it('requires exact tenant and owner-only access, with no admin-shaped bypass', async () => {
      const denied = managerStub({ deny: true })
      const facade = createDataSourcePluginFacade(() => denied.manager)
      await expect(facade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-1', principal: 'stranger',
      })).rejects.toBeInstanceOf(DataSourceUnavailableError)

      const mismatched = managerStub()
      const mismatchFacade = createDataSourcePluginFacade(() => mismatched.manager)
      await expect(mismatchFacade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-2', principal: 'owner-1',
      })).rejects.toBeInstanceOf(DataSourceUnavailableError)
      expect(mismatched.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    })

    it('permits tenantless legacy_private only for user/owner runs and rejects service runs', async () => {
      const m = managerStub({ scope: {
        ownerId: 'owner-1', workspaceId: null, tenantId: null, scopeKind: 'legacy_private',
      } })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-1', workspaceId: 'workspace-a', principal: 'owner-1', runAs: 'owner',
      })).resolves.toEqual({ id: 'pg', type: 'postgres', tenantId: null, scopeKind: 'legacy_private' })
      await expect(facade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-1', principal: 'owner-1', runAs: 'service',
      })).rejects.toBeInstanceOf(DataSourceUnavailableError)
      await expect(facade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-1', principal: 'owner-1',
      })).rejects.toBeInstanceOf(DataSourceUnavailableError)
    })

    it('treats workspaceId as binding context, not a PR-1 sharing grant', async () => {
      const m = managerStub()
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-1', workspaceId: 'workspace-a', principal: 'owner-1', runAs: 'service',
      })).resolves.toEqual({ id: 'pg', type: 'postgres', tenantId: 'tenant-1', scopeKind: 'private' })
      expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    })

    it('fails closed when the principal or tenant is missing', async () => {
      const getManager = vi.fn(() => managerStub().manager)
      const facade = createDataSourcePluginFacade(getManager)
      await expect(facade.resolveConnectionRegistration('pg', {
        tenantId: 'tenant-1', principal: undefined,
      })).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
      await expect(facade.resolveConnectionRegistration('pg', {
        tenantId: '  ', principal: 'owner-1',
      })).rejects.toBeInstanceOf(DataSourceUnavailableError)
      expect(getManager).not.toHaveBeenCalled()
    })
  })

  describe('describe (对接总览 display descriptor)', () => {
    it('returns EXACTLY {id,name,type,status} — no connection detail can ride along', async () => {
      const m = managerStub({ adapter: adapterStub({ name: 'PLM 只读库', type: 'sqlserver', connected: true }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      const descriptor = await facade.describe('ds_plm', 'owner-1')
      expect(descriptor).toEqual({ id: 'ds_plm', name: 'PLM 只读库', type: 'sqlserver', status: 'connected' })
      // Values-free: the ONLY object in this layer carrying connection/credentials is getConfig(),
      // and the descriptor must never have gone near it.
      expect(Object.keys(descriptor).sort()).toEqual(['id', 'name', 'status', 'type'])
      expect(JSON.stringify(descriptor)).not.toContain('connection')
    })

    it('reports the LIVE connection state, not the stored column', async () => {
      const m = managerStub({ adapter: adapterStub({ connected: false }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.describe('pg', 'owner-1')).resolves.toMatchObject({ status: 'disconnected' })
    })

    it('never opens a connection (a summary screen must not dial every database it lists)', async () => {
      const m = managerStub({ adapter: adapterStub({ connected: false }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await facade.describe('pg', 'owner-1')
      expect(m.stub.connectDataSource).not.toHaveBeenCalled()
      expect(m.adapter.testConnection).not.toHaveBeenCalled()
    })

    it('is OWNER-ONLY under the #5401 model — passes the BARE principal to assertAccess (no admin bypass)', async () => {
      // Load-bearing after #5401: assertAccess now takes a DataSourceActor, and a bare string is the
      // data-plane (owner-only) shape. describe must call it with the bare principal, NOT an
      // { platformAdmin } context — otherwise the hub would leak a non-admin a connection name they
      // could not see on /data-sources. Pin the exact call shape.
      const m = managerStub({ adapter: adapterStub({ name: 'PLM 只读库' }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await facade.describe('ds_plm', 'owner-1')
      expect(m.stub.assertAccess).toHaveBeenCalledWith('ds_plm', 'owner-1')
      // A bare string, never a management-actor context — no platformAdmin side channel.
      const [, actorArg] = m.stub.assertAccess.mock.calls[0]
      expect(typeof actorArg).toBe('string')
    })

    it('is principal-gated and fails closed with the uniform not-found wording (no existence leak)', async () => {
      const denied = managerStub({ deny: true })
      const facade = createDataSourcePluginFacade(() => denied.manager)
      await expect(facade.describe('someone-elses', 'owner-1')).rejects.toMatchObject({
        status: 422,
        code: DATA_SOURCE_NOT_FOUND_CODE,
        message: "Data source with id 'someone-elses' not found",
      })
      const getManager = vi.fn(() => managerStub().manager)
      const strict = createDataSourcePluginFacade(getManager)
      await expect(strict.describe('pg', undefined)).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
      // No fallback identity: a missing principal short-circuits before the manager is resolved.
      expect(getManager).not.toHaveBeenCalled()
    })

    it('describes a WRITABLE source too — the read-only guard is deliberately not applied here', async () => {
      const m = managerStub({ adapter: adapterStub({ readOnly: false, name: 'K3 写入库', type: 'sqlserver' }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.describe('ds_write', 'owner-1')).resolves.toMatchObject({ name: 'K3 写入库' })
    })
  })

  describe('assertReferenceable (P2-A bind-time ownership probe)', () => {
    it('passes for the owner WITHOUT connecting and WITHOUT requiring read-only', async () => {
      // A writable source: write-gated target bindings legitimately reference one,
      // so the probe must not impose the read path's read-only floor.
      const m = managerStub({ adapter: adapterStub({ readOnly: false, connected: false }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.assertReferenceable('pg', 'owner-1')).resolves.toBeUndefined()
      expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
      // binding metadata must never dial the customer system
      expect(m.stub.connectDataSource).not.toHaveBeenCalled()
      expect(m.adapter.testConnection).not.toHaveBeenCalled()
    })

    it('refuses a non-owner with the uniform not-found wording (no existence leak)', async () => {
      const m = managerStub({ deny: true })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.assertReferenceable('pg', 'stranger')).rejects.toMatchObject({
        code: DATA_SOURCE_NOT_FOUND_CODE,
        message: "Data source with id 'pg' not found",
      })
      await expect(facade.assertReferenceable('pg', 'stranger')).rejects.toBeInstanceOf(DataSourceUnavailableError)
    })

    it('refuses a missing principal before resolving the manager (never a default identity)', async () => {
      const getManager = vi.fn(() => managerStub().manager)
      const facade = createDataSourcePluginFacade(getManager)
      await expect(facade.assertReferenceable('pg', undefined)).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
      await expect(facade.assertReferenceable('pg', '   ')).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
      expect(getManager).not.toHaveBeenCalled()
    })
  })

  it('resolves the manager lazily (not at construction time)', async () => {
    const getManager = vi.fn(() => managerStub().manager)
    const facade = createDataSourcePluginFacade(getManager)
    expect(getManager).not.toHaveBeenCalled()
    await facade.test('pg', 'owner-1')
    expect(getManager).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a missing principal and NEVER falls back (manager not even resolved)', async () => {
    const getManager = vi.fn(() => managerStub().manager)
    const facade = createDataSourcePluginFacade(getManager)
    await expect(facade.select('pg', 't', { limit: 10 }, undefined)).rejects.toMatchObject({
      status: 422,
      code: DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
      message: MISSING_PRINCIPAL_MESSAGE,
    })
    await expect(facade.getSchema('pg', '   ')).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
    await expect(facade.getTableInfo('pg', 'items', undefined)).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
    await expect(facade.test('pg', undefined)).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
    // No fallback: a missing principal short-circuits before any manager / assertAccess is touched.
    expect(getManager).not.toHaveBeenCalled()
  })

  it('forwards the principal to assertAccess and propagates a mismatch (fail-closed, no leak)', async () => {
    const m = managerStub({ deny: true })
    const facade = createDataSourcePluginFacade(() => m.manager)
    await expect(facade.getSchema('pg', 'intruder')).rejects.toThrow(/not found/)
    expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'intruder')
  })

  it('re-raises a dangling / not-visible binding as a NAMED DataSourceUnavailableError with the message VERBATIM (no existence leak)', async () => {
    // This pins the name the integration host's inferHttpStatus keys on to map 500→422. The CJS
    // plugin route test fakes this error shape; if this name drifts, the route silently reverts to
    // 500 while that fixture test stays green — so the contract is pinned HERE, against the real TS.
    const m = managerStub({ deny: true })
    const facade = createDataSourcePluginFacade(() => m.manager)
    // assertAccess throws the uniform "not found"; the wrapper must add only a name, keeping the
    // message identical so a non-owner cannot distinguish "deleted" from "not yours".
    await expect(facade.getSchema('pg', 'intruder')).rejects.toMatchObject({
      name: 'DataSourceUnavailableError',
      status: 422,
      code: DATA_SOURCE_NOT_FOUND_CODE,
      message: "Data source with id 'pg' not found",
    })
    await expect(facade.getSchema('pg', 'intruder')).rejects.toBeInstanceOf(DataSourceUnavailableError)
    // Same uniform surface from a deleted-source (getDataSource miss) — message stays identical.
    const deleted = createDataSourcePluginFacade(() => ({
      assertAccess: vi.fn(() => undefined),
      getDataSource: vi.fn((id: string) => {
        throw new Error(`Data source with id '${id}' not found`)
      }),
      connectDataSource: vi.fn(async () => undefined),
      select: vi.fn(async () => ({ data: [], metadata: {} })),
    } as unknown as DataSourceManager))
    await expect(deleted.getSchema('pg', 'owner-1')).rejects.toMatchObject({
      name: 'DataSourceUnavailableError',
      status: 422,
      code: DATA_SOURCE_NOT_FOUND_CODE,
      message: "Data source with id 'pg' not found",
    })
  })

  it('select authorizes then maps to manager.select with {limit, offset}', async () => {
    const m = managerStub()
    const facade = createDataSourcePluginFacade(() => m.manager)
    const res = await facade.select('pg', 'public.items', { limit: 50, offset: 10 }, 'owner-1')
    expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    expect(m.stub.select).toHaveBeenCalledWith('pg', 'public.items', { limit: 50, offset: 10 })
    expect(res.data).toEqual([{ id: 1 }])
  })

  it('select forwards where filters to DataSourceManager for parameterized readonly reads', async () => {
    const m = managerStub()
    const facade = createDataSourcePluginFacade(() => m.manager)
    const where = { FileCode: 'P-001', parent_id: 'OBJ-7', active: true }
    await facade.select('pg', 'DN_PDM_PathExAttrInfo', { limit: 100, offset: 0, where }, 'owner-1')
    expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    expect(m.stub.select).toHaveBeenCalledWith('pg', 'DN_PDM_PathExAttrInfo', {
      limit: 100,
      offset: 0,
      where,
    })
  })

  it('select forwards orderBy with where for C3 keyset reads without opening a query/write surface', async () => {
    const m = managerStub()
    const facade = createDataSourcePluginFacade(() => m.manager)
    const where = { status: 'active' }
    const orderBy = [
      { column: 'updated_at', direction: 'asc' as const },
      { column: 'id', direction: 'asc' as const },
    ]
    await facade.select('pg', 'public.items', { limit: 100, offset: 0, where, orderBy }, 'owner-1')
    expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    expect(m.stub.select).toHaveBeenCalledWith('pg', 'public.items', {
      limit: 100,
      offset: 0,
      where,
      orderBy,
    })
  })

  it('select rejects malformed orderBy before DataSourceManager.select (direction allowlist)', async () => {
    const m = managerStub()
    const facade = createDataSourcePluginFacade(() => m.manager)
    await expect(
      facade.select(
        'pg',
        'public.items',
        { limit: 100, offset: 0, orderBy: [{ column: 'id', direction: 'asc;DROP' }] as never },
        'owner-1'
      )
    ).rejects.toMatchObject({
      status: 422,
      code: DATA_SOURCE_QUERY_INVALID_CODE,
      message: 'data source read orderBy[0].direction must be asc or desc',
    })
    expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    expect(m.stub.select).not.toHaveBeenCalled()
  })

  it('select normalizes uppercase orderBy directions to lowercase before forwarding', async () => {
    const m = managerStub()
    const facade = createDataSourcePluginFacade(() => m.manager)
    await facade.select(
      'pg',
      'public.items',
      { limit: 50, orderBy: [{ column: 'updated_at', direction: 'DESC' }] as never },
      'owner-1'
    )
    expect(m.stub.select).toHaveBeenCalledWith('pg', 'public.items', {
      limit: 50,
      offset: undefined,
      orderBy: [{ column: 'updated_at', direction: 'desc' }],
    })
  })

  it('connects the adapter when not already connected, before reading schema', async () => {
    const m = managerStub({ adapter: adapterStub({ connected: false }) })
    const facade = createDataSourcePluginFacade(() => m.manager)
    await facade.getSchema('pg', 'owner-1')
    expect(m.stub.connectDataSource).toHaveBeenCalledWith('pg')
    expect(m.adapter.getSchema).toHaveBeenCalled()
  })

  it('test on a read-only source returns { success }', async () => {
    const m = managerStub({ adapter: adapterStub({ healthy: true, readOnly: true }) })
    const facade = createDataSourcePluginFacade(() => m.manager)
    expect(await facade.test('pg', 'owner-1')).toEqual({ success: true })
  })

  it('fails closed on a WRITABLE source for EVERY read method (not just test) — read never performed', async () => {
    const m = managerStub({ adapter: adapterStub({ readOnly: false }) })
    const facade = createDataSourcePluginFacade(() => m.manager)
    await expect(facade.test('pg', 'owner-1')).rejects.toMatchObject({
      status: 422,
      code: DATA_SOURCE_NOT_READ_ONLY_CODE,
      message: writableSourceMessage('pg'),
    })
    await expect(facade.getSchema('pg', 'owner-1')).rejects.toThrow(writableSourceMessage('pg'))
    await expect(facade.getTableInfo('pg', 'items', 'owner-1')).rejects.toThrow(writableSourceMessage('pg'))
    await expect(facade.select('pg', 'items', { limit: 10 }, 'owner-1')).rejects.toThrow(writableSourceMessage('pg'))
    // The writable source is rejected before any read is performed — and before it is even connected.
    expect(m.stub.select).not.toHaveBeenCalled()
    expect(m.adapter.getSchema).not.toHaveBeenCalled()
    expect(m.adapter.getTableInfo).not.toHaveBeenCalled()
    expect(m.adapter.testConnection).not.toHaveBeenCalled()
    expect(m.stub.connectDataSource).not.toHaveBeenCalled()
  })

  // W-5: two fail-closed floors for ARMED B2a reads over SQL Server. `select`'s 5th param
  // (`strict`) is the ONLY way either floor engages — omitted (every caller before this change, and
  // every dormant/unarmed caller after it) is byte-identical to these floors never having existed.
  describe('select(..., strict) — W-5 armed-read floors', () => {
    it('strict omitted/false: a sqlserver source with requestTimeoutMs=0 is untouched (byte-identical)', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connected: false, connection: { requestTimeoutMs: 0 } }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.select('sql-1', 't', { limit: 10 }, 'owner-1')).resolves.toEqual({ data: [{ id: 1 }], metadata: {} })
      await expect(facade.select('sql-1', 't', { limit: 10 }, 'owner-1', false)).resolves.toEqual({ data: [{ id: 1 }], metadata: {} })
      expect(m.stub.connectDataSource).toHaveBeenCalledWith('sql-1')
      // No new field reaches manager.select when strict is absent/false.
      expect(m.stub.select).toHaveBeenCalledWith('sql-1', 't', { limit: 10, offset: undefined })
    })

    it('strict:true + sqlserver + requestTimeoutMs=0 refuses BEFORE any connection', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connection: { requestTimeoutMs: 0 } }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.select('sql-1', 't', { limit: 10 }, 'owner-1', true)).rejects.toMatchObject({
        status: 422,
        code: DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE,
        message: requestTimeoutDisabledMessage('sql-1'),
      })
      expect(m.stub.connectDataSource).not.toHaveBeenCalled()
      expect(m.stub.select).not.toHaveBeenCalled()
    })

    it('strict:true + sqlserver + requestTimeoutMs="0" (string) also refuses — same coercion mssql itself accepts', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connection: { requestTimeoutMs: '0' } }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.select('sql-1', 't', { limit: 10 }, 'owner-1', true)).rejects.toMatchObject({
        code: DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE,
      })
      expect(m.stub.connectDataSource).not.toHaveBeenCalled()
    })

    it('strict:true + sqlserver + a bounded requestTimeoutMs runs normally (floor only fires on an explicit 0)', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connected: false, connection: { requestTimeoutMs: 30000 } }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.select('sql-1', 't', { limit: 10 }, 'owner-1', true)).resolves.toEqual({ data: [{ id: 1 }], metadata: {} })
      expect(m.stub.connectDataSource).toHaveBeenCalledWith('sql-1')
    })

    it('strict:true + sqlserver + requestTimeoutMs unset (adapter default) runs normally', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connection: {} }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.select('sql-1', 't', { limit: 10 }, 'owner-1', true)).resolves.toEqual({ data: [{ id: 1 }], metadata: {} })
    })

    it('strict:true + a NON-sqlserver source with requestTimeoutMs=0 is unaffected (floor is sqlserver-only)', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'postgres', connected: false, connection: { requestTimeoutMs: 0 } }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.select('pg', 't', { limit: 10 }, 'owner-1', true)).resolves.toEqual({ data: [{ id: 1 }], metadata: {} })
      expect(m.stub.connectDataSource).toHaveBeenCalledWith('pg')
    })

    it('strict:true forces queryOptions.strictOffsetOrdering=true through to manager.select (floor 2)', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connection: {} }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await facade.select('sql-1', 't', { limit: 10, offset: 20 }, 'owner-1', true)
      expect(m.stub.select).toHaveBeenCalledWith('sql-1', 't', { limit: 10, offset: 20, strictOffsetOrdering: true })
    })

    it('strict omitted/false never adds strictOffsetOrdering to the forwarded query options', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', connection: {} }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await facade.select('sql-1', 't', { limit: 10, offset: 20 }, 'owner-1')
      expect(m.stub.select).toHaveBeenCalledWith('sql-1', 't', { limit: 10, offset: 20 })
      await facade.select('sql-1', 't', { limit: 10, offset: 20 }, 'owner-1', false)
      expect(m.stub.select).toHaveBeenLastCalledWith('sql-1', 't', { limit: 10, offset: 20 })
    })

    it('the readOnly / writable fail-closed check still runs before the strict floor (writable refuses first)', async () => {
      const m = managerStub({ adapter: adapterStub({ type: 'sqlserver', readOnly: false, connection: { requestTimeoutMs: 0 } }) })
      const facade = createDataSourcePluginFacade(() => m.manager)
      await expect(facade.select('sql-1', 't', { limit: 10 }, 'owner-1', true)).rejects.toMatchObject({
        code: DATA_SOURCE_NOT_READ_ONLY_CODE,
      })
      expect(m.stub.connectDataSource).not.toHaveBeenCalled()
    })
  })
})

describe('createDataSourceSealedSnapshotConnectionFacade', () => {
  const baseConnection = {
    server: 'sql.example.test',
    database: 'production',
    encrypt: true,
    trustServerCertificate: false,
  }

  const createFacade = (overrides: ManagerStubOptions = {}) => {
    const m = overrides.adapter
      ? managerStub(overrides)
      : managerStub({
          ...overrides,
          adapter: adapterStub({
            type: 'sqlserver',
            connection: baseConnection,
            credentials: { username: 'readonly-user', password: 'readonly-password' },
          }),
        })
    return { facade: createDataSourceSealedSnapshotConnectionFacade(() => m.manager), m }
  }

  it('projects only the sealed SQL shape, defaults the port, and never connects', async () => {
    const { facade, m } = createFacade()
    const result = await facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1',
      principal: 'owner-1',
      runAs: 'user',
    })
    expect(result).toEqual({
      connection: {
        database: 'production',
        encrypt: true,
        instanceName: null,
        port: 1433,
        server: 'sql.example.test',
        trustServerCertificate: false,
      },
      credentials: { password: 'readonly-password', user: 'readonly-user' },
    })
    expect(Object.keys(result).sort()).toEqual(['connection', 'credentials'])
    expect(Object.keys(result.connection).sort()).toEqual([
      'database', 'encrypt', 'instanceName', 'port', 'server', 'trustServerCertificate',
    ])
    expect(Object.keys(result.credentials).sort()).toEqual(['password', 'user'])
    expect(m.stub.assertAccess).toHaveBeenCalledWith('sql-1', 'owner-1')
    expect(m.stub.connectDataSource).not.toHaveBeenCalled()
    expect(m.adapter.getConfig).toHaveBeenCalledTimes(1)
  })

  it('reuses owner and exact-tenant authorization, and rejects service runs', async () => {
    const denied = createFacade({ deny: true })
    await expect(denied.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'stranger', runAs: 'user',
    })).rejects.toBeInstanceOf(DataSourceUnavailableError)

    const mismatched = createFacade()
    ;(mismatched.m.stub.getScope as ReturnType<typeof vi.fn>).mockReturnValue({
      ownerId: 'owner-1', workspaceId: null, tenantId: 'tenant-2', scopeKind: 'private',
    })
    await expect(mismatched.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })).rejects.toBeInstanceOf(DataSourceUnavailableError)

    const tenantfulService = createFacade()
    await expect(tenantfulService.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'service',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })

    const tenantless = createFacade()
    ;(tenantless.m.stub.getScope as ReturnType<typeof vi.fn>).mockReturnValue({
      ownerId: 'owner-1', workspaceId: null, tenantId: null, scopeKind: 'legacy_private',
    })
    await expect(tenantless.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'service',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })
  })

  it('rejects non-SQL Server and writable adapters before reading config', async () => {
    const wrongType = createFacade({ adapter: adapterStub({ type: 'postgres' }) })
    await expect(wrongType.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })
    expect(wrongType.m.adapter.getConfig).not.toHaveBeenCalled()

    const writable = createFacade({ adapter: adapterStub({ type: 'sqlserver', readOnly: false }) })
    await expect(writable.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })
    expect(writable.m.adapter.getConfig).not.toHaveBeenCalled()
  })

  it('fails closed for legacy TLS and unrepresentable connection fields', async () => {
    const manager = managerStub({
      adapter: adapterStub({
        type: 'sqlserver',
        connection: { ...baseConnection, legacyTls: true },
        credentials: { username: 'u', password: 'p' },
      }),
    })
    const invalid = createDataSourceSealedSnapshotConnectionFacade(() => manager.manager)
    await expect(invalid.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })

    const stringPort = createFacade({
      adapter: adapterStub({
        type: 'sqlserver',
        connection: { ...baseConnection, port: '1444' },
        credentials: { username: 'u', password: 'p' },
      }),
    })
    await expect(stringPort.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })
  })

  it('preserves password bytes and rejects instanceName because MSSQLAdapter does not consume it', async () => {
    const password = '  password with spaces  '
    const withPassword = createFacade({
      adapter: adapterStub({
        type: 'sqlserver',
        connection: baseConnection,
        credentials: { username: '  readonly-user  ', password },
      }),
    })
    const result = await withPassword.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })
    expect(result.credentials).toEqual({ password, user: '  readonly-user  ' })

    const withInstance = createFacade({
      adapter: adapterStub({
        type: 'sqlserver',
        connection: { ...baseConnection, instanceName: 'SQLEXPRESS' },
        credentials: { username: 'u', password: 'p' },
      }),
    })
    await expect(withInstance.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })

    const withEncodedInstance = createFacade({
      adapter: adapterStub({
        type: 'sqlserver',
        connection: { ...baseConnection, server: 'sql.example.test\\SQLEXPRESS' },
        credentials: { username: 'u', password: 'p' },
      }),
    })
    await expect(withEncodedInstance.facade.resolveSqlServerConnection('sql-1', {
      tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user',
    })).rejects.toMatchObject({ code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE })
  })
})

describe('createDataSourceWritePluginFacade', () => {
  it('is write-gated by construction — exposes structured methods only, no raw query/delete/credential surface', () => {
    const facade = createDataSourceWritePluginFacade(() => managerStub().manager)
    expect(Object.keys(facade).sort()).toEqual([
      'getSchema',
      'getTableInfo',
      'insertRows',
      'lookupByKey',
      'test',
      'updateRows',
    ])
    const surface = facade as unknown as Record<string, unknown>
    for (const forbidden of [
      'query', 'delete', 'remove', 'credentials', 'connect', 'disconnect',
      'addDataSource', 'updateDataSource', 'removeDataSource', 'adapter',
    ]) {
      expect(surface).not.toHaveProperty(forbidden)
    }
  })

  it('fails closed on a missing principal before resolving the manager', async () => {
    const getManager = vi.fn(() => managerStub().manager)
    const facade = createDataSourceWritePluginFacade(getManager)
    await expect(facade.lookupByKey(
      'pg',
      'public.items',
      { id: 1 },
      { keyFields: ['id'], writableFields: ['name'] },
      undefined
    )).rejects.toMatchObject({
      status: 422,
      code: DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
      message: MISSING_PRINCIPAL_MESSAGE,
    })
    expect(getManager).not.toHaveBeenCalled()
  })

  it('requires an explicitly writable C6 target with generic query disabled', async () => {
    const readOnly = managerStub({ adapter: adapterStub({ readOnly: true, c6WriteTarget: true, genericQueryDisabled: true }) })
    const readOnlyFacade = createDataSourceWritePluginFacade(() => readOnly.manager)
    await expect(readOnlyFacade.test('pg', 'owner-1')).rejects.toMatchObject({
      status: 422,
      code: DATA_SOURCE_NOT_WRITABLE_CODE,
      message: writeTargetReadOnlyMessage('pg'),
    })

    const notC6 = managerStub({ adapter: adapterStub({ readOnly: false, c6WriteTarget: true, genericQueryDisabled: false }) })
    const notC6Facade = createDataSourceWritePluginFacade(() => notC6.manager)
    await expect(notC6Facade.getSchema('pg', 'owner-1')).rejects.toMatchObject({
      status: 422,
      code: DATA_SOURCE_NOT_C6_WRITE_TARGET_CODE,
      message: writeTargetNotC6Message('pg'),
    })
    expect(notC6.stub.connectDataSource).not.toHaveBeenCalled()
  })

  it('write test returns the real C6 capability state used by dry-run revision fencing', async () => {
    const m = managerStub({ adapter: adapterStub({ readOnly: false, c6WriteTarget: true, genericQueryDisabled: true }) })
    const facade = createDataSourceWritePluginFacade(() => m.manager)
    await expect(facade.test('pg', 'owner-1')).resolves.toEqual({
      success: true,
      capabilityState: {
        readOnly: false,
        c6WriteTarget: true,
        genericQueryDisabled: true,
      },
    })
  })

  it('lookupByKey forwards only structured equality where and limit=2', async () => {
    const m = managerStub({ adapter: adapterStub({ readOnly: false, c6WriteTarget: true, genericQueryDisabled: true }) })
    const facade = createDataSourceWritePluginFacade(() => m.manager)
    await facade.lookupByKey(
      'pg',
      'public.items',
      { externalId: 'A-1' },
      { keyFields: ['externalId'], writableFields: ['name', 'status'] },
      'owner-1'
    )
    expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    expect(m.stub.select).toHaveBeenCalledWith('pg', 'public.items', {
      limit: 2,
      where: { externalId: 'A-1' },
    })
  })

  it('insertRows and updateRows enforce key/writable field allowlists before writing', async () => {
    const m = managerStub({ adapter: adapterStub({ readOnly: false, c6WriteTarget: true, genericQueryDisabled: true }) })
    const facade = createDataSourceWritePluginFacade(() => m.manager)
    const policy = { keyFields: ['externalId'], writableFields: ['name', 'status'] }

    await facade.insertRows('pg', 'public.items', [{ externalId: 'A-1', name: 'Widget', status: 'new' }], policy, 'owner-1')
    expect(m.stub.insert).toHaveBeenCalledWith('pg', 'public.items', [{ externalId: 'A-1', name: 'Widget', status: 'new' }])

    await facade.updateRows('pg', 'public.items', [{ externalId: 'A-1', status: 'done' }], policy, 'owner-1')
    expect(m.stub.update).toHaveBeenCalledWith('pg', 'public.items', { status: 'done' }, { externalId: 'A-1' })

    await expect(
      facade.insertRows('pg', 'public.items', [{ externalId: 'A-2', name: 'Widget', password: 'secret' }], policy, 'owner-1')
    ).rejects.toMatchObject({
      status: 422,
      code: DATA_SOURCE_QUERY_INVALID_CODE,
      message: 'rows[0].password is not in keyFields or writableFields',
    })
    expect(m.stub.insert).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Refusal reasons — WHY a connection was refused, for the server log only (#6067 §5 R1).
//
// Every refusal of `resolveConnectionRegistration` and of the sealed snapshot facade carries exactly
// one word of DATA_SOURCE_REFUSAL_REASONS, as a non-enumerable property under a registered symbol.
// What is thrown is otherwise exactly what was thrown before: the `expected` of each case below is
// the class name, code, message and status of that branch as it stood before the reason existed.
//
// Equal cost: a refusal decided from caller input alone looks nothing up and does not resolve the
// manager; every refusal decided after the manager was resolved has read the load state exactly
// once. `lookups` and `managerResolved` pin both halves, per branch.
// ---------------------------------------------------------------------------------------------
describe('refusal reasons (server log only)', () => {
  const ID = 'ds-1'
  const NOT_FOUND = `Data source with id '${ID}' not found`
  const UNAVAILABLE = { name: 'DataSourceUnavailableError', code: DATA_SOURCE_NOT_FOUND_CODE, message: NOT_FOUND }
  const sealedInvalid = (field: string) => ({
    name: 'DataSourceSealedSnapshotConnectionError',
    code: DATA_SOURCE_SEALED_SNAPSHOT_CONNECTION_INVALID_CODE,
    message: `data source sealed snapshot SQL Server connection field '${field}' is not representable`,
  })
  const TENANTLESS_LEGACY = { ownerId: 'owner-1', workspaceId: null, tenantId: null, scopeKind: 'legacy_private' as const }
  const TENANTLESS_PRIVATE = { ownerId: 'owner-1', workspaceId: null, tenantId: null, scopeKind: 'private' as const }
  const SEALED_CONNECTION = {
    server: 'sql.example.test',
    database: 'production',
    encrypt: true,
    trustServerCertificate: false,
  }
  const sealedAdapter = (overrides: AdapterStubOptions = {}) => adapterStub({
    type: 'sqlserver',
    connection: SEALED_CONNECTION,
    credentials: { username: 'readonly-user', password: 'readonly-password' },
    ...overrides,
  })

  interface RefusalRun {
    error: Error
    lookups: number
    managerResolved: number
  }

  interface RefusalCase {
    label: string
    reason: string
    expected: { name: string; code: string; message: string }
    lookups: 0 | 1
    inputOnly: boolean
    run(): Promise<RefusalRun>
  }

  type RegistrationOptions = Parameters<ReturnType<typeof createDataSourcePluginFacade>['resolveConnectionRegistration']>[1]

  async function refusalOf(action: () => Promise<unknown>): Promise<Error> {
    try {
      await action()
    } catch (error) {
      return error as Error
    }
    throw new Error('expected a refusal, the call resolved')
  }

  function reasonOf(error: unknown): unknown {
    return (error as Record<symbol, unknown>)[DATA_SOURCE_REFUSAL_REASON_KEY]
  }

  async function registration(stubOptions: ManagerStubOptions, options: Partial<RegistrationOptions> = {}): Promise<RefusalRun> {
    const m = managerStub(stubOptions)
    const getManager = vi.fn(() => m.manager)
    const facade = createDataSourcePluginFacade(getManager)
    const error = await refusalOf(() => facade.resolveConnectionRegistration(ID, {
      tenantId: 'tenant-1',
      principal: 'owner-1',
      ...options,
    } as RegistrationOptions))
    return { error, lookups: m.getLoadState.mock.calls.length, managerResolved: getManager.mock.calls.length }
  }

  async function sealed(
    stubOptions: ManagerStubOptions,
    options: Partial<RegistrationOptions> = {},
    arrange: (m: ReturnType<typeof managerStub>) => void = () => undefined,
  ): Promise<RefusalRun> {
    const m = managerStub({ adapter: sealedAdapter(), ...stubOptions })
    arrange(m)
    const getManager = vi.fn(() => m.manager)
    const facade = createDataSourceSealedSnapshotConnectionFacade(getManager)
    const error = await refusalOf(() => facade.resolveSqlServerConnection(ID, {
      tenantId: 'tenant-1',
      principal: 'owner-1',
      runAs: 'user',
      ...options,
    } as RegistrationOptions))
    return { error, lookups: m.getLoadState.mock.calls.length, managerResolved: getManager.mock.calls.length }
  }

  const PRINCIPAL_REQUIRED = {
    name: 'DataSourcePrincipalRequiredError',
    code: DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
    message: MISSING_PRINCIPAL_MESSAGE,
  }

  // One case per refusal branch. `resolveRegistration` has eight refusal sites; the catch around the
  // access step is one site with six outcomes (three separate throws behind it), and the sealed
  // facade adds seven sites of its own.
  const CASES: RefusalCase[] = [
    // ── decided from caller input, before the manager is resolved ──
    {
      label: 'principal missing',
      reason: 'principal_missing',
      expected: PRINCIPAL_REQUIRED,
      lookups: 0,
      inputOnly: true,
      run: () => registration({ loadState: 'loaded' }, { principal: undefined }),
    },
    {
      label: 'requested tenant missing',
      reason: 'tenant_missing',
      expected: UNAVAILABLE,
      lookups: 0,
      inputOnly: true,
      run: () => registration({ loadState: 'loaded' }, { tenantId: '   ' }),
    },
    {
      label: 'runAs is not user / owner / service',
      reason: 'run_as_invalid',
      expected: UNAVAILABLE,
      lookups: 0,
      inputOnly: true,
      run: () => registration({ loadState: 'loaded' }, { runAs: 'admin' as never }),
    },
    // ── the access step refused ──
    {
      label: 'loaded, and the principal is not its owner',
      reason: 'owner_mismatch',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ deny: true, loadState: 'loaded' }),
    },
    {
      label: 'not loaded: its stored credential cannot be decrypted',
      reason: 'not_loaded_credentials_unreadable',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ deny: true, loadState: 'credentials_unreadable' }),
    },
    {
      label: 'not loaded: its type has no adapter',
      reason: 'not_loaded_unsupported_type',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ deny: true, loadState: 'unsupported_type' }),
    },
    {
      label: 'not loaded: the load failed for another cause',
      reason: 'not_loaded_load_failed',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ deny: true, loadState: 'load_failed' }),
    },
    {
      label: 'not loaded: the registry has never seen the id',
      reason: 'not_loaded_absent',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ deny: true, loadState: 'absent' }),
    },
    {
      label: 'the access step refused and the load state is not one of the known words',
      reason: 'load_state_unknown',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ deny: true, loadState: 'owner_mismatch' }),
    },
    // ── access passed, the stored scope refused ──
    {
      label: 'access passed and no scope is stored',
      reason: 'scope_missing',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ scopeMissing: true, loadState: 'loaded' }),
    },
    {
      label: 'the source belongs to another tenant',
      reason: 'tenant_mismatch',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ loadState: 'loaded' }, { tenantId: 'tenant-2' }),
    },
    {
      label: 'tenantless source whose scope is not legacy_private',
      reason: 'tenantless_scope',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ scope: TENANTLESS_PRIVATE, loadState: 'loaded' }, { runAs: 'user' }),
    },
    {
      label: 'tenantless legacy_private source, asked for by a service run',
      reason: 'tenantless_service',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => registration({ scope: TENANTLESS_LEGACY, loadState: 'loaded' }, { runAs: 'service' }),
    },
    // ── sealed snapshot facade only ──
    {
      label: 'sealed: runAs is not user',
      reason: 'sealed_run_as_not_user',
      expected: sealedInvalid('runAs'),
      lookups: 0,
      inputOnly: true,
      run: () => sealed({ loadState: 'loaded' }, { runAs: 'service' }),
    },
    {
      label: 'sealed: the registration is not a SQL Server source',
      reason: 'sealed_type_unsupported',
      expected: sealedInvalid('type'),
      lookups: 1,
      inputOnly: false,
      run: () => sealed({ adapter: adapterStub({ type: 'postgres' }), loadState: 'loaded' }),
    },
    {
      label: 'sealed: the adapter left the registry after the registration passed',
      reason: 'sealed_adapter_unavailable',
      expected: UNAVAILABLE,
      lookups: 1,
      inputOnly: false,
      run: () => sealed({ loadState: 'loaded' }, {}, (m) => {
        m.stub.getDataSource
          .mockImplementationOnce(() => m.adapter)
          .mockImplementationOnce((id: string) => { throw new Error(`Data source with id '${id}' not found`) })
      }),
    },
    {
      label: 'sealed: the source is writable',
      reason: 'sealed_not_read_only',
      expected: sealedInvalid('readOnly'),
      lookups: 1,
      inputOnly: false,
      run: () => sealed({ adapter: sealedAdapter({ readOnly: false }), loadState: 'loaded' }),
    },
    {
      label: 'sealed: the adapter configuration cannot be read',
      reason: 'sealed_config_unreadable',
      expected: sealedInvalid('connection'),
      lookups: 1,
      inputOnly: false,
      run: () => sealed({ loadState: 'loaded' }, {}, (m) => {
        m.adapter.getConfig.mockImplementation(() => { throw new Error('config marker-zq9 is gone') })
      }),
    },
    {
      label: 'sealed: a connection field cannot be projected',
      reason: 'sealed_connection_not_representable',
      // The projection names the offending field, and that name is a key of the stored config.
      expected: sealedInvalid('connection.markerFieldZq9'),
      lookups: 1,
      inputOnly: false,
      run: () => sealed({
        adapter: sealedAdapter({ connection: { ...SEALED_CONNECTION, markerFieldZq9: true } }),
        loadState: 'loaded',
      }),
    },
  ]

  it.each(CASES)('$label → $reason', async ({ reason, expected, lookups, inputOnly, run }) => {
    const { error, lookups: observedLookups, managerResolved } = await run()

    // The one word.
    expect(reasonOf(error)).toBe(reason)
    expect(DATA_SOURCE_REFUSAL_REASONS).toContain(reason)

    // What is thrown is what was thrown before the reason existed.
    expect({ name: error.name, code: (error as { code?: unknown }).code, message: error.message }).toEqual(expected)
    expect((error as { status?: unknown }).status).toBe(422)
    expect(error).toBeInstanceOf(Error)
    if (expected.name === 'DataSourceUnavailableError') expect(error).toBeInstanceOf(DataSourceUnavailableError)
    expect(Object.keys(error).sort()).toEqual(['code', 'name', 'status'])
    expect(JSON.parse(JSON.stringify(error))).toEqual({ code: expected.code, name: expected.name, status: 422 })

    // Nothing that serializes an error can pick the word up.
    const descriptor = Object.getOwnPropertyDescriptor(error, DATA_SOURCE_REFUSAL_REASON_KEY)
    expect(descriptor).toEqual({ value: reason, enumerable: false, writable: false, configurable: false })
    expect((error as { reason?: unknown }).reason).toBeUndefined()
    expect('reason' in error).toBe(false)
    expect(Object.getOwnPropertyNames(error)).not.toContain('reason')
    expect(Object.getOwnPropertySymbols({ ...error })).toEqual([])
    expect(Object.getOwnPropertySymbols(Object.assign({}, error))).toEqual([])
    expect(JSON.stringify(error)).not.toContain(reason)
    expect(inspect(error)).not.toContain(reason)
    expect(String(error)).not.toContain(reason)
    expect(String(error.stack)).not.toContain(reason)

    // Equal cost, per branch.
    expect(observedLookups).toBe(lookups)
    if (inputOnly) expect(managerResolved).toBe(0)
    else expect(managerResolved).toBeGreaterThan(0)
  })

  it('the vocabulary is CLOSED: the branches produce exactly the exported list, no word more and none less', async () => {
    const produced = new Set<string>()
    for (const refusalCase of CASES) {
      produced.add(String(reasonOf((await refusalCase.run()).error)))
    }
    expect([...produced].sort()).toEqual([...DATA_SOURCE_REFUSAL_REASONS].sort())
    expect(new Set(DATA_SOURCE_REFUSAL_REASONS).size).toBe(DATA_SOURCE_REFUSAL_REASONS.length)
    for (const word of DATA_SOURCE_REFUSAL_REASONS) expect(word).toMatch(/^[a-z]+(_[a-z]+)+$/)
  })

  it('the source names no reason outside the list, and every listed word is used at a refusal site', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/data-adapters/data-source-plugin-facade.ts'),
      'utf8',
    )
    // Every snake_case literal of the file, minus the ones that are not reasons: a scope kind, and
    // the load states the manager answers with.
    const NOT_REASONS = new Set(['legacy_private', 'loaded', 'absent', 'credentials_unreadable', 'unsupported_type', 'load_failed'])
    const literals = new Map<string, number>()
    for (const match of source.matchAll(/'([a-z]+(?:_[a-z]+)+)'/g)) {
      if (NOT_REASONS.has(match[1])) continue
      literals.set(match[1], (literals.get(match[1]) ?? 0) + 1)
    }
    expect([...literals.keys()].sort()).toEqual([...DATA_SOURCE_REFUSAL_REASONS].sort())
    // Once in the list, at least once more where a refusal is built.
    for (const word of DATA_SOURCE_REFUSAL_REASONS) {
      expect(literals.get(word), `${word} is listed but no refusal site uses it`).toBeGreaterThanOrEqual(2)
    }
  })

  it('principal_missing is the refusal of requirePrincipal, not a not-found, for every blank principal', async () => {
    for (const principal of [undefined, '', '   ']) {
      const { error, lookups, managerResolved } = await registration({ loadState: 'loaded' }, { principal })
      expect(reasonOf(error)).toBe('principal_missing')
      expect(error).not.toBeInstanceOf(DataSourceUnavailableError)
      expect(error.name).toBe('DataSourcePrincipalRequiredError')
      expect(lookups).toBe(0)
      expect(managerResolved).toBe(0)
    }
  })

  it('load_state_unknown covers a manager without the accessor, an accessor that throws, and a registry that contradicts itself', async () => {
    // No accessor at all — the manager stub every earlier case in this file uses.
    const bare = managerStub({ deny: true })
    expect('getLoadState' in bare.stub).toBe(false)
    const bareError = await refusalOf(() => createDataSourcePluginFacade(() => bare.manager)
      .resolveConnectionRegistration(ID, { tenantId: 'tenant-1', principal: 'stranger' }))
    expect(reasonOf(bareError)).toBe('load_state_unknown')
    expect({ name: bareError.name, message: bareError.message }).toEqual({ name: UNAVAILABLE.name, message: NOT_FOUND })

    // The accessor throws: the refusal is the one the access step raised, never the accessor's error.
    const throwing = await registration({ deny: true, loadStateThrows: new Error('accessor marker-zq9 failed') })
    expect(reasonOf(throwing.error)).toBe('load_state_unknown')
    expect(throwing.error.message).toBe(NOT_FOUND)
    expect(throwing.lookups).toBe(1)

    // Loaded, access granted, and the adapter read still failed: not an owner mismatch.
    const contradicting = await registration({ getDataSourceThrows: true, loadState: 'loaded' })
    expect(reasonOf(contradicting.error)).toBe('load_state_unknown')
    expect(contradicting.error.message).toBe(NOT_FOUND)

    // The same adapter read failing on an id the registry reports as not loaded keeps its state.
    const notLoaded = await registration({ getDataSourceThrows: true, loadState: 'credentials_unreadable' })
    expect(reasonOf(notLoaded.error)).toBe('not_loaded_credentials_unreadable')

    // A non-string answer is not a state.
    for (const loadState of [undefined, null, 1, true, { toString: () => 'loaded' }, ['loaded']]) {
      expect(reasonOf((await registration({ deny: true, loadState })).error)).toBe('load_state_unknown')
    }
  })

  it('sealed_type_unsupported also names the second type check, on the adapter itself', async () => {
    const { error, lookups } = await sealed({ loadState: 'loaded' }, {}, (m) => {
      let reads = 0
      m.adapter.getType = () => {
        reads += 1
        return reads === 1 ? 'sqlserver' : 'postgres'
      }
    })
    expect(reasonOf(error)).toBe('sealed_type_unsupported')
    expect(error.message).toBe(sealedInvalid('type').message)
    expect(lookups).toBe(1)
  })

  it('a refusal of the registration reaches the sealed caller with the reason it already had', async () => {
    const { error, lookups } = await sealed({ deny: true, loadState: 'credentials_unreadable' })
    expect(reasonOf(error)).toBe('not_loaded_credentials_unreadable')
    expect(error).toBeInstanceOf(DataSourceUnavailableError)
    expect(lookups).toBe(1)
  })

  it('a resolution that passes reads the load state once as well, and returns what it returned before', async () => {
    const m = managerStub({ loadState: 'loaded' })
    const facade = createDataSourcePluginFacade(() => m.manager)
    await expect(facade.resolveConnectionRegistration(ID, { tenantId: 'tenant-1', principal: 'owner-1' }))
      .resolves.toEqual({ id: ID, type: 'postgres', tenantId: 'tenant-1', scopeKind: 'private' })
    expect(m.getLoadState).toHaveBeenCalledTimes(1)
    expect(m.getLoadState).toHaveBeenCalledWith(ID)

    const s = managerStub({ adapter: sealedAdapter(), loadState: 'loaded' })
    await expect(createDataSourceSealedSnapshotConnectionFacade(() => s.manager)
      .resolveSqlServerConnection(ID, { tenantId: 'tenant-1', principal: 'owner-1', runAs: 'user' }))
      .resolves.toMatchObject({ credentials: { user: 'readonly-user' } })
    expect(s.getLoadState).toHaveBeenCalledTimes(1)
  })

  it('the lookup is given the id and nothing about the caller', async () => {
    const m = managerStub({ deny: true, loadState: 'absent' })
    await refusalOf(() => createDataSourcePluginFacade(() => m.manager)
      .resolveConnectionRegistration(ID, { tenantId: 'tenant-1', principal: 'stranger', runAs: 'user' }))
    expect(m.getLoadState.mock.calls).toEqual([[ID]])
  })

  it('refusals outside the two resolution entry points carry no reason', async () => {
    const denied = managerStub({ deny: true, loadState: 'loaded' })
    const facade = createDataSourcePluginFacade(() => denied.manager)
    for (const action of [
      () => facade.describe(ID, 'stranger'),
      () => facade.assertReferenceable(ID, 'stranger'),
      () => facade.getSchema(ID, 'stranger'),
      () => facade.describe(ID, undefined),
      () => facade.select(ID, 't', { limit: 1 }, undefined),
    ]) {
      const error = await refusalOf(action)
      expect(Object.getOwnPropertySymbols(error)).toEqual([])
    }
    expect(denied.getLoadState).not.toHaveBeenCalled()
  })
})
