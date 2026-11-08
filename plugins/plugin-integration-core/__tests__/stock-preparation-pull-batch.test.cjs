'use strict'

// 批次标识 BI-1a — THE PORTABLE PURE CORE (lib/stock-preparation-pull-batch.cjs). Pure and not wired.
//
//   PB-G  the label grammar: 2 formats x 2 locales x live/inferred, unknown, 人工补充 = manual, blank, fail-safe
//   PB-S  the reader's Symbol is the shared registry key; the planner's created-by key is the planner's own
//   PB-E  the evidence set E (plugin rows only, R-65 C4; the shared manual: predicate, C3) and the gap-row predicate
//   PB-C  首次批次 — the §5.4 worked cases under BOTH rules; OWN-1 / Q6-a / R through the REAL planner
//   PB-D  the content-only digest: lane-free, ext_-free, key-order-free
//   PB-H  the history plan (§8.3) and the attested count (§8.5); H9/H10 = review fixes MF1 (membership reproduces the
//         assignment) and MF2 (the plan digest is clock-free); H11/H12 = review fixes round 3, R2-1 (the plan is
//         input-order invariant) and R2-2 (the digest covers the exceptions and placements lists)
//   PB-V  the verifier's round-1 killing assertions (MF4), one per design rule no other test pinned
//   PB-K  the configuration vocabulary (R-65 C2): defaults = the 10-27 design, four closed keys, fixed facts, locks
//   PB-P  portability and not-wired pins over the file TEXT (MF5), closed vocabularies
//   PB-A  the portable writer helpers (BI-1b review MF-5): the allocation answer must carry a LIVE label
//
// Synthetic values only (S-01, P-07, C, X, A, B).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const util = require('node:util')
const { spawnSync } = require('node:child_process')

const PLUGIN = path.join(__dirname, '..')
const LIB = path.join(PLUGIN, 'lib')
const MODULE_PATH = path.join(LIB, 'stock-preparation-pull-batch.cjs')
const PB = require(MODULE_PATH)
const planner = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const CF = require('./support/stock-preparation-continuation-fixtures.cjs')

const {
  DEFAULT_PULL_BATCH_CONFIG,
  EXISTING_ROW_PULL_BATCH,
  PULL_BATCH_ERROR_CODES,
  buildFirstPullBatchByKey,
  formatPullBatchLabel,
  normalizePullBatchConfig,
  parsePullBatchLabel,
  refusedPullBatchConfigEdits,
} = PB
const CREATED_BY = planner.EXISTING_ROW_CREATED_BY

const tests = []
const test = (name, fn) => tests.push([name, fn])

const L = (n, day = '2026-10-20', locale = 'zh-CN', labelFormat) => formatPullBatchLabel({ kind: 'live', n, day, locale, labelFormat })
const I = (n, day = '2026-10-01', locale = 'zh-CN', labelFormat) => formatPullBatchLabel({ kind: 'inferred', n, day, locale, labelFormat })
const UNKNOWN = '历史批次未知'
const RULES = ['material', 'predecessor_suffix']
const ruleConfig = (rule) => ({ firstPullBatchRule: rule })
const codeIs = (code, status) => (error) => error.code === code && (status === undefined || error.status === status)

/** A reader row: logical cells plus the band Symbol (createdAt / locked from the envelope). */
function readerRow(cells, { pullBatch = '', firstPullBatch = '', createdAt = '2026-10-20T02:00:00.000Z', locked = false, createdBy } = {}) {
  const out = { ...cells }
  out[EXISTING_ROW_PULL_BATCH] = Object.freeze({ pullBatch, firstPullBatch, createdAt, locked })
  if (createdBy) out[CREATED_BY] = createdBy
  return out
}

const key = (component, pathTokens) => JSON.stringify({ projectNo: 'PRJ-SCC-1', componentSourceId: component, parentSourceId: pathTokens.length > 1 ? pathTokens[pathTokens.length - 2] : null, path: pathTokens })
const row = (component, pathTokens, extra = {}, band = {}) => readerRow({
  projectNo: 'PRJ-SCC-1',
  idempotencyKey: key(component, pathTokens),
  componentSourceId: component,
  path: JSON.stringify(pathTokens),
  active: true,
  lastPlmRefreshDecision: 'add',
  ...extra,
}, band)
const add = (component, pathTokens) => ({ decision: 'add', idempotencyKey: key(component, pathTokens), record: { componentSourceId: component, path: JSON.stringify(pathTokens), idempotencyKey: key(component, pathTokens) } })
const inactive = (component, pathTokens) => ({ decision: 'inactive', idempotencyKey: key(component, pathTokens), patch: { active: false } })
const LEDGER = [
  { label: L(1), openedAt: '2026-10-20T01:00:00.000Z', status: 'closed' },
  { label: L(2), openedAt: '2026-10-22T01:00:00.000Z', status: 'closed' },
]
const carry = (args) => buildFirstPullBatchByKey({ locale: 'zh-CN', ledgerBatches: LEDGER, ...args })
const only = (map) => {
  assert.equal(map.size, 1)
  return [...map.values()][0]
}

// ── PB-G: the label grammar ────────────────────────────────────────────────────────────────────────

test('PB-G1 the eight strings: two formats x two locales x live / inferred, exactly as the grammar table says', () => {
  const expected = {
    ordinal_date: { 'zh-CN': ['第3批（2026-10-20）', '第3批（推定，2026-10-20）'], en: ['Batch 3 (2026-10-20)', 'Batch 3 (inferred, 2026-10-20)'] },
    ordinal: { 'zh-CN': ['第3批', '第3批（推定）'], en: ['Batch 3', 'Batch 3 (inferred)'] },
  }
  assert.deepEqual([...PB.PULL_BATCH_LABEL_FORMATS], Object.keys(expected))
  for (const [labelFormat, byLocale] of Object.entries(expected)) {
    for (const [locale, [live, inferred]] of Object.entries(byLocale)) {
      assert.equal(formatPullBatchLabel({ kind: 'live', n: 3, day: '2026-10-20', locale, labelFormat }), live, `${labelFormat} ${locale} live`)
      assert.equal(formatPullBatchLabel({ kind: 'inferred', n: 3, day: '2026-10-20', locale, labelFormat }), inferred, `${labelFormat} ${locale} inferred`)
    }
  }
  assert.equal(L(1), '第1批（2026-10-20）', 'labelFormat defaults to the 10-27 ordinal_date')
  assert.equal(formatPullBatchLabel({ kind: 'unknown', locale: 'zh-CN' }), '历史批次未知')
  assert.equal(formatPullBatchLabel({ kind: 'unknown', locale: 'en' }), 'Unknown historical batch')
  assert.equal(formatPullBatchLabel({ kind: 'manual', locale: 'zh-CN' }), '人工补充')
  assert.equal(formatPullBatchLabel({ kind: 'manual', locale: 'en' }), 'Manual row')
  assert.deepEqual({ ...PB.PULL_BATCH_MANUAL_LABELS }, { en: 'Manual row', 'zh-CN': '人工补充' })
})

test('PB-G2 both formats parse in both locales whatever is configured: kind, format and n recovered, day where printed; no string parses as another kind', () => {
  const seen = new Map()
  for (const labelFormat of PB.PULL_BATCH_LABEL_FORMATS) {
    for (const locale of PB.PULL_BATCH_LOCALES) {
      for (const kind of ['live', 'inferred']) {
        for (const [n, day] of [[1, '2026-01-31'], [12, '2026-10-27'], [207, '2024-02-29']]) {
          const text = formatPullBatchLabel({ kind, n, day, locale, labelFormat })
          const parsed = parsePullBatchLabel(text)
          assert.equal(parsed.kind, kind, text)
          assert.equal(parsed.format, labelFormat, text)
          assert.equal(parsed.n, n, `${text}: n`)
          assert.equal(parsed.day, labelFormat === 'ordinal' ? null : day, `${text}: day`)
          assert.ok(Object.isFrozen(parsed))
          const signature = `${kind}/${labelFormat}`
          if (seen.has(text)) assert.equal(seen.get(text), signature, `${text} is claimed by two kinds/formats`)
          seen.set(text, signature)
        }
      }
    }
  }
  for (const text of ['人工补充', 'Manual row']) assert.equal(parsePullBatchLabel(text).kind, 'manual', text)
  for (const text of ['历史批次未知', 'Unknown historical batch']) assert.equal(parsePullBatchLabel(text).kind, 'unknown', text)
  assert.deepEqual({ ...parsePullBatchLabel('第1批（2026-10-20）') }, { kind: 'live', format: 'ordinal_date', n: 1, day: '2026-10-20' })
})

test('PB-G3 blank and garbage parse fail-safe: blank is blank, everything else is unknown — never an earlier batch', () => {
  for (const value of [undefined, null, '', '   ']) assert.equal(parsePullBatchLabel(value).kind, 'blank', JSON.stringify(value))
  for (const value of [
    '第0批（2026-10-20）', '第01批（2026-10-20）', '第1批（2026-13-01）', '第1批（2026-02-30）', '第1批(2026-10-20)',
    'Batch 0', 'Batch 01', 'batch 1', 'Batch 1 (Inferred)', '第1批（推定)', '2026-02-30', '2026-2-3', '2026-10-20(推定)',
    '1', 7, true, {}, '第一批', 'Batch  1',
    // R-65 C2: the 'date' format is cut, so a bare date (or a dated 推定) is no label of any format
    '2026-10-20', '2026-10-20（推定）', '2026-10-20 (inferred)',
  ]) {
    assert.equal(parsePullBatchLabel(value).kind, 'unknown', JSON.stringify(value))
  }
  assert.equal(parsePullBatchLabel('  第2批（2026-10-20）  ').n, 2, 'surrounding whitespace is tolerated')
  assert.equal(parsePullBatchLabel('第2批 ').n, 2)
})

test('PB-G4 a malformed label request is refused (500 STAMP_INVALID): kind, n, day, format and locale', () => {
  for (const bad of [
    { kind: 'live', n: 0, day: '2026-10-20', locale: 'zh-CN' },
    { kind: 'live', n: 1.5, day: '2026-10-20', locale: 'zh-CN' },
    { kind: 'live', n: 1, day: '20261020', locale: 'zh-CN' },
    { kind: 'live', n: 1, day: '2026-10-20', locale: 'zh-CN', labelFormat: 'latest' },
    { kind: 'live', n: 1, day: '2026-10-20', locale: 'zh-CN', labelFormat: 'DATE' },
    { kind: 'live', n: 1, day: '2026-10-20', locale: 'zh-CN', labelFormat: 'date' },
    { kind: 'other', n: 1, day: '2026-10-20', locale: 'zh-CN' },
    { kind: 'live', n: 1, day: '2026-10-20', locale: 'zh' },
    { kind: 'unknown' },
  ]) {
    assert.throws(() => formatPullBatchLabel(bad), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID, 500), JSON.stringify(bad))
  }
  assert.throws(() => formatPullBatchLabel({ kind: 'live', n: 5, locale: 'en', labelFormat: 'ordinal' }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID, 500), "'ordinal' still needs the day: a batch always has both")
  assert.throws(() => formatPullBatchLabel({ kind: 'inferred', day: '2026-10-20', locale: 'en', labelFormat: 'ordinal' }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID, 500), "'ordinal' needs n")
})

test('PB-G5 the label day is the PROCESS-LOCAL calendar day (never toISOString().slice), witnessed under three time zones', () => {
  const probe = `const PB = require(${JSON.stringify(MODULE_PATH)}); process.stdout.write(JSON.stringify([PB.pullBatchLabelDay('2026-10-26T16:30:00.000Z'), PB.pullBatchLabelDay('2026-10-27T03:00:00.000Z')]))`
  const dayIn = (tz) => {
    const result = spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.deepEqual(dayIn('Asia/Shanghai'), ['2026-10-27', '2026-10-27'], 'east of UTC: 16:30Z is already the next local day')
  assert.deepEqual(dayIn('UTC'), ['2026-10-26', '2026-10-27'])
  assert.deepEqual(dayIn('America/Los_Angeles'), ['2026-10-26', '2026-10-26'], 'west of UTC: 03:00Z is still the previous local day')
  assert.equal(PB.pullBatchLabelDay(new Date(2026, 9, 27, 0, 30)), '2026-10-27')
  assert.equal(PB.pullBatchLabelDay('not a time'), null)
})

// ── PB-S ───────────────────────────────────────────────────────────────────────────────────────────

test("PB-S1 the reader Symbol is the shared registry key; the created-by key equals the planner's; the band ids are the two logical ids", () => {
  assert.equal(EXISTING_ROW_PULL_BATCH, Symbol.for('metasheet.stock-preparation.existingRow.pullBatch'))
  assert.equal(PB.__internals.EXISTING_ROW_CREATED_BY_KEY, CREATED_BY)
  assert.deepEqual({ ...PB.PULL_BATCH_BAND_FIELD_IDS }, { firstPullBatch: 'firstPullBatch', pullBatch: 'pullBatch' })
  assert.ok(Object.isFrozen(PB.PULL_BATCH_BAND_FIELD_IDS))
  const r = row('X', ['X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })
  assert.equal(JSON.stringify(r).includes('第1批'), false, 'the Symbol is invisible to JSON (hash neutrality)')
  assert.equal(Object.keys(r).includes('pullBatch'), false)
})

// ── PB-E ───────────────────────────────────────────────────────────────────────────────────────────

test('PB-E1 E = no creator ∧ a plugin key, not manual: ∧ a RUN stamp ∧ a non-blank normalized part id; gap rows = E rows unlocked with a blank cell', () => {
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'])), true)
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], {}, { createdBy: 'u_person' })), false, 'a person-created row (新建记录 / import / right-click duplicate)')
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], { idempotencyKey: 'manual:v1:rec_1' })), false, 'a manual row')
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], { idempotencyKey: 'manual:other' })), false, 'any key in the reserved manual: namespace (the shared raw prefix, not only manual:v1:)')
  assert.equal(PB.isPullBatchEvidenceRow(row('  ', ['X'])), false, 'a blank part id never matches')
  assert.equal(PB.isPullBatchEvidenceRow(row(null, ['X'])), false)
  assert.equal(PB.normalizePartId('  S-01 '), 'S-01')
  assert.equal(PB.normalizePartId(7), '7')
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'])), true, 'both cells blank')
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'], {}, { pullBatch: L(1) })), true, 'half stamped')
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })), false)
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'], {}, { locked: true })), false, 'a locked record is excluded (G12)')
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'], {}, { createdBy: 'u_person' })), false, 'a person row is never a gap row')
  assert.equal(PB.countPullBatchGapRows([row('X', ['X']), row('Y', ['Y'], {}, { pullBatch: L(1), firstPullBatch: L(1) })]), 1)
})

