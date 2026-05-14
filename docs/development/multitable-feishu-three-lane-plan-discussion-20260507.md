# 多维表 Feishu 深水区 · 三线并行计划讨论

> Date: 2026-05-07
> Status: 讨论中（pre-execution review）
> Scope: Lane A autoNumber / Lane B Gantt deps / Lane C Hierarchy drag-to-reparent
> 上游计划: 用户提交的"Claude 三线并行开发计划：多维表 Feishu 深水区"

## 0. 本文目的

在动手前把以下 4 类问题摆桌面：

1. **当前工作树状态**与三线开发的关系（必须先解决，否则 worktree 会污染）
2. **K3 PoC Stage 1 Lock 适用性**（这批是不是被 lock 拦下的"新战线"？）
3. **6 处技术风险**（Codex review 时大概率会问，先解决能省一轮）
4. **执行节奏与并行度**（3 lane 同时开 vs 串行落地）

最后给出建议执行顺序与待确认事项清单。

---

## 1. 当前工作树状态（必须先处理）

**分支**: `codex/dingtalk-directory-return-banner-tests-20260505`，比 main 领先 1 commit (`67898d144`)

**未提交改动 = 4 条独立战线，22 文件混合**

| # | 战线 | LOC | 完成度 | 推荐处理 |
|---|---|---|---|---|
| 1 | Directory return banner / governance（匹配分支名） | +2381 | 看 doc 已写好 verification | 留当前分支，整理后开 PR |
| 2 | **Group failure alert → rule creator**（0507 头条） | +1763 | **final-handoff 已写、4 套 vitest 全绿、build 全过、probe 测试 4/4 过、scoped diff clean、secret scan 干净** | **先切 worktree commit + push 落袋，最快可发** |
| 3 | Group destination verify-before-save / validity-test history | +304 | 昨日已写 verification | 切 worktree 收尾 |
| 4 | API token manager | +312 | 局部改动 | 切 worktree 收尾 |

**额外**: 50+ 未追踪 verification doc（dingtalk 系列 0505-0507）+ 2 份新 ops 脚本 + staging-deploy SOP/migration runbook + postmortem。需归位到对应 PR。

**结论**: 三线开发开始前，根目录必须冻结。否则 worktree 内任何 `git status`、CI、build 都会被这 4 条战线污染。最低成本路径是先把战线 #2（最完整）切出去 commit。

---

## 2. K3 PoC Stage 1 Lock 适用性

Lock 原文（来自 memory 文件 `project_k3_poc_stage1_lock.md`）：

- ❌ Touches `plugins/plugin-integration-core/*` → blocked
- ❌ New 平台-化 work → blocked
- ✅ 已发布功能的 follow-up → permitted
- ✅ Pure operational hygiene / Ops/observability 打磨 on shipped features → permitted

**本批三条 lane 评估**：

| Lane | 是否触 integration-core | 是否新建平台能力 | 是否已发布功能延伸 | 判定 |
|---|---|---|---|---|
| A autoNumber 字段类型 | 否 | **是 —— 新增字段类型枚举** | 多维表 M0-M5 已发布，是 parity 深化 | 边界情况：新增 field type 严格说是平台能力扩展。**PR 描述需明确"已发布多维表的 parity 深化，非新平台能力"** |
| B Gantt dependency arrows | 否 | 否（仅 view config 扩展） | 已有 Gantt view，加新配置项 | 通过 |
| C Hierarchy drag-to-reparent | 否 | 否（复用现有 patch path） | 已有 Hierarchy view，加交互 | 通过 |

**结论**: A 介于"新建平台能力"和"已发布功能延伸"之间。建议在 PR 描述模板里写：

```
本 PR 属于多维表 M5 后 Feishu RC parity 深化（参见 docs/development/multitable-feishu-rc-todo-20260430.md）。
不触发 K3 PoC Stage 1 Lock，因为：
1. 不修改 plugins/plugin-integration-core/* 任何文件
2. 多维表内核已在 Wave 系列发布，本 PR 是字段类型扩展而非新平台
3. 不引入对接外部 ERP 的代码路径
```

否则 Codex review 时 lock 检查可能直接打回。

---

## 3. 6 处技术风险（按风险等级排序）

### 🔴 高 · A1. autoNumber 回填窗口期的并发写入

