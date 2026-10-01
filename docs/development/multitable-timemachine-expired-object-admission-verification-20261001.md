# Expired archive object admission verification

Status: local synthetic acceptance PASS, runtime OFF, Draft/HOLD. This bounded
REQUEST/READY slice does not complete original D-L, D-H2 or controlled staging.
Baseline `2472eb288391ae9a58ea8a5429d27abc636efee8`, branch
`codex/tm-archive-expiry-admission-20261001`. No commit/push/PR performed by this
implementation agent; publication belongs to the parent task.

## Result and authority boundary

The additive Kysely migration installs one intent per exact generation/object, an
immutable owner request/provider operation key, row-version CAS and audited hold
cancellation. One checked SECURITY DEFINER command owns the fence→key→generation→
job/plan→hold→object/reference→intent sequence. It refuses non-READ-COMMITTED calls,
non-expired generations, holds, nonterminal jobs/prepared plans, incomplete target
rosters, sole complete coverage, inexact/incomplete rotation candidates and stale
binding/CAS. Attachment completeness includes exact provider version and digest.
The command never invokes a provider, creates a worker claim or releases a reference.

PUBLIC base DML and all new function execution are revoked. No production role or
runtime grants are created. Future invocation requires an approved non-owner,
non-superuser role with no direct/inherited base mutation or authority DDL and only
necessary function grants. Owner/superuser arbitrary DDL is outside this boundary;
the existing application database configuration is not claimed safe for activation.
The owned test role demonstrated effective permission denial for direct DML,
SELECT FOR UPDATE, forged GUCs, a caller-created nested trigger, helper invocation
and authority alteration, while the granted command admitted a lawful REQUEST/READY.

Every existing archive/object/attachment/key reference remains retained. Hold placement
cancels requested/ready/failed_retryable atomically, preserves prior failed attempt/fence
metadata, and refuses deleting/deleted without committing a hold or partial cancellation.
Those external states are unreachable through this slice's command. The two real races
prove hold-before-READY refusal and READY-before-hold cancellation, not the future
hold-versus-provider-point-of-no-return protocol.

## Actual local verification

Node `v24.14.1`; owned offline/frozen-lockfile/ignore-scripts dependency installation.
Native PostgreSQL 15, newly initialized owned synthetic cluster. No existing database,
object provider, KMS, customer records or LC retained keys were used.

| Check | Command from core-backend unless stated | Result |
|---|---|---|
| New wrapper + hold unit neighbor | `pnpm exec vitest run tests/unit/multitable-recovery-archive-object-deletions.test.ts tests/unit/multitable-recovery-archive-legal-holds.test.ts` | 36/36 PASS, 0 skip |
| New real-DB authority + hold/key neighbors | `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/multitable-recovery-archive-object-deletion-admission-realdb.test.ts tests/integration/multitable-recovery-archive-legal-hold-authority-realdb.test.ts tests/integration/multitable-recovery-archive-key-registry-realdb.test.ts` | 51/51 PASS, 0 skip; new file 22 |
| Targeted source lint | `pnpm exec eslint src/multitable/recovery-archive-object-deletions.ts src/db/migrations/zzzz20261001130000_add_archive_expired_object_admission.ts` | exit 0 |
| Acceptance source types | `pnpm exec tsc --noEmit --pretty false --project scripts/tsconfig.recovery-archive-acceptance.json` | exit 0 |
| Fresh migration apply | `pnpm migrate` | exit 0 |
| Migration replay UNION | `pnpm exec tsx tests/integration/multitable-timemachine-migration-replay-realdb.verify.ts` | 35 migrations, 1059 catalog objects PASS |
| New and preexisting replay down injections | Same verifier with `TIME_MACHINE_REPLAY_INJECT_DOWN_FAILURE_AFTER` at new admission or existing writer-state migration | Each expected exit 1, `injected_down_failure`; normal replay afterward PASS |
| Exact-anchor + D2 archive source CI guards (repo root) | `node --test scripts/ops/multitable-exact-anchor-ci-wiring.test.mjs scripts/ops/multitable-d2-archive-ci-wiring.test.mjs` | 51/51 PASS, 0 skip |
| Hermetic sealed-export provenance (repo root) | `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` | exit 0 after one workflow evidence pin correction |
| Hermetic sealed-export S5 evidence neighbor (repo root) | `node plugins/plugin-integration-core/__tests__/sealed-export-s5-evidence.test.cjs` | exit 0 |
| Source formatting | `git diff --check` | exit 0 |

