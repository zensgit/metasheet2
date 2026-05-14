# DingTalk Directory Org Tree Verification - 2026-05-13

## Result

Status: `PASS - merged and deployed`

The DingTalk organization tree slice was implemented and validated with targeted backend route tests, frontend view tests, backend build, web build, and whitespace checks. Follow-up quick-action, reference-check, inline-cleanup, bulk-cleanup, filtering, clear-filter, clipboard-copy, visible-department report copy, draft-scope-change report copy, configuration-reference report copy, stale-reference report copy, binding-gap filtering/reporting, inactive-department filtering/reporting, mirror sync-observation reporting, scope-view filtering, visible-row bulk add/remove action, saved-scope restore, and manual department-ID slices were added so administrators can copy department IDs from the tree into scoped DingTalk configuration drafts, copy IDs and visible/draft-change/configuration/issue/binding-gap/inactive-department/mirror-observation reports to external review material, detect stale references, remove stale IDs, find target departments, reset narrowed views, focus on configured/problematic/inactive/not-fully-bound/not-latest-batch rows, bulk-add or bulk-remove narrowed rows, review or revert pending scope changes before save, and handle known departments before the local mirror catches up.

Post-merge update: PR `#1524` was merged to `main` at `94c4694599f91819539a4ee2f4dd1fc07fbf87fa` and published through the GHCR deployment workflow. A later `main` commit (`e8eb9b212`) was already present when this verification note was updated; the DingTalk directory slice remains included in that `main` head.

## Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts
git diff --check -- packages/core-backend/src/directory/directory-sync.ts packages/core-backend/src/routes/admin-directory.ts packages/core-backend/tests/unit/admin-directory-routes.test.ts apps/web/src/views/DirectoryManagementView.vue apps/web/tests/directoryManagementView.spec.ts docs/development/dingtalk-directory-org-tree-development-20260513.md docs/development/dingtalk-directory-org-tree-verification-20260513.md
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
gh pr view 1524 --json state,mergedAt,mergeCommit,url
gh run view 25839874962 --json status,conclusion,headSha,workflowName,url,createdAt,updatedAt
gh run download 25839874962 -n deploy-logs-25839874962-1 -D /tmp/ms2-deploy-25839874962
```

## Test Evidence

- Backend route test: `packages/core-backend/tests/unit/admin-directory-routes.test.ts`
  - Result: `1 passed`
  - Tests: `27 passed`
  - New coverage: `GET /integrations/:integrationId/departments`

- Frontend directory page test: `apps/web/tests/directoryManagementView.spec.ts`
  - Result: `1 passed`
  - Tests: `41 passed`
  - New coverage: clicking "加载组织架构" calls `/api/admin/directory/integrations/dir-1/departments` and renders parent/child department rows plus aggregate member/binding counts.
  - New coverage: department quick actions append department ID `1` into admission whitelist, admission exclusion, and member-group sync draft fields.
  - New coverage: duplicate clicks do not duplicate the department ID and show a status message.
  - New coverage: configured department IDs are checked against the loaded mirror, including missing department IDs and inactive referenced departments.
  - New coverage: stale missing/inactive department references can be removed from the matching draft field and the panel returns to the healthy state.
  - New coverage: bulk cleanup removes all stale references while preserving valid active department IDs.
  - New coverage: full configuration reference reports can be copied through the clipboard helper and include configured unique count plus active/missing/inactive mirror diagnostics.
  - New coverage: stale reference reports can be copied through the clipboard helper and include issue count plus missing/inactive department diagnostics.
  - New coverage: not-fully-bound departments show `未绑定` counts, can be isolated with the `只看未全绑定` scope filter, and can be copied as a binding-gap report.
  - New coverage: inactive departments can be isolated with the `只看停用部门` scope filter and copied as an inactive-department report.
  - New coverage: mirror sync-observation shows latest batch counts, flags departments not seen in the latest batch, and copies a mirror-observation report through the clipboard helper.
  - New coverage: departments not seen in the latest mirror batch can be isolated with `只看非最新批次` and show a `非最新批次` row chip.
  - New coverage: mirror-observation quick focus actions can jump directly to stale-batch department rows, and inactive/unlinked quick focus actions are rendered when those issue counts exist.
  - New coverage: the currently visible department rows can be copied as a diagnostic report after scope filtering, including filter label, visible count, department status, batch status, and binding counts.
  - New coverage: draft scoped department changes are summarized against the selected integration's saved config and can be copied as a draft-change report with field-specific added department diagnostics.
  - New coverage: scoped department draft changes can be restored back to the selected integration's saved config without saving, both for one changed field and for all scoped fields, and the draft-change card disappears after restore.
  - New coverage: department filtering matches by department ID, shows matched counts, shows an empty state for no matches, and the clear-filter action restores all rows plus the default scope view.
  - New coverage: filtered visible department IDs can be copied through the clipboard helper, and a single department row can copy its own department ID.
  - New coverage: a manually entered department ID can be added into the admission draft, duplicate manual entries are blocked, and the loaded mirror flags the manual ID as `未同步`.
  - New coverage: scope-view filters can show only configured departments, show field-specific admission exclusion and member-group sync department rows, show an empty state when only missing issues exist, and show synced inactive departments when filtering to visible issues.
  - New coverage: filtered visible department IDs are shown in the read-only preview, filtered visible departments can be bulk-added into member-group sync draft fields, duplicate bulk adds are ignored, visible departments can be bulk-removed from the same draft field, duplicate bulk removes are ignored, and configured-row counts update accordingly.

- Backend build:
  - Command: `pnpm --filter @metasheet/core-backend build`
  - Result: `PASS`

- Web build:
  - Command: `pnpm --filter @metasheet/web build`
  - Result: `PASS`
  - Note: Vite emitted existing chunk-size/dynamic-import warnings; build completed successfully.

- Whitespace check:
  - Command: `git diff --check -- ...`
  - Result: `PASS`

## Verification Warnings

- The wider worktree still contains unrelated attendance/K3 changes. This verification only scopes the DingTalk directory files listed in the command block.
- The frontend targeted Vitest run emitted a local test WebSocket port-in-use warning, but the suite completed successfully with `41 passed`; this did not affect the directory page assertions.
- After deployment, the current Codex local environment could open a TCP connection to `142.171.239.56:8081` but received `Empty reply from server` for direct public HTTP GETs to `/` and `/api/health`. SSH-based deploy evidence and server-side smoke passed, so this was treated as a local/public-network verification boundary rather than a product regression. If page-level confirmation is needed from this workstation, use an SSH tunnel or run curl from the 142 host.
- `Attendance Locale zh Smoke (Prod)` failed on the same deployed commit because its `AUTH_TOKEN` was invalid and `LOGIN_EMAIL` / `LOGIN_PASSWORD` were not configured. That failure is outside this DingTalk directory slice and did not block the Build/Deploy/Plugin/DingTalk gates.

## First Command Correction

An initial targeted Vitest command used `--runInBand`, which this Vitest version does not support. That failed at CLI argument parsing before tests ran. The command was corrected to the supported `vitest run <test-file>` form, and both targeted suites passed.

## Secret Scan

- Command: strict value-pattern scan across `docs/development/dingtalk-directory-org-tree-*.md`.
- Result: `PASS`
- Scanner exit: `1`
- Interpretation: `rg` found 0 matching sensitive values.
- Coverage: DingTalk robot tokens, DingTalk `SEC` values, JWTs, bearer credentials, full DingTalk webhook URLs, and Slack webhook URLs.

## Deployment Status

Deployed through the existing GHCR/main pipeline.

- PR: `#1524`
- Merge commit: `94c4694599f91819539a4ee2f4dd1fc07fbf87fa`
- Merge time: `2026-05-14T03:27:05Z`
- Build + deploy run: `25839874962`
- Workflow result: `success`
- Deployed backend image: `ghcr.io/zensgit/metasheet2-backend:94c4694599f91819539a4ee2f4dd1fc07fbf87fa`
- Deployed web image: `ghcr.io/zensgit/metasheet2-web:94c4694599f91819539a4ee2f4dd1fc07fbf87fa`
- Remote preflight: `PASS`
- Remote deploy stage: `PASS`
- Remote migrate stage: `PASS`
- Remote smoke stage: `PASS`
- Authenticated postdeploy smoke: `PASS`, `10 pass / 0 skipped / 0 fail`
- Remote smoke checks included: `api-health`, `integration-plugin-health`, `k3-wise-frontend-route`, `auth-me`, `integration-route-contract`, `integration-list-external-systems`, `integration-list-pipelines`, `integration-list-runs`, `integration-list-dead-letters`, and `staging-descriptor-contract`.

