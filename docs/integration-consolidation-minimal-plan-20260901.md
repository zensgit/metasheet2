# 集成层最小可执行收敛方案（2026-09-01）

> 结论：可以收敛，但不做“外接数据源、数据工厂、Bridge Agent 三合一”，也不在当前阶段建设完整 iPaaS。
> 当前只完成某大客户备料接管所需的只读 SQL / Bridge 连接复用；Automation、HTTP/K3/PLM、飞书连接器按真实需求后置。

- 代码基线：`main@919dc42366d3464c0b941448fad880c88f3f7cf5`
- 文档性质：实施方案，不代表功能已经实现。
- 审阅状态：已逐条核对关键代码事实；本版已纳入 tenant、Bridge 归属、迁移期引用保护和 raw query 权限四项修订。
- 外部参照：飞书、n8n、数环通资料只用于比较产品边界，不作为本仓库配置或执行指令。
- 安全前提：真实客户数据、生产写入和任何外部系统写回仍需 owner 明确批准；K3 Save/Submit/Audit 不进入本方案。

## 1. 先回答：会不会超级麻烦

如果一次完成连接中心、OAuth、几十种连接器、定时/Webhook、可视化流程、治理表合并和连接器市场，工程量很大，而且会偏离当前备料接管目标。

本方案把当前必做项压缩为 3 个顺序依赖、可分别合并的 PR：

| PR | 当前要做的事情 | 复杂度 | 不做什么 |
|---|---|---:|---|
| PR-1 | External System 引用统一 Data Source；补 tenant schema 和双读 Resolver | 中 | 不搬 HTTP/K3/PLM 凭据，不改 Pipeline ID |
| PR-2 | 修复连接权限、双形态引用追踪、安全删除和 raw query 边界 | 中 | 不合并治理表，不删历史 migration |
| PR-3 | 让 plugin Resolver 将 Bridge descriptor 分派给现有只读 adapter | 中 | 不把 Bridge 伪装成 core SQL adapter，不开放写通道 |

完成这 3 个 PR 后应停止平台扩张，回到备料业务验收。Automation 触发、飞书连接器和通用 iPaaS 都是后续独立增量，不是这次收敛的前置条件。

## 2. 五个概念必须分开

| 概念 | 唯一职责 | 当前实现 | 收敛后的定位 |
|---|---|---|---|
| Connection | endpoint、驱动、凭据、连通性和访问权限 | `/data-sources`、`DataSourceManager` | 唯一物理连接注册中心 |
| Integration Binding | 连接在某个项目/场景中的身份、角色、能力和语义配置 | `integration_external_systems` | 保留，新增 `connection_id` 引用 Connection |
| Data Factory | 读取契约、映射、校验、批量/增量、DLQ、水位线和血缘 | Integration Core Pipeline | 保留为数据执行引擎 |
| Automation | 定时/Webhook/记录事件、条件、分支、等待和执行身份 | Multitable Automation | 保留为编排控制面 |
| Bridge Agent | 中央服务无法直连客户内网时的本机只读通道 | PowerShell Agent + Bridge adapter | Connection 的 `bridge` transport |

API Token、开放 API 和事件 Webhook 是第六个关注点：接口网关。它们可以复用 Connection、凭据、审计和限流能力，但不并入 Data Factory 或 Bridge。

用户心智模型保持简单：

- 管物理连接：外接数据源。
- 管业务对接、映射和同步：数据工厂。
- 管自动触发和流程条件：Automation。
- Bridge 由连接层自动选择，普通用户不需要把它理解成另一种数据源。

## 3. 已核实的代码事实

### 3.1 平台不缺触发器，缺的是安全绑定

Automation 已定义并运行以下触发器：

- `schedule.cron`、`schedule.interval`、`schedule.date_field`、`webhook.received`：`packages/core-backend/src/multitable/automation-triggers.ts:6-31`
- 匿名入站 Webhook 路由：`packages/core-backend/src/routes/automation.ts:236-253`
- HMAC、时间戳和五分钟重放窗口：`packages/core-backend/src/multitable/automation-inbound-webhook.ts:3-10,66-95`
- 服务启动时加载并注册所有定时规则：`packages/core-backend/src/index.ts:3282-3304`

