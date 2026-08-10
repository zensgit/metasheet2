# Attendance issue 4556 — W4C-5 Operator Transition Runbook

Date: 2026-08-09
Scope: `docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md`
(`OD-W4C-61=(a)`, ratified at `2a2a5eee4f00abceff94ed6360e8c051708e35f7`, owner comment
`5189421034` on PR 4747; the amendment's header on `main` still literally reads
`PROPOSED / staging HOLD` — that is known in-repo status drift pending the separate,
un-merged status-reconciliation PR 4834, not an open decision; the owner comment above is the
authority, not the header text).

## Non-authorization notice

This runbook and the CLI it documents (`scripts/ops/attendance-w4c5-rollout-transition.ts`)
authorize **no** staging access, **no** flag change, **no** deployment, **no** seven-day soak,
**no** production/customer data use, **no** external notification, and **no** closure of issue
4556. Every step below runs only against a **locally migrated scratch PostgreSQL database** and
a **single example synthetic org ID** you must replace with the owner-designated one before any
real use. `SEGMENT_CALCULATION_IMPLEMENTED`
(`plugins/plugin-attendance/lib/attendance-shift-service.cjs:60`) is untouched by this line of
work — flipping it is a separate implementation-readiness decision the owner has not made, and
this runbook does not depend on it (the rollout-state machine this tool drives is independent of
that constant; see the amendment's §0 finding).

Every command below was executed verbatim while writing this document, against a local scratch
PostgreSQL 15.17 instance on `localhost:54329` and Node v25.9.0. Substitute your own scratch
`DATABASE_URL` throughout — do **not** point any of this at staging or production. If a step
below cannot be run as written in your environment, do not attempt to work around it silently;
treat that as a defect in this document.

**Re-rehearsed cold (PR #4839 gate P3-1/P3-2, 20260809)**: the original version of this document
was rehearsed from an already-`pnpm install`ed checkout with a leftover `cd packages/core-backend`
in step 2 that steps 4/6/7/8's repo-root-relative `scripts/ops/...` paths never undid — reproduced
by an independent adversarial gate as `ERR_MODULE_NOT_FOUND` when run literally in sequence, and
by a missing `pnpm install` prerequisite reproducing as `tsx: command not found` from a genuinely
fresh checkout. Both are fixed below: every command in this document now runs from the **repository
root**, with no `cd` anywhere, and step 2 states the install prerequisite explicitly. This was
re-rehearsed end to end, cold, in a **new worktree with no pre-existing `node_modules`** against a
**freshly `initdb`'d scratch PostgreSQL instance**, at head `44803c10ab` on this branch — every
output below (including both `planDigest` values, which changed from the first version of this
document because `AttendanceRolloutTransitionPlanV1` gained a `priorState` field that is now also
part of the digest, see P2-1) was captured verbatim from that rehearsal, not edited by hand.

**Digests recomputed again (owner completion gate "Gate D", PR #4839, 20260810)**: landing the
authoritative-entrypoint delivery readiness check (`AUTHORITATIVE_ENTRYPOINTS_DELIVERED`, a new
predicate `buildAttendanceRolloutTransitionPlanV1` appends to `plan.predicates` for **every**
target state — `applicable: false, pass: true, count: null` for a non-`authoritative` target like
this worked example) changed the canonical predicate array `computeAttendanceW4C5PlanDigestV1`
hashes, which changes **every** `planDigest` this document prints, byte-content-of-the-plan
unrelated. Re-rehearsed steps 4/6/7 end to end at head `2ec9c165c6` on this branch, against a
freshly migrated scratch database with the identical illustrative org ID and correlation IDs this
document already used — every `planDigest` and predicate array below is the real captured output
of that rehearsal, not derived by inspection. `computeAttendanceW4C5PlanDigestV1` includes
`plan.orgId` in its canonical object, so these digests are specific to the illustrative org ID
`00000000-0000-4000-8000-000000000001` above — a real transition against a different org will
print a different digest, which is expected and is exactly why `apply` always recomputes and
compares fresh rather than trusting a supplied literal.

## Prerequisites (NOT executable steps — separately owner-authorized, listed for context only)

- Staging/production access, a seven-day soak, any `ATTENDANCE_*` flag change, and a real
  deployment are **not** covered by anything below and remain separately owner-gated per the
  amendment's landing sequence (§8).
- The org ID used in the worked example below (`00000000-0000-4000-8000-000000000001`) is an
  **illustrative placeholder only**. A real run must use the exact org ID the owner designates as
  the allowlisted synthetic org, and must never point at an org carrying real customer data (the
  evidence manifest's `customerData` field is a hard-fail gate on this, but it is a self-report by
  the operator preparing the manifest, not something the tool independently verifies).

## Step 1 — start a scratch PostgreSQL instance and create an empty database

```bash
initdb -D /tmp/w4c5-scratch-pgdata -U postgres --auth=trust
pg_ctl -D /tmp/w4c5-scratch-pgdata -o "-p 54329 -k /tmp" -l /tmp/w4c5-scratch-pg.log start
createdb -h localhost -p 54329 -U postgres ms2_w4c5_runbook_demo
```

Expected: `pg_ctl` prints `waiting for server to start.... done` / `server started`; `createdb`
prints nothing on success.

## Step 2 — install dependencies (if needed) and run the real migration chain

Every command in this runbook runs from the **repository root** — there is no `cd` anywhere
below. A fresh checkout has no `node_modules`; if `ls node_modules` in the repo root shows nothing,
install first:

```bash
pnpm install --frozen-lockfile
```

Then run the migration chain, targeting the `core-backend` workspace package by `--filter` rather
than `cd`-ing into it (so every later step's repo-root-relative `scripts/ops/...` path keeps
working without an explicit `cd` back):

```bash
DATABASE_URL="postgresql://postgres@localhost:54329/ms2_w4c5_runbook_demo" \
  pnpm --filter @metasheet/core-backend run db:migrate
```

Expected: one `migration "<name>" was executed successfully` line per migration, ending with the
most recent migration on your checked-out commit — for example, on this branch's base
(`8d47b5abac`), the tail of the run was:

```
migration "zzzz20260805120000_w4c2_scheduled_run_sweep_fairness" was executed successfully
migration "zzzz20260808090000_deprovision_effect_grant_row_created" was executed successfully
```

313 `"... was executed successfully"` lines (one per migration), zero `failed to execute migration`
lines — reproduced identically across three separate from-scratch rehearsals of this document
(the original two, plus the P3-1/P3-2 cold re-rehearsal noted above), all landing on the identical
last two migrations shown above. This is the same migration chain a real staging/production
database runs — not a test-only fixture.

## Step 3 — allowlist the example synthetic org for this scratch database's session

```bash
export DATABASE_URL="postgresql://postgres@localhost:54329/ms2_w4c5_runbook_demo"
export ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED="00000000-0000-4000-8000-000000000001"
```

This env var is the exact-org-only outer allowlist `isAttendanceCalculationOrgAllowlistedV1`
reads (`packages/core-backend/src/attendance/w4c0-identity.ts`) — a comma-separated list of exact
org IDs; it is never a wildcard, and setting it has zero effect on any org not named in it.

## Step 4 — plan (read-only): legacy -> shadow for the example org

```bash
pnpm exec tsx scripts/ops/attendance-w4c5-rollout-transition.ts plan \
  --org 00000000-0000-4000-8000-000000000001 \
  --target shadow
```

(Run from the repository root, with `DATABASE_URL` and `ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED`
still exported from step 3 in the same shell.)

Expected (exact output captured while writing this document — `planDigest` is
deterministic for an identical database state and will reproduce byte-for-byte if you replay
these exact steps from a freshly migrated database):

```json
{
  "orgId": "00000000-0000-4000-8000-000000000001",
  "orgAllowlisted": true,
  "rowExists": false,
  "currentState": "legacy",
  "currentVersion": null,
  "priorState": null,
  "targetState": "shadow",
  "legalPair": true,
  "comparisonWritePosture": "shadow",
  "canBootstrap": true,
  "predicates": [
    { "code": "ORG_ALLOWLISTED", "applicable": true, "pass": true, "count": null },
    { "code": "ROLLOUT_ROW_RESOLVABLE", "applicable": true, "pass": true, "count": null },
    { "code": "LEGAL_TRANSITION_PAIR", "applicable": true, "pass": true, "count": null },
    { "code": "UNCLOSED_LEGACY_BATCH", "applicable": true, "pass": true, "count": 0 },
    { "code": "RETRYABLE_JOB_POSTURE_MISMATCH", "applicable": true, "pass": true, "count": 0 },
    { "code": "RETRYABLE_JOB_HAS_OPERATION_ROWS", "applicable": false, "pass": true, "count": null },
    { "code": "NONTERMINAL_LEGACY_JOB", "applicable": true, "pass": true, "count": 0 },
    { "code": "INCOMPLETE_OPERATION", "applicable": false, "pass": true, "count": null },
    { "code": "UNRESOLVED_INGRESS_REVIEW", "applicable": false, "pass": true, "count": null },
    { "code": "DEFECTIVE_REQUEST_SNAPSHOT", "applicable": false, "pass": true, "count": null },
    { "code": "AUTHORITATIVE_ENTRYPOINTS_DELIVERED", "applicable": false, "pass": true, "count": null }
  ],
  "blocked": false,
  "planDigest": "82742c3c4137175bb5af92bc685fca23bfaa561086d359480ffb53afff972fb7"
}
```

(`AUTHORITATIVE_ENTRYPOINTS_DELIVERED` — Gate D, owner completion gate, PR #4839, 20260810 —
is `applicable` only when `--target authoritative`; for this `shadow` target it always reports
`applicable: false, pass: true, count: null`, and never blocks a non-authoritative transition.)

Exit code `0` (an unblocked plan). This command performed zero **durable writes** — see
`packages/core-backend/tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts` for
the mechanical proof (a dynamic query sweep asserting no `INSERT`/`UPDATE`/`DELETE`/… statement
and an always-`ROLLBACK`-never-`COMMIT` transaction, plus a before/after row-count invariance
check, exercised over both a shallow and a seeded-deep predicate branch). You can verify it
yourself right now: `psql -h localhost -p 54329 -U postgres -d ms2_w4c5_runbook_demo -c "SELECT
count(*) FROM attendance_calculation_rollout_state"` returns `0` before and after this step.

**Locking (PR #4839 gate P3-1, measured via `pg_locks`, not merely asserted):** although `plan`
writes nothing, it is not lock-free. It runs inside `BEGIN ISOLATION LEVEL SERIALIZABLE` and its
section-3 predicate queries take `RowShareLock` on up to 7 relations (plus row-level locks on any
matched job/operation/review/request/approval rows), held until the transaction's own `ROLLBACK`.
`RowShareLock` does **not** conflict with the `RowExclusiveLock` ordinary `INSERT`/`UPDATE`/`DELETE`
statements take, so `plan` does not block normal application writes — but it **does** conflict with
`ExclusiveLock`/`AccessExclusiveLock`, i.e. a concurrent schema migration (`ALTER TABLE`, etc.) on
one of those same relations. Avoid running `plan` (or `apply`, which calls `plan` internally as its
first step) concurrently with a migration window against the same database.

## Step 5 — prepare the evidence manifest

The manifest's `collectedAt` must be fresh (within 15 minutes of the `apply` call below) and its
`orgId`/`targetState` must match the CLI invocation exactly.

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
cat > /tmp/w4c5-manifest-legacy-to-shadow.json <<EOF
{
  "schemaVersion": 1,
  "collectedAt": "$NOW",
  "orgId": "00000000-0000-4000-8000-000000000001",
  "targetState": "shadow",
  "imageSha": "runbook-demo-image-sha",
  "pendingMigrations": 0,
  "serviceHealthy": true,
  "ownerAuthorizationRef": "runbook-demo-owner-authorization",
  "syntheticOrgRef": "runbook-demo-synthetic-org",
  "customerData": false,
  "externalNotificationsDisabled": true,
  "externalDestinationCount": 0,
  "entrypointInventoryRef": "runbook-demo-entrypoint-inventory"
}
EOF
```

For a **real** transition, every `*Ref` field must be a real, checkable reference (not the
`runbook-demo-*` placeholders above), `pendingMigrations` must reflect an actually-verified
pending-migration count of the real target environment, `serviceHealthy` must reflect an actually
-verified health check, and `customerData` must be an honest `false`. This tool validates the
manifest's *shape* only — it cannot verify that these fields are true of the real world; that
verification is the operator's own responsibility, performed before writing this file (amendment
§4).

A transition into `eligible`/`authoritative` additionally requires
`sevenDistinctCalendarDaysObserved` (exactly seven distinct `YYYY-MM-DD` strings),
`criticalDiffCount: 0`, and `unresolvedReviewCount: 0`. A resume (`suspended` -> `authoritative`)
additionally requires `ownerIncidentReviewRef`, `offlineReplayArtifactRef`,
`offlineReplayCriticalDiffCount: 0`, and `offlineReplayUnresolvedDiffCount: 0`. Neither applies to
the `legacy -> shadow` worked example above.

## Step 6 — apply: legacy -> shadow for the example org

```bash
pnpm exec tsx scripts/ops/attendance-w4c5-rollout-transition.ts apply \
  --org 00000000-0000-4000-8000-000000000001 \
  --target shadow \
  --expected-state legacy \
  --expected-version 1 \
  --plan-digest 82742c3c4137175bb5af92bc685fca23bfaa561086d359480ffb53afff972fb7 \
  --confirm I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_ONLY \
  --manifest /tmp/w4c5-manifest-legacy-to-shadow.json \
  --actor-id runbook-demo-operator \
  --correlation-id 00000000-0000-4000-8000-0000000000c1 \
  --engine-version w4c5-runbook-demo-v1
```

`--plan-digest` must be the exact `planDigest` value `plan` just printed in step 4 — it is
recomputed fresh inside `apply` from a brand-new `plan` call and compared byte-for-byte; a plan
digest from any other invocation (a different database state, a different org, or simply time
having passed and something else having changed) is refused, never silently reused.

Expected output (captured verbatim):

```json
{
  "outcome": "transitioned",
  "orgId": "00000000-0000-4000-8000-000000000001",
  "state": "shadow",
  "planDigest": "82742c3c4137175bb5af92bc685fca23bfaa561086d359480ffb53afff972fb7"
}
```

Exit code `0` (`planDigest` here is the pre-transition, `legacy`-state plan's digest — the same
value you supplied, captured before the boundary call, not recomputed after; contrast with step
7's no-op output below, which reflects the NEW post-transition plan). Verify the persisted state
directly:

```bash
psql -h localhost -p 54329 -U postgres -d ms2_w4c5_runbook_demo \
  -c "SELECT org_id, state, version, prior_state, scope FROM attendance_calculation_rollout_state WHERE org_id = '00000000-0000-4000-8000-000000000001';"
```

Expected:

```
                org_id                | state  | version | prior_state |       scope
--------------------------------------+--------+---------+-------------+-------------------
 00000000-0000-4000-8000-000000000001 | shadow |       2 | legacy      | synthetic_staging
```

```bash
psql -h localhost -p 54329 -U postgres -d ms2_w4c5_runbook_demo \
  -c "SELECT org_id, prior_state, new_state, reason_code FROM attendance_calculation_rollout_events WHERE org_id = '00000000-0000-4000-8000-000000000001';"
```

Expected:

```
                org_id                | prior_state | new_state |    reason_code
--------------------------------------+-------------+-----------+--------------------
 00000000-0000-4000-8000-000000000001 | legacy      | shadow    | rollout_transition
```

Exactly one row in each table — `apply` called
`transitionAttendanceCalculationRolloutV1` (`packages/core-backend/src/attendance/
w4c3a-rollout-control.ts`) exactly once; this tool never writes a rollout row directly.

## Step 7 — re-apply the SAME invocation: idempotent no-op, not a second transition

```bash
pnpm exec tsx scripts/ops/attendance-w4c5-rollout-transition.ts apply \
  --org 00000000-0000-4000-8000-000000000001 \
  --target shadow \
  --expected-state legacy \
  --expected-version 1 \
  --plan-digest 82742c3c4137175bb5af92bc685fca23bfaa561086d359480ffb53afff972fb7 \
  --confirm I_UNDERSTAND_THIS_TRANSITIONS_A_SYNTHETIC_ORG_ONLY \
  --manifest /tmp/w4c5-manifest-legacy-to-shadow.json \
  --actor-id runbook-demo-operator \
  --correlation-id 00000000-0000-4000-8000-0000000000c2 \
  --engine-version w4c5-runbook-demo-v1
```

This still no-ops after the P2-1 fix (PR #4839 gate, 20260809): the idempotency short-circuit now
additionally requires the persisted `prior_state` column to equal `--expected-state`, and this
org's real `prior_state` genuinely is `legacy` (it transitioned `legacy -> shadow` in step 6) —
exactly what `--expected-state legacy` above claims. A re-apply that claimed a DIFFERENT
`--expected-state` here (one that was never this org's real prior state) is refused instead of
silently no-op'd; see that finding for the two exact attack shapes this closes.

Expected (the `planDigest` field now reflects the CURRENT already-transitioned plan, not the
`--plan-digest` argument you supplied — that argument is intentionally never echoed back for a
no-op, only the freshly recomputed one):

```json
{
  "outcome": "noop_already_at_target",
  "orgId": "00000000-0000-4000-8000-000000000001",
  "state": "shadow",
  "planDigest": "4b5b212582ccae074136c8f8cf4bc9bb6ee395a7e2e9dbbdd61bd3e3b36fc0c1"
}
```

(This is the digest of the now-already-`shadow` plan — deliberately different from step 6's
digest of the pre-transition `legacy` plan; it depends only on the plan's own observable fields
— org, state, version, and every predicate — never on `--correlation-id`/`--actor-id`/manifest
content, so it reproduces byte-for-byte from the same database history.)

Exit code `0`. Re-run the two `psql` queries from step 6 — `version` is still `2`, and the event
table still has exactly one row. This did not perform a second transition.

## Step 8 — a refusal, worked: missing confirmation

```bash
pnpm exec tsx scripts/ops/attendance-w4c5-rollout-transition.ts apply \
  --org 00000000-0000-4000-8000-000000000001 \
  --target eligible \
  --expected-state shadow \
  --expected-version 2 \
  --plan-digest 0000000000000000000000000000000000000000000000000000000000000000 \
  --manifest /tmp/w4c5-manifest-legacy-to-shadow.json \
  --actor-id runbook-demo-operator \
  --correlation-id 00000000-0000-4000-8000-0000000000c3 \
  --engine-version w4c5-runbook-demo-v1
```

(`--confirm` deliberately omitted.) Expected stderr:

```
W4C5_TOOL_CONFIRMATION_REQUIRED
```

Exit code `3`. No database access was attempted — confirmation is checked during argument
parsing, before the CLI even opens a connection. The full refusal matrix (unknown org, org not in
the expected current state, an illegal transition pair, a stale/mismatched plan digest, and a
concurrent transition genuinely in flight), each with its own exact failure code and a real-
PostgreSQL mutation-tested proof, is in
`packages/core-backend/tests/integration/attendance-w4c5-rollout-transition-tool.db.test.ts`.

## Step 9 — tear down the scratch instance

```bash
dropdb -h localhost -p 54329 -U postgres ms2_w4c5_runbook_demo
pg_ctl -D /tmp/w4c5-scratch-pgdata stop
rm -rf /tmp/w4c5-scratch-pgdata /tmp/w4c5-scratch-pg.log /tmp/w4c5-manifest-legacy-to-shadow.json
```

## What this runbook does not authorize (repeated, deliberately)

Nothing above touches staging, production, a real synthetic org the owner has not explicitly
designated, any `ATTENDANCE_*` flag, a deployment, the seven-day soak, or issue 4556's closure.
`SEGMENT_CALCULATION_IMPLEMENTED` is untouched. If you are reading this to prepare a real
transition, stop after confirming the CLI and its tests behave as documented here, and take the
remaining steps (real org designation, real evidence collection, staging/production access) back
to the owner for separate, explicit authorization.
