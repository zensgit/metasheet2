'use strict'

// 批次标识 BI-1a (register R-65; coordinator ruling C2, critic correction BI-1a §4) — ONE VOCABULARY. Every closed
// IN-list of migration 105 equals the constant the code validates with, read from the migration TEXT (the
// support/stock-preparation-refresh-store-kit.cjs precedent): the page settings against the pure module
// (lib/stock-preparation-pull-batch.cjs), the ledger's own lists against the pure module or the store. A token added
// to one side only (M-CFG-7: a value added to the module only) turns this suite red, so the store can never accept a
// value the database refuses with 23514 (which would surface as a 503), and the database never holds a value the code
// cannot read. Hermetic: no database.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const pure = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const store = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const kit = require('./support/stock-preparation-pull-batch-kit.cjs')

const tests = []
const test = (name, fn) => tests.push([name, fn])

const schema = kit.loadSchema()
const enumByName = new Map()
for (const table of Object.values(schema)) for (const entry of table.enums) enumByName.set(entry.name, entry)
const C = (suffix) => `integration_stock_prep_pull_batch_${suffix}`
function inList(name) {
  const entry = enumByName.get(name)
  assert.ok(entry, `migration 105 declares the closed CHECK ${name}`)
  return entry.values
}
const same = (actual, expected, label) => assert.deepEqual([...actual], [...expected], label)

test('VM-1 the four page settings: both tables\' CHECK IN-lists equal the pure module\'s vocabulary, in order (first = default)', () => {
  const vocab = pure.PULL_BATCH_CONFIG_VALUES
  const pairs = [
    ['firstPullBatchRule', 'settings_rule_check', 'sheet_rule_check'],
    ['labelFormat', 'settings_format_check', 'sheet_format_check'],
    ['landing', 'settings_landing_check', 'sheet_landing_check'],
    ['placement', 'settings_placement_check', 'sheet_placement_check'],
  ]
  for (const [key, tenantCheck, sheetCheck] of pairs) {
    same(inList(C(tenantCheck)), vocab[key], `${key}: tenant table vs module`)
    same(inList(C(sheetCheck)), vocab[key], `${key}: _sheet table vs module`)
    same(store.PULL_BATCH_SETTING_VALUES[key], vocab[key], `${key}: the store reads the module's list`)
    assert.equal(vocab[key][0], pure.DEFAULT_PULL_BATCH_CONFIG[key], `${key}: the first token is the built-in default`)
  }
  same(store.PULL_BATCH_SETTING_KEYS, ['firstPullBatchRule', 'labelFormat', 'landing', 'placement'], 'exactly the four settings (ruling C2)')
  assert.equal(enumByName.get(C('settings_rule_check')).nullable, false, 'a tenant default is always complete')
  assert.equal(enumByName.get(C('sheet_rule_check')).nullable, false, 'rule is captured at birth / install')
  assert.equal(enumByName.get(C('sheet_format_check')).nullable, false, 'format is captured at birth / install')
  assert.equal(enumByName.get(C('sheet_placement_check')).nullable, true, 'placement is NULL until applied')
  assert.equal(enumByName.get(C('sheet_landing_check')).nullable, true, 'landing is NULL until applied')
})

test('VM-2 the built-in defaults are the 10-27 design and are accepted by every CHECK', () => {
  same(Object.entries(store.PULL_BATCH_BUILT_IN_SETTINGS), [['firstPullBatchRule', 'material'], ['labelFormat', 'ordinal_date'], ['landing', 'promote_prep_fill'], ['placement', 'left']], 'the 10-27 design')
  for (const [key, check] of [['firstPullBatchRule', 'settings_rule_check'], ['labelFormat', 'settings_format_check'], ['landing', 'settings_landing_check'], ['placement', 'settings_placement_check']]) {
    assert.ok(inList(C(check)).includes(store.PULL_BATCH_BUILT_IN_SETTINGS[key]), key)
  }
})

test('VM-3 the ledger\'s own closed lists equal the code\'s constants', () => {
  same(inList(C('sheet_locale_check')), pure.PULL_BATCH_LOCALES, 'label locale')
  same(inList(C('sheet_mode_check')), pure.PULL_BATCH_HISTORY_MODES, 'history mode')
  same(inList(C('sheet_status_check')), store.PULL_BATCH_HISTORY_STATUSES, 'history status')
  same(inList(C('closed_reason_check')), pure.PULL_BATCH_CLOSED_REASONS, 'closed reason (design §15)')
  same(inList(C('status_check')), ['open', 'closed', 'void'], 'batch status')
  same(inList(C('origin_check')), ['live', 'backfill_inferred'], 'batch origin')
  same(inList(C('execution_lane_check')), store.PULL_BATCH_LANES, 'lane')
  same(inList(C('execution_writer_status_check')), store.PULL_BATCH_WRITER_STATUSES, 'writer status')
  same(inList(C('execution_outcome_check')), store.PULL_BATCH_VERIFIED_OUTCOMES, 'verified outcome (S6 C-3)')
  // The evidence CHECK is a shape CHECK (the kit models it by hand); its token list is pinned from the text.
  const sql = kit.readMigrationText(kit.MIGRATION_FILES.pullBatch)
  const evidence = /evidence IS NULL OR evidence IN \(([^)]*)\)/.exec(sql)
  assert.ok(evidence, 'the evidence CHECK names its tokens')
  same(Array.from(evidence[1].matchAll(/'([^']+)'/g)).map((m) => m[1]), pure.PULL_BATCH_EVIDENCE_CLASSES, 'evidence class')
})

test('VM-4 every closed CHECK of 105 is pinned by this suite (a new IN-list cannot slip in unpinned)', () => {
  const pinned = new Set([
    'settings_rule_check', 'settings_format_check', 'settings_landing_check', 'settings_placement_check',
    'sheet_rule_check', 'sheet_format_check', 'sheet_landing_check', 'sheet_placement_check',
    'sheet_locale_check', 'sheet_mode_check', 'sheet_status_check',
    'closed_reason_check', 'status_check', 'origin_check',
    'execution_lane_check', 'execution_writer_status_check', 'execution_outcome_check',
  ].map(C))
  same([...enumByName.keys()].sort(), [...pinned].sort(), 'the parsed IN-lists are exactly the pinned ones')
})

test('VM-5 the parser itself is witnessed: a token added to a CHECK in a copy of the text moves the parsed list', () => {
  const sql = kit.readMigrationText(kit.MIGRATION_FILES.pullBatch)
  const mutated = sql.replace("CHECK (first_pull_batch_rule IN ('material','predecessor_suffix'))", "CHECK (first_pull_batch_rule IN ('material','predecessor_suffix','off'))")
  assert.notEqual(mutated, sql, 'the replace matched')
  const parsed = kit.parseSchema(mutated)
  const entry = parsed[C('settings')].enums.find((e) => e.name === C('settings_rule_check'))
  same(entry.values, ['material', 'predecessor_suffix', 'off'])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-vocabulary-migration.test.cjs', tests)
