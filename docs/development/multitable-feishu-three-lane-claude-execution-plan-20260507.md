# 多维表 Feishu 深水区 · Claude 执行计划

> Date: 2026-05-07
> Status: 执行计划（待 §5 八问确认后正式启动）
> 配套讨论文档: `docs/development/multitable-feishu-three-lane-plan-discussion-20260507.md`
> 上游 TODO: `docs/development/multitable-feishu-rc-todo-20260430.md`

本文是讨论文档的姊妹篇。**讨论文档**记录"为什么这么做"，**本文**记录"具体怎么做、做哪些、什么顺序、什么命令、什么验收标准"。Claude 启动每条 lane 时按本文条目逐步执行。

---

## 0. 前置假设（基于讨论文档默认推荐方案）

启动前用户对讨论文档 §5 的 8 问已答复，本文按以下默认方案推进；若用户答复不同，对应章节对照修改：

| # | 问题 | 默认方案 |
|---|---|---|
| 1 | K3 PoC Lock 适用性 | 采用 §2 的 PR 描述模板，三条 lane 均纳入"已发布功能 parity 深化" |
| 2 | A1 advisory lock | 若当前 record insert 路径无 sheet 级 advisory lock，本 lane 引入 |
| 3 | A2 批量号段策略 | 号段领取（`UPDATE ... RETURNING`），不走逐行 FOR UPDATE |
| 4 | A3 staging migration alignment | 本 lane 内顺手对齐 staging（参见 `docs/operations/staging-migration-alignment-runbook.md`） |
| 5 | B1 跨表 link | 跨表依赖不在 RC scope，dependencyFieldId 限制 self-table |
| 6 | C1 parent link 单值 | 硬约束：parent link field 必须 maxValues=1，否则禁用拖拽 |
| 7 | 工作树清场 | Claude 执行 Phase 0，把 4 条战线分别落盘 |
| 8 | 节奏 | Phase 1 (A) 独跑 → Phase 2 (B+C) 并行 |

---

## 1. Phase 0 · 工作树清场（约 60-90 min）

启动三 lane 之前，根目录工作树必须干净。

### 1.1 战线盘点固化

| 战线 | 文件 | 推荐分支名 |
|---|---|---|
| #1 directory return banner | `apps/web/src/views/{DirectoryManagementView,UserManagementView}.vue` + 对应 spec + `directory-sync.ts` | 当前分支 `codex/dingtalk-directory-return-banner-tests-20260505` 直接整理 |
| #2 group failure alert → rule creator | 14 文件（automation-actions/executor/service + dingtalk-automation-link-validation + MetaAutomation* + automation-v1 + dingtalk-automation-link-routes）+ probe 脚本 + 4 verification doc | `codex/dingtalk-group-failure-alert-creator-20260507` |
| #3 group destination verify-before-save | `dingtalk-group-destination-service.ts` + 路由/单元测试 + 多份 0506 verification doc | `codex/dingtalk-group-destination-verify-20260506` |
| #4 API token manager | `MetaApiTokenManager.vue` + spec + `api-tokens.ts` + `multitable-client.spec.ts` | `codex/multitable-api-token-manager-polish-20260506` |

### 1.2 执行步骤（按战线顺序）

每条战线执行同一套动作：

```bash
# 起 worktree（基于 origin/main）
EnterWorktree(branch="<推荐分支名>", base="origin/main")

# 在 worktree 内
git checkout -b <推荐分支名>
git -C <根目录> stash push --keep-index --include-untracked -- <该战线的全部文件>
# 或者用 git checkout 把该战线的 working-tree 改动捡到 worktree 内

# 自测
cd <worktree>
pnpm install --frozen-lockfile
<战线对应 vitest 套件>
git diff --check
git status

# 提交
git add <精确文件列表，不用 git add -A>
git commit -m "<conventional commit message>"
git push -u origin HEAD
gh pr create --title "..." --body "..."
```

### 1.3 验收

Phase 0 完成的判据：

- [ ] 4 条战线各自有独立分支 + 独立 PR + CI 启动
- [ ] `git status` 在根目录显示 clean（除 `.claude/` 外）
- [ ] 50+ 未追踪 verification doc 已归位到对应 PR
- [ ] 根目录 `git log` 不变（不在根目录直接 commit 三 lane 之外的东西）

只有 Phase 0 全部 ✅ 后，才能进 Phase 1。

---

