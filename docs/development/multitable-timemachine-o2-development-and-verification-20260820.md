# 多维表 Time Machine — O-2 启用加固与阶梯就绪：开发与验证记录（2026-08-19/20）

> 范围：本记录覆盖 **O-2 启用加固**（closeout 之后、阶梯启用之前的全部工程工作）。
> **安全边界（全程不变）**：四个 recovery flag 全 default-OFF；9 个 authority triggers 出厂 DISABLED；
> 本轮**未翻任何 flag、未 ENABLE 任何 trigger、未在任何主机上改变姿态**。
> 阶梯 L1–L7 的执行是**逐级 owner 授权 + 日历观察窗**，不是开发；Phase D / T-state 等是需先立设计锁的
> 后续能力。二者均**不计入**本记录的"完成"。

## 0. 为什么需要 O-2

`#4654` closeout 把 exact-anchor 恢复能力落成了**默认关闭的惰性基座**：代码在、schema 在、触发器在，
但全部不可达。要把它变成可启用的能力，必须先补齐三件**只有启用后才会暴露、启用后再补就来不及**的事：

1. **平台写路径会第一次遇到 40001**（触发器 ENABLE 后，平台权限写进入 recovery-authority 串行化）——
   若不分类，用户直接看到 500。
2. **注册路径的两事务缺口**：`createUser` 先提交、角色写在另一事务，忙碌耗尽后留下"有用户无角色"的残骸。
3. **recovery 可能永远抢不到租约**（写者持共享租约 ⇒ 单次 NOWAIT 立即 busy），即饥饿。

## 1. 交付明细（按切片；模型按难度分派）

| 片 | 内容 | 模型 | 承载 PR / SHA |
|---|---|---|---|
| S1 | 注册同事务原子性 + 整事务有界重试 | Sonnet 实现 / Opus 门 | #5014 `642b765a96` |
| S2 | 单一 40001 分类器 + 11 写面机械 census | Sonnet 实现 / Opus 门 | #5014 `642b765a96` |
| S3 | 独占-recovery 租约有界退避（NOWAIT 模型不变） | Sonnet 实现 / Opus 门 | #5014 `642b765a96` |
| S4 | 启用阶梯设计（trigger 先行 / flag 逐个 / staging 先行） | 主循环起草 | #5014 → **owner RATIFIED** |
| A1 | census 可达性升级（48 站点行为腿） | Sonnet 实现 / Opus 门 | #5018 `48134a16a4` |
| A2 | 退避 clamp 负例 | Sonnet | #5018 |
| A3 | register-null 语义收窄（不再谎报 409） | Sonnet | #5018 |
| A4 | L4/L5 演练 runbook + 只读观察 kit | Sonnet | #5018 |
| 附1 | SSH host-key pin 全家族（tier1+tier2） | Sonnet 实现 / Opus 门 | #5015 `543f367670` |
| 附2 | runLocal fakeHome 清理（NIT） | Fable | #5013 `8308495f47` |
| P3-* | 门审残余收口（见 §3；census linkage 执行绑定、SQL/runbook 守卫硬化、闭世界分母、CI 执行层证明） | Sonnet/Fable 实现 / Opus 门 | #5020 `401fa1d880` |

### S1 注册同事务原子性
`AuthService.register()` 现在在**同一事务**内创建用户并写角色，40001 触发**整事务**有界重试，
耗尽抛具名 `UserRoleAssignmentRecoveryBusyError`。
**证据**：真库注入（按本次运行唯一 email 命名空间收窄的触发器，抛真 ERRCODE 40001）→ 耗尽后
`users / user_login_aliases / user_permissions / user_roles` **四类零残留**，随后同 email 重注册成功；
触发器触发计数 == 重试上限，证明是**整事务**重试（逐语句重试会 25P02，触发器不可能触发三次）。
**变异**：还原"先提交用户"的旧形状 → 零残留断言在 `auth-register-atomicity.db.test.ts:244` 精确红
（`{users:1, aliases:2, permissions:6, roles:0}` vs 全零）。

### S2 40001 单一分类器 + 机械 census
教训约束：**枚举陷阱不收敛** ⇒ 不逐点 try/catch，而是**一个分类器 + 一份机械 census**。
11 个写面（deprovision-evidence-api / deprovision-ledger / invite-accept-writes / user-activate /
attendance-admin / spreadsheet-permissions / permissions / roles / directory-sync / dingtalk-oauth /
routes/auth 注册 handler）统一经 `classifyRecoveryConflict` / `translateRecoveryConflict`，
40001 → 具名可重试 409；**非 40001 路径逐字节不变**（正向断言）。
**证据**：真库中由真实触发器抛出的 40001（在真正持有的独占 recovery 租约下）被正确分类并再抛；
真实 23505 原样穿透；sentinel 证明"该跑而没 DB"是**红不是跳**。

