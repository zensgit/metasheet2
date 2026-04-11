# 审批 MVP 第一波执行验收 Runbook

> 日期: 2026-04-11
> 基线: `origin/main`
> 验证分支: `codex/approval-wave2-acceptance-20260411`
> 目标: 以真实命令和页面闭环确认审批 MVP 第一波可作为平台原生审批产品验收

---

## 1. 验收范围

本 Runbook 只覆盖第一波已经承诺的范围:

- 平台原生审批模板
- 审批中心
- 按模板发起审批
- 审批详情
- 统一动作与历史
- 第一波文档与 API 示例

明确不纳入本轮验收:

- PLM 并入统一 Inbox
- 考勤并入统一 Inbox
- 会签 / 或签 / 并行分支
- 催办 / SLA / 统计报表
- 移动端专属体验

---

## 2. 验收前提

- 已执行 `pnpm install`
- PostgreSQL / Redis 可用
- 后端已完成 migration
- 具备至少 4 类账号或等价权限夹具:
  - `approvals:read`
  - `approvals:write`
  - `approvals:act`
  - `approval-templates:manage`

推荐本地启动:

```bash
pnpm --filter @metasheet/core-backend dev
pnpm dev
```

---

## 3. 自动化验收命令

### 后端类型检查

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

本次执行结果: `PASS`

### 后端审批主线单测

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts \
  tests/unit/approval-template-routes.test.ts \
  tests/unit/approvals-routes.test.ts \
  tests/unit/approvals-bridge-routes.test.ts \
  --watch=false --reporter=dot
```

本次执行结果: `PASS`，`43/43` 通过

### 前端类型检查

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

本次执行结果: `PASS`

### 前端审批验收套件

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/approval-center.spec.ts \
  tests/approval-e2e-lifecycle.spec.ts \
  tests/approval-e2e-permissions.spec.ts \
  tests/approval-inbox-auth-guard.spec.ts \
  --watch=false --reporter=dot
```

本次执行结果: `PASS`，`78/78` 通过

补充:

- Vitest 输出里有 `WebSocket server error: Port is already in use`
- 该信息未影响测试结果，属于本地端口占用噪音，不构成审批功能 blocker

---

## 4. 手工验收步骤

### A. 模板管理

1. 打开 `/approval-templates`
2. 确认模板列表可见，状态筛选可切换
3. 打开一个 `published` 模板详情
4. 确认详情页展示:
   - 模板名称 / key / activeVersionId
   - 表单字段表格
   - 审批流程时间线
5. 若当前账号有 `approvals:write`，确认存在“发起审批”入口

### B. 发起审批

1. 从模板详情点击“发起审批”
2. 确认 `/approvals/new/:templateId` 正常加载
3. 逐项确认字段渲染:
   - text
   - textarea
   - number
   - date
   - datetime
   - select
   - multi-select
   - user
   - attachment
4. 留空必填字段提交，确认前端阻止提交
5. 填写合法数据后提交
6. 确认跳转到 `/approvals/:id`
7. 确认详情页显示 `requestNo`、`formSnapshot`

### C. 审批详情与动作

1. 用审批人账号打开待处理实例
2. 确认详情页显示:
   - 标题
   - 状态标签
   - 表单快照
   - 历史时间线
3. 依次验证动作:
   - approve
   - reject
   - transfer
   - comment
4. 用发起人账号验证 `revoke`
5. 确认动作后:
   - 历史刷新
   - 状态更新
   - 终态实例显示“该审批已结束”提示
   - 终态实例不再显示可执行按钮

### D. 权限矩阵

1. `approvals:read`
   - 可看列表和详情
   - 不可发起
   - 不可审批
2. `approvals:write`
   - 可发起
   - 不应拥有审批动作
3. `approvals:act`
   - 仅对命中 assignment 的 pending 实例可审批
4. `approval-templates:manage`
   - 可看模板中心
   - 可做模板创建 / 编辑 / 发布

### E. 兼容回归

1. PLM 页面仍可访问
2. 考勤审批流仍可访问
3. `/workflows` 仍可访问
4. 旧审批桥接路由单测仍通过

---

## 5. 本轮验收结论

截至 `2026-04-11`，审批 MVP 第一波满足“平台原生审批产品”基线:

- 契约、迁移、运行时、前端壳、文档均已进 `main`
- 自动化证据覆盖后端核心、前端核心、权限矩阵与生命周期
- 产品边界已明确锁定为平台原生审批，不把 PLM / 考勤强行并入统一 Inbox

可判定为:

- `工程交付: 可验收`
- `产品交付: 可进入第一波业务验收`
- `下一阶段: 不继续扩 Wave 1 核心代码，转 Wave 2 范围拆解`

---

## 6. 当前已知限制

- 统一 Inbox 只展示 `platform` 原生审批
- 条件分支为 JSON 图解释执行，不是 BPMN 主路径
- 模板权限仍是全局 `approval-templates:manage`，没有模板级 ACL
- 审批详情暂无流程图高亮
- 暂无催办、通知、已读未读、统计分析

---

## 7. 关联文档

- [approval-mvp-wave1-acceptance-checklist-20260411.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/approval-wave2-acceptance-20260411/docs/development/approval-mvp-wave1-acceptance-checklist-20260411.md)
- [approval-mvp-feishu-gap-matrix-20260411.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/approval-wave2-acceptance-20260411/docs/development/approval-mvp-feishu-gap-matrix-20260411.md)
- [approval-api-usage-guide-20260411.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/approval-wave2-acceptance-20260411/docs/development/approval-api-usage-guide-20260411.md)
