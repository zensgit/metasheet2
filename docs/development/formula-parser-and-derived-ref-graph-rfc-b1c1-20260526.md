# RFC：多维表公式解析器（B1）与统一派生字段依赖图（C1）

> Date: 2026-05-26 · 类型: **决策 RFC**（产出决定，不含实现）· Track B/C of `multitable-derived-field-borrow-plan-20260526.md`
> 上游: Track A formula 链已收口（A1 #1883 · A1.1 #1890 · A2-defense #1896 · F1 #1897）。再往下不是顺手小修，而是两个架构决策。
> 边界: K3 PoC Stage-1 锁内内核打磨；不碰 integration-core/RBAC/auth/存储；Teable `packages/*`=MIT 可改用，`apps/*`=AGPL 仅借思想。

本 RFC 记录两个拍板：**B1**（公式求值/解析怎么走）、**C1**（要不要多跳派生字段）。每条给出结论 + 翻盘条件。

> **已拍板 2026-05-27**（采纳两条建议）：B1 = 做 A2b、推迟解析器（A2b 为下一个独立 opt-in）；C1 = 暂不建（Track C 整体保持 🔒）。翻盘条件见下文各节，出现即重启对应 opt-in。

---

## B1 — 公式解析器：宏展开 vs Teable ANTLR

当前多维表 formula 求值（`MultitableFormulaEngine.evaluateField`）分两步，各有一处脆弱：

1. **抽依赖**：正则 `/\{(fld_[a-zA-Z0-9_]+)\}/g` 提取 `{fld_xxx}`（`extractFieldReferences`）。
2. **求值**：把 `{fld_xxx}` 的**字面值替换进字符串**，再 `formula/engine.ts` 的 `calculate('=' + resolved)` 求值。

三条候选（注意 A2b 是 B1a 的**伴随项**，不是替代）：

- **B1a｜只用 ANTLR 抽依赖**：用 AST visitor 取代正则 `extractFieldReferences`，求值路径不动。
- **B1b｜ANTLR 抽依赖 + 求值**：用 AST 直接对值求值，取代"字符串替换 + calculate()"。
- **A2b｜只加固宏展开**：对替换值做安全编码（引号/`{fld_`/运算符/超长），修真正在生产里的注入/转义/类型丢失问题；calculate() 与全部函数语义不动。

### 决策：**现在做 A2b，B1a 不做，B1b 推迟**（基于代码核实，非泛泛而论）

核实了两点决定性事实：

- **我们的 `{fld_xxx}` token 是不透明 ID 加花括号，正则抽取已足够稳**——B1 的"抽依赖更稳"这条收益**对我们不成立**。所以 **B1a 为了抽依赖单引一个 ANTLR 运行时不划算**。
- **真正的脆弱在"字符串替换 + 重新解析"**（字面值拼进表达式 = 注入/转义/类型丢失），这正是 **A2b** 直接修的。
- **求值与 `formula/engine.ts` 紧耦合**：`evaluateField` 完全靠 `calculate()`，其 **46 个内置函数**（SUM/IF/VLOOKUP/INDEX/MATCH/统计族…）+ Excel 错误哨兵（`#DIV/0!` 等）+ dry-run 分类 + 大量单测都依赖它。**B1b 要么对 AST 重实现这 46 个函数语义、要么换 Teable 自己的函数集 → 与现有行为的 parity 风险高，且无即时产品收益。**

> 直接回应你对 A2b 的顾虑（"若很快上解析器 A2b 会变短寿命补丁"）：**只有在 B1b 世界里 A2b 才会被丢弃。本 RFC 决定不走 B1b，所以 A2b 是耐久修复，不是短寿命补丁。**

**翻盘条件**（出现任一才重启 B1b）：① 产品要把公式能力做大（新增大量函数/类型/跨记录语义），重写求值反而比扩 `calculate()` 划算；② 决定砍掉"多维表 formula 复用网格 A1 引擎"这层耦合本身。届时 B1b 的 AST 还会顺带喂给 C1 的依赖图（见下）。

---

## C1 — 统一派生字段依赖图：要不要建 `derived_field_references`

现状：formula 有持久依赖表 `formula_dependencies`；lookup/rollup **没有**持久图（保存时即时扫 + 单层重算）。C1 = 把它泛化成统一 `derived_field_references(from_field_id, to_field_id, sheet_id, …)`，覆盖 formula+lookup+rollup，保存时按类型抽依赖 upsert（对标 Teable `field-supplement`）。

**关键：C1 本身（只建表）几乎不产生价值。** 它是契约层，只有配 **C2a（递归 CTE 求传递闭包 + 拓扑级联重算）** 和 **C3（建字段时环检测）** 才兑现。所以本次拍板核心不是"建不建表",而是 **"要不要多跳派生字段"**：
- 多跳 = lookup/rollup 能引用派生字段、或 A→B→C 传递 rollup（现状单跳、单层）。
- 要 → C1 是第一步（契约层），其后 C2a、C3。
- 不要 → C1 是死重，当前单跳模型 + A2-defense（已挡掉坏的 formula→formula）是自洽的。

### 决策：**暂不建 C1，等出现具体的多跳派生需求再启动**

没有真实客户/产品对"派生字段引用派生字段 / 传递 rollup"的诉求前，单跳模型够用，建图是提前支出。**翻盘条件**：一个具体的多跳派生场景落到需求上（届时按 C1→C2a→C3 推进；若同时在做 B1b，AST 抽依赖正好喂 C1）。

---

## 明确不做（保持冻结，各一行）

- **C2b 派生值物化**：靠近存储模型，**独立 gate**；只有要"派生再引用且不重入读"才谈，本 RFC 不解锁。
- **A2-full 记录内 formula 链拓扑**：仍冻结，除非产品先回答"链式 formula 是否做成特性"（A2-defense 已使其在后端不可达）。

---

## 已拍板结论

| # | 决策 | 结论 | 翻盘条件 |
|---|---|---|---|
| B1 | 公式解析/求值怎么走 | **做 A2b**（加固宏展开）；B1a 不做；B1b 推迟 | 公式能力要做大，或决定砍掉网格引擎耦合 |
| C1 | 要不要多跳派生字段 | **暂不建**（C1 只是手段，单跳够用） | 出现具体多跳派生需求 |

- 若 B1=A2b：A2b 是一次小的、耐久的内核打磨修复（对抗性测试覆盖注入/转义/类型/超长），可作为下一个独立 opt-in。
- 若 C1=暂不：Track C 整体保持 🔒，不动。
- 两者都不依赖对方；A2b 可单独先做。

---

## 合规
docs-only（本 PR 无代码、无测试、无迁移）。本 RFC 不含任何被复制的 OSS 源码，仅描述模式 + file:line 锚点。一切受 K3 PoC Stage-1 锁；产出是决定，下一步实现各自独立 opt-in。