### S3 租约有界退避
每次尝试都是**全新 NOWAIT**，尝试之间**释放全部已取锁**再退避——因此 no-deadlock 模型不变、
不引入任何新锁序。耗尽后仍是既有 fail-closed 拒绝。
**证据**：真库构造——(a) 持续写者流 + maxAttempts=1 ⇒ 立即 busy（基线控制）；(b) 写者在第一次退避
睡眠期间释放 ⇒ 第 2 次尝试拿到；(c) 写者不停 ⇒ 恰好 N 次全新尝试后同一具名 busy、零写零 burn；
(d) **双连接证明**退避睡眠期间本方零持锁（独占探针在写者持锁时 FALSE、在退避期 TRUE，
且一个全新写者事务能在睡眠期提交）。
**保守点（owner 已裁 DEFER 到 L3）**：公开 busy 结果仍沿用既有 `preview-drift` 409——
main 无独立公开 busy 码，新造属合同变更，需单独 ratify。

### S4 启用阶梯（RATIFIED）
`docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md`：
L0 前置 → L1 staging ENABLE triggers（flag 全 OFF）→ L2 CONTIGUITY_STRICT → L3 WRITER_FENCE →
L4 SHEET_REVERT（canary）→ L5 PIT_RESET（canary）→ L6 soak ≥7 日历日 → L7+ 生产重放全序。
**顺序的不对称代价**：先开 flag 后开 trigger ⇒ 全部 fail-closed（安全但不可用）；
先开 trigger 而平台写未分类 ⇒ 用户可见 500（这正是 S2 存在的理由）。
owner 已以绑 `642b765a96` 的 exact-SHA 批注 RATIFY（#5014 评论）；**批准不含任何台阶执行授权**。

### A1 census 可达性升级
门审 `#5014` P3-1 实证：token census 只数存在、不辨死代码——把 admin-directory 9/10 站点
`if (false && …)` 化后仍 55/55 全绿。修法：**每个登记站点补一条驱动该站点的行为腿** + 行↔腿链接元断言。
**判据本体（不可打折）**：门审那把死支刀**对每个登记站点逐一机械重放，每站至少一测红**。
**证据**：48/48 站点全红，且**双射**——每站恰红自己的 tagged leg；门审独立重放全部 48 站点复现该性质；
分母亦被核实（token 扫描 + import 扫描双双落在同一 13 文件 48 站点）。

### A4 演练与观察工装
`multitable-o2-observation.sql`（只读查询，每条注明各阶梯级的预期形状）+
`multitable-o2-canary-drill.md`（L4/L5 canary 清单，**每个触主机命令块标 OWNER-GATED**，机械强制）。
**诚实 sink 盘点**：HTTP-409 分类器命中数与精确 40001 计数**在库内没有可查询 sink**
（`AuditRepository` 在 `src/audit/` 外零调用方；PostgreSQL 无累计 40001 计数器）——
SQL 因此查真实代理量（触发器姿态 / xact_rollback 上界 / deadlock 增量 / 时点 pg_locks / token burns /
parked writer-fence 状态），权威计数属 app/PG 日志侧 = owner-gated 主机领域。

## 2. 验证方法学（为什么这些证据可信）

1. **变异只证承重**：每条守卫都真刀实改、亲眼见红、按文件备份还原（禁 `git checkout --`），并核字节一致。
2. **判据本身也要被攻击**：A1 的 census 判据被"死支化"攻破过一次（门审 P3-1）；本轮再被
   `it.skip` / `.only` 攻破一次（门审 #5018 P3-1）——每次都升级判据而非辩护。
3. **"不发生"必配正控**：零残留、never-invoked、无锁持有等断言，全部配可见的正向对照。
4. **真库 vs mock 分界**：竞态、锁、40001、残留一律真 PostgreSQL 构造；只有路由映射用 harness。
5. **被触发 ≠ 被验证**：新真库套件一律两点接线（no-DB 排除 + 真库步整文件），并由 wiring 守卫钉住；
   sentinel 保证"该跑而没跑"是红不是跳。本轮据此把观察 kit 的**执行层**从"CI 里从未跑过"改为承重。
6. **集成前先试合**：多车道并行改同一批文件时，先在**丢弃分支**上试合并跑关键守卫——
   本轮据此在 carrier 构建前抓到 P3-1 抽表 × NIT-5 解析器的耦合（5 红），CI 不会替你抓这类。
