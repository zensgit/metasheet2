REVIEW-BASE: 3f30d8eb4f27f9972b640e2d69e2c3dab2837ae5

# 匿名 hold 身份规格（O1-B，2026-08-29）

- 授权：`o1-ruling-20260829.md` 五问全 A，解锁项 3 明令「`c2_row_error` 是 ~10 种 expander 类型的伞名，身份方案须按**真实类型族**设计，不得按单一类型设计」。
- 前置：`o1-conflict-matrix-20260829.md` §3 脚注 ¹ —— 3 类匿名 hold 不带 `idempotencyKey`；`stableDecisionKey` 以 `rowIdentity` 为必需，故任何「行绑定录入面」在补身份之前**在代码上不成立**。
- 代码基线：`origin/main = 3f30d8eb4`。全部 `file:line` 指该提交。
- values-free：全文只出现族令牌、字段 id、源列名、计数、文件行号。**无任何客户业务值**；本规格定义的身份一律是 **hash**，不是明文。

---

## 0. 一句话结论

伞名之下共 **19 个真实族**：其中 **18 个**在发出点确实带有可复现的稳定上下文，本刀给它们身份并允许入账（仅 `pending`，**不新增任何 resolution 语义**）；**1 个**（无 `type` 的兜底 `c2_row_error`）结构上没有任何上下文，继续「只计数、不入账」，并带固定延期码 `ANONYMOUS_HOLD_IDENTITY_UNAVAILABLE` 出现在 run evidence 里 —— 从此是**显式延期**，不再是静默归堆。

---

## 1. 「匿名」的结构定义（不按令牌列举，按结构判定）

planner 的 `manualConfirm()`（`stock-preparation-conflict-planner.cjs`:921-929）把 `input.idempotencyKey` 原样落到决定上。八个 hold 型发出点里，`:1024` / `:1030` / `:1037` 三处**不传** `idempotencyKey`，其余五处传。

因此本规格采用的判据是结构性的，而非令牌白名单：

> **匿名 hold ≡ `decision === 'manual_confirm'` 且不带 `idempotencyKey` 的决定。**

好处：`c2_row_error` 是 `rowError.type || 'c2_row_error'` 的**无校验透传**（:1037），令牌集合本就不是封闭的（expander 将来新增一种 rowError 类型即自动多一个令牌）。按结构判定，新令牌自动落入本规格，不需要同步维护白名单——白名单漏项等于静默丢身份，是本线最不该有的失败模式。

ledger 侧今天的行为（`stock-preparation-confirmation-decisions.cjs`:407-413）：`conflictType !== 'duplicate_expanded_key'` 一律计入 `outOfScopeByConflictType` 并 `continue`，所以这三类**根本走不到** :418-426 的 422 缺键检查。矩阵 §3 脚注 ¹ 的描述在此确认无误。

---

## 2. 伞名拆解：19 个真实族与它们发出点上的真实上下文

「emitter 实附上下文」= 逐点读发出点代码后，该错误对象**实际携带**的键。凡未列出的（order id、component ref、path、record id）就是**没有**——不是没写在这里，是发出点确实没附。

### 2.1 族 A：`missing_expanded_idempotency_key`（1 族）

| 项 | 内容 |
|---|---|
| 发出点 | planner `:1023-1028`（`for (const row of expanded.missing)`） |
| emitter 实附上下文 | **循环变量 `row` 当前被完全丢弃**（`manualConfirm` 调用不传 `details`，也不传身份）。行对象本身持有 canonical lineage 列：`projectNo` / `componentSourceId` / `parentSourceId` / `path` / `depth` |
| 可达性 | 生产 expander **不可能**发出：`makeIdempotencyKey()`（`stock-preparation-bom-expansion.cjs`:438-445）是 `JSON.stringify({...})`，恒非空字符串。真实来源只有两条：large-BOM artifact 回放（`stock-preparation-large-bom-jobs.cjs`:899 从持久化 artifact 取 `rows`）与非 expander 调用方 |
| 修复面类别 | `source_data_repair` —— 无键行意味着 lineage 判别子在源侧缺失 |
| 稳定身份？ | **有**（粒度 `row`），条件见 §3.3 |

### 2.2 族 B：`missing_existing_idempotency_key`（1 族）

