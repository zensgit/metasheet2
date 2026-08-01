#!/usr/bin/env node
// #4556 W4C-0 Stage D — §8.4 "source, effect, and result mechanical bypass guard" collector gate.
//
// Explicit whole-file CI step (see .github/workflows/plugin-tests.yml): this is a node:test
// (.test.mjs) file, not a vitest spec, so it is invisible to both `pnpm --filter core-backend
// test` and vitest.config.ts's exclude list — it must be named explicitly in CI or it silently
// never runs (feedback_plugin_integration_core_tests_not_in_ci).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const toolDir = path.join(rootDir, 'scripts/attendance/w4c0-dml-inventory')

const { createWorktreeSource, createGitRefSource } = require(path.join(toolDir, 'sources.cjs'))
const {
  buildRawCensus,
  buildP25CallPathCensus,
  buildAttendanceRecordReadCensus,
  classifyCensus,
  scanFileForDmlSites,
  scanFileForP25CallPathSites,
  scanFileForAttendanceRecordReadSites,
  isCanonicalBoundaryPath,
  contentHashOfKeys,
} = require(
  path.join(toolDir, 'collector.cjs'),
)
const { classifyTrackedSites } = require(path.join(toolDir, 'classify-tracked-sites.cjs'))
const { CURATED_DEBT_ENTRIES } = require(path.join(toolDir, 'curated-debt-entries.cjs'))
const {
  P25_CALL_PATH_CLASSIFICATIONS,
  classifyP25CallPathSites,
} = require(path.join(toolDir, 'p25-call-path-classification.cjs'))
const {
  classifyAttendanceRecordReadSites,
} = require(path.join(toolDir, 'current-record-read-classification.cjs'))
const {
  TABLE_BUCKETS,
  P25_FORBIDDEN_AUTHORITY_ROLES,
  P25_IMPORT_INTEGRATION_TABLES,
  P25_OPERATIONAL_TABLE_SPECS,
  classifyP25Use,
  assertP25Use,
} = require(path.join(toolDir, 'table-classification.cjs'))

const PINNED_REF = 'e0defbe26d7f2e1747e74aa908ca710422812bf7'
const BASELINE_ARTIFACT_RELPATH = 'docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json'
const WORKFLOW_PATH = path.join(rootDir, '.github/workflows/plugin-tests.yml')
const THIS_TEST_FILENAME = 'attendance-w4c0-dml-inventory-collector.test.mjs'

function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8')
}

// -------------------------------------------------------------------------------------------
// 1. Exact-head HEAD scan: every business/schedule_fact/shared_hook site must resolve to a
//    curated debt entry or the generic-shared allowlist; every attendance-owned table must be
//    classified; every w4_canonical-table site must be inside the canonical boundary. This is
//    the actual §8.4 CI gate against the real repository.
// -------------------------------------------------------------------------------------------
test('exact-head HEAD scan: zero new/unclassified/out-of-boundary attendance DML', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)

  assert.deepEqual(
    unclaimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol} :: ${s.table}:${s.verb}`),
    [],
    'every business/schedule_fact/shared_hook DML site must resolve to a curated debt entry or the generic-shared allowlist',
  )
  assert.deepEqual(
    classified.unclassifiedTableSites.map((s) => `${s.relPath} :: ${s.table}`),
    [],
    'every attendance-owned table hit must be classified in table-classification.cjs',
  )
  assert.deepEqual(
    classified.outsideBoundarySites.map((s) => `${s.relPath} :: ${s.table}`),
    [],
    'w4_canonical-bucket tables may only be written from the canonical adapter path prefix',
  )
})

test('W4C-3a: generated SELECT inventory classifies every attendance-record read', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildAttendanceRecordReadCensus(source)
  const result = classifyAttendanceRecordReadSites(sites)

  assert.ok(sites.some((site) => site.table === 'attendance_current_records'))
  assert.ok(sites.some((site) => site.table === 'attendance_records'))
  assert.deepEqual(
    result.unclassified.map((site) => `${site.relPath} :: ${site.enclosingSymbol}`),
    [],
    'a direct ordinary attendance_records read must be classified or moved to the current view',
  )
  assert.deepEqual(result.countDrift, [], 'an added base-table read in a known wrapper needs explicit review')
  assert.deepEqual(result.stale, [], 'removed base-table reads must retire their historical classification')
  assert.equal(result.classifiedSites.length, sites.length)
})

test('W4C-3a SELECT-inventory mutation: a new direct ordinary base read fails while the current view passes', () => {
  const relPath = 'plugins/plugin-attendance/index.cjs'
  const direct = scanFileForAttendanceRecordReadSites(
    relPath,
    "async function newOrdinarySummary() { return db.query(`SELECT * FROM\n attendance_records`) }\n",
  )
  const current = scanFileForAttendanceRecordReadSites(
    relPath,
    "async function newOrdinarySummary() { return db.query(`SELECT * FROM\n attendance_current_records`) }\n",
  )

  assert.equal(classifyAttendanceRecordReadSites(direct).unclassified.length, 1)
  const currentResult = classifyAttendanceRecordReadSites(current)
  assert.deepEqual(currentResult.unclassified, [])
  assert.equal(currentResult.classifiedSites[0]?.posture, 'current')
})

test('W4C-3a SELECT-inventory mutation: a dynamic base-table member fails while the current view passes', () => {
  const relPath = 'plugins/plugin-attendance/index.cjs'
  const scan = (table) => scanFileForAttendanceRecordReadSites(
    relPath,
    `async function dynamicSummary() { const tables = ['${table}']; for (const table of tables) await db.query(\`SELECT 1 FROM \${table}\`) }\n`,
  )

  assert.equal(classifyAttendanceRecordReadSites(scan('attendance_records')).unclassified.length, 1)
  const currentResult = classifyAttendanceRecordReadSites(scan('attendance_current_records'))
  assert.deepEqual(currentResult.unclassified, [])
  assert.equal(currentResult.classifiedSites[0]?.posture, 'current')
  assert.equal(currentResult.classifiedSites[0]?.dynamic, true)

  const bypassShapes = [
    "const TABLE = 'attendance_records'\nasync function moduleConstant() { return db.query(`SELECT 1 FROM ${TABLE}`) }\n",
    'const TABLE = `attendance_records`\nasync function backtickConstant() { return db.query(`SELECT 1 FROM ${TABLE}`) }\n',
    "const TABLE = 'attendance_records'\nasync function wrappedConstant() { return db.query(`SELECT 1 FROM ${quote(TABLE)}`) }\n",
  ]
  for (const source of bypassShapes) {
    const result = classifyAttendanceRecordReadSites(
      scanFileForAttendanceRecordReadSites(relPath, source),
    )
    assert.equal(result.unclassified.length, 1, source)
    assert.equal(result.unclassified[0]?.table, 'attendance_records')
    assert.equal(result.unclassified[0]?.dynamic, true)
  }
})