7. **改了守卫的输入源，必须重证承重**：解析器改指向新表后，重新植入一个真实未登记调用方证明它仍会红。
8. **`cherry-pick <branch-tip>` 只取一个 commit**：本轮据此漏装了 NIT 车道 3 个 commit 中的 2 个，
   由"新测试文件不存在"暴露。多 commit 车道必须逐个列举。

### 一条反面证据（本轮 CI 唯一红，如实记录）
`test (20.x)` 曾红在 `multitable-oapi2a-ratelimit-realdb.test.ts`（限流审计断言）。四个信号定性为既有 flake：
本 PR diff 零碰该面、**`test (18.x)` 同一 real-DB 步骤跑绿**、失败断言靠**固定 `setTimeout(100)`**
等异步 `res.on('finish')` 审计落库（等"行出现"而非等 settled）、文件上次改动远在 #3365。
诊断如实贴入 PR 后重跑；**该既有测试的 settle 竞态已登记为观察项，本轮不越界修**。

## 3. 门审残余收口（#5020，本轮）

门审不是走过场：`#5018` 判 CLEAR 的同时留下 4 个 P3 + 5 个 NIT，其中 **P3-1 是阶梯 L0 的硬阻断**。
本轮把**全部工程侧残余**收掉（owner 侧两项如实留给 owner）。

### P3-1 census linkage（L0 阻断）——**两轮才真正闭合，第一轮我的声明被门审证伪**
旧 linkage 只查 tag 子串 ⇒ 腿可被掏空而 census 仍绿。**两个复现先在基线上跑通**（各自 EXIT 0、带一个死站点）：
`it.skip` 掏空 → `174 passed | 1 skipped`；`.only` 聚焦 → `156 passed | 19 skipped`。
修法：`WIRING_CENSUS` 抽到 `tests/unit/lib/recovery-census-table.ts`（静态 census 与运行时 recorder 共用**一份**表）；
`recovery-census-recorder.ts` 的 `censusFile(name)` 在**收集期**对未登记文件 fail-closed，并装一个文件级 `afterAll`
断言**实际执行**的站点集合**恰等于**该文件登记集合（少一个或多一个都红）；48 条腿各以 `record('<site>')` 收尾。
另加：机械 **focus/skip 禁令**（遍历 `it|test|describe|suite` 成员链、扫原始源码）、body-bounded 结构链接检查、
recorder 安装检查、以及"没有被链接的套件被排除出默认 vitest 运行"的检查。
**第一轮修后复现**：`it.skip` → **红且两个独立原因**（运行时钩子点名 `roles:update` 从未执行 + 禁令扫描）；
`.only` → 红，钩子点名全部 11 个被聚焦掉的站点。另做 13 站点 × 4 种变异形状回归。

**⚠️ 但第一轮并未闭合 L0——独立门审（绑 `f1d6433d06`）证伪了我"linkage now proves EXECUTION"的声明**，
造出两个反例让全家族在死站点下仍**绿（exit 0）**：
- `it.each([] as unknown[])` 于被标记的腿 + `record()` 下移一行（越过测试体 `})`，仍落在旧的 linkage 窗口内）
  ⇒ **零注册测试 ⇒ 连 skip 信号都没有**；
- `it.skipIf(true)` + `beforeEach` 里的 recorder。
根因：`auditCensusLegLinkage` 用"下一个 `it|test|describe|suite` **声明**"划定"自己的 body"，
于是钩子或 describe 体语句也算数；且禁令白名单放行 `each`/`skipIf`。
**门审判 CLEAR（0 P1/0 P2，与 #5018 对更易的祖先判 P3 保持标定一致），预授权的合并条件字面上已满足——
但本线拒绝按技术性 CLEAR 合入**：带一条被证伪的声明 + L0 未闭合合并，正是本线反复纠正的过强声明。
撤回**先行并传播到 PR 正文**（非仅评论），同时如实标注两条 lane 计数未经门审独立复测。

**第二轮真修**：`record()` 现在断言 `expect.getState().currentTestName` **携带该 site 自己的 tag**——
钩子、describe 体、邻居测试里的 record 都无法满足该站点;禁令同时覆盖括号写法 `it['skip']`。
**由我本人(非实现车道)在集成 head 重放 M7 验证**:精确报
`census.record("roles:update") … was not called from inside its own tagged leg … (current test: "<no test running>")`。

