'use strict'

/**
 * 备料 BATCH IDENTITY — RED witnesses for "物料创建日期(精确到小时)区分同一项目不同批次的物料".
 *
 * The owner states the rule; shipped code did not implement it. Repeated pulls of one project were
 * separated by a content-revision digest at the mint site plus a persist-time monotonic
 * `snapshotVersion`, and the hour rule lived only in the rehearsal driver as a caller-side
 * derivation the shipped mapper never saw.
 *
 * Every assertion below fails against the pre-change tree, either because the module does not exist
 * or because the hour rule was not the thing computed. The three the change was commissioned on:
 *
 *   (iii-a) two pulls in the SAME hour  -> the SAME batch id,
 *   (iii-b) two pulls in DIFFERENT hours -> DIFFERENT batch ids,
 *   (iii-c) a missing Createtime         -> a DECLARED degradation, never a crash and never a
 *                                           silently wrong bucket.
 *
 * Plus the guards that make the rule safe to turn on: the legacy default is byte-identical to
 * today, an unknown declared mode refuses rather than falling back, and a project number carrying
 * the scheme's own `|` separator degrades instead of minting an id that collides under the derived
 * child-id hashes.
 */

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const {
  BATCH_IDENTITY_MODES,
  DEGRADATION_REASONS,
  StockPreparationBatchIdentityError,
  hourBucket,
  mintStockPreparationBatchIdentity,
  readStockPreparationBatchIdentityMode,
} = require(path.join(LIB, 'stock-preparation-batch-identity.cjs'))

const PROJECT = 'SYN-XM-0001'
const LEGACY = 'snapshot_0123456789abcdef0123456789abcdef'

function rows(...createTimes) {
  return createTimes.map((createTime, index) => ({
    componentSourceId: `P${index}`,
    componentCode: `DRW-${index}`,
    ...(createTime === undefined ? {} : { createTime }),
  }))
}

function mintHour(rowsIn, projectNo = PROJECT) {
  return mintStockPreparationBatchIdentity({
    mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
    projectNo,
    rows: rowsIn,
    legacyBatchId: LEGACY,
  })
}

// ── RED (iii-a): two pulls in the SAME hour are ONE batch ─────────────────────────────────────
function samePullHourIsOneBatch() {
  const first = mintHour(rows('2026-08-30T09:04:11', '2026-08-30T09:51:02'))
  // A second pull of the same project: the ROWS are re-read (different order, one row's minute
  // moved) but every material was still created in hour 09.
  const second = mintHour(rows('2026-08-30T09:59:59', '2026-08-30T09:00:00'))

  assert.equal(first.batchId, `${PROJECT}|2026-08-30T09`, 'batch id is <project>|<YYYY-MM-DDTHH>')
  assert.equal(second.batchId, first.batchId, 'two pulls in the same creation hour are the SAME batch')
  assert.equal(first.mode, BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR)
  assert.equal(first.degraded, false)
  assert.equal(first.reason, DEGRADATION_REASONS.NONE)

  // Order-independence is what makes the id an identity rather than a checksum of the read order.
  const reversed = mintHour(rows('2026-08-30T09:51:02', '2026-08-30T09:04:11'))
  assert.equal(reversed.batchId, first.batchId, 'row order must not move the batch identity')

  console.log('  ✓ (iii-a) two pulls in the same creation hour mint one batch id, order-independently')
}

// ── RED (iii-b): two pulls in DIFFERENT hours are TWO batches ─────────────────────────────────
function differentPullHoursAreTwoBatches() {
  const batch1 = mintHour(rows('2026-08-30T09:04:11', '2026-08-30T09:51:02'))
  // Batch #2: the project gained a material created in hour 10. "As-of the NEWEST material hour".
  const batch2 = mintHour(rows('2026-08-30T09:04:11', '2026-08-30T10:02:00'))

  assert.equal(batch1.batchId, `${PROJECT}|2026-08-30T09`)
  assert.equal(batch2.batchId, `${PROJECT}|2026-08-30T10`)
  assert.notEqual(batch1.batchId, batch2.batchId, 'different creation hours are DIFFERENT batches')

  // The hour bucket is lexically ordered because it is fixed-width and zero-padded — no Date
  // parsing, no timezone, no clock. A day/month/year rollover must still order correctly.
  assert.equal(mintHour(rows('2026-08-30T23:00:00', '2026-08-31T00:00:00')).batchId, `${PROJECT}|2026-08-31T00`)
  assert.equal(mintHour(rows('2026-09-01T00:00:00', '2026-08-31T23:00:00')).batchId, `${PROJECT}|2026-09-01T00`)

  // Different PROJECTS never share a batch even inside the same hour.
  assert.notEqual(mintHour(rows('2026-08-30T09:00:00'), 'SYN-XM-0002').batchId, batch1.batchId)

  console.log('  ✓ (iii-b) different creation hours mint different batch ids; newest hour wins; rollovers order')
}

