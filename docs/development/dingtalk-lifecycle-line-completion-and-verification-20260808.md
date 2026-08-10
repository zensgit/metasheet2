# 钉钉生命周期线 — 收尾开发与验证 MD（2026-08-08）

- Status: **代码侧收尾完成（Rev 4.4 修复轮后恢复）** — closeout 复审（2026-08-08，对 main=45cf3a7c51）曾裁 **CHANGES REQUESTED**（2 P1 + 1 P2，见 §4bis），按其收尾顺序本状态一度改回 CHANGES_REQUIRED；修复 PR（T3 源权威 + OPS-01 可逆证据 Rev 4.4）与本状态行原子落地。启用/canary/U1-13/Transfer 仍 owner/ops-gated；三开关 OFF。
- 授权链：owner 2026-08-07/08 会话「钉钉同步业务功能开发-260721」指令 —— 「请排序并完成所有这条线剩余的开发，然后给出设计及验证 MD」，采纳含「显式批准 Rev 4.3」为第 1 步的收尾意见；模型分配按既有 model-split（Sonnet=机械/侦察、Fable=主循环+热文件语义、Opus=对抗门审）。
- 权威锁：`dingtalk-deprovision-reactivation-and-evidence-chain-design-20260723.md`（Rev 4.3，ratification 记录见其 §0.6，**终版随本 MD 提请 owner 会签**）+ companion admission 锁 Rev 4.2。
- 前情：`dingtalk-lifecycle-postmerge-findings-20260724.md`（07-24 实测「离岗零证据」P1 的完整证据链）与 honest closeout（#4587 修正版）。

## 1. 最终落地台账（11 车，全 squash-merge 于 2026-08-08）

| # | 车 | merge SHA | 内容 | 落地途中吸收的修复 |
|---|----|-----------|------|--------------------|
| 1 | #4646 D3 | `a45e1416002` | ledger schema 硬化至 §5.2（复合 FK/witness/CHECK/BEFORE INSERT 活链 trigger/immutability）+ **Rev 4.3 勘误**（每 event 单源组织 membership effect） | vue-tsc 一行错；Opus r1 P2×2（immutability 逐 trigger 臂 12 探针+正控、restore drift 门去 `.catch`）；r2 P3-D1 六列补探针；wiring 契约提升进 required `test` job；`pluginTestsWorkflow` 摘要重钉 |
| 2 | #4647 D4 | `882c2929063` | **writer→ledger 原子接线**（离岗与证据同事务） | Opus r1 **P1**（globally-clear 与取锁同语句=锁前快照⇒假证据）→ 锁拆独立语句先行；P2 蒸发候选改 per-candidate skip；r2 P1-D stub 缺臂+锁序断言；OPS-01 行形制裁定（见 §4）；两连接竞态+supersede 双腿金标（M1-M4 四变异各中一标） |
| 3 | #4648 D5a | `26d4be3e046` | admin 访问图写者挂 users 锁 | 18.x「terminating connection」flake（#4820 族）rerun 绿 |
| 4 | #4651 D5b | `cb12c6175a4` | bind/unbind 写者挂锁 + CAS | Opus D5 **P1-1**（witness 无 status 谓词 vs CAS 只认 linked ⇒ pending 匹配提示行 bind/admit 永败）→ 谓词对齐+pending-hint 金标（变异证承重）；两处 fixture 缺 `is_active` 修复 |
| 5 | #4653 D5c | `549ff555ef7` | sync 清单+OAuth 写者挂锁 | Opus D5 **P1-2**（清单按 payload 建、循环遍历全账号 ⇒ 滞留账号杀死每次 sync）→ SQL 加 DB 侧两臂成超集+杀手形状金标；**P2-1 ensureGrant `DO UPDATE→TRUE` 回退 creation-only**（否则离岗 disabled 行会被下次 OAuth 静默翻回——与 §4 裁定同轴）+ 双向金标 |
| 6 | #4655 D6 | `cc1843d4ca6` | restore 漂移原子化（资格判定入锁事务，闭 07-24 P2-2/评审 P2-D） | restack 冲突即主旨，取重写版并审计确认零吞/真表/事务内三重 FOR UPDATE |
| 7 | #4656 D7a | `6b9580e5f51` | D7 证据 API/UI 硬化 | 零冲突 |
| 8 | #4658 alias | `d97dc8d6eac` | **全部 activated-user 写者事务内 claim alias**（AuthService 自助注册/管理员建号/OAuth JIT——07-24 验证的三缺口） | 预告的唯一真冲突（vs #4716）keep-both；四单测套件补 alias-claim stub arm（含一处 stub 签名缺 params 的自伤）；E1 套件共享手机号撞全局唯一 alias ⇒ fixture 按 unionId 决定性推导（对照组：pristine main 8/8 证回归面在 fixture）；**七轮 BEHIND 追平后落地** |
| 9 | #4660 T3 批量 | `afe61d773c4` | 批量 pending 激活硬化 | 零冲突 |
| 10 | #4662 OAuth intent | `0514e698e7c` | `intent=activate` 专用 SSO 激活流（companion §6.2） | state-store 见证汇合（其 `insertedUserParams` 胜出+保我 alias arms）；invite-routes mock 补 `pool` stub；e2e quay.io 拉镜像 infra flake rerun 绿 |
| 11 | #4659 preview≈apply | `4368a5bc8fc` | preview 与 apply 同源判定（prospective ids + requireSourceInactive 贯穿三谓词,新增 `planDirectoryDeprovisionCandidate`） | **热文件手工语义汇合**：其重写基于评审前代码、会复活已杀的 P1 锁熔合 ⇒ 保锁分离结构+嫁接镜像谓词；skip 判定留 apply 侧（Opus 语义）、throw 判定入 plan 侧（其 API 契约） |

