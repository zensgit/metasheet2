# Data Factory #2342 - large-BOM background expansion and checkpoint apply test plan (2026-06-08)

## Scope

This is an implementation-prep, docs-only test plan for the #2342 large-BOM
lane.

It does not add runtime behavior, routes, UI, workers, migrations, packages,
MetaSheet writes, PLM writes, external database writes, K3 paths, production
rollout, or apply behavior. It exists to make the future C3 background
full-expansion and C4 checkpointed apply implementation reviewable before any
new write/runtime risk lands.

The current synchronous dry-run lane remains unchanged:

- bounded large-BOM dry-runs keep `largeBom=true`;
- bounded dry-runs are non-authoritative;
- bounded dry-runs keep `canApply=false`;
- bounded dry-runs issue no dry-run token;
- bounded dry-runs cannot start normal Apply or large Apply.

## Grounding

The current merged C1/C2 lane already distinguishes scale-class bounded states
from hard correctness failures:

- bounded: `max_rows_exceeded`, `read_page_limit_exceeded`,
  `read_count_exceeded`, `read_time_limit_exceeded`;
- hard failure: `max_depth_exceeded`, cycle detection, invalid rows, source
  failures, adapter failures, and other correctness errors.

C3 and C4 designs are already landed:

- C3: background full expansion is a separate durable job lane and remains
  read-only.
- C4: large-BOM Apply is a separate checkpointed writer and can consume only a
  completed authoritative C3 artifact plus explicit owner approval.

This test plan pins the tests and negative controls that future implementation
must satisfy.

## C3 background expansion tests

Future C3 implementation should include unit/service tests for the job engine
and route tests for the public surface.

Required contract tests:

- `startBackgroundExpansion` refuses to start from browser-supplied source,
  target, read plan, raw SQL, cap override, C3 plan, C4 payload, sheet id, field
  id, or dry-run token.
- source reads use the authenticated read principal; missing principal fails
  closed with no system/admin/service fallback.
- background expansion performs app-side recursion through flat allowlisted
  adapter reads only.
- expansion produces no target create or patch calls.
- expansion stores progress in durable storage; memory-only storage fails
  closed for background mode.
- a completed job has an authoritative artifact; queued/running/paused/failed/
  cancelled/expired jobs are not authoritative.
- retry/resume after an interrupted row chunk produces one copy of each
  expanded row, never duplicate artifact rows.
- completed artifacts are bound to action config revision, source binding
  revision, target binding revision, read plan revision, parameters hash, and
  authenticated read principal.
- expired or revision-mismatched artifacts cannot be used for planning or
  large Apply.

Budget tests:

- row budget exhaustion returns a non-authoritative failed background job with
  values-free `max_rows_exceeded` evidence.
- read page budget exhaustion returns a non-authoritative failed background job
  with values-free `read_page_limit_exceeded` evidence.
- read count budget exhaustion returns a non-authoritative failed background
  job with values-free `read_count_exceeded` evidence.
- elapsed-time budget exhaustion returns a non-authoritative failed background
  job with values-free `read_time_limit_exceeded` evidence.
- `max_depth_exceeded` remains a hard correctness failure and is not relabeled
  as a successful large-BOM bounded state.
- cycle detection remains a hard correctness failure and is not relabeled as a
  successful large-BOM bounded state.

Values-free evidence tests:

- public progress exposes counts, states, configured cap fields, object names,
  source kind, and error codes only.
- public progress never exposes project values, component values, parent/path
  values, idempotency keys, raw row payloads, target record ids, sheet ids,
  field ids, credentials, tokens, connection strings, raw SQL, or error messages
  containing row values.
- diagnostics report whether filters were sent and acknowledged from real
  adapter receipt, not by recomputing the request.

## C4 checkpointed apply tests

Future C4 implementation must be tested separately from C3. It is the write
lane and cannot be treated as a small extension of synchronous Apply.

Required contract tests:

- large Apply refuses any bounded preview or partial expansion artifact.
- large Apply accepts only a completed authoritative C3 artifact/plan.
- large Apply requires explicit owner approval bound to the completed artifact
  revision.
- large Apply derives write/admin permission from the authenticated approver,
  never from the browser and never from a hardcoded permission.
