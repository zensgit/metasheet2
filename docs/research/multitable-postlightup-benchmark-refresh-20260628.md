# 多维表 — light-up 收口后的短 refresh + 剩余前沿"收益 vs 风险"重排 — 2026-06-28

> Status: **决策输入 / 状态note**(内部对标，可引用飞书）。总目标 `multitable-benchmark-surpass-goal`。
> 短刷新:在「便宜档 light-up」三刀收口后重排剩余前沿,按**对标收益 / 风险成本**给出下一轮候选,**不**从剩余列表硬开。
> 底账(不重导):`multitable-vs-feishu-benchmark-refresh-20260627.md`（飞书侧 web 核验，~1 天前仍现行）+
> `multitable-post-crossbase-frontier-decision-20260628.md`（#3326 前沿/门状态）。取证根 `origin/main` @ `6d5b24dbc`。

## 0. 自上次刷新后落地了什么

- **cross-base 做深弧**(#3300/#3306/#3312)— 已合(超越轴)。
- **便宜档 light-up 三刀**(都逐条 owner GO + review）：
  - date-reminder 触发原语 → `e64414297`（补飞书 deadline 提醒对标）
  - form.submitted 触发器 UI → `262b52524`（点亮已建未亮触发）
  - start_approval 动作 UI（+ [P1] workflow_job_v1 修复）→ `14398f4d3`（"表单提交→发起审批" UI 全链路）

**结论:便宜档"点亮"轴基本见底。** 剩唯一同类 = `delete_record`,但它是破坏性动作、不算便宜档(见下)。

## 1. 剩余前沿 — 收益 / 风险成本 重排（净）

> 收益 = 对标飞书的差距闭合价值(H/M/L) · 风险/成本 = 安全面 + 工程量 + 需要的前置决策

| 候选 | 对标收益 | 风险/成本 | 比值 | 前置门(开之前必须先有) |
|---|---|---|---|---|
| **API 写回**(把 INERT 写 scope 接上 token 可达路径) | **H**(飞书服务端 API 读写全、批量≤1000;我们只读 = 真落后,企业集成价值高) | **M-H**(写路径安全 + 配额;但是**有界后端 feature**,非大弧) | **最高(实质项里)** | 写路径安全/配额 **design-lock**(scope 边界、鉴权、配额、审计) |
| **AI DARK 放量**(字段 shortcut/bulk-fill/NL→公式,已建 DARK) | **H**(飞书 AI 字段捷径+智能汇总已 GA = 可用性真落后;我们能力建好只是关着) | **M-H**(security-DARK 逐项 staging-first + provider/cost 决策) | 高 | provider/model/cost 决策 + 逐项 acceptance-harness |
| 配置恢复 Tier1/2 DARK 放量(刚建,躺 DARK) | M(我方纵深,非飞书 gap) | M(security-DARK 逐项放量) | 中 | 逐项 staging-first 放量决策 |
| `delete_record` 动作 UI | **L-M**(补全动作集,非飞书 parity gap) | **H**(破坏性:perm/确认文案/执行日志/防误删边界) | **低**(收益小、风险高 → 你已正确暂缓) | 单独破坏性动作 design(perm/confirm/log/anti-misdelete) |
| 实时共编 productionize(Yjs DARK→GA) | **H**(飞书强项,我们落后) | **XL**(独立大弧 + POC 范围窄 + parallel-owned) | 中(高收益但高成本) | 独立立项(create/delete/字段权限的协同语义) |
| 移动端 | **H**(飞书明显领先,我们 ABSENT) | **XL**(独立大工程) | 中 | 独立立项 |
| 模板平台(存为模板/市场/分享) | M(飞书有,我们 8 内置) | L-M(独立中弧) | 中 | 独立立项 |
| 图表补齐(词云/雷达/地图/多数据源) | M(§A web-verified 飞书略领先) | M | 中 | — |

## 2. 推荐(净)— 仅作下一轮 forks,需你 GO

1. **若下一轮要继续推对标,最高收益/风险比 = `API 写回`**,但**第一步是 design-lock、不是直接 build**:写路径安全(scope 边界 / 鉴权 / 配额 / 审计)先锁,再开实现。这条把"只读 → 读写"闭合,是飞书有我们无的真企业级 gap。
2. **AI DARK 放量**收益同样高(可用性对标),但它是 security-DARK + provider/cost 产品决策 — 适合作为"决策先行"的并行候选,不是一刀点亮。
3. **`delete_record` / 大弧(实时共编 / 移动端 / 模板)** = 收益虽有但风险/成本不匹配便宜档,**本轮及下一轮都不建议顺手开**;各自独立立项。

## 3. 结论

**本轮收口**:cross-base 做深 + 便宜档 light-up 三刀全部落地验证,"表单提交→发起审批" UI 全链路可建。剩余项已按收益/风险成本重排,**没有"顺手就能开"的下一刀** — 最高比值的 `API 写回` 也要先 design-lock。
下一步是 owner 从 §2 里点一条(且多数要先过 design-lock / 产品决策门),而不是从剩余列表硬开。**符合"不静默解封 gated 项"的纪律。**