因此准确结论是：Data Factory Pipeline 尚未通过受治理的内部端口绑定到现有 Automation，而不是系统没有定时或入站 Webhook。

### 3.2 连接引用复用已经有可工作的种子

- 宿主只向 Integration Core 注入 Data Source 的受限 facade：`packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:8-21`
- `data-source:sql-readonly` 只保存 `dataSourceId`，不复制凭据：`plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:557-565`
- UI 已明确提示凭据由 `/data-sources` 管理：`apps/web/src/components/integration/IntegrationConnectionSection.vue:189`

本次不是重新发明连接层，而是把已经正确工作的引用路径变成正式模型。

### 3.3 `integration_external_systems` 不能删除

该表承载 tenant/workspace/project、kind、role、capabilities、status：
`packages/core-backend/migrations/057_create_integration_core_tables.sql:19-46`。

Pipeline 通过稳定的 source/target external system ID 引用它：
`packages/core-backend/migrations/057_create_integration_core_tables.sql:51-77`。

内部的 `metasheet:staging`、`metasheet:multitable` 也没有对应外部物理连接。因此正确处理是把该表收敛为 Integration Binding，而不是删除、重建或更换 ID。

### 3.4 当前 Data Source 还不是通用凭证中心

当前路由只接受 `username/password/apiKey/token`：
`packages/core-backend/src/routes/data-sources.ts:54-59,116-123`。

DataSourceManager 只加密 `password/apiKey/token`：
`packages/core-backend/src/data-adapters/DataSourceManager.ts:12-15,213-220`。

K3、Bridge、OAuth 等凭证包含更多字段，直接迁移可能丢字段，或把未识别的 secret 落入普通 JSON。因此本阶段只收敛已经适配的 SQL 只读连接；通用整份凭证加密是未来接 HTTP/K3/PLM/飞书前的独立前置任务。

现有 Integration 凭据并非从零开始统一：宿主安全服务存在时，新写已经使用平台 `enc:` 格式，旧 `v1:` 仅保留兼容读取，见 `plugins/plugin-integration-core/lib/credential-store.cjs:6-22,143-147` 和 `packages/core-backend/src/security/plugin-runtime-security-service.ts:116-197`。未来工作的重点是整份 credential document 的 schema、存储形态和旧值重加密，不是再造第三套算法。

### 3.5 Bridge 已在 Integration Core 注册，不应伪装成 core Data Source adapter

- Integration Core 已注册 `bridge:legacy-sql-readonly`：`plugins/plugin-integration-core/index.cjs:325-333`
- core 默认注册表仍把 `sqlserver` 固定映射到 `MSSQLAdapter`：`packages/core-backend/src/data-adapters/DataSourceManager.ts:54-60`
- 现有 Bridge adapter 依赖 plugin 私有 contracts：`plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs:10-16`
- core `BaseDataAdapter` 要求 query、CRUD、事务和 stream：`packages/core-backend/src/data-adapters/BaseAdapter.ts:219-241,260-268`
- Bridge 只有 test/listObjects/getSchema/read，upsert 永久拒绝：`plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs:372-483,498-518`

Bridge 还是 `pagination:none + adapter_reported limit` 的特殊来源，不能套用 direct SQL 的 cursor/completeness 语义，见 `plugins/plugin-integration-core/lib/stock-preparation-readonly-source-run.cjs:31-42,54-70,248-279`。因此本方案选择唯一方向：**`data_sources` 在 core 只保存 Bridge connection descriptor、ACL 和引用；plugin `ConnectionResolver` 在创建 adapter 前完成 `direct | bridge` 分派，Bridge 继续使用现有唯一协议实现。** core 不导入 plugin，也不复制 Bridge HTTP 协议。只有将 core adapter 合同拆成独立只读能力接口，并且 Bridge 补齐可信分页/总数证明后，才重新评估下沉 core。

### 3.6 Connector Action 还没有接上运行时

Connector Action Contract 目前明确标记为 `LATENT`：
`plugins/plugin-integration-core/lib/connector-action-contracts.cjs:3-7`。