test('PB-E2 R-65 C4: a creator-less row is evidence only when it is a PLUGIN row — automation-like and forged-key rows are excluded, never gap rows, never carried', () => {
  const automationLike = row('X', ['X'], { idempotencyKey: 'rec_auto_1', lastPlmRefreshDecision: undefined }, { pullBatch: L(1), firstPullBatch: L(1) })
  assert.equal(PB.isPullBatchEvidenceRow(automationLike), false, 'automation create_record / FWB / public form: creator absent, non-JSON key, no RUN stamp')
  const forgedKey = row('X', ['X'], { lastPlmRefreshDecision: undefined }, { pullBatch: L(1), firstPullBatch: L(1) })
  assert.equal(forgedKey.idempotencyKey.startsWith('{'), true)
  assert.equal(PB.isPullBatchEvidenceRow(forgedKey), false, 'a forged JSON key without a RUN stamp')
  for (const stamp of ['', '   ', null, 7]) assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], { lastPlmRefreshDecision: stamp })), false, `RUN stamp ${JSON.stringify(stamp)}`)
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], { idempotencyKey: 'plain-key' })), false, 'a stamped row whose key is not a plugin key')
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], { idempotencyKey: ` ${key('X', ['X'])}` })), false, 'the plugin-key test is raw (no trim)')
  for (const stamp of ['add', 'update', 'inactive']) assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], { lastPlmRefreshDecision: stamp })), true, stamp)
  for (const excluded of [automationLike, forgedKey]) {
    assert.equal(PB.isPullBatchGapRow({ ...excluded, [EXISTING_ROW_PULL_BATCH]: Object.freeze({ pullBatch: '', firstPullBatch: '', createdAt: null, locked: false }) }), false, 'never a gap row, so never labelled')
    for (const rule of RULES) {
      assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [excluded], config: ruleConfig(rule) })), null, `${rule}: never carried`)
    }
  }
})

test('PB-E3 R-65 C3: the reserved prefix is the SHARED raw manual: predicate of stock-preparation-manual-rows.cjs (pinned, not required: the core stays portable)', () => {
  const manualRows = require(path.join(LIB, 'stock-preparation-manual-rows.cjs'))
  assert.equal(PB.MANUAL_ROW_KEY_PREFIX, manualRows.MANUAL_ROW_KEY_PREFIX)
  assert.equal(PB.MANUAL_ROW_KEY_PREFIX, 'manual:')
  for (const value of ['manual:', 'manual:v1:rec_1', 'manual:x', ' manual:v1:rec_1', 'Manual:v1:rec_1', 'manual', '{"a":1}', '', null, undefined, 7]) {
    assert.equal(PB.__internals.isManualRowKey(value), manualRows.isManualPrefixKey(value), JSON.stringify(value))
  }
})

// ── PB-C: the §5.4 worked cases ─────────────────────────────────────────────────────────────────────

const OWN_PARTS = [CF.part('P-07', 'D-P07', 'Assembly'), CF.part('S-01', 'D-S01', 'Sub'), CF.part('C', 'D-C', 'Child')]

async function ownOneSheets() {
  const first = await CF.expand(CF.project({ orders: [{ part: 'S-01', qty: 2 }], parts: OWN_PARTS, boms: { 'S-01': [{ part: 'C', usage: 3 }] } }))
  const plan1 = CF.plan(first, [])
  const sheet1 = CF.applyToSheet(plan1, []).map((entry) => readerRow(entry, { pullBatch: L(1), firstPullBatch: L(1), createdAt: '2026-10-20T02:00:00.000Z' }))
  return { plan1, sheet1 }
}

test("PB-C1 OWN-1 through the REAL expander and planner: batch 1 = S-01 + C; batch 2 = P-07 ⊃ S-01 (C09) ⇒ exactly the owner's table, under both rules", async () => {
  const { plan1, sheet1 } = await ownOneSheets()
  for (const rule of RULES) {
    const map1 = carry({ decisions: plan1.decisions, existingRows: [], ledgerBatches: [], config: ruleConfig(rule) })
    assert.deepEqual([...map1.values()], [null, null], `${rule}: batch 1 creates are "this batch"`)
  }
  const second = await CF.expand(CF.project({ orders: [{ part: 'P-07', qty: 1 }], parts: OWN_PARTS, boms: { 'P-07': [{ part: 'S-01', usage: 2 }], 'S-01': [{ part: 'C', usage: 3 }] } }))
  const plan2 = CF.plan(second, sheet1)
  const byDecision = (decision) => plan2.decisions.filter((entry) => entry.decision === decision).map((entry) => JSON.parse(entry.idempotencyKey).componentSourceId).sort()
  assert.deepEqual(byDecision('add'), ['C', 'P-07', 'S-01'], 'C09: the copies and P-07 are ADDed')
  assert.deepEqual(byDecision('inactive'), ['C', 'S-01'], 'C09: batch 1 is swept INACTIVE')
  for (const rule of RULES) {
    const map2 = carry({ decisions: plan2.decisions, existingRows: sheet1, config: ruleConfig(rule) })
    const firstOf = (component) => {
      const decision = plan2.decisions.find((entry) => entry.decision === 'add' && JSON.parse(entry.idempotencyKey).componentSourceId === component)
      const label = map2.get(decision.idempotencyKey)
      return label === null ? L(2) : label
    }
    // The owner-approved table: S-01 有效=否 首次=第1批 本次=第1批 (the untouched batch-1 row); S-01 有效=是 首次=第1批
    // 本次=第2批 (the copy); P-07 有效=是 首次=第2批 本次=第2批.
    assert.equal(firstOf('S-01'), L(1), `${rule}: the S-01 copy carries 首次 第1批`)
    assert.equal(firstOf('C'), L(1), `${rule}: the C copy carries 首次 第1批`)
    assert.equal(firstOf('P-07'), L(2), `${rule}: P-07 is new in batch 2`)
  }
})

test('PB-C2 Q6-a and R through the REAL planner: an identity change is HELD and a same-key revival is an UPDATE — neither reaches the carry map', async () => {
  const { sheet1 } = await ownOneSheets()
  // Q6-a: S-01's identity (its material) changes under the same key (F29).
  const renamed = [CF.part('P-07', 'D-P07', 'Assembly'), CF.part('S-01', 'D-S01', 'Sub', { Material: 'M-ALU' }), CF.part('C', 'D-C', 'Child')]
  const held = CF.plan(await CF.expand(CF.project({ orders: [{ part: 'S-01', qty: 2 }], parts: renamed, boms: { 'S-01': [{ part: 'C', usage: 3 }] } })), sheet1)
  const s01Key = sheet1.find((entry) => entry.componentSourceId === 'S-01').idempotencyKey
  const s01Decision = held.decisions.find((entry) => entry.idempotencyKey === s01Key)
  assert.ok(s01Decision, 'the planner answers the S-01 key')
  assert.equal(s01Decision.decision, 'manual_confirm', 'Q6-a: an identity change is HELD, never an ADD or an UPDATE')
  assert.equal(s01Decision.conflictSummary.type, 'component_identity_conflict')
  // R: C removed in batch 2 (only S-01 remains, without its BOM), back at the SAME key in batch 3.
  const swept = CF.plan(await CF.expand(CF.project({ orders: [{ part: 'S-01', qty: 2 }], parts: OWN_PARTS, boms: {} })), sheet1)
  const sheet2 = CF.applyToSheet(swept, sheet1).map((entry) => readerRow(entry, entry[EXISTING_ROW_PULL_BATCH] ? { ...entry[EXISTING_ROW_PULL_BATCH] } : {}))
  const cKey = sheet1.find((entry) => entry.componentSourceId === 'C').idempotencyKey
  assert.equal(sheet2.find((entry) => entry.idempotencyKey === cKey).active, false, 'C was swept INACTIVE in batch 2')
  const revived = CF.plan(await CF.expand(CF.project({ orders: [{ part: 'S-01', qty: 2 }], parts: OWN_PARTS, boms: { 'S-01': [{ part: 'C', usage: 3 }] } })), sheet2)
  const cDecision = revived.decisions.find((entry) => entry.idempotencyKey === cKey)
  assert.equal(cDecision.decision, 'update', 'R: the revival is an UPDATE at the same key')
  for (const rule of RULES) {
    for (const [label, planned, sheet] of [['Q6-a', held, sheet1], ['R', revived, sheet2]]) {
      const map = carry({ decisions: planned.decisions, existingRows: sheet, config: ruleConfig(rule) })
      assert.equal(map.has(label === 'Q6-a' ? s01Key : cKey), false, `${label} [${rule}]: both cells stay untouched`)
    }
  }
})

test('PB-C3 the §5.4 table under both rules (TWO-POS, COMMON, STD-PART, ACTIVE-ROOT, R′, MULTI, Q6-b, UNK-OLD, UNK-NEW, GAP-C09, PERSON-DUP, MANUAL)', () => {
  const cases = [
    // [id, existingRows, decisions, expected label per ADD for rule material, for rule predecessor_suffix]
    ['TWO-POS (X at two positions in one batch, both new)', [], [add('X', ['A', 'X']), add('X', ['B', 'X'])], { material: [null, null], predecessor_suffix: [null, null] }],
    ['COMMON (X under A in batch 1, still active; X under B in batch 2)', [row('X', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })], [add('X', ['B', 'X'])], { material: [L(1)], predecessor_suffix: [null] }],
    ['STD-PART (batch 1: S-01 ⊃ X; batch 2: P-07 ⊃ S-01 ⊃ X and P-07 ⊃ X)',
      [row('S-01', ['S-01'], {}, { pullBatch: L(1), firstPullBatch: L(1) }), row('X', ['S-01', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })],
      [add('X', ['P-07', 'S-01', 'X']), add('X', ['P-07', 'X']), inactive('S-01', ['S-01']), inactive('X', ['S-01', 'X'])],
      { material: [L(1), L(1)], predecessor_suffix: [L(1), null] }],
    ['ACTIVE-ROOT (S-01 still an active root; P-07 ⊃ S-01 newly demanded)', [row('S-01', ['S-01'], {}, { pullBatch: L(1), firstPullBatch: L(1) })], [add('S-01', ['P-07', 'S-01'])], { material: [L(1)], predecessor_suffix: [null] }],
    ["R′ (X removed in batch 2, re-added under another parent in batch 3; the remnant's path is not a suffix)", [row('X', ['A', 'X'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) })], [add('X', ['B', 'X'])], { material: [L(1)], predecessor_suffix: [null] }],
    ["R′ (the remnant's path IS a suffix)", [row('X', ['X'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) })], [add('X', ['B', 'X'])], { material: [L(1)], predecessor_suffix: [L(1)] }],
    ['MULTI (batch 3: Q-09 ⊃ P-07 ⊃ S-01; remnants of batches 1 and 2)',
      [row('S-01', ['S-01'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) }), row('S-01', ['P-07', 'S-01'], {}, { pullBatch: L(2), firstPullBatch: L(1) }), row('P-07', ['P-07'], {}, { pullBatch: L(2), firstPullBatch: L(2) })],
      [add('S-01', ['Q-09', 'P-07', 'S-01']), add('P-07', ['Q-09', 'P-07']), add('Q-09', ['Q-09']), inactive('S-01', ['P-07', 'S-01']), inactive('P-07', ['P-07'])],
      { material: [L(1), L(2), null], predecessor_suffix: [L(1), L(2), null] }],
    ['Q6-b (a revision with a NEW part id S′; the old S inactive)', [row('S', ['S'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) })], [add('S2', ['S2'])], { material: [null], predecessor_suffix: [null] }],
    ['Q6-b children (S′ ⊃ C; the old S ⊃ C inactive): the copies keep their earliest under rule A, not under F (paths differ)',
      [row('S', ['S'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) }), row('C', ['S', 'C'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) })],
      [add('S2', ['S2']), add('C', ['S2', 'C'])], { material: [null, L(1)], predecessor_suffix: [null, null] }],
    ['UNK-OLD (a matching blank row created BEFORE the earliest known batch opened)',
      [row('X', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) }), row('X', ['X'], { active: false }, { createdAt: '2026-10-19T00:00:00.000Z' })],
      [add('X', ['B', 'X'])], { material: [UNKNOWN], predecessor_suffix: [UNKNOWN] }],
    ['UNK-NEW (a matching blank row created AFTER it — e.g. a switch-off-period copy — is ignored)',
      [row('X', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) }), row('X', ['Z', 'X'], { active: false }, { createdAt: '2026-10-21T00:00:00.000Z' })],
      [add('X', ['B', 'X'])], { material: [L(1)], predecessor_suffix: [null] }],
    ['UNK-NEW under rule F (a blank suffix predecessor created after the known one opened)',
      [row('X', ['X'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) }), row('X', ['X'], { active: false, idempotencyKey: '{"copy":"X"}' }, { createdAt: '2026-10-21T00:00:00.000Z' })],
      [add('X', ['B', 'X'])], { material: [L(1)], predecessor_suffix: [L(1)] }],
    ['GAP-C09 (batch 2 pulled while the switch was off: blank copies, created after batch 1 opened; live batch 3 reads 第1批)',
      [row('S-01', ['S-01'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) }), row('S-01', ['P-07', 'S-01'], {}, { createdAt: '2026-10-21T00:00:00.000Z' }), row('P-07', ['P-07'], {}, { createdAt: '2026-10-21T00:00:00.000Z' })],
      [add('S-01', ['Q-09', 'P-07', 'S-01']), inactive('S-01', ['P-07', 'S-01'])], { material: [L(1)], predecessor_suffix: [L(1)] }],
    ['UNK (a matching row labelled 历史批次未知, no known label)', [row('X', ['A', 'X'], {}, { pullBatch: UNKNOWN, firstPullBatch: UNKNOWN })], [add('X', ['B', 'X'])], { material: [UNKNOWN], predecessor_suffix: [null] }],
    ['PERSON-DUP (a right-click duplicate of a batch-1 row: creator present, same part id, cells copied) is never evidence',
      [row('X', ['X'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1), createdBy: 'u_person' })], [add('X', ['B', 'X'])], { material: [null], predecessor_suffix: [null] }],
    ['MANUAL (a manual: row) is never evidence', [row('X', ['X'], { active: false, idempotencyKey: 'manual:v1:rec_9' }, { pullBatch: '人工补充', firstPullBatch: '人工补充' })], [add('X', ['B', 'X'])], { material: [null], predecessor_suffix: [null] }],
    ['inferred history travels verbatim (推定 and its date)', [row('X', ['X'], { active: false }, { pullBatch: I(1), firstPullBatch: I(1) })], [add('X', ['A2', 'X'])], { material: [I(1)], predecessor_suffix: [I(1)] }],
    ['the SMALLEST known number wins, whatever the row order', [row('X', ['B', 'X'], {}, { pullBatch: L(2), firstPullBatch: L(2) }), row('X', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })], [add('X', ['C', 'X'])], { material: [L(1)], predecessor_suffix: [null] }],
    ['part ids are normalized (trim) before matching', [row(' X ', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })], [add('X', ['B', 'X'])], { material: [L(1)], predecessor_suffix: [null] }],
    ['a blank part id never matches', [row('', ['A', ''], {}, { pullBatch: L(1), firstPullBatch: L(1) })], [{ ...add('', ['B', 'X']) }], { material: [null], predecessor_suffix: [null] }],
  ]
  const ledger = [...LEDGER, { label: I(1), openedAt: '2026-10-01T00:00:00.000Z', status: 'closed' }]
  for (const [label, existingRows, decisions, expected] of cases) {
    for (const rule of RULES) {
      const map = carry({ decisions, existingRows, ledgerBatches: ledger, config: ruleConfig(rule) })
      const adds = decisions.filter((entry) => entry.decision === 'add')
      assert.deepEqual(adds.map((entry) => map.get(entry.idempotencyKey)), expected[rule], `${label} [${rule}]`)
      assert.equal(map.size, new Set(adds.map((entry) => entry.idempotencyKey)).size, `${label} [${rule}]: ONE entry per ADD key`)
    }
  }
})

