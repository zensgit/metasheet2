# Data Factory Large-BOM Production / Batch Rollout Gate

Date: 2026-06-08

This document defines the gate for moving the large-BOM stock-preparation
background expansion + checkpoint apply flow from entity-machine validation into
production or batch rollout.

It does not authorize production rollout by itself. It is a values-free
decision checklist that must be satisfied after the C3/C4 route stack is merged,
packaged, deployed, and validated.

## Scope

This gate covers:

- production readiness after the C3/C4 entity-machine validation runbook passes;
- limited production pilot entry;
- batch rollout entry;
- stop rules and routing when a validation or pilot fails.

This gate does not add runtime, route, UI, migration, package, worker, MetaSheet
write, PLM write, external database write, K3 path, raw SQL, or a new duplicate
policy. It also does not bypass D4 duplicate policy review, #2388 lifecycle /
missing-child semantics, or the C3/C4 validation runbook.

## Required Pre-Gates

All of these must be true before production or batch is discussed:

```text
stackMergedInOrder=true
packageBuiltFromMergedMain=true
packageFingerprintPresent=true
c3c4EntityMachineValidation=pass
valuesFreeEvidence=pass
durableStorage=true
targetReadiness=ready
rollbackOwnerAssigned=true
operatorCanInspectTarget=true
d4DuplicatePolicyStable=true|not_applicable
lifecycleMissingChildSemanticsCleared=true|not_applicable
```

Definitions:

- `stackMergedInOrder=true`: the C3/C4 large-BOM implementation stack is merged
  to `origin/main` in dependency order. A stacked branch head is not enough.
- `packageBuiltFromMergedMain=true`: the deployed package was built from the
  merged `origin/main` commit or release tag, not from an open PR branch.
- `c3c4EntityMachineValidation=pass`: the entity-machine runbook passed,
  including expansion, planning, checkpoint apply, re-pull idempotence, and
  values-free evidence.
- `d4DuplicatePolicyStable=true|not_applicable`: any duplicate held groups in
  the intended production data set have an owner-approved policy, or the
  production sample has no duplicate held groups.
- `lifecycleMissingChildSemanticsCleared=true|not_applicable`: the intended data
  set does not contain unresolved incomplete-assembly / missing-child-BOM cases,
  or the #2388 lifecycle/missing-child semantics have been reviewed for that
  data set.

## Hard Stop Rules

Stop and keep production/batch closed if any condition below is true:

- C3/C4 entity-machine validation failed or was not run.
- The deployed package fingerprint does not match a merged `origin/main` commit
  or approved release tag.
- Expansion is bounded, incomplete, or reports a scale/global error such as
  `max_rows_exceeded`, `read_page_limit_exceeded`, `max_depth_exceeded`,
  `cycle_detected`, or `read_failed`.
- C3 output is not authoritative.
- C4 apply job lacks a completed authoritative C3 plan/artifact revision.
- `manual_confirm` is non-zero without owner-approved hold posture.
- Duplicate held groups need D4 policy review.
- Missing-child / incomplete-assembly semantics are unresolved for the data set.
- Values-free evidence check fails.
- A read-only user can create or run apply.
- Writes land outside the configured stock-preparation target.
- `update` or `inactive` creates a missing row.
- `manual_confirm` writes anything.
- Re-pull shows new `add` decisions for rows that should already exist.
- Target cleanup / rollback path is unclear.
- Any issue evidence includes project numbers, component values, raw keys,
  PLM rows, target sheet ids, field ids, tokens, credentials, raw SQL, or
  value-bearing stack traces.

## Rollout Lanes

### Lane 0 - Entity-Machine Gate

Run the entity-machine validation runbook first. This lane is mandatory.

Required output:

```text
packageFingerprint=
validationIssue=
expansion.status=completed
expansion.authoritative=true
plan.planRevisionPresent=true
apply.status=succeeded|partial
apply.failed=0
idempotence.secondPlan.add=0
valuesFreeEvidence=true
operatorDecision=pass
```

If this lane fails, route to the relevant development track and do not open a
production pilot.

### Lane 1 - Owner-Approved Canary

Use one owner-approved production project or an equivalent canary target.

Requirements:

- deploy the same package fingerprint that passed Lane 0;
- run expansion and plan first;
- have the owner review counts and held/manual-confirm posture before apply;
- run checkpoint apply in bounded chunks;
- re-pull immediately after apply;
- keep all evidence values-free.

