# ERP/PLM Phase 1 Closeout Design - 2026-05-07

## Scope

This closeout implements Phase 1 from
`docs/development/integration-erp-plm-closeout-plan-20260507.md`.
That plan was merged as #1413 at
`93878365fbd0d606b76adfe10d21a813926be29f`, then this batch merged the six
Phase 1 evidence/report hardening PRs on top of the refreshed `main`.

Phase 1 covers the evidence/report safety layer for the PLM -> MetaSheet
cleanse/staging -> K3 WISE ERP path. The purpose is to make customer-facing
diagnostic artifacts safe and stable before merging deeper runtime guardrails.

## Merged PRs

Merged in descending PR order after refreshing all six branches to current
`main` and waiting for fresh CI:

| PR | Merge commit | Purpose |
|---|---|---|
| #1405 | `33e325dc4fa2b793061c8ce892c06ffbad365df2` | Expose staging validation field details |
| #1404 | `88c6054a1c8bb97f01a2b9a94e2212755e47ce92` | Parse bracketed/schema-qualified K3 mock SQL tables |
| #1403 | `592daee52e2a16ecc383b7de59445bff5ee80289` | Redact K3 mock request logs |
| #1402 | `a0f5a888c29e987dcfde449328d589a0170e5737` | Escape live PoC Markdown reports |
| #1401 | `128c8d78ab00733130b24bac55c2c041727d8eb7` | Escape postdeploy smoke Markdown evidence |
| #1400 | `d978543b0f7c461b3a1291e0359affb39427ee58` | Escape postdeploy summary Markdown values |

## Merge Policy

All six PRs were:

- refreshed with `gh pr update-branch`
- `MERGEABLE`
- fresh green on required CI before merge
- free of failed and pending checks at merge time

Because branch protection still required review approval and these are small
safety/test/reporting PRs, the batch used admin squash merge in the order above.

## Design Outcome

The evidence/report layer now has these protections on `main`:

- K3 live PoC preflight and evidence Markdown escaping for table-breaking values.
- Postdeploy smoke Markdown escaping for table-breaking values.
- Postdeploy summary Markdown escaping for table-breaking values.
- Mock K3 request logging redacts credential-bearing fields.
- Mock SQL executor handles common SQL Server bracket/schema identifier forms.
- Staging descriptor validation reports field-level details for failed checks.

## Remaining Work

Phase 1 is complete. The next closeout batch should start Phase 2 runtime safety
guards from the plan, beginning with low-overlap adapter/config guard PRs before
runner/dead-letter/idempotency guard PRs.
