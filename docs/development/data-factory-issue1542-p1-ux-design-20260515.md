# Data Factory issue #1542 P1 UX collation - design notes - 2026-05-15

## Purpose

Issue #1542 reports that the Integration Workbench (Data Factory) onboarding flow is unclear when a deployed environment has no readable source system yet. This slice tightens two specific UX gaps surfaced during the K3 PoC validation chain. It does not add new business features, does not touch `plugins/plugin-integration-core`, and does not implement a real SQL executor.

The two gaps:

1. The `metasheet:staging` source can be created from staging descriptors in the Workbench, but the source-empty state does not advertise that path, so a new operator sees an empty source dropdown and only the K3 preset / SQL setup buttons.
2. A `erp:k3-wise-sqlserver` system whose backend has no `queryExecutor` is still selectable in the source dropdown. The runtime-blocker hint only renders after the user has already selected the SQL system, so the dropdown does not convey that the option is non-runnable up front.

This PR is frontend-only, route-compatible with `/integrations/workbench`, and adds only rendering / option-disable signals.

## Scope

In scope:

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- This design MD and a companion verification MD.

Out of scope (deliberate, per Stage 1 Lock):

- No new migrations.
- No new API endpoints.
- No real SQL `queryExecutor` implementation.
- No new K3 feature surface.
- No change to `plugins/plugin-integration-core`.
- No change to `/integrations/workbench` route registration or its API contract.

## Change 1 - Source dropdown disables SQL options without queryExecutor

`runtimeBlockerForSystem(system)` already detects two non-runnable cases for `erp:k3-wise-sqlserver`:

- `lastError` matches `queryExecutor|executor|injected|注入|执行器`.
- `status === 'error'` with no error message (operator must wire allowlist `queryExecutor`).

The source dropdown previously rendered every entry in `sourceSystems` as a freely selectable `<option>`. We now bind:

```html
<option
  :disabled="isSourceOptionDisabled(system)"
  :data-disabled="isSourceOptionDisabled(system) ? 'true' : 'false'"
  :data-testid="`source-system-option-${system.id}`"
>
  {{ system.name }} · {{ system.kind }}
</option>
```

`isSourceOptionDisabled(system)` returns `runtimeBlockerForSystem(system) !== ''`.

Behavior:

- Existing saved pipelines that reference a SQL source ID keep their value. `v-model` still binds the value when the option is the current `sourceSystemId`; the user simply cannot reselect the option after switching away. The runtime-blocker hint continues to show the reason.
- Fresh bootstrap does not auto-select a runtime-blocked SQL source. `normalizeSystemSelections()` now only uses runnable source systems for default selection, while preserving an already-bound source ID if it still exists in the system list.
- Non-SQL source systems are unaffected (`runtimeBlockerForSystem` only returns text for the two SQL cases above).
- `metasheet:staging` sources are never disabled (no runtime-blocker branch covers them).

A new computed `sqlChannelDisabledHint` renders the exact phrasing required by the issue intake:

```text
高级 SQL 通道未启用 / 需要部署侧注入 queryExecutor。已有 SQL 连接配置会保留但暂不能作为 Dry-run 来源。
```

It surfaces whenever the loaded `systems` list contains at least one `erp:k3-wise-sqlserver` system that `runtimeBlockerForSystem` flags. The hint is below `source-runtime-blocker` so a selected disabled SQL system shows both the selection-level runtime blocker and the dropdown-level hint.

The hint is intentionally NOT gated on `showAdvancedConnectors`. A non-admin who has not expanded the advanced connector toggle still sees the message if a SQL channel exists in the tenant. Rationale: the message signals an operator-level deployment gap (the backend needs a `queryExecutor`), which a non-admin cannot act on but should still see attributed to "this is a backend gap, not a user error". The text is a single sentence with no admin actions, so it does not pollute the non-admin surface.

## Assumed prerequisites

The `创建 staging 多维表作为来源` CTA assumes the `metasheet:staging` adapter is registered in the deployment. The on-prem package and the K3 PoC track register it; deployments without that adapter will see the CTA scroll to the install controls, but the install call will return an empty result (no staging contracts loaded). This is acceptable because the issue intake explicitly scopes the gap to Data Factory deployments. We deliberately do not gate the CTA on adapter availability to keep the PR small and the test surface unchanged.

## Change 2 - Staging-creation CTA in source-empty and staging-empty states

The current source-empty state at the top of the source column exposes:

- `使用 K3 WISE 预设` (preset router link)
- `启用 SQL 只读通道` (calls `showSqlSetup`)

It did not point to the `metasheet:staging` path even though the staging contract panel is on the same page. The empty state now renders whenever there are no runnable source systems, including the common "only SQL source exists but it is blocked by missing queryExecutor" deployment state. We add a third button as a pure addition:

```html
<button data-testid="show-staging-setup" @click="showStagingSetup">
  创建 staging 多维表作为来源
</button>
```

`showStagingSetup`:

- expands the inventory overview so the staging adapter row is visible,
- sets a status message walking the operator through Project ID + 创建清洗表,
- delegates to `focusStagingInstall()` which focuses the Project ID input and scrolls the install button into view.

Both DOM-level focus and `scrollIntoView` calls are wrapped in `try/catch` so jsdom (no `scrollIntoView`) does not throw.

After `创建清洗表` succeeds, the Workbench now auto-provisions the `metasheet:staging` external system and selects a default staging source object. The default order is:

1. the currently selected staging sheet,
2. `standard_materials`,
3. the first install target returned by the backend.

This closes the "installed staging tables but still no readable source selected" gap without adding a backend API. The per-card `作为 Dry-run 来源` button remains as an explicit manual fallback.

The staging-empty block at the staging dataset section is upgraded from a single-line empty to an actionable block:

```html
<div class="integration-workbench__empty integration-workbench__empty--actionable" data-testid="staging-empty">
  <strong>暂未加载 staging 契约。</strong>
  <p>填写下方 Project ID 后点击「创建清洗表」即可生成 staging 多维表；创建完成后可在 staging 卡片上「作为 Dry-run 来源」。</p>
  <div class="integration-workbench__actions">
    <button data-testid="staging-empty-focus-install" @click="focusStagingInstall">填写 Project ID 创建清洗表</button>
  </div>
</div>
```

The button is a focus shortcut to the install controls that already sit right below. No new API call.

## Compatibility

- `/integrations/workbench` route: unchanged.
- `WorkbenchExternalSystem` and `IntegrationAdapterMetadata` types: unchanged.
- Existing snapshot of `option.textContent` in `IntegrationWorkbenchView.spec.ts` (`'K3 SQL Read Channel · erp:k3-wise-sqlserver'`) is preserved - we deliberately did not add a `· 未启用` suffix on the option text. The disabled state is conveyed by the `disabled` attribute, the new `sql-channel-disabled-hint`, and the existing inventory-overview runtime-blocker `<small>`.
- Existing test for selecting a SQL system to verify the runtime-blocker text still passes; jsdom permits programmatic value assignment on disabled options.

## Stage 1 Lock conformance

- No new战线 (frontend UX collation of an existing surface).
- No `plugins/plugin-integration-core` touch.
- No new migration, no real SQL executor, no K3 feature expansion.
- No new env, no new contract.

## Related PRs and issues

- Issue: #1542 (Integration Workbench needs a clear new-connection flow)
- P0 sibling: PR #1561 (`fix(integration): unblock Data Factory pipeline save`) - still open as of 2026-05-15; touches the same view's `savePipeline` path but does not overlap with the rendering paths modified here.
