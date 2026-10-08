'use strict'

// P3 suggestion-operators hermetic battery (general-prep-system feasibility
// doc 2026-07-21 rev-2, layer 1 "suggestion 算子对"). Plain node test (throws
// on failure); no DB, no network. Values-free fixtures: abstract tokens only.
// Pins: cascade calendar-day arithmetic (incl. the documented NO-holiday-
// calendar limitation via a weekend landing), root-row and missing-lead skips,
// suggestion targeting the plm_system column (never demandDate), prefill
// latest-first ranking, empty-history emptiness (never fabricate), and the
// multi-candidate ranked-list-not-a-pick contract.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'stock-preparation-suggestion-operators.cjs')

const {
  SUGGESTED_DEMAND_DATE_FIELD_ID,
  SUGGESTION_APPLY_MODE,
  SUGGESTION_OPERATORS,
  SUGGESTION_ERROR_REASONS,
  CASCADE_SKIP_REASONS,
  CASCADE_LEAD_DAYS_FIELDS,
  PREFILL_MATCH_FIELDS,
  PREFILL_RECENCY_FIELDS,
  PREFILL_EXCLUSION_REASONS,
  MAX_LEAD_TIME_DAYS,
  StockPreparationSuggestionError,
  computeDemandDateCascade,
  crossProjectPrefillCandidates,
  __internals,
} = require(MODULE_PATH)

const { HUMAN_PRESERVED_FIELD_IDS } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

