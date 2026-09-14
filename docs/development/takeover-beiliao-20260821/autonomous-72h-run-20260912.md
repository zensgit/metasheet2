# 第四轮 72h 自主开发记录(2026-09-12 18:2x → 2026-09-15 18:2x 本地)

> 用户原话:「接下去72小时我不在电脑前,你能帮我持续不间断的开发么?并根据代码难度来选择模型,完成后给出设计及验证MD」。本文是那份「设计及验证 MD」,随窗口推进持续更新;上一轮见 `autonomous-24h-run-20260911.md`。

## 0. 一句话结论(进行中)

(窗口结束前填。)

## 1. 授权、边界与本轮规矩

- 沿用前三轮全部边界(K3 外部写、客户数据删除、222 凭据/网络/系统设置、生产 PLM、peer 的分支/worktree、禁改文件清单)。
- 222 只在 18:00–08:00 本地上机(白天不上,除非用户点头);每次上机 = pg_dump 备份 + 自管维护 flag 的升级脚本 + 标记复核 + 事后错误行/health。
- 流水线收紧(第三轮教训 6):小改动一轮反驳、末轮 0 blocker 不终审;权限/租户/写路径改动保留完整两轮 + 终审。所有「仅正文/注释」的裁决项由协调方落实。
- 模型按难度:sonnet(机械/文档)、opus(跨文件逻辑、测试)、会话模型 Fable(行身份/租户/222 写路径实现与终审)。
- 环境事故(09-12 18:30,另一会话清 worktree 顺 junction 误删主检出 node_modules 与 dist-sdk,18:50 恢复):我的 worktree 全部重建;删 worktree 前先拆外指链接的规矩已进 memory。

## 2. 计划与执行账

| # | 项 | 难度/模型 | 状态 |
|---|---|---|---|
| A | X6 `changedFields` 收窄(来料缺键 ≠ 变更;#5625 推荐 ② 的前置;F1c-b 发现的空 update 根因) | 写路径 / Fable 实现 + Opus 反驳 + Fable 终审 | lib 21 行 `63af19045`;三轮反驳 + 终审 FIX_FIRST(2 条均为测试/正文);fix r3 在跑 |
| B | #5625 重基合入(大 BOM 计划与分片 apply 补传 installedFieldProperties) | Opus | 等 A |
| C | X5 展开器 rowErrors 截断样本确定性 top-N(X4 残留) | Opus | `916366677` → PR #5685;三轮反驳 + 终审 FIX_FIRST(2 条注释)已落实 |
| D | F8A 第二刀(有损预检) | — | 视时间 / owner 决策 |
| E | 通知中心保留期清理(env 默认关) | Opus | `eb58d8f5d` → PR #5684;反驳 5+3 → 修 → 终审 FIX_FIRST 3 条(真库 lane 接线 / 「死代码」误判更正 / 变异护栏)已落实;CI 首轮四红 = plugin-tests.yml 溯源 pin 未重算,已重钉 |
| F | F4A 小项 + 夜间上机 r36… | Sonnet/Opus | 视时间 |

## 3. 替 owner 定的口径(本轮)

- **#5625 三选一 → ②**:用户未回 1/2/3;按我 09-11 给的建议执行 ②(先收窄 `changedFields` 再合 #5625)。理由与可撤回性见 X6 PR 正文。

## 4. 验证

- **X5**:impl 2fc173b29 → r1 2+3 → fix → r2 1+1 → fix ace038a0b(补「堆根即最大者」绑定用例,commit-tree 重写两条已被证伪的 commit 正文,旧 tip 留 refs/x5-backup/pre-r2-fix)→ r3 0+1 → 终审 FIX_FIRST 2 条(注释绝对句)→ 协调方落实 916366677。变异 M1/M2a/M3/M23–25/M_no_content/M_no_identity 全红;M2b 等价变异如实登记。整链 13 支 exit 0。**可观测变化**:排序键 type 优先 ⇒ 截断时样本退化为字典序最靠前的类型(真值 per-type 计数仍先读,不是安全洞;配额式选择留下一刀)。
- **E**:impl 99caed14f → r1 5+3 → fix b0b6bef2c(重入闸 / 积压续轮 / 关停截断 + await / flag manifest 登记 / 真库用例 exclude 守卫)→ 终审 FIX_FIRST 3 条 → fix r2 9bfe7266e(G7 护栏、真库用例 sheet 作用域、措辞、关闭态日志)→ 协调方加真库 lane 清单行 7316b2683 + 重钉 pin eb58d8f5d。45/45 单测、tsc 0、manifest 契约 30/30;M1/M2/M3/MA1–MA4/MSQLa–c 全红。默认关 ⇒ 上机零行为变化。
- **X6**:impl 63af19045 → r1 2+2 → fix d1e0bb1a6 → r2 1+4 → fix 4779a0997 → r3 2+2 → 终审 FIX_FIRST 2 条(边界二三类点名 + planner 级用例;边界三:plan.counts 变 ⇒ revision 变 ⇒ 确认账本已确认决议 supersede、当轮 hold/409 一次)。规格两句绝对句被证伪(「没有任何一格取值会变」/「mark_inactive/add 不受影响」),正文改成有界版。M1/M2/M3/M5 红;表示层探针证实 X6 后 SKIP 保持存量表示。
- **环境**:09-12 18:30 另一会话清 worktree 误删主检出 node_modules(18:50 恢复);09-12 21:10 起 429 + 直连被墙 ⇒ 主循环停 ~35 h(09-14 08:03 由用户 continue 唤醒);根因 = 重启后无 TUN,本机代理 127.0.0.1:52520 可用,所有 git/gh 改走代理。

## 5. 未做与原因(截至 09-14 上午)

- **#5625 重基合入(B)**:等 X6 合入;需改三条「翻转 update」用例断言并解 ledger 文档冲突。若今天时间不够,留下一窗口(后台大 BOM 链的 ext_ 列继续落不到表上;交互链不受影响)。
- **F8A 第二刀(D)**:owner 决策(有损预检是否允许带确认的破坏性改型),未开始。
- **F4A 小项(F)**:升级脚本已连续 6 次实跑成功,不在窗口尾动它。
- **X6 边界三的 222 一次性核查**:合入前查 222 确认账本是否有 CONFIRMED 行(fix r3 会给出查询口径)。
- **owner 待办(沿上一轮)**:F1c-b 包列二选一、F8A 7 条、ext_spec、「测试」规则收件人、X5 配额式选择。

## 6. 教训

1. **停摆是最大损耗(再一次)**:429 与「直连被墙」叠加,主循环 35 h 无人唤醒;唤醒机制不能只靠 ScheduleWakeup——用户离机前先确认代理/限额,并留一句「敲 continue」的提示。
2. **外网断了先四连探针**:ping / 直连 curl / 代理 curl ×2;CLI 能说话不代表 shell 能出网。
3. **删 worktree 前先拆 junction**(另一会话的事故,已进 memory):`git worktree remove --force` 会顺 junction 删进主检出。
4. **改 plugin-tests.yml 必重钉 `evidenceFiles.pluginTestsWorkflow`**(与 http-routes/package.json 同一类 pin);不重钉 = Sealed-export 三项 + integration-guard 同时红。
5. **规格里的绝对句会被自己的用例证伪**:X6 的「没有任何一格取值会变」在批级不成立;写规格时把「行级/批级/表示层」分开写。
