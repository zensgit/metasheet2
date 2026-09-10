#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { createMockSqlServerExecutor } from './mock-sqlserver-executor.mjs'

const require = createRequire(import.meta.url)
const { createK3WiseSqlServerChannel } = require('../../../../plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs')
// Source of truth for the permanent-fence token/message/status — asserted against directly rather
// than duplicated as literals, so this fixture cannot silently drift from the fence it exercises.
const {
  K3_WISE_EXTERNAL_WRITE_DISABLED,
  K3_EXTERNAL_WRITE_REFUSAL_MESSAGE,
  K3_EXTERNAL_WRITE_REFUSAL_STATUS,
} = require('../../../../plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs')

// Both E4S-era rejection tests below share this shape check: the permanent fence's fixed refusal
// (same code/status/message at every layer, §10.1), AND — the part that makes this a STRONGER
// guarantee than "the promise rejected" — the mock executor's own call log/write ledger are
// untouched, proving the channel never handed the mock SQL server so much as one statement.
function assertPermanentlyRefusedBeforeExecutor(error, executor) {
  assert.equal(error.code, K3_WISE_EXTERNAL_WRITE_DISABLED)
  assert.equal(error.status, K3_EXTERNAL_WRITE_REFUSAL_STATUS)
  assert.equal(error.message, K3_EXTERNAL_WRITE_REFUSAL_MESSAGE)
  assert.deepEqual(executor.queryLog, [])
  assert.equal(executor.writes.size, 0)
  return true
}

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

test('real channel refuses middle-table upsert under the permanent fence; executor receives nothing', async () => {
  // Pre-E4 this object was the LEGITIMATE case: writeMode 'middle-table' was the configuration
  // that made a K3 SQL Server channel upsert succeed. The permanent fence (E4 layer 3, HG v1.2
  // §10.2.3) now refuses unconditionally, ahead of the executor shape check, the request
  // normalisation, the table allowlist and the old middle-table rule — middle-table config
  // included. The assertion below is deliberately stronger than "the write mode still works":
  // it proves the mock SQL server's call log stays EMPTY, i.e. no statement ever reached the
  // wire, not merely that the channel's return value changed.
  const executor = createExecutor()
  const channel = createChannel(executor)

  await assert.rejects(
    channel.upsert({
      object: 'material_stage',
      records: [{ FNumber: 'MAT-MOCK-001', FName: 'Mock material' }],
      keyFields: ['FNumber'],
    }),
    (error) => assertPermanentlyRefusedBeforeExecutor(error, executor),
  )
})

test('real channel refuses direct K3 core table upsert under the permanent fence; executor receives nothing', async () => {
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
    (error) => assertPermanentlyRefusedBeforeExecutor(error, executor),
  )
})

test('mock SQL executor resolves bracketed schema-qualified K3 core table reads', async () => {
  const executor = createMockSqlServerExecutor({
    cannedReadResults: {
      t_icitem: [{ FItemID: 1001, FNumber: 'MAT-EXISTING' }],
    },
  })

  const result = await executor.query({
    sql: 'SELECT FItemID, FNumber FROM [dbo].[t_ICItem] WHERE FNumber = ?',
    params: ['MAT-EXISTING'],
  })

  assert.deepEqual(result.rows, [{ FItemID: 1001, FNumber: 'MAT-EXISTING' }])
  assert.equal(executor.queryLog[0].table, 't_icitem')
  assert.equal(executor.queryLog[0].op, 'read')
})

test('mock SQL executor resolves three-part SQL Server identifiers', async () => {
  const executor = createMockSqlServerExecutor({
    cannedReadResults: {
      t_icitem: [{ FItemID: 1002, FNumber: 'MAT-DB-SCOPED' }],
    },
  })

  const result = await executor.query({
    sql: 'SELECT FItemID, FNumber FROM [AIS_TEST_MOCK].[dbo].[t_ICItem] WHERE FNumber = ?',
    params: ['MAT-DB-SCOPED'],
  })

  assert.deepEqual(result.rows, [{ FItemID: 1002, FNumber: 'MAT-DB-SCOPED' }])
  assert.equal(executor.queryLog[0].table, 't_icitem')
})

test('mock SQL executor allows bracketed schema-qualified middle-table writes', async () => {
  const executor = createMockSqlServerExecutor()

  const result = await executor.exec({
    sql: 'INSERT INTO [dbo].[integration_material_stage] (FNumber, FName) VALUES (?, ?)',
    params: ['MAT-001', 'Mock material'],
  })

  assert.equal(result.rowsAffected, 1)
  assert.equal(executor.queryLog[0].table, 'integration_material_stage')
  assert.equal(executor.writes.get('integration_material_stage').length, 1)
})

test('mock SQL executor still blocks bracketed schema-qualified K3 core table writes', async () => {
  const executor = createMockSqlServerExecutor()

  await assert.rejects(
    () => executor.exec({
      sql: 'INSERT INTO [dbo].[t_ICItem] (FNumber, FName) VALUES (?, ?)',
      params: ['MAT-FORBIDDEN', 'Forbidden material'],
    }),
    /K3 core table t_icitem is forbidden/,
  )
  assert.equal(executor.queryLog[0].table, 't_icitem')
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

test('mock SQL executor resolves quoted schema-qualified middle-table writes', async () => {
  const executor = createMockSqlServerExecutor()

  const result = await executor.exec({
    sql: 'UPDATE "dbo"."integration_material_stage" SET FName = ? WHERE FNumber = ?',
    params: ['Mock material renamed', 'MAT-001'],
  })

  assert.equal(result.rowsAffected, 1)
  assert.equal(executor.queryLog[0].table, 'integration_material_stage')
  assert.equal(executor.writes.get('integration_material_stage').length, 1)
})
