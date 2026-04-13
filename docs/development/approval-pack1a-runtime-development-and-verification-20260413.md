# Approval Pack1A Runtime Development And Verification

> 日期: `2026-04-13`
> 分支: `codex/approval-pack1a-runtime-20260413`
> 基线: `origin/codex/approval-pack1a-contracts-20260413` @ `4279061ed`
> 实现提交: `199bb14aa feat(approvals): implement pack1a runtime actions`

## 1. 目标

本次实现只覆盖审批 `Wave 2 / Pack 1A runtime` 的后端执行语义，不扩展到 true parallel/join，也不改 `PLM`、`考勤` 的兼容边界。

本次需要兑现的能力：

- `approvalMode: single | all | any`
- `return + targetNodeKey`
- `emptyAssigneePolicy: error | auto-approve`
- 对应的历史、assignment、状态推进与单元回归

## 2. 实现范围

### 2.1 Runtime executor

文件：

- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`

本次新增：

- `ApprovalGraphAutoApprovalEvent`
- `ApprovalGraphResolution.autoApprovalEvents`
- `getApprovalMode(nodeKey)`
- `resolveReturnToNode(targetNodeKey)`
- `listVisitedApprovalNodeKeysUntil(currentNodeKey)`

语义变化：

- 审批节点默认仍按 `single` 处理，保持旧行为兼容。
- 当审批节点 `assigneeIds=[]` 且 `emptyAssigneePolicy='auto-approve'` 时：
  - executor 直接跳过当前审批节点
  - 继续解析后续节点
  - 产出系统自动通过事件，交给 service 写入历史
- 当审批节点 `assigneeIds=[]` 且策略不是 `auto-approve` 时：
  - executor 明确抛错，不再静默生成空 assignment
- `return` 的合法目标通过当前运行路径计算，不允许退回到当前节点本身，也不允许跳到未走过的审批节点

### 2.2 Product service

文件：

- `packages/core-backend/src/services/ApprovalProductService.ts`

本次落地：

- 创建实例时写入 `autoApprovalEvents`
- `transfer` 改为只关闭当前 actor 在当前节点命中的 assignment，不再粗暴关闭整节点全部活跃 assignment
- `return` 由占位报错改为真实语义：
  - 校验 `targetNodeKey`
  - 校验目标必须是当前路径上已走过的审批节点
  - 关闭当前活跃 assignment
  - 回到目标节点并重建目标节点 assignment
  - 写 `return` 历史
- `all` 模式改为聚合审批：
  - 当前 actor 审批后，仅关闭自己的 assignment
  - 若同节点仍有其他活跃 assignment，则实例保持 `pending`
  - 写 `approve` 历史并标 `aggregateComplete=false`
  - 只有最后一个审批人处理后，流程才真正推进
- `single/any` 继续走“当前节点完成即推进”的路径
- 自动通过节点现在会统一写入系统 `approve` 历史，metadata 带：
  - `autoApproved: true`
  - `reason: 'empty-assignee'`
  - `approvalMode`

## 3. 变更文件

- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/tests/unit/approval-graph-executor.test.ts`
- `packages/core-backend/tests/unit/approval-product-service.test.ts`

## 4. 验证覆盖

### 4.1 新增或补强的场景

`approval-graph-executor.test.ts`：

- date-only 条件比较仍然正确
- 空审批人 + `auto-approve` 会自动跳过节点并产出系统自动通过事件
- `listVisitedApprovalNodeKeysUntil()` 能按当前活跃路径给出合法 return 候选链

`approval-product-service.test.ts`：

- `return` 拒绝非法目标节点
- `return` 成功退回到已走过节点并重建 assignment
- `all` 模式下第一位审批人处理后实例仍保持 `pending`
- 既有 `revoke` policy / revoke window 约束不回归

### 4.2 实际执行的验证命令

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-template-routes.test.ts \
  tests/unit/approvals-routes.test.ts \
  --reporter=dot

pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false

git diff --check
```

### 4.3 验证结果

- `approval-graph-executor.test.ts`: `7/7 PASS`
- `approval-product-service.test.ts`: `5/5 PASS`
- `approval-template-routes.test.ts`: `4/4 PASS`
- `approvals-routes.test.ts`: `12/12 PASS`
- `tsc --noEmit`: `PASS`
- `git diff --check`: `PASS`

合计本轮直接回归：

- `4` 个测试文件
- `28` 个测试用例

## 5. 兼容与边界说明

本次明确保持不变的边界：

- 不引入 true parallel / join
- 不修改 `PLM` bridge 旧动作模型
- 不把 `考勤` 与 `PLM` 拉入统一 Inbox
- 不新增前端 runtime 交互改动

本次对旧行为的兼容判断：

- 旧模板未声明 `approvalMode` 时，仍按 `single` 执行
- 旧模板未声明 `emptyAssigneePolicy` 时，仍按保守语义处理，不自动通过
- 旧 `approve / reject / revoke / comment` 路径仍保留

## 6. 残余事项

Pack 1A runtime 完成后，后续仍需单独收口以下事项：

- 将当前 runtime 分支发布为 stacked PR，base 指向 `codex/approval-pack1a-contracts-20260413`
- 补前端对 `return / all / any / auto-approve` 的消费与 UI 表达
- 补更高层集成验证，覆盖“建模板 -> 发布 -> 发起 -> all/return/auto-approve”完整链路
- 评审是否开启 `Pack 1B true parallel / join`

## 7. 当前结论

截至本文件落地时，`Pack 1A runtime` 的核心后端执行语义已经可以单独审阅：

- 契约面与 runtime 面已对齐
- 旧 `return not implemented` 占位已经移除
- `all` 模式不再错误地提前推进流程
- 空审批人节点不再靠隐式空 assignment 漏过执行

结论：本轮代码已达到可开 stacked PR、可继续前端并行消费、可进入下一轮集成验证的状态。
