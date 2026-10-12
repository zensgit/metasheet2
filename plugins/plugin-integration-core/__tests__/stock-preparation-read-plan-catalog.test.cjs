'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { READ_PLAN_ID, SOURCE_KIND, ROLES, validateStockPreparationReadPlanConfig } = require('../lib/stock-preparation-read-plan-config.cjs')
const { inspectStockPreparationReadPlanCatalog } = require('../lib/stock-preparation-read-plan-catalog.cjs')

const ROLE_NAMES = Object.keys(ROLES)
const FIELD_SLOTS = Object.entries(ROLES).flatMap(([role, fields]) =>
  [...fields.required.filter((field) => field !== 'object'), ...fields.optional].map((field) => [role, field]))
const SENTINEL = 'synthetic-private-authorityCode-appKey-driver-message'
const clone = (value) => structuredClone(value)

function fixture({ optional = true, reused = false } = {}) {
  const readPlan = { id: READ_PLAN_ID, sourceKind: SOURCE_KIND, matchField: 'matchfield', maxReadCount: 200 }
  for (const [role, fields] of Object.entries(ROLES)) {
    readPlan[role] = { object: `syn.${reused ? 'shared' : role.toLowerCase()}` }
    for (const field of [...fields.required.filter((key) => key !== 'object'), ...(optional ? fields.optional : [])]) {
      readPlan[role][field] = field.toLowerCase()
    }
  }
  const config = { schemaVersion: 1, actionId: 'plm.stock-preparation.pull-bom.v1', systemId: 'synthetic-source', readPlan }
  // Positive fixtures pass the production validator, not a copied test contract.
  const validated = validateStockPreparationReadPlanConfig(config)
  const byObject = new Map()
  for (const [role, fields] of Object.entries(ROLES)) {
    const configured = validated.readPlan[role]
    const [schema, name] = configured.object.split('.')
    if (!byObject.has(configured.object)) byObject.set(configured.object, { schema, name, columns: [], columnsLoaded: true })
    const table = byObject.get(configured.object)
    for (const field of [...fields.required.filter((key) => key !== 'object'), ...fields.optional]) {
      if (configured[field] !== undefined && !table.columns.some((column) => column.name === configured[field])) {
        table.columns.push({ name: configured[field] })
      }
    }
  }
  return { config, dialect: 'postgres', catalog: [...byObject.values()] }
}

function expected(issues = []) {
  return { status: issues.length ? 'unverified' : 'matched', validation: 'physical-columns-only', authorizesExecution: false, issues }
}
function objectIssue(role, code) { return { path: `readPlan.${role}.object`, code } }
function fieldIssue(role, field, code) { return { path: `readPlan.${role}.${field}`, code } }
function tableFor(input, role) {
  const [schema, name] = input.config.readPlan[role].object.split('.')
  return input.catalog.find((table) => table.schema === schema && table.name === name)
}
function inspect(input) {
  const output = inspectStockPreparationReadPlanCatalog(input)
  assert.equal(output.authorizesExecution, false)
  assert.equal(output.validation, 'physical-columns-only')
  assert.doesNotMatch(JSON.stringify(output), /synthetic-private|authorityCode|appKey|driver-message/)
  return output
}

test('all 14 required and 11 optional physical field slots match without authorizing execution', () => {
  assert.equal(FIELD_SLOTS.length, 25)
  assert.equal(Object.values(ROLES).reduce((count, fields) => count + fields.optional.length, 0), 11)
  for (const dialect of ['postgres', 'postgresql', 'sqlserver']) {
    const input = fixture()
    input.dialect = dialect
    assert.deepEqual(inspect(input), expected())
  }
})

test('minimum roles do not introduce implicit optional defaults', () => {
  const input = fixture({ optional: false })
  assert.equal(input.catalog.reduce((count, table) => count + table.columns.length, 0), 14)
  assert.deepEqual(inspect(input), expected())
})

test('one shared descriptor checks the union of all seven role requirements', () => {
  const input = fixture({ reused: true })
  assert.equal(input.catalog.length, 1)
  assert.deepEqual(inspect(input), expected())
  input.catalog[0].columns = input.catalog[0].columns.filter((column) => column.name !== 'quantityfield')
  assert.deepEqual(inspect(input), expected([
    fieldIssue('orderDetail', 'quantityField', 'FIELD_MISSING'),
    fieldIssue('bomDetail', 'quantityField', 'FIELD_MISSING'),
  ]))
})

