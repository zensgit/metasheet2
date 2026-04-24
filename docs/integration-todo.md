# metasheet2 · PLM↔ERP 集成管道 TODO

> 来源：`/Users/chouhua/.claude/plans/todo-md-shimmering-willow.md`
> 节奏：M0→M3 共 **8-11 人周**，M4 按需拆 PR
> 状态：M0 PR #0 已收口，M1 开工前仍需真实 Postgres migration smoke 与后端 plugin hot-load smoke

---

## 🚧 M2 开工前 GATE（客户回执清单）

> M2 的**真实** K3 WISE adapter 在以下未全部确认前不开工；mock adapter / 接口契约 / 测试框架可并行推进。

- [ ] **GATE-01** K3 WISE 具体版本号与补丁号
- [ ] **GATE-02** K3API / WebAPI 实际 URL、内网/外网访问方式、认证方式
- [ ] **GATE-03** 测试账套是否已开通、是否允许写入测试物料/BOM
- [ ] **GATE-04** 物料与 BOM 字段清单（`t_ICItem`、`t_ICBOM`、`t_ICBomChild`，含自定义字段/视图/中间表）
- [ ] **GATE-05** 物料编码、单位、物料组、仓库、BOM 版本规则
- [ ] **GATE-06** Save 后是否由 adapter 自动 Submit/Audit，还是只保存
- [ ] **GATE-07** SQL Server 账号权限范围（只读 / 指定中间表可写 / 禁止访问表清单）
- [ ] **GATE-08** 是否有独立集成库/中间库
- [ ] **GATE-09** 测试数据回滚/清理策略
- [ ] **GATE-10** K3 成功/失败响应样例

---

## M0 · 插件运行时 spike + 安全边界（1 人周）

**目标**：确认系统插件运行路径，搭起空壳 `plugin-integration-core`，跑通 route + communication + scoped multitable + 凭据存储 + 基础 migration。

### M0.1 运行路径 spike
- [x] **M0-T01** 新建 `plugins/plugin-integration-core/plugin.json`（声明 `http.addRoute` / `events.emit` / `events.listen` / `database.read` / `database.write` 权限）
- [x] **M0-T02** 新建 `plugins/plugin-integration-core/index.cjs`（注册 `GET /api/integration/health` + `context.communication.register('integration-core', ...)` + 启动日志）
- [x] **M0-T03** 用 spike 结果记录 `core/plugin-manager.ts` vs `src/index.ts` 哪条是实际启动路径（after-sales 走 `createPluginContext`）；只做最小修复，不双路径同时大改
- [x] **M0-T04** 新建 `__tests__/plugin-runtime-smoke.test.cjs` 验证 route / communication / deactivate

### M0.2 数据与凭据边界
- [x] **M0-T05** 新建 `lib/credential-store.cjs`（因 runtime 尚未注入 `context.services.security`，M0 先用自包含 AES-GCM；开发允许 fake key，生产缺密钥拒启动）
- [x] **M0-T06** 新建 `lib/db.cjs`（仅允许 `integration_*` 前缀表；禁止透传 SQL 到业务表）
- [x] **M0-T07** 新建 `packages/core-backend/migrations/057_create_integration_core_tables.sql`（MVP 与后续插件 SQL migrations 保持同一格式）

### M0.3 多维表格 staging
- [x] **M0-T08** 新建 `lib/staging-installer.cjs`（自动创建 `plm_raw_items` / `standard_materials` / `bom_cleanse` / `integration_exceptions` / `integration_run_log`）
- [x] **M0-T09** 新建 `__tests__/staging-installer.test.cjs`（重复安装幂等；字段逻辑名 → 物理字段 ID 映射）

---

## M1 · integration-core MVP 后端闭环（4 人周）

**目标**：pipeline 完整链路（读 → 映射 → 清洗 → 校验 → 写 → 水位 → 死信）跑通四个 E2E。

### M1.1 数据模型
- [ ] **M1-T01** `057_create_integration_core_tables.sql` 建 7 张表：`integration_external_systems` / `integration_pipelines` / `integration_field_mappings` / `integration_runs` / `integration_watermarks` / `integration_dead_letters` / `integration_schedules`
- [ ] **M1-T02** 同文件补索引（`pipeline_id` / `status` / `run_id` / `idempotency_key` / `created_at`）；dead letter 字段补齐（source payload / transformed payload / error code+message / retry count）

