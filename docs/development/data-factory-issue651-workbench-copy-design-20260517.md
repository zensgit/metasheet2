# Data Factory issue #651 workbench copy design - 2026-05-17

## Purpose

Address the latest issue #651 usability feedback for `/integrations/workbench`.
The feedback is not a runtime bug: users can already select systems, load
objects, choose source/target datasets, map fields, dry-run, export, and
Save-only push. The problem is that the page did not make the dataset-selection
path obvious enough for first-time business users.

## Scope

Included:

- Add a compact operator path near the top of the page:
  `选来源系统 -> 选来源数据集 -> 选目标系统 -> 选目标数据集 -> 配映射 -> Dry-run -> 推送`.
- Add a section heading before the source/target selectors: `选择系统与数据集`.
- Rename the source/target columns to:
  - `1. 选来源系统与数据集`
  - `2. 选目标系统与数据集`
- Rename `Pipeline 执行` to `运行与推送`.
- Rename visible labels/buttons from `Pipeline` phrasing to `清洗流程` where the
  text is user-facing.

Excluded:

- No backend changes.
- No API or migration changes.
- No K3 WISE runtime changes.
- No change to route `/integrations/workbench`.
- No change to the stored pipeline data model or service method names.

## UX Rationale

Data Factory is positioned as a business workflow:

1. Pick the source connection.
2. Pick the source dataset.
3. Pick the target connection.
4. Pick the target dataset/template.
5. Configure cleansing mappings.
6. Dry-run.
7. Push or export.

The previous UI had all of these controls, but the source/target dataset
selection lived inside a dense panel. The new copy makes the flow explicit
without adding another page or changing the implementation model.

## Compatibility

The change is frontend-only copy and layout:

- Existing test IDs remain stable.
- Existing service/API calls remain unchanged.
- Existing `Pipeline` TypeScript names remain unchanged because they are
  developer-facing implementation terms.
- User-facing text now favors `清洗流程` and `运行与推送`.

## Deployment Impact

No migration is required. A normal web bundle rebuild is sufficient.
