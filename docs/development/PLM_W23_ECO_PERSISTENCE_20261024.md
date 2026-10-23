# W23 finite ECO persistence

Branch `codex/plm-w23-eco-persistence-20261024` is based on `8e15a92c4f994a5cba3f1df0ffa65eb905159e32`. This increment adds five ordinary Meta JWT routes for one ECO collaboration collection. It does not add readiness, UI, CAD, approval grants, a shared credential fallback, or a new manager.

The current 8e contract is `/tmp/plm-w23-eco-persistence-current8e-contract-20261024.json`, sha256 `fb4c20bd2754386dec1878e77a91edcd8f0a1e02c377ac4f7f239a9e622bbe6e`. Where an older proposal disagrees with that contract, the contract is the behavior implemented here. The migration and wire files on this base stay frozen.

## Routes

Mounted at `/api/plm-collaboration-snapshots` only when `plmEnabled` is already true. `PLM_BOM_REVIEW_ENABLED` does not gate the mount. The JWT family prefilter matches the BOM router and does not call `requireBomReview`. The actor is `req.user.id`. Responses use `{ok:true,data}` or `{ok:false,error:{code}}` and `Cache-Control: no-store`.

- `POST /preview` freezes one ECO source, anchor, base, and name for 15 minutes. `request_id`, `binding_id`, and `consumed_at` stay null.
- `POST /confirm` requires `expectedVersion` 0 with no target for a new collection, or a positive version with an explicit target for an append. Collection adoption is not inferred.
- `GET /:id` returns the retained binding and visible cells. It makes no Native call. `canRefresh` is a local eligibility hint.
- `POST /:id/refresh` rewrites the eleven source cells only when the business hash changes. An equal hash writes nothing.
- `POST /:id/disable` sets `disabled` and `version+1`. An exact disabled replay returns the retained state and does not restore it.

Source `readOnly` on the field property is not an ACL exemption. Field-permission `readOnly`, hidden fields, record access `none` or `read`, and a lock still refuse a source write. GET omits hidden cells and returns no cells when record access is `none`.

## Publication

Each short authority transaction takes `pg_advisory_xact_lock(hashtextextended(dataSourceId, 0))` before `classifyManagedSourceOnQuery` and before `data_sources` `FOR SHARE` or `FOR UPDATE`. The lock is not held across HTTP. Any managed binding row is refused. Schema-missing and unavailable fail closed.

The final write uses one `pool.transaction`. A new collection stays at version 1. A new or changed row on an existing collection advances the binding once before the receipt. The receipt, mapping, record, and `system_sync` history commit together. Success is the committed transaction. `metasheet.plm_collaboration_sync` is set only around that source write.

Base authority is owner or `canManageViews` from `deriveCapabilities(listUserPermissionsOnQuery, isAdminOnQuery)`. Sheet management is `canManageSheetAccess`.

## Adversarial controls

A. After the provider returns, the final transaction classifies the source again on that same transaction query. A managed row inserted with an unchanged config fingerprint is `ECO_SOURCE_MANAGED`: the preview is not consumed and no binding, record, sync, or history row is written. The global `classifyManagedSource` wrapper is unchanged and is not called from the transaction.

B. Replay of a consumed preview checks the actor, current source and sheet authorization, the frozen tuple and name, and any explicit target. Target B is `409` with no provider call. `expectedVersion` 0 with no target may replay after the binding version has moved past 0. The same request on another preview conflicts. A changed business hash against an unconsumed preview is `SOURCE_CHANGED` and does not mark a binding stale. A retained Native entitlement or anchor refusal may mark an existing active binding stale in a separate transaction. Transport unavailability does not.

## Measured checks

