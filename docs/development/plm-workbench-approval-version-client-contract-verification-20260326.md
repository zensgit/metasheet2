# PLM Workbench Approval Version Client Contract Verification

## 变更范围

- `apps/web/src/views/approvalInboxActionPayload.ts`
- `apps/web/src/views/ApprovalInboxView.vue`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/plm/plmPanelModels.ts`
- `apps/web/src/services/PlmService.ts`
- `apps/web/tests/plmApprovalInboxActionPayload.spec.ts`
- `apps/web/tests/plmService.spec.ts`
- `packages/openapi/dist-sdk/client.ts`
- `packages/openapi/dist-sdk/client.js`
- `packages/openapi/dist-sdk/client.d.ts`
- `packages/openapi/dist-sdk/tests/client.test.ts`
- `packages/core-backend/src/routes/federation.ts`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
- `packages/core-backend/src/di/container.ts`
- `packages/core-backend/tests/unit/federation.contract.test.ts`

## 回归点

### 1. version 解析统一

`plmApprovalInboxActionPayload.spec.ts` 新增断言：

- `resolveApprovalActionVersion({ version: 3 }) === 3`
- `resolveApprovalActionVersion({ version: '4' }) === 4`
- 空字符串、负数、非数字字符串返回 `null`

这保证 inbox 和 product 页面对 optimistic-lock version 的读取语义一致。

### 2. PlmService 透传 version / reason

`plmService.spec.ts` 新增断言：

- `approveApproval()` 会把 `approvalId + version + comment` 发到 federation mutate
- `rejectApproval()` 会把 `approvalId + version + reason + comment` 发到 federation mutate

同时已有 fallback case 更新为显式传 `version`，避免继续依赖旧 contract。

### 3. SDK runtime 与类型同步

`packages/openapi/dist-sdk/tests/client.test.ts` 更新后锁定：

- `approveApproval({ version })` body 包含 `version`
- `rejectApproval({ version, reason, comment })` body 同时包含三者

这保证 SDK runtime 和类型声明不会再和后端审批协议漂移。

### 4. federation mutate 和 adapter 强制 version

`federation.contract.test.ts` 更新后锁定：

- `approval_approve` / `approval_reject` 缺少 `version` 会返回 `400`
- `approveApproval()` 会把 `approvalId + version + comment` 传给 adapter
- `rejectApproval()` 会把 `approvalId + version + comment` 传给 adapter
- 响应体里的 `version` 会沿 route 返回

这保证产品页和 inbox 走 federation mutate 时，不会在后端半路把 optimistic-lock version 吞掉。

## 执行记录

### Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmApprovalInboxActionPayload.spec.ts tests/plmService.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/openapi/dist-sdk
pnpm exec vitest run tests/client.test.ts
```

结果：

- 前端 focused：`2` 个文件 / `11` 个测试通过
- SDK focused：`1` 个文件 / `6` 个测试通过

### Backend Focused

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/federation.contract.test.ts
```

结果：

- backend focused：`1` 个文件 / `6` 个测试通过

### Type Check

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

### Frontend Full

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

结果：

- `59` 个文件 / `451` 个测试通过

### Backend Build

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```

结果：

- 通过
