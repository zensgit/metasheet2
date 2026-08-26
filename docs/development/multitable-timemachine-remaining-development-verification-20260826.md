# 多维表 Time Machine 剩余开发与验证记录（2026-08-26）

> **状态：DEVELOPED AS DRAFT CARRIERS / NOT MERGED / NOT ENABLED。**
> 本轮把当前 `origin/main` 上仍可在安全边界内完成的 Time Machine 前置修复、迁移重放证明与
> Phase D1 设计锁分别交付；不把设计锁误写成归档运行时。所有 recovery flag 继续 default-OFF，
> 本轮未 dispatch、未部署、未触达 staging/production，也未替 owner ratify E1 或 Phase D1。

## 0. 基线与结论

- 冻结审计基线：`origin/main@efbf0a931cd6529703a91c9c0053d4cae8217abe`。
- L1 已在 main 关闭，权威证据为
  `docs/development/multitable-timemachine-l1-closure-20260826.md`；本轮不重开 L1。
- E1 仍是 `PROPOSED / HOLD`。本轮未启用 writer fence、strict、checkpoint activation、
  Revert、PIT Reset 或 retention。
- 本轮完成四类可自主交付物：checkpoint causal floor、retention 与 destructive recovery
  互斥、Time Machine 迁移 down/up replay、Phase D1 durable archive 设计锁。
- Phase D2-D7 运行时没有开工：D1 必须先由 owner 以 exact content SHA ratify。这个停止点是
  设计锁纪律，不是开发遗漏。

**产品边界仍然成立：**归档只能保护捕获边界之后、尚有可信源数据的状态。tombstone 捕获启用前已
物理删除、或 retention 已永久清除且没有备份/外部归档的数据，不能由版本链凭空恢复。本轮 D1
设计的是“以后 retention 后仍可整表/批量恢复”的持久归档权威，不改写这个信息论边界。

## 1. 交付载体

| 载体 | 精确 head | 内容 | 当前边界 |
|---|---|---|---|
| #5190 | `8db637c02eb571d4d61c61a3b21ba776b60f819f` | required/非 required 证据口径诚实化 | Ready；comments/docs only；未合 |
| #5193 | `246aeeeded87c2c64f6a45b813ddc01bd9fa95d3` | retention 活跃时 Revert/Reset preview+execute fail-closed | Draft；flag OFF；未合 |
| #5194 | `8f1a9f5726f4875523ac21cef857223f8c8f38cb` | 12 条 Time Machine migration 的 down/absence/up/fingerprint replay | Draft；只加验证器/CI 接线；未合 |
| #5195 | `b08ddf6672b1e66c34803388746f3e423b0ebab0` | checkpoint-backed reconstruction 的 exact causal window | Draft；flag OFF；未合 |
| #5199 (Phase D1) | `7a5b3af50a6d02eeebf06b5cc3a2a55316a6f130` | retention 后 durable archive / bulk recovery 设计锁 | Draft；PROPOSED；无 runtime 授权 |

各载体都从同一基线分叉；单 PR 绿不代表组合态绿。最终 landing 仍须按 §6 重放并在组合 main 上跑
required CI，不能沿用旧 head 的绿灯。

## 2. Checkpoint causal floor（#5195）

### 2.1 修复的真实缺陷

checkpoint 只在“被选中”还不够：保留下来的 floor 以前的普通 revision 仍可能覆盖 trusted
baseline，令 preview 与 apply 对同一个 anchor 产生非因果结果。本切片统一成数据库选出的同一个
checkpoint，并只重放精确 bigint 窗口：

```text
trusted_since_seq < revision.seq <= anchorSeq
```

strict precheck 也收窄到同一 target window；malformed/duplicate seq、generation drift、live/trash
投影不一致全部 fail-closed。新增 baseline/live/trash 的 raw `data` 投影仅存在于内部 precheck，
对外返回仍只有 `{ ok, reason }`；raw-projection inventory 已明确归类并做反向变异。

