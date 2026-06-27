# 多维表 对标飞书 — Benchmark Refresh + 下一弧决策图 — 2026-06-27

> Status: **RESEARCH / 决策输入**(内部对标，可引用飞书)。总目标 `multitable-benchmark-surpass-goal`(对标并超越飞书多维表格)。
> 方法:子代理对 `origin/main` 全能力面取证(file/route 级)→ 对照 2026-06-11 ladder v3 先验 → 对标飞书 Base(飞书近况以 ~2026-01 知识为准,标注"待核")→ 重排候选弧。
> 取证根:`origin/main`(本地 checkout 落后,所有结论读自 origin/main)。

## 0. 三个改变结论的刷新发现

1. **cross-base 已经"上线"了,不是"待建"。** 06-11 ladder 把 cross-base 记为 rank 19「设计锁定待实现」。实况:cross-base link(单向跨 base、`foreignBaseId` 真值墙、外读按字段脱敏、自动化跨 base 写配额、TOCTOU 守卫、前端开关)**已 GA、无 flag、~25 真库测试**。所以这条弧是 **deepen(做深)而非 build(从零建)**。
2. **大量能力"已建未亮"。** 一簇能力 runtime 已完成但对用户不可见:**DARK**(默认关 flag,含我们刚建的配置恢复 Tier1/2、PIT Reset、Yjs 协同、AI、行级读权限)、**BACKEND-ONLY**(`delete_record`/`start_approval`/`form.submitted` 后端就绪但编辑器无 UI)、**INERT**(`webhook.received` 在枚举里但无入口、永不触发)。把这些"点亮"是异常便宜的成熟度收益。
3. **三处过期注释陷阱**(origin/main 已核实为过期):`permission-rule-evaluator.ts`「UNWIRED ON PURPOSE」、`restore-preview-identity.ts`「CONTRACT ONLY — not wired」、MEMORY 的「公式仅 form-submit / grid-edit 会 stale」——**都已接线/已闭合**,别据此误判。

**图例**:ON=默认可用 · DARK=代码全但 flag 默认关 · BACKEND-ONLY=后端就绪无 UI · INERT=仅枚举无运行路径 · PARTIAL=部分 · ABSENT=未建。

## 1. 刷新后的能力 ladder(多维表 vs 飞书 Base)

| 能力域 | 多维表现状 | vs 飞书 | 备注 |
|---|---|---|---|
| 字段类型 | 28+ 类型 ON(标量/计算/关联/系统全) | **≈ 持平** | 缺 群组(group)/级联(cascade);progress 仅用 percent 近似;button 作为可建字段仍 INERT |
| 视图类型 | grid/form/kanban/gallery/calendar/timeline/gantt/hierarchy **8 种全 ON** | **≈ 持平或略领先** | hierarchy+timeline+gantt 较强;飞书核心约 6 种 |
| 视图内配置 | 嵌套筛选/多级排序分组+小计/条件格式(18 算符)/色阶 ON | ≈ 持平 | 冻结列、行高=3 档密度(非自由像素)PARTIAL |
| 记录/历史/恢复 | CRUD+批量、编辑历史、逐字段/批量恢复、回收站、**全局历史中心+PIT 只读视图+Revert** ON | **领先** | 配置/schema 历史 + 恢复是飞书没有的纵深;但批量删=客户端循环(无原子端点);**日期提醒 ABSENT** |
| 公式/rollup/lookup | ~60 函数、rollup 11 reducer、lookup 字段、FOL 一跳、**grid-edit 重算已闭合** | 略落后(引擎) | 解析器是 simplified(无 AST/A1/范围/数组);关系聚合 `RELSUMIF` 等仅单调用、不可组合 |
| **cross-base** | 单向跨 base link + 治理墙 + 外读脱敏 + 跨 base 自动化写 **ON(已 GA)** | **领先(超越轴)** | 深度缺口=两向 mirror 同步 / 跨 base 条件关系聚合(`#PERM!` bug)/ 引用完整性级联(无 FK)/ 跨 base 视图筛排 |
| 权限 | 角色 grant + 字段级 visible/read_only ON;**行级读 deny + 条件读规则 DARK** | ≈ 持平(但 DARK) | 条件可见性是展示层非安全边界 |
| 自动化 | 8 触发 / 14 动作 / 条件分支 / 审批即任务 ON | ≈ 持平 | `webhook.received` INERT(无入站);`delete_record`/`start_approval` BACKEND-ONLY;cron 仅 ~5 粗模式 |
| 仪表盘/图表 | 9 图表 + 6 聚合 + 跨面板联动 ON | ≈ 持平 | 第二条 `/dashboard/query` 无前端=死路 |
| 实时协同 | presence + 逐格光标 ON;**Yjs CRDT 共编 DARK(POC)** | **落后** | 飞书强项;且 schema/config 变更不广播=协作者看到过期 schema |
| 导入/导出 | CSV/TSV/XLSX 导入 + 导出(权限脱敏)ON | ≈ 持平 | — |
| API/Webhook | token 全生命周期、**但只读路由可达(写 scope INERT)**;webhook 仅出站 | **落后** | 飞书开放 API 读写全;入站 webhook 缺 |
| AI | 真 provider(Anthropic/OpenAI)、字段 shortcut/bulk-fill/NL→公式 **DARK** | ≈ 持平(已建) | flag+key+双确认才开 |
| 模板 | 8 内置模板 + 安装/dry-run ON | **落后** | 无"存为模板"/市场/分享 |
| 移动端 | **ABSENT**(web 多维表无移动/响应式代码) | **明显落后** | 飞书移动强;独立大工程 |