### M1.2 Adapter 契约与内置 adapter
- [ ] **M1-T03** 新建 `lib/contracts.cjs` 定义内部契约：`testConnection` / `listObjects` / `getSchema` / `read` / `upsert`（MVP 仅内部使用）
- [ ] **M1-T04** 新建 `lib/adapters/http-adapter.cjs`（分页、headers、method、body template、response path）
- [ ] **M1-T05** 新建 `lib/adapters/postgres-adapter.cjs`（source 默认只读；target 限定表/视图/中间表）
- [ ] **M1-T06** 新建 `lib/adapters/plm-yuantus-wrapper.cjs`（wrap 现有 PLMAdapter，**不删除内核**；输出统一 material/BOM 记录）

### M1.3 Pipeline Runner
- [ ] **M1-T07** 新建 `lib/pipeline-runner.cjs` 主函数 `runPipeline(pipelineId, { mode, triggeredBy })`：读 pipeline → 取 source adapter → 分批 read → transform → validate → 写 staging → upsert target → 更新 run metrics
- [ ] **M1-T08** 新建 `lib/transform-engine.cjs`（`trim` / `upper` / `lower` / `toNumber` / `toDate` / `defaultValue` / `concat` / `dictMap`，**不开放用户 JS**）
- [ ] **M1-T09** 新建 `lib/validator.cjs`（`required` / `pattern` / `enum` / `min` / `max` / `unique`）
- [ ] **M1-T10** 新建 `lib/idempotency.cjs`（键 = `sourceSystem + objectType + sourceId + revision + targetSystem`；重复执行不重复写 target）
- [ ] **M1-T11** 新建 `lib/watermark.cjs`（`updated_at` / `monotonic_id` 两种游标；失败批次不推进）
- [ ] **M1-T12** 新建 `lib/dead-letter.cjs`（单条失败入队；修正后 replay 保留原 run 关联）
- [ ] **M1-T13** 新建 `lib/run-log.cjs`（记录 `rows_read` / `rows_cleaned` / `rows_written` / `rows_failed` / `duration` / `status` / `error_summary`）

### M1.4 REST API
- [ ] **M1-T14** 新建 `lib/http-routes.cjs` 注册 API：external-systems CRUD/test、pipelines CRUD/dry-run/run、runs list/detail、dead-letters list/replay
- [ ] **M1-T15** 同文件鉴权：所有写操作 `checkPermission`；敏感字段永不返回明文；错误响应含 diagnostic code

### M1.5 E2E（M1 四大验收）
- [ ] **M1-T16** `__tests__/e2e-cleanse.test.cjs`：源 `{code:'  a-01  ', qty:'3.50'}` → 清洗 `{code:'A-01', qty:3.5}`；非法 qty 入死信
- [ ] **M1-T17** `__tests__/e2e-idempotency.test.cjs`：同 batch 连跑两次，target 不重复写，第二次 `rows_written = 0`
- [ ] **M1-T18** `__tests__/e2e-deadletter-replay.test.cjs`：校验失败 → 修 mapping/字典 → replay → 成功并回写状态
- [ ] **M1-T19** `__tests__/e2e-incremental.test.cjs`：首跑推进水位；新增/修改后第二跑只处理增量

---

## M2 · PLM/K3 WISE PoC 接入（3 人周）

**前置**：GATE 10 项客户回执已到位
**目标**：PLM material/BOM → K3 WISE mock/测试账套 → 单据号/状态回写 staging。
**架构**：K3 WISE **双通道**——WebAPI/K3API 走写入，SQL Server 走只读对账/回填/幂等判断（写操作仅限客户授权的中间表或存储过程）。

