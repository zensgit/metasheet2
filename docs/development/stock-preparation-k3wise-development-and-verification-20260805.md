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
| 从 main 出包可验证 | lane **两次**运行时证据 | run 30975655789(首绿)、**run 30979764981(候选包,7/7)**;074/075 于 PG 15/16/17 逐字 `executed successfully`;一字节篡改负控排他失败;排除集与 migration-replay 逐字对齐 |
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

1. **只读预检**:`POST /api/integration/external-systems/<k3SystemId>/read-smoke`
   (preset `k3wise.material-list.v1`)⇒ 期望 values-free 证据:业务成功、行数 ≤10、零泄漏键。
2. **建/核窗口 pipeline**:`POST /api/integration/pipelines` —— target=K3 系统(config 已含
   `objects.material.profile`,由部署包 FE/记录保证)、fieldMappings 与 B4 一致。
3. **dry-run**:`POST /api/integration/pipelines/<id>/external-write/dry-run`
   (body 仅 `tenantId/workspaceId/maxRows?`;K3 目标 maxRows 天花板=3)
   ⇒ 核验 `status=ready`、counts(`sourceRows≤3`,add/update 分布符合预期)、取得 `dryRunToken`。
   **人工批准点 = 此预览。** 不满意即止,无任何写发生。
4. **apply**:`POST /api/integration/pipelines/<id>/external-write/apply`
   (body `confirm.dryRunToken`;30 分钟 TTL,单次)⇒ `written` 与预览一致,rowErrors 空。
5. **回读**:重复步骤 1 的 read-smoke(single-record preset,按写入行键)⇒ 业务成功 + 记录存在;
   **值级确认**:操作员在客户 K3 客户端打开该物料核对名称/规格。
6. **留证**:dry-run/apply 响应的 values-free 字段(counts、status、closed tokens)+ run 引用
   归档;三元组(B4 mint 时已记)与 `serviceRuntimeSha e1b91594e`、候选包 digest 并列。

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

## 6b. 对抗复审记录(2026-08-05,四轮)

窗口 runbook 落地后经四轮独立 exact-head 对抗复审,累计 **3 P1 + 8 P2 CONFIRMED**,全部已修。
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

## 7. 唯一未完成项

**实体机窗口执行本身。** 其每一环的载体、判据与恢复路径如上;代码侧无剩余工作。
窗口 PASS 后在本文追加「§8 实体机验收记录」(日期、run/三元组引用、PASS 表)。
