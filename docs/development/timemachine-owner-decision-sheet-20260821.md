# Time Machine — owner 决策清单(2026-08-21)

> ⚠️ **2026-08-21 修正(owner 复审后)**:本清单初版把 **B1「A1 前置已满足」写错了**——已**撤回**。
> owner 复审在承重工具(L1 电池)上构造出**两个真缺陷**:P1 远端管理员凭据在 cancel/超时/失败时
> 可能遗留在部署主机 `/tmp`;P2 posture 校验只查 trigger 名+tgenabled,**同名 trigger 在错表仍 9/9 ARMED**
> (假 ARMED,静默作废下游全部 409 证据)。**结论:A1 暂不可 ratify,电池暂不可 dispatch**,须先 fix-forward
> (凭据生命周期 → canonical posture 校验 → 变异测试 → 独立复门 → owner 授权 staging 实跑 → PASS 后再 ratify)。
> 下文 B1 段已按此改写。
>
> **2026-08-21 二次更新(fix-forward 已落地)**:两缺陷已修 + 过独立复门(APPROVE @ `ceb0f08def`,#5069);
> **B1 的代码侧前置已满足**。P3-INFO-1(subject_type 枚举)已查证**满足**(两表 DB CHECK = recovery 枚举,见 §C1a)。
> 剩余 A1-ratify 前提**纯 owner/ops**:owner 授权 staging 电池实跑 → PASS → 再 ratify。secrets 已设、主机建号脚本已备。

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
- 前置:**代码侧已满足(2026-08-21)**。两缺陷已修 + 过独立复门(#5069 `ceb0f08def`);仍需 owner 授权 staging 电池实跑 PASS 才可 ratify。原两缺陷(已闭合,存档):
  - **P1 凭据生命周期**:cancel/超时/失败时管理员邮箱+密码可能遗留部署主机 `/tmp`——需 always() 清理+陈旧目录处理+失败注入测试。**(#5069 已落一轮;owner 二次复审又发现停止容器仍持密码却报 PASS ⇒ P1 第二轮修复进行中,修复前不建号/不 dispatch/不 ratify)**
  - **P2 canonical posture 校验**:当前只查 trigger 名+tgenabled;同名 trigger 在错表仍报 9/9 ARMED=假 ARMED。
    需校验表/事件/函数/参数/更新列/函数指纹+变异测试。**(已修 + 过独立复门,合 `ceb0f08def`)**
- 修复后序列:凭据修复 → canonical posture 校验 → 变异测试 → 修正本清单/文档 → exact-head 独立复门 →
  owner 授权 staging 电池实跑 → **PASS 后再 ratify A1**。
- 门审边界(修好后仍适用):干净电池只观测 **12/48 census 站点 + 6/9 触发器**——更强信号非更广,压窗 = "深换广"。
- 后果:未 ratify 期间原 `≥2 天` 判据继续生效,无损失。
- 载体:A1 = #5042;电池修复轮 = P2 posture 已合 `ceb0f08def`;**P1 凭据第二轮(停止容器泄漏)进行中,是 A1-ratify 的硬前置**。

### C1a · P3-INFO-1 subject_type 枚举(已查证,结论=满足)

- 复门给 A1 留的前置:确认 `record_permissions`/`field_permissions` 只带 recovery 覆盖的主体。
- **已查证满足**:两表都有 DB CHECK `subject_type IN ('user','role','member-group')`(`zzzz20260418143000` 加宽,此后无迁移改动),
  与触发器过滤谓词**完全一致**;三个应用写入方全在枚举内(`z.enum`/`isSheetPermissionSubjectType`)。越枚举值无法落库(23514)。
- 唯一残留由 HARDENING 车道兜住(见 §D3):subject_type CHECK 的**运行时**确认(pg_constraint 读)已并入 A-vs-B 漂移守卫(#5071 `d0911f264d`,独立车道 `multitable-recovery-schema-drift.yml`,check context 实名 **`recovery-schema-drift`**)。**该守卫目前尚未 required**——owner 须在 branch protection 加 `recovery-schema-drift` 到 required 才成底线(见 §E)。

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

## D2. owner 复审(2026-08-21)新增的待办

- **F1 · P1 凭据第二轮修复(硬前置)**:owner 用真实 Docker 证明——battery workflow 把密码 `docker cp` 进容器 `/tmp`,
  容器**停止**时 `docker ps` 看不到 ⇒ 清理跳过却报 PASS,而 writable layer 里密码仍在(`docker cp <stopped>:/…/password` 读回 9 字节)。
  **修复中(stdin-pipe 根治,不落容器盘)+ 停止容器 golden**。**修复前不建号、不 dispatch、不 ratify A1**。
- **F2 · 设漂移守卫为 required**:#5071 的 check context 实名 **`recovery-schema-drift`**;去 pull_request paths 后已对每个 PR 稳定产生该 context(修复轮 `<待填>`),
  owner 在 branch protection 加 `recovery-schema-drift` 到 required 即成 A-vs-B 底线。
- **F3 · search_path 根因裁决(L1 前)**:授权函数仍以**裸名**调 lease helper 且未固定 `SET search_path`;#5069 的 shadow census **只拒已污染库、不根治**。
  triggers DISABLED 时无影响,但 **L1 启用 triggers 前**应裁决并优先:schema-qualified 调用 + 固定函数 search_path + 真库反例。
- **F4 · 旧 Time Machine PR 处置**:除本轮三载体外,整条线仍有至少 #4216 / #4219 / #4224 / #4205 / #4204 / #4200 / #3805 为 OPEN,
  需逐个复核 superseded/parked 后关闭或标注(#4205 已知为 T-state parked)。

## E. 阶梯执行(全 owner-gated,日历为瓶颈,非开发)

L0(差 A1)→ L1 staging ENABLE triggers(≥1 天+电池,flag 全 OFF)→ L2 CONTIGUITY_STRICT → L3 WRITER_FENCE →
L4/L5 canary → **L6 soak ≥7 日历日** → L7+ 生产重放全序。**每级你亲授 + 观察窗**。压缩后地板约 9 天。
另需:目标主机跑一次**回滚后 postdeploy-full**(L0 §5 的 owner-gated 半条,本地演练不覆盖)。

---
**最短路径(owner 复审后订正)**:代码侧 → **P1 二轮修复(F1)+ 设 `recovery-schema-drift` required(F2)+ search_path 裁决(F3)** → 授权 staging 电池实跑 → PASS → 拍 B1(ratify A1,绑 #5042 exact content SHA)→ 挑时点开 L1。#5039 四迁移可并行,但 L1 前须 staging pending=0。C/D/D2/E 随进度陆续拍。**F1 修复前不建号/不 dispatch/不 ratify。**
