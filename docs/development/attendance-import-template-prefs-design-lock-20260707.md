# 导入模板字段勾选·用户级记忆 design-lock — 2026-07-07

> **Status: RATIFIED（owner 2026-07-07 两问拍板："能否自动保存用户上次的记录？"→
> "要跟用户关联，换浏览器都还可以？"= 服务端 per-user，非 localStorage）。**
> 承 import-section-ux lock（#3708 D3 勾选卡）。治理红线镜像多维表 personal-views 锁 §7 Q1：
> **user_id 恒取认证 actor（`req.user`），绝不信客户端传的 user 参数**（旧 views/x-user-id 反模式禁用）。

## 1. 数据模型（PR-A）

新表 `attendance_import_template_prefs`：
`org_id text NOT NULL` + `user_id text NOT NULL` + `selected_keys jsonb NOT NULL DEFAULT '[]'` +
`updated_at timestamptz NOT NULL DEFAULT now()`，`PRIMARY KEY (org_id, user_id)`。
迁移走 core-backend zzzz 链（attendance 表既有归属模式）。不存列名文案，只存 **targetField 键**
（词汇表演进时由前端交集消化，不需要迁移数据）。

## 2. 端点（PR-A，`withAttendanceImportPermission` 门内）

- `GET /api/attendance/import/template-prefs?orgId=` → `{ selectedKeys: string[] }`（无记录 → `[]`）。
- `PUT` 同路径 body `{ orgId?, selectedKeys: string[] }`：校验数组、每项非空字符串 trim、去重、
  **上限 64 键**（超限 400 VALIDATION_ERROR）；`selectedKeys: []` 或 `null` = **删除记录**
  （「恢复默认」语义——清档让未来默认集升级自然流到用户）。upsert `ON CONFLICT (org_id,user_id)`。
- org = 请求参数（多 org 管理员合法维度，沿用 `getOrgId(req)` 先例）；**user 恒 `req.user.id`**。

## 3. 前端接线（PR-B，等 #3776 落地后 FE 串行）

勾选卡加载（加载模板成功后）GET → 与当前可选字段（`allSelectableImportFieldKeys`）**求交集**恢复；
交集为空或 GET 失败 → 默认集（静默，不打扰）。勾选/全选变更 → PUT（静默失败）；
「恢复默认」→ PUT `[]`（清档）+ 本地回默认集。

## 4. 测试契约

- PR-A 真 DB（挂 plugin-tests.yml）：**actor 隔离金测试**（A 写 → B 读到空、A 读到自己的；
  伪造 body.userId 无效——记录仍落在 token actor 上）；org 维度隔离；upsert 覆盖；
  `[]` 清档；65 键 → 400；非法形状 → 400。
- PR-B：挂载测试（GET mock 返回子集 → 复选框恢复且幽灵键被丢弃；toggle → PUT 载荷正确；
  恢复默认 → PUT `[]`）+ mutation（摘交集/摘恢复 → 对应测试红）。

## 5. 完成口径

每 PR：实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证补记。PR-A backend 泳道即刻；PR-B 排 #3776 后。
