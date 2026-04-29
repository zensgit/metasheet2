# PLM 到 K3 WISE 数据清洗集成 MVP Runbook

**日期**: 2026-04-24
**范围**: `plugin-integration-core` 系统插件
**目标系统**: Yuantus/第三方 PLM source -> MetaSheet staging/cleanse -> Kingdee K3 WISE target
**状态**: PoC/MVP 接入指南。当前仓库已具备 mock E2E，不代表已连通真实客户 PLM 或真实 K3 WISE。

---

## 1. 目标与边界

本 runbook 用于把客户 PLM 物料/BOM 数据接入 MetaSheet，多维表 staging 中完成清洗、校验、异常处理后，再推送到 K3 WISE，并把 K3 回执写回 staging。

MVP 支持的链路：

```text
PLM source
  -> plm:yuantus-wrapper / HTTP / DB source adapter
  -> transform + validation + idempotency + watermark
  -> K3 WISE WebAPI/K3API target adapter
  -> ERP feedback writeback
  -> run log + dead letter replay
```

当前明确不做：

- 不删除内核 `PLMAdapter.ts`。
- 不直写 K3 WISE 核心业务表。
- 不默认自动 `Submit/Audit`。
- 不开放用户自定义 JS 清洗脚本。
- 不承诺兼容 K3 Cloud/星空；本方案目标是 K3 WISE。

---

## 2. 当前实现能力

已在 `plugin-integration-core` 中落地的 adapter kinds：

| Kind | 方向 | 用途 |
|---|---|---|
| `plm:yuantus-wrapper` | source | 包装 host `context.api.plm` 或注入的 `plmClient`，读取 material/BOM |
| `erp:k3-wise-webapi` | target | K3 WISE WebAPI/K3API 登录、Save、可选 Submit/Audit |
| `erp:k3-wise-sqlserver` | source/受限 target | SQL Server 只读对账；只允许写客户确认的中间表 |
| `http` | source/target | 通用 HTTP source/target |

核心模块：

- `lib/pipeline-runner.cjs`
- `lib/transform-engine.cjs`
- `lib/validator.cjs`
- `lib/idempotency.cjs`
- `lib/watermark.cjs`
- `lib/dead-letter.cjs`
- `lib/erp-feedback.cjs`
- `lib/http-routes.cjs`

关键接口：

```text
GET  /api/integration/status
POST /api/integration/external-systems
POST /api/integration/external-systems/:id/test
POST /api/integration/pipelines
POST /api/integration/pipelines/:id/dry-run
POST /api/integration/pipelines/:id/run
GET  /api/integration/dead-letters
POST /api/integration/dead-letters/:id/replay
```

---

## 3. M2 开工前 GATE

真实客户环境接入前必须拿到以下信息。未返回前，只能继续 mock/测试账套 PoC，不能对生产 K3 WISE 开写。

| 分类 | 必填问题 | 说明 |
|---|---|---|
| K3 WISE | 具体版本号、补丁号 | K3 WISE 与 K3 Cloud/星空接口不同 |
| K3 WebAPI/K3API | URL、网络访问方式、认证方式 | 内网、VPN、专线、代理都要明确 |
| 测试账套 | 是否已开通，是否允许写测试物料/BOM | 禁止直接打生产账套做首测 |
| 审核策略 | Save 后是否自动 Submit/Audit | 默认只 Save |
| 物料字段 | `t_ICItem` 字段编码、客户自定义字段 | 物料编码、名称、规格、单位、物料组 |
| BOM 字段 | `t_ICBOM` / `t_ICBomChild` 字段编码 | BOM 版本、父项、子项、数量、损耗 |
| SQL Server | 账号权限、只读/中间表写权限、禁用表 | 优先只读账号或集成库账号 |
| 中间库 | 是否有独立集成库/中间表 | 推荐有 |
| 样例 | K3 成功/失败响应 JSON | 用于错误码翻译和回执解析 |
| 回滚 | 测试数据清理策略 | 必须可回滚、可审计 |

---

## 4. 推荐部署拓扑

### 4.1 网络

推荐顺序：

