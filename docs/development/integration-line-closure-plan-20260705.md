# 数据库及系统连接线(#1709)— 收尾规划 — 2026-07-05

> 基于四路深读(#1709 全 150 评论时间线 / origin/main 代码实况审计 / 8 份设计锁与账面文档去重 /
> 卫星 issue 扫描)。本文是**规划,不是授权**——每个 🔒 项仍需其标注的门;✅ 表示已完成;⬜ 表示
> 已解锁可执行。

## 0. 收尾定义(DoD,三层)

这条线"收尾"= 三层同时成立:

- **A 能力关键路径**:组合链(material→内码→BOM 号)在实体机 **BL4 复跑 PASS**,或 owner 显式
  声明二跳能力 out-of-scope 并按该口径改写 close-out。当前组合链已实跑一次、**败于第二跳**
  (BL0/caseB:缺 `BOM/GetList` 按内码的 standalone 读),在 BL2+BL3 standalone PASS 前,
  组合线必须保持"非实体机 PASS"口径(BL0 锁明文)。
- **B 质量收尾**:本线的安全声明有 CI 兜底(见 §3——**当前不成立,是本规划最大发现**)、
  stale 注释清零、文档账面与 main 一致。
- **C 治理收尾**:#1709 关闭重组(body 级 DoD 已满足,残余 gate 迁至卫星 issue)、gated 池以
  "冻结即完成"口径显式声明。

## 1. 现状矩阵(审计基线 @ `4c376b8e4`,2026-07-05 深读时点;非当前 main HEAD)

