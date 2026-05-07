# DingTalk 142 机器可执行验收探针

## 目标

- 在需要真人参与的钉钉扫码、授权、群消息确认之前，先把机器可执行的 142 验收项跑通。
- 用真实环境返回值固定当前用户治理、目录同步、审计接口和公共表单访问的基线行为。
- 为后续 `142 联调验收清单` 回填提供事实依据。

## 1. 用户治理与 DingTalk 访问状态

### P4 Unauthorized Target

接口：

```bash
GET /api/admin/users/fb9861bb-2eef-4f0a-83e6-725b2aabf867/dingtalk-access
```

结果：

- `requireGrant = true`
- `directory.linked = true`
- `grant.enabled = true`
- `identity.hasUnionId = true`
- `identity.hasOpenId = false`
- `identity.openId = null`

结论：

- 这是一个非常合适的真实验收样本。
- 当前状态不是“未授权”，而是“已授权、已目录关联，但 openId 缺失”。

### zhouhua 管理员样本

接口：

```bash
GET /api/admin/users/b928b8d9-8881-43d7-a712-842b28870494/dingtalk-access
```

结果：

- `directory.linked = true`
- `grant.enabled = true`
- `identity.hasUnionId = true`
- `identity.hasOpenId = true`
- `identity.openId` 有值
- `lastLoginAt` 有值

结论：

- 这是一个“完整可用链路”样本，可作为真人侧成功场景参考。

## 2. 目录同步真实样本

接口：

```bash
GET /api/admin/directory/integrations
GET /api/admin/directory/integrations/<integrationId>/accounts?page=1&pageSize=3
```

结果：

- 当前目录集成数：`1`
- 首个集成：
  - `name = Production DingTalk Directory`
  - `provider = dingtalk`
  - `status = active`

- 当前抽样目录账户：
  - `total = 3`
  - 抽样 3 个账户均为 `linkStatus = linked`
  - 抽样中至少 2 个账户 `openId = null`、`unionId` 存在

结论：

- 当前 142 目录绑定链路可访问。
- 但 `openId` 缺失不是个别用户现象，后续真人验收必须结合真实登录结果一起判断。

## 3. 审计接口

接口：

```bash
GET /api/audit-logs?resourceType=user-auth-grant&action=revoke&page=1&pageSize=10
```

结果：

- `ok = true`
- `total = 0`
- `items = 0`

结论：

- 审计 API 当前可访问。
- 但 `user-auth-grant / revoke` 这一过滤条件下暂时没有记录。
- 如果后续要验证“最近 7 天治理审计”，需要先确认真实治理动作已经产生。

## 4. 公共表单访问探针

### 公开样本

样本视图：

- `view_form_dingtalk_demo_20260420`
- `publicToken = pub_dingtalk_demo_20260420`

接口：

```bash
GET /api/multitable/form-context?viewId=view_form_dingtalk_demo_20260420&publicToken=pub_dingtalk_demo_20260420
```

结果：

- `mode = form`
- `readOnly = false`
- `submitPath = /api/multitable/views/view_form_dingtalk_demo_20260420/submit?publicToken=pub_dingtalk_demo_20260420`
- `view.name = 钉钉填写入口`

结论：

- 当前 demo 公开表单上下文可正常匿名加载。

### 受保护样本

样本视图：

- `view_db8b7922-84dd-4bc9-8467-dd8a86d93360`
- `name = DingTalk P4 Protected Form`
- `accessMode = dingtalk_granted`
- `allowedUserIds` 包含 `zhouhua`

接口：

```bash
GET /api/multitable/form-context?viewId=view_db8b7922-84dd-4bc9-8467-dd8a86d93360&publicToken=pub_e34ef997-46ee-4830-b7a1-253454efdf99
```

结果：

- HTTP `401`
- `code = DINGTALK_AUTH_REQUIRED`
- `message = DingTalk sign-in is required for this form`

结论：

- 当前受保护表单机器探针已验证到正确的“需要先钉钉登录”拦截行为。
- 后续真人验收只需要补：
  - 已绑定且在允许名单中的 DingTalk 用户登录后能否正常进入
  - 未绑定或不在允许名单中的用户是否继续被正确阻止

## 当前结论

- 142 的机器可执行验收项已经能覆盖：
  - 管理员鉴权
  - 用户治理状态
  - 目录同步状态
  - 审计接口可达性
  - 公开表单与受保护表单的基础访问行为

## 下一步建议

- 下一轮重点转到真人参与项：
  - 成功登录样本：`zhouhua`
  - 缺 openId 样本：`P4 Unauthorized Target`
  - 受保护表单允许名单样本
  - 群机器人消息确认