1. MetaSheet 后端与 K3 WISE WebAPI 同内网/VPN。
2. MetaSheet 只访问 K3 WebAPI/K3API 写入入口。
3. SQL Server 账号只读 K3 业务表，或只写独立集成库/中间表。
4. 禁止使用高权限 SQL Server 账号直连生产库做写入。

### 4.2 权限

K3 WISE WebAPI 账号：

- 只授权物料/BOM 测试范围。
- 测试阶段优先测试账套。
- 生产阶段单独账号、单独审计。

SQL Server 账号：

- 对 `t_ICItem`、`t_ICBOM`、`t_ICBomChild` 默认只读。
- 对中间表或集成库存储过程按客户授权开放。
- 禁止 `db_owner`、禁止跨库高权限。

MetaSheet 权限：

- `integration:read` 可查看配置、运行、异常。
- `integration:write` 可创建系统、pipeline、触发 run/replay。
- `integration:admin` 可查看 dead-letter payload、管理高危配置。

### 4.3 凭据与密钥托管

External system 凭据必须通过 `integration_external_systems` 的 credential
边界写入，由 host security service 或 fallback 加密 envelope 保存。

要求：

- API 响应不得返回明文密码、token、SQL Server connection string。
- K3 WebAPI 密码、PLM token、SQL Server 凭据必须使用独立集成账号。
- 生产环境必须有稳定主密钥或 host security service。
- 日志、run details、dead letter 中不得写入明文凭据。
- 轮换凭据后必须重新执行 `external-systems/:id/test`。

---

## 5. External System 配置

### 5.1 PLM source

Yuantus/现有 PLM wrapper：

```json
{
  "tenantId": "tenant_1",
  "workspaceId": null,
  "name": "Yuantus PLM",
  "kind": "plm:yuantus-wrapper",
  "role": "source",
  "status": "active",
  "config": {
    "defaultProductId": "PLM_PRODUCT_ID_FOR_BOM_POC"
  }
}
```

说明：

- runtime 默认使用 `context.api.plm`。
- 测试可注入 `plmClient`。
- 不读取 env、不读 credential-store、不 import 内核 `PLMAdapter.ts`。

### 5.2 K3 WISE WebAPI target

```json
{
  "tenantId": "tenant_1",
  "workspaceId": null,
  "name": "K3 WISE WebAPI",
  "kind": "erp:k3-wise-webapi",
  "role": "target",
  "status": "active",
  "config": {
    "baseUrl": "https://k3-wise.example.internal",
    "loginPath": "/K3API/Login",
    "healthPath": "/K3API/Health",
    "autoSubmit": false,
    "autoAudit": false,
    "objects": {
      "material": {
        "savePath": "/K3API/Material/Save",
        "submitPath": "/K3API/Material/Submit",
        "auditPath": "/K3API/Material/Audit",
        "keyField": "FNumber"
      },
      "bom": {
        "savePath": "/K3API/BOM/Save",
        "submitPath": "/K3API/BOM/Submit",
        "auditPath": "/K3API/BOM/Audit",
        "keyField": "FNumber"
      }
    }
  },
  "credentials": {
    "username": "k3_integration_user",
    "password": "stored-through-credential-store",
    "acctId": "K3_TEST_ACCOUNT_SET"
  }
}
```

安全规则：

- `baseUrl` 只允许 `http/https`。
- endpoint 必须是相对路径。
- credential 通过 external-system registry 写入，不从 API 响应返回明文。
- `autoSubmit/autoAudit` 默认关闭。
- **`autoSubmit/autoAudit` 输入硬化（PR #1183）**：config 与 pipeline `request.options` 都接受 `true/false`、字符串 `"true"/"false"/"yes"/"no"/"on"/"off"`、中文 `是/否/启用/禁用/开启/关闭`、数字 `0/1`。Tri-state semantics — 显式 request 值覆盖 config，request 未设时 config 决定，全部未设默认 `false`。错误手输（如 `"maybe"`、`2`、`NaN`）抛 `AdapterValidationError` 带字段名。
- **Save-only runtime guard**：M2 Live PoC 的 material/BOM pipeline 必须把 `options.target.autoSubmit=false` 与 `options.target.autoAudit=false` 写进 pipeline 配置；pipeline-runner 会把 `pipeline.options.target` 原样传给 target adapter，K3 adapter 的 request options 优先级高于 external-system config。即使 K3 external system config 被后续误改成 `autoSubmit=true`，PoC pipeline 仍以 Save-only 为准。
- **历史 bug**：在 #1183 之前，操作员手输 `request.options.autoSubmit = "false"`（字符串）会被 `!== false` 判为 truthy，回退到 config，造成 auto-submit 仍触发——已修复并由 `__tests__/k3-wise-adapters.test.cjs` 中 10 项 `testK3WebApiAutoFlagCoercion` 场景固化。

