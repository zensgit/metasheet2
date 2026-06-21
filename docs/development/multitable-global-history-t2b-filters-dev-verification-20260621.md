# Global History — T2b 只读历史中心增强 开发与验证 MD（filters + search + cursor）

> 对应 owner 指定「**T2b 只读历史中心增强，可直接开发**」。
> **范围 = T2b 全部三子刀（read-only，在已 ratify 的 MVP 范围内，不 gated），均已 SHIPPED 2026-06-21**：
> filters（时间区间 + sheet 范围 + 字段筛选，#2988，本 MD §1–§3）、search（可见数据搜索，#2989，§5）、
> cursor 分页（#2990，§6）。search 的候选上限截断经 `searchTruncated` 透出（§5，非静默）。

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

## 4. T2b 子刀状态

- ✅ **可见数据搜索** —— SHIPPED 2026-06-21（#2989，见 §5）。
- ✅ **cursor 分页** —— SHIPPED 2026-06-21（#2990，见 §6）。
- ⬜ **跨表字段下拉 UX**（parked，非阻塞）：「全部表」模式字段下拉目前取**当前表**可读字段；后端 post-mask 是边界（安全无碍），仅 UX 偏窄。owner 2026-06-21 确认 parked，待其决定是否打磨（graceful 标注 vs 全量跨表字段加载）。

## 5. T2b search 子刀（SHIPPED 2026-06-21）

只读历史搜索，**严格 post-mask**：投影对每个批次的**可见**记录快照按 `filterDataByAllowedFields(snapshot, allowed)` 取可读字段值，再做 lowercase-contains 子串匹配（仅值搜索，无操作符/正则/查询语言；数字/日期按字符串形匹配）。

- **匹配对象 = revision snapshot ∩ visibleFields**（不是当前 `meta_records.data`——那会重开 #2968 类漏洞且语义错；也不是 display-title——留作后续）。
- **leak-free 双轴**：行级 deny 的记录在 search 前已被 `isDenied continue` 跳过；字段级 deny 的值被 `filterDataByAllowedFields` 滤掉 → 被拒记录/隐藏字段的值**永不可搜**。
- **total 为 post-search**：不匹配的批次不计入（cursor slice 会继承「actor 经全部 filter 后可见的匹配数」语义）。
- **成本 + 截断透出（复审硬化 2026-06-21）**：搜索时才 SELECT snapshot；候选行 cap 20000。命中 cap 时**不 fail-closed**（只读搜索截断只是结果不全，无 execution-matches-preview 不变式，不照搬 T5/PV-7），但**也不静默**：API 返回 `searchTruncated: true`（连同 server `console.warn`），FE 弹窗提示「结果可能不完整，请缩小筛选」——避免「截断后被当成『无匹配』」。注意：截断时 `total` 也只是受限候选集的计数。`searchRowCap` 为可注入测试 seam（route 不设，恒用默认 20000）。
- 后端 `?q=`；FE 搜索框 → `useHistoryCenter` → client `q`。
- **验证**：events goldens 10→14（**positive control 非空过** + **field-mask leak-free** + **row-deny leak-free** + **total post-search**）；完整历史套件 **52/52**；**mutation**：把 search 改成匹配 raw snapshot → field-mask leak-free golden 失败（被拒值泄漏），row-deny leak-free 仍过（依赖 row-skip 而非字段掩码）——精确隔离两轴守卫。tsc/vue-tsc 0；FE spec 5/5。

## 6. T2b cursor 分页子刀（SHIPPED 2026-06-21 —— T2b 完整）

稳定 key-cursor（Option A，over 已过滤的批次集；`total` 保持精确 post-filter）。

- **设计抉择**：精确 post-filter `total` 需 load-all + filter——这正是高效 cursor 要避免的。owner 要「保持 post-filter total 语义」→ 选 Option A（cursor over post-filter `all`，total 不变）。买到的是**页可达**（此前 FE 写死 limit:100，第 101 条不可达）+ **并发头插下稳定**（offset 会重显边界行；key-cursor 不会）；**不**降 DB 负载（每页仍 load-all——这是 total 精确的代价；SQL 级高效需换成 `hasMore` 估算，单列为 deferred）。
- **关键正确性**：cursor 比较键必须与 `all` 的排序**字节一致**。`all` 显式 `sort(compareBatchKeyDesc)` = (createdAt DESC, **batchId DESC**)，cursor 也比这个元组；batchId 全局唯一，破 createdAt 平局——否则边界落在时间戳平局上会 skip/duplicate。cursor = opaque base64(`createdAt|batchId`)；malformed → 当首页（不崩）。offset 保留（无消费者，但移除是无谓 churn）。
- **leak**：cursor 编码的是 actor 已见批次的键，且 over 已 post-filter 的 `all` → 永不能寻址被拒批次。
- **验证**：events goldens 14→18（**limit=1 全量分页 exactly-once 无 skip/dup** + **同 createdAt 两批跨页边界仍 exactly-once = 平局 golden** + **分页中 total 恒为 post-filter** + **malformed cursor→首页不崩**）；完整历史套件 **56/56**；**mutation**：去掉 compareBatchKeyDesc 的 batchId 平局位 → 平局 golden 失败（一条 tie 批次被 skip，`expected 0 to be 1`）——证明平局位 load-bearing。FE：`loadMore` 追加（不替换）+ 透传 cursor + 复用 filters，永不抛；「加载更多」按钮（nextCursor 时显示）。FE spec 5→7；vue-tsc 0；unit 3756/3756；无迁移。

## 7. 复审硬化（2026-06-21）：search 截断透出 + ledger 对账

owner 复审 T2b 提两点（均非安全，runtime 边界不动）：

- **[P2] search 静默截断 → 透出 `searchTruncated`**：此前命中 20000 候选上限只 `console.warn`（server 端，用户看不到），结果/`total` 受限却无任何标记——「截断」会被当成「无匹配」。修法（owner 建议的最小项）：投影返回 `searchTruncated`，route 透出，client→`useHistoryCenter.searchTruncated`→modal 弹窗提示。`searchRowCap` 作可注入测试 seam（route 恒用默认）。goldens +2（route 透出 `false`；cap=1 vs 大 cap → `true`/`false`）；FE spec +1（searchTruncated 从响应透传）。events goldens 18→20；完整历史套件 58/58；FE spec 7→8。
- **[P2] stale ledger 对账**：本 PR 一并修 3 处过期记账——TODO §Scope（search/cursor 仍写「FOLLOW-UP, NOT yet built」）、MVP MD（T2b「尚未建/⬜未建」）、本 MD front-matter（「filters 子刀」）——统一改为「T2b filters+search+cursor 全部 SHIPPED #2988/#2989/#2990」。
- **[P3]**（非阻塞，parked）：「全部表」模式字段下拉仍取当前表字段——后端 post-mask 是边界，安全无碍；UX 细化待 owner 决定。
