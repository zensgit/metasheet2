# Data Factory FOS-4b-3 — action APPLY 设计锁定(2026-06-22)

> 状态:**DESIGN-LOCK 草案(待 owner 评审 + ratify apply)**。**docs-only**:不授权任何 runtime / UI / migration 改动。**本设计锁本身不开启任何真实执行。**
> 上游:FOS-4b 行动绑定泛化。FOS-4b-1(action contract,#3066)+ FOS-4b-2(generic route **dry-run** path,#3072,owner ratified dry-run-only,**先不执行写**)已合并。FOS-4b-3 = **apply = 让动作引用真实执行**——这是 FOS 线**最重的门**(generic 路径上第一次真实外部执行/写),设计锁要求其单独 own review + negative controls + **owner ratify apply** + sandbox-first。
> 本文提出**可 ratify 的 apply 安全模型**(committed,非仅列开放问题),ratify 后 impl 机械化。**apply 仍未授权、未开启**,直到 owner 明确 ratify apply。

## 0. 一句话

dry-run(FOS-4b-2)已能在 generic route 校验动作引用并 values-free 预览,**不写不执行**。apply 在 dry-run 之后、**凭 dry-run token** 真实执行被许可的预定义动作(如 PLM pull-BOM:读 PLM + 写回 multitable)。这是真实外部交互 + 写,**必须**复用既有 C6 两阶段安全生命周期与红线,不另起、不放松。

## 1. 现状(锚:既有 dry-run→apply token 生命周期)

- **C6 外部写**:`dryRunToken` 由 dry-run 产出;apply 经 `VALID_C6_WRITE_APPLY_CONFIRM_KEYS = {dryRunToken}` 校验,缺 token → `C6_WRITE_DRY_RUN_TOKEN_REQUIRED`(400)。token **把 apply 绑定到一次具体 dry-run**,杜绝盲 apply。
- **stock-prep 动作 apply**:`dryRunStockPreparationAction` → `applyStockPreparationAction`(`stock-preparation-apply-writer.cjs`);per-row 隔离 + `dead-letter.cjs` 收口。
- **FOS-4b-2 dry-run(已合并)**:generic route `dryRun` 模式校验动作引用(注册表 ∩ preset.permittedActionIds,FOS-4b-1)+ values-free preview;preview 在 kernel 前 return → **零 patch / 零执行**;非 dryRun + 动作 → fail-closed(apply 未开)。
- **standing 写安全约束(继承,不可放松)**:凭据仅经 credential store(绝不 request);**首笔真实外部写 = 独立 owner 授权,sandbox-first**(多样本只读 dry-run → sandbox apply → re-pull 幂等 + 人工字段保留 → 生产);两阶段 dry-run→apply;per-row 隔离不 batch-abort;无自动重试打爆;dead-letter 收口;**K3 Submit/Audit/BOM 红线不开**;values-free evidence。

## 2. 提议的 apply 安全模型(committed — 请 ratify;非"开放问题")

1. **token-bound apply(无盲 apply)**:apply 必须携带由对应 FOS-4b-2 dry-run 产出的 `dryRunToken`;token 绑定 {preset, target, 动作引用集, 预览哈希}。缺/失配/过期 token → fail-closed(复用 `C6_WRITE_DRY_RUN_TOKEN_REQUIRED` 家族)。**dry-run 与 apply 之间 target revision 变化 → token 失效**(revision-fence),需重新 dry-run。
2. **同一 allowlist 闸**:apply 只执行 actionId ∈ 注册表 ∩ preset.permittedActionIds(FOS-4b-1),参数 ⊆ 注册表 allowlist;gating(`requiresDryRun`/`requiredPermission`)由**注册表**决定。`requiresDryRun=true` 的动作**必须**经过 dry-run(token 即证据)方可 apply。
3. **复用既有 apply writer + C6 生命周期,不另起**:apply 走 `stock-preparation-apply-writer.cjs` / C6 token-apply 路径(generalize,不复制);**per-row 隔离**(单行失败不 batch-abort)、**dead-letter 收口**、**无自动重试打爆**。
4. **凭据只经 credential store**:apply 执行动作时,外部系统凭据仅经 credential store 解析;request / preset / 浏览器**绝不**携带凭据。
5. **首笔真实 apply = owner-gated sandbox-first**(硬性):ratify apply 后,**仍**按 sandbox-first 序列推进——多样本只读 dry-run → sandbox apply → re-pull 幂等 + 人工字段保留校验 → 生产;**首笔生产 apply 单独 owner 授权**。
6. **K3 红线不开**:pull-BOM 等动作的 **K3 Submit / Audit / BOM-写-K3 红线绝不放松**;apply 只做动作既有授权范围内的执行(读 PLM + 写回 own-sheet multitable),不经 apply 打开任何 K3 写。
7. **values-free evidence**:apply 结果只记 actionId / 行数 / 成功失败计数 / dead-letter 计数 / 错误码;**无**参数值 / 源行 / 凭据 / sheetId。

> 一句话:**apply = 凭 token 的、allowlist 闸内的、复用 C6 per-row+dead-letter 的、凭据走 store 的、sandbox-first 的真实执行;K3 红线与 values-free 不变。**

## 3. 开放子选择(仅此需 owner 拍板)

- **3a. apply writer 复用粒度**:apply 直接复用 `applyStockPreparationAction` / `stock-preparation-apply-writer`(stock-prep 专属,**推荐**:首版 generic apply 仅支持注册表里现有的 stock-prep 动作 → 直接复用,零新写路径),还是抽一层 generic apply writer(更通用,但引入新写路径,风险更高)?**推荐:复用,首版只跑已注册动作。**
- **3b. token 来源**:apply 的 `dryRunToken` 来自 FOS-4b-2 generic dry-run(**推荐**,同一 generic 路径闭环),还是允许 stock-prep route 的 token 跨用?**推荐:仅接受 FOS-4b-2 generic dry-run 的 token(同源闭环)。**
- **3c. 首版 apply 范围**:首版是否仅 sandbox(不接生产 target),把"生产 apply"再作为一个独立 owner gate?**推荐:是**——FOS-4b-3 impl 首版 sandbox-only,生产 apply = 之后独立授权。

## 4. Gated 分刀(ratify §2/§3 后,各自独立 opt-in + own review)

- 🔒 **FOS-4b-3(本设计锁,docs-only)**:apply 安全模型 + token/allowlist/writer/红线 契约 + negative controls + 分刀。**无 runtime/UI/migration;不开任何执行。**
- 🔒 **FOS-4b-3-impl(sandbox-only,gated on ratify apply)**:generic route apply 路径(token-bound + allowlist 闸 + 复用 apply writer + per-row + dead-letter),**sandbox target only**;stock-prep 既有 apply 零漂移;经验非空洞(断 writer → 测试 fail)。
- 🔒 **FOS-4b-3-prod(首笔生产 apply)**:独立 owner 授权;sandbox-first 序列证完(re-pull 幂等 + 人工字段保留)后,单笔生产 apply。
- 🔒 **FOS-4b-3-UI**:dry-run preview → apply 确认(two-step,token 透传)。

## 5. Negative controls(impl 各刀必测)

```text
apply 无 dryRunToken → fail-closed(C6_WRITE_DRY_RUN_TOKEN_REQUIRED 家族)
token 与 preset/target/动作集 失配 或 target revision 已变 → fail-closed(revision-fence)
actionId ∉ 注册表 ∩ preset.permittedActionIds → fail-closed(与 dry-run 同闸)
requiresDryRun 的动作无对应 dry-run → 不 apply
requiredPermission 不足 → 403
单行执行失败 → 该行入 dead-letter,不 batch-abort,不自动重试打爆
凭据出现在 request/preset/浏览器 → reject(只经 credential store)
K3 Submit/Audit/BOM 写 → 绝不经 apply 打开(红线)
evidence values-free(无参数值/源行/凭据/sheetId)
stock-prep 既有 dry-run/apply 行为 → 零漂移
```

## 6. 红线 / 边界

```text
docsOnly=true   noRuntimeChange=true   noUiChange=true   noMigration=true   opensNoExecution=true
apply = token-bound + allowlist 闸 + 复用 C6 per-row/dead-letter + 凭据走 store
首笔真实 apply = 独立 owner 授权 + sandbox-first(多样本 dry-run → sandbox → re-pull 幂等/人工字段保留 → 生产)
K3 Submit/Audit/BOM 红线不开;无自动重试打爆;per-row 隔离;values-free evidence
浏览器仍只引用 actionId(从不定义/执行任意动作)——FOS-3/4b-1 不变式延续到 apply
```

## 7. 验收(本设计锁)

```text
apply 安全模型 committed(token-bound / allowlist 闸 / 复用 C6 writer / 凭据 store / sandbox-first / K3 红线 / values-free)= true
每个开放子选择有推荐默认(§3)= true
negative controls 枚举完备(§5)= true
分刀 gated(design-lock → sandbox-impl → prod → UI),首笔生产 apply 单独 owner gate = true
本设计锁不开启任何执行(opensNoExecution)= true
```

## 8. 终态声明

ratify §2/§3 后,FOS-4b-3-impl(sandbox-only)即机械化;但 **apply 永不在无 owner 明确 ratify apply 时开启**,且**首笔生产 apply 永远是独立 owner 授权**(sandbox-first 证完之后)。本设计锁交付**模型 + 计划**;真实执行待 owner 决策。其余 FOS 余项不变:真实业务域 preset(需 named target)、scheduled(需 named demand)。
