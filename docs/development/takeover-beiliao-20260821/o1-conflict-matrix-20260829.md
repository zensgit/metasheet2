REVIEW-BASE: 69bc848e9698d06fe7f79ea99d55627d1626da91

> **2026-08-29 入库版**:自声明基线 `b6c0241d6`,已对当前 `origin/main=69bc848e9` 复核——仅 `stock-preparation-table-actions.cjs` 行号漂移(内容不变),**并修正 Codex 复核指出的三处影响 owner 决策的错误 E1/E2/E3**(见 §1/§2/§5 就地标注)。此文入库替代 Downloads 副本(跨机公约:Downloads 不构成送达)。

# O1′ conflict matrix —— 草案（供 owner 裁决，未预决）

- 状态：**DRAFT / 待 owner 裁决**。HG v1.2 §5.5 明文「本文不预选 O1′」，故本文只**呈现**选项与代价，不作决定。文末每个决策行的 “建议” 一律为 **reviewer recommendation（可被推翻）**，不是 pre-decision。
- 代码基线：`C:\Users\zhou\Downloads\dev\metasheet` @ `origin/main` = `b6c0241d6`（confirmation-decision ledger 第一刀已合入）。所有 `file:line` 均指该提交。
- 规范基线：`metasheet-data-integration-human-governance-solution-v1.2-20260828.md` §5.5（:210-237）、Decision Register `O1′`（:586）、`T-HUMAN-WALL`（:585）。
- values-free：全文只出现字段 id、令牌、计数与文件行号，无任何客户业务值。

---

## 1. 结论摘要

| 项 | 数 |
|---|---|
| planner 可发出的 `conflictSummary.type` 令牌总数 | **不是封闭 13**（见 E2 校正）：8 hold + 5 非 hold **只是 planner 直接命名的**，但 `c2_row_error`(:1037)是 `rowError.type || 'c2_row_error'` 无校验透传,BOM expander 实发 10 种(ambiguous_component / ambiguous_path / invalid_quantity / missing_bom_id / missing_child_bom / missing_component / missing_component_source_id / missing_order_id / missing_path / missing_path_id)+ ext-mapping coercion 码 |
| carry policy 可发出的 hold 型 conflict type | **3** |
| **构成 O1′ 矩阵行的 hold 类型合计** | **11** |
| duplicate 子级 held reason 子词表 | 6 |
| carry `NO_CARRY` reason 子词表 | 3 |
| 相邻但**不属于本线**的 MVP 确认词表（material match / unit rule） | 5 + 6 |

六轴中 **`canonical_row_exists` 对 11 行全部代码可判定**；`duplicate_expanded_key` 一行六轴均代码可查,但其 `canonical_row_exists` **不是"否"而是"皆可"**(E1);其余 10 行的第 3～6 轴为 ⟨O1′⟩ owner-open（但受第 5 节所列代码硬约束限定）。

---

## 2. 真实冲突词表（closed vocabulary，非推测）

### 2.1 planner hold 型（`decision = manual_confirm`），8 个
`plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs`

| # | conflict type | 发出点 | 是否带 `idempotencyKey` |
|---|---|---|---|
| 1 | `missing_expanded_idempotency_key` | :1025 | **否**（匿名） |
| 2 | `missing_existing_idempotency_key` | :1031 | **否**（匿名） |
| 3 | `c2_row_error`(**无校验透传;实际是 10 种 BOM expander 类型 + coercion 码的伞名,非单一冲突——E2**) | :1037 | **否**（匿名） |
| 4 | `duplicate_expanded_key` | :1053 | 是 |
| 5 | `duplicate_existing_key` | :1065 | 是 |
| 6 | `add_missing_disabled` | :1083 | 是 |
| 7 | `lineage_mismatch` | :1094 | 是 |
| 8 | `component_identity_conflict` | :1106 | 是 |

hold 决定由 `manualConfirm()` :921-929 构造，**既无 `record` 也无 `patch`** —— hold 永不触碰 canonical 行。

### 2.2 planner 非 hold 型（写决定/信息），5 个
`add_missing` :941、`plm_system_refresh` :956（canonical 写入 :948）、`unchanged` :964、`missing_from_plm` :978（canonical 写入 :971）、`already_inactive` :1129。
这 5 个经 `runPatch()` :899-906 落入**系统段** `lastPlmConflictSummary`（该列属 `REQUIRED_SYSTEM_FIELDS`，`stock-preparation-templates.cjs`:16-26，**非** human band）。因此 `lastPlmConflictSummary` 结构上**无法承载 hold**，也无法承载人工决定。

