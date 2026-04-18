# 多维表治理权限模型验证说明

- 日期：2026-04-18
- Worktree：`.worktrees/dingtalk-member-group-role-sync-20260418`
- 分支：`codex/dingtalk-member-group-role-sync-20260418`

## 验证方式

这轮是文档设计收口，不涉及新的多维表运行时代码，因此验证重点是“设计是否和现有代码能力一致”。

## 检查命令

```bash
sed -n '1,220p' packages/core-backend/src/multitable/permission-derivation.ts
sed -n '1,220p' apps/web/src/multitable/components/MetaSheetPermissionManager.vue
sed -n '1,220p' apps/web/src/multitable/components/MetaRecordPermissionManager.vue
ls docs/development | rg 'multitable.*permissions|multitable.*matrix|permission.*matrix|field.*permission|record.*permission'
rg -n "field-permissions|view-permissions|records/.*/permissions|permission-derivation" packages/core-backend apps/web -g "*.{ts,vue}"
```

## 核对结果

### 1. 表级 / 视图级 / 列级 / 行级基础确实存在

从当前代码确认：

- sheet-level access：存在
- view-level permissions：存在
- field-level permissions：存在
- record-level permissions：存在

这说明“先做强列级 + 行级”的建议是建立在现有基础上的，不是脱离代码空想。

### 2. 当前列级能力已经支持隐藏 / 只读

`permission-derivation.ts` 里已经有：

- `MultitableFieldPermission`
- `FieldPermissionScope`
- `visible`
- `readOnly`

这与设计中“列级先做强”一致。

### 3. 当前行级能力已经支持 read / write / admin

`permission-derivation.ts` 里已经有：

- `RecordPermissionScope`
- `MultitableRecordPermission`

而 `MetaRecordPermissionManager.vue` 已提供记录级管理面。

这与设计中“行级继续强化”一致。

### 4. 当前尚未看到通用单元格级 ACL 模型

在本轮核对范围内，没有发现一套面向任意单元格的通用 ACL 模型。

因此把“单元格级”定位成后续少量例外层，而不是当前主线，是与现状一致的。

### 5. 与钉钉成员组治理方向不冲突

设计建议“成员组成为多维表 ACL 主体”的方向，与当前钉钉治理文档中：

- 钉钉部门 -> 平台成员组
- 平台成员组 -> 插件治理范围

是一致的，没有引入第二套平行主体模型。

## 结论

本轮新增的多维表权限模型设计，与当前仓库中的：

- sheet/view/field/record 权限能力
- 钉钉部门投影成员组的治理方向
- 插件管理员按 namespace + scope 管理的方向

保持一致。

## 部署

本轮不涉及部署。
本轮没有新增数据库迁移。
