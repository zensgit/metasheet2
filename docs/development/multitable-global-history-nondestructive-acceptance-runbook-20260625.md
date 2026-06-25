# Multitable Global History non-destructive acceptance runbook

Grounding: `origin/main` at `2b56e749b` on 2026-06-25. This runbook is for the
first product acceptance pass after the non-destructive Global History /
point-in-time restore line closed on main.

Recent closeout anchors:

- #3169 (`0d5dfe511`) shipped the T9-W FE token plumbing;
- #3177 (`ab92ae3c`) shipped R4 diff polish and the full mount-to-fetch wire test;
- #3184 (`6e666871`) reconciled the canonical verification docs;
- #3192 (`72600eee7`) debranded the historical Global History design docs.

## 0. Acceptance boundary

This is a trial / acceptance guide, not a new build plan.

In scope:

- base-level Global History timeline and batch detail;
- record drawer history with full-record and per-field preview-then-execute restore;
- scoped batch record restore, including partial and all-or-nothing modes;
- point-in-time read-only view and non-destructive Revert-to-T;
- config history, config-restore preview/execute for the safe subset;
- config revision retention and config-history `hasMore`;
- permission masking, row-deny, field-audit reveal, signed preview identities, drift/conflict handling.

Out of scope unless explicitly re-ratified:

- T8-2 Reset-to-T, which deletes records created after T;
- T9-W data-loss config operations, including field undelete and lossy retype;
- T8-1 undelete-execute;
- record-history projection keyset/`hasMore` estimate, which is waiting on the same-millisecond ordering decision.

## 1. Entry map for manual trial

| Surface | Where to enter | What to verify |
|---|---|---|
| Base Global History | Workbench top button `History` (`data-action="open-history"`) | Timeline loads, filters/search/cursor work, detail expands without leaking masked fields. |
| Record history | Open a record, choose the drawer `History` tab | Revisions show actor/time/source/field diffs. Restore button opens preview before any write. |
| Per-field record restore | Record drawer history diff checkboxes | Unchecking fields narrows the preview and execute set; no direct legacy write path is used. |
| Batch record restore | Select rows in the grid, click bulk `Restore` (`data-test="grid-bulk-restore"`) | Dialog defaults to original version, Advanced version picker re-previews, execute uses preview scope and expected versions. |
| Config history | Workbench top button `Config history` (`data-action="open-config-history"`) | Dedicated modal lists field/view/config revisions and filters by entity type. |
| Config restore safe subset | `Revert` action on safe config-history rows | Preview is read-only, confirm uses the server `previewToken`, successful restore refreshes sheet meta and grid. |
| Point-in-time read-only view | API / operator route `GET /api/multitable/sheets/:sheetId/point-in-time?asOf=...` | Shows visible records as of T using current row-deny and field-mask rules. |
| Non-destructive Revert-to-T | API / operator route `POST /api/multitable/sheets/:sheetId/revert-preview`, then `revert-execute` | Requires sheet-manage capability, refuses over-ceiling sheets, keeps post-T-created records. |

## 2. Suggested acceptance data

Use a small base with one sheet and at least six records:

- two ordinary records with text/number/date fields;
- one record hidden now by row-deny / conditional deny;
- one record with a field hidden by field permissions;
- one record created after the chosen `asOf` timestamp;
- one record edited after the chosen `asOf` timestamp.

Create at least these config changes:

- rename a field;
- reorder a field;
- update a view filter / sort / hidden-field config;
- create at least one gated config revision that should show as not reversible in v1.

The acceptance pass should use at least three actors:

- sheet manager: can manage sheet/config and run non-destructive Revert-to-T;
- record editor: can edit ordinary records but cannot run sheet-wide Revert-to-T;
- restricted reader/editor: subject to row-deny and/or field permissions.

## 3. Product acceptance checklist

### A. Read history

- [ ] `History` opens without errors and shows grouped events by actor/source/time.
- [ ] Time range, sheet scope, field filter, search, and cursor paging preserve the same visible result set.
- [ ] `searchTruncated` surfaces as a warning when a capped search may be incomplete.
- [ ] Batch detail hides row-denied records entirely.
- [ ] Field-hidden values and field IDs are masked in changed fields, detail payloads, and affected counts.
- [ ] Field-audit reveal requires explicit reveal + reason + valid grant, and writes audit before disclosure.
- [ ] Reveal does not affect restore/write surfaces.

### B. Record restore

- [ ] Record drawer History tab shows before/after field diffs and actor display names.
- [ ] Full-record restore opens `RestorePreviewDialog`; no write happens before confirm.
- [ ] Per-field restore checkboxes narrow the previewed and executed diff.
- [ ] Schema drift withholds executable identity or returns conflict; no partial write occurs.
- [ ] Row-denied records return not-found / forbidden-shaped behavior rather than leaking existence.
- [ ] Layer-3 field write permissions block forbidden fields across legacy, single execute, and batch execute.
- [ ] A successful restore appends a forward revision with `source=restore`.

### C. Batch restore

- [ ] Bulk Restore uses selected row IDs only for preview; execute uses the preview scope.
- [ ] Expected versions are built from each record's preview version, not current client state.
- [ ] PARTIAL mode restores allowed records and reports skipped denied/conflict/forbidden records.
- [ ] All-or-nothing mode rejects the whole batch when any target is blocked, with zero writes.
- [ ] Out-of-order preview responses cannot overwrite the active identity/scope.
- [ ] Off-page row labels are human-readable when available, with a safe ID fallback.

