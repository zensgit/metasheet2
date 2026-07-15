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
 * unless ALL of the following are explicitly satisfied:
 *   1. `BENCH_ALLOW_DESTRUCTIVE=1` is set (first opt-in — acknowledges this is destructive).
 *   2. `DATABASE_URL`'s host is `localhost` / `127.0.0.1` / `::1`, OR `BENCH_ALLOW_REMOTE_DB=1` is
 *      set (second, independent opt-in required to point this at any non-local host).
 *   3. `DATABASE_URL`'s database name has "bench" or "test" as a WHOLE underscore-delimited token (see
 *      `SAFE_DB_NAME_PATTERN` below — a strict, delimiter-anchored match, NOT a bare substring test:
 *      `bench` / `test` / `bench_tm` / `metasheet_test` pass, but `metasheet_latest_prod` / `contest_prod`
 *      do NOT, since "test" there is embedded mid-word with no token boundary), OR
 *      `BENCH_ALLOW_NONSTANDARD_DB_NAME=1` is set (third, independent opt-in required to point this at a
 *      database that doesn't look like a disposable bench/test database).
 *   4. `BENCH_RUN_ID` (if set) matches `^[a-z0-9]{1,16}$` — a bounded, SQL-metacharacter-free charset.
 *      This is checked and enforced by `resolveRunIdOrExit()` (see below), which runs immediately after
 *      `preflightGuard()` and — like it — before any database connection is used. An unset `BENCH_RUN_ID`
 *      auto-generates a safe id in the same charset; a set-but-invalid one exits fail-closed rather than
 *      being silently clamped/sanitized. This id is the sole substring of every DDL statement this
 *      harness ever issues (see `BENCH_INDEX_NAME` below) — validating it here, once, at the source,
 *      makes that interpolation safe without needing per-call escaping.
 * Any of these failing refuses with `process.exit(2)` and a clear message, before a single query runs.
 * There is no scenario in which this harness reaches a write with any of them unmet.
 *
 * **Run-id exclusivity (P1-2):** immediately after the checks above, `acquireRunLockOrExit()` takes a
 * Postgres session-level advisory lock keyed on `hashtext('bench:' || BENCH_RUN_ID)`
 * (`pg_try_advisory_lock`, non-blocking) and holds it, on one dedicated connection, for the entire run —
 * released in the outermost `finally`. A second concurrent invocation with the SAME `BENCH_RUN_ID`
 * cannot acquire the lock and exits fail-closed immediately, before touching anything. Separately (and
 * this is the part that matters even for a NON-concurrent repeat — e.g. a stale run id reused after an
 * earlier crash whose connection has since closed, releasing the lock), `assertRunIdsAvailableOrExit()`
 * queries `meta_bases` / `users` / `meta_sheets` / `pg_indexes` and refuses to proceed if ANY id this run
 * would create already exists — this harness NEVER silently "adopts" (treats as its own) a pre-existing
 * base/user/sheet/index row it did not itself just insert, and correspondingly `ensureBase()` and the
 * sheet-creation inserts use a PLAIN `INSERT` (no `ON CONFLICT ... DO NOTHING`) — a name collision that
 * slips past the assertion (a TOCTOU race) is a fatal unique-violation, not a silent no-op. Cleanup at
 * the end only ever deletes ids this run's own inserts actually, successfully created (tracked in
 * `createdSheetIds` / `baseAndUserCreated`, populated strictly AFTER the corresponding insert succeeds,
 * never speculatively beforehand) — it can never delete an object a prior/other run created. (P1-b,
 * round 6: `ensureBase()`'s base INSERT and user INSERT run on one client inside a single
 * `BEGIN`/`COMMIT` transaction — not as two independently-auto-committed statements — so a failure of
 * the SECOND insert can no longer leave the FIRST one's base row committed-but-untracked; see
 * `ensureBase()` itself for the detail.)
 *
 * **Index safety:** the harness never touches any pre-existing, non-harness-owned database object
 * (specifically: it never DROPs or CREATEs #4262 §4's real candidate index name — see
 * `REAL_CANDIDATE_INDEX_NAME` below, checked read-only, informationally, for context only — never via
 * DDL). For its own "with index" comparison pass it creates and drops a SEPARATE index under a
 * `bench_`-prefixed, `BENCH_RUN_ID`-namespaced name that it owns outright (see `BENCH_INDEX_NAME`) —
 * safe to create/drop freely because no other process or migration can legitimately own an object
 * under that name, AND because `BENCH_RUN_ID` is validated (item 4 above) before it ever reaches that
 * name's DDL text.
 *
 * **Cleanup:** all seeding (sheets/records/revisions/links/trash rows) and the harness-owned bench
 * index happen inside ONE outermost `try { ... } finally { ... }` in `main()`, so a mid-run exception
 * anywhere in the seed/measure/execute pipeline still runs cleanup — seeded data cannot be stranded by
 * a crash partway through. Cleanup is idempotent (deleting rows/ids that were never written, or were
 * already deleted by an earlier cleanup pass, is a no-op) and strictly scoped to ids THIS RUN CONFIRMED
 * IT CREATED (see "Run-id exclusivity" above) — it never touches any object this harness did not itself
 * create. (Note: this defends against a thrown/caught exception mid-run, not an unrecoverable OS-level
 * kill/power-loss — no userspace `finally` can run after that; the verification for this PR simulates
 * the former via `BENCH_INJECT_FAULT`, below.) **Cleanup failures are fatal (P2-3):** every cleanup step
 * (advisory-lock release, bench-index drop, row cleanup) is individually caught and logged, but if ANY
 * of them failed, the outermost `finally` re-throws (after re-throwing/preserving the ORIGINAL run error
 * if there was one) so the process exits non-zero — a cleanup failure can no longer be silently
 * swallowed into a green (`exit 0`) run that actually left data behind. See `BENCH_INJECT_CLEANUP_FAULT`
 * below for the self-test hook.
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
 *   BENCH_ALLOW_NONSTANDARD_DB_NAME=1  required only if the db name doesn't have "bench"/"test" as a whole
 *     underscore-delimited token (see SAFETY item 3 / SAFE_DB_NAME_PATTERN above).
 *   BENCH_TIERS         comma-separated record counts (default "1000,5000,10000,50000")
 *   BENCH_ITERS         override the loop-iteration count for EVERY tier (default: scaled per tier)
 *   BENCH_RUN_ID        override the run id used to namespace all seeded ids — MUST match `^[a-z0-9]{1,16}$`
 *     or the harness exits fail-closed before any DB connection (see SAFETY item 4); omit to auto-generate
 *     a safe one.
 *   BENCH_KEEP_DATA=1   skip cleanup at the end (for post-mortem inspection)
 *   BENCH_SKIP_INDEX_CMP=1  skip the drop/recreate index comparison pass (baseline-only run)
 *   BENCH_INJECT_FAULT=1  TESTING HOOK ONLY: throws a synthetic error after seeding + destructive
 *     execute + bench-index creation (requires BENCH_SKIP_INDEX_CMP to be unset), to prove the
 *     outermost try/finally still cleans up both seeded rows AND the harness-owned index on a
 *     mid-run crash. Never set this in a real measurement run.
 *   BENCH_INJECT_CLEANUP_FAULT=1  TESTING HOOK ONLY: makes the row-cleanup step itself throw (after a
 *     normal, successful run), to prove a cleanup-only failure (no original run error) still forces
 *     `process.exit(1)` instead of silently returning 0 with data left behind (P2-3). Never set this in
 *     a real measurement run — it deliberately strands rows on purpose; clean them up by hand afterward
 *     (same `BENCH_RUN_ID`, `BENCH_KEEP_DATA=1`-style manual query) if you run this self-test.
 *   BENCH_INJECT_USER_INSERT_FAULT=1  TESTING HOOK ONLY (P1-b, round 6): throws inside `ensureBase()`'s
 *     transaction after the base INSERT but before the user INSERT/COMMIT, to prove the base row is
 *     rolled back (never leaked) rather than left committed-but-untracked. Never set this in a real
 *     measurement run.
 */
