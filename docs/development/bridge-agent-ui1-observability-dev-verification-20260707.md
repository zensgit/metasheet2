# BA-UI-1 — Bridge Agent 只读可观测页 · 开发/验证报告 — 2026-07-07

> Design-lock: `docs/development/bridge-agent-admin-page-design-lock-20260707.md`(#3792,RATIFIED;
> owner granted BA-UI-1 implementation 2026-07-07)。Demand anchor: #3746(保持 OPEN)。
> 本片 = 纯只读可观测 UI:零写路径、零凭据路径变更、零 start/stop、零本机 config 编辑。

## 1. Backend scout 结论(实现前对账)

### 1.1 适配器面(`plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs`)

- 注册 kind:**`bridge:legacy-sql-readonly`**(`plugin-integration-core/index.cjs` L227
  `.registerAdapter('bridge:legacy-sql-readonly', createBridgeAgentReadonlyAdapterFactory(), { metadata: BRIDGE_READONLY_ADAPTER_METADATA })`)。
- 暴露操作:`testConnection` / `listObjects` / `getSchema` / `read`;`upsert` =
  `unsupportedAdapterOperation`(写在合同层就不可能)。metadata `supports` 同列这四项,
  `guardrails.write.supported=false`、`localhostOnly`、`noRawSql`。
- `testConnection()` 打 Agent 的 `GET /health` + `GET /objects`,返回
  `{ ok, status, connected, authenticated, code?, message }` —— message 已经过适配器内
  `redactSecretText`(DSN 密码/`*token=`/`Bearer|Basic`/JWT 全部 `[redacted]`)。
- `listObjects()` → `GET /objects` → 规格化为 `{ name, label, operations:['read'], source, readonly:true, fieldCount? }`。
- `getSchema({object})` → `GET /schema/<object>` → `{ object, fields:[{name,label,type,required}], raw:{source} }`。
- 协议版本:BA-M1 Agent(`scripts/ops/bridge-agent-readonly.ps1`)的 `/health` 不含 protocol/version
  字段,适配器也不透传 —— 状态卡片因此**不渲染版本**(渲染不存在的字段=造假)。

### 1.2 通用 HTTP 路由面(`plugins/plugin-integration-core/lib/http-routes.cjs`)

Workbench 既有面板已在消费三条**通用**只读端点(前端调用点 = `apps/web/src/services/integration/workbench.ts`):

| 需求 | 既有路由 | 前端 service 函数 | 权限 |
| --- | --- | --- | --- |
| health(在线/离线) | `POST /api/integration/external-systems/:id/test`(handlers.externalSystemsTest → adapter.testConnection) | `testExternalSystemConnection` | `integration:write`(探测=主动出网动作,沿用既有 tier) |
| 对象列表 | `GET /api/integration/external-systems/:id/objects`(→ adapter.listObjects) | `listExternalSystemObjects` | `integration:read` |
| schema 形状 | `GET /api/integration/external-systems/:id/schema?object=`(→ adapter.getSchema) | `getExternalSystemSchema` | `integration:read` |
| 实例列表 | `GET /api/integration/external-systems`(公开形状已剥凭据,带 `hasCredentials` 布尔) | `listWorkbenchExternalSystems`(父视图已加载,`systems` prop 传入) | `integration:read` |

后端在这些路由上已有的脱敏层(实现前逐一核对):

- test 路由:`sanitizeTestConnectionResult` 白名单只保留 `ok/status/code/message/authenticated/connected`
  且 string 值过 `redactSecretText`;回传的 `system` 经 `redactSystemForTest`(strip credentials)。
- objects/schema 路由:响应过 `sanitizeIntegrationPayload`。
- external-systems 列表:公开形状不含 credentials,凭据状态只有 `hasCredentials` 布尔。

### 1.3 零新路由决定

**采用:ZERO new backend routes。** 三条既有通用端点完整覆盖 BA-UI-1 的
health≈testConnection / objects≈listObjects / schema≈getSchema 三个面;实例列表来自既有
external-systems 公开形状。无新凭据路径、无写操作、无前端→Agent 直连(一切仍经 MetaSheet 后端代理,
与 lock §4 一致)。

**唯一后端改动 = 一个纯导出**(非路由、非行为):适配器新增导出
`BRIDGE_AGENT_READONLY_ADAPTER_ERROR_CODES`(4 码:`BRIDGE_AGENT_UNREACHABLE/TIMEOUT/REQUEST_FAILED/TEST_FAILED`),
供 web 端 IU-1 label 模块做 require() 镜像 tripwire —— 与
probe/resolver/composition/BOM 族既有纪律一致(单一来源,不手抄)。

