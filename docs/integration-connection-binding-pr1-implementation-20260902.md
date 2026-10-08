# Integration Connection / Binding PR-1 实施与验收报告

> 日期：2026-09-02
>
> 状态：代码已实现、完成人工对抗 review 并修复全部提交前建议，可提交合并；未部署。
>
> 基线：`origin/main@2f0f3b53d`（#5450，仅新增备料方案文档；PR-1 已 fast-forward 对齐）
>
> 分支：`codex/integration-connection-binding-pr1`
>
> 独立 worktree：`C:\Users\zhou\Downloads\dev\metasheet-pr1-connection-binding`

## 1. 结论

PR-1 已把“物理 Connection”与“业务 Binding”建立成真实的 canonical 引用关系，同时保留受控的旧数据回退窗口；没有新建第二套调度、第二套数据源或第二套凭据系统。

本次改动经人工对抗 review 后无生产代码阻断项，测试隔离和部署说明建议均已收口。它没有扩大 Bridge、raw SQL 或外部写能力；HTTP/K3/PLM 凭据仍走原路径。PR-2 的 workspace 共享、删除原子性和 raw `/query` 权限，以及 PR-3 的 Bridge transport Resolver，均未提前夹带进来。

实施基准仍是[最小整合方案](./integration-consolidation-minimal-plan-20260901.md)，本报告只记录已落地代码、验证证据和剩余边界。

## 2. 模型分工

| 模型 | 任务 | 采用原因 |
| --- | --- | --- |
| Sol | 架构裁决、跨模块集成、最终安全审查与验收 | 负责最难的边界一致性和最终收敛 |
| Terra | Connection Resolver、sealed capability 与权限链复核 | 适合中高复杂度后端、安全和运行时推理 |
| Luna | core/frontend 的局部实现与测试补齐 | 适合边界清楚、反馈快的模块化工作 |
| Kimi K3 | 长上下文代码与既有方案交叉审计 | 用于大范围检索、发现历史约束和重复实现风险 |
| Grok 4.6 | migration 与结构测试初稿、独立实现校验 | 用作并行编码代理，最终代码仍由 Sol 复核和整合 |

这套分工不是五个模型同时修改同一文件：迁移、Resolver、core、UI 和安全 review 被拆成独立任务，最终只在一个独立 worktree 中集成，避免与主检出的备料变更及未解决冲突互相覆盖。

## 3. 已实现范围

### 3.1 Schema：建立 canonical Connection 引用

新增迁移：

- `packages/core-backend/src/db/migrations/zzzz20260902120000_add_integration_connection_binding.ts`
- `data_sources.tenant_id`：显式、nullable，不从 workspace 猜测。
- `data_sources.scope_kind`：闭集 `legacy_private | private | workspace`；旧记录回填 `legacy_private`，新记录默认 `private`。
- `integration_external_systems.connection_id`：nullable，引用 `data_sources.id`，`ON DELETE RESTRICT`，允许多个 Binding 复用一个 Connection。
- `legacy_connection_fallback_eligible`：服务端维护的持久布尔标记，默认 `false`。

只回填同时满足以下条件的旧 SQL 只读 Binding：

1. `kind = data-source:sql-readonly`；
2. `config.dataSourceId` 能命中真实 `data_sources.id`；
3. 服务端历史戳 `config.dataSourceOwnerId` 与 Connection 的 `owner_id` 一致。

无法证明归属的记录保持未绑定和不可回退，不按 endpoint 自动合并。迁移对干净执行、重复执行和部分执行后的恢复均作了保护。

### 3.2 Core：可信 tenant/scope 与两形态引用保护

- `DataSourceManager` 持久化并恢复 tenant/scope；缺失或畸形旧字段按最窄的 `legacy_private + tenant null` 处理。
- 新建 Connection 默认 `private`，tenant 只能来自 JWT claim 专属的 `req.authenticatedTenantId`；请求体、`x-tenant-id` 兼容 header，以及被该 header 回填的 `req.user.tenantId` 都不能自报 tenant。
- canonical `connection_id` 与 legacy `config.dataSourceId + dataSourceOwnerId` 都进入删除引用计数；已迁移记录不会重复计数。
- 只有首个查询明确返回 PostgreSQL `42P01` 时才按“旧库尚无 integration 表”处理；已经观察到 canonical 引用后，后续 DDL race 不会被吞掉。
- 普通 plugin facade 只返回 `{ id, type, tenantId, scopeKind }`，不读取 adapter config、不连接数据库、不暴露凭据。