import { performance } from 'node:perf_hooks'
import express, { type Express } from 'express'
import request from 'supertest'
import type { PoolClient, QueryResultRow } from 'pg'

import { poolManager } from '../../src/integration/db/connection-pool'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { precheckSheetHistoryIntegrity } from '../../src/multitable/history-integrity-precheck'
import { univerMetaRouter } from '../../src/routes/univer-meta'

// ---------------------------------------------------------------------------------------------
// Preflight guard — MUST run, and MUST refuse where warranted, before any DB connection is used.
// See the "SAFETY" section of the header comment above for the exact checks.
// ---------------------------------------------------------------------------------------------

/**
 * Best-effort credential redaction for error messages (P2-5): NEVER print a raw DATABASE_URL, even one
 * that fails to parse — a malformed connection string still typically contains `user:pass@host`, and
 * printing it verbatim leaks the password into logs/CI output. Works via regex (not the `URL`
 * constructor, which is exactly what already failed to parse `raw`) to extract only the scheme and
 * host:port; the credentials segment (if any) is replaced with a fixed placeholder, never echoed.
 */
function redactDatabaseUrl(raw: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/]*@)?([^/?#]*)/.exec(raw)
  if (!m) return '(unparseable — redacted, no recognizable scheme://host prefix)'
  const [, scheme, hostPort] = m
  return `${scheme}://<redacted-credentials>@${hostPort || '<no-host>'}`
}

function parseDatabaseUrlOrExit(raw: string): { host: string; dbName: string } {
  try {
    const u = new URL(raw)
    return { host: u.hostname, dbName: u.pathname.replace(/^\//, '') }
  } catch {
    // P2-5: never print `raw` (or any substring the URL constructor rejected) — it may contain a
    // password. Only the redacted scheme://host form (or a fully generic message) is safe to log.
    console.error(`FATAL: DATABASE_URL is not a parseable URL: ${redactDatabaseUrl(raw)}`)
    process.exit(2)
  }
}

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * Strict, delimiter-anchored db-name allowlist (P1-a fix, round 6): the previous check was a bare
 * substring match (`/bench|test/i`), which accepted any name merely CONTAINING "test" or "bench" as
 * part of a longer word — including prod-looking names like `metasheet_latest_prod` (contains
 * "la-TEST") or `contest_prod` (contains "con-TEST"). Both of the owner's examples slipped past that
 * guard, defeating the "triple fail-closed" claim.
 *
 * This requires "bench" or "test" to appear as a WHOLE underscore-delimited token — bounded on both
 * sides by `_` or by the start/end of the string — so:
 *   - `bench`, `test`, `bench_tm`, `metasheet_test`  → PASS (token boundary satisfied)
 *   - `metasheet_latest_prod`, `contest_prod`        → REJECTED ("test" is embedded mid-word, no
 *                                                       underscore/start/end boundary on both sides)
 * The explicit `BENCH_ALLOW_NONSTANDARD_DB_NAME=1` override remains the escape hatch for any
 * legitimately-named disposable database that doesn't fit this shape.
 */
const SAFE_DB_NAME_PATTERN = /(?:^|_)(?:bench|test)(?:$|_)/i

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
  if (!SAFE_DB_NAME_PATTERN.test(dbName) && process.env.BENCH_ALLOW_NONSTANDARD_DB_NAME !== '1') {
    console.error(
      `FATAL: database name "${dbName}" does not look like a disposable bench/test database — refusing ` +
        'to run against what looks like a real deployment database. "bench" or "test" must appear as a ' +
        'WHOLE underscore-delimited token (bounded by "_" or the start/end of the name) — e.g. "bench", ' +
        '"test", "bench_tm", "metasheet_test" all pass, but a name that merely CONTAINS "test"/"bench" as ' +
        'a substring of a longer word (e.g. "metasheet_latest_prod", "contest_prod") does not.\n' +
        'Set BENCH_ALLOW_NONSTANDARD_DB_NAME=1 to explicitly triple-opt-in and override this check.',
    )
    process.exit(2)
  }
  console.log(`[preflight] OK — host="${host}" db="${dbName}" (all required opt-ins present; refusing otherwise).`)
}

preflightGuard()

// ---------------------------------------------------------------------------------------------
// BENCH_RUN_ID resolution (P1-1) — MUST run, and MUST refuse where warranted, before any DB
// connection is used (same contract as preflightGuard() above; this runs immediately after it and
// before the first `q(...)` call anywhere in the file). RUN_ID is the sole substring interpolated
// into raw DDL text (BENCH_INDEX_NAME, see below) rather than passed as a bind parameter — Postgres
// does not support parameterized identifiers in DDL — so it MUST be restricted to a bounded,
// SQL-metacharacter-free charset here, once, at the source, rather than escaped ad hoc at each call
// site. A user-supplied value that doesn't match is a fail-closed exit, never a silent
// truncate/sanitize/strip — silently coercing an attacker- or typo-supplied value into "something
// that happens to be safe" is itself a footgun (the coerced value may not be the id the caller
// thinks they're using, e.g. for `BENCH_KEEP_DATA=1` post-mortem inspection by run id).
// ---------------------------------------------------------------------------------------------
const BENCH_RUN_ID_PATTERN = /^[a-z0-9]{1,16}$/

/** Generates a fresh id already guaranteed to satisfy BENCH_RUN_ID_PATTERN. */
function generateRunId(): string {
  const t = Date.now().toString(36) // base-36 → [0-9a-z] only, already pattern-safe
  const r = Math.random().toString(36).slice(2, 8) // a few extra base-36 chars to avoid same-ms collisions
  return `${t}${r}`.slice(0, 16)
}

function resolveRunIdOrExit(): string {
  const raw = process.env.BENCH_RUN_ID
  if (raw === undefined || raw === '') {
    const generated = generateRunId()
    console.log(`[preflight] BENCH_RUN_ID not set — generated "${generated}" (matches ${BENCH_RUN_ID_PATTERN}).`)
    return generated
  }
  if (!BENCH_RUN_ID_PATTERN.test(raw)) {
    console.error(
      `FATAL: BENCH_RUN_ID "${raw}" is invalid — must match ${BENCH_RUN_ID_PATTERN} (lowercase ASCII ` +
        'letters/digits only, 1-16 chars). This id is interpolated directly into DDL object names ' +
        '(CREATE/DROP INDEX) rather than passed as a bind parameter, so it must be restricted to a ' +
        "bounded, SQL-metacharacter-free charset — refusing rather than silently sanitizing what you " +
        'passed. The 16-char bound also keeps every derived DDL identifier name well under ' +
        "Postgres's 63-byte identifier limit. Unset BENCH_RUN_ID to auto-generate a safe one, or supply " +
        'a value matching the pattern.',
    )
    process.exit(2)
  }
  return raw
}

// ---------------------------------------------------------------------------------------------
// Env (benchmark-process-only)
// ---------------------------------------------------------------------------------------------
process.env.MULTITABLE_ENABLE_SHEET_REVERT = process.env.MULTITABLE_ENABLE_SHEET_REVERT || 'true'
process.env.MULTITABLE_ENABLE_PIT_RESET = process.env.MULTITABLE_ENABLE_PIT_RESET || 'true'
process.env.RBAC_TOKEN_TRUST = process.env.RBAC_TOKEN_TRUST || 'true'
delete process.env.MULTITABLE_META_REVISION_RETENTION_ENABLED // must stay OFF or reset-preview 409s (RESET_RETENTION_CONFLICT)

const RUN_ID = resolveRunIdOrExit()
const TIERS = (process.env.BENCH_TIERS ? process.env.BENCH_TIERS.split(',').map(Number) : [1000, 5000, 10000, 50000]).filter(
  (n) => Number.isFinite(n) && n > 0,
)
const KEEP_DATA = process.env.BENCH_KEEP_DATA === '1'
const SKIP_INDEX_CMP = process.env.BENCH_SKIP_INDEX_CMP === '1'
const HOUR = 3_600_000
const GLOBAL_T0 = new Date('2024-01-01T00:00:00.000Z').getTime()

const q = <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => poolManager.get().query<T>(sql, params)

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

/**
 * P1-b fix (round 6): the base INSERT and the user INSERT are now issued on ONE dedicated client
 * inside an explicit `BEGIN`/`COMMIT` — previously they were two separate `q(...)` calls (the shared
 * pool's `.query()`, each its own implicit, independently auto-committed statement), so if the SECOND
 * insert failed, the FIRST one's base row was already permanently committed, yet the caller only sets
 * `baseAndUserCreated = true` after BOTH "succeed" — leaving that base row un-tracked and therefore
 * unreachable by `cleanup()` (which is scoped strictly to ids this run confirmed it created). Wrapping
 * both inserts in one transaction makes the pair atomic: either both rows exist (server COMMIT
 * succeeds) or neither does (ROLLBACK on any failure BEFORE the server commits). NOTE (P3, round 7):
 * a lost connection AFTER the server has committed is genuinely indeterminate at the client — the
 * rows may in fact exist while the driver reports an error; so this is "no partial leak of exactly
 * one row", not "a COMMIT error always means nothing was written". IMPORTANT (round 8): there is NO
 * abort-path recheck — the pre-existence assertion runs only BEFORE ensureBase(), and after a COMMIT
 * exception the code only rolls back and rethrows (baseAndUserCreated stays false, so cleanup does not
 * touch base/user). The residual is bounded by ONE property: a *same-BENCH_RUN_ID retry* fail-closes on
 * the pre-existence assertion and refuses. An auto-generated new run id would NOT detect a
 * post-commit-lost-connection leftover. Known, documented, bounded residual (harness is localhost-only,
 * window is a lost connection during COMMIT). See §self-test P1-b (BENCH_INJECT_USER_INSERT_FAULT).
 */
async function ensureBase(): Promise<void> {
  const client = await poolManager.get().getInternalPool().connect()
  try {
    await client.query('BEGIN')
    // P1-2(c): plain INSERT, no ON CONFLICT — assertRunIdsAvailableOrExit() (called earlier in main(),
    // before this function runs) already confirmed neither id exists; a conflict reaching either
    // statement below (a TOCTOU race) is a fatal unique-violation that aborts the whole transaction,
    // never a silent "someone else's row, adopt it" no-op.
    await client.query('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, `TM Bench ${RUN_ID}`])
    if (process.env.BENCH_INJECT_USER_INSERT_FAULT === '1') {
      // TESTING HOOK ONLY (P1-b self-test): fires AFTER the base INSERT above but BEFORE the user
      // INSERT / COMMIT, to prove the base insert is rolled back (never leaked) when the second insert
      // in this transaction never even runs. Never set this in a real measurement run.
      throw new Error(
        '[self-test] BENCH_INJECT_USER_INSERT_FAULT=1 — injected fault between the base INSERT and the ' +
          "user INSERT inside ensureBase()'s transaction, to verify the base row is rolled back, not leaked",
      )
    }
    await client.query("INSERT INTO users (id, password_hash) VALUES ($1,'x')", [ACTOR_ID])
    await client.query('COMMIT')
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // best-effort — the connection may already be broken (e.g. the failure was itself in COMMIT);
      // releasing it below still returns it to the pool, which discards broken connections itself.
    }
    throw e
  } finally {
    client.release()
  }
}

async function seedPeopleSheet(onSheetCreated: (id: string) => void, count = 20): Promise<string[]> {
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [PEOPLE_SHEET_ID, BASE_ID, 'TM Bench People'])
  // P1-2(d): recorded as "confirmed created by this run" only now, right after the insert above
  // succeeded — never speculatively before it, so cleanup can never target an id this run didn't
  // actually create.
  onSheetCreated(PEOPLE_SHEET_ID)
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
async function seedTier(n: number, personIds: string[], onSheetCreated: (id: string) => void, suffix = ''): Promise<TierSeed> {
  const sheetId = tierSheetId(n, suffix)
  const f = fieldIds(n, suffix)
  await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, BASE_ID, `TM Bench ${n}${suffix}`])
  // P1-2(d): recorded as "confirmed created by this run" only now, right after the insert above
  // succeeded — never speculatively before it.
  onSheetCreated(sheetId)
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
  // P1-2(c): plain CREATE INDEX — no IF NOT EXISTS. assertRunIdsAvailableOrExit() (called earlier in
  // main(), before any object this run owns is created) already confirmed this exact name does not
  // exist; a conflict reaching this statement (a TOCTOU race between that check and this call) is a
  // fatal unique-violation, never a silent adopt-and-continue.
  await q(`CREATE INDEX ${BENCH_INDEX_NAME} ON meta_record_revisions (sheet_id, record_id, created_at, version, id)`)
}

