#!/usr/bin/env tsx
/**
 * R14.C — Time Machine real-scale benchmark harness (multitable).
 *
 * Measures, at N = 1,000 / 5,000 / 10,000 / 50,000 synthetic records per throwaway sheet:
 *   1. reconstructRecordsAtT           — PIT record reconstruction (record-reconstructor.ts)
 *   2. precheckSheetHistoryIntegrity   — #4234 live-vs-latest integrity precheck
 *   3. a PROTOTYPE per-generation contiguity window-function query (standalone SQL here —
 *      NOT a change to any precheck/production source), informing #4262 §1's O(n)-window concern
 *   4. revert-preview / reset-preview  — end-to-end route latency below AND above the
 *      SHEET_REVERT_MAX_RECORDS ceiling (default 5000; >5000 tiers exercise the fail-closed 413 refusal)
 *   5. revert-execute / reset-execute  — one real destructive run each, at the 1k tier only
 *      (dedicated throwaway sheets), wall time + write counts
 *   6. table/index stats for meta_record_revisions, plus EXPLAIN (ANALYZE, BUFFERS) at the 10k tier
 *
 * Every measured query/route is exercised TWICE per run: once with a harness-OWNED composite index
 * (see "index safety" below) ABSENT and once with it CREATED, to compare against the shape #4262 §4
 * proposes (`(sheet_id, record_id, created_at, version, id)`).
 *
 * ── SAFETY (read before running — this harness performs REAL destructive writes) ──────────────────
 * This is not a read-only tool: it runs real revert-execute / reset-execute HTTP calls, mass
 * INSERT/DELETE of synthetic rows, and CREATE/DROP INDEX DDL. A hard, fail-closed preflight guard
 * (see `preflightGuard()` below) runs BEFORE any database connection is used and refuses to proceed
 * unless ALL THREE of the following are explicitly satisfied:
 *   1. `BENCH_ALLOW_DESTRUCTIVE=1` is set (first opt-in — acknowledges this is destructive).
 *   2. `DATABASE_URL`'s host is `localhost` / `127.0.0.1` / `::1`, OR `BENCH_ALLOW_REMOTE_DB=1` is
 *      set (second, independent opt-in required to point this at any non-local host).
 *   3. `DATABASE_URL`'s database name matches `/bench|test/i`, OR `BENCH_ALLOW_NONSTANDARD_DB_NAME=1`
 *      is set (third, independent opt-in required to point this at a database that doesn't look like
 *      a disposable bench/test database).
 * Any of the three failing refuses with `process.exit(2)` and a clear message, before a single query
 * runs. There is no scenario in which this harness reaches a write with any of the three unmet.
 *
 * **Index safety:** the harness never touches any pre-existing, non-harness-owned database object
 * (specifically: it never DROPs or CREATEs #4262 §4's real candidate index name — see
 * `REAL_CANDIDATE_INDEX_NAME` below, checked read-only, informationally, for context only — never via
 * DDL). For its own "with index" comparison pass it creates and drops a SEPARATE index under a
 * `bench_`-prefixed, `BENCH_RUN_ID`-namespaced name that it owns outright (see `BENCH_INDEX_NAME`) —
 * safe to create/drop freely because no other process or migration can legitimately own an object
 * under that name.
 *
 * **Cleanup:** all seeding (sheets/records/revisions/links/trash rows) and the harness-owned bench
 * index happen inside ONE outermost `try { ... } finally { ... }` in `main()`, so a mid-run exception
 * anywhere in the seed/measure/execute pipeline still runs cleanup — seeded data cannot be stranded by
 * a crash partway through. Every sheet id destined to be seeded is reserved into the cleanup list
 * BEFORE its seed call runs (not after it returns), so even a crash mid-seed of one tier still cleans
 * up whatever that tier's seed call had already written. Cleanup is idempotent (deleting rows/ids that
 * were never written, or were already deleted by an earlier cleanup pass, is a no-op) and strictly
 * scoped to this run's own `BENCH_RUN_ID`-namespaced sheet/base/user ids — it never touches any object
 * this harness did not itself create. (Note: this defends against a thrown/caught exception mid-run,
 * not an unrecoverable OS-level kill/power-loss — no userspace `finally` can run after that; the
 * verification for this PR simulates the former via `BENCH_INJECT_FAULT`, below.)
 *
 * Auth: this harness builds the multitable router in-process and injects `req.user` directly (the
 * exact fixture pattern the repo's own `multitable-*-realdb.test.ts` suite uses) rather than driving a
 * real HTTP server through JWT/RBAC_TOKEN_TRUST — the object under measurement is route+DB compute
 * latency, not auth-middleware overhead. RBAC_TOKEN_TRUST is still honored/set for parity with the
 * task's documented environment, but this harness does not depend on it.
 *
 * Measurement-only: seeds/measures/cleans up its own throwaway sheets (ids namespaced by `BENCH_RUN_ID`);
 * makes NO change to runtime source; the two default-off recovery flags are set in THIS PROCESS's env
 * only. NOT wired into CI — this is a load benchmark, run by hand, gated behind the preflight above.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:pw@localhost:55888/metasheet_test \
 *   BENCH_ALLOW_DESTRUCTIVE=1 \
 *     npx tsx packages/core-backend/scripts/bench/timemachine-scale-bench.ts
 *
 * Env knobs:
 *   BENCH_ALLOW_DESTRUCTIVE=1          REQUIRED — first opt-in, see SAFETY above.
 *   BENCH_ALLOW_REMOTE_DB=1            required only if DATABASE_URL's host isn't local, see SAFETY above.
 *   BENCH_ALLOW_NONSTANDARD_DB_NAME=1  required only if the db name doesn't match /bench|test/i, see SAFETY above.
 *   BENCH_TIERS         comma-separated record counts (default "1000,5000,10000,50000")
 *   BENCH_ITERS         override the loop-iteration count for EVERY tier (default: scaled per tier)
 *   BENCH_RUN_ID        override the run id used to namespace all seeded ids (default: Date.now())
 *   BENCH_KEEP_DATA=1   skip cleanup at the end (for post-mortem inspection)
 *   BENCH_SKIP_INDEX_CMP=1  skip the drop/recreate index comparison pass (baseline-only run)
 *   BENCH_INJECT_FAULT=1  TESTING HOOK ONLY: throws a synthetic error after seeding + destructive
 *     execute + bench-index creation (requires BENCH_SKIP_INDEX_CMP to be unset), to prove the
 *     outermost try/finally still cleans up both seeded rows AND the harness-owned index on a
 *     mid-run crash. Never set this in a real measurement run.
 */
