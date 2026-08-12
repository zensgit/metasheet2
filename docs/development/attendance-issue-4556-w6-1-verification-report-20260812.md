# Attendance Issue #4556 W6-1 Verification Report

> Status: **RECORD / PRE-MERGE GATE**. This report records synthetic and
> isolated verification for PR #4849. Passing evidence is only one condition
> of the owner's bounded merge authorization and does not authorize runtime.
>
> Date: 2026-08-12
>
> Fresh base: `origin/main@24794811b1c800402006b30d6e4fa9df670e124e`
>
> Implementation and test evidence head before this record-only report delta:
> `39d9a969e4d36f6600a51b8cb7a527d39fce34cd`

## 0. Evidence rules

1. All database evidence used a newly created local PostgreSQL database and
   synthetic fixtures only.
2. Unit, database, wiring, provenance, type-check, GitHub CI, and independent
   review are separate evidence classes.
3. A report from an older SHA is discovery evidence, not exact-head approval.
4. Historical mutation narratives are not silently upgraded to fresh-head
   execution. Only commands listed as run in this report count as fresh-base
   execution.
5. The record-only report commit cannot cite its own SHA. The PR gate comment
   must bind the final exact head and state whether the report-only delta was
   included.

## 1. Environment

| Item | Value |
| --- | --- |
| Repository | `zensgit/metasheet2` |
| Base | `24794811b1c800402006b30d6e4fa9df670e124e` |
| Evidence head | `39d9a969e4d36f6600a51b8cb7a527d39fce34cd` |
| Database | Local PostgreSQL 15.17 |
| Scratch database | `metasheet_w6_4849_codex_20260812_d` on a local role; credentials were not recorded; the database was dropped after the run and absence was verified |
| Data | Synthetic only |
| Runtime posture | No feature flag, rollout transition, deployment, staging, or soak |

## 2. Fresh-base executions

### 2.1 Core unit and guard matrix

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-admin-plugin-lib-dist-layout-boot.test.ts \
  tests/unit/attendance-plugin-lib-resolver-hardening.test.ts \
  tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts \
  tests/unit/attendance-w6-group-effective-policy-aggregate.test.ts \
  tests/unit/attendance-w6-group-effective-policy-authorization.test.ts \
  tests/unit/attendance-w6-group-effective-policy-dml-sweep.test.ts \
  tests/unit/attendance-w6-group-effective-policy-response-contract.test.ts \
  tests/unit/attendance-w6-import-graph-no-calculation-consumer.test.ts \
  tests/unit/attendance-w6-producer-key-single-source.test.ts \
  tests/unit/attendance-w6-schedule-route-surface-parity.test.ts \
  tests/unit/api-path-policy.test.ts \
  tests/unit/api-path-policy.guard.test.ts \
  --watch=false
```

Result: **12 files / 300 tests passed**.

This matrix covers pure aggregate behavior, exact recursive response shape,
authorization and app-assembly guards, static DML call-path closure, API path
policy, invalid enum/state negatives, resolver behavior reached by the route,
and zero-segment compatibility fixtures. The authorization matrix includes a
DB-backed platform-admin positive leg whose principal has no legacy admin role:
the real `isAdmin(userId, runQuery)` query returns true on the shared
transaction handle, the membership query is skipped, and aggregate reads still
run on that handle.

The three net-new unit legs close the discovery-gate gaps: AST-derived resolver
call coverage with dynamic-target refusal, UUID enforcement at every
UUID-formatted response position, and rejection of a zero managed-set
`rowCount`. Existing fixture reproduction also pins the newly emitted
`RULE_SOURCE_MISSING` conflict.

### 2.2 Migration and real-DB execution

```bash
DATABASE_URL="$ATTENDANCE_TEST_DATABASE_URL" \
  pnpm --filter @metasheet/core-backend migrate

