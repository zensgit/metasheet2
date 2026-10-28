# 审批与流程自动化收尾开发报告（2026-08-31）

**Status:** MERGED-SOURCE CLOSEOUT RECORD。本文记录代码与数据库迁移的落地事实，
不批准开关、部署、真实租户操作或产品完成标签。

| 项 | 值 |
|---|---|
| 报告基线 | `19f43285f4335ac325485b779afd73d210f9deb9` |
| 审批 / 自动化增量窗口 | `21932d08be`（#5368）→ `6d7cd1e76a`（#5365）→ `1a936c7dbf`（#5367） |
| 代码状态 | 三个 PR 均已合入 `main` |
| 数据库状态 | 三个自动化迁移已进入源码；本轮未在 staging / production 应用 |
| 开关状态 | 未新增或启用开关；目录停权门保持默认 OFF |
| 运行状态 | 未 dispatch、未部署、未执行真实租户或生产写入 |
| 完成标签 | `PRODUCT-FINAL = NO`；本文不签署其他 owner 标签 |

## 1. 与历史报告的关系

本文是增量收尾，不回写历史报告：

- `approval-remaining-dev-design-report-20260820.md` 对其读取基线仍然成立；
- 其中“F4-E 写入器已落地、生产派发未接线”已被 #5368 的新实现取代；
- 其中“F4-D 未落地”已被 #5368 的 prior-node 去重例外实现取代；
- 2026-08-30 新增的 guarded `real_fire` 与 retry 证据治理不在旧报告窗口内，由本文补记。

历史结论只在原 SHA 上有效。本文不把旧报告的测试数字、行号或产品结论整体重锚到当前 `main`。

## 2. Lock-4 运行时闭环

### 2.1 F4-B 指定兜底

#5368 将指定审批人兜底资格判断收敛到
`packages/core-backend/src/services/approval-designated-fallback-eligibility.ts`，并由
`ApprovalAssigneeResolver`、`ApprovalGraphExecutor` 与 `ApprovalProductService` 的现有运行路径消费。

实现边界：

- 只在已 ratify 的 `designated` 策略下尝试指定兜底；
- 组织、成员与授权状态不确定时 fail-closed；
- 不建立新的反向管理员枚举，也不扩大目录权限；
- 新增生产调用链、单测与 PostgreSQL 真库覆盖，不新增 flag 或迁移。

### 2.2 F4-D prior-node 去重例外

#5368 增加
`packages/core-backend/src/services/approval-prior-node-dedup-exemption.ts`，把“当前候选人曾在此前节点审批”
的例外限定在已 ratify 的节点历史与轮次边界内，再由执行器和产品服务消费。

该实现没有引入新的审批模式，也没有启用 `sequential`。它只闭合 Lock-4 的去重策略缺口，
保留既有 round / re-entry 保护和未知历史 fail-closed 行为。

### 2.3 F4-E 离职转直属上级生产调用链

#5368 新增
`packages/core-backend/src/approvals/approval-departure-transfer-dispatch.ts`，并在
`packages/core-backend/src/directory/directory-sync.ts` 的目录事务成功提交后立即消费已持久化的
`user_changed` 信号：

1. 目录事务完成并把 run 置为 `completed`；
2. 进入 post-commit 区域；
3. 调用 `dispatchApprovalDepartureTransfersForRun`；
4. 派发器按组织与离职用户解析直属上级，并调用既有
   `ApprovalProductService.applyApprovalDepartureTransfer`；
5. 邀请台账与其他 post-commit 兄弟工作随后独立执行。

关键不变量：

- 邀请台账或单用户派发失败不能跳过 F4-E；
- post-commit 兄弟失败不能把已提交且已完成的目录 run 改写为 `failed`；
- 故障证据保持 values-free，只记录稳定代码、计数和恢复提示；
- 派发查询按目录账号与本地用户的持久信号去重，每条信号逐条隔离处理；
- `DIRECTORY_DEPROVISION_ENABLED` 的组织级门保持默认 OFF。

