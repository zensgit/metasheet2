# 首个集成增量：候选场景短名单（2026-09-14）

> **证据冻结点**：本文所有 `file:line` 均指 `origin/main` 提交 `ce9da32ae69f12db082b6d3164b0634486e91172`，
> 每一条都在该快照上实读过，不引用记忆或其它 sha。
> 审阅报告 `artifacts/reviews/roadmap-20260914/review.md`（**未入库，在工作检出里**）的链接钉在
> `c13e40769…` 上，行号与本文不通用。
>
> **路径简写约定**：每个文件在文内首次出现时给相对仓库根的完整路径，之后用文件名简写。
> 简写只可能落在三个目录：`packages/core-backend/src/**`、`plugins/plugin-integration-core/lib/**`、
> `plugins/plugin-integration-core/lib/adapters/**`；全文无同名文件冲突。
>
> **本文是什么**：给产品负责人挑「一个」真实场景做小增量验证用的对照表。
> **本文不是什么**：不是立项、不是排期、不是产品化人月承诺。没有任何场景被批准实施。
> 已有资产按 file:line 说清；「能用 / 薄 / 桩」三档如实标注，占位不算能力。

---

## 0. 三个场景共用的前置

这三条与选哪个场景无关，先挑出来避免在每节重复。

1. **`mst_` API token 到不了 `/api/integration/**`。**
   全局会话门只为两类请求放行非 JWT bearer：`packages/core-backend/src/index.ts:1701`
   调 `isOapiAllowlistRequest`，而 allowlist 的读写两张表只覆盖 `/api/multitable/**` 与 `/api/comments`
   （`packages/core-backend/src/multitable/oapi-read-allowlist.ts:29-48` 读、`:79-91` 写）。
   任何 `/api/integration/...` 路由对 `mst_` bearer 落进 `jwtAuthMiddleware` → 401
   （`packages/core-backend/src/index.ts:1705`）。
   **含义**：外部编排器要触发插件侧的拉取/pipeline，只能持会话 JWT；这是运维动作，
   或者要新开一个受控触发入口（= 新授权边界，正是审阅 R6 要求单独提交的那类）。

2. **`mst_` token 不携带租户。** token 记录本身无 tenant 字段
   （`packages/core-backend/src/multitable/api-tokens.ts:6-21`；
   `packages/core-backend/src/multitable/api-token-service.ts` grep `tenant` 零命中），
   `apiTokenAuth` 也只挂 scopes / createdBy / tokenId / baseIds / sheetIds
   （`packages/core-backend/src/middleware/api-token-auth.ts:71-83`）；租户隐含为创建者的租户。可用的收敛手段是 per-base/sheet 白名单
   （`packages/core-backend/src/middleware/oapi-scope-guard.ts:1-19`，目标 sheet 服务端解析、
   记录寻址路由以记录自己的 sheet 为准、越界与不存在返回同一个 403 不构成探测预言机）。

3. **插件侧租户解析对「无租户的平台管理员」是可从请求指定的。**
   `plugins/plugin-integration-core/lib/http-routes.cjs:1028-1052`：租户绑定主体被锁在自己租户，
   只有 tenantless 平台管理员保留跨租户读能力；值面读另有更严的
   `stock-preparation-operator-scope.cjs:1-55`（要求租户被证明，tenantless 直接 403）。
   选场景时要意识到：演示账号用哪一种主体，会改变能看到什么。

4. **凭据形态统一**：`plugins/plugin-integration-core/lib/credential-store.cjs:1-23`，
   新写走宿主 `enc:`，旧 `v1:` 仍可读；生产缺 `INTEGRATION_ENCRYPTION_KEY` 时启动拒绝。
   三个场景都不需要新的凭据机制。

---

## 场景 A · K3 WISE 物料主数据只读拉取 → MetaSheet 内部物料缓存

### A.1 业务动作一句话
备料线的实施/管理员（`integration:admin` 档）在开工前把客户 K3 WISE 的物料主数据
（编码/名称/规格/单位）拉进 MetaSheet 内部物料缓存，供后续备料生成时做物料匹配；频率按批次，日级。

