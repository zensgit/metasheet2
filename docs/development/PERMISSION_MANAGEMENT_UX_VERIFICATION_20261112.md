# Permission management UX verification — 2026-11-12

Base: `7e7e8d73a5eea36027cd9d1a9305c3fada602530`. Local verification uses synthetic data only. No production host or customer data has been used. GitHub CI and the current merge base must also be checked before merging.

## Behavior and boundaries

- Members are selected explicitly. Authorization confirmations separate role membership, inherited codes, direct grants and admission effects. Removing the platform-admin role requires the exact phrase 取消平台管理员; the server's last-admin refusal remains authoritative.
- Role permissions have human-readable resource groups. The role member panel adds/removes memberships with confirmed targets and validated readback. Unsaved role edits retain save/discard/stay protection and block member mutations.
- The permission checker calls the actual `POST /api/permissions/check`. Direct grants and templates are collapsed under 直接授权与例外. Template role labels are references, not appointments. Inherited sources link to roles; historical grants have a separate clear action. Object-level table, field and record permissions remain in the existing multitable workbench.
- Management navigation uses live `/api/admin/access-capabilities`. A valid legacy `users.role=admin` or RBAC `admin` grants platform management; permission management specifically requires RBAC admin, matching the existing permissions router. Business administrators get the scope entrance. Token-only claims, `is_admin` alone and `users:write` do not grant platform navigation.
- The patch does not broaden `userHasPermission` or replace individual business authorization. A permission-code result is not proof of object/department scope or every business operation's outcome.

## Explicit creation and source-specific removal

Single-user, uploaded-file and pasted-row creation require the new explicit-admission capability. No checkbox is selected by default. Requested namespaces are validated against supported namespaces derived from the selected role and preset. Batch creation keeps admissions disabled; this patch does not add a batch admission opt-in interface. Its confirmation freezes the submitted people, roles, inherited codes and default-off admissions. Changing inputs invalidates that confirmation. Starting a new file read immediately clears old rows; only the latest read can publish results or errors.

Both create paths persist an explicitly disabled attendance admission when it was not selected. Simply leaving the row absent is insufficient: the existing AuthService self-service bootstrap can grant attendance access to older accounts in attendance/platform mode. The disabled row preserves the new administrator choice through a subsequent profile read; unrelated older-account bootstrap behavior is unchanged.

Role assignment only changes membership. The optional catalog `updatedAt` is sent as `expectedUpdatedAt` and compared under the role lock. Unassignment can close admissions no longer covered by remaining roles. Missing catalog metadata must be displayed as unknown, not as proof of no inherited codes or admission effects.

`POST /api/permissions/legacy/revoke` removes all trimmed matches from the legacy `users.permissions` array, supporting JSONB and older text arrays. It preserves unrelated entries, direct grants, roles, administrator fields and admissions. Actor/target locks and live actor recheck precede the write; deprovision evidence is updated in the same transaction. Invalidation and audit follow commit. No match returns 404. Inactive/pending targets can be cleaned; missing/recycled targets are refused.

A matching success receipt is followed by source readback. Same-code direct or inherited grants may remain. A lost response or failed readback is an unknown outcome with a read-only refresh action, not a false success or assurance of no side effects.

## Scope persistence and grey candidates

`includeChildren=false` selects the exact department; true includes descendants. The flag is stored and returned for direct and template departments, including merge/replace application and upserts. A true ancestor and false descendant retain union semantics. Member-only scopes remain valid; empty scope does not authorize a delegation write.

The changed count/list, target/write checks, stock-preparation member query and privilege witness must all honor the flag. The witness hashes strict `[namespace, departmentId, boolean]` tuples with a new domain, invalidating older proofs when the flag changes.

Optional grey candidates expose only `id`, `name`, `selectable:false` and `disabledReason`. Expansion requires proven active organization membership and a matching active integration/provider/corp directory chain. Untrusted tenant headers, ambiguous organizations, member-only scopes or failed proof do not expand the directory. Per-target `manageableNamespaces` filters delegated role choices.

Grey suggestions are bounded to the requested page size, at most 100; search can narrow them. Already-authorized users are excluded across all configured scope links and groups, including multiple accounts and users on other authorized-list pages. The suggestions are not a complete directory of out-of-scope people.

This grey-candidate proof does not redefine pre-existing authorization for already-authorized department/member-group users. Its negative tests use genuinely out-of-scope candidates; they do not establish a new tenant policy for every historical scope path.

## Migration and rollback

Migration `zzzz20261111181500_add_delegated_role_scope_include_children.ts` adds `include_children boolean NOT NULL DEFAULT true` to scope assignments and template departments. Existing rows retain descendant inclusion.

Apply the migration before readers select the new column. Upgrade every scope-reading process before writing false: old readers ignore it and would include descendants. `down()` locks both tables and refuses while either has false rows. Do not restore an old reader over false rows; retain the upgraded application or deliberately reconcile those scopes first. This patch does not enable production privilege-proof prerequisites or add a production feature flag.

## Verification record

Database tests use isolated synthetic PostgreSQL with RBAC bypass and token trust disabled before imports. Credentials and host values are excluded from published evidence.