**第三轮:门审又找到第三个逃逸,并附一条比缺陷更值钱的方法学警告**。
逃逸 = **重复 tag 诱饵**:tag 不要求唯一,`findIndex` 取首个匹配、运行时绑定只问 `currentTestName` **包含** tag ⇒
在真腿前放一个同 tag 诱饵、真腿用 `it.each([])` 废掉、死支 `roles.ts:91` ⇒ **exit 0、205/205 与 pristine 相同**。
**警告**:同一探针打在 `roles:update` 上会**意外变红**(套件自己的两条负控硬编码了该 tag),而它正是本 PR 处处使用的示例站点
⇒ **后来的复核者用它重验会得出假的「已闭合」**。此条已入库为通用教训。
第三轮修法 = **强制 tag 唯一**;实现车道自曝其**第一版修法本身又是枚举陷阱**
(按 `DECL_RE` 行锚点计数,被 `[1].forEach(() => it(tag, …))` 破),自查后重做——枚举陷阱在修复内部复发的第二次实证。

**第四轮:门审再抓两个可修项 + 一个真写入,并把天花板讲清楚**
- **T1**:一个 `it()` 名字带**两个** tag,各自仍只出现一次 ⇒ 唯一性通过 → 绿(207/207)。已修:一个声明只能一个 tag。
  **但一刀切会误伤 pristine 合法用例**——`admin-users-routes.test.ts` 有一个声明确实带两个 tag,
  因为 `sendIfRecoveryAuthorityBusy` 内部**委派**给 `sendIfRecoveryConflict`,打那条路由会真实地同时执行两个站点。
  改用**手工审阅的封闭允许清单**只放行该组合,并以正控证明:没有该条目时它会对 pristine 声明报红。
- **T2 = 结构性天花板**:真腿被**同 tag 的空壳测试替换** ⇒ 全家族 **208/208 与 pristine 逐字节相同、零数值信号**。
  (第三轮的近似形状之所以红,只是**连带**——死支让 handler 改抛;空壳不触 handler,连带消失。)

**⚠️ 最终处置:L0 记为「收窄」而非「闭合」(不自证)**
四轮之后,**调用形状族与命名族的逃逸均已封死**(`it.skip` / `.only` / `it['skip']` / `it.each([])`+位移 `record()` /
`it.skipIf`+钩子 / `forEach` 包裹 / 重复 tag 诱饵 / 一名两 tag)。**未封死的有两个,第二个是天花板**:
1. **构造式 tag**(`` it(`${'[recovery-census:roles'}:delete] decoy`, …) ``)——没有任何源码文本扫描能收敛于构造名;
2. **(天花板)真腿被同 tag 空壳测试替换**——文本守卫只能证明「被标记的测试跑了」,**永远证不了「生产调用站点被到达」**。

**准确声明(经门审 NIT-1 收窄)**:*一条腿不执行就无法满足它的站点——对门审探过的每一种调用形状与命名形状成立;
手写替身(混淆 tag 或空壳)仍然可能,且在 diff 里肉眼可见。* 即**事故模式已封死、蓄意替换披露开放**。
越过天花板需要**另一种机制**:给适配器本身埋点,或在同一次运行中断言 src 调用行的 V8/Istanbul 覆盖率。
可行性草图存于车道证据,**本轮没有造、也没有偷偷塞进 PR**。
**这是否满足阶梯 L0 是 owner 的裁量**;L0 保持登记开放,合并该 PR **不**关闭它。

### 观察 kit 的五轮加固(门审逐轮攻破、逐轮重修)

kit 的安全声明只有一句:**这份 SQL 是只读的**。五轮门审证明这句话此前**并不成立**:

| 轮 | 门审打穿的方式 | 修法 |
|---|---|---|
| 1 | 静态 census 只看**语句头**:`WITH…DELETE`、`FOR UPDATE`、`pg_advisory_lock`、`SELECT…INTO`、`pg_terminate_backend` 全溜 | 加执行层(`default_transaction_read_only=on` 跑整份) |
| 2 | `stripLineComments` **不识别字符串** ⇒ `SELECT 'x -- y'; DELETE …` 把 DELETE **抹出审查输入**;`set_config` 可**解除执行层武装** | 字符串感知的字符级 tokenizer;**会话末只读不变量金丝雀** |
| 3 | `pg_ls_waldir`/`pg_ls_tmpdir`/`pg_stat_reset`(刚封名字的兄弟)全过;**有界**解除武装(off→写→on)让金丝雀沉默 | 默认拒绝的 `pg_*` 允许清单;`BEGIN READ ONLY` 包裹 |
| 4 | **`lo_create` / `lo_from_bytea` 是真写入且通过所有层**(在只读姿态下真的建出大对象 OID) | 默认拒绝**覆盖所有函数调用**(该文件全部调用仅 8 名) |
| 5 | **`.sql` 同时是 psql 脚本**:`\gexec` 链**真建出持久表**、`\!` **执行 shell 命令**,而 head census、body census 连"pristine 跑得干净"都保持绿 | 剥离注释后**禁止任何反斜杠**(位置无关、非枚举) |
| 6 | **`"…"` 标识符未建模** ⇒ `"x -- "` 里的 `--` 当注释起点,该行其后**从所有静态谓词被抹除**(含刚加的反斜杠禁令);`lo_create` 借此再次真写入(一次武装运行大对象 **0→21** 而全绿);另有第七种不可见标记 `<style>`/`<script>` | 镜像单引号分支建模 `"…"`(`stripComments` 与 `splitStatements` 同步);`<style>`/`<script>` 内容先剥离;**套件内残留断言**(跑前取基线、跑后比对,测不出=失败) |

