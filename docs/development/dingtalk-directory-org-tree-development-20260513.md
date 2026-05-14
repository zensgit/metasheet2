# DingTalk Directory Org Tree Development - 2026-05-13

## Summary

Implemented a safe first slice for DingTalk organization-structure usability inside MetaSheet directory management.

This does not create a second editable organization master and does not write back to DingTalk. It exposes the already-synced DingTalk department mirror to administrators, with per-department member and local-binding coverage. The follow-up action slices let administrators reuse department IDs from that mirror, copy single or currently visible department IDs, copy visible-department, draft-scope-change, configuration, stale-reference, binding-gap, inactive-department, and mirror-observation reports, filter large department trees, focus on configured, problematic, inactive, not-fully-bound, or not-latest-batch departments, clear active view filters, bulk-add or bulk-remove narrowed department rows in draft scopes, review and revert scope changes before saving, and add a known department ID manually when the local mirror has not caught up yet.

## Scope

- Backend: add a read-only department summary API for a directory integration.
- Frontend: add an on-demand "组织架构镜像" section on `/admin/directory`.
- Frontend: add quick actions from each department row into admission whitelist, admission exclusions, and member-group sync scope.
- Frontend: add reference checks for configured department IDs that are missing from the local mirror or already inactive.
- Frontend: add inline cleanup actions for stale department references in the current draft.
- Frontend: add a bulk cleanup action for all stale department references while preserving healthy references.
- Frontend: add a clipboard report for all configured department references and their mirror status.
- Frontend: add a clipboard report for stale department references.
- Frontend: add client-side department filtering by department name, department ID, parent ID, or full path.
- Frontend: add member-binding gap counters and a `只看未全绑定` department filter.
- Frontend: add a clipboard report for departments that still have unlinked directory members.
- Frontend: add a `只看停用部门` department filter.
- Frontend: add a clipboard report for inactive departments.
- Frontend: add a local mirror sync-observation card and clipboard report for department batch freshness.
- Frontend: add a `只看非最新批次` department filter and per-row stale-batch chip.
- Frontend: add mirror-observation quick focus actions for stale-batch, inactive, and unlinked departments.
- Frontend: add scope-view filters for all departments, configured departments, and departments with visible issues.
- Frontend: add a clear-filter action that resets both text search and scope-view filtering.
- Frontend: add clipboard copy actions for a single department ID and the current visible department ID list.
- Frontend: add a clipboard report for the current visible department rows.
- Frontend: add save-before-review draft change summary and clipboard report for scoped department fields.
- Frontend: add local "还原已保存范围" and per-field "还原此范围" actions for scoped department draft fields.
- Frontend: add draft-only bulk add/remove actions for the currently visible filtered/scope-filtered departments.
- Frontend: add a draft-only manual department ID tool for known departments that are not present in the local mirror yet.
- Tests: add backend route coverage and frontend click-to-load coverage.
- No database migration was needed because the existing schema already has:
  - `directory_departments`
  - `directory_accounts`
  - `directory_account_departments`
  - `directory_account_links`

## Changed Files

- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`

## Backend Design

Added `listDirectoryIntegrationDepartments(integrationId)`:

- Validates `integrationId`.
- Reads `directory_departments` for the selected integration.
- Aggregates active member count through `directory_account_departments` and `directory_accounts`.
- Aggregates linked local-user count through `directory_account_links`.
- Includes active child department count.
- Returns a flat department list with parent external department IDs so the web client can render a tree safely.

Added admin route:

```text
GET /api/admin/directory/integrations/:integrationId/departments
```

Response shape:

```text
items[]
total
```

Each item includes department ID, external department ID, parent external department ID, name, full path, active status, member count, linked count, child count, and sync timestamps.

## Frontend Design

Added an on-demand "组织架构镜像" section to `/admin/directory`:

- It does not automatically fetch on page load.
- The administrator clicks "加载组织架构" or "刷新组织架构".
- It renders a tree-like flat list using parent external department IDs.
- It shows total departments, total members, linked local users, inactive department count, per-department member count, linked count, child count, parent label, and latest sync timestamp.
- It explicitly tells users this is a local DingTalk directory mirror and does not write back to DingTalk.

Added department quick actions:

- "加入准入白名单" appends the department external ID into `admissionDepartmentIdsText`.
- "加入排除部门" appends the department external ID into `excludeDepartmentIdsText`.
- "加入成员组同步" appends the department external ID into `memberGroupDepartmentIdsText`.
- The helper normalizes comma/newline separated values through the existing parser.
- Duplicate department IDs are ignored and reported through the existing status banner.
- The action only updates the current form draft; persistence still happens through the existing "保存变更" button, so users can review before saving.

Added configuration reference checks:

- Loaded department rows show badges when they are referenced by admission, exclusion, or member-group sync drafts.
- If a configured department ID is not present in the synced mirror, the page shows a `未同步` warning.
- If a configured department ID points to an inactive department, the page shows an `已停用` warning with the department name and ID.
- When configured IDs all match active departments, the page shows an explicit healthy reference-check message.
- This turns organization drift into a visible admin-page signal before the administrator saves or reuses a stale scope.

Added inline cleanup actions:

- Each stale-reference warning includes a "从...移除" action.
- The action removes that department ID from the corresponding draft textarea only.
- It uses the same normalized comma/newline parser as save/test payload construction, so duplicate or mixed-separator input is cleaned consistently.
- When all stale references are removed and remaining IDs match active departments, the reference-check panel switches to the healthy state.

Added bulk cleanup:

- The reference-check panel shows "清理全部异常引用" when any stale reference exists.
- Bulk cleanup removes all missing or inactive department IDs from their matching draft fields.
- Valid department IDs already referenced by the same fields are preserved.
- The action is still draft-only; persistence remains guarded by the existing "保存变更" button.

Added stale-reference report copy:

- The reference-check panel shows "复制异常引用报告" when any stale reference exists.
- The copied report includes the integration name, issue count, issue status, field label, and department ID/name.
- Missing departments are marked as `missing_from_mirror`.
- Inactive departments are marked as `inactive_department`.
- The report contains only configuration diagnostics already visible on the page; it does not include DingTalk secrets, robot webhooks, app secrets, JWTs, passwords, or full token values.
- Copy failure is surfaced through the existing status banner and does not change any draft field.

Added configuration-reference report copy:

- The reference-check panel shows "复制配置引用报告" whenever scoped department configuration exists.
- The copied report includes integration name, configured unique department count, loaded mirror department count, issue count, and the grouped department IDs for admission whitelist, exclusion, and member-group sync drafts.
- Each configured department ID is marked as `active_department`, `inactive_department`, or `missing_from_mirror`.
- The report is intended for save-before-review and operations handoff, especially when multiple draft fields share the same department ID.
- The report contains only IDs and names already visible in the admin page; it does not include DingTalk secrets, robot webhooks, app secrets, JWTs, passwords, or full token values.
- Copy failure is surfaced through the existing status banner and does not change any draft field.

Added department filtering:

- After the organization mirror is loaded, administrators can filter visible department rows by department name, full path, external department ID, or parent department ID.
- Filtering is purely client-side and does not trigger another DingTalk or backend request.
- The summary chips show total departments, matched departments while a filter is active, configured unique department IDs, and reference issue counts.
- The summary chips show total unbound directory members when the loaded mirror has departments whose member count is greater than linked local-user count.
- Each department row shows its own `未绑定` gap when member count is greater than linked local-user count.
- An empty-state message explains the active search term when no department matches.
- The "清空部门筛选" action clears text filtering and returns scope-view filtering to `全部部门`.
- Clearing the filter restores the full loaded tree and hides visible-row bulk actions until the view is narrowed again.

Added scope-view filters:

- `全部部门` keeps the full loaded mirror visible.
- `只看未全绑定` narrows the tree to departments whose synced member count is greater than linked local-user count.
- `只看停用部门` narrows the tree to synced departments marked inactive in the local mirror.
- `只看非最新批次` narrows the tree to synced departments whose `lastSeenAt` is older than the latest loaded mirror batch.
- `只看已配置` narrows the tree to synced departments referenced by admission, exclusion, or member-group sync drafts.
- `只看准入` narrows the tree to synced departments referenced by the admission whitelist draft.
- `只看排除` narrows the tree to synced departments referenced by the admission exclusion draft.
- `只看成员组同步` narrows the tree to synced departments referenced by the member-group sync draft.
- `只看异常` narrows the tree to synced departments that have reference issues, such as inactive referenced departments.
- Missing department IDs cannot appear as rows because they are not present in the mirror; they remain visible in the reference-check panel.
- Scope filtering composes with text filtering and remains client-side only.

Added binding-gap report copy:

- The department filter row shows "复制未绑定部门报告" when the loaded mirror contains at least one department where member count is greater than linked local-user count.
- The copied report includes integration name, total unlinked member count, department gap count, each department ID, path/name, active status, member count, linked count, and unlinked gap count.
- The report is intended for operations handoff before running manual binding or no-email admission workflows.
- The report contains only IDs/counts/names already visible in the admin page; it does not include DingTalk secrets, robot webhooks, app secrets, JWTs, passwords, or full token values.
- Copy failure is surfaced through the existing status banner and does not change any draft field.

Added inactive-department report copy:

- The department filter row shows "复制停用部门报告" when the loaded mirror contains at least one inactive department.
- The copied report includes integration name, inactive department count, each department ID, path/name, member count, linked count, and unlinked gap count.
- The report is intended for operations handoff before cleaning stale scope references or checking DingTalk-side department lifecycle.
- The report contains only IDs/counts/names already visible in the admin page; it does not include DingTalk secrets, robot webhooks, app secrets, JWTs, passwords, or full token values.
- Copy failure is surfaced through the existing status banner and does not change any draft field.

Added mirror sync-observation report copy:

- The organization mirror section shows "组织镜像同步观测" after departments are loaded.
- The card shows latest department mirror batch time, departments in the latest batch, departments not seen in that latest batch, latest row update time, and the selected integration's last successful sync time.
- The card turns warning-styled when departments are inactive or not seen in the latest local mirror batch.
- "复制同步观测报告" copies integration name, latest mirror batch, latest mirror update, integration last successful sync, total mirror department count, current batch count, stale batch count, inactive department count, unlinked member count, and a list of departments not seen in the latest batch.
- The `只看非最新批次` scope filter reuses the same freshness calculation so administrators can locate stale-batch departments without leaving the page or parsing the copied report manually.
- Department rows not seen in the latest batch show a `非最新批次` chip.
- The observation card conditionally shows `查看非最新批次`, `查看停用部门`, and `查看未绑定部门` quick actions when those issue counts are present.
- Quick focus actions clear any text search and switch to the matching scope-view filter so old search terms do not hide the issue rows.
- The report is intended for scheduled-sync and organization-drift review before administrators clean references or chase DingTalk-side changes.
- The report contains only IDs/counts/names/timestamps already visible or derived from the loaded admin page; it does not include DingTalk secrets, robot webhooks, app secrets, JWTs, passwords, or full token values.
- Copy failure is surfaced through the existing status banner and does not change any draft field.

Added visible-row bulk actions:

- When a text filter or scope-view filter narrows the department list, the page shows the current visible department count.
- The page also shows a read-only newline-separated preview of the exact currently visible department IDs.
- Administrators can copy the currently visible department ID list to the clipboard for external review or reuse.
- Administrators can copy a current visible department report that includes integration name, active scope filter, search query, visible count, latest mirror batch, each visible department ID/name, active state, latest-batch state, member count, linked count, and unlinked gap count.
- Administrators can bulk-add those currently visible department IDs into admission whitelist, admission exclusions, or member-group sync scope.
- Administrators can also bulk-remove those currently visible department IDs from the same draft scopes.
- The bulk actions use the same normalized parser and duplicate prevention as the single-row quick actions.
- The actions and ID preview are intentionally hidden for the default unfiltered `全部部门` view to avoid accidentally editing the whole organization.
- The actions remain draft-only; persistence still requires the existing "保存变更" button.
- The visible department report is intended for handoff after narrowing to stale-batch, inactive, unlinked, configured, or field-specific department rows, so reviewers do not need to parse raw ID-only lists.
- The visible department report contains only IDs/counts/names/timestamps already visible or derived from the loaded admin page; it does not include DingTalk secrets, robot webhooks, app secrets, JWTs, passwords, or full token values.

Added department scope draft-change review:

- The organization mirror section shows "部门范围草稿变更" when the current draft differs from the selected integration's saved scoped department configuration.
- The summary compares admission whitelist, admission exclusion, and member-group sync department IDs independently.
- The card shows added and removed department counts, plus field-specific added/removed ID lists.
- "复制草稿变更报告" copies integration name, changed field count, total added/removed department references, and the field-specific added/removed department IDs with mirror status when the local mirror is loaded.
- This is intended as a save-before-review checkpoint after quick actions, visible-row bulk actions, manual department ID entry, or stale-reference cleanup.
- "还原已保存范围" resets admission whitelist, admission exclusion, and member-group sync department drafts back to the selected integration's saved configuration.
- Each changed field row also exposes "还原此范围", which restores only that field to its saved configuration.
- Restore actions clear the matching pending scoped department draft changes locally and give a status message, but they do not call the backend or persist anything.
- The report contains only IDs/counts/names/status already visible or derived from the loaded admin page and saved/draft config; it does not include DingTalk secrets, robot webhooks, app secrets, JWTs, passwords, or full token values.
- Copy failure is surfaced through the existing status banner and does not change any draft field.

Added department ID copy actions:

- Each department row has a "复制部门 ID" action.
- The visible-row preview has a "复制当前可见部门 ID" action.
- Copy uses the browser clipboard API when available.
- If automatic copy is unavailable or blocked by the browser, the page shows an explicit error and keeps the read-only preview available for manual copy.
- Copy actions do not mutate drafts, do not call DingTalk, and do not persist configuration.

Added manual department ID helper:

- Administrators can enter a known department ID and optional display name.
- The helper can add that ID into admission whitelist, admission exclusions, or member-group sync scope.
- It uses the same normalized parser and duplicate prevention as mirrored department quick actions.
- It does not create a local organization record and does not call DingTalk.
- If the organization mirror is already loaded and the manual ID is absent, the existing reference-check panel immediately flags it as `未同步`.
- This covers the practical "known DingTalk department ID, mirror not updated yet" workflow without expanding schema scope.

## Safety Notes

- No DingTalk `appSecret`, robot webhook, `SEC`, JWT, bearer credential, password, or full webhook URL is added.
- This slice is read-only for organization structure.
- Quick actions only copy department IDs into editable draft fields and do not persist until the administrator explicitly saves.
- Reference checks, single cleanup, and bulk cleanup are client-side diagnostics over already-loaded mirror data; they do not call DingTalk and do not persist until the administrator explicitly saves.
- Configuration-reference report copy is client-side diagnostics over already-loaded mirror data and current draft fields; it does not call DingTalk and does not mutate drafts.
- Stale-reference report copy is client-side diagnostics over already-loaded mirror data; it does not call DingTalk and does not mutate drafts.
- Department filtering only changes the visible list in the browser and does not mutate the loaded mirror or configuration drafts.
- Scope-view filtering only changes the visible list and does not mutate the loaded mirror or configuration drafts.
- Binding-gap report copy is client-side diagnostics over already-loaded mirror data; it does not call DingTalk and does not mutate drafts.
- Inactive-department report copy is client-side diagnostics over already-loaded mirror data; it does not call DingTalk and does not mutate drafts.
- Mirror sync-observation report copy is client-side diagnostics over already-loaded mirror data; it does not call DingTalk and does not mutate drafts.
- Clipboard copy actions only copy IDs already visible in the UI and do not mutate loaded mirror data or configuration drafts.
- Visible department report copy is client-side diagnostics over currently visible mirror rows; it does not call DingTalk and does not mutate drafts.
- Draft scope change report copy compares selected saved config with current draft fields in the browser; it does not call DingTalk, does not persist, and does not mutate drafts.
- Draft scope restore only resets local draft fields to the selected saved integration config; per-field restore narrows this to one scoped department field. Neither path calls DingTalk or persists until the administrator explicitly saves again later.
- Visible-row bulk actions only append or remove visible IDs from draft configuration fields and never auto-save.
- Manual department ID entry only updates draft configuration fields; it is intentionally shown as `未同步` if the ID is not present in the loaded mirror.
- Existing automatic sync and manual member binding behavior are unchanged.
- Existing route/page behavior remains stable because organization loading is user-triggered and not added to the initial page load.

## Remaining Product Work

- Add a persistent named local-organization overlay if administrators need first-class manual-only departments that do not exist in DingTalk.
- Reuse the same department-picker pattern for forms, automations, and permission scope selectors.
- Extend scheduled sync observability into backend alerts if the mirror freshness thresholds need persistent audit records instead of client-side diagnostics.
