# DingTalk 治理审计场景预设开发及验证

日期：2026-05-05

## 开发目标

在管理审计页把钉钉治理相关审计从“单一 deep link”升级为可直接操作的场景预设，便于管理员快速切换：

- 全量钉钉治理动作
- 最近 7 天收口结果

## 本次改动

### 1. 审计页场景卡升级为双场景

文件：
- `apps/web/src/views/AdminAuditView.vue`

改动：
- 将原有单张“钉钉治理动作”卡升级为场景列表。
- 新增两个可直接应用的审计场景：
  - `钉钉治理动作`
    - `resourceType=user-auth-grant`
    - `action=revoke`
  - `最近 7 天收口结果`
    - `resourceType=user-auth-grant`
    - `action=revoke`
    - 自动带入最近 7 天的 `from/to`

### 2. 增加场景激活识别

文件：
- `apps/web/src/views/AdminAuditView.vue`

改动：
- 增加 `activeSceneKey` 识别逻辑：
  - 没有附加日期范围时，识别为“钉钉治理动作”
  - 日期范围等于最近 7 天时，识别为“最近 7 天收口结果”
- 当前已命中的场景会显示“当前场景已应用”。

### 3. 保持 URL 可复制与可重进

文件：
- `apps/web/src/views/AdminAuditView.vue`

改动：
- 场景切换后继续同步 query 到地址栏。
- “最近 7 天收口结果”会把日期范围一并写入 URL，便于值班巡检时复制、刷新和回访。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/adminAuditView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/adminAuditView.spec.ts` 8/8 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/adminAuditView.spec.ts`

新增验证：
- deep link 进入 `resourceType=user-auth-grant&action=revoke` 时，会自动识别为当前钉钉治理场景。
- 点击“打开钉钉治理审计”后：
  - 自动切换到钉钉治理场景
  - 地址栏同步为治理 query
- 点击“查看最近 7 天收口”后：
  - 自动切换到 `user-auth-grant + revoke`
  - 日期输入框填充最近 7 天
  - 请求 URL 带上对应 `from/to`
  - 地址栏同步为最近 7 天治理 query

## 产出文件

- `apps/web/src/views/AdminAuditView.vue`
- `apps/web/tests/adminAuditView.spec.ts`
- `docs/development/dingtalk-governance-audit-scene-presets-development-verification-20260505.md`