**第六轮那条最锋利的批评是打"零残留"这个说法本身**:它从来不是测试,而是我**手工跑完自己看一眼**。门审的形状能留下 21 个大对象而套件全绿——手检会读到非零却无人点名根因。现已改为**套件内断言**,并**注入一次真实泄漏证明它会红**。
教训与「被触发≠被验证」同族:**"我检查过"不是守卫,"套件会红"才是**。

**第五轮还暴露了一个方法学问题(值得单独记)**:两条实现车道因**会话额度**中途夭折,我在主循环接手时**选择重新验证而非信任**——因此抓到车道的谓词 `/^[ \t]*\\/` **只管行首**,而 `\gexec` 的标准写法是**跟在 SELECT 同行的行尾**。真库实证:该行 psql exit 0 且表被建出,行首规则从不触发。
**更阴的是**:我第一次用该探针打车道修法时**整体是红的**,但红的是两条无关正控,元命令测试本身**通过**——只看 exit code 就会误判"已修好"。这与「验证站点被自己的负控污染」是同一族陷阱:**红了 ≠ 红对了原因**。

同轮还做了一个**明说的加严**:字符串字面量内的反斜杠也拒。psql 会当数据,但这个 tokenizer 是手写的——"我们以为是字符串、psql 不这么认为"正是 E-string 那次咬到我们的类别;pristine 文件里字符串内零反斜杠,故今天零成本。

### P3-2 SQL 只读守卫（L4 阻断）
语句头 census 漏掉 `WITH … DELETE/UPDATE`、`FOR UPDATE`、`pg_advisory_lock`、`SELECT … INTO`、`pg_terminate_backend`。
修法**两层**：更强的静态 census + **执行层**（整份 SQL 在 `default_transaction_read_only = on` 会话中跑）。
六种绕过形状逐一真植入，**逐形状标注是哪一层抓到**——含诚实的一例：`pg_advisory_lock` 在只读事务中**不会**被拒
（会话级锁非数据写），执行层实测 exit 0，因此该形状由静态 census 承重，测试对此显式断言而非假装两层都拦。
守卫自身 5 次变异，各自只红对应的测试。

### P3-3 OWNER-GATED 扫描（L4 阻断）
verb 表过窄（`curl` / `psql … ALTER TABLE` / `aws` 在外）且块作用域松（编号列表与围栏块会并入前一个已标记段落）。
**缺陷先复现**：三处植入攻击下，旧的 16 个测试**全绿**。修法：逐次出现的 verb 扫描（严格超集，不弱化任何既有项）
+ 结构化块模型（围栏/列表项/标题/表行/引用/段落；围栏外空行终止块）。修后三处攻击各自变红。
**runbook 与 main 逐字节相同**——错的自始至终只是扫描器。

### P3-4 register-null 路由半边
`#5018` 只在 `routes/auth.ts` 留了 8 行注释断言，全仓零测试钉住（注释断言≠不变量）。
现双向钉死：`register() === null` → 精确 409 body；非 duplicate 抛出 → 既有通用 500
（防止 A3 的行为变更被悄悄回退成旧的"谎报 409"）。

### NIT 清扫
- **NIT-1**：obs-kit 的 path filter 现机械覆盖 runbook 引用的每一条路径。
- **NIT-3（真缺陷）**：`isDuplicateIdentityConflict` 曾用裸 `instanceof` ⇒ **跨 realm 的孪生错误**（携带同样 `.code`）
  能击穿它。改为按 `.code` 鸭子判定；还原裸 instanceof 恰红那条跨 realm 腿。
- **NIT-5**：闭世界分母检查——独立文件系统扫描必须与登记表**逐文件逐 token**相等，带 13 文件/48 站点**下限**
  （下限非精确钉，使正常增长无摩擦落地，而扫描器/解析器塌缩或 census 缩水即红）。
