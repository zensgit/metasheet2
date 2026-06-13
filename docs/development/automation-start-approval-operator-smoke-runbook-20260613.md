# Automation start_approval Operator Smoke Runbook - 2026-06-13

Type: **W6 deployed/operator validation runbook**.

Grounded on: `origin/main@7026a3303`.

Issue: `#2480` (`UAT: W6 start_approval automation bridge operator smoke`).

Companions:

- `docs/development/workflow-automation-completion-plan-20260609.md`
- `docs/development/automation-start-approval-scope-gate-20260610.md`
- `docs/development/approval-completion-event-contract-scope-gate-20260609.md`
- `docs/development/automation-approval-result-backwrite-scope-gate-20260611.md`

## 0. Verdict Boundary

This runbook validates the deployed W6 `start_approval` bridge from an operator
point of view. It does **not** validate or authorize W7 approval result
backwrite.

Backend correctness is already covered by the blocking real-DB CI seam
`tests/integration/multitable-automation-start-approval.test.ts`. The deployed
smoke here is intentionally narrower: prove that the packaged UI, deployed
`/api` routing, auth roles, approval actions, and Admin runs readability are
usable in the target environment.

PASS on this runbook may be used as the normal W7-1 re-entry proof. FAIL should
block W7-1 unless the owner explicitly gives a separate named runtime unlock.

## 1. Pre-flight

Run this only on a non-production or approved trial tenant.

Required accounts:

| Role | Needed capability |
|---|---|
| Automation admin | Can create/edit multitable automation rules and open Admin runs. |
| Approval requester | Can start approvals (`approvals:write`) and can be selected as the automation requester. |
| Approval assignee | Can receive and approve/reject the created approval. |
| Optional observer | Can inspect Admin runs without changing data. |

Required test assets:

- A dedicated test sheet/table with one disposable record.
- A published approval template with at least one approval node.
- A deterministic assignee path. Prefer a visible `form_field_user` source so
  the operator can confirm the submitted user resolves to the expected assignee.
- A harmless downstream automation action after `start_approval` so the smoke
  can prove the automation tail resumes exactly once. Use only a test record,
  a diagnostic webhook, or another explicitly disposable side effect.

Do not use production approval templates, customer data, or production webhooks.

## 2. Environment And Routing Check

1. Open the deployed MetaSheet URL in a clean browser session.
2. Sign in as the automation admin.
3. Confirm the page is MetaSheet, not a co-tenant application.
4. Open the approval center and Admin automation runs page.
5. If any request to `/api/...` returns a response that clearly belongs to a
   different application or tenant, stop and mark this run **FAIL: routing**.

Evidence to capture:

- Deployment URL.
- Current build/version or commit if visible.
- Screenshot of the Admin runs page loading.
- Any routing/auth error response if the check fails.

## 3. Happy Path: Approval Approved Resumes Tail Once

1. Create or open a test automation rule on the disposable test sheet.
2. Enable the WorkflowJob execution mode.
3. Add actions in this order:
   - `start_approval`, configured with the published template and explicit form
     data mappings.
   - One harmless downstream action that visibly proves the tail resumed.
4. Save the rule.
5. Trigger the automation once from the disposable record.
6. Open Admin runs and locate the execution.
7. Confirm the `start_approval` step/job is visible as suspended or waiting
   while the approval is pending.
8. Open the created approval as the assignee.
9. Approve it.
10. Return to Admin runs and refresh the execution detail.

Expected result:

- Exactly one approval instance is created for the automation step.
- The pending approval resolves to the expected assignee.
- The `start_approval` C1 job transitions from suspended/waiting to resolved.
- The downstream action runs exactly once.
- Admin runs output stays redacted: no full submitted form payload, raw approval
  internals, credentials, auth headers, or secret-shaped values.

Evidence to capture:

- Rule id/name.
- Execution id.
- Approval instance id.
- Screenshot or copied text showing the pending/suspended job.
- Screenshot or copied text showing resolved `start_approval` and the downstream
  action result.
- Note the harmless downstream side effect observed exactly once.