### A.2 现有连接器路径
| 项 | 证据 | 档 |
|---|---|---|
| kind 注册 | `plugins/plugin-integration-core/index.cjs:361`（`erp:k3-wise-webapi`） | 能用 |
| 读形状（冻结预设） | `lib/read-smoke.cjs:35-71`：`k3wise.material-list.v1`，`/K3API/Material/GetList`，五列投影 `FItemID/FNumber/FName/FModel/FUnitID`，`Top=10`、`PageIndex=1`、`maxListLimit:10` | 能用，但 10 行/页是硬上限 |
| 已批准读配置模板 | `lib/read-source-k3-material-list-b4-contract.cjs:1-55`（B4 双层冻结：代码层模板 + 运行时 mint）；mint 机构是真的（`lib/read-source-config-store.cjs:101` `contentKeyFor`、`:232` 落库时算 contentKey） | 模板本身是桩（PURE / LATENT，自称 executes nothing）；承载它的 store 能用 |
| 凭据来源 | `lib/credential-store.cjs:1-23` | 能用 |
| 只读门（永久拒写） | `lib/k3-external-write-permanent-fence.cjs:1-70`（E4/§10.1：无 env、无 owner policy、无审批可解锁；固定码 `K3_WISE_EXTERNAL_WRITE_DISABLED`）；落点 `adapters/k3-wise-webapi-adapter.cjs:2445`（WebAPI upsert，login 之前）、`adapters/k3-wise-sqlserver-channel.cjs:192-238`（含把注入 executor 的 `insertMany` 包起来拒绝）、`external-write-dry-run.cjs:16`、`pipeline-runner.cjs:468`（sqlserver kind）。**注意**：普通 pipeline run 打 `erp:k3-wise-webapi` target 时先撞另一道门 `pipeline-runner.cjs:446-449`，码是 `K3_WISE_PIPELINE_RUN_DISABLED`（指向 C6 dry-run→apply 生命周期），永久码在更深层 | 能用，且是本仓最硬的一条 |
| 分页真相 | `lib/stock-preparation-readonly-source-run.cjs:71-74`：`pagination:'page_index'`，页宽 `K3_WEBAPI_SOURCE_PAGE_SIZE`；`:23` 该常量 = 10；`:24` `SOURCE_MAX_PAGES=10`；适配器 `k3-wise-webapi-adapter.cjs:191` `DEFAULT_MATERIAL_LIST_MAX_LIMIT=10`（超限 THROW，不静默截断） | 薄：单次 run 上限约 100 行 |

### A.3 MetaSheet 受控操作
- 走**插件路由**，不走 pipeline，也不走 automation。
  `POST /api/integration/stock-preparation/mvp/source-runs/erp-materials`
  （注册 `lib/http-routes.cjs:130`，handler `:7160`），门 `requireAccess(req,'admin')` `:7161`。
- **默认只读**；写侧由 env `MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED` 打开
  （`:1290-1295`，只认字面量 `'true'`）。打开后：
  租户改由 `resolveAuthUserTenantId(req)` 从认证主体推导（`:7176`），
  且任何载体上的 `tenantId`/`projectId` 在任何 I/O 之前 400 拒绝（`:1321-1336`）。
- 落点：`persistStockPreparationErpMaterialSync`（`:7201`），
  目标项目 = `${tenantId}:integration-core`（`:1285-1288`，由 `:7200` 调用），永不取自请求。
- 独立 commit 路由 `POST .../mvp/erp-materials/sync`（`:135` / handler `:7230`）。
- **runAs**：这条路径没有 runAs 概念（runAs 只在 canonical connection 解析上，
  `lib/external-systems.cjs:547`：注册/通信调用方默认 `service`，只有认证过的 HTTP 面才显式盖 `user`）。
- **审计**：这条路径**不入** stock-prep 审计账本 —— `:7224-7229` 明说它属系统缓存刷新，
  与 `/mvp/sync/persist` 同类，审计留给人工 confirm/generation/resolve 家族
  （账本自身边界见 `lib/stock-preparation-audit-store.cjs:1-26`）。

### A.4 可选外部 n8n 调用面
n8n 能打的命名端点：触发用 `POST /api/integration/stock-preparation/mvp/source-runs/erp-materials`（需 JWT，见共用前置 1）；
读结果用 `GET /api/multitable/records`（`mst_` + `records:read` 可达，
`oapi-read-allowlist.ts:32`，路由 `routes/univer-meta.ts:17180`）。

