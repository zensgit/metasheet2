# 多维表 Time Machine O-2 启用阶梯（enablement ladder）— RATIFIED

> Status: **RATIFIED**。批准来源 = owner 在承载 PR #5014 留下的 exact-SHA 批注
> `RATIFY 642b765a96`（本文档自身定义的 RATIFY 机制即为此）。本次仅同步文件头——
> 批准早已成立，头部此前未跟上（ledger-sync）。
> **批准的是顺序与判据本身，不含任何台阶执行授权**：本文档不执行任何一步，
> 每一级台阶仍是**独立的 owner/ops 动作**，文档状态 ≠ 任何 flag/trigger 变更授权。
> 基线：#4654 closeout（merged `12f1f8c466`，inert 落地）。
> **主机证据（2026-08-20 刷新，取代原 08-12 的一组）**：双主机 postdeploy-full PASS，
> run `32321464042`（prod `metasheet-backend` + `metasheet-staging-backend` 同刻同指纹：
> 4 flag 运行态与 next-restart 均 CONTAINED、triggers 9/9 DISABLED `8c1be0b0…`、
> functions 6/6 `14c180aa…`、`meta_links.foreign_record_id` FK 0/0）。
> 原证据（prod run `31650980676`、both run `31651250987`，绑镜像 `12f1f8c466`）保留为历史记录，
> 但**已不是当前镜像的证据**——L0 判据以上面这组为准。

> **⚠️ 指纹变更公告（2026-08-21，migration `zzzz20260821120000_recovery_authority_functions_fix_search_path`）**：
> 该迁移对 6 个 recovery-authority 函数做了 search_path 加固（CVE-2018-1058 型 shadow 根治）——
> 3 个 trigger 函数体内的 helper 调用改为 schema-qualified（`public.metasheet_try_recovery_authority_*`），
> 且 6 个函数全部加上固定 `SET search_path = pg_catalog, public`；containment helper 同时把
> `proconfig`（即该 search_path）纳入指纹。**结果：functions 指纹从 `14c180aa…` 变为
> `e4a78f6cc9c993ed5ed7d2c81dfc44b94d844c7fb046160d8d13077208fa2498`（两次全新迁移字节稳定）。
> triggers 指纹 `8c1be0b0…` 不变**（本迁移不发任何 trigger DDL，9/9 仍出厂 DISABLED，OID 保留）。
> 因此：下文凡描述**当前镜像/全新迁移库 EXPECTED functions 指纹**处，随该迁移部署后应读
> `e4a78f6c…`；而**已注明日期的主机 run（`32321464042`）与 §5.1 演练（2026-08-20）**保留其
> 观测到的 pre-fix `14c180aa…` 作为 point-in-time 历史证据，不改写。行为不变（同锁语义、同 40001
> raise、同 DISABLED 姿态）——只硬化了名字解析。

## 0. 为什么需要阶梯

closeout 落的是**默认关闭的基座**。把它变成活能力涉及两类互相独立的开关：

- **DB 侧**：8 张平台授权表上的 9 个 triggers（出厂 DISABLED）。ENABLE 后平台权限写路径
  开始参与 recovery-authority 串行化 ⇒ 平台写者第一次真的会遇到 40001。
- **应用侧**：4 个 env flag（`MULTITABLE_HISTORY_CONTIGUITY_STRICT` /
  `MULTITABLE_ENABLE_WRITER_FENCE` / `MULTITABLE_ENABLE_SHEET_REVERT` /
  `MULTITABLE_ENABLE_PIT_RESET`）。

顺序错误的代价不对称：先开 flag 后开 trigger ⇒ recovery 对 `authorityLease='unavailable'`
fail-closed（安全但全部失败）；先开 trigger 而平台写路径没做 40001 分类 ⇒ 用户可见 500
（这正是 O2-S2 存在的理由）。所以**trigger 先行、flag 逐个、staging 先于生产**。

## 1. 前置（L0，全部满足才允许 L1）

- [x] O2-S1（注册同事务原子性）、O2-S2（40001 单一分类器 + 11 写者 census）、
      O2-S3（recovery 租约有界退避）已合 main 且随镜像部署到目标主机。 — 载体 #5014 `642b765a96` 已在 main，prod/staging 两侧现镜像均含之（已核）。
- [x] 目标主机 `postdeploy-full` containment PASS（**当前镜像**）——run `32321464042`（2026-08-20，双主机）。
- [ ] ⚠️ **staging 的 pending migrations ≠ 0**：2026-08-20 部署 `401fa1d880` 时，迁移对齐报告判
      `do_not_run_full_migrate`，runner 按 bundle §3.2 停止 —— staging 容器已在新镜像上、
      但**他线**（考勤 W7 / 审批 Lock-N 等）的迁移积压未应用。**本阶梯所依赖的三条 recovery 迁移
      早在 2026-08-12 已应用**，故上面那条 containment PASS 成立；但 L0 原文要求的
      「pending migrations = 0」在 staging 上**不成立**，需按
      `docs/development/staging-migration-alignment-runbook-verification-20260519.md` 单独处置后再开 L1。
