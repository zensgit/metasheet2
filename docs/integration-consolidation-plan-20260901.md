# 集成层收敛方案：外接数据源 / 数据工厂 / Bridge Agent（2026-09-01）

> **勘误与状态（2026-09-01 晚）**：实施以 `integration-consolidation-minimal-plan-20260901.md` 为基准，本文降级为背景调研报告。两处结论已被证伪：
> ① "平台无定时/入站触发器"不准确——multitable Automation 已有 `schedule.cron/interval/date_field`、`webhook.received`（HMAC + 重放窗口，`automation-triggers.ts:6-31`、`routes/automation.ts:236-253`），真实缺口是 Data Factory pipeline 未绑定 Automation；因此"接活 integration_schedules"方向作废，应复用 Automation + IntegrationRunPort。
> ② 062-065 治理表物理合并改为只抽共享代码（唯一键与安全不变量不同）。

> 结论先行：三者**定位不重复，实现重复严重**。处理原则是"不拆、不废、减负、转正"——
> 连接与凭据收敛到 `/data-sources` 唯一注册表；数据工厂剥离连接职责后转正为**契约治理 + 运行编排工作台**；
> Bridge Agent 降级为统一连接层的一种 transport。对照 n8n / 飞书 aPaaS / 数环通 iPaaS，
> 我们缺的不是连接能力，是**触发器（定时 + 入站 webhook）**。

- 调研范围：全仓（排除 `.claude/worktrees`、`output/releases`、`dist`），93 处调用点核对。
- 参照系：飞书 aPaaS《第三方集成使用指南》《各类集成凭证的配置说明》、n8n（credentials 与 nodes 分离）、数环通 iPaaS（连接器 + 触发器 + 执行动作）。

---

## 1. 三个功能现状

| | 外接数据源 | 数据工厂·读取源 | Bridge Agent |
|---|---|---|---|
| 位置 | core-backend + `/data-sources` | plugin-integration-core + `/integrations/workbench` | 客户机 PowerShell 进程 + 工作台"观测"区 |
| 本质 | 连接注册表 + 只读查询代理（实时透传） | 第三方 API 的只读读取契约（探测→内容寻址版本→审批→运行） | 客户内网 localhost-only 只读 SQL Server 网关 |
| 源类型 | postgres / mysql / sqlserver / http / plm（注册表 `DataSourceManager.ts:54`） | HTTP/REST 为主，经 systemId 可挂任意 kind | 仅 SQL Server（.NET SqlClient） |
| 数据流 | 拉、读为主；写路径可被 C6 闸门整体关闭 | 拉、纯只读；配置内禁止内联凭据 | 拉、纯只读；`upsert` 直接不支持 |
| 触发 | 手动/按请求 | 手动 | Agent 计划任务常驻；平台侧手动 |
| 落地 | 透传，硬顶 10000 行（`BaseAdapter.ts:89`） | 透传；落表走 pipeline `metasheet:multitable` | 透传；默认 20 / 硬顶 500，强校验 agent 回显 limit |
| 凭据 | AES-256-GCM 落库（`security/encrypted-secrets.ts`），响应永不回显 | 引用 `integration_external_systems.credentials_encrypted`（`credential-store.cjs`） | 共享密钥 `X-MetaSheet-Bridge-Secret` 或本机环境变量 |
| UI | `/data-sources`（`appRoutes.ts:174`） | `/integrations/workbench` 左栏（`IntegrationWorkbenchView.vue:658`） | 工作台第 7 组导航（`IntegrationWorkbenchView.vue:665`） |

关键代码锚点：

- 外接数据源：`packages/core-backend/src/routes/data-sources.ts`（15 个端点，RBAC `data_sources` + owner 隔离）；`data-adapters/DataSourceManager.ts`
- 读取源：`plugins/plugin-integration-core/lib/read-source-config.cjs`（4 种读模式 L26、SSRF 闸门 L98、拒写形状键 L58）；存储 062/063 迁移
- Bridge Agent：`scripts/ops/bridge-agent-readonly.ps1`（契约头 L1-21：白名单对象、永不接受原始 SQL）；平台适配器 `lib/adapters/bridge-agent-readonly-adapter.cjs`（强制 localhost L120、拒 SQL 选项 L258）；清单表 065 迁移（无 host / 无凭据 / 无 apply 列——平台无写通道硬锁）

三者是三个正交关注点各自长出的整套栈：

- 外接数据源 = **连接与凭据**（怎么连上、密码放哪）
- 数据工厂 = **契约与治理**（读什么、什么形状、谁批的）
- Bridge Agent = **网络通道**（内网数据库连不上怎么办）

