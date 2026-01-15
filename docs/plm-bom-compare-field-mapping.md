# PLM BOM Compare 字段级对照清单 (MetaSheet2 ⇄ Yuantus)

> 目标：明确 BOM Compare 的请求/响应字段、归一化规则、UI 展示字段来源，便于联测与问题排查。

---

## 1) 数据流与接口

### MetaSheet → PLM 适配器

- **操作名**：`bom_compare`
- **入口**：`POST /api/federation/plm/query`
- **Adapter**：`packages/core-backend/src/data-adapters/PLMAdapter.ts`
- **真实 PLM**：`/api/v1/bom/compare` (Yuantus)

### Schema

- **操作名**：`bom_compare_schema`
- **入口**：`POST /api/federation/plm/query`
- **真实 PLM**：`/api/v1/bom/compare/schema` (Yuantus)

---

## 2) 请求参数对照

| MetaSheet 参数 | Yuantus Query | 类型 | 说明 |
|---|---|---|---|
| `leftId` | `left_id` | string | 左侧根节点 ID |
| `rightId` | `right_id` | string | 右侧根节点 ID |
| `leftType` | `left_type` | string | `item`/`version` |
| `rightType` | `right_type` | string | `item`/`version` |
| `maxLevels` | `max_levels` | number | 展开层级（-1 无限） |
| `lineKey` | `line_key` | string | 行唯一键策略 |
| `compareMode` | `compare_mode` | string | 对比模式（自动设置 line_key + props） |
| `includeChildFields` | `include_child_fields` | boolean | 返回 parent/child 简要信息 |
| `includeRelationshipProps` | `include_relationship_props` | string[] | 关系字段白名单 |
| `includeSubstitutes` | `include_substitutes` | boolean | 返回替代件 |
| `includeEffectivity` | `include_effectivity` | boolean | 返回生效性 |
| `effectiveAt` | `effective_at` | ISO string | 生效性过滤日期 |

> 说明：`compare_mode` 若传入，会覆盖 `line_key` 与 `include_relationship_props`。`include_relationship_props` 默认为 `quantity/uom/find_num/refdes/effectivity_from/effectivity_to`（若字段存在）。

---

## 3) 响应结构（Yuantus）

```json
{
  "summary": {
    "added": 0,
    "removed": 0,
    "changed": 0,
    "changed_major": 0,
    "changed_minor": 0,
    "changed_info": 0
  },
  "added": [BOMCompareEntry],
  "removed": [BOMCompareEntry],
  "changed": [BOMCompareChangedEntry]
}
```

### 3.1 BOMCompareEntry（新增 / 删除）

| 字段 | 类型 | 说明 |
|---|---|---|
| `parent_id` | string | 父件 ID |
| `child_id` | string | 子件 ID |
| `relationship_id` | string | BOM 关系 ID |
| `line_key` | string | 行唯一键（由 line_key 规则生成） |
| `parent_config_id` | string | 父件 config_id |
| `child_config_id` | string | 子件 config_id |
| `level` | number | 深度（从 1 开始） |
| `path` | array | 路径节点（父到子） |
| `properties` | object | 关系属性（原始值） |
| `line` | object | 标准化 BOM 行字段（quantity/uom/…） |
| `line_normalized` | object | 归一化后的行字段 |
| `parent` | object | 父件简要信息（可选） |
| `child` | object | 子件简要信息（可选） |

### 3.2 BOMCompareChangedEntry（变更）

| 字段 | 类型 | 说明 |
|---|---|---|
| `parent_id` / `child_id` | string | 同上 |
| `relationship_id` | string | 同上 |
| `line_key` | string | 同上 |
| `level` | number | 同上 |
| `path` | array | 同上 |
| `before` / `after` | object | 发生变化的原始字段值 | 
| `before_line` / `after_line` | object | 标准行字段（原始值） |
| `before_normalized` / `after_normalized` | object | 标准行字段（归一化） |
| `changes` | array | 字段级变更列表（见 3.3） |
| `severity` | string | 变更严重度（major/minor/info） |
| `parent` / `child` | object | 可选，简要信息 |

### 3.3 BOMCompareFieldDiff（changes[]）

| 字段 | 类型 | 说明 |
|---|---|---|
| `field` | string | 字段名（quantity/uom/…） |
| `left` / `right` | any | 原始值 |
| `normalized_left` / `normalized_right` | any | 归一化值 |
| `severity` | string | 严重度（major/minor/info） |

---

## 4) UI 表格字段对照（MetaSheet 前端）

> 文件：`apps/web/src/views/PlmProductView.vue`

### 4.1 新增/删除（Added/Removed）

