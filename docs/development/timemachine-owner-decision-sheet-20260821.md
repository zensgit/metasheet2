# Time Machine — owner 决策清单(2026-08-21)

> ⚠️ **2026-08-21 修正(owner 复审后)**:本清单初版把 **B1「A1 前置已满足」写错了**——已**撤回**。
> owner 复审在承重工具(L1 电池)上构造出**两个真缺陷**:P1 远端管理员凭据在 cancel/超时/失败时
> 可能遗留在部署主机 `/tmp`;P2 posture 校验只查 trigger 名+tgenabled,**同名 trigger 在错表仍 9/9 ARMED**
> (假 ARMED,静默作废下游全部 409 证据)。**结论:A1 暂不可 ratify,电池暂不可 dispatch**,须先 fix-forward
> (凭据生命周期 → canonical posture 校验 → 变异测试 → 独立复门 → owner 授权 staging 实跑 → PASS 后再 ratify)。
> 下文 B1 段已按此改写。
>
> **2026-08-21 二次更新(fix-forward 已落地)**:两缺陷已修 + 过独立复门(APPROVE @ `ceb0f08def`,#5069);
> **B1 的代码侧前置:五轮复审后已全部闭合**(2026-08-21)。电池 workflow 凭据(#5069/#5076)、search_path 根修(F3,#5081)、context/台账(#5077)、建号脚本(F1:重写 #5080 + 提权修复 #5084 `162679992e`,含 login-first + 收敛行为 golden)、F5 readiness、五轮文案收窄——**均已落 main 且过独立复门(运行时代码 APPROVE,无 P1/P2)**。P3-INFO-1 已查证满足。**F2(设 required)、F4(旧 PR 处置)截至 2026-08-24 复核均已完成(见 §D2);剩余是 owner/ops:F3 主机证据、建号/电池实跑、~~staging pending≠0~~、A1 ratify——见下。** 原写「staging pending≠0(据 #5094 / `staging-migration-backlog-disposition-20260822.md`,本轮未取得比该报告更新的证据)」,**已更正(见下「五次更新」)**:该窗口已于 2026-08-24T05:44–05:54Z 执行完毕,staging **`Applied: 337 / Pending: 0`**(`run 32694623829` real-apply 段 + `run 32694880864` + 确认跑 `run 32695040817`),此项**不再是剩余项**。剩余 owner/ops 为三项:F3 双主机新指纹证据、建号 + 电池实跑 PASS、A1 ratify。
> 剩余 A1-ratify 前提**纯 owner/ops**:owner 授权 staging 电池实跑 → PASS → 再 ratify。secrets 已设、主机建号脚本已备。
>
> **2026-08-24 三次更新(fix-forward 复核,针对 #5130 之后又飘的表述)**:B1a 两处自伤均已随 #5125
> (`7067b49516`)处置——A1.3 证据绑定已落地;生产继承条款是被**收窄出 A1 范围**,不是被"修复"。
> #5128(`e9944cbfed8`)已 MERGED,census 分母缺口与 `details.retryable` 钉点引用均已更新(见 §D2-F7/F9)。
> F4 七个旧 PR 已全部处置(5 关闭 + 2 owner 明文 PARKED,不是"全 OPEN",见 §D2-F4)。
> **本轮新增两条 owner 待办**:ratified 阶梯 L2 判据的可产出性(新增 §D2-F10)、role-cascade witness
> PR #5131 held Draft(见 §B1a)。下方各节据此更新;历史记录原样保留,不做回溯改写。
>
> **2026-08-24 四次更新(#5131 已合并;本轮为同一失效类的第二次自实例——不是"头指针漂移",是"状态
> 在提交落地 6 分钟后翻转")**:上一条(三次更新,commit `57129e0b57`,12:09:47+08)把 role-cascade
> witness PR #5131 钉成 head `1d8f0708de`、状态 OPEN/Draft、main 仍是修复前的窄谓词——这些在落笔
> 时刻均为真(经 CI job 日志与 `gh pr view` 核实)。**但 #5131 在该提交落地后仅 6 分钟(12:15:34+08,
> 合并提交 `771cd9be20`)即被合并**,使同一批断言当场失效:#5131 现 **MERGED**(非 Draft/OPEN),宽
> 谓词与三个见证文件现已落 `origin/main`(合并提交 `771cd9be20` 是当前 `origin/main` 的**祖先**——此处刻意不镜像 main 的 tip:tip 是热的,本文档已因追它而两次过期),armed
> real-DB golden 在 main 上以 push 事件重跑仍是 **59/59、0 fail、0 skip**(`run 32689331718` /
> `job 97320045961`,与 #5131 分支上的原始执行 `run 32682499617` / `job 97301471543` 并存,不互相
> 替代——前者证"合并后 main 上仍执行",后者证"该 head 上曾执行",两者回答不同问题)。下方每处受影响
> 陈述均以「原写『…』」标出并保留原文,不做回溯改写——这正是本清单存在的理由本身,在同一份文档、
> 同一轮修复内又发生了一次。head 钉点 `1d8f0708de` 本身不变(真 merge,非 squash,分支尖端未再动),
> 仅**状态与位置**类断言(Draft/OPEN、"尚未落 main"、main 上谓词宽窄)过期。
>
> **2026-08-24 五次更新(staging 迁移窗口已执行 —— `pending = 0`;本轮更正的是本清单存续最久的一条
> 过期断言)**:2026-08-24T05:44–05:54Z,`Attendance Staging Window Runner`(head
> `c345c6b405eebe5d9299e2a89d452c907f1aab6b`)在同一窗口内跑完 **备份 → 克隆彩排 → 真实应用 → 重部署 →
> 确认**,staging 从 `Applied: 321 / Pending: 16` 变为 **`Applied: 337 / Pending: 0`**:
> `run 32694623829`(`migrate`,success)real-apply 段 05:47:48Z `321/16` → 05:47:53Z `337/0`,
> 05:47:54Z `[window-runner] apply OK: staging migrate ended at pending=0`;
> `run 32694880864`(`deploy`,success)05:49:45Z `337/0` + `[staging-migration-alignment-report]
> decision=aligned`,05:49:49Z `[window-runner] deploy OK: c345c6b405…`;
> `run 32695040817`(`migrate` 确认跑,success)四处观测均 `337/0`。
> **由此:L0 的 `staging pending migrations = 0` 前置已满足**,§A / §A-2 / §B1 / §E 下方相应断言逐处更正。
> 实际应用 **16** 条(以 run log 为准),是 `staging-migration-backlog-disposition-20260822.md` 所析七条的真超集。
> **同一窗口的 `deploy` 跑也解除了 §A-2 的镜像前置**(见该节更正)。
> 完整证据与三条程序勘误(CHECK 预检判据过窄 / 锁窗口按整批而非按迁移 / 预检二照抄会 `42703`)
> 见新增文档 **`staging-migration-window-completion-20260824.md`**。
> 历史记录原样保留,逐处以「原写『…』」标注,不做回溯改写。

> 一页看全:O-2 启用加固线(F1–F6、X2、census 覆盖)与阶梯加速修正案 A1 的**代码侧修复均已落 main 并过独立复门**;role-cascade witness 的判据修复**已随 #5131 合并落 main**(合并提交 `771cd9be20`,2026-08-24T12:15:34+08,见 §B1a)——armed real-DB golden 在 main 上实测 **59/59、0 fail、0 skip**(`run 32689331718`/`job 97320045961`)。原写「role-cascade witness 的判据修复目前落在 open PR #5131(Draft,head `1d8f0708de`)上——CI 已把其 real-DB golden 接进执行车道并实测通过(59/59),但分支尚未合并,main 上电池实跑用的仍是修复前的窄谓词」,已更正(见上「四次更新」):"尚未合并"/"main 上仍是窄谓词" 两个分句在本文档 12:09:47 提交落地后 6 分钟即失效;`59/59` 本身在原句中即真,继续成立。**另:staging 迁移积压已于 2026-08-24T05:44–05:54Z 应用完毕,`pending = 0`(见上「五次更新」与 `staging-migration-window-completion-20260824.md`)——L0 该项前置已满足。** 原写「本清单自身也是 open PR #5135,尚未合并」——#5135 已于 2026-08-24T07:53:28Z 合并为 `96b6416717`,该句随之移除。下面除已注明的开发缺口外都是**只有 owner 能拍的板**。
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

**A1 · 把 #5039 便笺转给审批线补迁移积压 —— ✅ 已完成(2026-08-24 窗口已执行,`pending = 0`)**
- 决策:让审批线按便笺(`staging-approval-migrations-disposition-20260820.md`)在克隆上彩排后应用审批迁移。
- **状态:已执行完毕。** 2026-08-24T05:44–05:54Z,`Attendance Staging Window Runner`
  (head `c345c6b405eebe5d9299e2a89d452c907f1aab6b`)按 runbook 走完 备份 → 克隆彩排 → 真实应用:
  `run 32694623829`(success)real-apply 段 05:47:48Z `Applied: 321 / Pending: 16` → 05:47:53Z
  **`Applied: 337 / Pending: 0`**,05:47:54Z `[window-runner] apply OK: staging migrate ended at pending=0`;
  同窗口 `run 32694880864`(`deploy`,success)05:49:45Z 复读 `337/0` 且对齐报告
  `decision=aligned`;`run 32695040817`(确认跑,success)四处观测均 `337/0`。
  实际应用 **16** 条(非便笺当时的 4 条,亦非 #5094 估的 ≥10;以 run log 为准),
  为 `staging-migration-backlog-disposition-20260822.md` 所析七条的真超集。
  证据与三条程序勘误见 `staging-migration-window-completion-20260824.md`。
- 原写「我的建议:做。这是 L0 唯一未勾项(`staging pending migrations ≠ 0`),也是整条阶梯的
  真瓶颈——L1 卡在它上。」,**已更正**:该项**已完成**,既不再是未勾项,也不再是瓶颈。
- **后果(已兑现)**:staging `pending=0`,L0 的该条前置满足。
  按冻结的阶梯 §1,L0 清单上仍开着的是 **owner/ops 项**,不是本项:
  ① §1 第五条的另一半——在目标主机跑一次**回滚后 `postdeploy-full`** 验证回到 inert 姿态
  (owner-gated,本地演练不覆盖,另见 §E 末);② §1 第四条附带的 owner 天花板裁量(即 §C 的 C1);
  ③ §1 第二条的 containment PASS **在冻结的阶梯 §1 上勾为 `[x]`**;但本清单 §D2-F3 与文首记其为
  **pre-fix 点内**观测(`run 32321464042`,2026-08-20),新指纹 `e4a78f6c…` 的双主机证据仍待取
  (见 §D2-F3、§E 第 6 步)。**此处报的是本清单的记载,不代阶梯改勾**——该勾选项属阶梯文档,冻结,不由本文改动。
- **剩余的 owner/ops 关键路径**(本清单不代拍板,以下各项均已在下文列明,此处只指向、不新增):
  **双主机 `postdeploy-full` 取 F3 新指纹证据(`e4a78f6c…`)→ 建号 → L1 电池实跑 → A1 ratify**
  (依次见 §D2-F3 / §E 第 6–7 步、§E 第 7 步、§B1 与 §E 第 9 步、§B1 与 §E 第 10 步)。
- 归属:审批线执行 + owner 批准(已按此完成);**Time Machine 线不代应用**(runbook 要求克隆彩排——本次确已先彩排后应用)。

## A-2 · staging 重部署 —— 原计划缺失的硬前置(2026-08-22 深审发现;**已于 2026-08-24 解除,见节内更正**)

原写(2026-08-22 时点,现已过期):staging 当时镜像(`401fa1d880`,或 08-21 那次失败尝试的 `5e9a15f02e`)**不含**:

- **电池脚本** `scripts/ops/multitable-l1-battery.mjs`(该树里根本没有此文件)⇒ 电池 dispatch 会 `MODULE_NOT_FOUND`
- **任何 `zzzz20260821*` 迁移**(含 F3 的 search_path 修复)⇒ 窗口 runner 无从应用 F3
- **匹配的 containment helper**:该镜像里的 helper sha 与 workflow 钉的 `c52501a9…` 不等 ⇒ postdeploy-full 的 **staging 腿会在 helper-sha 检查处以「被篡改」措辞直接失败**,根本到不了数据库观测

原写「**因此:第 6/7/9 步(取证 / 建号 / 电池)在 staging 重部署到 ≥ `d3289945e1` 之前全部不可执行**,且失败形式具误导性(像是安全告警而非"镜像太旧")。`Dockerfile.backend` 的 `COPY scripts` 保证重部署即全部修复。」,**已更正(见下)**。

> **2026-08-24 五次更新:本节所记的镜像前置已解除,上面三条 bullet 的前提均不再成立**(原文按惯例
> 原样保留,不做回溯改写)。同一迁移窗口内的 `run 32694880864`(`deploy`,success,
> 2026-08-24T05:49Z)把 staging 重部署到 **`c345c6b405eebe5d9299e2a89d452c907f1aab6b`**
> (日志:`Container metasheet-staging-backend Recreated` / `Container metasheet-staging-web Started`
> / `[window-runner] auth round-trip OK (me=200, settings=200)` /
> `[window-runner] deploy OK: c345c6b405…`)。逐条核实:
> - **`≥ d3289945e1`**:`gh api repos/zensgit/metasheet2/compare/d3289945e1...c345c6b405` 返回
>   `status=ahead, ahead_by=63, behind_by=0` ⇒ `d3289945e1` 是 `c345c6b405` 的祖先,条件满足。
> - **电池脚本**:`scripts/ops/multitable-l1-battery.mjs` 在 `c345c6b405` 上**存在**
>   (`git cat-file -e` 通过)⇒ 不再会 `MODULE_NOT_FOUND`。
> - **`zzzz20260821*` 迁移(含 F3)**:
>   `zzzz20260821120000_recovery_authority_functions_fix_search_path` 在 `c345c6b405` 上**存在**,
>   且**已实际应用**到 staging(在本窗口所应用的 16 条之内,见 §A)。
> - **containment helper sha**:`scripts/ops/multitable-recovery-schema-containment.mjs` 在
>   `c345c6b405` 上的 sha256 为
>   `c52501a9ff2edd1d91ec07b5e7ebe9d90b3242867031dec4dededa7e1d64060d`,与
>   `multitable-recovery-flag-containment-check.yml:173` 钉的 `SCHEMA_HELPER_SHA256` **逐字节相等**
>   ⇒ postdeploy-full 的 staging 腿不会再在 helper-sha 检查处以「被篡改」措辞失败。
>
> **即:第 6/7/9 步的这一层镜像前置已满足。** 但**这三步本身是否可以执行,仍是 owner/ops 的裁量**,
> 且各自另有前置(第 6 步取证本身即 F3 待补项,第 9 步须先经第 8 步 arm 9/9)——本节只更正
> 「镜像太旧」这一层,不改变、不预判 §B1 与 §E 所记的其余门。

## D2-F7 · X2 · `config-restore-execute` 的一条 unmapped-500 路径 —— ✅ 已修复(#5114),测试覆盖已随 #5128 落 main

`applyPermissionDeEscalation`(`src/routes/univer-meta.ts:6780`)写 `field_permissions` / `spreadsheet_permissions`——**两表的触发器在 L1 起都会 armed**。其唯一调用点在 `POST /sheets/:sheetId/config-restore-execute` 内。

- **原缺陷**:该路由的外层 catch 曾只认 `SheetWriterBlockedError` / `TombstoneCaptureCapExceededError` / `DB_NOT_READY`,不查 `isRecoveryAuthorityBusyError` ⇒ 40001 落到 `500 INTERNAL`。
- **已修复**:**#5114**(`da556a4f33`,2026-08-22 落 main)在该 catch 补上 `if (isRecoveryAuthorityBusyError(err)) return sendRecoveryAuthorityBusy(res)`,现位于 `src/routes/univer-meta.ts:9291`,映射方式与同文件其余 4 处调用点(现共 5 个调用点)一致。
- **为何 L1 期原本不发作**:独占租约此时只有电池持有,且其主体全是 `o2bat_` 合成对象。
- **L4+ 本会激活**:真实主体的租约一旦存在,击中即产生 unmapped 500——直接违反 L6 的「零 unmapped」判据;已在 L4 前修复,不再是阻断项。
- **遗留缺口(#5114 自陈,已随 #5128 补齐)**:修复落地时 `routes/univer-meta.ts` 从未进入 recovery-conflict census 分母(`tests/unit/lib/recovery-census-table.ts` 对该文件零登记)——即这行修复本身没有任何机械测试锚定。已实测复现(2026-08-23,#5128 落 main 前):在当时 main 上删掉 #5114 那一行,`tsc --noEmit` 仍 clean,`test:unit` 全量(544 files / 8420 tests)仍**全绿**;复现后已把改动还原为 byte-identical。**PR #5128 已 MERGED(`e9944cbfed8bcd0bdb4dd69ff3e076426a1a541f`,2026-08-23)**,把 `routes/univer-meta.ts`(5 个站点)与 `auth/AuthService.ts`(2 个站点)一并纳入 census 分母;已核实 `tests/unit/lib/recovery-census-table.ts` 现登记这两个文件,新增文件 `packages/core-backend/tests/unit/recovery-conflict-surfaces-routes-univer-meta.test.ts` 存在且含 5 处 `toEqual(UNIFORM_409_BODY)`。**未重新执行**上面同一条删行 mutation 来确认它现在会被拦红——上面的"全绿"结果是 #5128 落 main **前**的实测,本节只核实了 #5128 落地的静态事实,没有重跑 mutation。
- **处置**:代码修复已完成,不再是 L4 前的阻断项;#5128 已 MERGED,census 覆盖缺口在分母/新增测试文件层面已补齐(均已核实存在)。合并前那种"仅靠人工审查兜底"的窗口已经关闭。

## D2-F8 · L1 电池 driven-surface 是否扩至 univer-meta 五路由(owner 裁量,不代拍板)

**背景**(#5128,已 MERGED `e9944cbfed8`,分母修正引出):该 PR 把 `routes/univer-meta.ts`(5 个站点)与
`auth/AuthService.ts`(2 个站点)纳入 recovery-conflict census 分母,population 由 **13 files/48 sites**
升至 **15 files/55 sites**。新增的 7 个站点里,5 个 univer-meta 站点(`sheet-permissions-put` /
`field-permissions-put` / `config-restore-execute` / `record-permissions-put` /
`record-permissions-delete`)登记进电池脚本的 `NOT_DRIVEN_SITES`,理由一律是 **`orthogonal-fixture-cost`**,
且注释明文**不是**按不可达豁免——univer-meta 写入的三张表(`spreadsheet_permissions` /
`field_permissions` / `record_permissions`)**都**挂 recovery-authority 触发器(见下方触发器机制)。
(另外 2 个新增站点属于 `auth/AuthService.ts`:`auth-service:self-service-backfill` 同样是
`orthogonal-fixture-cost`;`auth-service:register-user-roles` 的登记理由是 `unknowable-lease-key`,与
univer-meta 五站点不同类,不在本项讨论范围。)

**owner 需要拍的问题**:电池是否应该扩面去**驱动**(drive)这五个 univer-meta 路由?驱动集合是电池
PASS 实际担保的范围,而这个集合被 RATIFIED 的 enablement-ladder 文档引用——扩大它会改变 L1 门的含义,
是 owner 幅度的判断,不是机械编辑。成本侧是 fixture 工程:电池目前搭的是 users/roles/permissions 类
fixture,不是带 sheets/fields/records 的 univer 表格,外加每次改动后要重跑电池自身的 head-scoped
对抗门审。

**两个与判断相关的既有事实(均已核实,不代表建议)**:

- **(a) required 车道 `test (20.x)` 已经在真实 HTTP 层驱动了五个路由中的 3 个**,在真实持有的租约下产生
  真实触发器抛出的 40001:`multitable-exact-anchor-route-wiring-realdb.test.ts` 的
  `AUTHORITY-HTTP-RETRY`(~1311 行)并发调用 `PUT .../permissions/user/:userId`(sheet-permissions-put)、
  `PUT .../field-permissions/:fieldId/user/:userId`(field-permissions-put)、
  `PUT .../records/:recordId/permissions`(record-permissions-put)三个路由,在持锁期间断言三者均返回
  409 `{code:'RECOVERY_AUTHORITY_BUSY', message:'Recovery is stabilizing permissions; retry this change.'}`。
  同文件的 `AUTHORITY-SUBJECT-LOCKS`(~1204 行)另外对 `spreadsheet_permissions` /
  `field_permissions` / `record_permissions` 三张表做**直接 SQL 写入**(非经 HTTP)验证同一持锁下抛
  40001/`METASHEET_RECOVERY_AUTHORITY_BUSY`——证明三张表的触发器机制本身可靠,但不等于驱动了对应的
  HTTP 路由。**未被上述任一测试覆盖的两个路由是 `config-restore-execute` 和
  `record-permissions-delete`。**
- **(b) `config-restore-execute` 路由唯一会产生 40001 的分支挡在 env flag `MULTITABLE_ENABLE_PERMISSION_REVERT`
  之后**(`src/routes/univer-meta.ts:9100`:该 flag 不等于 `'true'` 时直接 403,不会走到
  `applyPermissionDeEscalation`)。这个 flag **不在**阶梯 §0 列出的四个 flag(
  `MULTITABLE_HISTORY_CONTIGUITY_STRICT` / `MULTITABLE_ENABLE_WRITER_FENCE` /
  `MULTITABLE_ENABLE_SHEET_REVERT` / `MULTITABLE_ENABLE_PIT_RESET`)之内。

**触发器机制不是单一实现**:univer-meta 三张表(`spreadsheet_permissions` / `field_permissions` /
`record_permissions`)用的是 `metasheet_recovery_authority_subject_trigger`(按 `subject_type` 在
user/role/member-group 间多态分派);而 `users` / `user_roles` / `user_permissions` /
`platform_member_group_members` 用 `metasheet_recovery_authority_user_trigger`,`role_permissions` 单独用
`metasheet_recovery_role_permission_trigger`。三种函数由同一份迁移
`packages/core-backend/src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts` 建立。

**一个与成本估计相关的既存事实**:上面 (a) 提到的 realdb 集成测试套件本身就搭建了一份带
sheet/field/record 的 univer 表格 fixture 去驱动这三个 HTTP 路由——这是**另一套 harness**(vitest 集成
测试,不是电池脚本)已经做到的事,不代表把同类 fixture 移植进电池脚本的工程量必然低。

## D2-F9 · `details.retryable` 响应契约分歧(owner 裁量,不代拍板)

**背景**:同一 409 语义(recovery-authority 冲突)当前由两条独立的响应路径产出**不完全相同**的 body。

- `src/routes/univer-meta.ts:4293` 的 `sendRecoveryAuthorityBusy` 产出
  `{ ok: false, error: { code: 'RECOVERY_AUTHORITY_BUSY', message: '...' } }`——**没有** `details` 字段。
- 共享适配器 `src/db/recovery-conflict.ts:122` 的 `sendIfRecoveryConflict` 经
  `jsonError(res, 409, 'RECOVERY_AUTHORITY_BUSY', MESSAGE, { retryable: true })`
  (`jsonError` 定义于 `src/util/response.ts:3`,把第五个参数原样塞进 `error.details`)产出的 body 带
  `error.details.retryable === true`。

status(409)、code、message 三者完全一致,唯独一侧有 `details`、另一侧没有。

**现状核实**:对 `apps/web/src`、`plugins/`、`packages/*/src` 做过一次全仓扫描,**没有找到任何读取
`error.details.retryable`(或等价路径)的消费端代码**——现有的其它 `.retryable` / `error.details` 命中
均属无关字段(导入失败项的 `failure.retryable`、DingTalk 传输重试、考勤通知投递重试、
`RecoveryConflictError` 自身在服务端读取抛出对象上的 `.retryable`,以及若干校验类路由把
`error.details` 转发为字段级错误数组)。**因此这条分歧目前是潜伏的,不是一个活的用户可见 bug。**

**owner 需要拍的问题**:是否要把两条路径的 body 对齐。这**不能作为顺手改动**去做——它是对五个
L1-armed 路由的已发布响应体的契约变更,且已有两处测试逐字节钉住 univer-meta 侧**当前**(无
`details`)的 body,一旦改动会直接变红:

1. required 车道里的 `multitable-exact-anchor-route-wiring-realdb.test.ts`(`AUTHORITY-HTTP-RETRY`,
   ~1337 行)用 `toEqual` 钉住不带 `details` 的 body;
2. `packages/core-backend/tests/unit/recovery-conflict-surfaces-routes-univer-meta.test.ts`(#5128,
   已 MERGED `e9944cbfed8`)里的 `UNIFORM_409_BODY` 常量,被 5 处 `toEqual` 断言复用(已核实),同样钉住不带 `details` 的 body。

若要对齐,响应函数与上述两处钉点必须在**同一个 PR** 里一起改,否则要么改完立即两处变红,要么钉点先
改而生产代码未改,两者都不是安全的中间态。

## B1a · A1 ratify 的两处自伤 —— 均已处置(#5125 `7067b49516`)

1. **A1.3 的证据包今天产不出** —— ✅ **已解决**:workflow 现已捕获 `image_digest` / `build_commit`
   (`docker inspect`,`.github/workflows/multitable-l1-battery.yml:379-392`),连同电池自身的
   `script_sha256` 一起写入 evidence JSON 的 `provenance` 字段(`scripts/ops/multitable-l1-battery.mjs:1205,
   1220-1221`);缺失记 `null`(ladder §A1.3,已核实同步更新)。
2. **生产继承条款不可满足** —— 已通过**收窄 A1 的范围**处置,不是把条款本身改到可满足:ladder §A1.1
   现明文「A1 不覆盖生产(2026-08-22 深审后收窄)……生产 L1 仍按原 ≥2 日历日判据执行;若日后要把压缩窗
   扩到生产,须先(a)扩展电池覆盖、(b)另立生产授权 workflow,然后另行 ratify,不由 A1 顺带继承」(已核实
   同步更新)。即:今天不会 ratify 一条不可满足的生产条款,因为该条款已被移出 A1 的 ratify 范围。

> prod 那条 `role_permissions → roles` cascade FK 依旧是 **INFERRED-STRONG**(未被只读见证证实或证伪)。
> 见证查询 `ROLE_CASCADE_WITNESS_QUERY` 最初由 #5045(`4bacc27ccc`)引入电池脚本,早于 #5125 即已在
> main 上;唯一 dispatch 它的 workflow —— **PR #5131**(`multitable-role-cascade-witness.yml`;只读:仅 `docker ps` + 一次
> `docker exec` 跑 `pg_catalog`-only `SELECT`,无写入)—— **现已 MERGED**(合并提交 `771cd9be20`,
> 2026-08-24T12:15:34+08;`gh pr view 5131 --json state,mergedAt,mergeCommit` 核实)。原写「目前仍是
> **OPEN / Draft**」,已更正(见文首「四次更新」):该断言在本文档上一提交(`57129e0b57`,12:09:47+08)
> 落地 6 分钟后即失效——head `1d8f0708de` 本身不变(真 merge,分支尖端未再动),过期的只是 PR 状态。
>
> **原写「⚠️ 下面 (a)(b) 的谓词修复只存在于 #5131 分支(head `1d8f0708de`),尚未落 main:origin/main
> 现在 `136be5f1f5`……其上的 `scripts/ops/multitable-l1-battery.mjs` 目前仍是修复前的窄判据……
> `multitable-role-cascade-witness.*` 三个见证文件在 main 上根本不存在」,已更正**:#5131 合并后,
> 宽谓词与三个见证文件均已落 `origin/main`(合并提交 `771cd9be20` 是当前 `origin/main` 的**祖先**;此处刻意不镜像 main 的 tip;
> `gh api repos/zensgit/metasheet2/branches/main --jq '.commit.sha'` 核实)。main 上
> `scripts/ops/multitable-l1-battery.mjs:451-469` 现即 (a)(b) 段所述的宽 `ROLE_CASCADE_WITNESS_QUERY`
> (对 `roles` 的任意外键判断,不再硬编码表名),`:490` 现即 `ROLE_DELETE_CHILD_WRITE_ACTIONS =
> ['c','n','d']`(均以 `git show origin/main:scripts/ops/multitable-l1-battery.mjs` 核实,行号与
> #5131 分支上一轮核实时一致,因为是原样合并,未再改动);`.github/workflows/multitable-role-cascade-witness.yml`
> / `scripts/ops/multitable-role-cascade-witness.mjs` / `scripts/ops/multitable-role-cascade-witness.test.mjs`
> 三个见证文件均已在 `git ls-tree origin/main` 中列出。**main 上的这份宽判据不是电池之外的旁路检查,
> 电池自身在运行时就消费它**:`multitable-l1-battery.mjs:1518-1520`(main 上已核实,原窄判据时期
> 曾在 `:1366-1371`,行号随本次合并的其余改动一并前移)用同一个 `ROLE_CASCADE_WITNESS_QUERY` 查目标库,
> `roleDeleteCascadeExists` 判真则把 `not_driven_reason_expired` 推进 `failures`——今天从 main dispatch
> 的 L1 电池,`roles:delete` 站点的 NOT-DRIVEN 豁免复检用的已经是这份**宽**判据,不再是窄判据。
>
> **owner 复审在更早的 head(`c0c83e2534`)上指出的两处窄,已在 #5131 分支后续提交里修复,以该分支
> 当前 head `1d8f0708de` 核实(以下行号均属 #5131 分支,不是 main;`1d8f0708de` 未再改动
> `multitable-l1-battery.mjs`,行号与上一轮核实时一致)**:
> (a) 原判据只查 `role_permissions → roles`,漏了 `user_roles`。widen 提交
> `9bce95b4dd fix(multitable): widen the role-cascade witness predicate to the real premise` 把
> `ROLE_CASCADE_WITNESS_QUERY`(#5131 分支 `multitable-l1-battery.mjs:451-469`)改写为对 `roles` 的
> **任意**外键判断——不再硬编码表名——只要子表挂了 canonical recovery-authority 触发器(谓词由该文件
> 的 census 触发器函数列表派生),`role_permissions`/`user_roles` 两条 cascade 均落在判定范围内。
> (b) 判据原只认字面值 `confdeltype = 'c'`,未把 `'n'`(SET NULL)/`'d'`(SET DEFAULT)算作会对子表发
> DML 的动作。同一提交把 `ROLE_DELETE_CHILD_WRITE_ACTIONS`(#5131 分支同文件 :490)定义为
> `['c','n','d']`,三者都计入"child row gets touched"的判定,`'a'`/`'r'` 仍判 ABSENT(不产生子表
> DML,判定不变)。
>
> **现状(以 head `1d8f0708de` 核实,2026-08-24;晚于上一轮核实时的 `d8b6a2e933`):real-DB golden
> 现已接入 CI 并实际执行通过,这一轮之前"仅手动 arm 才过、CI 未接入"的现状已被这个新提交取代**。这
> 10 条 golden 默认门槛是 `ROLE_CASCADE_WITNESS_DB_GOLDENS === '1'`(`multitable-role-cascade-witness.test.mjs:1160-1170`
> 的 `dbGoldenSkipReason()`),不设即 SKIP——`1d8f0708de` 之前没有任何 CI 车道设置这个变量。`1d8f0708de`
> 在 `.github/workflows/multitable-o2-observation-kit-realdb.yml` 新增了一个 armed step(`:152-164`:
> env 里 `ROLE_CASCADE_WITNESS_DB_GOLDENS='1'` + 一个指向该 job 自身 `postgres:16` service 的
> `ROLE_CASCADE_WITNESS_ADMIN_URL`),该 job 的 `paths:` 过滤器也新增了见证脚本、见证测试文件、电池
> 文件本身与这个 workflow 文件,编辑其中任一个都会触发这条车道去执行 golden。这条接线由 always-on、
> 无 path 过滤的 hermetic 车道("observation-kit contract",已用 `gh api
> repos/zensgit/metasheet2/branches/main/protection/required_status_checks` 核实其 context 名在
> `required_status_checks.contexts` 里)中的用例钉住(`multitable-role-cascade-witness.test.mjs:1175`
> 的 fail-not-skip sentinel + cross-file 断言),删掉那个 armed step 会在 required 车道里变红。**已用
> GitHub 上的真实执行核实**:PR #5131 run `32682499617`,job "observation-kit execution proof (SQL
> is read-only against a real DB)"(`gh api repos/zensgit/metasheet2/actions/jobs/97301471543/logs`),
> `node --test scripts/ops/multitable-role-cascade-witness.test.mjs` 打印 `# tests 59` `# pass 59`
> `# fail 0` `# skipped 0`(该 job 用 `postgres:16` service)。**精度说明**:实际执行这些 golden 的
> job("observation-kit execution proof (SQL is read-only against a real DB)")本身**不在**
> `required_status_checks.contexts` 列表里——列表里的是钉住其接线的 hermetic 车道("observation-kit
> contract"),不是执行车道本身;`paths:` 过滤器保证"改到见证/电池/该 workflow 就会跑",但这与
> GitHub 分支保护意义上的 required check 是两回事。
>
> **由此产生一条持久控制缺口,以及一条在补上之前必须执行的人工步骤**:该执行车道未来即使变红,分支保护本身也**不会阻止合并**——被钉住的只是「接线存在」,不是「执行通过」。根治办法是把它接进一个**始终出现的 required 聚合门**(而非直接把这条 path-filtered 车道设为 required:它在无关 PR 上根本不产生 check run,直接设 required 会让那些 PR 永久 pending)。**在补上之前**:每次授权 L1 电池实跑之前,必须人工核对该执行车道在**待用 SHA** 上的最近一次运行为成功、且其 armed step 报告 `# skipped 0` —— `0 skipped` 才证明真库 golden 确实执行过,而不是车道走绿、golden 静默跳过。同一提交也把 `workflow_dispatch` 的默认目标从
> `production` 改成了 `staging`(`multitable-role-cascade-witness.yml:113-114`),并把
> `default == options[0] == staging` 钉进了同一份 hermetic 套件。
>
> **补记(2026-08-24,四次更新):上面这段以 #5131 分支 head `1d8f0708de` 为范围的执行证据本身继续
> 成立,不替换、只补充**——#5131 合并后同一条 armed step 在 `origin/main`(push 事件,commit
> `771cd9be20`)上重新执行,`run 32689331718` / `job 97320045961`
> (`gh api repos/zensgit/metasheet2/actions/jobs/97320045961/logs` 核实)同样打印 `# tests 59`
> `# pass 59` `# fail 0` `# skipped 0`。两条证据回答不同问题(该 head 上曾执行 / 合并后 main 上仍执行),
> 保留两条而非互相替换。
>
> **原写「但这不改变 PR #5131 仍是 Draft、main 上谓词仍未修复这件事……唯一剩的缺口是分支未合并,main
> 上电池实跑时用的仍是窄谓词」,已更正(见文首「四次更新」)**:该段落成立的前提(#5131 尚未合并)在
> 本文档上一提交(`57129e0b57`)落地 6 分钟后即被推翻——#5131 已 MERGED(`771cd9be20`),main 上电池
> 实跑时用的**已是宽谓词**,不再是窄谓词。ladder §A1.1 末段"建议在 ratify 前顺手跑掉"那条只读 SQL:
> 载体已存在(#5131,已合并)、判据已在 main 修完、CI 已覆盖 real-DB golden(分支与 main 两处均实测
> 59/59)——**此前"唯一剩的缺口是分支未合并"这条也已不再成立**;§B1 对应段落同步更正,见下。
>
> **`INDETERMINATE` 提醒**:见证脚本把结果分三类——`ABSENT`(premise CONFIRMED,exit 0)、
> `PRESENT`(premise REFUTED,exit 1)、`INDETERMINATE`(未能观测,**exit 2**)
> (`multitable-role-cascade-witness.mjs` 头注 HEADLINES 定义)。`INDETERMINATE` 是**证据缺口失败**,
> 不是通过——容器缺失、`DATABASE_URL` 不可读、查询失败等都归入这一类而非 `ABSENT`,诊断上合法,
> 但任何一次 dispatch 落在这一类都不能读成"这一轮见证过关"。

## B. 前置满足、随时可拍(压缩真正落袋的动作)

**B1 · ratify 阶梯修正案 A1 —— ⛔ 前置尚未满足,暂不可 ratify**
- 决策:在 **A1 承载 PR(#5042)** 留 `RATIFY-A1 <A1 内容的 exact-head SHA>` 批注,把 L1 窗口从 `≥2 日历日`
  改为 `≥1 日历日 + 电池 PASS`。**注意授权只能绑 A1 承载 PR 的 exact content SHA,不能在电池 PR 上替代授权。**
- 前置:**代码侧已闭合(范围限定:A1 电池基础设施这组——P1 凭据生命周期 / P2 canonical posture 校验 / F1 建号脚本 / F2 required check / F3 search_path 代码修复;不含 role-cascade witness 谓词,那是独立的另一产物,见下一条);仅 owner/ops 前置未满足**(截至 2026-08-22 第六轮复审;F2 状态已随 2026-08-24 复核更新)。已落 main:电池凭据(#5069/#5076)、search_path 根修(#5081)、context/台账(#5077/#5083/#5085)、建号脚本重写 + 提权修复(#5080/#5084)、电池 digest/sha 证据绑定(#5125)。**F2(设 required)已完成**(2026-08-24 经 `gh api .../branches/main/protection/required_status_checks` 核实,`contexts` 含 `recovery-schema-drift`)。**未满足的是 owner/ops**:F3 双主机新指纹证据、建号 + 电池实跑 PASS。**两者**齐备才可 ratify。
  **原写「……staging pending≠0(据 #5094 / `staging-migration-backlog-disposition-20260822.md`,本轮未取得更新证据)……三者齐备才可 ratify」,已更正(见文首「五次更新」)**:staging 迁移窗口已于
  2026-08-24T05:44–05:54Z 执行,`Applied: 337 / Pending: 0`(`run 32694623829` / `run 32694880864` /
  `run 32695040817`),该项**已满足**,故 owner/ops 前置由三项减为两项。已闭合缺陷存档:
  - **P1 凭据生命周期**:cancel/超时/失败时管理员邮箱+密码可能遗留部署主机 `/tmp`。**已闭合**(#5069 workflow always() 清理 → #5076 停止容器诚实枚举 → #5080/#5084 建号脚本 stdin-only+trap;全过独立复门)。
  - **P2 canonical posture 校验**:当前只查 trigger 名+tgenabled;同名 trigger 在错表仍报 9/9 ARMED=假 ARMED。
    需校验表/事件/函数/参数/更新列/函数指纹+变异测试。**(已修 + 过独立复门,合 `ceb0f08def`)**
- **⚠️ 与本条剩余前置"建号 + 电池实跑 PASS"交界的缺口(证据见 §B1a,role-cascade witness;不是重复劳动,是同一份证据在两处的排期含义)** —— **2026-08-24 四次更新:本条下方原文的核心前提(#5131 未合并)已失效,整段按原样保留、逐句标注更正,不做回溯改写**:
  原写「上面"代码侧已闭合"这组不含 role-cascade witness 谓词的宽化——该谓词的宽版本目前**只存在于
  #5131 分支(未合并,head `1d8f0708de`)**;origin/main 现在 `136be5f1f5`,其上(已核实,
  `scripts/ops/multitable-l1-battery.mjs:382-394`)电池脚本里的 `ROLE_CASCADE_WITNESS_QUERY` 仍是窄
  谓词……」,**已更正**:#5131 已于 2026-08-24T12:15:34+08(合并提交 `771cd9be20`)合并,宽谓词现已在
  `origin/main`(含合并提交 `771cd9be20`,该提交是当前 main 的祖先)上,`scripts/ops/multitable-l1-battery.mjs:451-469` 即宽版
  `ROLE_CASCADE_WITNESS_QUERY`(核实方式与引用行号见 §B1a)。
  原写「**现实后果**:在 #5131 合并前,若 owner 现在授权"建号 + 电池实跑",电池会用这份窄谓词复
  核……电池会**放行一个已经失效的豁免**……」,**已更正**:该风险的前提(#5131 未合并)已不成立——
  main 上电池自身在运行时消费的已是宽谓词(`multitable-l1-battery.mjs:1518-1520`,见 §B1a),窄谓词
  假放行的场景不再是"若 owner 现在授权就会发生"的现实路径。
  原写「**#5131 合并是下一次"可计入 A1 证据的 L1 电池实跑"的硬前置**……owner 仍可决定何时合并
  #5131……」,**已更正**:该硬前置**现已满足**(#5131 已合并)。**本清单不代 owner 决定这是否意味着
  "建号 + 电池实跑 PASS" 前置本身已满足或 A1 可以 ratify**——那需要一次实际的电池 dispatch 产出 PASS
  证据(见下方"修复后序列"),本条只更正"谓词处于哪个分支/是否已合并"这一事实,不改变、不预判 owner
  对是否现在授权电池实跑的决定。原写「F3 双主机新指纹证据、staging pending≠0、"建号 + 电池实跑 PASS"
  这三项 owner/ops 前置本身的完成状态不受本次更正影响,仍按 §B1 开头所记未满足」——**该句在四次更新
  落笔时为真,现按 2026-08-24「五次更新」更正**:其中 `staging pending≠0` 一项已于同日
  05:44–05:54Z 完成(`Applied: 337 / Pending: 0`,`run 32694623829` / `run 32694880864` /
  `run 32695040817`);**其余两项**(F3 双主机新指纹证据、建号 + 电池实跑 PASS)的完成状态确实不受
  本次更正影响,仍按 §B1 开头所记未满足。
- 修复后序列:凭据修复 → canonical posture 校验 → 变异测试 → 修正本清单/文档 → exact-head 独立复门 →
  owner 授权 staging 电池实跑 → **PASS 后再 ratify A1**。
- 门审边界(修好后仍适用):干净电池只观测 **12/55 census 站点(分母已随 #5128 由 48 升至 55,见 §D2-F8;driven 集合本身未变,仍是 12)+ 6/9 触发器**——更强信号非更广,压窗 = "深换广"。
- 后果:未 ratify 期间原 `≥2 天` 判据继续生效,无损失。
- 载体:A1 = #5042;电池修复轮全落 main(#5069/#5076/#5077/#5080/#5081/#5083/#5084/#5125);**代码侧 F1 硬前置已解除(#5084)**;F2 已完成(2026-08-24 核实);**#5039→#5094 的 staging 迁移积压已于 2026-08-24 应用完毕(`pending = 0`,见 §A)**;A1-ratify 剩 owner 侧前提**两项**(F3 主机证据 / 建号+实跑 PASS)。原写此处第三项「#5039→#5094 pending≠0」,已更正。

### C1a · P3-INFO-1 subject_type 枚举(已查证,结论=满足)

- 复门给 A1 留的前置:确认 `record_permissions`/`field_permissions` 只带 recovery 覆盖的主体。
- **已查证满足**:两表都有 DB CHECK `subject_type IN ('user','role','member-group')`(`zzzz20260418143000` 加宽,此后无迁移改动),
  与触发器过滤谓词**完全一致**;三个应用写入方全在枚举内(`z.enum`/`isSheetPermissionSubjectType`)。越枚举值无法落库(23514)。
- 唯一残留由 HARDENING 车道兜住(见 §D3):subject_type CHECK 的**运行时**确认(pg_constraint 读)已并入 A-vs-B 漂移守卫(#5071 `d0911f264d`,独立车道 `multitable-recovery-schema-drift.yml`,check context 实名 **`recovery-schema-drift`**)。**该守卫现已 required**(2026-08-24 经 `gh api repos/zensgit/metasheet2/branches/main/protection/required_status_checks` 核实,`contexts` 数组含 `recovery-schema-drift`)——F2 已完成(见 §D2)。

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

（F7/F8/F9/F10 是同一 F 序列后续新增的独立小节，见文前 §D2-F7 / §D2-F8 / §D2-F9 / 文后 §D2-F10，不在此列表内重复。）

- **F1 · 建号脚本(硬前置,✅ 已闭合)**:owner 复审历经四步——(1) battery workflow `docker cp` 密码进容器 → 停止容器假 PASS,**已修 #5076**;
  (2) 配套建号脚本 `create-l1-battery-admin-on-staging.sh` 重现同一泄漏 + 非原子提权,**已重写落 main #5080 `95318992ab`**(stdin-only+trap+单事务);
  (3) 第四轮发现该脚本提权漏洞:register 接受 409(预占邮箱)→ 先提升 → 后验密码,预占账号即得 admin。**已修并落 main #5084 `162679992e`**(login-first 拿服务端 user.id→按 id 原子提升;预占+错密码零提权 golden + mismatched-id 收敛行为 golden;独立复门 APPROVE)。
  (4) 第五轮:'zero database writes' 文案过强(register 先提交普通用户行)——已收窄为'zero privilege writes,普通用户残留可安全重跑'。**F1 全闭合。**
- **F2 · 设漂移守卫为 required —— ✅ 已完成(2026-08-24 核实)**:check context 实名 **`recovery-schema-drift`**(job 名,非文件名),已对每个 PR 稳定产生(#5075)。
  **F3 复门证实这是安全必需**(非可选):否则有人 revert `public.` 限定符后重生成指纹 → required 全绿而 shadow 重开,只非-required 反例能抓。**owner 已在 branch protection 把 `recovery-schema-drift` 加入 required**(2026-08-24 经 `gh api repos/zensgit/metasheet2/branches/main/protection/required_status_checks` 核实,`contexts` 数组含该 context)。
- **F3 · search_path 根修 —— 已落 main(#5081 `d3289945e1`)**:新迁移 schema-qualified 调用 + 固定 `SET search_path=pg_catalog,public`;函数指纹 `14c180aa→e4a78f6c`;triggers 不变 9/9 DISABLED;真库反例全 5 触发器路径均被防(复门 APPROVE)。
  **⚠️ ops 协调**:迁移使 prod 函数变新指纹**仅在迁移跑时生效**;镜像落但迁移未应用时跑 postdeploy-full 会 FAIL 在 config 字段=**预期(config-field)非 drift**,迁移须先于 containment/L1 dispatch。**⚠️ 待补:新指纹的双主机 postdeploy-full 证据尚未取**(2026-08-24 复核仍成立:`Multitable Recovery-Flag Containment Check` 的最近一次运行仍是 `run 32321464042`,2026-08-20,即本文档已标注的 **pre-fix 点内**观测;此后无新运行)。
  **2026-08-24 五次更新补记(只补"迁移先于 containment"这一层,不改上面的待补项)**:上述 ops 排序前置在 **staging 侧已满足**——F3 迁移 `zzzz20260821120000_recovery_authority_functions_fix_search_path` 已随 2026-08-24 窗口应用到 staging(在 16 条之内,见 §A),且 staging 镜像已重部署到 `c345c6b405`(见 §A-2),其 containment helper sha 与 workflow 钉值相等。**故 staging 腿现已具备"跑得起来"的条件;但双主机(prod + staging)新指纹 `e4a78f6c…` 的 postdeploy-full 证据本身依然未取**,该项仍开着。
- **F4 · 旧 Time Machine PR 处置 —— ✅ 已完成(2026-08-24 逐个核实)**:七个 PR 里五个已 **CLOSED**(经 `gh pr view --json state,closedAt` 核实,均在 2026-08-22T04:08–04:09Z 关闭,判定 superseded):#4216(`04:08:11Z`)、#4219(`04:08:15Z`)、#4204(`04:08:38Z`)、#4200(`04:08:42Z`)、#3805(`04:09:08Z`)。另两个是 owner 明文标注**故意 PARKED、禁止 sweep-close**、按设计保持 **OPEN**(不是遗漏):**#4205**(R13 Lane B T-state 设计,owner 评论 2026-08-21:是未来 T-state 工作的 ratify 前置输入,决策点在阶梯 L6 soak 之后)、**#4224**(R13-C retention↔Reset 设计锁,owner 评论 2026-08-22 的"F4 disposition sweep":内容尚未落地,是 §D2 所记 Phase D 一半的唯一草拟设计输入)。
- **F5 · P3(第四轮):#5080 golden readiness 竞态 — ✅ CLOSED**:`pg_isready` 后即连目标库(可能库未建好即返回)——PR 跑一度 19/20。**已改为目标库上 `SELECT 1` 循环(`waitForTargetDbQueryable`),随 F1 同轮落 main #5084 `162679992e`**;goldens 连跑无 flake。
- **F6 · P3-1(可选硬化)**:`recovery-authorization-stability.ts` 的函数指纹与 containment 常量无机械交叉守卫——将来改一份漏另一份会静默再破生产 lease。可加一条断言绑定。

## D2-F10 · ratified 阶梯 L2 判据不可产出(需 owner 对阶梯做出更正;非代码缺陷,不在任何 open PR 范围内)

**机制**(均已对照当前 main 逐条核实;下面按代码实际命中判据的先后顺序排列,不按发现顺序排列)——

**主要发现:两旗标合取门抢在任何 checkpoint 判据之前拒绝,这是 L2 不可产出、最先命中的原因**:

- `checkExactAnchorRecoveryTrust()`(`packages/core-backend/src/multitable/exact-anchor-recovery-route.ts:343-348`)
  只有 `isWriterFenceEnabled()` **与** `isContiguityStrictMode()` **同时**为真才返回 `{ok:true}`,否则返回
  `{ok:false, reason:'recovery-trust-required'}`。
- Revert/Reset 的两个生产入口都把这个合取门排在 checkpoint 判据**之前**:预览入口
  `previewExactAnchorRecovery` 在第 3 步调用它(`exact-anchor-recovery-route.ts:443`),第 4 步才调用
  `precheckSheetHistoryIntegrity`(`:451`,即下面的 checkpoint 判据所在函数);执行入口
  `applyExactAnchorRecovery` 同序:同一合取判据在第 2 步(`exact-anchor-recovery-execute.ts:899`),
  `precheckSheetHistoryIntegrity` 在第 4 步才被调用(`:913`)。已用
  `grep -rn "precheckSheetHistoryIntegrity\b" packages/core-backend/src/ | grep -v "\.test\.ts"` 核实
  (排除测试文件):生产代码里 `precheckSheetHistoryIntegrity` 唯一的两个调用点就是这两处,没有第三条
  路径能绕过前面的合取门去问 checkpoint 判据。
- ladder §2 把 `MULTITABLE_HISTORY_CONTIGUITY_STRICT` 排在 **L2**,把 `MULTITABLE_ENABLE_WRITER_FENCE`
  排在**更晚的 L3**(`multitable-timemachine-o2-enablement-ladder-20260819.md` §2:分别是
  "L2 — staging `MULTITABLE_HISTORY_CONTIGUITY_STRICT=1`" 与 "L3 — staging
  `MULTITABLE_ENABLE_WRITER_FENCE=1`" 两段)。
- **后果**:在 L2,fence 尚未开、strict 已开——`checkExactAnchorRecoveryTrust()` 对任何 sheet 的任何
  preview/execute 调用都返回 `recovery-trust-required`,代码根本不会走到 `precheckSheetHistoryIntegrity`。
  **即便该表恰好存在一个 ACTIVE trust checkpoint,这道更早的合取门也会无条件拒绝它**——ladder §2 给
  L2 写的验收证据「strict 拒绝率 = 预期(合成断链演练拒绝、正常表通过),无误伤」因此产不出,且原因与
  checkpoint 是否存在无关。

**次要发现(更深一层的 checkpoint 判据;只有在上面这道合取门被跳过或阶梯改序之后才有机会被实际问到)**:

- `RECONSTRUCTION_CAUSALITY_LANDED = true`(`packages/core-backend/src/multitable/history-trust-precondition.ts:37`)。
  该常量与"是否存在 ACTIVE trust checkpoint"共同构成 strict-enablement 的两条件门:
  `checkStrictEnablementPrecondition`(同文件 :68-77)读 `hasActiveTrustCheckpoint`;
  `precheckSheetHistoryIntegrity`(`history-integrity-precheck.ts:459`)在 `MULTITABLE_HISTORY_CONTIGUITY_STRICT`
  打开时(`:463`)**委托给这个两条件门**——`!canEnable` 无条件拒绝,返回 `strict_enablement_unmet`
  (`:477`),**不会**进入下方的 strict 比较器。一张没有 checkpoint 的表(包括"正常表")在 strict 打开时
  永远走不到比较器——但如上所述,这是**第二道门**,L2 期间第一道合取门已先行拒绝,这道 checkpoint 门在
  L2 从未被实际触达。
- trust-checkpoint 的**激活**另挂一个第五 env flag `MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION`
  (`src/routes/univer-meta.ts:10159-10160`,`POST /sheets/:sheetId/trust-checkpoint-activate` 路由的 flag 检查
  在 `:10163`)——该 flag **不在**阶梯 §0 列出的四个 flag 之内(已读 §0:只列 `MULTITABLE_HISTORY_CONTIGUITY_STRICT`
  / `MULTITABLE_ENABLE_WRITER_FENCE` / `MULTITABLE_ENABLE_SHEET_REVERT` / `MULTITABLE_ENABLE_PIT_RESET` 四个)。
- 激活还**额外要求 writer fence 已开**:该路由在 flag 检查之后立即检查 `isWriterFenceEnabled()`
  (`univer-meta.ts:10171-10172`;该函数读 `MULTITABLE_ENABLE_WRITER_FENCE`,`canonical-sheet-fence.ts:136-138`),
  不满足则 409 `TRUST_CHECKPOINT_FENCE_REQUIRED`。writer fence 在阶梯里排在 **L3**,晚于 strict 所在的 **L2**。

**关于 L2 期间是否"没有" active checkpoint 这件事本身**:阶梯既不在任何一级安排建立 trust checkpoint,
也不校验这个前提——通读 `multitable-timemachine-o2-enablement-ladder-20260819.md` 全文(§0–§5,含演练
记录与指纹表)对"checkpoint"零命中。**本节未查询任何主机上的 `meta_history_trust_checkpoints` 表**,
历史遗留的或手工建立的 checkpoint 无法排除,因此"L2 期间没有 active checkpoint"不是一个可以断言的事实
——阶梯没有能力保证这份证据可产出。但这件事对上面的主要结论没有影响:即便某张表在 L2 期间恰好存在
一个 checkpoint,`checkExactAnchorRecoveryTrust()` 这道更早的合取门依旧会无条件拒绝它,L2 的验收证据
照样产不出。

**后果(L4/L5)**:revert/reset 共用的预览入口 `previewExactAnchorRecovery`(`exact-anchor-recovery-route.ts:411`)
依序做:trust 旗标检查(`:443`,即上面的合取门,env-only)→ `precheckSheetHistoryIntegrity`
(`:451`,同一两条件门)→ `resolveExactAnchor`(`:455`)。到 L4/L5 时两个 flag(含 writer fence)均已开,
合取门会通过;`resolveExactAnchor` 内部**再独立查一次** checkpoint(`exact-anchor-recovery.ts:261-262`:
`selectCheckpointByAnchorSeq` 查不到即 `return { ok: false, reason: 'no-covering-checkpoint' }`);执行侧的
in-txn 复检有同一形状的拒绝(`exact-anchor-recovery-execute.ts:930`)。也就是说,没有 checkpoint 时,
revert/reset 的 preview 与 execute 会在两个独立位置都拒绝——L4/L5 命名合成 org 上的 canary 演练同样会在
到达"precise-anchor 成功"这一步之前就被拒。

**定性**:这是对已 ratified 阶梯文档(该文档本身冻结,本次不改动)的一处更正需求,不是代码缺陷——代码
按其自身注释记录的 owner 裁决(2026-07-16/17)行为正确;缺口在于阶梯的级序与 §0 的 flag 清单没有跟上
`checkExactAnchorRecoveryTrust()` 的两旗标合取门、两条件 checkpoint 门、以及第五个 flag 的设计。是否调整
级序、是否把第五个 flag 补进 §0、由谁在哪一级安排 checkpoint 激活,均属 owner 裁量。本节只记录机制,
不建议排序,不代拍板。

## E. 阶梯执行(全 owner-gated,日历为瓶颈,非开发)

> **2026-08-24 五次更新(L0 residual 的精确化)**:下行原写 `L0(差 A1)` 是速记,现按冻结的阶梯 §1
> 逐条对齐(**该阶梯文档本身冻结,本次不改动**;此处只在本清单内记录其勾选状态)。阶梯 §1 五条中:
> 第三条「staging 的 pending migrations ≠ 0」是阶梯 §1 上**唯一勾为 `[ ]` 的条目**,
> **已于 2026-08-24 满足**(`Pending: 0`,见文首「五次更新」)。
> 其余四条在阶梯 §1 上均勾为 `[x]`,但按**本清单自身的记载**仍附着三项 owner/ops 余项——
> (i) §1 第五条正文明写的另一半:目标主机上跑一次**回滚后 `postdeploy-full`** 验证回到 inert 姿态;
> (ii) §1 第四条正文明写的 owner 天花板裁量(= §C 的 C1);(iii) §1 第二条的 containment PASS,
> 阶梯勾为 `[x]`,而本清单 §D2-F3 记其为 pre-fix 点内观测(`run 32321464042`),新指纹
> `e4a78f6c…` 的双主机证据待取。**(i)(ii) 是阶梯正文自述的残留,(iii) 是本清单的记载——
> 三者均不改动阶梯的勾选状态,该文档冻结。**
> **A1 是阶梯的修正案、不是 L0 的勾选项**——它决定 L1 窗口按 `≥2 天` 还是 `≥1 天 + 电池 PASS` 计,
> 与 L0 是否满足是两件事;原速记 `差 A1` 把两者并列,易致误读。本条只记录状态,不代 owner 拍板。

L0(差 A1)→ L1 staging ENABLE triggers(flag 全 OFF)→ **⚠️ L2 及其之后 HOLD**(CONTIGUITY_STRICT;
验收证据不可产出,见 §D2-F10;HOLD 直至 owner 就阶梯 erratum 三点 ratify:(a) 新顺序——fence 不晚于
strict、(b) 把第五个 flag `MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION` 纳入阶梯 §0 的 flag 清单、
(c) 明确由哪一级负责 provision trust checkpoint;三点未 ratify 前,L2 按当前级序的验收证据产不出,见 §D2-F10)→ L3
WRITER_FENCE(同处 HOLD 范围)→ L4/L5 canary(同受 §D2-F10 影响,同处 HOLD 范围)→ **L6 soak ≥7 日历日**
→ L7+ 生产重放全序。
**每级你亲授 + 观察窗**。
**L1 窗口现行已 ratify 判据是 `≥2 日历日`(电池在窗口内跑,不替代天数)**;修正案 A1 拟把窗口收窄为
`≥1 日历日 + 电池 PASS`,但 **A1 目前 Status: PROPOSED,未 ratify 前上文 `≥2 天` 判据原样生效**(见 §B1、
enablement-ladder 文档 §修正案 A1)。压缩后地板约 9 天——**该数字假设 A1 已 ratify**(L1 记 ≥1 天);
按**现行未 ratify** 的 `≥2 天` 判据,L1 段本身多占 1 个日历日,地板相应更高(其余各级观察窗的实际
长度本文未逐级列出,不在此处折算)。
另需:目标主机跑一次**回滚后 postdeploy-full**(L0 §5 的 owner-gated 半条,本地演练不覆盖)。

---
> ⚠️ **第五轮 owner 复核观察(2026-08-21)**:F3 迁移已在 prod 执行,但部署窗口内有一次健康探针 `curl rc=7`;新指纹 `e4a78f6c` 的**双主机 postdeploy-full 证据尚未取**,staging 也未验证。**不能据此称 main 全绿或 prod 已稳定** —— F2 之后须先取双主机 postdeploy-full 证据(见 F3)再往下走。
>
> **2026-08-24 五次更新:上句是两个断言,现分别处置(原文保留)**——
> ① 「新指纹 `e4a78f6c` 的**双主机 postdeploy-full 证据尚未取**」:**仍然成立**。`Multitable
> Recovery-Flag Containment Check` 最近一次运行仍是 `run 32321464042`(2026-08-20,pre-fix 点内),
> 此后无新运行。F2 之后须先取该证据再往下走 —— 该结论不变。
> ② 「staging 也未验证」:**已部分位移,但结论未变**。staging 侧现已具备执行条件——F3 迁移已应用
> (2026-08-24 窗口 16 条之内,见 §A)、镜像已重部署到 `c345c6b405`、containment helper sha 与
> workflow 钉值相等(见 §A-2)。**但"具备执行条件"不等于"已验证":staging 腿的 postdeploy-full
> 仍未跑,指纹证据仍未取。** 故本行整体结论保持不变,只是其失败原因不再会是「镜像太旧」。

**最短路径(2026-08-22 深审后重排 —— ⚠️ 原顺序是循环的,见下)**

> **原顺序为何不可执行**:电池在 9/9 触发器未 ARMED 时**硬拒**(exit 2 `NOT_ARMED`),而电池 workflow **不代 arm**
> (其头注:"only at ladder rung L1 … after the owner has ENABLEd the 9 triggers")——**arm 9/9 就是 L1 的定义动作**。
> 原路径却把"电池 PASS"排在 ratify A1 与 L1 **之前**:照此执行则电池必红、无 PASS 可依、L1 永远排在最后。
> **正解:L1 按现行已 ratify 的 ≥2 日历日判据先开,电池在窗口内跑,PASS 后再 ratify A1,并按新判据 ≥1 天出窗。**

1. **F2** ✅ 已完成(owner 已加 check context `recovery-schema-drift` 到 branch protection,2026-08-24 核实)∥ **F4** ✅ 已完成(5 关闭 + 2 owner 明文 PARKED,见 §D2-F4)∥ owner 落墨 C1 天花板裁决(仍待拍板)
2. **文档修正一票** ✅ 已完成:指纹权威表(ladder §5.2,已核实存在)、armed 预期红(ladder §5.3,已核实存在)、redeploy 前置(本文档 §A-2)、清单指向 #5094(已核实,本文档 §A)
3. **电池 workflow 补 digest 捕获 + 脚本 sha pin** ✅ 已完成(#5125 `7067b49516`,即 B4;详见 §B1a)
4. **#5094 交付执行** ✅ **已完成**(2026-08-24 窗口):pinned SHA = `c345c6b405`。**实际执行顺序按时间戳为**:
   备份(05:46:32Z)→ 克隆彩排(`run 32694623829`,05:47:40–47:46Z,彩排库 `321→337`、`Pending: 0`,
   绿后即丢弃)→ 真实应用(05:47:48–47:53Z)→ 重部署 + 对齐报告 `decision=aligned`
   (`run 32694880864`,05:49:45Z)。原写「pin 部署 SHA + 冻结新迁移文件合并 → 按 pinned SHA 重生成
   对齐报告 → §7 只读预检 → 克隆彩排」,已按实际执行更正——**注意对齐报告是在应用之后由 `deploy` 跑
   产出的,不在彩排之前**。⚠️ **§7 只读预检的书面判据有三处缺陷**(CHECK 预检判据过窄 /
   锁窗口按整批而非按迁移 / 预检二照抄会 `42703`),**其它环境复用前必读**
   `staging-migration-window-completion-20260824.md` §2。
5. **staging 重部署 pinned SHA(≥ `d3289945e1`)+ 应用迁移 → pending=0** ✅ **已完成**
   (2026-08-24T05:44–05:54Z):应用迁移 = `run 32694623829`(`321/16` → **`337/0`**);
   重部署 = `run 32694880864`(`deploy`,success,目标 `c345c6b405`,`d3289945e1` 为其祖先——
   compare API `ahead_by=63, behind_by=0`);确认 = `run 32695040817`(四处 `337/0`)。
   原写「**⚠️ …… —— 原计划缺失的硬前置**(见 §A-2)」:该硬前置**已解除**(§A-2 三条 bullet 逐条更正见该节)。
6. **双主机 postdeploy-full**:取 triggers `4d68217d…` + functions `e4a78f6c…` PASS(=F3 证据,同时重绿 L0 item2)
7. **建号**(用 `scripts/ops/create-l1-battery-admin-on-staging.sh`;两枚 secrets 已设)
8. **owner 按现行 ≥2 天判据开 L1**:enable 9/9 → 立即 postdeploy-full(**trigger 腿预期红 = `505926e3…`**,flag 腿全绿)
9. **窗口内** dispatch 电池(intent `L1-open-battery-run-1`)→ PASS(证据绑镜像 digest)
10. **ratify A1 于 #5042**(建议绑 merge commit `5b2376bb49`,并在批注声明所用 SHA 形式)→ 出窗 → **STOP:L2 及其之后 HOLD**,待 owner ratify 阶梯 erratum(fence 不晚于 strict、`MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION` 纳入阶梯 §0 flag 清单、明确由哪一级 provision trust checkpoint;机制见 §D2-F10)。**本条最短路径到此为止,不得续接 L2**——主序列已声明 HOLD,此清单若仍写 `→ L2` 即构成绕过。
11. **L4 前 X2 一行修复 — ✅ 已修复(#5114)**;census 覆盖缺口 — ✅ 已随 #5128(`e9944cbfed8`,已 MERGED)补齐(见 §D2-F7)。⚠️ 与 §D2-F10 独立:即便 L4 打开,revert/reset 仍会在无 checkpoint 时于 preview/execute 两处拒绝。

**F1 已闭合;不再有"修复前不建号"的阻断。** 原写「——但第 5 步(staging 重部署+迁移)未完成前,第 6/7/9 步都会以难诊断的方式失败。」,**已更正(见文首「五次更新」)**:第 5 步已于 2026-08-24 完成(重部署 `c345c6b405` + `Pending: 0`),该"难诊断失败"的前提不再成立。**但这只解除镜像/迁移这一层**——第 6/7/9 步各自的 owner/ops 门(第 6 步取证本身即 §D2-F3 的待补项;第 9 步须先经第 8 步 arm 9/9)不受影响,仍按上文各条。
