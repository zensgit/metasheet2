# Attendance x Multitable Cleaning ACP-1 Owner Decision Packet

Status: **OWNER DECISIONS RATIFIED — DESIGN LOCK DRAFT/HOLD; NO RUNTIME AUTHORITY UNTIL THE EXACT MERGED SHA**
Prepared: 2026-08-31 (Asia/Taipei)
Repository: MetaSheet2
Authority rule: runtime work may start only after the owner ratifies the exact decisions below and the ratified lock is bound to an exact merged commit.

## 1. Exact audit snapshot

The following is the proposal-head audit snapshot ratified by the owner. Later state changes are recorded separately and do not rewrite the approved decisions.

- `origin/main`: `5e657ea9b321f5b3c9b771da9d3159ba8943e0e5`
- Audit worktree: detached `42afaa030d7d9be6279e8cb32df73c39f4f608a5`, clean; no edits made there.
- PR #5372: Draft/CLEAN, head `1b9c20c1a3d8bd687fcbf7973d751bfa0b002dc0`, base `de9e6ceb88d0b388c6283d22744e2190e1eb7269`.
- PR #5362: bounded replay in progress, Draft/MERGEABLE, head `43b8fa2e7cc7ecc789a508476477b9e60b49eff0`, base `5e657ea9b321f5b3c9b771da9d3159ba8943e0e5`; relative scope remains exactly `AttendanceView.vue` plus its admin regression spec and does not overlap Option A files.
- At proposal head `c50f65f55273842ba8b96245e3004ca58832af9d`, all OPEN attendance PR bodies, file lists, and full diffs were searched for `ACP-1`, `OD-ATC`, cleaning proposal/review/apply, and multitable attendance writeback authority. No earlier exact ratification existed; the later direct-owner decision is recorded in Section 3.
- The RATIFIED #5372 OD-MCD lock authorizes managed projection CAS/self-heal only. It explicitly keeps the projection one-way and excludes reverse write, UI, OpenAPI, permission expansion, and notification changes.
- The current platform multitable application model is DRAFT. It is architectural context, not attendance runtime authority.

Follow-up at ratification: `origin/main` is `919dc42366d3464c0b941448fad880c88f3f7cf5`; PR #5362 has since merged as `f45f6bb399d4d8131e3bf39e314212828b80e5b2`, and PR #5348 has since merged as `919dc42366d3464c0b941448fad880c88f3f7cf5`. Neither merge overlaps the six ACP-1 product files. PR #5372 remains Draft/HOLD and unmerged, so its old exact-head green checks are not proof of a then-current-main merge candidate.

Follow-up at OD-ATC-10R ratification: `origin/main` is `1a936c7dbfb3e62dd3e05b60f91cecbd28862e45`; the intervening #5368, #5365, and #5367 approval/automation changes do not overlap the six ACP-1 product files. PR #5372 remains Draft/HOLD and unmerged.

Conclusion: the owner-decision gate is closed, but **STOP before runtime implementation** until the exact ratified design-lock SHA is merged and the Section 5 dependency, fresh-main, and post-merge gates are satisfied. This evidence record cannot authorize itself.

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

## 3. Ratified owner decisions

### Ratification evidence

- Source: direct owner turn in Codex task `01a0528d-2a67-7ce3-9e23-3d3820d7d733`; no separate owner display identity was exposed, so none is inferred.
- Received: 2026-08-31 (Asia/Taipei); no time is recorded because the source did not expose a verifiable timestamp here.
- Ratified proposal: PR #5381 head `c50f65f55273842ba8b96245e3004ca58832af9d`, document blob `50e9ff52abd45b2616031c43b5e30222c23c6539`.
- Scope: `ACP-1A`, `OD-ATC-0..10`, 11 decisions, all option `(a)`. Deltas: none.
- Exact owner text:

  > RATIFY ACP-1A OD-ATC-0..10，全部采用 (a)

