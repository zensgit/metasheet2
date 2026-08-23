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
> 全程状态:4 flag OFF、9 trigger DISABLED(**当前权威指纹见阶梯 §5.2**:triggers `4d68217d…` / functions `e4a78f6c…`;
> 下方 run 记录里的 `8c1be0b0…`/`14c180aa…` 是**当时**实测值,epoch-bound,今天重跑不会复现)(双主机 run
> `32321464042` 2026-08-20 PASS——**这是 pre-fix 点内观测,保留为历史证据**)。
> **前瞻(2026-08-21)**:migration `zzzz20260821120000_recovery_authority_functions_fix_search_path`(CVE-2018-1058 型
> shadow 根治:helper 调用 schema-qualified + 固定 `SET search_path`,并把 proconfig 纳入指纹)部署后,
> **functions 指纹改为 `e4a78f6cc9c993ed5ed7d2c81dfc44b94d844c7fb046160d8d13077208fa2498`;triggers 的 DDL 与 DISABLED 姿态不变,
> 但其打印值早已因 #5069 加宽 canonical identity 而变为 `4d68217d…`(armed 态 `505926e3…`)——原写「triggers `8c1be0b0…` 不变」对 DDL 为真、对打印值为假,已更正,见阶梯 §5.2**
> (不发 trigger DDL,9/9 仍 DISABLED,行为不变);详见 enablement-ladder 文首「指纹变更公告」。

## A. 现在就能拍、且解锁最多的

**A1 · 把 #5039 便笺转给审批线补迁移积压(**已非 4 条**——见 #5094 `0f24e8430d`,实测 ≥10 且每日增长)**
- 决策:让审批线按便笺(`staging-approval-migrations-disposition-20260820.md`)在克隆上彩排后应用 4 条审批迁移。
- 我的建议:**做**。这是 L0 唯一未勾项(`staging pending migrations ≠ 0`),也是整条阶梯的真瓶颈——L1 卡在它上。
- 后果:staging `pending=0` → L0 五项全绿 → L1 可开。4 条全零命中本阶梯爆炸半径,2 条 high 是启发式误报(纯 CHECK 加宽)。
- 归属:审批线执行 + owner 批准;**Time Machine 线不代应用**(runbook 要求克隆彩排)。

## A-2 · ⚠️ staging 重部署 —— 原计划缺失的硬前置(2026-08-22 深审发现)

staging 现镜像(`401fa1d880`,或 08-21 那次失败尝试的 `5e9a15f02e`)**不含**:

- **电池脚本** `scripts/ops/multitable-l1-battery.mjs`(该树里根本没有此文件)⇒ 电池 dispatch 会 `MODULE_NOT_FOUND`
- **任何 `zzzz20260821*` 迁移**(含 F3 的 search_path 修复)⇒ 窗口 runner 无从应用 F3
- **匹配的 containment helper**:该镜像里的 helper sha 与 workflow 钉的 `c52501a9…` 不等 ⇒ postdeploy-full 的 **staging 腿会在 helper-sha 检查处以「被篡改」措辞直接失败**,根本到不了数据库观测

**因此:第 6/7/9 步(取证 / 建号 / 电池)在 staging 重部署到 ≥ `d3289945e1` 之前全部不可执行**,且失败形式具误导性(像是安全告警而非"镜像太旧")。`Dockerfile.backend` 的 `COPY scripts` 保证重部署即全部修复。

## D2-F7 · X2 · `config-restore-execute` 的一条 unmapped-500 路径(L4 前须处置)

`applyPermissionDeEscalation`(`src/routes/univer-meta.ts:6780`)写 `field_permissions` / `spreadsheet_permissions`——**两表的触发器在 L1 起都会 armed**。其唯一调用点在 `POST /sheets/:sheetId/config-restore-execute` 内,而该路由的外层 catch 只认 `SheetWriterBlockedError` / `TombstoneCaptureCapExceededError` / `DB_NOT_READY`,**不查 `isRecoveryAuthorityBusyError`** ⇒ 40001 落到 `500 INTERNAL`。

- **为何 L1 期不发作**:独占租约此时只有电池持有,且其主体全是 `o2bat_` 合成对象。
- **L4+ 会激活**:真实主体的租约一旦存在,击中即产生 unmapped 500 —— 直接违反 L6 的「零 unmapped」判据。
- **修法**:该 catch 加一行既有映射。**同文件已有 5 处这么做**(`isRecoveryAuthorityBusyError` 出现 5 次),所以这是**遗漏而非设计**。
- **处置**:L4 前落地,或 owner 签字接受该风险。

