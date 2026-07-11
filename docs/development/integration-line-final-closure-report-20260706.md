# 数据库及系统连接线(原 #1709)——最终收尾报告 — 2026-07-06

## 0. 结论

**本线按三层 DoD 收尾**(closure plan `docs/development/integration-line-closure-plan-20260705.md`
为权威地图):A 能力关键路径 `**A5 = BL4 组合复跑 PASS(2026-07-06)**,materialNumber→FItemID→FBOMNumber 全链实体机端到端证明`;B 质量收尾五项全绿;C 治理收尾三项全绿,
#1709 已关闭重组(162 评论演进史保留)。

## 1. 三层 DoD 终态

### A 能力关键路径

```text
A1 ✅ 二跳失败定位(#3652 三轮 probe → BL0/caseB)+ 客户契约取得(#3683)
A2 ✅ BL1 契约(#3689/#3691)+ pre-BL2 硬件验证 PASS(#3683)
A3 ✅ BL2 读 runtime(#3695;对抗审阅 APPROVE 零 P1/P2;mutation 5/5)+ 翻真 #3702
A4 ✅ BL3 standalone 实体机冒烟 PASS(#3701;happy path + AMBIGUOUS 策略双证据)
A5 ✅ BL4 组合复跑 PASS(#3703,2026-07-06)
```

**A5 证据(#3703 实体机回贴,values-free)**:

```text
release=multitable-onprem-bom-list-bl4b-20260706-eecd0c209(sha256 核对 ✔)
数据面翻页:probePagesScanned=3(hit-stop)· dataPlaneRowsSeenBucket=gt10
候选清查:candidateChecksBucket=gt10 · NOT_FOUND=gt10 · AMBIGUOUS=2-10 · 其他失败=0
命中:singleBomCandidateFound=true · candidateCountBucket=1
组合:compositionRunHttp=200 · compositionEvidenceOk=true · BL4HappyPath=PASS
fail-closed 双证据:组合级 AMBIGUOUS(前轮)+ 候选清查分桶(本轮)——8 码族按 BL0 设计实战履职
边界:11 项全 false,4 轮回贴零业务值(含 private config IDs 不出屏)
```

### B 质量收尾(全绿)

```text
B1 ✅ integration-guard CI lane(#3660)——插件 CJS 全链 + 定向 web specs 首次进 CI
B2 ✅ W1 = 契约层完成、runtime 冻结(§8.3;写轨道 W0 锁 #3515 与 W2+ 门原样保留)
B3 ✅ stale 注释清零(#3661)
B4 ✅ 冒烟姿态声明(§8.1,dispatch-only = 有意姿态)
B5 ✅ :id/read runtime-tier-only 即终态(§8.3)
```

### C 治理收尾(全绿)

```text
C1 ✅ #1709 线级 close-out + CLOSED;残余 gate 迁卫星(BL4→#3703 · W2+→#3515 轨 · 递归→REC-R0)
C2 ✅ #1711 CLOSED(superseded by DF-T3 reference-mapping);#2777/#2438/#2642 独立 infra 轨
C3 ✅ gated 池冻结清单(§8.2)——冻结即完成
```

## 2. 本次收尾冲刺交付账(2026-07-06 单日)

| 件 | PR/issue | 落点 |
| --- | --- | --- |
| BL1 契约 + MD | #3689 / #3691 | 7b9647f78 / (docs) |
| pre-BL2 硬件验证 PASS | #3683 | 实体机直连确认 |
| BL2 读 runtime + MD | #3695 / #3700 | 1e18f85d5 / 732edd120 |
| BL3 打包 + 冒烟 PASS + 翻真 + MD | #3701 / #3702 / #3704 | release …bl3…-1e18f85d5 / ef2ad42ff / ee7177e78 |
| BL4 执行单 + fail-closed 组合级证据 | #3703 | AMBIGUOUS via composition,policyConsistent |
| 有界 LIST pageIndex(evidence 面) | #3709 | 577cda6a4 |
| 有界 pageIndex 数据面输入 | #3727 | eecd0c209 |
| BL4 组合复跑 PASS + 执行单关闭 | #3703 / #3701 | 实体机证据 + CLOSED |
| B2/B5 声明 + C2 同步 | #3712 | 2d2faca48 |
| C1 落账 | #3725 | a2dea3a82 |
| checklist 同步×3 | #3692/#3704/#3712/#3725 | 权威地图与 main 一致 |

## 3. 工程质量纪律(本冲刺全程)

- **staged opt-in**:BL1→BL2→BL3→BL4 每级单独 owner opt-in;option-2 pageIndex 双半皆经授权。
- **对抗审阅 + mutation**:BL2 refute-first APPROVE;三轮 mutation 共 11/11 KILLED(含一次
  marker-gate 混叠修复与一次 checkout-陷阱自纠,均已记入长期 memory)。
- **values-free 全程**:实体机 4 轮回贴零业务值泄漏;evidence 契约 + 8 码族按 BL0 设计实战运作
  (AMBIGUOUS 在 standalone 与组合两层正确浮出)。
- **边界零跨越**:写/递归/Save-Submit-Audit/delete/生产写全程冻结;实体机拒绝服务器内部凭证访问
  (option 3 DECLINED)。

## 4. 后续(不属本线)

- 写自助化 W2+(W0 锁 #3515 轨,逐级 opt-in)
- 递归 BOM 展开(REC-R0 双门)

## 5. 权威文档索引

BL0 锁 / BL1-BL3 dev-verification MD ×3 / 组合 E2E runbook / closure plan(含 §8.1-§8.3 姿态声明)
——均在 `docs/development/`,commit 索引见 §2 表。
