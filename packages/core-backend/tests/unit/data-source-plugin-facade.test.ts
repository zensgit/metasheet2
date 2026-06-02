import { describe, expect, it, vi } from 'vitest'

import { createDataSourcePluginFacade, MISSING_PRINCIPAL_MESSAGE, writableSourceMessage } from '../../src/data-adapters/data-source-plugin-facade'
import type { DataSourceManager } from '../../src/data-adapters/DataSourceManager'

interface AdapterStubOptions {
  connected?: boolean
  healthy?: boolean
  readOnly?: boolean
}

function adapterStub(opts: AdapterStubOptions = {}) {
  return {
    isConnected: () => opts.connected ?? true,
    testConnection: vi.fn(async () => opts.healthy ?? true),
    isReadOnly: () => opts.readOnly ?? true,
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
    assertAccess: vi.fn((id: string, _owner: string | undefined) => {
      if (opts.deny) throw new Error(`Data source '${id}' not found`)
    }),
    getDataSource: vi.fn(() => adapter),
    connectDataSource: vi.fn(async () => undefined),
    select: vi.fn(async () => ({ data: [{ id: 1 }], metadata: {} })),
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
    await expect(facade.select('pg', 't', { limit: 10 }, undefined)).rejects.toThrow(MISSING_PRINCIPAL_MESSAGE)
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

  it('select authorizes then maps to manager.select with {limit, offset}', async () => {
    const m = managerStub()
    const facade = createDataSourcePluginFacade(() => m.manager)
    const res = await facade.select('pg', 'public.items', { limit: 50, offset: 10 }, 'owner-1')
    expect(m.stub.assertAccess).toHaveBeenCalledWith('pg', 'owner-1')
    expect(m.stub.select).toHaveBeenCalledWith('pg', 'public.items', { limit: 50, offset: 10 })
    expect(res.data).toEqual([{ id: 1 }])
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
    await expect(facade.test('pg', 'owner-1')).rejects.toThrow(writableSourceMessage('pg'))
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
