# Integration help center: terminology + SQL-source journey (design, 2026-09-10)

## Gap (G12 + G41)
`IntegrationHelpView.vue` (228 lines) only covered "read source vs composition" plus an
auto-generated error-code table and FAQ. It never mentioned the main journey — SQL table/view →
multi-dimensional table — and the surrounding UI calls the same concepts by several names
(connection/external data source/adapter; dataset/object/table-or-view; cleansing table/staging
table). Scope: only `IntegrationHelpView.vue` + its spec + this doc pair. No service calls, no
write path, no permission change (route meta stays `requiresAuth` only, deliberately not
`integration:write`, so a blocked user can still read this page).

## Structure added
1. **Terminology reference** (`help-section-glossary`), placed first. Table = unified name / where
   you'll see aliases / one-line meaning. Driven by an exported `INTEGRATION_HELP_GLOSSARY`
   constant (7 rows), single-source like the existing error-code table.
2. **Case one** (`help-section-case-sql-source`, 6 steps): SQL read-only source → multi-dim table.
   **Case two** (`help-section-case-k3-wise`, 4 steps): K3 WISE preset. Both use a 4-field step
   shape (where / what to click / success / common failure & where to look), values-free.
3. Existing when-to-use / error-code table (unchanged) / FAQ (7 existing + 2 new).

## `<script>` split (compiler constraint)
`<script setup>` cannot contain ES module exports — confirmed as a hard `@vue/compiler-sfc` error
while building this. `INTEGRATION_HELP_GLOSSARY` moved to a plain `<script lang="ts">` block before
`<script setup>`, matching the existing precedent in `ApprovalFormBuilder.vue`
(`STALE_SLOT_RETRY_MESSAGE`). Both blocks share one module scope; no re-import needed.

## Glossary alias grounding (file:line, real greps — not recalled)
| Row | Key citations |
| --- | --- |
| 连接/外接数据源/外部系统/连接草稿/adapter | `IntegrationWorkbenchView.vue:656,671,798,1126,1297,2104`; `IntegrationConnectionSection.vue:7,26`; `App.vue:70,194`; adapter label `plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:698` (`kind: data-source:sql-readonly`) |
| 数据集/对象/表或视图 | `IntegrationObjectTemplateSection.vue:7,15,103-104` (same picker: h3 says "对象", dropdown label says "数据集"); `IntegrationConnectionSection.vue:165-177,187`; `IntegrationWorkbenchView.vue:2001,2031` |
| 清洗表/staging 多维表 | `IntegrationCleaningDatasetSection.vue:109,111,142-143`; `IntegrationWorkbenchView.vue:1173-1183,1382,2877-2881,2904,2957` |
| 读取源 | rail label `IntegrationWorkbenchView.vue:673`; `resolver_lookup` at line 112; 4-step wizard `IntegrationReadSourceWizard.vue:8-11` |
| 组合 | rail label `IntegrationWorkbenchView.vue:674`; "两跳组合" line 112; component names mix both words (`IntegrationReadSourceCompositionPanel.vue`) |
| 管道/pipeline | button testid `save-pipeline` line 224-225 (Chinese-only "保存清洗流程", no `bi()` English variant); "pipeline 配置" line 1521; prop/testid names lines 231-256,374. **管道 itself does not appear** in any of the 3 grep-scoped locations (`rg 管道` against `IntegrationWorkbenchView.vue`, `components/integration/*.vue`, `App.vue` = 0 hits) — glossary row states this rather than inventing a UI spot |
| 死信 | rail label line 676; props/functions lines 382-402,462-474 |

## Case-one step grounding
`DataSourcesView.vue` ("新建数据源" `ds-new-button`) → `IntegrationConnectionSection.vue`
(`show-advanced-connectors` L117, `connect-new-system` L26, `connection-draft-kind` L151,
`data-source-bridge-id`/`data-source-bridge-object` L168/176, credential hint L189,
`save-connection-draft` L238-239) → `IntegrationObjectTemplateSection.vue`
(`load-source-objects` L98-99, `source-object` L104) → `IntegrationCleaningDatasetSection.vue`
(`install-staging` L142-143) → `IntegrationPipelineRunSection.vue` (`run-dry-run` L130-131,
`allow-save-only-run` L108, `run-save-only` L133-134) → `IntegrationWorkbenchView.vue:347-366`
(`export-cleansed-result`). Every button/testid label quoted in the page is a real, grepped label.

## Case-two (K3) alignment with in-flight #5597
`/integrations/k3-wise` still shows a live Save-only-to-K3 affordance at this branch's base
(`11dddc18b`). Commit `a734f8add` ("K3 目标永久只读") on branch
`fix/integration-k3-writeback-copy-and-codes` (not an ancestor of this branch — confirmed via
`git merge-base --is-ancestor`) changes this and adds three write-disabled codes to
`INTEGRATION_ERROR_CODE_LABELS` (picked up automatically by this page's single-source error table
once merged). Per task instruction, case two's copy matches that direction now so no follow-up
edit is needed after #5597 lands.

## Role/permission table (backs the FAQ's "why can't I see X" answer — codes not repeated on-page)
| UI surface | Gate | Source |
| --- | --- | --- |
| "数据工厂" nav → `/integrations/workbench` | `integration:write` | `App.vue:63,155-158` |
| "外接数据源" nav → `/data-sources` | `integration:write` (same computed) | `App.vue:70,155-158` |
| K3 WISE preset `/integrations/k3-wise` | `integration:write` (route meta) | `appRoutes.ts:309` |
| "备料工作台" nav → `/stock-prep` | `stock-prep:read` (`STOCK_PREP_ROUTE_PERMISSION`) | `App.vue:69,161-166` |
| This help page | `requiresAuth` only, no permission gate | route meta, unchanged |

## Deliberately not done
No change to `IntegrationWorkbenchView.vue`, `IntegrationK3WiseSetupView.vue`, `DataSourcesView.vue`,
or `components/integration/*` (grounding sources only). No PR/branch name in live page copy. Did not
attempt to fix the 管道 naming gap in the workbench UI — out of scope.
