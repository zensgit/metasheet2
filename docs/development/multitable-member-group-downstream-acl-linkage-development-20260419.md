# 成员组下游 ACL 联动开发说明 2026-04-19

## 目标

在现有“成员组 field/view ACL 模板复制”基础上，再补一个更接近真实治理动作的入口：

- 管理员在 `Sheet Access` 里看到两个已授权成员组
- 可以直接从一个成员组复制完整的下游 ACL 到另一个成员组
- 范围包括：
  - field override
  - view override
- 复制过程中仍然会清理目标成员组多余的旧 override，保证目标与模板源对齐

本轮不扩新权限模型，不新增后端接口，不新增数据库结构。

## 方案

### Sheet 层增加“完整下游 ACL”复制入口

在 `MetaSheetPermissionManager` 的 `Sheet Access` tab 中：

- 仅对 `member-group` 当前 ACL 行显示
- 新增：
  - `Copy downstream ACL…` 来源成员组选择器
  - `Copy field+view ACL` 动作按钮

点击后会：

1. 复制源成员组的所有 field override 到目标成员组
2. 复制源成员组的所有 view override 到目标成员组
3. 如果目标成员组存在源里没有的旧 override，则一并清掉

### 实现方式

- 抽出内部 helper：
  - `syncFieldTemplateBetweenMemberGroups`
  - `syncViewTemplateBetweenMemberGroups`
- 原有 `Field Permissions / View Permissions` tab 的逐类复制逻辑复用这两个 helper
- `Sheet Access` 的新动作则一次调用两类 helper，形成完整下游 ACL 同步

## 关键改动

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
  - `Sheet Access` 行新增成员组下游 ACL 复制入口
  - 抽出 field/view 模板同步 helper
  - 复用到：
    - field tab 的模板复制
    - view tab 的模板复制
    - sheet tab 的完整下游 ACL 复制
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
  - 新增 sheet tab 一次复制 field + view ACL 的回归

## 行为边界

- 仅对 `member-group` 主体开放
- 仅复制当前 sheet 下的 field/view override
- 不改 sheet access 本身
- 不改 record ACL
- 不复制到 user / role 主体

## 范围外

- 跨 sheet 的 ACL 模板库
- ACL 模板持久化
- record ACL 模板联动
- 后端批量同步 API

## 部署影响

- 本轮没有后端改动
- 本轮没有数据库迁移
- 本轮没有远端部署
