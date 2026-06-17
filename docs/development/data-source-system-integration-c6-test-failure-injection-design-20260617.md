# Data Source System Integration C6 - Test Failure Injection Design

Status: C6-5a design only; no runtime, no route, no UI, no package
Date: 2026-06-17

## Purpose

C6 external write still needs one entity-machine proof before the database/source
system integration line can close: a controlled write-time row failure must
produce values-free row-level evidence while clean sibling rows are not silently
swallowed.

Issue #2720 already proved the core C6 path on the entity machine:

- sandbox dry-run/apply/re-pull/rollback passed;
- the dedicated read-only route subgate passed;
- the controlled bad-row path could not use a reversible DDL/trigger shape
  because the target principal lacks the needed PostgreSQL privilege;
- the operator also reported that a seeded naturally failing row/constraint
  shape cannot be reset safely values-free in the current sandbox.

That leaves `HOLD_NO_SAFE_FAILURE_SHAPE`. This document defines the only
acceptable next direction: a separate, test-only, sandbox-only failure-injection
slice. It is a design contract, not implementation authorization.

## Non-Goals

This slice does not:

- add a production runtime hook;
- add a broad write-path fault-injection mechanism;
- allow the browser or API request body to choose failing rows;
- add raw SQL, DDL, trigger, stored procedure, CTE, or generic execute support;
- change C6 dry-run/apply authorization;
- relax dry-run token, revision fence, or single-use token rules;
- touch K3 Save / Submit / Audit / BOM;
- authorize production or batch writes;
- produce a new on-prem package;
- mark C6-5 as passed.

## Trigger And Routing

The test-only injection path may be opened only after all of these are true:

1. C6 core sandbox dry-run/apply/re-pull/rollback has passed on the entity
   machine.
2. The dedicated read-only route subgate has passed.
3. A reversible DDL/trigger-backed write-time failure shape is unavailable.
4. A seeded naturally failing row/constraint shape is unavailable or unsafe to
   reset values-free.
5. The issue evidence reports:

```text
controlledBadRow=hold
controlledBadRowStopReason=no_safe_failure_shape
failureShape=no_safe_failure_shape
```

If a real sandbox write-time failure shape becomes available later, prefer that
real target failure over this test-only mechanism.

## Trust Boundary

The failure injection must be server-owned and double-gated:

- process/deploy gate: disabled by default, enabled only by an explicit
  test-only environment flag such as
  `METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED=true`;
- server config gate: enabled only for an admin-reviewed sandbox C6 target or
  pipeline configuration;
- target kind gate: target external system must be
  `data-source:sql-write-gated`;
- sandbox gate: target config must declare `environment=sandbox`;
- raw-query gate: target data source must still have
  `genericQueryDisabled=true`;
- auth gate: C6 apply still requires write/admin permission;
- review gate: C6 apply still requires a fresh single-use dry-run token and an
  explicit operator confirmation;
- revision gate: apply must still recompute the plan and reject revision drift
  before any injected or real write.

The request body must never enable, disable, parameterize, or target the
injection. If a client sends fields such as `failureInjection`, `injectFailure`,
`failRow`, `rowIndex`, `rowFingerprint`, `targetObject`, `plan`, or `payload`,
the route must reject or ignore them according to the existing C6 scope-rejection
contract, and tests must prove the injected path is not activated.

No missing gate may fall back to tenant, workspace, admin, service, default, or
system identity.

## Injection Semantics

The future implementation may inject exactly one row-level write failure in a
sandbox C6 apply.

Required behavior:

- select the failing row deterministically from the server-recomputed dry-run
  plan using a values-free stable row fingerprint or ordinal;
- require at least one clean sibling row in the same apply so the test proves
  partial success, not only total failure;
- inject after dry-run token validation, token consumption, and revision
  recompute, so the gate exercises the real apply path;
- inject at the structured write boundary, before or at the same layer that
  calls `insertRows` / `updateRows`;
