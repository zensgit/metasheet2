# Attendance report calendar boundaries — 2026-10-22

Refs #6001. Baseline: main `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`.

Reports use the existing loaded-record timezone context: a single valid IANA
zone across the currently loaded records. This is not a census of all report
pages and must not be described as an organization-wide timezone.

- Compute this week (Monday–Sunday), this month, last month, this quarter,
  and the initial today-minus-30-calendar-days range from that IANA calendar.
  UTC arithmetic operates only on date-only keys, never on elapsed local days.
- Before records resolve a zone, preserve the existing initial browser range
  but label that source explicitly. Disable automatic presets without a unique
  valid record zone. Manual dates remain available. No invented UTC/rule fallback.
- Align the pristine initial range once after records load; preserve a user's
  edits even during loading. Refetch all report aggregates and records after
  alignment. A preset captures its zone before refresh clears the old records.
- Initial requests may discover record context using the explicitly labelled
  browser range. Only the aligned reload is final evidence for an automatic
  attendance-calendar range; unavailable/mixed contexts retain explicit copy.
- A response for the old target cannot align the new target. Dataset freshness
  remains tied to the request snapshot; stale exports stay blocked. Manual date
  edits for the same target can still be replaced with a calendar shortcut.
- Do not change overview/server-clock semantics, report permissions, backend
  date validation, scheduler, or any feature flags.

## Gates

| Gate | Required evidence |
| --- | --- |
| Baseline reproduction | Real mounted view fails date/preset assertions |
| Calendar unit | UTC+14/-12, month/year/quarter/week, leap day, DST |
| View integration | Aligned default and all presets, source copy, mixed/invalid/missing, edits during request, export/filter neighbors |
| Mutation | Replacing IANA calendar with browser/UTC gives named assertion failures, restore |
| Web wiring | Domain guard and required web runner both execute new tests |
| Quality | pnpm validate:all; required web lane; exact-head required CI |
| UI | Synthetic local render/screenshot, no real UAT |

Keep Draft. Stream/lifecycle OFF. No merge, deployment, real UAT or 50004.

## Local validation at the reviewed source

- Baseline mounted view: 11 assertion failures (date boundaries, disabled state
  and new explanatory copy); no runtime/setup failure counted as a reproduction.
- Follow-up query-target race: one named assertion failure before its fix; the
  13 filtered cases were excluded, not passed.
- Focused and neighboring checks: 8 files, 114/114, zero excluded.
- UTC-substitution mutation: 9 named failures and 7 controls. Removing the
  request-snapshot guard: one named failure, 14 excluded. Both restored exactly.
- Restored new suites: 31/31; America/New_York process repeat: 31/31.
- Focused ESLint and `pnpm validate:all`: exit 0 (plugin, lint, backend and
  frontend/verification type checks).
- Synthetic Chrome component preview: aligned default, preset and unresolved-zone
  checks passed; desktop/mobile screenshots use the real application style sources.
  No live backend/provider was contacted; no real UAT is implied.
- Full required web lane: initial run stopped on the unchanged approval member-bar
  positive control at its existing 15-second timeout (788 other assertions passed
  in that batch). The same failure reproduced standalone (26/27 passed). Moving
  the component import into test collection preserves every assertion and the
  15-second limit; member-bar/current-node now pass 36/36 and instance-consistency
  passes 39/39. Full-lane, follow-up quality and exact-head CI remain pending
  until their terminal results are recorded in the PR.

## Route-metadata import follow-up

The full web rerun passed the previous 37-file/789-test member-bar batch, then
failed the unchanged approval navigation route test at its existing 5-second
limit. The original four-file batch reproduced 115 passes and that one timeout.
Instrumenting the real import without an artificial delay observed appRoutes
still loading at 4,899ms; its 17 statically imported views were inside the test
budget. Fixed route metadata now loads during collection. App/authPrincipal
dynamic imports and module-reset/crash-isolation behavior remain unchanged.

All 37 original assertion lines remain. The target file passes 13/13. A transform
removing only the batch-transfer route's requiresAdmin produces the original
named assertion failure (12 filtered cases excluded); after restoring the real
module, the whole four-file batch passes 116/116 with zero excluded. No assertion,
permission guard, timeout or workflow is weakened. Evidence is under
artifacts/report-calendar/nav-route-timeout. Follow-up quality, full web and
exact-head CI must finish on the repaired source before final acceptance.


