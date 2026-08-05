# B4 绑定物草案 — K3 WISE material-list 读绑定(待 RATIFY)

> 状态:**DRAFT — 待 owner RATIFY**。本文件是 S5 的批准对象;代码层冻结已由
> `read-source-k3-material-list-b4-contract.cjs` + 其测试(链内)承载,本文只陈述与对照,
> 不另立记录点。RATIFY 后本节头改为 RATIFIED 并注 SHA。

## 1. 四参数(对应裁决点名的 profileId/configVersion/数据子集/行数上限)

| 参数 | 值 | 载体与依据 |
|---|---|---|
| profileId(= `actionProfileVersion`) | **`k3wise.material_list.v1`** | 合同模块常量。**勘误**:此前建议的 `k3wise.material-list.v1` 经 `PROFILE_ID_PATTERN` 实测**不合法**(段内仅 `[a-z0-9_]`,连字符不许;GIP 先例 `bridge.bounded_read.v2` 用下划线)。预设 id(连字符)与 profile id(下划线)是**两个语法域**,测试双向钉死,防止有人把一个"改成"另一个 |
| configVersion(= `approvedConfigVersion`) | **store 铸,冻结记录** | `read-source-config-store.cjs` mint 循环铸版本;`contentKeyFor` 排除 caller version ⇒ 结构上不可指定。mint 时刻记录 |
| 数据子集 | 投影 `FItemID, FNumber, FName, FModel, FUnitID`(FItemID 领头 = intake 必需身份,S4/#4757)+ `FNumber` contains_like 过滤(k3_freeform 转义)+ 响应容器 `Data.DATA` | 投影为**预设所有**(BL0 锁),合同模块持镜像 + 测试断言与活预设逐字相等(tripwire 非副本) |
| 行数上限(读) | **10/次,页界 1..10** | 预设 `listLimit:10`/`maxListLimit:10`,adapter 超限 THROW(既有强制界,非新发明)。写侧 3 已由 K3WriteDecision 另行冻结,两界各司其职 |

## 2. fieldMap(显式映射,裁决点名)

**仅一条**:`FUnitID → baseUnit`。
`FItemID/FNumber/FName/FModel` 由 intake 别名表覆盖,**刻意不重映射**(同一事实不设第二记录点)。
测试含**负控**:不带该映射时 `baseUnit === null` —— 证明显式映射承重,正是"不能依赖 intake 自动识别"的机械化。

## 3. 两层冻结(都诚实,各管一层)

- **代码层**:模板(占位 `systemId='b4-template'`)的 store contentKey 钉为字面量
  `a0a8f349981dc9d07b97a915ed799ae640f68aae656da7edddfed2e958a8932a` —— 任何内容漂移在 mint 之前就红。
  改动须与 pin **同 commit**(与 provenance pins 同配对纪律)。
- **运行层**:目标环境 mint 时 `systemId` 换真值,store 铸 `approvedConfigVersion`,
  provenance 记录**真实**三元组 `{actionProfileVersion, approvedConfigVersion, configContentKey}`。
  模板 contentKey ≠ 运行 contentKey 是**设计**(systemId 参与摘要),不是缺陷。

## 4. builder 的唯一自由度

`buildK3WiseMaterialListB4Config({systemId})` —— 除真实 systemId 外**无任何可覆盖项**,
mutation 证实偷放第二自由度即红。

## 5. RATIFY 清单(逐项可答)

- [ ] profileId 下划线形 `k3wise.material_list.v1`(含对此前建议的勘误)
- [ ] 数据子集五列 + FNumber contains_like + `Data.DATA`
- [ ] fieldMap 仅 `FUnitID→baseUnit`
- [ ] 读上限沿用 10/次(不另发明)
- [ ] 两层冻结语义(模板 pin + mint 记录)

## 6. RATIFY 后的链路(裁决既定序)

mint approved config(目标环境)→ resolver 身份三元组 → provenance 冻结
(三元组 + 构建时 digest 组:runtime sha、package sha、**三行** helper digest)→
`stock-prep-main-package-verify.yml` 出包验证 → 实体机窗口:先读/清洗,再 1–3 行 Save + GetDetail 回读。
