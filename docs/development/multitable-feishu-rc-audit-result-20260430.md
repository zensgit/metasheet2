# Multitable Feishu RC Audit Result - 2026-04-30

## Baseline

- Audited baseline: `origin/main@08f4ff920`
- Audit type: code/docs/static evidence audit.
- Staging status: not executed in this PR.

## Executive Result

The merged multitable Feishu-parity line is ready to enter staging smoke, but not yet ready to call RC complete.

RC-blocking uncertainty is concentrated in operational/staging evidence, not in local source completeness. The largest functional gap remains backend xlsx import/export routes. The deepest customer-trial gaps remain system fields, record version history, and record subscription/watch notifications.

## P0 Findings

### P0-1 - Staging smoke has not been executed

Evidence:

- The TODO had no completed staging smoke items before this PR.
- This PR creates the smoke checklist but does not deploy or click through staging.

Impact:

- Cannot claim RC readiness until staging confirms core flows.

Next action:

- Run `docs/development/multitable-feishu-staging-smoke-checklist-20260430.md` against the target staging server and update the master TODO with evidence.

### P0-2 - Backend xlsx import/export routes are still missing

Evidence:

- `apps/web/package.json` has `xlsx`.
- Frontend has `MetaImportModal` xlsx parsing and `onExportXlsx`.
- No multitable backend `import-xlsx` / `export-xlsx` routes were found under `packages/core-backend/src`.

Impact:

- Browser-based xlsx works for normal files, but server-side import/export APIs and larger operational workflows remain unavailable.

Next action:

- Execute Phase 2: Backend XLSX Route Layer.

## P1 Findings

### P1-1 - System fields batch is still missing

Missing field types:

- `autoNumber`
- `createdTime`
- `modifiedTime`
- `createdBy`
- `modifiedBy`

Impact:

- Customer-depth trials for CRM/ERP style tables will ask for stable row identifiers and audit metadata fields.

Next action:

- Execute Phase 4.

### P1-2 - Record/cell version history is still missing

Evidence:

- Existing record `version` is used for optimistic locking, not historical browsing.
- No RC record revision UI/API was found.

Impact:

- Data trust and audit use cases are weaker than Feishu-style history expectations.

Next action:

- Execute Phase 5.

### P1-3 - Record subscription/watch notifications are still missing

Evidence:

- Existing subscription hits are platform/event/notification internals.
- No user-facing record watch/unwatch feature was found in multitable UI/API.

Impact:

- Users cannot follow important records and receive update/comment notifications.

Next action:

- Execute Phase 6.

### P1-4 - Real `send_email` delivery depends on staging provider configuration

Evidence:

- `send_email` action exists and reuses `NotificationService`.
- The design explicitly leaves real provider wiring outside the feature PR.

Impact:

- Rule save/execution path may work while real email delivery is not operational.

Next action:

- Smoke with staging provider. If no provider is configured, classify as ops blocker, not product code blocker.

## P2 Findings

### P2-1 - Gantt deep project features remain out of scope

Missing:

- Dependency arrows
- Critical path
- Drag resize

Impact:

- Basic Gantt visualization exists; advanced project management parity is deferred.

### P2-2 - Hierarchy deep editing remains out of scope

Missing:

- Drag-to-reparent
- Server-side cycle prevention

Impact:

- Basic tree view exists; advanced tree editing remains deferred.

### P2-3 - Optional field parity remains

Missing:

- DateTime/timezone
- Number formatting
- Barcode
- Location
- Native person field migration

Impact:

- Useful for deeper Feishu parity, but not RC blockers.

## Current Recommendation

Proceed in this order:

1. Run staging smoke from the new checklist.
2. Fix any P0 smoke failures immediately.
3. Start Phase 2 backend xlsx routes.
4. Run Phase 3 OpenAPI/contract cleanup after xlsx route shape is known.
5. Then decide whether to start Phase 4 system fields before customer trial.