The decision applies prospectively from that owner turn. It does not retroactively authorize earlier work, authorize Ready/merge, or satisfy the exact merged-SHA runtime gate.

### OD-ATC-10R finding and ratified amendment

A post-ratification current-main audit found that OD-ATC-10 contains a false factual premise that was not visible in the proposal packet:

- At `origin/main` `919dc42366d3464c0b941448fad880c88f3f7cf5`, `plugins/plugin-attendance/index.cjs:503-514` defines `attendanceResultEditPolicy.enabled: true` and `notifyAffectedEmployee: true`, explicitly documenting default ON.
- The route at `plugins/plugin-attendance/index.cjs:31360-31373` falls back to that default and denies only when `enabled === false`.
- The web client at `apps/web/src/views/AttendanceView.vue:17250-17252` also treats an absent policy as enabled.

Therefore the original requirements “the existing result-edit policy/flag remains default OFF” and “ACP-1 adds no new flag” could not both be implemented without either changing an established global default or exposing ACP under a default-ON gate.

The owner ratified the fail-closed correction:

- Source: direct owner turn in Codex task `01a0528d-2a67-7ce3-9e23-3d3820d7d733`; no separate owner display identity was exposed, so none is inferred.
- Received: 2026-08-31 (Asia/Taipei); no unverifiable time is invented.
- Ratified amendment packet: PR #5381 head `f777f94e3d0eb5ab35e5462a9c249f3b73c80bc7`, document blob `3c66bda8a3c0f524c325b7f232262c0879c54b3b`.
- Scope: `ACP-1A`, `OD-ATC-10R`, option `(a)`. Deltas are limited to the two conflicting OD-ATC-10 clauses.
- Exact owner text:

  > RATIFY ACP-1A OD-ATC-10R，采用 (a)

**Controlling amendment — OD-ATC-10R(a):** add exactly one attendance-owned ACP policy, `attendanceMultitableCleaningPolicy.enabled`, normalized fail-closed to `false` when absent, malformed, or false. Leave the existing `attendanceResultEditPolicy` and its default-ON behavior unchanged. ACP list, approve-and-apply, and UI exposure require both `attendanceMultitableCleaningPolicy.enabled === true` and the existing result-edit policy to permit editing; neither condition may substitute for the other. ACP apply always supplies notification suppression regardless of the existing notification default. This packet adds no enable action: tests may enable the gate only in isolated fixtures, while Draft/HOLD, release, staging, deployment, production, and real-customer environments remain OFF unless separately authorized.

Option `(b)` is unselected. Changing the existing global result-edit default is excluded. The 11 original decision rows below remain byte-identical evidence; OD-ATC-10R(a) supersedes only the original “existing ... default OFF” and “adds no new flag” clauses. All other OD-ATC-10 restrictions remain in force. Like the original ratification, this amendment does not authorize Ready/merge or satisfy the exact merged-SHA runtime gate.

| ID | Ratified option (a) |
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

## 5. Locked implementation boundary

Implementation must wait until #5372 is merged to then-current `main` and post-merge checks are terminal green. This amended design lock must then be merged and bound to its exact merged SHA. ACP-1 must start from a fresh worktree at the later then-current `origin/main`; it must not stack on #5372 or copy its CAS code.

Attendance-owned product and dedicated tests:

1. `plugins/plugin-attendance/lib/attendance-report-cleaning-proposal.cjs` — new pure policy/planning module.
2. `plugins/plugin-attendance/index.cjs` — dedicated default-OFF ACP policy normalization, additive fields, and minimal route/injection wiring only.
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
- global/shared flags, changes to existing result-edit defaults, ACP gate enablement, external writes, dispatch, deployment, and production

## 6. Conditional shared decision/window

Current multitable permissions do not by themselves prove tenant-safe proposal-sheet access:

- global `multitable:write` can grant generic record editing;
- an unassigned sheet does not automatically become default-deny;
- plugin provisioning currently has no API to create the required organization/admin sheet grant;
- plugin record revision history currently records a system actor rather than the human reviewer.