### 5.3 K3 WISE SQL Server channel

```json
{
  "tenantId": "tenant_1",
  "workspaceId": null,
  "name": "K3 WISE SQL Server",
  "kind": "erp:k3-wise-sqlserver",
  "role": "bidirectional",
  "status": "active",
  "config": {
    "allowedTables": [
      "dbo.t_ICItem",
      "dbo.t_ICBOM",
      "dbo.t_ICBomChild",
      "dbo.integration_material_stage"
    ],
    "objects": {
      "material": {
        "table": "dbo.t_ICItem",
        "operations": ["read"],
        "columns": ["FItemID", "FNumber", "FName", "FModel"]
      },
      "material_stage": {
        "table": "dbo.integration_material_stage",
        "operations": ["upsert"],
        "writeMode": "middle-table",
        "keyField": "FNumber"
      }
    }
  }
}
```

SQL Server channel 当前是 skeleton：

- 不内置 SQL Server driver。
- 不接受 raw SQL。
- 需要运行时注入受限 `queryExecutor`。
- 写入必须是 `writeMode: "middle-table"`。

---

## 6. Pipeline 配置样例

### 6.1 物料主数据

```json
{
  "tenantId": "tenant_1",
  "workspaceId": null,
  "projectId": "project_1",
  "name": "PLM Material to K3 WISE",
  "sourceSystemId": "plm_1",
  "sourceObject": "materials",
  "targetSystemId": "k3_1",
  "targetObject": "material",
  "mode": "incremental",
  "status": "active",
  "idempotencyKeyFields": ["sourceId", "revision"],
  "options": {
    "batchSize": 100,
    "watermark": {
      "type": "updated_at",
      "field": "updatedAt"
    },
    "target": {
      "autoSubmit": false,
      "autoAudit": false
    },
    "erpFeedback": {
      "objectId": "standard_materials",
      "keyField": "_integration_idempotency_key"
    }
  },
  "fieldMappings": [
    {
      "sourceField": "code",
      "targetField": "FNumber",
      "transform": ["trim", "upper"],
      "validation": [{ "type": "required" }]
    },
    {
      "sourceField": "name",
      "targetField": "FName",
      "transform": { "fn": "trim" },
      "validation": [{ "type": "required" }]
    },
    {
      "sourceField": "uom",
      "targetField": "FBaseUnitID",
      "transform": {
        "fn": "dictMap",
        "map": {
          "PCS": "Pcs",
          "EA": "Pcs",
          "KG": "Kg"
        }
      }
    },
    {
      "sourceField": "sourceId",
      "targetField": "sourceId",
      "validation": [{ "type": "required" }]
    },
    {
      "sourceField": "revision",
      "targetField": "revision",
      "defaultValue": "A"
    }
  ]
}
```

### 6.2 BOM

```json
{
  "tenantId": "tenant_1",
  "workspaceId": null,
  "projectId": "project_1",
  "name": "PLM BOM to K3 WISE",
  "sourceSystemId": "plm_1",
  "sourceObject": "bom",
  "targetSystemId": "k3_1",
  "targetObject": "bom",
  "mode": "manual",
  "status": "active",
  "idempotencyKeyFields": ["sourceId", "revision"],
  "options": {
    "batchSize": 50,
    "target": {
      "autoSubmit": false,
      "autoAudit": false
    },
    "erpFeedback": {
      "objectId": "bom_cleanse",
      "keyField": "_integration_idempotency_key"
    }
  },
  "fieldMappings": [
    { "sourceField": "parentCode", "targetField": "FParentItemNumber", "validation": [{ "type": "required" }] },
    { "sourceField": "childCode", "targetField": "FChildItemNumber", "validation": [{ "type": "required" }] },
    { "sourceField": "quantity", "targetField": "FQty", "transform": { "fn": "toNumber" }, "validation": [{ "type": "min", "value": 0.000001 }] },
    { "sourceField": "uom", "targetField": "FUnitID" },
    { "sourceField": "sequence", "targetField": "FEntryID" },
    { "sourceField": "sourceId", "targetField": "sourceId", "validation": [{ "type": "required" }] },
    { "sourceField": "revision", "targetField": "revision", "defaultValue": "A" }
  ]
}
```

