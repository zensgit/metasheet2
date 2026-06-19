# 通用对接 (Generic External Integration) 设计锁定 — 2026-06-18

> 状态:**DESIGN-LOCK 草案(待 owner 评审)**。不授权任何 runtime;首笔真实外部写仍是独立 owner gate。
> 目标:出一个**通用对接**能力——接一个新外部系统 = **配一个模版/config**,而非再写一套 bespoke adapter+writer。**PLM BOM 备料 与 K3 WISE 是这套通用流的两个参考模版实例**(它们是我们的集成目标系统,非外部对标品)。
> 依据:通用底座盘点(2026-06-18,/tmp/...substrate map);引用既有件,不重造。
>
> **更新(2026-06-19 · S1a-retire)**:S1a 的"可选写能力"最终落为 **target write profile + 注入式 raw write-source 合同**(planner 经 profile + 写源驱动安全写),**不是** adapter 级 `targetWriteLifecycle`(lookup/apply)。该 method surface 在 S1b 实现中被证明 **orphaned**(S1b-1 seam 只消费 profile + raw 写源,planner 自产 values-free 证据),且在 adapter 上保留 `apply()` 有"绕过 C6 token/revision gate 直接写"的误用风险,**已退役**(S1a-retire PR)。下方 §6.1/§7 中 `targetWriteLifecycle`/`lookup`/`apply`/"evidence 投影"措辞均以此更新为准——S1a 合同 = profile(kind + capability normalize/assert)+ raw write-source(test/lookupByKey/insertRows/updateRows)。

## 1. 现状(盘点结论)

- **已有一套通用 kind-dispatch 适配器底座**:5-method 合同(`testConnection/listObjects/getSchema/read/upsert`,`contracts.cjs`)+ registry(kind→factory)+ `pipeline-runner`(source.read → transformRecord → target.upsert),runner **零 per-system 分支**。
- **源读已接近"配模版"**:通用 SQL / HTTP / staging 源 + `integration_field_mappings`。
- **写侧是三条未收敛的路**(核心问题,安全与覆盖呈反比):
  1. 通用 `targetAdapter.upsert()`——覆盖广(K3 WebAPI / HTTP / multitable 都 on-contract),但**安全薄**;
  2. C6 `external-write` dry-run→apply——**安全厚**(单用 token / revision-fence / per-row 隔离 / dead-letter),但**焊死在 `data-source:sql-write-gated`、绕过 runner**;
  3. PLM stock-prep——脱离合同的 bespoke 编排(BOM 展开/冲突)→ MetaSheet sheet。
- **无 first-class 存储的"集成模版"对象**;de-facto = `integration_pipelines` + `integration_field_mappings` + `external_systems.config`(只捕获字段映射,不含编排与写安全参数)。

## 2. 目标架构:把写侧三条路收敛成一条

通用对接 = 在已有通用底座上,**把写侧收敛为「适配器合同 + C6 安全生命周期(泛化到合同上)+ 一个 first-class 模版对象」**:

- **写路统一**:C6 的 `dry-run → revision-fence → token-apply → per-row → dead-letter` 生命周期,从 `sql-write-gated` 泛化到一个 **target-adapter 可选写能力扩展**(`targetWriteLifecycle` / `safeWrite`,内含 `lookup`/`apply`,与现有 `previewUpsert` 同族)。**关键约束(owner 裁决 2026-06-18):它是 OPTIONAL capability,绝不进 `REQUIRED_ADAPTER_METHODS`——5-method base 合同保持不变,只有 opt-in target 才实现 `lookup`/`apply`;不 opt-in 的 adapter 必须原样通过。** 让 K3 WebAPI / HTTP / multitable 各自 opt-in 同一安全写。
- **模版对象**:一个 declarative 的 `integration-template`,组合 source + target + mapping + orchestration + write-safety 参数;**"实例化" = 从模版生成 pipeline + mappings + system.config**。
- **自描述元数据**:adapter 自声明(label/roles/supports/guardrails),registry 收集,取代手维护的 `ADAPTER_METADATA` 静态字面量。

## 3. K3 / PLM 作为两个参考模版(不对称,需各自处理)

- **K3 WISE**:WebAPI adapter 已是 **on-contract target**(`upsert` on-contract)→ 最接近模版。Submit/Audit/BOM **红线是 essential**,保留为该模版的 guardrail(不开)。S2 让它 opt-in 安全写路(仅 sandbox)。
- **PLM BOM 备料**:现在**脱离合同**(独立 route + writer → sheet)。方向上把它的"合同绕过"**吸收进通用流**;但 **owner 裁决:低优先、渐进吸收,短期不重写已跑通的专用链路**——BOM 展开 / 冲突 / 人工保留字段 / large-BOM checkpoint 是强领域编排,不适合马上塞进普通 pipeline。落点是后续把它泛化到**通用 table-action seam**(已有 latent `apply_to_target_table` kind,无运行时;GAP-6,多数 ERP 接入不需递归展开)。

## 4. 复用(引用盘点 §E,**不重造**)

合同 + registry + dispatch(`contracts.cjs` / `pipeline-runner`);credential store(AES-256-GCM,写只读回 fingerprint);field-mapping + transform + validate(`integration_field_mappings` / `transform-engine` / `validator`,runner 与 C6 共用);**C6 安全原语**(单用 dry-run token、revision fencing、per-row 隔离、`canApply` 仅在完整读+零失败时);并发/游标/watermark guard;dead-letter(values-free, 32KB cap);write-gating + payload-redaction;writable-SQL fail-closed capability。

## 5. 红线 / 不变式

