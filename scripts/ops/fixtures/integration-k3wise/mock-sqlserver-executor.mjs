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
const WRITE_OPERATIONS = new Set(['insert', 'update', 'delete', 'merge'])

function tableNameFromSql(sql) {
  const match = sql.match(
    /(?:from|into|update|table|merge(?:\s+into)?)\s+(?:(?:dbo|\[dbo\]|"dbo")\s*\.\s*)?["[]?([a-z_][a-z0-9_]*)["\]]?/i,
  )
  return match ? match[1].toLowerCase() : null
}

function normalizeTableName(table) {
  return String(table || '')
    .trim()
    .replace(/["\[\]]/g, '')
    .split('.')
    .pop()
    .toLowerCase()
}

function hasMutatingCte(sql) {
  return /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE(?:\s+INTO)?|TRUNCATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\b/i.test(sql)
}

function operationFromSql(sql) {
  const trimmed = sql.trim().toUpperCase()
  if (trimmed.startsWith('SELECT')) return 'read'
  if (trimmed.startsWith('WITH')) return hasMutatingCte(sql) ? 'cte-write' : 'read'
  if (trimmed.startsWith('INSERT')) return 'insert'
  if (trimmed.startsWith('UPDATE')) return 'update'
  if (trimmed.startsWith('DELETE')) return 'delete'
  if (trimmed.startsWith('MERGE')) return 'merge'
  if (trimmed.startsWith('TRUNCATE') || trimmed.startsWith('ALTER') || trimmed.startsWith('DROP') || trimmed.startsWith('CREATE')) {
    return 'schema'
  }
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
    async select({ table, columns, limit, cursor, filters, orderBy, watermark, options, system } = {}) {
      const normalizedTable = normalizeTableName(table)
      queryLog.push({
        op: 'select',
        table: normalizedTable,
        columns,
        limit,
        cursor,
        filters,
        orderBy,
        watermark,
        options,
        systemId: system && system.id,
      })
      const rows = cannedReadResults[normalizedTable] || []
      const boundedRows = Number.isInteger(limit) && limit >= 0 ? rows.slice(0, limit) : rows
      return {
        records: boundedRows,
        nextCursor: null,
        done: true,
      }
    },
    async exec({ sql, params = [] } = {}) {
      const op = operationFromSql(sql)
      const table = tableNameFromSql(sql)
      queryLog.push({ sql, params, op, table })
      if (op === 'read') {
        throw new Error(`mock SQL: exec() rejects read operation; use query() instead`)
      }
      if (!WRITE_OPERATIONS.has(op)) {
        throw new Error(`mock SQL safety: unsupported operation "${op}" on ${table || sql.slice(0, 60)} is forbidden in PoC`)
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
    async insertMany({ table, records = [], keyFields = [], mode, options, system } = {}) {
      const normalizedTable = normalizeTableName(table)
      queryLog.push({
        op: 'insertMany',
        table: normalizedTable,
        records,
        keyFields,
        mode,
        options,
        systemId: system && system.id,
      })
      if (K3_CORE_TABLES.has(normalizedTable)) {
        throw new Error(`mock SQL safety: INSERTMANY on K3 core table ${normalizedTable} is forbidden in PoC`)
      }
      if (!normalizedTable.startsWith(middleTablePrefix)) {
        throw new Error(`mock SQL safety: INSERTMANY on non-middle table ${normalizedTable} is forbidden (prefix must be "${middleTablePrefix}")`)
      }
      const list = writes.get(normalizedTable) || []
      for (const record of records) list.push({ record, keyFields, mode, options })
      writes.set(normalizedTable, list)
      return {
        written: records.length,
        failed: 0,
        errors: [],
        results: records.map((record, index) => ({
          index,
          status: 'written',
          key: keyFields.length > 0 ? record[keyFields[0]] : undefined,
        })),
      }
    },
  }
}