BOM `productId` 说明：

- 当前 pipeline runner 不会读取 pipeline 内的 `source.productId` 配置并传给 source adapter。
- BOM PoC 应优先在 PLM external system 的 `config.defaultProductId` 中配置产品 ID。
- 直接调用 adapter 或后续 UI 若支持运行时过滤，可通过 `filters.productId` 传入。

---

## 7. Staging 与 ERP 回执字段

默认 staging 对象：

| 对象 | 用途 |
|---|---|
| `plm_raw_items` | PLM 原始拉取记录 |
| `standard_materials` | 清洗后的物料主数据 |
| `bom_cleanse` | 清洗后的 BOM 行 |
| `integration_exceptions` | 用户可见异常队列 |
| `integration_run_log` | 用户可见运行日志 |

默认 ERP feedback 字段是 camelCase：

```text
erpSyncStatus
erpExternalId
erpBillNo
erpResponseCode
erpResponseMessage
lastSyncedAt
```

如果客户 staging 使用 snake_case，可配置：

```json
{
  "options": {
    "erpFeedback": {
      "fieldMap": {
        "status": "erp_sync_status",
        "externalId": "erp_material_id",
        "billNo": "erp_bill_no",
        "responseCode": "erp_response_code",
        "responseMessage": "erp_response_message",
        "syncedAt": "last_synced_at"
      }
    }
  }
}
```

---

## 8. 部署步骤

### 8.1 基础迁移

确认 `057_create_integration_core_tables.sql` 已运行：

```bash
pnpm --filter @metasheet/core-backend migrate
```

应创建：

- `integration_external_systems`
- `integration_pipelines`
- `integration_field_mappings`
- `integration_runs`
- `integration_watermarks`
- `integration_dead_letters`
- `integration_schedules`

### 8.2 插件校验

```bash
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
```

### 8.3 启动服务

```bash
pnpm --filter @metasheet/core-backend dev
```

检查：

```bash
curl http://localhost:8900/api/integration/health
curl http://localhost:8900/api/integration/status | jq '.data.adapters'
```

`/api/integration/status` 的 `data.adapters` 应包含：

```text
erp:k3-wise-sqlserver
erp:k3-wise-webapi
http
plm:yuantus-wrapper
```

### 8.4 创建 staging

安装 `plugin-integration-core` staging 多维表：

- 通过插件安装流程调用 staging installer。
- 或由后续 UI/installer 操作统一触发。

成功后应存在：

- PLM Raw Items
- Standard Materials
- BOM Cleanse
- Integration Exceptions
- Integration Run Log

---

## 9. 运行流程

建议顺序：

1. 创建 PLM source external system。
2. 创建 K3 WISE WebAPI target external system。
3. 对两个 external system 执行 `testConnection`。
4. 创建 material pipeline。
5. 先执行 dry-run。
6. 检查 preview、mapping、validation、dead-letter 预期。
7. 在测试账套执行 run。
8. 检查 K3 单据号、feedback 字段、run log、dead letter。
9. 再创建 BOM pipeline。
10. 只在客户确认后开启 `autoSubmit/autoAudit`。

dry-run：

```text
POST /api/integration/pipelines/:id/dry-run
```

真实执行：

```text
POST /api/integration/pipelines/:id/run
```

查看运行历史：

```text
GET /api/integration/runs
```

异常重放：

```text
GET  /api/integration/dead-letters
POST /api/integration/dead-letters/:id/replay
```

### 9.5 客户 GATE 答卷回卷后的执行顺序