import { performance } from 'node:perf_hooks'
import express, { type Express } from 'express'
import request from 'supertest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { precheckSheetHistoryIntegrity } from '../../src/multitable/history-integrity-precheck'
import { univerMetaRouter } from '../../src/routes/univer-meta'

// ---------------------------------------------------------------------------------------------
// Preflight guard — MUST run, and MUST refuse where warranted, before any DB connection is used.
// See the "SAFETY" section of the header comment above for the exact three checks.
// ---------------------------------------------------------------------------------------------
function parseDatabaseUrlOrExit(raw: string): { host: string; dbName: string } {
  try {
    const u = new URL(raw)
    return { host: u.hostname, dbName: u.pathname.replace(/^\//, '') }
  } catch {
    console.error(`FATAL: DATABASE_URL is not a parseable URL: ${raw}`)
    process.exit(2)
  }
}

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function preflightGuard(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) {
    console.error('FATAL: DATABASE_URL is required (see script header for the expected local scratch PG URL).')
    process.exit(2)
  }
  if (process.env.BENCH_ALLOW_DESTRUCTIVE !== '1') {
    console.error(
      'FATAL: this harness performs REAL destructive operations against DATABASE_URL — revert-execute / ' +
        'reset-execute (one real run each), CREATE/DROP INDEX (harness-owned index only), and mass ' +
        'INSERT/DELETE of synthetic rows. Refusing to run without an explicit opt-in.\n' +
        'Set BENCH_ALLOW_DESTRUCTIVE=1 to proceed.',
    )
    process.exit(2)
  }
  const { host, dbName } = parseDatabaseUrlOrExit(rawUrl)
  if (!LOCAL_DB_HOSTS.has(host) && process.env.BENCH_ALLOW_REMOTE_DB !== '1') {
    console.error(
      `FATAL: DATABASE_URL host "${host}" is not localhost/127.0.0.1/::1 — refusing to run destructive ` +
        'operations against a non-local database.\n' +
        'Set BENCH_ALLOW_REMOTE_DB=1 to explicitly double-opt-in to a remote target.',
    )
    process.exit(2)
  }
  if (!/bench|test/i.test(dbName) && process.env.BENCH_ALLOW_NONSTANDARD_DB_NAME !== '1') {
    console.error(
      `FATAL: database name "${dbName}" does not match /bench|test/i — refusing to run against what looks ` +
        'like a real deployment database.\n' +
        'Set BENCH_ALLOW_NONSTANDARD_DB_NAME=1 to explicitly triple-opt-in and override this check.',
    )
    process.exit(2)
  }
  console.log(`[preflight] OK — host="${host}" db="${dbName}" (all required opt-ins present; refusing otherwise).`)
}

preflightGuard()

// ---------------------------------------------------------------------------------------------
// Env (benchmark-process-only)
// ---------------------------------------------------------------------------------------------
process.env.MULTITABLE_ENABLE_SHEET_REVERT = process.env.MULTITABLE_ENABLE_SHEET_REVERT || 'true'
process.env.MULTITABLE_ENABLE_PIT_RESET = process.env.MULTITABLE_ENABLE_PIT_RESET || 'true'
process.env.RBAC_TOKEN_TRUST = process.env.RBAC_TOKEN_TRUST || 'true'
delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED // must stay OFF or reset-preview 409s (RESET_RETENTION_CONFLICT)

const RUN_ID = process.env.BENCH_RUN_ID || `${Date.now()}`
const TIERS = (process.env.BENCH_TIERS ? process.env.BENCH_TIERS.split(',').map(Number) : [1000, 5000, 10000, 50000]).filter(
  (n) => Number.isFinite(n) && n > 0,
)
const KEEP_DATA = process.env.BENCH_KEEP_DATA === '1'
const SKIP_INDEX_CMP = process.env.BENCH_SKIP_INDEX_CMP === '1'
const HOUR = 3_600_000
const GLOBAL_T0 = new Date('2024-01-01T00:00:00.000Z').getTime()

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const BASE_ID = `base_tmb_${RUN_ID}`
const ACTOR_ID = `user_tmb_${RUN_ID}`
const PEOPLE_SHEET_ID = `sht_tmb_${RUN_ID}_people`
const F_PNAME = `fld_tmb_${RUN_ID}_pname`

function tierSheetId(n: number, suffix = ''): string {
  return `sht_tmb_${RUN_ID}_${n}${suffix}`
}
function fieldIds(n: number, suffix = '') {
  const p = `fld_tmb_${RUN_ID}_${n}${suffix}`
  return { name: `${p}_name`, amount: `${p}_amount`, status: `${p}_status`, owner: `${p}_owner`, score: `${p}_score` }
}

function itersFor(n: number): number {
  if (process.env.BENCH_ITERS) return Number(process.env.BENCH_ITERS)
  if (n <= 1000) return 30
  if (n <= 5000) return 20
  if (n <= 10000) return 15
  return 8
}

// ---------------------------------------------------------------------------------------------
// timing helpers
// ---------------------------------------------------------------------------------------------
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

interface LoopStats {
  iterations: number
  p50: number
  p95: number
  min: number
  max: number
  mean: number
}

async function timeLoop<T>(fn: () => Promise<T>, iterations: number, assertFn?: (result: T) => void): Promise<LoopStats> {
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    const result = await fn()
    const t1 = performance.now()
    if (assertFn) assertFn(result) // positive control: throws loudly if the op didn't do what we expect
    samples.push(t1 - t0)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    iterations,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  }
}

