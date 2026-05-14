# Data Factory Workbench Development - 2026-05-14

## Goal

Turn the existing system integration workbench into the default Data Factory
surface without changing the backend data model:

- data sources can be CRM / PLM / ERP / SRM / HTTP / SQL;
- datasets are chosen from existing object/schema discovery APIs;
- cleansing happens in multitable staging sheets;
- K3 WISE is a preset template path, not the product center;
- JSON remains a preview/debug artifact, not the business editing surface.

## Implementation

### Frontend information architecture

- The platform navigation now labels the integration entry as `数据工厂` /
  `Data Factory`.
- `/integrations/workbench` remains unchanged for deployed-link compatibility.
- The workbench header now uses Data Factory language and adds a four-step
  flow: connect systems, choose datasets, cleanse in multitable, dry-run /
  push.
- The K3 WISE setup page now presents itself as a Data Factory preset and links
  back with `进入数据工厂`.

### Dataset layer

- The source selector now uses data-source language.
- Source/target objects are presented as datasets.
- The page shows three dataset cards:
  - source dataset with field count and connection state;
  - staging multitable dataset with staging table count and area;
  - target dataset/template with field and required-field counts.
- Same-system and K3 SQL-read/WebAPI-write guidance remains in place.

### Multitable cleansing entry

- Staging descriptors are rendered as business-facing dataset cards.
- Known staging tables get explicit business areas:
  - `plm_raw_items`: raw area;
  - `standard_materials`, `bom_cleanse`: cleansing area;
  - `integration_exceptions`, `integration_run_log`: feedback/writeback area.
- The Data Factory page can call the existing
  `/api/integration/staging/install` endpoint with `projectId` and optional
  `baseId`.
- When the install result includes `targets`, `openLinks`, or `viewIds`, the UI
  renders `打开多维表` links so users can jump directly into the cleansing grid.

### Mapping and execution

- The existing field-mapping section is renamed to `清洗映射规则`.
- Existing transforms, validation rules, template preview, dry-run, Save-only
  opt-in, run history, and dead-letter observation are retained.
- No migration, new table, raw SQL editor, or user JavaScript execution was
  added.

### Delivery scripts and docs

- The Windows on-prem quickstart now describes `/integrations/workbench` as
  Data Factory.
- The K3 internal-trial runbook now describes K3 as the preset path and Data
  Factory as the configurable surface.
- The multitable on-prem package build/verify scripts now include the new Data
  Factory development docs and verify Data Factory copy in web dist.

## Files changed

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/services/integration/workbench.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/App.vue`
- `apps/web/src/router/appRoutes.ts`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`
- `apps/web/tests/platform-shell-nav.spec.ts`
- `docs/deployment/multitable-windows-onprem-easy-start-20260319.md`
- `docs/operations/integration-k3wise-internal-trial-runbook.md`
- `scripts/ops/multitable-onprem-package-build.sh`
- `scripts/ops/multitable-onprem-package-verify.sh`

## Deployment impact

- Frontend-only product language and workflow change, plus docs/package
  verifier updates.
- Backend runtime contract is unchanged.
- No migration required.
- Existing `/integrations/workbench` and `/integrations/k3-wise` routes remain
  stable.
