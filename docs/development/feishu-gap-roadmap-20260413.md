# MetaSheet 对标飞书多维表格 8 周执行路线图

Date: 2026-04-13

## 1. 目标

这 8 周只解决一件事：

把 MetaSheet 当前已经具备骨架的 `multitable + platform shell`，推进到一个可对外演示、可持续迭代、明显接近飞书多维表格使用感的版本。

本轮不追求：

- 做成完整飞书办公套件
- 同时扩张文档、IM、会议等多产品线
- 直接进入 CRDT / OT 级别的多人实时协同
- 一次性做完复杂 DAG 自动化或完整模板市场

## 2. 当前判断

当前 `main` 并不是从零开始。

已具备或半具备的能力包括：

- 多视图工作台骨架
- 记录 CRUD、批量操作、排序、筛选、分组
- 评论基础能力
- `@提及`、未读、收件箱、presence 的基础闭环
- 基础自动化能力
- 平台壳挂载业务应用的方向

当前真正的产品空白主要是：

- 外部公开表单分享
- 字段验证规则的完整前后端闭环
- `API token + webhook` 的产品化入口
- 高级自动化 V1
- 图表 / dashboard V1

因此本路线图的原则不是“从零搭新系统”，而是：

1. 先补完协作闭环
2. 再补齐真正空白
3. 最后做 RC 收口

## 3. 执行原则

### 3.1 每周只推进一个主题

避免把平台基线、业务模型、前端交互、验收脚本混在同一个大 PR 里。

### 3.2 固定 lane 拆分

每个主题默认按以下顺序拆分：

1. `baseline`
2. `contracts`
3. `runtime`
4. `frontend`
5. `integration`

说明：

- 如果某周不需要共享基线改动，可以省略 `baseline`
- 但凡碰到迁移、`packages/openapi`、认证入口、平台壳公共状态，必须先走 `baseline`

### 3.3 分支命名统一

统一使用：

- `codex/<theme>-baseline-YYYYMM`
- `codex/<theme>-contracts-YYYYMM`
- `codex/<theme>-runtime-YYYYMM`
- `codex/<theme>-frontend-YYYYMM`
- `codex/<theme>-integration-YYYYMM`

例如：

- `codex/public-form-baseline-202604`
- `codex/public-form-runtime-202604`
- `codex/public-form-frontend-202604`

### 3.4 worktree 纪律

每个 lane 建议使用独立 `git worktree`，全部从 `origin/main` 切出。

不要在一个脏工作目录里并行推进多个主题。

### 3.5 owner 划分

推荐按能力分工，而不是按页面随意切：

- `backend/contracts owner`：模型、迁移、OpenAPI、路由、执行引擎、集成协议
- `frontend owner`：交互、状态同步、页面入口、工作台体验
- `integration owner`：测试、回归、smoke、演示数据、验证文档

如果采用多代理协作：

- `Claude` 适合主导 `contracts/runtime`
- `Codex` 或人工更适合主导 `frontend/integration`

## 4. 成功标准

8 周结束后，应至少满足：

1. 协作闭环达到稳定可感知状态，评论、提及、未读、收件箱、presence 语义一致
2. 支持公开表单链接和最小匿名提交流程
3. 字段验证规则在外部表单和内部记录编辑中共用
4. 提供 `API token + webhook` 第一版能力
5. 自动化从 MVP 升级到可用于简单业务流程
6. 提供第一版图表 / dashboard 展示能力
7. 形成可回归、可演示、可继续拆分下一阶段 backlog 的 RC 版本

## 5. 每周执行计划

### Week 0: Roadmap 落库

主题：

- 路线图落库

分支：

- `codex/feishu-gap-roadmap-docs-202604`

Owner：

- 文档 owner

PR 范围：

- 仅新增本路线图文档

验收：

- 文档 PR 审阅完成即可

### Week 1: 协作语义统一

主题：

- 评论、提及、未读、收件箱、presence 的契约统一

