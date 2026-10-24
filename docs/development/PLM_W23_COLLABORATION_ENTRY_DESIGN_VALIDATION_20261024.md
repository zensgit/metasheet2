# W23 Meta collaboration entry validation

Date: 2026-10-24
Branch: `codex/plm-w23-collaboration-entry-20261024`
Base: `4036ac23e5f7cd60554ea2b4d4cbc24e2add0bd1`
Nonce: `ccacaa3ace9647398aaa0c9bdf56b91a`

Meta-only ordinary collaboration entry on the existing BOM host and Multitable workbench. Snapshots stay on the five existing `/api/plm-collaboration-snapshots` routes. Native paths from the unified-entry plan are outside this slice. Check counts are in `artifacts/plm-w23-collaboration-entry-20261024/verification.json`.

## Entry

`PlmCollaborationSnapshotsPanel` starts collapsed. The toggle label is `协作快照` and `aria-expanded` is false. The closed body is not rendered. Opening the toggle does not fetch.

On `/plm/bom-review` the panel sits inside the existing `v-if="readySource"` block, after `PlmBomChangeReadPanel`. It receives that branch's `readySource` and `readyPart`. Missing, blank, and ambiguous source branches do not mount it. The panel has no `<select>`.

On the workbench the same panel is the first child of `mt-workbench__main` only when `readPlmCollaborationSnapshotHint` accepts the active sheet. The workbench passes its client, `grid.rows`, and `grid.visibleFields`.

## Hint

`MetaSheet.plmCollaborationSnapshot` is optional and exact: `{ bindingId: string, sourceKind: 'eco' | 'readiness' }`. Extra keys, a non-UUID id, and any other kind are ignored. The returned `bindingId` keeps its original characters.

`GET /api/multitable/sheets` and `GET /api/multitable/context` attach the hint only after the existing ACL filter. The context route still returns 403 for a denied addressed sheet before the hint queries. An empty allowed-id list runs neither query. Otherwise the route runs `SELECT to_regclass('meta_plm_collaboration_bindings') AS present` and, only when `present` is neither null nor undefined, `SELECT id::text AS id, sheet_id, source_kind FROM meta_plm_collaboration_bindings WHERE sheet_id = ANY($1::text[])`. The query is not wrapped in a catch. Malformed id or kind rows are dropped. Two remaining valid rows omit the hint. One remaining valid row is copied as a new two-key object. Disabled and stale rows are kept. `listSheets` and `loadContext` are unchanged and already preserve extra DTO fields.

## Snapshot calls

`sourceKind` is chosen explicitly. A hint does not select a kind. Opening the hinted binding is a separate `GET /:id` with no query. That GET shows an open button and does not navigate by itself.

A new preview starts with the current-version choice unset. Blank text does not become null. `没有当前版本` sends `currentVersionId: null`. `使用这个版本` sends the typed finite id. The base is chosen from `listBases` after an ordinary stored Meta bearer check and is not auto-selected. The table name is required. ECO sends `ecoId`. Readiness sends `rulesetId`. `expectedVersion === 0` omits `targetBindingId`. Append sends the loaded version and that binding id.

A readiness ruleset can be typed or taken from visible fields whose name is `ruleset_id`. Committing one GETs `?rowKey=` as URL-encoded JSON of `dataSourceId`, `tenantId`, `orgId`, `itemId`, and that ruleset, taken from the authorized shell plus the committed value. No selector leaves `row: null` and `canRefresh: false`. Changing the other control or replacing visible rows does not retarget the committed ruleset.

Refresh sends `{ expectedVersion, rowKey }` only when the server `canRefresh` is true and `rowKey` is a non-empty array. Disable sends `{ expectedVersion }` and does not delete the snapshot. Confirm and refresh acknowledgement open route `multitable` with `baseId` and optional `recordId`. Local owner, due, and note fields are not posted. Source text is rendered with Vue text bindings. `coverage_status` is shown only when the server sends that string, including `bounded_not_proven_complete`.

## Confirm identity

Every snapshot request captures `readAuthSessionSignature()` and a context generation. A late result, error, or `finally` is ignored after the user, source, base, kind, item, version choice, selected binding, selector, auth session, or unmount changes. An auth switch clears the rendered snapshot and does not clear sessionStorage or replay a write.

The confirm request id comes from `randomUuid()` once, with the body and CAS, before the first submit. Unknown and 409 responses keep that body. 409 is not success and does not mint a new preview or version. The storage key `metasheet_plm_collaboration_confirm_pending` holds the body, the context, and `sha256Hex(sessionSignature)` only. Reload restores a matching digest and does not submit. A digest mismatch or malformed record blocks a new mutation until the user abandons it. `getItem` or `setItem` throwing blocks the mutation. A `setItem` failure before any POST is not an unknown submit, so a later explicit confirm may create a new id. A managed entry, or no stored bearer, is refused before `listBases` and before any snapshot call. There is no managed-cookie fallback.

