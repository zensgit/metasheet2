# DingTalk directory corp-scope staging UAT

Status: OWNER-GATED / NOT EXECUTED

Date: 2026-07-25

## 1. Pre-UAT cutover gate

Run this owner/ops gate before UAT:

1. Phase A matcher/callback hardening is merged and deployed to staging.
2. Build the exact Phase A SHA through the trusted operator path. Keep the provenance file owned
   by the deploy user with mode `0400` or `0600`.
3. Deploy that artifact and require exactly:

   ```text
   WORKER_DRAIN_GATE_PASS expected_project_workers=1 observed_project_workers=1 managed_project_old_workers=0 staging_ingress_workers=1 staging_ingress_unmanaged_workers=0 build_commit_match=1 image_match=1 image_id_match=1 revision_match=1 project_services_match=1
   ```

4. Verify the staging topology has no alternate backend upstream outside the managed Compose
   `backend` service and the fixed loopback publish `127.0.0.1:18900`.
5. Hold an exclusive host change window. Merge/deploy/verify Phase B migration before releasing
   it.
6. If any privileged Docker/Compose or ingress change occurs after the PASS and before migration
   completion, invalidate the evidence and repeat from step 3.

Do not re-deploy Phase A after Phase B migration. The PASS is point-in-time evidence for the
cutover, not a durable host lock or a claim about unrelated host processes.

## 2. UAT entry criteria

Do not start the UAT procedure until all conditions are true:

1. The saved pre-UAT cutover evidence above is complete.
2. Phase B schema migration is deployed and verified on staging.
3. Automatic directory sync and directory deprovision remain disabled.
4. The owner has authorized one manual sync and binding to one existing MetaSheet user.
5. Two real DingTalk enterprises and one overlap person are available.

Stop if any criterion is unproven. Do not infer rollout completion from a successful migration.

## 3. Values-free evidence

Record identifiers only as redacted labels (`integration-A`, `integration-B`, `user-existing`).
Do not paste credentials, corp IDs, unionId/openId/userId values, raw SQL errors, card payloads,
or business form values into the evidence document.

Allowed evidence:

- exact deployment and migration SHAs;
- image provenance schema and image IDs, kept in the private operator packet;
- the values-free `WORKER_DRAIN_GATE_PASS` summary;
- managed-project and staging-ingress worker counts;
- whether an alternate staging backend upstream exists;
- sync run status and values-free reason code;
- row counts grouped by redacted integration label;
- link status and match strategy;
- callback outcome/reason and approval record count;
- whether all runtime flags and schedules stayed unchanged.

## 4. UAT procedure

1. Capture the saved cutover PASS, exact Phase A SHA, Phase B migration ledger, private image
   provenance reference, topology result, and relevant flag states. Do not run the Phase A deploy
   again.
2. Run one manual sync for integration A.
3. Run one manual sync for integration B.
4. Confirm both runs complete and each integration retains its own departments/accounts.
5. Confirm the overlap account exists once under each integration even when provider identity
   values are equal.
6. Confirm neither account is automatically linked to the other enterprise's local user.
7. Bind only the authorized target account to the existing MetaSheet user.
8. Confirm bind/unbind conflict checks do not modify the other enterprise's identity row.
9. Send a fresh approval card for the bound integration and click one decision.
10. Confirm the callback resolves through the same integration and corp, writes one approval
    action, and leaves the other integration untouched.
11. Confirm no new MetaSheet user was created and no schedule/deprovision/flag changed.

## 5. Fail-closed outcomes

Stop and do not retry automatically when:

- the managed project has another backend, the fixed staging ingress resolves to another
  container, or an alternate staging backend upstream exists;
- migration/index verification fails;
- either manual sync fails or rolls back;
- identity matching is ambiguous;
- account corp is blank or differs from its parent integration;
- callback returns `operator_unresolved` or a corp refusal;
- an unrelated user, account, integration, or approval row changes.

Retain values-free evidence and return to code review. Do not repair staging data ad hoc.

## 6. Evidence block

```text
Phase A deployment SHA:                 TBD
Phase A image provenance schema:        TBD
worker-drain gate summary:              TBD (must be WORKER_DRAIN_GATE_PASS)
Phase B migration SHA:                  TBD
managed-project old worker count:       TBD (must be 0)
staging-ingress unmanaged worker count: TBD (must be 0)
alternate staging backend upstream:     TBD (must be false)
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
