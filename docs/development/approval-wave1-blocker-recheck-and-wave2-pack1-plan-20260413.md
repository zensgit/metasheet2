# 审批 Wave 1 Blocker 复核与 Wave 2 包 1 执行计划

> 日期: `2026-04-13`
> 基线: `origin/main` @ `713d77898`
> 工作分支: `codex/approval-wave2-20260413`
> 方法: 旧验收文档复核 + 当前主干代码审阅 + Git 历史核对 + 本机最小回归尝试

---

## 1. 复核结论

截至 `2026-04-13`，平台原生审批 `Wave 1` 仍然没有发现新的代码级 blocker，可以进入 `Wave 2` 设计与实现准备。

这次复核后的结论分成两类：

- 产品 / 代码层面：`无新增 blocker`
- 环境 / 工作站层面：`有阻塞，但不属于审批产品 blocker`

---

## 2. 本次复核输入

本次结论基于以下输入：

- 文档:
  - `docs/development/approval-mvp-wave1-execution-runbook-20260411.md`
  - `docs/development/approval-mvp-wave1-verification-report-20260411.md`
  - `docs/development/approval-mvp-wave2-scope-breakdown-20260411.md`
- 当前主干代码:
  - `packages/core-backend/src/services/ApprovalProductService.ts`
  - `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
  - `packages/core-backend/src/types/approval-product.ts`
  - `apps/web/src/types/approval.ts`
- Git 历史核对:
  - `9092bc1e8 feat(approvals): freeze platform approval v1 contracts`
  - `68d0f988b feat(approvals): add template runtime executor`
  - `0958370a2 feat(approvals): add template crud skeleton`
  - `47303f4bf fix(approvals): harden runtime validation and revoke flow`
  - `70e6bb381 docs(approvals): add wave1 runbook and wave2 scope`
  - `03f8ff1c6 docs(approvals): align wave1 acceptance with row-lock runtime`

未发现 `03f8ff1c6` 之后还有新的提交继续修改上述审批核心文件，因此当前 `origin/main` 上的审批实现语义与 `2026-04-11` 收口时保持一致。

---

## 3. Wave 1 真 blocker 复核

### 3.1 仍成立的结论

`docs/development/approval-mvp-wave1-verification-report-20260411.md` 中的 6 个 `BLOCKED` 项，复核后仍然是环境验证项，不是代码级 blocker：

| ID | 类别 | 结论 |
|----|------|------|
| BL1 | 模板权限 | 仍需真实账号验证 `approval-templates:manage` |
| BL2 | 发起权限 | 仍需真实账号验证 `approvals:write` |
| BL3 | 权限矩阵 | 仍需真实环境验证“无权限返回 403” |
| BL4 | 权限矩阵 | 仍需真实环境验证“只读可看不可操作” |
| BL5 | 兼容性 | 仍需真实环境验证 PLM 旧链路兼容 |
| BL6 | 兼容性 | 仍需真实环境验证考勤旧链路兼容 |

这些项的状态没有变化，依旧需要真实部署环境、真实用户或 JWT 来关闭。

### 3.2 本次代码复核未发现的新 blocker

本次对当前主干代码的复核结论：

- 审批节点类型仍只有 `start / approval / cc / condition / end`
- 审批动作仍只有 `approve / reject / transfer / revoke / comment`
- `ApprovalProductService.dispatchAction()` 仍使用 `SELECT ... FOR UPDATE` 行锁串行化，而不是客户端版本号 optimistic locking
- `ApprovalGraphExecutor` 仍是线性推进 + 条件分支模型，不支持 true parallel / join
- 表单校验仍覆盖 `required / 基础类型 / options / min/max / pattern`
- `revoke` 策略检查与 `cc` 历史落库逻辑仍存在

结论：当前主干与 Wave 1 交付边界一致，没有出现“Wave 1 已被后续提交打穿”的迹象。

---

## 4. 新电脑环境复核结果

本次尝试在新电脑上复跑审批相关最小验证，结果是“工作站依赖未装全”，不是审批代码回归。

### 4.1 已确认

- `pnpm` 未安装到本机 PATH
- 可以通过 `npx pnpm@10` 临时执行
- 当前根仓库 `node_modules` 不完整

### 4.2 实际复跑结果

尝试执行：

```bash
npx --yes pnpm@10 --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts \
  tests/unit/approval-template-routes.test.ts --reporter=dot

npx --yes pnpm@10 --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

得到的失败均为工作站依赖缺失，例如：

- `Failed to load url uuid`
- `Cannot find module 'pg'`
- `Cannot find module 'express'`
- `Cannot find module 'kysely'`

### 4.3 结论

这说明当前新电脑不具备完整的本地验证环境，不能把这类失败误判成审批产品 blocker。

建议把这件事单列为工作站准备项：

1. 安装 `pnpm`
2. 在仓库根目录补齐 workspace 依赖
3. 再复跑审批相关最小套件

在此之前，`Wave 2` 可以继续做契约与切片设计，但不应声称“本机已经完成重新验收”。

---

## 5. Wave 2 包 1 的正确切法

`docs/development/approval-mvp-wave2-scope-breakdown-20260411.md` 把 `并行分支 / 会签 / 或签 / return 到指定节点 / 空审批人自动通过` 放在同一个工作包里，这个方向对，但如果一次性全上，会把执行器从“线性 + 条件分支”直接抬到“部分 DAG + 聚合状态机”，风险过高。

