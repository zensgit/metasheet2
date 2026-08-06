# 备料功能(K3 WISE 首 profile)开发及验证报告 — 2026-08-05

> 本文是本交付线的**汇总报告**:开发了什么、每一项如何被验证、剩什么、窗口怎么执行。
> 权威计划与逐条勘误在 `stock-preparation-k3wise-first-profile-delivery-plan-20260804.md`
> (正文 + 附录 A–E);B4 绑定的 RATIFIED 记录在
> `k3wise-material-list-b4-binding-draft-20260805.md`。本文不另立记录点,冲突时以上述为准。
> 全文 values-free:只含计数、闭集 token、run/PR 引用与 PASS/FAIL。

## 1. 范围(owner 四项裁决,20260805,基点 `d368700536`)

`P4VerificationDecision=OPEN_MAIN_BUILD_VERIFY_MATRIX_V1`
`K3WriteDecision=REQUIRE_NAMED_PROFILE_MAX3_AND_CONTENT_BOUND_APPROVAL`
`EndpointMirrorDecision=KEEP_EXISTING_EXHAUSTIVE_TEST`
`B4ProvenanceDecision=ACTION_PROFILE_VERSION_PLUS_APPROVED_CONFIG_IDENTITY`

首版边界(不变):单客户、人工触发、K3 Material **Save-only**、最多 **1–3 行**;
Submit/Audit、BOM 写、定时任务、批量自动写、MES、全面通用化 **全关**。

## 2. 交付清单(全部 MERGED,含模型分配实录)

| 切片 | PR | 内容 | 模型 |
|---|---|---|---|
| S4 | #4757 | GetList 投影补 `FItemID`(缺它则每行被 intake 拒);两个孤儿套件接线 | opus 判据 / 机械落地 |
| S2 | #4758 | `maxApplyRows=3` 三层锁(字面量→merge 后钉→login 前拒)+ FE 无条件选 profile | opus(全为闸) |
| S3 | #4761 | C6 K3 write profile(内容绑定 token 生命周期)+ 独立对抗审修复轮 | opus |
| S1 | #4760 | `stock-prep-main-package-verify` lane(build→五检→同源→负控→PG 矩阵) | opus 判据(后台代理起草) |
| S7 | #4759 | 计划附录 E(勘误 + 裁决记录) | fable(后台代理) |
| S5-1 | #4763 | B4 合同冻结(模板 contentKey 钉字面量;profileId 语法勘误) | opus |
| 修钉 | #4764 | 五检器 runbook 代际钉(闭集双值) | opus |
| 整链 | #4765 | 裁决链六环单工件跑通(mock,值校验回读 + 负控) | opus |
| 守卫 | #4766 | RATIFY 落地:Guard A(material 写必须命名 profile)+ Guard B(K3 replay 禁用) | opus 闸 / **sonnet** 套件机械变换(代理) |

模型分配规则本身是实证产物(计划 §4):**判据与对抗门=opus;判据定死后的机械落地=sonnet;
形状固定后的成文=fable**。本线四次独立审的多数发现是「过强声明」而非坏代码,佐证该分配。

## 3. 验证证据表

