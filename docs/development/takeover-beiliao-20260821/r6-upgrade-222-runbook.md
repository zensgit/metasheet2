# 222 升级 r6 · 一页执行单(2026-08-27)

> 接 `codex-handoff-beiliao-20260825.md`。**2026-08-29 晚更新:r6 基线 = `3f30d8eb4` 或更新**——B2a 四支之外,W 修复波五支亦已全部合入(#5312 账本状态机三修 / #5313 迁移 078 claim CAS / #5314 通用出站写 unset=deny 门 / #5315 choke 下沉 runner / #5316 MSSQL armed floors)。**部署新增注意**:迁移含 **077+078** 两张新表;`INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS` **保持不设**(unset=deny 即正确姿态,222 无任何通用 http 写目标);K3 apply 恒拒与 B2a env 不设照旧。原 r6 基线注记如下——B2a 收敛四支已全部合入(#5243 MSSQL 加固 / #5245 确认账本+迁移 077 / #5247 K3 四层永久围栏 / #5248 B2a 登记+choke)。values-free 纪律照旧。
>
> **r6 新增能力与部署注意**:
> 1. 迁移新增 **077**(确认裁决 reconcile 租约表)——迁移步骤照跑即含;
> 2. **K3 外部写四层永久拒绝**已结构化(`K3_WISE_EXTERNAL_WRITE_DISABLED`)——K3 目标 dry-run 仍可、apply 恒拒,这是预期行为不是故障;
> 3. **确认裁决账本**五条 admin 路由随包(异常队列的权威投影);
> 4. **B2a 登记 env**(`INTEGRATION_CORE_B2A_REGISTRY_PATH`)本次**保持不设**——休眠即字节级原行为;首条真实登记属 owner 决策 O3,勿在 222 上私配;
> 5. 部署完成后按《跨机开发公约》推 tag:`git push origin <sha>:refs/tags/deploy-r6-YYYYMMDD`。

## 0. 打包与溯源

- r6 = 当前 main(含 #5232 pack-sandbox、#5231 守卫修复、#5126 mapper 接线、076 迁移)。
- **补一笔旧账**:把 r5 快照推成 tag(`git push origin b68cfbe3f:refs/tags/deploy-r5-20260827`)——它现在只活在你本地工作区,ZIP SHA 记了但代码快照无从复原。r6 起每次部署快照都推 tag。

## 1. 迁移前:量一次 org 数(上线门 §0b,不可跳)

对 222 的库:`SELECT count(DISTINCT org_id) FROM user_orgs WHERE <active 谓词按表结构>;`
- **= 1**(预期,单 `default` 租户)→ 继续。
- **≠ 1** → 停,先和审批线裁定 Lock-11 前提;单事务迁移链会整体回滚,备料零责任照样部署失败。
- 顺手:迁移前 `pg_dump` 一份快照,作为唯一回滚手段(owner 之前未正式批,这次部署窗口顺带让他点头)。

## 2. 跑迁移

r5 部署时故意没跑(42P01 by design)。r6 必须跑:补 076 等全部。单事务 all-or-nothing;全新失败即整体回滚,库不残留半迁移。

## 2.5 部署后第一件事:跑一次 preflight(按它列的逐条修,先别做别的)

`GET /api/integration/stock-preparation/preflight` —— read 档(`stock-prep:read`,平台 admin 同样满足),**只读**:不建表、不装列、不 ensure 任何东西。

一次返回 `ready` + `blockers`(最挡路的在前)。每条 blocker 带稳定的机器 `code`、人话 `what`,和一条**照抄就能跑**的 `fix.run`——要么是 `METHOD /path {json}`,要么是一行 `KEY=value`。**按它给的顺序修完、修到 `ready: true` 再往下走**;别自己另起 objectId,别凭印象猜 env 名。

它替掉了今天要分四个 readiness 端点轮询(`target/` `sandbox-target/` `mvp/` `confirmation-decisions/`)、轮完仍问不出来的那两件事:pack 自己声明的目标、以及 sandbox 写行授权。

| code | 它在说什么 |
|---|---|
| `STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY` | 确认裁决账本表不在。**它是按需建的,不在迁移链里**——部署完 ≠ 它存在。`fix` 是那条 ensure 调用 |
| `STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED` | 没配 pack。`fix` 直接点名 `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` |
| `STOCK_PREP_PACK_TARGET_MISSING` | **pack 自己声明的 `targetObjectId` 那张表不存在**。`fix` 里引的就是 **pack 声明的那个 id**,照抄,不要换成「现有的那张表」 |
| `STOCK_PREP_PACK_TARGET_INCOMPLETE` | 表在,但 pack 的 `ext_` 列没装。`fix` 是那个 pack 的 install 调用 |
| `STOCK_PREP_EXT_FIELD_MAPPING_NOT_CONFIGURED` | 没配源列→`ext_` 映射(列会装上、值一个都不写)。`fix` 点名 `INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH` |
| `STOCK_PREP_SANDBOX_MODE_NOT_ENABLED` | 写行授权没开。**装列(pack)和写行(apply)是两道独立授权** |
| `STOCK_PREP_SANDBOX_ALLOWLIST_MISSING_TARGET` | 允许清单里没有 pack 声明的目标——**装列会成功、写行会被拒**,这种晚失败最费时间。`fix` 给的是「现有清单 + 缺的那个」整行,贴一次就对 |

**它为什么存在——两起真事**(首次真机部署,同一次会话):
1. 有人手挑 sandbox objectId 被拒,而拒绝语没说命名空间是 `plm_stock_preparation_sandbox`;
2. 两个人并行配同一台机、各挑了不同的 sandbox objectId:pack 声明 A,实际建出来的表叫 B。dry-run 报缺目标,却从不提 pack 声明的那个名字。上表第 3 条就是为这条写的回归。

响应里只有部署方自己定义的东西(objectId、`ext_` 列 id、packId、env KEY 名),**不含任何客户业务值、口令或主机地址**;env 类 `fix` 只给 KEY 名和占位路径,不回显你机器上的真实路径。

**围栏是 `posture`,不是 blocker**:production Apply 关闭、K3 外部写永久拒、B2a 登记休眠、通用出站写门不设——这四条只报状态,**一律不给 fix**。不设就是正确姿态,preflight 不会推你去开它们。

## 3. 配置(全部服务端文件/env,永不入库、永不经请求)

| key | 内容 |
|---|---|
| `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` | 指向部署机上的 pack 目录 JSON。**试用期用合成 pack**(仓里 factory-a 样例导 JSON;pack 可带可选 `targetObjectId`,写 sandbox 命名空间 id;**显式写 canonical 会被拒**,这是守卫不是 bug) |
| `INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH` | 源列→`ext_` 映射 JSON(`packId` 必须在上面目录里) |
| `STOCK_PREP_SANDBOX_MODE=true` + `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=<sandbox objectId>` | apply 的允许清单——**装列(pack)和写行(apply)是两道独立授权,都要开** |
| production Apply | **保持关闭**(R-09 未签发) |

配完回头再跑一次 §2.5 的 preflight,直到 `ready: true` 且 `blockers` 为空——它对这张表里每一项都有对应的 blocker。

## 4. 目标绑定

`node scripts/ops/stock-preparation-derive-target-binding.mjs`(#5232 新增,离线,无需连库)→ 生成含全部 canonical + `ext_` 列的 `target` 块(fieldIdMap)。action config 必须带 `extensionFieldIds`,否则 dry-run 422 `TARGET_SCHEMA_INCOMPLETE`(**故意的,列出缺的列照抄即可**)。

## 5. 试用验收(两条判据)

1. install → dry-run → apply 后,**表格里 `ext_` 列出现非空值**(本地已证:6/7 行填充,human_preserved 列保持空)。
2. 二次刷新全 skip(幂等)。
注意:dry-run 与 apply 必须同配置——mapping 只接一边会 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`。

## 已知不影响试用、别顺手修

大 BOM 路径 `ext_` 未接(响应带 `extFieldMappingConfiguredButNotAppliedOnThisPath` 标记,持久态改动另立项);MVP 快照面(222 上有 2 个存量活跃项目——**切换清单里记一笔,别动它**);ledger `packVersion` 返回 string(小缺陷,单开)。

---

## 附:首次真机部署实测值(2026-08-30,直接复制,勿再自拟)

初装引导建 admin 之后,备料需要**两张受管表**,各一条 POST 即可(admin token)。**两个 objectId 是固定值**——
第一次部署时自拟名字被守卫拒了(见下),写在这里就不必再猜。

```
POST /api/integration/stock-preparation/confirmation-decisions/ensure   {}
POST /api/integration/stock-preparation/sandbox-target/ensure           {"objectId":"plm_stock_preparation_sandbox_trial"}
```

- 确认裁决账本 objectId(固定,不可自拟):`plm_stock_preparation_confirmation_decision` —— 建成为 16 列(12 系统 / 4 人工)。
- 沙箱目标 objectId:**必须落在 `plm_stock_preparation_sandbox` 命名空间**(等于它,或以 `plm_stock_preparation_sandbox_` 开头)。
  本次采用 `plm_stock_preparation_sandbox_trial` —— 建成为 25 列(17 系统 / 8 人工保留),`targetBindingAvailable: true`。
  **实测教训**:`stock_prep_sandbox_trial` 会被 422 `TARGET_SANDBOX_OBJECT_ID_INVALID / not_sandbox_namespace` 拒绝。
  该守卫是有意的(防止误建到 canonical 名下);其拒绝信息现已带上 `requiredNamespace`,不必再翻源码。

随后 env 里的沙箱清单直接用同一个值:

```
STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=plm_stock_preparation_sandbox_trial
```
