import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { createMockSqlServerExecutor } from './mock-sqlserver-executor.mjs'

const require = createRequire(import.meta.url)
const { createK3WiseSqlServerChannel } = require('../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs')

function createExecutor() {
  return createMockSqlServerExecutor({
    cannedReadResults: {
      t_icitem: [{ FItemID: 1001, FNumber: 'MAT-EXISTING', FName: 'Existing material' }],
    },
  })
}

function createChannel(executor = createExecutor()) {
  return createK3WiseSqlServerChannel({
    system: {
      id: 'mock-sql',
      name: 'Mock K3 SQL',
      kind: 'erp:k3-wise-sqlserver',
      role: 'bidirectional',
      config: {
        allowedTables: ['t_ICItem', 'dbo.integration_material_stage'],
        objects: {
          material_stage: {
            table: 'dbo.integration_material_stage',
            operations: ['upsert'],
            writeMode: 'middle-table',
            keyField: 'FNumber',
            schema: [{ name: 'FNumber', type: 'string', required: true }],
          },
        },
      },
    },
    queryExecutor: executor,
  })
}

test('mock SQL executor satisfies real channel read contract', async () => {
  const executor = createExecutor()
  const channel = createChannel(executor)
  const result = await channel.read({ object: 'material', limit: 1 })

  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].FNumber, 'MAT-EXISTING')
  assert.equal(result.metadata.table, 't_ICItem')
  assert.equal(executor.queryLog[0].op, 'select')
  assert.equal(executor.queryLog[0].table, 't_icitem')
})

test('mock SQL executor satisfies real channel middle-table upsert contract', async () => {
  const executor = createExecutor()
  const channel = createChannel(executor)
  const result = await channel.upsert({
    object: 'material_stage',
    records: [{ FNumber: 'MAT-MOCK-001', FName: 'Mock material' }],
    keyFields: ['FNumber'],
  })

  assert.equal(result.written, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.metadata.table, 'dbo.integration_material_stage')
  assert.equal(executor.writes.get('integration_material_stage').length, 1)
  assert.deepEqual(executor.writes.get('integration_material_stage')[0].record, {
    FNumber: 'MAT-MOCK-001',
    FName: 'Mock material',
  })
})

test('real channel still rejects direct K3 core table upsert before executor write', async () => {
  const executor = createExecutor()
  const channel = createK3WiseSqlServerChannel({
    system: {
      id: 'mock-sql',
      name: 'Mock K3 SQL',
      kind: 'erp:k3-wise-sqlserver',
      role: 'bidirectional',
      config: {
        allowedTables: ['t_ICItem'],
        objects: {
          material_write: {
            table: 't_ICItem',
            operations: ['upsert'],
            keyField: 'FNumber',
          },
        },
      },
    },
    queryExecutor: executor,
  })

  await assert.rejects(
    channel.upsert({
      object: 'material_write',
      records: [{ FNumber: 'MAT-FORBIDDEN' }],
      keyFields: ['FNumber'],
    }),
    /only writes to configured middle tables/,
  )
  assert.equal(executor.writes.size, 0)
})

test('mock SQL executor allows read-only CTE queries against K3 core tables', async () => {
  const executor = createExecutor()
  const result = await executor.query({
    sql: 'WITH existing AS (SELECT FItemID, FNumber FROM [dbo].[t_ICItem]) SELECT * FROM existing WHERE FNumber = ?',
    params: ['MAT-EXISTING'],
  })

  assert.equal(result.rows.length, 1)
  assert.equal(executor.queryLog[0].op, 'read')
  assert.equal(executor.queryLog[0].table, 't_icitem')
})

test('mock SQL executor rejects CTE-wrapped mutating queries through query()', async () => {
  const executor = createExecutor()

  await assert.rejects(
    executor.query({
      sql: 'WITH doomed AS (SELECT FItemID FROM dbo.t_ICItem) DELETE FROM doomed WHERE FItemID = ?',
      params: [1001],
    }),
    /query\(\) rejects non-read operation "cte-write" on t_icitem/,
  )
})

test('mock SQL executor rejects MERGE into K3 core tables', async () => {
  const executor = createExecutor()

  await assert.rejects(
    executor.exec({
      sql: 'MERGE INTO [dbo].[t_ICItem] AS target USING dbo.integration_material_stage AS source ON target.FNumber = source.FNumber WHEN MATCHED THEN UPDATE SET FName = source.FName;',
    }),
    /MERGE on K3 core table t_icitem is forbidden in PoC/,
  )
})

test('mock SQL executor rejects unsupported operations instead of logging null-table writes', async () => {
  const executor = createExecutor()

  await assert.rejects(
    executor.exec({ sql: 'EXEC dbo.SomeUnsafeProcedure' }),
    /unsupported operation "unknown".*forbidden in PoC/,
  )
  assert.equal(executor.writes.size, 0)
})

test('mock SQL executor still allows writes to integration middle tables', async () => {
  const executor = createExecutor()

  const result = await executor.exec({
    sql: 'INSERT INTO dbo.integration_material_stage (FNumber, FName) VALUES (?, ?)',
    params: ['MAT-MOCK-001', 'Mock material'],
  })

  assert.equal(result.rowsAffected, 1)
  assert.equal(executor.writes.get('integration_material_stage').length, 1)
})
