# Global History — all-tables 模式跨表字段元数据 — 决策 one-pager (PROPOSED)

- **Status**: PROPOSED 决策文档；owner ratify 前零实现授权。R10 gate-front 工件（R9 UX 审计携带项）。
- **现状**：History Center 的 `fields` prop 只承载**活动表**（workbench 的 `historyVisibleFields`，layer-2∩layer-3 已修）；all-tables 模式下其它表的批次 diff 标签/筛选回退为原始 field id。R9 已如实保留该回退。

## 约束（不可绕）

R9 #4007 的教训直接适用：**字段名本身是两层可掩码信息**（layer-2 property-hidden + layer-3 per-subject RBAC，均按「该字段所在表」评估）。任何跨表字段名供给必须对**每张表**做两层过滤——否则 all-tables 模式变成字段名侧信道。

## 选项

| 选项 | 内容 | 代价/问题 |
|---|---|---|
| A 客户端逐表拉取 | FE 对批次涉及的每张表调 fields+field-permissions 再本地求交集 | N 张表 N×2 请求;两层推导逻辑（permission-derivation.ts）在服务端,客户端复刻=两处真源漂移风险——正是 R9 P1 的病根 |
| **B（推荐）** 服务端掩码字段名随批次详情下发 | 批次详情投影已按表计算 per-sheet allow-set（值掩码用的同一套）;顺路输出 `fieldNames: {sheetId: {fieldId: name}}`,只含**该 actor 在该表两层可见**的字段 | response-shape 增量=两侧 shape-lock 全扫+LOCK-3 goldens;单一真源,零新端点 |
| C 维持 id 回退 | 现状 | 跨表可读性欠账永挂 |

## 建议

**B**。值掩码与名字掩码同源同 allow-set（`filterDataByAllowedFields` 的集合就是名字白名单），不引入第二套推导。实现要点（ratify 后才排）：投影层输出仅覆盖 payload 实际涉及的表；**隐藏字段名绝不出现**（golden：property-hidden 与 RBAC-denied 各一，跨表各一）；FE `diffFieldName` 优先 `fieldNames` 映射、活动表仍走 props（不回归 #4007）；两侧 wire shape 测试同步。

- **解锁词**：owner 点头选项（A/B/C）。
