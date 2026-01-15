# Verification: PLM UI BOM Compare Field Mapping - 20260115_1759

## Goal
Provide a field-level mapping between Yuantus BOM compare output and the MetaSheet PLM UI.

## Environment
- Yuantus base: http://127.0.0.1:7910
- Schema endpoint: /api/v1/bom/compare/schema
- Schema snapshot: artifacts/plm-bom-compare-schema-20260115_1759.json

## BOM compare response shape (Yuantus)
- `added[]` / `removed[]`: `BOMCompareEntry` with `line`, `line_normalized`, `properties`, `parent`, `child`, `path`.
- `changed[]`: `BOMCompareChangedEntry` with `changes[]`, `before/after`, `before_line/after_line`, `before_normalized/after_normalized`.

## Field mapping (line_fields)
| Field key | UI label | Yuantus response location | Normalization (Yuantus) | UI render path |
| --- | --- | --- | --- | --- |
| quantity | 数量 | `entry.line.quantity` (fallback `entry.properties.quantity`) | float | `getCompareProp(entry, 'quantity')` |
| uom | 单位 | `entry.line.uom` (fallback `entry.properties.uom`) | upper-case string | `getCompareProp(entry, 'uom')` |
| find_num | Find # | `entry.line.find_num` (fallback `entry.properties.find_num`) | trimmed string | `getCompareProp(entry, 'find_num')` |
| refdes | Refdes | `entry.line.refdes` (fallback `entry.properties.refdes`) | sorted unique list | `getCompareProp(entry, 'refdes')` |
| effectivity_from | 生效起 | `entry.line.effectivity_from` / `entry.properties.effectivity_from` | ISO datetime string | `formatEffectivity(entry)` |
| effectivity_to | 生效止 | `entry.line.effectivity_to` / `entry.properties.effectivity_to` | ISO datetime string | `formatEffectivity(entry)` |
| effectivities | 生效性 | `entry.properties.effectivities[]` | sorted tuples (type,start,end,payload) | `formatEffectivity(entry)` |
| substitutes | 替代件 | `entry.properties.substitutes[]` | sorted tuples (item_id,rank,note) | `formatSubstituteCount(entry)` |

Notes:
- `entry.line` is produced by Yuantus `_format_entry` and mirrors standard line fields from `entry.properties`.
- `effectivities` and `substitutes` appear only when `includeEffectivity` / `includeSubstitutes` is true.

## Structural mapping (rows + navigation)
| UI column | Yuantus source | UI helper |
| --- | --- | --- |
| 层级 | `entry.level` | direct |
| 父件 | `entry.parent` or `entry.path[0]` | `getCompareParent(entry)` + `getItemNumber/getItemName` |
| 子件 | `entry.child` or last `entry.path` | `getCompareChild(entry)` + `getItemNumber/getItemName` |
| Line | `entry.line_key` + `entry.relationship_id` | `entry.line_key`, `entry.relationship_id` |

## Diff mapping (changed[])
| Field | Yuantus source | UI render |
| --- | --- | --- |
| 变更项 | `entry.changes[]` | `getCompareChangeRows(entry)` |
| 严重度 | `entry.severity` + `changes[].severity` | `getCompareEntrySeverity(entry)` |
| 左/右值 | `changes[].left/right` | `formatDiffValue(change.left/right)` |
| 规范化值 | `changes[].normalized_left/right` | shown via meta tooltip label |

## Line key composition (Yuantus)
| line_key | Composition |
| --- | --- |
| child_config | `parent_config::child_config` |
| child_id | `parent_id::child_id` |
| relationship_id | `relationship_id` (fallback parent::child) |
| child_config_find_num | `parent_config::child_config::find_num` |
| child_config_refdes | `parent_config::child_config::refdes` |
| child_config_find_refdes | `parent_config::child_config::find_num::refdes` |
| child_config_find_num_qty | `parent_config::child_config::find_num::quantity` |
| child_id_find_num | `parent_id::child_id::find_num` |
| child_id_refdes | `parent_id::child_id::refdes` |
| child_id_find_refdes | `parent_id::child_id::find_num::refdes` |
| child_id_find_num_qty | `parent_id::child_id::find_num::quantity` |
| line_full | `parent::child::find_num::refdes::effectivity` |

## Known behavior
- `changed[]` entries do not include `properties` in Yuantus (`before_line/after_line` are available instead). The UI currently renders effectivity/substitute columns from `entry.properties`, so those columns may show `-` for changed rows.

## Verification steps
1. Fetch compare schema
   ```bash
   curl -s http://127.0.0.1:7910/api/v1/bom/compare/schema \
     -H 'Authorization: Bearer <token>' \
     -H 'x-tenant-id: tenant-1' -H 'x-org-id: org-1' \
     > artifacts/plm-bom-compare-schema-20260115_1759.json
   ```
2. Confirm UI field labels match schema keys (see `apps/web/src/views/PlmProductView.vue`).
