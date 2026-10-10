'use strict'

// Physical columns compared with caller-supplied catalog data only. This cannot
// attest how metadata was obtained, grant access, or serve as an evidence receipt.
// It performs no I/O and establishes no datatype, uniqueness, or join guarantees.
const { ROLES, validateStockPreparationReadPlanConfig } = require('./stock-preparation-read-plan-config.cjs')

const MAX_TABLES = 7
const MAX_COLUMNS = 4096
const MAX_IDENTIFIER_LENGTH = 128

function result(issues) {
  return {
    status: issues.length ? 'unverified' : 'matched',
    validation: 'physical-columns-only',
    authorizesExecution: false,
    issues,
  }
}

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function identifier(value) {
  // Unrelated physical columns may legitimately contain Unicode or spaces.
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH
}

function snapshotCatalog(catalog) {
  if (!Array.isArray(catalog)) return null
  const tableCount = catalog.length
  if (!Number.isInteger(tableCount) || tableCount < 0 || tableCount > MAX_TABLES) return null
  const tables = []
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const table = catalog[tableIndex]
    if (!record(table)) return null
    const name = table.name
    const schema = table.schema
    const columns = table.columns
    const columnsLoaded = table.columnsLoaded
    if (!identifier(name) || !identifier(schema) || !Array.isArray(columns)
      || (columnsLoaded !== undefined && typeof columnsLoaded !== 'boolean')) return null
    const columnCount = columns.length
    if (!Number.isInteger(columnCount) || columnCount < 0 || columnCount > MAX_COLUMNS) return null
    const names = []
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const column = columns[columnIndex]
      if (!record(column)) return null
      const columnName = column.name
      if (!identifier(columnName)) return null
      names.push(columnName)
    }
    tables.push({ name, schema, names, verified: columnsLoaded !== false && names.length > 0 })
  }
  return tables
}

function inspectStockPreparationReadPlanCatalog(input) {
  let config
  try {
    config = validateStockPreparationReadPlanConfig(input && input.config)
  } catch (_error) {
    return result([{ path: 'config', code: 'CONFIG_INVALID' }])
  }

  let dialect
  try {
    dialect = input.dialect
  } catch (_error) {
    return result([{ path: 'dialect', code: 'DIALECT_UNSUPPORTED' }])
  }
  if (!['postgres', 'postgresql', 'sqlserver'].includes(dialect)) {
    return result([{ path: 'dialect', code: 'DIALECT_UNSUPPORTED' }])
  }

  let tables
  try {
    tables = snapshotCatalog(input.catalog)
  } catch (_error) {
    // Accessors/proxies may fail with private driver details. Never expose them.
    return result([{ path: 'catalog', code: 'CATALOG_INVALID' }])
  }
  if (!tables) return result([{ path: 'catalog', code: 'CATALOG_INVALID' }])

  const issues = []
  const postgres = dialect === 'postgres' || dialect === 'postgresql'
  for (const [role, fields] of Object.entries(ROLES)) {
    const configured = config.readPlan[role]
    const objectPath = `readPlan.${role}.object`
    const segments = configured.object.split('.')
    if (segments.length !== 2 || (postgres && segments.some((segment) => segment !== segment.toLowerCase()))) {
      issues.push({ path: objectPath, code: 'RESOLUTION_UNPROVABLE' })
      continue
    }
    const [schema, name] = segments
    const candidates = tables.filter((table) => table.schema === schema && table.name === name)
    if (candidates.length > 1) {
      issues.push({ path: objectPath, code: 'OBJECT_AMBIGUOUS' })
      continue
    }
    if (!candidates.length || !candidates[0].verified) {
      issues.push({ path: objectPath, code: 'OBJECT_UNVERIFIED' })
      continue
    }
    const table = candidates[0]
    for (const field of [...fields.required.filter((key) => key !== 'object'), ...fields.optional]) {
      const columnName = configured[field]
      if (columnName === undefined) continue
      const fieldPath = `readPlan.${role}.${field}`
      if (postgres && columnName !== columnName.toLowerCase()) {
        issues.push({ path: fieldPath, code: 'RESOLUTION_UNPROVABLE' })
        continue
      }
      const folded = columnName.toLowerCase()
      const matches = table.names.filter((column) => column.toLowerCase() === folded)
      if (matches.length > 1) issues.push({ path: fieldPath, code: 'FIELD_AMBIGUOUS' })
      else if (!table.names.includes(columnName)) issues.push({ path: fieldPath, code: 'FIELD_MISSING' })
    }
  }
  return result(issues)
}

module.exports = { inspectStockPreparationReadPlanCatalog }
