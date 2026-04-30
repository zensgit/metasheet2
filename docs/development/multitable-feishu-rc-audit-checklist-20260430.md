# Multitable Feishu RC Audit Checklist - 2026-04-30

## Scope

This checklist audits the merged multitable Feishu-parity RC capability set on `origin/main@08f4ff920`.

It is a local/code-and-doc audit checklist, not a staging execution report. Staging-only checks live in `docs/development/multitable-feishu-staging-smoke-checklist-20260430.md`.

## Evidence Sources

- `docs/development/wave-m-feishu-1-delivery-20260426.md`
- `docs/development/wave-m-feishu-2-formula-view-gantt-development-20260429.md`
- `docs/development/wave-m-feishu-3-longtext-field-design-20260429.md`
- `docs/development/wave-m-feishu-3-send-email-design-20260429.md`
- `docs/development/wave-m-feishu-3-hierarchy-view-design-20260429.md`
- `docs/development/wave-m-feishu-4-multiselect-field-design-20260429.md`
- `docs/development/wave-m-feishu-4-filter-builder-design-20260429.md`
- `docs/development/wave-m-feishu-4-formula-catalog-design-20260429.md`
- `apps/web/src/multitable/**`
- `packages/core-backend/src/multitable/**`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/openapi/src/**`

## Capability Audit

### Base Multitable Workflow

- [ ] Base/sheet/view creation path is available in staging.
- [ ] Grid view can create, edit, delete, sort, filter, and group records.
- [ ] Record drawer opens from all RC view types that support selection.
- [ ] Comments drawer still opens from record-level affordances.
- [ ] Existing permissions still gate read/write/admin actions.

### XLSX Import / Export

- [x] Frontend `.xlsx`/`.xls` import path exists.
- [x] Frontend `.xlsx` export path exists.
- [x] `xlsx` dependency exists in `apps/web/package.json`.
- [ ] Backend `/import-xlsx` route exists.
  - Gap: no multitable backend route was found for `import-xlsx`.
- [ ] Backend `/export-xlsx` route exists.
  - Gap: no multitable backend route was found for `export-xlsx`.
- [ ] Staging validates real Excel round-trip with a real file.

### Field Types

- [x] Existing core types remain present: string, number, boolean, date, formula, select, link, lookup, rollup, attachment.
- [x] Batch-1 fields are present: currency, percent, rating, url, email, phone.
- [x] `longText` is present.
- [x] `multiSelect` is present.
- [ ] System fields are present: autoNumber, createdTime, modifiedTime, createdBy, modifiedBy.
  - Gap: these are still Phase 4 TODO items.
- [ ] DateTime/timezone field is present.
  - Gap: optional backlog item.
- [ ] Barcode/location fields are present.
  - Gap: optional backlog items.

### View Types

- [x] Grid, form, kanban, gallery, calendar, timeline are existing view types.
- [x] Gantt view frontend is present.
- [x] Hierarchy view frontend is present.
- [ ] Gantt dependencies / critical path / drag resize are present.
  - Gap: optional backlog item.
- [ ] Hierarchy drag-to-reparent and server-side cycle prevention are present.
  - Gap: optional backlog item.

### View Configuration

- [x] Visual filter builder exists.
- [x] Sort/filter/group config is exposed from view management.
- [x] Conditional formatting rules exist.
- [x] Conditional formatting is persisted in view config.
- [ ] Staging verifies conditional formatting reload across browser restart.

### Formula

- [x] Formula field editor exists.
- [x] Field-token insertion uses stable field ids.
- [x] Function catalog exists.
- [x] DATEDIFF runtime alias exists.
- [ ] Staging verifies formula save/evaluate/reload on real data.

### Automation

- [x] Advanced automation V1 exists.
- [x] `send_email` action type exists.
- [x] `send_email` UI config exists.
- [ ] Real email provider transport is configured in staging.
  - Gap: repository implementation reuses `NotificationService`; provider/runtime config must be verified operationally.

### Collaboration / Realtime

- [x] Comments, mention, unread, inbox, and presence are implemented.
- [x] Yjs text-cell collaboration exists behind opt-in flag.
- [ ] Long-text Yjs collaboration is enabled.
  - Gap: explicitly out of scope for longText slice.
- [ ] Record/cell version history exists.
  - Gap: Phase 5 TODO.
- [ ] Record subscription/watch notifications exist.
  - Gap: Phase 6 TODO.

### API / Contracts

- [x] API token and webhook V1 exist.
- [x] OpenAPI includes recent field enum additions.
- [ ] OpenAPI coverage for Gantt/Hierarchy/xlsx backend routes is fully audited.
  - Gap: Phase 3 TODO.

## Audit Output Requirements

The result document must classify findings as:

- P0: blocks RC staging/internal trial.
- P1: does not block first staging smoke, but blocks customer-depth trial.
- P2: known parity/UX gap, not an RC blocker.

No staging smoke item should be marked complete from this checklist alone.
