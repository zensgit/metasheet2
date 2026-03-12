# PLM Collaborative Audit Saved Views Verification

日期：2026-03-11

## 代码验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditSavedViews.spec.ts tests/plmAuditQueryState.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/web exec eslint src/views/PlmAuditView.vue src/views/plmAuditQueryState.ts src/views/plmAuditSavedViews.ts tests/plmAuditSavedViews.spec.ts --max-warnings=0`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

## 浏览器烟测

页面：

- `http://127.0.0.1:8899/plm/audit`

主路径：

1. 设置筛选：
   - `auditQ=documents`
   - `auditActor=dev-user`
   - `auditKind=documents`
   - `auditAction=archive`
   - `auditType=plm-team-view-batch`
   - `auditWindow=720`
2. 保存视图：`Documents Archive Saved`
3. 点击 `重置`
4. 点击已保存视图的 `应用`
5. 验证 URL、筛选字段、summary、表格行数一起恢复
6. 点击 `删除`
7. 验证 saved views 列表回到空状态，但当前路由和当前审计结果保留

## 浏览器结果

- 保存成功后，列表出现：
  - `Documents Archive Saved`
- 重置后，URL 退回：
  - `/plm/audit`
- 应用后，URL 恢复为：
  - `/plm/audit?auditQ=documents&auditActor=dev-user&auditKind=documents&auditAction=archive&auditType=plm-team-view-batch&auditWindow=720`
- summary 恢复为：
  - `窗口 720 分钟`
  - `资源桶 12`
  - `主要动作 归档`
- 表格收敛到 `3` 条 `documents archive / team-view-batch` 记录
- 删除 saved view 后：
  - 列表回到 `暂无已保存的审计视图`
  - 当前 route state 保持不变

## 产物

- browser artifact:
  - [plm-collaborative-audit-saved-views-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-saved-views-browser-20260311.json)
- cleanup artifact:
  - [plm-collaborative-audit-saved-views-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-collaborative-audit-saved-views-cleanup-20260311.json)
- screenshot:
  - [page-plm-collaborative-audit-saved-views.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-saved-views-20260311/page-plm-collaborative-audit-saved-views.png)
- snapshot:
  - [page-plm-collaborative-audit-saved-views.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-collaborative-audit-saved-views-20260311/page-plm-collaborative-audit-saved-views.txt)

## 清理

- 本轮 localStorage key `metasheet_plm_audit_saved_views` 已清空
- 未创建额外 backend/live 数据对象