## Unchanged

Frozen snapshot service sha256 `26a70904d4345e32ede8c6884253518c97df3e6378b1fc44a853654cc92a42b0`. Frozen snapshot routes sha256 `1bab47a54e20d404aa526a48876c028587efaa4cfcfe3c0eea1a2580a3abbd9b`. BOM host spec sha256 `1ff1a443d2b5efa80716e147b81fa425f15121c1618c8506369d50c4963949ef`. No edit to the snapshot service, snapshot routes, SQL, adapters, auth, managed source, token store, package manifests, `client.ts`, or the native tree.

`apps/web/scripts/run-required-web-tests.sh` was absent from the sparse checkout. It was materialized with `git show 4036ac23e5f7cd60554ea2b4d4cbc24e2add0bd1:apps/web/scripts/run-required-web-tests.sh`. Pre-edit blob sha256 `552f3f3e8c76cce44b90f41bb6b0dfcd37c1b9424cea7283c7fee797c2287614`. The binding baseline for that path is null because the file was sparse-absent. One token, `PlmCollaborationSnapshotsPanel`, was inserted between `personal-view-client` and `public-multitable-form`. The file still has one `exec npx vitest run` line.

`plm-bom-listener.yml` gained path triggers for the touched entry files, appended `tests/unit/multitable-collaboration-navigation-hint.test.ts` to the existing backend vitest argument list, and added one frontend step that runs the new panel spec plus `tests/PlmBomReviewWorkspaceView.spec.ts` immediately before the existing real PostgreSQL snapshot step. The postgres service, `permissions: contents: read`, `timeout-minutes: 25`, Node 20, and pnpm 10.16.1 remain. The listener had no `managed222` token to preserve.

## R2 repair

Root reproduced five UI defects on panel sha256 `843d6c1882a1a76e74ba9963c0db01392c5614b200ffaa1cdec882097a910ccd`. The corrected seven-control packet is 2 pass, 5 fail, 0 error, 0 skip. An earlier seven-initial run had three missing-hint errors because the fixture clicked before the DOM rendered. Those three are fixture failures, not product evidence. This section records the focused repair and the checks below. It is not a Root acceptance.

Confirm, preview, refresh, and disable capture the session signature, parent Source, parent Item, hint key, and generation before the first await. The confirm digest hashes that captured signature. After each await, and again before `setItem` and POST, a stale stamp returns without posting and without deleting an unknown pending record. A later B signature does not bless an A preview. The same freshness rule covers restore and load. This is a client identity, context, and egress repair. It is not a demonstrated backend privilege escalation.

A parent Source, Item, or hint change drops the loaded anchor and bumps generation. The version choice stays where the explicit control left it. Refresh and disable read the loaded id, version, and row key only while that anchor still matches the current parent and the source and item fields. `chooseNew` still clears loaded context.

Reload at a different parent Item keeps the stored pending record, shows the reconcile notice, and does not copy the old Item into the form. A restore that started under one signature does not hydrate after the signature changes. An identity change clears the rendered pending, loaded, and preview state in the same turn and leaves sessionStorage in place. Abandon remains the explicit delete.

Loaded `row.cells` render only when a finite `visibleFields` entry has a whitelisted Source name and its own UUID is present. Masked, hidden, and unknown cells stay absent. Preview cells stay keyed by the existing Source names. No field-list endpoint was added.

The backend unit now throws on SQL that is not an enumerated branch. The context load's previously empty branches are `meta_views` for one sheet, `meta_fields` ordered by `"order", id`, `field_permissions fp`, and the `user_permissions` / `user_roles` permission-code union. One test queries `SELECT unexpected_sentinel FROM meta_future_table` and expects that throw.

`run-required-web-tests.sh` lists `PlmBomReviewWorkspaceView` once, between `personal-view-client` and `PlmCollaborationSnapshotsPanel`. It still has one `exec npx vitest run` line. The listener file was not edited.

`normalize.ts` replaces `Object.hasOwn(raw, id)` with `Object.prototype.hasOwnProperty.call(raw, id)`. Target, lib, and strict are unchanged. A private edge script checked an own label, ignored inherited `constructor`, and kept own `constructor` and `__proto__` on a null-prototype map.

R1, the first R2 release, the restore supplement, and the pending-slot supplement are separate counts in `artifacts/plm-w23-collaboration-entry-20261024/verification.json`. Full app typecheck, browser, HTTP, install, hour, production, source-picker, and the unified entry remain open.

## R2 supplementary controls

