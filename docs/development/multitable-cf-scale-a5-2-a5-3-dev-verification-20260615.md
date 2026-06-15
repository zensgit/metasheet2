# 多维表 A5-2 / A5-3 条件格式（色阶 + 图标集）— 开发 & 校验 — 2026-06-15

> Status: **DONE + VERIFIED**（A5 范围型条件格式弧的最后一个 autonomous slice）。本文为该 slice 的开发与校验记录，并据当前 plan/todo 文件（`multitable-remaining-goal-dev-verification-20260615.md` §5/§6、`multitable-conditional-format-scale-designlock-20260615.md`）诚实标定 goal 余下项的门控分类。注意：本文**只**主张「已 opt-in 弧（A5 / B1-a）内的 autonomous 工作收口」，**不**主张「全 backlog autonomous 已尽」（见 §3 — B6 反应-API 后端半仍 autonomous-eligible 待 opt-in）。
>
> 交付 PR：**#2664**（`feat(multitable): conditional-formatting color scale + icon set (A5-2/A5-3)`）。

---

## 0. 本 slice 的位置（grounded 当前 todo）

A5 范围型条件格式弧分三个 kind：

- **A5-1 data bar** — 已建到渲染（后端契约 #2639 + FE 镜像/网格渲染 #2640）。
- **A5-2 color scale / A5-3 icon set** — **本 slice**。设计锁 #2637 已定 §2.1 配置形（color scale `stops[{at,color}]`；icon set 绝对阈值），本 PR 补齐**后端契约 + FE 镜像 + Trap-E 守卫**。渲染（在格内画色块 / 画图标）仍是 **browser-gated** 后续。

按 `multitable-remaining-goal-dev-verification-20260615.md` §6 推荐序：①B1-a1（已合并 #2653 executor core + 路由）→ **②A5-2/A5-3 后端契约（本 PR）** → ③A2 服务端导出残余 / masking 旗标核验。本 PR 落 ②，并顺手把 ③ 的 masking 旗标核到位（§4），三项 autonomous 全部收口。

---

## 1. 开发（做了什么）

### 1.1 后端 — `packages/core-backend/src/multitable/conditional-formatting-service.ts`（**canonical**）

- **配置类型**（设计锁 §2.1 锁形）：
  - `ConditionalFormattingColorScaleStop = { at: 'min'|'mid'|'max'; color }`、`ConditionalFormattingColorScaleConfig = { stops }`。
  - `ConditionalFormattingIconSetName = 'arrows3'|'traffic3'|'signs3'`、`ConditionalFormattingIconSetConfig = { set; thresholds: [number, number] }`（**绝对**阈值，非百分位——锁定类型无 mode 字段）。
  - `ConditionalFormattingScaleRule` 增 `colorScale?` / `iconSet?`。
- **`lerpHexColor(a, b, t)`**（导出）：支持 `#rgb` / `#rrggbb` / `#rrggbbaa`（alpha 剥离），`t` clamp 到 `[0,1]`。
- **`sanitizeConditionalFormattingScaleRule`** 改为**按 kind 分支**：共享 id/fieldId/order/enabled/range 解析（`base`）后：
  - `colorScale`：crash-safe `isPlainObject` 嵌套访问；stops **按名（`at`）** 解析，2 或 3 个；hex 校验；同名去重拒绝；必须含 `min`+`max`（3-stop 再要 `mid`）。
  - `iconSet`：set 枚举 + thresholds 长度 2 + 严格单调 `t0 < t1`（**不静默交换**）。
- **`FieldScalePresentation` 改为 ADDITIVE**（非判别联合，全可选）：`dataBar→barPct/barColor/negative`、`colorScale→scaleColor`、`iconSet→iconKey`。加 `kind:` 判别符会把自己强加到已发的 data-bar 形上、破坏 #2640 渲染器/测试——故走 additive。
- **辅助** `colorScaleColor(cfg, v, min, max)`（degenerate `span<=0`→t=1→max stop；3-stop 在 0.5 处分段）、`iconSetKey(cfg, v)`（`${set}:${index}`，按绝对阈值分桶）。
- **`buildFieldScaleMap`** 循环：保留 `!enabled` + 每字段优先级（first rule per field wins）守卫；增按-kind 配置守卫；每记录按 kind 产出 presentation；非数值跳过；degenerate → max stop。

### 1.2 FE 镜像 — `apps/web/src/multitable/utils/conditional-formatting.ts` + `types.ts`

与后端**逐行同义**（项目约定：FE 是 canonical 后端的镜像）。补 `colorScale`/`iconSet` 配置接口、`ICON_SET_NAMES` + `lerpHexColor`、按-kind `sanitizeScaleRule`、additive `FieldScalePresentation` + `colorScaleColor`/`iconSetKey`、按-kind `buildFieldScaleMap`。