## 2. Phase 1 · Lane A autoNumber 字段（约 1-1.5 天）

**分支**: `feat/multitable-auto-number-field-20260507`（基于 origin/main worktree）

**核心约束**:
- 用持久 sequence 表，不用 row index
- backfill + new-record allocation 必须并发安全
- 用户禁止写入 raw value
- 删除不复用号

### 2.1 文件清单

#### 后端

| 文件 | 操作 | 关键点 |
|---|---|---|
| `packages/core-backend/migrations/<timestamp>_meta_field_sequences.ts` | 新增 | `tenant_id, sheet_id, field_id, next_value, created_at, updated_at`；UNIQUE (tenant_id, sheet_id, field_id) |
| `packages/core-backend/src/multitable/field-types.ts` | 改 | enum 增 `'autoNumber'`；写约束：raw 是 number；property: `{ prefix: string, digits: number, start: number }` |
| `packages/core-backend/src/multitable/field-sequence-service.ts` | 新增 | `allocateNext(tenant, sheet, field, batchSize=1)` 用 `UPDATE ... SET next_value = next_value + :n RETURNING next_value - :n AS start_value` |
| `packages/core-backend/src/multitable/record-create-service.ts` | 改 | record 创建路径在同一 transaction 调 allocateNext；reject 用户传入 autoNumber raw value |
| `packages/core-backend/src/multitable/record-import-service.ts` | 改 | import 路径走 batch 号段 |
| `packages/core-backend/src/multitable/field-create-service.ts` | 改 | CREATE FIELD autoNumber 时：advisory lock → backfill (created_at, id) → INSERT meta_field_sequences (next_value = N+1) |
| `packages/core-backend/src/multitable/record-patch-service.ts` | 改 | reject 用户 patch autoNumber 字段 |
| `packages/core-backend/src/openapi/...` | 改 | field type schema 增 autoNumber，property schema 加上 |

#### 前端

| 文件 | 操作 | 关键点 |
|---|---|---|
| `apps/web/src/multitable/types.ts` | 改 | FieldType 增 `'autoNumber'` |
| `apps/web/src/multitable/components/MetaFieldManager.vue` | 改 | 字段类型下拉新增 autoNumber，配置面板：prefix / digits / start |
| `apps/web/src/multitable/components/cell-renderers/AutoNumberCell.vue` | 新增 | 只读渲染：`prefix + zeroPad(raw, digits)` |
| `apps/web/src/multitable/components/MetaGridView.vue` | 改 | 接入 AutoNumberCell |
| `apps/web/src/multitable/components/MetaRecordDrawer.vue` | 改 | 只读展示 |
| `apps/web/src/multitable/components/MetaRecordForm.vue` | 改 | autoNumber 字段不渲染表单输入 |

### 2.2 自测命令

```bash
# 后端
pnpm --filter @metasheet/core-backend exec vitest run \
  packages/core-backend/tests/unit/multitable/field-sequence-service.test.ts \
  packages/core-backend/tests/unit/multitable/auto-number-field.test.ts \
  packages/core-backend/tests/integration/auto-number-record-create.test.ts \
  packages/core-backend/tests/integration/auto-number-import.test.ts \
  --watch=false

# 前端
pnpm --filter @metasheet/web exec vitest run \
  apps/web/tests/multitable-auto-number-cell.spec.ts \
  apps/web/tests/multitable-auto-number-field-manager.spec.ts \
  --watch=false

# 类型 + lint + diff
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check

# OpenAPI gate
pnpm --filter @metasheet/core-backend run openapi:check
pnpm --filter @metasheet/web run openapi:check  # 若前端有生成 client
```

### 2.3 测试用例必须覆盖

后端：

- [ ] 创建 autoNumber 字段时 sheet 已有 N records → 全部按 (created_at, id) 回填 1..N，next_value = N+1
- [ ] 回填中并发 record insert 被 advisory lock 阻塞，回填完成后这条 record 拿到 N+1（不是漏号也不是冲突）
- [ ] 连续 10 次 create record → 编号严格递增 1..10
- [ ] 删除编号 5 的 record 后，再 create → 拿 11，不复用 5
- [ ] xlsx import 100 行 → 一次号段领取，编号连续 N+1..N+100
- [ ] 用户 create payload 带 `autoNumber: 999` → 后端拒绝 + 4xx + 错误信息明确
- [ ] 用户 patch payload 带 autoNumber 字段 → 后端拒绝
- [ ] 同一 sheet 两个 autoNumber 字段互不干扰（各自独立 sequence）
- [ ] property `digits=4, prefix='INV-', start=1000` → next_value 从 1000 起

