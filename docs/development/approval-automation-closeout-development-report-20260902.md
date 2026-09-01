# Approval Automation Closeout Development Report (Draft) - 2026-09-02

**Status:** DRAFT / HOLD. This is a preparation artifact only. It does not
authorize Ready, merge, feature flags, dispatch, deployment, production, or
real-tenant data access.

**Code baseline:** `origin/main@81960ae650d974dbd9a96c922ffb4a917292ac24`.
**Candidate:** `0f4331010c60405278bbcd4ab4e38fd5b5d92c38` (Draft PR #5439).
**Scope:** 10 files, `+348/-24`; no migrations, flags, shared branch-protection
edits, dispatches, deployments, or production actions.

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

## Code-head remote gate

Draft PR #5439 at exact code head
`0f4331010c60405278bbcd4ab4e38fd5b5d92c38` completed 25 contexts:
24 SUCCESS, 1 intentional Strict E2E SKIPPED, 0 pending, and 0 failure.
Node 18 and Node 20 both succeeded. This terminal result is code-head evidence;
the report-only child commit must obtain its own exact-head terminal result.

## Merge predicates

This Draft may advance only after exact-head CI becomes terminal without a
failure, a refute-first review reaches no P1/P2, and an owner separately
authorizes Ready and merge. Any base or head drift invalidates this report's
merge-state evidence.
