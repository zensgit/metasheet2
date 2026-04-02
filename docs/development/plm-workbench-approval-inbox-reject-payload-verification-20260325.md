# PLM Workbench Approval Inbox Reject Payload Verification

## 范围

验证 `ApprovalInboxView` 的 reject payload 现在会正确携带 `reason`，并且 reject 的提交条件与后端合同一致。

## 回归

新增 focused 回归：

- [plmApprovalInboxActionPayload.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmApprovalInboxActionPayload.spec.ts)

覆盖点：

1. approve 可无 comment 提交
2. approve 有 comment 时只发 `comment`
3. reject 必须有非空原因
4. reject 有输入时会同时映射成 `reason + comment`

同时依赖：

- [ApprovalInboxView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/ApprovalInboxView.vue)
- 全量 `plm*.spec.ts + usePlm*.spec.ts`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmApprovalInboxActionPayload.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`1` 个文件，`3` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：Approval Inbox 的 reject 动作已经不再把“拒绝原因”错误地只当作可选 comment；前端提交条件、按钮状态和后端接口合同已一致。
