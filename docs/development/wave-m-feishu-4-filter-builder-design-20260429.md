# Wave M Feishu 4 Filter Builder Design - 2026-04-29

## Scope

Lane C improves the multitable visual filter builder experience in `apps/web/src/multitable/components/MetaToolbar.vue` without changing the backend view protocol. Existing `filterRules` and `filterInfo.conditions` remain the source of truth.

## Design

- Keep the current toolbar panel and `FilterRule` event contract.
- Add field-type context next to each filter rule so users can see whether they are editing text, number, checkbox, select, or date logic.
- Keep unary empty-value operators (`isEmpty`, `isNotEmpty`) value-free and show a short "no value needed" hint instead of a disabled text box.
- Render select fields with their configured options as a dropdown; fallback options may come from `field.options` or `field.property.options`.
- Render boolean fields as a true/false dropdown and keep numeric fields as number inputs.
- Use typed default values when adding or retargeting filters: first select option for select fields, `true` for boolean fields, and an empty string for text/number/date.
- Surface staged filter state with clearer apply copy: dirty filters show "Apply filter changes" and a note that changes are staged until applied.

## Non-Goals

- No backend API or `filterInfo` shape changes.
- No rewrite of view management filtering or saved-view payloads.
- No new filtering operators beyond the existing operator keys.