| 项 | 内容 |
|---|---|
| 发出点 | planner `:1029-1034`（`for (const row of existing.missing)`） |
| emitter 实附上下文 | 同样**丢弃循环变量**。行对象是 canonical 记录的 `data`——注意 **record id 已在更早一层被丢掉**：`unmapRecordFields()`（`stock-preparation-table-actions.cjs`:452-461）只回传 `record.data`，`readExistingStockPreparationRows()` :482 逐行套用。所以「用 record id 做身份」在 planner 边界上**不可得** |
| 修复面类别 | `human_disambiguation` —— 行已在 canonical 内，源侧修不了；只能由人裁定（认领 lineage 补键，或作废该行） |
| 稳定身份？ | **有**（粒度 `row`），条件见 §3.3 |

### 2.3 族 C1：expander 结构型 rowError（10 族）

发出点全在 `stock-preparation-bom-expansion.cjs`。**10 种类型分布在 12 个发出点**（`missing_component_source_id` 有三处）。

| # | 族令牌 | 发出点 | `field` 取值（源读计划列名） | `depth` | `relation` |
|---|---|---|---|---|---|
| C1-1 | `ambiguous_component` | :766 | `plan.part.idField` | 调用点 depth | — |
| C1-2 | `missing_component` | :771 | `plan.part.idField` | 调用点 depth | — |
| C1-3 | `missing_bom_id` | :800 | `plan.bomHead.bomIdField` | `parentRow.depth` | — |
| C1-4 | `missing_child_bom` | :811-815 | `plan.bomDetail.bomParentField` | `nextDepth` | — |
| C1-5 | `missing_component_source_id` | :822 / :895 / :579 | `plan.bomDetail.componentIdField` / `plan.orderDetail.componentIdField` / `plan.part.idField` | `nextDepth` / `0` / 调用点 depth | — |
| C1-6 | `missing_path_id` | :869 | `plan.pathExAttr.pathIdField` | `0` | — |
| C1-7 | `ambiguous_path` | :875 | `plan.pathInfo.idField` | `0` | — |
| C1-8 | `missing_path` | :879 | `plan.pathInfo.idField` | `0` | — |
| C1-9 | `missing_order_id` | :887 | `plan.orderHead.idField` | `0` | — |
| C1-10 | `invalid_quantity` | :406-420（`parseQuantity`），由 :835 / :904 传入 | `plan.bomDetail.quantityField` / `plan.orderDetail.quantityField` | `nextDepth` / `0` | `'child'` / `'root'` |

**逐点核对结论（载荷性事实）：这 12 个发出点没有任何一个附带 order id、component ref、path 或行序号。** 上下文只有 `{type, field, depth}`（`invalid_quantity` 多一个 `relation`）。`field` 是**冻结读计划里的源对象列名**（配置标识，不是客户值），`depth` 是整数 BOM 层深。

> 脚注（2026-09-05，W3a）：本结论描述的是 rowError 载荷，而非展开器的全部产出。W3a 在展开结果上新增了与 `rowErrors` 平级的旁路数组 `expansion.missingComponents`，只对 `missing_component` 一族携带 `componentSourceId` 等真实客户值，专供 dry-run 响应的 `missingComponents` 键（门禁 operate ∧ 已证租户，显式 opt-in）。同时新增伴生计数 `expansion.missingComponentDistinctCount`（采集端按零件号封顶后仍能报真实去重总数）。它不进 revision 哈希（`buildRevision` 里的 expansion 投影，stock-preparation-table-actions.cjs）、不进身份哈希（`ANONYMOUS_LOCUS_IDENTITY_FIELDS`，stock-preparation-conflict-planner.cjs）、不进 ledger details（同文件 `manualConfirm` 对 rowError 的 `details` 投影）、不进 evidence（`summarizeBomExpansionForEvidence`，stock-preparation-bom-expansion.cjs），身份配方与账本语义一字未动。**本脚注只给函数名、不给行号**：上表的行号是 2026-08-29 当天 main 的快照，这四处投影此后各自漂移过；核对请按函数名搜索，行号以合并后的 main 为准。

- 修复面类别：全部 `source_data_repair`。
- 稳定身份？**有，但粒度是 `locus`（错误位点）而不是行** —— 见 §4 的诚实交代。

### 2.4 族 C2：ext-mapping coercion 码（6 族）

| # | 族令牌 | 触发 | 修复面类别 |
|---|---|---|---|
| C2-1 | `SOURCE_VALUE_NOT_A_STRING` | `coerce='string'` 失败 | `pack_mapping_repair` |
| C2-2 | `SOURCE_VALUE_NOT_A_NUMBER` | `coerce='number'` 失败 | `pack_mapping_repair` |
| C2-3 | `SOURCE_VALUE_NOT_A_BOOLEAN` | `coerce='boolean'` 失败 | `pack_mapping_repair` |
| C2-4 | `SOURCE_VALUE_NOT_A_DATE` | `coerce='date'` 失败 | `pack_mapping_repair` |
| C2-5 | `SOURCE_VALUE_NOT_AN_OPTION` | `coerce='select'` 不在选项表 | `pack_mapping_repair` |
| C2-6 | `SOURCE_VALUE_SECRET_SHAPED` | 任意类型，成值疑似凭据 | `source_data_repair`（映射没错，源单元格不该进表） |

