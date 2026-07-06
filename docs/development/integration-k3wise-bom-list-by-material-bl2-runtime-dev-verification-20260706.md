# K3 WISE BOM/GetList-by-material — BL2 读 runtime — 设计与验证 — 2026-07-06

## 0. 定位

BL0 阶梯(#3603)第三级 **BL2 = 适配器/probe/读 runtime,开放且仅开放一个 allowlisted 只读
lookup**(material-bom-list 的 `BOM/GetList` by `FItemID`)。前置双门均满足后 owner 显式「开 BL2」:
BL1 契约(#3689/#3691)+ **pre-BL2 硬件验证 PASS**(#3683,2026-07-06:`[FPercentItemID]` 过滤被
K3 接受、已知父物料返回 2-10 行、`Data.DATA` 容器与 `FBOMNumber` 字段在真机确认)。

## 1. 交付

| 件 | PR | SHA |
| --- | --- | --- |
| BL2 runtime(adapter 新读模式 + 契约锁 + 族码 + 测试 + 接入测试链) | #3695 | `1e18f85d5` |

## 2. 设计落点

### 2.1 单一契约锁点(owner 审阅约束①)

`normalizeReadSourceProbeContract`(S2-b probe 与 configured read **双路必经**)对 preset identity
(resolver_lookup + erp:k3-wise-webapi + material-bom-list)强制**全字段锁**
(`bomListByMaterialContractViolation`,BL1 模块纯函数):

```text
keyField=FPercentItemID · keyEncoding=numeric_id · readMethod=POST
readPath 尾缀 /BOM/GetList(部署前缀如 /K3API 属外部系统注册配置)
containerPaths ≡ ['Data.DATA'] · resolverRule=exactly_one(unique_only_fail_closed,owner c126/c127)
fieldMap ≡ [{source: FBOMNumber, …}]
```

漂移 → 值自由 coarse token(`bom_list_by_material_*_drift`)抛错,**先于 overlay/adapter 存在**。
identity 之外的 resolver_lookup(如 hop-1 material→FItemID)完全不受影响(identity-negative 有测试)。

### 2.2 Runtime 钉死(owner 审阅约束②)

filter 操作符、body 根、字段全集 **config 完全无法表达**——adapter 模式内常量(最强锁形态):

```text
POST <readPath>  body = { Data: { Top:10, PageSize:10, PageIndex:1,
  Filter: '[FPercentItemID] = <digits>', OrderBy:'', SelectPage:2, Fields:'FBOMNumber' } }
```

key 强制 `^[0-9]{1,20}$`(BL0 锁:FItemID 数字型,非数字**在任何外呼(含 login)之前**失败)→
过滤值为裸校验数字,**零引号/转义/表达式注入面**。

### 2.3 可达性与只读

- 新 adapter 读模式 `bom_list_by_material` 由 **Symbol marker** 门禁(同 C3/C4 纪律):JSON body、
  持久化 adapter config、source-action config 均无法伪造,仅 read-source runtime builders 可达。
- 单次 GetList;无 GetDetail、无递归、无写方法、无 Save-Submit-Audit;请求仅 `{inputs:{key}}`。
- 多重性:复用 shared resolver evaluator,unique-only fail-closed——**永不 first-row-wins**。

### 2.4 错误族(BL0 taxonomy)

8 码族 `K3_WISE_BOM_LIST_BY_MATERIAL_*` 精确注册进 probe evidence 码集;resolver 失败精确映射
(NO_MATCH→NOT_FOUND、AMBIGUOUS/CAP_REACHED→AMBIGUOUS、FIELD_MISSING、SHAPE_MISMATCH/
CONTAINER_NOT_FOUND→SHAPE_MISMATCH、其余→FAILED);classify 层精确集直通(无 prefix)。二跳失败
从此有自己的族,不再坍缩为 generic resolver/composition 失败。

### 2.5 runtimeValidated 受控转换

BL2 **保持 `runtimeValidated=false`**(有测试钉住)。翻真仅发生在 BL3 standalone 实体机冒烟 PASS
之后(BL0 standalone-first 门)。

## 3. 验证

- 新 hermetic 测试 `read-source-bom-list-by-material-runtime.test.cjs`(接入 plugin `test` 链 +
  integration-guard CI lane #3660):契约漂移 ×10 fail-closed(先于 adapter)· **真 adapter fetch 级
  pinned body 精确断言**(wire-vs-fixture 纪律)· 注入形 key ×6 → 零外呼 · 族码全分支 · 值自由扫描
  (key/BOM 值/host/凭证/K3 message)· 单 GetList、无 GetDetail/写/递归 · marker/filters/options/
  limit 门 · identity-negative(hop-1 不受锁/remap 影响)· `runtimeValidated` 钉 false。
- **本地全链**:plugin-integration-core `pnpm test` 全绿(66 suites;该链不在主 CI,本地跑过 +
  integration-guard lane 覆盖)。
- **Mutation 证明 5/5 KILLED**:数字键守卫 / 操作符 pinning / 全字段契约锁 / 族码 remap / marker 门。
  其中 marker 门首轮 SURVIVED——limit 守卫同族码**混叠**顶掉了 marker 断言;修测试(limit=10 使
  marker 成唯一变量)后 KILLED。教训:同族 coarse 码的多守卫路径,负控测试必须逐门隔离变量。
- **对抗审阅**(Opus subagent,refute-first,/tmp/pr3695-review-claude-20260706.md):**APPROVE,
  零 P1/P2**。攻击面全守住:三路(probe/read/组合)均汇入契约锁点、非 identity 配置无法转入新模式
  (Symbol marker 不可序列化 + configMode 双门)、注入形 key 零外呼、族码精确集无 prefix、BL1 purity
  tripwire 复核仍咬(注入 require → 测试红)、package.json 链 65→66 UNION。3 条 NIT 已修 2
  (key 数字分支 `Number.isSafeInteger` 防精度损失串码、evidence sentinel 补 tenant/systemId);
  NIT-3(scope guard limit 下界)不加——上游 `normalizeLimit` 已强制正整数,冗余守卫徒增噪音。
- CI:全绿(integration-guard lane 含新测试)+ admin-merge 落 main `1e18f85d5`。

## 4. BL 阶梯进度 + 下一步

```text
BL0 ✅ 设计锁 #3603
BL1 ✅ 契约 #3689 + MD #3691;pre-BL2 硬件验证 PASS(#3683)
BL2 ✅ 读 runtime #3695(本轮)——runtimeValidated 仍 false(诚实 latent)
BL3 🔒 打包 + standalone 实体机冒烟(下一 owner opt-in;PASS 后 runtimeValidated 才可翻真)
BL4 🔒 组合复跑 + close-out → 关 #1709
```

**BL3 注意事项(硬件验证的多行信号)**:#3683 显示已知父物料返回 **2-10 行** BOM——unique-only
fail-closed 策略下,多 BOM 父物料的 standalone 冒烟会**正确地**返回 AMBIGUOUS(这是锁定策略的既定
行为,不是缺陷;automaticSelectionByStatusVersionDate=false,owner c126/c127)。BL3 冒烟建议:
用单 BOM 父物料证 happy path,或将 AMBIGUOUS 作为多 BOM 父物料的预期 PASS 判据写进冒烟脚本。

## 5. 边界(本轮零跨越)

写路径/递归/Save-Submit-Audit/delete/生产写全冻结;`BOM/GetDetail` 行为零变化;host-allowlist 零
放宽;BL3/BL4 各为独立 owner opt-in。
