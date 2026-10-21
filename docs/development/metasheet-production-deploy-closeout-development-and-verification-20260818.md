# MetaSheet Production Deploy Closeout: Development and Verification

Date: 2026-08-18

Status: **MERGED, DEPLOYED, AND RUNTIME-VERIFIED for the scope recorded here**

This record covers the production deployment hardening in PR #4971, the
production deployment it triggered, and the read-only P4-B/P6 acceptance checks
performed after that deployment. It does not claim completion for unrelated
product work or for the separate Athena observation window.

## 1. Delivered scope

### 1.1 Deployment workflow hardening

PR [#4971](https://github.com/zensgit/metasheet2/pull/4971) changed only:

- `.github/workflows/docker-build.yml`
- `scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs`

The workflow now:

1. records the exact deploy-host sync exit code;
2. prevents the remote deploy from starting when host sync failed;
3. reports the sync result separately from the remote deploy result;
4. fails the final deploy gate when either phase failed; and
5. gives the automatic cold-deploy K3 WISE smoke a bounded 30,000 ms
   per-request timeout while retaining the manual workflow's 10,000 ms value.

PR #4971 adds no new retry or fail-open path.

### 1.2 Exact SHA chain

| Role | SHA |
| --- | --- |
| Reviewed PR base | `f9fc9807723263525110abf703c16ea72c66e4eb` |
| Reviewed PR head | `89ce89be6c170ba0f453a88b2514d5c51e2ac663` |
| Squash merge on `main` | `385a4338216314df32d4da6562b17c3b356de75b` |

The PR was rebased after `main` advanced during qualification. The earlier
green result was not reused: the two-file patch was replayed on the new base,
reviewed again, and the complete exact-head check set was rerun. This is why the
fresh-main gate was material rather than ceremonial.

## 2. Development verification

### 2.1 Local and source-level checks

- complete K3 operations command used by `plugin-tests.yml` and pinned by the
  integration-guard contract: **78/78 passed**;
- deploy workflow contract file in that command: **4/4 passed**;
- both workflow YAML files parsed with PyYAML;
- `git diff --check`: passed;
- the repository variable `K3_WISE_DEPLOY_SMOKE_TIMEOUT_MS` was unset, so the
  committed 30,000 ms default was selected; and
- the reviewed workflow and contract-test blobs were unchanged between the
  final source review and the exact-head run.

### 2.2 Exact-head PR gate

At `89ce89be6c170ba0f453a88b2514d5c51e2ac663`:

- visible PR checks: **14 passed, 0 failed, 0 pending**;
- Node 18 suite: passed in 15m51s;
- Node 20 suite: passed in 27m02s;
- web tests: passed in 6m22s;
- coverage: passed;
- unresolved review threads: **0**; and
- independent exact-head review: **0 P1, 0 P2, 0 P3**.

That independent review was a local read-only review session. No GitHub review
or repository review artifact was published for it.

The independent review retained two non-blocking implementation boundaries:
the job's final status is a normal exit-1 gate rather than propagation of the
raw sync exit code, and 30,000 ms is a per-request timeout rather than a total
smoke-duration cap.

## 3. Deployment and runtime verification

### 3.1 Authoritative deployment run

GitHub Actions run
[#32103960402](https://github.com/zensgit/metasheet2/actions/runs/32103960402)
completed successfully for merge SHA
`385a4338216314df32d4da6562b17c3b356de75b`.

The deploy job recorded:

- deploy-host sync: **exit 0**;
- remote preflight: **PASS**;
- deploy: **PASS**;
- migration: **PASS**;
- version verification: **PASS**;
- K3 WISE smoke: **12 passed, 0 skipped, 0 failed**; and
- final gate: **PASS**.

The actual job log, rather than the input-check artifact's diagnostic command,
is authoritative for the runtime value. It recorded
`K3_WISE_DEPLOY_SMOKE_TIMEOUT_MS=30000` and `smoke_rc=0`. The input-check
artifact still prints a 10,000 ms example command; that is an observability
wording debt, not the argument used by the automatic smoke step.

### 3.2 Deployed artifacts

| Component | Image | Digest |
| --- | --- | --- |
| Backend | `ghcr.io/zensgit/metasheet2-backend:385a4338216314df32d4da6562b17c3b356de75b` | `sha256:e96f778d55d24b843c07df6d3d489432fc3b5a2b3cdefa292ee13daccf37c3d5` |
| Web | `ghcr.io/zensgit/metasheet2-web:385a4338216314df32d4da6562b17c3b356de75b` | `sha256:f2f0172ca3a0d197cf7f76996eede555d0ecb949dd9929a7050cea1f4c1b98cc` |

Read-only host inspection confirmed that the production backend and web
containers use those exact tags. PostgreSQL and Redis were healthy. The
staging backend and web containers remained on
`815bd1a84410f9ee30c0b75255d10e995d19540d`; this production deployment did
not replace them.

Since the new backend started at `2026-08-18T05:47:34Z`, log-level counts were:

- `error`: **0**;
- `fatal`: **0**;
- unhandled lines: **0**; and
- migration-failure lines: **0**.

Substring searches for the word `error` also matched informational event names,
an attendance seed warning, and expired client-token warnings. Those were not
runtime `error`-level entries and are not represented as zero-warning evidence.

## 4. P4-B and P6 production acceptance

All database checks in this section were read-only and returned counts or
object names only. No customer field values were emitted.

### 4.1 P4-B schema and ledger

Post-deploy production checks returned:

- table `approval_form_field_revisions`: present;
- index `idx_approval_form_field_revisions_instance`: present; and
- `kysely_migration` row for
  `zzzz20260817130000_create_approval_form_field_revisions`: **1**.

### 4.2 P6 number-field corpus

The post-deploy census returned:

- approval templates: **6**;
- approval template versions: **6**;
- number fields: **4** total;
- top-level number fields: **2**;
- detail-column number fields: **2**;
- observed property-key counts: `min:4`; and
- property keys outside the eight-key allowlist: **0**.

This matches the pre-deploy census and shows that the production corpus did not
contain an unknown number-field property requiring migration before P6 landed.

## 5. Operational preparation

Before deployment, production disk usage was at 100% with approximately 626 MiB
free. Exactly 104 MetaSheet backend/web images that were not referenced by any
container were removed. No referenced image, volume, database, or running
container was removed. Approximately 39.4 GiB was recovered; post-deploy host
inspection showed 35 GiB available and 53% filesystem use.

The retained pre-deploy backup is:

- directory:
  `/home/mainuser/backups/metasheet-predeploy-pr4971-c2945a89b-20260818T033149Z`;
- dump size: `630519743` bytes;
- SHA-256:
  `02c9b9dbdf4153952945925a228d467a7786dd48fd6aba346d936e597cacdbc3`;
  and
- `pg_restore --list`: **PASS**.

A later backup attempt was interrupted by an unrelated automatic deployment.
Its partial dump failed classification and was deleted. It is not counted as
backup evidence.

## 6. Why the timeout change was needed

The preceding automatic cold-deploy evidence was discriminating:

| Run | Head | Result |
| --- | --- | --- |
| [#32096569585](https://github.com/zensgit/metasheet2/actions/runs/32096569585) | `f2ed020d1b38d0f40f1a0f80fa317eef486d2ae7` | automatic cold run: 6 pass / 6 fail at 10,000 ms |
| [#32097231841](https://github.com/zensgit/metasheet2/actions/runs/32097231841) | same SHA | later manual warm run: 12/12 pass |
| [#32100034647](https://github.com/zensgit/metasheet2/actions/runs/32100034647) | `680e93c018490b6d98cf7251fe431458c350afb5` | automatic cold run: 10 pass / 2 fail |
| [#32103960402](https://github.com/zensgit/metasheet2/actions/runs/32103960402) | `385a4338216314df32d4da6562b17c3b356de75b` | first automatic cold run at 30,000 ms: 12/12 pass |

The result supports the bounded timeout correction. It does not establish that
all future latency variation has been eliminated.

## 7. Explicit non-evidence and remaining boundaries

1. The separate `Deploy to Production` run
   [#32103960331](https://github.com/zensgit/metasheet2/actions/runs/32103960331)
   reported success but skipped its build/deploy jobs. It is not deployment
   evidence.
2. `approval-web-guard.yml` continues to create failed push runs with zero jobs
   on `main`, including run
   [#32103959541](https://github.com/zensgit/metasheet2/actions/runs/32103959541).
   The same `jobs=0` behavior predates this change, was not a required PR
   context, and remains independent CI trigger debt. Therefore this record does
   not say that every repository workflow is green.
3. The contract tests pin workflow structure and strings; they are not a proof
   of arbitrary GitHub Actions scheduler behavior.
4. No Athena image was built or deployed as part of this MetaSheet operation.
   Athena staging's separate 24-hour observation remains pending until its
   scheduled check completes on 2026-08-18 at 22:50 Asia/Taipei.

## 8. Closeout verdict

For this scope, the deployment workflow fix is built, tested, reviewed, merged,
deployed, and verified against the live production host. P4-B
schema/ledger acceptance and P6 production-corpus acceptance are complete.

The Athena observation window and the independent zero-job
`approval-web-guard` trigger debt remain open and must not be represented as
closed by this record.
