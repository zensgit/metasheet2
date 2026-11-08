'use strict'

// Parity for one synthetic input across the three places that compute a v3 YiDa plan:
//   1. template import  (parseYidaRuleTemplate on the checked-in synthetic material template),
//   2. browser preview  (the panel's own sequence: validate -> parse rows -> static plan or
//                        allocation preview, see StockPreparationYidaPreviewPanel.vue runPreview),
//   3. host recompute   (compileYidaLocalDraft in yida-draft-compiler.mjs; the persisted path re-exports only v2).
// The web spec drives the real panel from the same template and asserts it renders (2).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')

const lib = (name) => import(pathToFileURL(path.join(__dirname, '..', 'lib', name)).href)
const plannerPromise = lib('yida-static-plan.mjs')
const allocationPromise = lib('stock-preparation-yida-allocation.mjs')
const templatePromise = lib('yida-rule-template.mjs')
const draftPromise = lib('yida-draft-compiler.mjs')
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'yida-rule-templates', 'material-v3.json')
const TARGET = { appType: 'synthetic_parity_app', formUuid: 'synthetic_parity_form' }
const PROJECTS = ['SYN-PROJECT-01', 'SYN-PROJECT-02']

// R-71 ⑦.4 (A7): an oracle for the example's generated material code that shares no code with the
// planner or the material-code leaf: node:crypto SHA-1 and the UUIDv5 bit layout, frozen inputs.
function oracleMaterialCode(keyValue, projectNo) {
  const digest = require('node:crypto').createHash('sha1').update(Buffer.from('6d37f698e75c4b5e8eefb702478a1cfb', 'hex'))
    .update(Buffer.from(JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', keyValue, projectNo]), 'utf8')).digest().subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = digest.toString('hex').toUpperCase()
  return `WLBH-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// The exporter writes LF. A core.autocrlf=true checkout hands the fixture back with CRLF, so the
// comparison is on LF-normalized text; any other byte difference still fails the exact equality.
function readFixture() {
  return fs.readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')
}

function withoutTarget(config) {
  const { target: _target, ...rules } = config
  return rules
}

// Mirror of the panel's runPreview: original mode plans the rows as given; any other mode
// goes through the allocation preview and takes its plan.
async function browserPlan(rules, rowsText, allocation) {
  const { buildYidaStaticPlan, parseYidaStaticRows, validateYidaStaticConfig } = await plannerPromise
  const { buildYidaProjectAllocationPreview } = await allocationPromise
  const config = { ...rules, target: TARGET }
  if (allocation.mode !== 'original') {
    return buildYidaProjectAllocationPreview({ config, rowsText, allocation }).plan
  }
  const checked = validateYidaStaticConfig(config)
  assert.equal(checked.valid, true)
  return buildYidaStaticPlan({ config: checked.normalized, rows: parseYidaStaticRows(rowsText, checked.normalized) })
}

test('the checked-in synthetic v3 material template is exactly what the exporter writes for the example', async () => {
  const { createYidaTransformExample, validateYidaStaticConfig } = await plannerPromise
  const { exportYidaRuleTemplate, parseYidaRuleTemplate } = await templatePromise
  const example = createYidaTransformExample()
  const text = exportYidaRuleTemplate({ rules: withoutTarget(example.config), allocation: example.allocation })
  assert.equal(readFixture(), `${text}\n`)
  const imported = parseYidaRuleTemplate(text)
  assert.equal(imported.formatVersion, 2)
  assert.deepEqual(imported.rules, withoutTarget(validateYidaStaticConfig(example.config).normalized))
  assert.deepEqual(imported.allocation, example.allocation)
  assert.equal(exportYidaRuleTemplate({ rules: imported.rules, allocation: imported.allocation }), text)
  // Values-free: placeholders only, no target and no row data in the template.
  assert.doesNotMatch(text, /appType|formUuid|DEMO-|SYN-LINE|FORM-|APP_/)
})

test('template import -> browser preview -> host recompute: identical rules and plan, original and allocated', async () => {
  const { createYidaTransformExample } = await plannerPromise
  const { exportYidaRuleTemplate, parseYidaRuleTemplate } = await templatePromise
  const { compileYidaLocalDraft } = await draftPromise
  const example = createYidaTransformExample()
  const imported = parseYidaRuleTemplate(readFixture())
  for (const allocation of [{ mode: 'original' }, { ...imported.allocation, projects: PROJECTS }]) {
    const browser = await browserPlan(imported.rules, example.text, allocation)
    const host = compileYidaLocalDraft({ config: { ...imported.rules, target: TARGET }, rowsText: example.text, allocation })
    assert.deepEqual(withoutTarget(host.source.config), imported.rules)
    assert.deepEqual(host.plan, browser, allocation.mode)
    assert.equal(browser.evidence.invalid, 0)
    // The host's own rule identity matches a fresh export of what it compiled.
    assert.equal(exportYidaRuleTemplate({ rules: withoutTarget(host.source.config), allocation: imported.allocation }),
      readFixture().replace(/\n$/, ''))
  }
})

test('independent oracle for the first allocated row: values, constants, copy, concat, the generated code and the target-bound key', async () => {
  const { createYidaTransformExample } = await plannerPromise
  const { parseYidaRuleTemplate } = await templatePromise
  const { compileYidaLocalDraft } = await draftPromise
  const imported = parseYidaRuleTemplate(readFixture())
  const example = createYidaTransformExample()
  const host = compileYidaLocalDraft({ config: { ...imported.rules, target: TARGET }, rowsText: example.text,
    allocation: { ...imported.allocation, projects: PROJECTS } })
  assert.equal(host.plan.rows.length, 4)
  assert.deepEqual(host.plan.rows[0].payload, {
    project: 'SYN-PROJECT-01', drawingNo: 'DEMO-DRW-1', partName: '示例部件', specification: 'SPEC-1',
    materialGrade: 'MAT-1', versionNo: 'V1', totalQty: 2, blankSize: '1200*600*20', materialTypeText: 'SYN-BLANK',
    processRule: 'SYN-RULE-A', allowNegativeStock: 'SYN-NO', defaultText: 'SYN-DEFAULT', sourceLineId: 'SYN-LINE-1',
    materialCodeText: oracleMaterialCode('SYN-LINE-1', 'SYN-PROJECT-01'),
  })
  assert.deepEqual(host.plan.rows[3].payload, {
    project: 'SYN-PROJECT-02', drawingNo: 'DEMO-DRW-2', partName: '示例子件', materialGrade: 'MAT-2', versionNo: 'V1',
    parentDrawingNo: 'DEMO-DRW-1', parentPartName: '示例部件', partCategory: '示例部件', totalQty: 3,
    processRule: 'SYN-RULE-A', allowNegativeStock: 'SYN-NO', defaultText: 'SYN-DEFAULT', sourceLineId: 'SYN-LINE-2',
    materialCodeText: oracleMaterialCode('SYN-LINE-2', 'SYN-PROJECT-02'),
  })
  // Split rows of one source row get their own codes; the codes are the payload's only generated bytes.
  assert.deepEqual(host.plan.rows.map((row) => row.payload.materialCodeText), [['SYN-LINE-1', 'SYN-PROJECT-01'], ['SYN-LINE-1', 'SYN-PROJECT-02'],
    ['SYN-LINE-2', 'SYN-PROJECT-01'], ['SYN-LINE-2', 'SYN-PROJECT-02']].map(([keyValue, projectNo]) => oracleMaterialCode(keyValue, projectNo)))
  assert.equal(host.plan.rows[0].localBusinessKey, JSON.stringify(['yida-protocol-v2', TARGET.appType, TARGET.formUuid, [
    ['drawingNo', 'string', 'DEMO-DRW-1'], ['materialGrade', 'string', 'MAT-1'], ['parentDrawingNo', 'string', ''],
    ['partName', 'string', '示例部件'], ['project', 'string', 'SYN-PROJECT-01'], ['specification', 'string', 'SPEC-1'],
    ['versionNo', 'string', 'V1'],
  ]]))
  assert.deepEqual(host.keyDefinition.fields.map((field) => field.target),
    ['drawingNo', 'materialGrade', 'parentDrawingNo', 'partName', 'project', 'specification', 'versionNo'])
})

test('issues: the browser plan reports them; the host refuses to compile a draft with any of them', async () => {
  const { createYidaTransformExample } = await plannerPromise
  const { parseYidaRuleTemplate } = await templatePromise
  const { compileYidaLocalDraft } = await draftPromise
  const imported = parseYidaRuleTemplate(readFixture())
  const rows = createYidaTransformExample().rows.map((item) => ({ ...item }))
  rows[0].ext_blankWidth = null
  rows[1].material = ''
  const rowsText = JSON.stringify(rows)
  const browser = await browserPlan(imported.rules, rowsText, { mode: 'original' })
  assert.deepEqual(browser.rows.map((item) => item.issues), [
    [{ index: 0, code: 'FIELD_PART_MISSING', fields: [{ target: 'blankSize', type: 'string', transform: 'concat' }] }],
    [{ index: 1, code: 'KEY_MISSING', fields: [{ source: 'material', target: 'materialGrade', type: 'string', transform: 'direct' }] }],
  ])
  assert.throws(() => compileYidaLocalDraft({ config: { ...imported.rules, target: TARGET }, rowsText, allocation: { mode: 'original' } }),
    (error) => error.code === 'YIDA_DRAFT_PLAN')
})

test('template envelope: v1/v2 rules stay formatVersion 1; v3 rules need formatVersion 2; numbers stay exact', async () => {
  const { createYidaProtocolExample, createYidaTransformExample } = await plannerPromise
  const { exportYidaRuleTemplate, parseYidaRuleTemplate } = await templatePromise
  const v2 = exportYidaRuleTemplate({ rules: withoutTarget(createYidaProtocolExample().config), allocation: { mode: 'original' } })
  assert.match(v2, /"formatVersion": 1,/)
  assert.equal(parseYidaRuleTemplate(v2).formatVersion, 1)
  const text = readFixture()
  const code = (kind) => (error) => error.code === `YIDA_RULE_TEMPLATE_${kind}`
  assert.throws(() => parseYidaRuleTemplate(text.replace('"formatVersion": 2', '"formatVersion": 1')), code('TEXT'))
  assert.throws(() => parseYidaRuleTemplate(v2.replace('"formatVersion": 1', '"formatVersion": 2')), code('INPUT'))
  // Numeric constants are read only in their exact JavaScript spelling.
  const example = createYidaTransformExample()
  const numeric = withoutTarget(example.config)
  numeric.fieldCatalog = [...numeric.fieldCatalog, { id: 'syntheticFactor', control: 'number', required: false }]
  numeric.fieldMap = [...numeric.fieldMap, { transform: 'constant', value: 0.25, target: 'syntheticFactor', type: 'number', required: false }]
  const withNumber = exportYidaRuleTemplate({ rules: numeric, allocation: example.allocation })
  assert.equal(parseYidaRuleTemplate(withNumber).rules.fieldMap.at(-1).value, 0.25)
  for (const spelling of ['0.250', '2.5e-1', '-0', '00.25', '.25']) {
    assert.throws(() => parseYidaRuleTemplate(withNumber.replace('"value": 0.25', `"value": ${spelling}`)), code('TEXT'), spelling)
  }
})
