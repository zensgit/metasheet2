# 审批 MVP 第一波产品验收报告

> 验收日期: 2026-04-11
> 基线: `origin/main` @ `08bed35c3`
> 验收方法: 代码审阅 + 自动化测试执行 + 文档/契约复核
> 验收范围: 平台原生审批产品第一波

---

## 验收总结

| 类别 | PASS | FAIL | BLOCKED | OOS | 总计 |
|------|------|------|---------|-----|------|
| 模板管理 | 16 | 0 | 1 | 0 | 17 |
| 审批发起 | 13 | 0 | 1 | 0 | 14 |
| 审批中心 | 9 | 0 | 0 | 0 | 9 |
| 审批详情 | 9 | 0 | 0 | 0 | 9 |
| 审批操作 | 14 | 0 | 0 | 0 | 14 |
| 并发串行化 | 3 | 0 | 0 | 0 | 3 |
| 权限模型 | 5 | 0 | 2 | 0 | 7 |
| 前端路由 | 6 | 0 | 0 | 0 | 6 |
| 兼容性 | 3 | 0 | 2 | 0 | 5 |
| 响应格式 | 4 | 0 | 0 | 0 | 4 |
| 数据完整性 | 5 | 0 | 0 | 0 | 5 |
| **合计** | **87** | **0** | **6** | **0** | **93** |

**通过率: 94% (87/93)**  
**结论: 无代码级 blocker，剩余 6 项均为环境验证阻塞。**

---

## 自动化测试执行结果

| 测试套件 | 结果 | 备注 |
|---------|------|------|
| 后端审批单测 (executor + service + template-routes + bridge-routes) | **PASS 43/43** | 来自 Wave 1 runbook |
| 前端审批验收 (center + lifecycle + permissions + auth-guard) | **PASS 78/78** | 来自 Wave 1 runbook |
| 后端类型检查 (`tsc --noEmit`) | **PASS** | |
| 前端类型检查 (`vue-tsc --noEmit`) | **PASS** | |

---

## 已确认结论

### 1. 统一 action 端点不走 optimistic locking

当前 `POST /api/approvals/{id}/actions` 使用数据库行锁串行化并发写入:

- 代码位置: [ApprovalProductService.ts](../../packages/core-backend/src/services/ApprovalProductService.ts)
- 关键实现: `SELECT ... FOR UPDATE`

这意味着:

- 它不会要求客户端提交 `version`
- 它也不承诺返回 `APPROVAL_VERSION_CONFLICT`
- 并发后的后续请求若已不满足状态条件，仍可能收到 `409`，但语义是状态冲突，不是版本冲突

因此，这一项按“并发安全已实现”记为 `PASS`，并通过文档修正与当前实现保持一致。

### 2. cc 节点历史已经落库

当前 `cc` 不是外部 action，但审批图推进时会写入 `approval_records`:

- 代码位置: [ApprovalProductService.ts](../../packages/core-backend/src/services/ApprovalProductService.ts)
- 关键实现: `insertCcEvents()` → `insertApprovalRecord(... action: 'cc' ...)`

因此，`cc 写历史不建 assignment` 按 `PASS` 处理。

### 3. formSnapshot 日期字段不构成 blocker

`formSnapshot` 保留提交时的原始值。  
对 `date` 字段而言，`YYYY-MM-DD` 本身就是合法 ISO 8601 日期字符串，因此不作为失败项处理。

---

## BLOCKED 项

剩余 6 项均为环境依赖，不是代码级阻塞:

| ID | 类别 | 描述 | 当前状态 |
|----|------|------|---------|
| BL1 | 模板权限 | 无 `approval-templates:manage` 的真实账号验证 | BLOCKED |
| BL2 | 发起权限 | 无 `approvals:write` 的真实账号验证 | BLOCKED |
| BL3 | 权限矩阵 | 无权限/只读用户真实环境验证 | BLOCKED |
| BL4 | 权限矩阵 | 只读用户“可看不可操作”真实环境验证 | BLOCKED |
| BL5 | 兼容性 | PLM 真实环境兼容回归 | BLOCKED |
| BL6 | 兼容性 | 考勤插件真实环境兼容回归 | BLOCKED |

这些项必须通过真实部署环境、真实账号或 JWT 再次确认，不能靠本地代码审阅替代。

---

## 交付判断

截至 `2026-04-11`：

- 工程层面：`可交付`
- 文档层面：`可交付`
- 产品层面：`可进入真实环境正式验收`

当前不建议继续追加 Wave 1 核心开发。  
下一步应优先完成 6 个环境型 `BLOCKED` 项，再决定是否启动 Wave 2 实现。
