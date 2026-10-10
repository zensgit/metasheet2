import { describe, expect, it } from 'vitest'
import type {
  ColumnInfo,
  DataSourceConfig,
  DbValue,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
  Transaction,
} from '../../src/data-adapters/BaseAdapter'
import { BaseDataAdapter } from '../../src/data-adapters/BaseAdapter'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import {
  createDataSourcePluginFacade,
  DATA_SOURCE_NOT_FOUND_CODE,
  DATA_SOURCE_PRINCIPAL_REQUIRED_CODE,
  DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE,
  type DataSourceValidationReadOptions,
} from '../../src/data-adapters/data-source-plugin-facade'

/**
 * The migration and integration_data_source_validation_revisions mirror are not
 * imported or stubbed. A query against that mirror throws. A later read of the
 * data_sources row sees POISON, never the revision the manager may publish.
 */
const REVISION_MISMATCH = 'DATA_SOURCE_VALIDATION_REVISION_MISMATCH'
const OWNER = 'owner-current'
const OTHER = 'owner-other'
const TENANT = 'tenant-1'
const WORKSPACE = 'ws-1'
const REV_INSERT = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1'
const REV_LOADED = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBB2'
const REV_OLD = 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCC3'
const REV_NEW = 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDD4'
const REV_UPDATE = 'EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEE5'
const REV_EXEC = '99999999-9999-4999-8999-999999999999'
const REV_SECOND = '22222222-2222-4222-8222-222222222222'
const REV_OTHER = '11111111-1111-4111-8111-111111111111'
const ATTESTABLE_REVISION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POISON = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
const MIRROR = 'integration_data_source_validation_revisions'
const SQL_TYPES = ['mysql', 'postgres', 'postgresql', 'sqlserver'] as const

type ScopeOptions = { ownerId: string, workspaceId: string, tenantId: string, scopeKind: 'private' }
type Statement = { verb: string, table: string, returning: string[], select: string[] }
type Row = Record<string, unknown> & { id?: string, validation_revision?: unknown, is_active?: boolean, deleted_at?: unknown }

function scopeOptions(): ScopeOptions {
  return { ownerId: OWNER, workspaceId: WORKSPACE, tenantId: TENANT, scopeKind: 'private' }
}

function sourceConfig(id: string, type = 'sqlserver'): DataSourceConfig {
  return {
    id,
    name: id,
    type,
    connection: {
      host: 'db.example.test',
      port: 1433,
      database: 'erp',
      socket: { server: 'original-server' },
    },
    credentials: { username: 'reader' },
    options: { autoConnect: false, readOnly: true, label: 'original-label' },
    poolConfig: { min: 1, max: 4, idleTimeout: 10 },
  }
}

class ProbeAdapter extends BaseDataAdapter {
  readonly stats = { connect: 0, disconnect: 0, query: 0, select: 0, schema: 0, table: 0, columns: 0, config: 0 }
  selectArgs: QueryOptions[] = []
  schemaArgs: unknown[][] = []
  tableArgs: unknown[][] = []
  columnArgs: unknown[][] = []
  hook: (() => Promise<void>) | null = null

  override getConfig(): DataSourceConfig {
    this.stats.config += 1
    return super.getConfig()
  }

  async connect(): Promise<void> {
    this.stats.connect += 1
    if (this.hook) await this.hook()
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.stats.disconnect += 1
    this.connected = false
  }

  isConnected(): boolean { return this.connected }
  async testConnection(): Promise<boolean> { return true }
  async query<T = Record<string, DbValue>>(): Promise<QueryResult<T>> {
    this.stats.query += 1
    return { data: [] }
  }

  async select<T = Record<string, DbValue>>(_table: string, options?: QueryOptions): Promise<QueryResult<T>> {
    this.stats.select += 1
    this.selectArgs.push(options ?? {})
    return { data: [{ sku: 'captured' } as T] }
  }

  async insert<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async update<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async delete<T = Record<string, DbValue>>(): Promise<QueryResult<T>> { return { data: [] } }
  async getSchema(schema?: string, options?: unknown): Promise<SchemaInfo> {
    this.stats.schema += 1
    this.schemaArgs.push([schema, options])
    return { tables: [{ name: 'items', schema: schema ?? 'dbo', columns: [] }] }
  }

  async getTableInfo(table: string, schema?: string): Promise<TableInfo> {
    this.stats.table += 1
    this.tableArgs.push([table, schema])
    return { name: table, schema, columns: [] }
  }

  async getColumns(table: string, schema?: string): Promise<ColumnInfo[]> {
    this.stats.columns += 1
    this.columnArgs.push([table, schema])
    return [{ name: 'sku', type: 'varchar', nullable: false }]
  }
  async tableExists(): Promise<boolean> { return true }
  async beginTransaction(): Promise<Transaction> { return {} }
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async inTransaction<R>(_transaction: Transaction, callback: () => Promise<R>): Promise<R> { return callback() }
  async *stream<T = Record<string, DbValue>>(): AsyncIterableIterator<T> {}
}

function installProbes(manager: DataSourceManager): void {
  for (const type of SQL_TYPES) manager.registerAdapterType(type, ProbeAdapter as never)
}