| 验证物 | 方式 | 证据 |
|---|---|---|
| 从 main 出包可验证 | lane **两次**运行时证据 | run 30975655789(首绿)、**run 30979764981(7/7)** —— 二者证明的是**通道可用**;30979764981 当时被指认为候选包,现已因 #4769 合入而**过期**(见 §6 步 6 的自检);074/075 于 PG 15/16/17 逐字 `executed successfully`;一字节篡改负控排他失败;排除集与 migration-replay 逐字对齐 |
| 首跑失败的价值 | shakedown 抓真缺陷 | 五检器代际钉漂移(冻结代 vs R12 措辞)⇒ #4764 闭集双值修复;**全类机械横扫恰一处失配** |
| 写路径三重锁 | 套件 + mutation | profile 字面量删/merge 钉删/守卫短路/FE 常量差一位/payload 去 profile ⇒ 各自红;3 行正控放行 `1 login+3 Save+0 Submit/Audit` |
| C6 内容绑定 | 真 planner×真 adapter×mock 线 | 批准后改行 ⇒ 409 `C6_WRITE_DRY_RUN_TOKEN_MISMATCH` 且零 Save;第 4 源行 ⇒ `not_applyable` 不发 token |
| 对抗审 P1 修复 | 交集 allowlist + fail-closed | 「预览≠写出」旁路:字面量/有效 schema 双向钉(`K3_C6_UNSUPPORTED_TARGET_FIELD`);四 mutation 红 |
| 裁决链整链 | 单工件端到端(mock) | 读→清洗→dry-run→token→Save-only→**GetDetail 回读值校验**+未写入负控;Save 不存储/回读陈旧值两 mutation 红 |
| Guard A/B | 双向 mutation | 武装移除⇒正控红;判定短路⇒拒绝红;replay 拒绝不消费死信(letter 保持 open),mock-target replay 成功为正控 |
| B4 冻结 | contentKey 字面量钉 + 镜像 + 负控 | 模板漂移即红;投影镜像=活预设;`FUnitID→baseUnit` 缺失时 `baseUnit===null`(显式映射承重) |
| 测试变换零降级 | 台账(计划 E.5) | 机制迁 BOM 逐条保留;5 行夹具被 cap 逼拆 3+2(上限真咬) |

## 4. 写路径安全姿态(叠层)

```
JSON config(不可伪造 Symbol 武装)
  └─ 命名 profile 选中 ⇒ save-only lifecycle(Submit/Audit 运行期不可达)
       └─ maxApplyRows=3(字面量单源;adapter login 前拒;C6 plan 层同源上限)
            └─ C6 内容绑定 token(单次/30min/绑 rowFingerprints)覆盖 dry-run→apply
无 profile ⇒ K3_WISE_MATERIAL_PROFILE_REQUIRED(零网络)
replay ⇒ K3_WISE_REPLAY_DISABLED(先于任何读/run 记录/adapter 创建)
```

## 5. 诚实限定

- **mock pass ≠ customer live pass** —— demo 自陈;窗口执行同一条链于实体机。
- lane 的迁移矩阵证明的是「包内迁移 **减排除集**」(逐条有档,与 migration-replay 逐字防漂)。
- GetDetail 业务级失败映射为「缺席」:存在但因权限/锁失败的行会预览为 `add`
  (写结果不受影响,Save 同体;1–3 行人工审为补偿控制,已文档化)。
- 服务端证据面 values-free:脚本化回读到**存在性/业务成功**层;**值级**确认由操作员在客户 K3 客户端完成。

## 6. 实体机窗口 runbook(操作员逐步)

前置:#4628 五步完成(部署、迁移前建角色、external-system 记录、B4 mint 并记三元组、授权位翻正)。
以下路由均已在 main 的路由表核实;`<...>` 为环境占位,不含真实值。

### 步 0(新增,窗口**开始前**做,不在窗口内):baseUrl 字符集预检

`#4769` 起,`config.baseUrl` 的**路径部分**与其它路径字段走同一条正向白名单
(`/^\/[A-Za-z0-9\-._~/]*$/`,并整类拒绝百分号编码)。这带来一条**此前不存在的部署约束**:

| baseUrl 形状 | 结果 |
|---|---|
| `https://k3/K3API`、`https://k3/k3cloud/K3API`、`https://192.168.1.5/K3API` | ✅ 接受 |
| `https://k3/金蝶API`(**非 ASCII 虚拟目录**) | ❌ 拒 `K3_WISE_ENDPOINT_NOT_SAFE_RELATIVE` |
| `https://k3/K3 API`(路径含空格) | ❌ 同上 |

**为什么不放宽**:ASCII-only 是这道白名单挡住 Unicode 形近字(全角 Ｓubmit 等)的承重属性,
放宽等于把前九轮关掉的一整类重新打开。**所以这是预检,不是待修缺陷。**

**操作**:窗口前向客户取实际 baseUrl,确认路径段只含 ASCII 字母数字与 `-._~`。若客户 IIS
用了中文虚拟目录,在**窗口之前**协商改用 ASCII 别名站点/虚拟目录,或升 owner 裁决。
**窗口不可重试**,而这条会在 adapter 构造期即失败(读、写都进不去),故必须前置排除。