test('PB-C4 R6: an open row decides only if it could predate L* — a missing createdAt, or no ledger opened_at for L*, decides (fail safe)', () => {
  const known = row('X', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })
  const openNoTime = row('X', ['Z', 'X'], {}, { createdAt: null })
  assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [known, openNoTime] })), UNKNOWN, 'no createdAt => could predate')
  const openLater = row('X', ['Z', 'X'], {}, { createdAt: '2026-10-25T00:00:00.000Z' })
  assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [known, openLater], ledgerBatches: [] })), UNKNOWN, 'no ledger opened_at for L* => the open row could predate it')
  assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [known, openLater], ledgerBatches: [{ ...LEDGER[0], status: 'void' }] })), UNKNOWN, 'a void ledger row gives no opened_at')
  assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [known, openLater], locale: 'en' })), L(1), 'a later open row is ignored; the known label is copied verbatim whatever the locale')
  assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [openNoTime], locale: 'en' })), 'Unknown historical batch', 'no known row at all => unknown, in the sheet locale')
  assert.throws(() => carry({ decisions: [], locale: undefined }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID), 'the locale is required')
})

test("PB-C5 the 'ordinal' format: L* by number; two ledger batches with one label read the LATEST opening (fail-safe); a bare date is no label", () => {
  const ord = (n) => L(n, '2026-10-20', 'zh-CN', 'ordinal')
  const ordinalSheet = [row('X', ['B', 'X'], {}, { pullBatch: ord(2), firstPullBatch: ord(2) }), row('X', ['A', 'X'], {}, { pullBatch: ord(1), firstPullBatch: ord(1) })]
  const ordinalLedger = [{ label: ord(1), openedAt: '2026-10-20T01:00:00.000Z', status: 'closed' }, { label: ord(2), openedAt: '2026-10-22T01:00:00.000Z', status: 'closed' }]
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: ordinalSheet, ledgerBatches: ordinalLedger })), '第1批')
  const twinLedger = [
    { label: ord(1), openedAt: '2026-10-20T01:00:00.000Z', status: 'closed' },
    { label: ord(1), openedAt: '2026-10-20T09:00:00.000Z', status: 'closed' },
    { label: ord(2), openedAt: '2026-10-22T01:00:00.000Z', status: 'closed' },
  ]
  const between = row('X', ['Z', 'X'], {}, { createdAt: '2026-10-20T05:00:00.000Z' })
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: [...ordinalSheet, between], ledgerBatches: twinLedger })), UNKNOWN,
    'an open row between two openings of one label could predate the first appearance: 历史批次未知')
  const after = row('X', ['Z', 'X'], {}, { createdAt: '2026-10-20T10:00:00.000Z' })
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: [...ordinalSheet, after], ledgerBatches: twinLedger })), '第1批')
  const bareDate = [row('X', ['A', 'X'], {}, { firstPullBatch: ord(1) }), row('X', ['B', 'X'], {}, { firstPullBatch: '2026-10-19' })]
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: bareDate })), UNKNOWN, 'a bare date parses unknown, so it is an open row that could predate L*')
  // MF3: known labels of DIFFERENT formats are not comparable => 历史批次未知, never one of them copied (a copy would
  // spread the mix onto the new row). The ledger knows both openings, so only the format rule can decide.
  const mixedLedger = [
    { label: ord(1), openedAt: '2026-10-19T01:00:00.000Z', status: 'closed' },
    { label: L(2, '2026-10-22'), openedAt: '2026-10-22T01:00:00.000Z', status: 'closed' },
  ]
  for (const pair of [
    [row('X', ['A', 'X'], {}, { firstPullBatch: L(2, '2026-10-22') }), row('X', ['B', 'X'], {}, { firstPullBatch: ord(1) })],
    [row('X', ['B', 'X'], {}, { firstPullBatch: ord(1) }), row('X', ['A', 'X'], {}, { firstPullBatch: L(2, '2026-10-22') })],
  ]) {
    for (const rule of RULES) {
      const existingRows = rule === 'material' ? pair : pair.map((entry) => ({ ...entry, active: false, path: JSON.stringify(['X']) }))
      assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows, ledgerBatches: mixedLedger, config: ruleConfig(rule) })), UNKNOWN, `${rule}: 第2批（D） + 第1批 are not comparable`)
    }
  }
  const dateMix = [row('X', ['A', 'X'], {}, { firstPullBatch: L(2, '2026-10-22') }), row('X', ['B', 'X'], {}, { firstPullBatch: '2026-10-19' })]
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: dateMix, ledgerBatches: mixedLedger })), UNKNOWN, '第2批（D） + a bare date: never the date copied')
})

test('PB-C6 trashed rows are never evidence (a fixed fact, R-65 C2): a trashedRows input is not read, and naming the setting is refused', () => {
  const trashed = [row('X', ['X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })]
  for (const rule of RULES) {
    assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [], trashedRows: trashed, config: ruleConfig(rule) })), null, `${rule}: the trash is not evidence`)
    assert.throws(() => carry({ decisions: [add('X', ['B', 'X'])], existingRows: [], config: { firstPullBatchRule: rule, trashedRowsAreEvidence: true } }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 400))
  }
  assert.equal(PB.PULL_BATCH_FIXED_FACTS.trashedRowsAreEvidence, false)
})

// ── PB-D: the digest ───────────────────────────────────────────────────────────────────────────────

test('PB-D1 one content-only digest: the same rows give the same digest on both lanes and every retry; key order, ext_ keys and lane/parameters/readPlan/principal change nothing', () => {
  const canonicalRows = (rows) => rows.slice().sort((a, b) => (a.idempotencyKey < b.idempotencyKey ? -1 : a.idempotencyKey > b.idempotencyKey ? 1 : 0))
  const rows = [{ idempotencyKey: 'k2', componentSourceId: 'Y', totalQuantity: 1 }, { idempotencyKey: 'k1', componentSourceId: 'X', totalQuantity: 2 }]
  const actionId = 'plm.stock-preparation.pull-bom.v1'
  const small = PB.pullBatchSourceDigest({ actionId, rows, canonicalRows })
  assert.match(small, PB.PULL_BATCH_SOURCE_DIGEST_PATTERN)
  const largeRows = rows.slice().reverse().map((entry) => ({ totalQuantity: entry.totalQuantity, ext_tenant_note: 'n', componentSourceId: entry.componentSourceId, idempotencyKey: entry.idempotencyKey }))
  const large = PB.pullBatchSourceDigest({ actionId, rows: largeRows, canonicalRows, lane: 'large_apply', parameters: { a: 1 }, readPlan: { p: 2 }, principal: 'u1', runId: 'r2' })
  assert.equal(large, small, 'another lane, another key order, a tenant ext_ key, other parameters / readPlan / principal: one digest')
  assert.equal(PB.pullBatchSourceDigest({ actionId, rows, canonicalRows }), small, 'a retry is the same pull')
  assert.notEqual(PB.pullBatchSourceDigest({ actionId: 'other.action', rows, canonicalRows }), small)
  assert.notEqual(PB.pullBatchSourceDigest({ actionId, rows: [rows[0], { ...rows[1], totalQuantity: 3 }], canonicalRows }), small)
  for (const bad of [{ actionId: '', rows, canonicalRows }, { actionId, rows: null, canonicalRows }, { actionId, rows }, { actionId, rows, canonicalRows: () => 'x' }]) {
    assert.throws(() => PB.pullBatchSourceDigest(bad), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID))
  }
})

// ── PB-H: the history plan ─────────────────────────────────────────────────────────────────────────

const hrow = (id, createdAt, { decision = 'inactive', plannedAt = null, active = true, partId = id.replace(/_.*$/, ''), pathTokens } = {}) => ({
  recordId: id, createdAt, decision, plannedAt, active, partId, path: JSON.stringify(pathTokens || [partId]),
})
const COVERED = '2026-10-21T00:00:00.000Z'
const plan = (args) => PB.planPullBatchHistory({ coveredUntil: COVERED, locale: 'zh-CN', ...args })

const C09_P2 = '2026-10-20T02:30:00.000Z'
const C09_ROWS = [
  hrow('S-01_old', '2026-10-20T02:00:01.000Z', { decision: 'inactive', plannedAt: C09_P2, active: false }),
  hrow('C_old', '2026-10-20T02:00:02.000Z', { decision: 'inactive', plannedAt: C09_P2, active: false, pathTokens: ['S-01', 'C'] }),
  hrow('P-07_new', '2026-10-20T02:30:01.000Z', { decision: 'add', plannedAt: C09_P2 }),
  hrow('S-01_new', '2026-10-20T02:30:02.000Z', { decision: 'add', plannedAt: C09_P2, pathTokens: ['P-07', 'S-01'] }),
  hrow('C_new', '2026-10-20T02:30:03.000Z', { decision: 'add', plannedAt: C09_P2, pathTokens: ['P-07', 'S-01', 'C'] }),
]

test("PB-H1 R1's C09 shape: batch 2 (P-07 ⊃ S-01) only 30 min after batch 1, which it swept ⇒ TWO clusters (created_at, plan_time), labels 推定", () => {
  const { plan: p, assignments } = plan({ rows: C09_ROWS })
  assert.equal(p.K, 2)
  assert.deepEqual(p.clusters.map((c) => [c.k, c.evidence, c.rows, c.inactive]), [[1, 'created_at', 2, 2], [2, 'plan_time', 3, 0]])
  assert.equal(p.clusters[0].label, I(1, PB.pullBatchLabelDay('2026-10-20T02:00:01.000Z')))
  assert.match(p.clusters[1].label, /^第2批（推定，\d{4}-\d{2}-\d{2}）$/)
  const of = (id) => assignments.get(id)
  assert.equal(of('S-01_old').pullBatch, p.clusters[0].label)
  assert.equal(of('S-01_new').pullBatch, p.clusters[1].label)
  assert.equal(of('S-01_new').firstPullBatch, p.clusters[0].label, 'the copy carries 首次 = batch 1 (推定), material rule')
  assert.equal(of('P-07_new').firstPullBatch, p.clusters[1].label)
  assert.equal(p.scheme, PB.PULL_BATCH_HISTORY_SCHEME)
  assert.deepEqual(p.cuts, [C09_P2])
  assert.equal(p.digest, PB.pullBatchHistoryPlanDigest(p), 'the digest covers the plan without itself')
  assert.equal(plan({ rows: C09_ROWS.slice().reverse() }).plan.digest, p.digest, 'input order never moves the plan')
  assert.equal(plan({ rows: C09_ROWS }).plan.digest, p.digest, 'stable digest')
  assert.ok(!JSON.stringify(p).includes('S-01') && !JSON.stringify(p).includes('P-07'), 'values-free: no part id in the persisted plan')
})

test('PB-H2 a large job spread over 3 h with a 2 h pause is ONE cluster; without the add stamp the gap splits it; G is a parameter', () => {
  const p = '2026-10-20T01:00:00.000Z'
  const rows = [
    hrow('a', '2026-10-20T01:00:05.000Z', { decision: 'add', plannedAt: p }),
    hrow('b', '2026-10-20T01:30:00.000Z', { decision: 'add', plannedAt: p }),
    hrow('c', '2026-10-20T03:45:00.000Z', { decision: 'add', plannedAt: p }),
  ]
  assert.equal(plan({ rows }).plan.K, 1)
  const unstamped = rows.map((entry) => ({ ...entry, decision: 'update' }))
  assert.equal(plan({ rows: unstamped }).plan.K, 2, 'no anchor proves continuity: the 2 h gap splits')
  assert.equal(plan({ rows: unstamped, gapMinutes: 180 }).plan.K, 1, 'G is a parameter')
  assert.equal(plan({ rows: unstamped, gapMinutes: 180 }).plan.gapMinutes, 180)
  for (const bad of [0, 1.5, 24 * 60 + 1, '30']) assert.throws(() => plan({ rows, gapMinutes: bad }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID), String(bad))
})

test('PB-H3 batch 1 fully swept ⇒ cluster 1 created_at; some batch-1 rows still add @ p₁ ⇒ cluster 1 plan_time', () => {
  const p1 = '2026-10-20T02:00:00.000Z'
  const rows = C09_ROWS.map((entry) => (entry.recordId === 'S-01_old' ? { ...entry, decision: 'add', plannedAt: p1 } : entry))
  const { plan: p } = plan({ rows })
  assert.deepEqual(p.clusters.map((c) => [c.k, c.evidence]), [[1, 'plan_time'], [2, 'plan_time']])
  assert.deepEqual(p.cuts, [p1, C09_P2])
})

