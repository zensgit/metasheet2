# 数据库及系统对接线 — 文档与验证设计批次 · 开发及验证 MD — 2026-07-17

> 批次授权：owner /goal（2026-07-17）——「可以立即开发，但限定为文档和验证设计，不碰 RC-A 运行时」，
> 三项定序：P4 原子性设计锁 → #4194 决策单刷新 → supertest 小型验证切片。
> 本批次**零运行时产品代码变更**，不影响 RC-A（#4437）的 exact 包 SHA `d87e086fd1…`
> （RC-A 当日状态：顾问私下配置 approved source config + 实体机原包重跑，纯操作侧等待，与本批次零交集）。

## 1. 交付物台账

| # | 交付物 | 落点 | 状态 |
|---|---|---|---|
| D1 | **P4 persist 原子性设计锁（PROPOSED，四方案比较）** | PR **#4452**（`claude/stock-prep-p4-atomicity-design-lock-20260717`，`docs/development/stock-preparation-p4-persist-atomicity-design-lock-20260717.md`，两 commit：成稿 `d0b382fa9` + 校验修正 `af301092d`） | OPEN，未 arm，等 owner ratify |
| D2 | **#4194 决策单刷新 + owner 表决单** | PR #4194 分支 head **`2aa439dbc`**（§7 OD-E1..E6 + §8 OD1..OD6，四列：证据/选项/推荐/批准影响；沿用既有编号，未造第二套） | 已 push + 表决说明评论，等 owner 逐行表决 |
| D3 | **supertest 串台根除验证切片** | PR **#4454**（`tests/utils/pinned-server.ts` + 3 契约测 + 3 个 #4154 具名 flaky suite 迁移 + 25×2 压力 A/B） | OPEN，未 arm，等 owner 批量迁移 GO/NO-GO |

## 2. 方法与模型分派

- **理解阶段**：两个并行 Understand 工作流共 7 个读代理（persist 写序与崩溃窗口 / substrate 事务能力 /
  读侧消费端 / 词表与既往裁决 / OD1-6 证据 / OD-E1-6 证据 / supertest 侦察）；其中词表-裁决读代理撞
  session 限额，由主循环以定向 grep 补齐（T3b OD-4 权威文本、crash-injection 先例、文档既往表述）。
- **成稿**：设计文档与表决单由主循环（Fable）撰写；机械面（3 个 suite 的传输层迁移）交 3 个 Sonnet
  代理并行执行，逐文件回报前后计数。
- **对抗校验**：D1 三视角（引用审计 / 推理重推导 / 完备性+治理，high/xhigh effort）+ D2 单代理引用
  审计（xhigh），全部对真实代码在锚定 SHA `9048c27e2` 上 refute-first 核验（不信工作区、不信文档自述）。
- **压力验证**：D3 本机 25 轮 × 2 臂全量 `tests/unit`（retry=0），两臂**串行**执行以避免跨臂临时端口
  污染测量。

## 3. 验证结果

### D1（P4 锁）
- ~60 处 file:line 引用逐条对代码核验：**0 P1**；2 P2 + 3 P3 + 5 NIT，全部已修（`af301092d`）：
  - P2-1：patch 竞态序列化误归因给 `fenceWriterEntry`——实为 flag-gated no-op
    （`MULTITABLE_ENABLE_WRITER_FENCE` 默认 OFF），真实收敛机制 = 行级 UPDATE 锁 last-writer-wins；
    结论存活且反向强化方案 A；
  - P2-2：对比矩阵 B×CW4-first 与正文不一致——已在 §4 钉死终笔标记位置（project upsert 之后）并对齐
    矩阵，同时补记 B 的再入补标会把 CW4-existing stale 指针再静默化；
  - 另按完备性审补齐方案 A 的落地/迁移姿态段（共享 persist 两口同切 + OD-4 式非 inert 纪律）。
