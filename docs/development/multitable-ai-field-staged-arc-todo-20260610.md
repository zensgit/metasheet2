# 多维表 AI 字段 staged 主线 + parity 清尾副线 — 门控 TODO

> Date: 2026-06-10 · 配套计划:`multitable-ai-field-staged-arc-development-plan-20260610.md`
> 标记:✅ done · ⬜ todo(opt-in 后可动手)· 🔒 gated(被前置环/决策阻塞)
> 纪律:主线每环独立 opt-in;副线各项独立小 PR;AI 一律 fail-closed + 脱敏。
> 回填 2026-06-11:AI staged 主线 M0→M3 已闭合(#2486/#2490/#2494);本 TODO 仅保留 M4 gated 与副线未完成项。

## 0. 依据(2026-06-10 完成度审计,5-agent 条目级核验)

- 总纲 §9 八步:①D2 🟡(10k ✅/50k-100k 阻塞)②虚拟化 ✅决策关闭 ③D3 ✅ ④BI polish ✅ ⑤dry-run ✅ ⑥**AI ❌未建** ⑦模板 🟡(中心+install ✅/preview-onboarding ❌)⑧cross-base ❌(前提已齐)。
- RC 100%(69 项核验为真)· Phase2 功能 100% · Phase3 硬化门 ✅ + AI lanes 真实未建 · 多系列图表已由 BI v2-d(#2297→#2354)落地(open-items 标记 stale)。
- 审计工件:`/tmp/multitable-feishu-completion-audit-20260610.md`。

## 1. 主线 — AI 字段 staged

- [x] ✅ **M0 决策批准**(2026-06-10):全按推荐 + owner 两修正(①批准≠实现解锁,M1 实现另需显式解除 AI 线旧 defer gate;②R-2/internal-route 仅限 A1,A2/A3 产品路径届时按 sheet/field/record 权限重设计)→ `multitable-ai-field-staged-arc-m0-ratification-result-20260610.md`。
- [x] ✅ **M1a A1 设计锁定**:`multitable-ai-provider-readiness-a1-design-20260610.md` — resolver 镜像 email-transport-readiness / `requireAdminRole()` + internal 路由 / 门脚本 exit-2-blocked / 测试矩阵 A1-T1..T10(含三处泄漏哨兵)/ 零真实调用。
- [x] ✅ **M1b A1 实现**(#2486 MERGED `6a91b22c4` 2026-06-10):resolver + internal admin 路由 + tsx 门脚本;18 单元/路由 + 5 门测试 fail-first;审查泄漏狩猎 7 对抗场景零泄漏,APPROVE-WITH-NITS 全修后合并。**M1 整环闭合。**
- [x] ✅ **M2 A2 shortcut 后端**(#2490 MERGED `1e677208` 2026-06-11):design #2489 + 实现(preview/run、createRecordWriteHelpers 工厂(/patch 同源)、provider 客户端 fetchFn DI + E-12 双确认、台账 migration、**reserve-then-settle 配额**);审查 F1 major(跨 IO 持锁)→ 重构 → delta 复审 FIX-VERIFIED + NF-1 中文估算修复。**T1 + T6 关闭。**
- [x] ✅ **M3 A3 前端**(#2494 MERGED `a5809db11` 2026-06-11):design #2491 + 实现(config section、record drawer/cell triggers、run 响应适配器、429 双语义/503 blocked/422/502/409 状态 UX、usage-summary 管理员卡);后端 42 AI tests + route-level wire pin,前端 59/59 AI specs + 170/170 affected suites,review F3/F4 修复后合并。**T3 展示关闭;M0→M3 主线闭合。**
- [ ] 🔒 **M4 B2 公式 AI 辅助**(gated on M0-M3 closeout + 独立 opt-in;不随 M3 自动开启)。

## 2. 副线 — parity 清尾(已获 owner 总 opt-in 2026-06-10,可并行)

- [x] ✅ **S1 stale 文档 reconcile**(docs):phase3 plan/todo 四处 lane 级 stale + open-items S1-10 + research §7-4,按审计证据加 reconcile 注记。
- [ ] ⬜ **S2 模板 dry-run + 详情(工程缩减版)**:design-lock ✅(#2493,`multitable-template-dryrun-detail-s2-design-20260611.md`);⬜ 实现 = install dry-run 零写端点(与 install 同源冲突检测)+ 详情 UI。**范围修正:样例数据预览/onboarding/回滚策略 = #1571 C1 包 PM/SME 门控(G-4/G-6/T7),明示推迟**——原 S2 行的"含样例数据"在勘察后按既有门重新切分。
- [x] ✅ **S3 图表补全**(#2492 MERGED `a6b3986e5` 2026-06-11):area/funnel/gauge 端到端 + S1-9 异步 chunk(echarts 独立 chunk,EmbedHost 1.2M→760K 构建实证);**scatter 出局**(数据契约无 x/y 维度,需后端聚合新维度 = follow-up);polish 候选:gauge 非加性聚合文案、异步加载失败兜底、图表持久化 type 校验(F4 既有缺口)。
- [x] ✅ **S4 层级父链接单值约束**(#2488 MERGED `d928eff23` 2026-06-11):真实概念=`limitSingleRecord`;后端 view-config 校验镜像 gantt + 前端双选择器收窄 + parentInvalid 门控 bug 顺带修复;残留(field-PATCH 翻转/provisioning 旁路)已文档化。
- [ ] ⬜ **S5 D2 50k/100k 基线**(ops):修 undici harness → 跑全 perf budget;禁 async-import/seed-endpoint。

## 3. 收官

- [x] ✅ **AI staged 主线 closeout 验证 MD**(本 PR):`multitable-ai-staged-mainline-closeout-verification-20260611.md` 记录 #2486/#2490/#2494 当前证据与剩余 gates。
- [ ] 🔒 **副线验证 MD**(副线全清后落):per-slice 证据 + 本 TODO 打勾。

## 4. 明确不做(各既有 gate)

cross-base(总纲 #8,独立 opt-in)· FOL-3..9 · A2-full · B2 解析器 · C2a/C2b/C3 · D1 outbox · F2 · AI 自动化动作。