| R6 项 | 现状 | 证据 |
|---|---|---|
| 身份/租户传递 | **部分** | token 无 tenant 字段（`api-token-auth.ts:71-83`）；插件侧 ON 时租户强制来自认证主体（`http-routes.cjs:7176`） |
| 幂等键 | **无** | `mst_` 写面无 Idempotency-Key（在 `routes/univer-meta.ts` / `middleware/api-token-auth.ts` / `multitable/oapi-write-audit.ts` grep `idempotenc` 只命中 U4-L5 的实体 id 占用检查，`univer-meta.ts:9921`、`:9947`，与请求幂等无关）；本路由自身也无 |
| 结果查询 | **部分** | 同步返回 200/201 + values-free evidence（`http-routes.cjs:7214-7219`）；无按 runId 的查询端点 |
| 取消 | **无** | `pipeline-runner.cjs` / `run-log.cjs` / `stock-preparation-readonly-source-run.cjs` grep `cancel|abortSignal|AbortController` 未见 |
| 重试责任 | **部分** | 服务端无自动重试；重放责任在调用方。落库是按冻结模板 key 的 upsert（`http-routes.cjs:7230-7236` 注释），重复副作用收敛但无显式幂等凭证 |

### A.5 合成数据验证所需
- **数据集**：50–100 条假物料，覆盖 3 种单位、2 条重码、1 条缺 `FItemID`（缺内部 id 是 intake 的硬错，
  `lib/stock-preparation-readonly-intake.cjs:33-38` `MISSING_MATERIAL_INTERNAL_ID`，落点 `:267`）。
- **环境**：PG（MetaSheet 主库）+ 一个按 `/K3API/Material/GetList` 形状应答的假 HTTP 服务。不需要真 K3。
- **验收断言（先红后绿）**：
  1. flag OFF 跑一次 → 响应 `mode:'dry_run'`、`internalWriteExecuted:false`，缓存表零行。
     （变异：把 `lib/http-routes.cjs:7192` 的 OFF 分支去掉 → 该断言必须红。）
  2. flag ON + 请求带 `tenantId` → 400 `STOCK_PREPARATION_ERP_AUTOPERSIST_STEERING_NOT_ALLOWED`。
     （变异：删 `lib/http-routes.cjs:7170` 的 `assertStockPreparationErpAutoPersistNoSteering` → 必须红。）
  3. flag ON 正常跑 → 201，行落在本租户 staging；换另一租户 admin 跑，互不可见。
  4. 把某 pipeline 的 target 指到 `erp:k3-wise-webapi` 并 run → `K3_WISE_PIPELINE_RUN_DISABLED`
     （`pipeline-runner.cjs:446-449`）；直接调该适配器 `upsert` → `K3_WISE_EXTERNAL_WRITE_DISABLED`
     （`adapters/k3-wise-webapi-adapter.cjs:2445`）。两条都要求假 K3 侧 login 调用计数 = 0。
     已有测试 `plugins/plugin-integration-core/__tests__/k3-external-write-permanent-fence.test.cjs`。
  5. 假 K3 返回 11 行 → 适配器 THROW（`k3-wise-webapi-adapter.cjs:1090` 的 maxLimit 判定），不得静默截断。

### A.6 缺口清单（按文件粒度）
- 新增假 K3 WebAPI 夹具（`scripts/dev/` 或 `plugins/plugin-integration-core/__tests__/fixtures/`）。
- 若要求超过 ~100 行吞吐：必须改 `lib/read-smoke.cjs` 的冻结预设与 `adapters/k3-wise-webapi-adapter.cjs:191` 的上限
  —— 这是动安全边界的代码改动，不是配置项。
- 若增量要求审计：`lib/stock-preparation-audit-store.cjs` 需新增 action 词条（当前是闭集，未知 action 拒绝）。
- 若要 n8n 直接触发：需要一个受控触发入口 + 其授权边界（新代码、新 ADR）。

