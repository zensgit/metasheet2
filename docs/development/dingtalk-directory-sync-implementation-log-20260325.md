# DingTalk 目录同步实现与交付清单（2026-03-25）

## 目标状态

在现有基础上把“钉钉目录同步”做到可持续交付状态：目录接入、管理员审核、离职策略执行、账号绑定授权、以及可复现验证链路。

## 已完成（可复核）

- 目录同步后端服务、路由、调度接线完成：
  - `packages/core-backend/src/directory/directory-sync.ts`
  - `packages/core-backend/src/routes/admin-directory.ts`
  - `packages/core-backend/src/index.ts`
- 目录模型与迁移完成：
  - `packages/core-backend/src/db/migrations/zzzz20260324150000_create_directory_sync_tables.ts`
  - `packages/core-backend/src/db/migrations/zzzz20260325100000_add_mobile_to_users_table.ts`
  - `packages/core-backend/src/db/types.ts`
- 外部身份与鉴权基础设施已接入（用于授权判断）：
  - `packages/core-backend/src/auth/external-identities.ts`
  - `packages/core-backend/src/auth/external-auth-grants.ts`
- 前端目录管理页与路由接入：
  - `apps/web/src/views/DirectoryManagementView.vue`
  - `apps/web/src/main.ts`
  - `apps/web/src/router/types.ts`
- OpenAPI 合约接入：
  - `packages/openapi/src/paths/admin-directory.yml`
  - `packages/openapi/src/base.yml`
  - `packages/openapi/tools/build.ts`（构建聚合）
- 文档与验收资料补齐：
  - `docs/development/dingtalk-directory-sync-design-20260324.md`
  - `docs/development/dingtalk-directory-sync-todo-20260324.md`
  - `docs/development/dingtalk-directory-sync-verification-20260324.md`
- 验证闭环增强（本轮新增）：
  - 目录集成 `pageSize` 参数做 1~100 收敛（非法值回退/边界夹紧）
    - 文件：`packages/core-backend/src/directory/directory-sync.ts`
  - 集成作用域账号操作增加归属校验失败用例
    - 文件：`packages/core-backend/tests/unit/admin-directory-routes.test.ts`
  - 目录同步边界单测扩展（已有）
    - 文件：`packages/core-backend/tests/unit/directory-sync.test.ts`
  - DingTalk 缺权限错误识别与 remediation 透传
    - 文件：`packages/core-backend/src/utils/error.ts`
    - 文件：`packages/core-backend/src/directory/directory-sync.ts`
  - 目录管理页新增 scope 缺失提示与申请链接展示
    - 文件：`apps/web/src/views/DirectoryManagementView.vue`
    - 文件：`apps/web/tests/directoryManagementView.spec.ts`

## 本轮测试记录

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/directory-sync.test.ts tests/unit/admin-directory-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web build`
- `node scripts/openapi-check.mjs`
- `pnpm lint`（全仓库无 ERROR，仅既有 WARNING）
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/error-utils.test.ts tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts`
- 真实环境 `POST /api/admin/directory/integrations/{integrationId}/sync` 成功
- 真实环境 `node scripts/dingtalk-directory-smoke.mjs --base-url http://142.171.239.56:8081 ...` 通过
- 真实环境 `/api/auth/dingtalk/login-url?redirect=/settings` 返回的新授权地址已切到新 `client_id`
- 真实环境已将 `rootDepartmentId` 切换到子部门 `1068569133`
- 真实环境已完成子部门成员 `zaah` 的 MetaSheet 开户、钉钉授权和外部身份绑定

## 待并行执行（按优先级）

1. **真实联调（高）**
   - 已完成新钉钉应用接入、真实同步成功和扫码登录环境切换。
   - 当前需要转向核对“组织范围”和“应用可见成员范围”，确认为什么现网只有 `1` 个成员、`0` 个子部门被同步。
2. **验收闭环（中）**
  - “已绑定/待审核/冲突/未匹配”四态出现与前端展示一致性复核；
  - 三种离职策略在同步后执行效果复核（含 `disable_dingtalk_auth`/`disable_local_user`）。
  - 当前已实证通过一条“pending -> linked + authorized + bound”闭环。
3. **可运维化（低）**
   - 输出一份环境验收清单（生产地址、回调地址、登录页入口、企业权限映射）；
   - 与现网账号绑定流程打通前后，补一遍故障回放脚本（含失败时 `DIRECTORY_SYNC_FAILED` 及回写原因）。

## 完成标准（建议）

- 目录首次成功同步至少 2 次，且状态与钉钉组织数量一致；
- 处理链路覆盖并通过：`manual link`、`provision + authorize`、`deprovision-policy mark_inactive / disable_dingtalk_auth / disable_local_user`；
- 通过脚本化验收并附上 run 记录截图。
