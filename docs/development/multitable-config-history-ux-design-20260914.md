# Configuration History Readability

## Scope

Owner request: configuration history should identify actual operations instead of
showing only "update", expose the deleted field definition, explain `order`, and
display operator names. This is presentation/read enrichment of existing history,
not a new recovery capability.

- Initial main: `2e120a7d54cff04aa718a586aece56fc859483f6`.
- Product commit: `7aa8e12c8c85da2370bbf824f8e3d5f0a4464221`.
- Refreshed main: `c13e40769690a4ed51b3f3a7ac2f8026638f3e88`.
- True-merge candidate: `98c625b9518532dabc5692dff63d518631c5292c`.
- Branch: `codex/config-history-ux-20260914`.

## Display Contract

| History fact | Display |
| --- | --- |
| Field create/delete | Explicit create/delete field title; declared after/before configuration |
| Single field update | Rename, type change, properties change, or field reorder |
| View update | Filter, sort, grouping, hidden fields, rename or view settings |
| Multiple changed keys | Generic entity update plus every changed key; no first-key-only classification |
| `order` | Field order / 字段排列顺序; retain the recorded numeric value, not an inferred current ordinal |
| `sheet_config` | Table settings / 表级设置, distinct from field changes |
| Historical name present | Use revision after.name, or before.name for deletion |
| Name unavailable | Existing live label resolver, then its ID fallback |
| Operator | Server directory display name; preserve actor ID fallback and tooltip |
| Missing snapshot | Explicit unavailable details, never an invented snapshot |

Create/delete rendering uses declared changed keys. Legacy empty key lists fall
back only to known configuration keys; internal sequence `lastValue` is not
displayed. AI shortcut free text keeps the existing redactor. Unknown display
keys/types remain visible rather than silently disappearing.

## Authority And Boundaries

Stored actions, batch identities, sort/pagination and restoration semantics are
unchanged. Deleting a field legitimately records order/view update side effects;
those remain updates, not falsely relabeled deletes. Existing per-entity SQL
authorization runs before one batched actor-name lookup. View filter and table
conditional-read literal masking is unchanged.

No mutation endpoint, migration, flag, shared CI selector, recycle-bin behavior,
whole-table recovery or deployment is changed. The existing modal spec is already
included in both multitable web guard and required web tests.