| 面 | 状态 | 实体机验证 |
| --- | --- | --- |
| 读自助化 S0-S3(配置→探测→审批→运行) | 全栈 wired(路由+client+UI+冒烟) | ✅ PASS(#3488,dbd3768d8) |
| C3 LIST / C4 BOM 读 | wired | ✅ PASS(#3390 / #3405) |
| resolver R0-R3 | wired + mirror | ✅ standalone PASS(17688041f) |
| 组合 C-R1→C-R4 + authoring 面 | 全栈 wired(#3553…#3621/#3625) | ❌ **二跳 FAIL**(BL0/caseB)——A 层主阻塞 |
| 组合冒烟 + runbook | 就绪(#3600/#3598) | 待 BL 链后复跑 |
| 写阶梯 W1 | **完全 latent**(仅 lib+迁移+测试;零 service 注册/零路由/零 client) | N/A |
| field-option sync | wired(stock-prep preset 限定) | 既有线验证 |
| 递归 / 写执行 / K3 Save-Submit-Audit / delete | 🔒 冻结(各设计锁) | N/A(冻结即完成) |

## 2. A 层 — 能力关键路径(BL 链,顺序依赖)

| # | 项 | 执行者 | 门 | exit criteria |
| --- | --- | --- | --- | --- |
| A1 ⬜ | **#3652 二跳读形状 probe**(S2-b 探测面,今天即可跑) | **owner(实体机)** | 无(已上线能力) | values-free 形状证据回贴(container located / keyField token / 目标字段在否) |
| A2 🔒 | **BL1** 契约/config/preset 元数据 | BL0 session | owner opt-in(A1 证据后) | 契约合并,零 runtime |
| A3 🔒 | **BL2** standalone 读 runtime | BL0 session | 单独 opt-in | 本地全绿 |
| A4 🔒 | **BL3** 打包 + standalone 实体机冒烟 | owner(实体机) | 单独 opt-in | standalone PASS 证据块(standalone-first 纪律) |
| A5 🔒 | **BL4** 组合 E2E 复跑 + close-out 更新 | owner(实体机) | BL2+BL3 PASS | 组合链 PASS;runbook #3598 附录回填 |

> 替代路径:owner 可随时声明二跳 out-of-scope → A 层改为"按现口径改写 close-out",A2-A5 冻结。

## 3. B 层 — 质量收尾(不依赖实体机,可立即做)

| # | 项 | 执行者 | 说明 |
| --- | --- | --- | --- |
| B1 ⬜ | **integration CI guard lane(最高优先)** | 我 | **深读确认:插件 CJS 测试链(read-source/probe/resolver/composition/write-target 全套)不在任何 workflow;mirror tripwire + 三面板/service specs 也零 CI**——"tripwire 变红"声明当前仅本地成立。补法照 repo 既有模式(approval/attendance-web-guard 定向 spec,不上全量 vitest 避 flake):新 `integration-guard.yml` = `pnpm --filter plugin-integration-core test`(CJS 链)+ 定向 vitest(mirror tripwire + 3 面板 + service specs) |
| B2 ⬜ | **W1 处置决定** | owner 决定,我执行 | 二选一:(a) 开 W2(dry-run 契约 + token,W1 从 latent 转活);(b) 声明"W1=契约层完成、runtime 冻结"为收尾态,写入账面。**不决定 = W1 悬空,不是合法收尾态** |
| B3 ⬜ | stale scope-fence 注释清理 | 我 | `read-source-read-runtime.cjs:13,:180`、`read-source-composition-planner.cjs:7` 仍写着"composition 未 gated 开放"等旧口径 |
| B4 ⬜ | 冒烟姿态声明 | 我(docs) | 读/组合冒烟为 dispatch-only、不链 deploy(仅 K3 冒烟 continue-on-error 链入)——作为**有意姿态**写入账面,或改链入(owner 决定) |
| B5 ⬜ | 单配置 read 路由无 UI 面 | owner 决定 | `POST /read-source-configs/:id/read` 仅冒烟脚本消费——声明"runtime-tier-only 即终态"或排 UI 供给(建议前者,一句话入账) |

## 4. C 层 — 治理收尾

| # | 项 | 说明 |
| --- | --- | --- |
| C1 ⬜ | **#1709 关闭重组**(owner) | body 级验收标准已全部满足(读/list 规范化预览、错误语义、redacted fixtures、adapter 测试、零写),2026-06-30 close-out 已宣"CLOSED at scoped deliverable"。建议:关闭 #1709,残余 gate 迁卫星——BL 链挂 #3652/BL0、resolver GATE-front 形状挂其自身线程、W 阶梯挂 W0 锁 |
| C2 ⬜ | 卫星 issue 处置 | #1711(关系注册表,休眠)→ 对照已交付 resolver/组合重新定界或关闭;#2777/#2438(runner 侧联通)→ 明确不卡 owner-run 路径,独立轨;#2642(Windows TEMP)→ 工效项独立轨 |
| C3 ⬜ | gated 池冻结声明(收尾文档一句话表) | REC-R1..R3(双门)/ connector 目录 / 事件入站 / 可视化清洗 / OAuth / marker-gating / delete(无解锁路径)/ 永久边界锁(host-allowlist 等)——**冻结即完成**,不计入未完成项 |

## 5. TODO checklist(可追踪)

```text
A 能力关键路径
  ✅ A1 #3652 probe(owner,实体机)— 三轮回贴定性 BL0/caseB;#3683 客户 K3 文档补齐完整契约
  ✅ A2 BL1 契约(owner opt-in "开 BL1")— #3689 7b9647f78 契约模块 + #3691 dev-verification MD
       附:pre-BL2 硬件验证 PASS(#3683,2026-07-06)——FPercentItemID 过滤/Data.DATA 容器/
       FBOMNumber 字段真机证过,BL1 唯一不确定点(byMaterialExampleInDocs=false)已消
  ✅ A3 BL2 runtime(owner opt-in "开 BL2" 2026-07-06)— #3695 1e18f85d5;#3691 §4 两约束落实
       (契约锁点全字段核对 + adapter 常量钉死 operator/body);对抗审阅 APPROVE 零 P1/P2;
       mutation 5/5 KILLED;runtimeValidated 仍 false(BL3 PASS 才翻真)
  🔒 A4 BL3 打包+standalone 冒烟(门:单独 opt-in;owner 跑;多 BOM 父物料预期 AMBIGUOUS,
       见 BL2 dev-verification MD §4)
  🔒 A5 BL4 组合复跑(门:BL2+BL3 PASS)
B 质量收尾
  ✅ B1 integration CI guard lane(我)— #3660 00108b4b8;lane 合后在 main 实跑 green
  ⬜ B2 W1 处置(owner 二选一 → 我执行)
  ✅ B3 stale 注释清理(我)— #3661 2ba7133de
  ✅ B4 冒烟姿态声明(我 docs)— #3661 §8.1
  ⬜ B5 :id/read 无 UI 声明(owner 一句话)
C 治理收尾
  ⬜ C1 #1709 关闭重组(owner)
  🔄 C2 卫星 issue 处置 — 分析半(我)已完成:#1711 = superseded-or-narrow triage(reference-mapping DF-T3 + resolver/composition 覆盖,建议 close/收窄)已贴;#2777/#2438/#2642 = 独立 infra 轨不卡 owner-run。剩 owner 侧 close/keep 决定
  ✅ C3 gated 池冻结声明表(我)— #3661 §8.2
```

> checklist 同步(2026-07-06):B1 已随 #3660 落地(该 PR 未回改本表)+ C2 分析半完成——本次补记以保权威地图与 main 一致。
>
> checklist 同步 #2(2026-07-06 晚):A1/A2 补记完成——BL1 契约 #3689 + dev-verification MD #3691
> 落地,且实体机 pre-BL2 硬件验证 PASS(#3683)。A 层剩余全部为 owner opt-in 门(A3"开 BL2"即可
> 开工)。B/C 层剩余(B2/B5/C1/C2 残余)全部为 owner 决定项,无"我方可单独执行"的未完成件。

**建议起手序**(并行三轨):A1(owner 实体机)∥ B1+B3(我,今天可完)∥ B2/C1 两个 owner 决定
(异步定即可)。A 层其余按 BL 门渐进;全部勾完后出最终《收尾报告 MD》并关线。

## 6. 模型分派预案

| 件 | 分派 |
| --- | --- |
| B1 CI guard workflow(YAML+定向 spec 选择,防 flake 上门) | Fable-5 主循环(踩过 web-guard 模式与 flake 教训) |
| B3 注释清理 / C3 冻结表 / B4 姿态声明 docs | Sonnet agent + 质量闸 |
| BL1-BL2(若 opt-in) | BL0 session(不抢 lane) |
| W2(若选 (a)) | token-helper 提升=Fable 亲写;预览 evidence 机械件=Sonnet |

## 7. 边界(本规划零开门)

递归/写执行/K3 Save-Submit-Audit/delete/生产写全维持冻结;BL1+ 仍待 opt-in;本文档 authorizes
nothing。

## 8. 姿态声明与冻结清单(B4/C3 落实,2026-07-05)

### 8.1 冒烟姿态声明(B4)

读自助化(#3481/#3484)与组合(#3600)的 postdeploy 冒烟均为 `workflow_dispatch`-only 独立 lane,
**不**链入 docker-build 部署 job——当前仅 K3 冒烟以 `continue-on-error` 链入该部署 job。这是**有意
姿态**,而非遗漏:

- 这两条冒烟都需要实体机(entity-machine)K3 凭证 + owner 提供的样例 key 才能跑出有意义的结果;
  没有这些,冒烟要么被跳过、要么只能验证纯 mock 路径,起不到部署门禁的作用。
- 因此它们的定位是 **owner 手动验收通道**,不是部署 gate:owner 在具备凭证/样例 key 的窗口内按需
  `workflow_dispatch` 触发,把结果作为实体机验证证据的一部分(参见 §2 A 层 BL 链)。
- 若未来要把它们改链入部署 job(例如补齐了可在 CI 中安全使用的凭证注入机制),那是一个**独立的
  owner 决定**,不在本次收尾范围内,也不由本文档隐含授权。

### 8.2 gated 池冻结清单(C3)

以下每一项均处于其各自设计锁/门禁下的冻结态。**冻结即完成**——这些项不计入本线("数据库及系统
连接线 #1709")的未完成项;解锁需要各自标注的门(named demand / opt-in / owner 显式再决定),本文档
不解锁其中任何一项。

| 项 | 门 | 说明 |
| --- | --- | --- |
| REC-R1 / REC-R2 / REC-R3(递归展开) | 双门:named demand + opt-in | 参见 `integration-read-source-recursive-expansion-direction-design-lock-20260705.md`;二跳以上的递归组合链仍待具名需求 + 显式 opt-in |
| connector 模板目录 | 各自 design-lock 先行 + opt-in | 属于对标基准(benchmark §4)中列出的待办能力,尚无设计锁 |
| 事件驱动入站(event-driven inbound) | 各自 design-lock 先行 + opt-in | 同上,benchmark §4 |
| 可视化数据清洗(visual data prep) | 各自 design-lock 先行 + opt-in | 同上,benchmark §4 |
| OAuth / SaaS 连接器 | 各自 design-lock 先行 + opt-in | 同上,benchmark §4 |
| marker-gating enforcement | 已在 S1 递延(deferred at S1) | 非本线当前范围;沿用 S1 阶段的递延决定 |
| delete 轨道 | W0 锁中硬排除(hard-excluded),无解锁路径 | 当前无 unlock path 定义,不在任何 opt-in 序列中 |
| K3 Save / Submit / Audit + 外部/生产写 | 客户明令禁止(customer-barred);需显式授权 + sandbox-first | 与 BOM→stock-prep 轨的 C4 同口径:仅当获得显式授权且完成 sandbox 验证后才可能重新评估 |
| 永久边界锁:host-allowlist 放宽 | 需显式再决定 | 现状为永久锁,非"待办",重开需专门决策 |
| 永久边界锁:终端用户自由表单连接器(end-user free-form connector) | 需显式再决定 | 同上 |
| 永久边界锁:按系统凭证路径(per-system credential path) | 需显式再决定 | 同上 |
| 永久边界锁:组合深度 > 2(composition depth > 2) | 需显式再决定 | 现有组合链锁定为两跳(C-R1→C-R4);超过两跳属于永久边界锁范畴,与上面的递归展开条目(REC-R1..R3)共享同一物理限制但走独立的再决定路径 |

## 9. B2 / B5 处置 + C2 收口(owner 委托执行,2026-07-06)

Owner 委托处理下述决定;均取**"声明现状为终态、不建新东西、可逆"**口径(要推进各自仍是随时的单独 opt-in)。

### 9.1 B2 — W1 写自助化处置:contract-layer 完成、runtime 冻结(终态)

W1(#3548 711bac2c4)= write-target config model + validator + 迁移 064 + 测试,**完全 latent**(零 service 注册/零路由/零 client)。当前无 named 写需求,且**生产外部写客户明令禁**(2026-07-03)。处置:

```text
W1Disposition=contract_layer_complete_runtime_frozen (freeze-is-done)
W2W3W4=各自单独 opt-in;仅当出现 named 写需求 + owner 显式开 W2 时启动
不计入线未完成项(与 C3 冻结池同口径)
```

W1 作为契约层就绪、runtime 冻结,是本线**合法收尾态**,不是欠账。

### 9.2 B5 — 单配置 read 路由(:id/read)= runtime-tier-only 终态

`POST /api/integration/read-source-configs/:id/read` 仅供运行时/清洗层消费(冒烟脚本覆盖),**无 UI 供给面**。处置:

```text
idReadDisposition=runtime_tier_only_final
无 UI run affordance 为有意终态(该路由是运行时消费 API,非顾问配置面);冒烟通道已覆盖
```

### 9.3 C2 收口

```text
#1711=CLOSED as superseded(2026-07-06)——reference-mapping DF-T3 + resolver/composition 覆盖;PLM 图号→ERP 映射角度归 EII-R0
#2777/#2438/#2642=独立 infra/devops 轨,不卡 owner-run 收尾
现场契约缺口=独立 issue #3683([现场/客户] K3 BOM/GetList API 请求契约,BL1 前置)
```

### 9.4 C1 精化(修正 §4 的"现在关 #1709"建议)

**#1709 暂不关**——它是**实体机 + BL 轨的活协调锚点**:实体机 poller 读 #1709、二跳 BL 轨(#3683 契约 → BL1..BL4)仍在推进。**关线时机 = 二跳 BL 轨结论(PASS 或显式 out-of-scope)之后**,届时 body-DoD-met + 残余 gate 全迁卫星(#3683/BL0/EII-R0 #3674/W0/REC-R0)再一次性关闭。现在关会切断实体机协调、且已被 #3388 先例证明"过早关会重开"。

### 9.5 §5 checklist 推进(2026-07-06)

```text
B2 ⬜→✅(9.1 冻结声明)  B5 ⬜→✅(9.2 runtime-tier-only 终态)
C2 🔄→✅(9.3:#1711 closed + 现场契约 #3683 + infra 轨 disposition)
C1 保持 ⬜——精化为"待二跳 BL 轨结论后关"(9.4)
```