for (const role of ROLE_NAMES) {
  test(`missing descriptor for ${role} is object-unverified`, () => {
    const input = fixture()
    const table = tableFor(input, role)
    input.catalog = input.catalog.filter((entry) => entry !== table)
    assert.deepEqual(inspect(input), expected([objectIssue(role, 'OBJECT_UNVERIFIED')]))
  })
}

for (const [role, field] of FIELD_SLOTS) {
  test(`missing physical column for ${role}.${field} fails`, () => {
    const input = fixture()
    const table = tableFor(input, role)
    table.columns = table.columns.filter((column) => column.name !== input.config.readPlan[role][field])
    table.columns.push({ name: 'unrelated' })
    assert.deepEqual(inspect(input), expected([fieldIssue(role, field, 'FIELD_MISSING')]))
  })
  test(`postgres uppercase configured ${role}.${field} cannot prove resolution`, () => {
    const input = fixture()
    input.config.readPlan[role][field] = field.toUpperCase()
    if (role === 'pathExAttr' && field === 'matchField') input.config.readPlan.matchField = field.toUpperCase()
    assert.deepEqual(inspect(input), expected([fieldIssue(role, field, 'RESOLUTION_UNPROVABLE')]))
  })
}

test('empty catalog yields deterministic seven-role issues', () => {
  const input = fixture()
  input.catalog = []
  assert.deepEqual(inspect(input), expected(ROLE_NAMES.map((role) => objectIssue(role, 'OBJECT_UNVERIFIED'))))
})

test('empty or unloaded columns cannot verify an object', () => {
  for (const change of [
    (table) => { table.columns = [] },
    (table) => { table.columnsLoaded = false },
    (table) => { table.columnsLoaded = false; table.columns = [] },
  ]) {
    const input = fixture()
    change(tableFor(input, 'part'))
    assert.deepEqual(inspect(input), expected([objectIssue('part', 'OBJECT_UNVERIFIED')]))
  }
})

test('absent columnsLoaded is supported when physical columns are present', () => {
  const input = fixture()
  for (const table of input.catalog) delete table.columnsLoaded
  assert.deepEqual(inspect(input), expected())
})

test('metadata arrays and names are bounded and malformed shapes fail closed', () => {
  const badCatalogs = [undefined, null, {}, { tables: [] }, SENTINEL, [null], [SENTINEL],
    [{ error: SENTINEL }], [{ name: 'part', columns: [] }], [{ schema: 'syn', columns: [] }],
    [{ schema: 'syn', name: 'part', columns: null }], [{ schema: 'syn', name: 'part', columns: [{ type: SENTINEL }] }],
    [{ schema: 'syn', name: 'part', columns: [null] }], [{ schema: 'syn', name: 'part', columns: ['idfield'] }],
    [{ schema: 'syn', name: 'part', columns: [{ name: 1 }] }],
    [{ schema: 'syn', name: 'part', columns: [{ name: '' }] }],
    [{ schema: 'syn', name: 'part', columns: [{ name: 'a'.repeat(129) }] }],
    [{ schema: '', name: 'part', columns: [] }], [{ schema: 'syn', name: '', columns: [] }],
    [{ schema: 's'.repeat(129), name: 'part', columns: [] }],
    [{ schema: 'syn', name: 'n'.repeat(129), columns: [] }],
    [{ schema: 1, name: 'part', columns: [] }], [{ schema: 'syn', name: false, columns: [] }],
    [{ schema: 'syn', name: 'part', columns: [], columnsLoaded: 'true' }],
    [{ schema: 'syn', name: 'part', columns: [], columnsLoaded: null }],
    [new Error(SENTINEL)], new Array(1),
  ]
  for (const catalog of badCatalogs) {
    const input = fixture()
    input.catalog = catalog
    assert.deepEqual(inspect(input), expected([{ path: 'catalog', code: 'CATALOG_INVALID' }]))
  }
  const tooManyTables = fixture()
  tooManyTables.catalog.push(clone(tooManyTables.catalog[0]))
  assert.deepEqual(inspect(tooManyTables), expected([{ path: 'catalog', code: 'CATALOG_INVALID' }]))
  const manyColumns = fixture()
  const table = tableFor(manyColumns, 'part')
  while (table.columns.length < 4096) table.columns.push({ name: `unrelated_${table.columns.length}` })
  assert.deepEqual(inspect(manyColumns), expected())
  table.columns.push({ name: 'over_limit' })
  assert.deepEqual(inspect(manyColumns), expected([{ path: 'catalog', code: 'CATALOG_INVALID' }]))
})

test('bare names cannot establish runtime resolution', () => {
  const input = fixture()
  input.config.readPlan.part.object = 'part'
  assert.deepEqual(inspect(input), expected([objectIssue('part', 'RESOLUTION_UNPROVABLE')]))
})

