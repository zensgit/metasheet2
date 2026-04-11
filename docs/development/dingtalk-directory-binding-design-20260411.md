# DingTalk Directory Binding Design

Date: 2026-04-11

## Goal

补齐钉钉目录同步后的两个关键缺口：

1. 平台管理员能在页面上直接看到同步下来的钉钉成员及其核心 ID。
2. 没有企业邮箱的成员，也能被管理员预绑定到本地用户，并为后续扫码登录做好身份映射。
3. 绑定动作要更易用，管理员不应反复手输本地用户 ID，也需要可见的解绑入口与审计。

## Problems

之前的实现里，`directory_accounts` 已经落了 `external_user_id`、`union_id`、`open_id`、`corp_id`，但有两个问题：

1. 前端目录页不展示成员明细，管理员无法在页面上操作绑定。
2. 目录同步自动匹配只按 `user_external_identities.external_key` 比对；而钉钉 OAuth 在企业场景下使用的主键是 `corpId:openId`，目录同步里常见的却是 `unionId || openId || userId`。这会导致“已经绑定过/已经登录过”的账号在再次同步时仍然落成 `unmatched`。

## Design Decisions

### 1. 新增目录成员列表接口

新增接口：

- `GET /api/admin/directory/integrations/:integrationId/accounts`

返回内容包含：

- `externalUserId`
- `unionId`
- `openId`
- `externalKey`
- `corpId`
- 邮箱、手机号、部门路径
- 当前 `linkStatus`
- `matchStrategy`
- 已绑定的本地用户

### 2. 新增目录成员绑定接口

新增接口：

- `POST /api/admin/directory/accounts/:accountId/bind`

请求体：

```json
{
  "localUserRef": "alpha@example.com",
  "enableDingTalkGrant": true
}
```

`localUserRef` 支持本地用户 `id` 或邮箱，降低管理员操作成本。

### 2.1 新增目录成员解绑接口

新增接口：

- `POST /api/admin/directory/accounts/:accountId/unbind`

解绑时只做三件事：

1. 清除该目录成员的 `directory_account_links`
2. 删除与该目录成员对应的 `user_external_identities`
3. 写入管理员审计日志

不会自动修改该本地用户的其他角色或 grant 开关，避免把“目录解绑”误扩大成“权限回收”。

### 3. 预绑定时同步写入两张表

预绑定不能只写 `directory_account_links`，因为扫码登录只读取 `user_external_identities`。

绑定时在一个事务里同时写入：

1. `user_external_identities`
2. `user_external_auth_grants`
3. `directory_account_links`

这样可以保证：

- 目录侧看到的是 `linked`
- 登录侧首次扫码也能命中身份
- 严格白名单模式下也不会因为未开通 grant 被拒绝

### 4. Identity key 采用 OAuth 规则

管理员预绑定写入 `user_external_identities.external_key` 时，不直接复用 `directory_accounts.external_key`，而是按钉钉 OAuth 的规则生成：

- 有 `corpId + openId` 时：`corpId:openId`
- 否则：`unionId || openId`

原因：

- 这是扫码登录实际使用的主键规则。
- 如果直接写目录表里的 `unionId`，后续登录/更新时会产生隐性不一致。

### 5. 缺失 `openId/unionId` 时拒绝预绑定登录身份

仅有 `external_user_id` 不足以支持扫码登录命中当前鉴权逻辑，因此：

- 如果目录账号缺少 `openId` 和 `unionId`
- 则允许继续显示该成员
- 但拒绝将其预绑定为“可扫码登录身份”

这样比“看起来绑定成功，但首登仍失败”更安全。

### 6. 自动匹配补齐 corp-scoped open/union 逻辑

同步时除了原有的 `external_key` 精确匹配外，新增：

- `corp_id + provider_open_id`
- `corp_id + provider_union_id`

匹配命中后直接标记为 `linked`。

这样已预绑定或已登录过的无邮箱成员，在后续目录同步中不会反复回退成 `unmatched`。

### 7. 前端用户选择直接复用现有用户搜索接口

没有新增一套独立的“绑定用户搜索 API”，而是直接复用已有：

- `GET /api/admin/users?q=...&page=1&pageSize=8`

理由：

- 后端已有分页与模糊检索能力
- 可以直接按姓名、邮箱、用户 ID 搜索
- 复用已有管理员权限边界，减少一套重复接口

### 8. 成员账号列表按页管理

目录成员接口已经返回 `page / pageSize / total`，前端页不能再固定只拉首批结果。

这次调整采用：

- 默认每页 25 条
- 支持 `25 / 50 / 100` 切换
- 支持上一页 / 下一页
- 搜索时自动回到第 1 页

这样可以让大组织目录继续在同一管理页内完成绑定和解绑，不会因为成员数超过 100 而失去可操作性。

## UI Changes

页面：[DirectoryManagementView.vue](../../apps/web/src/views/DirectoryManagementView.vue)

新增“成员账号”区块，支持：

- 展示同步后的钉钉成员
- 展示 `externalUserId / unionId / openId / corpId`
- 展示本地绑定状态与匹配策略
- 基于后端 `total/page/pageSize` 做服务端分页
- 切换每页条数，并支持上一页 / 下一页翻页
- 搜索本地用户候选并点选
- 通过“本地用户 ID / 邮箱”手工绑定
- 绑定时一并开通钉钉登录 grant
- 解除绑定

## Backend Files

- [directory-sync.ts](../../packages/core-backend/src/directory/directory-sync.ts)
- [admin-directory.ts](../../packages/core-backend/src/routes/admin-directory.ts)

## Frontend Files

- [DirectoryManagementView.vue](../../apps/web/src/views/DirectoryManagementView.vue)

## Test Files

- [admin-directory-routes.test.ts](../../packages/core-backend/tests/unit/admin-directory-routes.test.ts)
- [directory-sync-bind-account.test.ts](../../packages/core-backend/tests/unit/directory-sync-bind-account.test.ts)
- [directoryManagementView.spec.ts](../../apps/web/tests/directoryManagementView.spec.ts)