### 2.2 证据

- fresh PostgreSQL 15，combined exact-anchor pack：`104/104`，`0 skipped`
  （apply `57/57`、route `28/28`、recovery `19/19`）。
- adjacent strict/history/mirror pack：`42/42`。
- CI source/wiring guard：`25/25`。
- raw projection guard：`3/3`；删除新 INTERNAL disposition 时恰好三处目标投影变红。
- TypeScript：通过。
- armed-without-DB sentinel：变异后按预期红；普通 no-DB 本地运行只允许显式 skip。
- 早期两轮独立对抗门曾分别对 runtime 与 raw-projection guard 给出 CLEAR；最终
  `b08ddf6672...` head 仍以本轮独立 Sol 复门为权威，见 §6。

第一次 exact-head required CI 在四个真实断言上失败，而不是 flake：两个测试把 post-anchor
变化误写进 target causal window，mirror fixture 又把同一记录既放进 checkpoint live baseline、又伪装成
checkpoint 后 create。修复测试模型后，新增一条独立 golden 钉住“post-anchor 最新 captured payload
必须等于当前 live payload”；两个判别变异分别让 target-gap 与 live-drift golden 变红。上述 `104/104`
与 `42/42` 都在修正后的 exact head 上重跑，不沿用失败前 head 的绿灯。

随后 Sol 复门又证明 phantom race 仍是假证明：其中一条 revision 还在 anchor 前，`scopeHash` 可先
拒绝，live-set guard 即使被删测试仍可能绿。最终 head 把 phantom 的 create/update 都放到 anchor
后，并直接断言两条 bigint seq 均大于 sealed endpoint；同时绕过 locked `liveHash` 与 fresh
`recheckHash` 两道检查后，该 golden 从预期 409 变成 200 而变红。恢复代码后六文件 `146/146`，
Sol exact-head 门才给出 CLEAR。

**保留边界：**`hashAnchorRecoveryScope` 绑定 record id、existence、version，尚不绑定 payload bytes。
本轮未发现可在不改变 version 的情况下修改 trusted payload 的应用写者，因此它不阻挡本切片，
但也不宣称这项 identity hardening 已关闭。

## 3. Retention 与 destructive recovery 互斥（#5193）

### 3.1 合同

当 `MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'` 时，Revert 与 PIT Reset 的 preview 和
execute 都必须拒绝；不存在“preview 可过、execute 再碰运气”的窗口。拒绝顺序保留 no-oracle：
请求形状、授权、sheet existence 与 preliminary full-read 在先，具名 retention conflict 在
trust/anchor/history 细节之前。

runtime、flag manifest、status 与 containment 全部使用 raw exact `1`，且 Revert/Reset 与
retention 的冲突边在 manifest 中双向登记。这里没有开启 retention 或 recovery，只修默认关闭
时的合同一致性。

### 3.2 证据

- hermetic manifest/status/containment/exact-anchor contracts：`114` passed。
- fresh PostgreSQL 15，全迁移后 Revert + Reset 整文件：`27/27`，`0 skipped`。
- focused route/retention：`55` passed。
- 四个 reciprocal-edge mutation 各自命中对应测试并变红。
- TypeScript：通过。
- 独立 Luna refute-first gate：CLEAR；另一次 clean-DB 复跑再次得到 `27/27`。
- exact-head required CI：见 §5，不用早期或邻接 head 的结果替代。

## 4. Migration replay（#5194）

### 4.1 覆盖面

验证器使用真实 12 个 Time Machine Kysely migration module：按逆序执行 `down()`，证明本线拥有的
table/column/index/constraint/sequence metadata/function/trigger 全部消失，再按因果顺序执行
`up()`，比较完整 catalog fingerprint，最后执行 ordinary migration-ledger no-op。