// ---------------------------------------------------------------------------------------------
// seeding
// ---------------------------------------------------------------------------------------------
type RecRow = { id: string; version: number; data: Record<string, unknown> }
type RevRow = { recordId: string; version: number; action: string; snapshot: Record<string, unknown>; createdAt: number }

interface TierSeed {
  sheetId: string
  fields: ReturnType<typeof fieldIds>
  n: number
  asOfIso: string
  expectedAtT: number // records that exist at asOf (cohort A + B)
  cohortCCount: number // records created strictly after asOf (reset delete-set / revert kept-created-after-T)
  cohortBCount: number // records with a delete->restore cycle (multi-generation chains)
}

async function ensureBase(): Promise<void> {
  await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [BASE_ID, `TM Bench ${RUN_ID}`])
  await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR_ID])
}

async function seedPeopleSheet(count = 20): Promise<string[]> {
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [PEOPLE_SHEET_ID, BASE_ID, 'TM Bench People'])
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    F_PNAME,
    PEOPLE_SHEET_ID,
    'Name',
    'string',
    '{}',
    1,
  ])
  const ids: string[] = []
  const t0 = new Date(GLOBAL_T0).toISOString()
  for (let i = 0; i < count; i++) {
    const id = `per_tmb_${RUN_ID}_${i}`
    ids.push(id)
    const data = { [F_PNAME]: `Person ${i}` }
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_at, updated_at) VALUES ($1,$2,$3::jsonb,1,$4,$4)', [
      id,
      PEOPLE_SHEET_ID,
      JSON.stringify(data),
      t0,
    ])
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, snapshot, created_at)
       VALUES (gen_random_uuid(),$1,$2,1,'create','bench',$3::jsonb,$4)`,
      [PEOPLE_SHEET_ID, id, JSON.stringify(data), t0],
    )
  }
  return ids
}

async function bulkInsertRecords(sheetId: string, rows: RecRow[]): Promise<void> {
  const CHUNK = 5000
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const ids = chunk.map((r) => r.id)
    const versions = chunk.map((r) => r.version)
    const datas = chunk.map((r) => JSON.stringify(r.data))
    const sheetIds = chunk.map(() => sheetId)
    const actorIds = chunk.map(() => ACTOR_ID)
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::jsonb[], $4::int[], $5::text[], $6::text[])`,
      [ids, sheetIds, datas, versions, actorIds, actorIds],
    )
  }
}

