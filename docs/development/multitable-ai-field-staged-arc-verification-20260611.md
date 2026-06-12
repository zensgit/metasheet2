# 多维表 AI 字段 staged 弧 — 验证报告 — 2026-06-11

> Status: **VERIFICATION(收官文档)** · 计划/TODO:`multitable-ai-field-staged-arc-{development-plan,todo}-20260610.md`(#2474)
> 方法:每环 = 勘察(file:line)→ 设计锁定(多 agent 事实核验)→ fail-first → 实现 → 独立对抗审查 → 发现修复(major 加 delta 复审)→ CI → admin-squash。审查工件存 `/tmp/*-review-claude-2026061*.md`。
> 回填 2026-06-11:本文原始收口点为 M0→M3;M4 公式 AI 辅助随后已通过 #2518(设计)→#2520(`62460217f`,实现)→#2521(`f9a663eb9`,会话验证)闭合。当前 AI staged 主线状态以 `multitable-ai-field-staged-arc-todo-20260610.md` 的 M0→M4 回填为准。

## 0. 总览

| 环 | PR | squash | 质量环要点 |
|---|---|---|---|
| M0 决策批准 | #2476 | `8af77bb84` | 全按推荐 + owner 两修正(批准≠解锁;R-2/internal 仅限 A1);同日 owner "解锁" 落档 §3 |
| M1a A1 设计 | #2478+#2481 | `e62aa2b8a`+`e95114ab1` | 8 问勘察;审查 F1 major(.mjs+node 跨 TS 不可行 → .ts+tsx)等 7 项修复(owner 手合并后以 follow-up 落) |
| M1b A1 实现 | #2486 | `6a91b22c4` | resolver/internal 路由/tsx 门脚本;18+5 测试 fail-first;泄漏狩猎 7 对抗场景零泄漏 |
| M2 A2 设计 | #2489 | `0081cf1ae` | 核验 ready-with-edits:subject_key=user_id 防 header 伪造、advisory-lock、失败路径 token 记账、helpers 工厂接缝 |
| M2 A2 实现 | #2490 | `1e677208` | preview/run + 台账 migration + 配额;审查 F1 major(跨 IO 持锁)→ **reserve-then-settle** 重构 → delta 复审 FIX-VERIFIED(探针级:无跨 HTTP 锁、零超额、迟到结算无丢失);NF-1 中文估算(1 token/char)合并前修;**T1+T6 关闭** |
| M3 A3 设计 | #2491 | `9441d5446` | 核验两 refuted 修正:run 响应非 PatchResult→FE 适配器;移除=省键(null 被拒/disabled 标记不安全);clobber 防护;429 双语义 |
| M3 A3 实现 | #2494 | `a5809db11` | 配置区+双触发面+适配器+usage-summary;审查 F3/F4(倒计时三面统一+自回声豁免)合并前修;**T3 展示关闭 → 主线 M0→M3 全闭** |
| S1 stale reconcile | #2475 | `f32d3283a` | 5 文档带证据注记(D0/D1/D4 关闭、B1/D2/D3/C1 supersession、S1-10 多系列、§7-4) |
| S3 图表补全 | #2492 | `a6b3986e5` | area/funnel/gauge 端到端 + S1-9 异步 chunk(构建实证 EmbedHost 1.2M→760K);scatter 出局(契约无 x/y)= follow-up |
| S4 层级父链接约束 | #2488 | `d928eff23` | 真实概念=limitSingleRecord;双前端选择器 + parentInvalid 门控 bug 顺带修;残留文档化 |
| S2 dry-run+详情 设计 | #2493 | `4d0102c5f` | 工程/产品拆分:样例数据/onboarding/回滚 = #1571 C1 包 PM 门控,明示推迟 |
| S2 实现 | #2503 | `0c2b058fe` | 共享冲突检测(install 同源、字节级不变+TOCTOU 后备)+ 零写 dry-run(query-spy 证明)+ 详情面;审查 APPROVE-WITH-NITS,F1(计划级重复 id)/F2/F4/F5 合并前修,F3 设计继承语义如实记录 |
| S5a harness 修复 | #2497 | `3deeaf6bd` | undici dispatcher(仅上传调用,1800s 下限 23 个对抗值探测零逃逸)+ err.cause 链打印 + 12/12 测试;审查 APPROVE-WITH-NITS 全非阻塞;**S5b staging 50k/100k 实跑 = operator-gated**(首跑建议 XLSX_CHUNK_SIZE=20000) |

## 1. 关键证据(主线)

- **M1 泄漏防线**:resolver 报告结构性无值(env 名/白名单常量/解析数);A1-T6 三层哨兵(报告 JSON/路由响应/门工件)双形态(sk- + 非 sk-);审查者独立 harness 7 恶意场景零泄漏。
- **M2 配额正确性**:4 路真库并发探针(1 胜 + 3 quota_exhausted,SUM==cap);迟到结算 vs 已清扫行探针证明无丢失无双计;x-tenant-id 伪造不可移动 subject_key(=user_id);版本冲突路径 usage 仍记账;429 不写台账。
- **M2/M3 写路径同源**:createRecordWriteHelpers/buildRecordPatchContext 工厂由 `/patch` 自身消费,FoL/AF/echo/invalidation 真库套件双轮验证"工厂重构不可见"。
- **M3 clobber 防线**:A3-T1b(只改 validation 保存 → aiShortcut 原样保留)+ T1c(移除=省键往返);审查 F1 注记 API-authored 形状的 canonicalization 边缘(UI-authored 精确往返)。
- **零真实调用纪律**:全弧(实现+测试+审查探针)无一次真实 provider HTTP;双确认门(readiness ready + E-12)A2 起执行,A2-T1 fetch-spy 零调用断言。

## 2. 已知边缘与 follow-up 池(全部已登记)

scatter 后端 x/y 维度 · gauge 非加性聚合文案 · 异步 chunk 加载失败兜底 · 图表持久化 type 校验(F4 既有)· API-authored aiShortcut canonicalization · all-sources-deleted 阻塞保存恢复 UX · stripUrlUserinfo 首-@ 边角 · 台账 aging(NiFi 对标既有 GAP)· S4 残留(field-PATCH 翻转/provisioning 旁路)· main 上烂掉的 multitable-view-config.api.test.ts(4/7 红,CI 不跑)· 公式 AI 后续优化(deferred-eval/多候选等,独立 opt-in)· C1 PM 门(G-4 样例数据/G-6 T7 回滚/onboarding)。

## 3. TODO 终态

原始收口时主线 M0→M3 **全闭**(7 PR:#2476/#2478/#2481/#2486/#2489/#2490/#2491/#2494),T1/T3/T6 关闭;副线 S1/S2/S3/S4/S5a **全闭**(#2475/#2503/#2492/#2488/#2497)。2026-06-11 回填后,M4 公式 AI 辅助也已闭合(#2518/#2520/#2521),所以当前 AI staged 主线为 **M0→M4 全闭**。仍门控:S5b(staging 实跑,operator-gated)· C1 PM 件(G-4/T7/onboarding)· §2 follow-up 池。**本 arc 原始收口共 14 个 PR、6 轮多 agent 设计核验、9 轮独立对抗审查(2 个 major 实弹:M2 跨 IO 持锁、A-full 前传 F1 同级)、全程零真实 provider 调用。**后续总目标见 benchmark-surpass goal(滚动 refresh → 阶梯 → staged arc)。
