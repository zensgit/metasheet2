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
2. **Case one** (`help-section-case-sql-source`, 7 steps): SQL read-only source → multi-dim table.
   **Case two** (`help-section-case-k3-wise`, 5 steps): K3 WISE preset. Both use a 5-field step
   shape (where / what to click / success / common failure & where to look / **code anchors**),
   values-free. Step counts and the anchor field are the round-2 rewrite — see below.
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

## Round-2 rewrite (2026-09-10, review finding P2 #5613)
Review, verbatim: *"帮助中心描述了走不通的操作链"* — (a) the walkthrough told the reader to type
placeholders into the real connection form while promising a working connection; (b) case two
claimed the K3 dry-run *"只读取 K3"* and that *"打开多维表会保存预览结果"*. Both were rewritten
against the real producers, and the spec was changed from "the copy is rendered" to "each step's
action exists in code".

### Case one — the real chain (file:line, read out before rewriting)
| Leg | Producer |
| --- | --- |
| Data-source page | `apps/web/src/router/appRoutes.ts:187` `path: '/data-sources'`; `DataSourcesView.vue:13` `ds-new-button` |
| Form fields | `DataSourcesView.vue:42,48,51,54,57,94` (`ds-field-host/port/database/username/password/readonly`). The greys `10.0.0.5` / `erp` are HTML `placeholder` ATTRIBUTES (L42, L51) — hint text, never submitted |
| "测试连接" (the only dial-out) | `DataSourcesView.vue:100-108` `ds-test-draft` → `runDraftTest()` L430 → `data-sources/api.ts:128 testDataSourceDraftConnection` → `POST /api/data-sources/test` (`routes/data-sources.ts:549`) → `DataSourceManager.ts:925 testEphemeralConnection` — transient adapter, persists nothing, result-only |
| "创建" (no dial-out) | `DataSourcesView.vue:109` `ds-submit` → `submit()` L630 → `buildPayload.ts:29 buildCreatePayload` → `POST /api/data-sources` (`routes/data-sources.ts:463`) → `DataSourceManager.ts:482 addDataSourceInternal(config, false)` |
| Why a placeholder still "saves" | `routes/data-sources.ts:121-128` states it in the schema comment: create never auto-connects, so a config that cannot connect "persists successfully and only fails the first time something actually connects" |
| Failure text is values-free | `routes/data-sources.ts:71-76` `SCHEMA_FAILURE_MESSAGE` / `TABLE_INFO_FAILURE_MESSAGE` / `CONNECT_FAILURE_MESSAGE` — no driver text; they point at 「测试连接」. The ephemeral test additionally strips the SUBMITTED host/username out of the driver diagnostic (`DataSourceManager.ts:955-990`) |

So the corrected copy is: fill real values → 「测试连接」 is the verification → 「创建」 只落库；
**保存成功 ≠ 连得上**. Placeholders are named only as (i) the HTML placeholder attribute and
(ii) something that belongs in docs/screenshots/evidence.

Remaining legs unchanged from round 1: `IntegrationConnectionSection.vue`
(`show-advanced-connectors` L119, `data-source-bridge-id` L168, `save-connection-draft` L238,
credential hint L189) → `IntegrationObjectTemplateSection.vue` (`load-source-objects` L98,
`source-object` L104) → `IntegrationCleaningDatasetSection.vue` (`install-staging` L142-143) →
`IntegrationPipelineRunSection.vue` (`run-dry-run` L130, `allow-save-only-run` L109,
`run-save-only` L133) → `IntegrationWorkbenchView.vue:362` (`export-cleansed-result`). Adapter
label `Read-only SQL data source` =
`plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:698`.

