# Attendance x Multitable Cleaning ACP-1 Owner Decision Packet

Status: **PROPOSED — NOT RATIFIED — NO IMPLEMENTATION AUTHORITY**
Prepared: 2026-08-31 (Asia/Taipei)
Repository: MetaSheet2
Authority rule: runtime work may start only after the owner ratifies the exact decisions below and the ratified lock is bound to an exact merged commit.

## 1. Exact audit snapshot

- `origin/main`: `5e657ea9b321f5b3c9b771da9d3159ba8943e0e5`
- Audit worktree: detached `42afaa030d7d9be6279e8cb32df73c39f4f608a5`, clean; no edits made there.
- PR #5372: Draft/CLEAN, head `1b9c20c1a3d8bd687fcbf7973d751bfa0b002dc0`, base `de9e6ceb88d0b388c6283d22744e2190e1eb7269`.
- PR #5362: bounded replay in progress, Draft/MERGEABLE, head `43b8fa2e7cc7ecc789a508476477b9e60b49eff0`, base `5e657ea9b321f5b3c9b771da9d3159ba8943e0e5`; relative scope remains exactly `AttendanceView.vue` plus its admin regression spec and does not overlap Option A files.
- All OPEN attendance PR bodies, file lists, and full diffs were searched for `ACP-1`, `OD-ATC`, cleaning proposal/review/apply, and multitable attendance writeback authority. No exact ratification exists.
- The RATIFIED #5372 OD-MCD lock authorizes managed projection CAS/self-heal only. It explicitly keeps the projection one-way and excludes reverse write, UI, OpenAPI, permission expansion, and notification changes.
- The current platform multitable application model is DRAFT. It is architectural context, not attendance runtime authority.

Conclusion: **STOP before runtime implementation.** This packet must not be cited as product authority until the owner ratifies it and the ratified text is committed on the accepted base.

## 2. Product objective

Allow an attendance administrator to use a multitable daily-report row as a controlled proposal surface:

1. inspect canonical attendance facts projected into a managed multitable sheet;
2. mark an anomalous row as a proposal to normalize the result to `normal` and enter a reason;
3. review the proposal in the attendance administration UI;
4. approve one proposal at a time;
5. approve-and-apply through the existing W4 `manual_edit` canonical writer;
6. bind the normalized proposal-content digest and reviewer decision to the existing immutable result-edit audit;
7. reproject canonical facts while preserving proposal/custom columns.

The multitable is a collaboration and cleaning workspace, **never the attendance system of record**.

## 3. Proposed owner decisions

The owner may ratify the recommended **Option A** contract in one response:

> RATIFY ACP-1A OD-ATC-0..10, all option (a).

