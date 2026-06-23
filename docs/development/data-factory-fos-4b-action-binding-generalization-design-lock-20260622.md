# Data Factory FOS-4b — action-binding 泛化 设计锁定(2026-06-22)

> 状态:**DESIGN-LOCK 草案(待 owner 评审 + ratify 安全模型)**。**docs-only**:不授权任何 runtime / UI / migration 改动。
> 上游:FOS 线(field-option-sync)buildable scope 已闭合(见 `data-factory-fos-plan-and-verification-20260621.md`)。FOS-4b 是其中 **action-binding 泛化** 这一 gated 项。安全敏感,设计锁要求其各自 own review + negative controls;本文**提出可 ratify 的具体安全模型**(不是再列开放问题),ratify 后 impl 即机械化。
> 这是 FOS 线 **最后一个可自主推进的设计步骤**:本设计锁落地后,余下 FOS 工作全部 decision-blocked(named target / named demand / ratify 本模型),无可在无 owner 决策下继续构建者(见 §8)。

## 0. 一句话

stock-prep 的选项可绑定**预定义动作**(option → predefined action,如 PLM pull-BOM),经 FOS-3 走 stock-prep 兼容路径;generic field-option-sync route 对带 `actionBindings` 的请求**当前 fail-closed**(`FIELD_OPTION_SYNC_ACTIONS_NOT_SUPPORTED`)。FOS-4b 把这套**预定义动作绑定**安全地泛化到 generic 路径——**但绝不把"浏览器定义任意动作"引入 generic 路径**(FOS-3 dual-route 的存在正是为此)。

## 1. 现状(锚:stock-prep 预定义动作绑定模型)

`lib/stock-preparation-option-sync.cjs`:

- **冻结 allowlist** `PREDEFINED_OPTION_ACTIONS`(键 = actionId),每条:
  ```text
  { actionId, kind: 'table_action', requiresDryRun: true, requiredPermission: 'write',
    allowedParameterBindings: ['projectNo'] }
  ```
- `normalizeActionBinding`:请求里的 action **必须** actionId ∈ allowlist(否则 `OPTION_SYNC_ACTION_NOT_ALLOWED`);`parameterBindings` 只允许该 action 声明的键(stock-prep 仅 `projectNo → projectNo` 恒等);**浏览器只引用 actionId + 受限参数绑定,从不定义动作体**。
- **generic route(FOS-2b)**:`carriesActions`(per-option `actionBindings`/`actions` 数组)→ `FIELD_OPTION_SYNC_ACTIONS_NOT_SUPPORTED`(422,fail-closed)。
- **FOS-3 UI**:带 actionBindings 的请求 dual-route → 既有 stock-prep route(能力保留,非静默);文案明确"动作绑定走备料兼容路径(泛化待 FOS-4)"。

**关键不变式(必须守):动作执行**(table_action 等)是受 dry-run + 权限 + 受限参数门控的 side-effect;**绝不能**让 generic 路径接受**浏览器定义的新动作**——只能引用已注册的预定义动作。

## 2. 提议的安全模型(committed — 请 ratify;非"开放问题")

1. **全局冻结动作注册表**(generalize `PREDEFINED_OPTION_ACTIONS` → `FOS_PREDEFINED_ACTIONS`):服务端常量,每条 = `{ actionId, kind, requiresDryRun, requiredPermission, allowedParameterBindings }`。**新增动作 = 改这张表 + own review**,不经 preset、不经 request。stock-prep 现有动作原样并入(零漂移)。
2. **preset 声明一个 SUBSET**:FOS preset 增一字段 `permittedActionIds: [...]`(∈ 注册表)。preset **只能引用**注册表里的 actionId,**不能定义新动作行为**。未声明 `permittedActionIds` 的 preset = 不支持动作(沿用 fail-closed)。
3. **每个动作保留全部门控**:`requiresDryRun` / `requiredPermission` / `allowedParameterBindings` 由**注册表**决定(非 preset、非 request 可放宽)。generic route 校验:actionId ∈(注册表 ∩ preset.permittedActionIds)且 parameterBindings ⊆ 注册表声明,否则 fail-closed。
4. **浏览器只引用、不定义**:request 仅传 `actionId` + 受限 `parameterBindings`(值经现有 values-free / 安全字符串校验);**绝不接受动作体 / SQL / JS / handler / URL**。这**精确保留** FOS-3 不变式——generic 路径无任意动作执行。
5. **dual-route 收窄(非移除)**:FOS-3 的 "actionBindings → legacy" 改为:**注册表+preset 允许的动作** → generic 路径(经上述门控);**其余**(未注册 / preset 未许可 / stock-prep 专属)→ 仍 legacy 或 fail-closed。**不静默换路导致能力坏掉**(沿用 FOS-3 纪律 + 路径 DOM 可见)。

