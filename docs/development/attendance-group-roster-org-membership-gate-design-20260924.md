# 考勤组花名册写入：活跃组织成员门（fail-closed）

> **文档性质：实现设计（design lock for this PR）**  
> **日期**：2026-09-24  
> **基准**：`main` @ `f31a88663d5dcb7a290b6237abff53d8c43d55fe`  
> **谱系**：#5899 O3（`attendance-group-acl-write-o3-design-20260920.md`）把 `add_members` 下放给组负责人之后，成员/负责人写入仍把 `userId` 原样 INSERT。  
> **本 PR**：设计 + 实现 + 验证；**draft，不合并**。修 #6045、#6047。

---

## 0. 一句话结论

| 写路径 | main 在本 PR 前 | 本 PR |
|---|---|---|
| `POST /api/attendance/groups/:id/members` | trim 后 `INSERT … ON CONFLICT DO NOTHING`，不查组织成员 | 同一事务内先查活跃组织成员；任一 id 不通过则 **整批 404 `USER_NOT_IN_ORG`，零 INSERT** |
| `POST /api/attendance/groups/:id/managers` | trim 后 `INSERT … ON CONFLICT DO UPDATE`，不查组织成员 | 同一事务内先查；不通过则 **404 `USER_NOT_IN_ORG`，不写、不触碰已有行** |
| 谁可以写（O3 / OW8） | owner/sub_owner 可 `add_members`；managers POST 仍 `attendance:admin` | **不改 ACL** |

谓词与年假手工调账 `applyAnnualLeaveManualAdjustment` 相同：`user_orgs.is_active = true AND users.is_active = true`，且 `user_orgs.org_id` 等于 actor 的已认证组织。真源表是 `user_orgs`（`user_id`/`org_id` 均为 text）JOIN `users`。

---

## 1. 目标 / 非目标

### 1.1 问题

#5899 之后组负责人可以粘贴 userId 加人。两条写路径都不检查目标是不是**该组织的活跃成员**：

- 停用用户（`users.is_active = false` 或 `user_orgs.is_active = false`）
- 只属于别的组织的用户
- 不存在的 id

都会落进 `attendance_group_members` / `attendance_group_managers`。`user_id` 是 text、无 FK。负责人行一旦写入，该 id 就进入 O3 的 `add_members` / `list_*` ACL。

### 1.2 目标

1. 成员 POST 与负责人 POST 在写入前 fail-closed。
2. 错误是 **404 `USER_NOT_IN_ORG`**，不是 500。文案与年假调账一致：`Target user is not an active member of this org`。
3. 批量成员写入 **全有或全无**：任一 id 不通过，包括本批里合格的 id 也不插入。
4. #5899 的正常路径仍可用：本组 owner/sub_owner 把**本组织活跃成员**加进自己的组，仍 200，并继续发 values-free `attendance.group.members.changed`。

### 1.3 非目标

- 不改 O3：谁可以 `add_members` / `remove_members` / `list_*` / preview。
- 不改 OW8：负责人 POST/DELETE 仍仅 `attendance:admin`。
- 不改 DELETE 成员/负责人（删除不是授予）。
- 不改 `POST /api/attendance/schedule-groups/:id/members`（#6045 标为可选同型残留，本 PR 不扩）。
- 不改导入路径 `insertAttendanceGroupMembers`（CSV 落成员，不是这两条路由）。
- 不回扫、不删除历史上已经写入的幽灵行。
- 不把 `users.activation_status` 加进谓词。年假调账与本门只看两列 `is_active`。W4 事务内 liveness 另有 `activation_status`，那是另一条写路径。
- 不改管理端 picker / global-scope 搜索。API 拒绝即可；UI 会看到 404。
- 不新增 env flag。

---

## 2. 当前 main 基线

权威路径：`plugins/plugin-attendance/index.cjs`。

| 面 | 本 PR 前 |
|---|---|
| 成员 POST | `withAttendanceGroupMemberAccess('add_members')` 之后直接 INSERT（约 45391–45404，基准 SHA） |
| 负责人 POST | `withPermission('attendance:admin')` 之后直接 INSERT（约 45553–45563，基准 SHA） |
| 对照门 | `applyAnnualLeaveManualAdjustment`：`user_orgs` ∩ `users.is_active`，否则 `404 USER_NOT_IN_ORG` |
| 事务回滚 | 插件 `database.transaction` 在 callback 抛错时 `ROLLBACK`（`packages/core-backend/src/integration/db/connection-pool.ts`） |