| ID | Recommended option (a) |
| --- | --- |
| OD-ATC-0 Authority | Only an exact merged design-lock SHA authorizes runtime work. Before that SHA, no runtime implementation, migration, API, UI, or CI wiring. |
| OD-ATC-1 Source of truth | `attendance_*` and the W4 calculation/result-edit boundary are the sole canonical source. Multitable data is an untrusted proposal and can never directly overwrite attendance facts. |
| OD-ATC-2 V1 scope | Only existing anomalous daily result rows. The only correction is `late`, `early_leave`, `late_early`, `partial`, or `absent` to `normal`. No metric overrides. Raw punches, leave, overtime, business trip, missed-punch creation, period summaries, and bulk actions are out. |
| OD-ATC-3 Ownership | V1 adds exactly two user-owned fields, `cleaning_requested` and `cleaning_reason`, to the existing report projection. They are excluded from the managed projection map. Managed canonical anchors and unrelated custom columns are preserved; neither can be supplied by the approve request. V1 does not claim an independent proposal object or ledger. |
| OD-ATC-4 Authority and tenancy | V1 authoring and approval are limited to users who already have sheet access and are authenticated, active, same-organization `attendance:admin`; it adds no grant or privilege. Self-review is allowed to match existing anomaly-edit authority. Ordinary employees and delegated cleaners are deferred. Release/enable remains blocked until tenant-safe sheet access is separately proven. |
| OD-ATC-5 Derived state | V1 state is derived only as `absent`, `pending`, `consumed`, `preapply_conflict`, or `applied_pending_cleanup`. Setting `cleaning_requested=true` with a valid reason creates the current pending proposal; clearing it withdraws the proposal. V1 has no durable submit/reject/approved state machine and must not claim one. |
| OD-ATC-6 Dual CAS | Before canonical apply, freeze and re-read the multitable record version plus canonical record/current-calculation ID and version. Any pre-apply drift produces a values-free conflict and zero new attendance DML. After canonical commit, a proposal-cleanup CAS conflict is a distinct `applied_pending_cleanup` result: canonical DML already occurred exactly once and must not be rolled back or repeated. |
| OD-ATC-7 Canonical sink | The server derives a bounded, values-safe `reviewedProposalRef` from the authenticated context and normalized proposal digest, then extends the existing anomaly-result-edit entry to call W4 `manual_edit`. The client cannot supply this reference. No raw `attendance_*` update, new open command kind, or policy bypass is allowed. |
| OD-ATC-8 Approve-and-apply and idempotency | V1 has one explicit approve-and-apply action; the attendance admin UI is the review surface and W4/result-edit audit is the reviewer/apply authority. Logical proposal identity/revision is a digest of organization, report record, canonical source fingerprint, `requested=true`, and normalized reason. `meta_records.version` is only a CAS precondition; record version and custom columns are excluded from the digest and operation ID. Post-canonical cleanup conflict is reconciled by stable operation readback on retry. |
| OD-ATC-9 Audit and evidence | The normalized proposal digest, server-derived reviewed reference, authenticated reviewer, stable operation ID, and existing result-edit audit form the durable linkage. V1 does not claim an independent immutable proposal/review ledger. Reason/evidence use a bounded allowlist; errors and logs remain values-free. |
| OD-ATC-10 Rollout | The existing result-edit policy/flag remains default OFF and is not enabled here; ACP-1 adds no new flag. Apply explicitly suppresses notification/external fan-out. The Draft/HOLD may be completed, but release/enable is blocked on tenant-safe permissions and CI selection. OpenAPI, deployment, staging, production, real customer data, business trip, leave, overtime, raw punch, bulk, and a full proposal lifecycle require separate locks. |

## 4. Minimal ACP-1 product slice

Name: **daily report normalize-to-normal proposal (Option A)**.

User-visible flow:

```text
managed daily attendance projection
  -> admin sets cleaning_requested=true + cleaning_reason
  -> attendance admin UI lists the proposal
  -> admin clicks "Approve correction to normal"
  -> server binds authenticated actor and organization
  -> server re-reads proposal and canonical facts
  -> proposal CAS + calculation CAS
  -> existing W4 manual_edit transaction and audit
  -> proposal CAS cleanup
  -> canonical report reprojection
```

The approve request must not accept client-supplied organization, employee, work date, target status, metrics, reason, punch, or business-trip facts. It accepts only the route record identity and expected multitable record version. Every authoritative value and the normalized reason are re-read by the server.

Option A intentionally combines review and apply. It does not expose a standalone approval state or immutable proposal ledger. A later full-lifecycle design is described in Section 7 and is not part of this slice.

## 5. Proposed implementation boundary

Implementation must wait until #5372 is merged to then-current `main` and post-merge checks are terminal green. ACP-1 must start from a fresh worktree at that then-current `origin/main`; it must not stack on #5372 or copy its CAS code.

Attendance-owned product and dedicated tests:

1. `plugins/plugin-attendance/lib/attendance-report-cleaning-proposal.cjs` — new pure policy/planning module.
2. `plugins/plugin-attendance/index.cjs` — additive fields and minimal route/injection wiring only.
3. `packages/core-backend/tests/unit/attendance-report-cleaning-proposal.test.ts` — new dedicated unit contract.
4. `packages/core-backend/tests/integration/attendance-report-cleaning-proposal.db.test.ts` — new isolated real-DB contract.
5. `apps/web/src/views/attendance/AttendanceReportFieldsSection.vue` — pending list and single-record approval UI.
6. `apps/web/tests/AttendanceReportFieldsSection.spec.ts` — dedicated user-flow tests.