### 2.3 `duplicate_expanded_key` 的 held reason 子词表，6 个
`heldReasonForDuplicatePolicy()` :663-667 与 `resolveDuplicateExpandedRows()`：
`default_hold`、`source_correction_required`、`unsupported_policy`（:69 catch-all）、`clean_to_collision_requires_review` :814、`missing_stable_discriminator` :827、`non_unique_resolved_key` :845。
策略词表 `DUPLICATE_EXPANDED_KEY_POLICIES` :52-59 冻结 6 个令牌；仅 `keep_multiple_rows`（:64）能解成写决定，`merge_quantity` / `select_representative` / `skip_selected` 由 :688-690 派生为 `UNIMPLEMENTED`，在选择边界被拒。

### 2.4 carry policy hold 型，3 个
`plugins/plugin-integration-core/lib/stock-preparation-carry-policy.cjs`:96-100
`carry_ambiguous_component_source`（1→N 歧义，:288）、`carry_reattach_requires_confirm`（:298）、`carry_conflicting_source_content`（同键人列内容分歧，:426）。
`NO_CARRY` reason :90-94：`same_key_update_preserve`、`no_source_match`、`no_human_context`。
**关键事实：`planCarry` 目前无任何生产调用方**（`git grep planCarry origin/main` 仅命中自身与测试）。该模块为纯未接线库，3 个类型属**潜在词表**。

### 2.5 相邻词表（另一条线，勿混入）
`stock-preparation-material-match.cjs`:12-18 `MATCH_STATUSES` 5 个；`stock-preparation-unit-rule-match.cjs`:18-25 `HELD_REASONS` 6 个。属 MVP 九表确认线（`stock-preparation-confirm-writes.cjs`），ledger 头部第 2 条已声明本线**不使用**九张冻结卫星表。

---

## 3. 六轴矩阵

图例：**[C]** = 代码已定；**⟨O1′⟩** = owner 待选。
轴 3～6 分别为 `human_value_entry_surface` / `planner_consumption_rule` / `final_write_band` / `supersede·resume`。

| conflict type | canonical_row_exists **[C]** | 录入面 | planner 消费 | 最终写入段 | supersede·resume |
|---|---|---|---|---|---|
| `duplicate_expanded_key` | **存在/不存在皆可(E1 校正)**——`:806 if (existingKeyed.has(key))` 恰在 canonical 行**存在**时触发且**不重分类**(:1053 仍发 `type:'duplicate_expanded_key'`;`clean_to_collision_requires_review` 是 held **reason** 非 type)。故 Q1/Q2 对唯一已实现类**未干净分离**;canonical 行存在的组做 `keep_multiple_rows` 确认会每次 replan 被重 hold | **[C]** ledger 行 human band `resolutionAction`；值列被拒（`CONFIRMATION_DECISION_VALUE_ENTRY_UNIMPLEMENTED`） | **[C]** `loadConfirmedDuplicatePolicyReview` :752-772 → table-scope policy → `computeDryRun` 重算一次（`stock-preparation-table-actions.cjs`:978-994） | **[C]** ledger 自身 human band；canonical 仅得 `add` 决定的系统段 | **[C]** 指纹变则旧行置 `superseded` 并开新 `pending`（:559-568）；readback 只认指纹一致者 |
| `duplicate_existing_key` | **是（≥2 行同键）** | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `lineage_mismatch` | **是** | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `component_identity_conflict` | **是** | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `add_missing_disabled` | **否** | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `missing_expanded_idempotency_key` | 无法寻址 | ⟨O1′⟩ **受限**¹ | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `missing_existing_idempotency_key` | 行在但无键 | ⟨O1′⟩ **受限**¹ | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `c2_row_error` | 展开前，无 canonical | ⟨O1′⟩ **受限**¹ | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `carry_ambiguous_component_source` | **否**（新 ADD 行；carry 源为 `active===false` 旧行） | ⟨O1′⟩ **未接线**² | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `carry_reattach_requires_confirm` | **否** | ⟨O1′⟩ **未接线**² | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |
| `carry_conflicting_source_content` | **否** | ⟨O1′⟩ **未接线**² | ⟨O1′⟩ | ⟨O1′⟩ | ⟨O1′⟩ |

¹ 这 3 类 hold **不带 `idempotencyKey`**，而 `stableDecisionKey = stableHash('stable-key', {projectNo, rowIdentity, conflictType})`（`stock-preparation-confirmation-decisions.cjs`:400）以 `rowIdentity` 为必需；:392-399 对本类缺键 hold 直接 422 拒绝。**owner 选任何"行绑定录入面"之前，必须先为这 3 类定义身份**，否则该选项在代码上不成立。
² carry 三类须先决定是否接线 `planCarry`；未接线前它们不会出现在任何 plan 中，矩阵行为纯设计承诺。