另：前置修复 #4587（幽灵列四处+错误面收敛，07-28 已合）、findings MD（07-24 分支）、flake 族票 **#4820**。

## 2. 决定性验收（整线的核心命题）

07-24 对当时 main 的实测（详见 findings MD §0.1）：开 `DIRECTORY_DEPROVISION_ENABLED` 离岗 ⇒ **图变而证据零行**（events/effects 0/0，generation 0→0，无锁）。

本轮 #4646+#4647 树上同型探针（Probe A v2，真库）：

| 指标 | 07-24 main | 收尾树 |
|---|---|---|
| 访问图（user/membership/grant） | 全变 | 全变 |
| **ledger events / effects** | **0 / 0** | **1 / 3** |
| **access_generation** | **0→0** | **0→1** |
| effect 形状 | — | `membership_changed`(源org)+`grant_changed`+`user_changed`，witness 自洽 —— Rev 4.3 语义 |

此后每车的真库金标（写者清单、竞态、supersede、restore 漂移、preview≈apply）都在该基础上逐层加固；全部套件在 required `test (20.x)` 显式 run-list 中，且 run-list 本身由 CI-wiring 契约钉死（该契约同时跑在 required lane —— 评审 P3 吸收）。

## 3. 独立对抗审台账（Opus adversarial-reviewer）

| 轮 | 对象 | 判定 | 收敛 |
|---|---|---|---|
| r1 | #4646+#4647 | CHANGES_REQUIRED：**P1 假证据竞态**（双连接实证）+5×P2（守卫可删类） | 全吸收；四变异各中一标 |
| r2 (delta) | 修复头 | CHANGES_REQUIRED：新 P1-D（stub 缺臂挂 required 单测）+P3-D1（六列可 neuter）+3 NIT | 全吸收（锁序断言「回答 stub 而非灭声」）；其对 r1 P1 的两个额外驳斥交错均告失败=强关闭 |
| r3 (D5 三连) | #4648/#4651/#4653 预排头 | #4648 APPROVE_WITH_HOLDS；#4651/#4653 CHANGES_REQUIRED（P1-1/P1-2/P2-1，均真库两态实证） | 全吸收（§1 行 4-5）；D5 residual：oauth ensureGrant 无锁翻位面 → 已由 P2-1 回退根治 |
| 终判 | — | **正式 verdict 悬置**：agent 于发终判时撞会话额度上限（截句「Prediction confirmed empirically」与吸收一致） | 证据链完整；此悬置如实登记，owner 会签时可要求补一轮独立审 |

Sonnet 侦察（restack 预案）全部命中：唯一真冲突 #4658、#4659 置尾省两次 rebase、全栈零 env/flag 触碰。

## 4. 两项合同级裁定（owner 会签清单）