// ---------------------------------------------------------------------------------------------
// Run-id exclusivity (P1-2) — advisory lock + non-adoption assertion. Both must run, and both must
// pass, BEFORE this run creates the base/user/sheet/index rows it will later clean up. See the header
// comment's "Run-id exclusivity" paragraph for the full contract; both close the same underlying gap
// from two angles: the lock refuses a genuinely CONCURRENT same-run-id invocation fast; the assertion
// refuses a non-concurrent but colliding run id (e.g. a stale id reused after an earlier crash whose
// connection — and thus whose lock — has since been released).
// ---------------------------------------------------------------------------------------------
let advisoryLockClient: PoolClient | null = null

/**
 * Non-blocking (`pg_try_advisory_lock`) session-level lock keyed on this run's BENCH_RUN_ID, acquired
 * on one dedicated connection held for the run's entire lifetime (released by releaseRunLock() in
 * main()'s outermost `finally`). A second concurrent invocation with the SAME BENCH_RUN_ID cannot
 * acquire this lock and exits fail-closed here — before it creates a single row.
 */
async function acquireRunLockOrExit(): Promise<void> {
  const client = await poolManager.get().getInternalPool().connect()
  const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`bench:${RUN_ID}`])
  if (!res.rows[0]?.locked) {
    client.release()
    console.error(
      `FATAL: could not acquire the advisory lock for BENCH_RUN_ID="${RUN_ID}" — another process already ` +
        'holds it (pg_try_advisory_lock refused). Refusing to run concurrently with, or later adopt/delete ' +
        'objects created by, another run using the same run id.\n' +
        'Use a different BENCH_RUN_ID (or omit it to auto-generate one).',
    )
    process.exit(2)
  }
  advisoryLockClient = client
}