From `packages/core-backend`, after the service parser narrowing:

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` exited 0. Free space before it was 14335299584 bytes.
- `node node_modules/vitest/vitest.mjs run tests/unit/plm-collaboration-snapshot-service.test.ts tests/unit/plm-collaboration-snapshot-routes.test.ts` passed 23 tests in 2 files. Free space before it was 14336028672 bytes.

The real PostgreSQL file is prepared and was not executed. Its mock-pool cousins are not PostgreSQL proof. Installed HTTP acceptance is not claimed. No commit or push was made.

## Limitation of the prepared PostgreSQL control

The prepared file pauses inside the injected provider, after the DTO exists and before the promise resolves, then inserts `plm_managed_source_bindings` and `plm_managed_identity_links` from a second connection. It does not call `provisionManagedLink`, because that function uses the global pool and would leave this fixture schema. The service's final transaction still starts only after that promise resolves. Root owns the actual two-connection, HTTP, CAS, and rollback run.

## Root repair e20a1351

The checks above are the initial service measurement. They are not proof of the repaired service. Root PostgreSQL found five business failures on service `01d459a32087a36e76f4244c6d53494e5bf1588c1f0817f850f702acd77fbf09`. This repair keeps those results as history.

Confirm with a positive `expectedVersion` reads the explicit target and requires the same frozen source, scope, item, nullable version, base, name, and fingerprint, plus current management and the exact active version, before the provider. Failure retention carries that identity and rechecks it. A token refusal can stale only that target. An unrelated binding stays active.

A consumed replay admits the current source and requires the fresh fingerprint to equal the frozen preview and binding. A changed config is `409 SOURCE_CHANGED` with no provider call and no history. `expectedVersion` 0 with no target still replays after the binding version has moved. A contradictory target stays `409`. Replay also requires current sheet management, not read alone.

Preview, confirm of an unconsumed preview, and refresh refuse with `503 ECO_RUNTIME_UNAVAILABLE` when `MULTITABLE_ENABLE_WRITER_FENCE` is not exactly `true`. The flag is not turned on globally. A publication also requires `mintOperation` to return an operation id and `sealOperation` to insert the endpoint. GET and disable do not gain that gate.

A row whose record access is `none` returns `row: null`. The response keeps the binding shell and sheet/view link. It does not return `recordId`, the typed row key, the business hash, or `capturedAt`. A hidden field value stays out of the allowed row cells.

The prepared PostgreSQL fixture no longer creates the four RBAC tables. It applies the existing config-history, config-source, row-deny, and conditional-rule migrations, sets the writer fence true for the fixture, and restores the previous value. The direct managed-binding insert remains classifier evidence. It is not a `provisionManagedLink` proof.

From `packages/core-backend`, after this repair:

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` exited 0. Free space before it was 13998010368 bytes.
- `node node_modules/vitest/vitest.mjs run tests/unit/plm-collaboration-snapshot-service.test.ts` passed 19 tests in 1 file. Free space before it was 13996867584 bytes.

The route file was not rerun. The real PostgreSQL file was not executed. Installed acceptance is not claimed.

## Field and lock repair 078ebf68

The measurements above stay history. Root PostgreSQL on service `c3d2ab28287bde6a33fcea6e79c7b75d619471fb874f110ec5e5436dd1b1e4df` found two further failures.

A readable row still returns `recordId` and the visible cells. `rowKey`, `businessHash`, and `capturedAt` are present only when all eleven source fields are visible under the existing field scope or property. A hidden source field nulls those three. A hidden local field does not. Record access `none` still returns `row: null`.

Confirm preflight, confirm final, refresh, replay, and failure retention take `pg_advisory_xact_lock(hashtextextended(dataSourceId, 0))` before an ECO preview or binding row lock. `admit` still takes that lock before `classifyManagedSourceOnQuery` and before the data source row. A lost concurrent append is `409 VERSION_CONFLICT`. The service does not map `40P01` and does not retry.

From `packages/core-backend`, after this repair:

- `node node_modules/typescript/bin/tsc --noEmit --pretty false` exited 0. Free space before it was 13967941632 bytes.
- `node node_modules/vitest/vitest.mjs run tests/unit/plm-collaboration-snapshot-service.test.ts` passed 21 tests in 1 file. Free space before it was 13952204800 bytes.

The real PostgreSQL file, including the new field and concurrent tests, was not executed. Installed acceptance is not claimed.

## PostgreSQL fixture repair 87e32164

