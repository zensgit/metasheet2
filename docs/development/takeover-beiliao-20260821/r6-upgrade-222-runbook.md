# 222 升级 r6 · 一页执行单(2026-08-27)

> 接 `codex-handoff-beiliao-20260825.md`。**2026-08-29 更新:r6 基线 = `916c912ee` 或更新**——B2a 收敛四支已全部合入(#5243 MSSQL 加固 / #5245 确认账本+迁移 077 / #5247 K3 四层永久围栏 / #5248 B2a 登记+choke)。values-free 纪律照旧。
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

## 3. 配置(全部服务端文件/env,永不入库、永不经请求)

| key | 内容 |
|---|---|
| `INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` | 指向部署机上的 pack 目录 JSON。**试用期用合成 pack**(仓里 factory-a 样例导 JSON;pack 可带可选 `targetObjectId`,写 sandbox 命名空间 id;**显式写 canonical 会被拒**,这是守卫不是 bug) |
| `INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH` | 源列→`ext_` 映射 JSON(`packId` 必须在上面目录里) |
| `STOCK_PREP_SANDBOX_MODE=true` + `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=<sandbox objectId>` | apply 的允许清单——**装列(pack)和写行(apply)是两道独立授权,都要开** |
| production Apply | **保持关闭**(R-09 未签发) |

## 4. 目标绑定

`node scripts/ops/stock-preparation-derive-target-binding.mjs`(#5232 新增,离线,无需连库)→ 生成含全部 canonical + `ext_` 列的 `target` 块(fieldIdMap)。action config 必须带 `extensionFieldIds`,否则 dry-run 422 `TARGET_SCHEMA_INCOMPLETE`(**故意的,列出缺的列照抄即可**)。

## 5. 试用验收(两条判据)

1. install → dry-run → apply 后,**表格里 `ext_` 列出现非空值**(本地已证:6/7 行填充,human_preserved 列保持空)。
2. 二次刷新全 skip(幂等)。
注意:dry-run 与 apply 必须同配置——mapping 只接一边会 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`。

## 已知不影响试用、别顺手修

大 BOM 路径 `ext_` 未接(响应带 `extFieldMappingConfiguredButNotAppliedOnThisPath` 标记,持久态改动另立项);MVP 快照面(222 上有 2 个存量活跃项目——**切换清单里记一笔,别动它**);ledger `packVersion` 返回 string(小缺陷,单开)。