test('three-part objects fail the production strict config validator before catalog comparison', () => {
  const input = fixture()
  input.config.readPlan.part.object = 'database.syn.part'
  assert.throws(() => validateStockPreparationReadPlanConfig(input.config))
  assert.deepEqual(inspect(input), expected([{ path: 'config', code: 'CONFIG_INVALID' }]))
})

test('object matching is exact with no schema fallback, suffix search, or folding', () => {
  for (const change of [
    (table) => { table.schema = 'other' },
    (table) => { table.name = 'syn.part' },
    (table) => { table.schema = 'SYN' },
    (table) => { table.name = 'PART' },
  ]) {
    for (const dialect of ['postgres', 'sqlserver']) {
      const input = fixture()
      input.dialect = dialect
      change(tableFor(input, 'part'))
      assert.deepEqual(inspect(input), expected([objectIssue('part', 'OBJECT_UNVERIFIED')]))
    }
  }
})

test('postgres configured object segments must be lowercase even when metadata matches exactly', () => {
  for (const object of ['Syn.part', 'syn.Part']) {
    const input = fixture()
    const table = tableFor(input, 'part')
    input.config.readPlan.part.object = object
    ;[table.schema, table.name] = object.split('.')
    assert.deepEqual(inspect(input), expected([objectIssue('part', 'RESOLUTION_UNPROVABLE')]))
  }
})

test('SQLServer can exactly match mixed-case objects and fields without inferring collation', () => {
  const input = fixture()
  input.dialect = 'sqlserver'
  const table = tableFor(input, 'part')
  input.config.readPlan.part.object = 'Syn.Part'
  table.schema = 'Syn'
  table.name = 'Part'
  input.config.readPlan.part.idField = 'PartId'
  table.columns.find((column) => column.name === 'idfield').name = 'PartId'
  assert.deepEqual(inspect(input), expected())
  table.columns.find((column) => column.name === 'PartId').name = 'partid'
  assert.deepEqual(inspect(input), expected([fieldIssue('part', 'idField', 'FIELD_MISSING')]))
})

test('duplicate object descriptors are ambiguous for every role using that object', () => {
  const input = fixture({ reused: true })
  input.catalog.push(clone(input.catalog[0]))
  assert.deepEqual(inspect(input), expected(ROLE_NAMES.map((role) => objectIssue(role, 'OBJECT_AMBIGUOUS'))))
  input.catalog[1].columnsLoaded = false
  assert.deepEqual(inspect(input), expected(ROLE_NAMES.map((role) => objectIssue(role, 'OBJECT_AMBIGUOUS'))))
})

test('duplicate or case-fold-colliding column candidates are ambiguous', () => {
  for (const dialect of ['postgres', 'postgresql', 'sqlserver']) {
    for (const names of [['idfield', 'idfield'], ['idfield', 'IDFIELD'], ['IDFIELD', 'IdField']]) {
      const input = fixture()
      input.dialect = dialect
      const table = tableFor(input, 'part')
      table.columns = table.columns.filter((column) => column.name !== 'idfield')
      table.columns.push(...names.map((name) => ({ name })))
      assert.deepEqual(inspect(input), expected([fieldIssue('part', 'idField', 'FIELD_AMBIGUOUS')]))
    }
  }
})

test('a single differently-cased physical column is missing, not an inferred match', () => {
  const input = fixture()
  tableFor(input, 'part').columns.find((column) => column.name === 'idfield').name = 'IDFIELD'
  assert.deepEqual(inspect(input), expected([fieldIssue('part', 'idField', 'FIELD_MISSING')]))
})

test('unsupported dialects, including Bridge, never certify physical matches', () => {
  for (const dialect of [undefined, null, 'Bridge', 'bridge', 'mysql', 'postgresql-http', 'POSTGRES', 'mssql', {}, 1]) {
    const input = fixture()
    input.dialect = dialect
    assert.deepEqual(inspect(input), expected([{ path: 'dialect', code: 'DIALECT_UNSUPPORTED' }]))
  }
})