async function bulkInsertRevisions(sheetId: string, rows: RevRow[]): Promise<void> {
  const CHUNK = 5000
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const sheetIds = chunk.map(() => sheetId)
    const recordIds = chunk.map((r) => r.recordId)
    const versions = chunk.map((r) => r.version)
    const actions = chunk.map((r) => r.action)
    const snapshots = chunk.map((r) => JSON.stringify(r.snapshot))
    const createdAts = chunk.map((r) => new Date(r.createdAt).toISOString())
    await q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, snapshot, created_at)
       SELECT gen_random_uuid(), s, r, v, a, 'bench', snap::jsonb, ca::timestamptz
       FROM UNNEST($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[]) AS t(s, r, v, a, snap, ca)`,
      [sheetIds, recordIds, versions, actions, snapshots, createdAts],
    )
  }
}

async function bulkInsertLinks(ownerFieldId: string, rows: RecRow[]): Promise<void> {
  const CHUNK = 5000
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const fieldIdsArr = chunk.map(() => ownerFieldId)
    const recordIds = chunk.map((r) => r.id)
    const foreignIds = chunk.map((r) => (r.data[ownerFieldId] as string[])[0])
    await q(
      `INSERT INTO meta_links (field_id, record_id, foreign_record_id) SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])`,
      [fieldIdsArr, recordIds, foreignIds],
    )
  }
}

/**
 * Seeds one throwaway sheet with `n` records and realistic revision chains:
 *   ~85% cohort A — plain 3-revision lifecycle (create, update, update), no delete.
 *   ~10% cohort B — delete -> restore cycle (create,update,update,delete,create,update): 2 generations,
 *                   6 revisions, version resets to 1 on the post-restore generation (matches
 *                   record-service.ts's real restoreRecord/undelete version semantics).
 *   ~5%  cohort C — created strictly AFTER `asOf` (single create revision at asOf+6h): populates
 *                   revert's "keptCreatedAfterT" bucket and reset's delete-set with real rows.
 * `asOf` = seed-local T0 + 1.5h, chosen so every cohort-A/B record's reconstructed state at T is its
 * v2 (post-first-update) snapshot, and every cohort-C record is absent from the T reconstruction.
 */
async function seedTier(n: number, personIds: string[], suffix = ''): Promise<TierSeed> {
  const sheetId = tierSheetId(n, suffix)
  const f = fieldIds(n, suffix)
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, BASE_ID, `TM Bench ${n}${suffix}`])
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    f.name,
    sheetId,
    'Name',
    'string',
    '{}',
    1,
  ])
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    f.amount,
    sheetId,
    'Amount',
    'number',
    '{}',
    2,
  ])
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    f.status,
    sheetId,
    'Status',
    'string',
    '{}',
    3,
  ])
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    f.owner,
    sheetId,
    'Owner',
    'link',
    JSON.stringify({ foreignSheetId: PEOPLE_SHEET_ID }),
    4,
  ])
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
    f.score,
    sheetId,
    'Score',
    'formula',
    JSON.stringify({ formula: 'Amount*2' }),
    5,
  ])

  const mkData = (name: string, amount: number, status: string, personId: string) => ({
    [f.name]: name,
    [f.amount]: amount,
    [f.status]: status,
    [f.owner]: [personId],
    [f.score]: amount * 2,
  })

  const cohortCCount = Math.max(1, Math.round(n * 0.05))
  let cohortBCount = 0
  const recRows: RecRow[] = []
  const revRows: RevRow[] = []

  for (let i = 0; i < n; i++) {
    const id = `rec_tmb_${RUN_ID}_${n}${suffix}_${i}`
    const base = GLOBAL_T0 + i // ms spread across records; negligible next to the hour-scale deltas below
    const personId = personIds[i % personIds.length]
    const isCohortC = i < cohortCCount
    const isCohortB = !isCohortC && i % 10 === 0
    if (isCohortC) {
      const data = mkData(`Rec ${i}`, 100 + i, 'draft', personId)
      revRows.push({ recordId: id, version: 1, action: 'create', snapshot: data, createdAt: base + 6 * HOUR })
      recRows.push({ id, version: 1, data })
    } else if (isCohortB) {
      cohortBCount++
      const v1 = mkData(`Rec ${i}`, 100 + i, 'draft', personId)
      const v2 = mkData(`Rec ${i}`, 200 + i, 'active', personId)
      const v3 = mkData(`Rec ${i}`, 300 + i, 'active', personId)
      const g2v1 = mkData(`Rec ${i} restored`, 400 + i, 'draft', personId)
      const g2v2 = mkData(`Rec ${i} restored`, 500 + i, 'closed', personId)
      revRows.push({ recordId: id, version: 1, action: 'create', snapshot: v1, createdAt: base + 0 })
      revRows.push({ recordId: id, version: 2, action: 'update', snapshot: v2, createdAt: base + 1 * HOUR })
      revRows.push({ recordId: id, version: 3, action: 'update', snapshot: v3, createdAt: base + 2 * HOUR })
      revRows.push({ recordId: id, version: 3, action: 'delete', snapshot: v3, createdAt: base + 3 * HOUR })
      revRows.push({ recordId: id, version: 1, action: 'create', snapshot: g2v1, createdAt: base + 4 * HOUR })
      revRows.push({ recordId: id, version: 2, action: 'update', snapshot: g2v2, createdAt: base + 5 * HOUR })
      recRows.push({ id, version: 2, data: g2v2 })
    } else {
      const v1 = mkData(`Rec ${i}`, 100 + i, 'draft', personId)
      const v2 = mkData(`Rec ${i}`, 200 + i, 'active', personId)
      const v3 = mkData(`Rec ${i}`, 300 + i, 'active', personId)
      revRows.push({ recordId: id, version: 1, action: 'create', snapshot: v1, createdAt: base + 0 })
      revRows.push({ recordId: id, version: 2, action: 'update', snapshot: v2, createdAt: base + 1 * HOUR })
      revRows.push({ recordId: id, version: 3, action: 'update', snapshot: v3, createdAt: base + 2 * HOUR })
      recRows.push({ id, version: 3, data: v3 })
    }
  }

  await bulkInsertRecords(sheetId, recRows)
  await bulkInsertRevisions(sheetId, revRows)
  await bulkInsertLinks(f.owner, recRows)

  const asOfIso = new Date(GLOBAL_T0 + 1.5 * HOUR).toISOString()
  return { sheetId, fields: f, n, asOfIso, expectedAtT: n - cohortCCount, cohortCCount, cohortBCount }
}

// ---------------------------------------------------------------------------------------------
// the v2 contiguity prototype (standalone SQL — NOT wired into any production source)
// ---------------------------------------------------------------------------------------------
const CONTIGUITY_SQL = `
WITH gen AS (
  SELECT sheet_id, record_id, id, action, version, created_at,
    COUNT(*) FILTER (WHERE action = 'create') OVER (
      PARTITION BY sheet_id, record_id ORDER BY created_at, version, id
      ROWS UNBOUNDED PRECEDING
    ) AS generation
  FROM meta_record_revisions
  WHERE sheet_id = $1
)
SELECT sheet_id, record_id, generation,
  COUNT(*) AS revision_count,
  MIN(version) AS min_version,
  MAX(version) AS max_version,
  COUNT(DISTINCT version) AS distinct_versions