Required registry order correction: the original head added the two report specs and analytics neighbor out of the existing case-insensitive order. The unchanged structural guard reproduced two assertion failures (32 controls passed). Only token order is repaired: all 514 entries and every prior selector remain present, without duplicates; the sorted .tokens manifest was already correct and is unchanged. Final registration/enumeration neighbors pass 456/456 in three backend files and workflow/shape neighbors pass 36/36 in two frontend files.

One initial backend-neighbor collection attempt hit the unchanged PyYAML subprocess 120-second limit (39 cases passed, one suite failed to collect); this is recorded as an environment/runtime failure, not an assertion result. The same Python parser and same Node bridge parsed the original workflow directly in 0.152/0.182 seconds. Repeating the original command, source, assertions and timeout completed 456/456. No parser or timeout was changed. Evidence: artifacts/report-calendar/gate-order/.

The partial local full-web run was explicitly stopped only after this registry defect was confirmed, before editing its source. Its log and prior validate:all exit0 are preserved and the partial run is not counted as passed. Full required-web and new-head required CI remain pending. That quality result predates the following cold-import repair; fresh quality is required for the new test source.

## Lifecycle and permissions cold-import follow-up

The next exact-source full web run completed 19 passing batches, then its final
592-file batch had 591 passing files and 12,278 passing tests, with one existing
5-second template-list mount timeout. Original uncached focused execution
reproduced two initial lifecycle mount timeouts (66/68 passed). After moving the
four SFC imports from mount helpers into collection, lifecycle passed 68/68; its
unchanged permissions neighbor then reproduced the same cold-import boundary
in two initial center mounts. Its five SFC imports were moved identically.

Final focused and restored runs each passed 113/113 (lifecycle 68, permissions
45), zero skipped. Temporarily removing the two mock adapters' load-observation
forwarding made exactly the original load assertions fail; real mounts, test
bodies and assertions remained unchanged, and source bytes were restored.
This is an assertion-observation control, not a production permission mutation.
All original hooks, mock factory behavior/order, assertions and timeouts remain
unchanged. Only module loading moved into collection. Evidence is retained under
`artifacts/report-calendar/lifecycle-timeout/`, including the original full-gate
log hash, both failed runs, mutation, restoration and final source hashes.

Fresh quality, complete required web and exact-head required CI remain pending
for this follow-up. No partial or failed lane is counted as a pass.

## Shared cold imports and expired test continuations

The next full lane at `1aa419c03d6c8febaed248f072c40e1557be502a` passed
19 batches, then failed its final batch: 579 files / 12,265 tests passed,
13 files / 14 tests failed. The original 13-file uncached focused run had
246 passes and 16 failures. These failed runs remain retained, not accepted.

Twelve observed approval specs now load their SFCs during collection: seven
static imports and five module-tail preloads after eager mock declarations.
The five keep every original mount-time await import. A beforeAll attempt
actually exceeded the unchanged 10-second hook budget: all 49 cases were
pending, despite the reporter's misleading top-level pass counter. The final
module-evaluation version passes all 12 complete files plus the unchanged
lifecycle/permissions neighbors: 14 files, 369/369, zero skipped. Two temporary
observation controls hit the original five-tabs and load-on-mount assertions
(47 passed, two named failures); exact restoration then passes center 49/49.

The multitable history field-scope failure was isolated separately. Natural
cold imports outlived multiple 5-second case budgets; expired continuations
mounted into a later case's shared container. A preloaded neutral copy passes
6/6. Holding only the first cached import return reproduces its intentional
timeout plus the original PR-C chip-null assertion, with four controls passing.
Trace shows the stale and current bodies mounting the same container and
clicking the same history button/modal twice, expanding then collapsing it.
Blocking only that stale continuation before mount leaves the intentional
first timeout but restores the other five original tests. Both delayed runs
retain exit 1; the intentional timeout is never counted as passed.

The actual test repair adds only a three-line collection preload after eager
mock declarations. All original bytes, including three dynamic import/await
sites, mounts, mocks, assertions and timeouts, remain. Normal configuration
passes the complete target 6/6 and two existing history neighbors 47/47, zero
skipped. Production field visibility and record navigation code are unchanged.

Main independently audited the exact source splices, per-case results, trace,
restoration and finished process handles. Evidence is under
`artifacts/report-calendar/cold-import-batch/` and
`artifacts/report-calendar/history-scope-timeout/preloaded/`.
Fresh quality, complete required web and exact-head CI remain required for
this new test source; prior-head CI success does not satisfy those gates.
