# DingTalk 142 验收基线快照

## 目标

- 在正式回填 `142 联调验收清单` 前，先固定一份真实环境基线快照。
- 记录当前管理员鉴权、用户治理、目录同步和审计入口的真实状态。
- 让后续验收结论、上线观察和交付结论都有同一天的事实基线可引用。

## 验证时间

- 日期：2026-05-06
- 环境：142 主站

## 1. 管理员鉴权

- 本地联调 token 文件：
  - `/tmp/metasheet-142-main-admin-72h.jwt`
  - 实际文件：`/tmp/metasheet-142-main-admin-72h-20260506T085320Z.jwt`

- `/api/auth/me` 验证结果：
  - `success = true`
  - `user.id = b928b8d9-8881-43d7-a712-842b28870494`
  - `email = zhouhua@china-yaguang.com`
  - `role = admin`
  - `features.plm = true`

## 2. 用户治理基线

- `/api/admin/users?filter=dingtalk-openid-missing`
  - `ok = true`
  - `total = 5`
  - `actorId = b928b8d9-8881-43d7-a712-842b28870494`

- 当前样本中可见：
  - `P4 Unauthorized Target`
    - `dingtalkOpenIdMissing = true`
    - `directoryLinked = true`
    - `dingtalkLoginEnabled = true`
  - `zhouhua`
    - `dingtalkOpenIdMissing = false`
    - `directoryLinked = true`
    - `dingtalkLoginEnabled = true`

说明：
- 当前环境仍存在至少 1 个 `缺 OpenID 且已目录关联` 的真实目标样本。
- 该样本可继续用于后续 DingTalk 登录限制与治理验证。

## 3. 目录同步基线

- `/api/admin/directory/integrations`
  - `ok = true`
  - 当前集成数：`1`
  - 首个集成：
    - `name = Production DingTalk Directory`
    - `provider = dingtalk`
    - `status = active`

- `/api/admin/directory/integrations/<integrationId>/accounts?page=1&pageSize=3`
  - `ok = true`
  - `total = 3`
  - 当前抽样 3 个目录账户均为 `linkStatus = linked`

- 样本观察：
  - `P4 Unauthorized Target` 对应目录账户：
    - `openId = null`
    - `unionId` 存在
    - `linkStatus = linked`
  - `zhouhua` 对应目录账户：
    - `openId = null`
    - `unionId` 存在
    - `linkStatus = linked`

说明：
- 当前 142 目录镜像中，账户与本地用户的绑定关系是存在的。
- 但 `openId` 缺失并非个别样本现象，后续验收时要结合真实钉钉登录继续判断。

## 4. 审计入口基线

- 前端管理审计页使用的真实后端接口为：
  - `/api/audit-logs`

- `/api/audit-logs?resourceType=user-auth-grant&action=revoke&page=1&pageSize=10`
  - `ok = true`
  - `total = 0`
  - `items = 0`

说明：
- 审计 API 当前可访问。
- 但在 `user-auth-grant / revoke` 这一过滤条件下，当前环境未查到记录。
- 后续如果需要验证“最近 7 天治理审计”，应先确认实际审计动作是否已经产生，或调整筛选条件。

## 当前结论

- 142 主站后台联调入口已补通。
- 管理员鉴权可用。
- 用户治理和目录同步关键接口可访问。
- 当前最值得继续推进的真实验收对象仍然是：
  - `P4 Unauthorized Target`
  - 以及已有绑定与目录关联的真实 DingTalk 用户样本

## 下一步建议

- 用现有 token 继续跑：
  - `142 联调验收清单`
  - `正式交付结论`
  - `上线观察记录模板`
- 优先聚焦三个问题：
  - 缺 `openId` 用户的真实登录结果
  - 已绑定用户的真实登录结果
  - 公共表单与群机器人在真实环境中的结果
