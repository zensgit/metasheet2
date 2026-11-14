'use strict'

// 批次标识 BI-1a (register R-65; design §4.1-§4.3) — THE BAND (lib/stock-preparation-templates.cjs): two machine string
// columns OUTSIDE the main template (owner 2026-11-07), their property (the PLM lock + the `stockPreparationPullBatch`
// marker carrying the 人工补充 literal), their descriptors per placement, the load-time contract, and the three `ext_`
// collision catalogs (customer pack, target provisioning, table actions) that now refuse `ext_pullBatch` /
// `ext_firstPullBatch`. M-BI-1 ("add the band to the template") turns TB-1 red here, and the completeness and golden
// suites elsewhere. Nothing reads these exports yet (BI-1b / BI-2). Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const tp = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const pure = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const customerPack = require(path.join(LIB, 'stock-preparation-customer-pack.cjs'))
const provisioning = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TEMPLATE = tp.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
const BAND = ['firstPullBatch', 'pullBatch']

test('TB-1 (M-BI-1) the band stays OUTSIDE the main template; its ids are the pure module\'s, machine string columns, labelled in both locales', () => {
  assert.deepEqual([...tp.STOCK_PREPARATION_PULL_BATCH_FIELD_IDS], BAND)
  assert.deepEqual([...tp.STOCK_PREPARATION_PULL_BATCH_FIELD_IDS], [pure.PULL_BATCH_BAND_FIELD_IDS.firstPullBatch, pure.PULL_BATCH_BAND_FIELD_IDS.pullBatch])
  const templateIds = new Set(TEMPLATE.fields.map((field) => field.id))
  for (const id of BAND) {
    assert.equal(templateIds.has(id), false, `${id} is not a template field`)
    assert.equal(tp.HUMAN_PRESERVED_FIELD_IDS.includes(id), false, `${id} is not human`)
  }
  assert.deepEqual(tp.STOCK_PREPARATION_PULL_BATCH_FIELDS.map((f) => [f.id, f.label, f.labelZh, f.type]), [
    ['firstPullBatch', 'First Pull Batch', '首次批次', 'string'],
    ['pullBatch', 'Pull Batch', '本次拉取', 'string'],
  ])
  assert.ok(Object.isFrozen(tp.STOCK_PREPARATION_PULL_BATCH_FIELDS) && tp.STOCK_PREPARATION_PULL_BATCH_FIELDS.every(Object.isFrozen))
  assert.equal(tp.assertPullBatchBandContract(), true)
})

test('TB-2 the property: the PLM lock and the v1 marker carrying the manual literal of the sheet\'s locale; the predicate needs BOTH', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(tp.pullBatchBandProperty('zh-CN'))), { humanWriteLock: 'plm_system', stockPreparationPullBatch: { band: 'v1', manualLabel: '人工补充' } })
  assert.deepEqual(JSON.parse(JSON.stringify(tp.pullBatchBandProperty('en'))), { humanWriteLock: 'plm_system', stockPreparationPullBatch: { band: 'v1', manualLabel: 'Manual row' } })
  assert.equal(tp.pullBatchBandProperty('zh-CN').stockPreparationPullBatch.manualLabel, pure.PULL_BATCH_MANUAL_LABELS['zh-CN'])
  assert.equal(pure.parsePullBatchLabel(tp.pullBatchBandProperty('en').stockPreparationPullBatch.manualLabel).kind, 'manual', 'the literal parses as manual, never unknown')
  assert.equal(tp.STOCK_PREPARATION_PULL_BATCH_BAND_MARKER, 'v1')
  assert.equal(tp.isPullBatchBandProperty(tp.pullBatchBandProperty('en')), true)
  assert.equal(tp.isPullBatchBandProperty({ stockPreparationPullBatch: { band: 'v1' } }), false, 'a marker without the PLM lock (a person can set the marker, never the lock)')
  assert.equal(tp.isPullBatchBandProperty({ humanWriteLock: 'plm_system', stockPreparationPullBatch: { band: 'v2' } }), false)
  assert.equal(tp.isPullBatchBandProperty({ humanWriteLock: 'plm_system' }), false)
  assert.equal(tp.isPullBatchBandProperty(null), false)
})

