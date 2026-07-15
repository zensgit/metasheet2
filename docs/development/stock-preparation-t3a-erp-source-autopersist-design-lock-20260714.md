# T3a 设计锁 — ERP approved source-run 服务端直落 `erp_material_master`（决策已定，待 RATIFY, rev 2026-07-15）

状态：**决策已写实（RATIFY-ready）** — OD-1..OD-5 全部裁决落定（§3），owner 2026-07-15 授权「推进 T3a/T3b」。实现处 `61caf7ff0`（分支 `claude/stock-prep-t3a-erp-autopersist`）**WIP 已按本锁核心接线**（flag 条件 tenant + auto-persist，flag OFF 证实 inert）；**flag ON 的安全验证(steering 拒绝 red-first + 真库 smoke + mutation)待补**（§5）。模型：实现=Opus 主循环（权限+真实写+mutation 证明，owner 政策）。**ratify 是 owner 的门**——本 rev 只把决策写实,不自我 ratify。

## 1. 问题（owner P1 功能断点，已核实）

「读真实 ERP 后自动落缓存/快照」当前**不成立**：
- ERP source-run 路由 `stockPreparationErpMaterialSourceRun`（http-routes.cjs:3796）跑 `runErpMaterialReadonlySource` → 产 `intake`（内部**含**规范化业务行 `erpMaterials: source.rows`，readonly-source-run.cjs:782），但 HTTP 层经 `publicReadonlySourceRunResult` **刻意剥离数据面**（`buildSourceRunOutcome` 头注：「HTTP must project through publicReadonlySourceRunResult and never serialize these normalized business rows」）。
- T2 落库 `persistStockPreparationErpMaterialSync`（已 MERGED #4206）是**独立路由**（`stockPreparationErpMaterialSync` @3833），要求调用方**重新提交** `erpMaterials`。
- 由于 source-run 公开面剥离行,调用方**拿不到行去重交** ⇒ 无服务端「读 ERP → 缓存填充」路径。

## 2. 设计（T3a）

在 **同一请求内**,ERP source-run 成功后,把服务端已有的 `intake` 规范化行**直接**喂给 T2 的 `persistStockPreparationErpMaterialSync`——**行永不过 HTTP**,公开面仍 values-free。复用两个已合入且已硬化的服务端件(source-run intake + T2 persist),是**组合接线**,非新能力面。**flag OFF 时响应逐字节不变(不加任何字段);flag ON 时才落库并加 `autoPersist` + 覆盖 projector 的 dry_run/未写标记**(权威契约见 OD-4)。

```
source-run 路由(与 http-routes.cjs WIP 922fd2f76 一致):
  admin gate → normalize body
  autoPersistEnabled = flag                                   (OD-1，默认 OFF)
  若 ON: assertStockPreparationErpAutoPersistNoSteering(req)   // 请求含 tenantId/projectId → 400,在任何 I/O 前 (OD-2)
  tenant = ON ? resolveAuthUserTenantId(req) : resolveTenantId(req,input)   // OFF 保持现有只读派生
  → runErpMaterialReadonlySource         // 产 intake.erpMaterials；空(rows<1) 已在此抛 SOURCE_RUN_EMPTY(422)→到不了下面 (OD-3)
  readProjection = publicReadonlySourceRunResult(result)      // 固定 mode:'dry_run' / evidence.internalWriteExecuted:false
  若 OFF: return sendOk(res, readProjection)                   // 逐字节不变，无 autoPersist 字段 (OD-4)
  若 ON:  autoPersist = persistStockPreparationErpMaterialSync({
              erpMaterials: intake.erpMaterials,   // 服务端行，不过 HTTP
              targetProjectId: resolveIntegrationStagingProjectId(<auth-tenant>, undefined),
              syncRunId, permission:'admin', recordsApi, provisioning })
          return sendOk({ ...readProjection,
                          mode:'internal_persist',                              // 覆盖假 dry_run
                          evidence:{ ...readProjection.evidence, internalWriteExecuted:true },  // 覆盖假「未写」
                          autoPersist },                                        // T2 真实 values-free 证据
                        autoPersist.persisted ? 201 : 200)                      // 201 iff 有行落地
```

## 3. 已决策（RATIFY-ready，owner 2026-07-15 定；实现处 `61caf7ff0` WIP 已按此接线）