| UI 列 | 取值逻辑 | 来源字段 |
|---|---|---|
| 层级 | `entry.level` | `BOMCompareEntry.level` |
| 父件 | `entry.parent` 优先，否则 `entry.path[0]` | `parent` / `path` |
| 子件 | `entry.child` 优先，否则 `entry.path[-1]` | `child` / `path` |
| 数量 | `getCompareProp(entry,'quantity')` | `entry.line.quantity` → `entry.properties.quantity` |
| 单位 | `getCompareProp(entry,'uom')` | `entry.line.uom` → `entry.properties.uom` |
| Find # | `getCompareProp(entry,'find_num')` | `entry.line.find_num` → `entry.properties.find_num` |
| Refdes | `getCompareProp(entry,'refdes')` | `entry.line.refdes` → `entry.properties.refdes` |
| 生效 | `formatEffectivity(entry)` | `entry.properties.effectivity_from/to` 或 `entry.properties.effectivities` |
| 替代件 | `formatSubstituteCount(entry)` | `entry.line.substitutes` / `entry.properties.substitutes` |
| Line | `entry.line_key` + `entry.relationship_id` | `line_key` / `relationship_id` |

> 注意：生效/替代件需要 `include_effectivity` / `include_substitutes` 为 true 才会有数据。

### 4.2 变更（Changed）

| UI 列 | 取值逻辑 | 来源字段 |
|---|---|---|
| 层级 | `entry.level` | `BOMCompareChangedEntry.level` |
| 父件 | `entry.parent` / `entry.path[0]` | `parent` / `path` |
| 子件 | `entry.child` / `entry.path[-1]` | `child` / `path` |
| 严重度 | `entry.severity` 或从 `changes[]` 最高级别推断 | `severity` / `changes` |
| 变更项 | `changes[]` 渲染 diff 列表 | `BOMCompareFieldDiff` |
| 生效 | `formatEffectivity(entry)` | **注意：默认为空**（变更条目不含 properties） |
| 替代件 | `formatSubstituteCount(entry)` | **注意：默认为空**（变更条目不含 properties） |
| Line | `entry.line_key` + `entry.relationship_id` | `line_key` / `relationship_id` |

> 变更条目的 “生效/替代件” 目前不直接展示（entry 无 properties），变化内容以 `changes[]` 为准。

---

## 5) BOM Compare 字段清单（来自 Schema）

来自 `GET /api/v1/bom/compare/schema`：

| Field | 默认严重度 | 归一化规则 | 描述 |
|---|---|---|---|
| `quantity` | major | float | BOM 数量 |
| `uom` | major | upper-case string | 单位 |
| `find_num` | minor | trimmed string | Find # |
| `refdes` | minor | sorted unique list | Refdes |
| `effectivity_from` | major | ISO datetime string | 生效起 |
| `effectivity_to` | major | ISO datetime string | 生效止 |
| `effectivities` | major | sorted tuples(type,start,end,payload) | 生效性记录 |
| `substitutes` | minor | sorted tuples(item_id,rank,note) | 替代件列表 |

> MetaSheet UI 会优先使用 Schema 中的 label/normalized/severity 作为 “字段对照清单”。

---

## 6) Line Key 规则（摘要）

来自 Yuantus `bom_service.py`：

- `child_config`：`parent_config_id::child_config_id`
- `child_id`：`parent_id::child_id`
- `relationship_id`：`relationship_id`（fallback 为 parent/child）
- `child_config_find_num`：`parent_config_id::child_config_id::find_num`
- `child_config_refdes`：`parent_config_id::child_config_id::refdes`
- `child_id_find_num`：`parent_id::child_id::find_num`
- `child_id_refdes`：`parent_id::child_id::refdes`
- `child_config_find_num_qty`：`parent_config_id::child_config_id::find_num::quantity`
- `child_id_find_num_qty`：`parent_id::child_id::find_num::quantity`
- `line_full`：`parent_id::child_id::find_num::refdes::effectivity`（含生效 key）

---

## 7) UI 显示 / 导出注意事项

- CSV 导出复用表格字段，顺序与 UI 保持一致。
- `compare_mode` 会自动设置 `line_key + include_relationship_props`，优先级高于手动输入。
- `include_relationship_props` 影响 `changes[]` 的字段集合（未包含的字段不会参与比较）。
- 生效性与替代件需要显式开启 `include_effectivity/include_substitutes` 才会输出。

---

## 8) 快速验证建议（可选）

```bash
curl -s -X POST http://127.0.0.1:7788/api/federation/plm/query \
  -H 'content-type: application/json' \
  -d '{
    "operation":"bom_compare",
    "leftId":"<LEFT_ID>",
    "rightId":"<RIGHT_ID>",
    "lineKey":"child_config",
    "maxLevels":6,
    "includeSubstitutes":true,
    "includeEffectivity":true,
    "includeRelationshipProps":["quantity","uom","find_num","refdes","effectivity_from","effectivity_to"]
  }'
```

