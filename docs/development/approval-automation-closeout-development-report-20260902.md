# Approval Automation Closeout Development Report (Draft) - 2026-09-02

**Status:** DRAFT / HOLD. This is a preparation artifact only. It does not
authorize Ready, merge, feature flags, dispatch, deployment, production, or
real-tenant data access.

**Original code baseline:** `origin/main@81960ae650d974dbd9a96c922ffb4a917292ac24`.
**Original code head:** `0f4331010c60405278bbcd4ab4e38fd5b5d92c38`.
**Historical replay base/head:** `origin/main@24942c70fb07133b580250c00aecbc208aa2f8e8` /
`bdf7626d6c8b1ffefcbccfc33571d04974f31224`.
**Current-main replay base:** `origin/main@8a7649b6eeaea4b57bc53e476f214985a622fc7f`.
**Current-main replay code head/tree:**
`e27bcd028659b87285b8dc38d846c632d1158125` /
`dc8ddbf1553d6cf7f24ede4f214d2f5ffc6abaf7`.
**PR:** Draft/HOLD #5439. The current replay remains 12 files: the 10 code files
and these two reports; no migrations, flags, shared branch-protection edits,
dispatches, deployments, or production actions.

## Authority and bounded objective

This is a narrow completion slice for Lock-4 F4-E. The authoritative product
contract remains
`docs/development/approval-lock4-flow-policies-20260817.md`, especially F4-E
and E-1/E-2/E-3. That lock permits a departure `user_changed` signal to reach
the existing fail-closed approval-seat transfer path; it does not authorize a
new transfer policy, a new flag, or activation.

The prior development report correctly recorded that the F4-E writer and
isolated transfer acceptance existed while the production departure signal
could not reach it. This candidate closes only that observable runtime seam and
its test-run input/CI evidence boundaries.

## Delivered candidate delta

| Area | Candidate change | Bound kept |
|---|---|---|
| `automation-service.ts` | A `real_fire` test-run accepts only a server-shaped sample record: non-empty record id and actor id plus plain-object data. Missing or malformed caller-side shapes reject before rule execution. | Simulated mode is unchanged; no request payload becomes an identity source. |
| `routes/automation.ts` | Direct real-fire requests without a readable persisted record return values-free `TEST_RUN_SAMPLE_RECORD_REQUIRED`. | Existing server-side record load remains authoritative. |
| F4-E source call | The directory/deprovision completion path retains its committed-boundary `user_changed` dispatch to the approved departure transfer path. | Post-commit sibling failures cannot erase a committed directory run or skip this dispatch. |
| Real-DB acceptance | The Class-A integration fixture seeds a persisted record and proves direct real-fire rejects missing/malformed samples without outputs, while valid inputs traverse the server-shaped path. | No migration or external action is introduced. |
| Approval continuation fixture | The existing real-fire approval continuation suite now supplies the authenticated requester in its server-shaped sample snapshot. | Production validation remains strict; no request field becomes an identity source. |
| Values-free sample read | Record-read failures are normalized to constant values-free 401/403/404/500 bodies before the automation route responds. | Missing record, sheet, or permission values are not echoed; successful snapshots remain server-derived. |
| CI lane | The F4-E real-DB workflow watches the planner, ledger, actual dispatcher, route/service, orchestration integration suite, and its wiring guard on both pull-request and push. | No branch-protection edit is included. |
| Mechanical wiring guard | A dedicated unit guard pins PR/push path-list equality, committed-boundary dispatch, and whole-file DB suite inclusion. | Guard changes are mutation-backed; no workflow broadening beyond the slice. |

## Exact file census

1. `.github/workflows/approval-realdb-departure-transfer.yml`
2. `packages/core-backend/src/multitable/automation-service.ts`
3. `packages/core-backend/src/routes/automation.ts`
4. `packages/core-backend/src/routes/automation-test-run-sample.ts`
5. `packages/core-backend/tests/integration/automation-test-run-sample-record.db.test.ts`
6. `packages/core-backend/tests/integration/multitable-4196-classa-claim-realdb.test.ts`
7. `packages/core-backend/tests/integration/multitable-automation-start-approval.test.ts`
8. `packages/core-backend/tests/unit/approval-departure-transfer-ci-wiring.test.ts`
9. `packages/core-backend/tests/unit/automation-testrun-gate.test.ts`
10. `packages/core-backend/tests/unit/multitable-automation-service.test.ts`
11. `docs/development/approval-automation-closeout-development-report-20260902.md`
12. `docs/development/approval-automation-closeout-verification-report-20260902.md`

## Non-goals and retained boundaries

- F4-D, unratified auto-reject semantics, and any new approval policy remain
  outside this candidate.
- Durable retry/outbox activation, FWB, attachments, Canvas activation, and
  every external-write switch remain separately gated and default OFF.
- This candidate does not add a migration, durable worker, background retry,
  branch-protection context, or staging/production action.
- F4-E remains the ratified single-shot out-of-band effect. Infrastructure or
  per-instance failure emits a values-free manual-recovery signal; automatic
  reconciliation is explicitly outside this candidate.
- The requiredness decision for the existing F4-E workflow remains an owner
  operation after exact-head CI and review; this change only creates stable
  evidence and workflow selection.

## Replay and code-head evidence

The original report-only head
`129556911a78764cc6c1d69687bc657b2af52474` completed 24 SUCCESS plus one
intentional Strict E2E SKIPPED. The final replay is a true no-conflict merge
with ordered parents `129556911a78764cc6c1d69687bc657b2af52474` then
`24942c70fb07133b580250c00aecbc208aa2f8e8`. At the `bdf...` code replay, all
12 approval/automation blobs are byte-identical to `129556...`; the old and
replay patches have identical SHA-256
`8b90e3de6340ad99e2c6e743679db08500d32767871c36926038746453eb98e8`.

Draft PR #5439 at final replay code head
`bdf7626d6c8b1ffefcbccfc33571d04974f31224` completed 24 SUCCESS plus one
intentional Strict E2E SKIPPED, with Node 18, Node 20, Web Tests, F4-E real-DB,
and coverage successful. That is retained as historical exact-head evidence.

The 2026-09-02 current-main replay is a true no-conflict merge with ordered
parents `6199d860b050b5497708f5e392f0e341906da053` then
`8a7649b6eeaea4b57bc53e476f214985a622fc7f`. The main-only range and candidate
range have zero changed-file overlap. Relative to the second parent, the
candidate still changes exactly the 12 files in this report. Range-diff
preserves the four content commits `a2efd8b49`, `0f4331010`, `129556911`,
and `6199d860b` in order, with no manual conflict resolution.

At current-main replay code head `e27bcd028659b87285b8dc38d846c632d1158125`,
the focused unit set passed 77/77. Five integration files passed together
70/70 against one freshly migrated native PostgreSQL 15 cluster, followed by
cluster deletion and zero owned residue. Core-backend type check passed;
targeted ESLint exited zero with only the pre-existing warning; and
`git diff --check` passed. The report-refresh child and its remote exact-head
CI do not exist at this authoring point and must be recorded separately after
publication.

## Merge predicates

This Draft may advance only after exact-head CI becomes terminal without a
failure, a refute-first review reaches no P1/P2, and an owner separately
authorizes Ready and merge. Any base or head drift invalidates this report's
merge-state evidence.
