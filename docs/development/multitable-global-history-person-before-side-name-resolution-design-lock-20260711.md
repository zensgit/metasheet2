# Global History — person diff before-side 名称解析 — MINI DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — docs-only；owner ratify 前零实现授权。R11 closeout 项（owner R11 directive 明列为收尾小设计项）。R9/R10 携带残差（「person diff before 侧缓存 miss 回退 raw id」）的正式设计。
- **解锁词**：owner 对本文的明确点头（如「ratify person 名称解析」+ 选项）。
- **难度/分派建议**：小（一处投影 map + FE 优先序 + wire shape-lock）→ Sonnet 5 建 + 对抗审。

## §1 问题（对 origin/main 核验）

History Center 批次 diff 里，person（人员）字段的值 = `userId[]`。FE `formatFieldDisplay`（field-display.ts person 分支，`byId.get(id) || id`）把每个 userId 经 `personSummaries`（`{id, display}[]`）解析为显示名，缺则**回退 raw userId**。服务端批次详情端点（univer-meta.ts:8252-8253）**已在用** `resolveUserDisplayNames`（user-display.ts:13）解析 `actorName`——本设计的 `personNames` 与它同源、同端点、零新往返。`HistoryBatchChangesList.formatDiffValueFor`（HistoryBatchChangesList.vue）给 person 传的 `personSummaries = props.personSummaries?.[c.recordId]?.[fieldId]` = grid 已抓取的**当前记录当前单元格**缓存。

- **关键区分（与 link 侧 owner P2 不同型）**：person 是**按 value 逐 id 映射**（每侧渲染各自的 userId），故**没有** link 侧「有 summaries 就无视 value、两侧同名单」的 bug——`linkSummariesForSide` 那套值序过滤对 person 不适用也不需要。
- **真实残差**：diff 的 **before 侧** userId 可能是**已从当前单元格移除**的人——不在当前单元格缓存里 ⇒ 回退 raw `userId`（一串不可读 id）。after 侧（=当前值）通常在缓存里，正常显示。即：person 历史 diff 的「谁被移除」只显示 id，不显示名字。

## §2 约束（不可绕）

1. person 字段值**已受 field_permissions 掩码**：若该 person 字段对 actor 不可读（layer-2/3），其值已在服务端投影里被 `filterDataByAllowedFields` 丢弃——before/after 都不含任何 userId。故本设计**只对已可见（post-mask）的 person 单元格里的 userId 解析显示名**，不新增任何字段值披露。
2. userId 本身已在可见 payload 里（before/after 的 person 值）——把它解析成 display name 是**目录级信息**，不是该字段值的新泄露。但 display name 解析必须复用既有目录可见性口径（`resolveUserDisplayNames`，与批次详情 `actorName` 同源），不得旁路。
3. `inactive`（停用用户）标记须保留（PersonSummary.inactive 语义，2c-S4）。

## §3 选项

| 选项 | 内容 | 代价/问题 |
|---|---|---|
| **A（推荐）** 服务端 `personNames` 随批次详情下发 | `loadHistoryBatchDetail` 顺路输出 `personNames: { [userId]: string }`，覆盖批次里**已可见 person 值**（before/after，post-mask）出现的所有 userId，用**批次详情端点已在用的** `resolveUserDisplayNames` 解析（与 `actorName` 同源）。FE person 渲染的 before 侧优先该 map、缺则单元格缓存、再缺 raw id | response-shape 增量=两侧 shape-lock；与 all-tables-B 的 `fieldNames` 完全同构（单一真源，零新端点）；需先枚举 payload 里的 person 字段（type='person' 且 refKind='user'）再收集其 before/after 的 userId |
| B FE 目录端点补抓 | FE 对缺失 userId 调目录端点补显示名 | N+1/额外往返；两处真源漂移；person 目录可见性口径要在 FE 复刻 |
| C 维持 raw-id 回退 | 现状 | before 侧「谁被移除」永远只显示 id |

## §4 建议

**A**。与 all-tables-B 的 `fieldNames`（#4119）同构：批次详情投影再顺路输出一个 masked/directory-resolved 的 `personNames` map，FE 优先序 = personNames map（before 侧解已移除的人）→ 当前单元格缓存 → raw id。单一真源，零新端点，无 flag（只读目录元数据）。

实现要点（ratify 后才排）：
- 投影层：枚举批次 changes 里 **type='person'（refKind='user'）** 的**可见**字段，收集 before/after 值里的 userId 集合，`resolveUserDisplayNames` 一次解析（非 N+1），输出 `personNames: { [userId]: displayName }`（含 inactive 标记？见 OD-P2）。
- 只覆盖已可见 person 单元格出现的 userId——denied person 字段的值已被掩码丢弃，其 userId 本就不在 payload。
- FE：`formatDiffValueFor` 的 person 分支，before 侧解析优先 `personNames`；after 侧行为不变（当前单元格缓存已够）；两侧最终回退 raw id 不变。
- Goldens：realdb——一条 person 字段 before 有「已移除」userId、after 没有，断言 `personNames` 含该 userId 的显示名且渲染出名字（非 raw id）；denied person 字段的 userId 绝不出现在 `personNames`（LOCK-3 邻测）。FE spec——before 侧优先 personNames、缺则缓存、再缺 raw id。wire shape 两侧同步。

## §5 Owner 决策点

- **OD-P1**：选项 A/B/C。
- **OD-P2**：`personNames` 是否携带 `inactive` 标记（推荐：携带，与 PersonSummary 一致，diff 里停用用户仍标注）——若携带则 map 值改为 `{ display, inactive? }` 而非裸 string。
- **OD-P3**：是否需要 flag（推荐：否——只读目录元数据，与 all-tables-B `fieldNames`、`actorName` 同级，无 flag）。

## §6 出界（如实）

- 非 person 的历史 diff 名称解析（field 名=all-tables-B 已解，#4119；link 记录标题=既有 linkSummariesForSide/pickRecordTitle）不在本文。
- 已删/停用用户的目录解析仍走既有 `resolveUserDisplayNames` 语义——本文不改目录可见性规则。