### Case two — the real chain (what falsified the old copy)
| Claim in round 1 | Reality (file:line) |
| --- | --- |
| "不需要手填连接参数" | The page's own journey nav step 1 is 「接通 K3 / 填写地址和授权码」 (`IntegrationK3WiseSetupView.vue:26-27`), with 「保存配置」 L15-17 then 「测试 WebAPI」 L107-108; an unsaved draft blocks the test (L110) |
| "Dry-run …只读取 K3 数据" | `k3WiseSetup.ts:2110-2117` binds `sourceSystemId = form.sourceSystemId` (the **PLM** source) and `targetSystemId = form.webApiSystemId` (K3); both drafts are described as `Draft PLM material/BOM cleansing pipeline` (L2125, L2151). The view labels the fields 「PLM Source System ID」 / 「K3 Target System ID」 (L728, L735). So the dry-run READS PLM |
| (what the dry-run actually produces) | `executePipeline(target, true)` L1708-1722 → `runIntegrationPipeline` L2298-2309 (`dryRun ? 'dry-run' : 'run'`) → `POST /api/integration/pipelines/:id/dry-run` (`plugins/plugin-integration-core/lib/http-routes.cjs:59,5423`) → `pipeline-runner.cjs:1044-1046 attachDryRunTargetPreview` → `targetAdapter.previewUpsert` (L858-887), which fills `targetPayload` / `targetRequest` (method, path, query, body) — i.e. the **K3 payload preview** |
| "打开多维表把结果落到 staging 多维表" | `IntegrationK3WiseSetupView.vue:164-177` is a `<router-link :to="target.openLink">` labelled 「打开多维表（新建记录入口）」. `openLink` comes from `buildStagingOpenTargets()` L1311-1331 / `buildMultitableOpenLink()` L1305-1309 = `/multitable/:sheetId/:viewId?baseId=…`. It is computed from `stagingInstallResult` (L1173), i.e. the **install** result, not any run result. **Pure navigation, zero write/save call on that path** |
| "永远不会写回 K3" (kept, now grounded here) | `pipeline-runner.cjs:1047-1048` — the module's ONLY `targetAdapter.upsert(` is behind `if (!dryRun && cleanRecords.length > 0)`; live runs to either K3 kind are refused earlier (L446, L467); the four-layer permanent fence is `plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs` and its deepest layer is `adapters/k3-wise-webapi-adapter.cjs:2445`, while `previewUpsert` (L2038-2081) composes the Save body with **no** `login()` and **no** request |

What a dry run DOES persist platform-side (stated in the copy, so it is not over-claimed): a run
record (`pipeline-runner.cjs:947-957`, `details.dryRun = true`) and dead letters for failed rows —
visible under 监控与死信. Nothing lands in the staging multi-dimensional table and nothing is sent
to the ERP.

### Anchors + the tests that make this falsifiable
Each step now carries `anchors: { file, token }[]` (44 anchors total), rendered on the page under
「这一步对应的代码」 and asserted by the spec via `readFileSync` (precedent:
`ui-foundation-style-guard.spec.ts`, `StockPreparationInstallRun.spec.ts`). Anchors are
identifiers only — never an error-code literal, because the page's code vocabulary has exactly one
source (`errorCodeLabels.ts`, untouched); a new test now fails if any SCREAMING_SNAKE code-like
token appears in either case section without being registered there.

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

Round 2 adds two more non-goals, both reported rather than fixed:
- The K3 preset page still renders 「执行物料」/「执行 BOM」 live-run buttons
  (`IntegrationK3WiseSetupView.vue:209-232`). Against a K3 target the runner refuses those runs at
  target resolution (`pipeline-runner.cjs:446` for the WebAPI kind, `:467` for the sqlserver kind),
  so the affordance outlives the capability. The help page says the runner refuses them; making the
  buttons themselves reflect that is a change to the preset view, outside this docs-only slice.
- `errorCodeLabels.ts` is untouched (task constraint). Two refusal codes the walkthroughs discuss in
  words — the K3 permanent write fence and the live-run redirect — are therefore NOT in the page's
  error-code table, which is exactly why the case prose names functions instead of codes.
