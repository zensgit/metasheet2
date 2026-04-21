# Monthly Wiring Audit — Development & Verification Report

Date: 2026-04-20
Branch lineage: `codex/monthly-delivery-audit-20260420` → PR #944 → main
Session effort: xhigh

## What was developed in this session

1. Launched three parallel `Explore` sub-agents to audit the frontend
   wiring of every major feature merged in the last ~30 days.
2. Consolidated findings into a single master document:
   `docs/operations/monthly-delivery-audit-20260420.md`.
3. Cross-checked each sub-agent's critical claim with a `grep`
   command executed directly by the parent agent.
4. Opened and merged PR #944 to land the audit doc on `main`.

No code changed. By design — each fix has its own risk surface and
warrants a separate PR with its own staging verification step.

## What the audit verified

For each of the following features, ran:

```
grep -rn "<entry symbol>" apps/web/src/ --include="*.vue" --include="*.ts"
```

And traced the import chain to a route, a menu item, or an active
parent component. If the chain reached a real user-visible path the
feature is marked WIRED. Otherwise ORPHAN.

### Independently verified claims

Every claim below was double-checked by the parent agent (not just
by the sub-agent reporting it):

1. `dashboardRouter()` is defined in
   `packages/core-backend/src/routes/dashboard.ts:38` and is NOT
   imported anywhere else in `packages/core-backend/src/`.
   Verification command:
   `grep -rn "dashboardRouter" packages/core-backend/src/`
   Result: only the definition line.

2. `createAutomationRoutes()` is defined in
   `packages/core-backend/src/routes/automation.ts:10` and is NOT
   imported anywhere else.
   Verification command:
   `grep -rn "createAutomationRoutes" packages/core-backend/src/`
   Result: only the definition line.

3. `MetaFieldValidationPanel` is defined at
   `apps/web/src/multitable/components/MetaFieldValidationPanel.vue`
   and is not imported anywhere in `apps/web/src/`.
   Verification command:
   `grep -rn "MetaFieldValidationPanel" apps/web/src/ --include="*.vue" --include="*.ts"`
   Result: empty.

4. `dashboard.ts` responds with `res.json({ items: charts })`
   (line 49) and `res.json({ items: dashboards })` (line 128), while
   `apps/web/src/multitable/api/client.ts` parses responses as
   `parseJson<{ charts: ChartConfig[] }>` and
   `parseJson<{ dashboards: Dashboard[] }>`. Two independent shape
   mismatches.

5. `dashboard.ts` mounts its routes at `/:sheetId/charts` while the
   frontend calls `/api/multitable/sheets/:sheetId/charts`. The
   `sheets/` segment is a third mismatch.

6. `field-validation-engine.ts` IS invoked at record-submit time
   (`univer-meta.ts:6474, 7879`), so validation works on the server —
   but `sanitizeFieldProperty()` at `univer-meta.ts:943-1016` does
   NOT persist or return validation rules, so there is no API surface
   to configure them.

### Features the audit PASSED

Each of these had a full import chain from user entry point to the
relevant API calls:

- Comment system (Week 1-2)
- API Token + Webhook Manager
- Public Form Share Manager
- DingTalk identity layer

## Outcome

The hypothesis at the start of the session was:

> If one feature (Yjs) passed 6 design reviews and 25 unit tests but
> shipped without frontend wiring, other features from the same window
> may have the same gap.

The hypothesis is correct. 3 additional features have real wiring
issues. One of them (Chart/Dashboard) produces a visible 404 the
first time a user clicks the corresponding button.

The audit checklist created in PR #941 did its job on its first real
application.

## What to do next

This is a decision point for the maintainer, not a technical blocker.

**Option A — fix the two cheap ones now** (~90 min total):
1. Mount `dashboardRouter()` in `packages/core-backend/src/index.ts`,
   align path prefix, align response shape, rebuild.
2. Mount `createAutomationRoutes()`, align response shape.
3. Run the end-to-end validation against staging before merging.

**Option B — file each as its own issue and move on.**
Field Validation Panel cannot be fixed by wiring alone; it needs API
design. Yjs frontend integration needs a product decision. Neither
blocks anything right now.

**Option C — keep applying the audit.**
Extend audit coverage backward (>30 days) or to plugins / approval
flows / attendance modules. Today's audit was scoped to recently
merged features; older work may also have gaps.

I recommend Option A for the two easy wins, then decide B vs C.

## Artifacts

- Audit master: `docs/operations/monthly-delivery-audit-20260420.md`
- PR: #944 (merged)
- This session summary: `docs/operations/audit-session-development-verification-20260420.md`

## Meta note

This audit took about 20 minutes to execute and caught 3 real
production-adjacent issues. For comparison, each of the original
feature PRs took days to weeks. The ROI of a mechanical import-chain
audit is very high; it should probably run as part of CI on every
feature-bearing PR, not only retrospectively.