### 1.3 网格渲染守卫（Trap E）— `apps/web/src/multitable/components/MetaGridTable.vue`（`cellStyle`, ~:604–611）

data-bar 渲染现守 `typeof scaleEntry.barPct === 'number'`：

```ts
const scaleEntry = props.conditionalFormattingScale?.byField[fid]?.byRecordId[rid]
const scale = scaleEntry && typeof scaleEntry.barPct === 'number' ? scaleEntry : undefined
```

→ colorScale/iconSet presentation（无 `barPct`）**绝不**会被画成 `linear-gradient(… undefined% …)` 而回归已发的 data-bar 渲染。A5-2/3 自身的格内渲染是 browser-gated 后续。

---

## 2. 校验（怎么证的）

| 校验项 | 结果 |
|---|---|
| 后端单测 `multitable-conditional-formatting.test.ts` | **75 passed**（A5-1 52 + 本 slice **+23**） |
| FE 镜像 parity `multitable-cf-scale.spec.ts` | **15 passed** |
| FE 网格 jsdom `multitable-grid-databar.spec.ts` | **6 passed**（含 2 个 Trap-E 回归守卫） |
| 后端 `tsc --noEmit` | exit 0（clean） |
| CI `test (18.x)` / `test (20.x)`（含 `pnpm -r type-check` → `vue-tsc -b`） | 双 Node 版本 **均 pass** = FE 类型门绿 |
| #2664 全部 required checks | pass（无 failing / pending） |

### 2.1 单测覆盖要点（防 false-green）

- **color scale sanitizer**：2-stop / 3-stop round-trip；stop 数非 2/3 拒；非 hex 拒；未知/重复 `at` 拒；缺 min·max·mid 拒；stops 非数组 / 配置缺失拒。
- **color scale builder**：端点取**精确** stop 色；中点插值 `#000000→#ffffff @0.5 = #808080`；3-stop 在中值处取 mid 色、四分位 `#000000→#ff0000 @t*2=0.5 = #800000`；degenerate（全等）→ max stop；非数值跳过；**presentation 设 scaleColor、绝不设 barPct/barColor（Trap B/E）**。
- **icon set sanitizer**：三套名各 round-trip；未知 set 拒；thresholds 长度非 2 / 非数值拒；非单调（含相等）拒；配置缺失拒。
- **icon set builder**：桶边界 `v<t0→0`、`t0<=v<t1→1`、`v>=t1→2`（**精确测 v=t0、v=t1 边界**）；非数值跳过；iconKey 形 `set:index`；不设 barPct/scaleColor。
- **`lerpHexColor`**：t=0/1 取端点；中点；clamp 越界；3-digit 展开 + 8-digit alpha 剥离。
- **网格 Trap-E 回归**：colorScale / iconSet 的 byField entry → 单元格 `backgroundImage === ''` 且不含 `undefined`。

### 2.2 持久化往返（防「加字段被序列化投影丢」盲点）

`conditionalFormattingScaleRules` 存于 **view config** 的不透明 JSON blob：

- 写：`routes/views.ts:152` `UPDATE views SET config = $1` 存 `JSON.stringify(config)` **整块**。
- 读：`routes/views.ts:92` `JSON.parse(view.config)` 后整体 spread；**无任何按字段投影**。
- 后端**不** sanitize/build scale 规则（`univer-meta.ts:166` 仅 import 算子规则的 `sanitizeConditionalFormattingRules`，**非** scale）；scale 规则净化在 FE 读取时由 `extractScaleRulesFromConfig` 完成，现已认 colorScale/iconSet。

→ 新增的可选 `colorScale`/`iconSet` 字段作为不透明 JSON 透明往返，**无投影丢字段路径**。（这正是「按字段拷贝/白名单/pick/projection 才需 round-trip 集成测」规则下的「opaque JSON → 安全」一档。）

### 2.3 A2 服务端导出 masking 旗标核验（todo §4 待核项 — 现核到位 = SAFE）

§4 提出疑：FE 客户端导出（`MultitableWorkbench.vue:~2585`，从 `grid.rows.value[].data` 读 `scopedGridFields`）是否泄漏 actor 无权读的字段值？**独立核验（code-grounded）结论：SAFE，无需改码。**

`grid.rows.value[].data` 在**所有**读/回显路径均经 `filterRecordDataByFieldIds(data, allowedFieldIds)` 服务端掩码：

- 载入视图 GET：`univer-meta.ts:8128`
- 单记录 GET：`univer-meta.ts:9319`
- patch 回显（含同表/跨表关联）：`record-write-service.ts:911 / 946 / 1037`
- patch 单记录：`univer-meta.ts:9024`

