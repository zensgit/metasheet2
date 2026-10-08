# 备料一线角色授权方案与依据

日期：2026-09-16
适用实例：客户现场 222（单租户 on-prem，3 个用户：2 个平台管理员 + 1 个测试一线账号）
结论先行：**已按"最窄可用"执行**——三个全局码 + 一张表级写授权；**没有**授予全局 `multitable:read`。
关联：#5741（`approvals:read` 未播种）、#5776（实例级读取放行参与人）、#5788（列表无归属谓词）、#5734（窄的记录送审码）

## 0. 为什么要有这份文档

阶段二把"记录级送审"和"审批进度卡片"做进了多维表的记录抽屉，但这两个功能在 222 上**只有管理员能用**。追下去发现问题比预想的靠前：一线角色连备料表都打不开。本文记录整条链上每一道门、我们选了哪条路、为什么不选另一条，以及新建备料应用后会发生什么。

## 1. 起点：一线角色当时的真实状态（只读实测）

| 事实 | 值 |
| --- | --- |
| 角色 `备料一线操作员`（id `stock-prep-operator`）持有的权限码 | 恰好两个：`stock-prep:operate`、`stock-prep:read` |
| 成员数 | 1（`test-operator-stockprep`，非管理员） |
| 备料表 `spreadsheet_permissions` 行数 | 0（全实例也是 0，这套机制从未被用过） |
| 该用户的活动组织数 | 恰好 1（审批实例派生组织要求恰好一行，否则 422） |
| 审批模板「备料送审示例」 | `published`，`visibility_scope.type = all` |

**第一停点因此不是送审，是打不开表**：`/api/multitable/context` 算出 `canRead=false`，直接 403，网格不渲染。

## 2. 一个必须先讲的教训：此前的管理员实测不算数

`rbacGuard` 有两处全局管理员旁路跑在权限查找之前（`rbac/rbac.ts:68-72` 认 JWT 的 role/roles，`:93-98` 认 DB 的 `isAdmin`）。而 222 的 `admin` 角色的 25 个码里**没有 `approvals:write`**——也就是说：

- 阶段二"送审端到端跑通"这个结论，走的是旁路，`approvals:write` 这条分支在 222 上从未被执行过一次。
- `/context` 的能力位对管理员是 token 短路（`multitable/access.ts:82-85`），一次库都不查，与任何 DB 授权状态无关。
- `deriveCanSubmitApproval` 第一行就是 `if (isAdminRole) return true`（`multitable/submit-approval-permission.ts:44`），码匹配分支没走过。

唯一一处管理员实测确实执行了真实码分支的是模板可读性门（`multitable/automation-approval-template-access.ts:29-38`，它**没有**管理员旁路），管理员能过纯粹因为 admin 角色恰好持有 `approvals:read`。

**推论**：任何以管理员身份做的权限结论，都不能外推到一线。

## 3. 整条链的门（送审 → 回读 → 进度）

| # | 门 | 位置 | 一线需要什么 |
| --- | --- | --- | --- |
| 1 | `/context` 的 `canRead` | `multitable/access.ts:109-112` | 全局 `multitable:read`/`write`，**或**该表一行表级授权 |
| 2 | `/context` 的 `canSubmitApproval` | `access.ts:134` → `submit-approval-permission.ts:39-46` | 全局 `multitable:submit-approval`（表级授权**永远无法**赋予它，只能收窄：`permission-service.ts:1492-1494`） |
| 3 | 送审路由第一道：记录可读 | `routes/multitable-record-approvals.ts:128-129` | 同 #1 |
| 4 | 送审路由第二道：`canSubmitApproval` | 同上 `:133-135` | 同 #2 |
| 5 | 送审路由第三道：模板可读 | 同上 `:138-141` → `automation-approval-template-access.ts:29-38` | `approvals:read`（此门无管理员旁路） |
| 6 | 发起审批：`loadAuthorizedApprovalActor` + 事务内复核 | `automation-approval-bridge-service.ts:272-274`；`services/approval-record-link-txn-auth.ts:558-577` | `approvals:write` |
| 7 | 实例归属组织派生 | `services/approval-instance-org-derivation.ts:88-91` | 非权限条件：活动组织**恰好一行**，否则 422 |
| 8 | 进度卡片（前端门） | `MetaRecordApprovalPanel.vue` | `approvals:read`（见 §6 的遗留问题） |

## 4. 已执行（可回滚）