// ── RED (iii-c): missing Createtime DEGRADES, declared, never a wrong bucket ──────────────────
function missingCreateTimeDegradesLoudly() {
  // The deployment declared no readPlan.part.createTimeField, so no row carries one.
  const none = mintHour(rows(undefined, undefined))
  assert.equal(none.batchId, LEGACY, 'degradation falls back to the legacy content-revision id')
  assert.equal(none.mode, BATCH_IDENTITY_MODES.SOURCE_REVISION, 'the EFFECTIVE mode is the legacy one')
  assert.equal(none.requestedMode, BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR, 'what was asked for is still reported')
  assert.equal(none.degraded, true, 'degradation is DECLARED, not silent')
  assert.equal(none.reason, DEGRADATION_REASONS.SOURCE_CREATE_TIME_ABSENT)
  assert.equal(none.evidence.rowsWithCreateTimeHour, 0)
  assert.equal(none.evidence.valuesFree, true, 'evidence carries counts and a coded reason, never values')

  // An empty pull is the same story, and must not throw.
  assert.equal(mintHour([]).reason, DEGRADATION_REASONS.SOURCE_CREATE_TIME_ABSENT)
  assert.equal(mintHour(undefined).batchId, LEGACY)

  // A column that exists but is NOT a timestamp must degrade, NEVER be sliced into a plausible
  // wrong bucket. This is the difference between the rehearsal driver's bare slice(0,13) and a
  // shipped rule: 'not-a-date-at' is 13 characters long and would have passed a length-only check.
  for (const junk of ['not-a-date-at', 'N/A', '0000', '2026/08/30 09:00', ' ']) {
    const degraded = mintHour(rows(junk))
    assert.equal(degraded.degraded, true, `unparseable createTime must degrade: ${JSON.stringify(junk)}`)
    assert.equal(degraded.reason, DEGRADATION_REASONS.SOURCE_CREATE_TIME_ABSENT)
    assert.equal(degraded.batchId, LEGACY)
  }

  // A PARTIAL read still buckets: one usable createTime among many is enough, and only the usable
  // ones are counted. Degrading a whole pull because one legacy row lacks a timestamp would be
  // worse than the rule it replaces.
  const partial = mintHour(rows(undefined, '2026-08-30T11:30:00', 'N/A'))
  assert.equal(partial.degraded, false)
  assert.equal(partial.batchId, `${PROJECT}|2026-08-30T11`)
  assert.equal(partial.evidence.rows, 3)
  assert.equal(partial.evidence.rowsWithCreateTimeHour, 1)

  console.log('  ✓ (iii-c) absent / unparseable createTime degrades with a coded reason — no crash, no wrong bucket')
}

// ── the shapes the rule accepts, and the one it refuses ───────────────────────────────────────
function hourBucketShapes() {
  assert.equal(hourBucket('2026-08-30T09:15:00'), '2026-08-30T09', 'ISO with T')
  // SQL Server varchar timestamps commonly use a space separator on this vendor family. Reading
  // that as a DIFFERENT bucket than the ISO form would split one hour into two batches.
  assert.equal(hourBucket('2026-08-30 09:15:00'), '2026-08-30T09', 'space separator is the same hour')
  assert.equal(hourBucket('2026-08-30T09:15:00.123Z'), '2026-08-30T09', 'sub-second/zone suffix is ignored')
  assert.equal(hourBucket('2026-08-30T09'), '2026-08-30T09', 'already a bucket')
  for (const bad of [null, undefined, '', '   ', '2026-08-30', 'yesterday', 42, {}, []]) {
    assert.equal(hourBucket(bad), null, `not a timestamp: ${JSON.stringify(bad)}`)
  }
  console.log('  ✓ hourBucket accepts the ISO and space-separated forms, refuses everything else')
}