1. **Rev 4.3 勘误已按 owner 指令落账**（#4646 锁文 §0.6 含 provenance）：每 event 仅一条源组织 `membership_changed`；`globally_clear` 只门控 grant/user。与 main 既有 W4-PRE-1d owner 裁决同轴，非新语义。**请 owner 终签。**
2. **OPS-01 行形制裁定 — 已被 Rev 4.4 取代（closeout 复审会签指令）**：复审裁定「OPS-01 暂不签——ledger 必须记录『grant 行从不存在到 disabled』的存在性变化，restore 时才能安全删除；不能仅调整 upsert 位置」。原「无条件 disabled 行、ledger 外写入」形制即复审 P1-2 的根因（从未有 grant 的人 rehire 后被孤儿 deny 行永久挡死 OAuth）。Rev 4.4（锁文 §0.7）改为**纯 effect 驱动**：creation effect（`grant_row_created=TRUE`）→ writer INSERT deny 行 → restore DELETE 恢复无行态；deny 闸本身不变（ensureGrant 仍 creation-only，被显式 disabled 行挡住）。**该项不再等 owner 会签原语义——按会签指令已重做。**
3. **OPS-01 supersede 残留的补偿路径（新增，对抗审 P2-1）**：deny 行的 DELETE 逆转仅在事件 `applied` 期间可用；被 supersede 后行成无证据残留（rehire/admin_force 均 `EVENT_NOT_APPLIED`，后续离岗不补证据）。此为 main 既有 supersede 合同的推论。**请 owner 裁定补偿路径**：残留 deny 行是否允许人工/运维清理，或引入「再证据化」机制。三开关 OFF 期间无生产暴露。

## 4bis. Closeout 复审吸收记录（2026-08-08，CHANGES REQUESTED → 修复）

| 判项 | 内容 | 修复 |
|---|---|---|
| **P1-1（T3 激活源权威）** | 仅 `sso`/显式 `directoryAccountId` 校验目录源；`temp_password`/`admin_no_password` 丢弃 `sourceOrgId`、直接信客户端 `orgId` → 可对 inactive 源静默开通 + 跨组织写 membership；单测 :44 还把「无源激活成功」钉成正控 | **所有激活模式**无条件解析并校验 active+linked 目录源；membership org 一律由 integration 派生，客户端 `orgId` 仅匹配校验（不符 → 409 `ACTIVATE_ORG_MISMATCH`，闭集错误表/HTTP/bulk 全链）；「无源成功」钉点翻转为拒绝 + 派生组织正控/错配负控/双组织 steering 负控 + 真库 fixture 补真实源 |
| **P1-2（OPS-01 不可逆 deny 行）** | disabled grant 行在 ledger 外无条件写入；restore 只逆转既有 effect → 无 grant 者离岗+rehire 后永久无法 OAuth | Rev 4.4 证据模型（锁文 §0.7）：`grant_row_created` 列（CHECK+immutability+拒降级 down）、planner creation effect、writer 纯 effect 驱动、restore DELETE；真库金标「无既有 grant → 离岗 → rehire → OAuth」全链 + creation-only ensureGrant 挡/放两态断言 |
| **P2（零 effect 语义分叉）** | 零 effect 早退跳过 bookkeeping upsert，与有 effect 路径 deny 语义相反；:450 测试不验 OAuth loginability | 语义统一（globally-clear 无行 ⇒ 必有 creation effect），两种零 effect 形态（deny 已在场 / not-globally-clear）均新增「运行前后 OAuth loginability 不变」真库断言 |

Mutation 六连杀（每条先证锚点命中、后证目标测试转红、cp 还原）：restore DELETE 分支、planner creation 规划、no-op 豁免、writer creation INSERT、`ACTIVATE_ORG_MISMATCH` 校验、激活源门控回退（原 P1 复刻）。

**独立对抗审 verdict（Opus，2026-08-09，绑 head 467ae34b57）**：**APPROVE-with-hardening，0 P1** —— 三条 refute-first 目标（T3 绕过 / writer 非 1:1 / restore drift）构造攻击后均未证伪；六条 mutation 独立复现全转红；immutability 函数与 20260728 版程序化逐行比对一列未丢；迁移在全新 DB 干净跑通且不在 9 处 MIGRATION_EXCLUDE。两条 P2 已落账：①**可逆性边界**——supersede（如管理员重新启用）后 restore 按既有门拒绝（`EVENT_NOT_APPLIED`），deny 行成无证据残留：锁文 §0.7 已按此限定措辞（main 既有语义，非本 PR 引入），补偿路径列入 §4 owner 清单第 3 项；②**双 ACTIVE 源 org 派生歧义**（今日无 web 调用点可达）→ follow-up #4833。层级事实：mutation (d)（writer INSERT）只有真库 golden 能杀（6666 unit 全绿）；mutation (f)（源门控回退）只有 unit 层能杀（grant-table 真库 17/17 仍绿）——两层缺一不可。