- **NIT-2 / NIT-4 属 owner 侧，本轮如实不做**：把 kit 设为 required check（分支保护）、
  以及阶梯锁文件头仍写 `Status: PROPOSED`（owner 已用 #5014 的 `RATIFY 642b765a96` 评论批准；
  头部翻转是一行 ledger-sync PR，属 owner 决定）。

### 集成期自查抓到的耦合（CI 抓不到的那类）
P3-1 抽表后，NIT-5 的解析器仍读旧文件 ⇒ **5 红**。这是在**丢弃分支上试合**时发现的（carrier 尚未构建），
修法是把解析器指向表的新家，并**重证承重**：植入一个真实未登记调用方 → 精确报 `UNREGISTERED caller` 并红；
移除 → 恢复绿。
**同期还抓到一次自己的漏装**：`git cherry-pick <branch-tip>` 只取了 NIT 车道的尖端 1 个 commit，
另两个（NIT-3 / NIT-5）没进来——由"新测试文件不存在"暴露，补齐后 5 commit 齐全。

### CI：观察 kit 的执行层从"没跑过"变为承重（被触发≠被验证）
kit 交付了两层只读守卫，但 CI 里**只有第一层真的跑过**——workflow 是 hermetic 的，执行层永远走 loud-skip。
新增 `execution-proof` job（postgres:16 + 真迁移，武装 `METASHEET_REAL_DB_TEST_STEP=1`，
使该车道缺 `DATABASE_URL` 时**红**而非静默跳过）。本地端到端复现：武装+已迁移 **38/38 零跳**；
武装但无 URL → sentinel 红；hermetic → 31 + 1 loud skip；
**承重证明**：往 SQL 植入 `SELECT … FOR UPDATE` → 4 红，还原字节一致 → 38/38 复绿。

## 3.9 收口:门审在本 PR 上做了 9 次绑定,以下是准确的账

**门审在 #5020 上做了 9 次 exact-head 绑定**(另加 #5014 两轮、#5018 一轮)——
`f1d6433d06` → `a235fcd6c2` → `1c2d6f64e2` → `4dc4713613` → `dd65fe75a8` → `47b91c7350` →
`39c2e61fcc` → `aae37bb37b` → `078eba6c10`。**每一次我都没有用"结论转移"代替重新绑定**,
包括最后那次只改了一行正则的。经它核定的 ledger——给推导,不给圆整数:

> **约 34 种不同形状,4 次真写入(横跨 3 条不同通道),1 次 shell 执行。**
> 通道:(i) 大对象 API 不受 `default_transaction_read_only` 阻挡(`lo_create`/`lo_from_bytea`,R3);
> (ii) psql 元命令(`\gexec` 建出持久表,R4);(iii) 词法器擦除**重新打开**通道 (i)(双引号标识符 `--`,R5)。
> shell 执行:`\!`(R4)。其余约 29 种是 census/linkage 逃逸、被层 2 抓到的静态绕过、以及不可见标记形式。

两条值得留在记录里的判断(门审原话方向):
1. **每一条写入通道,都是在我已经宣称"这轮做完了"之后才被找出来的**;
2. **每一条都是被一个"性质"关掉的,不是被清单上又一个名字关掉的**。

### 我自己被抓的每一次(与缺陷同等重要,故逐条列出而不给总数)
| # | 我做错了什么 | 怎么暴露的 |
|---|---|---|
| 1 | 声明「linkage now proves EXECUTION」 | 门审造出两个反例,声明被**证伪**;撤回并传播到 PR 正文 |
| 2 | 残留检查是**我手工跑完看一眼**,不是测试 | 门审的形状留下 21 个大对象而套件全绿 ⇒ 改为套件内断言并注入泄漏证明会红 |
| 3 | 加宽残留指纹时**删掉了唯一的绝对腿** | 门审植入"跑前就存在的残留",四次运行全绿 ⇒ 补回绝对腿 |
| 4 | ledger 写成「9 个逃逸、2 次真写入」 | 门审按自己的账核定为 **~34 形状 / 4 次真写入 / 1 次 shell 执行** |
| 5 | 给多行 HTML 标签残留标了「未确认可达」 | 门审**确认可达**——我用限定词软化了一个真实洞 |
| 6 | 把 PG15 的行为钉成普适事实 | 我自己的 CI job 在 postgres:16 上红(门审当时也没看见——它全程单版本) |
| 7 | 版本容忍分支接受裸的 `permission denied` | 门审指出基础设施错误会冒充"服务器保护了我们" |