因此，当前准确口径是“生产调用链已接线且源码已合并”，不是“离职自动转交已经在租户启用”。

## 3. Guarded real-fire 测试运行

#5365 为自动化测试运行增加受控 `real_fire` 模式。默认仍为 `simulate`。

入口与执行链：

- `packages/core-backend/src/routes/automation.ts` 校验管理权限、模式、显式
  `confirmSideEffects: true` 与样本记录可读性；
- `packages/core-backend/src/multitable/automation-service.ts` 生成服务端控制的 test-run root identity，
  不信任请求体提供运行时身份；
- 执行器、等待 / 恢复与审批 continuation 统一使用 `ledgerKind: 'test_run'`；
- Class-A / Class-B 外部动作继续受原有保护门与幂等台账约束；
- 不支持的动作族、缺失样本、权限不明或保护门未满足时 fail-closed。

该切片新增迁移：

- `zzzz20260830220000_add_automation_continuation_ledger_identity.ts`

迁移用于延续动作的 ledger identity，不代表外部写开关已开启。

## 4. 手动重试证据治理

#5367 收紧现有 `AutomationService.retryExecution`。这是管理员显式触发的整次执行重试，
不是后台自动重试 worker。

实现边界：

- 固定重试窗口绑定持久化 lineage root，而非当前请求时间；
- 首次重试在 dispatch 前通过持久 CAS 领取；
- 后续重试必须存在对应幂等证据，证据缺失时 fail-closed；
- 手动 test-run 不能进入 live execution 的 retry namespace；
- 已创建审批、规则缺失 / 禁用、规则指纹漂移、触发事件不可用或窗口过期均拒绝；
- Class-A 证据增加索引与 best-effort retention sweep。

该切片新增迁移：

- `zzzz20260830200000_add_automation_first_retry_attempt.ts`
- `zzzz20260830211000_add_automation_action_applied_retention_index.ts`

## 5. 部署顺序与回滚边界

若后续部署包含 #5365 / #5367，必须先在目标环境完成并核对上述三个迁移，再启动对应镜像。
本轮没有执行 staging 或 production migration，因此报告不能提供目标环境的 applied / pending 数字。

源码回滚边界：

- 应用镜像可按既有发布流程回滚；
- 已应用的加列 / 加索引迁移默认保留，除非另有经过验证的数据库回滚窗口；
- #5365 的本地验证覆盖 fresh apply，未执行其迁移 `down`；
- #5367 的两个迁移已单独执行 down / up 验证。

## 6. 明确保留的未完成项

以下事项未被本轮实现，也不得从“主队列已闭合”推导为已批准：

| 项 | 当前边界 |
|---|---|
| `auto_reject` | owner 延期；不得作为惰性第三选项出现 |
| `signaturePolicy` 运行时强制 | 仍为 declared-inert；需要独立 owner 决策与实现 |
| 节点内 `sequential` | 未进入运行时；不得与现有多节点顺序链混同 |
| #5174 多维表互通设计 | OPEN / owner-ratify HOLD |
| #5182 Lock-2B 联系人字段增量 | OPEN / owner-ratify HOLD |
| #5183 后加签延迟轮次 | OPEN / PROPOSED / HOLD |
| #5170 旧互通候选 | OPEN；由 owner 与 #5174 一并处置 |
| 自动重试 worker | 未实现；#5367 仅治理显式手动重试 |
| staging / production UAT | 本轮未执行 |

## 7. 收尾判定

本轮完成的是三条已 ratify 运行时切片的**源码与迁移合并闭环**：

- Lock-4 F4-B / F4-D / F4-E；
- guarded automation `real_fire`；
- 手动 retry 的证据与保留边界。

下一门属于交付与 owner 决策，不是继续堆功能：目标环境迁移预检、staging 部署、保持开关默认值、
受控 UAT、回滚演练及 owner 最终签署。完成这些门之前，不能写“已上线”“生产可用”或 `PRODUCT-FINAL = YES`。