**#4833 落地记录（2026-08-10，PR #4843 — 本段不属于上面绑定 467ae34b57 的 verdict）**：org 派生改为对 active eligible 源**集合**匹配；无 orgId 且集合含多个不同 org → 409 `ACTIVATE_ORG_AMBIGUOUS`（错误闭集 14，HTTP leak 链全 14 驱动）；同 org 多源去重照常派生；空 org 源不参与投票（单独 fail-closed 测试）；审计 meta 记录实际落位 org（`membershipOrgId`）。双 org 真库金标故意选非 `da.id` 首行的 org，使 find-first 变异确定性转红（3/3），避免 uuid 排序掷硬币。

## 5. 过程事故诚实档（含撤回）

- **浅克隆祖先误判（已公开撤回）**：本地 shallow ⇒ `merge-base`/`--is-ancestor`/`log -S` 全体说谎，曾据此发布「main 历史被重写」；GitHub compare 证伪（behind_by=0），#4578 评论撤回，memory 落 `feedback_shallow_clone_ancestry_lies`。
- **「落后 #4799 一格」误诊（commit message 内更正）**：integration-guard 连红真因=sealed-export 把整个 `plugin-tests.yml` 摘要钉死（`evidenceFiles.pluginTestsWorkflow`）；每张改 run-list 的 PR 须按**自己的树**重钉，pins 基底取 main 侧（rebase 中 `--theirs` 是被重放旧提交——曾因此钉旧值一次，自纠）。
- **本地 battery 盲区两次兑现**：①未跑 orchestration 套件 ⇒ OPS-01 合同冲突到 CI 才暴露；②未跑全量单测 ⇒ P1-D 到 required 才红。此后每车固定「全量单测+目标真库+tsc+pin」四件套。
- **并集解冲突两次弄坏结构**：尾部双增吞括号（EOF）、`it()` 嵌套（"test inside test"）——修复后以套件绿+杀伤变异复核。
- **CI 环境事故**：push 事件未达 Actions（PR CONFLICTING ⇒ merge ref 建不出 ⇒ `pull_request` runs 整体静默——close/reopen 无效，rebase 解冲突即愈）；quay.io 拉镜像 reset（e2e）；「terminating connection due to administrator command」18.x 族（**#4820** 已立票：两实例+机理假说+修法方向）。
- **跨车道 armed thrash**：#4658 连续七轮在门全绿瞬间被 approval 车道落地打成 BEHIND —— memory「多 armed=O(n²) thrash」的活例；靠即时追平穿针，未升级 owner 干预。

## 6. 剩余与明确不在本收尾内（owner/ops-gated）

- **三开关全 OFF**（`docker/app.env.example`/staging 同；`dingtalk-closeout-env-contract.test.mjs` MUST_BE_OFF 钉住）：`DIRECTORY_PENDING_ACTIVATION_ENABLED` / `AUTH_LOGIN_USE_ALIASES` / `DIRECTORY_DEPROVISION_ENABLED`。
- **Canary**（alias → pending → deprovision，逐项可回滚）= 另令 ops GO；参见 `dingtalk-lifecycle-canary-separate-go-20260724.md`。
- **U1-U13 验收表**、**Transfer T3-T5**（生产 adapter 仍未开发，双 corp T2-Gate verdict TBD）——收官列车步 6/7，独立于本线。
- 评审 P3 残留已分派未消：run stats 中 skip 可见性已加（`skippedCandidateCount`）；`restore_mode` 写入随 #4655/#4656 落地；deprovision 候选查询的全表扫描优化（P3 性能项）与 `syncLegacyAdminProfile` 锁外写（P3）留作后续小票。
- codex 于 #4662 附带的 `dingtalk-lifecycle-development-closeout` 文档随车合入——**本 MD 为收尾权威记录**，如两者表述冲突以本 MD 与锁文为准。

## 7. Memory 落账

`feedback_shallow_clone_ancestry_lies`（新增）；本线 project memory 待随会签更新至「代码侧收尾完成」。
