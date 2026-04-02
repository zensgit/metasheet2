# PLM Collaborative Audit Saved Views Benchmark Design

日期：2026-03-11

## 目标

- 让 `/plm/audit` 拥有与 `Workflow Hub saved views` 同级的本地视图保存能力。
- 保存的对象必须复用现有 `auditPage / auditQ / auditActor / auditKind / auditAction / auditType / auditFrom / auditTo / auditWindow` 协议。
- 应用已保存视图时，必须走同一条 route-driven 恢复链路，不能绕过 URL。

## 对标基线

- 现有基线来自 `Workflow Hub` 的本地 saved views：
  - 名称去重更新
  - localStorage 持久化
  - 最近更新时间排序
- `PLM audit` 已有 query/export 能力，但缺少“保存当前筛选工作视角”的低成本复用入口。

## 本轮设计

### 1. 独立 saved views 存储层

新增：

- `apps/web/src/views/plmAuditSavedViews.ts`

模型：

- `PlmAuditSavedView`
  - `id`
  - `name`
  - `state: PlmAuditRouteState`
  - `updatedAt`

行为：

- `readPlmAuditSavedViews()`
- `savePlmAuditSavedView()`
- `deletePlmAuditSavedView()`

约束：

- localStorage key: `metasheet_plm_audit_saved_views`
- 最多保留 `8` 条
- 同名视图更新，不新增重复条目

### 2. 页面接线

在 `PlmAuditView.vue` 增加：

- 当前筛选保存输入框
- `保存当前视图`
- saved view 卡片列表
- `应用`
- `删除`

恢复逻辑：

- `applySavedView()` 不直接改各个字段
- 统一调用 `syncRouteState(view.state)`
- 继续由已有 `watch(route.query)` 执行 `parse -> apply -> loadSummary/loadLogs`

这样可以保证：

- 浏览器历史一致
- 分享链接一致
- 导出 CSV 与当前视图一致

### 3. UI 边界

- `删除 saved view` 只删除 localStorage 条目
- 不清空当前 route state
- 因而不会意外打断用户正在看的审计结果

## 超越目标

相对纯粹的“本地收藏夹”，本轮多做了两点：

- saved view 直接绑定 `route state`，不是单独的一套页面内状态
- 删除 saved view 后保留当前审计上下文，避免“管理 saved view”反过来重置工作视角

## 后续建议

- 如果继续深化，下一步最自然的是：
  - `PLM audit shared/team views`
  - 或统一的 `PLM collaborative audit workbench`，把保存视图扩展成对象类型 tabs + 常用过滤组合