### A.7 红线核对
K3 拒写：不动，本场景纯读，四层围栏原样保留 ✔；Bridge 无 raw SQL：不涉及 ✔；
执行循环分离：本路径既不经 PipelineRunner 也不经 AutomationExecutor，无合并动机 ✔；
单插件 facade 不扩注入：全部在 `plugin-integration-core` 内，不新增能力注入 ✔。

### A.8 粗估
3–6 人日量级（**未冻结范围的占位**）。不含 n8n 侧、不含吞吐上限改造。

---

## 场景 B · PLM(yuantus) BOM 拉取 → 备料 MVP staging

### B.1 业务动作一句话
项目经理/实施在新建项目时，把该项目在 PLM 的 BOM 树拉进备料 staging 快照，作为备料行生成的输入；
每个项目 1 次，工程变更时重拉。

### B.2 现有连接器路径
| 项 | 证据 | 档 |
|---|---|---|
| kind 注册 | `plugins/plugin-integration-core/index.cjs:360`（`plm:yuantus-wrapper`） | 能用 |
| 实现性质 | `lib/adapters/plm-yuantus-wrapper.cjs:1-10` 自述为「对宿主 PLM 能力的 source-side facade」，不删也不引入 kernel PLMAdapter | 能用（但是门面，不是独立实现） |
| 固定 schema | 同文件 `:23-46`（material 9 列 / bom 10 列） | 能用 |
| 分页真相 | `lib/stock-preparation-readonly-source-run.cjs:55-58`：`pagination:'cursor'`、`limitContract:'honours_request'`、页宽 `SOURCE_PAGE_SIZE`（`:17` = 1000）×`SOURCE_MAX_PAGES`（`:24` = 10） | 能用，吞吐够真实 BOM |
| 同槽位可替代源 | `:77-81` `PLM_SOURCE_KINDS` 含 `data-source:sql-readonly` 与 `bridge:legacy-sql-readonly` | 能用 —— 开发期可用本机 PG 假 BOM 表替掉 mock PLM 服务 |
| 凭据 | 同共用前置 4 | 能用 |

### B.3 MetaSheet 受控操作
- 路由 `POST /api/integration/stock-preparation/mvp/source-runs/plm-bom`
  （注册 `lib/http-routes.cjs:129`，handler `:7077`），门 `requireAccess(req,'admin')` `:7078`。
- flag `MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED`（`:1337-1343`，与 ERP 的是**两个独立开关**）。
  ON 时：租户来自认证主体（`:7091`）；拒绝任何载体的 `tenantId` 与 query/params 的 `projectId`，
  但**允许 body 的 `projectId`**（它是写在行上的业务键，不是物理目标选择器，`:1384-1396`）。
- ON 时额外一道结构守卫 `assertPlmAutoPersistSourceConfigSafe(sourceRuntime.config)`（`:7104`）：
  在任何适配器创建/读取/持久化之前，拒绝把某列映射到内部 `missingChildBom` 标记的同时又映射显式 lineStatus 的配置。
- 落点：`buildPlmSourcePersistInput`（`:7127`）→ `persistStockPreparationSyncRun`（`:7137`），
  `targetProjectId = ${tenantId}:integration-core`（`:7126`）、`lockTenantId = tenantId`。
- 后续人工面（差异浏览、映射确认、生成、异常处理）各有自己的路由与审计
  （`lib/http-routes.cjs:141`、`:155`、`:169`、`:170` 等），**本条拉取不入审计账本**（同 A.3）。
- 值面读由 `lib/stock-preparation-operator-scope.cjs:1-55` 把门：tenantless 平台管理员 403。

### B.4 可选外部 n8n 调用面
端点与 A 相同量级：触发 `POST .../mvp/source-runs/plm-bom`（需 JWT）；
读 `GET /api/multitable/records`（`mst_` 可达）。R6 五项与 A 逐项相同
（身份/租户**部分**、幂等键**无**、结果查询**部分**、取消**无**、重试**部分**），
差别只在一点：BOM 结果属**值承载**读，`operator-scope` 要求租户被证明，
所以 n8n 若用平台管理员身份会被 403 —— 这是保护而不是缺陷。

### B.5 合成数据验证所需
- **数据集**：一棵 200–2500 行假 BOM（3 层），含 1 条缺子件、1 条数量为 0、1 条重复行。
- **环境**：PG + 二选一 —— 假 PLM HTTP 服务，或（更省）在本机 PG 建假 BOM 表并以
  `data-source:sql-readonly` 接入（同一条受控操作，见 B.2 最后一行）。
