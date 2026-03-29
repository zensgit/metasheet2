# DingTalk Directory Console Hardening Design

## Goal

把现有钉钉目录同步能力从“基础可用”推进到“真实可运营”：

- 成员目录不再停留在默认 20 条的隐式截断状态
- 管理员可以按绑定状态、匹配方式、授权状态、部门做精确筛选
- 目录接口返回可直接驱动控制台摘要卡片与分页器的元信息
- 管理员可以一键导出当前筛选结果，方便线下复核、归档与批量处理
- 开通本地账号后，控制台可直接展示临时密码，减少来回切页和二次查询
- 钉钉授权操作会根据当前状态动态切换为“授权”或“取消授权”，避免误操作
- 部署后可以用脚本快速验证目录管理接口是否完整可用
- 钉钉应用缺少通讯录 scope 时，控制台可以直接显示缺少的权限项与申请链接，而不是只留下一段原始报错

## Gap

截至本轮改造前，目录同步主链路已存在，但目录控制台仍有三个明显缺口：

- 前端成员目录默认调用 `/accounts` 时没有分页控制，而后端默认只返回第一页 `20` 条数据
- 后端列表接口只有 `q / linkStatus / isActive` 三个过滤维度，不足以支撑管理员做目录审核
- 现网部署后缺少一条专门验证目录管理接口结构的 smoke 脚本

这会导致一个典型误判：

- 实际已经同步了更多成员
- 但页面只展示第一页
- 操作人员误以为同步失败或目录数量异常

## Design Decision

本轮增强分三层落地。

### 1. Server-side pagination stays authoritative

目录成员列表继续由后端做分页，而不是前端一次性全量拉取：

- 避免大组织成员目录一次性加载
- 与后续更多筛选条件保持一致
- 便于直接暴露 `page / pageSize / pageCount / hasNextPage / hasPreviousPage`

### 2. Filters follow real admin workflows

列表接口新增以下筛选维度：

- `matchStrategy`
  - `external_identity`
  - `email_exact`
  - `mobile_exact`
  - `manual`
- `dingtalkAuthEnabled`
- `isBound`
- `departmentId`

同时，关键字搜索 `q` 不再只匹配姓名/邮箱/手机号/外部用户 ID，也会匹配部门名称与部门路径。

### 3. Response includes summary, not just rows

为了让目录管理页不需要自行遍历全量结果再做汇总，`GET /api/admin/directory/integrations/{integrationId}/accounts` 直接返回摘要：

- `linked`
- `pending`
- `conflict`
- `ignored`
- `active`
- `inactive`
- `dingtalkAuthEnabled`
- `dingtalkAuthDisabled`
- `bound`
- `unbound`

这样前端可以直接做：

- 顶部概览卡片
- 当前筛选结果摘要
- 翻页器状态控制

### 4. Export and action feedback close the operator loop

目录控制台不只要“看得见”，还要“带得走、看得懂、少点错”：

- `GET /api/admin/directory/integrations/{integrationId}/accounts/export.csv` 提供当前筛选条件下的成员导出
- 导出响应带上总数、返回数、是否截断等头部信息，便于前端提示真实导出规模
- 导出使用分页聚合而不是快照锁定，默认 `5000`、最大 `10000` 行，定位是运营导出而不是全量归档备份
- 开通本地账号后直接回显临时密码和账号邮箱，管理员无需再去日志或详情页追查
- 钉钉授权按钮根据当前绑定状态自动切换文案和请求参数，降低把授权和取消授权点反的风险

### 5. Permission failures become actionable operator hints

真实联调已经证明，目录同步最常见的外部阻塞不是“系统没跑起来”，而是钉钉应用缺少通讯录 scope。

因此本轮补一层权限错误产品化：

- 后端在调用钉钉目录接口失败时，识别 `subcode=60011` 与 `requiredScopes`
- 对缺权限错误透传结构化 details：
  - `provider`
  - `subcode`
  - `requiredScopes`
  - `applyUrl`
- 前端目录页同时支持两类展示：
  - 当前操作失败后的全局提示
  - 历史同步运行记录里的缺权限提示
- 即使历史运行记录里只剩一条原始字符串错误，前端也会重新解析出 scope 和申请链接

这样管理员在 `/admin/directory` 页面上就能直接知道：

