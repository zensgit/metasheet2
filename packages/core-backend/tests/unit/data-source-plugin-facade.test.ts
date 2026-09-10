import { describe, expect, it, vi } from 'vitest'

import {
  createDataSourcePluginFacade,
  createDataSourceSealedSnapshotConnectionFacade,
  createDataSourceWritePluginFacade,
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
}

function managerStub(opts: ManagerStubOptions = {}) {
  const adapter = opts.adapter ?? adapterStub()
  const stub = {
    // Mirror DataSourceManager's uniform not-found wording verbatim — the wrapper must re-raise it
    // unchanged (no existence leak), so the test asserts against the real message shape.
    assertAccess: vi.fn((id: string, _owner: string | undefined) => {
      if (opts.deny) throw new Error(`Data source with id '${id}' not found`)
    }),
    getScope: vi.fn(() => opts.scope ?? {
      ownerId: 'owner-1',
      workspaceId: null,
      tenantId: 'tenant-1',
      scopeKind: 'private',
    }),
    getDataSource: vi.fn(() => adapter),
    connectDataSource: vi.fn(async () => undefined),
    select: vi.fn(async () => ({ data: [{ id: 1 }], metadata: {} })),
    insert: vi.fn(async (_id: string, _table: string, rows: unknown[]) => ({ data: rows, metadata: {} })),
    update: vi.fn(async (_id: string, _table: string, data: unknown, where: unknown) => ({ data: [{ data, where }], metadata: {} })),
  }
  return { stub, adapter, manager: stub as unknown as DataSourceManager }
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