```sql
-- 4.1 目录表补行：approvals:write 此前不存在，而 role_permissions 有外键指向 permissions(code)，
--     不补这行，后面的授权 SQL 会直接 FK 失败。
INSERT INTO permissions (code, name, description)
SELECT 'approvals:write','Approvals Write','Create approval instances ...'
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE code='approvals:write');

-- 4.2 三个与"读权限策略"无关的全局码
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, c.code FROM roles r
CROSS JOIN (VALUES ('multitable:submit-approval'),('approvals:read'),('approvals:write')) AS c(code)
WHERE r.name='备料一线操作员'
  AND EXISTS (SELECT 1 FROM permissions p WHERE p.code=c.code)
ON CONFLICT DO NOTHING;

-- 4.3 读权限：表级、给角色、write 级（不是 read，见 §5）
INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
SELECT 'sheet_32df959afa3cecfa564e5486', NULL, 'role', r.id, 'spreadsheet:write'
FROM roles r WHERE r.name='备料一线操作员'
ON CONFLICT DO NOTHING;
```

回滚：
```sql
DELETE FROM role_permissions
 WHERE role_id='stock-prep-operator'
   AND permission_code IN ('multitable:submit-approval','approvals:read','approvals:write');
DELETE FROM spreadsheet_permissions
 WHERE sheet_id='sheet_32df959afa3cecfa564e5486' AND subject_type='role';
```

**未授**：全局 `multitable:read`（见 §5）；备料 base 下的另一张表 `sheet_ebd73e78d599a78a5bb64269`（Stock Preparation Confirmation Decision）——待确认一线是否需要在网格里操作它。

## 5. 为什么读权限走表级而不是全局码

**全局 `multitable:read` 在这套代码里不是"范围大"，是"没有边界"**：

- `meta_sheets` 与 `meta_bases` 都没有租户列（`db/types.ts:628-636`；迁移 `zzzz20260318110000:8-18`）。
- `GET /bases`（`routes/univer-meta.ts:7276-7287`）与 `GET /sheets`（`:8162-8169`）只有 `WHERE deleted_at IS NULL ... LIMIT 200`，没有租户或业务线谓词。
- `multitable/permission-service.ts` 全文没有 `tenant`。
- 唯二的围栏是硬编码的两个分支（审批投影 base、e-learning 统计 base，`permission-service.ts:1690-1722`）；插件系统 base 没有围栏。

所以敞口等于"实例里恰好有什么"，并且会随客户往里放东西静默变大。222 今天是 6 个 base / 10 张表（备料 2、考勤字段目录 1、PLM 沙箱 base 3、空 Untitled 2、审批投影 1），敞口不大；但没有任何机制会在敞口变大时提醒你当初授过这个。根因已记在 #5788。

**表级授权必须给 `write` 不是 `read`**：表上一旦出现授权行，该用户在这张表就切到交集模式（`permission-service.ts:1476-1494`），给 `read` 会把 `canCreateRecord`/`canEditRecord` 按成 false，一线就录不了值。`spreadsheet:write` 本身在可读码集里（`SHEET_READ_PERMISSION_CODES`，`permission-service.ts:77-90`），所以读写都有。

**零全局码 + 表级行确实能打通整条链**，这是代码预留的形状，不是绕路：
- 列表过滤走 `canReadWithSheetGrant` 的兜底分支（`permission-service.ts:1498-1505`：`!isAdminRole && !capabilities.canRead && scope.canRead === true`）。
- 表能力走 `resolveSheetCapabilities` → `applyContextSheetSchemaWriteGrant` → `applyContextSheetRecordWriteGrant` → `applyContextSheetReadGrant`（`:1507-1556`），最后一环在"交集为假但表级可读"时把 `canRead` 加回来。
- `canSubmitApproval` 经交集仍为真（全局码为真 × 表级可读为真）。

## 6. 新建备料应用后会发生什么

**不会自动调整。** 14 处创建 base/表的生产代码路径**没有一处**写授权行；全仓库只有 3 处会写 `spreadsheet_permissions`，全是人工入口（多维表 PUT 表权限路由、遗留 grant 路由、配置回滚重放）。也没有可继承的上层：授权查询只按 `sheet_id` 匹配（`permission-service.ts:729-731`，SQL 里没有 `base_id`），`base_permissions` 这张表根本不存在（`permission-service.ts:1875` 的注释自陈）。插件侧结构上也做不到：`plugins/` 全目录零 `spreadsheet_permissions`，插件 provisioning 契约（`types/plugin.ts:470-545`）没有任何授权动词。

所以：

| 第 1 步用 | 新建备料应用后 |
| --- | --- |
| 全局码 | 自动可用 |
| 表级行（当前选择） | **每新建一张托管表补一行**，一次 HTTP 调用：`PUT /api/multitable/sheets/<新表>/permissions/role/<角色id>`，body `{"accessLevel":"write"}`；执行者需 `multitable:share` 或管理员；界面在工作台的「权限」按钮 |

