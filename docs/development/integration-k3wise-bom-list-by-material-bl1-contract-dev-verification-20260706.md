# K3 WISE BOM/GetList-by-material — BL1 契约 — 设计与验证 — 2026-07-06

## 0. 定位

组合线第二跳(material→内码→BOM 号)的实体机 probe 系列(#3652/#3683)把二跳定性为 BL0/caseB
能力缺口,并从客户 K3 WebAPI 文档取得完整请求契约。BL0 锁(#3603)的 BL1 = **契约/config/preset
元数据(Runtime opened: None)**。本轮在 owner 显式"开 BL1"后交付该契约层,**零 runtime、零适配器、
零外呼、零写**。

## 1. 交付

| 件 | PR | SHA |
| --- | --- | --- |
| BL1 契约模块 `read-source-bom-list-by-material-contract.cjs` + 测试 + 接入测试链 | #3689 | `7b9647f78` |

## 2. 契约落点(来自 #3683 客户 K3 文档)

```text
preset=k3wise.bom-list-by-material-id.v1
requiredKind=erp:k3-wise-webapi ; object=material-bom-list ; mode=resolver_lookup
readMethod=POST ; readPath=BOM/GetList ; requestBodyRoot=Data ; selectPage=2
filterField=FPercentItemID (K3 父物料查询列) ; filterDialect=bracketed_field_key_expression
rowContainerPath=Data.DATA (大写) ; outputField=FBOMNumber
resolverRulePolicy=unique_only_fail_closed ; automaticSelectionByStatusVersionDate=false  (owner c126/c127)
entryIdentifierClass=ID  (EII-R0 #3674 + operator 确认)
inputName=FItemID  (hop-1 产出的物料 item id 标量,填入 [FPercentItemID])
runtimeValidated=false ; byMaterialExampleInDocs=false  (文档无 by-material 示例 → BL2/BL3 须真机验)
```

**FItemID vs FPercentItemID 已理清且不矛盾**:hop-1 产出物料的 FItemID 值 → 填入 BOM 查询的
`[FPercentItemID]` 列。inputName=产出标量,filterField=K3 查询列。

8 码族 `K3_WISE_BOM_LIST_BY_MATERIAL_*`(BL0 taxonomy):NOT_CONFIGURED / KEY_INVALID / REJECTED /
FAILED / SHAPE_MISMATCH / NOT_FOUND / AMBIGUOUS / FIELD_MISSING——精确注册集 + safe fallback,
未知/business-shaped token 降级 FAILED,无 regex/prefix 漏洞。

## 3. 验证

- `node __tests__/read-source-bom-list-by-material-contract.test.cjs` OK:purity tripwire(模块源码零
  require/adapter/network/write token)· preset 形状对 #3683 · values-free 扫描(无 host/凭证/长数字)·
  8 码精确族 + fallback · preset-config 谓词。
- node --check 通过;接入 plugin `test` 链,进新 **integration-guard CI lane**(#3660)保护面。
- **owner 审阅 = APPROVE**(head 6d1648660):BL1 边界守住(latent metadata,无 runtime 消费)、
  契约落点准确、FItemID/FPercentItemID 解释正确、8 码精确集无漏洞、测试进 CI 保护面。

## 4. ★ BL2 必须额外锁的(来自 owner 审阅的两条前瞻约束,记档防漂)

BL1 只是 identity + 契约声明。**BL2(适配器读 runtime,下一 opt-in)不得把 BL1 当完整契约校验**,
必须补齐:

1. **完整字段锁**:`isBomListByMaterialPresetConfig()` 现只校 mode/requiredKind/object(BL1 identity
   够用)。BL2 必须额外锁 `readPath / filterField / filterDialect / requestBodyRoot / selectPage /
   rowContainerPath / outputField`,以及 `runtimeValidated false→true` 的**受控转换**——否则会留下
   "配置长得像 preset 但关键字段漂了"的口子(reviewer 明确点名)。
2. **runtime 选择钉死**:BL1 只锁了 dialect + 字段名,**未证明 by-material runtime 可用**。BL2 之前
   须钉死最终的 **filter operator + body field list** 的 runtime 选择;`FPercentItemID` 是文档推得
   (无 by-material 示例),所以 **BL2/BL3 必须真机验证一次**才能把 `runtimeValidated` 翻真。这一点
   BL1 已由 `runtimeValidated=false` 诚实表达。

## 5. BL 阶梯进度 + 下一步

```text
BL0 ✅ 设计锁 #3603
BL1 ✅ 契约/preset 元数据 #3689（本轮）
BL2 🔒 适配器/probe/读 runtime（下一 owner opt-in;须落实 §4 两约束 + 真机验证）
BL3 🔒 打包 + standalone 实体机冒烟（验 FPercentItemID 推断,PASS 才可信）
BL4 🔒 组合复跑 + close-out → 关 #1709
```

## 6. 边界(本轮零跨越)

BL1 零 runtime;写路径/递归/Save-Submit-Audit 全冻结;`FPercentItemID` 未真机证,诚实标 latent;
未与并行 session worktree 冲突。
