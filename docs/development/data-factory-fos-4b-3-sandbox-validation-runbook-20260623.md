# FOS-4b-3 — Sandbox Validation Runbook / Evidence Checklist(2026-06-23)

> 状态:**runbook(docs-only)**。本文是 **sandbox-only 验证**的操作手册 + 证据清单。**不开启 production apply**;写 prod canonical(`plm_stock_preparation_main`)仍是 **FOS-4b-3-prod** 独立 owner gate。本 runbook 的产出(全部 ☐ 勾选 + 证据)= 之后讨论 FOS-4b-3-prod 的**输入**,不是其授权。
> 前置:FOS-4b-3 sandbox apply gate 已 shipped(#3089 `4b31901f6`):small-BOM(`applyStockPreparationAction` 函数内)+ large-BOM(`tableActionLargeBomApplyJobRun` 路由)两条真实写入口均 fail-closed sandbox 闸;无 config/env → 拒;prod canonical 始终拒;objectId 省略=视作 canonical=拒;values-free。

## 0. 目的与非目标

- **目的**:在**沙箱目标**上把 5 件事跑顺并留证:① sandbox gate 开关(`STOCK_PREP_SANDBOX_MODE` + allowlist)② sandbox apply ③ re-pull 幂等 ④ 人工字段保留 ⑤ values-free evidence。
- **非目标**:**不**写 prod canonical;**不**解锁 production apply;**不**碰 K3 Submit/Audit/BOM 红线;**不**改 generic FOS route 的 dry-run-only 边界。
- **退出**:全部 ☐ 勾选 + 证据归档后,才**提议**(非执行)FOS-4b-3-prod —— 后者仍需独立 owner 授权。

## 1. 前置条件(provision sandbox,不可用 prod)

```text
☐ 沙箱目标表:一个 stock-prep 结构的 multitable 表,objectId ≠ plm_stock_preparation_main(例如 plm_stock_preparation_sandbox)
☐ 沙箱 source:动作真实 dry-run 读取的只读源(data-source:sql-readonly 或 bridge:legacy-sql-readonly),指向沙箱/样本数据,非生产库
☐ 凭据:沙箱 source 凭据仅经 credential store(绝不 request/preset/浏览器)
☐ 操作主体:具备 integration write/admin 的沙箱账号
☐ 记录沙箱 objectId(下面记为 <SANDBOX_OBJECT_ID>)与 sheetId(仅本地记录,证据中不外泄)
```

### 1.1 如果沙箱目标表不存在

> **不要**使用 `POST /api/integration/stock-preparation/target/ensure`。该 canonical ensure 入口只会创建/绑定
> `plm_stock_preparation_main`,不是沙箱目标。缺沙箱表时,使用下面的 admin-only sandbox provisioning 入口。

```text
POST /api/integration/stock-preparation/sandbox-target/ensure
{
  "projectId": "<PROJECT_ID>",
  "baseId": "<SANDBOX_BASE_ID>",
  "objectId": "<SANDBOX_OBJECT_ID>",
  "label": "<SANDBOX_LABEL>"
}

期望:
☐ objectId ≠ plm_stock_preparation_main;若误传 canonical objectId → 422 TARGET_SANDBOX_OBJECT_ID_INVALID
☐ 响应 mode = sandbox_create 或 sandbox_existing
☐ 响应只返回 targetBindingAvailable + values-free evidence(objectIdHash / field counts / field names);不返回 targetBinding / sheetId / 明文 objectId
☐ evidence 可贴 issue;明文 <SANDBOX_OBJECT_ID> / sheetId 仅本地记录,不要贴出
```

## 2. Step 1 — 配置并验证 sandbox gate(开关 + fail-closed)

```text
配置(server config 或 env 二选一):
  env:  STOCK_PREP_SANDBOX_MODE=true
        STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=<SANDBOX_OBJECT_ID>        # 逗号分隔 allowlist
  config: context.config.stockPrepApplySandbox = { enabled:true, allowedTargetObjectIds:[<SANDBOX_OBJECT_ID>] }

验证(三连,缺一不可):
☐ A. gate OFF(未配置)→ 对沙箱目标 apply → 403 STOCK_PREP_APPLY_SANDBOX_ONLY(fail-closed 默认)
☐ B. gate ON + 目标 = <SANDBOX_OBJECT_ID>(在 allowlist)→ apply 通过闸(进入正常流程)
☐ C. gate ON 但目标 = plm_stock_preparation_main → 403 STOCK_PREP_APPLY_SANDBOX_ONLY,reason=prod_canonical(canonical 始终拒,即使误列 allowlist)
证据:
☐ A/C 的 403 响应体(error.code + 仅含 coarse reason,无 sheetId/objectId/值)
☐ 配置快照(env/config,凭据已脱敏)
```

## 3. Step 2 — Sandbox apply(dry-run → apply,只落沙箱表)

```text
small-BOM:
  POST /api/integration/table-actions/:actionId/dry-run   { parameters:{ projectNo:<样本> } }   → dryRunToken + counts(values-free)
  POST /api/integration/table-actions/:actionId/apply     { parameters:{...}, confirm:{ dryRunToken } }
large-BOM(若样本触发大 BOM):走 expansion-jobs → apply-jobs → apply-jobs/:id/run(同 sandbox 闸)
☐ apply 状态 succeeded;counts(created/updated/...)符合预期
☐ 写入仅命中 <SANDBOX_OBJECT_ID> 对应 sheet(target-scoped;无越界写)
☐ 全程无外部写、无 K3
证据:
☐ dry-run evidence(actionId / dryRunRevision / counts;projectNoPresent 为布尔,无 projectNo 值)
☐ apply evidence(actionId / dryRunRevision / apply.counts / errorCodes;无业务值)
☐ 沙箱表写入前后行数对比
```

## 4. Step 3 — Re-pull 幂等(重跑不重复写)

```text
☐ 用同一 parameters 再跑一次 dry-run → apply(token 需重取;revision-fence 生效)
☐ 第二次 apply:created = 0;既有行按 idempotencyKey 命中(matched/updated,不新建重复)
☐ 沙箱表行数与第一次 apply 后一致(无重复行)
证据:
☐ 第二次 apply 的 counts(created=0 / 重复=0)
☐ 两次之间沙箱表行数不变的对比
```

## 5. Step 4 — 人工字段保留(apply 不覆盖人工编辑)

```text
☐ 在某沙箱行手动编辑一个 human-preserved 字段(ownership=human_preserved)
☐ 用同一 parameters 再跑 dry-run → apply
☐ 该 human 字段值在 apply 后**未被覆盖**(保留人工值);plm_system 字段按预期刷新
证据:
☐ human 字段 apply 前/后值一致(截图或导出,业务值仅本地留存,证据 MD 中只写"preserved=yes")
☐ apply evidence 中无 human 字段值泄露
```

## 6. Step 5 — Values-free evidence 审计

```text
☐ 汇总 Step 1–4 的所有响应/evidence/run-log/dead-letter
☐ 确认其中**无**:projectNo / 组件码 / 行业务值;**无** sheetId / objectId;**无**凭据/连接串
☐ gate 失败仅含 coarse reason(prod_canonical / sandbox_disabled / target_not_allowlisted)
证据:
☐ evidence JSON 抽样(已确认 values-free)
☐ 一句话审计结论:values-free = yes
```

## 7. 退出标准 → 才谈 FOS-4b-3-prod

```text
☐ §2–§6 全部 ☐ 勾选,证据归档
☐ 无任何对 prod canonical 的写;canonical 全程被拒
☐ 幂等 + 人工字段保留 + values-free 均 PASS
→ 满足后:**提议** FOS-4b-3-prod(写 prod canonical),作为**独立 owner gate**;本 runbook 证据为其输入。
   FOS-4b-3-prod 未授权前,生产 apply 不开。
```

## 8. 红线 / 边界

```text
sandboxOnly=true   noProductionApply=true   noCanonicalWrite=true(canonical 全程被拒)
noExternalWrite=true(动作仅 read-only source read + own-sheet 沙箱写)   noK3=true(Submit/Audit/BOM 红线不开)
credentialsViaStoreOnly=true   valuesFreeEvidence=true   genericFosRoute=dry-run-only(不变)
首笔生产 apply = FOS-4b-3-prod 独立 owner 授权(本 runbook 不构成授权)
```