这意味着系统已有部分动作元数据，但还不能据此声称具备 n8n 或飞书连接器平台能力。这个缺口不阻塞当前 SQL/Bridge 只读收敛。

## 4. 最小目标架构

```text
外接数据源 / data_sources ── host 安全查询 ───────────────┐
  物理连接 descriptor、tenant/scope、ACL、引用           │
          │ connection_id                                │
          ▼                                              │
Integration Binding / integration_external_systems
  项目、角色、kind、capabilities、语义配置
          │ source_system_id / target_system_id
          ▼
Data Factory PipelineRunner
  读取、映射、校验、DLQ、水位线、血缘
          │
          ▼
plugin ConnectionResolver ◀──────────────────────────────┘
    ┌─────────────┴─────────────┐
    ▼                           ▼
direct transport          bridge transport（唯一协议实现）
宿主 Data Source facade   bridge:legacy-sql-readonly
    │                           │
MSSQLAdapter              localhost-only Agent
                          客户数据库凭据留本机
```

未来真正需要自动运行时再增加：

```text
Automation trigger
        │ run_integration_pipeline
        ▼
IntegrationRunPort
        ▼
integration_run_requests
        ▼
Integration Worker → PipelineRunner
```

AutomationExecutor 与 PipelineRunner 必须保持两个执行引擎。前者负责事件、条件、等待和 actor；后者负责数据分页、映射、批量写入、DLQ 和水位线。可以共享连接、凭据、审计、重试和 correlation ID，不能合并核心执行循环。

Bridge transport 有明确部署约束：MetaSheet backend/plugin runtime 与 Bridge Agent 必须运行在同一台受控 on-prem OS host 和 network namespace，因为 adapter 只允许访问自己的 localhost。中央 SaaS 以及未采用 host networking 的普通容器不能用 localhost 访问客户电脑上的 Agent，并且不得自动退化为远程 host。此时必须 fail closed，并向 UI 返回可理解的 `BRIDGE_LOCAL_AGENT_REQUIRED` / `BRIDGE_AGENT_UNREACHABLE` 错误。

## 5. 当前实施范围

### PR-1：Connection 与 Binding 正式关联

新增一条前向 migration：

- 给 `integration_external_systems` 增加 nullable `connection_id`。
- 建立到现有 `data_sources.id` 的 `ON DELETE RESTRICT` 引用约束；迁移阶段允许为空。
- 给 `data_sources` 增加 nullable `tenant_id` 和 `scope_kind`；`scope_kind` 闭集为 `legacy_private | private | workspace`，现有记录回填为 `legacy_private`，新建记录默认 `private`（workspace 共享须显式选择）。
- 保留所有 external system ID、Pipeline FK 和 sealed authority 证据。
- 不修改旧 057 migration。

tenant schema 决策写死如下：

- `tenant_id` 是 `data_sources` 上的显式列，**不得仅从 `workspace_id` 隐式派生**。
- 新建 Connection 必须从 JWT/服务身份绑定的可信认证上下文写入 `tenant_id`，不得接受请求体自报 tenant。
- 旧记录在 tenant 归属未被可靠证明前允许 `tenant_id = NULL`，但只能由原 owner 使用，不能 workspace 共享或由 service identity 运行。
- 仅当权威 workspace membership 能唯一证明 tenant/workspace 时才回填；歧义记录进入人工 reconciliation。
- Resolver 必须比较 Binding、Connection 和执行上下文的 tenant；任一不一致即 fail closed。

新增 `ConnectionResolver`：

1. Binding 有 `connection_id` 时，只读取 canonical Connection；连接不存在、越权或解析失败都不得降级 legacy。
2. 仅当 `connection_id IS NULL`、记录创建于 cutover 前、kind 在显式 allowlist 且仍为 owner-only 时，才允许读取 legacy `config.dataSourceId`。
3. Resolver 把 binding 的语义配置与 connection 的物理配置组合成现有 adapter 输入，第一阶段不重写 adapter。
4. 新建 `data-source:sql-readonly` binding 只写 `connection_id`，不再复制账号密码；如果该引用缺失，必须作为孤儿配置 fail closed，不能假装回退。
5. `connection_id` 与 legacy `config.dataSourceId` 同时存在但指向不同 Connection 时立即 fail closed；HTTP/K3/PLM 继续走各自现有路径，不属于本次 Resolver fallback。