**计划原文**: "创建 autoNumber 字段时，对已有 records 按 created_at, id 回填 1..N，并把 next_value 设为 N + 1"

**问题**: 回填执行期间，若有用户在同一 sheet insert record，会出现以下任一坏情况：

- 新 record 走 `next_value` 路径分号，回填段也用 `next_value` → 号段冲突或重复
- 新 record 在回填窗口被忽略 → 漏号
- 回填读快照外的 record 被忽略 → 漏号

**建议方案**:

`CREATE FIELD autoNumber` 整个动作包在单 transaction，且第一步即取 advisory lock：

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('meta_sheet_writes:' || :sheet_id::text));
-- 1) 物化新字段 schema
-- 2) 按 (created_at, id) 回填 records
-- 3) INSERT meta_field_sequences (...) VALUES (..., :next_value := N+1)
COMMIT;
```

advisory lock key 必须和"普通 record insert"路径共用同一 key，让 record 写入在回填期间也阻塞。

**待确认**: 当前 record insert 是否已有 sheet 级 advisory lock？若无，本 PR 需同时引入。

### 🔴 高 · A2. xlsx import / 批量 insert 性能

**计划原文**: "新建 record 时在同一 DB transaction 内 FOR UPDATE 锁 sequence 行并分配编号"

**问题**: FOR UPDATE 是单行语义。xlsx import 一次 10k 行 → 10k 次 round-trip + 10k 次锁竞争。当前 import 路径若能容忍此性能，未来其他批量场景未必。

**建议方案**:

batch 路径单独走号段领取：

```sql
UPDATE meta_field_sequences
SET next_value = next_value + :batch_size,
    updated_at = NOW()