function createDb(options: { withReturning?: boolean, executeFallback?: unknown, mutateOnWrite?: () => void } = {}) {
  const withReturning = options.withReturning !== false
  const executeFallback = options.executeFallback ?? [{ numInsertedOrUpdatedRows: 1 }]
  const rows = new Map<string, Row>()
  const queue: unknown[] = []
  const statements: Statement[] = []
  const executeResults: unknown[] = []

  function pull(): unknown {
    if (queue.length === 0) throw new Error('SA02N fake db ran out of RETURNING values')
    return queue.shift()
  }

  function refuse(table: string, verb: string): void {
    statements.push({ verb, table, returning: [], select: [] })
    if (table === MIRROR) throw new Error('SA02N revision mirror queried')
    throw new Error(`SA02N unexpected ${verb} ${table}`)
  }

  function selectBuilder(table: string) {
    if (table === 'integration_external_systems') {
      const count = {
        select: () => count,
        where: () => count,
        groupBy: () => count,
        execute: async () => {
          statements.push({ verb: 'select', table, returning: [], select: ['count'] })
          return [{ count: 0 }]
        },
      }
      return count
    }
    if (table !== 'data_sources') refuse(table, 'select')
    const selected: string[] = []
    let whereId: string | undefined
    const builder = {
      selectAll: () => builder,
      select: (column: unknown) => { selected.push(typeof column === 'string' ? column : 'expr'); return builder },
      where: (...args: unknown[]) => {
        if (args[0] === 'id' && args[1] === '=' && typeof args[2] === 'string') whereId = args[2]
        return builder
      },
      forUpdate: () => builder,
      execute: async () => {
        statements.push({ verb: 'select', table, returning: [], select: [...selected] })
        if (selected.includes('validation_revision')) throw new Error('SA02N fresh validation_revision read')
        let matched = [...rows.values()].filter(row => row.is_active === true && row.deleted_at == null)
        if (whereId) matched = matched.filter(row => row.id === whereId)
        const copies = matched.map(row => ({ ...row }))
        for (const row of matched) row.validation_revision = POISON
        return copies
      },
    }
    return builder
  }

  function insertBuilder() {
    let pending: Row = {}
    let updateSet: Row | undefined
    const returning: string[] = []
    const builder: Record<string, unknown> = {
      values: (value: Row) => { pending = value; return builder },
      onConflict: (callback: (conflict: unknown) => unknown) => {
        const conflict = { column: () => ({ doUpdateSet: (set: Row) => { updateSet = set; return conflict } }) }
        callback(conflict)
        return builder
      },
      execute: async () => {
        const id = String(pending.id)
        if (rows.has(id) && updateSet) rows.set(id, { ...rows.get(id), ...updateSet, validation_revision: POISON })
        else rows.set(id, { ...pending, validation_revision: POISON })
        options.mutateOnWrite?.()
        statements.push({ verb: 'insert', table: 'data_sources', returning: [...returning], select: [] })
        const result = returning.length > 0
          ? [{ validation_revision: pull() }, { validation_revision: REV_SECOND }]
          : executeFallback
        executeResults.push(result)
        return result
      },
    }
    if (withReturning) builder.returning = (column: string) => { returning.push(column); return builder }
    return builder
  }

  function updateBuilder() {
    let setObj: Row = {}
    let whereId: string | undefined
    const returning: string[] = []
    const builder: Record<string, unknown> = {
      set: (value: Row) => { setObj = value; return builder },
      where: (...args: unknown[]) => {
        if (args[0] === 'id' && args[1] === '=' && typeof args[2] === 'string') whereId = args[2]
        return builder
      },
      execute: async () => {
        if (whereId && rows.has(whereId)) rows.set(whereId, { ...rows.get(whereId), ...setObj, validation_revision: POISON })
        options.mutateOnWrite?.()
        statements.push({ verb: 'update', table: 'data_sources', returning: [...returning], select: [] })
        const result = returning.length > 0
          ? [{ validation_revision: pull() }, { validation_revision: REV_SECOND }]
          : executeFallback
        executeResults.push(result)
        return result
      },
    }
    if (withReturning) builder.returning = (column: string) => { returning.push(column); return builder }
    return builder
  }

  function deleteBuilder() {
    let whereId: string | undefined
    const builder = {
      where: (...args: unknown[]) => {
        if (args[0] === 'id' && args[1] === '=' && typeof args[2] === 'string') whereId = args[2]
        return builder
      },
      execute: async () => {
        if (whereId) rows.delete(whereId)
        statements.push({ verb: 'delete', table: 'data_sources', returning: [], select: [] })
        return []
      },
    }
    return builder
  }

  const executor = {
    selectFrom: (table: string) => selectBuilder(table),
    insertInto: (table: string) => table === 'data_sources' ? insertBuilder() : refuse(table, 'insert'),
    updateTable: (table: string) => table === 'data_sources' ? updateBuilder() : refuse(table, 'update'),
    deleteFrom: (table: string) => table === 'data_sources' ? deleteBuilder() : refuse(table, 'delete'),
  }
  return {
    rows,
    queue,
    statements,
    executeResults,
    db: { ...executor, transaction: () => ({ execute: async <T>(callback: (trx: typeof executor) => Promise<T>) => callback(executor) }) },
  }
}

function managerWith(db: ReturnType<typeof createDb>['db'] | undefined): DataSourceManager {
  const manager = db ? new DataSourceManager({ db: db as never }) : new DataSourceManager()
  installProbes(manager)
  return manager
}