`allowedFieldIds` = `fieldPermissions[f].visible !== false`（排除拒绝 + 受污染）；依赖被拒外表 lookup 的公式字段经 `maskStoredRecordFieldIds`（`:7865`）从 allowed 集排除，不入 `row.data`。客户端导出只能落已授权值 → 无字段级泄漏。A2 服务端导出残余的 autonomous 半（列/行选择器 #2635）已发；masking 旗标核验确认非洞。

---

## 3. Goal 终端（诚实）

**精确表述（区分两件不能混的事）**：

- ✅ **当前已 opt-in 的弧（A5 范围型条件格式、B1-a 按钮字段执行核）内的 autonomous 工作已 done + verified。**
- ⚠️ **不等于「backlog 里无 autonomous 工作可做」。** 仍有 autonomous-eligible 项，但它们是**新弧**，按 staged-opt-in lineage 纪律（「never auto-start the next link」）各需自己的具名 opt-in 才启动——不自动排期、不自动开工。

据 `multitable-remaining-goal-dev-verification-20260615.md` §5 逐项分四类（而非三类——A1 与 B6 各横跨「能自动建」与「门控」，需单列）：

**A. Done + verified（已 opt-in 弧内的 autonomous，本/近会话收口）**
- B1-a1（#2653 executor core + button/run 路由，已合并）· **A5-2/A5-3 后端契约（#2664，本 slice）** · A2 服务端导出残余 + masking 核验（#2635 + §2.3 核验 SAFE，`univer-meta.ts:8128` 已亲核 `filterRecordDataByFieldIds(row.data, allowedFieldIds)`）。

**B. Autonomous-eligible，但属新弧 / 待具名 opt-in（不自动开工）**
- **B6 评论 emoji 反应的「反应存储 + API」后端半**——§5 明示「半边其实可自动」（纯后端 + 单测可闭环）。**不现做的诚实理由是 staged-opt-in lineage 纪律（新弧待 opt-in），不是「browser-gated」**；其 emoji picker 终端 slice 才是 browser-gated（见 C）。
- **A1 网格窗口化（virtualization）的 FE 实现本身可自动建**——但**终端验证需你的 S5b staging 基线**（性能/滚动只能在真环境证）。即「可自动建、验证门控」第三态，既非 A 的干净收口、也非纯 owner-gated。

**C. Browser-gated 终端 slice（后端可自动，终端需真浏览器做 configure→render→click + 目检）**
- B1-b（按钮态渲染）· B1-c（FieldManager 配置 UI）· **A5-2/3 渲染**（格内色块/图标 + 对齐/对比度/frozen 滚动观感，jsdom 证不了）· A3 内联链接展开 · A4 表单逻辑深度 · B4 仪表盘非图表组件 · B5 longText in-cell @mention · B6 emoji picker（B 的终端半）。

**D. Owner/ops-gated（需特权人动作 / 具名需求，无自动代码路径）**
- A1 的 **S5b staging 基线**（B 中 A1 的验证门）· B7 行级规则权限（安全敏感，对抗式评审 lane）· B2 AI auto-trigger / B3 原生同步表（owner 章程解锁）· C1 SMTP（ops 凭据）· C2 模板行业内容（PM/SME）· C4 移动/PWA（无具名需求）。

**结论**：本会话把**已 opt-in 弧（A5 / B1-a）内的 autonomous 工作推进到 done + verified**，并核掉 A2 masking 疑点。**未**主张「全 backlog autonomous 已尽」——B6 反应-API 后端半仍 autonomous-eligible（新弧待 opt-in），A1 窗口化可自动建但验证挂 S5b。其余 browser/owner-gated 项只能设计锁定 + 诚实标门，需真浏览器真路径 + 目检或特权人/具名需求解锁。

### 3.1 残余风险（唯一真实）

不是代码 blocker，是**校验边界**：jsdom 只能证 style string / emit / 优先级 / 不产 `undefined%`，证不了真实浏览器里色阶的对齐、对比度、图标字形与 frozen 滚动观感。故 A5-2/3 的**渲染**显式留作 browser-gated；有浏览器/app 访问后，配置→渲染一次会话内连同 B1-b/c 一起做目检。

---

## 4. 落地

- 本 slice = PR **#2664**（7 文件：后端 service + 测、FE types + util + 2 测、MetaGridTable 守卫）。
- 本文 = A5-2/3 开发 & 校验记录 + goal autonomous 终端标定（docs-only）。
- 下一步（非 autonomous）：按 §3 门控推进——A1 需先跑 S5b staging 基线；B1-b/c 与 A5-2/3 渲染等浏览器 slice 在同一浏览器会话内做真路径 + 目检。