首批只回填已经引用 `dataSourceId` 的 SQL 只读 binding。不要按相同 endpoint 自动去重，也不要迁移 HTTP/K3/PLM 凭据。

#### PR-1 验收

- 旧 Pipeline 不改 ID 即可继续运行。
- 新旧读取路径的 schema、对象列表和只读查询结果一致。
- 两个 Binding 可以复用一个 Connection，且不复制 secret。
- 仅对迁移回填且仍保留 `config.dataSourceId` 的旧 Binding，将 `connection_id` 置空后可以回退 legacy 路径。
- 新建 `data-source:sql-readonly` 类 Binding 的 `connection_id` 不可为空；缺失时返回配置错误。（HTTP/K3/PLM Binding 本阶段合法地没有 `connection_id`，不受此条约束。）
- tenant 不一致或旧记录 tenant 未确认时，不得扩大为 workspace/service 使用。

### PR-2：权限、引用追踪和安全删除

当前 Data Source 主要按 owner 授权，workspace 还只是预留：
`packages/core-backend/src/data-adapters/DataSourceManager.ts:126-128,375-385`。

引入结构化访问上下文：

```ts
interface ConnectionAccessContext {
  actorId: string
  tenantId: string
  workspaceId?: string
  permissions: Array<'read' | 'use' | 'manage' | 'rotate'>
  runAs: 'user' | 'service'
}
```

实施要求：

- 保留现有 owner 连接为 `legacy_private`，不得自动扩大可见范围。
- 只有能证明 tenant/workspace 归属的连接才迁为 workspace 共享。
- `use` 和 `manage/rotate` 分权：可运行 Pipeline 不代表可查看或轮换凭据。
- workspace `use` 只允许 `testConnection/getSchema/getTableInfo/select` 及同等受限 facade 操作，不包含 raw `/query`。
- `POST /api/data-sources/:id/query` 必须同时满足现有 `data_sources:execute` RBAC 和 Connection owner/`manage` 授权；Bridge transport 即使 owner 也永久拒绝 raw query。
- 增加 Connection 引用查询；迁移期必须同时检查新 `integration_external_systems.connection_id` 和 legacy `config.dataSourceId`。任一种引用存在时，soft/hard DELETE 都返回 `409` 和 values-free consumer 信息；不能只依赖不会被 soft delete 触发的 FK。
- 删除必须在事务中先检查引用并更新数据库，提交后才清理内存。

当前删除路径可能先删除内存实例，再处理数据库：
`packages/core-backend/src/data-adapters/DataSourceManager.ts:506-543`。该问题必须在统一引用后修复，避免连接重启后“复活”。

#### PR-2 验收

- workspace 使用者可以 `use`，但不能 `rotate`。
- 只有 `use` 的 workspace 使用者访问 raw `/query` 必须得到 `403`；owner/`manage` 还必须通过现有 `data_sources:execute` RBAC。
- 错 tenant/workspace 访问 fail closed。
- 只有 legacy `config.dataSourceId` 引用、只有新 `connection_id` 引用或两者同时存在时，连接均无法删除。
- 删除失败不会改变内存状态，重启后不会复活。
- API、日志和审计不返回 secret 或客户连接值。

### PR-3：Bridge 成为 SQL Server 的 transport

实现归属采用 plugin Resolver 方案：