- the target records API is server-scoped to the configured target; browser
  input cannot supply or override target sheet/object scope.
- browser input cannot supply plan rows, payload rows, source binding, target
  binding, cap values, sheet id, field id, raw SQL, handler code, or retry
  instructions.
- manual-confirm decisions are held and write nothing.
- skip decisions write nothing.
- add decisions remain idempotent: an existing key is patched, not created
  again.
- update and inactive decisions are find-then-patch only; missing target rows
  are row-level failures, not create-on-miss.
- human-preserved fields are never written and are defensively rejected at the
  writer boundary.
- per-row failures do not abort clean rows and do not erase completed progress.
- checkpoint resume after a crash does not duplicate created rows and does not
  reapply completed decisions as new creates.
- losing a worker lease stops writes before another worker resumes.
- global failure does not erase row-level progress or hide partial status.

Checkpoint tests:

- checkpoint advances only after the corresponding decision result is
  persisted.
- retry after write-before-checkpoint uses the idempotent writer and records a
  values-free resumed result.
- retry after checkpoint-before-next-write skips completed decisions.
- pause/resume requires a fresh authenticated user when resumed manually.
- approval/artifact expiry fails closed and requires a new full review.

Values-free evidence tests:

- public apply progress exposes counts, result statuses, field categories, and
  error codes only.
- public apply progress never exposes project values, component values,
  parent/path values, idempotency keys, target row values, target record ids,
  sheet ids, field ids, tokens, raw plans, raw payloads, credentials, connection
  strings, raw SQL, or value-bearing stack traces.

## Operator UI and issue-evidence tests

Future UI work should remain explicit about which lane the operator is in.

Required tests:

- synchronous bounded preview renders as non-authoritative and apply-blocked.
- synchronous bounded preview has no dry-run token and cannot show an enabled
  Apply button.
- background expansion progress renders job state and values-free counters.
- completed background expansion is labeled authoritative for planning only,
  not as Apply authorization.
- large Apply requires a completed C3 artifact, a fresh review, and explicit
  owner approval.
- issue/customer evidence templates include only values-free counters, states,
  strategy labels, result counts, and error code counts.

The UI must not let the browser raise caps or choose a write mode. Any larger
budget or large-apply policy is server-side/admin-reviewed configuration.

## Negative controls

Future implementation PRs should include explicit negative controls. At a
minimum:

- If bounded preview starts issuing dry-run tokens, tests fail.
- If bounded preview can start normal Apply or large Apply, tests fail.
- If large Apply accepts a bounded or partial artifact, tests fail.
- If large Apply accepts a browser-supplied plan/payload/target scope, tests
  fail.
- If missing principal falls back to system/admin/service, tests fail.
- If background expansion uses process memory as its only checkpoint store,
  tests fail.
- If resume duplicates expanded artifact rows, tests fail.
- If checkpointed Apply duplicates target rows on retry, tests fail.
- If update/inactive create missing target rows, tests fail.
- If a manual-confirm row writes, tests fail.
- If public evidence includes raw values or target identifiers, tests fail.
- If `max_depth_exceeded` or cycle detection is relabeled as a successful
  large-BOM bounded state, tests fail.

## Relationship to #2343 duplicate strategy work

Large-BOM background expansion is upstream of authoritative duplicate analysis
for large samples.

If synchronous expansion is bounded, C3 duplicate counts and held-group counts
over that bounded subset are not authoritative. #2343 D4 duplicate-strategy
policies may be designed in parallel, but large-sample policy validation
requires a completed C3 full-expansion artifact.

No duplicate strategy should use a bounded large-BOM subset to authorize Apply.

## Sequencing

Recommended future slices:

1. C3-1: latent durable job model and values-free status contract.
2. C3-2: background expansion engine with checkpoint/resume tests.
3. C3-3: read-only UI/status surface for background expansion.
4. C4-1: checkpointed writer service, latent and target-scoped.
5. C4-2: route/UI apply surface with fresh approval and revision binding.
6. C4-3: entity-machine (onsite hardware) validation before production
   rollout.

Each implementation slice remains a separate opt-in. This document does not
authorize runtime changes or another apply.