- **验收断言（先红后绿）**：
  1. flag OFF → 响应逐字节等于今天的只读投影，无 `autoPersist` 字段（`:7118-7121`）。
  2. flag ON + 任意载体 `tenantId` → 400 专用转向码（`:1396`）。
  3. flag ON + 构造一个「同时映射 lineStatus 与 missingChildBom」的已批准配置 → 在任何 I/O 前被拒。
     （变异：删 `lib/http-routes.cjs:7104` 这一行 → 该断言必须红。）
  4. flag ON 正常跑 → 201 + sync-run 记录；跨租户主体读不到对方快照。
  5. 用 tenantless 平台管理员打值面读 → 403 `OPERATOR_SCOPE_TENANT_REQUIRED`。

### B.6 缺口清单
- 假 PLM 夹具或假 BOM 表种子脚本（新文件）。
- 字段映射需按客户 PLM 真实列名配置；客户 PLM 源侧列名语义在字典表里，
  这部分**属未知输入**，不是本仓代码缺口，但会决定增量能否验收。
- 审计缺口同 A.6 第 3 条。
- n8n 直接触发同 A.6 第 4 条。

### B.7 红线核对
K3 拒写：不涉及 ✔；Bridge 无 raw SQL：若走 `data-source:sql-readonly` 变体，由 canonical connection
+ 只读适配器把门，不引入 SQL 文本入口 ✔；执行循环分离：不经两个 runner ✔；facade 不扩注入 ✔。

### B.8 粗估
4–8 人日量级（**未冻结范围的占位**）。

---

## 场景 C · Bridge 只读 SQL Server 旧系统 → 多维表（Data Factory pipeline）

### C.1 业务动作一句话
客户内网一台不许中心直连的旧 SQL Server，由同机 Bridge Agent 按白名单对象只读取数，
pipeline 定期把结果写进一张多维表供业务查看；频率小时级。

### C.2 现有连接器路径
| 项 | 证据 | 档 |
|---|---|---|
| kind 注册 | `plugins/plugin-integration-core/index.cjs:363`（`bridge:legacy-sql-readonly`） | 能用 |
| 永不接受 SQL 文本 | `lib/adapters/bridge-agent-readonly-adapter.cjs:53`（`RAW_SQL_KEYS`）、`:263-265` 抛 `AdapterValidationError` | 能用，硬 |
| 只准 localhost | 同文件 `:49`（`LOCALHOSTS`）、`:133`（baseUrl 必须 localhost）、`:505` `localhostOnly:true` | 能用 |
| 部署约束 | `docs/integration-consolidation-minimal-plan-20260901.md:145`：backend/plugin runtime 必须与 Agent 同一受控 on-prem host 与 network namespace，不得自动退化为远程，须 fail closed | 已写死在方案里 |
| 凭据 | 共享密钥头 `X-MetaSheet-Bridge-Secret`（adapter `:44`） | 能用 |
| 分页真相 | `lib/stock-preparation-readonly-source-run.cjs:67-70`：`pagination:'none'`、`limitContract:'adapter_reported'`、页宽 `BRIDGE_SOURCE_PAGE_SIZE`（`:21` = 500）；Agent 按自己的 `config.maxLimit`（默认 20）**钳制**并在 `metadata.limit` 回显 | 薄：单页即全部，超一页无法证明完整性 |
| 认证过的读能力档案 | `lib/gip-bridge-bounded-read-profile.cjs:1-14`：`bridge.bounded_read.v2`，自述「仍保持 latent、零 runtime 接线」，是被认证的规格不是运行路径 | 桩 |

### C.3 MetaSheet 受控操作
- 走 **Data Factory pipeline**（PipelineRunner），不走 automation、不走 BPMN。
  - 建：`POST /api/integration/pipelines`（`lib/http-routes.cjs:56`）
  - 跑：`POST /api/integration/pipelines/:id/run`（`:58`，handler `:5401`），
    门 `requireAccess(req,'write')` `:5402`；输入打 `triggeredBy:'api'`、`runAs:'user'`（`:5415-5416`）；
    返回 **202 但 `runPipeline` 是 await 的**（`:5432`）—— 同步执行、202 状态码，没有异步作业句柄。
  - 租户来自 `scopedInput` → `resolveTenantId`（`:1252-1258` / `:1028-1052`），
    即 tenantless 平台管理员可从请求指定租户（与 A/B 的 autopersist 路径不同，那两条是强制取自主体）。