注意不能预授：`spreadsheet_permissions.sheet_id` 有外键指向 `meta_sheets(id)`，表没建出来插不进去。

## 7. 授完仍然不通 / 仍然难用的

| # | 问题 | 出处 |
| --- | --- | --- |
| a | 活动组织数不为一 → 422 `APPROVAL_ORG_UNRESOLVED`，且前端没有该 code 的中文文案，操作员看到英文 `Approval creation was rejected` | `approval-instance-org-derivation.ts:88-91`；文案映射表 `meta-record-labels.ts:765-774` 缺项 |
| b | 三种不同的拒绝共用一个 code 与一句文案（记录不可读 / 无送审码 / 无 `approvals:write`），文案只点了三因之二 | `routes/multitable-record-approvals.ts:75,134,173`；`meta-record-labels.ts:464` |
| c | 送审对话框把"库里没有模板"与"你没有 `approvals:read`"折叠成同一句 | `MetaRecordApprovalSubmitDialog.vue:392-398` |
| d | 请求号深链 `/approvals/:id` 未按 `approvals:read` 门控，而两层之下的进度卡片门控了；部分授权状态下点进去得到原始英文错误横幅 | 路由 `appRoutes.ts:369-372`（对比 `:345-348`） |
| e | 角色管理页**加不了权限**：`PUT /api/roles/:id` 只更新角色名，静默丢弃 `permissions` 数组然后回「角色已更新」 | `routes/roles.ts:55-78` |
| f | 授权后后端 60 秒内生效（`rbac/service.ts:13` 的 TTL，直连 SQL 不触发 `invalidateUserPerms`）；前端**刷新页面即可**，不需要退出重登——应用启动时 `apps/web/src/main.ts:61` 调 `bootstrapSession()` → `GET /api/auth/me` → `persistUserSnapshot()`（`composables/useAuth.ts:393`、`:471`）把权限写回 localStorage，而 token 本身不带权限声明。**但在不刷新的长会话标签页里不会自动生效**：快照只在启动时写，`approvals/permissions.ts` 的 `storage`/`focus` 监听因此观察不到变化。（本行 2026-09-16 更正：初版写作「必须退出重登」，追代码后为误，已改。） |
| f2 | **授权即时、收权不即时**：`getAccessSnapshot` 把 localStorage 快照与 **JWT 声明取并集**（`useAuth.ts:330-334`），而 token 里烤进了 `role`，`hasPermission` 又对 `roles.includes('admin')` 短路。所以把一个管理员在库里降级或收回权限，**刷新页面不会体现**，要等重新登录或 token 过期。只影响界面门控，服务端仍按库判定。另两种刷新也不够的情形：直接写 `user_permissions` 的授予会被命名空间准入丢掉（必须经角色，与 §4.2 的做法一致），以及非生产的 `RBAC_TOKEN_TRUST=1` / `/api/auth/dev-token`（烤进 `*:*`）。 |
| g | 想要"只能从记录送审、不能在审批中心自由发起"，现有码做不到（`approvals:write` 同时是 `POST /api/approvals` 的门） | `routes/approvals.ts:1684`；窄码提案见 #5734 |
| h | 申请人/参与人若无 `approvals:read` 看不到自己那条审批的进度 | 提案见 #5776 |

## 8. 实测清单（需要一个能登录一线账号的人）

Claude 不接触凭据，这一步必须由 owner 或客户执行。每步一个可证伪的观察点：

1. 以一线身份登录（若该标签页在授权之前就开着，**刷新一次页面**；不需要退出重登，理由见 §7f），打开备料表 → 应能看到网格（表级授权生效）。
2. 打开记录抽屉 → kebab 里应出现「送审」（`multitable:submit-approval` 生效）。
3. 点「送审」→ 模板下拉应出现「备料送审示例」（`approvals:read` 生效；若显示「无可用模板或无审批读取权限」说明第 5 道门没过）。
4. 提交 → 应创建成功并出现 `pending` 行（`approvals:write` 与组织派生都过）。若 422 且文案是英文，见 §7a。
5. 展开该行的「查看进度」→ 应显示步骤与历史（`approvals:read` 的前端门）。
6. 反例：打开别的 base 的表 → 应该看不到（验证我们没有误开全局只读）。

## 9. 待定

- 备料 base 下第二张表要不要一并授权。
- **产品层面**：一线日常用的是备料插件自己的页面（走 `stock-prep:read|operate`，从不查多维表权限，今天就能用）。把一线放进多维表网格的唯一理由，是阶段二的送审入口与进度卡片长在记录抽屉里。如果希望一线只待在备料页面，更该做的是把送审入口搬过去，而不是给他们网格权限——那样 §6 的"每新建一张表补一行"也一并消失。
