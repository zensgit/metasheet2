# Read-source resolver + remaining-scope — 开发及验证报告 — 2026-07-03

> 记录 #1709「未开部分全开」这一轮的 as-built:哪些**建了**、哪些**设计锁了**、哪些**仍 gated 且我不单方面建**。边界 = owner 授权 + 客户显式禁 + 可逆性。

## 1. 背景

resolver_lookup 从契约到运行时已闭合(R0+R1+R2,owner 授权,前几轮落地)。本轮目标是把「仍未开」的剩余项——R3/UI、composition、递归 BOM、Save/Submit/Audit、外部写、生产写——**各自推到安全的最大里程碑**。这些项性质分三类,处置不同(见 §4)。

## 2. 本轮 as-built(PR/SHA)

| 项 | 性质 | 处置 | PR | SHA |
| --- | --- | --- | --- | --- |
| R3 resolver 配置 UI | 前端配置授权(读侧,可逆) | **BUILD** | #3533 | 44eb8a989 |
| resolver composition(material→FItemID→FBOMNumber 链)+ 递归 BOM | 读侧链接,复杂(设计先行) | **DESIGN-LOCK** | #3532 | 1bbc402e5 |
| Save/Submit/Audit · 外部写 · 生产写 | 不可逆 ERP 写,客户今天显式禁 | **HOLD**(W0 方向锁已备,build 未做) | — | — |

前置(前几轮已合并):R0 #3520 (a35c9db3b) · R1 #3525 (54decfd25) · R2 #3526 (0c40d70a4) · evaluator 注释对齐 #3528 (ffa05d987) · 写回 W0 方向锁 #3515 (e784aa4f4) + token 措辞修 #3518 (856e6d468)。

## 3. 已建/已锁明细

### 3.1 R3 resolver 配置 UI(BUILD,前端-only)
IntegrationReadSourceConfigPanel.vue + readSourceConfigs.ts:mode=resolver_lookup 时按 rule 显隐输入——exactly_one 隐藏三项;first_when_sorted 显 sort 字段+方向;field_equals 显判别字段+值(bounded token)。save-payload 只带 rule 相关键(禁用项不发,与 R0 校验器一致)。server 400 粗粒度 field+reason 不回显值。顺手修 R0 遗留的 client MODE_REQUIRED 漂移。验证:panel 19/19、workbench 79/79、type-check、lint。**server(R0)保持权威,无运行时/写。**

### 3.2 composition + 递归 BOM 设计锁(DESIGN-LOCK,授权零代码)
`docs/development/integration-read-source-resolver-composition-design-lock-20260703.md`。锁:bounded 有序 approved 配置链 · typed 单值 handoff(step N 的 resolver 输出→step N+1 声明键,非行/列表/自由载荷)· 运行时仅带首步键(中间键平台派生)· per-hop + chain fail-closed(0/1/>1,不按 status/version/date 自动选)· values-free 拼接证据(中间 FItemID 不暴露,data 仅末步输出)· read-only(写形步拒)· 幂等重读。递归 BOM 单列后置(fan-out/环检测/逐级预算)。阶梯 C-R0→C-R1 配置→C-R2 planner→C-R3 运行时,各 opt-in。

## 4. 分类判据 + 为何写路径 HOLD

- **A 类可安全建**:R3 是读侧配置授权 UI,server 权威、无写、可逆 → 建。
- **B 类设计先行**:composition/递归 BOM 虽读侧,但引入依赖排序/数据面 handoff/部分失败/证据拼接/多次出站幂等——设计锁 #3479 本身写明「composition 是 later design-lock」→ 出设计锁。
- **C 类 HOLD(我不在"全开"上单方面建)**:Save/Submit/Audit、外部写、生产写。理由三条:①**不可逆**——写真实 ERP 系统记录,写错即别人生产库数据损坏;②**客户今天(2026-07-03,adharamans on #1709)显式禁**:SaveSubmitAuditK3Write=false / externalWrite=false / productionWrite=false;③**整条线的安全模型**要求 sandbox-first 阶梯(dry-run→sandbox apply→re-pull 幂等→逐次 owner 生产门,W4),这是 C6 纪律的存在理由。这些项**已有 W0 方向设计锁(#3515)**;往下 build 需**你/客户显式授权 + sandbox-first**,不由一句"全开"解封。

## 5. 仍待 owner/客户决定(gated 清单)

- **composition build**:C-R1(链配置模型)是下一刀,需 opt-in(设计锁已备)。
- **递归 BOM**:单独设计锁 + build,各 opt-in。
- **写路径 build**:API 写回 W1→W4,需显式授权 + sandbox-first;生产写 W4 逐次 owner-gated。客户今天的禁令未撤。

## 6. 当前基线(canonical)

resolver:R0+R1+R2 运行时闭合(standalone read)+ R3 配置 UI。composition/递归 BOM = 设计锁已备、build gated。写路径 = W0 方向锁已备、build gated(客户禁 + sandbox-first 前置)。**没有任何不可逆的生产写被本轮建出或解封。**

## 7. 实体机 standalone resolver smoke addendum(2026-07-04,#1709)

本节固化 #1709 operator 回传的 values-free 实体机证据。它验证的是**当前 R2 standalone resolver_lookup 运行时**,
不是后续 material→FBillNo composition 链,也不是 C3 LIST marker/list 语义。

### 7.1 部署包

| 项 | 证据 |
| --- | --- |
| package | `metasheet-multitable-onprem-v2.5.0-resolver-standalone-20260703-17688041f.zip` |
| packageContainsMainSha | `17688041f` |
| zipChecksum | PASS |
| deployApplyExit | 0 |
| healthcheck | PASS |

### 7.2 Smoke config shape(values-free)

```text
mode=resolver_lookup
readPath=/K3API/Material/GetDetail
keyField=FNumber
containerPaths=Data
resolverRule=exactly_one
fieldMap.source=Data.FItemID
fieldMap.target=resolved_item_id
getDetailContainerShape=Data array length 1; row.Data contains FItemID:number
```

### 7.3 PASS evidence(values-free)

```text
resolverStandaloneSmoke=PASS
loginHttp=200
externalSystemsHttp=200
k3SystemLocated=true
saveConfigHttp=201
approveHttp=200
runtimeHttp=200
evidenceOk=true
rule=exactly_one
containerLocated=true
candidateCount=1
resolved=true
resolverDataPresent=true
sampleKeyEchoed=false
resolvedValueEchoed=false
rawPayloadIncluded=false
postRetireRead=409_READ_SOURCE_CONFIG_NOT_APPROVED
valuesFreeEvidence=true
```

Boundary held:

```text
compositionExecuted=false
bomExecuted=false
recursiveBomExpansionExecuted=false
writeExecuted=false
thisSmokeAuthorizesComposition=false
thisSmokeAuthorizesListResolverSemantics=false
thisSmokeAuthorizesRecursiveBom=false
thisSmokeAuthorizesSaveSubmitAudit=false
thisSmokeAuthorizesExternalWrite=false
thisSmokeAuthorizesProductionWrite=false
```

### 7.4 Updated disposition

R0+R1+R2+R3 现在是 **built + entity-machine verified for standalone resolver_lookup**。
剩余 gate 不变:material→FBillNo composition、递归 BOM、Save/Submit/Audit、外部写、生产写,
均需要各自单独 owner opt-in。
