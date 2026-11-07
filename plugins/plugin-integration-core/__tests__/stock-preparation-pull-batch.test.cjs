'use strict'

// 批次标识 BI-1a — THE PORTABLE PURE CORE (lib/stock-preparation-pull-batch.cjs). Pure and not wired.
//
//   PB-G  the label grammar: 3 formats x 2 locales x live/inferred, unknown, 人工补充 = manual, blank, fail-safe
//   PB-S  the reader's Symbol is the shared registry key; the planner's created-by key is the planner's own
//   PB-E  the evidence set E and the gap-row predicate (rule 'off' reads the 本次 cell only)
//   PB-C  首次批次 — the §5.4 worked cases under BOTH rules (+ 'off'); OWN-1 / Q6-a / R through the REAL planner
//   PB-D  the content-only digest: lane-free, ext_-free, key-order-free
//   PB-H  the history plan (§8.3) and the attested count (§8.5)
//   PB-K  the configuration vocabulary: defaults = the 10-27 design, closed keys, meaning-locking
//   PB-P  portability, not-wired pin, closed vocabularies
//
// Synthetic values only (S-01, P-07, C, X, A, B).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
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

test('PB-G1 the twelve strings: three formats x two locales x live / inferred, exactly as the grammar table says', () => {
  const expected = {
    ordinal_date: { 'zh-CN': ['第3批（2026-10-20）', '第3批（推定，2026-10-20）'], en: ['Batch 3 (2026-10-20)', 'Batch 3 (inferred, 2026-10-20)'] },
    ordinal: { 'zh-CN': ['第3批', '第3批（推定）'], en: ['Batch 3', 'Batch 3 (inferred)'] },
    date: { 'zh-CN': ['2026-10-20', '2026-10-20（推定）'], en: ['2026-10-20', '2026-10-20 (inferred)'] },
  }
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

test('PB-G2 every format parses in both locales whatever is configured: kind and format recovered, n where printed, day where printed; no string parses as another kind', () => {
  const seen = new Map()
  for (const labelFormat of PB.PULL_BATCH_LABEL_FORMATS) {
    for (const locale of PB.PULL_BATCH_LOCALES) {
      for (const kind of ['live', 'inferred']) {
        for (const [n, day] of [[1, '2026-01-31'], [12, '2026-10-27'], [207, '2024-02-29']]) {
          const text = formatPullBatchLabel({ kind, n, day, locale, labelFormat })
          const parsed = parsePullBatchLabel(text)
          assert.equal(parsed.kind, kind, text)
          assert.equal(parsed.format, labelFormat, text)
          assert.equal(parsed.n, labelFormat === 'date' ? null : n, `${text}: n`)
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
    { kind: 'other', n: 1, day: '2026-10-20', locale: 'zh-CN' },
    { kind: 'live', n: 1, day: '2026-10-20', locale: 'zh' },
    { kind: 'unknown' },
  ]) {
    assert.throws(() => formatPullBatchLabel(bad), codeIs(PULL_BATCH_ERROR_CODES.STAMP_INVALID, 500), JSON.stringify(bad))
  }
  assert.equal(formatPullBatchLabel({ kind: 'live', n: 5, day: '2026-10-20', locale: 'en', labelFormat: 'date' }), '2026-10-20', "'date' still needs n: a batch always has a number")
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

test('PB-E1 E = machine-created ∧ not manual:v1: ∧ a non-blank normalized part id; gap rows = E rows unlocked with a blank cell', () => {
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'])), true)
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], {}, { createdBy: 'u_person' })), false, 'a person-created row (新建记录 / import / right-click duplicate)')
  assert.equal(PB.isPullBatchEvidenceRow(row('X', ['X'], { idempotencyKey: 'manual:v1:rec_1' })), false, 'a manual row')
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

test("PB-E2 rule 'off' writes no 首次, so a blank 首次 cell is NOT a gap row; a blank 本次 cell still is", () => {
  const off = { config: ruleConfig('off') }
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'], {}, { pullBatch: L(1) }), off), false)
  assert.equal(PB.isPullBatchGapRow(row('X', ['X'], {}, { firstPullBatch: L(1) }), off), true)
  assert.equal(PB.isPullBatchGapRow(row('X', ['X']), off), true)
  assert.equal(PB.countPullBatchGapRows([row('X', ['X'], {}, { pullBatch: L(1) }), row('Y', ['Y'])], off), 1)
  assert.throws(() => PB.isPullBatchGapRow(row('X', ['X']), { config: { firstPullBatchRule: 'none' } }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 400))
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
  assert.equal(carry({ decisions: plan2.decisions, existingRows: sheet1, config: ruleConfig('off') }).size, 0, "'off': nothing is computed")
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
      [row('X', ['X'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) }), row('X', ['X'], { active: false, idempotencyKey: 'k-x-copy' }, { createdAt: '2026-10-21T00:00:00.000Z' })],
      [add('X', ['B', 'X'])], { material: [L(1)], predecessor_suffix: [L(1)] }],
    ['GAP-C09 (batch 2 pulled while the switch was off: blank copies, created after batch 1 opened; live batch 3 reads 第1批)',
      [row('S-01', ['S-01'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1) }), row('S-01', ['P-07', 'S-01'], {}, { createdAt: '2026-10-21T00:00:00.000Z' }), row('P-07', ['P-07'], {}, { createdAt: '2026-10-21T00:00:00.000Z' })],
      [add('S-01', ['Q-09', 'P-07', 'S-01']), inactive('S-01', ['P-07', 'S-01'])], { material: [L(1)], predecessor_suffix: [L(1)] }],
    ['UNK (a matching row labelled 历史批次未知, no known label)', [row('X', ['A', 'X'], {}, { pullBatch: UNKNOWN, firstPullBatch: UNKNOWN })], [add('X', ['B', 'X'])], { material: [UNKNOWN], predecessor_suffix: [null] }],
    ['PERSON-DUP (a right-click duplicate of a batch-1 row: creator present, same part id, cells copied) is never evidence',
      [row('X', ['X'], { active: false }, { pullBatch: L(1), firstPullBatch: L(1), createdBy: 'u_person' })], [add('X', ['B', 'X'])], { material: [null], predecessor_suffix: [null] }],
    ['MANUAL (a manual:v1: row) is never evidence', [row('X', ['X'], { active: false, idempotencyKey: 'manual:v1:rec_9' }, { pullBatch: '人工补充', firstPullBatch: '人工补充' })], [add('X', ['B', 'X'])], { material: [null], predecessor_suffix: [null] }],
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
    assert.equal(carry({ decisions, existingRows, ledgerBatches: ledger, config: ruleConfig('off') }).size, 0, `${label} ['off']: nothing is computed`)
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

test("PB-C5 the 'ordinal' and 'date' formats: L* by number, else by day; two same-day 'date' batches read the LATEST opening (fail-safe); mixed formats are not comparable", () => {
  const ord = (n) => L(n, '2026-10-20', 'zh-CN', 'ordinal')
  const ordinalSheet = [row('X', ['B', 'X'], {}, { pullBatch: ord(2), firstPullBatch: ord(2) }), row('X', ['A', 'X'], {}, { pullBatch: ord(1), firstPullBatch: ord(1) })]
  const ordinalLedger = [{ label: ord(1), openedAt: '2026-10-20T01:00:00.000Z', status: 'closed' }, { label: ord(2), openedAt: '2026-10-22T01:00:00.000Z', status: 'closed' }]
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: ordinalSheet, ledgerBatches: ordinalLedger })), '第1批')
  const day = (d) => L(9, d, 'zh-CN', 'date')
  const dateSheet = [row('X', ['B', 'X'], {}, { pullBatch: day('2026-10-22'), firstPullBatch: day('2026-10-22') }), row('X', ['A', 'X'], {}, { pullBatch: day('2026-10-20'), firstPullBatch: day('2026-10-20') })]
  const dateLedger = [
    { label: '2026-10-20', openedAt: '2026-10-20T01:00:00.000Z', status: 'closed' },
    { label: '2026-10-20', openedAt: '2026-10-20T09:00:00.000Z', status: 'closed' },
    { label: '2026-10-22', openedAt: '2026-10-22T01:00:00.000Z', status: 'closed' },
  ]
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: dateSheet, ledgerBatches: dateLedger })), '2026-10-20', "'date': the earliest DAY wins")
  const between = row('X', ['Z', 'X'], {}, { createdAt: '2026-10-20T05:00:00.000Z' })
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: [...dateSheet, between], ledgerBatches: dateLedger })), UNKNOWN,
    'an open row between two same-day openings could predate the first appearance: 历史批次未知')
  const after = row('X', ['Z', 'X'], {}, { createdAt: '2026-10-20T10:00:00.000Z' })
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: [...dateSheet, after], ledgerBatches: dateLedger })), '2026-10-20')
  const mixed = [row('X', ['A', 'X'], {}, { firstPullBatch: ord(1) }), row('X', ['B', 'X'], {}, { firstPullBatch: day('2026-10-19') })]
  assert.equal(only(carry({ decisions: [add('X', ['C', 'X'])], existingRows: mixed })), UNKNOWN, 'a number-only and a day-only label cannot be ordered')
})

