# Data Factory Workbench TODO - 2026-05-14

## Summary

The integration surface is now moving from a K3/ERP-centered setup into a
Data Factory model:

```text
Connect systems -> choose datasets -> cleanse in multitable -> dry-run / export / Save-only push
```

K3 WISE stays as the first preset template for Material and BOM. Business data
continues to live in multitable fields; JSON is only used for payload preview,
adapter templates, and debugging.

## DF-M0 - Naming and information architecture

- [x] Rename the workbench page title to `数据工厂`.
- [x] Rename the platform nav entry to `数据工厂` / `Data Factory`.
- [x] Keep `/integrations/workbench` as the stable route.
- [x] Keep K3 WISE as a preset page under the Data Factory story.
- [x] Add the four-step flow: connect systems, choose datasets, cleanse in
  multitable, dry-run / push.
- [x] Keep SQL as an advanced connector hidden from the default business-user
  list.

## DF-M1 - Data source and dataset layer

- [x] Reword source selection as `数据源系统`.
- [x] Reword source/target objects as source/target datasets.
- [x] Add dataset summary cards for source, staging multitable, and target.
- [x] Show field counts, required target fields, and connection state.
- [x] Preserve same-system / different-business-object guidance.
- [x] Preserve SQL protocol split guidance for K3 SQL read + WebAPI write.

## DF-M2 - Multitable cleansing entry

- [x] Show staging descriptors as business-facing dataset cards.
- [x] Label `plm_raw_items` as raw area.
- [x] Label `standard_materials` and `bom_cleanse` as cleansing area.
- [x] Label exceptions and run logs as feedback/writeback area.
- [x] Add a Data Factory `创建清洗表` action backed by
  `/api/integration/staging/install`.
- [x] Render `打开多维表` links when staging install returns open targets.

## DF-M3 - Cleansing mapping rules

- [x] Rename the mapping section to `清洗映射规则`.
- [x] Keep source fields from the source dataset schema.
- [x] Keep target fields from the target dataset/template schema.
- [x] Keep only whitelisted transforms: `trim`, `upper`, `lower`, `toNumber`,
  `dictMap`.
- [x] Keep dictionary mapping and required/min/max validation support.
- [x] Keep user JavaScript and raw SQL out of the UI.

## DF-M4 - Dry-run, export, and push

- [x] Preserve payload preview before writing.
- [x] Preserve dry-run before Save-only execution.
- [x] Preserve explicit Save-only opt-in.
- [x] Preserve run and open dead-letter observation.
- [x] Add CSV / Excel export for cleansed staging dry-run preview data.
- [x] Keep "data service publishing" as a later-stage placeholder only.

## DF-M5 - K3 WISE as preset template

- [x] Keep K3 WISE Material/BOM templates.
- [x] Reword the K3 page as a Data Factory preset.
- [x] Keep K3 payload preview shape as `{ Data: ... }`.
- [x] Keep Base URL vs `/K3API/...` endpoint warning.
- [x] Keep Tenant ID defaulting to `default` through the existing scoped
  service helpers.
- [x] Keep WebAPI tested state as connected/failed instead of a permanent
  untested status after a successful test.

## DF-M6 - Docs, delivery, and package verification

- [x] Add this TODO.
- [x] Add development notes for the Data Factory conversion.
- [x] Add verification notes for focused UI and package checks.
- [x] Update Windows on-prem quickstart wording from generic integration to
  Data Factory.
- [x] Update K3 internal-trial runbook wording so K3 is a preset path.
- [x] Update multitable on-prem package build/verify scripts to include and
  verify the Data Factory docs/copy.

## Not in this slice

- Full visual ETL canvas.
- Customer-authored JavaScript transforms.
- Raw SQL editor.
- New database tables or migrations.
- Purchase order, sales order, warehouse receipt, or other K3 document
  templates beyond Material/BOM.
- Public data-service publishing.