分支：

- `codex/collab-semantics-baseline-202604`
- `codex/collab-semantics-contracts-202604`
- `codex/collab-semantics-runtime-202604`
- `codex/collab-semantics-frontend-202604`
- `codex/collab-semantics-integration-202604`

Owner：

- `contracts/runtime`：backend/contracts owner
- `frontend/integration`：frontend owner + integration owner

PR 范围：

- 统一评论对象、mention 对象、未读状态、收件箱汇总、presence 事件语义
- 前端优先对齐 contract，不做大规模视觉重做
- 后端补齐必要 API 规范化和测试

验收命令：

- `pnpm lint`
- `pnpm type-check`
- `pnpm --filter @metasheet/core-backend test:unit`
- `pnpm --filter @metasheet/web exec vitest run --watch=false`

### Week 2: 协作体验补完

主题：

- 把已有协作骨架提升到更完整的产品体验

分支：

- `codex/collab-ux-runtime-202604`
- `codex/collab-ux-frontend-202604`
- `codex/collab-ux-integration-202604`

Owner：

- `frontend`：frontend owner 主导
- `runtime`：backend owner 跟进补洞

PR 范围：

- 评论线程交互补完
- mention composer 和候选交互打磨
- 未读状态在工作台、评论抽屉、收件箱之间保持一致
- presence 从“存在”提升到“可感知谁在看”

验收命令：

- `pnpm --filter @metasheet/web exec vitest run apps/web/tests/multitable-comment-inbox-view.spec.ts apps/web/tests/multitable-comment-presence.spec.ts apps/web/tests/multitable-sheet-presence.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend test:integration`

### Week 3: 外部表单分享 Baseline

主题：

- 从内部表单流升级到公开表单入口

分支：

- `codex/public-form-baseline-202604`
- `codex/public-form-contracts-202604`
- `codex/public-form-runtime-202604`
- `codex/public-form-frontend-202604`
- `codex/public-form-integration-202604`

Owner：

- `baseline/contracts/runtime`：backend/contracts owner
- `frontend`：frontend owner

PR 范围：

- 公开链接模型
- 过期策略
- 匿名访问与最小权限模型
- 最小限流与防滥用
- 公开表单页面和提交成功页

说明：

- 本周不做复杂字段联动
- 重点是安全、可访问、可提交流程

验收命令：

- `pnpm --filter @metasheet/core-backend test:integration`
- `pnpm --filter @metasheet/web exec vitest run --watch=false`

### Week 4: 字段验证规则

主题：

- 建立外部表单和内部记录编辑共用的验证规则

分支：

- `codex/field-validation-contracts-202604`
- `codex/field-validation-runtime-202604`
- `codex/field-validation-frontend-202604`
- `codex/field-validation-integration-202604`

Owner：

- `contracts/runtime`：backend/contracts owner
- `frontend`：frontend owner

PR 范围：

- 必填
- 范围校验
- 长度限制
- 正则校验
- 统一错误结构

说明：

- 后端校验是权威来源
- 前端只负责复用同一套规则和错误展示

验收命令：

- `pnpm --filter @metasheet/core-backend test:unit`
- `pnpm --filter @metasheet/core-backend test:integration`
- `pnpm --filter @metasheet/web exec vitest run --watch=false`

### Week 5: API Token + Webhook V1

主题：

- 给 multitable 提供第一版开放接入能力

分支：

- `codex/api-token-webhook-baseline-202605`
- `codex/api-token-webhook-contracts-202605`
- `codex/api-token-webhook-runtime-202605`
- `codex/api-token-webhook-frontend-202605`
- `codex/api-token-webhook-integration-202605`

Owner：

- `baseline/contracts/runtime`：backend/contracts owner
- `frontend`：frontend owner

PR 范围：

- token 模型和 scope
- token 创建、展示、轮换、失效
- webhook 第一版事件：
  - 记录创建
  - 记录更新
  - 评论创建
