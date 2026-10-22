# Attendance daily calendar repair (#5999)

Base: `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`. Bounded R71 candidate; the main agent owns review, commit and Draft PR submission. Stream/lifecycle remain OFF. No merge, deployment, business database/provider work or real UAT; 50004 is excluded.

- Auto-absence runAt follows each organization's unique, valid default attendance rule IANA. No host/UTC/default-org fallback on missing, conflicting or invalid configuration. Job clock is not a new employee/trip timezone policy; existing W4 writer remains authoritative for targets.
- Reuse the host's strict wall-time resolver and IANA validator. Keep generic zonedTimeToUtc byte-identical. Advance date keys by calendar days; only a unique, future wall instant may arm a timer. UTC+14, DST, exact-at-target, gap and fold are explicit cases.
- Gap/fold occurrences are skipped, with a values-free reason, and the next uniquely resolvable calendar occurrence is planned. This deliberately trades a missed occurrence for avoiding a guessed business write; this is a bounded fail-closed risk choice, not authorization to operate on real data. Existing lookback remains available for later valid ticks.
- Recompute a timeout after each run. Stop/restart invalidates old async planning and callbacks, including callback completion after settings changes. One organization's timer must not cancel another's. An in-flight W4 transaction is not retroactively cancelled; stale callbacks must not initiate further dates or rearm.
- Settings success rearms; default-rule transaction success rearms auto-absence. Rejected/rolled-back updates do not rearm. Re-read and validate default rule before a due callback; changed timezone skips the obsolete occurrence and replans. Failed plan reads retry with no business work.
- Holiday's existing explicit-IANA daily consumer uses the same strict planning/timeout controller, preserving provider configuration and payload. Invalid holiday timezone fails closed rather than falling back.
- Two auto-absence settings entry points gain only explanatory copy. No picker, schema/migration, flag or new external-write capability.

Gates: retained baseline source probe RED; pure calendar/controller tests (DST, dateline, calendar lookback, multi-org, read failure, missing/invalid/conflicting default, stop/restart/old callback); wiring tests for W4/default-rule success ordering and generic-converter preservation; mutation checks for guards; neighbor timezone/store tests; UI copy tests wired in attendance-web-guard and required-web lane. Final executed gate results are recorded under artifacts/daily-calendar/HANDOFF.md; dependency-free probes, focused Vitest, guard mutations and neighbor gates are reported separately from deployment/UAT.

Exclusions: report presets/defaults, CSV/#6003, #6490, generic converter changes, W4 transaction/writer redesign, DingTalk Stream/lifecycle, 50004, business DB/provider writes, deployment/UAT, flags. Main agent reviews and commits.


PG validation addendum (owner request, 2026-10-22): an isolated synthetic PostgreSQL cluster/schema is authorized for tests only. The new fail-closed PG file uses pg.Pool for every SQL statement, real transaction authorization/source reads and actual registered PUT handlers, with deferred constraints proving COMMIT rejection/rollback. This is a narrow SQL-shape fixture with empty published/frozen/trip sources and OFF optional timezone policy, not production migration, HTTP authentication or durable W4 writer validation. The required plugin workflow runs the whole PG file; the no-DB lane excludes it.

No org-discovery polling is introduced: the existing application org/default creation path is the successful default-rule PUT and rearms there. External direct SQL creation is outside this slice. The global lastAutoAbsenceKey remains byte-identical and carries org/date; an interleaved two-org test drives the real controller and production executor through reversed completion, including a legacy-key hit that must still reach W4. It proves the handoff and absence of cross-org suppression, not durable W4 DB idempotency; that boundary remains frozen.

Scoped default-rule rearm correction (owner follow-up, 2026-10-22): a successful default-rule COMMIT replaces only that organization's plan, including invalidation of its old pending refresh/lookback continuation. Sibling handles, pending refreshes and lookback loops stay current. Settings success and stop/start still invalidate every old callback. Per-plan ownership is established before async reads; startup/list-read retries add only absent orgs and cannot replace a plan already created by a scoped COMMIT. New-org COMMIT can arm directly while discovery is pending or retrying; rollback does not touch any plan. No additional discovery poller, catch-up policy or W4 executor change. Required registered-handler and actual-PG two-org regressions plus global-restart mutation must demonstrate the missed-day counterexample.


## Validation at Draft submission

