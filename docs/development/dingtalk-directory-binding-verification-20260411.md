# DingTalk Directory Binding Verification

Date: 2026-04-11

## Scope

验证以下改动：

1. 目录成员列表接口可返回钉钉 ID 与本地绑定信息。
2. 管理员可将目录成员按本地用户 ID / 邮箱绑定到本地用户。
3. 预绑定写入的 DingTalk identity key 符合扫码登录规则。
4. 目录页前端可展示成员账号、分页浏览并发起绑定请求。
5. 目录页前端可搜索本地用户候选并执行解绑。

## Commands

### Backend unit tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/directory-sync-bind-account.test.ts
```

Result:

- 2 test files passed
- 10 tests passed

### Frontend unit tests

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts
```

Result:

- 1 test file passed
- 5 tests passed

### Type checks

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- backend type check passed
- frontend type check passed

## Verified Behaviors

### Backend

- `GET /api/admin/directory/integrations/:integrationId/accounts` 路由可用。
- `POST /api/admin/directory/accounts/:accountId/bind` 路由可用。
- `POST /api/admin/directory/accounts/:accountId/unbind` 路由可用。
- 绑定时会同时更新：
  - `user_external_identities`
  - `user_external_auth_grants`
  - `directory_account_links`
- 解绑时会删除对应 `user_external_identities`，并把 `directory_account_links` 重置为 `manual_unbound / unmatched`。
- 绑定时 `external_key` 会按 `corpId:openId` 规则写入，而不是直接照抄目录表里的 key。
- 当目录成员缺失 `openId/unionId` 时，后端会拒绝预绑定登录身份，避免假成功。
- 同步自动匹配已补上 `corp_id + open_id/union_id` 维度。
- 绑定与解绑都会写管理员审计日志。

### Frontend

- 目录页会在选中集成后自动加载“成员账号”。
- 页面会展示：
  - `externalUserId`
  - `unionId`
  - `openId`
  - `corpId`
  - 绑定状态
  - 本地用户
  - 部门路径
- 页面会按后端分页结果展示成员总数，并支持切换每页 25 / 50 / 100 条。
- 页面支持上一页 / 下一页翻页，不再固定只拉首批 100 条成员。
- 管理员输入本地用户邮箱后，可直接发起绑定请求。
- 管理员可先搜索本地用户候选，再一键填充绑定目标。
- 已绑定成员卡片上可直接执行“解除绑定”。

## Follow-up

当前版本已满足“同步展示钉钉 ID + 平台管理员预绑定 + 登录 grant 一并开通 + 解绑回收”的闭环。

后续可继续补两项增强：

1. 批量绑定/批量开通。
2. 更细的解绑策略，例如“仅解绑目录关系”与“同时停用 grant”的显式选项。
