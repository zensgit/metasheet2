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
- **三个迁移 suite 在 50 轮全量运行中 0 失败**，且按机制结构性免疫（`request(baseUrl)` 永不
  listen，suite 端口全程占有）。
- **诚实结论**：部分迁移**不降低** lane 级串台率（受害者在剩余 ~460 站点/39 文件间轮转）——
  根除必须批量迁移；在此之前 `retry:2` 仍然必要。基线红率 3/25 略高于 #4169 时的 2/25，
  与站点从 ~495 涨到 546 一致。

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