- 源读是 kind 泛型的 `context.sourceAdapter.read(...)`（`lib/pipeline-runner.cjs:1025`），
  适配器由 `adapterRegistry.createAdapter(sourceSystem)` 构造（`:518`）。
- 目标写：`lib/adapters/metasheet-multitable-target-adapter.cjs:1-10`
  + 所有权守卫 `lib/adapters/multitable-ownership-guard.cjs:1-45`：
  带 `ownership==='human_preserved'` 或 `preserveOnRefresh===true` 的字段从写入载荷里剥离；
  元数据读失败 = 整单拒（不肯在「可能是受保护表」上盲写）；无 reader 的旧构造只 warn。
- **行级幂等**：`lib/pipeline-runner.cjs:814-851` 把 `_integration_idempotency_key` 写在目标行上
  （`computeRecordIdempotencyKey`，`lib/idempotency.cjs:58`）。三个场景里**只有这一条**有可被外部引用的幂等凭证
  （A/B 的落库是按冻结模板 key 的 upsert，行为上收敛但不产生凭证）。
- run 账本：`GET /api/integration/runs`（`:270` / handler `:9725`），
  只能按 `pipelineId`/`status` 过滤，**无按 runId 单查**。
- 死信与重放：`GET /api/integration/dead-letters`（`:272`）、
  `POST /api/integration/dead-letters/:id/replay`（`:273`）。
- **一处要知道的松处**：`lib/pipelines.cjs:489-490` 只校验外接系统的 **role**，不校验 **kind**；
  `lib/http-routes.cjs:4218-4222` 的 E3-01 注释自己写明了这一点，
  而它那道围栏只在 ARMED B2a 部署下生效。K3 那边由 `pipeline-runner.cjs:446-449`（webapi kind）与
  `:468`（sqlserver kind）加 `k3-external-write-permanent-fence.cjs` 单独兜住，与本场景的 target kind 无关。

### C.4 可选外部 n8n 调用面
这是三个场景里 n8n 面最完整的一个，能打的命名端点：
- **n8n 读值**：`GET /api/multitable/records`（`routes/univer-meta.ts:17180`）、
  `GET /api/multitable/records/:id`（`:17310`）、`GET /api/multitable/fields`（`:12597`）、
  `GET /api/multitable/view`（`:15590`）——均挂 `apiTokenAuth + oapiScopeGuard + requireScope`。
- **n8n 回写**：`POST /records`（`:18125`）、`PATCH /records/:id`（`:16960`）、
  `DELETE /records/:id`（`:18394`）、`POST /patch`（`:19015`）—— 每条都串了
  `oapiWriteAuditBoundary + apiTokenWriteRateLimit + oapiScopeGuard + requireScope`；
  评论创建 `POST /api/comments` 在另一文件且守卫组合不同
  （`packages/core-backend/src/routes/comments.ts:417`：无 `oapiScopeGuard`，改与 `rbacGuard` 复合）。
- **MetaSheet 推给 n8n**：多维表出站 webhook，事件四类
  （`packages/core-backend/src/multitable/webhooks.ts:39-50`），创建 `POST /api/multitable/webhooks`
  （`packages/core-backend/src/routes/api-tokens.ts:320`），自带 `maxRetries/retryBaseDelayMs/retryMaxDelayMs`
  （`webhooks.ts:21-24`）。
- **n8n 触发 automation（现状不通）**：`POST /api/multitable/automation/webhooks/:ruleId`
  （`packages/core-backend/src/routes/automation.ts:255-271`），HMAC 签名头 / 时间戳 / 300s 重放窗 /
  60 次每分钟都齐（`multitable/automation-inbound-webhook.ts:3-10`）；
  但该路径**不在**全局门豁免表（`auth/api-path-policy.ts:114-164` 无此项）、也不在 OAPI allowlist，
  按 `index.ts:1705` 落进 `jwtAuthMiddleware`。即「HMAC 齐备但外部无会话打不通」。
  **这条是静态读出来的，未实跑确认，见文末不确定项。**