Pass condition:

```text
canary.expansion.authoritative=true
canary.apply.failed=0
canary.idempotence.add=0
canary.valuesFreeEvidence=true
canary.rollbackPathConfirmed=true
```

Canary with `partial` may pass only when held rows are explicitly expected,
owner-approved, and no clean-row failure exists.

### Lane 2 - Limited Production Pilot

Use a small, reviewed set of projects after the canary passes.

Requirements:

- same release/package family unless a new entity-machine validation reruns;
- per-project owner approval;
- per-project expansion/plan/apply evidence;
- no concurrent broad batch;
- no automatic retry storm;
- stop after the first unexpected failure.

Pass condition:

```text
pilot.projectCount=
pilot.failedProjects=0
pilot.unexpectedHeldGroups=0
pilot.idempotenceAllAddZero=true
pilot.valuesFreeEvidence=true
```

### Lane 3 - Batch Enablement

Batch rollout is allowed only after Lane 2 passes and the owner accepts the
operational posture.

Batch requirements:

- reviewed project list;
- max concurrent jobs per tenant/workspace/action;
- checkpoint storage retention reviewed;
- monitoring for queued/running/partial/failed jobs;
- explicit pause/resume owner;
- rollback owner and target-inspection process;
- no browser-supplied source, target, caps, plan, payload, sheet id, or field id.

Batch is not allowed when D4 duplicate policy or #2388 missing-child/lifecycle
semantics are unresolved for the project set.

## Rollback / Cleanup

Rollback must use the target system's normal admin/operator surface.

Allowed rollback evidence:

- created/updated/inactive/skipped/held/failed counts;
- job ids present/absent;
- status and error-code tokens;
- whether cleanup was completed.

Forbidden rollback evidence:

- raw project number;
- component code, component name, material id, source id;
- parent/path/idempotency key;
- target record id;
- sheet id or field id;
- raw PLM rows;
- raw payload JSON.

If rollback is required:

1. stop new apply jobs;
2. pause affected batch jobs;
3. inspect target rows locally through the authorized admin/operator surface;
4. remove or restore only rows associated with the owner-reviewed run;
5. re-pull to confirm no duplicate target rows remain;
6. post values-free closeout evidence.

Do not use raw SQL, external PLM DB writes, direct database edits, or a K3 path
for rollback.

## Values-Free Issue Evidence Template

```text
Large-BOM production / batch rollout gate

preGate:
  stackMergedInOrder=
  packageFingerprint=
  packageBuiltFromMergedMain=
  entityMachineValidation=
  durableStorage=
  targetReadiness=
  rollbackOwnerAssigned=
  d4DuplicatePolicyStable=
  lifecycleMissingChildSemanticsCleared=

canary:
  status=
  expansionAuthoritative=
  rowsExpanded=
  readCount=
  planAdd=
  planUpdate=
  planSkip=
  planInactive=
  planManualConfirm=
  applyCreated=
  applyUpdated=
  applyInactive=
  applySkipped=
  applyHeld=
  applyFailed=
  idempotenceAddZero=

pilot:
  projectCount=
  failedProjects=
  unexpectedHeldGroups=
  valuesFreeEvidence=

batchDecision:
  approvedForBatch=true|false
  approverPresent=true|false
  stopRuleTriggered=
  routedTo=
```

## Failure Routing

Route failures to one of these tracks:

- scale or bounded expansion: #2342 large-BOM capacity/background expansion;
- duplicate held groups: #2343 D4 held-group decision policy;
- missing-child / lifecycle ambiguity: #2388 lifecycle and node/edge model;
- write or target-readiness failure: C4 target write/readiness hardening;
- values leak: evidence/redaction hardening;
- package mismatch: rebuild/redeploy from merged `origin/main`;
- permission failure: integration auth / target-scope route hardening.

## Final Gate Statement

Production and batch remain closed until:

1. the C3/C4 route stack is merged and packaged from `origin/main`;
2. the entity-machine validation runbook passes;
3. the owner-approved canary passes;
4. values-free evidence is clean;
5. duplicate and lifecycle semantics are resolved for the intended data set;
6. rollback ownership and target cleanup are confirmed.

Passing this gate authorizes only the reviewed rollout lane. It does not
authorize unrelated K3 writes, PLM writes, external database writes, raw SQL,
new duplicate policies, or broader batch concurrency.
