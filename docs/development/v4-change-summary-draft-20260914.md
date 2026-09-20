# v4 变更摘要（草稿，2026-09-14 汇总）

> 供交付指南顶部「## v4(日期)变更摘要」节直接采用。**未定稿**：条目按本轮实际合并的 PR 增删；括号里是 PR 号；合并 SHA 与验收结果冻结后再落正文。来源：程序报告 §7.7 / §8.7 / §9.5 的草稿条目，逐条对应一支在飞 PR。

## 对外行为变化（按建议合并顺序）

1. **第二个 24h 窗口（09-10 18:15 → 09-11 18:15）的交付见 §7**，授权与边界相同。两窗口合计 17 个 PR，全部 CI 绿、全部 MERGEABLE、全部未合并。
2. **托管表（插件登记表）的字段结构写入只允许管理员**（#5638）。导入默认建列、字段管理面板的新建/改类型/删除，对非 admin 在能力层 fail-closed 拒绝；两个能力解析器同判。
3. **自动化订阅投递（webhook）不再投向内网/回环/链路本地地址，且不跟随重定向**（#5649）。指向内网地址或会 3xx 跳转的订阅会以闭集码（`WEBHOOK_TARGET_REJECTED:*` / `redirect-not-allowed`）失败并记入投递日志；不自动停用订阅，需人工改地址。
4. **外接数据源 `connection` 下不再接受口令类键**（#5648）。创建/测试/更新时 `connection` 里出现 `password`/`secret`/`token` 等形状的键一律 400 `DATA_SOURCE_CONNECTION_SECRET_REJECTED`，口令只能放 `credentials`；已存的这类键在读取时被剥离、不再回显。合并前置：一次只读盘点（含 `connection.baseURL` 里的 `user:pw@`）。
5. **数据源权限码新增 `data_sources:use / rotate / share`，凭据轮换改为 `rotate` 独占**（#5650）。三码只种不发权；持 `write` 无 `rotate` 者不能就地轮换凭据（`PUT /:id/credentials` 403）。合并前置：三面（`role_permissions` / `user_permissions` / `users.permissions`，后者有 jsonb 与 TEXT[] 两形状）0 行盘点，并给管理员角色授 `rotate`。
6. **映射转换的 bare `concat` 在全部部件缺失时不再写空串**（#5652）。与 #5628 同一原则：源字段不存在就不写目标，不再把目标覆盖成 `""`。
7. **SQL Server 源的 `join.on` 改为结构化对象**（#5653）。字符串形式的 ON 一律 400 `SQLSERVER_JOIN_ON_UNSUPPORTED` 且不发 SQL；`join.type` 过白名单。
8. **`/api/admin` 下 12 个写端点改为仅管理员**（#5665）。安全确认层的开关（enable/disable）、bulk 写/删、缓存清理、指标/限流重置、DLQ 重试/清理，非 admin 一律 403 `ADMIN_REQUIRED`；管理员流程不变。
9. **`/api/admin/safety/rules` 的增删改与求值改为仅管理员**（#5677）。规则创建者与限流身份取自登录主体，请求头 `x-user-id` 不再生效。
10. **PLM 数据源的访问令牌不再随配置落库**（#5679）。此前认证后令牌会写进 `connection.headers` 并在保存/审计时明文入库；现只存内存。已落库的旧令牌需一次性清理。
11. **外接数据源 `connection` 秘密键判据加严**（#5681）。`pw`/`pswd`/`passcode`、全角键名、`dbpass`/`rootpw` 一类粘连写法也被拒收/剥离。
12. **`/api/multitable/:id/comments/mark-all-read` 只认登录主体**（#5682）。请求体里的 `userId` 被忽略，不能再替他人批量标记已读。
13. **PLM 数据源的错误信息不再回显 URL 里的口令**（W4-L，叠 #5679）。

## 合并前置（需真库，本轮未执行）

- #5619/#5649：存量 `http://` 自动化规则与订阅目标只读盘点——https-only 后它们会以 `WEBHOOK_TARGET_REJECTED:scheme-not-allowed` 失败。
- #5648/#5681：`data_sources.config.connection` 秘密键盘点（含 `{connection,headers}` 嵌套与 `connection.baseURL` 里的 `user:pw@`），SQL 见其设计文档 §5（两种列形状，先跑 `pg_typeof`/`information_schema` 探针）。
- #5650：`role_permissions` / `user_permissions` / `users.permissions`（jsonb 或 TEXT[] 两形状）三面 0 行盘点；给管理员角色授 `data_sources:rotate`（授予即时生效，撤销滞后 ≤60s）。
- #5679：修复前已落库的 PLM 令牌（`connection.headers.Authorization`）与审计副本——吊销/轮换。
- #5665/#5677：目标部署若存在 `users.role='admin'` 而 `user_roles` 无 admin 行的运维账号，先回填，否则这些账号在补门端点上会 403。

## 已知未收口（不阻塞发布，另单）

- 读侧 12 条无门 GET（#5678）、`data_sources` 是否摘出 `validTables`（#5655）、F01 阶段②路线（#5689）、两份 `ensurePlatformAdmin` 宽度差（#5688）、kanban `parseInt` 串状态、`smoke-kanban.sh` 默认 `VIEW_ID`（#5694）。
