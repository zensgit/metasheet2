'use strict'

// #2253 C1 stock-preparation manifest tests. Plain node test (throws on failure).
// Locks the schema-only contract, human/PLM ownership split, and the C1/C2
// BOM-read feasibility gate. No runtime, PLM read, MetaSheet write, or K3 path.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  REQUIRED_SYSTEM_FIELDS,
  HUMAN_PRESERVED_FIELD_IDS,
  FEASIBILITY_FORBIDDEN_MECHANISMS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  StockPreparationTemplateError,
  normalizeStockPreparationTemplate,
  normalizeBomReadFeasibilityGate,
  buildSheetStructureFromTemplate,
  summarizeTemplateForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function baseTemplate(overrides = {}) {
  return {
    ...clone(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE),
    ...overrides,
  }
}

function main() {
  const template = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
  assert.equal(template.id, 'plm.stock-preparation.main.v1')
  assert.equal(template.objectId, 'plm_stock_preparation_main')
  assert.deepEqual(template.keyFields, ['idempotencyKey'])

  const byId = Object.fromEntries(template.fields.map((field) => [field.id, field]))

  // PLM/system fields are explicit and contain the C0-required idempotency/run/conflict fields.
  for (const id of REQUIRED_SYSTEM_FIELDS) {
    assert.ok(byId[id], `required PLM/system field exists: ${id}`)
    assert.equal(byId[id].ownership, 'plm_system', `${id} is PLM/system-owned`)
  }
  assert.equal(byId.idempotencyKey.key, true, 'idempotencyKey is the key')
  assert.equal(byId.idempotencyKey.required, true, 'idempotencyKey is required')
  assert.equal(byId.totalQuantity.type, 'number')
  assert.equal(byId.active.type, 'boolean')

  // Human-owned preserve whitelist is exact and every field is preserveOnRefresh.
  const humanIds = template.fields.filter((field) => field.ownership === 'human_preserved').map((field) => field.id)
  assert.deepEqual(humanIds, [...HUMAN_PRESERVED_FIELD_IDS], 'human preserve whitelist is exact and ordered')
  for (const id of HUMAN_PRESERVED_FIELD_IDS) {
    assert.equal(byId[id].preserveOnRefresh, true, `${id} preserves on PLM refresh`)
  }

  // config_info option sources are schema references only, not option values.
  assert.deepEqual(byId.materialType.optionSource, { type: 'config_info', key: 'material_type' })
  assert.deepEqual(byId.blankType.optionSource, { type: 'config_info', key: 'blank_type' })
  assert.deepEqual(byId.stockPreparationStatus.optionSource, { type: 'config_info', key: 'stock_preparation_status' })
  for (const field of template.fields) {
    assert.ok(!('options' in field), `${field.id} carries no inline option values`)
    assert.ok(!('value' in field) && !('default' in field), `${field.id} carries no value/default`)
  }

  // Feasibility gate: explicit no-raw-SQL => app-side recursion over flat parameterized reads.
  const gate = template.feasibilityGate
  assert.equal(gate.mode, 'flat_parameterized_reads')
  assert.equal(gate.sourceKind, 'data-source:sql-readonly')
  assert.equal(gate.matchField, 'FileCode')
  assert.equal(gate.sourceIdField, 'OBJ_ID')
  assert.equal(gate.status, 'requires_customer_schema')
  assert.deepEqual(gate.forbiddenMechanisms, [...FEASIBILITY_FORBIDDEN_MECHANISMS])
  assert.deepEqual(
    gate.relationDescriptors.map((relation) => relation.kind).sort(),
    ['children_by_parent', 'root_by_project'],
    'root + child relation descriptors are required',
  )

  // create-from-template returns an empty sheet structure; no customer content can ride along.
  const structure = buildSheetStructureFromTemplate(template)
  assert.equal(structure.objectId, 'plm_stock_preparation_main')
  assert.deepEqual(structure.rows, [], 'structure has no rows')
  assert.ok(structure.fields.some((field) => field.id === 'idempotencyKey' && field.property.validation[0].type === 'required'))

  // Evidence summary is values-free: ids/ownership/types/gate state only.
  const evidence = summarizeTemplateForEvidence(template)
  assert.ok(!JSON.stringify(evidence).includes('P2026-001'), 'evidence has no project value')
  assert.ok(!JSON.stringify(evidence).includes('Widget'), 'evidence has no business row value')
  assert.deepEqual(evidence.humanPreservedFields, [...HUMAN_PRESERVED_FIELD_IDS])
  assert.deepEqual(evidence.feasibilityGate.relationDescriptorKinds.sort(), ['children_by_parent', 'root_by_project'])

  // Schema-only manifest rejects content-like keys at top level and field level.
  for (const contentKey of ['rows', 'records', 'data', 'values', 'content', 'sample', 'payload', 'payloadTemplate', 'rawSql', 'sql', 'query', 'storedProcedure']) {
    assert.throws(
      () => normalizeStockPreparationTemplate(baseTemplate({ [contentKey]: [{ projectNo: 'P2026-001' }] })),
      StockPreparationTemplateError,
      `top-level ${contentKey} rejected`,
    )
  }
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      fields: [
        ...template.fields,
        { id: 'bad', label: 'Bad', type: 'string', ownership: 'plm_system', default: 'customer value' },
      ],
    })),
    StockPreparationTemplateError,
    'field default rejected',
  )

  // Contract drift fail-closed: bad field ownership/type, missing required groups, duplicate ids.
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      fields: template.fields.map((field) => field.id === 'notes' ? { ...field, ownership: 'plm_system' } : field),
    })),
    StockPreparationTemplateError,
    'human whitelist drift rejected',
  )
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      fields: template.fields.map((field) => field.id === 'componentCode' ? { ...field, type: 'sql' } : field),
    })),
    StockPreparationTemplateError,
    'bad field type rejected',
  )
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      fields: template.fields.concat({ ...template.fields[0] }),
    })),
    StockPreparationTemplateError,
    'duplicate field id rejected',
  )
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      keyFields: ['componentCode'],
    })),
    StockPreparationTemplateError,
    'keyFields missing idempotencyKey rejected',
  )

  // PLM/system fields cannot be accidentally marked preserveOnRefresh.
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      fields: template.fields.map((field) => field.id === 'componentName' ? { ...field, preserveOnRefresh: true } : field),
    })),
    StockPreparationTemplateError,
    'PLM/system preserveOnRefresh rejected',
  )

  // Feasibility gate rejects every forbidden shape: non-readonly source, non-flat mode,
  // non-FileCode match, missing forbidden mechanism, and SQL/stored-proc payloads.
  assert.throws(
    () => normalizeBomReadFeasibilityGate({ ...gate, sourceKind: 'plm:adapter' }),
    StockPreparationTemplateError,
    'non-readonly source rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({ ...gate, mode: 'recursive_cte' }),
    StockPreparationTemplateError,
    'recursive CTE mode rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({ ...gate, matchField: 'ProjectNo' }),
    StockPreparationTemplateError,
    'non-FileCode match rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({ ...gate, forbiddenMechanisms: ['raw_sql', 'stored_procedure', 'vendor_api_call'] }),
    StockPreparationTemplateError,
    'missing recursive_cte forbidden mechanism rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({ ...gate, rawSql: 'WITH RECURSIVE bom AS (...) SELECT * FROM bom' }),
    StockPreparationTemplateError,
    'raw SQL on feasibility gate rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({
      ...gate,
      relationDescriptors: [{ id: 'root', kind: 'root_by_project', matchField: 'FileCode', sql: 'SELECT * FROM bom' }],
    }),
    StockPreparationTemplateError,
    'SQL on relation descriptor rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({
      ...gate,
      relationDescriptors: [{ id: 'root', kind: 'root_by_project', matchField: 'FileCode', sourceIdField: 'OBJ_ID' }],
    }),
    StockPreparationTemplateError,
    'missing child relation rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({
      ...gate,
      relationDescriptors: [
        { id: 'root', kind: 'root_by_project', sourceIdField: 'OBJ_ID' },
        { id: 'child', kind: 'children_by_parent', parentField: 'parentSourceId', childField: 'componentSourceId', sourceIdField: 'OBJ_ID' },
      ],
    }),
    StockPreparationTemplateError,
    'root relation missing matchField rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({
      ...gate,
      relationDescriptors: [
        { id: 'root', kind: 'root_by_project', matchField: 'FileCode', sourceIdField: 'OBJ_ID' },
        { id: 'child', kind: 'children_by_parent', childField: 'componentSourceId', sourceIdField: 'OBJ_ID' },
      ],
    }),
    StockPreparationTemplateError,
    'child relation missing parentField rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({
      ...gate,
      relationDescriptors: [
        { id: 'root', kind: 'root_by_project', matchField: 'FileCode', sourceIdField: 'OBJ_ID' },
        { id: 'child', kind: 'children_by_parent', parentField: 'parentSourceId', sourceIdField: 'OBJ_ID' },
      ],
    }),
    StockPreparationTemplateError,
    'child relation missing childField rejected',
  )
  assert.throws(
    () => normalizeBomReadFeasibilityGate({
      ...gate,
      relationDescriptors: [
        { id: 'root', kind: 'root_by_project', matchField: 'FileCode', sourceIdField: 'OBJ_ID' },
        { id: 'child', kind: 'children_by_parent', parentField: 'parentSourceId', childField: 'componentSourceId' },
      ],
    }),
    StockPreparationTemplateError,
    'child relation missing sourceIdField rejected',
  )

  // Secret-shaped schema strings are rejected, not scrubbed into a schema.
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      fields: template.fields.map((field) => field.id === 'notes' ? { ...field, label: 'Bearer abcdefghijklmnop' } : field),
    })),
    StockPreparationTemplateError,
    'secret-shaped label rejected',
  )
  assert.throws(
    () => normalizeStockPreparationTemplate(baseTemplate({
      fields: template.fields.map((field) => field.id === 'materialType' ? { ...field, optionSource: { type: 'config_info', key: 'token=abcdef123456' } } : field),
    })),
    StockPreparationTemplateError,
    'secret-shaped option source rejected',
  )

  console.log('stock-preparation-templates.test.cjs OK')
}

main()