test('actual strict config validator rejects extensions, unsafe identifiers, and invalid roles', () => {
  for (const change of [
    (config) => { config.extra = SENTINEL },
    (config) => { config.readPlan.extra = SENTINEL },
    (config) => { config.readPlan.part.extra = SENTINEL },
    (config) => { config.readPlan.part.idField = 'id;select' },
    (config) => { config.readPlan.part = {} },
    (config) => { config.actionId = SENTINEL },
    (config) => { config.readPlan.maxReadCount = 1001 },
    (config) => { config.readPlan.matchField = 'mismatch' },
  ]) {
    const input = fixture()
    change(input.config)
    assert.throws(() => validateStockPreparationReadPlanConfig(input.config))
    assert.deepEqual(inspect(input), expected([{ path: 'config', code: 'CONFIG_INVALID' }]))
  }
  for (const input of [undefined, null, {}, { config: null }]) {
    assert.deepEqual(inspect(input), expected([{ path: 'config', code: 'CONFIG_INVALID' }]))
  }
})

test('extra metadata and unrelated Unicode/space columns are harmless and never echoed', () => {
  const input = fixture()
  for (const table of input.catalog) {
    Object.assign(table, { comment: SENTINEL, connection: SENTINEL, error: SENTINEL })
    for (const column of table.columns) {
      Object.assign(column, { dataType: SENTINEL, default: SENTINEL, comment: SENTINEL, unique: false, nullable: true })
      Object.defineProperty(column, 'privateUnusedMetadata', { get() { throw new Error(SENTINEL) } })
    }
    table.columns.push({ name: '字段 名称', comment: SENTINEL }, { name: 'spaces allowed' }, { name: 'x'.repeat(128) })
  }
  assert.deepEqual(inspect(input), expected())
})

test('throwing accessors and proxies return fixed values-free issues', () => {
  for (const target of ['config', 'dialect', 'catalog', 'tableName', 'columnName']) {
    const input = fixture()
    const explode = { get() { throw new Error(SENTINEL) } }
    if (['config', 'dialect', 'catalog'].includes(target)) Object.defineProperty(input, target, explode)
    else if (target === 'tableName') Object.defineProperty(input.catalog[0], 'name', explode)
    else Object.defineProperty(input.catalog[0].columns[0], 'name', explode)
    const path = target === 'config' ? 'config' : target === 'dialect' ? 'dialect' : 'catalog'
    const code = target === 'config' ? 'CONFIG_INVALID' : target === 'dialect' ? 'DIALECT_UNSUPPORTED' : 'CATALOG_INVALID'
    assert.deepEqual(inspect(input), expected([{ path, code }]))
  }
  const input = fixture()
  input.catalog = new Proxy(input.catalog, { get() { throw new Error(SENTINEL) } })
  assert.deepEqual(inspect(input), expected([{ path: 'catalog', code: 'CATALOG_INVALID' }]))
})

test('array iteration cannot bypass catalog and column count bounds', () => {
  const input = fixture()
  Object.defineProperty(input.catalog, Symbol.iterator, { value() { throw new Error(SENTINEL) } })
  for (let index = 0; index < input.catalog.length; index += 1) {
    Object.defineProperty(input.catalog[index].columns, Symbol.iterator, { value() { throw new Error(SENTINEL) } })
  }
  assert.deepEqual(inspect(input), expected())
  for (const length of [Infinity, -1, 1.5, '1']) {
    const invalid = fixture()
    invalid.catalog = new Proxy(invalid.catalog, { get(target, key) { return key === 'length' ? length : target[key] } })
    assert.deepEqual(inspect(invalid), expected([{ path: 'catalog', code: 'CATALOG_INVALID' }]))
    const invalidColumns = fixture()
    const table = tableFor(invalidColumns, 'part')
    table.columns = new Proxy(table.columns, { get(target, key) { return key === 'length' ? length : target[key] } })
    assert.deepEqual(inspect(invalidColumns), expected([{ path: 'catalog', code: 'CATALOG_INVALID' }]))
  }
})

test('inspection does not mutate inputs and emits a fresh result', () => {
  const input = fixture()
  const before = clone(input)
  function freeze(value) {
    if (!value || typeof value !== 'object') return
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  freeze(input)
  const first = inspect(input)
  const second = inspect(input)
  assert.deepEqual(input, before)
  assert.deepEqual(first, expected())
  assert.notEqual(first, second)
  assert.notEqual(first.issues, second.issues)
})

test('output ordering follows seven roles and required then optional fields, regardless of metadata order', () => {
  const input = fixture()
  for (const table of input.catalog) table.columns = [{ name: 'unrelated' }]
  const issues = FIELD_SLOTS.map(([role, field]) => fieldIssue(role, field, 'FIELD_MISSING'))
  assert.deepEqual(inspect(input), expected(issues))
  input.catalog.reverse()
  for (const table of input.catalog) table.columns.reverse()
  assert.deepEqual(inspect(input), expected(issues))
  for (const issue of inspect(input).issues) assert.deepEqual(Object.keys(issue), ['path', 'code'])
})