function watch(manager: DataSourceManager) {
  const calls = { getDataSource: 0, connectDataSource: 0, select: 0, query: 0 }
  const original = {
    getDataSource: manager.getDataSource.bind(manager),
    connectDataSource: manager.connectDataSource.bind(manager),
    select: manager.select.bind(manager),
    query: manager.query.bind(manager),
  }
  manager.getDataSource = ((id: string) => { calls.getDataSource += 1; return original.getDataSource(id) }) as typeof manager.getDataSource
  manager.connectDataSource = (async (id: string) => { calls.connectDataSource += 1; return original.connectDataSource(id) }) as typeof manager.connectDataSource
  manager.select = (async (...args: Parameters<DataSourceManager['select']>) => { calls.select += 1; return original.select(...args) }) as typeof manager.select
  manager.query = (async (...args: Parameters<DataSourceManager['query']>) => { calls.query += 1; return original.query(...args) }) as typeof manager.query
  return calls
}

async function rejected(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error as Error & { code?: string }
    throw error
  }
  throw new Error('expected the call to be refused')
}

function loadedRow(id: string, revision: unknown, config?: Record<string, unknown>): Row {
  return {
    id,
    name: id,
    type: 'sqlserver',
    description: null,
    config: config ?? {
      connection: { host: 'db.example.test', port: 1433, database: 'erp' },
      options: { autoConnect: false, readOnly: true },
    },
    validation_revision: revision,
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: OWNER,
    workspace_id: WORKSPACE,
    tenant_id: TENANT,
    scope_kind: 'private',
    is_active: true,
    auto_connect: false,
    deleted_at: null,
    metadata: null,
    tags: null,
  }
}

async function addReturning(id = 'src-insert', revision: unknown = REV_INSERT) {
  const db = createDb()
  db.queue.push(revision)
  const manager = managerWith(db.db)
  const config = sourceConfig(id)
  await manager.addDataSource(config, scopeOptions())
  return { db, manager, config, id }
}

function readsOf(db: ReturnType<typeof createDb>, table = 'data_sources') {
  return db.statements.filter(statement => statement.verb === 'select' && statement.table === table)
}

describe('DataSourceManager loaded validation revision', () => {
  it('binds the exact RETURNING value and does not relabel the installed adapter from a later row', async () => {
    const { db, manager, id } = await addReturning()
    const adapter = manager.getDataSource(id)
    expect(db.statements).toEqual([{ verb: 'insert', table: 'data_sources', returning: ['validation_revision'], select: [] }])
    expect(db.executeResults).toEqual([[
      { validation_revision: REV_INSERT },
      { validation_revision: REV_SECOND },
    ]])
    expect(readsOf(db)).toHaveLength(0)
    expect(db.statements.some(statement => statement.table === MIRROR)).toBe(false)
    expect(db.rows.get(id)?.validation_revision).toBe(POISON)
    expect(manager.getLoadedValidationRevision(id, adapter)).toBe(REV_INSERT)
    expect(manager.getLoadedValidationRevision(id, adapter)).not.toBe(REV_SECOND)

    const before = db.statements.length
    expect(manager.getLoadedValidationRevision(id)).toBe(REV_INSERT)
    expect(db.statements).toHaveLength(before)

    await manager.loadFromDatabase()
    expect(readsOf(db)).toHaveLength(1)
    expect(db.rows.get(id)?.validation_revision).toBe(POISON)
    expect(manager.getDataSource(id)).toBe(adapter)
    expect(manager.getLoadedValidationRevision(id, adapter)).toBe(REV_INSERT)
  })

  it('binds the exact loaded row and ignores the revision stored after that read', async () => {
    const db = createDb()
    db.rows.set('src-loaded', loadedRow('src-loaded', REV_LOADED))
    const manager = managerWith(db.db)
    await manager.loadFromDatabase()
    const adapter = manager.getDataSource('src-loaded')
    expect(readsOf(db)).toHaveLength(1)
    expect(readsOf(db)[0]?.select).toEqual([])
    expect(db.rows.get('src-loaded')?.validation_revision).toBe(POISON)
    expect(manager.getLoadedValidationRevision('src-loaded', adapter)).toBe(REV_LOADED)

    const before = db.statements.length
    expect(manager.getLoadedValidationRevision('src-loaded')).toBe(REV_LOADED)
    expect(db.statements).toHaveLength(before)
    await manager.loadFromDatabase()
    expect(manager.getLoadedValidationRevision('src-loaded', adapter)).toBe(REV_LOADED)
  })

  it.each([
    ['empty string', ''],
    ['spaces', '   '],
    ['prose', 'not-a-uuid'],
    ['padded uuid', `${REV_INSERT} `],
    ['null', null],
    ['number', 7],
  ])('does not publish a %s RETURNING value', async (_label, revision) => {
    const { manager, id } = await addReturning('src-invalid', revision)
    expect(manager.getDataSource(id).getType()).toBe('sqlserver')
    expect(manager.getLoadedValidationRevision(id)).toBeUndefined()
    expect(manager.getLoadedValidationRevision(id, manager.getDataSource(id))).toBeUndefined()
  })

  it('does not publish a revision for a memory-only source', async () => {
    const manager = managerWith(undefined)
    const id = 'src-memory'
    await manager.addDataSource(sourceConfig(id), scopeOptions())
    expect(manager.getLoadedValidationRevision(id)).toBeUndefined()
    expect(manager.getLoadedValidationRevision(id, manager.getDataSource(id))).toBeUndefined()
    const facade = createDataSourcePluginFacade(() => manager)
    const registration = await facade.resolveConnectionRegistration(id, { tenantId: TENANT, principal: OWNER, runAs: 'user' })
    expect(registration).toEqual({ id, type: 'sqlserver', tenantId: TENANT, scopeKind: 'private' })
    expect(registration).not.toHaveProperty('validationRevision')
    expect((manager.getDataSource(id) as ProbeAdapter).stats.connect).toBe(0)
  })

  it('does not publish a revision when persistence is off', async () => {
    const db = createDb()
    db.queue.push(REV_INSERT)
    const manager = managerWith(db.db)
    const id = 'src-unpersisted'
    await manager.addDataSource(sourceConfig(id), { ...scopeOptions(), persist: false })
    expect(db.statements).toEqual([])
    expect(manager.getLoadedValidationRevision(id)).toBeUndefined()
  })

  it('does not let an execute-only InsertResult attest a revision', async () => {
    const db = createDb({ withReturning: false })
    const manager = managerWith(db.db)
    const id = 'src-insert-result'
    await manager.addDataSource(sourceConfig(id), scopeOptions())
    expect(db.statements).toEqual([{ verb: 'insert', table: 'data_sources', returning: [], select: [] }])
    expect(manager.getLoadedValidationRevision(id)).toBeUndefined()
  })

  it('ignores an execute-only poison revision after the write', async () => {
    const db = createDb({ withReturning: false, executeFallback: [{ validation_revision: REV_EXEC }] })
    const manager = managerWith(db.db)
    const id = 'src-execute-row'
    await manager.addDataSource(sourceConfig(id), scopeOptions())
    expect(REV_EXEC).toMatch(ATTESTABLE_REVISION)
    expect(db.statements).toEqual([{ verb: 'insert', table: 'data_sources', returning: [], select: [] }])
    expect(db.executeResults).toEqual([[{ validation_revision: REV_EXEC }]])
    expect(manager.getDataSource(id)).toBeInstanceOf(ProbeAdapter)
    expect(manager.getLoadedValidationRevision(id, manager.getDataSource(id))).toBeUndefined()
  })

  it('installs a loaded row with an unusable revision without publishing one', async () => {
    const db = createDb()
    db.rows.set('src-bad-load', loadedRow('src-bad-load', 'not-a-uuid'))
    const manager = managerWith(db.db)
    await manager.loadFromDatabase()
    expect(manager.getDataSource('src-bad-load')).toBeInstanceOf(ProbeAdapter)
    expect(manager.getLoadedValidationRevision('src-bad-load')).toBeUndefined()
  })

  it('does not publish a row revision when the adapter never installed', async () => {
    const db = createDb()
    db.rows.set('src-unreadable', loadedRow('src-unreadable', REV_OLD, {
      connection: { host: 'db.example.test', port: 1433, database: 'erp' },
      credentials: { password: 'enc:not-a-ciphertext' },
      options: { autoConnect: false, readOnly: true },
    }))
    const manager = managerWith(db.db)
    await manager.loadFromDatabase()
    expect(manager.getLoadState('src-unreadable')).toBe('credentials_unreadable')
    expect(manager.getLoadedValidationRevision('src-unreadable')).toBeUndefined()
    expect(db.rows.get('src-unreadable')?.validation_revision).toBe(POISON)
  })
})

