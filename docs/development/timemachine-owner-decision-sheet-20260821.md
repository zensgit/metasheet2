# Time Machine — owner 决策清单(2026-08-21)

> ⚠️ **2026-08-21 修正(owner 复审后)**:本清单初版把 **B1「A1 前置已满足」写错了**——已**撤回**。
> owner 复审在承重工具(L1 电池)上构造出**两个真缺陷**:P1 远端管理员凭据在 cancel/超时/失败时
> 可能遗留在部署主机 `/tmp`;P2 posture 校验只查 trigger 名+tgenabled,**同名 trigger 在错表仍 9/9 ARMED**
> (假 ARMED,静默作废下游全部 409 证据)。**结论:A1 暂不可 ratify,电池暂不可 dispatch**,须先 fix-forward
> (凭据生命周期 → canonical posture 校验 → 变异测试 → 独立复门 → owner 授权 staging 实跑 → PASS 后再 ratify)。
> 下文 B1 段已按此改写。

> 一页看全:两条线(O-2 启用加固 + 阶梯加速)的**开发已全部落 main 并验证**;下面全是**只有 owner 能拍的板**。
> 每条给:决策、我的建议、拍板后果、相关载体。**本清单不代为决定,也不改变任何姿态。**
> 全程状态:4 flag OFF、9 trigger DISABLED(指纹 `8c1be0b0…`/`14c180aa…`,双主机 run `32321464042` 2026-08-20 PASS)。

## A. 现在就能拍、且解锁最多的

**A1 · 把 #5039 便笺转给审批线补那 4 条迁移**
- 决策:让审批线按便笺(`staging-approval-migrations-disposition-20260820.md`)在克隆上彩排后应用 4 条审批迁移。
- 我的建议:**做**。这是 L0 唯一未勾项(`staging pending migrations ≠ 0`),也是整条阶梯的真瓶颈——L1 卡在它上。
- 后果:staging `pending=0` → L0 五项全绿 → L1 可开。4 条全零命中本阶梯爆炸半径,2 条 high 是启发式误报(纯 CHECK 加宽)。
- 归属:审批线执行 + owner 批准;**Time Machine 线不代应用**(runbook 要求克隆彩排)。

## B. 前置满足、随时可拍(压缩真正落袋的动作)

**B1 · ratify 阶梯修正案 A1 —— ⛔ 前置尚未满足,暂不可 ratify**
- 决策:在 **A1 承载 PR(#5042)** 留 `RATIFY-A1 <A1 内容的 exact-head SHA>` 批注,把 L1 窗口从 `≥2 日历日`
  改为 `≥1 日历日 + 电池 PASS`。**注意授权只能绑 A1 承载 PR 的 exact content SHA,不能在电池 PR 上替代授权。**
- 前置:**未满足(2026-08-21 撤回)**。承重工具(电池)有两个 owner 复审确认的真缺陷,fix-forward 前
  电池不可信,A1 不可 ratify:
  - **P1 凭据生命周期**:cancel/超时/失败时管理员邮箱+密码可能遗留部署主机 `/tmp`——需 always() 清理+陈旧目录处理+失败注入测试。(修复中)
  - **P2 canonical posture 校验**:当前只查 trigger 名+tgenabled;同名 trigger 在错表仍报 9/9 ARMED=假 ARMED。
    需校验表/事件/函数/参数/更新列/函数指纹+变异测试。(修复中)
- 修复后序列:凭据修复 → canonical posture 校验 → 变异测试 → 修正本清单/文档 → exact-head 独立复门 →
  owner 授权 staging 电池实跑 → **PASS 后再 ratify A1**。
- 门审边界(修好后仍适用):干净电池只观测 **12/48 census 站点 + 6/9 触发器**——更强信号非更广,压窗 = "深换广"。
- 后果:未 ratify 期间原 `≥2 天` 判据继续生效,无损失。
- 载体:A1 = #5042;电池修复轮 = 进行中(P1+P2)。

## C. 需要 owner 裁量的天花板(两个,同类)

**C1 · census linkage L0 天花板**(T2)
- 蓄意空壳替换/构造 tag 封不死(文本守卫证不了 src 可达性)。事故模式已封死。
- 建议:接受"收窄"并视 L0 该项满足(平行你已接受的先例)。要真闭合=给适配器埋点或读覆盖率(独立小工程)。

**C2 · 电池 P3-7 守卫天花板**(T2,同类)
- 早退清理守卫是文本存在性守卫,门审用字符串诱饵/`if(false)` 可 defeat;偶发回退已挡尽,行为双 E2E 验证正确。
- 建议:同 C1 接受"收窄"。要零残留=补 postgres+backend 行为测试车道(**我不建议**,为一个守卫造重型车道,不成比例)。

## D. 记录在案、默认不动

**D1 · 激进重叠选项(A1.4)**:soak 尾 1–2 天 × 生产 L1,再省 1–2 天。**默认不推荐**(soak 第 6 天冒问题时生产触发器已开)。owner 另行明示才生效。

**D2 · 后续能力(Phase D / T-state / 精确复活)**:需先立设计锁,属新一轮开发。**建议等 L6 soak 证据**再决定值不值 8–12 人周。

## E. 阶梯执行(全 owner-gated,日历为瓶颈,非开发)

L0(差 A1)→ L1 staging ENABLE triggers(≥1 天+电池,flag 全 OFF)→ L2 CONTIGUITY_STRICT → L3 WRITER_FENCE →
L4/L5 canary → **L6 soak ≥7 日历日** → L7+ 生产重放全序。**每级你亲授 + 观察窗**。压缩后地板约 9 天。
另需:目标主机跑一次**回滚后 postdeploy-full**(L0 §5 的 owner-gated 半条,本地演练不覆盖)。

---
**最短路径**:拍 A(转便笺,可**并行**)‖ 代码侧 fix-forward(P1 凭据 + P2 canonical posture + 变异 + 独立复门)→ 授权 staging 电池实跑 → PASS 后拍 B1(ratify A1)→ 挑时点开 L1。C/D/E 可随进度陆续拍。**A1 在 fix-forward 完成并复门前不可 ratify;电池在此前不可 dispatch。**