/** Releases the advisory lock and its dedicated connection. Safe to call even if never acquired. */
async function releaseRunLock(): Promise<void> {
  if (!advisoryLockClient) return
  const client = advisoryLockClient
  advisoryLockClient = null
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`bench:${RUN_ID}`])
  } finally {
    client.release()
  }
}

/**
 * Refuses to proceed if ANY id this run is about to create (the base, the user, every reserved sheet
 * id, the harness-owned bench index) already exists — this harness must never silently "adopt" (treat
 * as its own, and later delete) an object it did not itself just insert. Must be called, and must
 * pass, before ensureBase() / seedPeopleSheet() / seedTier() / createBenchIndex() run.
 */
async function assertRunIdsAvailableOrExit(reservedSheetIds: string[]): Promise<void> {
  const conflicts: string[] = []

  const baseRows = await q('SELECT id FROM meta_bases WHERE id = $1', [BASE_ID])
  if (baseRows.rows.length > 0) conflicts.push(`meta_bases.id = ${BASE_ID}`)

  const userRows = await q('SELECT id FROM users WHERE id = $1', [ACTOR_ID])
  if (userRows.rows.length > 0) conflicts.push(`users.id = ${ACTOR_ID}`)

  if (reservedSheetIds.length > 0) {
    const sheetRows = await q<{ id: string }>('SELECT id FROM meta_sheets WHERE id = ANY($1::text[])', [reservedSheetIds])
    if (sheetRows.rows.length > 0) {
      conflicts.push(`meta_sheets.id IN (${sheetRows.rows.map((r) => r.id).join(', ')})`)
    }
  }

  const idxRows = await q('SELECT indexname FROM pg_indexes WHERE indexname = $1', [BENCH_INDEX_NAME])
  if (idxRows.rows.length > 0) conflicts.push(`pg_indexes.indexname = ${BENCH_INDEX_NAME}`)

  if (conflicts.length > 0) {
    console.error(
      `FATAL: object(s) already exist for BENCH_RUN_ID="${RUN_ID}" — refusing to proceed, since this run ` +
        'would then either fail on its own insert or (worse) later delete an object it did not create: ' +
        `${conflicts.join('; ')}.\n` +
        'This usually means a previous run with the same BENCH_RUN_ID crashed before its own cleanup ran, ' +
        'or an id collided by chance. Use a different BENCH_RUN_ID (or omit it to auto-generate one) — ' +
        'never re-run with a colliding id.',
    )
    process.exit(2)
  }
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
// cleanup — idempotent, strictly scoped to ids THIS RUN CONFIRMED IT CREATED (P1-2(d): `sheetIds` is
// `createdSheetIds` from main(), populated only after each corresponding INSERT succeeded — never a
// speculative "about to seed" list — and `baseAndUserCreated` gates the base/user deletes the same
// way). Never a table-wide or prefix-LIKE delete. Safe to call even when some/all of the given ids
// were already removed by an earlier cleanup pass — DELETE ... WHERE x = ANY($1) / WHERE id = $1
// against nonexistent ids simply deletes zero rows.
// ---------------------------------------------------------------------------------------------
async function cleanup(sheetIds: string[], baseAndUserCreated: boolean): Promise<void> {
  if (process.env.BENCH_INJECT_CLEANUP_FAULT === '1') {
    // TESTING HOOK ONLY (P2-3 self-test): thrown before any DELETE below, so this run's rows are left
    // stranded on purpose — proves a cleanup-only failure (no original run error) still forces
    // main()'s outermost finally to exit the process non-zero instead of silently returning 0. See the
    // header comment's BENCH_INJECT_CLEANUP_FAULT entry. Never set this for a real measurement run.
    throw new Error(
      '[self-test] BENCH_INJECT_CLEANUP_FAULT=1 — injected fault inside cleanup() itself, to verify a ' +
        "cleanup-only failure (the run otherwise succeeded) still forces process.exit(1) rather than exit(0)",
    )
  }
  if (sheetIds.length > 0) {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [sheetIds])
    await q('DELETE FROM meta_records_trash WHERE sheet_id = ANY($1::text[])', [sheetIds])
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheetIds]) // cascades records/fields/links/attachments
  }
  if (baseAndUserCreated) {
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID])
    await q('DELETE FROM users WHERE id = $1', [ACTOR_ID])
  }
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function main() {
  console.log(`R14.C Time Machine scale benchmark — run ${RUN_ID}`)
  console.log(`tiers: ${TIERS.join(', ')}`)

  // Every sheet id this run WOULD create, computed up front (pure JS, no DB) so
  // assertRunIdsAvailableOrExit() can check all of them before this run creates anything. Note the
  // 1k revert/reset-execute sheets are reserved unconditionally — item 5 always seeds a dedicated 1k
  // tier for those regardless of what's in BENCH_TIERS.
  const reservedSheetIds = [
    PEOPLE_SHEET_ID,
    ...TIERS.map((n) => tierSheetId(n)),
    tierSheetId(1000, '_revertexec'),
    tierSheetId(1000, '_resetexec'),
  ]

  // `createdSheetIds` / `baseAndUserCreated` / `benchIndexCreated` are populated ONLY after the
  // corresponding INSERT/CREATE INDEX actually, successfully ran (P1-2(d)) — never speculatively
  // beforehand — so the `finally` below can never clean up (or unlock) something this run did not
  // itself create/acquire.
  const createdSheetIds: string[] = []
  let baseAndUserCreated = false
  let benchIndexCreated = false
  const results: Record<string, unknown> = { runId: RUN_ID, tierList: TIERS }
  const tierResults: Record<number, Record<string, unknown>> = {}
  const seeds: Record<number, TierSeed> = {}

  let originalError: unknown = null
  try {
    // P1-2(a)+(b): acquire the run-id advisory lock, then assert none of this run's ids already
    // exist — BOTH must pass before anything below creates a single row. See the header comment's
    // "Run-id exclusivity" paragraph.
    await acquireRunLockOrExit()
    await assertRunIdsAvailableOrExit(reservedSheetIds)

    const realIndexPresentAtStart = await realCandidateIndexExists() // read-only, informational only — never DDL'd
    results.realCandidateIndexPresentAtStart = realIndexPresentAtStart
    console.log(
      `[info] real §4 candidate index ("${REAL_CANDIDATE_INDEX_NAME}") present at start: ${realIndexPresentAtStart} ` +
        `— this harness NEVER drops/creates this object. It owns a separate index ("${BENCH_INDEX_NAME}") for the ` +
        "with-index comparison pass instead; that pass reflects whatever the real index's presence/absence already " +
        'is on this DB, on top of the harness-owned one.',
    )

    await ensureBase()
    // P1-b: ensureBase() returns normally only after its transaction reports a successful COMMIT of
    // both the base row and the user row; a failure before the server commits throws (after ROLLBACK).
    // So reaching this line means the pair is atomic — never "only one of the two exists". (P3 caveat,
    // round 8: a connection dropped AFTER a server-side commit is indeterminate — a leftover pair may
    // exist. There is NO abort-path recheck; the ONLY backstop is a same-run-id retry hitting the
    // pre-existence assertion. An auto-generated new run id would not detect it. Bounded, localhost-only.)
    baseAndUserCreated = true
    const personIds = await seedPeopleSheet((id) => createdSheetIds.push(id))
    const app = buildApp()

    for (const n of TIERS) {
      console.log(`\n=== seeding tier ${n} ===`)
      const t0 = performance.now()
      const seed = await seedTier(n, personIds, (id) => createdSheetIds.push(id))
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
    const revertSeed = await seedTier(1000, personIds, (id) => createdSheetIds.push(id), '_revertexec')
    results.revertExecute = await runDestructiveOp(app, 'revert', revertSeed)
    console.log(`  revert-execute: ${JSON.stringify(results.revertExecute)}`)

    const resetSeed = await seedTier(1000, personIds, (id) => createdSheetIds.push(id), '_resetexec')
    results.resetExecute = await runDestructiveOp(app, 'reset', resetSeed)
    console.log(`  reset-execute: ${JSON.stringify(results.resetExecute)}`)

    if (!SKIP_INDEX_CMP) {
      try {
        await createBenchIndex()
        benchIndexCreated = true // CREATE INDEX above succeeded — confirmed created by this run
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
        // Always relinquish the harness-owned resource as soon as this inner pass is done (never
        // touches the real index); the outermost finally below is a defensive backstop, gated on
        // `benchIndexCreated`, for the case where the try above threw BEFORE reaching this point.
        if (benchIndexCreated) {
          await dropBenchIndex()
          benchIndexCreated = false
        }
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
  } catch (e) {
    // Captured (not re-thrown here) so the cleanup pass below always runs and can log its own
    // failures without them masking this original error — it is re-thrown, unmodified, at the end of
    // the `finally` block (P2-3).
    originalError = e
  } finally {
    // OUTERMOST cleanup (P1-3): runs whether the try block above completed normally OR threw at ANY
    // point above (mid-seed, mid-measure, mid-execute, mid-index-comparison) — seeded data can never
    // be stranded by a mid-run failure. Every step below is individually caught and logged so one
    // failing step doesn't stop the others from running. `dropBenchIndex()` here only fires if
    // `benchIndexCreated` is still true — i.e. either the inner try/finally above never ran (a crash
    // before `createBenchIndex()`), or it ran but failed to clear the flag.
    const cleanupErrors: unknown[] = []

    if (benchIndexCreated) {
      try {
        await dropBenchIndex()
      } catch (e) {
        cleanupErrors.push(e)
        console.error('[cleanup] dropBenchIndex failed:', e)
      }
    }

    if (!KEEP_DATA) {
      console.log('\ncleaning up seeded data...')
      try {
        await cleanup(createdSheetIds, baseAndUserCreated)
        console.log('cleanup done.')
      } catch (e) {
        cleanupErrors.push(e)
        console.error('[cleanup] cleanup(createdSheetIds) FAILED — seeded rows may be stranded, inspect/clean up manually:', e)
        console.error(`[cleanup] created sheet ids were: ${JSON.stringify(createdSheetIds)}`)
      }
    } else {
      console.log('\nBENCH_KEEP_DATA=1 set; leaving seeded rows in place for inspection.')
      console.log(`created sheet ids: ${JSON.stringify(createdSheetIds)}`)
    }

    try {
      await releaseRunLock()
    } catch (e) {
      cleanupErrors.push(e)
      console.error('[cleanup] releaseRunLock failed:', e)
    }

    // P2-3: a cleanup failure must never be silently swallowed into a green (exit 0) run. If the try
    // block above ALSO threw, that original error takes priority (re-thrown unmodified — never masked
    // by a cleanup error, only accompanied by one logged above); otherwise, if cleanup itself is the
    // only thing that failed, throw here so the top-level `.catch()` below still exits non-zero.
    if (originalError) {
      if (cleanupErrors.length > 0) {
        console.error(
          `[cleanup] ${cleanupErrors.length} cleanup step(s) ALSO failed while handling the error above — see logs; ` +
            'the original error is what will be reported/exit non-zero.',
        )
      }
      throw originalError
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `[cleanup] ${cleanupErrors.length} cleanup step(s) failed after an otherwise-successful run — see the ` +
          'logged errors above. Exiting non-zero so this can never be silently reported as a clean run.',
      )
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