---

## 4. 五个 O1′ 决策行

> 每行末的 **建议** 均为 reviewer recommendation，供 owner 参考与推翻。

### Q1 已有 canonical 行由用户在哪些 human-owned 列填值

| 选项 | 代价 | 触及的不变量 |
|---|---|---|
| **A** 开放全部 16 列 human band（template 8 列 `HUMAN_PRESERVED_FIELD_IDS` `templates.cjs`:28-37 + 客户包 `ext_` 人列） | **S** —— 人直接编辑 sheet 不经 apply-writer，无新表、无新写路径 | 扩大 T-3「列权限已建立」将来须覆盖的列集合（见 §6 校正） |
| **B** 仅开放 template 8 列，`ext_` 人列须由 pack 场景显式声明后逐步开放 | **S/M** —— 需在 pack 安装面加开放清单 | 与 `derivePackAwarePlmWritableFields` 的 pack-aware band 判定需保持一致 |
| **C** canonical 不填，值只落 ledger `resolvedValue`/`resolvedAuxValue`，canonical 仅作投影 | **M/L** —— 需定义投影读面 | §5.5 候选 3 明禁「机器把人工值复制进 canonical human band」，C 若含回写即越界 |

**建议（reviewer）**：A —— canonical human band 本就是人的产权段，T-HUMAN-WALL 拦的是**机器**写入，人直接编辑不触墙。

### Q2 新 held 行在进入 canonical 前在哪里填值

| 选项 | 代价 | 触及的不变量 |
|---|---|---|
| **A** 填在 ledger：`resolvedValue` / `resolvedAuxValue` 已在 schema（`templates.cjs`:631-632），当前 confirm 主动拒绝 | **S** —— 解除 `CONFIRMATION_DECISION_VALUE_ENTRY_UNIMPLEMENTED` 拒绝 + 定义消费规则即可，**无 schema 迁移**（converged shape 已预留） | ledger 从「决定账本」变为「值账本」，values-free 证据面须重新界定 |
| **B** 机器先建 system-only 占位行（见 Q3），人在 canonical 上填 | **M** —— 需占位行生命周期与「未填 vs 差异」判别 | 占位行进入 canonical 即计入业务事实表 |
| **C** 复用 `plm_stock_preparation_exception_confirmation` 卫星（`templates.cjs`:842-874，人列 `resolutionAction`/`resolvedBy`/`resolvedAt`） | **M/L** | **直接冲突**：ledger 头部第 2 条声明九张冻结 MVP 卫星表不用于本线；且该表**无 fingerprint 列**，无法表达 revision 绑定 |

**建议（reviewer）**：A —— 唯一零迁移、且已有指纹绑定与 supersede 语义的落点。

### Q3 是否允许只含 system-owned band 的占位行

| 选项 | 代价 | 触及的不变量 |
|---|---|---|
| **A** 允许（**即现状**：`makeAddDecision` :931-943 本就只写 plm band 并 `assertNoHumanFields`） | **S** —— 零改动 | canonical 出现人列全空行；T-2 对账引擎（尚未实现）须能区分「未填」与「差异」 |
| **B** 不允许，人列未备齐不得进 canonical | **S/M** —— 需在 ADD 前置人工步骤，改变现有 add 语义 | 与 `add_missing` 现行自动写入直接冲突 |
| **C** 允许但 `active=false` 直至人工填值 | **M** | `active===false` 已是 carry policy 的**carry 源**语义载体（carry-policy 头部 :50-53），语义重载有风险 |

**建议（reviewer）**：A —— 现状即此，改动成本最低；配套要求是 T-2 口径显式区分空值与差异。

### Q4 人工值、decision、fingerprint/revision 的绑定位置

| 选项 | 代价 | 触及的不变量 |
|---|---|---|
| **A** 全绑 ledger 行：`stableDecisionKey` :400 → `inputFingerprint` :401（含 `sourceRevision`）→ `decisionId = stableHash('revision-key', {stableDecisionKey, inputFingerprint})` :407 | **S** —— **已实现** | 无新增；但需为 §3 脚注 ¹ 的 3 类匿名 hold 补身份 |
| **B** 值绑 canonical 行、decision 绑 ledger（双绑） | **M** —— canonical 需新增 fingerprint 列或旁表 | canonical 承载 revision 语义后，T-3 provenance 与列权限判据都要扩 |
| **C** 每字段一条 append-only 修订行（先例 `approval_form_field_revisions`，`packages/core-backend/src/db/migrations/zzzz20260817130000_create_approval_form_field_revisions.ts`：`before_value`/`after_value` JSONB + `actor_id` + `audit_record_id` 序数） | **L** —— 新表 + 新读面 + 掩码语义 | 该先例**以 JSONB 存业务值**，与本线 values-free 证据纪律相反，需专门隔离 |

