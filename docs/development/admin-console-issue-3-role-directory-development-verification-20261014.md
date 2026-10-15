# Admin issue 3 — role directory development verification

Implementation-side status at initial handoff: **NOT RUN** (superseded by the parent qualification section below). This slice did not install dependencies, build, run Vitest, call APIs, open a browser, use SSH, read customer data, or commit, push, or publish. Parent owns native tests, the API/browser pass, OpenAPI generation, the required web chain, and Sol review.

## Source

- Design lock: `docs/development/admin-console-issue-3-role-directory-design-lock-20261014.md`
- Authority reused as-is: `ensurePlatformAdmin` in `packages/core-backend/src/routes/admin-users.ts` (`authenticate` plus legacy platform claim or live `admin` role). Not widened to `roles:read` or a `permissions` wildcard.
- Pagination: `parsePagination` defaults used by admin user lists, bounded here to page size 20 and max 100.
- Member rows: `user_roles` plus local `users.name`, with the user id when the name is blank. No `is_active` / organization filter and no extra profile columns.
- Role titles: `migrations/054_create_users_table.sql`, `zzzz20260208100000_create_roles_table.ts` (English seed and name=id backfill), `zzzz20260826140000_add_elearning_role_templates.ts`, `zzzz20261010124500_seed_stock_prep_role_templates.ts`, and the 2026-10-12 frontline name `操作人员`. Stored `一线填写` is left as stored.
- Fresh migration catalog, synthetic only, curated into the committed fixture `apps/web/tests/fixtures/builtinCatalogSeedDefaults.json` (`synthetic_only`, 12 roles, 41 permissions). The spec imports that JSON. It does not read the private artifact or `import.meta.url`.
- Historical aliases kept even though that fresh catalog does not insert them: role `user`; permissions `*:*`, `admin:users`, `admin:roles`, `admin:permissions`, `permissions:read`, `permissions:write`, `roles:read`, `roles:write`, `spreadsheet:delete`, `spreadsheet:share`; name=id backfill; `一线填写`; seed-rbac description alternates; the 054 Chinese descriptions; the earlier `approvals:admin` and `stock-prep:admin` sentences.
- Other permission title sources already read: `migrations/054_create_users_table.sql`, `scripts/seed-rbac.ts`, `20250924190000_create_rbac_tables.ts`, and the first-party permission INSERT migrations. Dynamic plugin-provisioned names are not translated.

## Changed files

- `apps/web/src/views/RoleManagementView.vue`
- `apps/web/src/views/RoleMembersPanel.vue`
- `apps/web/src/views/roleMembers.ts`
- `apps/web/src/views/builtinCatalogPresentation.ts`
- `apps/web/tests/roleMembers.spec.ts`
- `apps/web/tests/builtinCatalogPresentation.spec.ts`
- `apps/web/tests/fixtures/builtinCatalogSeedDefaults.json` (committed seed fixture, not runtime output)
- `apps/web/tests/roleManagementSave.spec.ts` (empty member-read mock only)
- `packages/core-backend/src/routes/admin-role-members.ts`
- `packages/core-backend/src/index.ts` (import and mount only)
- `packages/core-backend/tests/unit/admin-role-members-routes.test.ts`
- `packages/openapi/src/paths/roles.yml` (new path and inline schema only)
- this note

`adminPageContentSearch.spec.ts` did not need a change. Required-web script, domain guards, workflows, tokens, `UserManagementView`, and password helpers were not edited.

## Behavior

- `GET /api/admin/roles/:roleId/members` is one parameterized read. Missing role is 404. Storage or guard failure is 503 and does not report a healthy total of 0. An empty role and an out-of-range page both return the snapshot total.
- The panel drops stale replies for role switches A→B→A and for page switches. A failed refresh shows 成员名单暂时不可用, not 暂无成员.
- Builtin English defaults display in Chinese. Ids, custom labels, unknown codes, and prototype-like ids stay as stored. A permissions-only save sends the loaded raw name; typing in the name field still saves that edit.