test('PB-H4 degenerate createdAt (a bulk copy) ⇒ no createdAt inference: anchors only, ordered by plan time; every non-add row unplaced (历史批次未知)', () => {
  const rows = [
    hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-19T01:00:00.000Z' }),
    hrow('b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: '2026-10-18T01:00:00.000Z' }),
    hrow('c', '2026-10-20T01:00:00.200Z', { decision: 'inactive', plannedAt: '2026-10-19T01:00:00.000Z', active: false }),
  ]
  const { plan: p, assignments } = plan({ rows })
  assert.equal(p.degenerate, true)
  assert.equal(p.K, 2, 'one cluster per add plan time — nothing inferred from the copy times')
  assert.deepEqual(p.clusters.map((cluster) => cluster.anchorAt), ['2026-10-18T01:00:00.000Z', '2026-10-19T01:00:00.000Z'], 'ordered by plan time')
  assert.equal(assignments.get('b').k, 1)
  assert.equal(assignments.get('a').k, 2)
  assert.equal(p.unplacedRows, 1)
  assert.equal(assignments.get('c').pullBatch, UNKNOWN)
  assert.equal(PB.pullBatchHistoryMembership(p, { recordId: 'c', createdAt: '2026-10-20T01:00:00.200Z' }), null, 'a degenerate plan places nothing by time')
  const late = [
    hrow('d', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-21T01:00:00.000Z' }),
    hrow('e', '2026-10-20T03:00:00.000Z', { decision: 'add', plannedAt: '2026-10-21T01:00:00.000Z' }),
  ]
  const lateAnswer = plan({ rows: late, coveredUntil: '2026-10-22T00:00:00.000Z' })
  assert.equal(lateAnswer.plan.degenerate, true, 'late add stamps (plan time after creation) are degenerate as well')
  assert.equal(lateAnswer.plan.K, 0)
  assert.equal(lateAnswer.plan.unplacedRows, 2)
})

test("PB-H5 an add-stamped row created inside ANOTHER anchor's segment joins its own anchor (exceptions); membership reads the persisted plan only; coveredUntil", () => {
  const p1 = '2026-10-20T01:00:00.000Z'
  const p2 = '2026-10-20T01:10:00.000Z'
  const rows = [
    hrow('a', '2026-10-20T01:00:01.000Z', { decision: 'add', plannedAt: p1 }),
    hrow('b', '2026-10-20T01:10:01.000Z', { decision: 'add', plannedAt: p2 }),
    hrow('late', '2026-10-20T01:12:00.000Z', { decision: 'add', plannedAt: p1 }),
  ]
  const { plan: p, assignments } = plan({ rows })
  assert.equal(p.K, 2)
  assert.deepEqual(p.exceptions, [{ recordId: 'late', k: 1 }])
  assert.equal(p.interleavedRows, 1)
  assert.equal(assignments.get('late').k, 1)
  assert.equal(PB.pullBatchHistoryMembership(p, { recordId: 'late', createdAt: '2026-10-20T01:12:00.000Z' }), 1)
  assert.equal(PB.pullBatchHistoryMembership(p, { recordId: 'b', createdAt: '2026-10-20T01:10:01.000Z' }), 2)
  assert.equal(PB.pullBatchHistoryMembership(p, { recordId: 'new', createdAt: '2026-10-22T00:00:00.000Z' }), 'uncovered', 'a row after coveredUntil is not covered')
  assert.equal(p.coveredUntil, COVERED)
  assert.throws(() => PB.pullBatchHistoryMembership({ scheme: 'x' }, {}), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID))
})

test('PB-H6 a gap pass (extension of a persisted plan) appends after the base, and 首次 reads the rows already labelled', () => {
  const prior = [{ partId: 'X', path: JSON.stringify(['X']), active: false, firstPullBatch: L(1), createdAt: '2026-10-20T01:00:00.000Z' }]
  const rows = [hrow('x2', '2026-10-25T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-25T00:59:59.000Z', partId: 'X', pathTokens: ['P', 'X'] })]
  for (const rule of RULES) {
    const { plan: p, assignments } = plan({ rows, priorRows: prior, base: 3, coveredUntil: '2026-10-26T00:00:00.000Z', ledgerBatches: LEDGER, config: ruleConfig(rule) })
    assert.equal(p.clusters[0].k, 4)
    assert.equal(p.base, 3)
    assert.match(assignments.get('x2').pullBatch, /^第4批（推定，/)
    assert.equal(assignments.get('x2').firstPullBatch, L(1), rule)
  }
  assert.throws(() => plan({ rows, coveredUntil: 'never' }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID))
  assert.throws(() => plan({ rows: [rows[0], rows[0]] }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID), 'a record id appears once')
  assert.throws(() => plan({ rows, base: -1 }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID))
})

test('PB-H7 the configuration reaches the plan: label format and rule; trashed rows are not read; the digest moves with rule, format and locale, never with landing / placement', () => {
  const ordinal = plan({ rows: C09_ROWS, config: { labelFormat: 'ordinal' } })
  assert.deepEqual(ordinal.plan.clusters.map((c) => c.label), ['第1批（推定）', '第2批（推定）'])
  assert.throws(() => plan({ rows: C09_ROWS, config: { labelFormat: 'date' } }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 400))
  assert.throws(() => plan({ rows: C09_ROWS, config: ruleConfig('off') }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 400))
  const trashed = [{ partId: 'P-07', path: JSON.stringify(['P-07']), firstPullBatch: I(1, '2026-10-01'), createdAt: '2026-10-01T00:00:00.000Z' }]
  const ledger = [{ label: I(1, '2026-10-01'), openedAt: '2026-10-01T00:00:00.000Z', status: 'closed' }]
  assert.equal(plan({ rows: C09_ROWS, trashedRows: trashed, ledgerBatches: ledger }).assignments.get('P-07_new').firstPullBatch, plan({ rows: C09_ROWS }).plan.clusters[1].label, 'trashed rows are never read')
  assert.equal(Object.prototype.hasOwnProperty.call(plan({ rows: C09_ROWS }).plan, 'trashedRowsAreEvidence'), false)
  const digests = new Set([
    plan({ rows: C09_ROWS }).plan.digest,
    plan({ rows: C09_ROWS, config: ruleConfig('predecessor_suffix') }).plan.digest,
    ordinal.plan.digest,
    plan({ rows: C09_ROWS, locale: 'en' }).plan.digest,
  ])
  assert.equal(digests.size, 4, 'rule, format and locale each move the plan digest')
  assert.equal(plan({ rows: C09_ROWS, config: { placement: 'right', landing: 'keep_current' } }).plan.digest, plan({ rows: C09_ROWS }).plan.digest, 'landing and placement do not')
})