Explicitly excluded from the product slice:

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/attendance-admin-regressions.spec.ts`
- shared multitable runtime and SDK files
- migrations and PostgreSQL schema
- OpenAPI and shared manifests
- workflow and global selector files
- flags, external writes, dispatch, deployment, and production

## 6. Conditional shared decision/window

Current multitable permissions do not by themselves prove tenant-safe proposal-sheet access:

- global `multitable:write` can grant generic record editing;
- an unassigned sheet does not automatically become default-deny;
- plugin provisioning currently has no API to create the required organization/admin sheet grant;
- plugin record revision history currently records a system actor rather than the human reviewer.

Before release, the owner must choose one of these permission/evidence contracts:

1. **Option A contract:** the Draft/HOLD only serves existing same-org attendance administrators and adds no grant. Release/enable waits for an explicit tenant-safe sheet grant through a separately reviewed shared seam. Canonical W4 audit remains the human actor authority; multitable revision is system projection evidence.
2. Require human actor identity in multitable revision history, which adds an actor-aware shared patch API and its own real-DB tests.

If existing `spreadsheet_permissions` can express the grant, prefer it and avoid a migration. A migration is requested only after proving the existing schema insufficient. The attendance-owned Draft/HOLD may close before this shared seam, but it must remain disabled and cannot be called release-ready.

## 7. Deferred Option B: full independent lifecycle

Option B is a different product and must not be mixed into Option A. It adds a durable attendance-owned proposal workflow with separate submit, approve/reject, apply, and projection states.

It requires at least:

- authoritative attendance tables for proposals, append-only normalized revisions, append-only reviewer decisions, apply links to `attendance_record_result_edits`, stable-operation uniqueness, and a durable projection outbox;
- a migration plus migration replay/rollback review and real-DB lifecycle, concurrency, idempotency, and outbox-reconciliation tests;
- organization-scoped base/sheet provisioning, `spreadsheet_permissions` grants, field permissions, record ownership/write-own rules, and plugin-scoped grant tests in shared multitable services;
- a closed W4 internal `reviewedProposalRef`/apply-link contract so proposal state, canonical manual edit, operation, and audit are committed atomically;
- an additional actor-aware CAS patch API only if the owner requires the multitable revision itself to record the human reviewer. Otherwise the attendance decision/audit remains actor authority and projection writes remain system-attributed.

Option B cannot be delivered in the six attendance-owned Option A files and requires separately authorized DB/shared windows.

## 8. Refute-first acceptance matrix

### Pre-fix RED

- New policy module and routes are absent.
- The two proposal fields are absent and are not protected by an ownership contract.
- The admin component has no pending-proposal approval flow.
- The real-DB path has no dual-CAS/idempotency proof.

These failures must be captured before implementation; a newly written test that passes against the old code is not a discriminating test.

### Unit contract

- Exactly two additive user-owned fields; repeated provisioning is a no-op; managed projection IDs exclude both.
- Parser accepts only `cleaning_requested === true` and a trimmed, bounded reason.
- Target is a server literal `normal`; custom target, metrics, punch, and business-trip keys are ignored/rejected.
- Logical proposal digest and operation identity are deterministic across `meta_records.version` and unrelated custom-column changes, but change with normalized reason or canonical source fingerprint.
- Proposal cleanup patch contains exactly the proposal keys and never the full row, managed values, or custom columns.
- Serialized failures and logger arguments do not contain sentinel business values.

### Real-DB contract

- Happy path creates one W4 manual edit, one immutable result-edit audit, one sealed operation, and clears only proposal fields; unrelated custom data survives.
- Policy/flag OFF fails closed with zero proposal, canonical, audit, or revision mutation and never enables a setting.
- A token with generic multitable write but no same-org active `attendance:admin` cannot list or approve.
- Cross-organization and tampered anchor attempts fail non-leaking with zero writes.
- Stale proposal version is rejected before canonical mutation.
- A genuine post-canonical proposal CAS race returns a retryable cleanup conflict, records canonical apply exactly once, preserves the proposal, and succeeds safely on same-operation retry.
- Duplicate/replayed approval creates exactly one canonical edit and audit.
- Stale W4 calculation ID/version fails closed; sealed command carries actual expected calculation identity and stable operation ID.
- Canonical failure leaves proposal intact; cleanup failure after canonical is reconciled through idempotent readback.
- Report resync and #5372 same-fingerprint drift repair preserve proposal and unrelated custom columns.
- Isolated database, settings, revisions, and connections leave zero residue.

### Web contract

- Pending list/count and fixed action "Approve correction to normal" are visible only to authorized admins.
- Approval sends only `expectedVersion` to the record-specific route; double-click sends one request.
- Success/already-applied removes the row.
- Pre-canonical conflict asks for reload; post-canonical cleanup conflict keeps the row and offers safe retry; neither shows false success.
- Disabled/permission/server errors are localized, values-free, and do not break the report panel.
- Organization changes, reload, and unmount clear stale selection/proposal state.
- Required web classifier and target argv are mechanically pinned before CI closure is claimed.

## 9. Required mutation kills

The following mutations must each make a named test RED:

1. trust request/query organization or proposal-row organization;
2. accept client target, metrics, reason, employee, date, punch, or business-trip facts;
3. bypass W4/result-edit policy or write `attendance_*` directly;
4. randomize operation ID or include proposal version/custom columns in it;
5. clear proposal before canonical success;
6. drop expected proposal version or make patch unconditional;
7. patch the full row instead of proposal-only keys;
8. swallow cleanup CAS as success;
9. accept normal source, raw punch, or business-trip correction;
10. log raw proposal/canonical values;
11. add proposal fields to the managed projection map;
12. remove the new real-DB/web test from required CI selection.

## 10. Validation commands and closure evidence

Final commands must be copied from then-current workflows. The planned minimum is:

- dedicated unit tests plus neighboring attendance field-catalog and managed-drift tests;
- isolated PostgreSQL real-DB test plus existing result-edit and multitable revision neighbors;
- Node 18 and Node 20 target repeats, at least five each for the concurrency-sensitive lane;
- attendance component/web guard tests and the existing admin regression suite;
- backend and web type checks;
- plugin validation and `node --check` for each CJS file;
- `git diff --check <exact-base>...HEAD`;
- migration ledger unchanged;
- exact database/process/residue census;
- exact-head remote CI census with failures, pending jobs, intended skips, and the tested SHA.

Workflow or shared test-selector edits require a separately granted bounded window. Until the new unit/real-DB/web files are proven selected in required lanes, a green PR is not CI closure.

## 11. Model allocation for the future implementation

This is a separation-of-duties plan, not authority to start work:

- **Sol:** owns security-critical architecture, W4 boundary integration, dual-CAS/idempotency review, and final merge-blocking audit.
- **Grok 4.6:** independent adversarial call-chain and concurrency review; proposes mutations and checks for bypasses. Codex independently verifies all output.
- **Terra:** implements bounded attendance policy/wiring and focused unit/integration tests after ratification.
- **Luna:** handles mechanical repository census, repeated focused test runs, diff/status evidence, and values-free scans.
- **Opus 5:** independent product/authority review of proposal lifecycle, permissions, UX semantics, and acceptance completeness.
- **Sonnet 5:** implements/reviews the bounded Vue component and web tests under the locked API contract.
- **Fable 5:** produces end-user wording, empty/error/conflict states, and final development/validation documentation; it does not decide security or canonical write rules.

Outputs from unavailable external models are optional independent reviews, not required build inputs. The accountable coding agent must re-read diffs and rerun the evidence locally.

## 12. Stop conditions

Stop immediately and report the exact blocker if:

- owner decisions are not ratified or conflict with this packet;
- #5372 changes or is not merged on the starting main;
- `origin/main` drifts after preflight or relevant OPEN PR overlap changes;
- Option A requires permission or actor semantics beyond the ratified Draft/HOLD boundary;
- evidence suggests production audit loss instead of delayed/retryable visibility;
- the slice requires raw attendance writeback, permission expansion, notification fan-out, OpenAPI, migration, or deployment;
- file scope expands beyond an authorized window.

Tenant-safe shared permission work is a release blocker, not authority to silently expand the attendance-owned PR. No Ready, merge, flag enable, dispatch, staging, deploy, production, or real customer data is authorized by this document.