test('PB-C6 trashedRowsAreEvidence: trashed rows are ignored while the setting is off and read (as predecessors) when it is on, under both rules', () => {
  const trashed = [row('X', ['X'], {}, { pullBatch: L(1), firstPullBatch: L(1) })]
  const base = { decisions: [add('X', ['B', 'X'])], existingRows: [], trashedRows: trashed }
  for (const rule of RULES) {
    assert.equal(only(carry({ ...base, config: { firstPullBatchRule: rule } })), null, `${rule}: off by default — the trash is not evidence`)
    assert.equal(only(carry({ ...base, config: { firstPullBatchRule: rule, trashedRowsAreEvidence: false } })), null, `${rule}: explicitly off`)
    assert.equal(only(carry({ ...base, config: { firstPullBatchRule: rule, trashedRowsAreEvidence: true } })), L(1), `${rule}: on — the trashed batch-1 row decides`)
  }
  const personTrash = [row('X', ['X'], {}, { pullBatch: L(1), firstPullBatch: L(1), createdBy: 'u_person' })]
  assert.equal(only(carry({ ...base, trashedRows: personTrash, config: { trashedRowsAreEvidence: true } })), null, 'a trashed person row is still never evidence')
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

test("PB-H7 the configuration reaches the plan: label format, rule 'off' (首次 left blank), trashed evidence; the digest moves with every meaning-locked key", () => {
  const ordinal = plan({ rows: C09_ROWS, config: { labelFormat: 'ordinal' } })
  assert.deepEqual(ordinal.plan.clusters.map((c) => c.label), ['第1批（推定）', '第2批（推定）'])
  const dated = plan({ rows: C09_ROWS, config: { labelFormat: 'date' }, locale: 'en' })
  assert.match(dated.plan.clusters[0].label, /^\d{4}-\d{2}-\d{2} \(inferred\)$/)
  const off = plan({ rows: C09_ROWS, config: ruleConfig('off') })
  for (const [, value] of off.assignments) assert.equal(value.firstPullBatch, '', "'off': no 首次 value")
  const trashed = [{ partId: 'P-07', path: JSON.stringify(['P-07']), firstPullBatch: I(1, '2026-10-01'), createdAt: '2026-10-01T00:00:00.000Z' }]
  const ledger = [{ label: I(1, '2026-10-01'), openedAt: '2026-10-01T00:00:00.000Z', status: 'closed' }]
  assert.equal(plan({ rows: C09_ROWS, trashedRows: trashed, ledgerBatches: ledger }).assignments.get('P-07_new').firstPullBatch, plan({ rows: C09_ROWS }).plan.clusters[1].label, 'trash ignored by default')
  assert.equal(plan({ rows: C09_ROWS, trashedRows: trashed, ledgerBatches: ledger, config: { trashedRowsAreEvidence: true } }).assignments.get('P-07_new').firstPullBatch, I(1, '2026-10-01'), 'trash read when on')
  const digests = new Set([
    plan({ rows: C09_ROWS }).plan.digest,
    plan({ rows: C09_ROWS, config: ruleConfig('predecessor_suffix') }).plan.digest,
    plan({ rows: C09_ROWS, config: ruleConfig('off') }).plan.digest,
    ordinal.plan.digest,
    plan({ rows: C09_ROWS, config: { trashedRowsAreEvidence: true } }).plan.digest,
    plan({ rows: C09_ROWS, locale: 'en' }).plan.digest,
  ])
  assert.equal(digests.size, 6, 'rule, format, trash switch and locale each move the plan digest')
  assert.equal(plan({ rows: C09_ROWS, config: { placement: 'right', landing: 'keep_current', formalExport: 'included' } }).plan.digest, plan({ rows: C09_ROWS }).plan.digest, 'presentation keys do not')
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

// ── PB-K: the configuration vocabulary ─────────────────────────────────────────────────────────────

test('PB-K1 DEFAULT_PULL_BATCH_CONFIG is exactly the 10-27 design, frozen; undefined / null / {} normalize to it', () => {
  assert.deepEqual({ ...DEFAULT_PULL_BATCH_CONFIG }, {
    firstPullBatchRule: 'material',
    pullBatchMeaning: 'created',
    labelFormat: 'ordinal_date',
    landing: 'promote_prep_fill',
    formalExport: 'excluded',
    placement: 'left',
    trashedRowsAreEvidence: false,
  })
  assert.ok(Object.isFrozen(DEFAULT_PULL_BATCH_CONFIG))
  assert.deepEqual([...PB.PULL_BATCH_CONFIG_KEYS], ['firstPullBatchRule', 'pullBatchMeaning', 'labelFormat', 'landing', 'formalExport', 'placement', 'trashedRowsAreEvidence'])
  for (const input of [undefined, null, {}]) assert.deepEqual({ ...normalizePullBatchConfig(input) }, { ...DEFAULT_PULL_BATCH_CONFIG }, JSON.stringify(input))
  assert.ok(Object.isFrozen(normalizePullBatchConfig({ placement: 'right' })))
})

test('PB-K2 every valid value of every key is accepted and merged over the defaults', () => {
  const expected = {
    firstPullBatchRule: ['material', 'predecessor_suffix', 'off'],
    pullBatchMeaning: ['created'],
    labelFormat: ['ordinal_date', 'ordinal', 'date'],
    landing: ['promote_prep_fill', 'keep_current'],
    formalExport: ['excluded', 'included'],
    placement: ['left', 'right'],
    trashedRowsAreEvidence: [false, true],
  }
  assert.deepEqual(Object.fromEntries(Object.entries(PB.PULL_BATCH_CONFIG_VALUES).map(([k, v]) => [k, [...v]])), expected)
  for (const [configKey, values] of Object.entries(expected)) {
    for (const value of values) {
      const normalized = normalizePullBatchConfig({ [configKey]: value })
      assert.equal(normalized[configKey], value, `${configKey}=${value}`)
      for (const other of PB.PULL_BATCH_CONFIG_KEYS) if (other !== configKey) assert.equal(normalized[other], DEFAULT_PULL_BATCH_CONFIG[other])
    }
  }
})

test("PB-K3 fail-closed: an unknown key, an unknown value (the deferred 'latest' meaning included), a loose type or a non-object is refused 400 CONFIG_INVALID naming the field", () => {
  const refused = [
    [{ firstPullBatchRule: 'path' }, 'firstPullBatchRule'],
    [{ firstPullBatchRule: 'Material' }, 'firstPullBatchRule'],
    [{ pullBatchMeaning: 'latest' }, 'pullBatchMeaning'],
    [{ pullBatchMeaning: 'latest_pull' }, 'pullBatchMeaning'],
    [{ labelFormat: 'ordinal_date ' }, 'labelFormat'],
    [{ landing: 'prep-fill' }, 'landing'],
    [{ formalExport: true }, 'formalExport'],
    [{ placement: 'middle' }, 'placement'],
    [{ trashedRowsAreEvidence: 'true' }, 'trashedRowsAreEvidence'],
    [{ trashedRowsAreEvidence: 1 }, 'trashedRowsAreEvidence'],
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

test('PB-K4 the meaning lock: once a sheet has stamped, edits to firstPullBatchRule / pullBatchMeaning / labelFormat / trashedRowsAreEvidence are refused; presentation keys stay editable', () => {
  assert.deepEqual([...PB.PULL_BATCH_MEANING_LOCKED_KEYS], ['firstPullBatchRule', 'pullBatchMeaning', 'labelFormat', 'trashedRowsAreEvidence'])
  const everyEdit = { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'date', trashedRowsAreEvidence: true, landing: 'keep_current', formalExport: 'included', placement: 'right' }
  assert.deepEqual([...refusedPullBatchConfigEdits({ captured: null, edit: everyEdit, stamped: false })], [], 'not stamped: everything is editable')
  assert.deepEqual([...refusedPullBatchConfigEdits({ captured: null, edit: everyEdit, stamped: true })], ['firstPullBatchRule', 'labelFormat', 'trashedRowsAreEvidence'], 'stamped: the meaning keys are locked (null captured = the defaults)')
  for (const lockedKey of ['firstPullBatchRule', 'labelFormat', 'trashedRowsAreEvidence']) {
    assert.deepEqual([...refusedPullBatchConfigEdits({ captured: {}, edit: { [lockedKey]: everyEdit[lockedKey] }, stamped: true })], [lockedKey], lockedKey)
  }
  for (const freeKey of ['landing', 'formalExport', 'placement']) {
    assert.deepEqual([...refusedPullBatchConfigEdits({ captured: {}, edit: { [freeKey]: everyEdit[freeKey] }, stamped: true })], [], freeKey)
  }
  const captured = { firstPullBatchRule: 'off', labelFormat: 'ordinal' }
  assert.deepEqual([...refusedPullBatchConfigEdits({ captured, edit: { firstPullBatchRule: 'off', labelFormat: 'ordinal', pullBatchMeaning: 'created' }, stamped: true })], [], 'repeating the captured value is no change')
  assert.deepEqual([...refusedPullBatchConfigEdits({ captured, edit: { firstPullBatchRule: 'material' }, stamped: true })], ['firstPullBatchRule'], 'back to the default is a change too')
  assert.throws(() => refusedPullBatchConfigEdits({ captured: null, edit: { pullBatchMeaning: 'latest' }, stamped: false }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID), 'an invalid edit is refused before the lock is read')
  assert.throws(() => refusedPullBatchConfigEdits({ captured: { mystery: 1 }, edit: {}, stamped: true }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID))
  assert.throws(() => refusedPullBatchConfigEdits({ captured: null, edit: {}, stamped: 'yes' }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID))
  assert.throws(() => refusedPullBatchConfigEdits({ captured: null, edit: null, stamped: true }), codeIs(PULL_BATCH_ERROR_CODES.CONFIG_INVALID))
  assert.ok(Object.isFrozen(refusedPullBatchConfigEdits({ captured: null, edit: {}, stamped: true })))
  assert.equal(PULL_BATCH_ERROR_CODES.CONFIG_LOCKED, 'STOCK_PREP_PULL_BATCH_CONFIG_LOCKED')
  assert.equal(PB.PULL_BATCH_ERROR_HTTP_STATUS[PULL_BATCH_ERROR_CODES.CONFIG_LOCKED], 409)
})

// ── PB-P ───────────────────────────────────────────────────────────────────────────────────────────

const requiresOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])

test('PB-P1 PORTABILITY (S6 C-1, design §12.2): the pure core requires node:crypto and nothing else', () => {
  assert.deepEqual(requiresOf(MODULE_PATH), ['node:crypto'])
})

test('PB-P2 NOT WIRED (BI-1a): no plugin runtime file requires the pure core yet — the lane / store PR replaces this pin', () => {
  const runtime = ['index.cjs', ...fs.readdirSync(LIB).filter((name) => name.endsWith('.cjs')).map((name) => `lib/${name}`)]
  const wired = runtime.filter((file) => requiresOf(path.join(PLUGIN, file)).some((entry) => entry.includes('stock-preparation-pull-batch')))
  assert.deepEqual(wired, [])
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
  for (const list of [PB.PULL_BATCH_CLOSED_REASONS, PB.PULL_BATCH_RESPONSE_REASONS, PB.PULL_BATCH_LABEL_KINDS, PB.PULL_BATCH_LOCALES, PB.PULL_BATCH_LABEL_FORMATS, PB.FIRST_PULL_BATCH_RULES, PB.PULL_BATCH_CONFIG_VALUES, PB.PULL_BATCH_ERROR_CODES]) {
    assert.ok(Object.isFrozen(list))
  }
  assert.deepEqual([...PB.PULL_BATCH_LABEL_KINDS], ['live', 'inferred', 'unknown', 'manual', 'blank'])
  assert.deepEqual([...PB.FIRST_PULL_BATCH_RULES], ['material', 'predecessor_suffix', 'off'])
  assert.ok(PB.PULL_BATCH_CLOSED_REASONS.includes('recovery_verified'), 'S6 C-3 token')
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch.test.cjs', tests)