ACP-1A ratifies the first permission/evidence contract below. That selection does not prove or deliver a tenant-safe sheet grant; release/enable remains blocked until that grant is separately reviewed and proven.

1. **Selected — Option A contract:** the Draft/HOLD only serves existing same-org attendance administrators and adds no grant. Release/enable waits for an explicit tenant-safe sheet grant through a separately reviewed shared seam. Canonical W4 audit remains the human actor authority; multitable revision is system projection evidence.
2. **Unselected and deferred:** require human actor identity in multitable revision history, which adds an actor-aware shared patch API and its own real-DB tests.

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
- The dedicated ACP gate is absent; the existing result-edit policy is default ON and cannot stand in for it.
- The two proposal fields are absent and are not protected by an ownership contract.
- The admin component has no pending-proposal approval flow.
- The real-DB path has no dual-CAS/idempotency proof.

These failures must be captured before implementation; a newly written test that passes against the old code is not a discriminating test.

### Unit contract

- Exactly two additive user-owned fields; repeated provisioning is a no-op; managed projection IDs exclude both.
- `attendanceMultitableCleaningPolicy.enabled` accepts only explicit boolean `true` as enabled; absent, malformed, and false inputs normalize to false without mutating persisted settings.
- Parser accepts only `cleaning_requested === true` and a trimmed, bounded reason.
- Target is a server literal `normal`; custom target, metrics, punch, and business-trip keys are ignored/rejected.
- Logical proposal digest and operation identity are deterministic across `meta_records.version` and unrelated custom-column changes, but change with normalized reason or canonical source fingerprint.
- Proposal cleanup patch contains exactly the proposal keys and never the full row, managed values, or custom columns.
- Serialized failures and logger arguments do not contain sentinel business values.

### Real-DB contract

- Happy path creates one W4 manual edit, one immutable result-edit audit, one sealed operation, and clears only proposal fields; unrelated custom data survives.
- An absent, malformed, or false ACP gate makes list and approve-and-apply fail closed with zero proposal, canonical, audit, notification, or revision mutation and never enables a setting, even when the existing result-edit policy is default ON.
- An enabled ACP gate cannot bypass an explicitly disabled existing result-edit policy; both gates are required.
- With both gates permitting apply, notification/external fan-out remains suppressed even though the existing notification default is true.
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

- Pending list/count and fixed action "Approve correction to normal" are visible only when the ACP gate is explicitly true and the user is an authorized admin.
- Gate false, absent, malformed, or changed during reload hides/clears proposal UI state and sends no list/approve request.
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
13. default the ACP gate to true, treat a truthy non-boolean as enabled, replace the two-gate conjunction with OR, or inherit the existing result-edit/notification defaults.

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

- the ratification source cannot be verified, the decision table differs from PR #5381 head `c50f65f55273842ba8b96245e3004ca58832af9d` / document blob `50e9ff52abd45b2616031c43b5e30222c23c6539`, or a later owner decision conflicts with this packet;
- the dedicated ACP gate is not fail-closed, is silently enabled, bypasses the existing result-edit policy, or permits notification/external fan-out;
- implementation would change an existing result-edit default, touch a shared/global flag, or add a seventh product file without a new bounded window;
- #5372 changes or is not merged on the starting main;
- `origin/main` drifts after preflight or relevant OPEN PR overlap changes;
- Option A requires permission or actor semantics beyond the ratified Draft/HOLD boundary;
- evidence suggests production audit loss instead of delayed/retryable visibility;
- the slice requires raw attendance writeback, permission expansion, notification fan-out, OpenAPI, migration, or deployment;
- file scope expands beyond an authorized window.

Tenant-safe shared permission work is a release blocker, not authority to silently expand the attendance-owned PR. No Ready, merge, flag enable, dispatch, staging, deploy, production, or real customer data is authorized by this document.