| Gate | Evidence |
| --- | --- |
| Registered two-org counterexample | Named assertion RED before scoped rearm; sibling due date retained after repair |
| Backend and neighbors | 7 files, 172/172; zero skipped |
| Actual PostgreSQL | 15/15; real COMMIT/ROLLBACK and deferred COMMIT rejection; zero skipped |
| Guard mutations | 9 unit and 3 PG mutations produce assertion failures; sources restored, positive suites pass |
| Web copy and neighbors | 3 files, 45/45; zero skipped |
| Registration shape | 34/34; token UNION and sorted exec registry preserved |
| Type and quality checks | Focused strict test types and `pnpm validate:all` exit 0 |
| Synthetic component UI | Real component and application styles, desktop/mobile; no backend/provider IO |
| Full required web and exact-head CI | Pending at Draft submission; not counted as passed |

Final scoped evidence is retained under `artifacts/daily-calendar/SCOPED-REARM-HANDOFF.md` and the `scoped-*` logs/manifests. The initial type-only mock signature error was corrected without changing assertions or compiler settings. Earlier shared raw log filenames were reused; `scoped-log-provenance.json` identifies this and the final copies. The current source and all final positive evidence were rechecked before submission.

## Shared required-web cold-import repairs

The seventeen existing web specs use the same original bytes as main and the
report-calendar baseline. This candidate carries only their reviewed collection
import/preload repairs from report-calendar `48d3bb350`; no report-calendar
business feature or workflow change is copied. Original assertions, mocks,
module-reset behavior and test/hook budgets remain. The fixed route-metadata
case becomes synchronous; reset-dependent App/authPrincipal imports remain
inside their original helpers. The member-bar 15-second setting is unchanged.

Parent evidence includes the original cold-import failures, approval 369/369,
two named observation failures and restored center 49/49, and the multitable
expired-continuation control with normal target 6/6 and neighbors 47/47. Earlier
member-bar and navigation repairs have their own original failures and restored
neighbor evidence. These are provenance for the shared repair, not daily-run
results. Exact original/repaired hashes and the patch are retained under
`artifacts/daily-calendar/shared-import-harness/`; all prior daily feature,
backend guard, test wiring and UI hashes remain unchanged except this evidence
appendix. Fresh quality, the full required web lane (including these complete
files) and exact-head CI must pass on the resulting daily candidate before
acceptance. No production configuration, Stream/lifecycle or UAT change.

## Session fixture clock-boundary follow-up (2026-10-22)

The `5e7e219e2` attendance-web-guard failed the old-bootstrap / explicit-switch test (62 passed, one failed). Its two independently generated org-a tokens could straddle an expiration-second boundary, correctly failing the runtime expected-token check before any switch. The test did not assert that the requested switch succeeded.

A deterministic artifact-only 1ms boundary reproduces the same named assertion failure (35 passed, one failed): the expected token differs, the real setter returns false, and the original bootstrap remains current. Reusing the captured original token and asserting setter success passes all 36 cases under the identical boundary. The actual fix is confined to three inserted / two removed test lines; all four original outcome assertions, mocks and timeouts remain. No runtime, authorization or configuration code changed.

The original four-file explicit-session CI selection then passes 63/63 under the normal config, zero skipped or pending, exit 0. Main independently audited raw exits, actual assertion results, clock call-through/restoration, exact diff and unchanged runtime hashes. Evidence: `artifacts/daily-calendar/auth-bootstrap-clock-5e7/`, including `main-independent-audit.json`. Fresh commit quality/full-web and exact-head required CI remain mandatory and pending; this is fixture repair evidence, not UAT or a release result.

## Shared shell-preload follow-up (2026-10-22)

Two additional navigation fixtures receive the reviewed report-candidate preload after confirming their original bytes match exactly. Each appends three lines while retaining its entire original source, dynamic module imports, mock/reset behavior and timeouts. The report source passes the controlled 5.5-second initial module-load delay (31/31), the normal full four-file selection (116/116), two named observation REDs, and exact-restored TodoBadge 23/23. Natural focused runs passed 31/31 and are not reported as a natural timeout reproduction.

These are source-matched shared-repair results, not new daily full-gate results. The daily clock fixture remains byte-identical to its independently verified 63/63 source. Fresh daily quality, full required web and exact-head CI are pending for the final head; runtime and feature source are unchanged. Shared source provenance is retained in `artifacts/daily-calendar/shared-nav-session-harness.json`.