- 锁文沉淀了三条**此前未记录**的现状事实（均已核）：CW4-existing 崩溃窗口的静默 stale project
  pointer（200 skipped_existing，无任何观测面）；diff current/base **无服务端完整性门**（孤儿可当
  base 幻造全 added 差异，仅 FE 禁按钮）；check-then-create TOCTOU 双写对 batch key / project 的
  **永久毒化**（无修复路径）。三条均进 §9 与方案选型正交的微硬化菜单（H-1/H-2/H-3），单独交 owner 裁。

### D2（#4194 表决单）
- 新增内容单代理引用审计：**0 P1**；2 P2 + 2 P3 + 1 NIT，全部已修（`2aa439dbc`）：
  - P2-1：「唯一外写机制 = C6」范围过宽——已限定为「唯一带 dry-run→gated-apply 门的外写机制」，
    并明示既有 K3 写路径（pipeline upsert/Save/Submit/Audit）属 pipeline 线、config-gated、即 §4
    的 C4 gated pool 项；
  - P2-2：`category_rule`「全仓唯一命中」计数错（9 处词表/类型回显）——改述为「服务端实现面唯一
    命中 = 词表常量，无任何逻辑分支」。
- 证据修正沉淀：OD4 的取整机制**已建但惰性**（none/ceil/floor/nearest/pack_size + minimum floor，
  默认 none、仅用户手输）——裁的是品类默认表，不是机制本身；OD6 现状全 blocking 已完整实现，
  **owner 可零成本直接 ratify 关闭**。

### D3（supertest 切片）
- helper 契约测 3/3（端口跨测试稳定 / setApp 逐测试换 app / 缺 setApp 响 500 不挂起）；
  三个迁移 suite 前后计数逐一相等（17/33/11），diff 纯传输层，迁移后零 `request(app` 残留。
- **压力 A/B（25×2，retry=0，全量 lane）**：

| 臂 | 代码 | 红轮 | 受害 suite（6 轮 6 个不同文件，无重复，均非迁移对象） |
|---|---|---|---|
| 基线（main `9048c27e2`） | 未迁移 | **3/25** | snapshot-labels-authz · approval-template-routes · correlation+plugin-runtime-teardown |
| 迁移后（#4454） | 迁移 3 suite | **3/25** | approvals-bridge-routes · multitable-ai-usage-summary-route · plm-workbench-bom-multitable-routes |

- 6 轮红逐一核对错误签名：socket hang up / ECONNRESET / 405-非预期状态（含 `expected 200 got 405`
  的打错 app 铁证）——全部归入串台类，无其他根因混入。
- **三个迁移 suite 在 50 轮全量运行中 0 失败**——积极统计证据 + 机制论证（绑定期内其请求只达
  自己的 app），**不作结构性免疫表述**（round-1 更正：suite 首次绑定仍可能复用刚释放的端口、
  成为迟到请求的目标——collider 角色从逐请求降为每 suite 至多一次，非归零）。
- **诚实结论**：部分迁移**不降低** lane 级串台率（受害者在剩余未迁移文件间轮转）——
  根除必须批量迁移；在此之前 `retry:2` 仍然必要。（3/25 与 #4169 的 2/25 均为单样本率，
  不据以推断趋势。）

## 4. 诚实边界（本批次未做 / 未证）

- P4 锁是 **PROPOSED**：未 ratify、未实现任何方案、H-1/H-2/H-3 微硬化未实现；crash-injection
  证据是实现 PR 的门，不是本文档的交付。
- #4194 十二行决策**均未表决**；OD1/OD3/OD4/OD-E1/OD-E2 需客户数据，仓内无法自决。
- D3 未做批量迁移（~460 站点）；lane 级红率未降是预期结果而非缺陷；压力 A/B 跑在本机
  （darwin），CI runner 上的绝对比例可能不同（机制同类，#4169 已在 CI 侧证过同型签名）。
- 本批次三个 PR 均**未 arm**——合并/表决/选型全部留 owner。

## 5. Owner 待决清单

1. **#4452**：ratify P4 选型（推荐倾向 = A 组合事务 + 一次性 C 清理工具）+ §10 五个决策点
   （含落地姿态与 H-1/H-2/H-3 是否先行）。