test('PB-H8 the attested count (§8.5): inferred needs count = K (degenerate too); unknown takes any count ≥ 0; the live floor follows base + count', () => {
  const { plan: p } = plan({ rows: C09_ROWS })
  assert.deepEqual({ ...PB.resolvePullBatchHistoryCount({ plan: p, confirmHistoricalBatchCount: 2 }) }, { historyMode: 'inferred', historyBatchCount: 2, writesInferredBatches: true, firstLiveBatchNo: 3 })
  assert.throws(() => PB.resolvePullBatchHistoryCount({ plan: p, confirmHistoricalBatchCount: 3 }), (error) => error.code === PULL_BATCH_ERROR_CODES.HISTORY_COUNT_MISMATCH && error.status === 409 && error.details.K === 2)
  assert.deepEqual({ ...PB.resolvePullBatchHistoryCount({ plan: p, historyMode: 'unknown', confirmHistoricalBatchCount: 5 }) }, { historyMode: 'unknown', historyBatchCount: 5, writesInferredBatches: false, firstLiveBatchNo: 6 })
  assert.equal(PB.resolvePullBatchHistoryCount({ plan: p, historyMode: 'unknown', confirmHistoricalBatchCount: 0 }).firstLiveBatchNo, 1)
  const degenerate = plan({ rows: [
    hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-19T01:00:00.000Z' }),
    hrow('b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: '2026-10-18T01:00:00.000Z' }),
  ] }).plan
  assert.equal(PB.resolvePullBatchHistoryCount({ plan: degenerate, confirmHistoricalBatchCount: 2 }).historyBatchCount, 2)
  assert.throws(() => PB.resolvePullBatchHistoryCount({ plan: degenerate, confirmHistoricalBatchCount: 1 }), (error) => error.code === PULL_BATCH_ERROR_CODES.HISTORY_COUNT_MISMATCH && error.details.degenerate === true)
  const gapPass = plan({ rows: [hrow('x2', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-20T00:59:59.000Z' })], base: 4 }).plan
  assert.equal(PB.resolvePullBatchHistoryCount({ plan: gapPass, confirmHistoricalBatchCount: 1 }).historyBatchCount, 5, 'a gap pass: base + count')
  for (const [mode, count] of [['guess', 2], ['inferred', -1], ['inferred', 1.5], ['inferred', '2'], [undefined, undefined]]) {
    assert.throws(() => PB.resolvePullBatchHistoryCount({ plan: p, historyMode: mode, confirmHistoricalBatchCount: count }), codeIs(PULL_BATCH_ERROR_CODES.INSTALL_REQUEST_INVALID, 400), `${mode}/${count}`)
  }
  assert.equal(PB.nextLivePullBatchNo({ maxBatchNo: 2, historyBatchCount: 5 }), 6, 'live numbering continues after max(batch_no, history count)')
  assert.equal(PB.nextLivePullBatchNo({ maxBatchNo: 7, historyBatchCount: 5 }), 8)
  assert.equal(PB.nextLivePullBatchNo({}), 1)
  assert.throws(() => PB.nextLivePullBatchNo({ maxBatchNo: -1 }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID))
})

// ── PB-H9..H10: review fixes MF1 / MF2 (the persisted plan reproduces its own assignment; the digest is clock-free) ──

/** Every row's membership over the PERSISTED plan equals its assignment's k (design §8.2 I3, §8.3 step 6). */
const membershipMismatches = (answer, rows) => rows
  .map((entry) => ({ recordId: entry.recordId, k: answer.assignments.get(entry.recordId).k, membership: PB.pullBatchHistoryMembership(answer.plan, { recordId: entry.recordId, createdAt: entry.createdAt }) }))
  .filter((entry) => entry.k !== entry.membership)

test('PB-H9 MF1: the persisted plan reproduces its own assignment — degenerate placements, exception-only clusters, rows after coveredUntil, and a seeded sweep', () => {
  // (a) a degenerate plan places add rows by anchor: the placements are persisted, so membership recovers them.
  const degenerateRows = [
    hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-19T01:00:00.000Z' }),
    hrow('b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: '2026-10-18T01:00:00.000Z' }),
    hrow('c', '2026-10-20T01:00:00.200Z', { decision: 'inactive', plannedAt: '2026-10-19T01:00:00.000Z', active: false }),
  ]
  const degenerate = plan({ rows: degenerateRows })
  assert.equal(degenerate.plan.degenerate, true)
  assert.deepEqual(membershipMismatches(degenerate, degenerateRows), [], '(a) degenerate placements')
  assert.deepEqual(degenerate.plan.placements, [{ recordId: 'a', k: 2 }, { recordId: 'b', k: 1 }], 'placements persisted, sorted by record id')
  assert.deepEqual(degenerate.plan.exceptions, [], 'placements are not exceptions')
  assert.equal(degenerate.plan.interleavedRows, 0, 'interleavedRows counts true interleaves only')
  assert.deepEqual(plan({ rows: C09_ROWS }).plan.placements, [], 'a non-degenerate plan places by time: no placements')
  // (b) an exception-only cluster: its span (from its exceptions) holds a TIME member of another cluster.
  const a1 = '2026-10-20T01:00:00.000Z'
  const exceptionOnlyRows = [
    hrow('old', '2026-10-20T00:00:00.000Z', { decision: 'inactive', plannedAt: a1, active: false }),
    hrow('e1', '2026-10-20T00:59:56.000Z', { decision: 'add', plannedAt: a1 }),
    hrow('mid', '2026-10-20T00:59:58.000Z', { decision: 'update', plannedAt: '2026-10-20T05:00:00.000Z' }),
    hrow('e2', '2026-10-20T00:59:59.000Z', { decision: 'add', plannedAt: a1 }),
  ]
  const exceptionOnly = plan({ rows: exceptionOnlyRows })
  assert.equal(exceptionOnly.plan.degenerate, false)
  assert.deepEqual(membershipMismatches(exceptionOnly, exceptionOnlyRows), [], '(b) the time member is answered by its own cluster')
  const anchored = exceptionOnly.plan.clusters.find((cluster) => cluster.anchorAt === a1)
  assert.equal(anchored.timeRows, 0, 'the anchor cluster holds exceptions only')
  assert.equal(exceptionOnly.plan.clusters.reduce((sum, cluster) => sum + cluster.timeRows, 0) + exceptionOnly.plan.exceptions.length, exceptionOnlyRows.length)
  // (c) an input row created after coveredUntil is a caller defect (the same DB read): refused, never counted in K.
  const afterRows = [
    hrow('in1', '2026-10-20T01:00:01.000Z', { decision: 'add', plannedAt: '2026-10-20T01:00:00.000Z' }),
    hrow('after', '2026-10-22T01:00:01.000Z', { decision: 'add', plannedAt: '2026-10-22T01:00:00.000Z' }),
  ]
  assert.throws(() => plan({ rows: afterRows }), (error) => error.code === PULL_BATCH_ERROR_CODES.STAMP_INVALID && error.details.field === 'coveredUntil', '(c)')
  assert.equal(plan({ rows: afterRows, coveredUntil: '2026-10-22T01:00:01.000Z' }).plan.K, 2, 'a row created AT coveredUntil is covered')
  // (d) a seeded sweep biased toward copy-like and clock-slack shapes.
  let seed = 20261107
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const baseMs = Date.parse('2026-10-20T00:00:00.000Z')
  const stats = { trials: 0, degenerate: 0, exceptions: 0, mismatched: 0 }
  for (let trial = 0; trial < 5000; trial += 1) {
    const anchors = []
    for (let i = 0, n = Math.floor(rand() * 4); i < n; i += 1) anchors.push(baseMs + Math.floor(rand() * 6 * 3600) * 1000)
    const rows = []
    const copyLike = rand() < 0.25
    for (let i = 0, n = 1 + Math.floor(rand() * 9); i < n; i += 1) {
      const isAnchored = anchors.length > 0 && rand() < 0.6
      const p = isAnchored ? pick(anchors) : null
      let c
      if (copyLike) c = baseMs + 3600 * 1000 + Math.floor(rand() * 1500)
      else if (isAnchored) c = p - 4900 + Math.floor(rand() * 4900) + (rand() < 0.4 ? Math.floor(rand() * 3 * 3600 * 1000) : 0)
      else c = baseMs + Math.floor(rand() * 7 * 3600) * 1000 + Math.floor(rand() * 1000)
      rows.push(hrow(`r${i}`, new Date(c).toISOString(), { decision: isAnchored ? 'add' : pick(['inactive', 'update']), plannedAt: isAnchored ? new Date(p).toISOString() : null, active: rand() < 0.7, partId: pick(['X', 'Y']) }))
    }
    const answer = plan({ rows, coveredUntil: '2026-10-22T00:00:00.000Z' })
    stats.trials += 1
    if (answer.plan.degenerate) stats.degenerate += 1
    if (answer.plan.exceptions.length) stats.exceptions += 1
    if (membershipMismatches(answer, rows).length) stats.mismatched += 1
  }
  assert.equal(stats.trials, 5000)
  assert.ok(stats.degenerate > 0 && stats.exceptions > 0, `the sweep reaches both shapes: ${JSON.stringify(stats)}`)
  assert.equal(stats.mismatched, 0, `(d) ${JSON.stringify(stats)}`)
})

test('PB-H10 MF2: the plan digest is clock-free — the same rows read at two coveredUntil values share it (dry-run -> install I0/I3); a new row moves it; coveredUntil stays in the plan', () => {
  const rows = [
    hrow('x1', '2026-10-20T01:00:01.000Z', { decision: 'add', plannedAt: '2026-10-20T01:00:00.000Z' }),
    hrow('x2', '2026-10-20T01:00:02.000Z', { decision: 'add', plannedAt: '2026-10-20T01:00:00.000Z' }),
  ]
  const dryRun = plan({ rows, coveredUntil: '2026-10-21T00:00:00.000Z' }).plan
  const install = plan({ rows, coveredUntil: '2026-10-21T00:05:00.000Z' }).plan
  assert.equal(install.digest, dryRun.digest)
  assert.equal(PB.pullBatchHistoryPlanDigest({ ...install, coveredUntil: '2030-01-01T00:00:00.000Z' }), install.digest, 'the digest never reads coveredUntil')
  assert.equal(dryRun.coveredUntil, '2026-10-21T00:00:00.000Z', 'coveredUntil is persisted (I5 and membership read it)')
  assert.equal(install.coveredUntil, '2026-10-21T00:05:00.000Z')
  const grown = plan({ rows: [...rows, hrow('x3', '2026-10-20T03:00:00.000Z', { decision: 'update' })], coveredUntil: '2026-10-21T00:05:00.000Z' }).plan
  assert.notEqual(grown.digest, install.digest, 'a new row in the read moves the digest')
  assert.notEqual(plan({ rows, coveredUntil: '2026-10-21T00:05:00.000Z', base: 2 }).plan.digest, install.digest, 'the base moves it')
})

// ── PB-H11..H12: review fixes round 3 (R2-1 the plan is input-order invariant; R2-2 the digest covers the per-record lists) ──

/** Every row's full assignment, in record-id order (the Map's own order follows the input and is never persisted). */
const assignmentList = (answer, rows) => rows
  .map((entry) => entry.recordId)
  .sort()
  .map((recordId) => [recordId, answer.assignments.get(recordId)])
const permutations = (list) => (list.length <= 1
  ? [list.slice()]
  : list.flatMap((head, index) => permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((tail) => [head, ...tail])))

// Two exception-only clusters whose earliest createdAt is the same millisecond (the R2-1 P4 shape), in S0.
const TIE_ROWS = [
  hrow('r0', '2026-10-20T00:00:00.000Z', { decision: 'update' }),
  hrow('r1', '2026-10-20T00:59:58.000Z', { decision: 'add', plannedAt: '2026-10-20T01:00:00.000Z' }),
  hrow('r2', '2026-10-20T00:59:58.000Z', { decision: 'add', plannedAt: '2026-10-20T01:00:03.000Z' }),
]

test('PB-H11 R2-1: the plan never depends on the input order — the whole persisted plan (exceptions and placements lists included), its digest and every assignment, over every permutation of exception-tie, degenerate and exception shapes', () => {
  const a1 = '2026-10-20T01:00:00.000Z'
  const shapes = {
    'two exception-only clusters, same earliest createdAt, S0': TIE_ROWS,
    'two exception-only clusters, same earliest createdAt, a later segment': [
      hrow('s3', '2026-10-20T01:20:01.000Z', { decision: 'add', plannedAt: '2026-10-20T01:20:00.000Z' }),
      hrow('s1', '2026-10-20T01:25:00.000Z', { decision: 'add', plannedAt: '2026-10-20T01:00:00.000Z' }),
      hrow('s2', '2026-10-20T01:25:00.000Z', { decision: 'add', plannedAt: '2026-10-20T01:10:00.000Z' }),
    ],
    'degenerate placements (PB-H4)': [
      hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-19T01:00:00.000Z' }),
      hrow('b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: '2026-10-18T01:00:00.000Z' }),
      hrow('c', '2026-10-20T01:00:00.200Z', { decision: 'inactive', plannedAt: '2026-10-19T01:00:00.000Z', active: false }),
    ],
    'degenerate late stamps, every row unplaced (PB-H4)': [
      hrow('d', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-20T21:00:00.000Z' }),
      hrow('e', '2026-10-20T03:00:00.000Z', { decision: 'add', plannedAt: '2026-10-20T21:00:00.000Z' }),
      hrow('f', '2026-10-20T03:00:01.000Z', { decision: 'update' }),
    ],
    'an exception-only cluster with two exceptions (PB-H9 b)': [
      hrow('old', '2026-10-20T00:00:00.000Z', { decision: 'inactive', plannedAt: a1, active: false }),
      hrow('e1', '2026-10-20T00:59:56.000Z', { decision: 'add', plannedAt: a1 }),
      hrow('mid', '2026-10-20T00:59:58.000Z', { decision: 'update', plannedAt: '2026-10-20T05:00:00.000Z' }),
      hrow('e2', '2026-10-20T00:59:59.000Z', { decision: 'add', plannedAt: a1 }),
    ],
    "R1's C09 shape (PB-H1)": C09_ROWS,
  }
  const reached = { exceptions: 0, placements: 0, unplaced: 0 }
  for (const [label, rows] of Object.entries(shapes)) {
    const first = plan({ rows })
    if (first.plan.exceptions.length > 1) reached.exceptions += 1
    if (first.plan.placements.length > 1) reached.placements += 1
    if (first.plan.unplacedRows > 0) reached.unplaced += 1
    for (const order of permutations(rows)) {
      const other = plan({ rows: order })
      const at = `${label} [${order.map((entry) => entry.recordId).join(',')}]`
      assert.deepEqual(other.plan, first.plan, `${at}: the persisted plan`)
      assert.equal(other.plan.digest, first.plan.digest, `${at}: the digest`)
      assert.deepEqual(assignmentList(other, rows), assignmentList(first, rows), `${at}: the assignments`)
    }
  }
  assert.ok(reached.exceptions >= 3 && reached.placements >= 1 && reached.unplaced >= 2, `the shapes reach every per-record list: ${JSON.stringify(reached)}`)
  // The tie is broken by anchor time: the earlier anchor's cluster takes the smaller number.
  const tie = plan({ rows: TIE_ROWS })
  assert.deepEqual(tie.plan.clusters.map((cluster) => [cluster.k, cluster.anchorAt, cluster.timeRows]), [
    [1, null, 1], [2, '2026-10-20T01:00:00.000Z', 0], [3, '2026-10-20T01:00:03.000Z', 0],
  ])
  assert.deepEqual(tie.plan.exceptions, [{ recordId: 'r1', k: 2 }, { recordId: 'r2', k: 3 }])
  // A seeded sweep: each plan re-planned in two shuffled orders.
  let seed = 20261108
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const shuffled = (list) => {
    const out = list.slice()
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
  const baseMs = Date.parse('2026-10-20T00:00:00.000Z')
  let moved = 0
  for (let trial = 0; trial < 1500; trial += 1) {
    const anchors = []
    for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i += 1) anchors.push(baseMs + Math.floor(rand() * 6 * 3600) * 1000)
    const copyLike = rand() < 0.25
    const rows = []
    for (let i = 0, n = 2 + Math.floor(rand() * 7); i < n; i += 1) {
      const isAnchored = rand() < 0.6
      const p = isAnchored ? anchors[Math.floor(rand() * anchors.length)] : null
      let c
      if (copyLike) c = baseMs + 3600 * 1000 + Math.floor(rand() * 1500)
      else if (isAnchored) c = p - 4900 + Math.floor(rand() * 4900) + (rand() < 0.4 ? Math.floor(rand() * 3 * 3600 * 1000) : 0)
      else c = baseMs + Math.floor(rand() * 7 * 3600) * 1000
      rows.push(hrow(`r${i}`, new Date(c).toISOString(), { decision: isAnchored ? 'add' : (rand() < 0.5 ? 'inactive' : 'update'), plannedAt: isAnchored ? new Date(p).toISOString() : null, active: rand() < 0.7, partId: rand() < 0.5 ? 'X' : 'Y' }))
    }
    const first = plan({ rows, coveredUntil: '2026-10-22T00:00:00.000Z' })
    for (let again = 0; again < 2; again += 1) {
      const other = plan({ rows: shuffled(rows), coveredUntil: '2026-10-22T00:00:00.000Z' })
      if (!util.isDeepStrictEqual(other.plan, first.plan) || !util.isDeepStrictEqual(assignmentList(other, rows), assignmentList(first, rows))) moved += 1
    }
  }
  assert.equal(moved, 0, 'shuffled re-plans that moved')
})

test('PB-H12 R2-2: the plan digest covers the per-record lists — two plans with deepEqual clusters but different placements (degenerate) or different exceptions never share a digest', () => {
  const p1 = '2026-10-18T01:00:00.000Z'
  const p2 = '2026-10-19T01:00:00.000Z'
  const one = plan({ rows: [hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: p1 }), hrow('b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: p2 })] }).plan
  const two = plan({ rows: [hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: p2 }), hrow('b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: p1 })] }).plan
  assert.equal(one.degenerate && two.degenerate, true)
  assert.deepEqual(one.clusters, two.clusters, 'placements: the clusters are the same')
  assert.notDeepEqual(one.placements, two.placements, 'placements: the per-record anchors are swapped')
  assert.notEqual(one.digest, two.digest, 'placements: a per-record reassignment moves the digest')
  // The exception-tie shape with the two rows' anchors swapped: same clusters, the exceptions' k swapped.
  const swapped = TIE_ROWS.map((entry) => (entry.recordId === 'r1' ? { ...entry, plannedAt: '2026-10-20T01:00:03.000Z' } : entry.recordId === 'r2' ? { ...entry, plannedAt: '2026-10-20T01:00:00.000Z' } : entry))
  const three = plan({ rows: TIE_ROWS }).plan
  const four = plan({ rows: swapped }).plan
  assert.equal(three.degenerate || four.degenerate, false)
  assert.deepEqual(three.clusters, four.clusters, 'exceptions: the clusters are the same')
  assert.notDeepEqual(three.exceptions, four.exceptions, "exceptions: the rows' clusters are swapped")
  assert.notEqual(three.digest, four.digest, 'exceptions: a per-record reassignment moves the digest')
})

// ── PB-V: the verifier's killing assertions (round 1, MF4) — each guards one design rule no other test pins ──

test('PB-V03 R6 boundary: an open row created EXACTLY at L*\'s opening does not predate it ("earlier than", §5.2 step 5)', () => {
  const known = row('X', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })
  const atOpening = row('X', ['Z', 'X'], { active: false }, { createdAt: LEDGER[0].openedAt })
  assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [known, atOpening] })), L(1))
})

test('PB-V06 history rule F: an inactive earlier row at the SAME path is not a PROPER suffix', () => {
  const rows = [
    hrow('X_old', '2026-10-20T01:00:00.000Z', { decision: 'update', active: false, partId: 'X', pathTokens: ['A', 'X'] }),
    hrow('X_new', '2026-10-20T03:00:00.000Z', { decision: 'update', active: true, partId: 'X', pathTokens: ['A', 'X'] }),
  ]
  const { plan: p, assignments } = plan({ rows, config: ruleConfig('predecessor_suffix') })
  assert.equal(p.K, 2)
  assert.equal(assignments.get('X_new').firstPullBatch, assignments.get('X_new').pullBatch)
})

test('PB-V10 the 5 s clock slack (§8.3 step 1): an add row created 3 s BEFORE its plan time is an anchor and a cut', () => {
  const p = '2026-10-20T01:10:00.000Z'
  const rows = [hrow('old', '2026-10-20T01:00:00.000Z'), hrow('early', '2026-10-20T01:09:57.000Z', { decision: 'add', plannedAt: p })]
  const { plan: out, assignments } = plan({ rows })
  assert.deepEqual(out.cuts, [p])
  assert.equal(out.K, 2)
  assert.equal(assignments.get('early').k, 2)
  assert.equal(assignments.get('old').k, 1)
})

test('PB-V11 ONE anchor with a sub-2 s createdAt spread is NOT degenerate (§8.3 step 2 needs |A| > 1)', () => {
  const rows = [
    hrow('a', '2026-10-20T01:00:00.500Z', { decision: 'add', plannedAt: '2026-10-20T01:00:00.000Z' }),
    hrow('b', '2026-10-20T01:00:01.000Z'),
  ]
  const { plan: out, assignments } = plan({ rows })
  assert.equal(out.degenerate, false)
  assert.equal(assignments.get('b').k, 1)
})

test('PB-V24 the copied 首次 label is trimmed', () => {
  assert.equal(only(carry({ decisions: [add('X', ['B', 'X'])], existingRows: [row('X', ['A', 'X'], {}, { pullBatch: L(1), firstPullBatch: `  ${L(1)}  ` })] })), L(1))
})

test('PB-V27 history rule F, ACTIVE-ROOT: an ACTIVE earlier-cluster row is not a predecessor (rule A still carries)', () => {
  const rows = [
    hrow('S-01_root', '2026-10-20T01:00:00.000Z', { decision: 'update', active: true, pathTokens: ['S-01'] }),
    hrow('S-01_under', '2026-10-20T03:00:00.000Z', { decision: 'update', active: true, pathTokens: ['P-07', 'S-01'] }),
  ]
  const ruleF = plan({ rows, config: ruleConfig('predecessor_suffix') })
  assert.equal(ruleF.assignments.get('S-01_under').firstPullBatch, ruleF.assignments.get('S-01_under').pullBatch, 'rule F: 第2批 / 第2批')
  const ruleA = plan({ rows })
  assert.equal(ruleA.assignments.get('S-01_under').firstPullBatch, ruleA.assignments.get('S-01_root').pullBatch, 'rule A: 第1批 / 第2批')
})

test('PB-V28 an UNPLACED row (degenerate plan) gets 本次 历史批次未知 and 首次 by §5 — the placed row of its material decides', () => {
  const rows = [
    hrow('X_a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-18T01:00:00.000Z' }),
    hrow('Y_b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: '2026-10-19T01:00:00.000Z' }),
    hrow('X_c', '2026-10-20T01:00:00.200Z', { decision: 'inactive', active: false }),
  ]
  const { plan: out, assignments } = plan({ rows })
  assert.equal(out.degenerate, true)
  assert.equal(assignments.get('X_c').pullBatch, UNKNOWN)
  assert.equal(assignments.get('X_c').firstPullBatch, assignments.get('X_a').pullBatch)
})

test('PB-V29 prototype-chain keys are refused 400 CONFIG_INVALID naming the key (not a TypeError)', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => normalizePullBatchConfig(JSON.parse(`{"${name}": 1}`)), (error) => error.code === PULL_BATCH_ERROR_CODES.CONFIG_INVALID && error.status === 400 && error.details.field === name, name)
  }
})

test('PB-V34 a blank-string creator is no creator (the reader convention)', () => {
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], {}, { createdBy: '   ' })), true)
})