The measurements above stay history. Root later ran service `1293269d83ef7b89478208fa1b96f362f05df648d9394d137a4c0beb957301d1` on PostgreSQL. That review is root history. Privacy was 2 PASS. Two services confirming concurrently was 1 PASS: one commit at version 2 and one `409 VERSION_CONFLICT`, with no `40P01`. `provisionManagedLink` was 2 PASS. Target, replay, and a legitimate stale were 4 PASS.

The prepared realdb file on that same body was 7 nodes: 6 PASS and 1 fixture FAIL. The failed node is `a hidden source field redacts ECO identity and a local-only hide does not`. Its direct `UPDATE meta_records` of `kept-local`, without canonical write admission, a version CAS, or a history seal, raised `23514` `plm_collaboration_source_protected`. That statement is fixture SQL. It is not a service business failure. The root packet manifest is `ad71919ad93dd2a3475eaf7f14fa81492a970dd20d2c71a2eabdf9ae6efea2a3`. The production guards, the trigger, and the service stay unchanged.

The same node now writes `kept-local` through the existing `RecordWriteService.patchRecords` while `review_note` is still visible. The actor is `eco-owner`. `resolveSheetCapabilitiesForUserOnQuery` supplies the current manage and field authority, with `isAdminRole` false. The call uses `ensureRecordWriteAllowed`, the fixture writer fence, the minted ledger, the live record version, and the history seal. A GET then shows `cells.review_note` as `kept-local` together with `cells.id`, `rowKey`, `businessHash`, and `capturedAt`. The `rest` revision for that version has an `operation_id`, and that operation's `event_count` is 1. The existing `meta_fields` property update then hides `review_note`. The following GET omits `kept-local` and still returns the source metadata. The provider call count does not move.

This worker did not execute PostgreSQL. The other six realdb nodes were not repeated. The new imports are in the test file, which `tsc --noEmit` excludes, so `tsc` was not rerun. The unit file was not rerun. Installed acceptance is not claimed.


## Independent root qualification before source commit

The final production service is `1293269d83ef7b89478208fa1b96f362f05df648d9394d137a4c0beb957301d1`; its field/lock repair passed independent static review. On actual owned PostgreSQL 16.15 UTF8, independent privacy 2, concurrent confirm 1, actual `provisionManagedLink` 2 and target/replay/legitimate-stale 4 controls passed. The concurrent observation was an actual source-advisory wait, one committed version 2 and one `409 VERSION_CONFLICT`, without `40P01` or double history. The producer control used the canonical migrations and actual global-pool producer, not a manual replacement producer insert.

The current author realdb file first passed 6 nodes and failed one fixture statement: a direct local-cell UPDATE correctly hit `23514 plm_collaboration_source_protected`. The fixture now uses the existing `RecordWriteService` with current non-admin authority, version CAS, a persisted local value and an actual REST revision with a non-null sealed operation. Root reran only that failed node: 1 passed, 6 deselected. Production service pins did not change. This is not a claim of one final full-file 7-node run or a sum of distinct controls. Its post-commit subscriber query logged missing fixture relation `meta_record_subscriptions` (`42P01`); subscriber/notification integration is unqualified.

Historical five-RED, c3 two-RED and fixture-RED evidence remains immutable. Current service proof manifest: `ad71919ad93dd2a3475eaf7f14fa81492a970dd20d2c71a2eabdf9ae6efea2a3`; corrected fixture: `e2e8bf289583f93ec6d0982331b18ba9c2ab598c37fdbe3effd8190c08c08b22`. Both owned databases were explicitly dropped and catalogs restored; clusters stopped with status 3, PID absence and no open files, then only their owned runtime copies, roots and locks were removed. Final cleanup manifest: `f23473933be71ee5bd0f526fe22457c86e03676c213c2707fb6b9fd66beb5a0a`.

Actual Native HTTP, unified workspace/browser, readiness persistence, installed images and exact remote CI remain separate gates. This source cut does not complete the master goal. Keep Draft; no merge, deployment, production enablement, real business notification or issue closure.