describe('validation metadata, scope copy, and SQL snapshot', () => {
  it('getLoadedValidationRevision is metadata-only and pins the installed adapter', async () => {
    const { db, manager, id } = await addReturning('src-pin')
    const adapter = manager.getDataSource(id) as ProbeAdapter
    const beforeStats = { ...adapter.stats }
    const beforeStatements = db.statements.length
    expect(manager.getLoadedValidationRevision(id, adapter)).toBe(REV_INSERT)
    expect(manager.getLoadedValidationRevision(id)).toBe(REV_INSERT)
    const stranger = new ProbeAdapter(adapter.getConfig())
    expect(manager.getLoadedValidationRevision(id, stranger)).toBeUndefined()
    expect(adapter.stats).toEqual({ ...beforeStats, config: beforeStats.config + 1 })
    expect(stranger.stats).toEqual({ connect: 0, disconnect: 0, query: 0, select: 0, schema: 0, table: 0, columns: 0, config: 0 })
    expect(db.statements).toHaveLength(beforeStatements)
    expect(manager.getLoadedValidationRevision(id, adapter)).toBe(REV_INSERT)
  })

  it('compares the live scope with the copied scope', async () => {
    const { manager, id } = await addReturning('src-scope')
    const adapter = manager.getDataSource(id)
    const live = manager.getScope(id)
    expect(live).toBeDefined()
    if (!live) throw new Error('scope missing')
    const original = { ...live }
    for (const [key, changed] of [
      ['ownerId', OTHER],
      ['tenantId', 'tenant-other'],
      ['workspaceId', 'ws-other'],
      ['scopeKind', 'workspace'],
    ] as const) {
      (live as unknown as Record<string, string>)[key] = changed
      expect(manager.getLoadedValidationRevision(id, adapter)).toBeUndefined()
      Object.assign(live, original)
      expect(manager.getLoadedValidationRevision(id, adapter)).toBe(REV_INSERT)
    }
  })

  it.each(SQL_TYPES)('deep-snapshots the caller %s config before the write resolves', async (type) => {
    const caller = sourceConfig(`src-snap-${type}`, type)
    caller.credentials = { password: 'original-secret', username: 'reader' }
    const db = createDb({ mutateOnWrite: () => {
      caller.connection.host = 'mutated-host'
      ;(caller.connection.socket as { server: string }).server = 'mutated-server'
      caller.poolConfig!.max = 99
      caller.credentials!.password = 'mutated-secret'
      caller.options!.label = 'mutated-label'
    } })
    db.queue.push(REV_INSERT)
    const manager = managerWith(db.db)
    await manager.addDataSource(caller, scopeOptions())
    const installed = manager.getDataSource(caller.id).getConfig()
    expect(caller.connection.host).toBe('mutated-host')
    expect(installed.connection.host).toBe('db.example.test')
    expect(installed.connection.socket).toEqual({ server: 'original-server' })
    expect(installed.connection).not.toBe(caller.connection)
    expect(installed.connection.socket).not.toBe(caller.connection.socket)
    expect(installed.poolConfig).toEqual({ min: 1, max: 4, idleTimeout: 10 })
    expect(installed.poolConfig).not.toBe(caller.poolConfig)
    expect(installed.credentials).toEqual({ password: 'original-secret', username: 'reader' })
    expect(installed.credentials).not.toBe(caller.credentials)
    expect(installed.options?.label).toBe('original-label')
    expect(db.rows.get(caller.id)?.config).toMatchObject({
      connection: { host: 'db.example.test', socket: { server: 'original-server' } },
      poolConfig: { max: 4 },
    })
    expect(manager.getLoadedValidationRevision(caller.id)).toBe(REV_INSERT)
  })

  it('deep-snapshots a memory-only sqlserver config before installation', async () => {
    const caller = sourceConfig('src-memory-snap')
    caller.credentials = { password: 'original-secret' }
    const manager = managerWith(undefined)
    const pending = manager.addDataSource(caller, { ...scopeOptions(), persist: false })
    caller.connection.host = 'mutated-host'
    ;(caller.connection.socket as { server: string }).server = 'mutated-server'
    caller.poolConfig!.max = 99
    caller.credentials.password = 'mutated-secret'
    await pending
    const installed = manager.getDataSource(caller.id).getConfig()
    expect(installed.connection.host).toBe('db.example.test')
    expect(installed.connection.socket).toEqual({ server: 'original-server' })
    expect(installed.poolConfig?.max).toBe(4)
    expect(installed.credentials?.password).toBe('original-secret')
    expect(manager.getLoadedValidationRevision(caller.id)).toBeUndefined()
  })
})