## 4. Terminal Failure Path: Rejected/Revoked/Cancelled Fails And Skips Tail

Run at least one terminal non-approval outcome that the deployed environment can
exercise safely. Rejected is usually enough if revoke/cancel is not available to
the operator role.

1. Trigger a new execution of the same rule.
2. Confirm the approval is pending and `start_approval` is suspended/waiting.
3. Reject, revoke, or cancel the approval.
4. Return to Admin runs and refresh the execution detail.

Expected result:

- The `start_approval` C1 job is failed with a redacted terminal outcome.
- The downstream action is shown as skipped or otherwise clearly not executed.
- The harmless downstream side effect does not occur.
- Admin runs output remains redacted.

Evidence to capture:

- Execution id.
- Approval instance id.
- Terminal action used: approved/rejected/revoked/cancelled.
- Screenshot or copied text showing failed `start_approval` and skipped tail.

## 5. Retry Duplicate Guard

This check proves retry does not create a second approval for the same business
step after the original run already created one.

1. Pick one execution from Section 3 or Section 4 that already created an
   approval bridge.
2. From Admin runs, attempt the supported retry action for that execution.
3. If retry is not available in the deployed UI, record that as **not
   executable in UI** and ask an operator with API access to run the equivalent
   admin retry endpoint on the same execution.

Expected result:

- Retry fails closed with a precise duplicate-approval/bridge message, or
  otherwise refuses to create another approval instance for the same step.
- The approval count for that execution/business step remains one.
- No extra downstream side effect is produced by the failed retry.

Evidence to capture:

- Original execution id.
- Retry response/error text.
- Approval count or observable proof that no duplicate approval was created.

## 6. Redaction And Readability Check

Inspect the Admin runs detail for all executions created during this smoke.

Expected result:

- Operators can identify the rule, execution, step, approval instance, and
  terminal outcome well enough to debug the run.
- Submitted form data is not dumped wholesale.
- Trigger event, rule snapshot, step output, error text, and approval bridge
  output do not expose secrets or auth-shaped values.
- If a redaction leak is found, stop and mark the run **FAIL: redaction**.

## 7. PASS Criteria

The run is PASS only if all of these are true:

- The deployed MetaSheet UI and `/api` route point at the intended backend.
- One approved approval resumes the automation tail exactly once.
- One rejected/revoked/cancelled approval fails `start_approval` and skips the
  tail.
- Retry does not create a duplicate approval.
- Admin runs is readable enough for operators and remains redacted.
- No W7 result backwrite behavior is tested or inferred from this run.

## 8. Result Template For Issue #2480

Paste this into `#2480` after the run.

```md
W6 `start_approval` deployed/operator smoke result:

- Environment:
- Build / commit:
- Operator:
- Date/time:

Checks:
- [ ] Routing/auth points to MetaSheet backend.
- [ ] Approved path: one approval created, `start_approval` suspended then resolved, tail resumed exactly once.
- [ ] Rejected/revoked/cancelled path: `start_approval` failed, downstream tail skipped, no side effect.
- [ ] Retry duplicate guard: no second approval created for the same step.
- [ ] Admin runs readability/redaction: identifiers useful, sensitive payloads redacted.
- [ ] W7 result backwrite was not tested.

Evidence:
- Happy path execution id:
- Happy path approval id:
- Failure path execution id:
- Failure path approval id:
- Retry evidence:
- Screenshots/log snippets:

Verdict: PASS / FAIL

Notes:
```

## 9. If The Run Fails

- **Routing/auth failure**: fix deployment routing or auth first. Do not debug
  W6 runtime from a co-tenant or wrong-backend response.
- **Approval creation failure**: check requester permissions and template
  publication before changing automation code.
- **Approval completion does not resume/fail the tail**: compare with the
  blocking real-DB CI test to determine whether the issue is deployed build,
  event wiring, or environment data.
- **Retry creates a duplicate approval**: treat as a W6 blocker and do not
  start W7-1.
- **Redaction failure**: treat as a W6 blocker and do not start W7-1.