### 3.3 Plugin：单一 Resolver，canonical 优先

新增 `plugins/plugin-integration-core/lib/connection-resolver.cjs`：

- 仅接管 `data-source:sql-readonly`；HTTP/K3/PLM 继续原路径。
- `connection_id` 一旦存在就是唯一权威；解析失败不能退回 legacy。
- canonical 与遗留 `config.dataSourceId` 同时存在但不一致时立即 fail closed。
- legacy 回退必须同时满足：`connection_id === null`、迁移标记为真、存在有效旧指针、owner user delegation、tenant 匹配、Connection 为 `legacy_private`。
- `connection_id === undefined` 被视为新结构孤儿，不被当作旧记录。
- 新建 SQL 只读 Binding 只持久化 `connection_id` 和业务语义 config，不复制 Connection 凭据。
- Pipeline 缺省及跨插件调用使用 `runAs: service`；只有认证 HTTP 入口显式使用 user delegation，请求字段不能伪造 runAs。

### 3.4 Sealed snapshot：专用、短命、最窄的 secret capability

普通 Adapter 路径不能拿到 Connection secret，但 sealed SQL Server snapshot 需要把连接参数交给受保护的 capture runtime。为此新增了独立 capability，而不是把凭据塞回 Binding：

- capability 只注入 `plugin-integration-core`，其他插件不可见。
- 强制 `runAs: user`、存在 principal、owner/tenant exact match、SQL Server、read-only。
- 只在内存返回严格的 `{ connection, credentials }` 投影，不持久化、不日志输出。
- 普通 `getExternalSystemForAdapter` 永远不含该 secret；只有内部 `getExternalSystemForSealedSnapshot` 可调用。
- 不可等价表示的 legacy TLS、未知字段、字符串端口、显式 `instanceName`、`host\instance` 全部 fail closed，避免普通 Adapter 与 sealed runtime 连到不同端点。
- SQL login/password 是 opaque driver input：保留首尾空格和原值，只拒绝空值、超长值和控制字符；端到端测试证明 Resolver 到最终 driver config 不会 trim。

Bridge adapter 没有下沉到 core，core 也没有获得 Bridge/raw SQL 能力。

### 3.5 前端：Binding 选择 canonical Connection

- Integration Workbench 的 SQL 只读系统改用 `connectionId` 选择 core Connection。
- `config` 只保留 schema/table 等 Binding 业务语义。
- 旧 `dataSourceId` 仍可显示迁移期状态，但新建流程不再写它。
- 空连接、legacy、canonical 三种状态均有对应 UI/测试覆盖。

### 3.6 SQL Binding 写权限裁决

`data-source:sql-readonly` Binding 的创建/更新继续使用既有 `integration:write` 门槛，不提升为 `integration:admin`。原因是该写入只保存 Connection 引用和业务语义配置，Connection facade 仍独立执行 owner/tenant/type 校验，调用方既不能读取也不能修改 Connection 凭据。包含私有配置子树的变更仍必须是 `integration:admin`。

SQL Binding 写入仍走 `scopedAuthenticatedWriteInput`：tenant 从认证用户上下文派生，请求体携带不同 tenant 时返回 `403 TENANT_MISMATCH`。专门测试覆盖 writer 成功、read 用户 403、跨 tenant 403 且拒绝请求不进入 registry。

## 4. 验证结果

### 4.1 通过