FROM gen
GROUP BY sheet_id, record_id, generation`

async function runContiguityPrototype(sheetId: string) {
  return q(CONTIGUITY_SQL, [sheetId])
}

const RECONSTRUCT_SQL = `SELECT DISTINCT ON (record_id) record_id, action, snapshot, version
     FROM meta_record_revisions
     WHERE sheet_id = $1 AND created_at <= $2
     ORDER BY record_id, created_at DESC, version DESC, id DESC`

const PRECHECK_LATEST_SQL = `SELECT DISTINCT ON (record_id) record_id, action, snapshot
     FROM meta_record_revisions
     WHERE sheet_id = $1
     ORDER BY record_id, created_at DESC, version DESC, id DESC`

async function explain(sql: string, params: unknown[]): Promise<string> {
  const res = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params)
  return (res.rows as Array<Record<string, string>>).map((r) => r['QUERY PLAN']).join('\n')
}

// ---------------------------------------------------------------------------------------------
// index handling
//
// SAFETY (P1-2 fix): this harness must NEVER drop/create a pre-existing, non-harness-owned database
// object — doing so on a shared DB is a mutation, not a benchmark. REAL_CANDIDATE_INDEX_NAME below is
// #4262 §4's actual proposed index name; it is checked READ-ONLY (a SELECT against pg_indexes, purely
// informational) and is NEVER passed to DROP/CREATE anywhere in this file. For the "with index vs
// without" comparison pass, the harness instead owns a SEPARATE index under a `bench_`-prefixed,
// BENCH_RUN_ID-namespaced name (BENCH_INDEX_NAME) of the identical column shape — safe to create/drop
// freely because no migration or other process can legitimately hold that name. This measures the same
// query-planner effect (index column shape, not index name, is what the planner reasons about) without
// ever mutating anything the harness didn't itself create.
// ---------------------------------------------------------------------------------------------
const REAL_CANDIDATE_INDEX_NAME = 'idx_meta_record_revisions_sheet_record_created_version_id'
const BENCH_INDEX_NAME = `bench_tmb_${RUN_ID}_candidate_idx`

/** Read-only informational check — never used to justify a DROP/CREATE against this name. */
async function realCandidateIndexExists(): Promise<boolean> {
  const res = await q('SELECT 1 FROM pg_indexes WHERE indexname = $1', [REAL_CANDIDATE_INDEX_NAME])
  return res.rows.length > 0
}
async function dropBenchIndex(): Promise<void> {
  await q(`DROP INDEX IF EXISTS ${BENCH_INDEX_NAME}`)
}
async function createBenchIndex(): Promise<void> {
  await q(`CREATE INDEX IF NOT EXISTS ${BENCH_INDEX_NAME} ON meta_record_revisions (sheet_id, record_id, created_at, version, id)`)
}

// ---------------------------------------------------------------------------------------------
// table/index stats
// ---------------------------------------------------------------------------------------------
async function tierTableStats(sheetId: string) {
  const recCount = Number((await q('SELECT count(*)::int c FROM meta_records WHERE sheet_id=$1', [sheetId])).rows[0].c)
  const revCount = Number((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id=$1', [sheetId])).rows[0].c)
  return { recCount, revCount }
}
async function globalIndexSizes() {
  const res = await q(
    `SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size
     FROM pg_stat_user_indexes WHERE relname = 'meta_record_revisions' ORDER BY indexrelname`,
  )
  return res.rows as Array<{ indexrelname: string; size: string }>
}

// ---------------------------------------------------------------------------------------------
// HTTP app (in-process; see header note on the auth-bypass pattern)
// ---------------------------------------------------------------------------------------------
function buildApp(): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { user: unknown }).user = {
      id: ACTOR_ID,
      roles: ['member'],
      perms: ['multitable:read', 'multitable:write', 'multitable:share'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

// ---------------------------------------------------------------------------------------------
// per-tier read-path measurement (items 1,2,3,4)
// ---------------------------------------------------------------------------------------------
async function measureReadPath(seed: TierSeed, label: string, app: Express) {
  const pool = poolManager.get()
  const queryFn = pool.query.bind(pool)
  const iterations = itersFor(seed.n)

  console.log(`  [${label}] reconstructRecordsAtT x${iterations}...`)
  const reconstruct = await timeLoop(
    () => reconstructRecordsAtT(queryFn, seed.sheetId, seed.asOfIso),
    iterations,
    (m) => {
      if (m.size !== seed.expectedAtT) {
        throw new Error(`[${label}] positive-control FAILED: reconstruct size ${m.size} !== expected ${seed.expectedAtT}`)
      }
    },
  )

  console.log(`  [${label}] precheckSheetHistoryIntegrity x${iterations}...`)
  const precheck = await timeLoop(
    () => precheckSheetHistoryIntegrity(queryFn, seed.sheetId),
    iterations,
    (v) => {
      if (!v.ok) throw new Error(`[${label}] positive-control FAILED: precheck not ok: ${JSON.stringify(v)}`)
    },
  )

  console.log(`  [${label}] contiguity prototype x${iterations}...`)
  const contiguity = await timeLoop(() => runContiguityPrototype(seed.sheetId), iterations)

  const previewIters = Math.min(iterations, 20)
  const expectStatus = seed.n <= 5000 ? 200 : 413 // SHEET_REVERT_MAX_RECORDS default = 5000, refuses STRICTLY above

  console.log(`  [${label}] revert-preview x${previewIters} (expect ${expectStatus})...`)
  const revertPreview = await timeLoop(
    () => request(app).post(`/api/multitable/sheets/${seed.sheetId}/revert-preview`).send({ asOf: seed.asOfIso }),
    previewIters,
    // supertest ships no type declarations in this project (implicit `any`) — annotate explicitly so
    // `timeLoop`'s generic can resolve T instead of defaulting to `unknown` here.
    (res: { status: number; body: unknown }) => {
      if (res.status !== expectStatus) {
        throw new Error(`[${label}] positive-control FAILED: revert-preview status ${res.status} !== ${expectStatus}: ${JSON.stringify(res.body)}`)
      }
    },
  )

  console.log(`  [${label}] reset-preview x${previewIters} (expect ${expectStatus})...`)
  const resetPreview = await timeLoop(
    () => request(app).post(`/api/multitable/sheets/${seed.sheetId}/reset-preview`).send({ asOf: seed.asOfIso }),
    previewIters,
    (res: { status: number; body: unknown }) => {
      if (res.status !== expectStatus) {
        throw new Error(`[${label}] positive-control FAILED: reset-preview status ${res.status} !== ${expectStatus}: ${JSON.stringify(res.body)}`)
      }
    },
  )

  return { reconstruct, precheck, contiguity, revertPreview, resetPreview, expectStatus }
}

// ---------------------------------------------------------------------------------------------
// destructive execute (item 5) — one real run each, 1k tier, dedicated throwaway sheets
// ---------------------------------------------------------------------------------------------
async function runDestructiveOp(app: Express, kind: 'revert' | 'reset', seed: TierSeed) {
  const pv = await request(app).post(`/api/multitable/sheets/${seed.sheetId}/${kind}-preview`).send({ asOf: seed.asOfIso })
  if (pv.status !== 200) throw new Error(`[${kind}-execute] preview failed ${pv.status}: ${JSON.stringify(pv.body)}`)
  const previewIdentity = pv.body.data.previewIdentity as string
  const beforeRev = Number((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id=$1', [seed.sheetId])).rows[0].c)
  const beforeTrash = Number((await q('SELECT count(*)::int c FROM meta_records_trash WHERE sheet_id=$1', [seed.sheetId])).rows[0].c)

  const body: Record<string, unknown> = { asOf: seed.asOfIso, previewIdentity }
  if (kind === 'reset') body.confirm = 'reset'
  const t0 = performance.now()
  const ex = await request(app).post(`/api/multitable/sheets/${seed.sheetId}/${kind}-execute`).send(body)
  const wallMs = performance.now() - t0
  if (ex.status !== 200) throw new Error(`[${kind}-execute] execute failed ${ex.status}: ${JSON.stringify(ex.body)}`)

  const afterRev = Number((await q('SELECT count(*)::int c FROM meta_record_revisions WHERE sheet_id=$1', [seed.sheetId])).rows[0].c)
  const afterTrash = Number((await q('SELECT count(*)::int c FROM meta_records_trash WHERE sheet_id=$1', [seed.sheetId])).rows[0].c)

  return {
    wallMs,
    previewSummary: pv.body.data.summary,
    executeResult: ex.body.data,
    revisionsWritten: afterRev - beforeRev,
    trashRowsAdded: afterTrash - beforeTrash,
  }
}

// ---------------------------------------------------------------------------------------------
// cleanup — idempotent, strictly scoped to this run's own BENCH_RUN_ID-namespaced sheet/base/user ids
// (never a table-wide or prefix-LIKE delete). Safe to call even when some/all of the given ids were
// never actually written (a crash before that seed call reached its first INSERT) or were already
// removed by an earlier cleanup pass — DELETE ... WHERE x = ANY($1) / WHERE id = $1 against
// nonexistent ids simply deletes zero rows.
// ---------------------------------------------------------------------------------------------
async function cleanup(sheetIds: string[]): Promise<void> {
  if (sheetIds.length === 0) return
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [sheetIds])
  await q('DELETE FROM meta_records_trash WHERE sheet_id = ANY($1::text[])', [sheetIds])
  await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheetIds]) // cascades records/fields/links/attachments
  await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID])
  await q('DELETE FROM users WHERE id = $1', [ACTOR_ID])
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`R14.C Time Machine scale benchmark — run ${RUN_ID}`)
  console.log(`tiers: ${TIERS.join(', ')}`)

  const realIndexPresentAtStart = await realCandidateIndexExists() // read-only, informational only — never DDL'd
  console.log(
    `[info] real §4 candidate index ("${REAL_CANDIDATE_INDEX_NAME}") present at start: ${realIndexPresentAtStart} ` +
      `— this harness NEVER drops/creates this object. It owns a separate index ("${BENCH_INDEX_NAME}") for the ` +
      "with-index comparison pass instead; that pass reflects whatever the real index's presence/absence already " +
      'is on this DB, on top of the harness-owned one.',
  )

  // Every sheet id below is pushed into `allSheetIds` BEFORE the corresponding seed call runs (not
  // after it returns) — see the header comment's "Cleanup" section: this way, if a seed call throws
  // partway through (e.g. after inserting the sheet/fields rows but before finishing the record/
  // revision bulk insert), the outermost `finally` below still knows to clean up that sheet id.
  const allSheetIds: string[] = []
  const results: Record<string, unknown> = { runId: RUN_ID, tierList: TIERS, realCandidateIndexPresentAtStart: realIndexPresentAtStart }
  const tierResults: Record<number, Record<string, unknown>> = {}
  const seeds: Record<number, TierSeed> = {}

  try {
    allSheetIds.push(PEOPLE_SHEET_ID)
    await ensureBase()
    const personIds = await seedPeopleSheet()
    const app = buildApp()

    await dropBenchIndex() // idempotent defensive drop of the harness-owned index only (never the real one)

    for (const n of TIERS) {
      const sheetId = tierSheetId(n)
      allSheetIds.push(sheetId) // reserved before seeding — see comment above
      console.log(`\n=== seeding tier ${n} ===`)
      const t0 = performance.now()
      const seed = await seedTier(n, personIds)
      const seedMs = performance.now() - t0
      console.log(`seed ${n} took ${seedMs.toFixed(0)}ms (records=${seed.n} cohortB=${seed.cohortBCount} cohortC=${seed.cohortCCount})`)
      seeds[n] = seed
      tierResults[n] = { seedMs, stats: await tierTableStats(seed.sheetId), cohortBCount: seed.cohortBCount, cohortCCount: seed.cohortCCount }
    }

    console.log('\n--- measuring BASELINE (harness-owned bench index ABSENT) ---')
    for (const n of TIERS) {
      tierResults[n].baseline = await measureReadPath(seeds[n], `${n}-baseline`, app)
    }

    if (seeds[10000]) {
      console.log('\n--- EXPLAIN ANALYZE at 10k, baseline (bench index absent) ---')
      results.explainBaseline = {
        reconstruct: await explain(RECONSTRUCT_SQL, [seeds[10000].sheetId, seeds[10000].asOfIso]),
        precheckLatest: await explain(PRECHECK_LATEST_SQL, [seeds[10000].sheetId]),
        contiguity: await explain(CONTIGUITY_SQL, [seeds[10000].sheetId]),
      }
    }

    console.log('\n--- destructive execute at 1k (dedicated throwaway sheets) ---')
    const revertSheetId = tierSheetId(1000, '_revertexec')
    allSheetIds.push(revertSheetId)
    const revertSeed = await seedTier(1000, personIds, '_revertexec')
    results.revertExecute = await runDestructiveOp(app, 'revert', revertSeed)
    console.log(`  revert-execute: ${JSON.stringify(results.revertExecute)}`)

    const resetSheetId = tierSheetId(1000, '_resetexec')
    allSheetIds.push(resetSheetId)
    const resetSeed = await seedTier(1000, personIds, '_resetexec')
    results.resetExecute = await runDestructiveOp(app, 'reset', resetSeed)
    console.log(`  reset-execute: ${JSON.stringify(results.resetExecute)}`)

    if (!SKIP_INDEX_CMP) {
      try {
        await createBenchIndex()
        if (process.env.BENCH_INJECT_FAULT === '1') {
          // TESTING HOOK: fires after seeding + destructive execute + bench-index creation, so a single
          // injected crash exercises BOTH the seeded-row cleanup path AND the bench-index drop path in
          // one run (see header comment). Requires BENCH_SKIP_INDEX_CMP to be unset.
          throw new Error(
            '[self-test] BENCH_INJECT_FAULT=1 — injected fault after seed+execute+bench-index-create, ' +
              'to verify the outermost try/finally still cleans up seeded rows and the harness-owned index on a mid-run crash',
          )
        }
        console.log('\n--- measuring WITH harness-owned bench index PRESENT ---')
        for (const n of TIERS) {
          tierResults[n].withIndex = await measureReadPath(seeds[n], `${n}-withIndex`, app)
        }
        if (seeds[10000]) {
          console.log('\n--- EXPLAIN ANALYZE at 10k, with bench index present ---')
          results.explainWithIndex = {
            reconstruct: await explain(RECONSTRUCT_SQL, [seeds[10000].sheetId, seeds[10000].asOfIso]),
            precheckLatest: await explain(PRECHECK_LATEST_SQL, [seeds[10000].sheetId]),
            contiguity: await explain(CONTIGUITY_SQL, [seeds[10000].sheetId]),
          }
        }
      } finally {
        await dropBenchIndex() // always relinquish the harness-owned resource; never touches the real index
      }
    }

    results.tiers = tierResults
    results.indexSizes = await globalIndexSizes()
    const realIndexPresentAtEnd = await realCandidateIndexExists()
    console.log(
      `\n[info] real §4 candidate index present at end: ${realIndexPresentAtEnd} (start: ${realIndexPresentAtStart}) ` +
        '— unchanged by this harness by construction (never DDL\'d).',
    )

    console.log('\n=== RESULTS (JSON) ===')
    console.log(JSON.stringify(results, null, 2))
  } finally {
    // OUTERMOST cleanup (P1-3): runs whether the try block above completed normally OR threw at ANY
    // point above (mid-seed, mid-measure, mid-execute, mid-index-comparison) — seeded data can never
    // be stranded by a mid-run failure. `dropBenchIndex()` here is a defensive, idempotent no-op in the
    // normal case (the inner finally already dropped it) and a real safety net if the inner finally
    // itself never ran (e.g. a crash before `createBenchIndex()` even started). Cleanup errors are
    // caught and logged here rather than left to propagate, so they can never mask the ORIGINAL error
    // that triggered this finally (if any) — see the top-level `.catch()` below.
    await dropBenchIndex().catch((e) => console.error('[cleanup] dropBenchIndex failed (best-effort):', e))
    if (!KEEP_DATA) {
      console.log('\ncleaning up seeded data...')
      try {
        await cleanup(allSheetIds)
        console.log('cleanup done.')
      } catch (e) {
        console.error('[cleanup] cleanup(allSheetIds) FAILED — seeded rows may be stranded, inspect/clean up manually:', e)
        console.error(`[cleanup] seeded sheet ids were: ${JSON.stringify(allSheetIds)}`)
      }
    } else {
      console.log('\nBENCH_KEEP_DATA=1 set; leaving seeded rows in place for inspection.')
      console.log(`seeded sheet ids: ${JSON.stringify(allSheetIds)}`)
    }
  }
}

main()
  .then(() => {
    console.log('\nbenchmark run complete.')
    return poolManager.close()
  })
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('\nFATAL', e)
    // No index/data restoration needed here: main()'s own outermost try/finally (P1-3) already ran
    // cleanup (including the defensive bench-index drop) before this rejection reached this handler.
    try {
      await poolManager.close()
    } catch {
      /* ignore */
    }
    process.exit(1)
  })