describe('reseal RETURNING capture', () => {
  async function unreadable(options: { withReturning?: boolean, executeFallback?: unknown }) {
    const db = createDb(options)
    db.rows.set('src-reseal', loadedRow('src-reseal', REV_OLD, {
      connection: { host: 'db.example.test', port: 1433, database: 'erp' },
      credentials: { password: 'enc:not-a-ciphertext' },
      options: { autoConnect: false, readOnly: true },
    }))
    const manager = managerWith(db.db)
    await manager.loadFromDatabase()
    const stored = db.rows.get('src-reseal')
    if (!stored) throw new Error('reseal row missing')
    stored.validation_revision = REV_OLD
    return { db, manager }
  }

  it('binds the new RETURNING revision, not the locked row or a later stored revision', async () => {
    const { db, manager } = await unreadable({})
    db.queue.push(REV_NEW)
    const result = await manager.resealLoadFailedDataSource('src-reseal', { password: 'replacement-secret' }, OWNER)
    expect(result.restartRequired).toBe(false)
    const adapter = manager.getDataSource('src-reseal')
    expect(db.executeResults).toEqual([[
      { validation_revision: REV_NEW },
      { validation_revision: REV_SECOND },
    ]])
    expect(db.statements.some(statement => statement.verb === 'update' && statement.returning.includes('validation_revision'))).toBe(true)
    expect(db.statements.some(statement => statement.table === MIRROR)).toBe(false)
    expect(db.rows.get('src-reseal')?.validation_revision).toBe(POISON)
    expect(manager.getLoadedValidationRevision('src-reseal', adapter)).toBe(REV_NEW)
    expect(manager.getLoadedValidationRevision('src-reseal', adapter)).not.toBe(REV_SECOND)
    expect(manager.getLoadedValidationRevision('src-reseal')).not.toBe(REV_OLD)
    expect(manager.getLoadedValidationRevision('src-reseal')).not.toBe(POISON)
  })

  it('does not let a reseal execute-only InsertResult attest a revision', async () => {
    const { manager } = await unreadable({ withReturning: false })
    await manager.resealLoadFailedDataSource('src-reseal', { password: 'replacement-secret' }, OWNER)
    expect(manager.getDataSource('src-reseal')).toBeInstanceOf(ProbeAdapter)
    expect(manager.getLoadedValidationRevision('src-reseal')).toBeUndefined()
  })

  it('ignores a reseal execute-only poison revision after the write', async () => {
    const { db, manager } = await unreadable({ withReturning: false, executeFallback: [{ validation_revision: REV_EXEC }] })
    await manager.resealLoadFailedDataSource('src-reseal', { password: 'replacement-secret' }, OWNER)
    expect(REV_EXEC).toMatch(ATTESTABLE_REVISION)
    expect(db.statements.some(statement => statement.verb === 'update' && statement.returning.length > 0)).toBe(false)
    expect(db.executeResults).toEqual([[{ validation_revision: REV_EXEC }]])
    expect(manager.getDataSource('src-reseal')).toBeInstanceOf(ProbeAdapter)
    expect(manager.getLoadedValidationRevision('src-reseal', manager.getDataSource('src-reseal'))).toBeUndefined()
  })
})