注入中途 down failure 时，验证器先恢复所有已 down 的 migration，再以非零退出；数据库 teardown
在最外层 `finally`，即使 cleanup 或 fingerprint 检查自身失败也会关闭连接。输出只含 code/count/
fingerprint，不打印 DSN 或数据库值。

required workflow 先跑 armed injected-failure，再以
`env -u TIME_MACHINE_REPLAY_INJECT_DOWN_FAILURE_AFTER` 显式解除同一步骤环境变量后跑恢复 replay。
hermetic guard 钉住注入在先、非零预期、显式 unarm、恰好两次 verifier 调用与逆序 down。

### 4.2 证据

- fresh PostgreSQL 15：down / absence / up / fingerprint / final migrate PASS。
- fingerprint：`6050a09de37790170e2e3244b9ddca025b60fbc6c5f3d460c4c785f30690ddfe`。
- 12 个注入点逐一失败后均能 cleanup，再 replay 得到同一 fingerprint。
- workflow 语义实跑：armed 命令非零并报 `injected_down_failure`；同 step 的第二命令只有在
  `env -u` 后 PASS。
- hermetic source/wiring guard：`28/28`；逆序变异被 required contract 拒绝。
- exact-head 独立对抗门：CLEAR，`0 P1 / 0 P2`。
- exact-head required CI：见 §5。

## 5. Phase D1 durable archive 设计锁

### 5.1 为什么只交设计锁

Phase D 跨越 retention、KMS、不可变对象、整表/批量重建、异步 job、token burn、legal hold 和
pruning。它属于新能力，按仓库纪律必须先锁定持久协议与失败语义，再写 runtime。D1 当前只产生
可 ratify 的设计载体；D2-D7 不因“模型有空”而越过 owner gate。

### 5.2 已锁定的核心约束

- capture 在单一 Repeatable Read 事务中完成关系快照，不在事务内做网络/KMS/object-store IO。
- D2-D7 的所有 KMS verb（含 unwrap、MAC/sign、verify）都必须在数据库事务外；短事务只能持久化或
  重新绑定预计算的 opaque 结果，transaction-depth spy 与反向变异为承重门。
- canonical sheet fence 在任何 sheet-scoped claim 的第一位；随后才是 key/generation/job/hold/object
  锁，避免与现有 writer/recovery 锁序形成环。
- 每个缺失 genesis head 使用独立 `section_bootstrap` operation id + seq、deferred composite FK 与
  dedicated seal；distinct parent `archive_snapshot` 使用更大的 seq，并在所有 child 后最后插入/封口。
  失败只留下允许的 seq gap，reservation 永不复用。
- `coverage_index` 是精确 section envelope，verified 后不可修改；prune 必须以整个 operation 为
  单位，普通 row-level age sweep 只能处理 `operation_id IS NULL`。
- config revision、field tombstone 与 link tombstone 都显式加入 operation graph；Phase-D writer 在同一
  事务写入共享 operation id，whole-operation prune 必须枚举这些 evidence rows 与 section event。
- archive membership 带 `sheet_id` 与复合 FK；bootstrap 必须在 quiescent/fenced 边界完成，不能
  由“现有对象大概属于该 snapshot”推断。
- AEAD catalog 记录 algorithm/key/wrapped-DEK identity/nonce；nonce 唯一性绑定 KMS-backed
  `dek_fingerprint`，registry 永不自动清理，不能靠删除 catalog 后复用 nonce。
- sync burn 与 async job-claim 分型；sync 在同一 L8 transaction 终结，async 只在 job terminal
  transition 终结，legacy provenance-null burn 不自动清理。
- zero-direct-event operation 的闭集恰为 `archive_snapshot` 与 `restore_aggregate`；两者使用不同
  membership/validator/seal，aggregate 的 `event_count` 是 children 之和，不能把最后一个 chunk 冒充终点。