Replay fingerprint:
`3fd028c2a4dbc1184ea378f630a26d823c1dd65d3ea97fc953ec2ab92af5c012`.
The new real-DB selector is added to the executable Node20 multitable step in
`plugin-tests.yml`, excluded from the no-DB lane, and checked by a unit wiring guard.
New migration/table/functions/triggers are included in replay and the empty newer-layer
suspend/restore helper. Existing sibling selectors/migrations/negatives are preserved.
The exact-anchor source guard now requires the exact 35-migration replay UNION,
including the admission migration, while preserving retype and abandoned-binding
omission negatives. Its new admission omission mutation rejects removal. The D2
source guard requires all 15 archive acceptance files in both placements; separate
in-memory removal mutations reject deleting the new admission file from either
the executable workflow selector or direct no-DB exclusion. Both strict roster
comparisons remain intact. The final source-guard log and guard source hashes are
recorded in `artifacts/tm-dl-admission-20261001/manifest.json`. This source-only
correction did not alter runtime/migration source or require another database replay.
This is local Node24 evidence; exact-head Node20 CI is pending publication.

The hermetic provenance check at HEAD `74bc34bb9cdb4c3815b5f3f85e29c1786108677e`
first exited 1 because its workflow evidence pin predated the new acceptance selector.
`computePackageProvenancePinSet(repoRoot)` compared all 66 leaves and confirmed the
sole difference was `evidenceFiles.pluginTestsWorkflow`: `7229213b25c6ddc49bc795e90c8e5697488df22e80339a31f35271d0bb007cf9`
became the actual workflow SHA-256 `ad257aebcc7ea63a6e6ee4e749fadd069fba7056b5f85b48d2235acb503acd76`.
The other 65 leaves, including `runtimeFiles.pluginHttpRoutes`, remain exact. Only
that JSON pin changed; runtime, migration and workflow bytes remain unchanged.
Both hermetic checks above passed afterward without database/provider work. Original
failure evidence and before/after comparison, exit and hash receipts are preserved
under `artifacts/tm-dl-provenance-20261001/`. The new source head still requires its
own CI evidence; an earlier-head run does not cover this pin correction.

Nine load-bearing mutations each RED: expired state, hold refusal, job refusal,
complete replacement, row-version CAS, restricted ACL, hold cancellation,
READ COMMITTED and exact attachment version. Migration source byte-exact restored
SHA-256 `ba15441a23f14510c38b289297d3838f47eb16e8c91490739dd5354ee512dc66`.
The intentional RR mutation initially caused downstream fixture failures and retained a
synthetic hold/role; the owned database was reset after a zero-connection census.
Final fresh apply, all 51 tests and replay passed after restoration. The down-refusal
golden now creates its own committed intent, avoiding an order-dependent empty down.

Cleanup recorded connections=0, temporary roles=0, owned database dropped, pg_ctl
stop success/status exit 3 and cluster directory removed. Evidence is under
`artifacts/tm-dl-admission-20261001/`; logs redact synthetic identifiers and endpoint
values. No owned PostgreSQL process or role remains.

## Gate table and remaining work

| Gate | Status |
|---|---|
| Bounded REQUEST/READY/hold cancellation storage authority | Local PASS |
| Existing disabled runtime / custody / provider / flags | Unchanged; no caller/activation |
| Exact-SHA D1 ratification before D2+ merge | OPEN; no owner receipt inferred |
| Non-owner runtime role/grants + owner/tenant API/ops authorization | OPEN; default unavailable |
| Object deleting claim, lease takeover, idempotent reconciliation, receipt and reference release | OPEN |
| Original hold-versus-deleting crash/concurrency goldens | OPEN |
| Independent recovery-horizon sweeper / key-destruction authority | OPEN; LC retained keys remain retained |
| Original D-H2 committed capture block → fresh RR capture protocol | OPEN |
| Exact-head Node20 CI / merge / configured controlled staging / full acceptance | OPEN; parent-owned review/publication |

The conservative tradeoff is to treat all future-horizon catalog rows at the same
six-field exact identity as still legal. There is no independent owner-deleted point
catalog at this baseline, so no owner-deletion exemption or new horizon is invented.
A prepared restore plan is also conservatively retained until terminal/expired; this
can refuse cleanup earlier than a jobs-only census. Supersession is a hint that must
bind a verified complete exact replacement; later anchors never authorize deletion.
