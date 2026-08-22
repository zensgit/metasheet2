# Time Machine — owner 决策清单(2026-08-21)

> ⚠️ **2026-08-21 修正(owner 复审后)**:本清单初版把 **B1「A1 前置已满足」写错了**——已**撤回**。
> owner 复审在承重工具(L1 电池)上构造出**两个真缺陷**:P1 远端管理员凭据在 cancel/超时/失败时
> 可能遗留在部署主机 `/tmp`;P2 posture 校验只查 trigger 名+tgenabled,**同名 trigger 在错表仍 9/9 ARMED**
> (假 ARMED,静默作废下游全部 409 证据)。**结论:A1 暂不可 ratify,电池暂不可 dispatch**,须先 fix-forward
> (凭据生命周期 → canonical posture 校验 → 变异测试 → 独立复门 → owner 授权 staging 实跑 → PASS 后再 ratify)。
> 下文 B1 段已按此改写。
>
> **2026-08-21 二次更新(fix-forward 已落地)**:两缺陷已修 + 过独立复门(APPROVE @ `ceb0f08def`,#5069);
> **B1 的代码侧前置:五轮复审后已全部闭合**(2026-08-21)。电池 workflow 凭据(#5069/#5076)、search_path 根修(F3,#5081)、context/台账(#5077)、建号脚本(F1:重写 #5080 + 提权修复 #5084 `162679992e`,含 login-first + 收敛行为 golden)、F5 readiness、五轮文案收窄——**均已落 main 且过独立复门(运行时代码 APPROVE,无 P1/P2)**。P3-INFO-1 已查证满足。**剩余全是 owner/ops:F2(设 required)、F3 主机证据、F4、建号/电池、#5039 pending=0、A1 ratify——见下。**
> 剩余 A1-ratify 前提**纯 owner/ops**:owner 授权 staging 电池实跑 → PASS → 再 ratify。secrets 已设、主机建号脚本已备。

> 一页看全:两条线(O-2 启用加固 + 阶梯加速)的**开发已全部落 main 并验证**;下面全是**只有 owner 能拍的板**。
> 每条给:决策、我的建议、拍板后果、相关载体。**本清单不代为决定,也不改变任何姿态。**
> 全程状态:4 flag OFF、9 trigger DISABLED(指纹 triggers `8c1be0b0…` / functions `14c180aa…`,双主机 run
> `32321464042` 2026-08-20 PASS——**这是 pre-fix 点内观测,保留为历史证据**)。
> **前瞻(2026-08-21)**:migration `zzzz20260821120000_recovery_authority_functions_fix_search_path`(CVE-2018-1058 型
> shadow 根治:helper 调用 schema-qualified + 固定 `SET search_path`,并把 proconfig 纳入指纹)部署后,
> **functions 指纹改为 `e4a78f6cc9c993ed5ed7d2c81dfc44b94d844c7fb046160d8d13077208fa2498`,triggers `8c1be0b0…` 不变**
> (不发 trigger DDL,9/9 仍 DISABLED,行为不变);详见 enablement-ladder 文首「指纹变更公告」。

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
- 前置:**代码侧已闭合;仅 owner/ops 前置未满足**(截至 2026-08-22 第六轮复审)。已落 main:电池凭据(#5069/#5076)、search_path 根修(#5081)、context/台账(#5077/#5083/#5085)、建号脚本重写 + 提权修复(#5080/#5084)。**未满足的全是 owner/ops**:F2 设 required、F3 双主机新指纹证据、#5039 staging pending=0、建号 + 电池实跑 PASS。四者齐备才可 ratify。已闭合缺陷存档:
  - **P1 凭据生命周期**:cancel/超时/失败时管理员邮箱+密码可能遗留部署主机 `/tmp`。**已闭合**(#5069 workflow always() 清理 → #5076 停止容器诚实枚举 → #5080/#5084 建号脚本 stdin-only+trap;全过独立复门)。
  - **P2 canonical posture 校验**:当前只查 trigger 名+tgenabled;同名 trigger 在错表仍报 9/9 ARMED=假 ARMED。
    需校验表/事件/函数/参数/更新列/函数指纹+变异测试。**(已修 + 过独立复门,合 `ceb0f08def`)**
- 修复后序列:凭据修复 → canonical posture 校验 → 变异测试 → 修正本清单/文档 → exact-head 独立复门 →
  owner 授权 staging 电池实跑 → **PASS 后再 ratify A1**。
- 门审边界(修好后仍适用):干净电池只观测 **12/48 census 站点 + 6/9 触发器**——更强信号非更广,压窗 = "深换广"。
- 后果:未 ratify 期间原 `≥2 天` 判据继续生效,无损失。
- 载体:A1 = #5042;电池修复轮全落 main(#5069/#5076/#5077/#5080/#5081/#5083/#5084);**代码侧 F1 硬前置已解除(#5084)**;A1-ratify 剩 owner 侧前提(F2/F3 主机证据/建号+实跑 PASS/#5039 pending=0)。

### C1a · P3-INFO-1 subject_type 枚举(已查证,结论=满足)

- 复门给 A1 留的前置:确认 `record_permissions`/`field_permissions` 只带 recovery 覆盖的主体。
- **已查证满足**:两表都有 DB CHECK `subject_type IN ('user','role','member-group')`(`zzzz20260418143000` 加宽,此后无迁移改动),
  与触发器过滤谓词**完全一致**;三个应用写入方全在枚举内(`z.enum`/`isSheetPermissionSubjectType`)。越枚举值无法落库(23514)。
- 唯一残留由 HARDENING 车道兜住(见 §D3):subject_type CHECK 的**运行时**确认(pg_constraint 读)已并入 A-vs-B 漂移守卫(#5071 `d0911f264d`,独立车道 `multitable-recovery-schema-drift.yml`,check context 实名 **`recovery-schema-drift`**)。**该守卫目前尚未 required**——owner 须在 branch protection 加 check context **`recovery-schema-drift`**(job 名,**非**文件名 `multitable-recovery-schema-drift`)到 required 才成底线(见 §E)。

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

- **F1 · 建号脚本(硬前置,✅ 已闭合)**:owner 复审历经四步——(1) battery workflow `docker cp` 密码进容器 → 停止容器假 PASS,**已修 #5076**;
  (2) 配套建号脚本 `create-l1-battery-admin-on-staging.sh` 重现同一泄漏 + 非原子提权,**已重写落 main #5080 `95318992ab`**(stdin-only+trap+单事务);
  (3) 第四轮发现该脚本提权漏洞:register 接受 409(预占邮箱)→ 先提升 → 后验密码,预占账号即得 admin。**已修并落 main #5084 `162679992e`**(login-first 拿服务端 user.id→按 id 原子提升;预占+错密码零提权 golden + mismatched-id 收敛行为 golden;独立复门 APPROVE)。
  (4) 第五轮:'zero database writes' 文案过强(register 先提交普通用户行)——已收窄为'zero privilege writes,普通用户残留可安全重跑'。**F1 全闭合。**
- **F2 · 设漂移守卫为 required(owner 动作,尚未做)**:check context 实名 **`recovery-schema-drift`**(job 名,非文件名),已对每个 PR 稳定产生(#5075)。
  **F3 复门证实这是安全必需**(非可选):否则有人 revert `public.` 限定符后重生成指纹 → required 全绿而 shadow 重开,只非-required 反例能抓。owner 在 branch protection 加 `recovery-schema-drift` 到 required。
- **F3 · search_path 根修 —— 已落 main(#5081 `d3289945e1`)**:新迁移 schema-qualified 调用 + 固定 `SET search_path=pg_catalog,public`;函数指纹 `14c180aa→e4a78f6c`;triggers 不变 9/9 DISABLED;真库反例全 5 触发器路径均被防(复门 APPROVE)。
  **⚠️ ops 协调**:迁移使 prod 函数变新指纹**仅在迁移跑时生效**;镜像落但迁移未应用时跑 postdeploy-full 会 FAIL 在 config 字段=**预期(config-field)非 drift**,迁移须先于 containment/L1 dispatch。**⚠️ 待补:新指纹的双主机 postdeploy-full 证据尚未取。**
- **F4 · 旧 Time Machine PR 处置(可并行)**:整条线仍有 #4216 / #4219 / #4224 / #4205 / #4204 / #4200 / #3805 全 OPEN,逐个复核 superseded/parked 后关闭或标注(#4205 已知 T-state parked)。
- **F5 · P3(第四轮):#5080 golden readiness 竞态 — ✅ CLOSED**:`pg_isready` 后即连目标库(可能库未建好即返回)——PR 跑一度 19/20。**已改为目标库上 `SELECT 1` 循环(`waitForTargetDbQueryable`),随 F1 同轮落 main #5084 `162679992e`**;goldens 连跑无 flake。
- **F6 · P3-1(可选硬化)**:`recovery-authorization-stability.ts` 的函数指纹与 containment 常量无机械交叉守卫——将来改一份漏另一份会静默再破生产 lease。可加一条断言绑定。

## E. 阶梯执行(全 owner-gated,日历为瓶颈,非开发)

L0(差 A1)→ L1 staging ENABLE triggers(≥1 天+电池,flag 全 OFF)→ L2 CONTIGUITY_STRICT → L3 WRITER_FENCE →
L4/L5 canary → **L6 soak ≥7 日历日** → L7+ 生产重放全序。**每级你亲授 + 观察窗**。压缩后地板约 9 天。
另需:目标主机跑一次**回滚后 postdeploy-full**(L0 §5 的 owner-gated 半条,本地演练不覆盖)。

---
> ⚠️ **第五轮 owner 复核观察(2026-08-21)**:F3 迁移已在 prod 执行,但部署窗口内有一次健康探针 `curl rc=7`;新指纹 `e4a78f6c` 的**双主机 postdeploy-full 证据尚未取**,staging 也未验证。**不能据此称 main 全绿或 prod 已稳定** —— F2 之后须先取双主机 postdeploy-full 证据(见 F3)再往下走。

**最短路径(第五轮后,代码侧已闭合——以下全 owner/ops)**:① owner 设 `recovery-schema-drift` required(F2,安全必需)→ ② staging 迁移 + 双主机 postdeploy-full(取新指纹 `e4a78f6c` 证据,迁移须先于 dispatch)→ ③ 建号(用 #5080/#5084 修好的脚本)+ 授权 staging 电池实跑 → PASS + 确认 #5039 pending=0 → ④ ratify A1(绑 #5042 exact content SHA)→ L1。F4 旧 PR 清理可并行。