- 凭据仍只经 credential store;UI 只引用 system / dataSourceId,**不复制凭据**。
- **首笔真实外部写 = 独立 owner 授权**;sandbox-first 序列:多样本只读 dry-run → sandbox apply → re-pull 幂等 + 人工字段保留 → 生产。
- 两阶段 dry-run → apply;per-row 隔离,**不 batch-abort**;**无自动重试打爆**;dead-letter 收口。
- **K3 Submit/Audit/BOM 红线不开**。
- issue 上 **values-free**。

## 6. Gated 切片序(每刀:独立 opt-in + 独立 PR + 设计/实体机验证;**contracts-first**)

| 刀 | 内容 | 风险 | gate |
|---|---|---|---|
| **S1a (合同层)** | 定义 target 的**可选**写能力扩展 `targetWriteLifecycle`(`lookup`/`apply`,抽象 C6 planner write 原语);**不进 `REQUIRED_ADAPTER_METHODS`**;enum-strict、result **values-free**(opaque keyHash/revisionHash、code-only errorCode、无 free-text error、metadata number\|boolean\|null)、**不接 runtime**(见 §6.1)。注:这是 **plugin-local 内部合同,无公开 API surface,OpenAPI 不适用** | 低 | lock-safe 合同,可直接评审 |
| **S1b (keystone)** | 让 **`metasheet:multitable`**(自有 sheet)target 实现该能力面 + 走 C6 `dry-run→apply` 生命周期 —— 证明"安全写能脱离 `sql-write-gated` 泛化",**零外部写、纯 sandbox** | 低(自有 target) | opt-in |
| **S2** | **K3 WebAPI** target opt-in 同一安全写路(on-contract,红线保留),仅 sandbox | 中 | opt-in + 实体机 |
| **S3** | first-class `integration-template` 对象 + 实例化(从模版生成 pipeline+mappings);K3 / PLM 各出一个参考模版 | 中-大 | opt-in |
| **S4** | adapter 自描述元数据(替换 `ADAPTER_METADATA` 静态字面量) | 小 | opt-in |
| **S5** | 统一 field-mapping(generic vs stock-prep `fieldIdMap`);PLM stock-prep 编排吸收进通用 table-action seam | 中-大 | opt-in |
| **首笔生产外部写** | S1-S3 sandbox 验证齐 + **owner 显式授权**后,单独一刀,走 sandbox-first 序列 | 最高 | **owner 授权** |

### 6.1 S1a 锁定约束 + 验收(owner 裁决 2026-06-18)

**锁文本(逐字)**:
> Target lookup/apply is an optional capability extension, not a replacement for or expansion of the required 5-method adapter contract. `REQUIRED_ADAPTER_METHODS` remains unchanged. Non-opt-in adapters must continue to pass unchanged.

**验收(S1a 必过)**:
1. `adapter-contracts.test` 证明**旧 adapter 不实现 `lookup`/`apply` 仍通过**(5-method base 合同不爆)。
2. 一个 **opt-in 假 target** 实现新能力,锁住:enum-strict、result **values-free**、**no runtime wire**(S1a 绝不接真实写)。
3. **result values-free 形态(逐 vector canary 锁)**:result 流向 UI / issue evidence,故只携带不可逆/受控字段——
   - key → **opaque `keyHash`**(投影到声明的 keyFields 后 sha256);
   - revision → **opaque `revisionHash`**(sha256;保留**相等性**,故 dry-run→apply 的 revision-fence 仍可判漂移);
   - **不携带 free-text `error`**(DB 错误会内嵌行值);人类可读原因改落 **dead-letter**(`sanitizeIntegrationPayload`,32KB cap)——**relocated, not lost**;
   - `errorCode` 受 **CODE charset `[A-Z0-9_]{1,64}`** 约束(允许全数字 SQLSTATE 如 `42501`)——这是**纵深防御 + canary 锚点**,不是硬结构保证(`WIDGET`/`123456` 也能过),合同仍依赖 adapter 传稳定常量;
   - `metadata` 仅 **number\|boolean\|null**(拒绝字符串与嵌套——字符串可能藏行值)。
   canary 须对每个 vector(key/error/revision/metadata)各种一颗 PII/secret/行值,断言不出现在 wire。

C6-gated adapter 在 S1a 后**仍不自动 runtime 写**。

> **S1b 衔接**:lifecycle result = **code-only 分流类**(status + errorCode);**sanitized 人类可读 detail 落 dead-letter**,不进 result。S1b runtime 必须按此分流,不得把 free-text 原因塞回 result/evidence。

## 7. 首步建议(keystone)

**S1a 合同层先行**:定义 target-adapter 的 `lookup`/`apply` 能力面(把 C6 planner 硬编码的 `dataSourceWrites.lookupByKey/insertRows/updateRows` 抽象成合同方法),enum-strict + result values-free-locked(plugin-local 内部合同,无公开 API surface,OpenAPI 不适用),**不 wire runtime**——纯 lock-safe 合同,可直接评审。它是整条收敛的 **keystone**:解锁后 S1b 用自有 `metasheet:multitable` target 验证"安全写生命周期能脱离 `sql-write-gated` 泛化"(零外部写),再逐个让 K3 / HTTP opt-in。风险最低、解锁面最大。

**owner 裁决(2026-06-18)**:① 收敛方向**认可**;② 切片序**认可**,但 S1a 必须是**可选能力面**(§6.1 锁文本 + 两条验收);③ PLM stock-prep "合同绕过吸收进通用流"**认可为方向**,低优先、渐进吸收,短期不重写专用链路(§3)。

**下一步 = S1a 合同层先行(不是继续 C6-3)**:若按旧形态继续 C6-3,会把 `data-source:sql-write-gated` 专用路再焊深一层;先落 S1a,后续 C6-3 可直接走通用安全写能力面。