| R6 项 | 现状 | 证据 |
|---|---|---|
| 身份/租户传递 | **部分** | token 无租户（`api-token-auth.ts:71-83`），靠 base/sheet 白名单收敛（`oapi-scope-guard.ts:1-19`）；pipeline 侧租户可被 tenantless 平台管理员指定（`http-routes.cjs:1028-1052`） |
| 幂等键 | **部分** | 行级有（`pipeline-runner.cjs:814-851`）；run 级 / HTTP 级无（`mst_` 写面无 Idempotency-Key） |
| 结果查询 | **部分** | `GET /api/integration/runs` 只按 pipelineId/status（`http-routes.cjs:9725-9734`），无 runId 单查；run 本身同步返回 |
| 取消 | **无** | `pipeline-runner.cjs` / `run-log.cjs` grep `cancel|abortSignal|AbortController` 未见 |
| 重试责任 | **部分** | 有人工死信重放（`:273`），无自动重试；两边都重试时，行级幂等键把重复写收敛到同一行 |
| 写审计 | **有** | 提交写在事务内落审计（`multitable/oapi-write-audit.ts:1-16`），拒绝/限流/错误在 `res.on('finish')` 边界落（`:150-167`）；限流 600/min/token（`middleware/rate-limiter.ts:273-284`） |

### C.5 合成数据验证所需
- **数据集**：一张 ≤20 行（或把开发期 Agent 的 `config.maxLimit` 调到 500）的假旧表，
  含 1 条空值、1 条超长文本、1 条含引号的值；目标多维表预先加一个 `human_preserved` 字段并填人工值。
- **环境**：本机 SQL Server（容器即可）+ 本机跑只读 Bridge Agent
  （`docs/integration-consolidation-plan-20260901.md:34` 指向 `scripts/ops/bridge-agent-readonly.ps1`）+ PG。
  **这是三个场景里最重的环境。**
- **验收断言（先红后绿）**：
  1. 读请求带 `options.sql`（或 `rawSql`/`queryText`）→ `AdapterValidationError`。
     （变异：删 `bridge-agent-readonly-adapter.cjs:263-265` 的循环 → 必须红。已有测试
     `plugins/plugin-integration-core/__tests__/bridge-agent-readonly-adapter.test.cjs`。）
  2. baseUrl 指向非 localhost → `:133` 拒绝。
  3. Agent `maxLimit=20` 而假表 500 行 → 完整性证明不成立，run 失败而非吞下截断结果
     （`stock-preparation-readonly-source-run.cjs:67-70` 的 `adapter_reported` 契约）。
  4. pipeline 重跑 → `human_preserved` 字段的人工值不被覆盖
     （变异：给守卫喂一个读不到字段元数据的 reader → 必须整单拒，不得静默写）。
  5. 同一批次重跑 → 行级幂等键不产生重复行。
  6. n8n 侧：用 `mst_` token（仅 `records:read` + 指定 sheet 白名单）读通；
     用同 token 打一条未列入 allowlist 的写路径（`POST /records/:recordId/lock`，
     `routes/univer-meta.ts:18616`，该路由不挂 `apiTokenAuth`）→ 401；
     用 scope 不足的 token 打 `PATCH /records/:id` → 403 且审计落一行 `denied`/`insufficient_scope`。

### C.6 缺口清单
- 本机 SQL Server + Bridge Agent 的开发环境编排（脚本/文档，新文件）——工作量大头。
- 若数据量超过单页：Bridge 不能分页是协议级事实，要真做得改 Agent 协议 + adapter + feeder 契约，属新工作。
- 按 runId 单查 run 的读端点（`lib/http-routes.cjs` 新 handler + `pipelines.cjs` 查询）。
- 外部触发 pipeline 的受控入口（新授权边界，须单独 ADR）；
  或裁定是否把 inbound automation webhook 纳入门豁免（**这是放宽认证边界的决定，须 owner 裁定，不应由实施顺手做**）。