- `data_sources` 增加 `transport_kind`，闭集为 `direct | bridge`，旧记录默认 `direct`。
- core 为 Bridge 保存不可执行的 registration descriptor、ACL 和引用，不将其注册成 `MSSQLAdapter`，也不执行 Bridge 协议。
- DataSourceManager 在 `transport_kind=bridge` 时使用 inert registration holder，不能继续按 `type=sqlserver` 实例化 `MSSQLAdapter`。
- 宿主 facade 增加 tenant/scope-gated 的 `resolveConnectionRegistration`，只返回 `{ type, transport, nonsecretConfig, authEnvRef }` 等安全 descriptor，不返回 secret 值。
- plugin `ConnectionResolver` 在 `adapterRegistry.createAdapter` 前验证 Binding 与 descriptor：`type=sqlserver, transport=direct` 使用 `data-source:sql-readonly`；`type=sqlserver, transport=bridge` 使用现有 `bridge:legacy-sql-readonly`。
- Bridge shared secret 继续通过受控的本机环境变量引用解析，客户数据库凭据继续只在 Agent 本机；旧 Binding kind 和 ID 暂不改。
- `/data-sources` UI 显示 transport；Bridge registration 的 core test/schema/select/query 均禁用，并引导到 Integration Bridge 观测页。core 不导入 plugin。
- `/data-sources` create/update schema 对 Bridge 不再要求 SQL host/server，也不得接受远程 base URL；只允许固定 localhost 语义、非秘密 registration 参数和受校验的 `authEnvRef`。

目标分派：

```text
type=sqlserver, transport=direct → MSSQLAdapter
type=sqlserver, transport=bridge → plugin bridge:legacy-sql-readonly
```

Bridge 安全边界原样保留：

- 只监听 localhost。
- 只接受对象/字段白名单，不接受 raw SQL。
- 仅实现只读 source，不实现 upsert/write target。
- core `/api/data-sources/:id/test|schema|select|query` 对 Bridge registration 返回结构化“仅 on-prem Integration runtime 可执行”；其中 raw `/query` 永久为 `403`，不得把 SQL 文本转发给 Agent。
- 必须验证 Agent 回显 limit。
- 客户数据库凭据只保留在 Agent 本机。
- 中央只保存 Agent 注册信息和 Bridge 鉴权引用。

相关现有硬锁：

- 平台适配器强制 localhost：`plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs:120-142`
- 适配器只读且不支持写：`plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs:372-483,498-518`
- Agent 对象/字段白名单：`scripts/ops/bridge-agent-readonly.ps1:241-282`
- Agent 使用参数化等值过滤：`scripts/ops/bridge-agent-readonly.ps1:409-449`
- Data Source UI 当前默认向 SQL source 暴露测试/结构/预览并要求 host/server，改造点见 `apps/web/src/views/DataSourcesView.vue:146-180,460-463,630-640`

#### PR-3 验收

- 相同 Pipeline 契约可在 direct 和 bridge transport 间切换。
- Bridge 仍无法执行 raw SQL 或任何写入。
- 中央数据库、日志和 API 中没有客户数据库密码。
- localhost、白名单和 limit 校验均有回归测试。
- core 不依赖 plugin，Bridge HTTP 协议只有 plugin 内现有一份实现。
- core UI/API 不会把 Bridge registration 误拨给 `MSSQLAdapter`，也不会把它展示为可执行 raw SQL 的普通 SQL Connection。
- on-prem 同机部署可以测试成功；中央 SaaS 或 Agent 不在同机时以明确错误 fail closed。
- 形成一个客户可见的只读备料演示。

完成 PR-3 后停止本轮平台工作，进入客户只读窗口授权、历史迁移和双轨对账。

## 6. 后续需求出现时再做

### 6.1 客户需要自动同步时

复用现有 Automation scheduler 和 inbound webhook，不接活第二套 `integration_schedules` runtime。

新增：

- 宿主拥有的 `IntegrationRunPort.request()`。
- 持久化 `integration_run_requests`。
- 独立 Integration Worker。
- Automation 动作 `run_integration_pipeline`。

队列采用至少一次投递，并通过唯一键防止重复请求：

- cron：`triggerId + scheduledFor`
- webhook：`triggerId + providerEventId`

触发器只决定“何时请求运行”，绝不自动授予外部写权限。Automation 也不能通过普通 HTTP/self-webhook 绕过 Integration 的写入围栏。

### 6.2 客户需要 HTTP/K3/PLM/飞书时