WHERE sheet_id = :sheet_id AND field_id = :field_id
RETURNING next_value - :batch_size AS start_value;
```

backend 在内存中给批次内每行赋号 `start_value, start_value+1, ..., start_value+batch_size-1`。

**待确认**: import 路径走 vitest 还是真表？10k 行端到端时间预算是多少？

### 🟡 中 · A3. Schema 缺 tenant_id

**计划原文**: `meta_field_sequences(sheet_id, field_id, next_value, created_at, updated_at)`

**问题**: metasheet2 多维表惯例是所有表 tenant_id 字段化。sheet_id 能间接 JOIN 出 tenant，但跨租户审计、按租户分区、未来 RLS 都需要直接列。

**建议**:

```sql
CREATE TABLE meta_field_sequences (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  sheet_id UUID NOT NULL,
  field_id UUID NOT NULL,
  next_value BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, sheet_id, field_id)
);
CREATE INDEX idx_meta_field_sequences_sheet ON meta_field_sequences (sheet_id, field_id);
```

注意 staging migration 已落后 prod 66 entries（参见 `project_staging_migration_alignment.md`）—— 本迁移落地前需对齐 staging。

### 🟡 中 · B1. dependencyFieldId 必须限制为 self-table link

**计划原文**: "只接受 link field"

**问题**: 多维表的 link field 可指向当前 sheet 也可指向其他 sheet。predecessor 依赖只对 self-table 有意义。如果允许跨表 link，箭头要么画不出来，要么把跨表 record 当成本表 record，逻辑错乱。

**建议**: dependencyFieldId 校验链上加 self-table 限定：

- 前端 view config drawer：仅列出 `linkConfig.targetSheetId === currentSheetId` 的 link field
- 后端 OpenAPI schema：增加 `x-linkTarget: self` 标注（若现有约定支持）；否则在 view config save 校验里拒绝
- 文档明确"跨表依赖不在本 RC scope"

### 🟡 中 · B2 + C2. 渲染层必须对环免疫

**计划原文**: 仅做 client-side warning

**问题**: 即使前端加 warning，环仍可能从其他写路径混入：

- 老数据
- xlsx import
- 直接 API 调用
- 多用户并发编辑下的 race window

Gantt 箭头渲染若递归遍历依赖图，无 visited set 会栈溢出 / 死循环。Hierarchy 树同理。

**建议**: 不论 server 是否阻止，**render 层必须自带 cycle guard**：

```ts
function renderTree(root: NodeId, visited = new Set<NodeId>()): TreeNode | null {
  if (visited.has(root)) return null; // cycle, truncate
  visited.add(root);
  const children = getChildren(root)
    .map(c => renderTree(c, visited))
    .filter(isNonNull);
  return { id: root, children };
}
```

最大递归深度兜底（如 max 1024）也加上。

### 🟠 中高 · C1. parent link field 必须 max=1

**计划原文**: "拖到节点：patch parent link field 为 [targetRecordId]"

**问题**: 如果 parent link field 配置为多值 link，patch 成单值数组会**抹掉用户已设的其他 parent**。这是 silent destructive。

**建议**: Hierarchy view 配置 drawer 强约束 parent link field 必须 `linkConfig.maxValues === 1`：

- 多值 link field 不出现在 parent field 选项里
- 已配的 view 若 link field 后来被改成多值，view 加载时报错并要求重选
- 拖拽功能开关本身依赖 parent field 满足约束

否则用户配错的代价是丢数据，不可接受。

---

## 4. 执行节奏建议

### 阶段 0（先做）· 工作树清场

1. 战线 #2（group-failure-alert）→ 切 worktree → commit + push 出独立 PR（30 min）
2. 战线 #1（directory return banner）→ 留当前分支，整理 verification doc → 推 PR
3. 战线 #3 (group destination) + #4 (api tokens) → 各自 worktree commit + PR
4. 50+ 未追踪 verification doc → 按战线归位，避免 cross-PR 引用

阶段 0 完成后，根目录工作树**完全干净**，再开三 lane。

### 阶段 1 · Lane A（autoNumber）独立推进

理由：A 改 OpenAPI / types / 新 migration，是冲突源头。先合让 B/C rebase 成本最小。

执行节奏：
- 起 worktree `feat/multitable-auto-number-field-20260507`
- backend schema + migration → backend 字段类型枚举 → OpenAPI 生成物 → 前端 Field Manager + renderer → 测试
- 每个原子改动都跑 backend vitest + 前端 vitest + vue-tsc + diff --check
- PR 描述必须包含"K3 PoC Stage 1 Lock 适用性说明"段落（见 §2）
- 等 Lane A PR **CI 全绿且进入 review 状态**再开 Lane B/C

### 阶段 2 · Lane B + C 并行

A 进入 review 后，B/C 可以并行起 worktree（彼此不冲突），但 rebase 基线必须是 Lane A 分支或 A merge 后的 main。

### 阶段 3 · 收尾

每条 lane 落地后：
- 更新 `docs/development/multitable-feishu-rc-todo-20260430.md`
- 写 `*-development-verification-20260507.md`
- Codex 二次 review

---

## 5. 待用户确认清单

执行前必须收到的明确答复：

1. **K3 PoC lock 适用性**：用户是否同意 §2 给出的 PR 描述模板？还是觉得 Lane A 应推迟到 K3 PoC GATE PASS 之后？
2. **A1 advisory lock**：当前 record insert 路径是否已有 sheet 级 advisory lock？若没有，本 PR 是否可以引入？
3. **A2 batch import 策略**：选号段领取（推荐）还是逐行 FOR UPDATE？后者性能差但实现简单。
4. **A3 staging migration alignment**：本 migration 落地前是否需要先把 staging 66 entries 对齐？还是可在本 lane 内顺手对齐？
5. **B1 跨表 link**：是否同意"跨表依赖不在本 RC scope"？
6. **C1 parent link 单值约束**：是否同意作为 Hierarchy view 配置硬约束？
7. **工作树清场**：阶段 0 由我执行还是用户自己处理？50+ untracked doc 是否都保留？
8. **节奏**：阶段 1（A）→ 阶段 2（B+C 并行）的串行/并行策略是否接受？还是要 A/B/C 全并行？

---

## 6. 我的结论

**计划方向 + 拆 PR + clean worktree 三大原则我都同意。** 但 6 处技术风险中至少 A1 / A2 / A3 / C1 必须在动手前明确处理方式 —— 这是结构性决策，落到代码后改成本远高于现在改方案。

**最小动作建议**：

- 立刻可做：阶段 0 工作树清场（先把战线 #2 切出去）
- 等用户确认：§5 八问，逐条回答后再起 Lane A worktree
- 不建议立刻三 lane 并行：A 改的 types/OpenAPI 是真冲突源，先让 A 跑出 PR 形态再开 B/C
