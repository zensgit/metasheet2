# 考勤 vNext UX 线 Wave 3 — 开发与验证记录（2026-07-21）

> Charter: `attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`（§14 步骤 5、§6.2 Wave 3 行、§15）。
> 需求源 = issue #4353；#4414 为旧 stacked draft，owner 裁决**禁直接合**——本波交付 = 其业务意图对 current main 的三方差分 reclaim。
> 模型分工：实现=Sonnet、对抗审=Opus、三视口证据与编排=Fable 主循环。证据=本地真跑+真栈真浏览器+CI，合成 fixture。

## 1. 已交付

**PR #4504（squash `786a1223f`）**：管理中心 task-first 独占首页 + `AttendanceAdminTaskHome.vue` 首次抽取（§6.2 点名交付物，#4414 原文未组件化）。

**意图差分表（对抗审独立对账：诚实、无静默漏项）**：
- 已落地跳过（逐条对 current main 验真）：组详情四阶段/列表 CSS（Wave 1 落）、focused 模式 observer 早退（已在 base）、`loadAdminNavFocusedMode` 恒-true 使 #4414 的持久化补丁 no-op。
- 本波实现（缺失集）：`adminTaskHomeOpen` 独占切换 +「管理首页」返回；四任务组重组（daily-operations / people-groups / work-time-policies / reporting-payroll，含异常深链）；ExperienceView overview section-id 白名单扩至 4-id（fail-closed，与 canonical 常量逐值一致）；`clear-section` emit 链（AdminCenter→ExperienceView）；`adminNavigationEnabled` 门（首页开启时抑制 hash-restore/scroll-spy/键盘导航）。
- 显式推迟（合法，非砍需求）：per-task status badges（issue #4353 验收不含、#4414 原文亦无）、组内权限过滤（§6.2 明确留父层）。

## 2. 门禁（章程 §8.1 对照）

| 项 | 结果 |
|---|---|
| spec | AttendanceAdminTaskHome 4 / entrypoints 10（首次接线 guard）/ regressions 122→124（含审后回填两腿）/ anchor-nav 30 / navigation 13——受影响 5 spec 合跑 **181/181** |
| guard current-head | 29 文件 run-list 原命令 566/566（本地）+ CI attendance-web-guard 在真 head 绿（run 29796419080）|
| §8.1.4 | 两个 spec（新 TaskHome + 首次接线 entrypoints）run-list 显式 + 双 path filter（审阅实证 L198/L113-114/L154-155）|
| vue-tsc / build | 双净；AttendanceView 定向 ESLint 与基线逐项一致（零新增违规）|
| 承重 mutation | **7 刀全被杀**：实现方 3（独占切换回退 / navigation 门恒开 / allowlist 回退）+ 审阅方 1（深链落点 `hasExplicitAdminSectionTarget`→false）+ 回填 kill-proof 2（AdminCenter 再发射剪断 / forbidden v-if 门失效）+ 审阅 Mutation B（原逃生→回填后被杀）|

## 3. 对抗审（Opus，refute-first）

**APPROVE，0 P1 / 0 P2**（MD /tmp/pr4504-w3-review-claude-20260721.md）。攻击面：差分表诚实性（过）、深链兼容（过，见 §4）、返回链路 hash 清理（过）、allowlist 注入面（4-id 白名单 fail-closed）、§6.2 边界与越界（hunk 级确认组工作台/员工总览/审批面未触）。P3-1（clear-section 再发射零覆盖）与 P3-2（admin-forbidden mounted 测试缺失）已在合入 head 回填并 kill-proof（见 §2）；P3-2 的构造要点记录在案：**单端点 403 不稳定——约 90 处成功路径会重置 `adminForbidden`（last-writer-wins），全面无权限面才是稳定触发**。

## 4. 三视口真浏览器证据（真栈+种子；拍前真在场断言+人工目检）

截图 5 张入 `assets/w3-vnext-20260721/`（01 任务首页 1440 · 02 入区工作台 1440 · 03 query 深链落位 1440 · 04 任务首页 1024 · 05 任务首页 390）：
- **独占性**：首页⇄工作台互斥（home 开启时 rail 几何不可见，反之亦然）；入区后「管理首页」返回钮在场；返回后 **hash 干净清理**（A→B→C 实测）。
- **深链契约**：`?section=attendance-admin-groups` 冷加载直落「组织分组 · 考勤组」并 bypass 首页 ✓。**文档化观察**：raw-hash 冷加载 bypass 首页但停默认区块——与 pre-#4504 main 行为逐点一致（Wave 1 取证同现象），既有缺口非本波回归；受支持深链形态 = query 形。
- 四任务组 1440/390 一致呈现；三档 `<main>` 收边（390 页级 390=390）；桌面页级 64px 溢出仍为壳层旧账（Wave 1 MD 已记）。

## 5. 已知项（honest，不阻断）

1. raw-hash 冷加载不恢复区块（既有，跨波；候选后续统一深链行为时处理）。
2. ExperienceView allowlist 与 canonical 常量双源重复（审阅 NIT，当前逐值一致；候选抽公共常量）。
3. navigation gate 注释「no scroll-spy」轻微 overclaim（行为已被 gate 测试断言，benign）。
4. Wave 1/2 已知项状态不变（壳导航溢出、规则卡错误串 i18n）。

## 6. 剩余（口径）

- **§14 五步序全部完成**：①②（Wave 0）③（Wave 1）④（#4370 RATIFY）⑤（Wave 2 + 本波 reclaim）。#4414 处置建议：本波已 reclaim 其全部可用意图，旧 draft 可由 owner 关闭留档。
- **Wave 4 onboarding = DESIGN-LOCK-GATED、Wave 5 explainability = DATA-CONTRACT-GATED**（owner 门）——目标池自主可执行段至此清空。
- 真实租户视觉复核、S7 flag 开启等 operator 项不由本文替代。
