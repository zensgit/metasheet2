# R14.C — Time Machine real-scale benchmark (multitable) — 2026-07-14

**Status:** evidence + analysis only. **No product decision is made here** — R14 (Option A "base-wide
atomic restore" vs Option B "granular operation-level recovery") stays an owner decision; this MD
supplies the measured numbers the R14 call and the [#4262 v2 design lock](https://github.com/zensgit/metasheet2/pull/4262)'s
§1 O(n)-window / §4 supporting-index forks need.

**Model dispatch:** built and run by a Sonnet agent (harness code + execution + this write-up), per the
owner's model-split policy for benchmark/impl lanes. No Opus adversarial gate has reviewed this MD;
treat the numbers as measured evidence, not a ratified design artifact.

**Harness:** [`packages/core-backend/scripts/bench/timemachine-scale-bench.ts`](../../packages/core-backend/scripts/bench/timemachine-scale-bench.ts)
(tsx, not wired into CI — a load benchmark run by hand). Re-runnable, idempotent per `BENCH_RUN_ID`,
seeds/measures/cleans up its own throwaway sheets.

## 0. Environment (read this before trusting any number)

- **Local scratch PG**, `postgresql://postgres:pw@localhost:55888/metasheet_test` — a single dev
  instance, not a production-shaped cluster (no replicas, no realistic concurrent load, single
  connection pool, `DB_POOL_MAX` default). **Numbers are relative (cross-tier, cross-op), not
  absolute** — do not read "50k reconstruct = 122–183ms" as a production SLA.
- The table `meta_record_revisions` is **shared** across many past benchmark/dev sessions on this
  scratch DB — at the time of these runs it held ~1,000–35,000 baseline rows from unrelated prior
  work before this harness added its own throwaway sheets on top. Every measured query is scoped by
  `sheet_id = $1`, so correctness is unaffected, but the table's physical size (see §6) reflects
  cumulative churn, not a clean single-tenant table.
- **Flags:** `MULTITABLE_ENABLE_SHEET_REVERT=true` and `MULTITABLE_ENABLE_PIT_RESET=true` were set in
  the **benchmark process's own env only**. Both are default-OFF on `main` (the interim revert-execute
  master gate from #4261, and the reset-execute flag from the original T8-2 design) — this benchmark
  does not flip anything in a real deployment, and the flags revert the moment the process exits.
  `MULTITABLE_META_REVISION_RETENTION_ENABLED` was left unset (retention off), since reset-preview
  409s (`RESET_RETENTION_CONFLICT`) when retention is on.
- **Auth:** the harness builds the multitable router in-process (`express()` + `univerMetaRouter()`)
  and injects `req.user = { id, roles:['member'], perms:['multitable:read','multitable:write',
  'multitable:share'] }` directly — the exact fixture pattern the repo's own
  `multitable-*-realdb.test.ts` suite already uses (see e.g. `multitable-reset-pit-realdb.test.ts`).
  It does not drive a real HTTP server through JWT/`RBAC_TOKEN_TRUST`; the object under measurement is
  route + DB compute latency, not auth-middleware overhead. `RBAC_TOKEN_TRUST=true` is still set in the
  process env for parity with the task's documented environment, but this harness does not depend on it.
- **Two full runs** were executed for stability (`BENCH_RUN_ID=r14c1` and `r14c2b`); a third invocation
  (`r14c2`) was aborted and discarded after it was accidentally run concurrently with an ad hoc index
  probe that also drops/creates the same index — see §4 footnote. Both reported runs ran standalone.

## 1. Seeding model

Each tier seeds one throwaway sheet with `N` records (5 fields: `Name` string, `Amount` number,
`Status` string, `Owner` link → a shared 20-row "People" reference sheet, `Score` formula — present so
the precheck's derived-field exclusion (`DERIVED_FIELD_TYPES`) is exercised at scale, not just in a
unit test) and three cohorts of realistic revision chains, built with bulk `UNNEST`-array `INSERT`s
(chunked at 5,000 rows) — seeding is setup, not the measurement:

| Cohort | Share | Chain | Purpose |
|---|---|---|---|
| A | ~85% | create → update → update (3 revisions, no delete) | the common case |
| B | ~9.5% (`i % 10 == 0`) | create → update → update → **delete** → **create** → update (6 revisions, 2 generations, version resets to 1 post-restore — matches `record-service.ts`'s real `restoreRecord`/undelete version semantics) | multi-generation chains, per the task's "~10% delete→restore" requirement |
| C | ~5% (first `0.05·N` ids) | a single create, timestamped **after** `asOf` | populates revert's `keptCreatedAfterT` bucket and reset's delete-set with real rows |

Timestamps: each record's own T0 = a fixed `GLOBAL_T0` + `i` ms (negligible next to the hour-scale
deltas below); revisions land at T0+0 / +1h / +2h / (+3h delete / +4h restore-create / +5h restore-update
for cohort B) / +6h for cohort C's single create. `asOf` = `GLOBAL_T0 + 1.5h`, chosen so cohort A/B
reconstruct to their **v2** (post-first-update) snapshot at T, and cohort C is **absent** from the T
reconstruction (created strictly after). This gives every measured tier a genuine diff to compute (not
a no-op preview) and a genuine delete-set for reset, without any hand-tuned per-tier logic.

**Positive controls** (silent-wrong-path is the single biggest risk in a benchmark like this — see the
harness's own `assertFn` on every `timeLoop` call): every `reconstructRecordsAtT` call asserts
`map.size === N − cohortC`; every `precheckSheetHistoryIntegrity` call asserts `verdict.ok === true`
(live `meta_records.data` is seeded as a literal copy of the record's last revision snapshot, so a
healthy sheet never trips rule 2's content-mismatch or rule 3's zero-revision/live-after-delete
refusals — the precheck therefore does a **full** scan every iteration, not an early-exit on the first
bad record); every preview/refusal call asserts the expected HTTP status (200 below the ceiling, 413
above it). All of these held on every iteration of both runs — no assertion failures, no silent
wrong-path measurements.

## 2. Results — read path (baseline: §4 candidate index ABSENT = main-parity)

`reconstructRecordsAtT`, `precheckSheetHistoryIntegrity`, and the v2 contiguity prototype (§4) are pure
functions/SQL called directly (no HTTP); `revert-preview`/`reset-preview` go through the real Express
route. All times in ms, p50/p95 over the iteration counts shown (30/20/15/8 for 1k/5k/10k/50k).

| Tier (N) | Op | run1 p50 | run1 p95 | run2b p50 | run2b p95 |
|---|---|---|---|---|---|
| 1,000 | reconstructRecordsAtT | 2.73 | 6.54 | 1.74 | 2.48 |
| 1,000 | precheckSheetHistoryIntegrity | 5.24 | 7.42 | 3.95 | 6.91 |
| 1,000 | contiguity prototype | 7.01 | 10.38 | 3.19 | 4.09 |
| 1,000 | revert-preview (200) | 19.03 | 30.72 | 14.90 | 21.44 |
| 1,000 | reset-preview (200) | 17.42 | 25.05 | 14.66 | 17.17 |
| 5,000 | reconstructRecordsAtT | 12.91 | 16.24 | 12.73 | 18.05 |
| 5,000 | precheckSheetHistoryIntegrity | 28.76 | 65.58 | 28.38 | 33.03 |
| 5,000 | contiguity prototype | 22.73 | 26.77 | 23.91 | 27.27 |
| 5,000 | revert-preview (200) | 70.92 | 191.55 | 62.77 | 67.98 |
| 5,000 | reset-preview (200) | 66.66 | 156.37 | 59.20 | 63.75 |
| 10,000 | reconstructRecordsAtT | 27.48 | 54.33 | 29.86 | 36.68 |
| 10,000 | precheckSheetHistoryIntegrity | 60.14 | 113.29 | 69.73 | 87.47 |
| 10,000 | contiguity prototype | 50.89 | 94.48 | 50.47 | 55.99 |
| 10,000 | revert-preview (**413**) | 2.20 | 4.04 | 2.36 | 3.75 |
| 10,000 | reset-preview (**413**) | 2.08 | 2.44 | 2.22 | 2.83 |
| 50,000 | reconstructRecordsAtT | 182.76 | 346.36 | 121.83 | 149.62 |
| 50,000 | precheckSheetHistoryIntegrity | 171.57 | 334.75 | 212.03 | 250.75 |
| 50,000 | contiguity prototype | 219.84 | 247.53 | 214.47 | 223.73 |
| 50,000 | revert-preview (**413**) | 3.73 | 7.30 | 9.81 | 13.38 |
| 50,000 | reset-preview (**413**) | 3.96 | 4.60 | 9.16 | 13.06 |

50k was **not** skipped — seeding took 18.0s (run1) / 4.7s (run2b; the gap is warm-cache/pool-state
variance between runs, not a measured metric) and all measurements completed cleanly. Run-to-run
variance is generally 10–25% at the p50 level (this single dev-box PG, not isolated hardware), larger
at p95 (single-digit-ms ops are dominated by scheduler/GC noise at that scale — see 50k revert/reset-preview
p50 3.7–9.8ms, a ~2.6x spread that is still "a few ms," i.e. noise around a very small true value, not
a regression). The **413 ceiling refusal itself is fast in every case** (1.6–13.4ms, never anywhere
near a timeout) — see §5(d).

## 3. §4 candidate index — measured, and why it made ~no difference

The scratch DB already had an index that is **exactly** the shape the [#4262 v2 design lock §4](https://github.com/zensgit/metasheet2/pull/4262)
would need:

```
idx_meta_record_revisions_sheet_record_created_version_id
  btree (sheet_id, record_id, created_at, version, id)
```

**This index is NOT in any migration on `origin/main`** (`git log --all -S` traces it to a paused,
explicitly "do not build on" W0-1 implementation draft, commit `d7637986b` — its migration file never
merged, but its `CREATE INDEX` had already been run by hand against this shared scratch DB at some
point). To avoid silently reporting an index-assisted number as "main behavior," every read-path op
above was measured **twice**: once with this index **dropped** (main-parity — the §2 table) and once
with it **recreated** (the "§4 index applied" comparison). The index is dropped at harness start and
unconditionally recreated in a `finally` block so a crash cannot leave the shared DB worse than found;
both runs confirmed `present at end == present at start (true)`.

Result: **no consistent improvement** from having the index. At 10k, for example (run1):
reconstruct 27.48ms → 26.26ms, precheck 60.14ms → 56.52ms, contiguity 50.89ms → 48.55ms — all within
run-to-run noise, not a real effect. `EXPLAIN (ANALYZE, BUFFERS)` at 10k (both runs, both index
states) shows why: **the planner never selects this index for any of the three queries**, in either
state. It consistently picks `idx_meta_record_revisions_sheet_batch` (a `(sheet_id, batch_id)` index)
for a Bitmap Heap Scan restricted to the sheet, then an explicit `Sort` to satisfy the query's
`ORDER BY`:

```
-- reconstructRecordsAtT @ 10k, index PRESENT (run1)
Unique  (cost=12760.84..15152.30 rows=17974 width=293) (actual time=16.479..23.147 rows=9500 loops=1)
  ->  Gather Merge  ...
        ->  Sort  (actual time=7.896..8.370 rows=6333 loops=3)
              Sort Key: record_id, created_at DESC, version DESC, id DESC
              ->  Parallel Bitmap Heap Scan on meta_record_revisions  (actual time=0.272..2.523 rows=6333 loops=3)
                    ->  Bitmap Index Scan on idx_meta_record_revisions_sheet_batch
Execution Time: 23.723 ms
```

**Why the ASC-only composite index can't help the reconstructor/precheck queries at all**: their
`ORDER BY record_id, created_at DESC, version DESC, id DESC` is a *mixed-direction* sort relative to
the index's all-ascending column order — a single btree scan (forward or backward) can only satisfy a
sort where every non-equality column agrees in direction; here `record_id` wants ASC while
`created_at`/`version`/`id` want DESC, so no single scan direction over this index can produce the
required order. As a quick side probe (not part of the official two runs, done on a throwaway 10k
sheet and cleaned up afterward), a **DESC-matching** variant —
`(sheet_id, record_id, created_at DESC, version DESC, id DESC)`, i.e. the exact direction the query
needs — was also **not** selected; Postgres fell back to a `Seq Scan` on the whole (bloated, see §6)
table instead of even the `sheet_batch` bitmap path, which is a related-but-different point about this
DB's current physical state, not a new negative result about the index shape.

**Where a supporting index *would* line up**: the contiguity prototype's own `ORDER BY record_id,
created_at, version, id` (all ascending, feeding the window function) matches the existing composite
index's column order exactly — and the planner still declined it, preferring bitmap-scan-then-sort at
this per-sheet row count (10k–50k). Two readings, both left open for the owner/#4262 rather than
resolved here: (1) at these per-sheet scales, on this table's current physical layout, a full sort is
genuinely cheaper than an index-ordered scan, so the §4 index is not urgent; or (2) a production-scale
table (many more sheets, different cache pressure, different physical correlation) could tip the
planner the other way, and this should be re-checked against a production-shaped copy before deciding
either way. **This benchmark does not resolve which reading is correct — it only establishes that,
on this environment, neither the ASC-only nor the DESC-matching index changed the measured latency.**
One structural note that does carry over regardless of planner choice: the design's own move from
`(created_at, version, id)` to a single persistent monotonic `seq` (§1 of the v2 lock) turns this from
a 3-key mixed-type sort into a single-key integer sort, which is mechanically cheaper to sort on and a
better index candidate in principle — independent of whether Postgres chooses to use an index for it
in this environment today.

## 4. Destructive execute (1k tier, dedicated throwaway sheets, real writes)

One real run each per harness invocation (destructive — can't be looped for percentiles without
re-seeding each time; the two independent full-harness runs are the "at least twice" stability check
here). Same seed shape as the 1k tier: 950 records get a content revert (cohort A+B), 50 records
(cohort C, created after `asOf`) are revert's `keptCreatedAfterT` / reset's delete-set.

| Metric | revert-execute (run1) | revert-execute (run2b) | reset-execute (run1) | reset-execute (run2b) |
|---|---|---|---|---|
| wall time | 4,332ms | 3,864ms | 390ms | 407ms |
| records reverted | 950 | 950 | 950 | 950 |
| records deleted | 0 (not applicable — revert never deletes) | 0 | 50 | 50 |
| new revisions written | 950 | 950 | 1,000 (950 update + 50 delete) | 1,000 |
| ms / record touched | ~4.56 | ~4.07 | ~0.39 | ~0.41 |
| transaction shape | **per-record** — each `patchRecords` call is its own transaction (loop at `univer-meta.ts` ~:10295) | same | **single transaction** wrapping every revert-update AND every delete (`pool.transaction` at ~:10426) | same |

**This ~10–11x gap is the single most decision-relevant number in this benchmark.** It is not noise —
it reproduced within ~12% across two independent runs, and it has a structural explanation already on
record: the [#4262 v2 design lock](https://github.com/zensgit/metasheet2/pull/4262) §9 item 1 itself
flags revert-execute's per-record loop as an "honest deferral" — *"needs an outer-txn refactor... until
then the #4261 default-off gate is the operative protection."* reset-execute's existing single-transaction
pattern (already shipped, already exercised by the T8-2 real-DB test suite) is the empirically faster
**and** the only genuinely atomic one of the two.

## 5. Table/index stats

| Tier (N) | live records | revisions written |
|---|---|---|
| 1,000 | 1,000 | 3,185 |
| 5,000 | 5,000 | 15,925 |
| 10,000 | 10,000 | 31,850 |
| 50,000 | 50,000 | 159,250 |

`meta_record_revisions` index sizes (whole shared table, not per-sheet) grew between the two runs —
run1: `sheet_batch` 368kB / `sheet_record_created_version_id` (the §4 candidate) 1,280kB /
`sheet_record_version` 1,216kB / pkey 400kB; run2b (after run1's data was cleaned up but with more
cumulative churn from run1 + the index probe in between): `sheet_batch` 3,488kB / candidate 22MB /
`sheet_record_version` 54MB / pkey 13MB. This ~15–40x growth in absolute index size for the same
logical row counts is **table bloat from repeated seed/cleanup cycles on this shared scratch table**
(confirmed via `pg_stat_user_tables`: 0 dead tuples after a recent autovacuum, but ~265MB of physical
table size for ~35k live rows at one point during this session) — an artifact of this benchmark's own
iteration, not a property of the reconstructor/precheck logic. Absolute index-size numbers in this
report should be read as "same order of magnitude, this dev box," not as production sizing.

## 6. Analysis (evidence only — R14 decision stays with the owner)

**(a) Option A — base-wide atomic restore, feasibility at 50k+ across multiple sheets.** Using
reset-execute's real single-transaction pattern as the empirical anchor (§4: ~0.4ms per record-write,
atomic, reproduced across two runs) and extrapolating **linearly** (a stated simplification — it
ignores lock-contention growth, WAL/checkpoint pressure, and larger in-memory sort costs at higher N,
all of which tend to make large transactions *worse* than linear, not better):
- 10,000 records ≈ 10 × 0.4ms/record × 1,000 ≈ **~4 seconds** of transaction time for the writes alone.
- 50,000 records ≈ **~20 seconds**.
- A *base-wide* restore spanning multiple sheets (e.g. 10 sheets × 5,000 records) would need to extend
  the transaction boundary across sheets (today's reset-execute is single-sheet), but the per-record
  write cost measured here is the right order-of-magnitude building block: ~10 sheets × 5,000 records
  ≈ 50,000 records total ≈ the same **~20 second** ballpark, plus the read-side compute (reconstruct +
  precheck + contiguity) per sheet, which is comparatively cheap even at 50k (150–350ms per sheet,
  §2) — the write work dominates, not the read/verify work.
- A ~20-second single transaction holding row locks (and, if the [v2 design lock](https://github.com/zensgit/metasheet2/pull/4262)
  §5's proposed shared sheet-writer fence is adopted, blocking **all** concurrent writes to the
  affected sheet(s) for that whole window) is a real but bounded cost — plausibly acceptable for an
  explicit, user-initiated, rare "restore this base" action, but not something to run casually inline
  with normal traffic. This is consistent with (and reinforces) the design lock's own framing of Option
  A as "the full W0 trustworthiness build," not a headline slice.
- **revert-execute's current per-record-transaction pattern is not a viable template for Option A as
  measured** (~3.6 minutes extrapolated at 50k, and non-atomic — a crash mid-loop leaves a partially
  reverted sheet). If Option A is chosen, the write path should follow reset-execute's already-atomic
  shape (or the design lock's own proposed txn/fence refactor), not revert-execute's current shape.

**(b) Option B — granular operation-level recovery.** The read-path numbers (§2) directly size this:
reconstructing or precheck-validating a single sheet at realistic scale (1k–50k records) costs single-
to-low-triple-digit milliseconds, cheap enough to run synchronously per-operation (per-record,
per-field, per-sheet) without an async job, which is exactly Option B's premise. Nothing in this
benchmark suggests granular recovery has a scale problem in the ranges tested; its cost profile scales
with the size of the *targeted* scope, not the whole base, by construction.

**(c) The v2 contiguity window-function cost, and the §4 supporting index.** The per-generation
contiguity prototype (§3) costs roughly the same as the existing precheck's own latest-revision scan
at every tier (both are dominated by a full per-sheet sort — see the `EXPLAIN` output in §3, where the
`Sort` node is 25–47ms of a 35–53ms total at 10k) — i.e. adding generation-aware contiguity checking on
top of today's live-vs-latest precheck is **not** introducing a new order-of-magnitude cost; it is
roughly the same shape of work the precheck already pays. The O(n)-window concern in #4262 §1 is real
in the sense that this is an O(n log n) sort-then-scan per sheet, confirmed to scale from ~7ms (1k) to
~220ms (50k) across two runs — but it does not blow up superlinearly in the tested range, and it is not
materially worse than the precheck cost already paid on every revert/reset preview and execute today.
**On the §4 supporting index specifically: this benchmark could not demonstrate a benefit from either
an ASC-ordered or a DESC-matching composite index at 10k-per-sheet scale on this dev DB** — the planner
consistently chose bitmap-scan-then-sort over both index shapes (§3). This is evidence against treating
the index as an urgent prerequisite, but it is evidence from one dev box's current table state, not a
production-scale test; re-verify against a production-shaped copy (many sheets, realistic cache
pressure) before ruling the index out. Independent of the index question, the design's own move to a
single persistent monotonic `seq` (replacing the 3-key `(created_at, version, id)` tuple) is still the
right simplification for the sort itself — a single-key integer sort is cheaper to perform and a
cleaner index target than a 3-key mixed-type tuple, regardless of what the planner does with either
index today.

**(d) Is the >5,000 async-job requirement (SC.1) confirmed?** **Yes, on two independent lines of
evidence.** First, the *existing* fail-closed 413 refusal above `SHEET_REVERT_MAX_RECORDS` (default
5,000) is itself fast in every measured case (1.6–13.4ms at 10k/50k, §2) — so today's ceiling is not
masking a slow path; it refuses cheaply, exactly as designed. Second, and more importantly: **if the
ceiling were simply raised or removed**, the write-side cost extrapolated in (a) — ~20 seconds at 50k
for the atomic (reset-execute-shaped) pattern, ~3.6 minutes for the current non-atomic (revert-execute-
shaped) pattern — is well past what a synchronous HTTP request/response should hold open (typical
gateway/load-balancer timeouts sit in the 30–60s range, and a multi-minute held transaction risks lock-
contention pileups on a live table regardless of gateway timeouts). The data confirms that >5,000-record
recovery needs to move to an async job with progress/cancel semantics (SC.1, and the R13-C design
lock's own framing) rather than simply raising the synchronous ceiling — this holds whether Option A or
Option B is chosen, since both would eventually need to process more than 5,000 records per operation
at scale.

## 7. Reproduce

```bash
DATABASE_URL=postgresql://postgres:pw@localhost:55888/metasheet_test \
  npx tsx packages/core-backend/scripts/bench/timemachine-scale-bench.ts
```

Env knobs: `BENCH_TIERS` (default `1000,5000,10000,50000`), `BENCH_ITERS` (override loop count for
every tier), `BENCH_RUN_ID` (namespaces all seeded ids — must be unique per concurrent invocation; see
the caveat below), `BENCH_KEEP_DATA=1` (skip cleanup for inspection), `BENCH_SKIP_INDEX_CMP=1`
(baseline-only, skip the drop/recreate-index comparison pass).

**Concurrency caveat (learned the hard way during this session):** the harness drops and recreates a
**global** index (`idx_meta_record_revisions_sheet_record_created_version_id`) as part of its baseline
methodology. Two harness invocations (or a harness run and any ad hoc `EXPLAIN`/index probe) must
**never** run concurrently against the same database — one can observe or restore the index mid-measurement
of the other. Run invocations sequentially. (This is why the two official runs reported here are
`r14c1` and `r14c2b` — an interim `r14c2` was aborted mid-run after it overlapped with a manual index
probe, and discarded rather than reported.)