客户 GATE 答卷归档前，先确认当前 MetaSheet 部署本身具备 K3 WISE PoC
控制面能力。这一步不访问客户 K3 / PLM / SQL Server，只读检查部署后的
backend、插件、前端路由、integration API 路由和 staging descriptor：

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --out-dir artifacts/integration-live-poc/postdeploy-smoke
```

也可以在 GitHub Actions 手动触发 `K3 WISE Postdeploy Smoke`，填写
`base_url`、`require_auth=true`、`tenant_id`。期望产物是
`integration-k3wise-postdeploy-smoke.json` / `.md` 均 PASS，且四个只读
control-plane list probe 都通过：

- `/api/integration/external-systems?tenantId=<tenant>&limit=1`
- `/api/integration/pipelines?tenantId=<tenant>&limit=1`
- `/api/integration/runs?tenantId=<tenant>&limit=1`
- `/api/integration/dead-letters?tenantId=<tenant>&limit=1`

鉴权 token 来源顺序：

1. 优先使用仓库 secret `METASHEET_K3WISE_SMOKE_TOKEN`。
2. 若未配置 secret，workflow 会在 deploy host 的运行中 backend 容器内通过
   `authService.createToken()` 临时签发 2 小时 token，并写入本次 job 的
   `K3_WISE_SMOKE_TOKEN`；该 fallback 只查询 active admin 用户，不写业务库。
3. deploy workflow 对 token 解析失败保持 public-only smoke；手动
   `require_auth=true` 时 token 解析失败会直接失败。

客户 GATE 答卷归档后，按下面这条线性顺序推进 M2-LIVE，每一步都要在测试账套用最小权限账号执行：

| 步 | 命令 / 动作 | 期望产出 | 失败处理 |
|---|---|---|---|
| 1 | `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --input <gate.json> --out-dir artifacts/integration-live-poc` | 脱敏 `packet.json` + Markdown 摘要 | 任何 `LivePocPreflightError` 抛出说明 GATE 答卷有缺陷或不符合 Save-only 要求，回填 GATE 后再跑 |
| 2 | `node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs` | `✓ K3 WISE PoC mock chain verified end-to-end (PASS)` | 链路本身有问题，先修代码再跑客户测试 |
| 3 | 通过 REST 创建 PLM + K3 + 可选 SQL Server external system，跑 `testConnection` | 各 system 返回 `{ok: true}` 并写到 evidence `connections.<system>.status` | 凭据 / URL / acctId 错误，校对 GATE 答卷重新写凭据 |
| 4 | 创建 material pipeline，执行 dry-run（POST `/dry-run` 或带 `dryRun: true`） | preview JSON 含 1-3 条 cleaned 记录，target 不写入 | 字段映射或 transform 错误，调整 mapping 后再跑 |
| 5 | 同 pipeline 执行 Save-only run（`autoSubmit=false`、`autoAudit=false`） | K3 返回 1-3 个 externalId / billNo，staging feedback 字段更新，watermark 推进 | 业务码失败 → dead letter，修原始数据后 replay；连接失败 → 复查 K3 / 网络 |
| 6 | 创建 BOM pipeline（必须用 PLM external system `config.defaultProductId` 或 direct adapter `filters.productId`，**不要**用旧的 `pipeline.options.source.productId`） | BOM 写入 1-2 个测试 BOM，K3 返回单据号 | `BOM_PRODUCT_SCOPE_REQUIRED` → 补 productId；`LEGACY_BOM_PRODUCT_ID_USED` → 切换到 PLM config 路径 |
| 7 | 客户填写 `evidence.json`（或基于 `scripts/ops/fixtures/integration-k3wise/evidence-sample.json` 修改） | `evidence.json` 含真实 runId、K3 单据号、phase status | 字段值用客户习惯写法都接受（中文 / 英文 / 0-1）；非常规值会抛 `LivePocEvidenceError` |
| 8 | `node scripts/ops/integration-k3wise-live-poc-evidence.mjs --packet <step1>/packet.json --evidence <step7>/evidence.json --out-dir artifacts/integration-live-poc/evidence` | `✓ Decision: PASS` JSON + Markdown report | `PARTIAL` / `FAIL` 回填 evidence 缺项或回流 M2 adapter 硬化，**不进入 M3 UI** |

每一步的 evidence JSON 字段都已硬化（见 §11.5）：客户随手写中文 `成功` / `通过` / `失败`、字符串 `"true"` / `"false"`、数字 ID `12345`、numeric `0/1` 都被接受，只有 `"maybe"` / `NaN` / `2` 等真正无意义的值才会抛错。

### 9.6 字段输入规约（GATE + evidence 共同适用）

| 字段类型 | 接受 | 拒绝 | PR |
|---|---|---|---|
| Boolean (`autoSubmit`, `autoAudit`, `saveOnly`, `productionWriteBlocked`, `enabled`, `legacyPipelineOptionsSourceProductId`, `dryRun`, `allowInactive`) | `true`/`false`、字符串 `"true"`/`"false"`/`"yes"`/`"no"`/`"on"`/`"off"`、中文 `是`/`否`/`启用`/`禁用`/`开启`/`关闭`、数字 `0`/`1` | `"maybe"`、其他字符串、非 `0/1` 数字、`NaN`、`Infinity`、对象、数组（带字段名抛错） | #1168 / #1169 / #1175 / #1182 / #1183 / #1184 |
| 数字 ID (`productId`, `runId`) | 字符串 `"PROD-001"`、有限数字 `12345`、bigint `9007199254740993n` | `NaN`、`Infinity`、对象、数组、布尔（视为缺失） | #1176 |
| Status 字段 (`gate.status`、`materialDryRun.status` 等) | canonical (`pass/partial/fail/skipped/todo/blocked`)、英文同义词 (`passed`/`complete`/`done`/`ok`/`success`/`failed`/`error`/...)、中文 (`通过`/`成功`/`完成`/`已完成`/`失败`/`错误`/`进行中`/`部分`/`阻塞`/`等待中`/`跳过`/`不适用`/`待办`/`未开始`/...)，大小写不敏感 | 完全未知字符串（自动回退 `todo`，**不抛错**） | #1177 |
| BOM `productId` | PLM external system `config.defaultProductId` 或 direct adapter `filters.productId` | `pipeline.options.source.productId`（旧路径，evidence 会标 `LEGACY_BOM_PRODUCT_ID_USED`） | #1162 (preflight) / #1166 (evidence) |

**关键：** 所有"接受"的变体在硬化层 normalizeSafeBoolean 处都被规范化为真正的布尔/字符串，下游业务逻辑看到的永远是 canonical 形态。客户不需要逐字段研究规范——按习惯写就好，错的会带字段名抛出。

### 9.7 错误处理快查表

下表覆盖客户/操作员最可能遇到的 7 类错误，按"看到这条信息→怎么办"组织：

| 错误信号 | 典型场景 | 怎么办 |
|---|---|---|
| `LivePocPreflightError: <field> must be a boolean, 0/1, or boolean-like string` | GATE 答卷写了 `autoSubmit: "maybe"` 或类似无效值 | 改成允许的写法（`true/false/是/否/0/1/...`）后重跑 preflight |
| `LivePocPreflightError: M2 live PoC packet is Save-only: autoSubmit and autoAudit must be false` | GATE 答卷写了 `autoSubmit: true` | M2 PoC 强制 Save-only。等过 PoC 后再单独申请开 auto-submit。改回 `false` 重跑 |
| `LivePocPreflightError: SQL Server channel may not write K3 core business tables in live PoC` | `sqlServer.allowedTables` 含 `t_ICItem` / `t_ICBOM` 且 `mode != readonly` | 把 mode 改回 `readonly`，或把 allowedTables 限制到中间表 |
| `LivePocPreflightError: K3 WISE live PoC must target a non-production test environment` | `k3Wise.environment` 写成 `production` / `prod` | 改成 `test` / `uat` / `staging` 等非生产环境标识 |
| `LivePocEvidenceError: evidence contains unredacted secret-like fields` | evidence JSON 里残留了真密码 / token / sessionId | 把 secret-like key 的值替换成 `<redacted>` 或空字符串后重跑 |
| `SAVE_ONLY_VIOLATED` (evidence 报告 issues) | evidence 中 `materialSaveOnly.autoSubmit` 或 `autoAudit` 是 truthy（含字符串/数字/中文） | 客户 K3 实际跑时确实开了自动审核——按 GATE 答卷 Save-only 约定重新跑客户侧 K3 测试，或回流 M2 adapter 硬化 |
| `BOM_PRODUCT_SCOPE_REQUIRED` / `LEGACY_BOM_PRODUCT_ID_USED` | BOM 没传 productId，或用了旧的 `pipeline.options.source.productId` 路径 | 通过 PLM external system `config.defaultProductId` 或 direct adapter `filters.productId` 传入 |
| `AdapterValidationError: request.options.autoSubmit must be ...` | pipeline run 的 REST 调用里 `options.autoSubmit` 写了未知字符串 | 用允许的布尔变体；K3 adapter 已在 #1183 全面硬化，错误信息会带具体字段名 |
| `PipelineRunnerError: input.dryRun must be ...` | pipeline run 的 REST 调用里 `dryRun` 字段写了 `"maybe"` | 用允许的布尔变体；pipeline-runner 已在 #1184 全面硬化 |

---

## 10. 验收清单

### 10.1 Mock 验收

已由仓库测试覆盖：

- PLM wrapper material/BOM canonical mapping。
- K3 WISE WebAPI Save 成功/失败。
- PLM material -> K3 mock -> feedback writeback。
- K3 业务失败进入 dead letter。
- partial run 不推进 watermark。
- dry-run 不写 K3、不写 dead letter、不写 feedback。
- 输入硬化（#1175-#1184）：preflight + evidence + adapter + pipeline-runner 全链路 bool/numeric/synonym/Chinese 强化。

命令：

```bash
pnpm -F plugin-integration-core test:e2e-plm-k3wise-writeback
node scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node scripts/ops/integration-k3wise-live-poc-evidence.test.mjs   # 31/31
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