test('PB-V35 the degenerate spread is measured over the WHOLE input, not the add rows only', () => {
  const rows = [
    hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-20T00:59:59.000Z' }),
    hrow('b', '2026-10-20T01:00:00.500Z', { decision: 'add', plannedAt: '2026-10-20T00:59:58.000Z' }),
    hrow('c', '2026-10-20T02:00:00.000Z'),
  ]
  assert.equal(plan({ rows }).plan.degenerate, false)
})

test('PB-V36 exactly ONE late add stamp is not degenerate ("more than one", §8.3 step 2)', () => {
  const rows = [
    hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-20T02:00:00.000Z' }),
    hrow('b', '2026-10-20T03:00:00.000Z'),
  ]
  assert.equal(plan({ rows }).plan.degenerate, false)
})

test('PB-V37 a createdAt gap of EXACTLY G does not split ("longer than G")', () => {
  assert.equal(plan({ rows: [hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'update' }), hrow('b', '2026-10-20T01:30:00.000Z', { decision: 'update' })] }).plan.K, 1)
})

test('PB-V40 membership: a persisted exception wins over a time interval that contains its createdAt', () => {
  const p1 = '2026-10-20T01:00:00.000Z'
  const p2 = '2026-10-20T01:10:00.000Z'
  const rows = [
    hrow('a1', '2026-10-20T01:00:01.000Z', { decision: 'add', plannedAt: p1 }),
    hrow('b1', '2026-10-20T01:10:01.000Z', { decision: 'add', plannedAt: p2 }),
    hrow('late', '2026-10-20T01:12:00.000Z', { decision: 'add', plannedAt: p1 }),
    hrow('b2', '2026-10-20T01:15:00.000Z', { decision: 'add', plannedAt: p2 }),
  ]
  const { plan: out, assignments } = plan({ rows })
  assert.equal(assignments.get('late').k, 1)
  assert.equal(PB.pullBatchHistoryMembership(out, { recordId: 'late', createdAt: '2026-10-20T01:12:00.000Z' }), 1)
})

test('PB-V41 an add-stamped row WITHOUT createdAt is no anchor (p ≤ c + 5 s needs c)', () => {
  const rows = [
    hrow('x', null, { decision: 'add', plannedAt: '2026-10-20T01:10:00.000Z' }),
    hrow('y', '2026-10-20T01:00:00.000Z', { decision: 'update' }),
    hrow('z', '2026-10-20T01:20:00.000Z', { decision: 'update' }),
  ]
  const { plan: out, assignments } = plan({ rows })
  assert.deepEqual(out.cuts, [])
  assert.equal(out.K, 1)
  assert.equal(assignments.get('x').k, null)
})

test('PB-V51 a whitespace-only 本次 cell is blank: the row is a gap row', () => {
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'], {}, { pullBatch: '   ', firstPullBatch: L(1) })), true)
})

test('PB-V55 history rule F, OWN-1 (C09): the batch-2 copies carry 首次 = cluster 1 through the swept predecessors; P-07 is new', () => {
  const { plan: out, assignments } = plan({ rows: C09_ROWS, config: ruleConfig('predecessor_suffix') })
  const [one, two] = out.clusters.map((cluster) => cluster.label)
  assert.equal(assignments.get('S-01_new').firstPullBatch, one)
  assert.equal(assignments.get('C_new').firstPullBatch, one)
  assert.equal(assignments.get('P-07_new').firstPullBatch, two)
})

// ── PB-K: the configuration vocabulary ─────────────────────────────────────────────────────────────

test('PB-K1 DEFAULT_PULL_BATCH_CONFIG is exactly the 10-27 design, frozen; undefined / null / {} normalize to it; the fixed facts are not settings', () => {
  assert.deepEqual({ ...DEFAULT_PULL_BATCH_CONFIG }, {
    firstPullBatchRule: 'material',
    labelFormat: 'ordinal_date',
    landing: 'promote_prep_fill',
    placement: 'left',
  })
  assert.ok(Object.isFrozen(DEFAULT_PULL_BATCH_CONFIG))
  assert.deepEqual([...PB.PULL_BATCH_CONFIG_KEYS], ['firstPullBatchRule', 'labelFormat', 'landing', 'placement'])
  for (const input of [undefined, null, {}]) assert.deepEqual({ ...normalizePullBatchConfig(input) }, { ...DEFAULT_PULL_BATCH_CONFIG }, JSON.stringify(input))
  assert.ok(Object.isFrozen(normalizePullBatchConfig({ placement: 'right' })))
  assert.deepEqual({ ...PB.PULL_BATCH_FIXED_FACTS }, { pullBatchMeaning: 'created', formalExport: 'excluded', trashedRowsAreEvidence: false, firstPullBatchColumn: 'shown' })
  assert.ok(Object.isFrozen(PB.PULL_BATCH_FIXED_FACTS))
  for (const fact of Object.keys(PB.PULL_BATCH_FIXED_FACTS)) assert.equal(PB.PULL_BATCH_CONFIG_KEYS.includes(fact), false, `${fact} is a fixed fact, not a setting`)
})

test('PB-K2 R-65 C2: the ONE token set — every valid value of every key is accepted and merged over the defaults', () => {
  const expected = {
    firstPullBatchRule: ['material', 'predecessor_suffix'],
    labelFormat: ['ordinal_date', 'ordinal'],
    landing: ['promote_prep_fill', 'keep_current'],
    placement: ['left', 'right'],
  }
  assert.deepEqual(Object.fromEntries(Object.entries(PB.PULL_BATCH_CONFIG_VALUES).map(([k, v]) => [k, [...v]])), expected)
  for (const [configKey, values] of Object.entries(expected)) {
    assert.equal(values[0], DEFAULT_PULL_BATCH_CONFIG[configKey], `${configKey}: the first value is the default`)
    for (const value of values) {
      const normalized = normalizePullBatchConfig({ [configKey]: value })
      assert.equal(normalized[configKey], value, `${configKey}=${value}`)
      for (const other of PB.PULL_BATCH_CONFIG_KEYS) if (other !== configKey) assert.equal(normalized[other], DEFAULT_PULL_BATCH_CONFIG[other])
    }
  }
})

test("PB-K3 fail-closed: rule 'off', format 'date', the fixed-fact keys (whatever their value), an unknown key / value, a loose type or a non-object is refused 400 CONFIG_INVALID naming the field", () => {
  const refused = [
    // R-65 C2: removed from accepted input — refused, never ignored
    [{ firstPullBatchRule: 'off' }, 'firstPullBatchRule'],
    [{ labelFormat: 'date' }, 'labelFormat'],
    [{ formalExport: 'excluded' }, 'formalExport'],
    [{ formalExport: 'included' }, 'formalExport'],
    [{ trashedRowsAreEvidence: false }, 'trashedRowsAreEvidence'],
    [{ trashedRowsAreEvidence: true }, 'trashedRowsAreEvidence'],
    [{ pullBatchMeaning: 'created' }, 'pullBatchMeaning'],
    [{ pullBatchMeaning: 'latest' }, 'pullBatchMeaning'],
    [{ firstPullBatchColumn: 'shown' }, 'firstPullBatchColumn'],
    // the vocabulary of other drafts is not this one
    [{ firstPullBatchRule: 'position' }, 'firstPullBatchRule'],
    [{ landing: 'promote_fill' }, 'landing'],
    [{ firstPullBatchRule: 'path' }, 'firstPullBatchRule'],
    [{ firstPullBatchRule: 'Material' }, 'firstPullBatchRule'],
    [{ labelFormat: 'ordinal_date ' }, 'labelFormat'],
    [{ landing: 'prep-fill' }, 'landing'],
    [{ placement: 'middle' }, 'placement'],
    [{ placement: true }, 'placement'],
    [{ batchColumns: 'two' }, 'batchColumns'],
    [{ __proto__x: 1 }, '__proto__x'],
    [[], 'config'],
    ['material', 'config'],
    [new Map(), 'config'],
  ]
  for (const [input, field] of refused) {
    assert.throws(() => normalizePullBatchConfig(input), (error) => error.code === PULL_BATCH_ERROR_CODES.CONFIG_INVALID && error.status === 400 && error.details.field === field, JSON.stringify(input))
  }
  assert.throws(() => buildFirstPullBatchByKey({ locale: 'zh-CN', config: { firstPullBatchRule: 'path' } }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID), 'every entry point normalizes its config')
  assert.throws(() => plan({ rows: [], config: { mystery: 1 } }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID))
})

const UNLOCKED = Object.freeze({ hasStamped: false, landingApplied: false, placementApplied: false })