## B1a · A1 ratify 的两处自伤(ratify 前须二选一处置)

1. **A1.3 的证据包今天产不出**:A1.3 要求出窗出示"被验 head/镜像 SHA",但电池 evidence JSON 与 workflow step-summary **均无任何镜像 digest / 脚本 sha 捕获**(对照:containment 腿有 `SCHEMA_HELPER_SHA256` pin)。⇒ 每个 PASS 都绑不上镜像,**按 A1.3 自身条款窗口自动作废**。**修法**:workflow 加 `docker inspect` digest 捕获 + 电池脚本 sha pin(小改),**或** owner 明文接受人工 out-of-band 记录为等价物。
2. **生产继承条款不可满足**:A1.1 经"L7+ 同判据"把压缩窗继承到生产 L1,但 (i) 电池 workflow 的 `target` 是硬 choice `[staging]`,头注明言生产需另立独立授权 workflow;(ii) prod 跑过 legacy `033_create_rbac_core.sql`,其中建了 `role_permissions.role_id → roles(id) ON DELETE CASCADE`,而电池每次运行都重验该前提(自过期见证查询)——**cascade 存在即 exit 1 `not_driven_reason_expired`,拒产任何证据**。⇒ 会 ratify 一条今天不可满足的生产条款。**修法**:ratify 限定 staging L1,生产条款改为"需电池扩展 + 独立 workflow 后另议"。

> prod 那条 cascade FK 目前是 **INFERRED-STRONG**(据 prod 迁移账),**一条只读 SQL 即可定案**:在 prod 跑电池的见证查询(`multitable-l1-battery.mjs` 内 `ROLE_CASCADE_WITNESS_QUERY`)。建议在 ratify 前顺手跑掉。

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

**最短路径(2026-08-22 深审后重排 —— ⚠️ 原顺序是循环的,见下)**

> **原顺序为何不可执行**:电池在 9/9 触发器未 ARMED 时**硬拒**(exit 2 `NOT_ARMED`),而电池 workflow **不代 arm**
> (其头注:"only at ladder rung L1 … after the owner has ENABLEd the 9 triggers")——**arm 9/9 就是 L1 的定义动作**。
> 原路径却把"电池 PASS"排在 ratify A1 与 L1 **之前**:照此执行则电池必红、无 PASS 可依、L1 永远排在最后。
> **正解:L1 按现行已 ratify 的 ≥2 日历日判据先开,电池在窗口内跑,PASS 后再 ratify A1,并按新判据 ≥1 天出窗。**

1. **F2** owner 加 check context `recovery-schema-drift` 到 branch protection ∥ **F4** 旧 PR 清理(已完成)∥ owner 落墨 C1 天花板裁决
2. **文档修正一票**(本 PR):指纹权威表(§5.2)、armed 预期红(§5.3)、redeploy 前置、清单指向 #5094
3. **电池 workflow 补 digest 捕获 + 脚本 sha pin**(B4;或 owner 明文接受人工等价物)—— **ratify 前必须二选一**
4. **#5094 交付执行**:pin 部署 SHA + 冻结新迁移文件合并 → 按 pinned SHA 重生成对齐报告 → §7 只读预检 → 克隆彩排
5. **⚠️ staging 重部署 pinned SHA(≥ `d3289945e1`)+ 应用迁移 → pending=0** —— **原计划缺失的硬前置**(见 §A-2)
6. **双主机 postdeploy-full**:取 triggers `4d68217d…` + functions `e4a78f6c…` PASS(=F3 证据,同时重绿 L0 item2)
7. **建号**(用 `scripts/ops/create-l1-battery-admin-on-staging.sh`;两枚 secrets 已设)
8. **owner 按现行 ≥2 天判据开 L1**:enable 9/9 → 立即 postdeploy-full(**trigger 腿预期红 = `505926e3…`**,flag 腿全绿)
9. **窗口内** dispatch 电池(intent `L1-open-battery-run-1`)→ PASS(证据绑镜像 digest)
10. **ratify A1 于 #5042**(建议绑 merge commit `5b2376bb49`,并在批注声明所用 SHA 形式)→ 出窗 → L2
11. **L4 前**:X2 一行修复落地,或 owner 签字接受(见 §D2-F7)

**F1 已闭合;不再有"修复前不建号"的阻断——但第 5 步(staging 重部署+迁移)未完成前,第 6/7/9 步都会以难诊断的方式失败。**
