# 多维表 AI 字段 staged 主线 + parity 清尾副线 — 门控 TODO

> Date: 2026-06-10 · 配套计划:`multitable-ai-field-staged-arc-development-plan-20260610.md`
> 标记:✅ done · ⬜ todo(opt-in 后可动手)· 🔒 gated(被前置环/决策阻塞)
> 纪律:主线每环独立 opt-in;副线各项独立小 PR;AI 一律 fail-closed + 脱敏。

## 0. 依据(2026-06-10 完成度审计,5-agent 条目级核验)

- 总纲 §9 八步:①D2 🟡(10k ✅/50k-100k 阻塞)②虚拟化 ✅决策关闭 ③D3 ✅ ④BI polish ✅ ⑤dry-run ✅ ⑥**AI ❌未建** ⑦模板 🟡(中心+install ✅/preview-onboarding ❌)⑧cross-base ❌(前提已齐)。
- RC 100%(69 项核验为真)· Phase2 功能 100% · Phase3 硬化门 ✅ + AI lanes 真实未建 · 多系列图表已由 BI v2-d(#2297→#2354)落地(open-items 标记 stale)。
- 审计工件:`/tmp/multitable-feishu-completion-audit-20260610.md`。

## 1. 主线 — AI 字段 staged

- [x] ✅ **M0 决策批准**(2026-06-10):全按推荐 + owner 两修正(①批准≠实现解锁,M1 实现另需显式解除 AI 线旧 defer gate;②R-2/internal-route 仅限 A1,A2/A3 产品路径届时按 sheet/field/record 权限重设计)→ `multitable-ai-field-staged-arc-m0-ratification-result-20260610.md`。
- [ ] ⬜ **M1a A1 设计锁定 docs PR**(M0 已批,可先行):替代已失 `/tmp` 草稿,按 M0 决议(R-1..3 A1 限定 / Option B / shape defer / E-1..12 / P-1 / Q-1..4)。
- [ ] 🔒 **M1b A1 实现 PR**(gated on **owner 显式解除 AI 线 defer gate**,见 ratification-result §3):resolver + readiness 内部路由 + `disabled/blocked/ready` 状态机 + 脱敏 + fail-closed;**零真实 provider 调用**。
- [ ] 🔒 **M2 A2 shortcut 后端**(gated on M1):preview/run 端点 + 成本台账 + 配额执行(关 T1)+ 4 保留态推导(关 T6)+ 双确认真实调用门;design-lock 先行。
- [ ] 🔒 **M3 A3 前端**(gated on M2):shortcut 配置 + 单元格 preview/run + blocked 安全态 + 成本可见性(关 T3 展示);design-lock 先行。
- [ ] 🔒 **M4 B2 公式 AI 辅助**(gated on M1-M3 验证 + 独立 opt-in)。

## 2. 副线 — parity 清尾(已获 owner 总 opt-in 2026-06-10,可并行)

- [ ] ⬜ **S1 stale 文档 reconcile**(docs):phase3 plan/todo 四处 lane 级 stale + open-items S1-10 + research §7-4,按审计证据加 reconcile 注记。
- [ ] ⬜ **S2 模板 preview/dry-run**(runtime,design-lock 先行):预览(含样例数据)+ install dry-run 零写端点 + 详情 UI。
- [ ] ⬜ **S3 图表补全**(runtime):scatter/area/funnel/gauge(纯渲染层)+ S1-9 echarts 异步 chunk。
- [ ] ⬜ **S4 层级父链接 maxValues=1 约束**(runtime,小):消除多值链接静默覆盖风险。
- [ ] ⬜ **S5 D2 50k/100k 基线**(ops):修 undici harness → 跑全 perf budget;禁 async-import/seed-endpoint。

## 3. 收官

- [ ] 🔒 **验证 MD**(主线 M1-M3 或副线全清后分别落):per-slice 证据 + 本 TODO 打勾。

## 4. 明确不做(各既有 gate)

cross-base(总纲 #8,独立 opt-in)· FOL-3..9 · A2-full · B2 解析器 · C2a/C2b/C3 · D1 outbox · F2 · AI 自动化动作。