## 2. 重复证据（8 项）

1. **两套连接注册表**：`data_sources`（type 闭集）vs `integration_external_systems`（057 迁移，kind 自由字符串无词表）。同一 SQL Server 可能存两行、被两套加密各加密一次。
2. **两套凭据加密**：core `encrypted-secrets.ts`（`ENCRYPTION_KEY` + PBKDF2 + 16B IV，`enc:` 前缀）vs 插件 `credential-store.cjs`（`INTEGRATION_ENCRYPTION_KEY` + 12B IV，`v1:` 格式，兼容 `enc:`）。
3. **3-4 处 SQL Server 连接池**：`MSSQLAdapter.ts:219`、`k3-wise-sqlserver-executor.cjs:197`、`gip-sqlserver-snapshot-page-sequence-executor.cjs:372`、Bridge Agent 进程内 `SqlConnectionStringBuilder`（ps1 L330）。
4. **4 套字段映射模型**：`integration_field_mappings`（057 L83）、读取源 `fieldMap`、前端 `EditableMapping`、备料 `ext_` 映射；transform 函数集前端与 SQL 注释各硬编码一次。
5. **3 套同步调度表，本次扫描均无消费者**：040 `data_sync_jobs`、044 `external_tables`（`DataMaterializationService.ts` 1324 行全仓零 import）、057 `integration_schedules`（pipeline `VALID_TRIGGERS` 含 `'cron'` 但无写入方）。三个功能今天全是纯手动触发。
6. **两套 HTTP 出站适配器**：`HTTPAdapter.ts`（753 行，axios）vs `http-adapter.cjs`（525 行，fetch + 出站写闸门），错误分类/脱敏/写闸门互不共享。
7. **三套 schema/objects 发现**：`/api/data-sources/:id/schema`、`/api/integration/external-systems/:id/schema`、Agent 自身 `GET /schema/<object>`。
8. **四套同构治理存储**：062/063/064/065 四个迁移同为"内容寻址 + draft/approved/retired + values-free 审计"；`bridge-agent-change-checklist-store.cjs:6` 自述 "Mirrors read-source-config-store.cjs's pattern"。

已存在的正确复用（收敛路径的种子）：

- 宿主 facade 注入：`packages/core-backend/src/index.ts:2228` 仅向 plugin-integration-core 注入 `dataSources` 只读面（test/schema/tableInfo/select）与 `dataSourceWrites` 写面 → 插件 kind `data-source:sql-readonly` / `sql-write-gated`。
- UI 已落实引用制：`IntegrationConnectionSection.vue:189`"凭据由 /data-sources 管理，这里只引用 dataSourceId，不复制账号密码"。

## 3. 目标架构（对照飞书 aPaaS 模式）

飞书的分工：「第三方集成」集中管理连接配置（凭证 + 连通性测试 + 引用追踪 + 审计），
外部对象 / 流程 / Webhook 只**引用**。映射到我们：

```
连接层（唯一）  data_sources ＝ 连接 + 凭据 + 测试 + 引用追踪 + 审计
                Bridge Agent 为其中一种 transport（type: sqlserver, transport: bridge）
                     │ 只被引用，凭据永不复制
契约层（唯一）  数据工厂：读取源 / 组合 / 写目标
                通用 versioned-config store（收敛 062/063/064/065）
                     │
消费层          pipeline 落表 / 备料 / 多维表 / （未来）流程触发
```

用户心智模型：**管连接去外接数据源，管对接去数据工厂。**

## 4. 数据工厂处理方案

数据工厂七块板块逐一判决：

| 板块 | 性质 | 判决 |
|---|---|---|
| 连接（external systems + 凭据） | 与 `/data-sources` 结构性重复 | **剥离** |
| 读取源 / 组合 | 契约治理核心，全仓独一份 | **保留（产品差异化本体）** |
| 写目标 | K3 写围栏落点 | **保留，不动** |
| pipeline | 唯一"外部数据→多维表落表"通道，仅手动 | **保留 + 补活触发器** |
| Bridge Agent 观测 | 纯观测 + 机读清单（无写通道硬锁） | **保留** |
| 模板目录 | 场景预设雏形 | **保留，升级为"配置即接入"目录** |

### 动作一：剥离连接职责（最优先）

端态：数据工厂不再新建/编辑连接与凭据；「连接」区变为**引用选择器 + 场景语义**
（一个 external system ＝ 引用哪个 data_source（或 Bridge）＋ 业务场景标签）。