### D. Config history and safe config restore

- [ ] `Config history` opens from the workbench and fetches through the client envelope.
- [ ] Entity-type filter triggers a server fetch; it is not a client-only cull.
- [ ] Read gate matches mutation gate per entity type.
- [ ] A field-denied `canManageViews` actor cannot see denied-field `filterInfo` literals in `/config-history` view
      revision `before` / `after` payloads.
- [ ] The same actor cannot see denied-field `filterInfo` literals in `config-restore-preview` view `current` /
      `target` payloads; execute still applies the raw target server-side.
- [ ] Field/view safe reverts preview current -> target, then execute with `previewToken`.
- [ ] A computed or missing token is rejected; baseline hash alone is not accepted.
- [ ] Drift after preview returns conflict and does not write.
- [ ] Gated operations return the documented non-supported state, not a partial attempt.
- [ ] After a successful revert, sheet metadata and grid data refresh.

### E. Point-in-time read and Revert-to-T

- [ ] `point-in-time` read uses current row-deny; a record public at T but denied now is absent.
- [ ] Field-mask still applies to T-data.
- [ ] Revert preview is write-free and returns no executable token for an empty revert set.
- [ ] Revert execute requires `canManageSheetAccess`.
- [ ] A normal record editor receives `403`.
- [ ] A sheet above `MULTITABLE_SHEET_REVERT_MAX_RECORDS` receives `413`.
- [ ] Revert keeps records created after T.
- [ ] Revert never composes with field-audit reveal.

## 4. Expected error / status semantics

These are success conditions, not necessarily bugs:

- `403` on sheet-wide Revert-to-T for a record editor: expected D2 gate.
- `413 SHEET_TOO_LARGE` on over-ceiling Revert-to-T: expected D3/PIT-6 fail-closed behavior.
- `409` on stale preview identity, schema drift, or config drift: expected preview/execute identity protection.
- `422` on T9-W data-loss operations: expected v1 safe-subset gate.
- not-found-shaped response for row-denied restore targets: expected no-existence-oracle behavior.
- masked field values or omitted field IDs for restricted actors: expected field permission behavior.

## 5. Non-destructive trial script

1. Create the acceptance base and actors from section 2.
2. Make record edits as manager and editor; verify the base History feed groups them and shows source/actor/time.
3. Restrict one field and one record; re-open History as the restricted actor and confirm no data/count/existence leak.
4. Restore one full record through the drawer; confirm preview first, then forward `source=restore` revision.
5. Restore a single field from the same record history; confirm only that field changes.
6. Select several grid rows and run batch restore in PARTIAL mode; confirm skipped reasons are visible.
7. Run the all-or-nothing batch mode through API or test harness; confirm one blocked record produces zero writes.
8. Rename/reorder a field and update a view; open Config history and confirm the entries are readable.
9. Revert a safe config change; confirm signed-token execute, history append, and grid/meta refresh.
10. Attempt a gated config operation; confirm `422` / not supported.
11. Use `point-in-time` read for an earlier timestamp; confirm current row-deny and field-mask still apply.
12. Run Revert-to-T as sheet manager; confirm post-T-created records remain.
13. Run Revert-to-T as normal record editor; confirm `403`.
14. Re-run the key flows after page reload to catch client-only state assumptions.

## 6. Verification commands for a development checkout

Run the targeted gates before calling the acceptance pass healthy:

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/web exec vitest run --watch=false multitable-config-history-modal multitable-workbench-restore-wiring
pnpm --filter @metasheet/web build
```

If the full integration suite is too expensive locally, the minimum acceptance proof is:

- the real-DB Global History / restore / config-history suites pass in CI on `test (20.x)`;
- `multitable-web-guard` passes on the current branch;
- a manual UI pass records screenshots or notes for sections A-E.

## 7. Release / pilot decision

The non-destructive line is acceptable for pilot if:

- every checklist item in sections A-E passes or is explicitly marked not applicable for the pilot dataset;
- all expected error/status semantics in section 4 are observed;
- no masked field value, hidden field ID, denied record count, or denied record existence is visible to a restricted actor;
- no write path accepts a client-computable identity in place of a server preview token;
- T8-2 Reset-to-T and T9-W data-loss operations remain unavailable unless separately ratified.

If this pass fails on UX only, file polish follow-ups against the owning surface.
If it fails on permission, preview identity, drift, or atomicity, stop the pilot and fix before release.

## 8. Remaining gates after acceptance

| Item | Status | Required next action |
|---|---|---|
| T8-2 Reset-to-T | Gated destructive path | Explicit owner sign-off on D1-D5, then build behind a flag with PIT-2 / ceiling / atomicity goldens. |
| T9-W data-loss config ops | Gated irreversible config path | Separate design/sign-off for field undelete and lossy retype; likely depends on the wider undelete story. |
| T8-1 undelete-execute | Deferred | Needs the cross-cutting undelete/link-rebuild slice. |
| Record-history keyset `hasMore` | Deferred | Resolve same-millisecond ordering semantics before implementing. |
| Base-level config history | N/A for this line | No mutation chokepoints exist today; re-open only when base-level mutations are introduced. |