**已知不可达数据 = objects 列表的 keyField**:design-lock BA-UI-1 行写「对象名/label/keyField/字段数」,
但 BA-M1 Agent 的 `GET /objects` 线上形状(ps1 L543-554)只回 `{id,label,readonly,fieldCount}`——
keyField 只存在于 Agent 本机 config,**任何 HTTP 端点都不暴露它**(schema 端点也不含)。
加后端路由无济于事(得改 BA-M1 Agent 协议,超出 UI 片授权范围)。
决定:本片渲染 name/label/fieldCount,keyField 留待 Agent 协议演进(若有)再补;组件内有注释说明。
同因,状态卡片的「协议版本」也不渲染(§1.1)。

## 2. 组件契约

`apps/web/src/components/integration/IntegrationBridgeAgentSection.vue`
(section id `int-sec-bridge-agent`,骑 IU-2 骨架,第 7 个 rail 分组 `bridge-agent` —— add-only)

- Props:`{ systems: WorkbenchExternalSystem[], scope: IntegrationScope }` —— 父视图只传共享的
  systems 列表 + scope;组件自持三条只读 service 调用(自包含模式 = IntegrationReadSourceConfigPanel 同款,
  区别于 IU-2b/2c 的纯模板抽取件)。
- kind 过滤:`system.kind === 'bridge:legacy-sql-readonly'` 的系统才进入本区。
- **状态卡片**:在线/离线(testConnection.ok)、只读标识(无条件渲染)、最近检查时间
  (**客户端时钟** `new Date().toISOString()`,非 wire 值)、单卡「检查连接」+ 全部检查(串行,不并发轰本机 Agent)。
- **实例列表**:name / 用途(role 人话)/ coarse status(启用/停用/异常)/ 凭据 =
  `hasCredentials` 布尔 →「已配置/未配置」。**不渲染** host/tenant/config/credentials/lastError。
- **对象列表**:选中实例 → `listExternalSystemObjects`;渲染 name/label/fieldCount
  (fieldCount 缺失显式「未提供/N/A」,不猜)。
- **Schema 预览**:按需 `getExternalSystemSchema`,显式逐字段映射 `{name,type,required}`
  (白名单 copy,wire 上任何额外 key 都进不了 DOM);**永不**调用 read/query(lock §4)。
- 空态:无实例(这是什么+第一步:去连接管理区新增)、allowlist 为空(第一步:本机 config 加对象)——
  IU-6 what+first-step 双 testid 模式。
- i18n:useLocale + 组件内 `bi(zh,en)`(read-source panel 同款);field hints 走 fieldHints.ts
  新增 4 个 `bridgeAgent.*` key(el-tooltip);样式 token-only(UF-6 guard TARGET_FILES 已收编本文件)。
- EP icons:`Connection`/`Lock`/`Refresh`(@element-plus/icons-vue)。

### 错误展示纪律(比 IU-1 基线更紧一档)

IU-1 基线允许 raw **code**(注册闭集)出现在折叠/次要位。本组件连 code 字符串也不渲染:
Bridge Agent 的 HTTP error body 里 `error.code` 可以是**运营者自建 Agent 提供的任意字符串**
(适配器 `bridgeErrorCode(data)` 原样透传),不属于闭集 —— 所以显著层与全部层都只渲染
`integrationErrorCodeDisplayLabel` 的映射结果(未注册码→通用「未知错误」),objects/schema 失败
渲染固定双语文案(shared `parseIntegrationResponse` 抛出的 Error.message 携带后端 error.message,
组件 catch 后**不捕获不渲染**该文本)。

## 3. Sentinel 测试说明(`apps/web/tests/IntegrationBridgeAgentSection.spec.ts`,10 tests)

在组件能收到的**每个后端供给面**种入 secret 形状哨兵串:

| 哨兵位置 | 载体 |
| --- | --- |
| `system.config.sharedSecretEnvVar` / `system.config.connectionString` | systems prop |
| `system.lastError`(token=…、内网 IP) | systems prop |
| testConnection 响应 `message`(secret+localhost URL)与嵌套 `system.config.sharedSecret` | POST /test mock |
| testConnection 响应 `code`(敌意非闭集 code,内嵌 secret=) | POST /test mock |
| objects 响应条目额外 key `connectionString` | GET /objects mock |
| schema 响应 field 额外 key `defaultValue` + `raw.leaked` | GET /schema mock |
| objects/schema 失败 body `error.message`(authorityCode=…) | 500 mock |

驱动全部渲染路径(check + 自动 objects + schema 展开)后断言:每个哨兵串在 `innerHTML` 与
`textContent` 双面均不出现,且子片段(`SENTINEL-`/`Password=`/`token=`/`authorityCode=`/内网 IP/
`sharedsecret`)也不出现 —— 部分渲染同样算泄漏。同 spec 另有:未注册 code 降级断言、
raw code 字符串不渲染断言、固定文案断言、凭据布尔是唯一凭据相邻输出断言、zh 文案断言。

### Mutation 证明(每变体单独注入→跑→红→精确路径 revert;基线 commit 后执行)