分两批迁移：

- 批 1（facade 通道现成）：直连 SQL 类 kind `data-source:sql-readonly` / `sql-write-gated`。
- 批 2：HTTP 类 kind（`http` / `erp:k3-wise-webapi` / `plm:yuantus-wrapper`）——凭据从
  `credentials_encrypted` 迁到 data_sources http type 下，加密统一到 core `encrypted-secrets`
  （插件侧已兼容 `enc:` 格式，改动面可控）。
- Bridge Agent 注册进 `DEFAULT_ADAPTER_REGISTRY`；网络反转、白名单、limit 回显校验等独特价值保留，
  schema 发现 / 连接管理走统一层；观测 UI 留在数据工厂。

**前置坑——权限模型不对齐（P1 第一个工作项）**：
`/data-sources` 是 `owner_id` 个人隔离 + 仅 requiresAuth；数据工厂是 `tenant_id`（NOT NULL）+
`integration:write`。收敛前 data_sources 需补 tenant/workspace 共享模型（如 owner 私有 → workspace
共享两态），否则顾问 A 建的连接顾问 B 引用不到。这是全方案最实质的工程量。

### 动作二：治理存储合并（低风险、纯内部质量，可穿插）

062/063/064/065 收敛为一个通用 versioned-config store（`config_type` 判别列），
读取源 / 组合 / 写目标 / Bridge 清单皆为实例。不改对外行为。

### 动作三：补触发器，数据工厂转正为流程层

1. **定时**：`integration_schedules` 表已建、`VALID_TRIGGERS` 已含 `'cron'`，缺的只是调度器写入方
   ——照 multitable `automation-scheduler` 模式接一条；UI 在 pipeline 区加"定时运行"。
2. **入站 webhook**：参照飞书 Webhook 连接配置形态（自动生成 token、IP 白名单、HMAC 签名），
   外部系统 POST 触发指定 pipeline，打通"K3 出单 → 自动同步进多维表"闭环。
3. **清死代码**：删 040/044 僵尸表 + `DataMaterializationService.ts`；057 `integration_schedules`
   接活（或删）。避免下一个人在死表上接调度。

## 5. iPaaS 能力对照（n8n / 飞书 / 数环通）

| iPaaS 能力 | 现状 |
|---|---|
| 凭证与消费方分离 | 部分有（facade 线），P1 后完整 |
| 连接器抽象 | 有（adapterRegistry / kind），目录小且分裂 |
| 出站动作 | 有但刻意锁死——安全裁决非缺陷；写动作走审批门 |
| 对外开放 API + 事件推送 | 有雏形（多维表 `mst_` token + webhook 出站 + HMAC） |
| 入站触发器 | **无** |
| 定时触发器 | **无活的**（活着的 cron 仅 multitable automation-scheduler 与 BPMN 引擎） |
| 可视化编排 | 半个：BPMN 引擎存在，pipeline 是线性手动配置，均未与集成层打通 |
| 连接器目录规模 | 5 种注册 vs 数环通近百——但定位不同：制造业要 K3/PLM/MES 深连接器 + 场景预设，不要 SaaS 长尾 |

差距结论：**架构上差的不是连接能力，是触发器。** 编排层未来评估让 BPMN 引擎调用统一连接层，
不引入第三套流程模型。

## 6. 红线（整合中不许动）

1. **K3 写围栏**：只读账号是可证明保证，应用层解析 SQL 拦不住写（六轮实证，裁决 2026-09-01）。
   整合后的写能力仍按目标系统逐个走账号层 + 审批门；三套只读闸门语义（C6 gate /
   `WRITE_SHAPED_KEYS` / adapter 拒绝）**不得合并成一个开关**。
2. **Bridge Agent 平台无写通道**：065 迁移头部与 `bridgeAgentConfigCheck.ts` 双重声明的硬锁原样保留；
   连接层收敛不为其开任何新口子。

## 7. 实施顺序

```
P1  权限模型对齐（data_sources 补 workspace 共享）
 →  直连 SQL 类连接迁移（facade 通道）
 →  死代码清理（040/044/DataMaterializationService）
P2  定时触发接活（scheduler → pipeline triggeredBy:'cron'）
 →  HTTP 类连接迁移（凭据统一加密）
P3  入站 webhook 触发
 →  场景预设目录（配置即接入）
穿插 治理 store 合并（062-065 同构收敛）
```

---

*调研与方案：2026-09-01。行号为当日快照，后续以代码为准。*
