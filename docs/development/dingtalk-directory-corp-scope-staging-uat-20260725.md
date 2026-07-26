# DingTalk directory corp-scope staging UAT

Status: OWNER-GATED / NOT EXECUTED

Date: 2026-07-25

## 1. Entry criteria

Do not start this runbook until all conditions are true:

1. Phase A matcher/callback hardening is merged and deployed to staging.
2. Every pre-Phase-A worker is drained; record the deployment SHA and worker rollout evidence.
3. Phase B schema migration is merged, deployed, and verified on staging.
4. Automatic directory sync and directory deprovision remain disabled.
5. The owner has authorized one manual sync and binding to one existing MetaSheet user.
6. Two real DingTalk enterprises and one overlap person are available.

Stop if any criterion is unproven. Do not infer rollout completion from a successful migration.

## 2. Values-free evidence

Record identifiers only as redacted labels (`integration-A`, `integration-B`, `user-existing`).
Do not paste credentials, corp IDs, unionId/openId/userId values, raw SQL errors, card payloads,
or business form values into the evidence document.

Allowed evidence:

- exact deployment and migration SHAs;
- worker version counts;
- sync run status and values-free reason code;
- row counts grouped by redacted integration label;
- link status and match strategy;
- callback outcome/reason and approval record count;
- whether all runtime flags and schedules stayed unchanged.

## 3. Procedure

1. Capture the exact staging SHA, migration ledger, worker versions, and relevant flag states.
2. Confirm no old worker remains.
3. Run one manual sync for integration A.
4. Run one manual sync for integration B.
5. Confirm both runs complete and each integration retains its own departments/accounts.
6. Confirm the overlap account exists once under each integration even when provider identity
   values are equal.
7. Confirm neither account is automatically linked to the other enterprise's local user.
8. Bind only the authorized target account to the existing MetaSheet user.
9. Confirm bind/unbind conflict checks do not modify the other enterprise's identity row.
10. Send a fresh approval card for the bound integration and click one decision.
11. Confirm the callback resolves through the same integration and corp, writes one approval
    action, and leaves the other integration untouched.
12. Confirm no new MetaSheet user was created and no schedule/deprovision/flag changed.

## 4. Fail-closed outcomes

Stop and do not retry automatically when:

- any old worker remains;
- migration/index verification fails;
- either manual sync fails or rolls back;
- identity matching is ambiguous;
- account corp is blank or differs from its parent integration;
- callback returns `operator_unresolved` or a corp refusal;
- an unrelated user, account, integration, or approval row changes.

Retain values-free evidence and return to code review. Do not repair staging data ad hoc.

## 5. Evidence block

```text
Phase A deployment SHA:                 TBD
Phase B migration SHA:                  TBD
old worker count before UAT:            TBD (must be 0)
automatic sync enabled:                 TBD (must be false)
deprovision enabled:                    TBD (must be false)
integration A sync:                     TBD
integration B sync:                     TBD
cross-corp equal-key coexistence:       TBD
cross-corp auto-link count:             TBD (must be 0)
authorized existing-user bind:          TBD
same-corp callback outcome:             TBD
approval action count:                  TBD (must be 1)
other-corp changed-row count:           TBD (must be 0)
new MetaSheet user count:               TBD (must be 0)
runtime flag changes:                   TBD (must be none)
owner disposition:                      TBD
```
