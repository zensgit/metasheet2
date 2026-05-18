# Data Factory issue #1542 closeout development - 2026-05-17

## Purpose

Issue #1542 asks for a clearer new-connection flow in the Data Factory
Workbench. This closeout is intentionally docs-only: it records the current
`main` state and separates the #1542 onboarding scope from deeper runtime
capabilities that should remain tracked elsewhere.

Baseline inspected in this slice:

```text
main: 82242b380 docs(integration): record issue 651 C1 C3 UI closeout
issue: #1542 Integration Workbench needs a clear new-connection flow
state at inspection: OPEN
```

## Why this is a closeout, not another feature PR

The originally reported operator confusion has been covered by the shipped Data
Factory work:

| Concern | Current behavior |
| --- | --- |
| "Where do I start?" | The Workbench starts with `数据工厂`, a visible `连接新系统` area, a K3 preset entry, a general connection guide action, and an SQL/high-connection action. |
| "What is loaded?" | The summary expands into configured systems, adapter inventory, and staging multitable inventory. |
| "Why can I not use SQL yet?" | SQL connections are hidden by default, marked as advanced, and when executor support is missing the UI explains `SQLSERVER_EXECUTOR_MISSING`. |
| "How do I get a readable source without live PLM/K3 SQL?" | The Workbench exposes staging creation and `作为 Dry-run 来源` for installed staging tables. |
| "Where is the real multitable entry?" | Staging cards use the backend-provided `/multitable/...` open link and explicitly warn against hand-writing `/grid` or `/spreadsheets/...` paths. |
| "Can I save a draft pipeline?" | The issue #1542 smoke now verifies a staging-to-K3 material draft pipeline save path. |

The remaining items frequently mentioned in the same discussion are not the
same product problem:

- A real SQL Server executor is a deployment/runtime capability behind the
  advanced SQL channel. It must keep allowlist-only read guardrails and should
  not be bundled into a UI wording closeout.
- K3 WebAPI read/list runtime support touches `plugin-integration-core` and is
  blocked by the customer GATE contract that was documented before runtime
  changes.
- Relationship mapping and unresolved-link handling are model/runtime work, not
  the new-connection onboarding flow.

## Current shipped slices that form the closeout

| Area | Evidence in repo |
| --- | --- |
| Data Factory IA | `apps/web/src/views/IntegrationWorkbenchView.vue` renders the `数据工厂` title, four-step flow, connection onboarding, and staging dataset region. |
| Issue #1542 P1 UX | `data-factory-issue1542-p1-ux-*` documents disabled SQL source states and staging creation CTAs. |
| Save/Dry-run prerequisites | `data-factory-issue1542-p2-prereq-*` documents disabled save/dry-run controls until required state exists. |
| Pipeline JSONB repair | `data-factory-issue1542-pipeline-jsonb-*` records the fix for draft pipeline save failures. |
| Staging source install/signoff | `data-factory-issue1542-install-smoke-*`, `data-factory-issue1542-workflow-install-staging-*`, and `data-factory-issue1542-postdeploy-signoff-*` record automated staging-source checks. |
| Package inclusion | `data-factory-issue1542-package-verify-*` records package-level inclusion of the smoke assets. |

## Operator path after this closeout

1. Open Data Factory at `/integrations/workbench`.
2. Use `使用 K3 WISE 预设` for the first K3 material/BOM target path, or use the
   general `连接新系统` guide for non-K3 systems.
3. If no readable source exists, create staging multitables from the Workbench.
4. Open the returned `/multitable/...` link to clean or add rows in the real
   multitable surface.
5. Select the staging table as Dry-run source and K3 WebAPI material/BOM as
   target.
6. Save the draft pipeline; then run dry-run. Save-only remains separate from
   Submit/Audit and must be explicit.

## Explicit non-goals

- No new migration.
- No new backend route.
- No `plugin-integration-core` runtime change.
- No SQL Server driver/executor implementation.
- No K3 live write or Submit/Audit enablement.
- No raw SQL, direct JavaScript transform, or secret-bearing example in docs.

## Recommendation

After this closeout PR is merged, issue #1542 can be closed as resolved for the
Data Factory new-connection/onboarding flow. Follow-up work should stay in the
more specific buckets already identified:

- advanced SQL executor deployment and allowlist verification;
- post-GATE K3 WebAPI read/list runtime support;
- relationship mapping/unresolved-link behavior;
- customer GATE live K3 validation.
