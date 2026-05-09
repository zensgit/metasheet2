# DingTalk 治理工作台运营提示开发及验证

日期：2026-05-05

## 开发目标

在现有治理工作台 3 张快捷卡上补充实时运营提示，让管理员一进入页面就能判断：

- 今天先点哪张卡
- 目录修复是否还有积压
- 最近 7 天是否已有治理收口可复盘

## 本次改动

### 1. 工作台卡片改为带运营提示的动态卡

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `governanceWorkbenchCards` 计算属性。
- 3 张卡保持原有 deep link 不变，但每张卡新增实时提示：
  - `缺 OpenID 成员`
    - `今日优先处理 N 个待收口成员`
    - 或 `当前没有待收口成员需要优先处理`
  - `目录同步修复入口`
    - `N 个成员可先回目录同步继续补齐 openId`
    - 或 `当前没有需要回目录同步补齐的成员`
  - `最近 7 天收口审计`
    - `最近 7 天已收口 N 个成员，可直接复盘处理动作`
    - 或 `最近 7 天暂无新的收口记录`

### 2. 增加最近 N 天治理判断辅助函数

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `isWithinRecentDays()`，用于识别最近 7 天的钉钉扫码关闭记录。
- 工作台“最近 7 天收口审计”提示基于这个判断生成。

### 3. 工作台提示样式补齐

文件：
- `apps/web/src/views/UserManagementView.vue`

改动：
- 新增 `user-admin__workbench-note` 样式。
- 将运营提示和描述文案在视觉上区分开，更像“当前建议动作”。

## 验证

### 自动化测试

执行：

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts --watch=false
git diff --check
```

结果：
- `tests/userManagementView.spec.ts` 22/22 通过
- `git diff --check` 通过

### 本次新增覆盖

文件：
- `apps/web/tests/userManagementView.spec.ts`

新增验证：
- 工作台 3 张卡的 deep link 继续保持正确。
- 当 fixture 数据显示：
  - 当前无待收口成员
  - 有 1 个目录已链接但缺 openId 成员
  - 最近 7 天有 1 个已收口成员
  
  页面会分别显示对应的运营提示文案。

## 产出文件

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/userManagementView.spec.ts`
- `docs/development/dingtalk-governance-workbench-operational-hints-development-verification-20260505.md`