DATABASE_URL="$ATTENDANCE_TEST_DATABASE_URL" \
  pnpm --filter @metasheet/core-backend exec vitest \
  --config vitest.integration.config.ts run \
  tests/integration/attendance-w6-group-effective-policy.db.test.ts \
  tests/integration/attendance-w6-group-effective-policy-membership-overlap.db.test.ts \
  --watch=false
```

Result: migrations reached the current repository head; **2 files / 48 tests
passed**.

Observed real-DB legs include:

- exact values-free happy-path aggregate;
- zero-segment strict compatibility;
- PostgreSQL SQLSTATE `25006` rejection for a helper write and a write to an
  unlisted table on the shared read-only transaction;
- delegated membership and platform-admin reads on the same transaction-bound
  query handle;
- cross-org, selector-spoof, and inaccessible-group behavior;
- FSER byte-shape composition;
- membership overlap count, boundedness, and no choose-first result.

### 2.3 Required-CI wiring guard

```bash
node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs
```

Result: **221 / 221 passed**.

The count is the fresh-main count after PR #4804 and is not copied from the
older #4849 branch. The W6 database suites are represented in both required
places: no-DB exclusion and the executable attendance real-DB run list.

### 2.4 Sealed-export provenance

```bash
node --test \
  plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
```

Result: **1 / 1 passed**. A full call to `computePackageProvenancePinSet()`
also produced JSON byte-identical to the checked-in pin file. The recomputed
`pluginTestsWorkflow` SHA-256 remained
`be00b174108df71c67bdfd971af2098b00b0149cf6a08be45770d2f3b981e461`.

### 2.5 TypeScript

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit -p tsconfig.json
```

Result: **passed with zero diagnostics**.

## 3. Load-bearing evidence and limits

| Invariant | Fresh-base evidence | Limit |
| --- | --- | --- |
| Shared read-only transaction | Real PostgreSQL refuses two differently shaped writes with `25006`; normal aggregate reads pass | Does not claim repeatable-read isolation |
| Auth and org order | Unit/app-assembly guards plus real-DB delegated and cross-org legs | Global middleware security is repository-level policy, not redefined by W6 |
| Values-free exact shape | Recursive exact-key/value tests and real-DB response assertions | Internal count computation may read IDs |
| Closed enums | Invalid-value unit legs fail closed | Adding a new enum is a future contract amendment |
| FSER single source | Caller inventory and real FSER composition tests | W6 does not test or authorize FSER-4 member UI |
| Resolver containment | Closed-file, unique-root, regular-file, symlink-component, and realpath tests | Closed set intentionally rejects unlisted libraries |
| CI execution | Two-point wiring guard and fresh provenance verifier | GitHub required checks remain a separate post-push gate |

The branch history includes earlier adversarial mutations. They are useful for
test design, but this report does not claim that every historical manual
mutation was replayed after the fresh-main merge. The fresh executions above
are the authoritative local evidence for this report.

## 4. Independent model gates

Model roles are split so one model does not both implement and approve the same
claim:

- Kimi K3: preliminary test/CI bypass analysis;
- Grok 4.5: transaction, auth/org, FSER, response, and resolver review;
- GPT-5.6 Sol: exact-head code gate;
- GPT-5.6 Terra: exact-head evidence, scope, and claims gate.

The final exact-head outcomes will be recorded in a PR gate comment after fresh
checks and independent gates complete, because only that comment can bind the
SHA containing this report. Any P1/P2 requires a fix and a new exact-head gate;
an older-head approval cannot transfer by wording alone.

## 5. Verdict boundary

At the evidence head, the focused local matrix is green. The PR must remain
Draft/HOLD until its report delta is committed, pushed, fresh GitHub checks are
green, and the final exact-head independent gates report zero P1/P2. The
owner's separate instruction then permits this PR only to become Ready and
squash-merge, followed by an immediate stop at the exact merge SHA.

Even after those conditions, this report authorizes none of the following:

- W6-2, W6-3, or W6-4 runtime work;
- feature-flag or rollout-state change;
- deployment, staging, or soak;
- production or customer data;
- closing issue #4556.