- [ ] **M2-T01** `lib/adapters/plm-yuantus-wrapper.cjs` 完成 material / BOM / metadata 到统一记录的映射（**保留内核 PLMAdapter 不删除**）
- [ ] **M2-T02** 新建 `lib/adapters/k3-wise-webapi-adapter.cjs`：`testConnection` + 登录/会话保持 + upsert material + upsert BOM + 响应解析 + 返回 external id/status/message；**`Submit/Audit` 必须可配置关闭**（客户只允许保存不允许自动审核的场景）
- [ ] **M2-T03** 新建 `lib/adapters/k3-wise-sqlserver-channel.cjs`：source 默认只读；target 仅允许写客户确认的中间表或调用存储过程；禁止默认直写核心业务表
- [ ] **M2-T04** 新建 `lib/erp-feedback.cjs`：回写 staging 字段 `erp_sync_status` / `erp_material_id` / `erp_bill_no` / `erp_response_code` / `erp_response_message` / `last_synced_at`
- [ ] **M2-T05** `__tests__/e2e-plm-k3wise-writeback.test.cjs`：mock PLM → mock K3 WISE WebAPI 跑物料+简单 BOM，断言单据号/状态回写；SQL Server 只读对账单独一测
- [ ] **M2-T06** 新建 `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`：版本 / URL / SQL 连接 / 中间表策略 / 字段 / 自动提交审核开关 / 部署 / 配置 / 运行 / 故障排查 / 回滚

---

## M3 · 运营化与简单 UI（3 人周）

**目标**：非技术用户能完成"配置 → 预览 → 触发 → 查看 run → 查看死信 → replay"全流程。

- [ ] **M3-T01** 前端位置决策：
  - 独立商业化 / 独立授权 / 独立版本 / 多客户分发 → `plugins/plugin-integration-ui/`（独立前端包）
  - 否则 MVP 先挂 `apps/web/src/views/IntegrationPipelineView.vue`，后续再迁出
  - 页面功能：连接管理、字段映射、dry-run、手动触发、运行历史、dead letter
- [ ] **M3-T02** `apps/web/src/router/appRoutes.ts` 或 plugin view manifest 加 `/integration` 入口
- [ ] **M3-T03** `apps/web/tests/integration-pipeline.spec.ts`（Playwright 覆盖新建 / dry-run / 手动 run / 死信查看 / replay）

---

## M4 · 后续平台化扩展（按需独立 PR，不并入 MVP）

- [ ] **M4-T01** 通用插件 SQL migrations 运行时：统一 `PluginManifest` 与 `PluginManifestValidator` 的 migrations 结构；新增执行器 + checksum 记录；迁移编号用当前最新之后的安全编号（不使用已存在的 034）
- [ ] **M4-T02** 动态 `AutomationActionRegistry`：保留内置 action 强类型，外部 action 通过 registry 注册
- [ ] **M4-T03** `DataSourceManager` 暴露到 `CoreAPI`：只暴露受控注册 + 连接测试；查询/写入走 integration-core adapter 权限边界
- [ ] **M4-T04** Yuantus PLM 完整插件化迁移，最终删除内核 `PLMAdapter.ts`
  - **删除判据（必须全部满足）**：
    1. `plm-yuantus-wrapper` 在生产稳定运行至少 **2 个 release**
    2. `routes/plm-workbench.ts` / `routes/federation.ts` / `routes/approval-history.ts` / `index.ts` 中暴露的 `plm` API **全部切到统一 adapter 契约**
    3. E2E / contract 测试覆盖旧能力等价
    4. 删除前保留 feature flag 回退路径 **至少 1 个 release**
- [ ] **M4-T05** K3 WISE 生产硬化：多账套 / 多组织 / 真实审核流 / 替代料 / 复杂 BOM / 错误码翻译字典 / 补偿事务 / 幂等重放 / 高并发限流 / 审计追踪 / 生产回滚预案
- [ ] **M4-T06** Oracle / SQL Server / SOAP / 文件 / SFTP transport 独立插件；独立部署验证
- [ ] **M4-T07** 独立 `plugin-integration-ui`：三栏 Designer + 运行历史 + 异常重放 + 连接器 marketplace

---

## ✅ 验收 E2E 汇总

### M1（后端闭环四大）
- [ ] **清洗**：`{code:'  A-01  ', qty:'3.50'}` → `{code:'A-01', qty:3.5}`；非法 qty 入 `integration_dead_letters`
- [ ] **幂等**：同 batch 连跑两次，target 不重复写，第二次 `rows_written = 0`
- [ ] **死信重放**：失败 → 修 mapping/字典 → replay → 成功并回写状态
- [ ] **增量**：首跑推进水位，源变更后第二跑只处理增量