- Core targeted Vitest：5 files，130 tests passed。
- JWT tenant 污点链负控：tenantless token 下，`x-tenant-id` 只能回填 `req.user.tenantId`，不能产生 `req.authenticatedTenantId`；数据源创建同时伪造 header、body 和回填后的 user tenant 仍返回 `401 AUTHENTICATED_TENANT_REQUIRED`（已纳入上述 130 tests）。
- Core `type-check` passed。
- Core production build passed。
- Frontend `type-check` passed。
- Frontend targeted Vitest：2 files，61 tests passed（Connection section 9，Workbench 52）。
- Frontend production build passed；仅有既存的大 chunk 警告。
- Plugin migration structural test passed。
- Plugin Connection Resolver、external systems、HTTP routes、pipeline runner、overview、runtime smoke、B2A wiring、sealed runtime core/product 共 9 个相关 suite passed。
- Connection Resolver 的 fallback marker、legacy user delegation、canonical registration tenant 和 legacy registration tenant 均有相互隔离的负例；每个断言的 fixture 都满足其他守卫，避免错误码被另一道守卫代偿。
- 内存变异复验：移除 fallback marker、legacy user delegation 或 registration tenant 比对时，测试分别失败；M2/M5/M3 均被杀死。
- Sealed source-authority adapter-projection suite 在内存统一为 LF 后完整通过，证明其 Windows 失败点仅是自变异 needle 的换行假设。
- Test-chain completeness：203 suites 全部纳入 `pnpm test`，0 intentional exclusions。
- Sealed package provenance：运行时计算结果与冻结 JSON 完全一致。
- `git diff --check` 无 whitespace error。
- Terra 最终安全复核结论：可合并，无新增代码阻断。

### 4.2 当前主机上的环境/基线限制

不宣称整个仓库 `pnpm test` 全绿，已明确观察到以下与本 PR 代码无关的限制：

1. `sealed-export-package-provenance.test.cjs` 的 Node 侧哈希校验已通过，但最后的 shell mutation verifier 调用 Windows `bash.exe` 时失败；当前 WSL 未安装 Linux distribution。
2. 未修改的 `sealed-export-s6a-source-authority-adapter-projection.test.cjs` 用 LF 固定 needle 自读测试文件，在 Windows CRLF checkout 上无法插入自变异语句；production live pins 在失败前已经通过，且同一 suite 经只读、内存 LF 归一后完整通过。建议后续把 needle 改成 CRLF/LF 无关匹配。
3. 早先全链运行还会在既存 `sealed-export-s3-private-ingestion-migration.test.cjs` 对 `vitest.config` exclusion 的断言处停止；该文件和配置不在本 PR 修改范围。

这些限制应在 Linux CI 或配置好 WSL 的 Windows runner 上复验，但不应通过修改 parked/sealed 基线逻辑来掩盖。

## 5. 未包含内容与止损线

以下内容留给后续独立 PR：

- PR-2：workspace membership 共享、`use/manage` 权限、raw `/query` 继续 owner/manage-only、删除事务原子性。
- PR-2：legacy Binding 修改 `config.dataSourceId` 时必须同时提供 `connectionId` 并转 canonical；不得原地改指针继续留在 fallback 状态。
- PR-2：tenant 回填只接受 JWT 专属可信 claim、服务身份或权威 membership；不能使用 Binding 自带 tenant、请求体、`x-tenant-id` 或被兼容 header 回填的 `req.user.tenantId` 作为证据。
- PR-3：plugin 内的 direct/bridge transport Resolver；Bridge adapter 不下沉 core。
- HTTP/K3/PLM credential document 迁移。
- connector catalog、n8n 风格编排 UI、iPaaS 映射/监控能力。
- 任何真实客户 PLM/K3 数据访问、任何外部写、任何部署。

PR-1 review/合并后应先回到备料业务验收；没有真实客户需求时不自动展开 PR-2/PR-3。

## 6. Review 与回滚提示

建议 review 顺序：

1. migration 与 owner-attributed backfill；
2. core tenant/scope 和 values-free facade；
3. plugin Resolver 的 canonical/legacy 状态机；
4. sealed secret capability；
5. HTTP/Pipeline runAs；
6. UI 与回归测试。

### 6.1 迁移前 values-free 盘点

迁移只会给具有 owner attribution 的旧 SQL Binding 打 fallback 标记。P2-A 之前创建、没有 `config.dataSourceOwnerId` 的记录会保持 `connection_id = NULL + legacy_connection_fallback_eligible = FALSE`，上线后按设计返回 `CONNECTION_LEGACY_FALLBACK_DENIED`。这是一项有意的 fail-closed 行为变化，不能把它描述成无中断迁移。