- 发出点：`stock-preparation-ext-field-mapping.cjs`:562-567 —— `{ type: coerced.reason, target, sourceColumn, expectedType }`；`stock-preparation-bom-expansion.cjs`:616 再补 `depth`。
- `target` 是 `ext_` 目标字段 id，`sourceColumn` 是源列名，`expectedType` 是 pack 推导出的类型令牌 —— **三者都是配置标识，不是客户业务值**。
- **关键落差**：planner 的 details 投影 `:1039-1043` 只转发 `field` / `depth` / `relation`，把 `target` / `sourceColumn` / `expectedType` **全部丢弃**。所以今天这 6 类 hold 的 `conflictSummary` 实际只剩 `{type, depth}`。本规格的身份配方**直接读 `rowError.*` 原始键**（`normalizeRows()` :108-114 的浅拷贝保留了它们），**不改动 details 投影**——避免动到 `conflictSummary`，因为它进 `inputFingerprint`（:428-433）。
- 稳定身份？**有**（粒度 `cell`：一个 (ext 目标列 × 源列 × 声明类型 × 层深) 位点一行账）。

### 2.5 族 C3：`c2_row_error` 字面量兜底（1 族）——**无身份**

| 项 | 内容 |
|---|---|
| 触发 | `rowError.type` 为空/缺失时 `:1037` 的 `|| 'c2_row_error'` 兜底 |
| emitter 实附上下文 | **未知**。当前 expander 的任何发出点都必带 `type`，故此分支只可能来自被篡改的 artifact、外部调用方，或将来某个只带 `message` 的错误对象 |
| 修复面类别 | 无法归类（连是哪类失败都不知道） |
| 稳定身份？ | **没有。** 没有 `type` 就没有族，没有族就没有可复现的判别子；把它入账等于开一条永远无人能对应到任何源事实的 pending 行 |
| 处置 | 保持「只计数、不入账」，但带固定码 `ANONYMOUS_HOLD_IDENTITY_UNAVAILABLE` 显式出现在 run evidence（族名 + 计数，values-free） |

### 2.6 计数

| 类别 | 族数 |
|---|---|
| A + B（无键行族） | 2 |
| C1（expander 结构型） | 10 |
| C2（coercion 码） | 6 |
| **本刀给身份并入账（pending）小计** | **18** |
| C3（无 type 兜底） | 1 |
| **结构性无身份、显式延期小计** | **1** |
| **合计** | **19** |

---

## 3. 身份规则

### 3.1 命名空间（与 `idempotencyKey` 身份**不可能**相撞）

```
ANONYMOUS_HOLD_IDENTITY_PREFIX = 'anon-hold:v1:'
rowIdentity = `anon-hold:v1:<granularity>:sha256:<hex32>`
```

不撞的**结构性**理由（不是概率理由）：真实 `idempotencyKey` 恒为 `JSON.stringify({projectNo, componentSourceId, parentSourceId, path})`（`bom-expansion.cjs`:438-445），首字符必为 `{`；`anon-hold:` 前缀不可能由 `JSON.stringify` 一个对象产生。

再加一道**双向围栏**（ledger 侧 `resolveLedgerRowIdentity`）：

| 情形 | 处置 |
|---|---|
| `idempotencyKey` 以保留前缀开头 | 422 `CONFIRMATION_DECISION_IDENTITY_NAMESPACE_VIOLATION`（伪造的匿名身份不得冒充真实键） |
| 派生身份**不**以保留前缀开头 | 同码拒绝（身份必须自证来源） |

### 3.2 hash 配方

```
hex32 = sha256(
  "stock-preparation-anonymous-hold-identity:<granularity>:v1\0"   // 域分隔前缀
  || stableStringify(context)                                       // 键序无关的稳定序列化
).hex[0:32]
```

`stableStringify` 复用 planner :489-495 既有实现（键排序），与 ledger :207-213 同语义。域分隔前缀里嵌 `granularity`，所以三种粒度即使 context 恰好相同也落到不同 hash。

### 3.3 三种粒度的 context