最后一条 `run-mock-poc-demo.mjs` 是端到端 mock 链路烟雾测试（GATE → preflight → mock K3 WebAPI → mock SQL → evidence compile → 断言 PASS），用于在客户回卷前证明"链路是通的"。**Mock pass ≠ 客户 live pass**——见 `scripts/ops/fixtures/integration-k3wise/README.md`。

### 10.2 测试账套验收

客户测试账套必须完成：

- 物料 Save 成功。
- 物料 Save 失败返回业务错误码，dead letter 可诊断。
- K3 返回单据号/物料 ID 后，staging feedback 字段更新。
- 重复执行同一批次不会重复写入。
- 增量执行只处理新增/修改记录。
- Submit/Audit 默认关闭；开启后符合客户审批流。
- SQL Server 只读对账可执行；直写 `t_ICItem`、`t_ICBOM`、
  `t_ICBomChild` 等 K3 核心业务表必须被拒绝。

### 10.3 生产前验收

生产前必须完成：

- SQL Server 权限复核。
- K3 WebAPI 账号权限复核。
- 数据回滚脚本或清理 SOP。
- 错误码翻译表。
- 并发与限流策略。
- 日志留存与审计策略。
- 客户签字确认字段 mapping。

---

## 11. 故障排查

### 11.1 PLM 读取失败