- return a synthetic values-free row error token such as
  `C6_TEST_INJECTED_ROW_FAILURE`;
- keep clean sibling writes eligible and observable;
- emit values-free row result, dead-letter, and provenance evidence for the
  failed row when the normal C6 stores are available;
- preserve re-pull idempotence: a post-apply dry-run must show no duplicate
  target rows and no silent retry of the failed injected row without another
  explicit review/apply.

The injection must not mutate source rows, target rows outside the reviewed plan,
target schema, credentials, or pipeline configuration.

## Evidence Contract

Allowed evidence:

- package fingerprint;
- route names;
- target kind;
- sandbox/test-injection enabled flags as booleans;
- counts: planned, written, failed, dead-lettered;
- error code tokens;
- row fingerprints or opaque hashes;
- whether at least one clean sibling wrote;
- whether production/batch/K3/raw-SQL boundaries stayed closed.

Forbidden evidence:

- credentials;
- connection strings;
- host/database names unless already approved as names-only metadata;
- data-source ids;
- row values;
- target payload JSON;
- raw SQL;
- dry-run tokens;
- private sheet/field ids;
- value-bearing stack traces.

Example values-free result:

```text
c6TestFailureInjection:
  enabledByDeploy=true
  enabledByServerConfig=true
  clientControlled=false
  targetKind=data-source:sql-write-gated
  environment=sandbox
  dryRunTokenRequired=true
  revisionMatched=true
  injectedRows=1
  cleanSiblingWritten=true
  apply.status=partial
  deadLetters.count=1
  rowErrorTypes=C6_TEST_INJECTED_ROW_FAILURE
  productionWrite=false
  batchWrite=false
  rawSql=false
  k3Write=false
  valuesFreeEvidence=true
```

## Implementation Acceptance For C6-5b

A future implementation PR must include all of these tests:

- default-off: with the env flag absent or false, no injected failure can occur;
- server-config gate: env true but no admin-reviewed sandbox config still does
  not inject;
- sandbox-only: non-sandbox target fails closed before write when injection is
  requested by server config;
- target-kind guard: only `data-source:sql-write-gated` can use the test path;
- raw-query guard: target must remain `genericQueryDisabled=true`;
- client cannot activate injection: request body fields cannot select or enable
  the failed row;
- token/revision first: missing, stale, used, or mismatched tokens block before
  any injected write;
- single-row failure: exactly one row receives the synthetic error token;
- clean sibling writes: at least one valid sibling row writes in the same apply;
- values-free dead-letter/provenance: no row values, payload JSON, SQL text,
  data-source ids, credentials, tokens, or value-bearing messages;
- ordinary C6 apply remains unchanged when the test gates are off.

At least one integration-style test must drive the real C6 apply route with a
fake structured write facade; a helper-only fixture is not enough.

## Entity-Machine Acceptance For C6-5c

After C6-5b lands and a new sandbox package is published, #2720 may continue
with this ordered sequence:

1. deploy package and confirm checksum/health;
2. confirm the test-injection deploy flag is enabled only for the sandbox
   package/environment;
3. dry-run through the dedicated C6 route;
4. apply with the fresh token and explicit review confirmation;
5. verify `apply.status=partial`, one synthetic row error, and at least one clean
   sibling write;
6. verify dead-letter/provenance are values-free;
7. re-pull and verify idempotence/no duplicate target rows;
8. clean up with operator-local sandbox controls;
9. disable the test-injection flag after validation.

If any evidence contains values or any boundary opens, stop and report HOLD.

## Sequencing

- C6-5a: this design and tracker/runbook updates. Docs only.
- C6-5b: implement the default-off test-only injection seam and tests. Separate
  opt-in.
- C6-5c: publish a sandbox package and rerun #2720 controlled bad-row evidence.
  Separate opt-in.

C6-5 remains open until C6-5c passes. Production and batch rollout remain closed.