### 步 0-b(新增,窗口**开始前**做):客户侧必须建**两条** K3 external-system 记录

**结论**:一条 K3 记录**不能**同时承担「list 读」与「armed 写」。窗口需要两条,指向**同一台**
物理 K3(相同 baseUrl):

| 记录 | config | 用途 |
|---|---|---|
| K3-read(**不选 profile**) | 带 list 读配置(`readMode:'list'`、`readList*` 一族) | 步骤 1 的 read-smoke;B4 契约描述的就是它 |
| K3-write(**选 `material-k3wise-customer-profile-v1`**) | profile 武装,save-only + maxApplyRows=3 | C6 dry-run→apply 的写目标 |

**为什么不能合并成一条**(实测,非推断):`#4769` 把 `readMode`、`readListBodyKey`、
`readListFields`、`readListOrderBy`、`topField`、`pageIndexField`、`pageSizeField`、
`maxListLimit`、`readListBodyTemplate` 全部列为 profile 的 forbidden overlay key。在一条
armed 记录上,这些键在 adapter 归一化时被**静默剥除**(实测全部变 `undefined`,且 `readPath`
被钉成 `/K3API/Material/GetDetail`)。

**连首方冻结预设也被剥**:`read-smoke` 的 `k3wise.material-list.v1` 自带 `readConfigOverlay`
(含完整 list 形状),`applyReadSmokePresetOverlay` 会把它并上去 —— 但随后的 adapter 归一化
仍然剥掉。也就是说这道加固**不区分「操作员覆盖」与「首方预设覆盖」**。方向是 fail-closed
(安全的那一侧),但后果是:**armed 记录做不了 list read-smoke**。

**操作**:窗口前确认客户环境里这两条记录都已建、baseUrl 相同、且 K3-read 那条**没有**选
profile。窗口不可重试,而这条会在步骤 1(read-smoke)当场失败。

> 关联未决项:B4 绑定的 systemId 只能是 pipeline 的 source/target 之一(`#4769` 关系检查),
> 而 K3-read 记录在「非 K3 source」的管道里两者都不是 —— 该冲突的处置见 §7.2。

1. **只读预检**:`POST /api/integration/external-systems/<k3SystemId>/read-smoke`
   (preset `k3wise.material-list.v1`)⇒ 期望 values-free 证据:业务成功、行数 ≤10、零泄漏键。
2. **建/核窗口 pipeline**:`POST /api/integration/pipelines` —— target=K3 系统(config 已含
   `objects.material.profile`,由部署包 FE/记录保证)、fieldMappings 与 B4 一致。
   ⚠️ **source 必须是非 K3 系统**(见 §7.2)。本步原文只写了 target,没写 source ——
   彩排驱动器正是在这个空白处猜了「K3 当 source」,而那**在结构上不可能成立**。窗口不可重试,
   所以 source 必须在建 pipeline 前就被指定并核实。
3. **dry-run**:`POST /api/integration/pipelines/<id>/external-write/dry-run`
   (body 仅 `tenantId/workspaceId/maxRows?`;K3 目标 maxRows 天花板=3)
   ⇒ 核验 `status=ready`、counts(`sourceRows≤3`,add/update 分布符合预期)、取得 `dryRunToken`。
   **人工批准点 = 此预览。** 不满意即止,无任何写发生。
4. **apply**:`POST /api/integration/pipelines/<id>/external-write/apply`
   (body `confirm.dryRunToken`;30 分钟 TTL,单次)⇒ `written` 与预览一致,rowErrors 空。
5. **回读**:重复步骤 1 的 read-smoke(single-record preset,按写入行键)⇒ 业务成功 + 记录存在;
   **值级确认**:操作员在客户 K3 客户端打开该物料核对名称/规格。
