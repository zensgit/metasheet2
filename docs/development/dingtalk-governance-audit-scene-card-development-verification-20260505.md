# DingTalk 治理审计场景卡开发及验证

日期：2026-05-05

## 开发目标

在管理审计页提供一个不依赖用户管理页跳转的钉钉治理快捷入口，让管理员可以直接进入 `user-auth-grant + revoke` 审计场景。

## 本次改动

### 1. 审计页增加治理场景卡

文件：
- `apps/web/src/views/AdminAuditView.vue`

改动：
- 在审计页顶部新增“钉钉治理动作”场景卡。
- 点击后自动切换为：
  - `resourceType=user-auth-grant`
  - `action=revoke`
- 切换时清空 `actorId/resourceId/from/to`，避免旧筛选条件污染治理视角。
- 当当前筛选已经等于该治理场景时，按钮显示为“当前场景已应用”。

### 2. 增加 URL 同步

文件：
- `apps/web/src/views/AdminAuditView.vue`

改动：
- 新增筛选到地址栏的同步逻辑。
- 场景卡点击后，地址栏会稳定反映为：
  - `/admin/audit?resourceType=user-auth-grant&action=revoke`
- 这样管理员可以直接刷新、复制链接或再次进入该治理场景。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/adminAuditView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/adminAuditView.spec.ts` 7/7 通过
- `git diff --check` 通过

### 本次新增测试覆盖

文件：
- `apps/web/tests/adminAuditView.spec.ts`

覆盖点：
- deep link 进入 `resourceType=user-auth-grant&action=revoke` 时，审计页会自动进入钉钉治理场景。
- 点击“打开钉钉治理审计”后：
  - 资源筛选变为 `user-auth-grant`
  - 动作筛选变为 `revoke`
  - 请求 URL 带上对应 query
  - 地址栏同步为治理场景链接
  - 页面显示“当前场景已应用”

## 产出文件

- `apps/web/src/views/AdminAuditView.vue`
- `apps/web/tests/adminAuditView.spec.ts`
- `docs/development/dingtalk-governance-audit-scene-card-development-verification-20260505.md`