生产 migration 前必须在目标库运行以下只读盘点。输出用序号代替 tenant ID，可写入私有部署记录；PR/issue 只记录四类总数，不附 Connection、Binding、tenant 或 endpoint 值。

```sql
WITH per_tenant AS (
  SELECT
    ies.tenant_id,
    COUNT(*) AS sql_binding_rows,
    COUNT(*) FILTER (
      WHERE NULLIF(BTRIM(ies.config ->> 'dataSourceId'), '') IS NOT NULL
    ) AS legacy_pointer_rows,
    COUNT(*) FILTER (
      WHERE ds.id IS NOT NULL
        AND NULLIF(BTRIM(ies.config ->> 'dataSourceOwnerId'), '') = ds.owner_id
    ) AS owner_attributed_rows,
    COUNT(*) FILTER (
      WHERE NULLIF(BTRIM(ies.config ->> 'dataSourceId'), '') IS NOT NULL
        AND (
          ds.id IS NOT NULL
          AND NULLIF(BTRIM(ies.config ->> 'dataSourceOwnerId'), '') = ds.owner_id
        ) IS NOT TRUE
    ) AS denied_after_cutover_rows
  FROM integration_external_systems AS ies
  LEFT JOIN data_sources AS ds
    ON ds.id = NULLIF(BTRIM(ies.config ->> 'dataSourceId'), '')
  WHERE ies.kind = 'data-source:sql-readonly'
  GROUP BY ies.tenant_id
)
SELECT
  ROW_NUMBER() OVER (ORDER BY tenant_id NULLS FIRST) AS tenant_bucket,
  sql_binding_rows,
  legacy_pointer_rows,
  owner_attributed_rows,
  denied_after_cutover_rows
FROM per_tenant
ORDER BY tenant_bucket;
```

本 PR 未获准读取生产客户数据，因此没有伪造盘点数字。部署记录必须在上线前补齐：tenant bucket 数、SQL Binding 总数、owner-attributed 数、cutover 后拒绝数；最后一项非零时，先由 owner 决定 reconciliation、重建 canonical Binding 或接受中断。

### 6.2 Sealed snapshot 切换检查

密封备料的 `systemContentKey` 会对 `{ connectorKind, endpoint, principal }` 做 HMAC。PR-1 后 endpoint/login 来自所引用的 `data_sources` 严格投影，而不是 Binding 内嵌的 `sealedSnapshotSqlServer`。只要 server、port、database、TLS 缺省或 login 任一语义不同，既有 authority anchor 就会拒绝运行，必须重新审批/绑定。

部署前逐个核对现网密封 Binding 所引用 Connection 的 endpoint/login 与原内嵌配置语义一致；命名实例、字符串端口、`host\\instance`、不可等价的 legacy TLS 形态会在投影层直接 fail closed，不能自动迁移。该核对只在受控环境完成，不把值写入 PR、日志或证据报告。

### 6.3 部署与回滚顺序

部署顺序是硬约束：**先执行 migration 并验证新列/约束，再发布 PR-1 runtime，最后做只读 smoke test**。若新代码先于 migration 上线，新建 Connection 会因缺少 `tenant_id/scope_kind` 列而失败；删除引用检查会因缺少 `connection_id` 返回数据库错误。两者虽 fail closed，但会造成管理功能不可用。

运行 migration 前应备份 `data_sources` 与 `integration_external_systems`。若需回滚，先回退依赖 `connection_id` 的 runtime，再执行 migration `down`；直接删列会使新建 SQL Binding 失去唯一 Connection 引用。生产执行仍属于 owner 先批后动事项。

## 7. 当前交接状态

- 改动在独立 worktree 完成，主检出未被修改。
- 人工对抗 review 结论为生产代码无阻断项；F1–F5 已在本 PR 收口，F6/F7 已固化为 PR-2 待办。
- 没有读取真实客户数据，也没有触发外部系统写。
- 合并后停止扩展平台范围，回到备料业务验收；任何生产 migration/部署仍需 owner 单独批准。
