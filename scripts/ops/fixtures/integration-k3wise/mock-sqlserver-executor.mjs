#!/usr/bin/env node
// Mock SQL Server executor for the K3 WISE SQL Server channel.
// Enforces the live-PoC safety rules:
//   - Read-only on K3 core tables (t_ICItem, t_ICBOM, t_MeasureUnit, etc.)
//   - Allow writes to integration middle tables (integration_*)
//   - Reject any INSERT/UPDATE/DELETE on K3 core tables (would corrupt customer ERP)
//
// Returns a small executor object compatible with the adapter contract:
//   testConnection() → { ok: true, ... }
//   query({ sql, params }) → { rows: [...] }
//   exec({ sql, params }) → { rowsAffected, lastId? }
//
// The mock keeps query log + writeRowsByTable so demos/tests can assert.

const K3_CORE_TABLES = new Set([
  't_icitem',
  't_icbom',
  't_icbomchild',
  't_baseproperty',
  't_measureunit',
  't_organization',
])

function tableNameFromSql(sql) {
  const match = sql.match(/(?:from|into|update|table)\s+(?:dbo\.)?["[]?([a-z_][a-z0-9_]*)["\]]?/i)
  return match ? match[1].toLowerCase() : null
}

function operationFromSql(sql) {
  const trimmed = sql.trim().toUpperCase()
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return 'read'
  if (trimmed.startsWith('INSERT')) return 'insert'
  if (trimmed.startsWith('UPDATE')) return 'update'
  if (trimmed.startsWith('DELETE')) return 'delete'
  return 'unknown'
}

export function createMockSqlServerExecutor({
  cannedReadResults = {},
  middleTablePrefix = 'integration_',
} = {}) {
  const queryLog = []
  const writes = new Map()  // table → array of { sql, params }

  return {
    queryLog,
    writes,
    async testConnection() {
      return { ok: true, server: 'mock-sql-server', database: 'AIS_TEST_MOCK' }
    },
    async query({ sql, params = [] } = {}) {
      const op = operationFromSql(sql)
      const table = tableNameFromSql(sql)
      queryLog.push({ sql, params, op, table })
      if (op !== 'read') {
        throw new Error(`mock SQL: query() rejects non-read operation "${op}" on ${table || sql.slice(0, 60)}`)
      }
      const rows = cannedReadResults[table] || []
      return { rows }
    },
    async exec({ sql, params = [] } = {}) {
      const op = operationFromSql(sql)
      const table = tableNameFromSql(sql)
      queryLog.push({ sql, params, op, table })
      if (op === 'read') {
        throw new Error(`mock SQL: exec() rejects read operation; use query() instead`)
      }
      if (table && K3_CORE_TABLES.has(table)) {
        throw new Error(`mock SQL safety: ${op.toUpperCase()} on K3 core table ${table} is forbidden in PoC`)
      }
      if (table && !table.startsWith(middleTablePrefix)) {
        throw new Error(`mock SQL safety: ${op.toUpperCase()} on non-middle table ${table} is forbidden (prefix must be "${middleTablePrefix}")`)
      }
      const list = writes.get(table) || []
      list.push({ sql, params })
      writes.set(table, list)
      return { rowsAffected: 1 }
    },
  }
}