// -------------------------------------------------------------------------------------------
// 2. Reproducibility: regenerating the pinned baseline manifest from the pinned ref must byte-
//    match the committed docs/data-only artifact. This is what makes the artifact auditable —
//    a reviewer reruns generate-baseline-manifest.cjs and diffs, rather than trusting hand edits.
// -------------------------------------------------------------------------------------------
test('pinned baseline artifact is byte-reproducible from the pinned ref', () => {
  const gitSource = createGitRefSource(rootDir, PINNED_REF)
  const { roots, sites } = buildRawCensus(gitSource)
  const classified = classifyCensus(sites)
  const { claimsByEntryId, genericAllowlisted, unclaimed } = classifyTrackedSites(classified.trackedSites)

  assert.deepEqual(unclaimed, [], 'pinned baseline must have zero unclaimed sites (else the committed artifact could not have been generated cleanly)')

  const entries = CURATED_DEBT_ENTRIES.map((entry) => {
    const claimed = claimsByEntryId.get(entry.id) || []
    const keys = claimed.map((s) => s.key).sort()
    return {
      id: entry.id,
      title: entry.title,
      owningSlice: entry.owningSlice,
      sharedHook: entry.sharedHook,
      confidence: entry.confidence || 'direct',
      siteCount: claimed.length,
      tables: [...new Set(claimed.map((s) => `${s.table}:${s.verb}`))].sort(),
      symbols: [...new Set(claimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol}`))].sort(),
      contentHash: contentHashOfKeys(keys),
    }
  })
  const regenerated = {
    schemaVersion: 1,
    generatedFromRef: PINNED_REF,
    lockAnchor: 'docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md#8.4',
    runtimeRoots: roots,
    debtEntries: entries,
    genericSharedAllowlist: genericAllowlisted.map((s) => `${s.relPath} :: ${s.enclosingSymbol}`).sort(),
    manifestContentHash: contentHashOfKeys(classified.trackedSites.map((s) => s.key)),
  }

  const committedText = fs.readFileSync(path.join(rootDir, BASELINE_ARTIFACT_RELPATH), 'utf8')
  const committed = JSON.parse(committedText)
  assert.deepEqual(regenerated, committed, 'committed baseline artifact must byte-match a fresh regeneration from the pinned ref')
  assert.equal(committedText, `${JSON.stringify(committed, null, 2)}\n`, 'committed artifact must be exactly what the generator writes (no hand edits)')
})

// -------------------------------------------------------------------------------------------
// 3. Baseline pin identity: the ref is the exact SHA the design lock names, not inferred.
// -------------------------------------------------------------------------------------------
test('baseline ref is the exact pinned SHA named by the design lock, restore-only', () => {
  assert.equal(PINNED_REF, 'e0defbe26d7f2e1747e74aa908ca710422812bf7')
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, BASELINE_ARTIFACT_RELPATH), 'utf8'))
  assert.equal(manifest.generatedFromRef, PINNED_REF)
})

// -------------------------------------------------------------------------------------------
// 4. Positive controls — §8.4: "Each syntax/table class has a positive-control fixture,
//    including deliberate plugin, packages/core-backend/src, shared-approval, and
//    operator-script bypasses." These call the scanner/classifier directly on synthetic
//    in-memory content (never written under a scanned root) so the guard proves it has teeth
//    without polluting the real repository scan.
// -------------------------------------------------------------------------------------------

function classifyOneSyntheticSite(relPath, content) {
  const rawSites = scanFileForDmlSites(relPath, content)
  const classified = classifyCensus(rawSites)
  return classified
}

test('positive control: deliberate plugin-style direct INSERT bypass is unclaimed', () => {
  const content = "async function newLiveBypassRoute() {\n  await db.query(`INSERT INTO attendance_records (id) VALUES ($1)`, [id])\n}\n"
  const classified = classifyOneSyntheticSite('plugins/plugin-attendance/index.cjs', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(classified.trackedSites.length, 1)
  assert.equal(unclaimed.length, 1, 'a brand-new symbol writing attendance_records must not be silently claimed by an existing P0x entry')
})

test('positive control: deliberate packages/core-backend/src bypass (new route, no discriminator) is unclaimed', () => {
  const content = "router.post('/api/attendance/new-bypass-route', async (req, res) => {\n  await client.query('UPDATE attendance_records SET status = $1 WHERE id = $2', [status, id])\n})\n"
  const classified = classifyOneSyntheticSite('packages/core-backend/src/routes/attendance-new-bypass.ts', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(unclaimed.length, 1)
})

test('positive control: shared-approval bypass (approval_instances write from an unlisted path) is unclaimed', () => {
  const content = "function terminalizeSomewhereElse() {\n  return trx.raw(\"UPDATE approval_instances SET status = 'completed' WHERE id = $1\", [id])\n}\n"
  const classified = classifyOneSyntheticSite('packages/core-backend/src/services/SomeOtherBridgeNotOnAllowlist.ts', content)
  const { unclaimed, genericAllowlisted } = classifyTrackedSites(classified.trackedSites)
  assert.equal(genericAllowlisted.length, 0)
  assert.equal(unclaimed.length, 1)
})

test('positive control: operator-script bypass (direct delete outside the staging-helper path prefix) is unclaimed', () => {
  const content = "async function pruneOldRows() {\n  await pool.query('DELETE FROM attendance_records WHERE org_id = $1', [orgId])\n}\n"
  const classified = classifyOneSyntheticSite('scripts/ops/attendance-unlisted-operator-tool.mjs', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(unclaimed.length, 1)
})

test('positive control: raw COPY into a W4 authoritative (canonical) table from outside the boundary fails', () => {
  const content = "async function sneakyBulkLoad(client) {\n  const stream = client.query(copyFrom(`COPY attendance_result_operations (org_id) FROM STDIN`))\n}\n"
  const classified = classifyOneSyntheticSite('plugins/plugin-attendance/index.cjs', content)
  assert.equal(classified.canonicalSites.length, 0)
  assert.equal(classified.outsideBoundarySites.length, 1, 'a COPY into a w4_canonical table from a non-canonical path must be flagged out-of-boundary, not silently allowed')
  assert.equal(classified.outsideBoundarySites[0].verb, 'copy')
})

test('positive control: raw COPY FROM STDIN into attendance_records ahead of preflight is unclaimed', () => {
  const content = "async function legacyImportRawCopy(client) {\n  const stream = client.query(copyFrom(`COPY attendance_records (id) FROM STDIN`))\n}\n"
  const classified = classifyOneSyntheticSite('plugins/plugin-attendance/index.cjs', content)
  const { unclaimed } = classifyTrackedSites(classified.trackedSites)
  assert.equal(classified.trackedSites.length, 1)
  assert.equal(classified.trackedSites[0].verb, 'copy')
  assert.equal(unclaimed.length, 1)
})

test('positive control: MERGE INTO and runtime staging CREATE TABLE syntax classes are both detected', () => {
  const mergeContent = "async function upsertViaMerge() {\n  await db.query(`MERGE INTO attendance_records t USING src ON t.id = src.id`)\n}\n"
  const mergeSites = scanFileForDmlSites('plugins/plugin-attendance/index.cjs', mergeContent)
  assert.equal(mergeSites.length, 1)
  assert.equal(mergeSites[0].verb, 'merge')
  assert.equal(mergeSites[0].table, 'attendance_records')

  const stagingContent = "async function makeTempStage() {\n  await db.query(`CREATE TABLE attendance_records (id uuid)`)\n}\n"
  const stagingSites = scanFileForDmlSites('plugins/plugin-attendance/index.cjs', stagingContent)
  assert.equal(stagingSites.length, 1)
  assert.equal(stagingSites[0].verb, 'staging_create')
})

test('canonical boundary helper agrees with the classifier on in/out-of-boundary paths', () => {
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/attendance/w4c0-operation-registry.ts'), true)
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/attendance/w4c3a-legacy-plan-enqueue.ts'), true)
  assert.equal(isCanonicalBoundaryPath('plugins/plugin-attendance/index.cjs'), false)
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/routes/admin-users.ts'), false)
})

test('W4C-3a storage buckets preserve frozen source, result, revision, and cleanup boundaries', () => {
  for (const table of [
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_terminal_responses',
    'attendance_import_rollback_commands',
    'attendance_import_rollback_restore_witnesses',
    'attendance_record_target_revisions',
    'attendance_group_effect_revisions',
  ]) {
    assert.equal(TABLE_BUCKETS[table], 'w4_canonical', `${table} must stay inside the canonical boundary`)
  }
  assert.equal(
    TABLE_BUCKETS.attendance_import_upload_cleanup_commands,
    'operational',
    'upload cleanup commands are P25 operational-only state',
  )
})

test('W4C-3a canonical tables reject a plugin-side writer', () => {
  const classified = classifyOneSyntheticSite(
    'plugins/plugin-attendance/index.cjs',
    "async function bypassFrozenPlan() {\n  await db.query('UPDATE attendance_import_legacy_execution_plans SET plan_digest = $1 WHERE job_id = $2', [digest, jobId])\n}\n",
  )
  assert.equal(classified.canonicalSites.length, 0)
  assert.equal(classified.outsideBoundarySites.length, 1)
  assert.equal(classified.outsideBoundarySites[0].table, 'attendance_import_legacy_execution_plans')
})

test('W4C-3a canonical tables accept a W4C-3a boundary writer', () => {
  const classified = classifyOneSyntheticSite(
    'packages/core-backend/src/attendance/w4c3a-synthetic-positive-control.ts',
    "async function persistFrozenPlan() {\n  await db.query('INSERT INTO attendance_import_legacy_execution_plans (job_id) VALUES ($1)', [jobId])\n}\n",
  )
  assert.equal(classified.canonicalSites.length, 1)
  assert.equal(classified.outsideBoundarySites.length, 0)
  assert.equal(classified.canonicalSites[0].table, 'attendance_import_legacy_execution_plans')
})

test('W4C-3a fixed record-effect DML is classified under the completed P06-P09 cutovers', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { claimsByEntryId } = classifyTrackedSites(classified.trackedSites)
  const adapterPath =
    'packages/core-backend/src/attendance/w4c3a-legacy-plan-record-effects.ts'
  const expectedKeys = classified.trackedSites
    .filter((site) => site.relPath === adapterPath)
    .map((site) => site.key)
    .sort()

  assert.equal(expectedKeys.length, 2, 'the fixed adapter must expose exactly UPDATE + INSERT')
  for (const id of ['P06', 'P07', 'P08', 'P09']) {
    const claimedKeys = (claimsByEntryId.get(id) || [])
      .filter((site) => site.relPath === adapterPath)
      .map((site) => site.key)
      .sort()
    assert.deepEqual(claimedKeys, expectedKeys, `${id} must classify both shared adapter sites`)
    const entry = CURATED_DEBT_ENTRIES.find((candidate) => candidate.id === id)
    assert.equal(
      entry?.canonicalizedBy,
      'W4C-3a',
      `${id} must remain explicitly canonicalized by its owning slice`,
    )
  }
})

test('W4C-3a fixed item-effect DML is classified under the completed P06-P09 cutovers', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { claimsByEntryId } = classifyTrackedSites(classified.trackedSites)
  const adapterPath =
    'packages/core-backend/src/attendance/w4c3a-legacy-plan-item-effects.ts'
  const expectedKeys = classified.trackedSites
    .filter((site) => site.relPath === adapterPath)
    .map((site) => site.key)
    .sort()

  assert.equal(expectedKeys.length, 1, 'the fixed item adapter must expose exactly one INSERT')
  for (const id of ['P06', 'P07', 'P08', 'P09']) {
    const claimedKeys = (claimsByEntryId.get(id) || [])
      .filter((site) => site.relPath === adapterPath)
      .map((site) => site.key)
      .sort()
    assert.deepEqual(claimedKeys, expectedKeys, `${id} must classify the shared item adapter site`)
    const entry = CURATED_DEBT_ENTRIES.find((candidate) => candidate.id === id)
    assert.equal(
      entry?.canonicalizedBy,
      'W4C-3a',
      `${id} must remain explicitly canonicalized by its owning slice`,
    )
  }
})

// -------------------------------------------------------------------------------------------
// 5. CI wiring: this file must be named explicitly in the workflow (node:test files are neither
//    vitest-discovered nor covered by vitest.config.ts's exclude list — see module header).
// -------------------------------------------------------------------------------------------
test('this collector test file has an explicit CI execution step', () => {
  assert.match(readWorkflow(), new RegExp(THIS_TEST_FILENAME.replaceAll('.', '\\.')))
})

// -------------------------------------------------------------------------------------------
// 6. W4C-2 cutover markers (lock §12.3: "P01 live, P02 merge second-pass, P03 cron absence,
//    and P04 administrator-run absence inventory entries are removed independently"). Each of
//    the four entries must INDEPENDENTLY carry the removed-by-adapter marker; no other entry
//    may be silently marked; and the claim predicates still cover the adapter-owned sites so
//    unclaimed=0 detection is not bypassed by the removal.
// -------------------------------------------------------------------------------------------
test('W4C-2: P01, P02, P03, P04 each independently carry canonicalizedBy=W4C-2 — and only they do for W4C-2', () => {
  const byId = new Map(CURATED_DEBT_ENTRIES.map((entry) => [entry.id, entry]))
  // Four independent assertions — removing any ONE marker fails on its own line.
  assert.equal(byId.get('P01')?.canonicalizedBy, 'W4C-2', 'P01 (live punch) must be removed-by-adapter')
  assert.equal(byId.get('P02')?.canonicalizedBy, 'W4C-2', 'P02 (merge second-pass) must be removed-by-adapter')
  assert.equal(byId.get('P03')?.canonicalizedBy, 'W4C-2', 'P03 (cron absence) must be removed-by-adapter')
  assert.equal(byId.get('P04')?.canonicalizedBy, 'W4C-2', 'P04 (administrator absence run) must be removed-by-adapter')
  const marked = CURATED_DEBT_ENTRIES.filter((entry) => entry.canonicalizedBy === 'W4C-2')
    .map((entry) => `${entry.id}:${entry.canonicalizedBy}`)
    .sort()
  assert.deepEqual(
    marked,
    ['P01:W4C-2', 'P02:W4C-2', 'P03:W4C-2', 'P04:W4C-2'],
    'exactly the four W4C-2 entries carry the W4C-2 marker',
  )
})

test('W4C-2: the canonical adapter symbols are claimed by exactly the expected entries', () => {
  const syntheticLive = {
    relPath: 'plugins/plugin-attendance/index.cjs',
    enclosingSymbol: 'applyLivePunchProjectionLegacyV1',
    table: 'attendance_events',
    verb: 'insert',
    bucket: 'business',
    key: 'synthetic-live',
    line: 1,
  }
  const syntheticAbsence = {
    relPath: 'plugins/plugin-attendance/index.cjs',
    enclosingSymbol: 'generateAbsenceRecords',
    table: 'attendance_records',
    verb: 'insert',
    bucket: 'business',
    key: 'synthetic-absence',
    line: 2,
  }
  const { claimsByEntryId, unclaimed } = classifyTrackedSites([syntheticLive, syntheticAbsence])
  assert.deepEqual(unclaimed, [], 'the adapter-owned sites must remain claimed (unclaimed=0 not bypassed)')
  assert.deepEqual(
    (claimsByEntryId.get('P01') || []).map((site) => site.key),
    ['synthetic-live'],
    'P01 claims the live adapter site',
  )
  // One function, two initiators, two debt ids (lock section 1.1): P03 AND P04 both claim it.
  assert.deepEqual((claimsByEntryId.get('P03') || []).map((site) => site.key), ['synthetic-absence'])
  assert.deepEqual((claimsByEntryId.get('P04') || []).map((site) => site.key), ['synthetic-absence'])
})

// -------------------------------------------------------------------------------------------
// 7. W4 canonical wrong-bucket drift guard (origin: W4C-2 P1-2, #4612 final-gate P2-5):
//    the collector's classification suite covered ABSENCE (an unclassified table fails) but not
//    WRONG BUCKET — re-classifying `attendance_scheduled_runs` from `w4_canonical` to
//    `operational` left all prior legs green, silently disarming the canonical-boundary hard
//    fail (ATTENDANCE_W4C0_DML_OUTSIDE_CANONICAL_BOUNDARY) for that table. Same exact-set shape
//    as the debt-ID exclusivity assertion in section 6: three per-table legs (each of the three
//    new tables reddens on its own line) + one exact-set leg over the WHOLE w4_canonical bucket
//    (so demoting ANY canonical table — the W4C-0/W4C-3a ones included — reddens too, and a table
//    smuggled INTO the bucket to widen the path-prefix allowlist's reach also reddens).
// -------------------------------------------------------------------------------------------
test('the three scheduled-run tables are w4_canonical, and the bucket is the exact known closed set', () => {
  // Three independent assertions — flipping any ONE table's bucket fails on its own line.
  assert.equal(
    TABLE_BUCKETS.attendance_scheduled_runs,
    'w4_canonical',
    'attendance_scheduled_runs must stay canonical-boundary-only (wrong-bucket drift, not just absence)',
  )
  assert.equal(
    TABLE_BUCKETS.attendance_scheduled_run_targets,
    'w4_canonical',
    'attendance_scheduled_run_targets must stay canonical-boundary-only (wrong-bucket drift, not just absence)',
  )
  assert.equal(
    TABLE_BUCKETS.attendance_scheduled_run_target_outcomes,
    'w4_canonical',
    'attendance_scheduled_run_target_outcomes must stay canonical-boundary-only (wrong-bucket drift, not just absence)',
  )
  const bucketMembers = Object.keys(TABLE_BUCKETS)
    .filter((table) => TABLE_BUCKETS[table] === 'w4_canonical')
    .sort()
  assert.deepEqual(
    bucketMembers,
    [
      'attendance_calculation_rollout_events',
      'attendance_calculation_rollout_state',
      'attendance_group_effect_revisions',
      'attendance_import_legacy_execution_plan_chunks',
      'attendance_import_legacy_execution_plans',
      'attendance_import_legacy_terminal_responses',
      'attendance_import_rollback_closures',
      'attendance_import_rollback_commands',
      'attendance_import_rollback_restore_witnesses',
      'attendance_record_calculations',
      'attendance_record_segments',
      'attendance_record_target_revisions',
      'attendance_request_calculation_snapshots',
      'attendance_result_event_outbox',
      'attendance_result_operation_batches',
      'attendance_result_operations',
      'attendance_scheduled_run_target_outcomes',
      'attendance_scheduled_run_targets',
      'attendance_scheduled_runs',
    ],
    'the w4_canonical bucket is an exact closed set — a demotion OR a smuggled addition both redden here',
  )
})

// -------------------------------------------------------------------------------------------
// 8. P25 import/integration inventory contract (OD-W4C-36 and OD-W4C-56).  A bucket allowlist alone
// is too weak: it would let a V1 job/plan value be reported as authority while the DML census
// remains green.  The P25 table spec is the closed family/authority inventory; the synthetic
// use checks below are deliberately independent from route behavior and do not claim that the
// completed P06-P11/P23-P25 callers and classifications remain mechanically visible.
// -------------------------------------------------------------------------------------------
test('P25: the closed import/integration set has explicit family and non-authority specs', () => {
  const expectedP25Tables = [
    'attendance_import_items_stage',
    'attendance_import_jobs',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_terminal_responses',
    'attendance_import_records_stage',
    'attendance_import_template_prefs',
    'attendance_import_tokens',
    'attendance_import_upload_cleanup_commands',
    'attendance_integration_runs',
    'attendance_integrations',
  ]
  assert.deepEqual(
    P25_IMPORT_INTEGRATION_TABLES,
    expectedP25Tables,
    'P25 must remain a closed import/integration set, not every operational attendance feature',
  )

  for (const [table, spec] of Object.entries(P25_OPERATIONAL_TABLE_SPECS)) {
    assert.ok(TABLE_BUCKETS[table], `${table} must also exist in the closed table bucket map`)
    assert.match(spec.family, /^[a-z0-9_]+$/)
    assert.match(spec.authorityClass, /^[a-z0-9_]+$/)
    assert.deepEqual(spec.forbiddenAuthorityRoles, P25_FORBIDDEN_AUTHORITY_ROLES)
    assert.equal(spec.forbiddenAuthorityRoles.includes('calculation_source'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('calculation_result'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('promotion_evidence'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('rollback_authority'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('authorization_evidence'), true)
    assert.equal(spec.forbiddenAuthorityRoles.includes('operation_claim'), true)
  }

  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const p25Sites = [...classified.bucketAllowlistedSites, ...classified.canonicalSites].filter(
    (site) => P25_OPERATIONAL_TABLE_SPECS[site.table],
  )
  assert.ok(p25Sites.length > 0, 'the generated census must contain P25 operational/canonical sites')
  for (const site of p25Sites) {
    assert.deepEqual(site.p25, P25_OPERATIONAL_TABLE_SPECS[site.table], `${site.table} must carry its P25 posture in generated inventory`)
  }

  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_jobs.family, 'import_job')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_items_stage.family, 'temporary_staging')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_upload_cleanup_commands.family, 'upload_lifecycle')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_integration_runs.family, 'integration_audit_attempt')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_legacy_execution_plans.family, 'durable_legacy_plan')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_legacy_execution_plan_chunks.family, 'durable_legacy_plan')
  assert.equal(P25_OPERATIONAL_TABLE_SPECS.attendance_import_legacy_terminal_responses.family, 'durable_legacy_terminal')
  for (const table of [
    'attendance_notification_deliveries',
    'attendance_unscheduled_reminder_dispatch',
    'attendance_record_target_revisions',
    'attendance_group_effect_revisions',
  ]) {
    assert.equal(P25_OPERATIONAL_TABLE_SPECS[table], undefined, `${table} must remain outside P25 scope`)
    assert.equal(classifyP25Use({ table, role: 'business_state' }).classification, 'not_p25_operational')
  }
})

test('P25: durable legacy V1 job and plan values cannot become authority evidence', () => {
  for (const table of [
    'attendance_import_jobs',
    'attendance_import_legacy_execution_plans',
    'attendance_import_legacy_execution_plan_chunks',
    'attendance_import_legacy_terminal_responses',
  ]) {
    assert.throws(
      () => assertP25Use({ table, role: 'authorization_evidence' }),
      (error) => error.code === 'ATTENDANCE_P25_OPERATIONAL_AUTHORITY_FORBIDDEN',
      `${table} must not be promoted into authorization evidence`,
    )
    assert.equal(
      classifyP25Use({ table, role: 'compatibility_transport', adapter: 'private_worker' }).allowed,
      true,
      `${table} may remain transport state for the private worker`,
    )
  }
})

test('P25: non-worker adapters cannot claim a retryable V1 job identity', () => {
  for (const adapter of ['sync', 'legacy_import', 'integration_sync', 'rollback']) {
    assert.throws(
      () => assertP25Use({ table: 'attendance_import_jobs', role: 'retryable_job_identity_claim', adapter }),
      (error) => error.code === 'ATTENDANCE_P25_NON_WORKER_JOB_IDENTITY_FORBIDDEN',
      `${adapter} must reject a retryable job identity before source/operation DML`,
    )
  }
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_jobs',
      role: 'retryable_job_identity_claim',
      adapter: 'private_worker',
    }).allowed,
    true,
    'the private worker is the only adapter allowed to claim a retryable job identity',
  )
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_jobs',
      role: 'identity_transport',
      adapter: 'legacy_import',
    }).allowed,
    false,
    'a non-worker adapter cannot transport a reserved V1 identity tuple',
  )
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_legacy_execution_plans',
      role: 'compatibility_transport',
      adapter: 'legacy_import',
    }).allowed,
    false,
    'renaming a reserved identity use as compatibility transport must not bypass the adapter boundary',
  )
  assert.equal(
    classifyP25Use({
      table: 'attendance_import_legacy_execution_plans',
      role: 'compatibility_transport',
      adapter: 'private_worker',
    }).allowed,
    true,
    'the private worker may consume the durable compatibility plan',
  )
})

test('P25: integration dryRun audit state cannot be categorized as business state', () => {
  assert.throws(
    () => assertP25Use({ table: 'attendance_integration_runs', role: 'business_state', dryRun: true }),
    (error) => error.code === 'ATTENDANCE_P25_DRY_RUN_AUDIT_NOT_BUSINESS_STATE',
  )
  assert.equal(
    classifyP25Use({ table: 'attendance_integration_runs', role: 'audit_attempt', dryRun: true }).allowed,
    true,
    'dryRun may append an audit attempt only',
  )
})

test('P25: generated runtime call-path census classifies every closed-table read and write', () => {
  const source = createWorktreeSource(rootDir)
  const { sites } = buildP25CallPathCensus(source)
  const result = classifyP25CallPathSites(sites)

  assert.equal(sites.length, 105, 'the current generated P25 read/write inventory must remain explicit')
  assert.deepEqual(result.unclassified, [], 'a new P25 table/site or renamed wrapper must not inherit a broad allowlist')
  assert.deepEqual(result.countDrift, [], 'an extra P25 access in an existing wrapper must require an explicit classification')
  assert.deepEqual(result.stale, [], 'removing a P25 access must retire its classification deliberately')
  assert.equal(result.classifiedSites.length, sites.length, 'every generated P25 site must carry an explicit adapter and role')
  assert.deepEqual(
    [...new Set(sites.map((site) => site.table))].sort(),
    P25_IMPORT_INTEGRATION_TABLES,
    'the generated call-path census must cover every closed P25 table family',
  )
})

test('P25 mutation: removing the private-worker boundary or adding a non-worker reserved-tuple read fails', () => {
  const workerClassification = P25_CALL_PATH_CLASSIFICATIONS.find(
    (classification) =>
      classification.relPath === 'packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts' &&
      classification.table === 'attendance_import_legacy_execution_plans' &&
      classification.access === 'read',
  )
  assert.ok(workerClassification)
  const withoutPrivateWorker = P25_CALL_PATH_CLASSIFICATIONS.map((classification) =>
    classification === workerClassification ? { ...classification, adapter: 'sync' } : classification,
  )
  assert.throws(
    () => classifyP25CallPathSites([], withoutPrivateWorker),
    (error) => error.code === 'ATTENDANCE_P25_IDENTITY_ADAPTER_PATH_FORBIDDEN',
    'the durable plan read cannot survive after its private-worker boundary is removed',
  )

  const nonWorkerRead = scanFileForP25CallPathSites(
    'plugins/plugin-attendance/index.cjs',
    "async function syncAdoptsReservedTuple() {\n  await db.query('SELECT * FROM attendance_import_jobs WHERE id = $1', [jobId])\n}\n",
  )
  assert.equal(nonWorkerRead.length, 1)
  assert.throws(
    () =>
      classifyP25CallPathSites(nonWorkerRead, [
        {
          relPath: 'plugins/plugin-attendance/index.cjs',
          enclosingSymbol: 'syncAdoptsReservedTuple',
          table: 'attendance_import_jobs',
          access: 'read',
          verb: 'select',
          count: 1,
          role: 'compatibility_transport',
          adapter: 'sync',
        },
      ]),
    (error) => error.code === 'ATTENDANCE_P25_IDENTITY_ADAPTER_PATH_FORBIDDEN',
    'a sync/legacy/integration/rollback wrapper cannot consume a reserved retryable tuple',
  )

  const hiddenReadShapes = [
    'async function multilineP25Read() {\n  return db.query(`SELECT * FROM\n attendance_import_jobs`)\n}\n',
    "const TABLE = 'attendance_import_jobs'\nasync function moduleP25Read() { return db.query(`SELECT * FROM ${TABLE}`) }\n",
    'const TABLE = `attendance_import_jobs`\nasync function backtickP25Read() { return db.query(`SELECT * FROM ${TABLE}`) }\n',
    "const TABLE = 'attendance_import_jobs'\nasync function wrappedP25Read() { return db.query(`SELECT * FROM ${quote(TABLE)}`) }\n",
  ]
  for (const source of hiddenReadShapes) {
    const sites = scanFileForP25CallPathSites('plugins/plugin-attendance/index.cjs', source)
    assert.equal(sites.length, 1, source)
    assert.equal(sites[0]?.table, 'attendance_import_jobs')
    assert.equal(classifyP25CallPathSites(sites).unclassified.length, 1, source)
  }

  const reusedLoopVariable = scanFileForP25CallPathSites(
    'packages/core-backend/src/db/migrations/example.ts',
    "async function down() {\n  const checks = ['attendance_import_legacy_execution_plans']\n  for (const table of checks) { await db.query(`SELECT * FROM ${quote(table)}`) }\n  for (const table of ['attendance_import_jobs']) { await drop(table) }\n}\n",
  )
  assert.deepEqual(
    reusedLoopVariable.map((site) => site.table),
    ['attendance_import_legacy_execution_plans'],
    'a later same-name loop binding must not contaminate an earlier dynamic SELECT',
  )
})

test('P25 mutation: an unclassified wrapper and integration-run authority both fail', () => {
  const renamedWrapper = scanFileForP25CallPathSites(
    'packages/core-backend/src/attendance/w4c3a-legacy-plan-worker-repository.ts',
    "async function renamedPlanReader() {\n  await db.query('SELECT * FROM attendance_import_legacy_execution_plans WHERE job_id = $1', [jobId])\n}\n",
  )
  const unclassified = classifyP25CallPathSites(renamedWrapper)
  assert.equal(unclassified.unclassified.length, 1, 'renaming a P25 wrapper must require a new explicit classification')

  const addedSite = scanFileForP25CallPathSites(
    'plugins/plugin-attendance/index.cjs',
    "function buildImportJobProjectionSql() {\n  return 'SELECT * FROM attendance_import_jobs'\n}\n",
  )
  const addedSiteResult = classifyP25CallPathSites(addedSite)
  assert.equal(addedSiteResult.unclassified.length, 0, 'the single known wrapper site remains classified')
  const duplicateSiteResult = classifyP25CallPathSites([...addedSite, ...addedSite])
  assert.equal(duplicateSiteResult.unclassified.length, 1, 'a new P25 site inside an existing wrapper must be unclassified')

  const integrationAudit = P25_CALL_PATH_CLASSIFICATIONS.find(
    (classification) => classification.table === 'attendance_integration_runs',
  )
  assert.ok(integrationAudit)
  const authorityMutation = P25_CALL_PATH_CLASSIFICATIONS.map((classification) =>
    classification === integrationAudit ? { ...classification, role: 'business_state' } : classification,
  )
  assert.throws(
    () => classifyP25CallPathSites([], authorityMutation),
    (error) => error.code === 'ATTENDANCE_P25_AUDIT_NOT_BUSINESS_STATE',
    'integration_runs, including dry-run audit state, cannot feed calculation or authorization authority',
  )
})

test('P06-P11/P23-P25 remain visible and explicitly canonicalized by W4C-3a', () => {
  const requiredDebtIds = ['P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P23', 'P24', 'P25']
  const byId = new Map(CURATED_DEBT_ENTRIES.map((entry) => [entry.id, entry]))
  const source = createWorktreeSource(rootDir)
  const { sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { claimsByEntryId } = classifyTrackedSites(classified.trackedSites)

  for (const id of requiredDebtIds) {
    const entry = byId.get(id)
    assert.ok(entry, `${id} must remain in the generated debt inventory`)
    assert.equal(
      entry.owningSlice,
      id === 'P25' ? 'W4C-0' : 'W4C-3a',
      `${id} must retain its original owning slice`,
    )
    assert.equal(entry.canonicalizedBy, 'W4C-3a', `${id} must retain its completed-slice marker`)
    // P23/P24/P25 are authorization/operational classification debt and intentionally have no
    // tracked business DML claim; P06-P11 must retain the concrete current census claims.
    if (!['P23', 'P24', 'P25'].includes(id)) {
      assert.ok((claimsByEntryId.get(id) || []).length > 0, `${id} must expose its current canonical writers`)
    }
  }
})