2. **#4194**：§7/§8 逐行表决；**OD6 可当场零成本 ratify 现状**；OD-E6（feasibility gate 协议）
   同样零代码可批。
3. **#4454**：批量迁移 GO/NO-GO（GO 则 ~460 站点按已证 recipe 机械展开，例外模式已编目）。
4. （非本批次）RC-A #4437：等顾问配置 + 实体机回贴，回贴后按六判据复核。


## 6. Owner review round-1（2026-07-17）判决与修正落点

| PR | 判决 | 修正（本轮已落） |
|---|---|---|
| #4452 | REQUEST_CHANGES，暂不 ratify；方向条件接受 A+一次性 C，硬切换，H-1/H-2 先行，H-3 为 A 前置，T3a 另审 | §3 方案 A 重写为**受限 unit-of-work**（key lock/锁内复检/replay 判定/create-or-patch/revision 全在同一事务）；§9 H-1/H-2 升为先行必修、H-3 定为 A 前置；§10 决策点按裁定收敛 |
| #4194 | REQUEST_CHANGES | OD2 行改判：`category_rule` **非安全状态**（FE 可选 + 匹配器尾部兜底 ≈ manual，`material-match.cjs:116-136`）→ 三选一交 owner，推荐服务端 fail-closed 先行；§0 台账日期更正（首次 PASS=corrective-7 07-12，最终收口=corrective-6 rerun，#4101 CLOSED=07-17）；PR body 同步更正；owner 预决五行已注记（待正式回帖生效） |
| #4454 | 代码 APPROVE；批量迁移有条件 GO（分批 + AST 防回归 + 保留 retry:2） | 新增 AST tripwire + 冻结基线（**45 文件/636 站点**，drain-only）+ 可复现压力入口 `scripts/ops/supertest-crosstalk-stress.sh` + 原始 A/B 证据 MD；PR body 撤回「结构性免疫/不再是 collider」表述 |
| #4456 | HOLD，最后合并 | 本 v2：§3 过强结论更正（结构性免疫→统计+机制；删站点增长推断）+ 本节判决台账 |

四分支均已 rebase 追平 main 等 fresh-green；仍全部未 arm。

---

# 批次 2（同日）：round-1 判决解锁的 runtime hardening + wave-1 · 开发及验证

> 授权：owner round-1 判决（H-1/H-2 先行必修、H-3 为 A 前置、category_rule 不能静默接受、
> #4454 批量迁移有条件 GO）+ owner /goal「完成所有开发」。全部 PR 未 arm。
> 模型分派：H-2/H-3 主循环（Fable）；H-1/OD2 实现代理（Fable 档，详规格）；wave-1 三个 Sonnet
> 机械迁移；对抗校验 3×xhigh + 1×high 独立代理（可跑测试、独立复验 mutation）。

## 7. 交付物台账（批次 2）

| PR | 内容 | 关键证据 |
|---|---|---|
| **#4460** | H-2 stale 指针 409 + H-3 显式行数上限（persist hardening）——**round-3 后 HOLD 复审中，非闭合** | 38/38；CW4-existing crash-injection 复现；4 处 mutation 逐字 RED；R3 修复=单调守卫扫**项目全批次历史**（完整孤儿批次绕过已堵，owner 复现的 V1→V3崩→V2 序列现 422 零写） |
| **#4461** | H-1 diff 服务端完整性门——**round-3 后 HOLD 复审中，非闭合** | 22/22；双端点双侧 gated；R3 修复=current/base/run 恰好一行（重复业务身份 twin 绕过已堵，409 `{reason:'ambiguous'}`） |
| **#4463** | OD2 category_rule fail-closed（4 执行点 + FE 摘除） | 全插件链绿 + vue-tsc 0；两引擎守卫 + 输入边界 422 + confirm-existing 422；mutation 逐字 RED；「唯一映射为 category_rule 的行从静默匹配退化为可见 HELD」= 有意 fail-closed 方向 |
| **#4462** | wave-1 批量迁移（stacked on #4454）：10 suites / 280 站点 | 基线 636→356（drain-only tripwire 锁定）；全量 lane 5658/5658 @ retry=0；对抗采样审 APPROVE |

