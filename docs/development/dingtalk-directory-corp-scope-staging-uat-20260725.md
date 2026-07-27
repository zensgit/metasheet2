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
5. Run the Phase B values-free preflight immediately before the controlled migration and require
   exit code `0` with status `PASS`.
6. Hold an exclusive host change window. Merge/deploy/verify Phase B migration before releasing
   it.
7. If any privileged Docker/Compose or ingress change occurs after the PASS and before migration
   completion, invalidate the evidence and repeat from step 3.

Do not re-deploy Phase A after Phase B migration. The PASS is point-in-time evidence for the
cutover, not a durable host lock or a claim about unrelated host processes.

## 2. Phase B preflight

Run this after Phase A is deployed to every worker and the old-worker count is zero, but before
applying the Phase B migration:

```bash
DATABASE_URL="$STAGING_DATABASE_URL" \
  pnpm --silent --filter @metasheet/core-backend \
  preflight:dingtalk-directory-corp-scope \
  > artifacts/dingtalk-directory-corp-scope-preflight.json
```

The preflight opens a `REPEATABLE READ READ ONLY` transaction. Its JSON contains only schema
booleans, counts, and stable blocker codes; it does not return corp IDs, provider identity values,
account keys, credentials, or the database URL.

Exit codes:

- `0`: `PASS`; retain the JSON evidence and continue to the controlled migration window.
- `2`: `BLOCKED`; do not migrate. Resolve the reported data/schema class under a separately
  reviewed repair plan, then rerun the preflight.
- `1`: `ERROR`; read-only execution was not verified or the query could not complete. Do not
  migrate and do not infer safety from an empty/missing report.

`PASS` requires the exact legacy global index, a `NOT NULL` parent-integration corp column, no
Phase B replacement index/CHECK already present, canonicalizable parent integration scope, no
orphan/provider-drift account, canonicalizable identity corp, and no duplicate group that a
Phase B scoped identity index would reject.

Never paste the database URL or query raw offending values for this evidence. The report is a
deployment gate, not a repair tool and not proof that old workers were drained.

## 3. UAT entry criteria

Do not start the UAT procedure until all conditions are true:

1. The saved pre-UAT cutover evidence above is complete.
2. The retained Phase B preflight report records exit code `0`, status `PASS`, and zero blockers.
3. Phase B schema migration is deployed and verified on staging.
4. Automatic directory sync and directory deprovision remain disabled.
5. The owner has authorized one manual sync and binding to one existing MetaSheet user.
6. Two real DingTalk enterprises and one overlap person are available.

Stop if any criterion is unproven. Do not infer rollout completion from a successful migration.

## 4. Values-free evidence

Record identifiers only as redacted labels (`integration-A`, `integration-B`, `user-existing`).
Do not paste credentials, corp IDs, unionId/openId/userId values, raw SQL errors, card payloads,
or business form values into the evidence document.

Allowed evidence:

- exact deployment and migration SHAs;
- image provenance schema and image IDs, kept in the private operator packet;
- the values-free `WORKER_DRAIN_GATE_PASS` summary;
- managed-project and staging-ingress worker counts;
- whether an alternate staging backend upstream exists;
- the complete values-free preflight JSON and exit code;
- sync run status and values-free reason code;
- row counts grouped by redacted integration label;
- link status and match strategy;
- callback outcome/reason and approval record count;
- whether all runtime flags and schedules stayed unchanged.

## 5. UAT procedure

1. Capture the saved cutover PASS, exact Phase A SHA, Phase B preflight report/exit code, Phase B
   migration ledger, private image provenance reference, topology result, and relevant flag
   states. Do not run the Phase A deploy again.
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

## 6. Fail-closed outcomes

Stop and do not retry automatically when:

- the managed project has another backend, the fixed staging ingress resolves to another
  container, or an alternate staging backend upstream exists;
- any old worker remains;
- the preflight status is not `PASS`, its exit code is not `0`, or its JSON cannot be retained;
- migration/index verification fails;
- either manual sync fails or rolls back;
- identity matching is ambiguous;
- account corp is blank or differs from its parent integration;
- callback returns `operator_unresolved` or a corp refusal;
- an unrelated user, account, integration, or approval row changes.

Retain values-free evidence and return to code review. Do not repair staging data ad hoc.

## 7. Evidence block

```text
Phase A deployment SHA:                 TBD
Phase A image provenance schema:        TBD
worker-drain gate summary:              TBD (must be WORKER_DRAIN_GATE_PASS)
Phase B preflight exit/status:          TBD (must be 0 / PASS)
Phase B preflight blocker count:        TBD (must be 0)
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
