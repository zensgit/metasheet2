# T3a 设计锁 — ERP approved source-run 服务端直落 `erp_material_master`（PROPOSED, 2026-07-14）

状态：**PROPOSED**（design-lock，零 runtime；ratify 前不实现）。模型：设计=Fable；**实现=Opus 主循环**（权限+真实写+mutation 证明，owner 政策）。

## 1. 问题（owner P1 功能断点，已核实）

「读真实 ERP 后自动落缓存/快照」当前**不成立**：
- ERP source-run 路由 `stockPreparationErpMaterialSourceRun`（http-routes.cjs:3796）跑 `runErpMaterialReadonlySource` → 产 `intake`（内部**含**规范化业务行 `erpMaterials: source.rows`，readonly-source-run.cjs:782），但 HTTP 层经 `publicReadonlySourceRunResult` **刻意剥离数据面**（`buildSourceRunOutcome` 头注：「HTTP must project through publicReadonlySourceRunResult and never serialize these normalized business rows」）。
- T2 落库 `persistStockPreparationErpMaterialSync`（已 MERGED #4206）是**独立路由**（`stockPreparationErpMaterialSync` @3833），要求调用方**重新提交** `erpMaterials`。
- 由于 source-run 公开面剥离行,调用方**拿不到行去重交** ⇒ 无服务端「读 ERP → 缓存填充」路径。

## 2. 设计（T3a）

在 **同一请求内**,ERP source-run 成功后,把服务端已有的 `intake` 规范化行**直接**喂给 T2 的 `persistStockPreparationErpMaterialSync`——**行永不过 HTTP**,公开面仍 values-free(增 persist 证据:counts/modes/status)。复用两个已合入且已硬化的服务端件(source-run intake + T2 persist),是**组合接线**,非新能力面。

```
source-run 路由:
  admin gate → normalize body
  → [读租户/项目 scope]           (见 OD-2)
  → runErpMaterialReadonlySource  (产 intake.erpMaterials，服务端)
  → [若成功 & 开启] persistStockPreparationErpMaterialSync({
        erpMaterials: intake.erpMaterials,   // 服务端行，不过 HTTP
        targetProjectId: resolveIntegrationStagingProjectId(<auth-tenant>, undefined),
        syncRunId, permission:'admin', recordsApi, provisioning })
  → sendOk(publicReadonlySourceRunResult(result) + persist 证据)   // values-free
```

## 3. Open Decisions（ratify 时定）

### OD-1 自动落库 vs 门控（推荐:默认关闭 flag，分级启用）
- **A（推荐）**:新增 `MULTITABLE_STOCK_PREP_ERP_SOURCE_AUTOPERSIST_ENABLED` 默认 OFF（规范化字面 `true`）。OFF ⇒ 今日行为逐字节不变(只读,不落库);ON ⇒ 自动落缓存。符合本线 staged-optin 纪律 + O-2 阶梯。
- B 无 flag 直接自动落。owner 若认为「approved source-run 本就该落缓存」可选,但失去分级回退。
- **默认 A。** flag 进 manifest / O-2 阶梯(与 W0 step-1 同款契约)。

### OD-2 租户派生（**安全关键**——T3a 让读变得有后果）
现路由读侧用 `resolveTenantId(req, input)`（admin 采信请求 tenantId=GHSA 同款 steering,此前作 GHSA step-2 只读**延后**)。**T3a 使该读产生写副作用 ⇒ 读侧 steering 升级为写相关向量**:admin 可把读引到 tenant_evil 的源配置,再把 tenant_evil 的 ERP 数据落进某租户缓存。
- **裁决:T3a 落地时,本路由读+写租户**都**从认证主体派生**(`resolveAuthUserTenantId`),写 staging 用 `resolveIntegrationStagingProjectId(auth-tenant, undefined)`(#4206 模式)。即 T3a **顺带闭合本路由的 GHSA step-2 读侧向量**(因为 T3a 让它有了写后果)。**不碰其它 source-run/plan 路由**(仍 GHSA step-2 owner 决策)。
- 验证:body/query/params tenantId 与 projectId 透传 steering 零副作用(写落认证租户)。

### OD-3 失败/原子性语义
- source-run 失败 ⇒ 不 persist,公开面 values-free 错误(现状)。
- source-run 成功 + persist 失败 ⇒ 公开面反映 persist 失败(values-free coarse code),已落部分=T2 的 create/patch 计数(T2 逐行 upsert,缺必填字段计 skip)。**不引入跨两步事务**(T2 persist 自身 upsert 幂等,重跑刷新)——与本线既有 persist 语义一致。
- 空 intake(零行)⇒ persist 零物料 + run 记录(T2 既有语义)。

### OD-4 values-free 契约（双向）
`intake.erpMaterials` 携带 ERP 业务值(那就是缓存数据),但**只在服务端 source→persist 流动**;公开面 = source 证据 + persist 证据(counts/modes/status/field-key NAMES),**无原始行**。leak-bait 双路(成功+错误)证 syncRunId/物料码/名称不过线。

### OD-5 幂等
T2 persist 按模板 keyFields[0] upsert(已幂等 + #4206 数字-key 硬化)。重跑 source-run ⇒ 刷新缓存行,零重复。

## 4. 边界（红线）

- **只写 9 内部 MVP 表**(T2 persist 经 `createTargetScopedRecordsApi` 绑定)。**绝不外部写**(C4:不碰 apply-writer/K3 Save/自动建 ERP 物料);`externalWrite` 恒 false。
- 不改 source-run 的只读读取逻辑;不新增端点(在现路由内接线)。
- 不碰其它 source-run/plan/read 路由的租户派生(GHSA step-2)。
- 中央 RBAC 不碰。

## 5. 验证计划（ratify 后实现时）

真库 smoke（plugin-tests.yml 白名单,否则 skip-green）:
1. approved ERP source-run(flag ON)→ `erp_material_master` 出现物理键行(fieldId 取自 `meta_fields` 交叉核,非代码 sha1 派生)+ run 记录 = erp_material_sync。
2. 重跑同 source-run → 零重复(幂等 upsert)。
3. flag OFF → 只读,`erp_material_master` **零行**(负控 + 正控:ON 落 OFF 不落)。
4. values-free leak-bait 双路:公开面 + 错误面无 syncRunId/物料码/名称。
5. 租户 steering 零副作用:admin body/query tenantId=evil + projectId=evil:integration-core → 写落认证租户 staging,绝不 evil(隔离测,像 #4206 query-string 测)。
6. mutation:去掉 persist 接线 → 缓存零行(证接线载荷);去掉 auth-tenant 派生 → steering 测红(证租户闭合载荷);flag 去掉 → OFF 也落(证 flag 载荷)。
7. flag 进 global-history…否 stock-prep flag manifest(若有)+ O-2/运维契约,生产默认 OFF。

## 6. 交付物

- 本设计锁(PROPOSED)。
- ratify 后:实现 PR(Opus 主循环)= source-run 路由接线 + flag + 上述真库 smoke + mutation + values-free 双向。**不 arm/合,独立对抗审后 owner GO**(首次「读→自动写」组合,虽在内部写边界内,建议 owner 点头)。

## 7. 与 T3b 关系

T3b（PLM approved source → 服务端直落 project/snapshot/run）= 同构(PLM source-run 的 `intake.plmBomLines` → sync-run persist),独立实体,**并行组 B** 可并。T3b 单独设计锁。