- 最小管理页面

说明：

- 这周应尽量复用平台级能力
- 不要做成 multitable 私有黑箱

验收命令：

- `pnpm --filter @metasheet/core-backend test:unit`
- `pnpm --filter @metasheet/core-backend test:integration`
- `pnpm verify:multitable-openapi:parity`

### Week 6: 高级自动化 V1

主题：

- 把自动化从 MVP 升到简单业务可用

分支：

- `codex/automation-v1-contracts-202605`
- `codex/automation-v1-runtime-202605`
- `codex/automation-v1-frontend-202605`
- `codex/automation-v1-integration-202605`

Owner：

- `runtime`：backend owner 主导
- `frontend`：frontend owner

PR 范围：

- 定时触发
- 条件判断
- webhook 动作
- `2` 到 `3` 步串联
- 执行日志与失败重试

说明：

- 不做复杂流程设计器
- 沿现有自动化模型增量扩展，不另起一套引擎

验收命令：

- `pnpm --filter @metasheet/core-backend test:unit`
- `pnpm --filter @metasheet/core-backend test:integration`
- `pnpm --filter @metasheet/web exec vitest run apps/web/tests/multitable-automation-manager.spec.ts --watch=false`

### Week 7: 图表 / Dashboard V1

主题：

- 补齐最明显的产品展示空白

分支：

- `codex/dashboard-contracts-202605`
- `codex/dashboard-runtime-202605`
- `codex/dashboard-frontend-202605`
- `codex/dashboard-integration-202605`

Owner：

- `runtime`：聚合 API、dashboard 模型
- `frontend`：图表渲染、布局、交互

PR 范围：

- 柱状图
- 折线图
- 饼图
- 从 view/filter 取数
- 最小 dashboard 面板布局

说明：

- 本周必须前后端并行
- 不先做复杂 BI 和高级分析

验收命令：

- `pnpm --filter @metasheet/core-backend test:integration`
- `pnpm --filter @metasheet/web exec vitest run --watch=false`

### Week 8: RC 收口

主题：

- 回归、演示、发布候选准备

分支：

- `codex/feishu-gap-rc-integration-202605`
- `codex/feishu-gap-rc-docs-202605`

Owner：

- integration owner
- 文档 owner

PR 范围：

- 统一 smoke
- 回归测试
- 演示数据
- 发布说明
- 下一阶段 backlog 切分

验收命令：

- `pnpm validate:all`
- `pnpm verify:smoke`

## 6. 关键纪律

1. `Week 1-2` 不追求新功能数量，只追求协作闭环稳定
2. `Week 3-6` 虽然后端主导，但每周必须保留 `frontend` 和 `integration` lane
3. `Week 7` 图表相关能力必须前后端并行，不允许只先做后端模型
4. 真正的多人实时协同编辑不放进这 8 周
5. 每个 lane 合并后尽快删分支，避免形成长寿分支

## 7. 风险

1. 当前仓库共享热点多，若不先拆 `baseline`，后续冲突会迅速放大
2. 公开表单和 API token 都会引入公开面，若缺少限流、过期、权限边界，风险高于普通内部页面
3. 自动化很容易范围失控，必须把本轮限制在“简单可用”而不是“通用流程平台”
4. 图表如果没有真实 view/filter 对接，只会形成演示型 UI，不能算有效交付

## 8. 本轮明确不做

- 文档 / IM / 会议产品线
- CRDT / OT 实时协同基础设施
- 复杂 DAG 自动化设计器
- 完整模板市场
- 把钉钉扩张成主产品线

## 9. 下一步直接执行建议

如果按本路线图启动，建议第一批动作是：

1. 合并本路线图文档
2. 按 `Week 1` 建立 `collab-semantics` 主题分支和 worktree
3. 先提交 `contracts/runtime` 的评论、mention、未读语义清理
4. 再提交 `frontend` 的协作状态同步与交互补完
5. 最后补 `integration` 验证和回归文档