6. **留证**:dry-run/apply 响应的 values-free 字段(counts、status、closed tokens)+ run 引用
   归档;三元组(B4 mint 时已记)与**实际部署的** `serviceRuntimeSha`、包 digest 并列。
   ⚠️ **不要照抄任何历史 SHA。** 本步原文钉的是 `e1b91594e`,那是 #4769 门**合入之前**的
   候选包 —— 其树中不含 `K3_WISE_PIPELINE_RUN_DISABLED` 与 `assertWireEndpointIntent`
   (各 0 文件,已核)。装它等于把 owner 在 #4768 复审中点名的两个敞口原样带进不可重试的窗口。
   **部署前自检(勘误 2026-08-06:改为钉「批准包身份」,并修正判定方向)**

   ⚠️ **不要再追「最新 K3 合入点」。** 那个做法每次有影响 K3 写路径的修复合入就过期一次
   (已发生两次:`e1b91594e` 早于 #4769 的安全门,`65edb98c6` 早于 #4784),而窗口不可重试。
   正确的做法是钉**最终批准包的精确身份**:

   ```
   批准包 serviceRuntimeSha:  aa48c3f187685b6f37aceed8cec1c5bcccc8b9a7
   packageTgzSha256:         93aa75c9ea88ef8e52a6ebd96378ddb049e5c3bed785a40bdb4f7f2e8659d90f
   packageZipSha256:         d66392d9035fd8259d1086e21d613b29f609b10762746bae3eb1836c44cfe273
   出包 run:                 31103351286   (Stock-prep main package verify)
   彩排 run:                 31103021849   (同一 head,17/17)
   ```

   **这三个值的取得方式**:出包 lane 以 `expected_sha` 钉死 —— checkout 的 HEAD 与它不符即失败,
   所以不需要事后核对包出自哪个 commit。该 run 自报 `buildShaSourcesAgree=PASS`、
   `buildProvenanceGitCommitMatchesBuildSha=PASS`、`packageSource=BUILT_FROM_DISPATCHED_COMMIT`,
   且 074/075 在 PostgreSQL 15/16/17 三个版本上均 `executed successfully`。

   ⚠️ **这是一个可复现的身份,不是「客户可用」的背书。** 出包 lane 自己写明其证据类是
   **受控合成功能证据**:它证明包过五检、含并真的应用 074/075、在临时 PG 15/16/17 上干净幂等;
   它**不建立**关于真实客户生产、sealed-snapshot 语义、规模、外部写、rollout 或
   PLM/ERP/CRM/SRM 泛化的任何结论。三层仍是三层:
   `mock pass ≠ rehearsal pass ≠ customer live pass`。

   现场只接受**逐字等于**上面那个 SHA 的包。相等判定不会过期,也不需要有人判断
   「哪些修复算数」。

   **辅助安全检查(方向修正)** —— 若需确认某候选包**含有**某个必需修复:

   ```bash
   git merge-base --is-ancestor <必需修复的 SHA> "$serviceRuntimeSha"   # 非零 ⇒ 不含 ⇒ 拒绝
   ```

   ⚠️ **此前写反了**:原文是 `is-ancestor <候选> e6523c949`。那个方向问的是「候选是不是修复的
   祖先」——对**恰好等于修复提交**的包也成立,于是把**正确的包判成过期包误拒**;而一个不含该
   修复的**分叉**提交并不是修复的祖先,反而被放行。**方向反了会同时产生误拒与漏放。**

   ⚠️ **为什么下界从 `65edb98c6` 上移**——这是本步记录过的**同一类失效,一个 merge 之后重演**。
   原钉 `e1b91594e` 失效是因为它早于 #4769 的安全门;现在 `65edb98c6` 同样失效,因为它早于
   **#4784**(`e6523c949`,"C6 loaded the TARGET with the credential-stripped accessor")。
   在这两点之间构建的包**满足旧自检、却在窗口要跑的那一步必死**:C6 用去凭据的公开访问器
   载入 adapter-backed 的写 target,适配器在**发出任何 wire 调用之前**抛
   `K3_WISE_CREDENTIALS_MISSING`。**窗口不可重试**,所以这不是"跑一次看看"能兜住的。

   ⚠️ **下界会继续上移。** 每次有影响 K3 写路径的修复合入 main,本行的 SHA 就过期一次。
   照抄本行的历史 SHA 与照抄 `e1b91594e` 是同一个错误 —— 出包前请核对 main 上最后一个
   影响该路径的合入点。

**PASS 判据**:1–6 全绿且 `0 Submit / 0 Audit`。

> **该不变量的实际载体**(复审后更正 —— 原文只写"服务端不变量"而未说由什么保证,
> 而当时它确实**可被绕过**):① save-only profile 在运行期强制 `autoSubmit/autoAudit=false`
> 并删除 submit/audit 端点;② profile 拥有的请求形状键 merge 后重钉、未声明的整形键删除
> (含 `readBodyTemplate`/`bodyTemplate`/`passThroughBody` 等 body 注入通道);
> ③ **无条件**守卫:任何 K3 读路径不得指向生命周期写端点(`K3_WISE_READ_PATH_IS_WRITE_ENDPOINT`)
> —— 这一条不依赖是否选了 profile,因为 K3 **source** 管道合法无 profile;
> ④ material 写与**预览**均要求命名 profile(`K3_WISE_MATERIAL_PROFILE_REQUIRED`);
> ⑤ `/run` 对 K3 目标整体 fail-closed(`K3_WISE_PIPELINE_RUN_DISABLED`),C6 是唯一写入口;
> ⑥ 预览的 auto-flag 镜像 save-only 锁 —— **预览等于写**。
> 前三条各自由独立对抗复审构造的可执行利用推动;每条都有 mutation 探针。
**异常恢复**:任何一步失败 ⇒ 修正后**从步骤 3 重走**(重新人工批准)。replay 已禁用,by design。

## 6b. 对抗复审记录(2026-08-05,**共十一轮**;下表为前四轮)

窗口 runbook 落地后经**十一轮**独立 exact-head 对抗复审(本节表格记前四轮;第五至十一轮见 #4769
的逐轮 disposition 评论)。**同一缺陷类累计逃逸八次**:字段→跨文件→跨 profile 条件→检查早于
归一化→`?`/`#`→单点段→段内尾点→匹配锚点。终局解法不是第九条正则,而是把守卫移到**唯一线上
咽喉点**(`requestJson`)并对**产出的** pathname 判定,再以必填 `intent` 关闭覆盖面。
另一再现模式:「守卫被测但**接线**未被测」出现四次(healthPath、wire gate、B4 scope、apply 侧)。

前四轮累计 **3 P1 + 8 P2 CONFIRMED**,全部已修。
P1 的三条是**同一个类的三条轴**,而我每轮只封住了刚被展示的那个实例:

| 轴 | 逃逸方式 | 修法 |
|---|---|---|
| 字段 | 钉了 `savePath`,`readPath` 更宽(dry-run 期驱动) | 钉整个请求形状类 |
| **跨文件** | `k3-save-body-composer.cjs` 从同一份配置读 `passThroughBody`/`bodyTemplate` | sweep 扫全部消费者,消费者清单对全仓遍历比对 |
| **跨条件** | 整个钉在 `if (saveOnlyProfile)` 内 —— 由被防御者自愿启用 | 读路径守卫**无条件**,覆盖两个填充循环 |

其余 P2 含:集合是标签而非行为(键在集合间移动全绿)、B4 绑定失去与本 pipeline 的关系、
`previewUpsert` 缺守卫且不镜像 save-only 锁、零调用断言无正控、类型混淆探针被降级而台账称"零降级"。

**方法学结论**:声称"某一类已关闭"时,**交付物必须是机械断言而非清单** ——
本线现有 sweep 契约(遍历源码枚举读取点、要求三集合全覆盖、带匹配下限防空过)即为此。

## 7. 未完成项

### 7.0 勘误(2026-08-05,owner 复审后):本节原文「代码侧无剩余工作」为**假**,撤回

原文断言「唯一未完成项 = 实体机窗口执行本身;代码侧无剩余工作」。owner 复审 staging 彩排
PR #4768 时**当场证伪**,点名两条仍然敞开的写入口:

| 敞口 | 内容 |
|---|---|
| A | 普通 `POST /api/integration/pipelines/:id/run` 仍可**绕过 C6 token** 直接写 K3 |
| B | 命名 profile 的 `savePath` 仍可被操作员覆盖成 `Submit`/`Audit` |

两条都不是窗口操作问题,是代码侧的写路径敞口 —— 即本节当时的断言方向就是错的。
**教训按仓内纪律记录**:「收官」类断言必须由独立门审给出,不能由交付方自证;本节原文正是
自证。见 `feedback_completion_claim_phrasing` 与 `feedback_adversarial_review_catches_overclaims_not_just_bugs`。

### 7.1 当前真实剩余(2026-08-05)

| # | 项 | 状态 | 阻塞于 |
|---|---|---|---|
| R1 | **#4769** 前置门:C6-only 写入口(`/run` 与 replay 双拒)、Save endpoint 钉死、C6 消费 approved B4 binding | ✅ **MERGED 2026-08-05T18:01Z**(main `65edb98c6`),9/9 required 绿含 `integration-guard` | — |
| R2 | **#4768** staging 彩排 | 已 rebase 到 main;exact-head 复审 **CHANGES-REQUESTED**:驱动器把 K3 当 pipeline **source**,而任何 K3 配置都不能充当 C6 source(`readSourceRows` 发裸 read ⇒ `K3_WISE_READ_LIST_ROUTE_UNSUPPORTED`/`K3_WISE_READ_KEY_REQUIRED`,**零 HTTP 调用**)⇒ 步骤 3–9 不可达 | **owner 裁决:换哪个 source**(见下 §7.2) |
| R3 | 彩排跑绿(dispatch-only workflow,PR checks **不**执行它) | 未开始 | R2 |
| R4 | 本 MD 与计划按彩排实测同步(§8 前置) | 未开始 | R3 |
| R5 | 目标环境 mint B4 并记三元组 | 未开始 | 运维授权(#4628) |
| R6 | 出最终包(从 main,走 P4 lane) | 未开始 | R5 |
| R7 | 实体机窗口执行 + 本文 §8 验收记录 | 未开始 | R6 + 三项授权位 |

**R5–R7 全部阻塞在 owner/运维侧**(部署授权、建角色、external-system 记录、翻授权位、排窗),
**不是编码工作**。R1–R4 是代码/文档侧,其中 R1 已达合并水位。

### 7.2 待 owner 裁决:窗口/彩排的 **source 系统**

**结论先说**:**K3 不能充当 C6 pipeline 的 source。** 这不是配置问题,是结构问题 ——
`external-write-dry-run.cjs:427` 的 `readSourceRows()` 发的是裸 `read({object, limit, cursor})`,
不带 key、不带 read-smoke marker。对真 adapter 用驱动器逐字配置实测三种写法:

| 变体 | 结果 | HTTP 调用 |
|---|---|---|
| `readMode:'list'`(驱动器原样) | `K3_WISE_READ_LIST_ROUTE_UNSUPPORTED` | **0** |
| 省略 `readMode`(默认 detail) | `K3_WISE_READ_KEY_REQUIRED` | **0** |
| `readMode:'single_record_detail'` | `K3_WISE_READ_KEY_REQUIRED` | **0** |

「零 HTTP 调用」是要点:失败发生在**任何字节上线之前**,所以 dry-run/token/apply/回读/负控
全部不可达 —— 而那正是彩排与窗口的全部内容。

**不可采取的修法**:把 read-smoke marker 透传进 `readSourceRows` 以放宽
`K3_WISE_READ_LIST_ROUTE_UNSUPPORTED`。那是**借诊断通道夹带安全放宽**,须升 owner 裁,
不能由彩排 lane 自行决定。

**选项**(选择直接决定彩排/窗口证明了什么):

| 选项 | 需要 | 证明力 |
|---|---|---|
| `data-source:sql-readonly` | staging 可达的库凭据 | 与仓内已裁先例一致(C6 套件与 offline demo 均用它) |
| `metasheet:staging-source` | 先经 API 建并灌一张表 | 完全自足、无外部依赖;离客户形态最远 |
| `plm:yuantus-wrapper` | 可达的 PLM 端点 | **最接近真实形态**(`PLM material → K3 WISE` 是本线的规范管道) |

**建议 = PLM**:彩排的价值与它同窗口的相似度成正比。代价是 staging 需要一个可达 PLM。
**此项未定之前,R2/R3 不可推进,窗口 §6 步 2 也不完整。**

### 7.3 窗口 PASS 后

在本文追加「§8 实体机验收记录」(日期、run/三元组引用、PASS 表)。
