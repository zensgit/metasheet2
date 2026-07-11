# 多维表对标线 — 自主开发会话 设计与验证记录(2026-07-09/10)

**类型**:会话级设计与验证记录(docs-only,零 runtime,可自验)。承接 `multitable-benchmark-session-final-design-verification-20260708.md`(#3960)的 7 簇框架与「自主轴边界」判定,本会话把该边界**向前推进**:清空滞留 PR 列车、把 ratify 队列推到全 MERGE_CLEAN、纠正并重开被误判耗尽的路 1、Lane A batch1 落地、以及一次 CI 破损事故的 fix-forward 与流程加固。

**安全边界**:本仓公开。权限/出口类内容一律不在本文出现,经会话对话面交付 owner。

---

## 1. 目标与授权形态

owner `/goal`(2026-07-09):接多维表开发线,总目标池,固定节奏,可并行,完成给设计+验证 MD,按难度自动选模型(Fable5/Sonnet5,Fable 不可用→Opus4.8);owner AFK「自动帮我选择」。红线沿 #3805:不自 ratify、不碰权限语义、不动 AI live env、存疑即停。

**执行前重建盘面**:5 面并行扫描(PR readiness / Lane A inventory / 锁队列 / 解锁核查 / 并行会话碰撞图)→ 输出执行序。碰撞图证实同日有 5+ 条并行线(dingtalk/global-history/approval-b3/attendance/stock-prep)在同仓落地——本会话全程独立 worktree、串行落地、不触碰外线 PR/worktree/canonical 树。

## 2. 落地台账(7 PR 全 MERGED)

| PR | 内容 | 闸 | 
|---|---|---|
| #3959 | 公式引擎 13 标量函数(batch-1) | MERGE_CLEAN(2026-07-08 独立闸;本会话核实零 main 侧漂移后落) |
| #3976 | F2 附件读闸安全回归 CI 覆盖(test-only) | 本会话独立闸:新鲜 PG 实跑,双闸 neuter→RED→恢复 GREEN 实证;fixture 合跑无碰撞 |
| #3853 | UI-P2-1c 迁移 proof-specs 接 CI | 闸 CHANGES_REQUESTED(P2:漏 required 门的两点纪律)→ 补 `migration` token 后落 |
| #4065 | **热修**:web-guard yml 冲突标记(事故 §6) | fix-forward,YAML 验证 + 全树扫描 |
| #3934 | 公式目录 parity(12 函数)+ backend 活漂移守卫 | 欠账重闸 MERGE_CLEAN:4 刀 mutation 全实证(删引擎函数→守卫红/注假条目→红/COUNTIF 分层/反 fixture),union 严格 additive |
| #4066 | Lane A batch1:入口面 10 键→MtButton(3 组件+3 migration specs) | 七门全 PASS(逐字节守恒/范围/共享类/测试真咬+mutation/token-only);type=submit 排除带守卫断言 |
| #4075 | 公式引擎 batch-2:26 标量函数(引擎 91→117) | 26 函数逐一独立重算;P2 硬化(days360US 31 日 goldens)按处方在 PR 内落地并刀验真咬 |

落地力学:strict + enforce_admins + 热 main(外线每小时 3-4 合并)→ 全程「arm --auto 一次 + 90s green+behind→update 循环」;#3853 三方 union 尊重 main 侧删除(未复活 #4034 已删 token)。无 admin 旁路(enforce_admins=true 下不存在),未动分支保护。

## 3. Ratify 队列推平(最高杠杆)

上会话遗留:13 锁中 5 把 CHANGES_REQUESTED + 一对重复。本会话全部收口——**修复(docs-only,file:line 逐条对 origin/main 核实)→ 独立重闸 → 裁决贴 PR**:

| 锁 | 原缺陷 | 修复要点 | 重闸 |
|---|---|---|---|
| #3814/#3940 重复 | 同范围两份 S1b 锁 | 关 #3814(其 nearest-prior 机制被 #3940 §2 证明不健全),留 #3940 | — |
| #3816 L0.5 租户闸 | P1 信任边界 | §3.6 硬不变量(live-gate key + quota subject 双双 trust-derived)+§1 反转 +§5 伪造负 golden +4×P3 | ✅ MERGE_CLEAN(调用图验证) |
| #3818 W3-6 widgets | P2 假读权限不变量 | §4.1 收窄到聚合形 rungs;W3-6a 剥离 preview-data 锁进命名前置 gate;重闸 2 NIT 当场修 | ✅ MERGE_CLEAN |
| #3673 S4 成本 | 2×P2(其一 money) | §1.3 改 EXTEND 既有卡;C1 重定义零 spend read;三轴 fail-closed(重闸证实轴 2 更强:estimate≥实际扣费无条件) | ✅ MERGE_CLEAN(枚举 12 AI 路由) |
| #3681 S3 血缘 | P2 hash 基集矛盾 | A1a-A1e 钉死全声明集×server 权威值×单 helper;GS8 reader-independence golden | ✅ MERGE_CLEAN(构造输入证伪) |
| #3808 S5 normalize | P2 governance + P2 fallback | 逐项继承父锁 L3 全 8 项;unmatchedMirrorFieldId fail-closed | ✅ MERGE_CLEAN(父锁实文核对) |

**终态:ratify 队列 12 锁全部 MERGE_CLEAN、全部 PROPOSED、P1/P2 残余为零**——owner 可逐把一键 ratify。

## 4. 路 1 重开与收口(纠上会话「耗尽」误判)

#3960 §3 称路 1 耗尽——该判断只覆盖审计缺失清单(range 族)。按 #3948 简报自身的路 1 定义,扫描证实 26 个清单外标量余量 → batch-2(#4075)本会话实现并落地。语义决定全部以一手资料钉死(ATAN2 参数序照 MS 例、YEARFRAC 只 basis-0 其余 reject、NETWORKDAYS 2 参核心、FACT 严格整数为刻意分歧并披露)。**至此路 1 真正吃净**:引擎 117 函数,C 簇余下全部为 range/array/跨记录 = 路 2/3(owner RFC 重开决定,#3948 已把决策压到最小)。

## 5. Lane A batch1(#4066)

Workbench conflict 三键(全 sharer 删基类)+ HomeView refresh/favorite/open + CommentInbox 三键 → MtButton;HomeView primary-create 排除(隐式 type=submit 回车语义,照锁不做规则,spec 加守卫断言防漂移)。3 个 `*-migration.spec.ts` 13/13 绿(经 #3853 自动进双 CI 门),mutation-red 实证,零新 hex。Lane A 余量:batch3-7(managers/日历/画廊清洁面)UNGATED 可续;T1-T5 尾部等 #3866 ratify。

## 6. 事故与流程加固(诚实记录)

**事故**:#3853 squash 把 web-guard yml 一个未解决冲突 hunk(字面 `<<<<<<<` 标记)带上 main → advisory web-guard 自 31c2bbb7e 起不可解析。**根因**:手工解 merge 时只核对了 merge 输出报的冲突文件,第二个 UU 文件被 `git add -A` 连标记提交;sanity grep 同时命中冲突两侧 → 假阴性。**修复**:#4065 fix-forward(43-token union,YAML 验证,全树扫描确认无其它受害文件),该 PR 上 web-guard 重新解析并实跑。**加固**:四步纪律固化入持久记忆(UU 清零 → `git diff --check` → 逐文件锚定 grep → 结构化文件语法验证)。

**第二次损伤(诚实记录)**:#3934 重做 union 时 hunk 边界又吃掉一个 `},`(formula-docs.ts 语法错)——四步纪律当时未含 TS 语法验证,由 **CI 三红抓出**(非本地预检),本地修复(7f6a8a9e3)并把 `node --experimental-strip-types --check` 纳入第四步;重闸时该事件作为 F0 一并复核。

## 7. 终态

- **代码侧**:列车 4 + 热修 1 + Lane A 1 + batch-2 1 = **7 PR MERGED**;C 簇路 1 吃净(117 函数);迁移 specs 双门接线;F2 安全回归进 required lane。
- **决策侧**:12 锁全 MERGE_CLEAN 等 ratify;路 2/3 RFC 重开、AI L1(canary+cap)、Lane A T1-T5、簇 A/B/G runtime、簇 E/F——全部卡 owner 一句话,无一卡在「裁决分歧未清」。
- **不主张**:任何 PROPOSED 锁已获批;任何簇「完成」;任何安全结论入库。按既定口径:**decision-clean 池已清空;剩余 = owner ratify/决策/env 输入与其后的 gated runtime。**

## 8. 方法学(供复盘)

- **修复→独立重闸→贴裁决**闭环 6 次全一轮过;重闸代理纠正原裁决自身行号漂移 3 处、走调用图/构造输入/枚举路由证伪而非复读。
- **并行会话纪律**:碰撞图先行;三方 union 以 merge-base 为基、删除优先;全程未触碰外线资产;两次会话级限额中断经 SendMessage 从 transcript 断点复活代理 5 次,零重做。
- **模型分层实况**:主循环+扫描+重闸 = Fable5/Opus(adversarial-reviewer);实现 = Sonnet5(batch1/batch-2);impl-lane 勿 advisor 再次实证(batch1 代理死于 advisor 调用前,复活时明令跳过后顺利交付)。
- **落地力学**:strict 热 main 跑步机(单 PR 最多 6-8 轮 green+behind→update);merge-queue(owner 已在别线拍板)落地后此类磨损应消失。