| granularity | 适用族 | context 键（仅收**非空**键） | 最少判别子要求 |
|---|---|---|---|
| `row` | A、B | `conflictType`, `projectNo`, `componentSourceId`, `parentSourceId`, `path`, `depth` | 除 `conflictType`/`projectNo` 外至少 1 个非空 |
| `locus` | C1（10 族） | `conflictType`, `field`, `depth`, `relation` | 除 `conflictType` 外至少 1 个非空 |
| `cell` | C2（6 族） | `conflictType`, `target`, `sourceColumn`, `expectedType`, `depth` | `target` 与 `sourceColumn` 皆非空 |

- 「非空」判据沿用 planner `isBlank()` :96-98：`undefined` / `null` / 纯空白字符串为空。**`depth: 0` 不是空**（数字 0 通过），这是一个容易写错的边界，已有专测。
- 标量一律 `String(value)` 归一后入 hash（canonical 读回可能把 `depth` 给成 `"2"` 而 expander 给 `2`），非标量走 `stableStringify`。
- 「最少判别子」不满足 ⇒ **不产生身份**，落入 §5 的延期桶。典型：一条只有 `active: true` 的空 canonical 行（既有测试 `stock-preparation-conflict-planner.test.cjs`:167 就构造了这种行）。

### 3.4 与既有 ledger 三段绑定的接法（不改配方）

派生身份**只替换 `rowIdentity` 的来源**，`stableDecisionKey` / `inputFingerprint` / `decisionId` 的配方一字不改：

```
stableDecisionKey = stableHash('stable-key', { projectNo, rowIdentity, conflictType })      // :427
inputFingerprint  = stableHash('input',      { sourceRevision, stableDecisionKey,
                                               conflictSummary, changedFields,
                                               occurrenceCount })                            // 匿名族多一个键
decisionId        = stableHash('revision-key', { stableDecisionKey, inputFingerprint })      // :434
```

`occurrenceCount` **只出现在匿名族**的 fingerprint 输入里；`duplicate_expanded_key` 的 fingerprint 输入结构与今天逐字节相同（已存在的 ledger 行不会因本刀被重新 key）。

---

## 4. 诚实交代：`locus` / `cell` 不是逐行身份

这是本规格最需要被 owner 看见的一条。

C1 的 10 族与 C2 的 6 族，身份粒度是**位点**而不是**行**：同一 `(type, field, depth, relation)` 上的 N 条错误折叠成**一条**账。

- **为什么只能这样**：§2.3 已逐点核对——发出点根本没有逐行判别子。没有的东西造不出来。要造，只能改 expander 去附 component ref / path，那是**改发出点**而不是**补身份**，且会把客户标识推进更多层，不在本刀范围。
- **为什么这仍然是可用的身份**：它稳定、可复现、可对账；「(某类错误) 在 (某源列) 的 (某层深) 上还有 N 条」本身就是一个人可以受理、可以修的真实待办。
- **数量变化不被吞掉**：`occurrenceCount` 进 `inputFingerprint`。修掉 5 条里的 3 条 ⇒ 指纹变 ⇒ 旧行 `superseded` + 新 `pending`（人必须重看）；全修完 ⇒ 冲突从 plan 消失 ⇒ 孤儿清扫（:691-718）关掉该行。**没有任何路径能让陈旧确认放行一个仍然成立的 hold。**
- **副产品**：折叠把行错误的账本行数从 O(错误条数) 压到 O(类型 × 源列 × 层深)，`MAX_DECISIONS_PER_RECONCILE = 2000`（:149）不再会被一个大 BOM 的行错误压爆。

C2 的 `cell` 粒度同理：一个 (ext 目标列 × 源列 × 声明类型 × 层深) 位点一条账 —— 这恰好就是 `pack_mapping_repair` 的**天然修复单位**（改一次映射声明，整个位点一起消失）。

---

## 5. 无身份族的处置：显式延期，不是静默归堆

| 项 | 规定 |
|---|---|
| 固定码 | `ANONYMOUS_HOLD_IDENTITY_UNAVAILABLE` |
| 触发 | ① C3（无 `type` 兜底）；② 任何匿名族在运行期不满足 §3.3 最少判别子 |
| 行为 | **不入账**（与今天一致，fail-safe 方向不变） |
| 证据面 | reconcile evidence 新增 `anonymousHoldIdentity.deferredByFamily = { <族令牌>: <计数> }` 与 `deferralCode`。**只有族名与计数**，无值 |
| 与既有 `outOfScopeManualConfirm` 的关系 | 互不重叠：后者继续只装**带键**的非首刀类（`lineage_mismatch` / `component_identity_conflict` / `duplicate_existing_key` / `add_missing_disabled`），语义不变 |

---

## 6. 消费边界（本刀**只给身份，不给放行能力**）

