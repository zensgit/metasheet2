'use strict'

// DF-T3a reference-mapping sheet template tests. Plain node test (throws on failure). Focus:
// manifest schema, NO customer content, required columns present, dangerous fields/values rejected.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  REFERENCE_MAPPING_IDENTIFIERS,
  K3_REFERENCE_MAPPING_TEMPLATES,
  ReferenceMappingTemplateError,
  normalizeReferenceMappingTemplate,
  buildSheetStructureFromTemplate,
} = require(path.join(__dirname, '..', 'lib', 'reference-mapping-templates.cjs'))

function baseTemplate(overrides = {}) {
  return {
    id: 'k3wise.refmap.unit.v1',
    domain: 'unit',
    identifier: 'FNumber',
    columns: [
      { name: 'sourceCode', type: 'text', required: true, key: true },
      { name: 'fNumber', type: 'text', required: true },
      { name: 'fName', type: 'text', required: true },
      { name: 'enabled', type: 'checkbox' },
      { name: 'notes', type: 'text' },
    ],
    ...overrides,
  }
}

function main() {
  // --- built-in templates: schema-only, required columns present, identifier mapping correct ---
  assert.equal(K3_REFERENCE_MAPPING_TEMPLATES.length, 12)
  const byDomain = Object.fromEntries(K3_REFERENCE_MAPPING_TEMPLATES.map((t) => [t.domain, t]))
  // full customer-profile coverage: 5 BY_NUMBER + 7 BY_ID domains (locks against silent drop)
  assert.deepEqual(
    K3_REFERENCE_MAPPING_TEMPLATES.map((t) => t.domain).sort(),
    ['account', 'category', 'inspection-level', 'inspection-mode', 'manager', 'order-strategy', 'planning-strategy', 'track', 'unit', 'unit-group', 'use-state', 'warehouse'],
    'built-in domain set (5 BY_NUMBER + 7 BY_ID)',
  )
  for (const t of K3_REFERENCE_MAPPING_TEMPLATES) {
    const names = t.columns.map((c) => c.name)
    const idCol = t.identifier === 'FID' ? 'fID' : 'fNumber'
    for (const req of ['sourceCode', idCol, 'fName', 'enabled']) {
      assert.ok(names.includes(req), `${t.domain} has column ${req}`)
    }
    assert.ok(t.columns.find((c) => c.name === 'sourceCode').key, `${t.domain} sourceCode is the key`)
    // NO customer content anywhere on a built-in template
    for (const k of ['rows', 'records', 'data', 'values', 'content']) assert.ok(!(k in t), `${t.domain} has no ${k}`)
    for (const c of t.columns) {
      assert.ok(!('value' in c) && !('default' in c), `${t.domain}.${c.name} carries no value/default`)
    }
  }
  // identifier mapping: 5 BY_NUMBER domains → FNumber/require-fnumber-fname + fNumber column
  for (const d of ['unit', 'unit-group', 'account', 'warehouse', 'manager']) {
    assert.equal(byDomain[d].identifier, 'FNumber', `${d} FNumber`)
    assert.equal(byDomain[d].completeness, 'require-fnumber-fname', `${d} completeness`)
    assert.ok(byDomain[d].columns.some((c) => c.name === 'fNumber'), `${d} has fNumber`)
  }
  // 7 BY_ID domains → FID/require-fid-fname + fID column (category + the enum/strategy/inspection family)
  for (const d of ['category', 'use-state', 'track', 'planning-strategy', 'order-strategy', 'inspection-level', 'inspection-mode']) {
    assert.equal(byDomain[d].identifier, 'FID', `${d} FID`)
    assert.equal(byDomain[d].completeness, 'require-fid-fname', `${d} completeness`)
    assert.ok(byDomain[d].columns.some((c) => c.name === 'fID'), `${d} has fID`)
  }
  assert.deepEqual([...REFERENCE_MAPPING_IDENTIFIERS], ['FNumber', 'FID'])

  // --- create-from-template → empty structure, ALWAYS zero rows ---
  const structure = buildSheetStructureFromTemplate(byDomain.unit)
  assert.deepEqual(structure.rows, [], 'structure has no rows (no customer content)')
  assert.ok(structure.columns.some((c) => c.name === 'sourceCode' && c.key))
  assert.equal(structure.identifier, 'FNumber')

  // --- dangerous fields / values rejected (no customer content can ride in) ---
  for (const contentKey of ['rows', 'records', 'data', 'values', 'content']) {
    assert.throws(
      () => normalizeReferenceMappingTemplate({ ...baseTemplate(), [contentKey]: [{ sourceCode: 'X' }] }),
      ReferenceMappingTemplateError,
      `manifest "${contentKey}" rejected`,
    )
  }
  // a column carrying a value/default would smuggle content
  assert.throws(
    () => normalizeReferenceMappingTemplate(baseTemplate({
      columns: [{ name: 'sourceCode', type: 'text', key: true, value: 'EA' }, { name: 'fNumber', type: 'text' }, { name: 'fName', type: 'text' }, { name: 'enabled', type: 'checkbox' }],
    })),
    ReferenceMappingTemplateError,
    'column value rejected',
  )
  // a secret-shaped column name
  assert.throws(
    () => normalizeReferenceMappingTemplate(baseTemplate({
      columns: [{ name: 'postgres://u:p@h/db', type: 'text', key: true }, { name: 'fNumber', type: 'text' }, { name: 'fName', type: 'text' }, { name: 'enabled', type: 'checkbox' }, { name: 'sourceCode', type: 'text' }],
    })),
    ReferenceMappingTemplateError,
    'secret-shaped column name rejected',
  )
  // bad identifier / completeness mismatch
  assert.throws(() => normalizeReferenceMappingTemplate(baseTemplate({ identifier: 'FCode' })), ReferenceMappingTemplateError, 'bad identifier rejected')
  assert.throws(() => normalizeReferenceMappingTemplate(baseTemplate({ completeness: 'require-fid-fname' })), ReferenceMappingTemplateError, 'completeness mismatch rejected')
  // missing required column (no fName)
  assert.throws(
    () => normalizeReferenceMappingTemplate(baseTemplate({
      columns: [{ name: 'sourceCode', type: 'text', key: true }, { name: 'fNumber', type: 'text' }, { name: 'enabled', type: 'checkbox' }],
    })),
    ReferenceMappingTemplateError,
    'missing fName rejected',
  )
  // sourceCode not the key
  assert.throws(
    () => normalizeReferenceMappingTemplate(baseTemplate({
      columns: [{ name: 'sourceCode', type: 'text' }, { name: 'fNumber', type: 'text' }, { name: 'fName', type: 'text' }, { name: 'enabled', type: 'checkbox' }],
    })),
    ReferenceMappingTemplateError,
    'sourceCode-not-key rejected',
  )
  // bad column type (not text/checkbox — e.g. would allow a formula/sql column)
  assert.throws(
    () => normalizeReferenceMappingTemplate(baseTemplate({
      columns: [{ name: 'sourceCode', type: 'sql', key: true }, { name: 'fNumber', type: 'text' }, { name: 'fName', type: 'text' }, { name: 'enabled', type: 'checkbox' }],
    })),
    ReferenceMappingTemplateError,
    'bad column type rejected',
  )

  // --- the REAL safety net: the output whitelist drops ANY unanticipated key, even one NOT in the
  // forbidden list. A capital-D "Data" envelope (#1882 shape) sails past the lowercase throw check,
  // so the guarantee must rest on the allow-list projection, not on enumerating every bad key name. ---
  const withExtra = normalizeReferenceMappingTemplate({ ...baseTemplate(), Data: [{ FNumber: 'X', FName: 'Y' }], extraJunk: 'drop-me' })
  assert.ok(!('Data' in withExtra) && !('extraJunk' in withExtra), 'normalize whitelists output (drops unanticipated keys)')
  const structFromExtra = buildSheetStructureFromTemplate({ ...baseTemplate(), Data: [{ FNumber: 'X' }], extraJunk: 'drop-me' })
  assert.ok(!('Data' in structFromExtra) && !('extraJunk' in structFromExtra), 'structure whitelists output')
  assert.deepEqual(structFromExtra.rows, [], 'structure still has no rows despite a Data envelope on input')

  console.log('reference-mapping-templates.test.cjs OK')
}

main()