检查：

- `context.api.plm` 是否存在。
- PLM adapter 是否 connected。
- `sourceObject` 是否为 `materials` 或 `bom`。
- BOM pipeline 对应的 PLM external system 是否配置 `config.defaultProductId`，或直接 adapter 调用是否提供 `filters.productId`。

常见错误：

| 错误 | 处理 |
|---|---|
| `PLM_CLIENT_MISSING` | host 未注入 PLM client，检查 PLM runtime 或改用 mock |
| `BOM read requires filters.productId` | 在 PLM external system 补 `config.defaultProductId`，或直接 adapter 调用传 `filters.productId` |
| `UnsupportedAdapterOperationError` | PLM 是 source-only，不允许 upsert |

### 11.2 K3 写入失败

检查：

- `baseUrl` 是否可达。
- `loginPath` 是否正确。
- 账套 ID、用户名、密码是否正确。
- Save payload 是否符合客户字段编码。
- `autoSubmit/autoAudit` 是否被误开启。

常见错误：

| 错误 | 处理 |
|---|---|
| `K3_WISE_TEST_FAILED` | 登录或 health 检查失败 |
| `K3_WISE_SAVE_FAILED` | K3 未返回明确业务错误码，检查 raw response |
| 客户业务错误码 | 写入错误码翻译字典，修 mapping 或源数据 |