describe('removed and replaced adapters', () => {
  it('drops the revision on remove and a later stored revision cannot revive it', async () => {
    const { db, manager, id } = await addReturning('src-remove')
    const removed = manager.getDataSource(id)
    db.queue.push(REV_UPDATE)
    await manager.removeDataSource(id)
    db.rows.set(id, loadedRow(id, REV_UPDATE))
    const before = db.statements.length
    expect(manager.getLoadedValidationRevision(id)).toBeUndefined()
    expect(manager.getLoadedValidationRevision(id, removed)).toBeUndefined()
    expect(db.statements).toHaveLength(before)
    const facade = createDataSourcePluginFacade(() => manager)
    const error = await rejected(facade.getTableInfo(id, 'Item', OWNER, 'dbo', { expectedValidationRevision: REV_INSERT }))
    expect(error.code).toBe(DATA_SOURCE_NOT_FOUND_CODE)
    expect((removed as ProbeAdapter).stats.connect).toBe(0)
  })

  it('binds only the replacement adapter to the new RETURNING revision', async () => {
    const { db, manager, facade, id, config } = await fencedSource('src-replace')
    const previous = manager.getDataSource(id) as ProbeAdapter
    db.queue.push(REV_UPDATE)
    const replacement = await manager.updateDataSource(id, { ...config, connection: { ...config.connection, database: 'replaced' } }, scopeOptions()) as ProbeAdapter
    expect(replacement).not.toBe(previous)
    expect(db.rows.get(id)?.validation_revision).toBe(POISON)
    expect(manager.getLoadedValidationRevision(id, replacement)).toBe(REV_UPDATE)
    expect(manager.getLoadedValidationRevision(id, previous)).toBeUndefined()
    expect(manager.getLoadedValidationRevision(id)).not.toBe(REV_INSERT)
    const error = await rejected(facade.select(id, 'items', { limit: 1, offset: 0 }, OWNER, false, { expectedValidationRevision: REV_INSERT }))
    expect(error.code).toBe(REVISION_MISMATCH)
    expect(previous.stats.select).toBe(0)
    expect(previous.stats.connect).toBe(0)
    expect(replacement.stats.select).toBe(0)
    expect(replacement.stats.connect).toBe(0)
    expect(replacement.stats.query).toBe(0)
  })

  it('clears the previous revision when the replacement RETURNING value is unusable', async () => {
    const { db, manager, id } = await addReturning('src-replace-clear')
    const previous = manager.getDataSource(id)
    db.queue.push('not-a-uuid')
    const replacement = await manager.updateDataSource(id, sourceConfig(id), scopeOptions())
    expect(manager.getLoadedValidationRevision(id, previous)).toBeUndefined()
    expect(manager.getLoadedValidationRevision(id, replacement)).toBeUndefined()
    expect(manager.getLoadedValidationRevision(id)).toBeUndefined()
  })
})

async function fencedSource(id: string) {
  const created = await addReturning(id)
  const facade = createDataSourcePluginFacade(() => created.manager)
  return { ...created, facade }
}

type LooseSelect = (
  id: string,
  table: string,
  options: Pick<QueryOptions, 'limit' | 'offset' | 'where' | 'orderBy'>,
  principal: string,
  fifth?: unknown,
  sixth?: unknown,
) => Promise<QueryResult<Record<string, DbValue>>>