| Slice | Current evidence |
| --- | --- |
| Frontend behavior | Independent 18 files / 504 unique tests passed, zero skipped. The combined run passed 501 tests; after the final upload-race fix, all 3 affected member/confirmation files passed 185 tests, including 3 added regressions. The untouched scope/navigation, checker and role slices remain 210, 59 and 50 tests respectively. |
| Backend unit behavior | Independent 13 files / 706 tests passed; after the catalog SQL correction, the affected 3 files / 222 tests passed, including one new regression. The combined unique total is 707 tests. |
| Required web-lane registration | 2 files / 63 guard tests passed. |
| Browser-lane dependency registration | Stock-prep and approval wiring guards: 9 tests passed under native Node in WSL. Both classifiers include the new capability module imported through useAuth. |
| Scope/witness PostgreSQL | 3 tests passed, zero skipped; 474 migrations applied. |
| Actual PostgreSQL rollback | 5 scenarios passed; false-row refusal and missing-column cases; no temporary schema residue. |
| Legacy PostgreSQL | 9/9 passed, zero skipped, including the same warmed reader process before/after commit. An earlier CJS test-helper startup failure was fixed and the full slice rerun. |
| Admin and existing lifecycle PostgreSQL | Admin UX 25, lifecycle 15, batch 95 and recycle 25 passed, zero skipped, on separately migrated synthetic databases. Admin UX was rerun after the narrow catalog SQL correction. Together with legacy and witness, 7 specs / 172 unique tests passed. |
| Role browser | 4/4 scenarios passed against actual Vue, production routers and synthetic DB: add/remove/readback, cancellation, typed admin removal, unsaved edits and desktop/390px widths. |
| Checker browser | 1 combined scenario passed: real deny/allow, interrupted request, collapsed exceptions, no auto-selection, desktop/390px widths, focus trap/Escape/cancel with zero writes. Earlier narrow overflow was fixed and retested. |
| App navigation browser | 5 scenarios passed with actual App, guards, auth and capabilities: scope-only entry, database/JWT-only users:write denial, same-token downgrade and real cross-tab storage logout. The downgrade scenario dispatches a synthetic focus event because headless window switching did not emit one; native window-focus behavior remains unverified. |
| Management scope browser | 1 combined scenario passed: exact/subtree department choice, grey candidates, pinned selection, namespace-specific controls, confirmation and real database writes. |
| Members browser | 1 combined scenario passed: explicit selection, default-off and opted-in admission creation, role and bulk-admission confirmation/cancellation, typed admin removal, and desktop/390px layouts. With the actual App reset loaded, the narrow drawer is exactly 390px wide with left=0 and right=390. |
| Batch creation browser | File upload and pasted rows both passed (2 scenarios): cancel sends no write, changing input invalidates confirmation, confirmed creation persists disabled admission. All 6 browser suites total 14 passed scenarios, with the 22 tracked source-file hashes unchanged during final verification. |
| Existing permission lifecycle browser | Dedicated PostgreSQL/Chromium suite: 1 spec / 2 tests passed with the zero-skip guard. Clicks now pass through the actual confirmation; the mutation baseline is captured before opening it. Original lifecycle 6 writes and status sequence 403→200→200→403→403→200→403, scope 9 writes and 200→403, unchanged JWT and preflight-before-test-reread proofs remain. After admission succeeds, the UI's refreshed permission snapshot must equal the real access readback. |
| Existing stock-prep browser lane | The workflow's Playwright command passed all 39 synthetic-fixture scenarios with zero skipped tests. This lane does not use the real database. |
| Workspace validation | `pnpm validate:all` passed. After the final upload handler and its tests changed, the affected frontend tests and all 37 changed frontend source/test files were checked again; ESLint has zero errors and 32 test-fixture warnings. The 8 changed backend runtime files also pass ESLint. |
| Final frontend types | `pnpm --filter @metasheet/web type-check` passed, including the approval and stock-preparation verification projects. |

Dedicated real-database CI slices are registered in `.github/workflows/admin-users-realdb-review.yml`: batch, recycle, permission-ux-admin, permission-ux-legacy and permission-ux-witness. Each requires a JSON report, zero skipped tests and exactly one executed spec. New database specs are excluded from generic suites with different auth setup. Local browser evidence mounts actual components and production routers; it is not a complete production-process or deployment acceptance test.

The component harness loads the real App stylesheet and initializes auth/capabilities through production code and actual APIs. An earlier standalone run omitted that reset and misleadingly clipped the member drawer; that run is not the final layout evidence. Navigation tests mount the actual application entry point. Test servers and database containers are local and disposable.

## Screenshots

These are unedited browser captures with synthetic accounts. The component captures carry an isolation caption; only the navigation capture mounts the complete App shell. No temporary passwords or invitation URLs are included.

| View | Desktop | Narrow (390px) |
| --- | --- | --- |
| Permission checker | [Checker](../../artifacts/permission-management-ux-20261112/checker-desktop-viewport.png) | [Checker](../../artifacts/permission-management-ux-20261112/checker-narrow-viewport.png), [confirmation](../../artifacts/permission-management-ux-20261112/checker-confirm-narrow-viewport.png) |
| Role editor and members | [Role details](../../artifacts/permission-management-ux-20261112/roles-desktop-detail-viewport.png) | [Role details](../../artifacts/permission-management-ux-20261112/roles-narrow-detail-viewport.png) |
| Management scope | [Scope](../../artifacts/permission-management-ux-20261112/scope-desktop-viewport.png) | [Scope](../../artifacts/permission-management-ux-20261112/scope-narrow-viewport.png), [App navigation](../../artifacts/permission-management-ux-20261112/app-scope-narrow-viewport.png) |
| Members | [Members](../../artifacts/permission-management-ux-20261112/members-desktop-viewport.png) | [Effective-permission drawer](../../artifacts/permission-management-ux-20261112/members-narrow-detail-viewport.png) |
| Batch creation confirmation | [Preview](../../artifacts/permission-management-ux-20261112/members-batch-file-desktop-confirm-viewport.png) | [Preview](../../artifacts/permission-management-ux-20261112/members-batch-file-narrow-confirm-viewport.png) |