> 一句话:**注册表拥有动作定义与门控;preset 拥有"许可哪些";request 只拥有"引用哪个 + 受限参数"**。三层各自最小权限。

## 3. 开放子选择(仅此 1–2 项需 owner 拍板)

- **3a. 动作执行的 dry-run/apply 生命周期**:generic 路径的动作是否复用 stock-prep 现有的 dry-run→apply token 机制(推荐:**是**,复用同一受门控生命周期,不另起),还是 FOS-4b 仅做 **dry-run-only**(动作只预览不 apply,apply 留更后刀)?**推荐:dry-run-only 起步**(最小 side-effect 面),apply 作为独立 gated 子刀。
- **3b. 注册表归属**:`FOS_PREDEFINED_ACTIONS` 是 plugin 常量(推荐,轻、own-review 改),还是需运行时可配置(否——可配置 = 把动作定义权下放,违背 §2.1)。**推荐:plugin 常量。**

(其余 §2 各点为 committed 推荐,默认采用,除非 owner 改。)

## 4. Gated 分刀(ratify §2/§3 后,各自独立 opt-in + own review)

- 🔒 **FOS-4b(本设计锁,docs-only)**:安全模型 + 注册表/preset/route 契约 + negative controls + 分刀。**无 runtime/UI/migration。**
- 🔒 **FOS-4b-1(contract,lock-safe)**:抽 `FOS_PREDEFINED_ACTIONS` 注册表 + FOS preset 加 `permittedActionIds`(enum-strict ∈ 注册表)+ action-binding normalizer(generalize `normalizeActionBinding`);不接 generic runtime;stock-prep 行为零漂移。
- 🔒 **FOS-4b-2(generic route runtime,dry-run-only)**:generic route 接受 actionId ∈(注册表 ∩ preset.permitted)+ 受限参数 → 经 dry-run 门控;非许可 → fail-closed;FOS-3 dual-route 收窄。
- 🔒 **FOS-4b-3(apply 生命周期)**(若 §3a 选 apply):独立 gated;复用 stock-prep dry-run→apply token。
- 🔒 **FOS-4b-UI**:generic panel 暴露 preset 的 permitted 动作(引用式);文案更新。

## 5. Negative controls(impl 各刀必测)

```text
未注册 actionId → fail-closed(不静默忽略)
preset 未声明 permittedActionIds → 动作 fail-closed(等同今天)
actionId 不在 preset.permittedActionIds → fail-closed
parameterBindings 超出注册表声明 → fail-closed
request 携带动作体 / SQL / JS / handler / URL → reject(浏览器只引用 actionId)
requiresDryRun 的动作未经 dry-run → 不 apply
requiredPermission 不足 → 403
stock-prep 既有 option-sync + action 行为 → 零漂移(既有测试原样绿)
evidence values-free(动作只记 actionId / 计数,无参数值/源行)
```

## 6. 红线 / 边界

```text
docsOnly=true   noRuntimeChange=true   noUiChange=true   noMigration=true
动作定义权:仅注册表(own-review 改);preset 只许可子集;request 只引用
浏览器无任意动作执行(精确保留 FOS-3 dual-route 不变式)
metadata-only 选项写 + 受门控的预定义动作(dry-run/perms/受限参数);无浏览器 SQL/JS/handler
无 K3 Save/Submit/Audit/BOM 红线放松;首笔真实外部写仍独立 owner gate
values-free evidence
```

## 7. 验收(本设计锁)

```text
安全模型 committed(注册表/preset-subset/request-引用三层)= true
每个开放子选择有推荐默认(§3)= true
negative controls 枚举完备(§5)= true
分刀 gated(FOS-4b-1 contract → -2 dry-run runtime → -3 apply → UI)= true
FOS-3 不变式(无任意动作执行)明确保留 = true
```

## 8. 终态声明(FOS 线)

本设计锁落地后,**FOS 线无可在无 owner 决策下继续自主构建者**:
- action-binding impl(FOS-4b-1+)= 待 owner **ratify §2/§3 安全模型**;
- 真实业务域 preset = 待 owner **点名一个真实已 provision 的 target**;
- scheduled / after-source-refresh = 待 owner **具名调度 demand + 可观测要求**;
- append/keep_existing/manual_confirm 的 HTTP wire-test = 随上述真实 preset 用到时一并补。

即:可自主构建段(含本设计锁)已尽;余下三类各缺一个**仅 owner 能给**的决策。Stop hook 再触发时,诚实回应 = 持有并指出 decision-block,而非再造文档或盲开 runtime。