### 11.3 SQL Server 通道失败

检查：

- 是否注入受限 `queryExecutor`。
- 表名是否在 `allowedTables`。
- 表/列 identifier 是否符合白名单。
- 写入对象是否 `writeMode: "middle-table"`。

常见错误：

| 错误 | 处理 |
|---|---|
| `SQLSERVER_EXECUTOR_MISSING` | 当前 runtime 未注入 SQL Server executor |
| `table is not in the configured allowlist` | 补 allowlist 或修配置 |
| `only writes to configured middle tables` | 禁止直写 K3 核心表，改用中间表 |

### 11.4 Feedback 未写回

检查：

- `pipeline.projectId` 是否存在。
- `pipeline.options.erpFeedback.objectId` 是否正确。
- `keyField` 是否能匹配 staging 记录。
- multitable `records.patchRecord/createRecord` 是否可用。
- 是否是 dry-run。

Feedback 写回失败默认不回滚 K3 写入。需先从 run details 查看 `erpFeedback` 摘要。

---

## 12. 回滚策略

### 12.1 配置回滚

- 将 pipeline `status` 改为 `paused` 或 `disabled`。
- 将 external system `status` 改为 `inactive`。
- 关闭 schedule。
- 关闭 `autoSubmit/autoAudit`。
- 关闭或跳过 `options.erpFeedback.enabled`，停止 feedback 写回 staging。

### 12.2 数据回滚

测试账套：

- 按测试数据前缀清理物料/BOM。
- 清理中间表记录。
- 保留 `integration_runs` 和 `integration_dead_letters` 作为审计。

生产账套：

- 不建议自动删除 K3 单据。
- 按客户 K3 运维 SOP 执行反审核、禁用、废弃或人工冲销。
- 由 K3 管理员确认后再清理。

### 12.3 代码回滚

- 插件可通过停用 pipeline 降级。
- 不需要回滚内核 `PLMAdapter.ts`，本方案未删除它。
- 若 K3 adapter 有问题，先停用 K3 external system，不影响其他插件。

---

## 13. 上线限制

MVP 只能作为 PoC/测试账套上线，生产硬化前不得宣称完成生产可用。

必须补齐的生产项：

- 多账套/多组织策略。
- 客户真实审核流。
- 替代料与复杂 BOM。
- K3 错误码翻译字典。
- 补偿事务。
- 高并发幂等重放。
- 限流和重试。
- SQL Server executor 生产实现。
- 前端配置与异常处理 UI。

---

## 14. 当前仓库验证命令

```bash
pnpm -F plugin-integration-core test
node scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

截至 2026-04-29，本地验证结果：

- `plugin-integration-core` 全量测试通过（含 `testK3WebApiAutoFlagCoercion` 10 项硬化场景）。
- preflight 脚本测试全部通过（含 #1168 / #1169 bool sweep）。
- evidence 脚本 31/31 测试通过（含 #1175 / #1176 / #1177 / #1182 全链路硬化）。
- mock PoC demo 链路 9 步全 PASS（GATE → preflight → mock K3 → mock SQL → evidence → 断言 PASS）。
- postdeploy token resolver 测试通过，覆盖长期 secret、可选跳过、必需失败与 deploy-host fallback 前置检查。
- postdeploy smoke 测试通过，覆盖公开检查、鉴权控制面 list probe、tenant 显式参数和环境变量回退。
- postdeploy workflow contract 测试通过，覆盖 deploy workflow 与手动 workflow 的 token / tenant wiring。
- 插件 manifest 校验 13/13 valid，0 errors。
- `git diff --check` 通过。

**Mock pass ≠ 客户 live pass。** 上述命令证明仓库内部链路是通的。客户真实 K3 WISE 仍可能拒绝 payload、返回非标准响应、要求审批流——以客户测试账套验证为准。

---

## 15. 相关文件

- `plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-channel.cjs`
- `plugins/plugin-integration-core/lib/erp-feedback.cjs`
- `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- `plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs`
- `docs/development/integration-core-plm-yuantus-wrapper-design-20260424.md`
- `docs/development/integration-core-k3wise-adapters-design-20260424.md`
- `docs/development/integration-core-erp-feedback-design-20260424.md`