另有一次**设计救了我自己**:加宽指纹时我第一版查询是无效 SQL(`relkind` 是 `"char"`,`||` 有歧义),
`scalar()` 返回 null——因为我把"测不出来"设计成**失败而非通过**,干净运行直接变红,
而不是变成一条永远绿的空转断言。**fail-toward-flagging 不是文风,它刚刚抓住了它自己的作者。**

### 最终残留(三类,如实分层)
1. **天花板类(census/L0)**:T2 空壳替换、构造式 tag、`CLASSIFIER_MODULE` 迁移。
   文本守卫无法证明 src 站点可达性;越过需要给适配器埋点或读覆盖率——**未造,也未偷偷塞进 PR**。
2. **不可见标记类**(门审建议**披露而非追**):它在第 2–6 轮**每轮长出新兄弟**(HTML 注释→多行标签→
   未闭合注释→fence info string→链接 title→`<style>`/`<script>`→链接目标/`<template>`)。
   它**不是执行通道**(runbook 自身不执行任何东西,管的是人的授权标注),且收敛修法需要真正的
   CommonMark 渲染,这条 hermetic 车道按设计装不了依赖。**登记为一个类别,带轮次历史。**
3. **owner 侧**:obs-kit 未设为 required check(⇒ 连新加的残留断言在合并时也只是建议性)、
   阶梯锁文件头仍写 PROPOSED、relay 评论的 provenance。

## 3.10 三条关于「审阅者本身」与版本盲点的记录

**(a) 门审自曝了自己方法的盲点。** 它在 `39c2e61fcc` 判 CLEAR 时**只在 PostgreSQL 15.17 上量过**;
而同一个 head 在 CI 的 **postgres:16** 上是**红的**——两条断言把「`lo_create`/`lo_from_bytea` 不被只读模式阻挡」
这个 PG15 事实钉成了普适事实。它的门审全程单版本,所以这条版本相关性**对它的方法不可见**。
用它自己的话:这是「运行器≠生产版本」应用在**审阅者**身上,也正是"拒绝在陈旧 head 上合并"的具体价值。
修法不是选一个版本站队,而是只断言**版本无关**的两件事:①静态 census 必须抓到(任何版本上它才是真守卫);
②**若**服务器确实拒绝,那必须是**真的**只读/权限拒绝,不能让无关失败冒充保护。

**(b) 同一个坑的两个方向都出现过。** 记忆里那条教训原本是"运行器版本差异会造成**空转的绿**";
这次它造成的是**冤枉的红**。两个方向都要防——判据要绑**不变的性质**,不要绑**某台机器上的观察**。

**(c) 最后一条被抓的假接受(我的):** 版本容忍分支里我写了裸的 `permission denied`,
于是 `psql: error: could not open file …: Permission denied` 与 `EACCES: permission denied`
会被当成"服务器保护了我们"——「不是错误X≠结果断言」。现锚定到 PostgreSQL 自己的 `ERROR:` 措辞,
并逐条验证接受集(三种真实拒绝)与拒绝集(两种基础设施错误、两种无关 ERROR、连接失败、**空 stderr**)。

## 4. 门审记录
| 轮 | 对象 | 结果 |
|---|---|---|
| #4654 终门 | exact-anchor closeout | CLEAR（142/142 + 6 变异 + foreign-fence 无新死锁） |
| SSH tier-1 | #5015 前半 | GO（0 P1/P2/P3） |
| #5014 R1 | O-2 carrier `5b7a0edc89` | **CHANGES-REQUIRED**（1 P2：分类器套件单点接线，no-DB lane collect-skip-green） |
| #5014 R2 | 修复后 `ef733899dc` | CLEAR（delta 纯 append、零 src 改动 ⇒ R1 结论转移） |
| #5018 | A 层 `1721b45e98` | CLEAR 0P1/0P2/4P3/5NIT（独立重放 48/48 双射红；5 个 P2 候选自提自否） |

## 5. 当前姿态与主机证据

| 项 | 值 |
|---|---|
| main | 见 §6 落地 SHA |
| `RECONSTRUCTION_CAUSALITY_LANDED` | `true` |
| 四 flag | `.env.example` / `docker-compose.app.yml` / `docker/app.staging.env.example` **零出现** |
| triggers | 9/9 DISABLED（fp `8c1be0b0…`），functions 6/6（fp `14c180aa…`），`meta_links` FK 0/0 |
| 主机证据 | prod `31650980676` PASS、双主机 `31651250987` PASS、staging 部署 `31651154126` |

