# DingTalk Secure Admission Verification

日期: 2026-04-11

## 编译检查

后端 TypeScript 编译通过：

```bash
pnpm --filter @metasheet/core-backend build
```

考勤插件 CJS 语法检查通过：

```bash
node -c plugins/plugin-attendance/index.cjs
```

## 后端定向测试

执行命令：

```bash
cd packages/core-backend
../../node_modules/.bin/vitest run \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/notification-service-dingtalk.test.ts \
  tests/unit/dingtalk-client-policy.test.ts \
  tests/unit/rbac-namespace-admission.test.ts \
  tests/unit/auth-login-routes.test.ts \
  tests/unit/dingtalk-oauth-login-gates.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-bind-account.test.ts
```

结果：

- 8 个测试文件
- 86 个测试
- 全部通过

覆盖重点：

- Corp allowlist 在 DingTalk OAuth 配置层生效
- namespace admission 对权限列表和直接权限检查生效
- 平台管理员与委派插件管理员 admission API 可用
- 角色撤销后 admission 自动关闭
- DingTalk 机器人日志不再泄露 access token
- 目录绑定与 DingTalk 登录授权链路未回归

## 前端定向测试

执行命令：

```bash
cd apps/web
../../node_modules/.bin/vitest run tests/userManagementView.spec.ts tests/roleDelegationView.spec.ts
```

结果：

- 2 个测试文件
- 5 个测试
- 全部通过

覆盖重点：

- 平台用户管理页展示并切换 namespace admission
- 委派插件管理员页面展示并切换 namespace admission

## 数据库迁移验证

本地数据库最初存在一处既有迁移账目漂移：

- `zzzz20260404100000_extend_approval_tables_for_bridge` 的 schema 实际已在库中
- 但 `kysely_migration` 缺少这条记录
- 导致 `pnpm --filter @metasheet/core-backend migrate` 被 Kysely 判定为顺序损坏

核查结果：

- `approval_instances` 扩展字段已存在
- `approval_assignments` 表及索引已存在
- 因此不需要重复执行业务 schema 变更，只需补 migration ledger

处理后再次执行：

```bash
pnpm --filter @metasheet/core-backend migrate
```

结果：

- 历史缺口账目修复后，迁移恢复正常
- `zzzz20260411120000_create_user_namespace_admissions` 执行成功
- 同时补齐了本地库里之前积压的数条 2026-04 迁移

额外执行：

```bash
pnpm --filter @metasheet/core-backend exec tsx scripts/encrypt-dingtalk-integration-secrets.ts
```

结果：

- `directoryUpdated = 0`
- `attendanceUpdated = 0`
- 说明当前本地数据无需再做 secret 重写

## 浏览器人工验收

启动本地服务：

```bash
pnpm --filter @metasheet/core-backend dev
VITE_API_URL=http://127.0.0.1:7778 pnpm --filter @metasheet/web dev -- --host 127.0.0.1
```

浏览器验收结论：

- `http://127.0.0.1:8899/admin/users`
  - 页面成功加载“用户管理”
  - 选中成员后可见“成员准入”“插件使用”“钉钉扫码登录”等分层文案
  - 空状态文案正确区分：
    - `暂无插件使用准入信息`
    - `未开通钉钉扫码`
    - `未绑定钉钉身份`

- `http://127.0.0.1:8899/admin/role-delegation`
  - 页面成功加载“角色委派”
  - 可见插件管理员范围、平台成员集、模板覆盖等既有区域
  - 可见新增“插件使用准入”区块与“两层开关”说明文案

验收说明：

- 浏览器验收使用了数据库中真实存在的管理员用户会话
- 默认开发态 `/api/auth/dev-token` 返回的 `dev-user` 不在当前本地库中，部分后台接口会返回 `403`
- 这不影响本次改动的功能判断，但意味着本地 admin 页面联调时应优先使用真实管理员会话

## 人工检查建议

上线前建议再做一轮人工验证：

1. 平台管理员给成员分配 `crm_operator`，但不打开 `crm` admission。
   预期：成员仍不能进入 CRM 插件功能。

2. 平台管理员打开 `crm` admission。
   预期：成员获得 CRM 插件使用权限。

3. 撤销成员最后一个 `crm_*` 角色。
   预期：`crm` admission 自动关闭。

4. 使用不在 `DINGTALK_ALLOWED_CORP_IDS` 内的 corpId 新建目录/考勤集成。
   预期：接口拒绝。

5. 查看 DingTalk 通知日志。
   预期：日志里只看到脱敏后的 webhook URL。

6. 对历史目录/考勤集成执行加密脚本后再次查看列表与同步。
   预期：旧集成仍能正常读取和同步，不暴露明文 secret。

## 未跑项目

- 未执行整个 workspace 的全量前端测试，因为仓库当前存在与本任务无关的既有失败项。
- 未做真实 DingTalk 线上回调联调，本次验证停留在本地定向单测、编译、迁移与浏览器人工验收层。