### C.7 红线核对
K3 拒写：不涉及，且 `pipeline-runner.cjs:446-449` / `:468` 的两道 K3 目标围栏原样保留 ✔；
Bridge 无 raw SQL：既有守卫不动，验收断言 1 就是它 ✔；
执行循环分离：只用 PipelineRunner，不碰 AutomationExecutor / BPMN
（`docs/integration-consolidation-minimal-plan-20260901.md:143`）✔；
单插件 facade 不扩注入：不新增插件消费者 ✔。

### C.8 粗估
6–12 人日量级（**未冻结范围的占位**），环境搭建占大头。

---

## 推荐与理由

**推荐场景 C（Bridge 只读 SQL Server → 多维表 pipeline）。**

理由，按审阅第 2 条建议的三个尺子：

1. **最能验证「受控连接器 → MetaSheet 受控操作 →（可选）外部 n8n 调用」这条完整路，且第三跳零新端点。**
   A 与 B 的前两跳证据同样扎实，但它们落进插件内部 MVP 表后，n8n 那一跳要么要会话 JWT（运维动作），
   要么要新开一个触发入口 —— 而新开入口正是审阅 R6 要求单独提交 ADR 的那类授权边界决策，
   把它塞进「第一个可验收增量」会让这个增量同时变成一次安全边界变更。
   C 的三跳全部落在已命名、已挂守卫的现成端点上：
   Bridge 只读 → PipelineRunner → `metasheet:multitable` → n8n 用 `mst_` 读写 → 出站 webhook 推回。

2. **R6 五问上现状最不空。** 它是唯一同时具备行级幂等（`pipeline-runner.cjs:814-851`）、
   死信重放（`http-routes.cjs:273`）、run 账本（`:270`）、写审计与 per-token 限流
   （`oapi-write-audit.ts:150-167`、`rate-limiter.ts:273-284`）的一条。
   「取消」在三个场景里一律是**无**，这一项无论选谁都要单独裁定责任归属。

3. **风险形态最可控。** C 的主要成本是**一次性环境搭建**（SQL Server + 本机 Agent），
   而 A 的主要成本是**动冻结的读预设上限**、C 之外两条的 n8n 跳是**动授权边界**——
   后两类是不可逆的安全决策，前一类只是工时。
   C 要动的守卫是零：验收断言 1/2/4 全部是对既有守卫的确认，不是对它们的放宽。

**推荐的同时必须说清的两件事**：
- C 的连接器档位是**薄**（不能分页、单页受现场 Agent 配置钳制），
  `gip-bridge-bounded-read-profile.cjs` 是**桩**（自称零 runtime 接线）。
  这个增量能证明「受控读 + 受控写 + n8n 可调用」，**不能**证明「Bridge 可承载生产数据量」。
- `pipelines.cjs:489-490` 只校验 role 不校验 kind 这一点，是选 C 时应当同时知会 owner 的既有状态，
  不建议在这个增量里顺手改（改它会影响所有既存 pipeline）。

**若产品负责人更看重「今年就能给客户看」而非「验证 n8n 这条路」**，
则应选 **B**：它吞吐够真实 BOM、写侧守卫最厚（转向拒绝 + 配置结构守卫 + 值面租户证明三道），
且可用本机 PG 假 BOM 表替掉 mock PLM，环境最轻 —— 代价是 n8n 那一跳在 B 上几乎全是「无」。

---

## 我没能实读 / 不确定的点

1. `POST /api/multitable/automation/webhooks/:ruleId` 对未认证外部调用方是否真的 401：
   我只静态读了门（`index.ts:1694-1707`）、豁免表（`api-path-policy.ts:114-164`，grep `webhook` 无命中）
   和 allowlist（`oapi-read-allowlist.ts`），**没有实跑**。这条结论如果要作为决策依据，请先跑一次。
2. 三个场景的「人日量级」是未冻结范围的占位，不是估算方法的产物，也未与任何既有排期对齐。
3. 客户 PLM 源侧列名语义（场景 B 的字段映射输入）不在本仓，我无法从代码验证，
   它可能成为 B 的真实阻塞项。
4. 我没有运行任何测试，也没有访问任何客户系统或部署环境；本文全部结论来自
   `ce9da32ae69f12db082b6d3164b0634486e91172` 的静态阅读。
