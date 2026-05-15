# Data Factory issue #1542 P1 UX collation - verification - 2026-05-15

## Scope

Verifies the rendering changes in `apps/web/src/views/IntegrationWorkbenchView.vue` that collate issue #1542's P1 UX gap:

1. `metasheet:staging` source - actionable CTA in source-empty and clearer staging-empty pointing back to the install controls.
2. SQL Server source option - disabled when backend has no `queryExecutor`, with the required `高级 SQL 通道未启用 / 需要部署侧注入 queryExecutor` hint.

No backend / migration / route changes; no `plugins/plugin-integration-core` touch.

## Local test commands and results

### 1. IntegrationWorkbenchView focused suite (2 added, 3 existing preserved)

```text
cd apps/web
pnpm vitest run tests/IntegrationWorkbenchView.spec.ts
```

```text
 RUN  v1.6.1 /Users/chouhua/Downloads/Github/metasheet2/apps/web
 ✓ tests/IntegrationWorkbenchView.spec.ts  (5 tests) 207ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

The 5 cases:

- existing - loads systems, object schemas, and previews a template payload
- existing - shows actionable source-empty and dry-run readiness guidance
- existing - does not mark error-state source or target systems as dry-run ready
- new - marks SQL Server source option as disabled when queryExecutor is missing
- new - surfaces staging-creation CTA in source-empty and staging-empty when no readable source exists

### 2. Sibling workbench client + view suites

```text
pnpm vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts
```

```text
 ✓ tests/integrationWorkbench.spec.ts  (2 tests) 5ms
 ✓ tests/IntegrationWorkbenchView.spec.ts  (5 tests) 188ms

 Test Files  2 passed (2)
      Tests  7 passed (7)
```

## Manual sanity check (jsdom level)

The new test `marks SQL Server source option as disabled when queryExecutor is missing` asserts:

- after toggling `show-advanced-connectors`, the SQL option exists in the dropdown,
- the option has `disabled === true`,
- the option carries `data-disabled="true"`,
- the disabled SQL source is not auto-selected as the default source,
- the source-empty CTA remains visible because there is still no runnable source,
- the page contains the exact phrase `高级 SQL 通道未启用 / 需要部署侧注入 queryExecutor`.

The new test `surfaces staging-creation CTA ...` asserts:

- `show-staging-setup` button exists in `source-empty-state`,
- `staging-empty` block contains the `填写下方 Project ID 后点击「创建清洗表」` text,
- a `staging-empty-focus-install` button exists in the staging-empty block,
- clicking `show-staging-setup` expands `inventory-overview` and surfaces the staging guidance status text.

The existing end-to-end Workbench view smoke was updated to assert that clicking `创建清洗表` now:

- creates the staging tables,
- auto-upserts the `metasheet:staging` external system,
- selects `metasheet_staging_project_1` as the source system,
- selects `standard_materials` as the source object,
- leaves the explicit per-card `作为 Dry-run 来源` button enabled as a fallback.

## Pre-existing assertions preserved

The existing IntegrationWorkbenchView smoke test asserts that the SQL option text reads `K3 SQL Read Channel · erp:k3-wise-sqlserver`. The added `:disabled` attribute does not change the option's textContent, so this assertion continues to pass without modification.

The existing readiness-guidance test asserts `SQL source 需要部署 allowlist queryExecutor 后才能读取` from `showSqlSetup`'s status text - left untouched.

The existing source-empty test (`shows actionable source-empty and dry-run readiness guidance when no readable source exists`) renders the same DOM as the new staging-creation case. After this PR the same DOM additionally contains:

- the `show-staging-setup` button in the source-empty block,
- the `staging-empty-focus-install` button inside the upgraded staging-empty block,
- the new `sql-channel-disabled-hint` text (only when a SQL system is present; the existing test does not load one, so the hint does not render in that case).

None of the existing assertions in that test use `not.toContain` against these strings, and the additions do not collide with the existing `toContain` matches. Confirmed by the 3-of-3 pre-existing pass plus 2 new passes (5/5 total).

## Type-check / lint

`apps/web` continues to consume the unmodified `WorkbenchExternalSystem` and `IntegrationAdapterMetadata` types. The new helpers (`isSourceOptionDisabled`, `showStagingSetup`, `focusStagingInstall`) and the new computed (`sqlChannelDisabledHint`) reuse existing types only.

CI gates (lint, typecheck, contracts, K3 WISE offline PoC, test-18/20, coverage, after-sales integration, DingTalk P4 ops regression) will rerun under the standard `pr-validate` chain on push.

## Deployment impact

- No new environment variables.
- No new database migrations.
- No new feature flags.
- No new external endpoints touched.
- Frontend bundle adjusts by ~30 lines of template + ~25 lines of `<script setup>`; build is unaffected functionally.

## GATE-blocking status

This PR does not lift the customer GATE lock and does not unblock live PoC execution. It is a Stage 1 internal UX polish to make the onboarding chain clearer on already-deployed environments (including 142). The K3 live preflight remains blocked on the customer GATE.

## Risk and rollback

Low risk. Rendering-only change behind existing v-model bindings. Rollback = revert this PR; no data migration to reverse.

## Stage 1 Lock conformance

- No new战线: this is the existing Workbench page only.
- No `plugins/plugin-integration-core` touch.
- No real SQL executor.
- No K3 feature expansion.
- No new migration.
- `/integrations/workbench` route unchanged.
