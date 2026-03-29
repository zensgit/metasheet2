# DingTalk Directory Sync TODO

## 1. 文档与契约

- [x] 更新设计文档，锁定首版范围、无邮箱开户规则、离职策略配置模式
- [x] 新增 TODO 文档，作为开发与验收追踪清单
- [x] 补充 OpenAPI 路径与 schema

## 2. 后端数据模型

- [x] 新增 `directory_integrations`
- [x] 新增 `directory_departments`
- [x] 新增 `directory_accounts`
- [x] 新增 `directory_account_departments`
- [x] 新增 `directory_account_links`
- [x] 新增 `directory_sync_runs`
- [x] 更新 `db/types.ts`

## 3. 后端服务层

- [x] 封装目录 integration 读写
- [x] 封装部门/成员 upsert
- [x] 封装成员与部门关系重建
- [x] 封装目录成员匹配逻辑
- [x] 封装离职策略求值与执行
- [x] 封装同步 run 生命周期
- [x] 封装 DingTalk 通讯录读取 client
- [x] 同步启动/停止时刷新定时调度
- [x] `mobile_exact` 自动匹配

附：补充 `users.mobile` 持久化与手机号归一化匹配。

## 4. 后端管理接口

- [x] `GET /api/admin/directory/integrations`
- [x] `POST /api/admin/directory/integrations`
- [x] `PATCH /api/admin/directory/integrations/:id`
- [x] `POST /api/admin/directory/integrations/:id/test`
- [x] `POST /api/admin/directory/integrations/:id/sync`
- [x] `GET /api/admin/directory/integrations/:id/runs`
- [x] `GET /api/admin/directory/integrations/:id/departments`
- [x] `GET /api/admin/directory/integrations/:id/accounts`
- [x] `GET /api/admin/directory/integrations/:id/accounts/:accountId`
- [x] `POST /api/admin/directory/accounts/:accountId/link-existing`
- [x] `POST /api/admin/directory/accounts/:accountId/provision-user`
- [x] `POST /api/admin/directory/accounts/:accountId/authorize-dingtalk`
- [x] `POST /api/admin/directory/accounts/:accountId/ignore`
- [x] `POST /api/admin/directory/accounts/:accountId/unlink`
- [x] `POST /api/admin/directory/accounts/:accountId/deprovision-policy`
- [x] 集成上下文别名路由：
  - `/api/admin/directory/integrations/:integrationId/accounts/:accountId/*`

## 5. 同步与调度

- [x] 支持手动同步
- [x] 支持定时同步
- [x] 同一 integration 运行互斥
- [x] 失败写 run 错误信息
- [x] 重复同步幂等

## 6. 前端后台页

- [x] 新增 `/admin/directory` 路由
- [x] 新增目录管理视图
- [x] 集成配置区
- [x] 最近同步运行列表
- [x] 部门树筛选
- [x] 成员列表
- [x] 成员详情抽屉
- [x] 关联已有账号
- [x] 开通本地账号
- [x] 授权钉钉登录
- [x] 成员级离职策略覆盖
- [x] 编辑已有集成时保留已存 AppSecret

## 7. 测试

- [x] 后端路由单测
- [x] 后端同步/匹配/离职策略单测
- [x] 前端页面测试
- [x] OpenAPI build / validate / parse check
- [x] `vue-tsc --noEmit`
- [x] backend build
- [x] web build

## 8. 验收

- [x] 目录同步现网部署
- [x] 现网目录接口可访问
- [ ] 凭据测试通过
- [ ] 首次同步成功
- [ ] 已绑定用户识别正确
- [ ] 邮箱匹配正确
- [ ] 冲突用户识别正确
- [ ] `mobile_exact` 自动匹配正确
- [ ] `mobile_exact` 冲突边界识别（同手机号多用户时不自动绑定）
- [ ] 未匹配用户可补邮箱开户
- [ ] 授权后允许发起钉钉绑定
- [ ] 三种离职策略生效正确
- [ ] 定时同步可触发且不并发
说明：
- 现网 `142.171.239.56:8081` 已部署目录同步能力
- 当前真实阻塞已收敛到钉钉应用权限，至少缺：
  - `qyapi_get_department_list`
  - `qyapi_get_department_member`