- legal hold、KMS retirement/destruction 与 archive prune 各有明确锁序、引用检查和 fail-closed
  反向 golden。
- 归档 delta 必须进入 L8 既有 composed-map，禁止再造第二条“精确重建”权威路径。

### 5.3 D2-D7 依赖

| 阶段 | 仅在 D1 ratify 后允许的工作 | 退出证据 |
|---|---|---|
| D2 | archive writer、closed state machine、section history、operation graph 与 prune handoff | migrate up/down/replay、crypto reservation、distinct bootstrap operation/seq、deferred composite FK、dedicated seal、parent-last snapshot、whole-operation prune、drift-fail-loud |
| D3 | scheduled/manual recovery-point catalog、verifier、hold/key/object lifecycle | immutable verify、expired-only deletion、hold/key-retire race；object/KMS mid-state crash 后以 owner/fence lease 接管、复用 stable idempotency key、事务外 reconcile，unknown 保持中间态 |
| D4 | checkpoint + archived delta 的唯一 reconstruction authority | floor-aware exact anchor、完整 section state、bigint/generation mutation |
| D5 | restore planner、sync L8 kernel、async bulk job 与 burn/receipt protocol | schema/permission/live drift、anti-replay；sync 整事务零部分写；async 每 chunk 原子且 receipt 一致，失败显式 `abandoned_partial`、不广告 whole-job success |
| D6 | Time Machine picker、diff、scope 与 progress UI | preview-first、flag-OFF 不呈现可执行态、可访问性/状态机 |
| D7 | staging fault/scale/runbook + development/verification MD | 5k fence budget、observability、staging-only owner window |

Phase D1 Draft 为 #5199；文件 exact SHA-256 是
`19f10cd8d7259861c75ee6d82af4f421f29b875101a5a2a583c0a73c67009caf`。最终独立 Luna
refute-first 门为 CLEAR，`0 P1 / 0 P2`。这个结果只批准文本可供 owner ratify，不是 ratification；
D2-D7 仍不得开工或合并。

## 6. Exact-head CI 与组合落地纪律

| 载体 | 本地/独立门 | exact-head GitHub 状态（本记录提交时） |
|---|---|---|
| #5190 | diff/required-state 复核 | `18 success / 0 fail / 0 pending` |
| #5193 | CLEAR + fresh PG15 `27/27` | `39 success / 0 fail / 0 pending / 1 designed skip` |
| #5194 | CLEAR + replay/failure injection | `22 success / 0 fail / 0 pending / 1 designed skip` |
| #5195 | Sol exact-head CLEAR + fresh PG15 `104/104` + adjacent `42/42` | `39 success / 0 fail / 0 pending / 1 designed skip` |
| #5199 | Luna CLEAR；exact file SHA 已钉 | `18 success / 0 fail / 0 pending` |

`recovery-schema-drift` 与 hermetic observation-kit contract 是 live branch protection required；real-DB
observation execution lane 仍是非 required/path-filtered。文档不把后者写成 required。

三张 runtime/test PR 共享 `vitest.config.ts` 或 `multitable-exact-anchor-ci-wiring.test.mjs`。建议 landing
不是“同时点 merge”，而是由单一协调者逐张 replay：每落一张，下一张从新 main 重放并保留 run-list
**并集**，再跑 full required CI 与本 PR 的真库包。最终 combined-main 还必须再跑：

1. causal-floor combined pack `104/104`；
2. Revert + Reset `27/27`；
3. migration replay 正常腿 + injected-failure 恢复腿；
4. wiring/manifest/status/containment guards；
5. branch-protection required contexts 全绿（其中包括 Node 20、web-tests、
   `recovery-schema-drift`）；本线另要求非 required 的 Node 18 与 `migration-replay` exact-head PASS。

