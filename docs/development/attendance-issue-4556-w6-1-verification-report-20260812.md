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
> `d951b9e3da27a2b07615c5139c7e64edf656d104`

## 0. Evidence rules

1. Database evidence used a local migrated test database plus dedicated
   disposable databases for the fixture matrix and overlap shape. All seeded
   rows were synthetic; no production or customer data was used.
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
| Evidence head | `d951b9e3da27a2b07615c5139c7e64edf656d104` |
| Database | Local PostgreSQL 15.17 |
| Database isolation | Local `metasheet_test` for the shared route suite; per-run `attendance_w6_matrix_*` and `attendance_w6agg_overlap_*` databases created and dropped by their suites |
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

The DML matrix constructs fifteen named indirect or computed DB-seam spellings,
including local/destructured/assignment/object aliases, static and computed
element access, conditional/logical aliases, and `.call`/`.apply`/`.bind`.
Each produces a fail-closed finding. A literal DML statement through an alias is
independently rejected by both the seam classifier and the raw-text DML leg.
The detector is explicitly bounded rather than represented as complete
JavaScript data-flow analysis; opaque higher-order returns, arbitrary identity
functions, and object-spread propagation remain outside this secondary leg.

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
  tests/integration/attendance-w6-group-effective-policy-fixture-matrix.db.test.ts \
  tests/integration/attendance-w6-group-effective-policy-membership-overlap.db.test.ts \
  --watch=false
```

Result: the migration list reported **Applied: 314 / Pending: 0**, and the
real-DB matrix passed: **3 files / 57 tests**.

Observed real-DB legs include:

- exact values-free happy-path aggregate;
- zero-segment strict compatibility;
- PostgreSQL SQLSTATE `25006` rejection for a helper write and a write to an
  unlisted table on the shared read-only transaction;
- delegated membership and platform-admin reads on the same transaction-bound
  query handle;
- cross-org, selector-spoof, and inaccessible-group behavior, including the
  exact shared values-free `404` shape for missing and delegated-inaccessible
  groups;
- byte-equal query/body/header org selector positive controls plus mismatched
  and ambiguous selector 403 negatives before aggregate SQL;
- all eight committed aggregate fixtures reproduced from seeded rows with the
  canonical FSER and exact-key equality;
- FSER byte-shape composition;
- membership overlap count, boundedness, and no choose-first result.

### 2.3 Required-CI wiring guard

```bash
node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs
```

Result: **223 / 223 passed**.

The count is the fresh-main count after PR #4804 and the new fixture suite; it
is not copied from the older #4849 branch. All three W6 database suites are
represented in both required places: no-DB exclusion and the executable
attendance real-DB run list.

### 2.4 Sealed-export provenance

```bash
node --test \
  plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
```

Result: **1 / 1 passed**. A full call to `computePackageProvenancePinSet()`
also produced JSON byte-identical to the checked-in pin file. The recomputed
`pluginTestsWorkflow` SHA-256 is
`b689c385336cdc7c05d77086f9b6b147f7f40b5d2d9c3c48a1593e6c561585d6`.

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
| Values-free exact shape | Recursive exact-key/value tests plus an eight-shape seeded real-DB fixture matrix | Internal count computation may read IDs |
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

The first report-head review round at
`89b3fff8cdd8d8b53a37277f6142ae83fb648fb4` produced two P2 findings: the
delegated-inaccessible response differed from the ratified values-free `404`
shape, and six indirect/computed DB-seam forms disappeared from the static
classification. A later adversarial pass found additional assignment,
object-property, conditional, and object-destructuring spellings; evidence head
`c9005abe8c7d8efcabe0fdadd327635c3b4e121b` contains the bounded-grammar repairs
and the fresh local executions above. All final model
gates must therefore rerun against the later exact PR head that includes this
report; the earlier outcomes remain discovery evidence only.

The next independent round at `a5738017edd2698db5fbda6a2aa73011ad5ba461`
found three P2s: query-org mismatch returned generic 400, the eight fixture
shapes lacked a seeded real-DB exact matrix, and ratified §7.2 still contradicted
the normative 404 rule. Evidence head
`413271e2d7a14aa21a9c5be48001d9c15c432b5d` closes the first two and carries
fresh local execution for both. The third remains an owner-governed durable
text correction, not an implementation decision.

The following evidence gate at
`4d2a9b217880290d33a92b9508e14ba469fca3f0` reproduced a required-test
failure: the new fixture-matrix suite called canonical FSER directly but its
exact file identity was absent from the FSER caller inventory. Evidence head
`d951b9e3da27a2b07615c5139c7e64edf656d104` adds that test file to the
closed set without widening any production caller allowance. The inventory
passed `8 / 8`, and the full command in §2.1 passed `12 files / 300 tests`.

The same review found a governance contradiction in the ratified source:
W6-R3 and endpoint §4.1 require missing and inaccessible groups to share one
values-free `404`, but completion-skeleton §7.2 still says delegated non-member
`403`. Runtime and tests follow the normative red line. This report discloses
but does not amend that ratified text; a durable owner correction remains a
separate prerequisite if the final gate continues to grade the contradiction
P2.

## 5. Verdict boundary

At evidence head `d951b9e3da27a2b07615c5139c7e64edf656d104`, the
focused local matrix is green. The PR must remain Draft/HOLD until its report
delta is committed, pushed, fresh GitHub checks are green, the ratified-lock
contradiction above is durably resolved if a new gate continues to grade it P2,
and the final independent gates report zero P1/P2.
The owner's separate instruction then permits this PR only to become Ready and
squash-merge, followed by an immediate stop at the exact merge SHA.

Even after those conditions, this report authorizes none of the following:

- W6-2, W6-3, or W6-4 runtime work;
- feature-flag or rollout-state change;
- deployment, staging, or soak;
- production or customer data;
- closing issue #4556.