## Parent commands

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-role-members-routes.test.ts
pnpm --filter @metasheet/web exec vitest run --watch=false tests/roleMembers.spec.ts tests/builtinCatalogPresentation.spec.ts tests/roleManagementSave.spec.ts tests/adminPageContentSearch.spec.ts
pnpm --filter @metasheet/openapi build
```

Parent also wires `builtinCatalogPresentation` and `roleMembers` into the sorted required web chain, then runs the native API, browser, quality, and Sol checks. OpenAPI dist and SDK were not regenerated here.

## Risks

- The new route imports `admin-users.ts` so the platform-admin check cannot drift. That module is large; the route does not call its writers.
- Chinese text is a display whitelist of the fresh catalog plus the historical aliases above. A later permission seed stays in its stored language until this whitelist is extended.
- The presentation spec imports the committed fixture. The private catalog path is not a test dependency. This fixture edit was not re-run.
- `stock-prep_frontline` still stored as `一线填写` keeps that name on screen. Only the id-as-name alias and `操作人员` show the current title.
- New web specs are not in `apps/web/scripts/run-required-web-tests.sh` until the parent adds those tokens.


## Parent qualification (2026-10-14)

Production source `ae84ffe37f5e68475e0d3d9652766b5c501c936d`; portable fixture and generated-contract correction `0a00422c2bfff48b7fcdeae3c54713b31e3dae9b`. All execution below uses the dedicated Mac mini synthetic environment; it is not staging or customer acceptance.

- Five backend files: **246 passed**. Five frontend files at corrected source: **25 passed**, no skipped tests. `pnpm validate:all` passed. New frontend specs are registered in both the approval domain guard and the sorted required-web chain.
- Actual fully migrated/authenticated API: platform administrators can read member names across synthetic organizations; ordinary users from both organizations receive 403. A user whose legacy `roles:read` successfully reads the old catalog still receives 403 from the new member route. Pagination, missing role, healthy empty role and out-of-range page were verified.
- Actual product router/browser/backend: 21 persisted inactive members are displayed across pages 20+1 without loss; Chinese builtin role/permission text, custom-name preservation, raw-name persistence on permissions-only save, and unavailable-versus-empty states passed.
- Fresh first-party catalog coverage: 12 roles and 41 permissions covered. Presence checks alone do not establish translation accuracy; Sol separately reviewed the whitelist and semantics.
- `pnpm openapi:build` and `pnpm openapi:guard` passed on the production source. Four generated SDK/contract files were committed in the correction. Independent Sol review passed after the private-fixture dependency was replaced with a tracked synthetic fixture.
- All 445 synthetic tables restored to baseline by actual count/content hashes; four users, zero sessions. Owned backend and web processes stopped. The test database is retained only for remaining goal qualification, then stopped.

The first frontend collection failed because a private file was imported through a jsdom URL. The correction was verified by the successful 25-test rerun. Mac mini system-temp space was exhausted during an intermediate rerun; only this task's temporary directory was relocated to its data-volume workspace. Neither failed run is counted as acceptance.

Final mutation and combined-source qualification are recorded in the goal closeout after completion; the initial A→B→A test did not detect a disabled generation guard because its loading UI masked stale data. That intermediate green mutant is a test gap, not PASS evidence.

Evidence stays local under `artifacts/admin-issues-20261014/`: source-attributed native receipts, `role-browser-ae84ffe37f.json`, `sol-role-directory-independent-review.md`, and the synthetic browser screenshot. No public push, PR, merge, deployment, real CI-variable change or customer data access occurred.


### Final test qualification

Frozen `e83aad19665ae16a8f29d202d215aaa30f13f4f2`: five role frontend files **25 passed**, `validate:all` passed. Four isolated mutations (platform-admin guard, late-success generation guard, late-error generation guard, raw-name preservation) each failed the matching assertion; original bytes restored after every mutation. Sol independently accepted the strengthened newest-first tests at the same SHA. The earlier hidden-stale test gap is closed. Combined source at `0a00422c2b` also passed 331 backend and 163 frontend tests; production files are byte-identical at e83, whose only changes are the strengthened role spec and this qualification document.

Latest main `2fc0527bd6b1fe712b5f0c403f057e3c026a292e` differs from the original base only in two unrelated stock-prep documents. Local concern-branch projection retains its changes and verifies qualified source blobs. This is local qualification; remote PR CI and public review have not been performed.
