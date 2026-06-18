# 数据库连接页 — 测试连接前置(test-before-save)设计锁定 — 2026-06-17

> 状态:**DESIGN-LOCK**。已并入 owner 复审 P1/P2a/P2b + 两个判断点确认 + 两枚实现钉子。
> 范围:`DataSourcesView.vue` **create + 凭据轮换** 表单的"先验证后保存";edit 不在 v1(见 §9)。
> 不涉及:C3 增量、C6 外写、K3 Save/Submit/Audit/BOM、任何凭据存储位置变更。

## 1. 问题

当前试连接口 `GET /api/data-sources/:id/test` **只认已存库的 id**。前端是「填表 → 直接保存(已创建源)→ 才能在列表行点测试」。host/凭据填错时**已经先造了一个坏源**,要再编辑/轮换重试。这是该页最大摩擦。

## 2. 目标 / 非目标

- 目标:create / 凭据轮换场景下,**保存前**用当前表单参数验证连接,错误就地暴露、不产生坏源。
- 非目标:不改凭据信任边界(凭据仍只经 create/rotate 落库);不引入批量;不改连接池长连;不碰 K3;**edit 场景的 draft 预验证留 v2**(§9)。

## 3. 后端契约(锁定)

新增 `POST /api/data-sources/test`:

- **入参 = create payload 同形**(连接参数 + 凭据),**仅覆盖 create + 凭据轮换(填入新密钥时)**。edit 不走 draft test——理由见 P1/§4。
- **零持久化,新增显式 helper `DataSourceManager.testEphemeralConnection(config)`**(P2a):
  - 由 `adapterTypes.get(type.toLowerCase())` 直接 `new AdapterClass(config)` 构造;
  - **不经 `addDataSourceInternal`**(它会注册进 `adapters` 且对 dup id 抛错)、**不写 `adapters`/`scopes`/`connectionPool`、不接 manager 事件转发**;
  - `try connect → 取 {success, latency, error} → finally adapter.disconnect() + adapter.removeAllListeners()`。
  - (注:`BaseDataAdapter` 无 `dispose()`;`addDataSource(persist=false)` 仍注册进 maps,**不是**真 ephemeral——故必须新 helper。)
- **钉子①(封装)**:该 helper 实现**封装在 `DataSourceManager` 内**;route 只调 `manager.testEphemeralConnection(config)`,**不直接触碰** private 的 `adapterTypes` / `adapters` / `scopes` / `connectionPool`。
- **校验**(P2b):复用 create 的 **schema / type allowlist**;连接必填项缺失由**同一 adapter connect/test 语义**返回失败(不在路由层另造一套必填校验);日后若新增业务校验,必须与 create 对齐。
- **错误语义**对齐既有 `/:id/test`(A3):请求层 `ok:true` + `data.success` 布尔 + 失败时 `data.error.message`(脱敏);4xx 仅 payload 非法 / 鉴权;5xx 仅意外异常。
- **钉子②(只回结果面)**:响应只含 `{ success, latency, error.message(脱敏) }`,**绝不 echo** 提交的 `config` / `connection` / `credentials`(不把入参或密钥反射回去)。
- **rbac = `data_sources:write`**(owner 已确认 2026-06-17):区别于 `/:id/test` 的 `read`——按任意参数主动外连属 write 级,收敛可调用人群、减少内网探测面,与 create 一致。
- **脱敏**:临时凭据不得入日志(沿用 adapter 既有 redacted `connectionError`)。
- 可行性已核:`adapterTypes` + `new AdapterClass(config)` 是 `addDataSourceInternal` 内现成路径;helper 复用构造、跳过注册与持久化即可。

## 4. 前端体验(锁定)

- **create**:表单内「测试连接」→ POST 当前 payload 到 `/test`。
- **凭据轮换**:仅当填入新密钥(复用现有 `credentialFieldsFilled`)时启用 draft 测试(stored 非密钥参数 + 新密钥);留空(保持现有密钥)则不显示 draft 测试,回退行级 `GET /:id/test`——stateless `/test` 不读取/合并存量密钥,这与 edit 同源,故回退是正确 v1 边界。
- **edit:不提供表单内 draft 测试**(P1)——凭据 write-only、`GET /:id` 不回传,改 host/db 沿用旧凭据无法构造真实连接 → 会假失败或逼用户重输。edit 仍用列表行 `GET /:id/test`(保存后验证);v2 再补 `:id/test-draft`(§9)。
- 结果**表单内联**呈现(成功=通过·latency;失败=失败·脱敏 message),**不**复用顶部全局 `store.error` 横幅(顺带消解表单校验错误与 API 错误混横幅的小毛病)。
- **不硬门控保存**(owner 已确认 2026-06-17):服务端试连有价值但不绝对代表部署路径;失败强提示、不阻断。

## 5. 切分(两刀,各自独立 PR + 独立 opt-in)

| 刀 | 内容 | 测试门 |
|---|---|---|
| Slice 1 (BE) | `testEphemeralConnection(config)` helper(封装于 manager)+ `POST /api/data-sources/test` 路由 + 脱敏 + 不 echo 入参 | 单元:type allowlist / 错误 shape / **响应不含 config/connection/credentials**;real-DB 集成:成功 + 失败 + **断言零持久化**(测后 DB row count 不变、`manager` list 不增、`adapters`/`scopes`/`connectionPool` 无残留、失败也不残留) |
| Slice 2 (FE) | create + 凭据轮换(新密钥)表单内「测试连接」+ 内联结果(edit 不接入) | 组件:成功/失败渲染;wire 测试:断言表单 payload 正确 POST(防 wire-vs-fixture 漂移) |

## 6. 红线 / 纪律

- issue 上 **values-free**:不出现真实连接串、账号、密码、host。
- **不新增凭据存储**;凭据仍只经 create/rotate 落库。
- **响应不 echo 入参**(钉子②):结果面 only;**helper 封装在 manager 内**(钉子①),route 不碰 private maps。
- 防滥用:复用 create schema/allowlist + `write` 门收敛人群;留意"勿沦为内网 host:port 探测 oracle / SSRF"——外连面与 create 同级,不扩面。
- BE 刀(新外连面)走**子智能体复审**。
- 此页**不在三个 builder 窗口的飞行文件内**(`DataSourcesView.vue` / `data-sources` 路由无在飞分支触碰)→ 本窗接它零撞车。

## 7. TODO

- ✅ design-lock(本文)
- ⬜ Slice 1 — `testEphemeralConnection` helper(封装于 manager)+ `POST /api/data-sources/test`(no-persist、不 echo 入参)
- ⬜ Slice 2 — FE create + 凭据轮换表单「测试连接」+ 内联结果
- 🔒 v2(§9)— edit 场景 `:id/test-draft`,owner 单独 opt-in

## 8. 验收

操作员在 create / 凭据轮换表单内、保存前验证连接;错误凭据就地暴露且**不产生坏源**;试连**零持久化**(无 DB/maps 残留),响应**不回显**入参与密钥。

## 9. v2 候选(不在本锁范围)

`POST /api/data-sources/:id/test-draft`:后端 `assertAccess(owner)` 后加载存量 config + 凭据,merge 当前**非密钥** draft,走同一 `testEphemeralConnection`(仍零持久化),让 edit 也能"改 host/db、沿用旧凭据"地预验证。契约更重(需读存量密钥入临时连接),单列 v2、owner 单独 opt-in。
