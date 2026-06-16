import { describe, expect, it, vi } from 'vitest'

import {
  createDataSourcePluginFacade,
  createDataSourceWritePluginFacade,
  DATA_SOURCE_NOT_FOUND_CODE,
  DATA_SOURCE_NOT_READ_ONLY_CODE,
  DATA_SOURCE_NOT_C6_WRITE_TARGET_CODE,
  DATA_SOURCE_NOT_WRITABLE_CODE,
  DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
  DATA_SOURCE_QUERY_INVALID_CODE,
  DataSourceUnavailableError,
  MISSING_PRINCIPAL_MESSAGE,
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
}

function adapterStub(opts: AdapterStubOptions = {}) {
  return {
    isConnected: () => opts.connected ?? true,
    testConnection: vi.fn(async () => opts.healthy ?? true),
    isReadOnly: () => opts.readOnly ?? true,
    getConfig: () => ({
      id: 'pg',
      name: 'pg',
      type: 'postgres',
      connection: {},
      options: {
        ...(opts.readOnly === undefined ? {} : { readOnly: opts.readOnly }),
        ...(opts.c6WriteTarget === undefined ? {} : { c6WriteTarget: opts.c6WriteTarget }),
        ...(opts.genericQueryDisabled === undefined ? {} : { genericQueryDisabled: opts.genericQueryDisabled }),
      },
    }),
    getSchema: vi.fn(async (_schema?: string) => ({ tables: [], views: [] })),
    getTableInfo: vi.fn(async (table: string, _schema?: string) => ({ name: table, columns: [] })),
  }
}

interface ManagerStubOptions {
  adapter?: ReturnType<typeof adapterStub>
  deny?: boolean
}

function managerStub(opts: ManagerStubOptions = {}) {
  const adapter = opts.adapter ?? adapterStub()
  const stub = {
    // Mirror DataSourceManager's uniform not-found wording verbatim — the wrapper must re-raise it
    // unchanged (no existence leak), so the test asserts against the real message shape.
    assertAccess: vi.fn((id: string, _owner: string | undefined) => {
      if (opts.deny) throw new Error(`Data source with id '${id}' not found`)
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
  it('is read-only by construction — exposes only read methods, no write/credential surface', () => {
    const facade = createDataSourcePluginFacade(() => managerStub().manager)
    expect(Object.keys(facade).sort()).toEqual(['getSchema', 'getTableInfo', 'select', 'test'])
    const surface = facade as unknown as Record<string, unknown>
    for (const forbidden of [
      'insert', 'update', 'delete', 'create', 'remove', 'rotate', 'connect', 'disconnect',
      'credentials', 'query', 'addDataSource', 'updateDataSource', 'removeDataSource',
    ]) {
      expect(surface).not.toHaveProperty(forbidden)
    }
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