---

## 3. 批量语义（本 PR 锁定）

`POST /api/attendance/groups/:id/members` 接受 `userId` 和/或 `userIds`。去重、trim 之后：

1. 在**同一个事务**里、**任何 INSERT 之前**，用一条查询取出本批中属于该 org 的活跃成员：

```sql
SELECT uo.user_id
  FROM user_orgs uo
  JOIN users u ON u.id = uo.user_id
 WHERE uo.org_id = $1
   AND uo.user_id = ANY($2::text[])
   AND uo.is_active = true
   AND u.is_active = true
```

`$1` 是 actor 已认证 `orgId`（`resolveAttendanceGroupRouteActorContext`），不是 body 里的 org 选择器。

2. 请求顺序里凡是不在结果集中的 id，整批失败：

```json
{
  "ok": false,
  "error": {
    "code": "USER_NOT_IN_ORG",
    "message": "Target user is not an active member of this org",
    "details": [{ "userId": "<rejected id>" }]
  }
}
```

HTTP **404**。`details` 只回显调用方自己提交、且未通过的 id（去重后、保持请求顺序）。不区分「停用 / 他组织 / 不存在」——三种都是「不是该组织的活跃成员」，避免用不同错误码泄露他组织是否存在该用户。

3. 全部通过才执行既有 `INSERT … ON CONFLICT DO NOTHING`。已是成员不是错误：冲突行不出现在 `data.items`，与现在一致。成功才发 `attendance.group.members.changed`。

4. 抛 `HttpError` 时事务回滚。实现上拒绝发生在 INSERT 之前，所以合格 id 也不会先写入再回滚。单测锁定的是「拒绝路径上没有 INSERT 调用」。

`POST /api/attendance/groups/:id/managers` 的 schema 仍是**单个** `userId`（没有 `userIds` 批）。同一谓词、同一 404、同一 `details: [{ userId }]`。检查在 INSERT 之前、同一事务内，因此 `ON CONFLICT DO UPDATE` 不会去摸一条被拒绝的幽灵行。

空 id 列表仍是 400 `VALIDATION_ERROR`（`userId is required`），发生在事务之前。非法 role 仍是 400，且不查库。

缺 `user_orgs` / `users` 表仍走既有 `isDatabaseSchemaError` → 503 `DB_NOT_READY`，不插入。

---

## 4. 实现要点

1. 模块级 `assertActiveOrgMemberUserIds(client, orgId, userIds)`（`index.cjs`，年假调账函数上方）。返回去重后的 id；否则抛 `HttpError(404, 'USER_NOT_IN_ORG', …, details)`。
2. 成员 POST：事务内先 assert，再按返回列表 INSERT。catch 里 `HttpError` 原样抛出，由 `withAttendanceGroupMemberAccess` 写成 4xx JSON（避免被内层 catch 收成 500）。
3. 负责人 POST：组存在性检查仍在前（不存在 → 404 `NOT_FOUND`，不查成员）。通过后开事务：assert，再 INSERT。`HttpError` 同样原样抛出，由 `withPermission` 写成 4xx。
4. 年假调账函数本体不改，避免动它的 SQL 形状；本门的 WHERE 与它逐字对齐（两列 `is_active` + org + user）。

---

## 5. 变异（测试必须能抓住）

| 刀 | 预期 |
|---|---|
| 成员 POST 去掉 `assertActiveOrgMemberUserIds`，恢复「直接 INSERT」 | 负向与混合批变成 200；#5899 正向腿因 SQL 不再含 `FROM user_orgs uo` 而红 |
| 负责人 POST 去掉同一调用 | 停用 / 他组织 / 不存在的负责人写入变成 200，且出现 `INSERT INTO attendance_group_managers` |
| 谓词删掉 `u.is_active = true` 或 `uo.is_active = true` 或 `JOIN users` | `expectActiveOrgMemberPredicate` 红 |
| 先 INSERT 再检查 | 混合批负向腿断言「没有 INSERT」而红（单测事务桩不会真的 ROLLBACK） |

本地已做成员 POST 去门变异：`inactive user` 与 `mixed member batch` 得到 200 而不是 404；owner 正向腿缺少 `FROM user_orgs uo`。恢复断言后套件回到绿。详见验证记录。

测不到的降级：见验证记录第 5 节（排班组成员、导入落成员、历史幽灵行、真实 PostgreSQL 的 `ANY($2::text[])`）。