现有 credential store 已经做到“新写 `enc:`、兼容读旧 `v1:`”。因此这里不是替换加密算法，而是把目前分散的 provider credential shape 收敛成按 connector schema 校验的整份加密文档，并用应用层任务将旧 `v1:` 解密后重新写成 `enc:`；禁止 SQL 直接复制旧密文。

先完成以下基础能力：

- 整份 credential document 加密。
- 每种 connector 的 auth schema。
- OAuth 授权、刷新、吊销和过期状态。
- 可运行、可版本化的 Connector Catalog。
- 强类型、命名明确的 action/trigger。
- provider 事件去重、重放、限流和观测。

飞书首批应按真实场景实现少量动作，例如读取多维表、写入指定对象或接收指定事件；不先提供任意 URL、任意 raw HTTP、任意 SQL 的万能节点。

### 6.3 明确延期

以下事项不是当前备料接管前置条件：

- 通用 n8n 式可视化画布。
- 连接器市场和第三方 Connector SDK。
- BPMN 与 Integration 的整合。
- 远程 Bridge Agent fleet 管理。
- 062/063/064/065 治理表物理合并。
- AutomationExecutor 与 PipelineRunner 合并。
- HTTP/K3/PLM 全量凭据迁移。
- 任何 K3 Save/Submit/Audit。

## 7. 不应进行的“伪合并”

### 不物理合并 062/063/064/065

这些表虽然都采用内容寻址、draft/approved/retired 和 values-free 审计，但唯一键和安全不变量不同。当前只应抽取共享的版本、审批和审计代码，不把业务表合成一个通用 JSON 表。

### 不强行共用两个 HTTP Adapter

core `HTTPAdapter` 暴露写方法，而 Integration HTTP adapter 有默认拒绝写的治理语义。可以抽取 SSRF、timeout、重试、脱敏、指标等 `SecureHttpClient`，但不能用 core adapter 替换受治理 adapter。

### 不把四套字段映射压成一张表

前端编辑 DTO、读取投影、ETL 映射和备料业务映射不是同一种语义。可以共享 transform registry 和 canonical IR，不能抹平业务边界。

### 不删除历史 migration

040/044 已作为 superseded/no-op 历史标记存在：
`packages/core-backend/src/db/migration-provider.ts:21-35,84-102,192-198`。

可以在独立 PR 中删除零 importer 的旧服务源码；如果要删除数据库遗留表，必须新增前向 migration、先盘点和备份。历史 migration 文件名不能删除。

## 8. 最终产品能力判断

完成当前 3 个 PR 后，系统获得的是可靠的“制造业只读数据接入底座”，不是完整 iPaaS：

- 连接只配置一次，可被多个业务 Binding 引用。
- Data Factory 不再复制 SQL 凭据。
- Direct SQL 与 Bridge 共用 Integration source contract，但保留各自不同的分页与完整性 capability。
- Connection、Binding、Pipeline 的职责清楚且可追踪。
- 现有只读、安全围栏和证据链不被破坏。

未来增加 Automation 运行端口和第一个真实飞书连接器后，系统才开始具备 n8n/飞书连接器的动作编排能力；随着 connector catalog、OAuth、重试、事件去重和运行观测成熟，才逐步接近数环通类 iPaaS。

该演进路线不需要再次推翻连接层，但也不要求当前为尚未发生的需求预建完整平台。

## 9. 决策摘要

1. `/data-sources` 是唯一物理连接注册中心。
2. `integration_external_systems` 保留，转为稳定的 Integration Binding。
3. Data Factory 和 Automation 保持两个执行引擎。
4. Bridge 是 SQL Server Connection 的只读 transport；core 只保存 descriptor，plugin Resolver 执行唯一协议实现。
5. 当前只做 SQL/Bridge 只读收敛、权限和引用安全。
6. 自动触发、HTTP/K3/PLM、飞书和 Connector Catalog 按真实需求后置。
7. 不合并治理表、不接 BPMN、不建设连接器市场、不开放外部写。
8. 每个阶段必须可回滚；旧凭据、旧字段和历史 migration 只有在完成审计和回滚窗口后才允许清理。

---

*代码行号基于 2026-09-01 快照；main 前进后，实施 PR 合并前必须 rebase 并重新核对。*