在冻结基线按 `#5190 -> #5193 -> #5194 -> #5195` 做过一次纯 Git 合成：四步
`merge-tree` 均 CLEAN，最终合成 commit 为 `2ffc62363f03384cad615e00fd6b49803dc1b781`，净增量
`26 files / +2243 / -216`。这个 exact 合成树又单独通过：causal/history/mirror 六文件
`146/146`、Revert+Reset `27/27`，以及 migration injected-down 预期非零后 cleanup + 正常 replay
PASS（fingerprint `6050a09de37790170e2e3244b9ddca025b60fbc6c5f3d460c4c785f30690ddfe`）。
`merge-tree` 只证明文本可合；行为结论来自这些实际命令，不能由 CLEAN 反推。
#5199 docs-only 随后作为第五步也 CLEAN，最终 tree 为
`b2d56a76a8824951bcbb5cf569a5cfd0eb1fed85`（`27 files / +3428 / -216`）；它不改变上述 runtime
行为包，因此没有拿 docs-only 增量重复冒充一次运行时验证。

## 7. 审批流程及自动化窗口协调

本轮开始时已向并行窗口发送 exact base、Time Machine reserved paths 与“单一 merge coordinator”约束。
最新协调快照中，对方 #5174/#5182/#5183 都是 approval 专属 docs-only 载体，另一个浏览器证据切片
只改 approval 专属 Chromium spec；它们均不修改本轮 migration replay、exact-anchor、retention、shared
writer/fence/flag、`plugin-tests.yml` 或共享 Vitest 清单。对方也已逐字确认避让三条 replay 写集。

若对方后续需要 shared migration、workflow、writer/fence 或同一 test manifest，必须先停在 Draft 并重新
分配所有权；不能靠最后一次 rebase 猜测合并。当前没有代码文件重叠，不构成本轮阻断。

## 8. 模型分派与证据纪律

| 角色 | 分派 | 实际结果 |
|---|---|---|
| 总体协调、基线/PR/CI/组合审阅 | Codex 主循环 | 负责最终事实与边界，不转包结论 |
| checkpoint causal floor | Sol | 实现；随后由独立门与主循环 mutation/真库复核 |
| retention 与 replay hardening | Terra | 实现/修复；由 Luna 独立门与主循环复核 |
| migration replay 初始尝试 | Kimi K3 | 会话长时间无可审编辑，终止；不计入交付证据 |
| Phase D1 初稿 | Grok 4.6 | 产出初稿；其内容经主循环多轮修正 |
| 独立对抗门 | Luna / Sol | findings-first；只把 exact-head CLEAR 记入结论 |

模型名不是质量证明。有效证明只有冻结 head、真实 call path、fresh DB、判别性负例/变异、required CI
与独立复核；代理自述未被主循环重验的内容不进入本记录的完成列。

## 9. 收口后仍需 owner 的动作

1. 审阅并决定 #5190/#5193/#5194/#5195 的逐层 landing；每次 main 前进后重放并复绿。
2. 审阅 Phase D1 Draft，以 exact content SHA ratify 或提出修改；ratify 前 D2-D7 不启动。
3. E1 继续独立 HOLD；Phase D1 ratify 不等于 E1 ratify，也不授权任何 staging/production flag。
4. 决定是否另立 `hashAnchorRecoveryScope` payload identity hardening；它不是本轮隐式完成项。
5. 决定后续产品范围：只做 retention 后归档恢复，还是再立 T-state 浏览、整表 resurrect、跨 sheet
   原子恢复。#4205/#4224 等 parked 载体不因本记录自动复活。

## 10. 本轮明确未做

- 未 merge/auto-merge/undraft 任何 runtime PR。
- 未 dispatch workflow、未 SSH、未部署、未改 staging/production。
- 未 enable trigger，未设置任何 recovery/retention flag。
- 未对 E1 或 Phase D1 自行 ratify。
- 未声称恢复无来源的历史物理删除数据。
- 未把 D1 设计交付冒充 D2-D7 runtime、UI、benchmark 或 staging acceptance。