The first R2 release at `2026-10-24T17:17:48.913266+08:00` is historical. It is not the acceptance release. Root then froze three more actual RED controls against immutable R1 panel sha256 `843d6c1882a1a76e74ba9963c0db01392c5614b200ffaa1cdec882097a910ccd`. The packet manifest is sha256 `4598051ff7c5c8c1dd30eae341be23a82ac883c875082a58e1adc485411b459d`.

Those three sequences are now permanent cases in `PlmCollaborationSnapshotsPanel.spec.ts`. The panel source did not change for them. The stamp, the synchronous clear, and the guarded refresh already cover the sequences.

A restore that has entered the real digest under principal A does not hydrate after principal B finishes its own storage inspection and the held digest is then released. The stored pending bytes stay identical. The anchor and the retry control stay absent.

While principal B's storage digest is still held, the rendered A anchor and retry control are already gone. Storage stays byte-identical.

A loaded refresh that switches principal before its first storage await returns resolves without a value, posts no `/refresh`, and leaves no unhandled rejection. The version is copied before that await. The later read stays inside `try`.

That restore supplement's fixture count is 33 passed and 0 failed. The panel spec contributed 23. The unchanged host spec contributed 10. The first R2 fixture count remains 30. The R1 fixture count remains 23. Backend unit and backend `tsc` were not rerun. Narrow `vue-tsc` exited 0 again. The shared Vue global types file stayed sha256 `5a214dfb5fc02409787e0a7e297baad796809fe3a7b82c6874f5bcc323c43fb8`, size 6303, mtime_ns `1792830452822532608`, directory mtime_ns `1790739124106486757`. This is not a Root acceptance.

## R2 pending-slot supplement

Root froze two more actual RED controls against the same immutable R1 panel. The packet manifest is sha256 `bc35817afb93383d7d2c6bbc4bcc204f87c86aeca416900ca040f22b24317933`. Both failed. A same-identity, same-context replacement uses a new request id and preview id. The releases at `2026-10-24T17:17:48.913266+08:00` and `2026-10-24T17:34:10.505000+08:00` stay historical.

Confirm now freezes the exact `sessionStorage` text it read. It compares that text again immediately before writing a new pending record and immediately before the confirm POST. A newer record stops the write and the POST. The acknowledgement removes the stored text only when that same text is still current. The replacement stays byte-identical. The panel keeps it as the unknown pending record and does not replay, delete, or retarget it. Same-origin documents can change this storage while a confirm is awaiting. These UI controls do not establish a cross-process guarantee.

This pending-slot run's fixture count is 35 passed and 0 failed. The panel spec contributed 25. The host spec contributed 10. Earlier fixture counts remain 23, 30, and 33. Backend unit and backend `tsc` were not rerun. Narrow `vue-tsc` exited 0. The shared Vue global types file was unchanged before and after that check. Root acceptance remains open.

## R3 SQL journal

Root pinned the released R2 UI as immutable packet `w23-ui-entry-r2-released-20261024`, manifest sha256 `3b25334e48b53fc5e66576c866c96505541417edeb4f7b0d62c88318aaa5596d`. Root reran the original 7 controls, the 3 restore controls, and the 2 pending-slot controls unchanged. That independent run was 12 passed, 0 failed, 0 error, and 0 skip. The panel stayed sha256 `ccb141ed159fd7aa60d7adaaf3585c25820105466b07746bafb5ad9e7ee60e71`. This turn did not rerun those UI controls and did not edit the panel.

The residual item was a P2 in this unit's observability. The list-sheets route catches an unknown query and can still return the expected 500, so a status assertion alone can pass while an unexpected statement was swallowed. These controls record that test gap. They do not change product behavior.

The unit now keeps a finite `unexpectedSql` journal, capped at 4 entries, and asserts that journal is empty after every route case, including the 500 case. The direct sentinel uses its own fixture, expects exactly one entry, `SELECT unexpected_sentinel FROM meta_future_table`, and leaves that entry in place. `afterEach` still only unmocks the RBAC module and restores mocks. The known normal empty SQL branches stay enumerated.

A private edit inside the test pool recorded `SELECT injected_unknown_during_500 FROM meta_future_table` on the bindings-failure path and still threw `bindings unavailable`. That run exited 1 with 6 passed and 1 failed. The failed assertion was `expectNoUnexpectedSql` on `surfaces a bindings read failure as the route 500`. The received journal was that injected statement. The route log was still `[univer-meta] list sheets failed: Error: bindings unavailable`. The injection was then removed. The restored unit file sha256 is `d37b8e20ad56406692e646286f56b37a8dc7e5ec114a8ad3c389fa0c0a3dbb81`. The restored run exited 0 with 7 passed, 0 failed, 0 pending, and 0 todo. The production route stayed sha256 `b8bcaef0b430ceec86558fad96c2318122ac0d7c69cad3c2bbeebc0d30a014e2`.