### OD-1 自动落库 vs 门控 — ✅ DECIDED：默认关闭 flag，分级启用
- **裁决 A**:新增默认-OFF flag（规范化字面 `true`,trim+小写）。OFF ⇒ 今日行为逐字节不变(只读,不落库);ON ⇒ 自动落缓存。符合本线 staged-optin 纪律 + O-2 阶梯。**默认 OFF ⇒ 即便早合也零运行时影响,可在实体机等待期安全合并。**
- 实现处 flag 名 = `MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED`（WIP 已用；ratify 时若 owner 要对齐 `..._SOURCE_AUTOPERSIST_ENABLED` 可改,单点)。flag 进 stock-prep flag 台账/O-2 运维契约,生产默认 OFF。

### OD-2 租户派生（**安全关键**——T3a 让读变得有后果）— ✅ DECIDED
现路由读侧用 `resolveTenantId(req, input)`（admin 采信请求 tenantId=GHSA 同款 steering,此前作 GHSA step-2 只读**延后**)。**T3a 使该读产生写副作用 ⇒ 读侧 steering 升级为写相关向量**:admin 可把读引到 tenant_evil 的源配置,再把 tenant_evil 的 ERP 数据落进某租户缓存。
- **裁决:租户派生随 flag 条件化。**
  - **flag OFF**:保持现有 `resolveTenantId(req, input)` 只读路径,**逐字节不变**——GHSA step-2 的只读 steering 问题仍**延后**,不在 T3a 内动。
  - **flag ON**:读+写租户都**从认证主体派生**(`resolveAuthUserTenantId`),写 staging 用 `resolveIntegrationStagingProjectId(auth-tenant, undefined)`(#4206 模式)。
- **强化(owner 2026-07-15):flag ON 时,请求侧显式 tenant/projectId steering 在任何 I/O(source-run 读)之前 fail-closed 拒绝**——不是静默忽略。即请求 body/query/params 带 `tenantId` 或 `projectId` ⇒ 400(如 `STOCK_PREPARATION_ERP_AUTOPERSIST_STEERING_NOT_ALLOWED`),在 `loadStockPreparationReadonlySource` / persist 之前。理由:auto-persist 下,一个被引导的读会真实落进认证租户缓存(即便租户派生已闭合,拒绝比忽略更早、更明确、审计更清晰,与 baseId `assertNoRequestBaseId` 同纪律)。
- T3a **顺带闭合本路由的 GHSA step-2 写相关向量**(因为 flag ON 让它有写后果)。**不碰其它 source-run/plan 路由**(仍 GHSA step-2 owner 决策)。
- 验证:flag ON 下 body/query/params tenantId 或 projectId → I/O 前 400 + 零 source-run 读 + 零写;flag OFF 下现有读行为不变。

### OD-3 空输入 / 失败语义 — ✅ DECIDED（对齐真实代码,rev 2026-07-15）
- **空 intake(零行)⇒ 根本到不了 persist**:`assertIntakeReady()` 在 `erpMaterialRows < 1` 时**先抛 `SOURCE_RUN_EMPTY`(422)**(见 stock-preparation-readonly-source-run.cjs)。所以 flag ON 只会在 **≥1 行**时 persist。**修正:不存在「空 intake 返回 200 + 写 run」这一路径**(旧稿有误);空 = 422,零写。现有测试已锁该 422 路径。
- **source-run 失败 ⇒ 不 persist**,公开面 values-free 错误(现状不变)。
- **source-run 成功 + persist 失败 ⇒ 整请求返回 persist 的 values-free coarse 错误**(如 `ERP_MATERIAL_SYNC_*`),**不返回半成品 autoPersist、不返回部分成功计数**。T2 逐行 upsert 可能已落部分行——但这**不进响应**(响应只有 coarse 错误);幂等 upsert ⇒ 重跑 source-run 安全刷新,零重复。**不引入跨两步事务**(与本线既有 persist 语义一致)。
- **非空 intake 但所有行被 persist 跳过**(缺必填字段 → created=0∧patched=0):`autoPersist.persisted=false, autoPersist.mode='skipped_empty'`,HTTP 200,`internalWriteExecuted=true`(写路径已跑,无行落地)。

### OD-4 响应契约 + values-free（双向）— ✅ DECIDED（对齐真实代码,rev 2026-07-15）
- **flag OFF ⇒ 响应逐字节不变** = `publicReadonlySourceRunResult(result)`,**不新增任何字段**(无 autoPersist)。RC-0 安全。(修正旧稿「恒增 autoPersist:null」——那与「逐字节不变」矛盾;现在 OFF 什么都不加。)
- **flag ON ⇒ 响应 = read 投影 + 覆盖 + autoPersist**:
  - `publicReadonlySourceRunResult` 固定 `mode:'dry_run'` 且 `evidence.internalWriteExecuted:false`——**发生真实内部写后二者皆为假**,故 ON 路径**覆盖**为 `mode:'internal_persist'` + `evidence.internalWriteExecuted:true`,响应绝不谎报「未写」。(修正旧稿未覆盖 projector。)
  - 加 `autoPersist` = **T2 persist 的真实返回**(值来自 stock-preparation-erp-material-sync-persist.cjs:397-405):`{ persisted, mode('created'|'refreshed'|'skipped_empty'), created:{materials,run}, patched:{materials,run}, skipped:{materials}, runStatus, evidence:{ …targets:{material,run:{objectId,fieldKeys,keyField}}, targetObjectIds, valuesFree:true } }`。**修正旧稿的错误形状**(不是 `skippedInvalid`/`run:{status}`/`fieldKeyNames`)。
  - **HTTP 201 iff `autoPersist.persisted`(created>0∨patched>0),否则 200**。实现处 `sendOk(res, body, autoPersist.persisted ? 201 : 200)`(修正旧 WIP 固定 200)。
- **契约不变式(无矛盾)**:`autoPersist` **存在 ⟺ flag ON**;flag OFF **无此字段**。不存在 null 态。
- **values-free 双向**:`intake.erpMaterials` 带 ERP 业务值,但**只在服务端 source→persist 流动**;响应只有 source 证据 + T2 values-free evidence(counts/modes/statuses/objectIds/fieldKeys),**无原始行、无 syncRunId 值、无物料码/名称**。leak-bait 双路(成功+错误)证之。

### OD-5 幂等 + **staged upsert-only（非全量同步）** — ✅ DECIDED
- T2 persist 按模板 keyFields[0] upsert(已幂等 + #4206 数字-key 硬化)。重跑 source-run ⇒ 刷新缓存行,零重复。
- **明确口径:T3a 是「staged、upsert-only 的缓存写入」,不是权威全量同步。** 不删除源里已消失的陈旧缓存行、不做 reconcile/对账、不保证缓存 == 当前 ERP 全集。承诺仅:approved source-run 读到的行被 upsert 进缓存。对外/对实体机描述必须用「落缓存(upsert)」而非「全量同步」,避免过度承诺。全量 reconcile(若需要)是独立后续,非 T3a。

## 3.5 实现契约细化（owner re-review — rev 2026-07-15 对齐真实代码）

> 说明:响应契约(②)与空/失败语义(③)已**就地统一进 OD-4 / OD-3**(不再在此追加平行说法)。此处保留 ①④⑤。所有契约均以 http-routes.cjs WIP `922fd2f76` + T2/source-run 真实返回为准。

**① 精确 flag 名（单一,不再留两选）**
`MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED`。默认 OFF;仅规范化字面 `true`（`String(env ?? '').trim().toLowerCase() === 'true'`)为 ON。实现处 `61caf7ff0` 已用此名。**不再保留 `..._SOURCE_AUTOPERSIST_ENABLED` 备选。**

**② 响应契约 → 见 OD-4（已就地统一,不在此重复）**
避免两处说法漂移:OFF 逐字节不变(无 autoPersist 字段)、ON 覆盖 projector 的 dry_run/internalWriteExecuted 并加 T2 真实 evidence、201/200 规则、契约不变式,**全部在 OD-4**(对齐 stock-preparation-erp-material-sync-persist.cjs 真实返回)。

**③ 空输入 / 失败语义 → 见 OD-3（已就地统一,不在此重复）**
空 intake = 422 `SOURCE_RUN_EMPTY`(到不了 persist)、mid-failure = coarse 错误无半成品、全在 **OD-3**(对齐 assertIntakeReady 真实行为)。

**④ steering-reject guard 的精确落点**
新 guard `assertStockPreparationErpAutoPersistNoSteering(req)`(镜像 `assertNoRequestBaseId` 纪律),在 handler 内**紧接 `requireAccess` + flag 判定之后、`loadStockPreparationReadonlySource`(source-run 读 I/O)之前**调用:flag ON 且 `requestBody(req)`/`requestQuery(req)`/`requestParams(req)` 任一含**非空 `tenantId` 或 `projectId`** ⇒ `throw new HttpRouteError(400, 'STOCK_PREPARATION_ERP_AUTOPERSIST_STEERING_NOT_ALLOWED', ...)`。**flag OFF 不调用此 guard**(只读路径行为逐字节不变)。⇒ 拒绝发生在任何外部读/写 I/O 之前,zero side-effect。

**⑤ workspaceId 同租户选择语义(不是 steering 向量)**
`workspaceId` 允许透传,**但它不改租户也不改写目标**:flag ON 下 tenant 恒 `resolveAuthUserTenantId(req)`、写 staging 恒 `resolveIntegrationStagingProjectId(auth-tenant, undefined)`——`workspaceId` **不参与写目标派生**。它仅作认证租户**内部**的 source 配置作用域选择(source-run 读侧沿用现语义)。因此 workspaceId 不是跨租户 steering 向量(改它选不到别租户的写目标),故 ④ 的 guard **只拒 tenantId/projectId,不拒 workspaceId**。若未来 workspaceId 被证实能跨租户选到 source 配置,另立 guard(非本锁范围)。

## 4. 边界（红线）

- **只写 9 内部 MVP 表**(T2 persist 经 `createTargetScopedRecordsApi` 绑定)。**绝不外部写**(C4:不碰 apply-writer/K3 Save/自动建 ERP 物料);`externalWrite` 恒 false。
- 不改 source-run 的只读读取逻辑;不新增端点(在现路由内接线)。
- 不碰其它 source-run/plan/read 路由的租户派生(GHSA step-2)。
- 中央 RBAC 不碰。

## 5. 验证计划（ratify 后实现时）

真库 smoke（plugin-tests.yml 白名单,否则 skip-green）:
1. approved ERP source-run(flag ON,≥1 行)→ `erp_material_master` 出现物理键行(fieldId 取自 `meta_fields` 交叉核,非代码 sha1 派生)+ run 记录 = erp_material_sync;**响应 HTTP 201 + `mode:'internal_persist'` + `evidence.internalWriteExecuted:true` + `autoPersist.persisted=true`**(证覆盖了 projector 的 dry_run/未写)。
2. 重跑同 source-run → 零重复(幂等 upsert);第二次 `autoPersist.mode='refreshed'`,若无变化 HTTP 200。
3. flag OFF → 响应**逐字节等于**只读投影(**无 autoPersist 字段**)、`erp_material_master` **零行**(负控 + 正控:ON 落 OFF 不落)。
3b. **空 intake → 422 `SOURCE_RUN_EMPTY`,零写、无 autoPersist**(证空不是 200-写路径)。
4. values-free leak-bait 双路:公开面 + 错误面无 syncRunId/物料码/名称。
5. 租户 steering **I/O 前拒绝**(flag ON):admin body/query/params 带 tenantId 或 projectId → **400 + 零 source-run 读 + 零写**(在 `loadStockPreparationReadonlySource`/persist 之前 fail-closed)。无 steering 的正常请求 → 落认证租户 staging。flag OFF → 现有读行为不变(不拒绝)。
6. mutation(每处证载荷):去 persist 接线 → 缓存零行;去 steering 拒绝 → steering 测红(且证「在 I/O 前」:mock source-run 应零调用);去 auth-tenant 派生 → 落错租户;flag 去掉 → OFF 也落。
7. flag `MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED` 进 **stock-prep flag 台账 / O-2 运维契约**(非 global-history manifest——那是 Global History 线的),生产默认 OFF。

## 6. 交付物

- 本设计锁(决策已定,RATIFY-ready)。
- 实现（Opus 主循环）:核心接线 `61caf7ff0` WIP 已落 = source-run 路由 flag 条件 tenant + auto-persist(flag OFF inert 已证)。**待补** = flag ON 的 §5 验证(steering I/O 前拒绝 red-first + 真库 smoke + mutation + values-free 双向）。**不 arm/合,独立对抗审后 owner GO**(首次「读→自动写」组合,虽在内部写边界内,建议 owner 点头)。**因 flag 默认 OFF,可在实体机等待期安全合并。**

## 7. 与 T3b 关系 — **T3b 走独立设计门**

T3b（PLM approved source → 服务端直落 project/snapshot/run）= 同构(PLM source-run 的 `intake.plmBomLines` → sync-run persist),但**实体不同、写目标不同(project/snapshot/run vs erp_material_master)、幂等/不可变语义不同**。owner 2026-07-15 裁决:**T3b 单独设计锁,不折进本 T3a 锁**;T3a 落地后串行推进(同写热点不并行)。本锁**只管 ERP→erp_material_master**。
