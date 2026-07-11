# Global History — all-tables 模式跨表字段元数据 — 决策 one-pager (RATIFIED — B · AS-BUILT R11)

- **Status**: **RATIFIED 2026-07-11（owner R11 directive: 「并行实现 all-tables-B」）→ 选项 B（服务端掩码 `fieldNames` 随批次详情下发）。AS-BUILT**：`loadHistoryBatchDetail`（history-projection.ts）新增 `fieldNames: { [sheetId]: { [fieldId]: name } }`，仅覆盖批次 changes 实际涉及的表与**该表 post-mask（layer-2 property-hidden ∩ layer-3 field_permissions ∩ taint）已可见**的字段——复用值掩码同一 `allowedFieldsBySheet` allow-set + 防御性 `allowed.has` 二次校验；一次 unnest-join 查询（非 N+1）。FE `HistoryBatchChangesList.diffFieldName(fieldId, sheetId)`：活动表仍走 `fields` prop（字节等价 pre-R11，field id 全局唯一故不误配），非活动表走 `fieldNames` 映射，皆无 → 原始 id。零新端点、零 schema、无 flag（只读元数据）。
- **验证**：realdb golden `multitable-history-alltables-fieldnames-realdb.test.ts`（plugin-tests.yml 白名单）——layer-2 隐藏名（表 A）+ layer-3 拒绝名（表 B）各一，跨表；whole-body 断言两个敏感名绝不出现。突变（用 pre-mask changed_field_ids 建 `fieldNames` 且去二次校验）⇒ 三断言全红。FE spec（inline-diff spec，web-guard 已覆盖）钉 props→map→id 优先序；突变（去 map 分支）⇒ 跨表断言红。
- ~~PROPOSED~~ 原始现状（保留供审计）：History Center 的 `fields` prop 只承载**活动表**（workbench 的 `twoLayerVisibleFields` — #4007 后的活动真源，layer-2∩layer-3 已修）；all-tables 模式下其它表的批次 diff 标签回退为原始 field id。**R11 后**：非活动表由服务端掩码 `fieldNames` 提供名字，隐藏/拒绝字段名绝不出现。

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

- **解锁词**：~~owner 点头选项（A/B/C）~~ **已解锁 → B（owner R11 directive 2026-07-11）**。本项出列（AS-BUILT）。