// ── the legacy default is UNCHANGED, and a typo is refused rather than defaulted ──────────────
function legacyDefaultAndDeclaration() {
  // No declaration => today's behaviour, byte for byte. This is what keeps every running install
  // on the content-revision id when this change lands.
  assert.equal(readStockPreparationBatchIdentityMode(undefined), BATCH_IDENTITY_MODES.SOURCE_REVISION)
  assert.equal(readStockPreparationBatchIdentityMode({}), BATCH_IDENTITY_MODES.SOURCE_REVISION)
  assert.equal(readStockPreparationBatchIdentityMode({ batchIdentity: {} }), BATCH_IDENTITY_MODES.SOURCE_REVISION)
  assert.equal(
    readStockPreparationBatchIdentityMode({ batchIdentity: { mode: 'material_create_hour' } }),
    BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
  )

  const legacy = mintStockPreparationBatchIdentity({ projectNo: PROJECT, rows: rows('2026-08-30T09:00:00'), legacyBatchId: LEGACY })
  assert.equal(legacy.batchId, LEGACY, 'the default mint is the caller-supplied revision id, even when hours ARE available')
  assert.equal(legacy.degraded, false, 'the legacy default is not a degradation — it is the declared default')
  assert.equal(legacy.reason, DEGRADATION_REASONS.NONE)

  // A typo must never silently mean "legacy" — a deployment that believes it turned the rule on
  // and did not would batch its materials by the wrong rule with nothing to show for it.
  assert.throws(
    () => readStockPreparationBatchIdentityMode({ batchIdentity: { mode: 'material_create_day' } }),
    (error) => error instanceof StockPreparationBatchIdentityError &&
      error.details.field === 'readPlan.batchIdentity.mode',
  )
  assert.throws(
    () => mintStockPreparationBatchIdentity({ mode: 'hourly', projectNo: PROJECT, rows: [], legacyBatchId: LEGACY }),
    StockPreparationBatchIdentityError,
  )
  // The fallback is what makes degradation safe, so it is never optional.
  assert.throws(
    () => mintStockPreparationBatchIdentity({ mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR, projectNo: PROJECT, rows: [] }),
    (error) => error instanceof StockPreparationBatchIdentityError && error.details.field === 'opts.legacyBatchId',
  )

  console.log('  ✓ absent declaration keeps today\'s id; an unknown mode refuses instead of defaulting')
}

// ── the derived-child-id separator stays injective ────────────────────────────────────────────
function separatorSafety() {
  // Every derived child id hashes `${snapshotBatchId}|${seed}` (snapshotLineId, stockPrepLineId,
  // exceptionId, runId). One `|` contributed by the hour scheme is safe because the hour bucket is
  // fixed-shape; a `|` inside the PROJECT would not be. Degrade rather than mint a colliding id.
  const unsafe = mintHour(rows('2026-08-30T09:00:00'), 'SYN|XM|0001')
  assert.equal(unsafe.batchId, LEGACY)
  assert.equal(unsafe.degraded, true)
  assert.equal(unsafe.reason, DEGRADATION_REASONS.PROJECT_NO_NOT_SEPARATOR_SAFE)

  const noProject = mintStockPreparationBatchIdentity({
    mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
    rows: rows('2026-08-30T09:00:00'),
    legacyBatchId: LEGACY,
  })
  assert.equal(noProject.reason, DEGRADATION_REASONS.PROJECT_NO_ABSENT)
  assert.equal(noProject.batchId, LEGACY)

  console.log('  ✓ a project number carrying the scheme\'s own separator degrades rather than colliding')
}

// ── purity: no clock, no I/O, no input mutation ───────────────────────────────────────────────
function purity() {
  const input = rows('2026-08-30T09:00:00', '2026-08-30T10:00:00')
  const before = JSON.stringify(input)
  const a = mintHour(input)
  const b = mintHour(input)
  assert.equal(JSON.stringify(input), before, 'the input rows are never mutated')
  assert.deepEqual(a, b, 'the same input yields a byte-identical verdict — no clock, no randomness')
  // An expansion RESULT object is accepted as readily as a bare array.
  assert.equal(mintHour({ rows: input }).batchId, a.batchId)
  console.log('  ✓ pure: no mutation, no clock, accepts rows or an expansion result')
}

function main() {
  samePullHourIsOneBatch()
  differentPullHoursAreTwoBatches()
  missingCreateTimeDegradesLoudly()
  hourBucketShapes()
  legacyDefaultAndDeclaration()
  separatorSafety()
  purity()
  console.log('✓ stock-preparation-batch-identity: the hour rule, its declared opt-in, and its declared degradation')
}

main()