test('TB-3 descriptors: left => order -2 / -1; right => after the largest existing order (required); placement is closed and REQUIRED; the page setting\'s vocabulary is the band\'s', () => {
  assert.deepEqual([...tp.STOCK_PREPARATION_PULL_BATCH_PLACEMENTS], [...pure.PULL_BATCH_CONFIG_VALUES.placement])
  const left = tp.pullBatchBandFieldDescriptors({ locale: 'zh-CN', placement: 'left' })
  assert.deepEqual(left.map((d) => [d.id, d.name, d.type, d.order]), [['firstPullBatch', '首次批次', 'string', -2], ['pullBatch', '本次拉取', 'string', -1]])
  assert.ok(left.every((d) => tp.isPullBatchBandProperty(d.property)))
  const right = tp.pullBatchBandFieldDescriptors({ locale: 'en', placement: 'right', maxExistingOrder: 41 })
  assert.deepEqual(right.map((d) => [d.id, d.name, d.order]), [['firstPullBatch', 'First Pull Batch', 42], ['pullBatch', 'Pull Batch', 43]])
  assert.equal(right[0].property.stockPreparationPullBatch.manualLabel, 'Manual row')
  for (const bad of [{ placement: 'right' }, { placement: 'right', maxExistingOrder: 1.5 }, { placement: 'middle' }, { placement: undefined }, {}]) {
    assert.throws(() => tp.pullBatchBandFieldDescriptors({ locale: 'en', ...bad }), (error) => error.name === 'StockPreparationTemplateError', JSON.stringify(bad))
  }
})

test('TB-4 the load-time contract refuses a band that is in the template, human, an ext_ id, named by a fill-view constant, or not two distinct ids', () => {
  const withBand = { ...TEMPLATE, fields: TEMPLATE.fields.concat([{ id: 'pullBatch', label: 'Pull Batch', type: 'string' }]) }
  assert.throws(() => tp.assertPullBatchBandContract({ template: withBand }), /outside the main template/)
  // A human id is also a template id; an empty template isolates the human check.
  assert.throws(() => tp.assertPullBatchBandContract({ template: { fields: [] }, bandFieldIds: ['firstPullBatch', tp.HUMAN_PRESERVED_FIELD_IDS[0]] }), /never human/)
  assert.throws(() => tp.assertPullBatchBandContract({ bandFieldIds: ['firstPullBatch', 'ext_pullBatch'] }), /not a tenant extension/)
  assert.throws(() => tp.assertPullBatchBandContract({ hiddenFieldIds: ['pullBatch'] }), /fill view/)
  assert.throws(() => tp.assertPullBatchBandContract({ sortFieldIds: ['firstPullBatch'] }), /fill view/)
  assert.throws(() => tp.assertPullBatchBandContract({ groupFieldIds: ['pullBatch'] }), /fill view/)
  assert.throws(() => tp.assertPullBatchBandContract({ activeFilterFieldId: 'pullBatch' }), /fill view/)
  assert.throws(() => tp.assertPullBatchBandContract({ bandFieldIds: ['pullBatch', 'pullBatch'] }), /two distinct/)
  assert.throws(() => tp.assertPullBatchBandContract({ bandFieldIds: ['pullBatch'] }), /two distinct/)
  for (const list of [tp.STOCK_PREPARATION_FILL_VIEW_HIDDEN_FIELD_IDS, tp.STOCK_PREPARATION_FILL_VIEW_SORT_FIELD_IDS, tp.STOCK_PREPARATION_FILL_VIEW_GROUP_FIELD_IDS, [tp.STOCK_PREPARATION_FILL_VIEW_ACTIVE_FILTER_FIELD_ID]]) {
    for (const id of BAND) assert.equal(list.includes(id), false, `the fill view never names ${id}`)
  }
})

test('TB-5 the three ext_ collision catalogs refuse ext_pullBatch / ext_firstPullBatch (template collision) and still accept an ordinary ext_ id', () => {
  for (const id of ['ext_pullBatch', 'ext_firstPullBatch']) {
    assert.throws(() => customerPack.__internals.normalizeExtensionFields([{ id, label: 'X', type: 'string', ownership: 'human_preserved' }]),
      (error) => error.details && error.details.namespaceReason === 'FIELD_ID_TEMPLATE_COLLISION', `customer pack ${id}`)
    assert.throws(() => provisioning.__internals.normalizeExtensionFieldIds([id], TEMPLATE),
      (error) => error.reason === 'FIELD_ID_TEMPLATE_COLLISION', `provisioning ${id}`)
    assert.throws(() => tableActions.__internals.normalizeActionExtensionFieldIds([id], TEMPLATE),
      (error) => error.code === 'TABLE_ACTION_CONFIG_INVALID' && error.details.namespaceReason === 'FIELD_ID_TEMPLATE_COLLISION', `table actions ${id}`)
  }
  assert.equal(customerPack.__internals.normalizeExtensionFields([{ id: 'ext_remark', label: 'X', type: 'string', ownership: 'human_preserved' }]).length, 1)
  assert.deepEqual(provisioning.__internals.normalizeExtensionFieldIds(['ext_remark'], TEMPLATE), ['ext_remark'])
  assert.deepEqual(tableActions.__internals.normalizeActionExtensionFieldIds(['ext_remark'], TEMPLATE), ['ext_remark'])
  // The catalog widening never makes a band id a TEMPLATE id elsewhere: the template-id helpers are unchanged.
  assert.deepEqual(provisioning.__internals.templateFieldIds(TEMPLATE), TEMPLATE.fields.map((field) => field.id))
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-band.test.cjs', tests)
