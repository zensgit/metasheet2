# Global History — T2b filters slice 开发与验证 MD

> 对应 /goal「完成余下所有的开发…给验证MD」中 owner 指定「**T2b 只读历史中心增强，可直接开发**」的一项。
> **范围 = T2b 的 filters 子刀（read-only，在已 ratify 的 MVP 范围内，不 gated）**：时间区间 + sheet 范围 +
> 字段筛选。T2b 余下两子刀（可见数据搜索、cursor 分页）需新增后端，作为后续命名子刀（见 §4）。

## 1. 交付

| 件 | 内容 |
|---|---|
| 后端 | 历史投影 `loadHistoryBatchSummaries` 新增 `fieldId` 筛选——**post-mask**（在 `visibleFields` 上判定）：仅返回该字段对当前 actor **可见**地变更过的批次。`from`/`to`/`sheetId` 后端早已支持（FE 此前未接）。events 路由透传 `fieldId`。 |
| 前端 | `HistoryCenterModal` 新增：时间区间（from/to 日期输入）、字段下拉（`:fields` 由 workbench 传当前表可读字段）、「全部表」范围开关（默认当前表）。`useHistoryCenter` + client 透传 `from`/`to`/`fieldId`。 |

## 2. 关键安全属性：字段筛选 LEAK-FREE（post-mask）

字段筛选在 **post-mask 可见字段集**上判定（`if (fieldId && !visibleFields.has(fieldId)) continue`），不是 raw `changed_field_ids`。后果:被 `field_permissions` 拒读的字段**永不在** `visibleFields` 里 → 按它筛选 → **0 批次**。actor 因此**无法**用「按字段 X 筛选」反推「哪些批次动过隐藏字段 X」。这与 #2968 的 LOCK-3 边界一致(字段不出现在 filter/detail/count)。

## 3. 验证

- backend `tsc --noEmit` **0**；web `vue-tsc -b` **0**。
- **真库 events goldens 8→10**：新增「字段筛选返回触及可读字段的批次」+「**字段筛选 leak-free**：按被拒字段筛选返回 0 批次」。完整历史套件 **48/48**（events 10 + grant 15 + reveal 13 + log 6 + taint 4）。
- **Mutation check**：把字段筛选改成 raw/pre-mask（`g.some(r => r.changed_field_ids.includes(fieldId))`）→ leak-free golden **失败**（被拒字段命中、批次泄漏）→ 证明 post-mask 放置 load-bearing。
- FE `multitable-history-fe.spec.ts` **5/5**：`load` 透传 `from`/`to`/`fieldId`（连同 actor/source/action）。
- 无迁移；FE 改动经 multitable-web-guard 覆盖（触发路径含 HistoryCenterModal/useHistoryCenter/spec；vue-tsc 覆盖 client + workbench）。

## 4. T2b 余下子刀（read-only，未建；各需新增后端，命名 follow-up）

- **可见数据搜索**（按可见记录标题/数据搜历史）——需新增后端 data-search 参数，且搜索面必须只命中 actor 可读的记录/字段（同 LOCK-3 边界,设计时单列)。
- **cursor 分页**——当前后端是 offset/limit；cursor 需新增后端游标，且要保持 LOCK-3「total 为 post-filter」语义。
- 字段下拉目前取**当前表**可读字段；「全部表」范围下的跨表字段筛选 UX 可后续细化。
