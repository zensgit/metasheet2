# PLM 审批到平台审批/工作流桥接设计

日期: 2026-03-08

## 目标

本阶段不直接替换现有 PLM 联邦审批链，而是先补一层可验证的桥接模型，让 PLM ECO 审批能够逐步收口到平台审批/工作流语义。

## 当前事实

- PLM 审批仍走 `/api/federation/plm/query` 和 `/api/federation/plm/mutate`
- 平台审批走 `/api/approvals/*`
- 平台工作流走 `/api/workflow/*`
- 两套模型当前并行存在，尚未统一

## 最小桥接策略

1. 先把 PLM 审批实体映射成平台侧可识别的桥接记录
2. 桥接记录只描述:
   - 外部来源
   - 业务主键
   - 建议 workflow key
   - 标题 / 状态 / 请求人 / 产品主体
   - 审批策略
3. 当前阶段不改变上游 PLM 仍为 source of truth 的事实

## 建议映射

| PLM 字段 | 平台桥接字段 |
| --- | --- |
| `id` | `externalApprovalId` |
| `product_id` | `businessKey` (`plm:product:<id>`) |
| `title` / `product_number` | `title` |
| `status` | `status` |
| `requester_id` / `requester_name` | `requester` |
| `type` / `stage` | `metadata.source_type` / `metadata.source_stage` |

## 最小落地

本次已新增桥接模块:

- [plm-approval-bridge.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/federation/plm-approval-bridge.ts)

提供:

- `toPlatformApprovalBridgeRecord()`
- `createPlmApprovalBridgePreview()`

对应测试:

- [plm-approval-bridge.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-approval-bridge.test.ts)

## 下一步

1. 在 federation/PLM route 读取审批列表后，增加 bridge preview 输出能力
2. 平台审批 UI 可以先消费 preview，不立即接管审批动作
3. 等 workflow key、instance lifecycle、审计语义稳定后，再考虑真正的 upsert / sync
