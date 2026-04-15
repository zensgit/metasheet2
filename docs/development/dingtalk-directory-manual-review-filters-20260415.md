# DingTalk Directory Manual Review Filters

## Goal

继续把目录 review queue 做成真正可运营的管理员工作台。

在“推荐优先默认流”之后，管理员仍然需要面对一批 `pending_binding` 的人工处理项；如果这些项只按列表平铺展示，管理员还是需要逐条阅读“推荐判断”文案，效率不高。

本轮目标：

- 把 `需人工处理` 再按原因拆成可直接点击的子视图。
- 优先把最常见、最有运营价值的两类拆出来：
  - `无精确匹配`
  - `冲突待复核`
- 保持现有后端推荐规则不变，不扩展 review item API。

## Implementation

### Frontend

- 在 `apps/web/src/views/DirectoryManagementView.vue` 为 `pending_binding` 的人工处理项新增 `PendingBindingManualReasonFilter`：
  - `all`
  - `no_exact_match`
  - `conflict`
- 继续沿用后端已有的 `recommendationStatus.code` 做前端归类：
  - `no_exact_match` 归到“无精确匹配”
  - 其余人工状态：
    - `ambiguous_exact_match`
    - `pending_link_conflict`
    - `linked_user_conflict`
    - `external_identity_conflict`
    统一归到“冲突待复核”
- 在待处理队列头部增加人工项概览：
  - `人工处理中：无精确匹配 X · 冲突待复核 Y`
- 当管理员切到 `需人工处理` 时，展示新的原因筛选按钮：
  - `全部人工`
  - `无精确匹配`
  - `冲突待复核`
- 刷新队列时，如果当前人工原因筛选已无命中项，会自动回退到 `全部人工`，避免管理员停留在空视图。

说明：

- 这轮没有改后端推荐判定。
- 前端只是把已存在的 `recommendationStatus.code` 做成更可操作的运营分组。

## Tests

前端测试更新在：

- `apps/web/tests/directoryManagementView.spec.ts`

覆盖点：

- 切到 `需人工处理` 后会显示人工原因统计与筛选按钮。
- `无精确匹配` 子视图只展示没有唯一精确候选的目录成员。
- `冲突待复核` 子视图只展示存在精确匹配冲突或待确认绑定冲突的目录成员。
- 当某个人工原因在刷新后已无可处理项时，页面会安全回退到 `全部人工`。

## Verification

通过：

```bash
pnpm --filter @metasheet/web exec vitest run --api.port 0 tests/directoryManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

`Claude Code CLI`：

- 已调用只读检查当前 review queue 实现；
- 这轮最终结论仍以本地代码和本地测试结果为准。
