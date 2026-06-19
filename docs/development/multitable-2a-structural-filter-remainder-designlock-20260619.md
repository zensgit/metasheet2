# 多维表 2a 视图筛选 — 结构性剩余项设计锁 (link/lookup filter-by-value · nested AND/OR groups) — 2026-06-19

> Status: **DESIGN-LOCK (待评审，不实现)。** Contract-for-review only. No runtime in this PR.
> Context: 2a (view filter operator depth) 的**纯算子扩展**部分已落 main —— set-membership `isAnyOf`/`isNoneOf` (#2932 + FE #2935) 与 relative-date (`isToday`/`isThisWeek`/`isLastNDays`/`isOverdue` 等, #2936)。本设计锁覆盖 2a 余下的**两项结构性子项**，它们不是 `evaluateMetaFilterCondition` 的纯增量，需先定数据流再实现。
> Grounding: `origin/main` @ `1a31dad91`.
> 为什么单列：这两项各自动到**筛选数据流**或**筛选数据模型**，盲改有回归面（masking/permission、既有扁平筛选向后兼容）。先锁，审过再实现。

## A. link/lookup filter-by-value（按链接/查找的**显示值**筛选）

### A.0 头号发现：链接显示值在 view-assembly 时解析，不在 `record.data` 里

`evaluateMetaFilterCondition(type, cellValue, condition)` 读的是 `record.data[fieldId]`。但 link 字段在 `record.data` 里存的是**外键 id 数组**，其**显示值** `LinkedRecordSummary = { id, display }` 由 `loadLinkValuesByRecord(...)` 在 **view-assembly 时**单独 join 外表解析（见 `univer-meta.ts` 注释 “resolved … at view-assembly time”）。lookup 字段同理（其结果同样在装配期解析，不落 `record.data`）。

**所以**：今天对 link 字段做 `is`/`contains`/`isAnyOf` 走的是 string 兜底分支，`toComparableString` 对数组对象做 `JSON.stringify` → 匹配的是**原始 JSON 噪声**（含 id、键名），`is "Alpha"` 永不命中、`contains "Alpha"` 会被 id/键名误命中。这正是要修的“按显示值筛选”缺口；它不是加一个 `case`，而是要把**已解析的 display** 喂给筛选。

### A.1 必须先定的决策

- **D-A1 — 筛选发生在管线哪一步**：
  - (a) **resolution-then-filter**：在 `loadLinkValuesByRecord` 之后、对**已装配的 display** 做内存筛选（与现有 in-memory `evaluateMetaFilterCondition` 调用点一致，但需让该调用点拿到 link summaries 而非 `record.data` 原值）；
  - (b) **filter-at-query**：把 link 显示值的匹配下推到 SQL join（性能更好，但要在 join 上表达 is/contains/isAnyOf，复杂度高、与现有内存评估器双轨）；
  - 推荐 **(a)**：复用现成评估器与算子语义，最小新面；下推留作后续性能项。
- **D-A2 — 数组语义**：link 单元是**多值**（`{id,display}[]`）。`is`/`isnot` 对多值如何定义？推荐 **per-element**：`is X` = 任一 display === X；`isAnyOf [..]` = 任一 display ∈ 集合；`contains X` = 任一 display 含 X；空链接 = 不命中（除 `isEmpty`）。
- **D-A3 — 比较用 display 还是 id**：用户筛“链接到 Alpha”是按 **display**；但 display 可重名。推荐 v1 **按 display**（与 UI 选值一致），并在设计里记重名歧义为已知项；按 id 精确筛是后续项。
- **D-A4 — masking/permission 交互**：link summary 可能被行/字段权限 mask（display 置空或省略）。**锁：被 mask 的链接值不得通过筛选泄露**——筛选只能在调用者已可见的 summaries 上进行，mask 后的值视为不命中，绝不因筛选反推出隐藏的 display。
- **D-A5 — lookup 字段**：lookup 的结果 kind 已由 `resolveEffectiveFieldType`/`parseLookupFieldConfig` 决定（string/number/...）。其值同样装配期解析 → 复用 (a) 的 resolution-then-filter，按结果 kind 套用既有标量算子。

### A.2 验证计划（审过后）

resolution-then-filter 单测：单值/多值 link 的 is/isnot/contains/isAnyOf/isNoneOf per-element 命中；空链接只被 isEmpty 命中；**被 mask 的 summary 不命中且不泄露 display**；lookup 按结果 kind 走标量算子；与既有扁平筛选/排序的回归。真实 PG 装配路径覆盖一条 link join。

## B. nested AND/OR condition groups（嵌套条件组）

### B.0 现状与缺口

今天 `MetaFilterCondition = { fieldId, operator, value }`，`filterInfo.conditions` 是**扁平数组**，顶层用单一 AND/OR 连接（automation 引擎已支持嵌套，视图筛选不支持）。2a 要的是 `(A AND B) OR (C)` 这类**树**。

### B.1 必须先定的决策

- **D-B1 — 数据模型**：扁平 `conditions[]` → 递归 `group = { conjunction: 'and'|'or', children: (Condition | Group)[] }`。**向后兼容锁**：既有扁平 `filterInfo`（无 group）必须按原语义继续工作（隐式单层 group），持久化迁移用**惰性读时归一**（读到扁平就包一层），不做破坏性迁移。
- **D-B2 — 求值递归**：评估器对 group 递归 —— `and` = 全真、`or` = 任一真、空 group = inactive（match all，沿用空筛选约定）。复用既有 `evaluateMetaFilterCondition` 作叶子。
- **D-B3 — 深度/规模上限**：防嵌套过深 DoS —— 锁一个保守的最大深度与总条件数（如 depth ≤ 5、conditions ≤ 50），越界拒绝（contract 校验）。
- **D-B4 — 权限投影**：`stripFilterValuesForUser`（现有，按 allowedFieldIds 省略 value）必须在树上递归，保持“fieldId+operator 透传、越权 value 省略”不变量；按 array-index+（fieldId,operator）匹配的现有保存校验也要适配树。
- **D-B5 — FE builder**：视图筛选 UI 加 group 嵌套（automation 已有该交互可参照实现，不复制其文案）。与并行的 #2935 filter-builder 改动需协调落点（同文件区）。

### B.2 验证计划（审过后）

求值：`(A and B) or C` 真值表、空 group=match-all、depth/规模越界拒绝；向后兼容：旧扁平 filterInfo 读时归一后语义不变；权限：树形递归的 value 省略不变量；FE builder spec。

## C. 落地

本设计锁（docs）→ 评审（先定 **D-A1 管线落点 / D-A2 数组语义 / D-A4 masking** 与 **D-B1 数据模型 / D-B3 上限 / D-B4 权限递归**）→ 实现：A（resolution-then-filter，复用评估器）与 B（递归数据模型 + 读时归一 + 评估器递归 + 上限 + 权限递归 + FE builder）各为独立 opt-in。两者皆不触碰运行时安全闸；FE 改动需与 #2935 协调落点。
