# PLM Workbench Approval Actionability Verification

## 范围

验证 `PLM approvals` 的审批动作不再只按 `pending` 判定，而是要求当前 actor 真正匹配审批人。

## 回归

新增 focused 回归：

- [plmApprovalActionability.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmApprovalActionability.spec.ts)
- [usePlmAuthStatus.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmAuthStatus.spec.ts)

覆盖点：

1. actor ids 会从 `plm_token / auth_token / jwt` 正确解析并去重
2. row 上直接带 `approver_id` 时，只有命中的 actor 才可操作
3. row 缺审批人信息时，会回退到 approval history 的 pending `user_id`
4. 非 `pending` 或 actor 不匹配时，actionability 为 `false`

同时依赖：

- [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
- 全量 `plm*.spec.ts + usePlm*.spec.ts`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmApprovalActionability.spec.ts tests/usePlmAuthStatus.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`2` 个文件，`7` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：`PLM approvals` 的 `通过 / 拒绝` 已不再把“待处理”误当成“当前用户可处理”；按钮显示和 mutation guard 都对齐到了同一套 actor-aware actionability 合同。
