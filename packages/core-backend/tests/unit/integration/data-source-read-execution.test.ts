import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DataSourceConfig, Transaction } from '../../../src/data-adapters/BaseAdapter'
import { MSSQLAdapter } from '../../../src/data-adapters/MSSQLAdapter'
import { PostgresAdapter } from '../../../src/data-adapters/PostgresAdapter'
import type { DataSourceManager } from '../../../src/data-adapters/DataSourceManager'
import { createDataSourcePluginFacade } from '../../../src/data-adapters/data-source-plugin-facade'
import {
  isDataSourceReadExecutionError,
  runDataSourceReadIO,
  withDataSourceReadExecution,
} from '../../../src/data-adapters/data-source-read-execution'
import type { DataSourceReadIOKind } from '../../../src/data-adapters/data-source-read-execution'

vi.mock('../../../src/audit/audit', () => ({ auditLog: vi.fn(async () => {}) }))

// Both adapters use require() for optional drivers. Swap only their native constructors; all
// adapter methods (including the four-query table-detail path) remain genuine production code.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const mssqlDriver = require('mssql') as Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const pgDriver = require('pg') as Record<string, unknown>
const originalMssqlPool = mssqlDriver.ConnectionPool
const originalPgPool = pgDriver.Pool

afterEach(() => {
  mssqlDriver.ConnectionPool = originalMssqlPool
  pgDriver.Pool = originalPgPool
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function options(adapter: object, signal = new AbortController().signal) {
  return {
    adapter,
    signal,
    beforeIO: vi.fn(async (_kind: DataSourceReadIOKind) => {}),
    afterIO: vi.fn(async () => {}),
  }
}

function config(type: 'sqlserver' | 'postgres'): DataSourceConfig {
  return {
    id: 'synthetic-read-source', name: 'synthetic-read-source', type,
    connection: { host: 'synthetic.invalid', database: 'synthetic' },
    options: { autoConnect: false },
  }
}

function fixture(type: 'sqlserver' | 'postgres', attach = true) {
  const adapter = type === 'sqlserver' ? new MSSQLAdapter(config(type)) : new PostgresAdapter(config(type))
  const nativeQuery = vi.fn(async (_sql: string) => ({
    rows: [] as unknown[], recordset: [] as unknown[], rowCount: 0, rowsAffected: [0], fields: [],
  }))
  const requests: Array<{ cancel: ReturnType<typeof vi.fn> }> = []
  const pool = {
    query: nativeQuery,
    request: vi.fn(() => {
      const request = { input: vi.fn(() => request), query: nativeQuery, cancel: vi.fn() }
      requests.push(request)
      return request
    }),
    connect: vi.fn(async () => pool),
    close: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  }
  if (attach) {
    const internal = adapter as unknown as { pool: unknown; connected: boolean }
    internal.pool = pool
    internal.connected = true
  } else {
    const driver = type === 'sqlserver' ? mssqlDriver : pgDriver
    driver[type === 'sqlserver' ? 'ConnectionPool' : 'Pool'] = class {
      constructor() { return pool }
    }
  }
  return { adapter, pool, nativeQuery, requests }
}

describe('host data-source read execution scope', () => {
  it('leaves native calls outside a scope unchanged', async () => {
    const native = vi.fn(async (signal?: AbortSignal) => signal)
    await expect(runDataSourceReadIO({}, 'query', native)).resolves.toBeUndefined()
    expect(native).toHaveBeenCalledTimes(1)
    expect(native).toHaveBeenCalledWith()
  })

  it('checks authority around each native IO in order and passes the signal', async () => {
    const adapter = {}
    const execution = options(adapter)
    const order: string[] = []
    execution.beforeIO.mockImplementation(async kind => { order.push(`before:${kind}`) })
    execution.afterIO.mockImplementation(async () => { order.push('after') })
    await withDataSourceReadExecution(execution, () => runDataSourceReadIO(adapter, 'query', async signal => {
      expect(signal).toBe(execution.signal)
      order.push('native')
      return true
    }))
    expect(order).toEqual(['before:query', 'native', 'after'])
  })

  it('rejects a different adapter with identical fields before authority or native IO', async () => {
    const adapter = { id: 'same' }
    const execution = options(adapter)
    const native = vi.fn(async () => true)
    await expect(withDataSourceReadExecution(execution, () => runDataSourceReadIO(
      { id: 'same' }, 'query', native,
    ))).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_ADAPTER_MISMATCH' })
    expect(execution.beforeIO).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
  })

  it('makes a caught checkpoint failure sticky and preserves its authority identity', async () => {
    const adapter = {}
    const execution = options(adapter)
    const denied = Object.assign(new Error('AUTHORITY_LOST'), { code: 'AUTHORITY_LOST' })
    execution.beforeIO.mockRejectedValue(denied)
    const native = vi.fn(async () => true)
    await expect(withDataSourceReadExecution(execution, async () => {
      await runDataSourceReadIO(adapter, 'query', native).catch(() => undefined)
      await runDataSourceReadIO(adapter, 'query', native).catch(() => undefined)
      return 'attempted success'
    })).rejects.toBe(denied)
    expect(isDataSourceReadExecutionError(denied)).toBe(true)
    expect(execution.beforeIO).toHaveBeenCalledTimes(1)
    expect(native).not.toHaveBeenCalled()
  })

  it('refuses nested scope replacement even when the caller catches the rejection', async () => {
    const adapter = {}
    const native = vi.fn(async () => true)
    await expect(withDataSourceReadExecution(options(adapter), async () => {
      await withDataSourceReadExecution(options(adapter), native).catch(() => undefined)
      return true
    })).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_NESTED' })
    expect(native).not.toHaveBeenCalled()
  })

  it('rejects detached child work after its parent scope has returned', async () => {
    const adapter = {}
    const gate = deferred<void>()
    const native = vi.fn(async () => true)
    let detached!: Promise<unknown>
    await withDataSourceReadExecution(options(adapter), async () => {
      detached = gate.promise.then(() => runDataSourceReadIO(adapter, 'query', native))
    })
    const rejected = expect(detached).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_CLOSED' })
    gate.resolve()
    await rejected
    expect(native).not.toHaveBeenCalled()
  })

  it('rejects native completion when its detached scope has already returned', async () => {
    const adapter = {}
    const started = deferred<void>()
    const completed = deferred<boolean>()
    const execution = options(adapter)
    let detached!: Promise<unknown>
    await withDataSourceReadExecution(execution, async () => {
      detached = runDataSourceReadIO(adapter, 'query', async () => {
        started.resolve()
        return completed.promise
      })
      await started.promise
    })
    const rejected = expect(detached).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_CLOSED' })
    completed.resolve(true)
    await rejected
    expect(execution.afterIO).not.toHaveBeenCalled()
  })

  it.each(['before', 'checkpoint', 'native', 'after'] as const)('fails closed on abort at %s', async phase => {
    const adapter = {}
    const controller = new AbortController()
    const execution = options(adapter, controller.signal)
    const native = vi.fn(async () => {
      if (phase === 'native') controller.abort()
      return true
    })
    if (phase === 'before') controller.abort()
    if (phase === 'checkpoint') execution.beforeIO.mockImplementation(async () => { controller.abort() })
    if (phase === 'after') execution.afterIO.mockImplementation(async () => { controller.abort() })
    await expect(withDataSourceReadExecution(execution, () => runDataSourceReadIO(adapter, 'query', native)))
      .rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_ABORTED' })
    expect(native).toHaveBeenCalledTimes(phase === 'before' || phase === 'checkpoint' ? 0 : 1)
  })

  it('isolates concurrent scopes on the same adapter and does not poison later unscoped calls', async () => {
    const adapter = {}
    const gate = deferred<void>()
    const denied = options(adapter)
    denied.beforeIO.mockImplementation(async () => {
      await gate.promise
      throw new Error('AUTHORITY_LOST')
    })
    const allowed = options(adapter)
    const blockedNative = vi.fn(async () => true)
    const blocked = withDataSourceReadExecution(denied, () => runDataSourceReadIO(adapter, 'query', blockedNative))
    const rejected = expect(blocked).rejects.toThrow('AUTHORITY_LOST')
    await expect(withDataSourceReadExecution(allowed, () => runDataSourceReadIO(adapter, 'query', async () => 1))).resolves.toBe(1)
    gate.resolve()
    await rejected
    expect(blockedNative).not.toHaveBeenCalled()
    expect(allowed.afterIO).toHaveBeenCalledTimes(1)
    await expect(runDataSourceReadIO(adapter, 'query', async () => 2)).resolves.toBe(2)
  })
})

describe.each(['sqlserver', 'postgres'] as const)('%s native adapter read guards', type => {
  it('reauthorizes each of the four genuine getTableInfo queries', async () => {
    const { adapter, nativeQuery } = fixture(type)
    const execution = options(adapter)
    await withDataSourceReadExecution(execution, () => adapter.getTableInfo('synthetic_table'))
    expect(nativeQuery).toHaveBeenCalledTimes(4)
    expect(execution.beforeIO.mock.calls).toEqual([['query'], ['query'], ['query'], ['query']])
    expect(execution.afterIO).toHaveBeenCalledTimes(4)
  })

  it('stops schema fanout if authority fails before the second native query', async () => {
    const { adapter, nativeQuery } = fixture(type)
    const execution = options(adapter)
    const denied = new Error('AUTHORITY_LOST')
    execution.beforeIO.mockImplementationOnce(async () => {}).mockRejectedValue(denied)
    await expect(withDataSourceReadExecution(execution, () => adapter.getTableInfo('synthetic_table'))).rejects.toBe(denied)
    expect(nativeQuery).toHaveBeenCalledTimes(1)
    expect(execution.afterIO).toHaveBeenCalledTimes(1)
    expect(execution.beforeIO).toHaveBeenCalledTimes(2)
  })

  it('stops schema fanout on second native driver failure instead of returning empty details', async () => {
    const { adapter, nativeQuery } = fixture(type)
    nativeQuery.mockImplementationOnce(async () => ({ rows: [], recordset: [], rowCount: 0, rowsAffected: [0], fields: [] }))
      .mockRejectedValue(new Error('SYNTHETIC_PRIVATE_DRIVER_DETAIL'))
    const execution = options(adapter)
    await expect(withDataSourceReadExecution(execution, () => adapter.getTableInfo('synthetic_table')))
      .rejects.toMatchObject({ message: 'DATA_SOURCE_READ_EXECUTION_IO_FAILED' })
    expect(nativeQuery).toHaveBeenCalledTimes(2)
  })

  it('stops schema fanout when authority is lost after the second query', async () => {
    const { adapter, nativeQuery } = fixture(type)
    const execution = options(adapter)
    const denied = new Error('AUTHORITY_LOST')
    execution.afterIO.mockImplementationOnce(async () => {}).mockRejectedValue(denied)
    await expect(withDataSourceReadExecution(execution, () => adapter.getTableInfo('synthetic_table'))).rejects.toBe(denied)
    expect(nativeQuery).toHaveBeenCalledTimes(2)
    expect(execution.afterIO).toHaveBeenCalledTimes(2)
    expect(execution.beforeIO).toHaveBeenCalledTimes(2)
  })

  it('keeps a caught native error sticky without exposing driver details', async () => {
    const { adapter, nativeQuery } = fixture(type)
    nativeQuery.mockRejectedValue(new Error('SYNTHETIC_PRIVATE_DRIVER_DETAIL'))
    await expect(withDataSourceReadExecution(options(adapter), async () => {
      await adapter.query('SELECT 1').catch(() => undefined)
      return true
    })).rejects.toMatchObject({ message: 'DATA_SOURCE_READ_EXECUTION_IO_FAILED' })
  })

  it('does not swallow health-check authority failures or emit raw adapter errors', async () => {
    const { adapter, nativeQuery } = fixture(type)
    const emit = vi.spyOn(adapter, 'emit')
    const execution = options(adapter)
    const denied = new Error('AUTHORITY_LOST')
    execution.beforeIO.mockRejectedValue(denied)
    await expect(withDataSourceReadExecution(execution, () => adapter.testConnection())).rejects.toBe(denied)
    expect(nativeQuery).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('guards native connect and the connect health query', async () => {
    const { adapter, pool, nativeQuery } = fixture(type, false)
    const execution = options(adapter)
    await withDataSourceReadExecution(execution, () => adapter.connect())
    expect(adapter.isConnected()).toBe(true)
    expect(nativeQuery).toHaveBeenCalledTimes(1)
    expect(pool.connect).toHaveBeenCalledTimes(type === 'sqlserver' ? 1 : 0)
    expect(execution.beforeIO.mock.calls).toEqual(type === 'sqlserver' ? [['connect'], ['query']] : [['query']])
    expect(execution.afterIO).toHaveBeenCalledTimes(type === 'sqlserver' ? 2 : 1)
  })

  it('blocks connect before native IO and never emits a checkpoint error', async () => {
    const { adapter, pool, nativeQuery } = fixture(type, false)
    const emit = vi.spyOn(adapter, 'emit')
    const execution = options(adapter)
    const denied = new Error('AUTHORITY_LOST')
    execution.beforeIO.mockRejectedValue(denied)
    await expect(withDataSourceReadExecution(execution, () => adapter.connect())).rejects.toBe(denied)
    expect(pool.connect).not.toHaveBeenCalled()
    expect(nativeQuery).not.toHaveBeenCalled()
    expect(pool.close).not.toHaveBeenCalled()
    expect(pool.end).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(adapter.isConnected()).toBe(false)
  })

  it('retains the established unscoped query failure result', async () => {
    const { adapter, nativeQuery } = fixture(type)
    const failure = new Error('SYNTHETIC_DRIVER_FAILURE')
    nativeQuery.mockRejectedValue(failure)
    await expect(adapter.query('SELECT 1')).resolves.toEqual({ data: [], error: failure })
  })

  it('closes only the unpublished connect candidate when its post-IO checkpoint fails', async () => {
    const { adapter, pool, nativeQuery } = fixture(type, false)
    const sharedPool = { close: vi.fn(), end: vi.fn() }
    const internal = adapter as unknown as { pool: unknown; connected: boolean }
    internal.pool = sharedPool
    const execution = options(adapter)
    const denied = new Error('AUTHORITY_LOST_AFTER_CONNECT')
    execution.afterIO.mockRejectedValue(denied)
    await expect(withDataSourceReadExecution(execution, () => adapter.connect())).rejects.toBe(denied)
    expect(type === 'sqlserver' ? pool.close : pool.end).toHaveBeenCalledTimes(1)
    expect(sharedPool.close).not.toHaveBeenCalled()
    expect(sharedPool.end).not.toHaveBeenCalled()
    expect(internal.pool).toBe(sharedPool)
    expect(internal.connected).toBe(false)
    expect(nativeQuery).toHaveBeenCalledTimes(type === 'sqlserver' ? 0 : 1)
  })

  it('waits for in-flight connect settlement before cleaning its aborted candidate', async () => {
    const { adapter, pool, nativeQuery } = fixture(type, false)
    const controller = new AbortController()
    const started = deferred<void>()
    const completed = deferred<void>()
    if (type === 'sqlserver') pool.connect.mockImplementation(async () => {
      started.resolve(); await completed.promise; return pool
    })
    else nativeQuery.mockImplementation(async () => {
      started.resolve(); await completed.promise
      return { rows: [], recordset: [], rowCount: 0, rowsAffected: [0], fields: [] }
    })
    const execution = options(adapter, controller.signal)
    const connecting = withDataSourceReadExecution(execution, () => adapter.connect())
    const rejected = expect(connecting).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_ABORTED' })
    await started.promise
    controller.abort()
    expect(pool.close).not.toHaveBeenCalled()
    expect(pool.end).not.toHaveBeenCalled()
    completed.resolve()
    await rejected
    expect(type === 'sqlserver' ? pool.close : pool.end).toHaveBeenCalledTimes(1)
    expect(adapter.isConnected()).toBe(false)
    expect(execution.afterIO).not.toHaveBeenCalled()
  })

  it('blocks streaming before starting native IO or returning a retained iterator', async () => {
    const { adapter, pool, nativeQuery } = fixture(type)
    await expect(withDataSourceReadExecution(options(adapter), () => adapter.stream('SELECT 1').next()))
      .rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_OPERATION_UNSUPPORTED' })
    expect(pool.connect).not.toHaveBeenCalled()
    expect(nativeQuery).not.toHaveBeenCalled()
  })

  it('retains unscoped connect, health-check and disconnect behavior', async () => {
    const { adapter, pool, nativeQuery } = fixture(type, false)
    nativeQuery.mockResolvedValue({ rows: [{ ok: 1 }], recordset: [{ ok: 1 }], rowCount: 1, rowsAffected: [1], fields: [] })
    await adapter.connect()
    expect(adapter.isConnected()).toBe(true)
    await expect(adapter.testConnection()).resolves.toBe(true)
    await adapter.disconnect()
    expect(adapter.isConnected()).toBe(false)
    expect(type === 'sqlserver' ? pool.close : pool.end).toHaveBeenCalledTimes(1)
  })

  it('retains unscoped failed-connect pool cleanup and error reporting', async () => {
    const { adapter, pool, nativeQuery } = fixture(type, false)
    const onError = vi.fn()
    adapter.on('error', onError)
    nativeQuery.mockRejectedValue(new Error('SYNTHETIC_DRIVER_FAILURE'))
    await expect(adapter.connect()).rejects.toThrow(type === 'sqlserver' ? 'Failed to connect to SQL Server' : 'Failed to connect to PostgreSQL')
    expect(adapter.isConnected()).toBe(false)
    expect(type === 'sqlserver' ? pool.close : pool.end).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it.each(['beginTransaction', 'commit', 'rollback', 'inTransaction'] as const)('blocks %s before any transaction IO in a scope', async method => {
    const { adapter, pool } = fixture(type)
    const transaction = { commit: vi.fn(), rollback: vi.fn(), query: vi.fn(), release: vi.fn() }
    const callback = vi.fn(async () => true)
    await expect(withDataSourceReadExecution(options(adapter), async () => {
      if (method === 'beginTransaction') return await adapter.beginTransaction()
      if (method === 'inTransaction') return await adapter.inTransaction(transaction as unknown as Transaction, callback)
      return await adapter[method](transaction as unknown as Transaction)
    })).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_OPERATION_UNSUPPORTED' })
    expect(pool.connect).not.toHaveBeenCalled()
    expect(transaction.commit).not.toHaveBeenCalled()
    expect(transaction.rollback).not.toHaveBeenCalled()
    expect(transaction.query).not.toHaveBeenCalled()
    expect(transaction.release).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('readonly facade column projection with the genuine PostgreSQL adapter', () => {
  function columnFixture() {
    const f = fixture('postgres')
    f.nativeQuery.mockImplementation(async sql => ({
      rows: sql.includes('FROM information_schema.columns c')
        ? [{ column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null, comment: 'synthetic-column' }]
        : [],
      recordset: [], rowCount: 0, rowsAffected: [0], fields: [],
    }))
    const manager = {
      assertAccess: vi.fn((_id: string, principal: string) => {
        if (principal !== 'synthetic-owner') throw new Error('not found')
      }),
      getDataSource: vi.fn(() => f.adapter),
      getLoadedValidationRevision: vi.fn(() => 'synthetic-revision'),
      connectDataSource: vi.fn(async () => { throw new Error('attached adapter must not reconnect') }),
    }
    return { ...f, manager, facade: createDataSourcePluginFacade(() => manager as unknown as DataSourceManager) }
  }

  it('returns the genuine getColumns mapping with one query/two checkpoints instead of four queries/eight checkpoints', async () => {
    const { adapter, nativeQuery, manager, facade } = columnFixture()
    expect(adapter).toBeInstanceOf(PostgresAdapter)
    const expectedColumns = await adapter.getColumns('synthetic_table', 'public')
    expect(expectedColumns).toEqual([{ name: 'id', type: 'integer', nullable: false, defaultValue: null, comment: 'synthetic-column' }])
    nativeQuery.mockClear()
    const validation = { expectedValidationRevision: 'synthetic-revision' }
    const fullExecution = options(adapter)
    const full = await withDataSourceReadExecution(fullExecution, () => facade.getTableInfo(
      'synthetic-read-source', 'synthetic_table', 'synthetic-owner', 'public', validation,
    ))
    expect(full.columns).toEqual(expectedColumns)
    expect(nativeQuery).toHaveBeenCalledTimes(4)
    expect(fullExecution.beforeIO.mock.calls).toEqual([['query'], ['query'], ['query'], ['query']])
    expect(fullExecution.afterIO).toHaveBeenCalledTimes(4)
    nativeQuery.mockClear()
    const execution = options(adapter)
    const columns = await withDataSourceReadExecution(execution, () => facade.getTableInfo(
      'synthetic-read-source', 'synthetic_table', 'synthetic-owner', 'public', validation, 'columns',
    ))
    expect(columns).toEqual({ name: 'synthetic_table', schema: 'public', columns: expectedColumns, columnsLoaded: true })
    for (const absent of ['primaryKey', 'indexes', 'foreignKeys']) expect(columns).not.toHaveProperty(absent)
    expect(nativeQuery).toHaveBeenCalledTimes(1)
    expect(nativeQuery.mock.calls[0][0]).toContain('FROM information_schema.columns c')
    expect(execution.beforeIO.mock.calls).toEqual([['query']])
    expect(execution.afterIO).toHaveBeenCalledTimes(1)
    expect(manager.assertAccess).toHaveBeenNthCalledWith(2, 'synthetic-read-source', 'synthetic-owner')
    expect(manager.connectDataSource).not.toHaveBeenCalled()
  })

  it.each(['abort-after-native', 'revoke-after-native'] as const)('rejects %s and a caught retry without additional native IO', async phase => {
    const { adapter, nativeQuery, facade } = columnFixture()
    const controller = new AbortController()
    const execution = options(adapter, controller.signal)
    const denied = new Error('AUTHORITY_LOST_AFTER_COLUMNS')
    if (phase === 'abort-after-native') {
      nativeQuery.mockImplementation(async () => {
        controller.abort()
        return { rows: [], recordset: [], rowCount: 0, rowsAffected: [0], fields: [] }
      })
    } else execution.afterIO.mockRejectedValue(denied)
    const read = () => facade.getTableInfo(
      'synthetic-read-source', 'synthetic_table', 'synthetic-owner', 'public',
      { expectedValidationRevision: 'synthetic-revision' }, 'columns',
    )
    const attempted = withDataSourceReadExecution(execution, async () => {
      await read().catch(() => undefined)
      await read().catch(() => undefined)
      return 'must not succeed after losing authority'
    })
    if (phase === 'abort-after-native') await expect(attempted).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_ABORTED' })
    else await expect(attempted).rejects.toBe(denied)
    expect(nativeQuery).toHaveBeenCalledTimes(1)
    expect(execution.beforeIO).toHaveBeenCalledTimes(1)
    expect(execution.afterIO).toHaveBeenCalledTimes(phase === 'abort-after-native' ? 0 : 1)
  })
})

describe('driver-specific cancellation and unsupported IO', () => {
  it('cancels only the active MSSQL request and leaves the shared pool and other requests usable', async () => {
    const { adapter, nativeQuery, pool, requests } = fixture('sqlserver')
    const controller = new AbortController()
    const started = deferred<void>()
    const completed = deferred<Awaited<ReturnType<typeof nativeQuery>>>()
    nativeQuery.mockImplementationOnce(async () => {
      started.resolve()
      return completed.promise
    })
    const active = withDataSourceReadExecution(options(adapter, controller.signal), () => adapter.query('SELECT 1'))
    const rejected = expect(active).rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_ABORTED' })
    await started.promise
    await withDataSourceReadExecution(options(adapter), () => adapter.query('SELECT 2'))
    controller.abort()
    expect(requests[0].cancel).toHaveBeenCalledTimes(1)
    expect(requests[1].cancel).not.toHaveBeenCalled()
    expect(pool.close).not.toHaveBeenCalled()
    expect(pool.end).not.toHaveBeenCalled()
    completed.resolve({ rows: [], recordset: [], rowCount: 0, rowsAffected: [0], fields: [] })
    await rejected
    await expect(adapter.query('SELECT 3')).resolves.toMatchObject({ data: [] })
  })

  it('rejects PostgreSQL streaming before acquiring a vended client', async () => {
    const { adapter, pool, nativeQuery } = fixture('postgres')
    await expect(withDataSourceReadExecution(options(adapter), () => adapter.stream('SELECT 1').next()))
      .rejects.toMatchObject({ code: 'DATA_SOURCE_READ_EXECUTION_OPERATION_UNSUPPORTED' })
    expect(pool.connect).not.toHaveBeenCalled()
    expect(nativeQuery).not.toHaveBeenCalled()
  })
})
