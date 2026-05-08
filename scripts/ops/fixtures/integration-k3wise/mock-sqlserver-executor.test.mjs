#!/usr/bin/env node

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockSqlServerExecutor } from './mock-sqlserver-executor.mjs'

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