前端：

- [ ] Field Manager 选 autoNumber → 显示 prefix/digits/start 配置
- [ ] Grid 渲染 raw=42 + property `{prefix:'A-',digits:4}` → 显示 "A-0042"
- [ ] Drawer + Form 显示该字段为只读
- [ ] property `digits=0` → 不补零
- [ ] property `prefix=''` → 无前缀

### 2.4 验证 doc

写：
- `docs/development/multitable-auto-number-field-development-verification-20260507.md`
- 更新 `docs/development/multitable-feishu-rc-todo-20260430.md`

### 2.5 PR 描述模板

```markdown
## 摘要

为多维表新增 autoNumber 字段类型，对齐 Feishu RC 字段能力。

## K3 PoC Stage 1 Lock 适用性

本 PR 不触发 lock 拦截，因为：
1. 不修改 plugins/plugin-integration-core/* 任何文件
2. 多维表内核已在 Wave 系列发布，本 PR 是字段类型扩展而非新平台能力
3. 不引入对接外部 ERP 的代码路径

参见 docs/development/multitable-feishu-rc-todo-20260430.md。

## 关键决策

- 持久 sequence 表 meta_field_sequences，不用 row index
- 创建字段时 advisory lock + 回填 + 设 next_value=N+1，全在单 transaction
- 批量 import 走号段领取（UPDATE ... RETURNING），不逐行 FOR UPDATE
- 用户 create/patch/import 写 autoNumber 一律拒绝
- 删除不复用号

## 测试

[贴 vitest 输出]

## Migration

新增 meta_field_sequences。staging 已预先对齐到 prod baseline。
```

### 2.6 Phase 1 验收

- [ ] PR CI 全绿
- [ ] OpenAPI gate 通过
- [ ] vue-tsc 通过
- [ ] 测试用例 §2.3 全覆盖
- [ ] verification doc 已写
- [ ] PR 进入 review 状态

仅在以上全 ✅ 后启动 Phase 2。

---

## 3. Phase 2A · Lane B Gantt dependency arrows（约 0.5-1 天）

**分支**: `feat/multitable-gantt-dependency-arrows-20260507`（基于 Lane A 分支或 Lane A merge 后的 main）

**核心约束**:
- 仅扩 view config，不改后端 schema
- dependencyFieldId 限 self-table link field
- 渲染必须 cycle-defensive

### 3.1 文件清单

| 文件 | 操作 | 关键点 |
|---|---|---|
| `apps/web/src/multitable/view-config.ts` | 改 | GanttViewConfig 增 `dependencyFieldId?: string \| null` |
| `apps/web/src/multitable/components/MetaGanttView.vue` | 改 | 读 dependencyFieldId；遍历前置任务时带 visited set；最大递归深度 1024 |
| `apps/web/src/multitable/components/MetaGanttView/DependencyArrows.vue` | 新增 | SVG 箭头层；渲染算法 cycle-defensive |
| `apps/web/src/multitable/components/MetaGanttView/GanttConfigDrawer.vue` | 改 | dependencyFieldId 选项仅列 self-table link field |
| `packages/core-backend/src/multitable/view-config-schema.ts` | 改 | Gantt config zod 增 dependencyFieldId 字段；save 时校验 self-table link |
| `packages/core-backend/src/openapi/...` | 改 | view config schema 同步 |

### 3.2 自测命令