**⚠️ 证据时效（必须如实记录）**：上述主机证据取于 **2026-08-12、绑镜像 `12f1f8c466`**。此后生产已随
main 前进多次自动部署。核实：`12f1f8c466..main` 新增 8 条迁移**全部属他线**（考勤 W7 ×4、审批 ×4），
**零条触碰 recovery schema / trigger DDL**；四 flag 在 compose/env 仍零出现。
⇒ 姿态**推定**未变，但**证据对当前镜像已过期**：阶梯 L0 的"目标主机 postdeploy-full PASS（当前镜像）"
**必须重跑一次**才成立。该动作触主机，属 owner 授权范围。

## 6. 剩余（**非本记录的开发范围**）

**A. 阶梯执行（owner + ops，日历为瓶颈）**
L0 重跑 postdeploy-full（当前镜像）→ L1 staging ENABLE triggers（观察 ≥2 日历日）→ L2 → L3 →
L4/L5 canary → L6 soak ≥7 日历日 → L7+ 生产重放。每级独立 owner 授权。

**B. 后续独立能力（需先立设计锁）**
- Phase D：retention 后不可变归档 + 完整性校验 + 大批量异步恢复 + 进度/重试 UI（`v3.7 §12` 估 8–12 人周）
- 完整 T-state 浏览：服务端 `/point-in-time` 一处路由级改动，但**前端全仓零消费者**（整条读路径从零）；
  `#4205` 设计锁不在 main，需先 ratify
- 删除记录精确复活：需先建 at-anchor **inbound** authority（`#4446` 参考件在手，`multitable-4446-resurrect-reference-design-20260812.md`）
- 跨 sheet 原子恢复（无设计）
- foreign-fence 共享查找表残余（可用性非死锁，pre-existing；根治需围栏全部 link-in sheet 或弱化记录锁）
- SSH on-prem 残余：`dingtalk-onprem-docker-gc.sh`（2 站点）、`install-dingtalk-onprem-docker-gc.sh`（1 站点）、
  `scripts/phase5-deploy-prometheus-rules.sh`（任意 host + 直接 scp + 仅告警）= **已登记未解决**，独立治理

## 7. 安全边界重申
flags 全 default-OFF · triggers 出厂 DISABLED · 无 flag 翻转 / 无 trigger 启用 / 无主机姿态变更 /
无 auto-merge。阶梯每一级、Phase D 的立项，均为独立 owner 决策。

## 8. 落地台账（exact SHA）

| PR | 内容 | 合并 SHA |
|---|---|---|
| #5014 | O-2 加固 S1/S2/S3 + 启用阶梯 S4（PROPOSED→owner RATIFIED） | `642b765a96` |
| #5013 | runLocal fakeHome 清理（NIT） | `8308495f47` |
| #5015 | SSH host-key pin 全家族（tier1 + tier2；contract check 设为第 10 条 required） | `543f367670` |
| #5018 | O-2 A 层：census 可达性、clamp 负例、register-null、演练/观察工装 | `48134a16a4` |
| #5020 | 门审残余收口：linkage 执行绑定、SQL/runbook 守卫硬化、闭世界分母、CI 执行层证明 | `401fa1d880` |

前序（本记录的基线）：#4654 `12f1f8c466`（closeout，inert 落地）、#4885 `b4492c3047`、#4887 `0a5f319059`。

## 9. 交给 owner 的三件事（本记录不代为决定）

1. **阶梯 L0 的天花板裁量**——census linkage 的事故模式已封死，蓄意替换（T2 空壳、构造式 tag、
   `CLASSIFIER_MODULE` 迁移）**封不死**，越过需要给源码埋点或读覆盖率。**是否满足 L0 由 owner 裁**；
   本记录只把边界写清楚，不自证。
2. **obs-kit 是否设为 required check**——目前不是，因此其**全部**执行层证据（含新加的残留断言）
   在合并时**只是建议性**的。
3. **阶梯锁文件头 `Status: PROPOSED` 的 ledger-sync**——owner 已用 #5014 的 `RATIFY 642b765a96`
   评论批准，文件头未同步（一行 docs PR）。

## 10. 一条必须随记录一起保存的限制

**门审全程单版本(PostgreSQL 15.17)。** 它在 `39c2e61fcc` 判 CLEAR 时未察觉两条断言把 PG15 行为钉成普适事实，
而同一 head 在 CI 的 postgres:16 上是红的。最终那次跨版本检查是**消息形状推理**，不是在 PG16 上执行——
**该半边的证据是 CI 上 `postgres:16` 的 `execution-proof` job 转绿**。
若要彻底消除版本/语言依赖，收敛做法是匹配 **SQLSTATE**（`25006` 只读、`42501` 权限不足）配
`PGOPTIONS=-c lc_messages=C`；本轮未做，已登记。