**一句话**:核心表格/字段/视图/公式/仪表盘/自动化面**已对标到位甚至领先**(视图、cross-base 治理、配置历史恢复是领先项);**真落后只在**实时共编、移动端、模板平台、日期提醒、入站自动化、API 写回。

## 2. 重排候选弧(我的排序)

### ★ 候选 A:cross-base 做深(「超越」旗舰) — 推荐
- **为何**:cross-base 是多维表对飞书的**真差异化**(飞书关联基本同 base 内;跨 base/跨部门工作流是飞书弱项)。地基已 GA、前提(字段级权限+外读脱敏)已是已上线基础,06-11 预标"prereqs met"成立。
- **范围(4 块,按价值)**:(b) **跨 base 条件关系聚合修复+扩展**——`RELSUMIF/RELCOUNTIF/RELLOOKUP` 现对任何跨 base sheet 返回 `#PERM!`,**连授权读者都被挡=真 bug**,修它+让其可组合;(c) **引用完整性/级联**——`meta_links` 无 FK,悬挂边只报不修,补级联/修复;(a) 两向 mirror 跨 base 同步;(d) 跨 base 视图按外字段筛排。
- **性质**:含一条真 bug 修(b),纵深 + 正确性双收益。重,但旗舰。

### 候选 B:可用性扫荡(「把已建的点亮」) — 推荐作为并行快弧
- **为何**:审计揭出异常多"已建未亮"。把它们变可用,**几乎零新建成本**就直接推进对标(功能本就在,只是没开)。
- **便宜档(低风险)**:暴露 BACKEND-ONLY UI(`delete_record`/`start_approval` 动作、`form.submitted` 触发进编辑器下拉)· 死 `/dashboard/query` 清理 · 原子批量删端点 · 真 cron 解析器 · 修三处过期注释。
- **需 staging-first 的 DARK 档(各自独立放量,非一键翻)**:配置恢复 Tier1/2(刚建)、PIT Reset(+ 接上孤儿 `ResetConfirmDialog.vue`)、行级读权限、AI、Yjs。**这些 flag 默认关是有安全理由的,逐项 acceptance-harness 放量,不是 sweep。**

### 候选 C:补真落后项(对标补齐)
- **日期提醒**(小、高价值:飞书有"截止前 N 天提醒",多维表无任何日期触发原语)——便宜,建一个 date-based trigger 原语。
- **API 写回**(把 INERT 写 scope 接上 token 可达路径)——中等,企业集成价值高。
- **实时共编 productionize**(Yjs DARK→GA)——大,飞书强项,但 POC 范围窄(逐记录、不含 create/delete/字段权限),productionize 是独立大弧。
- **模板平台 / 移动端**——各自独立大工程,本轮不建议。

## 3. 我的建议(净)

**主弧开 A(cross-base 做深),并行插 B 的"便宜档"。**
- A 是唯一的"超越"轴且地基已齐,从 **(b) 关系聚合 `#PERM!` bug** 切入——它既是真 bug 又是纵深起点,fail-first 容易、价值即时。
- B 的便宜档(暴露 BACKEND-ONLY UI + 死路清理 + 过期注释)风险低、ROI 高,可与 A 并行、独立小 PR。
- B 的 DARK 放量(尤其刚建的配置恢复 Tier1/2)按**逐项 staging-first acceptance** 走,不在本弧一键翻。
- **日期提醒**(候选 C 头部)是个便宜的对标补齐,可作为 A/B 之外的轻量第三股。
- 移动端 / 实时共编 productionize / 模板平台 = 各自独立大弧,**本轮不开**。

## 4. 待 owner 拍板
1. 主弧 = A(cross-base 做深)确认?从 (b) `#PERM!` 切入确认?
2. 并行 B 便宜档(BACKEND-ONLY 暴露 + 清理)要不要现在一起开?
3. 日期提醒(C 头部)要不要插一股?
4. 刚建的配置恢复 Tier1/2 是否要排"staging-first 放量"(把 DARK→可用),还是继续躺着等需求?

> 飞书具体能力以 ~2026-01 知识为准;若近半年飞书有新增(如更强 AI/移动),本 ladder 的"落后"项可能更多——可在确认主弧前对飞书做一次 web 核验(若环境允许)。