### M2（PLM → ERP 写回）
- [ ] PLM material/BOM → K3 WISE mock/测试账套 → K3 单据号/状态回写 staging

### M3（用户可操作闭环）
- [ ] 非技术用户完整走通"新建连接 → 字段映射 → dry-run → 手动触发 → 查看 run → 查看死信 → replay"

---

## 📋 PR 分批建议

| PR | 范围 | 前置 | 验收 |
|---|---|---|---|
| **PR #0** | `spike(integration): verify system plugin runtime` | 无 | `GET /api/integration/health` 返回；不影响 after-sales/attendance 插件 |
| **PR #1** | `feat(integration): core pipeline tables and runner` | PR #0 | M1 四个 E2E 全过 |
| **PR #2** | `feat(integration): PLM wrapper + K3 WISE writeback` | PR #1 + GATE 回执 | M2 E2E 过 |

> 后续 M3 UI、M4 各项能力按实际需求拆独立 PR。

---

## ⚠ 关键风险速查

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 插件运行路径不清（两条并存） | M0 spike 先确认再改 |
| 2 | 删除 `PLMAdapter.ts` 破坏 PLM 功能 | MVP 禁止删除；wrapper/facade；双轨运行 |
| 3 | 外部凭据泄露 | 加密存储；生产缺密钥拒启动；API 永不明文；K3 SQL 账号用只读/中间库账号 |
| 4 | 直连业务库破坏业务系统 | source 默认只读；target 默认 API/中间表；直写核心表需显式高危开关 |
| 5 | ERP 写入慢 → 内存堆积 | batch + bounded queue；source 根据 target 反压暂停 |
| 6 | 用户 JS transform 安全问题 | MVP 只开放内置 transform；自定义 JS 延后到评估 sandbox 后 |
| 7 | UI 做太重拖慢闭环 | M3 先做轻量运维 UI；三栏 Designer 推到 M4 |

---

## 📊 进度统计

- **M0** (1 人周)：**9 / 9，PR #0 review 修正完成**（2026-04-24）
- **M1** (4 人周)：0 / 19 — **启动前须先合 PR #0 修正；`/dev/real-postgres + plugin hot-load` 测试仍欠**
- **M2** (3 人周)：0 / 6（+ 10 项 GATE）
- **M3** (3 人周)：0 / 3
- **M4** (按需)：0 / 7（新增 M4-T08/M4-T09 — 内核 route/comm unregister + services.security 注入）

**MVP 总计**：9 / 37 任务（不含 GATE 与 M4）

### M0 完成产出（11 个文件）
- `plugins/plugin-integration-core/plugin.json` — manifest v2.0
- `plugins/plugin-integration-core/package.json` — `test` 脚本跑 4 个测试文件（`pnpm -F plugin-integration-core test` 可用）
- `plugins/plugin-integration-core/index.cjs` — activate/deactivate + `/api/integration/health` + communication namespace
- `plugins/plugin-integration-core/SPIKE_NOTES.md` — 运行时路径 + 内核缺口清单
- `plugins/plugin-integration-core/lib/credential-store.cjs` — AES-256-GCM 加密；生产缺 `INTEGRATION_ENCRYPTION_KEY` 拒启动
- `plugins/plugin-integration-core/lib/db.cjs` — **严格 CRUD 构造器**（`select/selectOne/insertOne/insertMany/updateRow/deleteRows/countRows/transaction`）；**无 rawQuery**；标识符白名单 + 参数化 SQL
- `plugins/plugin-integration-core/lib/staging-installer.cjs` — 5 张 staging 多维表格自动建；`required` 已正确映射到 `property.validation`
- `plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs` — 运行时/manifest/路由/通信/deactivate
- `plugins/plugin-integration-core/__tests__/credential-store.test.cjs` — 7 场景（dev fallback/prod 拒绝/roundtrip/tamper/格式/编解码）
- `plugins/plugin-integration-core/__tests__/db.test.cjs` — CRUD + 边界 + 注入（值参数化 / 标识符拒绝 / 无 rawQuery）
- `plugins/plugin-integration-core/__tests__/staging-installer.test.cjs` — 7 断言 + `property.validation` 转换验证
- `packages/core-backend/migrations/057_create_integration_core_tables.sql` — 7 张 SQL 表 + **tenant_id/workspace_id/project_id 作用域** + 唯一约束 + 索引 + 触发器

