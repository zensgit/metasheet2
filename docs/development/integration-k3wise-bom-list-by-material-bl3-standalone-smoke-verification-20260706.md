# K3 WISE BOM/GetList-by-material — BL3 standalone 实体机冒烟 — 验证记录 — 2026-07-06

## 0. 定位

BL0 阶梯(#3603)第四级 **BL3 = 打包 + standalone 实体机冒烟(仅操作验证,零新 runtime)**。owner
显式「开 BL3」并要求实体机配合走 issue;执行单 = **#3701**。这是 BL0 **standalone-first 门**的正体:
组合复跑(BL4)之前,新读能力必须先以 standalone 形态在真机证明。

## 1. 交付链

| 件 | 落点 |
| --- | --- |
| 打包(main@`1e18f85d5`,含 BL2) | release `multitable-onprem-bom-list-bl3-20260706-1e18f85d5`(run 28776177601,10 资产:tgz/zip+sha256+SHA256SUMS+meta+verify×4) |
| 实体机执行单 | #3701(配置 JSON、run 指引、key 判据、values-free 模板、边界) |
| 冒烟证据 | #3701 实体机回贴(2026-07-06,全 values-free) |
| runtimeValidated 受控翻真 | #3702 `ef2ad42ff` |

## 2. 实体机证据(#3701 回贴,原样摘录)

部署与配置链:

```text
packageSha256=32522898…afe14cf ✔ · deployRemoteExit=0 · applyExit=0 · healthHttp=200
readSourceConfigSaveHttp=201 · readSourceConfigApproveHttp=200
```

**Happy path(单 BOM 父物料)**:

```text
bomListByMaterialSmoke=PASS
runtimeHttp=200 · evidenceOk=true
inputName=FItemID · endpointClass=GetList
candidateCount=1 · resolved=true · resolverDataPresent=true · rule=exactly_one
```

**Fail-closed 策略双证据(多 BOM 父物料)**:

```text
multiBomParentTried=true · runtimeHttp=200
errorCode=K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS
candidateCount=2-10 · policyConsistent=true
```

边界声明全 false(inputEchoed / fbomNumberEchoed / rawPayload / credentials / hostSystemTenantIds /
connectionStrings / recursiveBomExpansion / SaveSubmitAudit / externalWrite / productionWrite)。

## 3. 判读

1. **BL0 standalone-first 门 = PASS**。BL1 时的唯一不确定点(文档无 by-material 示例)经两级真机
   证明闭合:pre-BL2 直连验证(#3683)→ BL3 平台全链(config 审批 → runtime → adapter → K3 →
   resolver)。
2. **8 码族实战首验**:多 BOM 父物料在真机浮出 `K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS`——二跳
   失败不再坍缩为 generic 码,BL0 taxonomy 的设计目的在生产形态达成。
3. **unique-only fail-closed(owner c126/c127)按锁定行为运作**:AMBIGUOUS 是策略正确输出,非缺陷;
   双证据(PASS + AMBIGUOUS)同时坐实 happy path 与 fail-closed 两面。
4. **受控转换履约**:`runtimeValidated` 仅在本轮证据后翻真(#3702),兑现 owner 审阅约束①的转换锁;
   `byMaterialExampleInDocs=false` 保留(文档事实不变)。

## 4. BL 阶梯进度

```text
BL0 ✅ 设计锁 #3603
BL1 ✅ 契约 #3689 + MD #3691 + pre-BL2 硬件验证 PASS(#3683)
BL2 ✅ 读 runtime #3695 + MD #3700(对抗审阅 APPROVE;mutation 5/5)
BL3 ✅ 打包 + standalone 实体机冒烟 PASS(#3701)+ runtimeValidated 翻真 #3702(本轮)
BL4 🔒 组合复跑(materialNumber→FItemID→FBOMNumber)+ close-out → 关 #1709
      门:owner 单独 opt-in。组合链本身已 wired(C-R1..C-R4);二跳能力缺口已由 BL2/BL3 补齐,
      复跑用既有组合 E2E runbook(integration-composition-entity-e2e-runbook-20260705.md)+
      新包重放,PASS 判据 = compositionSmoke=PASS + evidenceOk=true + 中间值零暴露。
```

## 5. 边界(本轮零跨越)

BL3 零新 runtime(翻真为 latent 元数据,无 runtime 消费);写/递归/Save-Submit-Audit/生产写全冻结;
BL4 未被本轮授权。