function assertThrowsReason(fn, reason, label) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a throw`)
  assert.ok(
    thrown instanceof StockPreparationSuggestionError,
    `${label}: expected StockPreparationSuggestionError, got ${thrown.name}`,
  )
  assert.equal(thrown.reason, reason, `${label}: expected reason ${reason}, got ${thrown.reason}`)
  return thrown
}

function moduleSurface() {
  // Closed vocabularies are frozen.
  for (const vocab of [
    SUGGESTION_OPERATORS,
    SUGGESTION_ERROR_REASONS,
    CASCADE_SKIP_REASONS,
    CASCADE_LEAD_DAYS_FIELDS,
    PREFILL_MATCH_FIELDS,
    PREFILL_RECENCY_FIELDS,
    PREFILL_EXCLUSION_REASONS,
  ]) {
    assert.ok(Object.isFrozen(vocab), 'vocabulary arrays are frozen')
  }
  assert.deepEqual([...SUGGESTION_OPERATORS], ['demand_date_cascade', 'cross_project_prefill'])
  assert.deepEqual([...CASCADE_SKIP_REASONS], ['root_row', 'lead_days_missing', 'lead_days_invalid'])
  assert.deepEqual([...PREFILL_EXCLUSION_REASONS], ['self_row', 'record_id_missing', 'no_prefillable_values'])
  assert.equal(SUGGESTION_APPLY_MODE, 'k2_confirm_required')

  // Ownership wall pin: the cascade target is a plm_system SUGGESTION column,
  // never one of the human_preserved fields.
  assert.equal(SUGGESTED_DEMAND_DATE_FIELD_ID, 'suggestedDemandDate')
  assert.ok(
    !HUMAN_PRESERVED_FIELD_IDS.includes(SUGGESTED_DEMAND_DATE_FIELD_ID),
    'suggestion target must not be a human_preserved field',
  )
  assert.ok(HUMAN_PRESERVED_FIELD_IDS.includes('demandDate'), 'fixture sanity: demandDate IS human_preserved')
  assert.ok(HUMAN_PRESERVED_FIELD_IDS.includes('leadTimeDays'), 'fixture sanity: leadTimeDays IS human_preserved')
  assert.doesNotThrow(() => __internals.assertSuggestionTargetIsSystemOwned())

  // No live Set / *_SET mirror leaks on the export surface (codec-surface
  // poisoning class from the row-digest round-4 review).
  const mod = require(MODULE_PATH)
  for (const [key, value] of [...Object.entries(mod), ...Object.entries(mod.__internals)]) {
    assert.ok(!key.includes('_SET'), `${key}: no exported Set-mirror names`)
    assert.ok(!(value instanceof Set), `${key}: no live Set instance exported`)
  }

  // Require surface: node builtins + the templates contract only.
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  const requireCalls = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.ok(requireCalls.length >= 1, 'module requires the templates contract')
  for (const specifier of requireCalls) {
    assert.ok(
      specifier.startsWith('node:') || specifier === './stock-preparation-templates.cjs',
      `require("${specifier}") must be a node builtin or the templates contract`,
    )
  }
  // The documented limitation must stay documented in the source.
  assert.ok(/NO holiday or workday[\s/]+calendar/i.test(source), 'no-holiday-calendar limitation stays documented')
}

function cascadeArithmetic() {
  const rows = [
    { recordId: 'r-root', isRoot: true, leadTimeDays: 3 },
    { recordId: 'r-lead-5', isRoot: false, leadTimeDays: 5 },
    { recordId: 'r-lead-0', isRoot: false, leadTimeDays: 0 },
    { recordId: 'r-missing', isRoot: false },
    { recordId: 'r-null', isRoot: false, leadTimeDays: null },
    { recordId: 'r-string', isRoot: false, leadTimeDays: '5' },
    { recordId: 'r-negative', isRoot: false, leadTimeDays: -1 },
    { recordId: 'r-fraction', isRoot: false, leadTimeDays: 1.5 },
    { recordId: 'r-over-bound', isRoot: false, leadTimeDays: MAX_LEAD_TIME_DAYS + 1 },
  ]
  const options = {
    rootPredicate: (row) => row.isRoot === true,
    leadDaysField: 'leadTimeDays',
    rootDemandDate: '2026-08-10',
  }
  const result = computeDemandDateCascade(rows, options)

  assert.equal(result.operator, 'demand_date_cascade')
  assert.equal(result.applyMode, 'k2_confirm_required', 'cascade output requires K2 confirm')
  assert.equal(result.suggestionFieldId, 'suggestedDemandDate', 'targets the plm_system suggestion column')
  assert.equal(result.rootDemandDate, '2026-08-10')

  // Arithmetic: rootDemandDate minus leadTimeDays, plain calendar days.
  assert.deepEqual(
    result.suggestions.map((entry) => ({ ...entry })),
    [
      { recordId: 'r-lead-5', suggestedDemandDate: '2026-08-05' },
      { recordId: 'r-lead-0', suggestedDemandDate: '2026-08-10' },
    ],
    'lead 5 lands 5 calendar days earlier; lead 0 lands on the root date',
  )
  assert.equal(result.suggestionCount, 2)

  // Suggestion entries are a suggestion-column payload: recordId + suggested
  // value ONLY — no demandDate key, nothing that reads as a human-field write.
  for (const entry of result.suggestions) {
    assert.deepEqual(Object.keys(entry).sort(), ['recordId', 'suggestedDemandDate'])
    assert.ok(!('demandDate' in entry), 'never a direct demandDate write')
    assert.ok(Object.isFrozen(entry))
  }

  // Skips: root row itself + every untrustworthy lead value, each with its
  // closed reason; skipped rows get NO suggestion (fail closed per row).
  assert.deepEqual(
    result.skipped.map((entry) => ({ ...entry })),
    [
      { recordId: 'r-root', reason: 'root_row' },
      { recordId: 'r-missing', reason: 'lead_days_missing' },
      { recordId: 'r-null', reason: 'lead_days_missing' },
      { recordId: 'r-string', reason: 'lead_days_invalid' },
      { recordId: 'r-negative', reason: 'lead_days_invalid' },
      { recordId: 'r-fraction', reason: 'lead_days_invalid' },
      { recordId: 'r-over-bound', reason: 'lead_days_invalid' },
    ],
  )
  assert.equal(result.skippedCount, 7)
  for (const entry of result.skipped) {
    assert.ok(CASCADE_SKIP_REASONS.includes(entry.reason), 'skip reasons stay in the closed vocabulary')
  }

  // Bound edge: lead == MAX_LEAD_TIME_DAYS is still a suggestion.
  const atBound = computeDemandDateCascade(
    [{ recordId: 'r-at-bound', leadTimeDays: MAX_LEAD_TIME_DAYS }],
    { rootPredicate: () => false, rootDemandDate: '2026-08-10' },
  )
  assert.equal(atBound.suggestionCount, 1, 'lead == bound is accepted')

  // Determinism: identical input twice -> deep-equal output.
  assert.deepEqual(JSON.parse(JSON.stringify(computeDemandDateCascade(rows, options))), JSON.parse(JSON.stringify(result)))

  // Result containers frozen; input untouched.
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.suggestions))
  assert.ok(Object.isFrozen(result.skipped))
  assert.equal(rows.length, 9)
  assert.equal(rows[0].recordId, 'r-root', 'caller rows untouched')
}

function cascadeCalendarBoundaries() {
  const run = (rootDemandDate, leadTimeDays) =>
    computeDemandDateCascade(
      [{ recordId: 'r-1', leadTimeDays }],
      { rootPredicate: () => false, rootDemandDate },
    ).suggestions[0].suggestedDemandDate

  assert.equal(run('2026-03-01', 1), '2026-02-28', 'non-leap February boundary')
  assert.equal(run('2028-03-01', 1), '2028-02-29', 'leap-year February boundary')
  assert.equal(run('2026-01-01', 1), '2025-12-31', 'year boundary')
  assert.equal(run('2026-08-10', 40), '2026-07-01', 'multi-month subtraction')

  // DOCUMENTED LIMITATION pinned behaviorally: plain calendar-day subtraction
  // can land on a weekend — 2026-07-20 is a Monday, minus 2 days = Saturday.
  // A workday/holiday-aware operator would never emit a Saturday here.
  const weekend = run('2026-07-20', 2)
  assert.equal(weekend, '2026-07-18')
  assert.equal(new Date(`${weekend}T00:00:00Z`).getUTCDay(), 6, 'suggestion lands on a Saturday (no holiday calendar)')
}

function cascadeFailClosed() {
  const goodOptions = { rootPredicate: () => false, rootDemandDate: '2026-08-10' }

  assertThrowsReason(() => computeDemandDateCascade('t', goodOptions), 'INPUT_SHAPE_INVALID', 'rows not an array')
  assertThrowsReason(() => computeDemandDateCascade([], null), 'INPUT_SHAPE_INVALID', 'options missing')
  assertThrowsReason(
    () => computeDemandDateCascade([], { rootDemandDate: '2026-08-10' }),
    'INPUT_SHAPE_INVALID',
    'rootPredicate missing',
  )
  assertThrowsReason(
    () => computeDemandDateCascade([], { rootPredicate: () => false, rootDemandDate: '2026-08-10', leadDaysField: 'notes' }),
    'LEAD_DAYS_FIELD_NOT_ALLOWED',
    'leadDaysField outside the closed vocabulary',
  )

  // Strict root date: nonexistent dates, non-canonical shapes, datetimes, and
  // out-of-domain years all fail closed.
  for (const bad of ['2026-02-30', '2026-8-1', '2026-08-01T00:00:00Z', '20260801', '', '1969-12-31', undefined, 20260801]) {
    const thrown = assertThrowsReason(
      () => computeDemandDateCascade([], { ...goodOptions, rootDemandDate: bad }),
      'ROOT_DEMAND_DATE_INVALID',
      `root date reject ${JSON.stringify(bad ?? 'undefined')}`,
    )
    // Values-free error surface: the raw input never round-trips into details.
    assert.equal(thrown.details.field, 'options.rootDemandDate')
    assert.ok(!JSON.stringify(thrown.details).includes('2026-02-30'), 'details carry field names, not raw values')
  }

  assertThrowsReason(
    () => computeDemandDateCascade([{ leadTimeDays: 1 }], goodOptions),
    'RECORD_ID_INVALID',
    'row without recordId',
  )
  assertThrowsReason(
    () => computeDemandDateCascade([{ recordId: '  ', leadTimeDays: 1 }], goodOptions),
    'RECORD_ID_INVALID',
    'blank recordId',
  )
  assertThrowsReason(
    () =>
      computeDemandDateCascade(
        [
          { recordId: 'r-1', leadTimeDays: 1 },
          { recordId: 'r-1', leadTimeDays: 2 },
        ],
        goodOptions,
      ),
    'RECORD_ID_DUPLICATE',
    'duplicate recordId',
  )
  assertThrowsReason(() => computeDemandDateCascade([null], goodOptions), 'INPUT_SHAPE_INVALID', 'null row')
}

function prefillRanking() {
  const target = { recordId: 't-1', componentCode: 'part-a' }
  const history = [
    { recordId: 'h-old', componentCode: 'part-a', lastPlmRefreshAt: '2026-05-01', materialType: 'mt-1', notes: 'n-old' },
    { recordId: 'h-new', componentCode: 'part-a', lastPlmRefreshAt: '2026-06-01', notes: 'n-new' },
    { recordId: 'h-other-part', componentCode: 'part-b', lastPlmRefreshAt: '2026-07-01', notes: 'n-other' },
    { recordId: 'h-undated', componentCode: 'part-a', notes: 'n-undated' },
  ]
  const result = crossProjectPrefillCandidates(target, history, {
    matchField: 'componentCode',
    humanFields: ['materialType', 'notes'],
  })

  assert.equal(result.operator, 'cross_project_prefill')
  assert.equal(result.applyMode, 'k2_confirm_required', 'candidates require K2 confirm, never auto-apply')
  assert.equal(result.matchField, 'componentCode')
  assert.equal(result.recencyField, 'lastPlmRefreshAt', 'default recency field')

  // Multi-candidate: a RANKED LIST of all matches, not a single pick.
  assert.equal(result.candidateCount, 3, 'all matched rows come back as ranked candidates')
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.sourceRecordId),
    ['h-new', 'h-old', 'h-undated'],
    'latest first; missing recency ranked last',
  )
  assert.deepEqual(result.candidates.map((candidate) => candidate.rank), [0, 1, 2], 'explicit ranks')

  // Candidate field sets carry only PRESENT human-field values.
  assert.deepEqual({ ...result.candidates[0].fieldValues }, { notes: 'n-new' })
  assert.deepEqual([...result.candidates[0].presentFieldIds], ['notes'])
  assert.deepEqual({ ...result.candidates[1].fieldValues }, { materialType: 'mt-1', notes: 'n-old' })
  assert.equal(result.candidates[2].sourceRecency, null, 'unparseable/missing recency reported as null')
  assert.equal(result.candidates[0].sourceRecency, '2026-06-01')

  // Unmatched part never leaks in.
  assert.ok(!result.candidates.some((candidate) => candidate.sourceRecordId === 'h-other-part'))

  // Frozen result; caller arrays untouched (sort must not mutate input).
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.candidates))
  assert.ok(Object.isFrozen(result.candidates[0].fieldValues))
  assert.deepEqual(
    history.map((row) => row.recordId),
    ['h-old', 'h-new', 'h-other-part', 'h-undated'],
    'history order untouched',
  )

  // Datetime recency (explicit zone) outranks same-day date-only midnight.
  const timed = crossProjectPrefillCandidates(target, [
    { recordId: 'h-midnight', componentCode: 'part-a', lastPlmRefreshAt: '2026-06-01', notes: 'n-a' },
    { recordId: 'h-later-same-day', componentCode: 'part-a', lastPlmRefreshAt: '2026-06-01T05:00:00Z', notes: 'n-b' },
  ], { humanFields: ['notes'] })
  assert.deepEqual(
    timed.candidates.map((candidate) => candidate.sourceRecordId),
    ['h-later-same-day', 'h-midnight'],
  )

  // Recency tie -> deterministic recordId-ascending tiebreak.
  const tied = crossProjectPrefillCandidates(target, [
    { recordId: 'h-b', componentCode: 'part-a', lastPlmRefreshAt: '2026-06-01', notes: 'n-b' },
    { recordId: 'h-a', componentCode: 'part-a', lastPlmRefreshAt: '2026-06-01', notes: 'n-a' },
  ], { humanFields: ['notes'] })
  assert.deepEqual(
    tied.candidates.map((candidate) => candidate.sourceRecordId),
    ['h-a', 'h-b'],
    'ties break by recordId ascending',
  )

  // Single candidate is STILL a ranked list of one — not a pre-applied pick.
  const single = crossProjectPrefillCandidates(target, [history[1]], { humanFields: ['notes'] })
  assert.equal(single.candidateCount, 1)
  assert.equal(single.candidates[0].rank, 0)
  assert.equal(single.applyMode, 'k2_confirm_required')
}

function prefillFieldPresenceRanking() {
  // The gallery pack's "最全方案复用" (most-complete plan reuse) use-case: rankBy
  // 'field_presence' must rank the FULLER prior row first even when it is OLDER,
  // while 'recency' (default) still ranks by date. Both are deterministic.
  const target = { recordId: 't-1', componentCode: 'part-a' }
  const history = [
    // fuller (2 human fields) but OLDER
    { recordId: 'h-full-old', componentCode: 'part-a', lastPlmRefreshAt: '2026-05-01', materialType: 'mt', notes: 'n' },
    // sparser (1 human field) but NEWER
    { recordId: 'h-thin-new', componentCode: 'part-a', lastPlmRefreshAt: '2026-06-01', notes: 'n2' },
  ]
  const humanFields = ['materialType', 'notes']

  const byRecency = crossProjectPrefillCandidates(target, history, { humanFields })
  assert.equal(byRecency.rankBy, 'recency', 'default rank mode reported')
  assert.deepEqual(
    byRecency.candidates.map((c) => c.sourceRecordId),
    ['h-thin-new', 'h-full-old'],
    'recency: newest first even if sparser',
  )

  const byPresence = crossProjectPrefillCandidates(target, history, { humanFields, rankBy: 'field_presence' })
  assert.equal(byPresence.rankBy, 'field_presence')
  assert.deepEqual(
    byPresence.candidates.map((c) => c.sourceRecordId),
    ['h-full-old', 'h-thin-new'],
    'field_presence: fullest first even if older (most-complete plan reuse)',
  )
  assert.equal(byPresence.candidates[0].presentFieldIds.length, 2)

  // Equal presence falls through to recency (still a strict total order).
  const equalPresence = crossProjectPrefillCandidates(target, [
    { recordId: 'h-a', componentCode: 'part-a', lastPlmRefreshAt: '2026-05-01', notes: 'a' },
    { recordId: 'h-b', componentCode: 'part-a', lastPlmRefreshAt: '2026-06-01', notes: 'b' },
  ], { humanFields: ['notes'], rankBy: 'field_presence' })
  assert.deepEqual(equalPresence.candidates.map((c) => c.sourceRecordId), ['h-b', 'h-a'], 'presence tie → recency')

  // Closed vocabulary: an unknown rankBy fails closed.
  assert.throws(
    () => crossProjectPrefillCandidates(target, history, { humanFields, rankBy: 'nonsense' }),
    /RANK_MODE_NOT_ALLOWED|rankBy/,
    'unknown rankBy rejected',
  )
}

function prefillEmptyAndExclusions() {
  const target = { recordId: 't-1', componentCode: 'part-a' }
  const opts = { humanFields: ['notes'] }

  // Zero history -> zero candidates. Nothing is fabricated.
  const empty = crossProjectPrefillCandidates(target, [], opts)
  assert.equal(empty.candidateCount, 0)
  assert.deepEqual([...empty.candidates], [])

  // No same-part row -> zero candidates.
  const unmatched = crossProjectPrefillCandidates(
    target,
    [{ recordId: 'h-1', componentCode: 'part-z', notes: 'n-1' }],
    opts,
  )
  assert.equal(unmatched.candidateCount, 0)

  // Target without a match value -> zero candidates (no wildcard matching).
  for (const bareTarget of [{ recordId: 't-1' }, { recordId: 't-1', componentCode: '  ' }, { recordId: 't-1', componentCode: 7 }]) {
    assert.equal(crossProjectPrefillCandidates(bareTarget, [{ recordId: 'h-1', componentCode: 'part-a', notes: 'n-1' }], opts).candidateCount, 0)
  }

  // Match is EXACT on the trimmed code: no case folding.
  const cased = crossProjectPrefillCandidates(
    target,
    [{ recordId: 'h-1', componentCode: 'PART-A', notes: 'n-1' }],
    opts,
  )
  assert.equal(cased.candidateCount, 0, 'no case folding on identity-ish codes')

  // Exclusions, each counted under its closed reason:
  const excluded = crossProjectPrefillCandidates(target, [
    { recordId: 't-1', componentCode: 'part-a', notes: 'n-self' }, // the target itself
    { componentCode: 'part-a', notes: 'n-no-id' }, // no provenance
    { recordId: 'h-empty', componentCode: 'part-a', notes: '   ' }, // nothing to prefill
    { recordId: 'h-structured', componentCode: 'part-a', notes: { nested: 'n-x' } }, // non-scalar never offered
    { recordId: 'h-good', componentCode: 'part-a', notes: 'n-good' },
  ], opts)
  assert.equal(excluded.candidateCount, 1)
  assert.equal(excluded.candidates[0].sourceRecordId, 'h-good')
  assert.deepEqual({ ...excluded.excludedCounts }, { self_row: 1, record_id_missing: 1, no_prefillable_values: 2 })

  // Ownership wall + closed vocab fail-closed:
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, [], { humanFields: ['projectNo'] }),
    'HUMAN_FIELD_NOT_ALLOWED',
    'plm_system field requested for prefill',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, [], { humanFields: [SUGGESTED_DEMAND_DATE_FIELD_ID] }),
    'HUMAN_FIELD_NOT_ALLOWED',
    'suggestion column itself is not prefillable',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, [], { humanFields: ['notes', 'notes'] }),
    'INPUT_SHAPE_INVALID',
    'duplicate humanFields entry',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, [], { humanFields: [] }),
    'INPUT_SHAPE_INVALID',
    'empty humanFields',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, [], { humanFields: ['notes'], matchField: 'idempotencyKey' }),
    'MATCH_FIELD_NOT_ALLOWED',
    'matchField outside the closed vocabulary',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, [], { humanFields: ['notes'], recencyField: 'notes' }),
    'RECENCY_FIELD_NOT_ALLOWED',
    'recencyField outside the closed vocabulary',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(null, [], opts),
    'INPUT_SHAPE_INVALID',
    'targetRow not an object',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, 't', opts),
    'INPUT_SHAPE_INVALID',
    'historyRows not an array',
  )
  assertThrowsReason(
    () => crossProjectPrefillCandidates(target, [null], opts),
    'INPUT_SHAPE_INVALID',
    'null history row',
  )
  assertThrowsReason(
    () =>
      crossProjectPrefillCandidates(target, [
        { recordId: 'h-1', componentCode: 'part-a', notes: 'n-1' },
        { recordId: 'h-1', componentCode: 'part-a', notes: 'n-2' },
      ], opts),
    'RECORD_ID_DUPLICATE',
    'duplicate matched history recordId',
  )

  // plmDrawingNo is the other chartered match field (cross-project mapping key).
  const byDrawing = crossProjectPrefillCandidates(
    { recordId: 't-1', plmDrawingNo: 'dwg-1' },
    [{ recordId: 'h-1', plmDrawingNo: 'dwg-1', notes: 'n-1' }],
    { matchField: 'plmDrawingNo', humanFields: ['notes'] },
  )
  assert.equal(byDrawing.candidateCount, 1)
}

function internalsDateCodec() {
  const { parseIsoDateUtcMs, formatIsoDateUtc, parseRecencyMs, DAY_MS } = __internals

  assert.equal(parseIsoDateUtcMs('2026-08-10'), Date.UTC(2026, 7, 10))
  assert.equal(formatIsoDateUtc(Date.UTC(2026, 7, 10)), '2026-08-10')
  assert.equal(formatIsoDateUtc(Date.UTC(2026, 7, 10) - 5 * DAY_MS), '2026-08-05')
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-08-00', 'not-a-date', '1969-12-31', 7, null]) {
    assert.equal(parseIsoDateUtcMs(bad), null, `parse rejects ${JSON.stringify(bad)}`)
  }

  // Recency: strict date, or datetime WITH an explicit zone. A naive local
  // datetime is refused (would break cross-timezone determinism).
  assert.equal(parseRecencyMs('2026-06-01'), Date.UTC(2026, 5, 1))
  assert.equal(parseRecencyMs('2026-06-01T05:00:00Z'), Date.UTC(2026, 5, 1, 5))
  assert.equal(parseRecencyMs('2026-06-01T05:00:00.123Z'), Date.UTC(2026, 5, 1, 5, 0, 0, 123))
  assert.equal(parseRecencyMs('2026-06-01T08:00:00+08:00'), Date.UTC(2026, 5, 1))
  assert.equal(parseRecencyMs('2026-06-01T05:00:00'), null, 'naive datetime refused')
  assert.equal(parseRecencyMs('2026-06-01 05:00:00Z'), null, 'space separator refused')
  assert.equal(parseRecencyMs(1717200000000), null, 'epoch number refused')
  assert.equal(parseRecencyMs('garbage'), null)
}

function main() {
  moduleSurface()
  cascadeArithmetic()
  cascadeCalendarBoundaries()
  cascadeFailClosed()
  prefillRanking()
  prefillFieldPresenceRanking()
  prefillEmptyAndExclusions()
  internalsDateCodec()
}

main()
console.log('stock-preparation-suggestion-operators.test.cjs OK')