describe('read-only facade revision fence', () => {
  it('getTableInfo takes expectedValidationRevision fifth and calls the captured adapter', async () => {
    const { manager, facade, id } = await fencedSource('src-table')
    const adapter = manager.getDataSource(id) as ProbeAdapter
    const calls = watch(manager)
    expect(facade.getTableInfo).toHaveLength(5)
    const validation: DataSourceValidationReadOptions = { expectedValidationRevision: REV_INSERT }
    const info = await facade.getTableInfo(id, 'Item', OWNER, 'dbo', validation)
    expect(info.name).toBe('Item')
    expect(adapter.tableArgs).toEqual([['Item', 'dbo']])
    expect(adapter.stats.connect).toBe(1)
    expect(adapter.stats.query).toBe(0)
    expect(adapter.stats.schema).toBe(0)
    expect(calls).toEqual({ getDataSource: 1, connectDataSource: 0, select: 0, query: 0 })
    for (const key of ['query', 'rawQuery', 'insert', 'update', 'delete', 'execute', 'connect']) {
      expect(facade).not.toHaveProperty(key)
    }
  })

  it('column detail keeps the real manager owner/revision fence and reads the captured adapter on every call', async () => {
    const { manager, facade, id } = await fencedSource('src-columns')
    const captured = manager.getDataSource(id) as ProbeAdapter
    const calls = watch(manager)
    const validation = { expectedValidationRevision: REV_INSERT }
    expect(facade.getTableInfo).toHaveLength(5)
    for (let index = 0; index < 2; index += 1) {
      await expect(facade.getTableInfo(id, 'Item', OWNER, 'dbo', validation, 'columns')).resolves.toEqual({
        name: 'Item', schema: 'dbo', columns: [{ name: 'sku', type: 'varchar', nullable: false }], columnsLoaded: true,
      })
    }
    expect(captured.columnArgs).toEqual([['Item', 'dbo'], ['Item', 'dbo']])
    expect(captured.stats.connect).toBe(1)
    expect(captured.stats.columns).toBe(2)
    expect(captured.stats.table).toBe(0)
    expect(captured.stats.query).toBe(0)
    expect(calls).toEqual({ getDataSource: 2, connectDataSource: 0, select: 0, query: 0 })
  })

  it('column detail refuses missing/wrong owners and stale/missing revision assertions before any IO', async () => {
    const { manager, facade, id } = await fencedSource('src-columns-denied')
    const captured = manager.getDataSource(id) as ProbeAdapter
    const validation = { expectedValidationRevision: REV_INSERT }
    for (const [principal, revision, code] of [
      [undefined, validation, DATA_SOURCE_PRINCIPAL_REQUIRED_CODE],
      [OTHER, validation, DATA_SOURCE_NOT_FOUND_CODE],
      [OWNER, { expectedValidationRevision: REV_OTHER }, REVISION_MISMATCH],
      [OWNER, { expectedValidationRevision: '' }, REVISION_MISMATCH],
      [OWNER, {} as DataSourceValidationReadOptions, REVISION_MISMATCH],
    ] as const) {
      const error = await rejected(facade.getTableInfo(id, 'Item', principal, 'dbo', revision, 'columns'))
      expect(error.code).toBe(code)
    }
    expect(captured.stats.connect).toBe(0)
    expect(captured.stats.columns).toBe(0)
    expect(captured.stats.table).toBe(0)
    expect(captured.stats.query).toBe(0)
    const unbound = await addReturning('src-columns-no-attestation', '')
    const missing = await rejected(createDataSourcePluginFacade(() => unbound.manager)
      .getTableInfo(unbound.id, 'Item', OWNER, 'dbo', validation, 'columns'))
    expect(missing.code).toBe(REVISION_MISMATCH)
    const unattested = unbound.manager.getDataSource(unbound.id) as ProbeAdapter
    expect(unattested.stats.connect).toBe(0)
    expect(unattested.stats.columns).toBe(0)
    expect(unattested.stats.table).toBe(0)
  })

  it('select keeps a strict boolean fifth and revision options sixth', async () => {
    const { manager, facade, id } = await fencedSource('src-select')
    const adapter = manager.getDataSource(id) as ProbeAdapter
    const calls = watch(manager)
    expect(facade.select).toHaveLength(6)
    const options = {
      limit: 25,
      offset: 40,
      where: { sku: 'A' },
      orderBy: [{ column: 'sku', direction: 'desc' as const }],
    }
    const rows = await facade.select(id, 'items', options, OWNER, true, { expectedValidationRevision: REV_INSERT })
    expect(rows.data).toEqual([{ sku: 'captured' }])
    expect(adapter.selectArgs).toEqual([{
      limit: 25,
      offset: 40,
      where: { sku: 'A' },
      orderBy: [{ column: 'sku', direction: 'desc' }],
      strictOffsetOrdering: true,
    }])
    expect(adapter.stats.query).toBe(0)
    expect(calls).toEqual({ getDataSource: 1, connectDataSource: 0, select: 0, query: 0 })

    const again = await facade.select(id, 'items', { limit: 2, offset: 0 }, OWNER, false, { expectedValidationRevision: REV_INSERT })
    expect(again.data).toEqual([{ sku: 'captured' }])
    expect(adapter.selectArgs[1]).toEqual({ limit: 2, offset: 0 })
    expect(adapter.selectArgs[1]).not.toHaveProperty('strictOffsetOrdering')
    expect(calls).toEqual({ getDataSource: 2, connectDataSource: 0, select: 0, query: 0 })
  })

  it('preserves an unfenced strict select through the manager', async () => {
    const { manager, facade, id } = await fencedSource('src-unfenced')
    const calls = watch(manager)
    const adapter = manager.getDataSource(id) as ProbeAdapter
    await facade.select(id, 'items', { limit: 5, offset: 6, where: { bin: 'Z' } }, OWNER, true)
    expect(adapter.selectArgs).toEqual([{ limit: 5, offset: 6, where: { bin: 'Z' }, strictOffsetOrdering: true }])
    expect(calls.select).toBe(1)
    expect(calls.connectDataSource).toBe(1)
    expect(adapter.stats.query).toBe(0)
  })

  it('does not treat a non-boolean fifth argument as strict or as revision options', async () => {
    const { manager, facade, id } = await fencedSource('src-fifth')
    const calls = watch(manager)
    const adapter = manager.getDataSource(id) as ProbeAdapter
    const select = facade.select as LooseSelect
    const rows = await select(id, 'items', { limit: 3, offset: 1 }, OWNER, { expectedValidationRevision: 'not-a-revision' })
    expect(rows.data).toEqual([{ sku: 'captured' }])
    expect(adapter.selectArgs).toEqual([{ limit: 3, offset: 1 }])
    expect(calls.select).toBe(1)
    expect(calls.query).toBe(0)
  })

  it('requires the current owner and refuses a mismatch before connect', async () => {
    const { manager, facade, id } = await fencedSource('src-owner')
    let lookups = 0
    const guarded = createDataSourcePluginFacade(() => { lookups += 1; return manager })
    const adapter = manager.getDataSource(id) as ProbeAdapter
    const validation = { expectedValidationRevision: REV_INSERT }
    const missing = await rejected(guarded.getTableInfo(id, 'Item', undefined, 'dbo', validation))
    const blank = await rejected(guarded.select(id, 'items', { limit: 1, offset: 0 }, '   ', true, validation))
    const mismatch = await rejected(facade.getSchema(id, OTHER, 'dbo', validation))
    expect(missing.code).toBe(DATA_SOURCE_PRINCIPAL_REQUIRED_CODE)
    expect(blank.code).toBe(DATA_SOURCE_PRINCIPAL_REQUIRED_CODE)
    expect(mismatch.code).toBe(DATA_SOURCE_NOT_FOUND_CODE)
    expect(mismatch.name).toBe('DataSourceUnavailableError')
    expect(lookups).toBe(0)
    expect(adapter.stats.connect).toBe(0)
    expect(adapter.stats.schema).toBe(0)
    expect(adapter.stats.table).toBe(0)
    expect(adapter.stats.select).toBe(0)
  })

  it('refuses a moved owner and a stale revision before connect', async () => {
    const { manager, facade, id } = await fencedSource('src-stale')
    const adapter = manager.getDataSource(id) as ProbeAdapter
    const live = manager.getScope(id)
    if (!live) throw new Error('scope missing')
    live.ownerId = OTHER
    const moved = await rejected(facade.select(id, 'items', { limit: 1, offset: 0 }, OTHER, true, { expectedValidationRevision: REV_INSERT }))
    const previousOwner = await rejected(facade.getTableInfo(id, 'Item', OWNER, 'dbo', { expectedValidationRevision: REV_INSERT }))
    live.ownerId = OWNER
    const stale = await rejected(facade.getSchema(id, OWNER, 'dbo', { expectedValidationRevision: REV_OTHER }))
    const empty = await rejected(facade.getTableInfo(id, 'Item', OWNER, undefined, { expectedValidationRevision: '' }))
    expect(moved.code).toBe(REVISION_MISMATCH)
    expect(previousOwner.code).toBe(DATA_SOURCE_NOT_FOUND_CODE)
    expect(stale.code).toBe(REVISION_MISMATCH)
    expect(empty.code).toBe(REVISION_MISMATCH)
    expect(adapter.stats.connect).toBe(0)
    expect(adapter.stats.select).toBe(0)
    expect(adapter.stats.schema).toBe(0)
    expect(adapter.stats.table).toBe(0)
    expect(adapter.stats.query).toBe(0)
  })

  it('keeps the sqlserver strict timeout refusal ahead of connect when the revision matches', async () => {
    const { manager, facade, id } = await fencedSource('src-timeout')
    const adapter = manager.getDataSource(id) as ProbeAdapter
    adapter.getConfig().connection.requestTimeoutMs = 0
    const error = await rejected(facade.select(id, 'items', { limit: 1, offset: 4 }, OWNER, true, { expectedValidationRevision: REV_INSERT }))
    expect(error.code).toBe(DATA_SOURCE_REQUEST_TIMEOUT_DISABLED_CODE)
    expect(adapter.stats.connect).toBe(0)
    expect(adapter.stats.select).toBe(0)
    expect(adapter.stats.query).toBe(0)
  })

  it('publishes the captured revision without connecting or rereading the database', async () => {
    const { db, manager, facade, id } = await fencedSource('src-registration')
    const adapter = manager.getDataSource(id) as ProbeAdapter
    const before = db.statements.length
    const registration = await facade.resolveConnectionRegistration(id, { tenantId: TENANT, principal: OWNER, runAs: 'owner' })
    expect(registration).toEqual({
      id,
      type: 'sqlserver',
      tenantId: TENANT,
      scopeKind: 'private',
      validationRevision: REV_INSERT,
    })
    expect(adapter.stats.connect).toBe(0)
    expect(adapter.stats.config).toBe(0)
    expect(db.statements).toHaveLength(before)
  })

  it('refuses schema, select and column detail when connect observes a replaced manager adapter', async () => {
    for (const method of ['schema', 'select', 'columns'] as const) {
      const { db, manager, facade, id, config } = await fencedSource(`src-race-${method}`)
      const calls = watch(manager)
      const captured = manager.getDataSource(id) as ProbeAdapter
      captured.hook = async () => {
        db.queue.push(REV_UPDATE)
        await manager.updateDataSource(id, {
          ...config,
          connection: { ...config.connection, database: 'replaced-during-connect' },
        }, scopeOptions())
      }
      const validation = { expectedValidationRevision: REV_INSERT }
      const error = method === 'schema'
        ? await rejected(facade.getSchema(id, OWNER, 'dbo', validation))
        : method === 'select'
          ? await rejected(facade.select(id, 'items', { limit: 10, offset: 2, orderBy: [{ column: 'sku', direction: 'asc' }] }, OWNER, true, validation))
          : await rejected(facade.getTableInfo(id, 'Item', OWNER, 'dbo', validation, 'columns'))
      const replacement = manager.getDataSource(id) as ProbeAdapter
      expect(error.code).toBe(REVISION_MISMATCH)
      expect(captured.stats.connect).toBe(1)
      expect(captured.stats.schema).toBe(0)
      expect(captured.stats.select).toBe(0)
      expect(captured.stats.table).toBe(0)
      expect(captured.stats.columns).toBe(0)
      expect(captured.stats.query).toBe(0)
      expect(replacement).not.toBe(captured)
      expect(replacement.getConfig().connection.database).toBe('replaced-during-connect')
      expect(replacement.stats.connect).toBe(0)
      expect(replacement.stats.schema).toBe(0)
      expect(replacement.stats.select).toBe(0)
      expect(replacement.stats.columns).toBe(0)
      expect(replacement.stats.query).toBe(0)
      expect(calls.connectDataSource).toBe(0)
      expect(calls.select).toBe(0)
      expect(calls.query).toBe(0)
      expect(manager.getLoadedValidationRevision(id, captured)).toBeUndefined()
      expect(manager.getLoadedValidationRevision(id, replacement)).toBe(REV_UPDATE)
    }
  })
})