- [x] **census 可达性升级已闭合**（对抗门 P3-1 已收口：48 站点行为腿 + 运行时执行绑定 + tag 唯一 + 一名一 tag 全落地，见 #5018/#5020）。**剩余的不是这个缺陷，而是 owner 对天花板类残留的裁量**（T2 空壳替换 / 构造式 tag / `CLASSIFIER_MODULE` 迁移——文本守卫无法证明 src 站点可达性）；该裁量是 L0 的一个独立 owner 决策项，不是编码缺口。
- [x] 回滚路径**脚本侧已演练一次**：`scripts/ops/multitable-recovery-authority-triggers.mjs`
      （`disable`=大红回滚，从 census 派生 9 目标、单事务、亏损即回滚），在真库上跑通
      enable→disable 往返并验回到出厂指纹（见 §5 演练记录，#5037 `a875950936`）。
      ⚠️ **L0 剩这一条的另一半仍开着**：在**目标主机**上跑 `postdeploy-full` 验证回到 inert
      姿态，属 owner-gated 主机动作，本地演练不覆盖——L1 前须由 owner 执行一次。

## 2. 阶梯（每级 = 独立 owner 授权 + 观察期）

**L1 — staging ENABLE triggers（flags 保持全 OFF）**
9/9 triggers ENABLE（仅 staging）。flags 全 OFF ⇒ recovery 端点仍不可达，本级只暴露
「平台写 × authority 串行化」。观察 ≥2 日历日：40001 发生率、S2 分类器命中
（409/具名 retryable，**零** unmapped 500）、平台写延迟无回归。

**L2 — staging `MULTITABLE_HISTORY_CONTIGUITY_STRICT=1`**
只读侧收严（历史链断裂拒绝重建）。观察：strict 拒绝率 = 预期（合成断链演练拒绝、
正常表通过），无误伤。

**L3 — staging `MULTITABLE_ENABLE_WRITER_FENCE=1`**
写者围栏可达。观察：普通写路径无回归；S3 退避在写者间隙内拿到租约（演练）；
写者不停时 recovery 仍具名 busy（fail-closed 不变）。

**L4 — staging `MULTITABLE_ENABLE_SHEET_REVERT=1`（canary）**
在**具名合成 org**（禁客户数据）上执行 revert 演练：precise-anchor 成功、
preview-drift abort 正控、trash/link 状态核对。

**L5 — staging `MULTITABLE_ENABLE_PIT_RESET=1`（canary）** — 同 L4 纪律做 reset 演练。

**L6 — staging soak**：全开姿态 ≥7 日历日。判据（全部满足才可申请生产）：
零 unmapped 40001（=零该类 500）、零 40P01、零 containment 意外、canary 演练全绿、
recovery busy-exhaustion 率在口径内。

**L7+ — 生产**：重复 L1→L5（同序、同判据、独立授权、canary org 另立）。任一观察不达
⇒ 停在当前级或回滚一级，**不跳级、不补授权**。

## 3. 每级通用规则

授权 = owner 亲笔（exact 内容 + 目标环境 + 级别）；执行后立即跑 `postdeploy-full`
（containment workflow 的 flag 腿此时**预期红**的项须与本级声明的开启集合精确一致——
差一个即回滚）；观察窗内新增 P1/P2 ⇒ 冻结阶梯。

## 4. 已登记残余（启用面不扩，此处只登记处置）

- **foreign-fence 共享查找表形状**（FK KEY SHARE vs 行锁 FOR UPDATE，pre-existing）：
  可用性问题非死锁；L4/L5 canary 演练须包含一次 link-in 表并发写场景确认无 40P01。
  根治（围栏全部 link-in sheet 或弱化记录锁）留独立立项。
- **retention 后恢复 / 整表 resurrect / 归档异步恢复（Phase D）**：与本阶梯无耦合，
  另立设计锁。
- **`#4446` resurrect 参考件**：reference-only（`multitable-4446-resurrect-reference-design-20260812.md`），
  不随本阶梯启用。

## 5. 回滚（每级可逆，单向依次撤）