这次复核后的建议是：

- `Wave 2 包 1` 先做“审批节点能力扩展”
- `true parallel / join` 单独拆成 `Wave 2 包 1B`

也就是说，先做能在当前图模型上增量落地的能力，不在第一刀里强行引入 DAG 级复杂度。

---

## 6. 建议执行范围

### 6.1 Wave 2 包 1A: 审批节点能力扩展

这是建议立即启动的包。

目标能力：

- 会签: 同一审批节点支持 `all`
- 或签: 同一审批节点支持 `any`
- `return` 到指定已走过节点
- 审批人为空自动通过

建议的最小契约扩展：

- `approval` 节点配置新增 `approvalMode: 'single' | 'all' | 'any'`
- `approval` 节点配置新增空审批人策略
  - 推荐命名: `emptyAssigneePolicy: 'error' | 'auto-approve'`
  - 默认值保持保守，建议为 `error`
- `ApprovalActionRequest` 新增 `return`
- `return` 请求体新增 `targetNodeKey`
- 历史时间线增加多审批人聚合结果表达

保持不变的点：

- 图拓扑仍是 `start / approval / cc / condition / end`
- 不新增并行分支节点
- 不新增 join 节点
- 不改 PLM / 考勤接入边界

### 6.2 Wave 2 包 1B: 真并行与聚合节点

这一包建议后置，不和 `1A` 同时开。

原因：

- 当前 `ApprovalGraphExecutor.resolveAfterApprove()` 是单路径推进
- 当前实例态只有 `current_node_key/current_step/total_steps`，不适合表达多活跃节点
- 真并行意味着需要 join 条件、分支完成度、实例聚合状态，已经不是“给 approval 节点多加几个字段”能解决的事

因此 `1B` 至少要单独评审：

- 图模型是否允许多活跃节点
- 实例表是否需要新的运行时状态字段
- 历史与 assignment 如何表达 branch / join

在这些问题没定稿前，不建议把 true parallel 放进 `1A`。

---

## 7. Wave 2 包 1A 的实现切片

### 切片 1: 契约冻结

由主线 owner 负责。

内容：

- `approval-product.ts` 类型扩展
- `apps/web/src/types/approval.ts` 同步
- OpenAPI 契约同步
- `return` 语义与错误码固定
- `all / any / single` 的历史表达和响应字段固定

验收标准：

- 后端类型、前端类型、OpenAPI 三者一致
- 对旧模板完全向后兼容

### 切片 2: Executor / Service

由主线 owner 负责。

内容：

- `ApprovalGraphExecutor` 支持 `single / all / any`
- `ApprovalProductService.dispatchAction()` 支持 `return`
- 同节点聚合审批结果写入 `approval_records`
- 空审批人策略在运行时兑现

关键约束：

- 默认行为必须继续兼容当前 `single`
- 不允许把现有 `approve/reject/transfer/revoke/comment` 语义打坏

### 切片 3: 后端测试

由主线 owner 负责。

至少补齐：

- `single` 回归不变
- `all` 要求所有审批人处理后才推进
- `any` 任意一人通过即可推进
- `return` 只能退回到合法已走过审批节点
- `emptyAssigneePolicy=auto-approve` 能自动推进
- 历史时间线能表达聚合节点结果

### 切片 4: 前端消费与 UI 标注

可以并行给 Claude，但前提是切片 1 已冻结。

内容：

- 审批详情页展示 `会签 / 或签 / 单审` 标签
- 动作区支持 `return`
- 多审批人节点的状态文案、空状态、错误态
- 模板设计页 / 模板详情页展示新配置

### 切片 5: 文档与验收

可以并行给 Claude。

内容：

- API 指南补 `return / all / any / empty-assignee`
- Wave 2 包 1A 验收条目
- 与飞书审批差距表更新

---

## 8. 我与 Claude 的推荐分工

### 我负责

- 契约冻结
- `ApprovalGraphExecutor` 语义
- `ApprovalProductService` 动作推进
- 后端测试
- 兼容边界与 PR 收口

### Claude 负责

- 契约冻结后的前端 UI 消费
- 文档与差距表更新
- 只读 / 展示类测试
- Wave 2 包 1A 的前端产品壳演进

### 当前不建议交给 Claude 的部分

- executor 运行时语义
- 多审批人聚合状态
- `return` 的服务端边界
- 任何需要改运行时表语义的后端逻辑

原因很直接：这些部分一旦做错，不是 UI 小修，而是审批状态机出错。

---

## 9. 下一步顺序

建议按下面顺序推进：

1. 先把新电脑的依赖环境补齐，恢复最小本地验证能力
2. 开 `Wave 2 包 1A` 契约冻结 PR
3. 契约冻结后，Claude 开始前端消费与文档并行块
4. 主线同时做 executor / service / tests
5. `1A` 稳定后，再评审是否开启 `1B true parallel`

---

## 10. 最终判断

当前最稳妥的判断是：

- `Wave 1` 没有新增代码 blocker
- 当前真正阻塞的是:
  - 真实环境的 6 个验收项未关闭
  - 新电脑本地依赖未装全
- `Wave 2` 不应该直接上“大并行 DAG”
- 应先启动 `Wave 2 包 1A: 会签 / 或签 / return / 空审批人自动通过`

这是当前最小、最稳、能继续并行开发的切法。