- 缺哪个权限
- 去哪里申请
- 当前阻塞是否来自钉钉开放平台，而不是 MetaSheet 内部故障

## Backend Changes

本轮代码增强如下：

- `DirectorySyncService.listAccounts()` 增加高级筛选与分页元信息
  - 文件：`packages/core-backend/src/directory/directory-sync.ts`
- `fetchJson()` 识别 DingTalk scope 错误并抛出带 remediation details 的 `DirectorySyncError`
  - 文件：`packages/core-backend/src/directory/directory-sync.ts`
- `admin-directory` 路由增加 query 参数解析
  - 文件：`packages/core-backend/src/routes/admin-directory.ts`
- `admin-directory` 路由增加成员导出 CSV 接口
  - 文件：`packages/core-backend/src/routes/admin-directory.ts`
- OpenAPI 补充新增 query 参数与响应字段
  - 文件：`packages/openapi/src/paths/admin-directory.yml`
- 增加目录管理 smoke 脚本
  - 文件：`scripts/dingtalk-directory-smoke.mjs`

## Frontend Changes

控制台页也已同步增强：

- 增加“测试连接”按钮，直接命中 `/api/admin/directory/integrations/{integrationId}/test`
- 顶部摘要区展示最近一次同步状态与成员摘要
- 成员目录分页导航正式接入后端分页元信息
- 成员目录筛选支持：
  - 绑定状态
  - 匹配方式
  - 钉钉授权状态
  - 是否已完成钉钉绑定
  - 部门
- 增加“导出 CSV”按钮，导出内容复用当前筛选条件
- 新增“缺少钉钉权限”提示区，可直接显示 scope 与申请链接
- 目录成员详情仍保留开户、授权、忽略、解绑、离职策略等原有操作
- 开通本地账号成功后，界面会直接显示临时密码与邮箱，便于管理员同步给使用者
- 钉钉授权按钮会根据当前账号状态动态显示“授权钉钉登录”或“取消钉钉授权”

对应文件：

- `apps/web/src/views/DirectoryManagementView.vue`
- `apps/web/tests/directoryManagementView.spec.ts`

## API Contract

目录账号列表接口新增 query 参数：

- `matchStrategy`
- `dingtalkAuthEnabled`
- `isBound`
- `departmentId`

目录账号导出接口新增 query 参数：

- `limit`

目录账号列表响应新增字段：

- `pageCount`
- `hasNextPage`
- `hasPreviousPage`
- `summary`

目录账号导出接口新增响应头：

- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition`
- `X-Export-Total`
- `X-Export-Returned`
- `X-Export-Truncated`

## Operational Superiority

与普通“目录同步能跑起来”的实现相比，这一轮额外补齐了可运营细节：

- 避免大目录在 UI 上被误判为“只同步了 20 人”
- 支持管理员按审核语义而不是按原始字段盲查
- 支持脚本化验证返回结构是否完整
- 支持直接导出当前筛选结果，减少人工复制和二次筛选
- 支持开户后即时展示临时密码，降低操作链路长度
- 支持授权/取消授权按钮语义随状态切换，减少误点风险
- 为前端摘要卡片和真实分页器提供稳定后端契约

## Smoke Script

新增脚本：

- `node scripts/dingtalk-directory-smoke.mjs --base-url http://host:8081 --token <admin-token> [--integration-id dir-1]`

它会依次验证：

1. `/api/admin/directory/integrations`
2. `/runs`
3. `/departments`
4. `/accounts?page=1&pageSize=N`
5. `/accounts/export.csv`

并校验：

- 分页字段完整
- `summary` 字段完整
- 导出响应头完整
- 可解析出 integration/runs/departments/accounts 数量

## Result

这一轮增强已经把目录同步控制台从“基础链路可跑”推进到“可筛选、可分页、可诊断、可 smoke 验证”的状态，重点超越点体现在：

- 大目录不再被 UI 假性截断
- 控制台支持按真实审核语义筛选
- 契约直接返回摘要与翻页状态
- 控制台支持导出当前筛选结果并保留导出规模提示
- 控制台支持开户结果即时回显，减少管理员来回跳转
- 控制台支持授权按钮随状态变化，降低操作歧义
- 前端与脚本都能复用同一套后台能力