flag 级：从 compose/env 移除该 flag → 重启 → `predeploy-flags` 验证该 flag CONTAINED。
trigger 级（大红开关）：9/9 `DISABLE TRIGGER` → `postdeploy-full` 验证回到出厂 inert
指纹（triggers `8c1be0b0…` / functions `e4a78f6c…`（随 `zzzz20260821120000` 起，pre-fix 为
`14c180aa…`，见上「指纹变更公告」）仍应精确匹配——DISABLE 不改函数体）。
回滚不需要迁移、不丢数据（authority locks 表保留，无消费者时惰性）。

### 5.1 演练记录（2026-08-20，作者在全新 PG15.17 库上**独立复现**，非只信实现车道 transcript）

演练用可执行脚本 `scripts/ops/multitable-recovery-authority-triggers.mjs`，判定用 `multitable-recovery-schema-containment.mjs` 的**原始输出**逐步核对：

| 步 | 动作 | 结果 |
|---|---|---|
| baseline | 全新迁移库 | containment PASS；触发器 `8c1be0b0…`；函数 `14c180aa…`；9/9 `tgenabled='D'` |
| enable | 脚本 `enable` | 9/9 armed；containment FAIL；触发器漂移到 `b87ded5a…`；**函数仍 `14c180aa…`**（证 DISABLE/ENABLE 不碰函数体） |
| disable | 脚本 `disable`（大红回滚） | containment PASS；触发器**精确回到** `8c1be0b0…`；函数 `14c180aa…`；0/9 armed |
| 变异 | armed 全 9，手动只 disable 8/9（留 `trg_user_roles_…`） | containment **FAIL**，一枚仍 armed——证演练能发现**不完整**回滚，非只对干净态点头 |
| 原子性 | 脚本目标注入一枚伪触发器 | 42704，整事务回滚，**0/9 armed**，containment 仍 PASS |

hermetic 守卫 13 测试在无 node_modules 纯净树 13/13,已接入 obs-kit contract required 车道。
**未行使的轴（如实披露)**:PG16 / musl / x86(本地=PG15 Homebrew aarch64)、`lock_timeout` 路径(空库无并发写者)、以及**目标主机**上的 postdeploy-full(见上 ⚠️,owner-gated)。

## 修正案 A1 — L1 窗口的证据替代（Status: **PROPOSED**，未 ratify 前上文判据原样生效）

> RATIFY 机制与本文档相同：owner 在承载 PR 以 exact-SHA 批注 `RATIFY-A1 <sha>`。
> **前置**：A1 仅在「L1 演练电池」落地 main **且通过独立对抗门审**后方可 ratify——
> 电池是本修正案的承重证据工具，未经门审的电池不得作为窗口压缩依据。

### A1.1 修正内容（仅两处，其余判据一字不动）

- **L1（staging）观察窗**：「≥2 日历日」→「**≥1 日历日 + L1 演练电池 PASS**」。
- **生产 L1**（经 L7+「同判据」继承）：同上替代。
- **明确不变**：L6 soak ≥7 日历日**不动**（它买的是一个完整周周期的日历节律——周末形态、
  weekly cron、备份窗——合成负载伪造不了；租约饥饿/死锁积累是慢显影病灶，soak 是唯一
  在真实节奏下行使它们的机会）；L2–L5 判据不变（本就无日历约束）。

### A1.2 为什么这是证据替代而非偷工

staging 有机流量稀薄：被动等 2 天,「40001 发生率」实际近零——因为 flags 全 OFF 时无人持租约,
触发器永不冲突。被动窗口**测不到它声称要测的东西**。电池主动构造判别条件:
在库内持真实的**独占** authority 租约(xact 级 advisory lock),经**已部署的真实应用 HTTP 面**
驱动 census 写面,逐面断言:持锁期 = 具名可重试 409(`RECOVERY_AUTHORITY_BUSY`),
**零** unmapped 500,**零** 2xx(持独占锁下 2xx = 触发器未触发,比 500 更糟——它会静默作废
L1 本身);释锁后 = 同写面 2xx(正控,证 409 确为租约所致)。保留的 ≥1 日历日守住电池
覆盖不了的轴:平台写延迟无回归、无非构造性异常。

### A1.3 电池 PASS 的工件绑定(防口头 PASS)

ratify 后,L1 出窗必须同时出示:L1 电池 workflow run URL、evidence JSON 工件、
被验 head/镜像 SHA、驱动面清单(含**逐面点名的 NOT-DRIVEN 面**及原因——无静默上限)。
缺任一项 = 窗口未满足,回落到原 2 日历日判据。

### A1.4 记录但**不属于 A1**的激进选项(owner 独立裁量,默认不推荐)

soak 尾部 1–2 天与生产 L1 重叠可再省 1–2 天。代价:若 soak 第 6 天冒出问题,生产触发器已开
(回滚已演练、单命令可逆,风险有界但真实)。此选项**不随 A1 一并 ratify**;owner 若要行使,
须另行明示。