Earlier UI fixture counts remain 23, 30, 33, and 35. This unit count is separate from those counts. Root review, the whole application, HTTP, browser, install, and the hour remain open. This section is not a Root acceptance.

## R4 hint-only Workbench call

Root reproduced one availability failure against the released R2 panel sha256 `ccb141ed159fd7aa60d7adaaf3585c25820105466b07746bafb5ad9e7ee60e71`. The packet is `w23-workbench-hint-only-r2-root-red-20261024`, manifest sha256 `5b03cfe2d33c8145b648e184177f20c7ca43ffc8723424f75f777980a3cee6df`. `MultitableWorkbench.vue` lines 290–297 pass the hint, visible rows, visible fields, and client. They do not pass Source or Item. The panel defaults both to empty. `applyLoaded` and `actionableLoaded` required the server anchor to equal those empty props, so an authorized finite GET still left `open-sheet` null. The R3 SQL-journal release stays historical. It is not a Root acceptance. The backend unit was not edited and was not rerun. Its sha256 remains `d37b8e20ad56406692e646286f56b37a8dc7e5ec114a8ad3c389fa0c0a3dbb81`.

A nonempty outer Source or Item remains a constraint. When that prop is absent, the explicit binding GET is the authority: its finite server anchor establishes the frozen Source, Item, and version. The panel does not infer a first Source or version from visible rows, and it does not add a hint field, endpoint, or source picker. A provided parent that disagrees with the anchor is still refused. Parent changes, session changes, hint freshness, the three local fields, the existing engines, the Readiness row selector, and the unknown pending compare stay as they were.

The registered cohort in the private R4 fixture passed 37 tests, exit 0: panel spec 27, host spec 10. Narrow `vue-tsc` exited 0 with empty output. The shared Vue global types file stayed sha256 `5a214dfb5fc02409787e0a7e297baad796809fe3a7b82c6874f5bcc323c43fb8`, size 6303, mtime_ns `1792830452822532608`, directory mtime_ns `1790739124106486757`. A copy of Root's original 12 controls plus the hint-only case passed 13, exit 0. Those copies ran in `/tmp/plm-w23-ui-grok-r4-ccacaa3ace9647398aaa0c9bdf56b91a`. The Root fixture files were not edited. The R2 counts 35, 12, and narrow exit 0 stay with R2. Panel sha256 is now `3f4287e3ae2f822d249ac26912671ed1933226d37697e41e91dad9f5b322373c`. Panel spec sha256 is now `f781eacbba0128fc09eb67b11a81ab559def762d725e8fdca2bb48a86f520739`. Root review, the whole application, HTTP, browser, install, and the hour remain open. This section is not a Root acceptance.

## Final independent verification

Codex inspected the released source and independently reran the unchanged original 12 adversarial controls, the actual hint-only Workbench call, the permanent panel spec, and the unchanged BOM host spec. The final combined run passed 50 tests: 13 independent controls, 27 panel cases, and 10 host cases, with zero failures, errors, or skips. Panel sha256 remained `3f4287e3ae2f822d249ac26912671ed1933226d37697e41e91dad9f5b322373c`. The earlier RED packets and invalid private-fixture attempts remain separate historical evidence.

The backend failure-path test additionally asserts that its intended bindings read is reached exactly once. This one-line test-only correction prevents an earlier known-query failure from satisfying the same expected 500 response. The final unit sha256 is `da396bc6a17fb3ea4218b92a85736bcccf4e182ccea80e698d11041d4684061e`. Codex independently passed all seven backend unit cases. In a private fixture, an earlier known-query failure made the new reachability assertion RED; an unexpected SQL query on the intended failure path made the empty-journal assertion RED. Each targeted mutant failed its one selected case; the six filtered cases are not coverage. Restoring the exact fixture bytes passed the selected case. Product route source was not mutated. Private setup and teardown copies kept fixture cleanup inside the owned nonce directory, which was removed after its Node processes ended.

Backend production `tsc --noEmit --incremental false` exited 0 with empty output; its existing config excludes test files. The separate frontend narrow `vue-tsc` exited 0 with empty output using the actual ES2020/strict import closure, private generated global types, and a write guard. Shared generated-cache SHA and nanosecond mtime were unchanged. This frontend check is limited to the panel/DTO import closure; full application, host, and Workbench typechecking are not claimed.

These checks qualify this bounded source slice. Parent-head publication checks, the new exact-head CI, actual Native+Meta HTTP with independent personal identity, browser/unified source selection, static build and image provenance, installation, the original-frame hour, and the complete master acceptance remain separate. The personal write/approval grant engines and Native source are unchanged by this Meta slice. Publication remains Draft.
