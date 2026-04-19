# 成员组 ACL 模板联动开发说明 2026-04-19

## 目标

在现有 multitable 成员组 ACL 基础上，补一个最小但实用的治理增强：

- 管理员已经为某个成员组配置好的 field/view ACL override
- 可以直接复制到另一个已具备 sheet access 的成员组
- 并且会清掉目标成员组多余的旧 override，使目标和模板源保持一致

本轮不扩新权限模型，不新增后端 API，不新增数据库结构。

## 方案

### Field ACL 模板复制

在 `MetaSheetPermissionManager` 的 `Field Permissions` tab 里：

- 对每个当前已授权的成员组主体
- 新增一个 `Copy from member group…` 选择器
- 可从其它已具备 sheet access 的成员组里选一个模板源
- 点击 `Copy ACL` 后：
  - 源成员组对每个 field 的 override 会复制到目标成员组
  - 若源成员组某字段没有 override，但目标成员组有旧 override，则会自动清掉目标旧 override

### View ACL 模板复制

同样逻辑应用到 `View Permissions` tab：

- 复制源成员组的 view override 到目标成员组
- 目标成员组多余的旧 view override 会被清理成 `none`

## 关键改动

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
  - 新增成员组模板源选择状态
  - 新增 field/view 模板复制动作
  - 模板复制基于现有 `fieldPermissionEntries / viewPermissionEntries` 计算
  - 复用现有：
    - `updateFieldPermission`
    - `updateViewPermission`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
  - 新增 field 模板复制测试
  - 新增 view 模板复制测试

## 行为边界

- 仅对 `member-group` 主体开放模板复制
- 仅在目标成员组已经有 sheet access 的前提下可用
- 模板复制只影响当前 sheet 下的 field/view override
- 不改 sheet access 本身
- 不改 record ACL
- 不复制到 user / role 主体

## 范围外

- 跨 sheet 的 ACL 模板库
- 成员组 ACL 模板持久化
- 成员组 ACL 和 record ACL 联动模板
- 后端批量模板 API

## 部署影响

- 本轮没有后端改动
- 本轮没有数据库迁移
- 本轮没有远端部署