| 不变量 | 保障方式 |
|---|---|
| 双墙不动 | `assertNoHumanFields`（planner :879-888 / apply-writer :239-247）零改动；hold 决定本就既无 `record` 也无 `patch` |
| 不新增 resolution 语义 | `IMPLEMENTED_RESOLUTION_ACTIONS` 不变（仍只有 `keep_multiple_rows`）；`accept_current` / `manual_hold` 属兄弟刀 O1-A |
| 匿名族的账本行**永不放行任何 hold** | **结构性**：`deriveDecisionCandidates` 把匿名候选放在**独立数组**返回，只有 `reconcileConfirmationDecisions` 取用；readback `loadConfirmedDuplicatePolicyReview`（:886-907）的解构**收不到**它们。不是过滤器，是拿不到 |
| 匿名行**今天连确认都做不了** | confirm 面既有的 `conflictType !== FIRST_CUT_CONFLICT_TYPE ⇒ 409 CONFIRMATION_DECISION_ACTION_CONFLICT_MISMATCH` 检查**先于**本刀存在、本刀**未改动**。故匿名行落地形态是：**可见的 pending 队列条目，暂不可确认**。这正是「只入账 pending、不新增 resolution」的字面实现 |
| production Apply / K3 外部写 | 完全未触及 |

因此：匿名族的 ledger 行即使**被绕过 confirm 面强行置为 confirmed**（本规格的专测就构造了这种行），readback 也不会为它发出任何 policy —— 墙不依赖 confirm 面那道检查。这是 Q5-A「陈旧确认只会让 hold 继续成立」方向的严格延续。

> **复核时的落差提示**：兄弟刀 O1-A 若解除 `CONFIRMATION_DECISION_ACTION_CONFLICT_MISMATCH` 或扩 `IMPLEMENTED_RESOLUTION_ACTIONS`，**匿名族不会自动获得放行能力**（readback 拿不到它们），但「匿名行可被确认」这件事会随之成立。届时须补的是**匿名族各自的 planner 消费规则**，不是再开一次身份。

---

## 7. 对账可复现性（本刀的承重属性）

链条逐段确定：

1. 同一源状态 ⇒ expander 输出同一 `rows` / `rowErrors`（纯函数化的展开）；
2. ⇒ planner 输出同一 `derivedRowIdentity`（§3.2 的 hash 是纯函数）；
3. ⇒ 同一 `stableDecisionKey`（§3.4，配方未改）；
4. ⇒ 同一 `inputFingerprint`（同一 `sourceRevision` + 同一 `conflictSummary` + 同一 `occurrenceCount`）；
5. ⇒ 同一 `decisionId` ⇒ 第二次 reconcile 命中 :623-630 的 replay guard，**零行增长**。

分组内 `conflictSummary` 的代表性：同一身份组的成员按构造**必然携带完全相同的 `conflictSummary`**——身份 context 是 `conflictSummary` 细节的超集（`locus` 含 `field`/`depth`/`relation`，`cell` 含 `depth`；A/B 族的 `conflictSummary` 只有 `{type}`）。故取组内首条作代表与顺序无关。

---

## 8. 留给后续刀次（本规格明确**不做**）

1. **C2 的行级身份**：coercion 错误发生时 `rowResult.row.idempotencyKey` 在 `bom-expansion.cjs`:616 处**是在手的**，只是没被附上。附上即可把 C2 从 `cell` 升到 `row` 粒度。这是**改发出点**，另开一刀，须与 values-free 边界一起评审。
2. **C1 的行级身份**：需要 expander 在 12 个发出点附 component ref / path。代价更大，收益需先由现场确认（位点粒度是否已经够用）。
3. **`accept_current` / `manual_hold` 语义**：兄弟刀 O1-A。
4. **carry policy 三类**（`carry_ambiguous_component_source` / `carry_reattach_requires_confirm` / `carry_conflicting_source_content`）：本规格写作时 `planCarry` 尚无生产调用方（矩阵 §2.4），故不覆盖。**后续已接线**（执行计划 W4a/W4b + 裁决层③ stock-prep-change-adjudication-20260901.md §3.1）：planner 在 `carryPolicy` 配置 opt-in 下对每条候选 ADD 跑 `planCarry`，三类 carry hold 以**带 idempotencyKey 的 keyed 候选**入账（独立 `carryCandidates` 数组，readback 结构性拿不到，无 `duplicateGroupFingerprint`）；其确认面是 K2 carry 路由（`applyCarryViaConfirm` + `confirmCarryConfirmationDecision` 的保留 token `carry_via_confirm`），**不是**本规格的匿名身份机制——carry 行有真实 key，从不走 `anon-hold:` 命名空间，本规格的双向围栏原样成立。
