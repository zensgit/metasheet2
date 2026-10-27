# R74 本地审批关系补丁操作草案（未部署）

目标基线：`f3efc86c0159408ec8531b887d86a157368af666`。本包仅用于该 R74 源码的受控构建；不是全量 main 升级。隔离本地验证已完成；交付形态为 Draft 源码补丁，仍需当前补丁 CI 和操作者自己的构建、迁移、发布验收。

## 解决的问题

已有活跃成员可通过单独入口建立本地目录档案；原加入组织入口继续拒绝已有归属。负责人关系是成员与部门之间的显式关系。岗位文字不是审批人：
- `isPrimary`：申请人的主部门。
- `isManager`：该部门用于现有“直属上级”节点的经理。R74 的这个节点是部门级经理，不是任意逐人汇报线。
- `isDepartmentHead`：独立的部门主管，不覆盖经理。
- `users.position`、本地目录 title、钉钉镜像 title 仍分开，本补丁不复制或统一。

## 操作者前置核对

1. 核对 health 的完整 build.commit 与基线相同，保留现有构建和数据库可恢复备份。
2. 使用已有平台管理员会话。不要粘贴认证头、Cookie、密钥或完整配置到反馈中。
3. 确认申请人、经理、主管都是本组织已有活跃演示成员，且未有已生效离职证据。由操作者选择真实演示账号，本包不预置账号和授权。
4. 先读取本地组织及审批来源。存在 disabled / ambiguous 组织来源时停止，不借创建部门接口复活来源。
5. 审批来源是组织级配置。改变它会影响后续新审批单，需要操作者审阅现有来源和预览差异，不能为了一个演示直接覆盖其它流程来源。

## 完成构建验证后可使用的管理接口

以下均在服务器本地、由授权操作者决定执行；本次 Codex 没有连接或写入测试服务器。

| 步骤 | 接口 | 最小输入 / 校验 |
| --- | --- | --- |
| 只读查看组织 | GET /api/admin/directory/local/workspace | 无查询参数；返回本地来源和部门 |
| 只读找已有成员 | GET /api/admin/directory/local/member-candidates | integrationId、page、pageSize、q；ID 必须从当前组织取得 |
| 只读查看已有档案与关系 | GET /api/admin/directory/local/members | integrationId、page、pageSize、q；已投影成员从这里取得 accountId 和 membership id |
| 建立本地档案 | POST /api/admin/directory/local/member-projections | integrationId、localUserId；不提交 org、角色或职务 |
| 创建部门（仅确实需要时） | POST /api/admin/directory/local/departments | name、可选 parentDepartmentId |
| 加入部门 | POST /api/admin/directory/local/memberships | accountId、departmentId |
| 设置申请人主部门 | PATCH /api/admin/directory/local/memberships/:membershipId | { "isPrimary": true } |
| 设置直属经理 | 同上 | { "isManager": true }；不可与 isPrimary 同请求 |
| 设置部门主管 | PATCH /api/admin/directory/local/memberships/:membershipId/department-head | { "isDepartmentHead": true } |
| 只读核对主管 | GET 上一主管接口 | 核对目标成员、部门和主管状态 |
| 只读查看来源 | GET /api/admin/directory/routing-policy | 核对 approval_routing |
| 只读预览来源 | GET /api/admin/directory/routing-policy/approval_routing/preview?candidate=:integrationId | 检查人员关系差异 |
| 明确决定后设置来源 | PATCH /api/admin/directory/routing-policy/approval_routing | { "canonicalIntegrationId": "经预览核对的本地来源ID" } |

memberships 路径参数的实际格式为单个 `<accountId>:<departmentId>`，两个 UUID 中间只有一个冒号。请使用接口返回的 membership id，不要把占位符原样发送。

## 验收与保留边界

新发布的演示模板使用 direct_manager → dept_head、single、emptyAssigneePolicy=error；提交一张新单，分别用经理、主管已有合法办理权限的账号完成两步。申请人只需原提交权限。本包不授予 approvals:act、不包含撤回权限补丁，不绕过权限检查。

审批单创建时冻结关系快照。后续改负责人不重写已有单；旧单卡住不能靠改草稿模板自动恢复。不得把“指定成员”临时工作流当作自动关系验证。

迁移只新增默认 false 的主管标记和索引，不回填钉钉 raw、不生成历史负责人。迁移回退会删除主管标记，回退前须保存新增映射并评估影响，不能盲回退已有业务写入。发布/数据库迁移/重启仍需操作者自己的变更流程；本草案未授权执行它们。

不合并、不部署、不改 R71；Stream/lifecycle/external writes OFF；真实 UAT、业务 50004 排除。历史 08 点 PUT 仍未定因。