### PR #0 review 修正（全部采纳）
- **High #1 修复**：db.cjs 移除正则 SQL 扫描，改为严格结构化 CRUD 构造器 + 标识符白名单。不再可被 `FROM "users"` 之类绕过
- **High #2 修复**：迁移 057 加 `tenant_id/workspace_id/project_id`；`external_systems`/`pipelines` 加 `UNIQUE(tenant_id, workspace_id, name)`；K3 账套等外部维度存 `config` JSONB
- **Medium #3 修复**：SPIKE_NOTES.md 新增"Known kernel gaps"章节，标红 `http.addRoute/removeRoute` 无效（`src/index.ts:284`）、`communication.register` 无 unregister（`src/index.ts:1320-1338`）、`services.security` 未注入（`src/index.ts:1351-1356`）
- **Medium #4 修复**：把 ad-hoc `node -e` 测试正式落盘（`credential-store.test.cjs` + `db.test.cjs`），新增 `package.json` 的 `test` 脚本，接入 pnpm workspace
- **Medium #5 修复**：staging-installer 用 `materializeField()` 把 `required: true` 转成 `property: { validation: [{ type: 'required' }] }`；测试断言顶层 `required` 被剥离、`property.validation` 有 required 规则

### PR #0 review round 2 修正（追加采纳）
- **High 补修**：`lib/db.cjs` 的 `selectOne` / `countRows` 原按 `{ rows: [...] }` 读返回值，但真实 runtime 在 `src/index.ts:324` `return (await pool.query(...)).rows`、`types/plugin.ts:685` 定义 `DatabaseQueryResult = Record<string, unknown>[]`——返回的就是数组。在生产环境原代码会让 `selectOne` 永远返回 null、`countRows` 永远返回 0。已改为优先识别数组形态、defensively 兼容 `{rows}` 形态；测试 mock 同步改成返回数组；新增 6b 小节显式锁定返回形态契约
- **Medium 补修**：`057_*.sql` 原用 `UNIQUE (tenant_id, workspace_id, name)`，Postgres 默认 NULL≠NULL，单工作区部署 `workspace_id IS NULL` 时仍可重复插入同名。PG 14 不支持 `NULLS NOT DISTINCT`，改为 `CREATE UNIQUE INDEX ... (tenant_id, COALESCE(workspace_id, ''), name)` 表达式索引；文档里注明调用方不要用空串存 workspace_id

### 测试实际跑通情况（`pnpm -F plugin-integration-core test`）
```
✓ plugin-runtime-smoke: all assertions passed
✓ credential-store: 7 scenarios passed
✓ db.cjs: all CRUD + boundary + injection tests passed（含 6b 返回形态回归）
✓ staging-installer: all 7 assertions passed
```
语法检查、JSON 解析、CJS 加载均过。

### 仍未覆盖（诚实记录）
- `057_create_integration_core_tables.sql` **未对真实 Postgres 跑过** —— M1 开工第一件事应在 CI 加 `pnpm migrate`
- 完整的 `PluginLoader → createPluginContext → plugin.activate()` **未在运行的 metasheet2 后端上验证** —— smoke test 用模拟 context（按实际运行时 shape 还原），但未启动真实服务
- 本地 `pnpm validate:plugins` 在沙箱下因 `tsx IPC listen EPERM` 失败（非代码问题，环境限制）；真实开发环境应重跑

### M4 新增任务（由 SPIKE_NOTES.md 导入）
- **M4-T08** 内核补 `http.removeRoute` 真实实现 + `communication.unregister(name)`，让插件热装热卸不漏路由/通信命名空间
- **M4-T09** `src/index.ts:1351-1356` 注入真正的 `services.security`（封装 `packages/core-backend/src/security/encrypted-secrets.ts`），credential-store 可迁移复用

---

## 📚 参考文档

- 完整设计/路径速查/风险分析：`/Users/chouhua/.claude/plans/todo-md-shimmering-willow.md`
- 参考插件模板：`plugins/plugin-after-sales/`（activate / communication.register / installer）
- 复用内核模块：`packages/core-backend/src/security/encrypted-secrets.ts` / `sandbox/SandboxManager.ts` / `multitable/formula-engine.ts` / `multitable/field-validation-engine.ts`
