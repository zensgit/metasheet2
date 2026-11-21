# 权限管理 v1.1 实现记录

本记录以 `c9359a02408b9d2ec26e275a59f32a9e7d2a7ada` 为基线。2026-11-17 的两份提议分别保存在 [授权命令 ADR #6917](https://github.com/zensgit/metasheet2/pull/6917) 和 [权限检查 ADR #6918](https://github.com/zensgit/metasheet2/pull/6918)。发布和开关变更须另行授权。

## 已合入的实现

| 原草稿 | 合入的实现与验收入口 |
| --- | --- |
| [#6919](https://github.com/zensgit/metasheet2/pull/6919) | [#6924](https://github.com/zensgit/metasheet2/pull/6924) 的管理范围页要求明确选择成员，保留有效深链和刷新后的选择。组件测试在 `apps/web/tests/roleDelegationView.spec.ts`。后续 [#6934](https://github.com/zensgit/metasheet2/pull/6934) 增加明确启停。 |
| [#6921](https://github.com/zensgit/metasheet2/pull/6921) | #6924 提供真实守卫与资源只读检查。差分套件 `packages/core-backend/tests/integration/business-check-realdb.test.ts` 对照真实 HTTP 路由。 |
| [#6922](https://github.com/zensgit/metasheet2/pull/6922) | #6924 提供预览、提交、原主体回执、影响回读和审计。实库验收由 `scripts/ops/permission-authorization-operation-realdb.mjs` 驱动，集成后覆盖 PostgreSQL 14–17。 |
| [#6923](https://github.com/zensgit/metasheet2/pull/6923) | #6924 保存角色任命来源，支持 `manual`、`creation` 和 `unknown`。已有记录保留原始来源，由 `packages/core-backend/tests/integration/authorization-operation-role-provenance.db.test.ts` 验证。 |

## 授权命令

`packages/core-backend/src/routes/admin-users.ts` 提供 `POST /api/admin/authorization-operations/preview`、`POST /api/admin/authorization-operations` 和 `GET /api/admin/authorization-operations/:clientOperationId`。输入契约与锁内执行分别在 `packages/core-backend/src/admin/authorization-operation-contract.ts` 和 `authorization-operation-service.ts`。写入、必需审计和回执在同一事务内。预览版本过期时重新预览，提交结果不明时通过只读回执查询确认。页面依据当前授权来源回读验证实际生效。

角色和准入按每项动作及命名空间核对平台或委派授权。直接例外、模板和历史权限使用各自实时平台角色要求。权限变更影响和历史撤权边界见 [历史权限撤权事务记录](legacy-permission-revoke-transaction-boundary-design-lock-20261117.md)。旧兼容入口各自沿用已接线的服务和请求契约，只有新协议提供客户端操作 ID、预览版本和原主体回执。

## 业务权限检查

`POST /api/permissions/check` 保留原有预检用途。`POST /api/permissions/v2/business-check` 按 `packages/core-backend/src/rbac/business-policies.ts` 注册的实际路由返回只读快照。已注册业务策略包括考勤决策追踪、审批模板列表和审批模板目录角色。共享求值器覆盖 single、any、all，当前注册表的实际 HTTP 策略使用 single 和 any。

多维表使用独立的表、视图、字段和记录读取策略。不可安全推断的资源、凭据上下文或动作返回 `unknown`，数据库故障也可能返回统一的不可用错误。实际业务请求仍执行自己的认证、资源和写入检查。业务检查器的链接使用当前登录主体打开多维表。

## Windows 验收与开关

[Windows PM2 修复 #6943](https://github.com/zensgit/metasheet2/pull/6943) 的合入树 `a3a6775d34d2c87ac7a732add1562256eae7ab0d` 与候选包验收树一致。断网 Windows Sandbox 的默认 `deploy.bat` 在旧进程退出后完成迁移并冷启动 PM2，旧范围保留，授权预览、提交和回执回读通过。合入后的 [Windows PM2 回归](https://github.com/zensgit/metasheet2/actions/runs/44739956414) 与候选 [授权写入实库矩阵](https://github.com/zensgit/metasheet2/actions/runs/44712065234) 独立记录。

`DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED` 和 `DELEGATED_SCOPE_ACTIVATION_ENABLED` 在该验收中保持关闭。以后启用按[委派启停记录](PERMISSION_DELEGATED_SCOPE_ACTIVATION_20261118.md)单独验证旧进程退出、启用语义与回退。