```bash
pnpm --filter @metasheet/web exec vitest run \
  apps/web/tests/multitable-gantt-dependency-arrows.spec.ts \
  --watch=false

pnpm --filter @metasheet/core-backend exec vitest run \
  packages/core-backend/tests/unit/view-config-gantt-dep.test.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

### 3.3 测试用例必须覆盖

- [ ] 配 dependencyFieldId → 持久化到 view config
- [ ] 配置后渲染箭头：A 依赖 B → B 末端到 A 起点的箭头
- [ ] missing dependency（指向已删除 record）→ console.warn + 不画箭头 + 不阻断渲染
- [ ] self dependency（A 依赖 A）→ console.warn + 不画箭头
- [ ] cycle (A→B→A) → console.warn + 渲染时 visited set 截断 + 不死循环
- [ ] dependencyFieldId 配的是非 self-table link → save 时被 backend 拒绝
- [ ] dependencyFieldId 未配 → 保持旧 Gantt 行为（无箭头层）

### 3.4 验证 doc

写：
- `docs/development/multitable-gantt-dependency-arrows-development-verification-20260507.md`
- 更新 `docs/development/multitable-feishu-rc-todo-20260430.md`

---

## 4. Phase 2B · Lane C Hierarchy drag-to-reparent（约 0.5-1 天，可与 Lane B 并行）

**分支**: `feat/multitable-hierarchy-drag-reparent-20260507`（基于 Lane A 分支或 Lane A merge 后的 main）

**核心约束**:
- 拖拽 patch 复用现有 record patch path，不加 REST API
- parent link field 必须 maxValues=1
- render 层 cycle-defensive

### 4.1 文件清单

| 文件 | 操作 | 关键点 |
|---|---|---|
| `apps/web/src/multitable/components/MetaHierarchyView.vue` | 改 | 树渲染加 visited set + max depth 1024；拖拽事件挂载 |
| `apps/web/src/multitable/components/MetaHierarchyView/HierarchyNode.vue` | 改 | draggable + dragover + drop 事件 |
| `apps/web/src/multitable/components/MetaHierarchyView/HierarchyConfigDrawer.vue` | 改 | parent link field 仅列 maxValues=1 的 link field；多值 link 不可选 |
| `apps/web/src/multitable/composables/useHierarchyDrag.ts` | 新增 | 客户端 self-parent / descendant-parent 阻断；patch 调用 |
| `packages/core-backend/src/multitable/view-config-schema.ts` | 改 | Hierarchy config save 校验 parent link field 满足 maxValues=1 |

### 4.2 自测命令

```bash
pnpm --filter @metasheet/web exec vitest run \
  apps/web/tests/multitable-hierarchy-drag.spec.ts \
  --watch=false

pnpm --filter @metasheet/core-backend exec vitest run \
  packages/core-backend/tests/unit/view-config-hierarchy-parent-link.test.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

### 4.3 测试用例必须覆盖

- [ ] 拖 child 到另一 node → 发出 patch 把 parent link field 设为 [targetRecordId]
- [ ] 拖 child 到 root 区域 → 发出 patch 清空 parent link field
- [ ] 拖 self 到 self → drop 被阻断，不发 patch
- [ ] 拖 ancestor 到 descendant → drop 被阻断
- [ ] 配置 parent link field 为多值 link → drawer 不允许选；强行配的 view 加载报错
- [ ] 树数据中存在环 → 渲染 visited set 截断，不死循环
- [ ] 原有 select / comment / create child 行为不回归

### 4.4 验证 doc

写：
- `docs/development/multitable-hierarchy-drag-reparent-development-verification-20260507.md`
- 更新 `docs/development/multitable-feishu-rc-todo-20260430.md`

---

## 5. 全局验收清单

三 lane 全部完成后：

- [ ] 三个 PR 全部 CI 绿
- [ ] 各 PR vue-tsc / vitest / openapi gate 通过
- [ ] 三份 verification MD 已写
- [ ] `multitable-feishu-rc-todo-20260430.md` 三条对应行已勾完
- [ ] Codex 二次 review 通过
- [ ] 合并顺序严格 A → B → C
- [ ] B / C 在 A merge 后 rebase 到 main，重跑 CI

---

## 6. 重要操作纪律（避免历史踩过的坑）

- **绝对禁止 `git add -A` 或 `git add .`** —— 必有 50+ 未追踪 verification doc，会误纳无关战线
- **绝对禁止 `git commit --no-verify`** —— 触发 hook 失败必须根因修复
- **每 lane 单独 worktree** —— 不允许在同一 worktree 切来切去，避免 stash 污染
- **migration 落地前先对齐 staging** —— 参见 `docs/operations/staging-migration-alignment-runbook.md`
- **PR 描述必须含 K3 PoC Lock 适用性段落** —— Codex review 第一关
- **每条 PR 自带 verification MD** —— 项目惯例，无 doc 不 merge
- **不创建 plan/decision MD 除非 user 要求** —— 本文 + 讨论文档已是唯一两份

---

## 7. Claude 启动信号

收到用户以下任一指令即视为开工：

- "开始 Phase 0"
- "开始清场"
- "起 Lane A"
- "执行计划开始"

收到信号前，仅就 §5 八问做澄清问答，不动代码。
