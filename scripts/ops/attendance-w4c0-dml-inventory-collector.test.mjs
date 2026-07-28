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
const { buildRawCensus, classifyCensus, scanFileForDmlSites, isCanonicalBoundaryPath, contentHashOfKeys } = require(
  path.join(toolDir, 'collector.cjs'),
)
const { classifyTrackedSites } = require(path.join(toolDir, 'classify-tracked-sites.cjs'))
const { CURATED_DEBT_ENTRIES } = require(path.join(toolDir, 'curated-debt-entries.cjs'))

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
  assert.equal(isCanonicalBoundaryPath('plugins/plugin-attendance/index.cjs'), false)
  assert.equal(isCanonicalBoundaryPath('packages/core-backend/src/routes/admin-users.ts'), false)
})

// -------------------------------------------------------------------------------------------
// 5. CI wiring: this file must be named explicitly in the workflow (node:test files are neither
//    vitest-discovered nor covered by vitest.config.ts's exclude list — see module header).
// -------------------------------------------------------------------------------------------
test('this collector test file has an explicit CI execution step', () => {
  assert.match(readWorkflow(), new RegExp(THIS_TEST_FILENAME.replaceAll('.', '\\.')))
})
