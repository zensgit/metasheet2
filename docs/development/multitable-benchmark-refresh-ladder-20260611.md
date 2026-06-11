# 多维表对标飞书 — 差距阶梯刷新(post-AI-arc)— 2026-06-11

> Status: **REFRESH(总纲 `multitable-feishu-benchmark-20260522.md` 的 v3 阶梯刷新)**
> 方法:3 并行差距审计员(剩余阶梯 / quick-wins / follow-up 池)逐项对 `origin/main@932b350df`(#2505)核验代码与 PR 现实,1 综合器按总纲四原则(measurement→optimization · enterprise-baseline→differentiation · foundations→advanced · stability→risk)重排。
> 配套:benchmark-surpass goal(memory)+ cross-base 勘察(2026-06-11)。

## 0. 自上次基准以来已闭合(核验为真,非文档标记)

§8-2 评论@推送(#636/#641/#656)· §8-6 inline create row(#1834)· §8-7 冻结列(#1837)· §4 聚合页脚+分组小计(#1841/#1852,服务端全集语义)· §5 number unit + 公式 type 校验诊断 · **§3 Gap 6 "缺 HMAC" = 写基准时即已过期**(webhook-service.ts:575 早有 HMAC-SHA256)· §7-A 实时已事件驱动(非轮询)· AI 字段整弧(M0-M3,14 PR)· 图表 area/funnel/gauge + 多系列 + S1-9 异步 chunk · S1-S5a 副线。

## 1. 重排后的执行阶梯(19 项)

> 原 6 项预测阶梯被重排:cross-base 从预测 #2 → **实测 #19**(理由见 §2)。

**A 组 — 测量与账本先行(gate-free,rank 1-3)**
1. **计划账本对账 + 分支卫生**[S,无门]— 本刷新文档 + benchmark §13 v3 changelog;此仓两次 stale-marker 翻车(#2177/C5-2)→ 先校准计划本身。
2. **质量打磨批(已发布面的正确性,一条 lane)**[S,单 opt-in + 1 个一行 UX 决策]— 按序:stripUrlUserinfo 首-@ 边角(安全相邻,先做)→ S5a N1/N4 → gauge 非加性文案 → 异步 chunk 失败兜底 → 图表持久化 type 校验(F4)→ aiShortcut canonicalization 注记 → all-sources-deleted UX(F2:零幸存=needs-attention vs 自动禁用,需你一句拍板)。
3. **S5b 50k/100k staging 基线**[S 工程/M 运维,**operator-gated**]— #2497 harness,首跑 XLSX_CHUNK_SIZE=20000、独占串行;§9 step 1 的容量锚点。

**B 组 — 企业基线先于差异化(rank 4-8)**
4. **§8-4 生产 SMTP 真实发送验收**[S,**ops 凭据门**]— 一次性运维动作闭合 §3 Gap 5 Phase 1。
5. **§8-1 webhook 出站管道接线("一刀")**[S-M,owner opt-in]— 今天 API/UI 承诺投递但实际静默不发(比缺失更糟);HMAC 代码已存在,缺启动接线 + retry tick + 真事件链测试。
6. **§8-5 webhook retry 策略配置 + send_webhook 加固**[M,**严格在 #5 之后**]。
7. **修复 + CI 接线 multitable-view-config.api.test.ts**[M]— main 上 4/7 红的死回归网(skip-when-unreachable 盲点活样本),rank 10/13/15 都依赖它。
8. **§8-3 lock_record 存储契约 + 重新暴露**[M,owner 设计决策 + A6-3 lane 后]。

**C 组 — 已发布面的稳定债 + AI 收尾(rank 9-11)**
9. **AI 用量台账留存/aging**[M,迷你留存决策]— **刻意排在 M4 前**:M4 会加第三个台账写入方,先定留存契约。
10. **S4 残留 limitSingleRecord true→false 翻转语义**[M,小设计决策]。
11. **M4 公式 AI 辅助(deferred-eval→impl)**[M,**deferred-eval + 独立 opt-in**]— 基底 100% 建成(#2505),边际成本史上最低;纯杠杆会排更高,但 baseline 优先。

**D 组 — parity 补齐(rank 12-16)**
12. scatter x/y 二维聚合[M,轻设计锁]· 13. 小 parity 批(§4/§5/§6 的 S 项,一条 lane:per-cell 评论触发/进度条 gauge cell/person 头像 chip/附件缩略图/导出选择)· 14. **C1 模板 PM 包**[M,**PM/SME 内容门**,并行 lane]· 15. 规则型 UI 深度对(条件格式 + 字段条件可见性)· 16. 日历事件拖拽(借 Gantt 模式)。

**E 组 — 大投入/差异化(rank 17-19)**
17. 富文本 longText + cell 内 @mention(联合设计锁)[L]· 18. AI 字段后续 rings(每 ring 独立 opt-in)[L]· 19. **① Cross-base 链接/自动化(战略 XL)**[XL,owner opt-in + 设计锁先行]。

## 2. 为什么 cross-base 从预测 #2 落到 #19

总纲的 **stability-before-risk + foundations-before-advanced** 两原则 + cross-base 勘察(2026-06-11)的实测:跨 base 后端**今天就半可达且零治理**——链接配置无 base 边界校验、lookup/automation 全 base-agnostic、**export 字段掩码可经跨 base lookup 列绕过**(enterprise 安全级洞)。因此它不是"加功能",而是 XL 数据模型变更 + 权限模型扩展,且**必须先有 base 级权限原语 + 校验墙**。综合器判定:在它之前先清掉所有 S/M 级 baseline 与稳定债(它们每单位投入服务更多用户),cross-base 作为压轴的设计锁优先项。两个前提(D3 golden 进 CI、post-GATE 治理)已核验满足——它**可以**启动,只是不**应该**抢在 baseline 前。

## 3. 已退役/明确不做(核验)

§7-B PWA/offline(无需求)· kanban swimlane(低优,单轴已发)· sub-record 嵌套(XL/弱需求)· location 地图选择器(provider 依赖决策)· duration 字段(无具名需求)· FOL-3/4/5/6/8/9(各自 gate,correct-by-default 成立)· FOL-7 Yjs 重算(需求门,最便宜可解释的 unlock 候选)· 双向镜像链接(折进 rank 19 设计空间)· AI auto-trigger ring(M0 章程明确划出)。

## 4. 落地

rank 1 = 本文档。后续按 goal 纪律:gate-free 项走标准管线自动推进;owner/PM/ops 门项到点请示。cross-base(#19)需独立 opt-in + 决策包。
