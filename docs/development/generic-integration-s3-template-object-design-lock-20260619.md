# 通用对接 S3 — first-class integration-template 对象 设计锁定(2026-06-19)

> 状态:**DESIGN-LOCK 草案(待 owner 评审)**。不授权任何 runtime / migration;impl 是后续独立 opt-in。
> 上游:`generic-integration-design-lock-20260618.md` §6 S3。基础 = 已落地的 S1b 收敛(C6 安全写经 target write profile + raw write-source 泛化;见 `…plan-and-verification-20260618.md`)。
> 目的:把 §6 的 S3(first-class `integration-template` 对象 + 实例化)从"一刀"细化为**可评审设计 + 开放裁决项 + 分刀计划**。S3 是 中-大 弧,**设计锁先行**(同 S1a/S1b)。

## 1. 现状(盘点结论)

- **de-facto 模版 = 三件分布式拼装**:`integration_pipelines`(migration 057)+ `integration_field_mappings`(057)+ `integration_external_systems.config` JSONB(057);各有 registry CRUD(`pipelines.cjs` / `external-systems.cjs`)+ routes(`http-routes.cjs`)。它捕获**字段映射**,但不含**编排 + 写安全参数**,且"配一套"要手动连接三处。
- **三个 latent 模版 helper(schema-only,非 first-class)**:`connector-template-derive.cjs`(DF-T2a payload 模版派生,纯计算)、`reference-mapping-templates.cjs`(DF-T3a 参考映射 schema 规范化 + 空 sheet 结构)、`stock-preparation-templates.cjs`(DF-C1 stock-prep 表模版)。三者都是 normalize + 结构派生工具,**无存储、无 CRUD、无实例化**。
- **无 first-class 存储的"集成模版"对象**。

## 2. 目标:一个 declarative 的 first-class 模版对象 + 实例化

`integration-template` = 一条 declarative 记录,组合 **source + target + mapping + orchestration + write-safety 参数**;**"实例化" = 从模版原子生成 pipeline + field-mappings + system.config**(三件拼装自动化)。K3 WISE / PLM BOM 各出一个**参考模版实例**。

## 3. 开放裁决项(owner 必须先签)

S3 触及一个**新存储对象 + migration**,以下语义必须 owner 先裁,impl 才能机械执行:

1. **实例化原子性**:template→(pipeline + mappings + system.config)必须 all-or-nothing。是用单事务跨三表写,还是 saga + 补偿?**推荐:单 DB 事务**(三表同库,057 同迁移);失败整体回滚,不留半实例化。
2. **模版版本 vs 已实例化 live pipeline**:模版改了,已从它实例化的 live pipeline 怎么办?**推荐:实例化 = snapshot(拷贝语义),live pipeline 与模版解耦**(模版后续变更不回溯改 live pipeline);模版记 version,实例记 `instantiatedFromTemplateId + templateVersion` 供追溯,但**不自动 re-sync**。(否则改模版会静默改生产 pipeline = 危险。)
3. **参考模版注册**:K3 WISE / PLM BOM 参考模版是**baked-in 示例**(opt-in 注册,不默认推给所有租户),还是随插件装?**推荐:opt-in 注册的示例**,不默认实例化。
4. **写安全参数承载**:模版的 write-safety 参数 = 引用 S1b 的 **target write profile**(per-kind),不在模版里重定义安全策略。模版只选 target kind + object + keyFields/mappings;安全写仍走 C6 + profile。
5. **S3 ↔ S2 依赖**:K3 参考模版的 target = K3 kind。K3 安全写(S2)仍 gated(实体机 + 红线)。**S3 可先落 multitable 参考模版**(已 sandbox-ready),K3 模版的 runtime 写等 S2。即 S3 存储/实例化与 S2 解耦:模版可引用任意 kind,实际写仍受该 kind 的 gate。

## 4. 触点(盘点 §3-§4)+ 与 S4 无冲突

- **新增**:`lib/integration-templates.cjs`(normalizer + CRUD + 实例化)、`migrations/058_create_integration_templates.sql`(`integration_templates` 表)。
- **改**:`http-routes.cjs`(+5 routes:list/get/upsert/instantiate/delete + handlers;ROUTES 数组尾 + 新 handler 区,与 S4 的 `ADAPTER_METADATA`/`adaptersList`/`describeAdapterKind` 区**不相交**)、`index.cjs`(registry 装配 + communication API)、`pipelines.cjs`(暴露内部 `createPipelineFromTemplate` 组合 helper,**无签名变更**)。
- **不碰** `contracts.cjs` 的 adapter registry(S3 只 `listAdapterKinds()` 读校验 target kind 存在);故 **S3 与 S4(改 registry + ADAPTER_METADATA)在 `contracts.cjs` 零冲突,在 `http-routes.cjs` 区段不相交**。

## 5. 分刀计划(每刀 opt-in + 独立 PR + 审阅;contracts/storage-first)

> 前置:本设计锁经 owner 签字(§3 开放裁决项)。

- **S3-1(contract + storage)**:`integration_templates` 表(migration 058)+ normalizer + CRUD(upsert/get/list/delete),**不含 instantiate**;routes 只挂 CRUD。验收:迁移可前/后向、normalizer enum-strict、CRUD round-trip、values-free。
- **S3-2(实例化)**:`instantiateTemplate` = 单事务生成 pipeline + mappings + system.config(§3-1 原子性);snapshot 语义(§3-2);route `POST …/instantiate`。验收:原子(失败整体回滚)、snapshot 不回溯 live pipeline、wire-vs-fixture 集成测试断真实 route。
- **S3-3(参考模版)**:multitable 参考模版示例(sandbox-ready);K3/PLM 模版**记录但 runtime 写 gated**(K3 等 S2,PLM 见 S5)。opt-in 注册。

## 6. 红线 / 不变式

- 实例化**只写我们自己的 config 表**(pipelines / mappings / external_systems.config),**不写任何外部系统**;实际外部/sandbox 写仍走 C6 + profile(本刀不碰)。
- 凭据只经 credential store;模版**不存凭据**(只引用 system / dataSourceId)。
- **首笔真实外部写仍 = 独立 owner 授权**;S3 不解锁它。
- K3 Submit/Audit/BOM 红线不开;K3 模版 runtime 写 = S2 gate。
- values-free;**改模版不静默改已实例化的 live pipeline**(snapshot)。

## 7. 不做什么(防 scope 漂移)

- 不改 `REQUIRED_ADAPTER_METHODS`;不动 S4 的 adapter registry/metadata;不重写 PLM stock-prep(S5,短期不重写);不开 K3 runtime 写(S2);不开首笔生产外部写(owner)。