| # | 变体 | 结果 |
| --- | --- | --- |
| A | 状态卡错误行渲染 raw `state.code` 而非 label | RED(1 failed)✅ killed |
| B | 实例列表 status 单元格追加 `{{ system.lastError }}` | RED(sentinel)✅ killed |
| C | objects 失败 catch 捕获 error.message 并渲染 | RED(values-free 断言)✅ killed |
| D | 客户端镜像删除 `BRIDGE_AGENT_TIMEOUT` | RED(mirror tripwire Set-equality)✅ killed |
| E | 视图删除第 7 个 rail 分组 | RED(2 failed:view wiring + rail anchor)✅ killed |

## 4. 安全边界 checklist(vs lock §2.1 逐条)

| §2.1 锁条款 | 状态 | 证据 |
| --- | --- | --- |
| 禁前端显示/保存 password/token/secret/connection string/authorityCode/原始 payload rows/业务数据行 | ✅ | sentinel 测试(§3)全渲染路径覆盖;schema/objects 显式白名单字段映射;错误只出 label/固定文案 |
| 凭据仅后端持有;前端最多「已配置/未配置」布尔 | ✅ | 唯一凭据相邻输出 = `hasCredentials` → 已配置/未配置;组件不读 `system.config`/`credentials` 任何键 |
| 禁 raw SQL 编辑器;只能 allowlist 对象 | ✅ | 零输入框(除实例下拉);对象列表=Agent allowlist 只读回显;无任何 SQL 面 |
| 默认只读;不得触发 K3 Save/Submit/Audit、ERP/PLM/生产写 | ✅ | 组件 import 面无任何写 service;`POST /query` 不消费(spec 断言每次 fetch 均属 test/objects/schema 三端点) |
| 诊断/导出 values-free | ✅ | 展示面=count/布尔/coarse 状态/闭集 label;无导出功能(BA-UI-2+ 才有探测证据面) |
| 无 start/stop、无本机 config 编辑(第一版 out 项) | ✅ | 无对应 UI/调用;计划任务运行态提示属 BA-UI-4(未开门) |
| 代理走既有 external-system 权限门,不碰中央 rbac/auth | ✅ | 零新路由;test=integration:write、objects/schema/list=integration:read 全部沿用既有门 |

## 5. 测试与构建矩阵

| 面 | Node 25(默认) | Node 20(nvm,CI 同版) |
| --- | --- | --- |
| plugin-integration-core CJS 全链(`pnpm --filter plugin-integration-core test`) | ✅ | ✅ |
| integration-guard 19-spec 全列表(含新 IntegrationBridgeAgentSection,223 tests) | ✅ 223/223 | ✅ 223/223 |
| ui-foundation-style-guard(TARGET_FILES 收编新组件后 67 tests) | ✅ | —(纯 fs 扫描,版本无关) |
| `vue-tsc -b` | ✅ clean | — |
| `pnpm build`(apps/web) | ✅ | — |

CI 面:integration-guard.yml 的 pull_request/push paths 与 vitest run 列表均已收编新组件+新 spec
(workflow 自身也在自己的 paths 里,改动即触发)。
注意(既有事实,非本片引入):plugin-integration-core 测试链在 integration-guard.yml 中运行,
本 PR 触碰 `plugins/plugin-integration-core/**` 会触发。

## 6. 改动清单

| 文件 | 类型 |
| --- | --- |
| `apps/web/src/components/integration/IntegrationBridgeAgentSection.vue` | 新增(组件本体) |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | 挂载 + 第 7 rail 分组 + sectionGroupIds(add-only) |
| `apps/web/src/services/integration/errorCodeLabels.ts` | BRIDGE_AGENT_* 族(4 码 label + 镜像数组) |
| `apps/web/src/services/integration/fieldHints.ts` | 4 个 `bridgeAgent.*` hint |
| `apps/web/src/services/integration/workbench.ts` | `IntegrationSystemObject` 增补 `fieldCount?/readonly?` 类型(对既有 wire 的 additive typing,非 wire 变更) |
| `plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs` | 导出错误码闭集常量(纯导出,零行为) |
| `plugins/plugin-integration-core/__tests__/bridge-agent-readonly-adapter.test.cjs` | 钉 4 码 + TIMEOUT/REQUEST_FAILED 兜底路径用例 |
| `apps/web/tests/IntegrationBridgeAgentSection.spec.ts` | 新增(10 tests,含 sentinel) |
| `apps/web/tests/IntegrationWorkbenchRail.spec.ts` | 7th group fixture + 11th anchor(add-only) |
| `apps/web/tests/IntegrationWorkbenchView.spec.ts` | 7-group wiring(add-only) |
| `apps/web/tests/integrationErrorCodeLabels.spec.ts` | BRIDGE_AGENT 镜像 tripwire |
| `apps/web/tests/ui-foundation-style-guard.spec.ts` | TARGET_FILES 收编新组件 |
| `.github/workflows/integration-guard.yml` | paths + run 列表收编 |

## 7. 边界外(维持冻结)

BA-UI-2(values-free 探测)/ BA-UI-3(配置校验+变更建议)/ BA-UI-4(计划任务运行态)各需独立
opt-in;本片未实现其任何部分。
