# DingTalk 治理统计到审计场景快捷入口开发及验证

日期：2026-05-05

## 开发目标

把用户管理页里的 DingTalk 治理统计直接接到审计页场景，减少管理员从“看到待收口数量”到“进入审计定位动作”的跳转成本。

## 本次改动

### 1. 用户管理页 summary 卡片增加快捷入口

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 将治理 summary 中两项指标改为可点击入口：
  - `待收口`
    - 跳转到全量钉钉治理审计：
    - `/admin/audit?resourceType=user-auth-grant&action=revoke`
  - `已收口`
    - 跳转到最近 7 天收口审计：
    - `/admin/audit?resourceType=user-auth-grant&action=revoke&from=...&to=...`

### 2. 新增最近 7 天治理审计链接构造

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 增加 `buildRecentDingTalkGovernanceAuditLocation()`
- 自动生成最近 7 天的 `from/to` 审计区间，和审计页新增的“最近 7 天收口结果”场景保持一致。

### 3. summary 卡片交互样式补齐

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `user-admin__metric-link`
- 让“已收口/待收口”在视觉上保持 summary 卡片形态，并增加 hover 高亮，避免像普通文本链接。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 18/18 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- `待收口` summary 指标会跳到全量钉钉治理审计。
- `已收口` summary 指标会跳到最近 7 天治理审计，并带上固定 `from/to` query。
- 原有“查看钉钉治理审计”入口仍保持不变。

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-summary-audit-links-development-verification-20260505.md`
