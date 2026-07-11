# 考勤系统开发收官 验证报告 — 2026-07-07

> owner goal:「完成这条考勤系统所有的开发」。本 MD = 全量缺口审计结论 + 本批两刀验证 + 剩余项归属。
> 审计法:tracker(单一真源)逐节 + origin/main 实证(纠正一处陈旧快照:S2 内外勤合并实为 ✅ 已闭环)。

## 1. 全量缺口审计结论(2026-07-07,基线 origin/main)

**代码侧开发全部收敛。** tracker §0.1-§0.6/§1/§2 逐项核:H2 MUST 六项、H2 SHOULD 四项、A2、C5、
年假 L0-L6、§0.5 四切片、S2 内外勤、HMR-1..4、调度 D1-D4、换班 SW1-SW4、小组织 SO0-SO2、
E1/E2(a/b/c)、UI-P1、导入线(guard/picker/recognition/xlsx/BOM/prefs/格式说明/示例行)全 ✅。
本批补齐最后两块可自主开发项(E3 深链 + Lane B 收尾),此后剩余项全部 owner-gated 或 staged(§3)。

## 2. 本批两刀

### 2.1 E3 通知深链(PR #3806,`ed14bac46`)
C5 钉钉 work-notification channel:双条件 gate(`ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED` + `PUBLIC_APP_URL||APP_BASE_URL`)
下发 actionCard,按钮深链 `/attendance?noticeSource=<source>` 直达 E2 容器 landing(经 E2b 免登);任一条件缺 → text 逐字节回落。
- 验证:新鲜迁移库真 DB 6/6(card/URL缺回落/flag关回落/builder 契约);mutation 双刀(拆 flag gate/拆斜杠归一→红);
  actionCard sender 空串守卫 vs 恒非空输入契约核过;tsc 清。审阅:opus APPROVE-with-hardening 0 P1/P2(P3 APP_BASE_URL 回退分支已补测/flag 已入 .env.example)。

### 2.2 Lane B 收尾(PR #3811,`972518a8f`)
- #3793 NIT-3:fallback「下载 CSV 模板」空行→示例行,两下载出口对齐;mutation 曾证 wire 断言无牙→补 blob 解码断言→红→绿。
- NIT-1:mock 补 dataType,8.5 派生示例 wire 断言。NIT-2 有意不修(逐列格式演示≠语义自洽记录,同后端 templateSampleRow 取舍)。
- token B1-exact:17 处属性对齐且与 UF token 逐字节同值的裸 hex 迁移(317→301,构造上视觉零变)。
- 棘轮护栏:`attendance-token-ratchet.spec.ts`(MAX_BARE_HEX=301 单调递减 + 四 hex 不回潮)接入 attendance-web-guard。
- 验证:web-guard 19 spec/415 绿;tsc 清;mutation 三刀(重引入 hex→棘轮红/fallback 回空行→wire 红)。审阅:opus APPROVE 0 P1/P2 3NIT(NIT-1 五 hex 不回潮已钉/NIT-2 fail-safe 接受/NIT-3 body 已更);审阅确认 token 替换全主题视觉零变、棘轮剥注释后计数(自审抓到 16 个注释 PR 号假阳性,基线 301→285)。

## 3. 剩余项(全部非代码开发,归属明确)

| 项 | 归属 | 备料状态 |
|---|---|---|
| HMR-5 / 调度 D5 / 换班 SW5 / 小组织 SO3 staging smoke | **owner/operator**(staging operator-only) | harness+runbook 四套全备(scripts/ops/*.mjs + docs runbook) |
| E4 真机 smoke | **owner**(钉钉开放平台注册微应用:首页地址/安全域名/免登权限)+ operator env(`DINGTALK_CONTAINER_LOGIN_ENABLED`,深链另加 `ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED`) | E1/E2/E3 代码全落,runbook 归 E4 时补 |
| token B2-B6 语义批(~284 处近似收敛) | **Sonnet 跑量**(2026-07-12 恢复;owner 定档) | 映射锁 #3802 已合(6 批边界+语义陷阱+棘轮纪律) |
| F0-F3 飞书系列 / UI-P2 图表 / P3a-d 管理台 | 方向锁 gated,按需另起 | — |

## 4. 过程纪律记录

限量窗口(两次 opus 审中断,10:30 LA 重置)按既定降级:主循环机械门预审(closing-keyword/文件面/契约/空串守卫)全绿留痕,
opus 终审于额度恢复后补;10:44 一次性定时器兜底自动续跑。`git checkout --` 未提交文件陷阱第 4 次触发(E2b),已入记忆强化。
