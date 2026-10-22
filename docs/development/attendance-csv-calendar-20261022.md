# Attendance CSV import calendar closure

Refs #6003; #6014 is historical reference only. R71 candidate; Draft only.

Dependency: #6490 at `5ca5b36da16d6f22d7fa2dac1350a41b4be401d4`.
Main baseline: `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`.
This branch inherits the reviewed pure-profile candidate preflight and reuses its
canonical calendar resolver. The dependency has not merged.

## Contract

CSV epoch seconds/milliseconds and offset-qualified dates denote instants. Preserve
them until the subject-specific rotation, published shift or rule timezone selects
the work date. Explicit calendar dates and naive/time-only punches retain existing
semantics. Payload timezone cannot silently replace authoritative calendar sources.
Keep original source fields and provenance, duplicate detection, import tokens,
403/422 ordering, frozen-plan checks and replay behavior.

Apply the same resolver to inline CSV, uploaded CSV and streamed file iteration
used by preview and commit. Uploaded iteration normalizes at most 500 rows per
batch with coalescing disabled, preserving source ordinals and duplicate detection.
No new full-file materialization. Parser diagnostics, false callbacks and exceptions
propagate. Scope checks precede ambiguity and selected-date calculation admission;
actual matching multi-segment calculations retain the existing gate.

## Implemented seam

- `normalizeCsvWorkDate` preserves recognized instants instead of truncating to UTC.
- Existing inline/uploaded row builders call the shared calendar resolver.
- `iterateImportCalendarRows` wraps the actual file parser with bounded batches;
  both asynchronous preview and real core-owned plan construction consume it.
- No new timezone policy, flag, schema, provider adapter or alternate writer.

## Verification

| Requirement | Evidence |
| --- | --- |
| Instant parsing, sources and adjacent contracts | Nine unit/neighbor files, 142/142, zero skipped; `unit-final-preflight.log/json` |
| Real file iteration | Nine stream cases: 500/500/1 batches, source ordinals through title/blank rows, false/throw propagation, boundary and file errors |
| Real PostgreSQL protocol | 15/15, zero skipped; `pg-async-core-alias-fixed.log/json`; 28 actual migrations and registered production handlers |
| Synchronous persistence | Real sync host, exact stored date/instant/timezone and raw provenance for inline/uploaded CSV |
| Asynchronous persistence | Real reservation host and core processor; ordinary admitted importer, zero record effects before worker, exact freeze, token consumption, HTTP/worker replay without duplicate effects |
| Authorization | Scope-only admitted employee cannot access the invisible multi-segment calendar; complete 403 precedes ambiguity. Both async endpoints reject before calendar reads or jobs. No admin role is assigned to the ordinary importer. |
| Effects accounting | Six sync host calls; six records, eight batches/items, seven jobs and zero remaining tokens. Job count includes preview jobs; provider IO zero. |
| Stream characterization | 1,001 distinct synthetic subjects, 12,030 adapter statements: 6,006 shift and 6,006 rotation reads, zero candidate holiday reads. One measured run was 2,079ms; characterization only, no production SLA. |
| Guard mutations / restore | Instant truncation: 11 unit assertion failures / 34 controls passed. Uploaded normalization bypass: 8 failing DB cases (including effects accounting) / 7 controls passed. Exact restore: 45/45 focused units and 15/15 DB; `mutation-final.json`, `post-mutation-summary.json`. |
| Quality | `pnpm validate:all` exit 0; CJS syntax and whitespace checks pass. All source restored exactly. Existing lint scope and nine manifest warnings remain unchanged. |
| Mandatory CI | New whole-file CSV PostgreSQL step in required `test (20.x)`; existing timezone protocol and all earlier steps retained. Units use the default Vitest collection. |
| Exact-head required CI | Pending on the submitted head; no dependency-head or earlier-head pass is counted |

Evidence lives in the owned remote worktree under `artifacts/csv-calendar/`.
The fixture uses the real roles migration and users.role default. Full async import
runs as an admitted attendance_importer with attendance:import, not an admin. Scope
controls have employee read/write plus scheduler self/import only. Provider calls
are replaced by a rejecting test stub; no real tenant IO.

Early setup/hook failures count as zero executed passes. The first async attempt
with assertions exposed a missing role/admission test fixture; the next reached
successful core processing but failed the verification SELECT alias. Both are
preserved, followed by the complete 15/15 run, including replay assertions. These
were test-fixture repairs, not relaxed production authorization or timeouts.

The autoAssignMembers true/false preview matrix supplies no group membership
column. It proves those preflight paths preserve the calendar, not that actual
membership assignment was exercised. The large-file case is a preview with no
record writes. Registered handlers and a real database are not browser or UAT proof.

Commands:
```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-import-timezone.test.ts tests/unit/attendance-import-calendar-stream.test.ts
pnpm --filter @metasheet/core-backend exec vitest --config tests/attendance-import-timezone-protocol/vitest.csv.config.ts run
pnpm validate:all
```
The PostgreSQL command requires a scratch test DATABASE_URL. Its runner starts and
stops only the isolated synthetic cluster; no business database is used.

Stream/lifecycle remain OFF. No deployment, real UAT or 50004 changes. #6491 rule
default preservation, #5999 scheduler and #6001 report presets are separate slices.
Do not merge or treat this candidate as a built R71 release.

## Required backend regression repair

The initial required backend job failed an unchanged realtime retype test: the
bridge writer was correctly parked on the conversion fence, but its independent
Yjs persistence INSERT had not committed when the test read it. A dedicated real
PostgreSQL control blocks the INSERT with a table lock and releases it only after
the first count. The original one-shot read then fails the same `0 >= 1` assertion.
This reproduces the concrete race; historical CI did not record its exact schedule.

The test now waits for persisted state while keeping the conversion blocked, then
retains every original invalidation, document-eviction, record and reopen assertion.
The normal and delayed paths both pass. No runtime, timeout, assertion, skip or
workflow was weakened; all 284 original assertion lines remain.

| Additional gate | Evidence |
| --- | --- |
| Controlled original race | One named assertion failure, one positive control; 72 name-filtered cases excluded |
| Repaired normal and delayed paths | 2 passed; 72 name-filtered cases excluded |
| Entire containing file and two DB neighbors | 3 files, 83/83 passed, zero skipped |
| Database preparation | Actual workflow migration setup, 440 ledger entries; isolated PostgreSQL 16 |
| Cleanup | Test cluster stopped, no remaining blocked sessions; files retained |

Evidence: `artifacts/csv-calendar/ci-retype-failure/report.md`, terminal JSON,
red/green source snapshots, command records and assertion-preservation census.
The local PostgreSQL 16 result does not claim PostgreSQL 14 CI qualification;
required CI must succeed again on the committed repair.