Main workflow status for merge commit `94c4694599f91819539a4ee2f4dd1fc07fbf87fa`:

- `Build and Push Docker Images`: `success`
- `Deploy to Production`: `success`
- `Plugin System Tests`: `success`
- `Phase 5 Production Flags Guard`: `success`
- `Observability E2E`: `success`
- `monitoring-alert`: `success`
- `Attendance Locale zh Smoke (Prod)`: `failure`, non-DingTalk-directory blocker caused by invalid smoke auth token configuration.

## Conclusion

The first organization-structure usability slice is ready for review:

- The system can expose synced DingTalk departments as a local organization mirror.
- Administrators can manually load and inspect the department tree from `/admin/directory`.
- Administrators can reuse a department row to populate scoped admission and member-group sync draft fields safely.
- Administrators can see stale or inactive department references after loading the organization mirror.
- Administrators can remove stale department IDs from the current draft without manually editing textarea contents.
- Administrators can bulk-clean all stale department references while preserving valid active references.
- Administrators can copy a full configuration-reference report for save-before-review or operations handoff without exposing sensitive DingTalk values.
- Administrators can copy a stale-reference report for review or operations handoff without exposing sensitive DingTalk values.
- Administrators can identify departments that still have directory members without linked local users.
- Administrators can copy a binding-gap report for manual binding/no-email admission follow-up without exposing sensitive DingTalk values.
- Administrators can isolate inactive departments from the synced local mirror before deciding whether to clean stale scope references.
- Administrators can copy an inactive-department report for operations handoff without exposing sensitive DingTalk values.
- Administrators can inspect and copy a mirror sync-observation report for organization-drift review without exposing sensitive DingTalk values.
- Administrators can isolate departments not seen in the latest local mirror batch before deciding whether they represent DingTalk-side lifecycle changes or local sync drift.
- Administrators can use observation-card quick actions to jump from summary warnings to the matching filtered rows without manually choosing a separate scope filter.
- Administrators can copy the currently visible department rows as a richer review report instead of handing off only raw department IDs.
- Administrators can review and copy pending scoped department draft changes before saving, reducing the risk of accidental admission/exclusion/member-group scope edits.
- Administrators can revert one scoped department field or all scoped department draft changes back to the saved integration config before saving, giving a low-friction recovery path after accidental bulk edits.
- Administrators can filter large DingTalk department mirrors before applying scope actions.
- Administrators can copy a single department ID or the currently visible filtered department ID list without mutating configuration drafts.
- Administrators can switch between all departments, configured department rows, field-specific configured rows, and visible issue rows before applying scope actions.
- Administrators can bulk-add or bulk-remove the currently visible filtered/scope-filtered department rows in draft scope fields without auto-saving.
- Administrators can enter a known department ID manually and rely on the reference checker to mark it as `未同步` until the next directory sync includes it.
- Existing user sync, binding, no-email admission, and work-notification settings are not changed by this slice.
