# Multitable Gantt Dependencies Design - 2026-05-06

## Scope

This slice adds an opt-in dependency display to the built-in multitable Gantt view. It is frontend-only and does not change record storage, backend schemas, migrations, or REST contracts.

## Goals

- Let a Gantt view persist a dependency field through `MetaGanttViewConfig.dependencyFieldId`.
- Let users choose the dependency field from the view manager and inline Gantt toolbar.
- Render lightweight dependency arrows between scheduled rows when the configured field references another record in the current result set.
- Keep the feature disabled by default so existing text or select-like data is not reinterpreted as dependencies.

## Data Contract

`MetaGanttViewConfig` now includes:

```ts
dependencyFieldId?: string | null
```

Supported field types are:

- `link`: primary intended source; values are treated as linked record ids.
- `multiSelect`: accepted for teams that model dependency ids as controlled options.
- `string`: accepted for comma, semicolon, or newline separated record ids.

Invalid or stale `dependencyFieldId` values resolve to `null`. This mirrors the existing view-config hardening pattern and avoids saving unsupported field references.

## Frontend Behavior

- `resolveGanttViewConfig()` validates `dependencyFieldId` against current fields.
- `MetaViewManager` exposes a "Dependency field" selector in Gantt configuration and blocks saving if the chosen dependency field disappears or becomes unsupported.
- `MetaGanttView` exposes the same selector in the toolbar and emits `update-view-config` with the persisted config.
- The Gantt renderer computes dependencies only among currently scheduled rows. Missing, unscheduled, or self-references are ignored.
- Arrows are row-local visual hints rendered inside the dependent task row. Forward dependencies render solid orange arrows; backward dependencies render dashed arrows.

## Non-Goals

- No backend dependency model or validation.
- No cross-row SVG routing, collision avoidance, or critical-path layout.
- No automatic dependency inference from existing text fields.
- No scheduling semantics such as auto-shifting dependent tasks.
- No dependency editing UI beyond selecting the source field.

## Implementation Notes

- Date-like handling remains aligned with the recent DateTime field work: Gantt defaults and selectors accept `date` and `dateTime` fields.
- String dependency parsing uses comma, semicolon, or newline delimiters. Whitespace-only values are ignored and duplicate ids are de-duplicated.
- Rendering stays component-local and does not require new shared state or Pinia stores.

## Follow-Ups

- Add a dedicated dependency field type or structured dependency editor if users need stable dependency authoring rather than record-id entry.
- Add full cross-row dependency routing after real internal usage shows this lightweight hint is insufficient.
- Add backend validation only if dependencies become authoritative scheduling data.
