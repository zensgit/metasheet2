# Approval Lock-2B Contact Multi-Select Development Report

Date: 2026-09-03
Status: IMPLEMENTED AND VERIFIED; OWNER READY/MERGE GATE
Contract: `approval-lock2-org-controls-field-routing-20260817.md` L2-B/L2-C, OD-L2-2(a), OD-L2-3(a), OD-L2-7(a)
Parent: `c7ef42a221ec8f3a04a8702fe89a6fa145b6e211` (#5454 Lock-2A merged main)
Pre-evidence exact head: `0bc10532f4af2b0668094223bb0ae0097d434df4`

## 1. Result

The shipped `user` form-field type is now the Lock-2B contact control. It supports typed authoring and fill-time behavior for:

- `allowSelf?: boolean`, absent equivalent to `false`;
- `selection?: 'single' | 'multi'`, absent equivalent to `single`;
- `defaultMode?: 'requester' | 'designated'`;
- `defaultUserIds?: string[]`;
- `maxSelections?: number` for bounded multi selection.

The fifth key needs an explicit contract note: the L2-B prose lists four keys, while ratified OD-L2-3 and the owner decision record require `maxSelections` as the publish-time cap. The implementation follows the ratified owner record and exposes one exact five-key server allowlist.

No new form type, assignee-source kind, feature flag, migration, event family, or external write was added.

## 2. End-to-End Call Chain

### Authoring

`templateAuthoring.ts` hydrates the five typed properties into `FieldAuthoringDraft`, validates selection/default/cap relationships, and emits only meaningful `user` props. Retyping away from `user` removes contact-only properties. `approvalFormCommands.ts` admits these properties only for a current `user` field, preserving one typed undo/redo command per committed inspector edit.

`ApprovalFormFieldInspector.vue` supplies the contact inspector controls. Designated people are fetched through the existing author directory composable; off-page selected ids remain present with values-free labels. Choosing the requester enables `allowSelf`; disabling `allowSelf` clears an incompatible requester default.

### Request Form

`ApprovalUserPicker.vue` now supports single and bounded multiple selection without changing the existing single-value event contract. Excluded requester ids are disabled even when restored as a current selection. Unresolved identities remain values-free and unselectable.

`ApprovalNewView.vue` initializes requester/designated defaults, renders top-level and detail contact pickers, preserves scalar single values and array multi values, resolves selected labels in one batch, and submits the exact selected shape.

### Server Boundary

`ApprovalGraphExecutor.ts` enforces the value protocol before any approval write:

- single is one legacy string or object carrying a valid `id`;
- multi is an array;
- blank/malformed ids, duplicates, wrong cardinality, and values above `maxSelections` fail closed;
- the historical blank-scalar routing door remains distinguishable, so field-derived manager/head routing still returns its existing values-free empty-anchor response.

`ApprovalProductService.ts` applies the exact props allowlist on save/publish/restore, pins required/no-visibility/max semantics for all three contact-derived assignee sources, and verifies every submitted contact against active local users. `allowSelf` is enforced on the server using the effective requester identity. Directory read failure is a values-free retryable 503 and occurs before instance/assignment persistence.

`ApprovalAssigneeResolver.ts` resolves every distinct multi value. Direct `form_field_user` and contact-derived manager/department-head sources use UNION semantics with no runtime truncation. Field-derived organization chains are resolved at create and frozen into the instance-bound snapshot, so later directory changes cannot move an in-flight seat.

## 3. Compatibility

- A pre-Lock-2 `user` field with no props remains byte-equivalent: single selection and requester self-selection refused by default.
- Existing enriched single values such as `{ id, name }` remain readable; display metadata is not authoritative.
- Published/in-flight runtime graphs continue to execute from their frozen definitions and snapshots.
- Old drafts that use an unlisted `user.props` key intentionally fail their next save/publish/restore. The ratified mitigation is the deployed-data census in Section 5, not a permissive residual spread.

## 4. Code Surface

Production frontend:

- `apps/web/src/approvals/approvalFormCommands.ts`
- `apps/web/src/approvals/components/ApprovalFormFieldInspector.vue`
- `apps/web/src/approvals/components/ApprovalUserPicker.vue`
- `apps/web/src/approvals/templateAuthoring.ts`
- `apps/web/src/views/approval/ApprovalNewView.vue`

Production backend:

- `packages/core-backend/src/services/ApprovalAssigneeResolver.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`

Fifteen existing focused test files were updated. The Lock-7 field-edit real-DB fixture now carries the ratified required pin and supplies an active contact. Three older integration fixtures were also aligned with the same active-contact and required-field contract after the first published Node 20 run exposed them. No workflow, shared test manifest, package manifest, migration, OpenAPI file, or feature-flag registry changed.

## 5. Release Boundary

The isolated synthetic database census returned zero persisted user fields. The separately owner-authorized staging census then found one persisted `user` field, zero fields carrying `props`, and an empty props-key set. It ran as an aggregate-only read in an explicit read-only transaction and selected no field values, user ids, tenant ids, or template payloads. The result is compatible with the five-key allowlist and requires no data rewrite or exception. Production was not queried.

The implementation and staging compatibility gate are complete. Ready/merge remains a separate owner decision. This report authorizes no branch-protection change, flag change, dispatch, deployment, production action, production-data read, or additional staging action.