## 8. 对抗校验轮（refute-first，两个 P2 被验证者端到端复现后修复）

- **#4460 R2-P2-1（真界 24,999）**：完整性只能靠短页证明——25,000 行恰好 50 满页，建得进去但
  **永远无法 exact replay**（验证者实跑复现）。修：`PERSIST_MAX_PLAN_LINES = 500×50−1` + 界上
  create-then-replay 测试（分页 fake）。
- **#4460 R2-P2-2（默认版本空转）**：snapshotVersion 处处默认 1，等版本对比永不判 stale——
  CW4-existing 在默认路径上仍静默。修：**create 路径单调版本守卫**（重复 sync 版本 ≤ 指针批版本
  → 422 `PERSIST_VERSION_NOT_MONOTONIC`，写前拒绝）+ replay 等版本异 run（仅存量退化数据可达）
  → 409 `pointer_unresolvable`。行为注记：省略版本的重复 sync 从此响亮失败（读侧本就假设单调）。
- **#4461 P3**：ghost current + 孤儿 line 行的残缝已闭（幻造 all-added diff → 409；空 ghost 保持
  #4002 graceful 锁形状）。
- **#4463 R2-P2×2**：stored-status 短路先于守卫（legacy version_conflict 行仍参与）→ 守卫前置，
  两引擎同步 + mutation RED；confirm-existing 分支漏验存量行（可制造死确认行）→ 422。
  P3：FE 读侧类型加回 'category_rule'（读词表 ≠ 写白名单）；junk 值 400→422 变化已注记。
- **#4462**：APPROVE（4 个最险文件全 diff 审 = 纯传输；1 NIT setApp 收进 beforeAll 已修）。

## 9. 诚实边界（批次 2）

- H-2 的判别器在**版本单调纪律下**成立——round-3 后该纪律由 create 守卫以**项目全批次历史最大
  版本**强制（此前仅比指针版本，可被完整孤儿批次绕过，owner 复现后已修）；存量乱序版本/歧义
  身份数据的 replay 与 diff 一律 fail-closed（409），不静默、不修复。
- OD2 选择了 fail-closed 方向：唯一映射是 category_rule 的行从「静默宽匹配」变「可见 HELD 异常」，
  是行为变更（有意、已注记）；品类规则真实现（选项③）仍留 owner 未来设计门。
- wave-1 后剩 356 站点/35 文件（含 5 个参数化 builder 例外文件）；`retry:2` 保留至基线清零。
- 四个 PR 全部未 arm；与 RC-A（#4437）零交集（纯等待实体机）。

## 10. Owner 待决清单（批次 2 增量）

1. #4460/#4461/#4463 审合（其中 #4460 的单调版本纪律是新的 422 面，值得单独看一眼）；
2. #4462 合并时机（stacked，等 #4454 先合后 retarget）；
3. wave-2+（剩 356 站点，例外模式清单已备）按同 recipe 继续的节奏。


## 11. Round-3 复审与合并序（owner 裁决执行记录）

- **#4460 HOLD→R3 修复 `4ffd329d8`**：单调守卫改为项目全批次有界最大版本扫描（`readProjectMaxBatchVersion`，
  fail-closed `history_unprovable`）；crash 序列测试（V1→V3 崩→V2 拒→V4 通）+ mutation RED。等 owner 复审。
- **#4461 HOLD→R3 修复 `0c7d178c4`**：current/base/run 恰好一行否则 409 `ambiguous`（闭词表
  {incomplete, ambiguous}）；双端点重复身份测试 + mutation RED。等 owner 复审。
- **#4463 GO @`5db599796`**、**#4454 GO 先合**、**#4462 条件 GO**（#4454 合后 retarget→main + 全量
  required CI）、**#4456 最后合**——按裁决执行，结果见合并记录。