test('PB-K4 the lock helper (R-65 C2): rule and format lock when the sheet first stamps; landing and placement lock once applied; each flag locks only its own keys', () => {
  assert.deepEqual({ ...PB.PULL_BATCH_CONFIG_LOCKS }, { firstPullBatchRule: 'hasStamped', labelFormat: 'hasStamped', landing: 'landingApplied', placement: 'placementApplied' })
  assert.deepEqual([...PB.PULL_BATCH_CONFIG_LOCK_STATES], ['hasStamped', 'landingApplied', 'placementApplied'])
  assert.deepEqual([...PB.PULL_BATCH_MEANING_LOCKED_KEYS], ['firstPullBatchRule', 'labelFormat'])
  const everyEdit = { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal', landing: 'keep_current', placement: 'right' }
  const refusedWith = (state, edit = everyEdit, captured = null) => [...refusedPullBatchConfigEdits({ captured, edit, state: { ...UNLOCKED, ...state } })]
  assert.deepEqual(refusedWith({}), [], 'nothing applied: everything is editable')
  assert.deepEqual(refusedWith({ hasStamped: true }), ['firstPullBatchRule', 'labelFormat'], 'stamped: rule and format (null captured = the defaults)')
  assert.deepEqual(refusedWith({ landingApplied: true }), ['landing'])
  assert.deepEqual(refusedWith({ placementApplied: true }), ['placement'])
  assert.deepEqual(refusedWith({ hasStamped: true, landingApplied: true, placementApplied: true }), ['firstPullBatchRule', 'labelFormat', 'landing', 'placement'])
  for (const [flag, keys] of [['hasStamped', ['firstPullBatchRule', 'labelFormat']], ['landingApplied', ['landing']], ['placementApplied', ['placement']]]) {
    for (const lockedKey of keys) assert.deepEqual(refusedWith({ [flag]: true }, { [lockedKey]: everyEdit[lockedKey] }, {}), [lockedKey], `${flag} locks ${lockedKey}`)
    for (const freeKey of PB.PULL_BATCH_CONFIG_KEYS.filter((entry) => !keys.includes(entry))) {
      assert.deepEqual(refusedWith({ [flag]: true }, { [freeKey]: everyEdit[freeKey] }, {}), [], `${flag} leaves ${freeKey} editable`)
    }
  }
  const captured = { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal', landing: 'keep_current', placement: 'right' }
  const all = { hasStamped: true, landingApplied: true, placementApplied: true }
  assert.deepEqual(refusedWith(all, captured, captured), [], 'repeating the captured value is no change')
  assert.deepEqual(refusedWith(all, { firstPullBatchRule: 'material' }, captured), ['firstPullBatchRule'], 'back to the default is a change too')
  assert.throws(() => refusedPullBatchConfigEdits({ captured: null, edit: { labelFormat: 'date' }, state: UNLOCKED }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID), 'an invalid edit is refused before the lock is read')
  assert.throws(() => refusedPullBatchConfigEdits({ captured: { mystery: 1 }, edit: {}, state: UNLOCKED }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID))
  assert.throws(() => refusedPullBatchConfigEdits({ captured: null, edit: null, state: UNLOCKED }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID))
  for (const [state, field] of [
    [undefined, 'state'],
    [true, 'state'],
    [{ hasStamped: true, landingApplied: false }, 'placementApplied'],
    [{ ...UNLOCKED, hasStamped: 'yes' }, 'hasStamped'],
    [{ ...UNLOCKED, landingApplied: 1 }, 'landingApplied'],
    [{ ...UNLOCKED, stamped: true }, 'stamped'],
  ]) {
    assert.throws(() => refusedPullBatchConfigEdits({ captured: null, edit: {}, state }), (error) => error.code === PULL_BATCH_ERROR_CODES.CONFIG_INVALID && error.status === 400 && error.details.field === field, JSON.stringify(state))
  }
  assert.ok(Object.isFrozen(refusedPullBatchConfigEdits({ captured: null, edit: {}, state: UNLOCKED })))
  assert.equal(PULL_BATCH_ERROR_CODES.CONFIG_LOCKED, 'STOCK_PREP_PULL_BATCH_CONFIG_LOCKED')
  assert.equal(PB.PULL_BATCH_ERROR_HTTP_STATUS[PULL_BATCH_ERROR_CODES.CONFIG_LOCKED], 409)
})

test('PB-K5 R-65 C10: the settings help text names rule F\'s history caveat (today\'s 有效 state) in both locales; rule A says it is time-consistent; values-free and frozen', () => {
  const help = PB.PULL_BATCH_SETTINGS_HELP
  assert.deepEqual(Object.keys(help), ['firstPullBatchRule'])
  assert.deepEqual(Object.keys(help.firstPullBatchRule), [...PB.FIRST_PULL_BATCH_RULES], 'one entry per rule')
  for (const rule of PB.FIRST_PULL_BATCH_RULES) {
    assert.deepEqual(Object.keys(help.firstPullBatchRule[rule]).sort(), [...PB.PULL_BATCH_LOCALES].sort())
    assert.ok(Object.isFrozen(help.firstPullBatchRule[rule]))
  }
  assert.ok(Object.isFrozen(help) && Object.isFrozen(help.firstPullBatchRule))
  const f = help.firstPullBatchRule.predecessor_suffix
  assert.match(f['zh-CN'], /^按位置/)
  assert.match(f['zh-CN'], /今天的「有效」状态/)
  assert.match(f['zh-CN'], /可能与当时实时拉取/)
  assert.match(f.en, /today's active state/)
  assert.match(f.en, /can differ from what a live pull would have written/)
  assert.match(help.firstPullBatchRule.material['zh-CN'], /^按物料/)
  assert.match(help.firstPullBatchRule.material.en, /same result as live pulls/)
  assert.equal(/S-01|P-07|PRJ|\d{4}-\d{2}-\d{2}/.test(JSON.stringify(help)), false, 'values-free copy')
})

// ── PB-I: the per-sheet install's pure helpers (BI-2; register R-65) ───────────────────────────────────────────

const AS = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const firstInstall = (rows, extra = {}) => PB.planPullBatchFirstInstall({ rows, coveredUntil: COVERED, locale: 'zh-CN', ...extra })
const assignmentsOf = (args) => PB.pullBatchHistoryAssignments({ ledgerBatches: [], priorRows: [], ...args })
const plainMap = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

test('PB-I1 P2-1: the approvalRef shape — register rows and comment refs pass, every accepted value passes the audit store\'s string gate; #, /, short, long and a leading dash are refused', () => {
  const pattern = PB.PULL_BATCH_APPROVAL_REF_PATTERN
  for (const ok of ['R-65', 'O-BI-1.S-01', '6079:1234567890', 'abc', 'A'.repeat(64)]) {
    assert.ok(pattern.test(ok), ok)
    assert.ok(AS.__internals.SAFE_STRING_PATTERN.test(ok), `${ok} is audit-safe`)
  }
  for (const bad of ['#6079', 'R-65/x', 'ab', 'A'.repeat(65), '-R65', ' R-65', 'R 65', '']) assert.equal(pattern.test(bad), false, JSON.stringify(bad))
})

test('PB-I2 the install digest ignores exactly the undigested run facts (and each segment\'s clock) and moves with every other key', () => {
  const envelope = firstInstall(C09_ROWS)
  assert.equal(envelope.digest, PB.pullBatchInstallPlanDigest(envelope))
  assert.notEqual(envelope.digest, PB.pullBatchHistoryPlanDigest(envelope), 'not the planner\'s own digest (critic C13)')
  assert.deepEqual([...PB.PULL_BATCH_INSTALL_PLAN_UNDIGESTED_KEYS], ['digest', 'coveredUntil', 'previousHistoryStatus', 'historyMode', 'aborted'])
  const same = { ...envelope, digest: 'x', coveredUntil: '2030-01-01T00:00:00.000Z', previousHistoryStatus: 'backfilled', historyMode: 'unknown', aborted: true, segments: envelope.segments.map((segment) => ({ ...segment, coveredUntil: '2031-01-01T00:00:00.000Z' })) }
  assert.equal(PB.pullBatchInstallPlanDigest(same), envelope.digest)
  for (const [label, changed] of [
    ['run', { ...envelope, run: 'gap_pass' }],
    ['segments K', { ...envelope, segments: [{ ...envelope.segments[0], K: 9 }] }],
    ['gapPass', { ...envelope, gapPass: { rows: ['x'], joins: [], interleaved: [], newestOpenedAt: null } }],
    ['clusters', { ...envelope, clusters: envelope.clusters.slice(1) }],
    ['gapMinutes', { ...envelope, gapMinutes: 31 }],
  ]) assert.notEqual(PB.pullBatchInstallPlanDigest(changed), envelope.digest, label)
  assert.equal(firstInstall(C09_ROWS, { coveredUntil: '2026-10-21T05:00:00.000Z' }).digest, envelope.digest, 'the read clock never moves it')
  assert.equal(Object.isFrozen(envelope), true)
})

test('PB-I3 P2-3 THE CONTRACT: pullBatchHistoryAssignments over the persisted envelope deepEquals the planner\'s assignments — C09, both rules, and a 5000-trial seeded sweep (degenerate, exceptions, unplaced); the indexed membership equals pullBatchHistoryMembership', () => {
  for (const rule of RULES) {
    const planned = plan({ rows: C09_ROWS, config: ruleConfig(rule) })
    const envelope = firstInstall(C09_ROWS, { config: ruleConfig(rule) })
    assert.deepEqual(plainMap(assignmentsOf({ plan: envelope, rows: C09_ROWS })), plainMap(planned.assignments), rule)
  }
  let seed = 20261108
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const baseMs = Date.parse('2026-10-20T00:00:00.000Z')
  const stats = { trials: 0, degenerate: 0, exceptions: 0, unplaced: 0, mismatched: 0, membership: 0 }
  for (let trial = 0; trial < 5000; trial += 1) {
    const anchors = []
    for (let i = 0, n = Math.floor(rand() * 4); i < n; i += 1) anchors.push(baseMs + Math.floor(rand() * 6 * 3600) * 1000)
    const rows = []
    const copyLike = rand() < 0.25
    for (let i = 0, n = 1 + Math.floor(rand() * 9); i < n; i += 1) {
      const isAnchored = anchors.length > 0 && rand() < 0.6
      const p = isAnchored ? pick(anchors) : null
      let c
      if (copyLike) c = baseMs + 3600 * 1000 + Math.floor(rand() * 1500)
      else if (isAnchored) c = p - 4900 + Math.floor(rand() * 4900) + (rand() < 0.4 ? Math.floor(rand() * 3 * 3600 * 1000) : 0)
      else c = baseMs + Math.floor(rand() * 7 * 3600) * 1000 + Math.floor(rand() * 1000)
      const tokens = pick([['X'], ['A', 'X'], ['B', 'A', 'X'], ['Y'], ['A', 'Y']])
      rows.push(hrow(`r${i}`, rand() < 0.05 ? null : new Date(c).toISOString(), { decision: isAnchored ? 'add' : pick(['inactive', 'update']), plannedAt: isAnchored ? new Date(p).toISOString() : null, active: rand() < 0.6, partId: tokens[tokens.length - 1], pathTokens: tokens }))
    }
    const config = ruleConfig(pick(RULES))
    const planned = plan({ rows, coveredUntil: '2026-10-22T00:00:00.000Z', config })
    const envelope = firstInstall(rows, { coveredUntil: '2026-10-22T00:00:00.000Z', config })
    stats.trials += 1
    if (planned.plan.degenerate) stats.degenerate += 1
    if (planned.plan.exceptions.length) stats.exceptions += 1
    if (planned.plan.unplacedRows) stats.unplaced += 1
    if (!util.isDeepStrictEqual(plainMap(assignmentsOf({ plan: envelope, rows })), plainMap(planned.assignments))) stats.mismatched += 1
    const index = PB.__internals.membershipIndexOf(envelope)
    for (const entry of rows) {
      const createdMs = PB.__internals.timeMsOf(entry.createdAt)
      if (index(entry.recordId, createdMs) !== PB.pullBatchHistoryMembership(envelope, entry)) stats.membership += 1
    }
  }
  assert.ok(stats.degenerate > 0 && stats.exceptions > 0 && stats.unplaced > 0, `the sweep reaches every shape: ${JSON.stringify(stats)}`)
  assert.equal(stats.mismatched, 0, JSON.stringify(stats))
  assert.equal(stats.membership, 0, JSON.stringify(stats))
})

test('PB-I4 M-2B-19: a re-run never reads a RUN stamp — rows whose decision / plannedAt were rewritten after planning get the same labels', () => {
  const envelope = firstInstall(C09_ROWS)
  const rewritten = C09_ROWS.map((entry) => ({ ...entry, decision: 'update', plannedAt: '2026-10-20T09:00:00.000Z' }))
  assert.deepEqual(plainMap(assignmentsOf({ plan: envelope, rows: rewritten })), plainMap(assignmentsOf({ plan: envelope, rows: C09_ROWS })))
})

const LIVE_P = '2026-10-23T01:00:00.000Z'
const GAP_LEDGER = [
  { batchNo: 1, label: L(1), openedAt: '2026-10-20T01:00:00.000Z', status: 'closed' },
  { batchNo: 2, label: L(2, '2026-10-23'), openedAt: LIVE_P, status: 'closed' },
]
const priorRow = (id, createdAt, { pullBatch, firstPullBatch, decision = 'add', plannedAt = LIVE_P, active = true, partId = id.replace(/_.*$/, ''), pathTokens } = {}) => ({
  ...hrow(id, createdAt, { decision, plannedAt, active, partId, pathTokens }), pullBatch, firstPullBatch,
})
const gapPass = (args) => PB.planPullBatchGapPass({ ledgerBatches: GAP_LEDGER, historyBatchCount: 0, coveredUntil: '2026-10-26T00:00:00.000Z', locale: 'zh-CN', ...args })

test('PB-I5 the gap pass (design §8.6): exact join on an EQUAL plan time to ONE live label; ±1 ms or two labels ⇒ no join; interleaved older rows ⇒ 历史批次未知; the rest after base = max(batch_no, count); GAP-C09 carries 首次', () => {
  const prior = [
    priorRow('S-01_b1', '2026-10-20T01:00:01.000Z', { pullBatch: L(1), firstPullBatch: L(1), plannedAt: '2026-10-20T01:00:00.000Z', active: false }),
    priorRow('Z_live', '2026-10-23T01:00:01.000Z', { pullBatch: L(2, '2026-10-23'), firstPullBatch: L(2, '2026-10-23') }),
  ]
  const gapRows = [
    hrow('Q_join', '2026-10-23T03:00:00.000Z', { decision: 'add', plannedAt: LIVE_P }),
    hrow('Q_ms', '2026-10-23T03:00:00.500Z', { decision: 'add', plannedAt: '2026-10-23T01:00:00.001Z' }),
    hrow('S-01_old', '2026-10-22T00:00:00.000Z', { decision: 'add', plannedAt: '2026-10-22T00:00:00.000Z' }),
    hrow('S-01_copy', '2026-10-25T02:00:01.000Z', { decision: 'add', plannedAt: '2026-10-25T02:00:00.000Z', pathTokens: ['P-07', 'S-01'] }),
    hrow('P-07_new', '2026-10-25T02:00:02.000Z', { decision: 'add', plannedAt: '2026-10-25T02:00:00.000Z' }),
  ]
  for (const rule of RULES) {
    const envelope = gapPass({ gapRows, priorRows: prior, config: ruleConfig(rule) })
    assert.equal(envelope.run, 'gap_pass')
    assert.equal(envelope.base, 2, 'base = max non-void batch_no')
    assert.deepEqual(envelope.gapPass.joins, [{ recordId: 'Q_join', label: L(2, '2026-10-23') }], 'equal plan time only (±1 ms never joins)')
    assert.deepEqual(envelope.gapPass.interleaved, [{ recordId: 'S-01_old' }], 'older than the newest batch, unjoined')
    assert.deepEqual(envelope.gapPass.rows, ['P-07_new', 'Q_join', 'Q_ms', 'S-01_copy', 'S-01_old'], 'R persisted, sorted')
    assert.equal(envelope.gapPass.newestOpenedAt, LIVE_P)
    const got = assignmentsOf({ plan: envelope, rows: gapRows, priorRows: prior, ledgerBatches: GAP_LEDGER })
    assert.equal(got.get('Q_join').pullBatch, L(2, '2026-10-23'), 'the join carries the LIVE label unmarked')
    assert.equal(got.get('S-01_old').pullBatch, UNKNOWN)
    assert.match(got.get('Q_ms').pullBatch, /^第3批（推定，/, 'clusters are numbered after base')
    assert.match(got.get('P-07_new').pullBatch, /^第4批（推定，/)
    assert.equal(got.get('S-01_copy').firstPullBatch, rule === 'material' ? L(1) : L(1), `GAP-C09: the copy carries 第1批 [${rule}]`)
    assert.equal(got.get('P-07_new').firstPullBatch, got.get('P-07_new').pullBatch, 'a new material is this batch')
    assert.equal(got.size, gapRows.length, 'every R row and nothing else')
  }
  const twoLabels = gapPass({ gapRows: [gapRows[0]], priorRows: [...prior, priorRow('Y_other', '2026-10-23T01:00:02.000Z', { pullBatch: L(3, '2026-10-23'), firstPullBatch: L(3, '2026-10-23') })] })
  assert.deepEqual(twoLabels.gapPass.joins, [], 'two live labels for one plan time: no join')
  const inferredPrior = gapPass({ gapRows: [gapRows[0]], priorRows: [priorRow('Z_inf', '2026-10-23T01:00:01.000Z', { pullBatch: I(2), firstPullBatch: I(2) })] })
  assert.deepEqual(inferredPrior.gapPass.joins, [], 'a 推定 label never joins (M-2B-9)')
  assert.equal(gapPass({ gapRows: [], priorRows: prior, historyBatchCount: 7 }).base, 7, 'base = max(batch_no, history_batch_count)')
})

// Review round 1 (BI-2 verification, H4d): the exact join counts only `add` prior rows. A prior row stamped at the SAME
// plan time with a live 本次 but decision 'update' was created by an EARLIER batch (本次 = its creation batch); a gap row
// added at that plan time must not join that label.
test('PB-I5b (review H4d) no exact join onto the live label of a non-add (update) prior row at the same plan time', () => {
  const p = '2026-10-22T01:00:00.000Z'
  const envelope = PB.planPullBatchGapPass({
    gapRows: [{ recordId: 'rec_gap', createdAt: '2026-10-22T01:00:05.000Z', decision: 'add', plannedAt: p, active: true, partId: 'N-01', path: ['N-01'] }],
    priorRows: [{ recordId: 'rec_upd', createdAt: '2026-10-20T01:00:01.000Z', decision: 'update', plannedAt: p, active: true, partId: 'S-01', path: ['S-01'], pullBatch: L(1), firstPullBatch: L(1) }],
    ledgerBatches: [{ batchNo: 1, label: L(1), status: 'closed', openedAt: '2026-10-20T01:00:00.000Z' }],
    historyBatchCount: 0,
    coveredUntil: '2026-10-22T01:00:05.000Z',
    locale: 'zh-CN',
    config: PB.DEFAULT_PULL_BATCH_CONFIG,
  })
  assert.deepEqual(envelope.gapPass.joins, [], JSON.stringify(envelope.gapPass))
})

test('PB-I6 critic C1: a gap pass labels R only — a labelled prior row inside a gap-cluster interval is never in R and never gets an assignment; its cells feed 首次', () => {
  const prior = [priorRow('X_live', '2026-10-25T02:00:01.500Z', { pullBatch: L(2, '2026-10-23'), firstPullBatch: L(2, '2026-10-23') })]
  const gapRows = [
    hrow('X_a', '2026-10-25T02:00:01.000Z', { decision: 'update' }),
    hrow('X_b', '2026-10-25T02:00:02.000Z', { decision: 'update' }),
  ]
  const envelope = gapPass({ gapRows, priorRows: prior, ledgerBatches: GAP_LEDGER.slice(0, 1) })
  assert.equal(envelope.K, 1)
  const allRows = [...gapRows, prior[0]]
  assert.deepEqual([...PB.pullBatchInstallRunSet({ plan: envelope, rows: allRows })].sort(), ['X_a', 'X_b'], 'the live row inside the cluster interval is not in R')
  const got = assignmentsOf({ plan: envelope, rows: gapRows, priorRows: prior, ledgerBatches: GAP_LEDGER.slice(0, 1) })
  assert.equal(got.has('X_live'), false)
  assert.equal(got.get('X_a').firstPullBatch, L(2, '2026-10-23'), 'the prior cell decides 首次 (material)')
})

test('PB-I7 P2-10 extension: planned after base + K with the pool after every segment; the flattened plan reproduces both segments; R covers the new rows; a degenerate side is refused extension_degenerate', () => {
  for (const rule of RULES) {
    const config = ruleConfig(rule)
    const persisted = firstInstall(C09_ROWS, { config })
    const newRows = [
      hrow('S-01_ext', '2026-10-21T03:00:01.000Z', { decision: 'add', plannedAt: '2026-10-21T03:00:00.000Z', pathTokens: ['Q', 'S-01'] }),
      hrow('N_ext', '2026-10-21T03:00:02.000Z', { decision: 'add', plannedAt: '2026-10-21T03:00:00.000Z' }),
    ]
    const extended = PB.extendPullBatchHistoryPlan({ persisted, runRows: C09_ROWS, newRows, priorRows: [], coveredUntil: '2026-10-21T04:00:00.000Z', ledgerBatches: [] })
    assert.equal(extended.K, persisted.K + 1)
    assert.deepEqual(extended.segments.map((segment) => [segment.base, segment.K]), [[0, 2], [2, 1]])
    assert.equal(extended.coveredUntil, '2026-10-21T04:00:00.000Z')
    assert.equal(extended.clusters[2].k, 3)
    assert.notEqual(extended.digest, persisted.digest)
    const all = [...C09_ROWS, ...newRows]
    assert.deepEqual([...PB.pullBatchInstallRunSet({ plan: extended, rows: all })].sort(), all.map((entry) => entry.recordId).sort())
    const got = assignmentsOf({ plan: extended, rows: all })
    const base = assignmentsOf({ plan: persisted, rows: C09_ROWS })
    for (const entry of C09_ROWS) assert.deepEqual(got.get(entry.recordId), base.get(entry.recordId), `${rule}: segment 0 unchanged`)
    assert.equal(got.get('S-01_ext').pullBatch, extended.clusters[2].label)
    assert.equal(got.get('S-01_ext').firstPullBatch, persisted.clusters[0].label, `${rule}: 首次 over the base segment's decided rows`)
    assert.deepEqual([...PB.pullBatchInstallRunSet({ plan: persisted, rows: all })].sort(), C09_ROWS.map((entry) => entry.recordId).sort(), 'before the extension the new rows are uncovered')
  }
  const degenerateRows = [
    hrow('a', '2026-10-20T01:00:00.000Z', { decision: 'add', plannedAt: '2026-10-19T01:00:00.000Z' }),
    hrow('b', '2026-10-20T01:00:00.100Z', { decision: 'add', plannedAt: '2026-10-18T01:00:00.000Z' }),
  ]
  const degenerate = firstInstall(degenerateRows)
  assert.equal(degenerate.degenerate, true)
  assert.throws(() => PB.extendPullBatchHistoryPlan({ persisted: degenerate, runRows: degenerateRows, newRows: [hrow('c', '2026-10-21T03:00:00.000Z')], coveredUntil: '2026-10-21T04:00:00.000Z' }), (error) => error.code === PULL_BATCH_ERROR_CODES.PLAN_CHANGED && error.details.reason === 'extension_degenerate')
})

test('PB-I8 critic C12 choice (b): under rule F a set 首次 cell of an R row is kept (and feeds the pool); under rule A keepFirst is ignored', () => {
  const envelopeF = firstInstall(C09_ROWS, { config: ruleConfig('predecessor_suffix') })
  const keep = new Map([['S-01_new', '第9批（推定，2026-10-01）']])
  const kept = assignmentsOf({ plan: envelopeF, rows: C09_ROWS, keepFirst: keep })
  assert.equal(kept.get('S-01_new').firstPullBatch, '第9批（推定，2026-10-01）')
  const envelopeA = firstInstall(C09_ROWS)
  assert.deepEqual(plainMap(assignmentsOf({ plan: envelopeA, rows: C09_ROWS, keepFirst: keep })), plainMap(assignmentsOf({ plan: envelopeA, rows: C09_ROWS })))
})

test('PB-I9 the resolve inputs: one inferred batch per cluster (closed / backfill shape inputs), the plan labels = every cluster label + 历史批次未知 in both locales; a malformed envelope is 500', () => {
  const envelope = firstInstall(C09_ROWS)
  const batches = PB.pullBatchInstallInferredBatches(envelope)
  assert.deepEqual(batches.map((batch) => [batch.batchNo, batch.label, batch.evidence]), envelope.clusters.map((cluster) => [cluster.k, cluster.label, cluster.evidence]))
  assert.equal(batches[0].openedAt, envelope.clusters[0].startAt)
  assert.equal(batches[0].displayDay, PB.pullBatchLabelDay(envelope.clusters[0].startAt))
  const labels = PB.pullBatchInstallPlanLabels(envelope)
  assert.ok(labels.has(envelope.clusters[0].label) && labels.has(UNKNOWN) && labels.has('Unknown historical batch'))
  for (const bad of [null, {}, { ...envelope, run: 'other' }, { ...envelope, segments: [] }, { ...envelope, run: 'gap_pass' }]) {
    assert.throws(() => PB.pullBatchHistoryAssignments({ plan: bad, rows: [] }), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID))
  }
})

test('PB-I10 critic C2: the record-ref key is the planner\'s own Symbol (spelled by its registry key; no require)', () => {
  assert.equal(PB.EXISTING_ROW_RECORD_REF, planner.EXISTING_ROW_RECORD_REF)
})

// ── PB-P ───────────────────────────────────────────────────────────────────────────────────────────

// MF5: both pins read the TEXT, whatever the require form (a quoted literal, path.join(__dirname, …), a
// concatenation, a template, a dynamic import) — a regex over quoted literals alone passes vacuously.
test('PB-P1 PORTABILITY (S6 C-1, design §12.2): the pure core contains exactly one require( — require(\'node:crypto\') — and no import(', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  assert.equal(source.split('require(').length - 1, 1, 'exactly one require( in the core')
  assert.equal(source.split("require('node:crypto')").length - 1, 1, "and it is require('node:crypto')")
  assert.equal(/\bimport\s*\(|^\s*import\s/m.test(source), false, 'no dynamic import( and no import statement')
})

// BI-1b (the lanes; register R-65) replaced the BI-1a "not wired" pin with the WIRED set, exactly: the pure module is
// named by the lanes helper, the status read, the store, the template band, the reader (table actions), the writer,
// the large lane (its stored-plan shape), pilot readiness (v3), the routes and index. The ledger STORE is named only by
// index (which builds it), by the lanes helper (its execution-ref pattern) and — for its constants only — by the BI-7
// settings helper; BI-2 adds the install library to the wired set (it reaches the ledger only through injected deps).
// Every request reaches the ledger through
// the routes' lane input, which hands it over only while the pull-batch switch is on.
test('PB-P2 WIRED (BI-1b): exactly these runtime files name stock-preparation-pull-batch, in any form (BI-2 adds the install library, BI-7 the settings helper); only index, the lanes helper and the settings helper name the store', () => {
  const runtime = ['index.cjs', ...fs.readdirSync(LIB).filter((name) => name.endsWith('.cjs')).map((name) => `lib/${name}`)]
    .filter((file) => file !== 'lib/stock-preparation-pull-batch.cjs')
  assert.ok(runtime.length > 100, 'the scan sees the plugin runtime')
  const textOf = (file) => fs.readFileSync(path.join(PLUGIN, file), 'utf8')
  const wired = runtime.filter((file) => textOf(file).includes('stock-preparation-pull-batch'))
  assert.deepEqual(wired, [
    'index.cjs',
    'lib/http-routes.cjs',
    'lib/stock-preparation-apply-writer.cjs',
    'lib/stock-preparation-large-bom-jobs.cjs',
    'lib/stock-preparation-pilot-readiness.cjs',
    // BI-2 (R-65): the per-sheet install library (portable; it reaches the ledger only through its injected deps).
    'lib/stock-preparation-pull-batch-install.cjs',
    'lib/stock-preparation-pull-batch-lanes.cjs',
    // 批次标识 BI-7 (R-65): the settings routes' helper — bodies, answers and the in-transaction audit adapter.
    'lib/stock-preparation-pull-batch-settings.cjs',
    'lib/stock-preparation-pull-batch-status.cjs',
    'lib/stock-preparation-pull-batch-store.cjs',
    'lib/stock-preparation-table-actions.cjs',
    'lib/stock-preparation-templates.cjs',
  ])
  const storeUsers = runtime.filter((file) => file !== 'lib/stock-preparation-pull-batch-store.cjs' && textOf(file).includes('stock-preparation-pull-batch-store'))
  // BI-7: the settings helper requires the store for its CONSTANTS only (the setting keys and the audit action / modes,
  // one spelling); the store INSTANCE still reaches the routes only as the service index.cjs builds.
  assert.deepEqual(storeUsers, ['index.cjs', 'lib/stock-preparation-pull-batch-lanes.cjs', 'lib/stock-preparation-pull-batch-settings.cjs'], 'the ledger store is built by index and read only through the lanes and the settings helper')
})

test('PB-P3 the error codes are closed, code-shaped, unique and carry their HTTP status; the vocabularies are frozen', () => {
  const codes = Object.values(PULL_BATCH_ERROR_CODES)
  assert.equal(codes.length, 19)
  assert.equal(new Set(codes).size, codes.length)
  assert.ok(codes.every((code) => /^STOCK_PREP_PULL_BATCH_[A-Z_]+$/.test(code)))
  assert.deepEqual(Object.keys(PB.PULL_BATCH_ERROR_HTTP_STATUS).sort(), codes.slice().sort(), 'every code has a status')
  const error = new PB.StockPreparationPullBatchError(PULL_BATCH_ERROR_CODES.STORE_FAILED, 'm', { operation: 'read' })
  assert.equal(error.status, 503)
  assert.equal(error.details.operation, 'read')
  for (const list of [PB.PULL_BATCH_CLOSED_REASONS, PB.PULL_BATCH_RESPONSE_REASONS, PB.PULL_BATCH_LABEL_KINDS, PB.PULL_BATCH_LOCALES, PB.PULL_BATCH_LABEL_FORMATS, PB.FIRST_PULL_BATCH_RULES, PB.PULL_BATCH_CONFIG_VALUES, PB.PULL_BATCH_ERROR_CODES, PB.PULL_BATCH_FIXED_FACTS, PB.PULL_BATCH_CONFIG_LOCKS, PB.PULL_BATCH_CONFIG_LOCK_STATES, PB.PULL_BATCH_MEANING_LOCKED_KEYS, PB.PULL_BATCH_SETTINGS_HELP]) {
    assert.ok(Object.isFrozen(list))
  }
  assert.deepEqual([...PB.PULL_BATCH_LABEL_KINDS], ['live', 'inferred', 'unknown', 'manual', 'blank'])
  assert.deepEqual([...PB.FIRST_PULL_BATCH_RULES], ['material', 'predecessor_suffix'])
  assert.ok(PB.PULL_BATCH_CLOSED_REASONS.includes('recovery_verified'), 'S6 C-3 token')
})

test('PB-A1 (BI-1b review MF-5) assertAllocatedBatch: the ledger allocation must answer a LIVE label — manual, unknown, blank, inferred (both locales, both formats) or a non-string label is 500 STAMP_INVALID naming the label', () => {
  const answer = (label) => ({ batchId: 'batch_syn_a1', batchNo: 2, label, joined: false })
  for (const label of ['第2批（2026-11-08）', '第2批', 'Batch 2 (2026-11-08)', 'Batch 2']) {
    assert.deepEqual({ ...PB.assertAllocatedBatch(answer(label)) }, answer(label), `calibration: ${label} is live`)
  }
  for (const label of ['人工补充', 'not a batch label', '', '   ', '第2批（推定，2026-11-08）', '第2批（推定）', 'Batch 2 (inferred, 2026-11-08)', 'Batch 2 (inferred)', 7, null]) {
    assert.notEqual(PB.parsePullBatchLabel(typeof label === 'string' ? label : '').kind, 'live', `calibration: ${JSON.stringify(label)} is not live`)
    assert.throws(
      () => PB.assertAllocatedBatch(answer(label)),
      (error) => error.code === 'STOCK_PREP_PULL_BATCH_STAMP_INVALID' && error.status === 500 && error.details.field === 'label',
      JSON.stringify(label),
    )
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch.test.cjs', tests)