**建议（reviewer）**：A —— 三段绑定已在合入代码中闭环，B/C 都要求 canonical 或新表承担 revision 语义。

### Q5 指纹变化后值、决定与任务如何 supersede

| 选项 | 代价 | 触及的不变量 |
|---|---|---|
| **A** 沿用现有 supersede 语义 + **补 4(a) 修复** | **S~M —— 部分已实现,有缺陷** | **E3 校正:非"已实现"。** 4(a) 实测:指纹**返回**(A→B→A)时旧 superseded 行走 exact-skip,**不 supersede、不开新 pending**,该 stableDecisionKey 永久不可确认——`decisionId=hash(stableKey,fingerprint)` 复现旧 id。fail-safe(hold 恒立)但需 reopen 修复(~15-20 行)。成本不止"重复工作量" |
| **B** 指纹变化时保留人工值并自动 resume 到新 decision 行 | **M/L** | **落在 §5.5 候选 3 禁区**：自动搬运人工值即「机器复制人工值」；且需判定「旧值对新输入仍适用」的语义 |
| **C** 指纹变化即冻结，要求人重填（显式，无自动 resume） | **S** | 与 A 实际同效，但须明确 UI 提示，避免被读成静默丢失 |

**建议（reviewer）**：A —— 唯一 fail-safe 方向（陈旧确认只会让 hold 继续成立，永不误放行）。
**依赖提示**：HG v1.2 :349 就「同 subject 新 generation」另给 O1′ 二选一（A 原子 supersede / B 发布前固定码拒绝），T-E2 在其落入 Decision Register 前不得 Ratify；Q5 的选择须与之一致。

---

## 5. 已被代码排除的选项（owner 不必再权衡）

1. **机器把人工值写进 canonical human band —— 结构性不可能。**
   `stock-preparation-apply-writer.cjs`:239-247 `assertNoHumanFields` 对 human 列**抛错（fail-closed，非静默过滤）**，add 路径 :373、patch 路径 :396 各调一次；:518-527 用 `derivePackAwarePlmWritableFields` 令该墙**pack-aware**，连客户包 `ext_` 人列一并拒绝。planner 侧 :879-888 有同名同语义的第二道墙。
2. **ledger 模块越权写 canonical —— 结构性不可能。** ledger 头部第 4 条：该模块**不持有**指向 canonical sheet 的 records-API 能力，写入一律经 `createTargetScopedRecordsApi` 钉死自身 sheetId。
3. **用 `lastPlmConflictSummary` 承载人工决定 —— 不可行。** 该列属系统段（§2.2），且 hold 决定根本不产生 patch。
4. **未实现令牌静默入库 —— 已被拒绝式设计排除。** `accept_current` / `manual_hold` 在 `IMPLEMENTED_RESOLUTION_ACTIONS` 之外，选择即 `CONFIRMATION_DECISION_ACTION_UNIMPLEMENTED` 报错；duplicate 策略同理（:688-690）。
5. **双源策略分歧不静默取胜。** `mergeTableScopeConflictPolicyReviews`（`table-actions.cjs`:722-752）在两个持久源不一致时**删除该选择**使 planner 继续 hold。

---

## 6. 需 owner 知悉的校正与未决

- **校正（引用出处）**：T-2/T-3 的**定义**不在 `mysql-migration-plan.md`，而在 `docs/development/takeover-beiliao-20260821/beiliao-production-go-live-gate.md`:116-138；该门再向 `mysql-migration-plan.md` §2(4) 取对账表与容差、取切换判据四条件。准确口径为：
  - **T-2 双轨对账零差异窗口**（:125-129）：按 `product_code` 连续 N 日零差异。**现状「对账引擎尚未实现（零可执行面）」**，故本文未把任何选项的代价挂在 T-2 的既有实现上。
  - **T-3 按项目号切换判据**（:131-134）四条件中，与 O1′ 直接相关的是**「列权限已建立」**与**「provenance 完整」**；四条**均未实现**。
  - 因此 Q1/Q3 的真实风险是**扩大了 T-3「列权限已建立」将来必须覆盖的列集合**，而非违反某条已生效的对账口径。
- 3 类匿名 hold（§3 脚注 ¹）的身份定义是 Q2/Q4 任一「行绑定」选项的**前置条件**，建议与 O1′ 同批裁决。
- carry 三类是否接线（§2.4）本身即一个未列入五问的隐含选择，建议 owner 明确「本轮不接线」或将其并入 O1′ 范围。
