# PLM <-> ERP 物料主数据对账 V2 Charter（PROPOSED）— 2026-07-19

> **状态：PROPOSED / doc-only。** 本文把备料通用化计划的下一开发目标收敛为一个真实的
> 第二场景：**PLM <-> ERP 物料主数据对账**。本文不授权运行时代码、迁移、路由、开关、
> 实体机重跑或外部写；运行时实现须等 §10 的 owner 决策与 Charter ratify。
>
> **代码锚：** `origin/main` `d83cf5875f517c3046eb43b37ab83da9e9d2fef9`（rev-5 刷新；较 rev-3 锚
> `698997cf8…` 仅多一笔 attendance 文档提交 `#4492`,stock-prep / integration-core 面零变动;
> rev-2 锚 `2590704f1…` 的唯一受检面变更为 `approval-fwb-decision-values.ts`（审批 FWB 线、非
> stock-prep）;claims 逐条仍成立；rev-1 锚 `e20907b64…`）。
>
> **rev-2（2026-07-19，owner 两轮 REQUEST_CHANGES 全量吸收）：** ①角色化来源 + 场景绑定版本 +
> 受控换绑（§2.3/§4.5）；②六桶身份分类替换初稿 diff 词表，重复键语义统一为「桶级 fail-closed、
> 非整跑失败」（§4.6，P2-1）；③active binding 由数据库权威保证唯一（§4.1，058 先例）；④激活 /
> run-start / commit 分层重验，commit 漂移拆「绑定选择漂移可记录 / 输入可信性漂移必中止」
> （§4.5，P2-2）；⑤血缘键与运行身份键分离 + 双指纹（采集证据 vs 语义内容）模型（§4.6）；
> ⑥切片统一为 D 序并修正排期（§7）。
>
> **rev-3（2026-07-20，owner rev-2 复审 2×P1 + 2×P2 全量吸收）：** ①分页完整 ≠ 时点一致：新增
> `sourceConsistencyProof` 闭机制集 + `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` fail-closed
> （§2.2/§4.3/§4.6，P1-1）；②外部系统身份 pin：`externalSystemVersionId` + `systemContentKey`
> 进绑定成员 / bindingFingerprint / run-start pin / commit 重验（§2.3/§3/§4.5/§4.6，P1-2）；
> ③active 权威与状态机解耦：**指针权威**单选（复合 FK；`active` 为派生谓词非存储状态；revoke
> 清指针同事务；partial-unique 变体明确不采用）（§3/§4.1/§4.5，P2-1）；④attempt 与语义 run 键
> 时间冲突：`attemptId` 建行即有，`runIdentityKey` NULL→commit 事务内一次落定 + 部分唯一索引，
> 并发同内容 attempt 落 `deduplicated` 终态 = exact-noop 机制（§3/§4.4/§4.6/§5，P2-2）；
> ⑤D3a 排期改为一致性证明选型后重估（§7）。
>
> **rev-4（2026-07-20，owner rev-3 复审 1×P1 + 3×P2 全量吸收）：** ①双扫摘要相等**不构成**
> 时点一致证明（ABA 撕裂反例入文），从证明机制移除、降为可选稳定性证据；闭机制收为三种
> （源侧快照事务 / 不可变快照 token / 全投影字段单调无 ABA 版本 pin），皆不合格的源 V1 不可用
> （§2.2/§4.6/§8.2-7，P1）；②dedup 冲突收束改 **claim-first 无抛错抢占**（23505 会废事务、
> 另开事务有卡死窗口）：写行前抢键，胜者独占 `runIdentityKey`，败者同事务落 `deduplicated`
> 且键永远 NULL，claim 持有者非终态 ⇒ `RUN_IDENTITY_CLAIM_PENDING` 可重试失败（**rev-5 已删除
> 该分支——见下 rev-5 ②**），`failed` 同事务释放 claim，冲突分支崩溃注入承重（§4.4/§5/§8.2b，P2）；
> ③外部系统身份定为
> **内容键单轨**：不引入无权威来源的 `externalSystemVersionId`（迁移 057 现实为可变行），
> 各层重验 = 当前重算 `systemContentKey` 对 pinned 值（§2.3/§3/§4.5，P2）；④确定性与换绑
> 边界冻结：排序元组长度前缀 + class 域分隔编码、invalid sentinel、multiplicity 读上界；
> revoke 切换预选替代版本 = 同事务完整 Activate 重验（§4.1/§4.6/§8.2b-15..16，P2）。
>
> **rev-5（2026-07-20，owner rev-4 复审 1×P1 + 3×P2 全量吸收）：** ①一致性证明**标记与页数据
> 原子绑定**：逐页回显不够,标记须为承载该页数据的同一次源读取的内在属性,旁路另取即不合格
> fail-closed（§2.2/§4.6/§8.2-7/§8.2b-17，P1）；②claim-first 的 PG 语义订正——`ON CONFLICT
> DO NOTHING` 遇并发未提交同键会**阻塞**（非「不等待」）,且 claim+complete 原子同提交使
> `RUN_IDENTITY_CLAIM_PENDING` 分支不可达;rev-5 **接受有界等待、删除 PENDING**,冻结 READ
> COMMITTED 下「胜者独占 / 败者见已提交 complete 持有者落 dedup / 胜者回滚则败者转正」三路
> （§4.4/§5/§8.2b-13..14，P2）；③§3 全清单补 `reconciliation_run_identity_claim` claim 表;
> ④`canonicalRowDigest` 确定性契约（字段序、类型标签、null·空·缺省三分、数字规范化不经浮点、
> NFC）列为 D1 必冻 + mutation 承重（§4.6/§8.2b-15b，P2）。
>
> **rev-6（2026-07-20，owner rev-5 复审 1×P2 全量吸收）：** claim-first 的「有界等待」从文字
> 承诺升级为**数据库强制硬边界**——claim insert 前 `SET LOCAL lock_timeout = <bounded>`,对手持
> 未提交 claim 且不推进(idle-in-transaction / 长写)时,败者的 insert 在上限内抛 `55P03`、commit
> 事务中止(claim 为首写 ⇒ 零 snapshot/diff)、以 `RUN_IDENTITY_CLAIM_BUSY`（retryable,§5 闭词表）
> 收束、由新 attempt 重试,绝不无限行锁等待。测试矩阵加「对手持未提交 claim」场景（§4.4/§5/
> §8.2b-14b，P2）。
> **上位规划：**
> `stock-preparation-generalization-and-scenario-packaging-proposal-20260717.md`。
> **相邻但独立的操作线：** RC-A `#4437` 保持既有 flag-OFF、values-free、操作侧门；本 Charter
> 不改包、不改 runner、不请求新 ON 窗口。

## 1. 目标变更

开发总目标从「继续扩充备料专用功能」改为两条互不阻塞的收尾线：

1. **操作线：** 保持 `#4437` 的 RC-A 实体机验收边界，由操作侧按现有指针执行或回贴；开发线
   不因等待实体机而冻结，也不修改该验收包。
2. **开发线：** 用第二场景证明哪些机制真的可复用。第一交付不是抽通用平台，而是先冻结本
   Charter；ratify 后再由第二场景逐刀拉动最小抽取。

成功不以「抽出最多代码」衡量，而以以下结果衡量：第二场景结构独立、stock-prep 行为不变、
共享边界由两个真实消费者共同证明、所有新执行面 default-OFF 且 `externalWrite=false`。

## 2. 场景定义

### 2.1 用户与任务

- **集成顾问 / 场景管理员：** 选择并审批两个只读源配置，配置精确身份键和冻结投影，运行
  完整性预检。
- **主数据治理人员：** 查看 values-free 的运行状态、差异分类和计数，决定是否进入后续受控
  值面审阅设计门。
- **运维 / 审计人员：** 依据闭词表状态、计数、不可变运行记录和失败原因判断是否可重跑。

V2 不面向备料计划员，不展示 BOM 展开、issueQty、备料异常或领料单位规则。

### 2.2 输入、处理与输出

**输入：** 两个 tenant-bound、approved 的只读源配置：

1. PLM 物料 / Item 主数据；
2. ERP 物料主数据。

两个源都必须声明可证明的分页 / 上界能力；未知能力、短页边界不可证、配置未批准、租户不一致
或响应 envelope 畸形均 fail-closed。V2 不把 stock-prep 内部缓存当作 ERP 源。

**分页完整 ≠ 时点一致（P1-1）：** 逐页读全只证明「读窗口内源给出的所有页都收到了」，不证明
这些页对应源的同一时点状态——页间的插入 / 更新 / 删除会把快照抹成时间涂层。因此每侧快照还须
携带 §4.6 的 `sourceConsistencyProof`（rev-4 三机制闭集：源侧快照事务 / 不可变快照 token /
全投影字段单调无 ABA 版本 pin；双扫相等只是稳定性证据、不构成证明）；三机制皆不可用或证明
失败时，该侧读取以 `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` 家族 fail-closed，不产出快照、
不进入 compare。
两侧各自时点一致后，**跨侧时间偏移是产品语义而非缺陷**：V1 比较的是「两份各自一致、读窗口
相近但不同时」的快照，run 记录双侧读窗口证据，不假装存在跨系统全局事务。

**处理：** 分别生成不可变源快照，执行统一身份分析（§4.6），以 owner 批准的精确身份键做
键级分类，产出闭词表六桶结果：

- `only_in_engineering` / `only_in_enterprise` — 键在一侧恰好一行、另一侧不存在；
- `matched_consistent` / `matched_divergent` — 键在两侧各恰好一行，冻结投影相等 / 不等；
- `ambiguous` — 同一精确键在**任一单侧**命中多行（键级归桶，绝不任选第一条、绝不产生假匹配）；
- `identity_invalid` — 行的身份键缺失或不可按冻结规则规范化（行级归桶）。

V1 不做模糊匹配、别名推断、自动合并或域规则补值；候选、置信度与人工确认属 **V2.1**，须另开
含 RBAC、值面与审计的独立设计门。**exact-key 的承重前提是两侧共享一个可精确比对的身份键**——
当客户两系统不共享精确键时，结果安全退化为大量 `only_in_*` / `identity_invalid`：exact-key
永不产生假匹配，该退化本身就是「需要 V2.1」的正确信号，是特性而非缺陷。

**输出：** 独立的运行、快照、快照行与差异记录，以及 values-free 证据。任何对外系统写入均不在
本场景内。

### 2.3 角色化来源与场景绑定（产品模型）

产品从固定品牌关系提升为**「双源物料主数据对账」**；「PLM ↔ ERP」只是默认场景模板，不是
运行时代码限制。场景内部不绑定厂商品牌，而绑定两个语义角色：

```text
scenarioInstance（active 指针，§4.1 指针权威）
├── bindingVersion（含 contractVersion）
├── engineering_material_master -> approvedConfigVersionId + pinned systemContentKey
└── enterprise_material_master  -> approvedConfigVersionId + pinned systemContentKey
```

- 每个角色指向**一个租户内、已注册系统上、已审批、能力兼容的只读配置版本**——客户可用
  Yuantus、其他 PLM、K3、其他 ERP，乃至符合契约的 PDM / 只读数据库源，无须改对账业务本身；
- **外部系统注册身份必须被 pin（P1-2；rev-4 定为内容键单轨）**：系统注册行的身份承载字段
  （连接器 / 源类别、端点身份、认证主体引用）可被就地修改（现表
  `integration_external_systems`，迁移 057，即为可变行、无版本 ID），仅 pin
  `approvedConfigVersionId` 不足以证明「还在对同一个外部系统说话」。权威取**有明确定义的
  `systemContentKey`**（§4.6 确定性内容键）：绑定成员钉住其值，激活 / run-start / commit
  各层以「当前重算值 = pinned 值」重验，任何身份承载字段就地变更 ⇒ 键漂移 ⇒ fail-closed
  （§4.5）。**不引入** `externalSystemVersionId`——现有注册表没有不可变版本记录可作其权威
  来源，虚悬的版本 ID 不如诚实的内容键；若未来把注册表升级为 create-only 版本化，属独立
  迁移设计门，不在 V1；
- **运行请求只传 `scenarioInstanceId`**：服务端解析当前 active bindingVersion；业务用户不能在
  单次运行请求中临时指定 systemId、配置 ID、URL 或 SQL；
- **换绑受控**（生命周期与重验见 §4.5）：新建候选绑定 → preflight（连通性 / 分页完整性 /
  一致性证明能力 / 字段投影 / 身份键 / 权限）→ 新基线预览 → 场景管理员审批 →
  **原子切换**为新 bindingVersion；
  旧绑定保留，回滚 = 产生新的激活版本，绝不改写历史；
- **权限分层**：平台管理员（安装 / 注册连接器类型）→ 租户集成顾问（选系统、配映射、探测、
  提交换绑申请）→ 场景管理员（审批 / 激活 / 回滚绑定）→ 业务操作员（运行对账、看结果，
  **不能换绑**）→ 只读用户（仅状态与结果）。租户内词表映射到 OD-V2-3 的
  `material-reconciliation:read/operate/admin`；
- **界面分层**：基础模式四步（选工程侧系统 → 选企业侧系统 → 自动检测兼容性并预览映射 →
  提交审批）；高级模式按权限展开（身份键与冻结投影、分页与完整性能力、新旧绑定差异、基线
  重建、绑定历史与回滚、兼容性诊断）。不支持的客户系统走「连接器接入申请」，**不能**通过输入
  URL、SQL 或脚本直接执行；
- **V1 严格保持两个来源**，不开放任意 N 源——N 源引入来源优先级、字段所有权、多方冲突与
  原子提交等新语义，须由真实第三来源需求推动、另过设计门。

## 3. 结构独立性（必须同时满足）

第二场景不是「换名字的备料缓存」。以下条件为 ratify 后实现的结构性验收项：

1. 独立 manifest id、route namespace、feature flag、权限词表、状态词表和契约测试；
2. 独立 frozen templates 与独立 intake aliases；objectId / fieldId 不使用
   `plm_stock_preparation_*` 前缀；
3. 独立内部表角色，不写、不 patch、不读取 stock-prep 九表作为业务输入；
4. 不 import stock-prep templates、BOM mapper、classifiers、generation、repair 或
   `runStockPreparationPersistUnitOfWork`；
5. `erp_material_master` 继续是 stock-prep 的可变 cache。现有 T3a 模块明确是 upsert cache、
   非 immutable snapshot，因此不得迁移、复用或重命名为 V2 表；
6. stock-prep 路由、返回形状、错误码、权限和 flag-OFF 行为保持 byte-identical。

建议的独立角色（逻辑名在实现锁中最终冻结）：

| 角色 | V2 语义 | 写入纪律 |
|---|---|---|
| `reconciliation_run` | 一次运行 attempt 及闭词表状态；`attemptId` 建行即有（服务端生成、不透明），`runIdentityKey` 建行时为 NULL、仅在 commit 事务内 claim-first 抢占成功后一次落定（§4.4/§4.6；败者永远 NULL） | 仅允许 §5 的单向状态迁移；`runIdentityKey` NULL→值仅一次（claim 为控制流、索引为背书）；禁止回退或改写身份 |
| `source_snapshot` | PLM 或 ERP 一侧的不可变快照头 | create-only |
| `source_snapshot_row` | 经冻结投影规范化后的快照行 | create-only |
| `reconciliation_diff` | 两个完整快照间的确定性差异 | create-only；仅引用快照句柄 |
| `material_reconciliation_scenario` | 场景实例；`active_binding_version_id` 单指针 = active 的唯一权威（§4.1 指针权威，复合 FK 限定本场景） | 仅 active 指针可变（CAS 切换）；其余字段冻结 |
| `material_reconciliation_binding_version` | 一次绑定版本（角色 → approvedConfigVersionId + contractVersion）；status 词表不含 `active`——「active」是被场景指针指向的**派生谓词**（§4.1/§4.5） | 行 create-only；status 仅 §4.5 单向迁移 |
| `material_reconciliation_binding_member` | 绑定版本内的角色成员：role → approvedConfigVersionId + pinned `systemContentKey`（§4.6；rev-4 内容键单轨，无版本 ID） | create-only |
| `material_reconciliation_binding_audit` | 绑定生命周期审计 | append-only、values-free |
| `reconciliation_run_identity_claim` | 语义键抢占表（§4.4 claim-first）：`(tenant_id, run_identity_key)` 主键 + 引用胜者 `attemptId`；`complete` 保留、`failed` 同事务删除 | claim-only；仅胜者写、`failed` 释放；不存业务值 |

D1 必须把**绑定对象与数据对象一次列全**，并冻结字段、唯一键、写入纪律与保留策略。
人工决议表和值面明细不进入第一版（V1 不新增 mapping / decision 表；`reconciliation_diff`
足以承载 exact-key 结果）；若需要，另开 RBAC + audit 设计门。

## 4. 不变量

### 4.1 租户与权限

- 所有会产生内部写或持久运行记录的执行，tenant 仅从认证主体派生；body、query、params 中的
  `tenantId` / `workspaceId` / `projectId` / `targetProjectId` / `baseId` steering 在任何
  source、provisioning、records I/O 前拒绝；
- source config 必须属于同一认证 tenant 且状态为 approved；source I/O 前重新读取，提交前以
  同事务锁定验证或 approved-version CAS 证明其所有权和批准版本未变化，具体机制由实现锁冻结；
- V2 是 tenant-level 主数据对账，不借用 stock-prep project scope；
- **运行请求只携带 `scenarioInstanceId`**；systemId、配置 ID、URL、SQL 出现在运行请求中一律在
  任何 source / provisioning / records I/O 前拒绝（§2.3）；
- **active 权威与状态机解耦（P2-1 裁决：指针权威，单选）**：本 Charter 冻结为
  **pointer-authoritative**——场景表唯一列 `active_binding_version_id` 是「哪个绑定 active」的
  **唯一权威**；单列指针在构造上只能持有一个值，无需部分唯一索引即满足数据库权威唯一。
  配套约束：
  - **复合外键** `(scenario_id, active_binding_version_id)` 引用绑定版本表的
    `(scenario_id, id)`，指针在数据库层不可能指向其他场景的绑定；
  - 绑定版本的 status 词表**不含 `active` 存储值**：「active」是被指针指向的派生谓词，
    生命周期事实（draft_candidate / preflight_passed / approved / superseded / revoked）与
    权威选择（指针）彻底分离；
  - **revoke 与清指针同事务**：撤销当前被指向的绑定版本时，置 `revoked` 与指针清空（或切至
    预选替代版本）必须在同一事务内完成，不允许出现「已 revoked 却仍被指针引用」的窗口；
    **切至预选替代版本 = 一次完整激活**（rev-4 收紧）：替代版本必须在同一事务内重新通过
    §4.5 第 2 层 Activate 全量校验（config / 系统身份 / 租户 / approved / 能力契约），
    仅保证指针不悬空不合格；
  - status-authoritative 变体（`UNIQUE ... WHERE status = 'active'` 部分唯一索引，
    058 先例）**明确不采用**，两套权威语义不得并存；058 精确形态仍是
    `runIdentityKey` 部分唯一索引（§4.4）的仓内先例。
  应用层 CAS（`WHERE active_binding_version_id = <期望旧值>`）只负责陈旧请求检测与友好 409，
  **不承担最终一致性**；
- 建议权限词表为 `material-reconciliation:read`、`:operate`、`:admin`。是否采用该命名及
  迁移策略由 OD-V2-3 裁决。

### 4.2 外部系统与数据面

- PLM / ERP adapter 只读；所有成功、失败和审计证据均声明 `externalWrite=false`；
- 不调用 K3 Save / Submit / Audit，不调用 PLM write，不接 external-write apply pipeline；
- V1 公共 API / UI、审计、用户可见日志和 values-free artifact 只允许不透明句柄、
  闭枚举、计数和有界摘要 hash。物料编码、名称、规格、单位、源字段名、原始 path、
  原始错误和配置内容不得进入上述任一表面；
- 受控的内部诊断 telemetry 也必须 values-free：只可记录闭词表 family / reason / phase、
  计数、非敏感关联句柄、经确定性脱敏的 error class 与 stack fingerprint。禁止记录 raw message / stack、
  path、config、payload、source field 或业务值；该面必须有 leak-bait / redaction 测试承重，不得以
  “仅内部可见”为由接入 raw Sentry / logger capture。实现锁必须冻结闭集 error-class
  allowlist（未知类折叠为 `OTHER`）与单向、有界、path/message-free 的 fingerprint 输入规则；
- 值面审阅默认 barred，不能因为用户持有 `integration:write` 自动解锁。

### 4.3 完整性、身份与歧义

- 两侧 source snapshot 都必须**完整可证且时点一致可证**（§2.2/§4.6 `sourceConsistencyProof`）
  后才能进入 compare；任一证明缺失即 fail-closed（完整性走 `READ_UNPROVABLE` 家族、一致性走
  `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` 家族）；一侧失败不得以另一侧部分数据产出
  「无差异」或有效 diff；
- 身份键为 owner 冻结的精确键。重复 / 缺失 / 不可规范化键的语义**统一为 §4.6 的桶级
  fail-closed**（进入 `ambiguous` / `identity_invalid` 桶、绝不进入 matched 桶），**不是整次
  运行失败**——本 Charter 明确**不采用**「整跑拒绝」变体，两套语义不得并存（P2-1 裁决）；
- V1 禁止 fuzzy match、大小写猜测、名称相似度或以 stock-prep 的
  `childDrawingNo|childVersion` 回退；
- comparator 只消费 scenario-owned frozen projection；新增字段必须升级 contract version，不能
  静默改变历史 diff。

### 4.4 原子性、幂等与重放

- 一个成功 run 必须原子提交：两个完整 snapshot、所有 snapshot rows、diff rows 和 run 的
  `complete` 终态同成同败；任何中途错误不得留下可被读为成功的半成品。失败运行可单独落
  values-free `failed` 终态，但不得引用或暴露半成品 snapshot / diff；
- 不直接复用 stock-specific P4 UOW。V2 先定义自己的事务声明；只有 V3 证明两个场景拥有同一
  事务边界后，才可抽场景无关 UOW；
- **attempt 与语义 run 键的时间冲突按 set-once 解（P2-2 裁决）**：`runIdentityKey` 依赖两侧
  `snapshotContentDigest`，只有读完双源才存在，而 run 行从 `planned` 起就必须存在。因此
  运行行以服务端生成的不透明 `attemptId` 建行（调用方不能指定租户或持久键）；
  `runIdentityKey` 建行时为 NULL，**仅在 commit 事务内一次落定**（NULL→值仅一次，禁止改写），
  由 `UNIQUE (tenant_id, run_identity_key) WHERE run_identity_key IS NOT NULL` 部分唯一索引
  承重（058 先例的精确用法）。不另拆 attempt / 语义 run 两对象——单对象 + set-once 已闭合
  时序，拆表变体不采用；
- **重放与并发去重是同一机制：claim-first + 数据库强制的有界等待（rev-6 冻结，PostgreSQL 语义
  已核实）**：唯一索引违例（23505）会废掉整个事务，「撞索引后同事务标记 dedup」不可实现；
  「另开事务标记」又在崩溃时留下永久停在 `compared` 的非终态窗口。owner rev-4 复审指出
  `INSERT ... ON CONFLICT DO NOTHING` 遇**并发未提交**同键行会**阻塞等待**该事务提交或回滚，
  并非「不等待」；且 claim 与 `complete` 同事务提交 ⇒ 败者永远看不到「已提交但非终态」的持有
  者，故原 `RUN_IDENTITY_CLAIM_PENDING` 分支不可达（rev-5 删除该分支）。**owner rev-5 复审
  进一步指出：仅靠「对方 commit 事务时延」并不是有界——胜者在 claim 后 idle-in-transaction 或
  被长写拖住时,败者会在行锁上被无限吊住。rev-6 因此把「有界」从文字承诺升级为数据库强制的
  硬边界**（**事务隔离级别 READ COMMITTED**）：
  - **claim insert 前必设事务局部等待上限** `SET LOCAL lock_timeout = <bounded>`（有界值由实现
    锁冻结,秒级;可另设 `SET LOCAL statement_timeout` 作整段兜底）——这使行锁等待由**数据库**
    强制封顶,不依赖对手事务的自律;
  - commit 事务内、**写任何 snapshot / diff 行之前**，`INSERT ... ON CONFLICT DO NOTHING` 抢
    租户级 claim 表的语义键（claim 行引用 `attemptId`）；
  - **锁等待超过 `lock_timeout`**（对手持未提交 claim 且不推进）：PostgreSQL 抛 `55P03`
    (lock_not_available) 使该 commit 事务中止——因 claim 是事务内**第一个写**,中止时**零
    snapshot / diff 行**已写；回滚后在独立小事务把本 attempt 记为 `failed`、reason
    `RUN_IDENTITY_CLAIM_BUSY`（**retryable 类**,闭词表,见 §5）,调用方以**新 attempt** 重试,
    绝不无限等待;
  - **胜者**（本语句插入成功）：同一事务内继续写全部 immutable 行、set-once 落
    `runIdentityKey`、置 `complete`，随事务原子提交；
  - **败者**（插入 0 行，键已被占）：因胜者的 claim 与 `complete` 原子同提交,败者解除阻塞时
    看到的**已提交** claim 必属于一个已 `complete` 的 run；败者 `SELECT` 该持有者、同一（仍
    可用的）事务内落 `deduplicated` 终态（§5，引用胜者不透明句柄），**零 immutable 行**。
    若胜者事务回滚 / `failed`（在其事务内删除了 claim 行,见下），阻塞解除后本 `INSERT` 成功
    ⇒ 败者转为胜者继续。**故不存在「已提交但非终态持有者」状态,无 PENDING 分支**；
  - **败者的 `runIdentityKey` 永远保持 NULL**——语义键只属于胜者，部分唯一索引因此只在
    逻辑缺陷时触发，是不变量背书而非控制流；
  - `failed` 终态在同一事务内**释放 claim**（删除 claim 行），`complete` 永不释放——崩溃
    留下的非终态胜者按 §5 崩溃规则 exact-resume 或被管理面置 `failed`（随事务释放 claim），
    语义键因此不会被死 attempt 永久占据；
  - 迁移 058 仅是 partial-unique-index 的仓内先例，**不是**本冲突收束机制的先例；冲突分支
    （胜者/败者/回滚转正 三路）必须有崩溃注入测试承重（§8.2b）。
  相同输入重放与并发同内容 attempt 都由此收敛为 exact-noop，计数和 immutable rows 不增长；
  内容 / contract 不同 ⇒ `runIdentityKey` 天然不同 ⇒ 各自独立 run，历史不可覆盖；
- 分页读取有界；达到上界但无法证明下一页为空时返回 `READ_UNPROVABLE` 家族错误，不提交 run；
  时点一致性不可证时返回 `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` 家族错误，同样不提交 run。

### 4.5 绑定生命周期与四层重验

绑定版本**存储状态**生命周期（单向；终态语义**必须拆分**；`active` 不是存储状态——它是
「被场景 `active_binding_version_id` 指针指向」的派生谓词，§4.1 指针权威）：

```text
draft_candidate -> preflight_passed -> approved ──┬-> superseded（被后续版本正常替代）
                                                  └-> revoked（安全撤销；同事务清指针/换指针）
（approved 且被指针指向 = 派生的「active」；指针切换 = 原子激活事务，不改写状态历史）
```

四层校验，各层职责不同、不可互相替代：

1. **Preflight（候选阶段）：** 允许外部连通性、分页完整性、一致性证明能力（§4.6 三机制之一
   的合格性）、字段投影、身份键与权限探测——**外部网络探测只发生在这一层，绝不进入数据库
   事务**；
2. **Activate（激活事务内）：** 重新读取两个 config、**外部系统注册（当前 systemContentKey
   须等于绑定成员钉住值，P1-2）**、tenant、approved 状态与 capability contract——**信当下，
   不信 preflight 的旧结论**（存量 approved 也可能已失效；运行读取面本就 fail-closed 只接受
   approved，先例见 `read-source-config-store.cjs` `getForRuntime` 的 approved-only 拒绝）；
   指针 CAS 切换（旧值→新值）、旧版本置 `superseded` 与审计同事务；
3. **Run-start：** 再次重验并 **pin 全元组**（bindingVersion、两个 configContentKey、
   两个 `systemContentKey`、contractVersion 与各源 consistency-proof 能力声明，见 §4.6），
   防止激活后、运行前发生 retire 或系统身份变更；运行全程只读 pinned 的不可变输入；
4. **Commit（漂移裁决，P2-2）：** **绑定选择漂移可记录，输入可信性漂移必须中止**——
   - active 指针已被**后续版本正常替代**（superseded）：允许提交，记录
     `supersededAtCommit=true`，默认查询不得把该 run 呈现为「当前」结果；
   - pinned config 内容、**外部系统身份（当前 systemContentKey ≠ pinned 值，P1-2）**、
     租户归属、能力契约或安全有效性发生变化：**失败**；
   - 任一 pinned config、外部系统注册或绑定被 **revoked**：**失败**；
   - 若终态语义未拆分（无法区分「正常替代」与「安全撤销」），则一律失败——不拆语义就没有
     安全的继续提交。

### 4.6 身份分析、血缘键与双指纹

**统一身份分析（共享阶段，非拒绝式门）：** D3a 保存**完整**快照（不因重复键丢行），并执行一次
统一 identity analysis——按冻结规则规范化每行身份键、计算键级 multiplicity。该分析同时供给：
①`snapshotContentDigest`（确定性排序）；②D3b 的键级分类（§2.2 六桶）。重复键**不破坏**摘要
确定性——排序元组编码 rev-4 冻结如下（影响摘要、双指纹与 dedup，不得由实现自选）：

- 排序元组 = `(identityKeyClass, identityKeyBytes, canonicalRowDigest, multiplicity)`，逐分量
  **长度前缀编码**（`len(bytes) || bytes`，长度为固定宽度大端整数）后拼接——禁止裸拼接，
  杜绝跨分量拼接碰撞；
- `identityKeyClass` 为单字节域分隔符：`0x01` = 可规范化键，`0x00` = `identity_invalid`；
  invalid 行的 `identityKeyBytes` 使用**固定空 sentinel**（零长度），排序回退到
  `canonicalRowDigest`——sentinel 与任何真实键处于不同 class 域，不可能碰撞；
- `multiplicity` 为固定宽度大端无符号整数，上界即读取有界上界（页上限 × 页数上限），
  由构造不可溢出。

**`canonicalRowDigest` 确定性契约（P2，rev-5 冻结；外层长度前缀救不了内层不确定性）：**
排序元组的长度前缀只防跨分量碰撞，`canonicalRowDigest` 自身的字节必须逐位确定,否则同一行在
两次运行/两侧可得不同摘要,连带毁掉 `snapshotContentDigest`、双指纹与 dedup。该摘要为对**冻结
投影字段集**规范化后的行编码,以下规则列为 **D1 必冻契约、且每条以 mutation 承重**（§8.2b）：

- **字段序**：按 contractVersion 冻结的字段顺序编码（非源返回序、非字母序自选）；字段名与值
  各自长度前缀,字段间不裸拼接；
- **类型标签**：每个值前置单字节类型标签（null / bool / int / decimal / string / 缺省），
  使 `"1"`(string) 与 `1`(int)、`""` 与 null 不可互相碰撞；
- **null 与空**：`NULL`、空串、字段缺省(missing)为**三个不同**编码,不得折叠;
- **数字规范化**：整数与定点小数以规范十进制文本编码(无前导零、无正号、负零折叠为零、无
  科学计数法、小数尾零裁剪到冻结精度),不经 IEEE754 浮点中转;超出安全范围的数值走冻结的
  大十进制表示;
- **Unicode 规范化**：字符串先 **NFC** 归一再 UTF-8 编码,固定大小写策略(默认**不**折叠大小写,
  身份键的大小写敏感性由 owner 冻结键规则决定,不在摘要层猜测);禁止去空白/全半角等隐式改写。

任一规则缺省或由实现自选 ⇒ 摘要不确定性 mutation 红(§8.2b-15b)。

```text
sourceReadEvidenceDigest = 页回显、分页参数（cursor/pageIndex）、原始页指纹、
                           完整性证明 + sourceConsistencyProof 证据的有序摘要
                                                        —— 证明「采集过程」
snapshotContentDigest    = contractVersion 下冻结投影的规范化多重集摘要
                                                        —— 语义幂等
```

**sourceConsistencyProof（P1-1，闭机制集；rev-4 收紧）：** 每侧快照必须证明「所有页对应源的
同一时点状态」。**双扫摘要相等不构成该证明**（rev-4 裁决）：反例——两页 A、B，每轮扫读都在
读完 A 后源先改 A 再改 B、下一轮前恢复，两轮均装配出 {A=a1,B=b1}，而源的真实状态序列从未
包含 {a1,b1}；摘要相等仍接受了撕裂快照。双扫本质是「装配产物稳定性」证据，对 ABA 型撕裂
不设防，因此**从证明机制中移除**，至多作为可选的稳定性辅助证据记录，不解锁 compare。

**证明标记与页数据必须原子绑定（P1，rev-5 收紧）：** 逐页回显一个 token/version 还不够——若
标记与该页数据来自**两次独立读取**，实现仍可能把旧标记配到新数据上，重新制造撕裂快照。因此
每种机制都要求**证明标记是承载该页数据的同一次源读取的内在属性**（同一响应、同一游标推进、
同一事务可见性），而非旁路另取。标记与数据不能证明同源 ⇒ 该机制不合格、该侧
`SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` fail-closed。

证明机制词表冻结为三种，源能力声明其一（连接器能力矩阵扩展一项 `consistencyProof`）：

- `SOURCE_SNAPSHOT_TXN` — 源侧在单个快照隔离事务（或等价读一致性会话）内完成全部页读取；
  原子绑定天然成立：所有页共享该事务的同一可见性快照，无独立标记可错配；
- `IMMUTABLE_SNAPSHOT_TOKEN` — 源先物化一份不可变快照并返回其 token，**全部页只经由该
  token 作为读句柄取得**（token 是取数的入参、非取数后另取的旁路标记），逐页回显 token 供
  校验；页数据若可不经 token 取得，则该机制不合格；
- `MONOTONIC_VERSION_PIN` — 源在**返回页数据的同一响应**里内联该页对应的、**覆盖全部投影
  字段、单调递增且无 ABA 语义**的数据集版本标记（非独立端点另查）；逐页回显，任一页回显
  漂移 ⇒ 该侧读取失败重来（有界重试次数由实现锁冻结），重试耗尽 ⇒
  `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE`。仅覆盖部分字段、可回绕、可重置，或标记与页数据
  分两次取的版本 pin **均不合格**。

三种机制皆不可用、能力未声明或证明失败一律 fail-closed（§2.2），**不得**以「分页读全」或
「双扫相等」冒充时点一致，也不得静默降级为无证明快照——无法提供任一合格证明的源在 V1 即
不可作为对账输入（这本身是 D3a spike 的合格性评估结论之一）。每侧实际采用的机制与其证据
（事务/快照 token 回显序列或版本标记回显序列的 hash）计入该侧 `sourceReadEvidenceDigest`；
可选的双扫稳定性证据若记录，亦入该摘要但不参与证明判定。各源类别实际选型与合格性在 D3a
设计 spike 内逐源冻结（§7），选型改变排期须回写。

现有 feeder 的逐页 SHA-256 + seenPages 去重 + 页回显校验只是**页级防重证据、不返回也不持久化**
——D3a 须新增上述两个摘要，**不得**拿原始页序 hash 直接充当语义快照 hash。业务数据摘要不得以
公开可猜测的裸 SHA 暴露：优先内部保存，或使用带域隔离的 HMAC。

**血缘键与运行身份键（分离，P2 裁决）：**

```text
systemContentKey   = 系统注册身份承载字段（连接器/源类别、端点身份、认证主体引用）的
                     确定性内容键（内部保存，P1-2）
bindingFingerprint = hash(role -> configContentKey + systemContentKey
                                + connectorCapabilityVersion)
baselineLineageKey = hash(contractVersion + bindingFingerprint)     —— 不含快照内容
runIdentityKey     = hash(baselineLineageKey
                          + engineeringSnapshotContentDigest
                          + enterpriseSnapshotContentDigest)         —— 含两侧快照摘要
```

配置内容、**外部系统身份**、连接器能力、身份键或投影契约变化 ⇒ 新 `baselineLineageKey`
（强制新基线血缘）；源数据正常变化 ⇒ 只产生新 run，不改变配置血缘。未经兼容性证明，不得把
新旧 baseline 血缘下的快照直接当作业务差异比较。

**runIdentityKey 落定时序（P2-2）：** 该键在读完双源、算出两侧 `snapshotContentDigest` 之前
不存在，因此 run 行以 `attemptId` 建行、`runIdentityKey` 为 NULL；键仅在 commit 事务内、
claim-first 抢占成功后随快照 / diff / 终态一次性落定（§4.4：胜者独占，败者永远 NULL；部分
唯一索引为不变量背书而非控制流）。`runIdentityKey` 含业务数据摘要，遵循本节裸 SHA 纪律：
内部保存或域隔离 HMAC，不进入公开表面。

## 5. 场景状态与闭词表（提案）

实现锁应冻结以下最小状态机，命名可由 OD-V2-5 调整但语义不得弱化：

```text
planned -> reading_sources -> snapshots_complete -> compared -> complete
   |                                                    \-> deduplicated（终态）
   \-------------- any proven failure --------------------------> failed
```

- `complete` 只允许在两侧完整性可证、统一身份分析完成、快照持久化和 diff 原子提交全部成立后
  出现（**不要求身份全局唯一**——重复 / 无效键按 §4.6 落入 `ambiguous` / `identity_invalid`
  桶后运行照常 complete；complete 的 run 可携带 `supersededAtCommit` 标记，§4.5）；
- `deduplicated`（终态）：commit 事务内语义键 claim 被某个 run 占用、且阻塞解除后看到的是
  **已提交**持有者时的收束态（§4.4 claim-first + 有界等待）——因 claim 与 `complete` 原子
  同提交,已提交持有者必已 `complete`;本 attempt 不写任何 snapshot / diff 行、`runIdentityKey`
  保持 NULL,仅记录胜者 run 的不透明句柄;这是 §4.4 exact-noop 重放与并发同内容去重的落点,
  默认查询不把它呈现为独立结果。**不存在「已提交但非终态持有者」状态**（rev-5 删除原
  PENDING 分支）:胜者回滚/`failed` 会在其事务内释放 claim,阻塞解除的败者转为胜者继续;
- `failed` 记录固定 family / reason / phase / counts，不保存原始异常；reason 闭词表含
  **retryable 类** `RUN_IDENTITY_CLAIM_BUSY`（§4.4 claim insert 触 `lock_timeout`/`55P03`：
  对手持未提交 claim 且不推进,数据库强制封顶等待后败者以此 retryable 终态收束、零 immutable
  写、调用方以新 attempt 重试）与既有的 `READ_UNPROVABLE` /
  `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` 等；retryable 与永久失败在 reason 层区分；
- 进程崩溃留下的非终态运行不可被查询面当成 complete；重试只能 exact-resume 或创建新 run，
  具体策略在实现锁中冻结；
- 差异词表第一版冻结为 §2.2 六桶：`only_in_engineering`、`only_in_enterprise`、
  `matched_consistent`、`matched_divergent`、`ambiguous`、`identity_invalid`。

## 6. 允许抽取与禁止抽取

### 6.1 V2/V3 可由第二消费者拉动的候选

仅在 V2 实现出现第二个真实消费者后逐项抽取：

1. source capability + bounded completeness contract；
2. immutable snapshot persist / exact replay orchestration；
3. frozen projection typed normalization 与 equality；
4. 参数化 exact-key diff 骨架；
5. values-free run evidence / audit envelope；
6. 场景 manifest / route registration 的最小注册面。

每项抽取必须以 stock-prep preset contract、V2 contract 与 mutation 同时承重，不能只靠类型或
源码字符串检查证明「通用」。

### 6.2 永远留在 stock-prep 域内

BOM expansion、pathKey 语义、`childDrawingNo|childVersion` 身份回退、duplicatePathKey HELD、
missingChildBom、设计数量 / 单位规则、material mapping、issueQty 数学、tri-XOR、备料异常词表、
九表 frozen templates、stock-prep project/batch locks 与 one-shot repair 均不得进入通用内核。

## 7. 实施切片（ratify 后才可执行；rev-2 统一为 D 序，旧 V 标签映射在括注）

任一切片首次新增或改动应用日志 / 内部诊断 telemetry 时，leak-bait 与 redaction mutation
必须作为**同一切片**的退出条件；不得延后到后续 UI 切片补证。

| 切片 | 内容 | 建议执行 / 审阅 | 退出条件 | 预估 |
|---|---|---|---|---|
| D0 | 本 Charter 修订 + ratify（即本文 rev-2） | Codex/Claude 起草；owner exact-head 短复审 | code-vs-doc、边界审阅 | 0.5–1 天 |
| D1（≈V2-a） | 独立 manifest、**绑定对象 + 数据对象 + `reconciliation_run_identity_claim` 全清单**的 frozen templates、闭词表、flag/permissions contract、**`canonicalRowDigest` 确定性契约冻结**（字段序/类型标签/null·空·缺省/数字/NFC） | Kimi K3 设计审计；Codex 定稿 | schema tests + forbidden-content tests + 摘要确定性 mutation；无 routes/runtime | D0–D2 合计 7–11 天 |
| D2 | 场景实例与绑定版本库（§3 绑定对象 + §4.1 指针权威 active + §4.5 生命周期 + `systemContentKey` 内容键派生与钉住） | Grok 实现；Codex 事务/权限复核 | 真库事务、指针 CAS + 复合 FK 负控、revoke 清指针同事务测（含替代版本全量 Activate 重验）、跨租户负控、supersede/revoke 拆分测、系统身份就地变更判别测 | （含于上） |
| D3a（≈V2-b/V2-c） | **一致性证明选型 spike（0.5–1 天，逐源评估 §4.6 三机制合格性并冻结）** + 双源采集、完整性 + 时点一致证明、不可变快照、统一身份分析（含 rev-4 冻结的排序元组编码）、双指纹、run pin、claim-first dedup + `runIdentityKey` set-once | Grok 实现；Kimi 跨模块审计；Codex 安全复核 | OFF inert；steering pre-I/O；分页边界 + 一致性漂移 mutation；真 PG rollback/replay/并发 dedup + 冲突分支崩溃注入；meta_fields 物理 id | spike 后回写：三机制内选型 4–6 天；任一源三机制皆不合格 ⇒ 该源 V1 不可用（范围裁剪，非加时） |
| D3b | 跨源 exact-key reconciliation（六桶分类）——**独立设计门后实现** | Kimi 设计；Grok 实现；Codex 行为审计 | 六桶正反序判别；桶泄漏 mutation；空侧正控 | 4–7 天 |
| D4 | 基础自助 UI（§2.3 四步） | Grok FE；Codex 浏览器与权限复核 | 浏览器流程、权限、响应式 | UI+真库+浏览器+收口合计 9–15 天 |
| D5 | 高级配置与换绑管理（§2.3 高级面） | Grok FE；Codex 复核 | 版本历史、基线、回滚测试 | （含于上） |
| D6 | 全链验收与 default-OFF 试点 | Codex 主导 | 真 PG、浏览器、实体机 | （含于上） |
| D7 | 统一设计及验证 MD | Codex | SHA、测试、边界与台账核对 | 1 天 |

（抽取切片旧标 V3-a 不入 D 序：按 §6.1 由第二消费者出现后逐项拉动，验收 = stock-prep + V2
双 contract + 完整静态依赖闭包 tripwire。）

**排期口径（rev-3 修正）：** exact-key V1 合计约 **25–42 个集中开发日**（rev-2 的 24–39 上加
系统身份版本化与一致性证明面；**精确值待 D3a 选型 spike 后回写**——owner 裁定 D3a 排期在
选定源一致性证明机制后重估）；Grok/Kimi 并行、关键写路径严格串行合并，约 **4–7 个日历周**。
候选 / 置信度 / 人工确认若纳入首版需另加约 3–6 周——**不混入**，留 V2.1。**对抗审重点压在
D3a 的并发面**（指针 CAS、`runIdentityKey` 部分唯一索引与并发 dedup、run pin、一致性证明
漂移、TOCTOU）——本线历次真 P2 均出自 check-then-set 类缺陷；D3b 在 exact-key-only 下反而是
低风险。

未经每个切片的退出条件和独立复核，不进入下一刀。Grok / Kimi 的绿灯只是证据，不替代 Codex
复核或 owner ratify。安全关键 PR 不以代理测试结果替代 exact-head 复核，也不自动合并。

## 8. 必须杀死的变异与验证矩阵

### 8.1 安全与边界

1. 把任一内部 target 指向 stock-prep `erp_material_master` 或其他九表 -> contract / real-DB 红；
2. 任一 adapter write spy 被调用或 `externalWrite` 变 true -> 红；
3. request tenant/project/base steering 在 source I/O 前未拒绝 -> 调用计数红；
4. 未批准、跨租户或执行中被撤销的 config 仍可提交 -> 红；
5. 业务值植入每个允许字段或诊断字段后，出现在响应、DOM、审计 / 用户可见日志、
   summary、values-free artifact 或受控内部诊断 telemetry -> 红；raw message / stack、path、
   config、payload 或 source field 绕过脱敏 -> 红。

### 8.2 完整性与正确性

1. 未知 source capability、满页到界或畸形 envelope 被当成完整 -> 红；
2. 任一非法行被过滤后继续比较 -> 红，必须整 envelope fail-closed；
3. 重复身份键按返回顺序选第一条 -> 正反序测试红；
4. 一侧空 / 失败被呈现为「无差异」 -> 红；合法且完整、一致可证的空 snapshot 应有独立正控：
   两个 matched 桶计数为 0，空侧无行，非空侧的行按键级规则落
   `only_in_<非空侧>` / `ambiguous`（侧内重复键）/ `identity_invalid`（无效键）——**不得**断言
   「全 only_in_*」（P3 修正），也不是空 diff；
5. 同内容重放未收束为 `deduplicated`、或使 snapshot / diff 行增长 -> 红；内容变化却收束为
   `deduplicated` / 返回 noop -> 红；
6. snapshot 行写入后、diff 或 run 终态前注入崩溃仍留下可见成功数据 -> 真库红；
7. 页间事务 / 快照 token / 版本标记回显漂移仍被当成一致快照提交 -> 红；**双扫摘要相等被当作
   时点一致证明接受**（构造 ABA 撕裂：读 A 后改 A、改 B、再恢复，双扫装配结果相同但源从未
   处于该状态）-> 红；三机制皆不可用 / 证明失败未走 `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE`
   fail-closed、或静默降级为无证明快照 -> 红。

### 8.2b 绑定、生命周期与指纹（rev-2/rev-3 新增）

1. 并发双激活同一场景 -> 指针 CAS/行锁下恰一个胜出，负者收到友好 409（构造并发测，非顺序
   论证）；指针指向他场景绑定 -> 复合 FK 数据库红；
2. preflight 与 activate 之间 config 被 retire/易主 -> 激活事务内重验红；
3. activate 与 run-start 之间 config 被 retire -> run-start 重验红；
4. commit 时绑定被**后续版本替代** -> 提交成功且 `supersededAtCommit=true`（正控）；
   commit 时 config 内容/租户/能力/安全有效性漂移或任一环节 **revoked** -> 提交失败；
5. 终态语义未拆分（supersede 与 revoke 同一状态）时仍继续提交 -> 契约红；
6. ambiguous / identity_invalid 键的行进入任一 matched 桶 -> 红；同键多行任选第一条 -> 正反序红；
7. 行序打乱但内容相同 -> `snapshotContentDigest` 必须不变（规范化多重集）；以原始页序 hash
   充当语义摘要 -> 红；
8. 业务数据摘要以裸 SHA 出现在公开表面 -> values-free 红（内部保存或域隔离 HMAC）；
9. 运行请求携带 systemId / 配置 ID / URL / SQL -> pre-I/O 拒绝计数红；
10. 外部系统注册身份承载字段在 activate / run-start / commit 前被就地修改仍通过对应层重验
    -> 各层判别红（当前 systemContentKey ≠ pinned 值必须 fail-closed，P1-2）；系统身份变更
    后 `bindingFingerprint` / `baselineLineageKey` 不变 -> 红；
11. 绑定版本 status 出现 `active` 存储值 -> 契约红（active 只能是指针派生谓词）；revoke 提交
    后指针仍引用该版本（撤销与清指针不同事务）-> 真库红；
12. `runIdentityKey` 由 NULL 落定后被二次改写 -> set-once 红；绕过 claim 写入同租户同键第二个
    complete run -> claim/索引数据库红；`deduplicated` attempt 的 `runIdentityKey` 非 NULL
    -> 红；
13. 并发同内容双 attempt（构造并发测）-> 恰一 `complete` + 恰一 `deduplicated`；败者不写任何
    snapshot / diff 行、`runIdentityKey` 保持 NULL -> 否则红；引入不可达的「已提交非终态持有
    者」处理分支 -> 契约红（rev-5 删除 PENDING）；
14. **冲突分支崩溃注入（三路）**：胜者 claim 后、immutable 行前崩溃 / 胜者行后、终态前崩溃 /
    败者阻塞解除后、落 `deduplicated` 前崩溃 -> 恢复后不存在停在 `compared` 的永久非终态，
    claim 不被死 attempt 永久占据（`failed` 同事务释放 claim 的正控 + 负控）-> 真库红；胜者
    回滚后并发败者未能转正继续 -> 红；
14b. **有界等待硬边界（P2 rev-6）**：构造对手事务持**未提交** claim 且不推进（模拟
    idle-in-transaction / 长写），败者的 claim insert 必须在 `lock_timeout` 上限内以
    `RUN_IDENTITY_CLAIM_BUSY`（retryable）失败、**零 snapshot / diff 写入**，而非无限等待
    -> 真库红；缺 `SET LOCAL lock_timeout`（回落到无限行锁等待）-> 红；超时路径写了任何
    immutable 行 -> 红；`RUN_IDENTITY_CLAIM_BUSY` 未标 retryable / 未被新 attempt 重试路径消费
    -> 红；
15. 排序元组以裸拼接编码（可构造跨分量拼接碰撞的两快照同摘要）-> 红；`identity_invalid`
    sentinel 与真实键同域可碰撞 -> 红；multiplicity 溢出未由读上界排除 -> 红；
15b. **`canonicalRowDigest` 确定性（P2 rev-5）**：字段序改动 / 缺类型标签使 `"1"` 与 `1` 或
    `""` 与 null 同摘要 / null·空·缺省折叠 / 数字经浮点中转或保留科学计数法 / 字符串未 NFC
    归一 -> 同一行两次摘要不同或异行同摘要，判别测试红；
16. revoke 切换预选替代版本时跳过替代版本的全量 Activate 校验（仅查指针不悬空）-> 红；
17. **一致性证明标记与页数据非同源**（旁路另取 token/version 后配到另一次读的页数据）仍被
    当成合格证明 -> 红（P1 rev-5，原子绑定）。

### 8.3 抽取与兼容

1. 从通用入口遍历完整静态依赖闭包，命中 stock-prep template / mapper / classifier / UOW -> 红；
2. 动态 require/import 无法静态证明且不在逐条说明的 allowlist -> 红；
3. stock-prep 既有返回形状、状态、错误码或 OFF 行为变化 -> byte-identical contract 红；
4. fake 绕过真实 meta_fields 物理 fieldId、事务或 approved-config store -> real-DB / wiring 红。

## 9. 非目标

- 不替换、迁移或清空 stock-prep `erp_material_master` cache；
- 不实现 BOM 对账、备料生成、物料匹配、单位换算或异常确认；
- 不做 PLM / ERP / K3 外部写，不授权 sandbox apply 或 production apply；
- 不在 V1 提供值面 UI、批量导出、自动修复、模糊匹配或人工确认写面；
- 不以「先造通用框架」为目标；若第二场景不需要某个抽象，就不抽；
- 不修改 `#4437` 的包、指针、flag、PM2、配置或实体机执行纪律。

## 10. Owner 决策单

| # | 决策 | 推荐 | ratify 后影响 |
|---|---|---|---|
| OD-V2-1 | 两个源的产品边界 | **V1 固定两个语义角色 `engineering_material_master` / `enterprise_material_master`，不固定厂商品牌；「PLM ↔ ERP」仅为默认产品模板；每角色绑定租户内已注册、已审批、能力兼容的只读配置版本；不读 stock-prep cache；源能力含 `sourceConsistencyProof` 三机制闭集（源侧快照事务 / 不可变快照 token / 全投影字段单调无 ABA 版本 pin，§4.6；双扫相等只是稳定性证据、不构成时点证明），不可证 = `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` fail-closed（该源 V1 不可用），跨侧时间偏移为披露的产品语义** | 冻结 V2 输入、角色模型与独立性 |
| OD-V2-2 | 身份匹配 | **V1 仅 owner 配置的 exact key；§2.2 六桶键级分类；重复/无效键 = 桶级 fail-closed（非整跑失败，两套语义不并存）；不做 fuzzy；候选/置信度/人工确认 = V2.1 独立设计门** | 解锁 comparator contract |
| OD-V2-3 | 权限 | **独立 `material-reconciliation:read/operate/admin`；不复用 `integration:write` 作为长期权限** | 解锁 manifest / route RBAC 设计 |
| OD-V2-4 | 数据面 | **V1 values-free；值面另开 gated + audited read** | 解锁 evidence UI，值面继续 barred |
| OD-V2-5 | 持久模型 | **run 仅允许 §5 单向迁移（含 `deduplicated` 终态）；`attemptId` 建行即有、`runIdentityKey` NULL→commit 事务内 claim-first 抢占后 set-once（READ COMMITTED；claim insert 前 `SET LOCAL lock_timeout` 数据库强制封顶等待,超时→ `RUN_IDENTITY_CLAIM_BUSY` retryable、零 immutable 写、新 attempt 重试；败者永远 NULL；索引为背书非控制流；claim 与 complete 原子同提交 ⇒ 无「已提交非终态持有者」，不设 PENDING 分支；`failed` 同事务释放 claim）；含 `reconciliation_run_identity_claim` 表；`canonicalRowDigest` 确定性契约（字段序/类型标签/null·空·缺省三分/数字规范化/NFC）D1 必冻；冲突分支崩溃注入 + 有界等待硬边界承重；snapshot/row/diff create-only；不建 decision 表** | 解锁 templates / migration 设计 |
| OD-V2-6 | 发布姿态 | **独立 default-OFF flag；仅内部写；`externalWrite=false`** | 解锁 D1，仍不授权 ON rollout |
| OD-V2-7 | 场景绑定与换绑 | **§2.3/§4.5/§4.6 模型整体冻结：绑定版本生命周期（supersede/revoke 拆分；`active` 为指针派生谓词非存储状态）+ 指针权威唯一 active（复合 FK；revoke 清指针同事务，切换预选替代版本 = 同事务完整 Activate 重验；partial-unique 变体不采用）+ 外部系统身份 pin（内容键单轨：`systemContentKey` 进绑定成员、bindingFingerprint、run-start pin 与 activate/commit 重验；不引入无权威来源的版本 ID）+ 四层重验 + commit 漂移拆分 + 血缘/运行双键 + 双指纹（业务摘要不裸 SHA 外显；排序元组编码 rev-4 冻结）+ 运行请求仅 scenarioInstanceId + V1 双源不 N** | 解锁 D2 绑定底座设计 |

**建议裁决：七项全部按推荐 ratify。** 该裁决只解锁 D1；D2 及以后仍按 §7 逐刀过门，
不会自动触发运行时开发、发布或实体机执行。

## 11. Charter 退出判据

本 Charter 只有在以下条件同时满足后才从 PROPOSED 转为 RATIFIED：

1. owner 对 OD-V2-1..7 逐项裁决；
2. 独立 code-vs-doc 审阅确认现有 cache、P4 UOW、source capability 和 external-write 边界表述
   与代码一致；
3. PR 仅含文档，且无 closing keyword、secret、客户标识、业务值或运行时授权；
4. `#4437` 状态保持独立，不以 Charter 合并代替实体机验收。

## 12. 本轮设计审计与验证记录

### 12.1 Kimi K3 设计审计

K3 以只读方式检查第二场景边界，结论为 **Charter GO / runtime NO-GO until ratify**，并确认：

- 用户、双 approved-source 输入、独立 snapshot/diff 输出与 stock-prep 用户流不同；
- 新场景必须独立写入自己拥有的内部表，不能把 T3a cache 当 immutable snapshot；
- `externalWrite=false`、未知分页能力 fail-closed、values-free leak-bait、重放幂等和禁止依赖
  stock-specific UOW 应成为承重 mutation。

K3 的后续 exact-diff 会话无输出停滞后被终止，**未被记为通过证据**。因此本轮最终 code-vs-doc
裁决仍由 Codex 独立完成，后续 PR review 还需重跑 exact-head 审阅。

### 12.2 Codex code-vs-doc 复核

复核锚点与结论：

- `stock-preparation-erp-material-sync-persist.cjs` 明确把 `erp_material_master` 定义为 upsert
  cache、非 immutable snapshot，并保持 internal-only / `externalWrite=false`；
- `stock-preparation-persist-unit-of-work.ts` 明确是 stock-preparation-specific 四表 UOW，不能
  预称通用事务内核；
- `stock-preparation-readonly-source-run.cjs` 已有 source capability 与完整性 fail-closed 先例，
  但 V2 仍须以自己的双源 envelope 和 contract 证明复用；
- P4 closeout 明确 T3a ERP sync atomicity 仍是独立裁决，且 `#4437` flag-OFF 诊断面不可被本线
  改动；
- E0 外部对接锁继续钉死 OD-E3=否、OD-E4=smoke only、OD-E5=`externalWrite=false`，本 Charter
  未放宽这些门。

复核中发现并修正了一处自相矛盾：初稿把 `reconciliation_run` 写成 create-only，却同时定义
状态迁移。终稿改为 run 仅允许 §5 单向迁移，snapshot / row / diff 三类保持 create-only，并区分
成功原子提交与 values-free 失败终态。

### 12.3 本地检查

```text
git diff --check
rg -n "externalWrite=false|#4437|erp_material_master|runStockPreparationPersistUnitOfWork|OD-V2-" \
  docs/development/stock-preparation-v2-material-master-reconciliation-charter-20260719.md
```

本切片只改变两份 Markdown；未运行 runtime test，也未声称 real-DB / entity-machine 证据。

### 12.4 rev-2 吸收记录（2026-07-19）

owner 两轮 REQUEST_CHANGES 的全部裁决已落入本 rev：

- **P1×3（blocker）**：D3a/D3b 拆分且 D3b 为独立设计门（exact-key only，候选/置信度/人工确认
  = V2.1）；active binding 数据库权威（partial unique index **或** 单指针 FK 皆可，058 先例；
  CAS 仅陈旧检测）；Preflight / Activate / Run-start / Commit 四层重验（外部探测不进事务）。
- **P2×2**：`baselineLineageKey`（不含快照内容）与 `runIdentityKey`（含双侧快照摘要）分离；
  `sourceReadEvidenceDigest` 与 `snapshotContentDigest` 双指纹——经代码核实，现有 feeder 的
  逐页 SHA-256（`read-source-read-runtime.cjs` fingerprintRows）+ seenPages + 页回显仅是页级
  防重证据、不返回不持久化，D3a 须新增两摘要而非「复用页指纹链」（rev-1 讨论中的错误事实
  陈述已订正）。
- **P2-1（本轮）**：重复身份键语义统一——D3a 全量快照 + 统一身份分析（不丢行），D3b 键级
  归桶（ambiguous/identity_invalid），fail-closed = 桶级排除非整跑失败；「整跑拒绝」变体明确
  不采用；摘要确定性由 `identityKey + canonicalRowDigest + multiplicity` 排序保证。
- **P2-2（本轮）**：commit 漂移拆分——仅 active 指针被后续版本替代可记录
  （`supersededAtCommit=true`，默认查询不呈现为当前）；config 内容/租户/能力/安全有效性漂移
  与一切 revoked 必中止；终态语义必须先拆 supersede/revoke。
- **P3**：数据底座并非遗漏（rev-1 已含四数据对象）——D1 改为绑定对象 + 数据对象一次列全；
  V1 不新增 mapping/decision 表。
- 采纳三条补充：exact-key 共享键前提显式命名为特性（安全退化 = V2.1 信号）；统一身份分析为
  **共享阶段**而非拒绝式门；commit 放宽仅限 active-pointer supersede。
- 排期修正为 24–39 开发日 / 4–6 周；对抗审重点 = D3a 并发面。

### 12.5 rev-3 吸收记录（2026-07-20，owner rev-2 复审 2×P1 + 2×P2 + P3）

- **P1-1（分页完整 ≠ 时点一致）**：§2.2 显式区分两种证明；§4.6 新增 `sourceConsistencyProof`
  闭机制集（`SOURCE_VERSION_PIN` / `DUAL_SWEEP_DIGEST_MATCH`），能力未声明、机制不可用或证明
  失败一律 `SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE` fail-closed（§4.3/§4.4），证据计入
  `sourceReadEvidenceDigest`；跨侧时间偏移明确为披露的产品语义（V1 比较两份各自一致但不同时
  的快照，不假装全局事务）；逐源选型下沉到 D3a spike，排期选型后回写（§7）。
- **P1-2（外部系统身份未 pin）**：系统注册身份承载字段就地可变 ⇒ 仅 pin
  `approvedConfigVersionId` 不足。新增 `systemContentKey`（确定性内容键、内部保存）与
  `externalSystemVersionId`：进绑定成员行（§2.3/§3）、进 `bindingFingerprint`（§4.6，因此也
  进 `baselineLineageKey` 血缘）、进 run-start pin 元组与 activate / commit 重验（§4.5——
  身份漂移属「输入可信性漂移」必中止）。
- **P2-1（active 权威与状态机解耦）**：单选 **pointer-authoritative**：场景表
  `active_binding_version_id` 单指针为唯一权威（单列构造性唯一），复合 FK
  `(scenario_id, active_binding_version_id)` 防跨场景引用；绑定 status 词表**不含 active**
  （派生谓词）；revoke 与清指针 / 换指针同事务；status-authoritative（partial-unique）变体
  明确不采用，058 先例改为 `runIdentityKey` 部分唯一索引的先例引用（§3/§4.1/§4.5）。
- **P2-2（attempt 与语义 run 键时间冲突）**：`attemptId` 建行即有（服务端生成）、
  `runIdentityKey` NULL→仅在 commit 事务内随快照 / diff / 终态一次落定，
  `UNIQUE (tenant_id, run_identity_key) WHERE run_identity_key IS NOT NULL` 承重；撞索引 ⇒
  attempt 落 `deduplicated` 终态（§5 新增）引用既有 run、零行写入——重放 exact-noop 与并发
  同内容去重收敛为同一机制（§4.4/§4.6）；不拆双对象变体（单对象 + set-once 已闭合时序）。
- **P3**：§8.2-4 空侧正控改为「matched 双桶为 0；非空侧行按键级落
  `only_in_<非空侧>` / `ambiguous` / `identity_invalid`」，不再断言「全 only_in_*」；PR body
  随 rev-3 重写（rev-3 锚、OD-V2-1..7 现状、D1 范围）；分支 rebase 追平 `origin/main`
  `698997cf8`（两锚间 stock-prep 面零变动，唯一受检面变更为 approval FWB 新文件）。
- 变异矩阵同步：§8.2-5/-7 与 §8.2b-1/-10..13（一致性漂移、系统身份漂移各层判别、指针权威
  约束、set-once 与并发 dedup）。

### 12.6 rev-4 吸收记录（2026-07-20，owner rev-3 复审 1×P1 + 3×P2）

- **P1（双扫不能证时点一致）**：owner 反例成立——双扫相等只证「装配产物稳定」，对 ABA 型
  撕裂（页间改后复原）不设防；rev-3 把它列为证明机制属于错误。rev-4 从证明词表移除双扫、
  降为可选稳定性证据；证明闭集收为 `SOURCE_SNAPSHOT_TXN` / `IMMUTABLE_SNAPSHOT_TOKEN` /
  `MONOTONIC_VERSION_PIN`（全投影字段覆盖、单调、无 ABA 才合格）；三者皆不可用的源 V1
  不可作对账输入（范围裁剪而非降级）。反例与「把双扫当证明」均入 §8.2-7 变异。
- **P2（dedup 收束未闭合）**：rev-3 的「撞部分唯一索引 ⇒ 同事务落 deduplicated」在 PG 下
  不可实现（23505 废事务），另开事务补标记则有停在 `compared` 的崩溃卡死窗口。rev-4 冻结
  claim-first：写任何 immutable 行之前 `ON CONFLICT DO NOTHING` 抢租户级语义键 claim；
  胜者同事务写行 + set-once + `complete`；败者读 claim 持有者——complete ⇒ 同事务
  `deduplicated`（键永远 NULL、零行）、非终态 ⇒ `RUN_IDENTITY_CLAIM_PENDING` 可重试失败
  （**该 PENDING 分支 rev-5 已删除,见 §12.7**）；`failed` 同事务释放 claim（complete 永不
  释放），死 attempt 不永久占键；索引降为不变量背书。冲突分支崩溃注入入 §8.2b-14。058 仅为
  partial-index 先例的表述已订正。
- **P2（externalSystemVersionId 无权威来源）**：迁移 057 的 `integration_external_systems`
  为可变行、无版本记录，rev-3 引入的版本 ID 是虚悬概念且各层实际只比内容键。rev-4 按
  owner 处方二选一取**内容键单轨**：删除 `externalSystemVersionId`，`systemContentKey`
  （闭字段清单确定性派生、内部保存）为唯一权威，activate / run-start / commit 三层均以
  「当前重算 = pinned」重验；注册表 create-only 版本化留作独立未来设计门。
- **P2（确定性/换绑边界未冻结）**：排序元组编码冻结为逐分量长度前缀 + 单字节
  `identityKeyClass` 域分隔（`0x01` 有效 / `0x00` invalid），invalid 行键位为空 sentinel、
  按 `canonicalRowDigest` 定序，multiplicity 固定宽度、上界=读取有界上界；裸拼接碰撞、
  sentinel 同域碰撞、溢出均入 §8.2b-15 变异。revoke 切换预选替代版本 = 同一事务内对替代
  版本重跑完整 Activate 校验（§4.1 收紧 + §8.2b-16 变异）。
- **Ratify 影响**：本轮修正对应 owner 暂缓的 OD-V2-1/5/7 三项；OD-V2-3/4/6 维持可接受判定
  不变。D3a spike 语义更新为「三机制合格性评估」，不合格源=范围裁剪非加时（§7）。

### 12.7 rev-5 吸收记录（2026-07-20，owner rev-4 复审 1×P1 + 3×P2）

- **P1（一致性证明缺原子绑定）**：owner 指出逐页回显 token/version 仍可「旧标记配新数据」——
  若标记与页数据来自两次独立读取,ABA 撕裂重现。rev-5 要求**标记是承载该页数据的同一次源
  读取的内在属性**（同一响应/游标推进/事务可见性）,非旁路另取:`SOURCE_SNAPSHOT_TXN` 靠共享
  事务快照天然成立;`IMMUTABLE_SNAPSHOT_TOKEN` 要求页只经 token 作读句柄取得;
  `MONOTONIC_VERSION_PIN` 要求版本标记在返回页数据的同一响应内联。标记与数据不能证同源 ⇒
  该机制不合格 fail-closed（§2.2/§4.6,§8.2-7/§8.2b-17 变异）。
- **P2（claim-first 的 PG 语义不成立）**：owner 指出两点——(a)`INSERT ... ON CONFLICT DO
  NOTHING` 遇并发**未提交**同键会**阻塞等待**对方提交/回滚,并非「不等待」;(b)claim 与
  `complete` 原子同提交 ⇒ 败者永远看不到「已提交但非终态」持有者,`RUN_IDENTITY_CLAIM_PENDING`
  分支不可达。二者均成立。rev-5 处方二选一取**「接受有界等待 + 删除 PENDING 分支」**（比
  advisory-lock 更契合单事务模型）,冻结 READ COMMITTED 下三路:胜者独占;败者阻塞解除后见
  **已提交**的 claim（必属已 complete 的 run,因原子同提交）⇒ SELECT 持有者落 `deduplicated`;
  胜者回滚/`failed` 释放 claim ⇒ 败者 INSERT 成功转正继续。有界等待受对方 commit-事务自身
  时延约束、可接受。§5/§8.2b-13 删除 PENDING,§8.2b-14 崩溃注入扩为三路（含胜者回滚败者转正）。
- **P2（持久/摘要契约不完整）**：§3 全清单补 `reconciliation_run_identity_claim`（
  `(tenant_id, run_identity_key)` 主键 + 胜者 attemptId 引用,claim-only,`failed` 释放）;
  `canonicalRowDigest` 新增确定性契约——字段序按 contractVersion 冻结、每值单字节类型标签
  （`"1"`≠`1`、`""`≠null）、null·空·缺省三分不折叠、数字规范十进制不经浮点、字符串 NFC 归一 +
  固定大小写策略;列为 **D1 必冻 + §8.2b-15b mutation 承重**。外层长度前缀不救内层不确定性。
- **Ratify 影响**：本轮修正续对 owner 暂缓的 OD-V2-1/5/7；OD-V2-3/4/6 维持可接受。claim 有界
  等待属正常行锁竞争、非并发缺陷,不改 D3a「对抗审压并发面」的定性,排期口径不变。

### 12.8 rev-6 吸收记录（2026-07-20，owner rev-5 复审 1×P2）

- **P2（有界等待只是文字承诺,不是机制）**：owner 指出 rev-5 的「等待受对方 commit 事务时延
  约束」在胜者 claim 后 idle-in-transaction 或被长写拖住时并不成立——败者会在行锁上被无限
  吊住,设计上不 bounded。处方采纳:把有界从文字升级为**数据库强制**——claim insert 前
  `SET LOCAL lock_timeout = <bounded>`（有界值实现锁冻结,秒级;可另设 `statement_timeout`
  兜底）,锁等待超限 ⇒ PostgreSQL `55P03` 中止 commit 事务;因 claim 是事务首写,中止时零
  snapshot/diff 已写;回滚后独立小事务记 `failed` reason `RUN_IDENTITY_CLAIM_BUSY`（§5 闭词表
  retryable 类）,调用方以新 attempt 重试。§8.2b-14b 加「对手持未提交 claim 且不推进」场景:
  败者必须在上限内 busy 失败/重试、零 immutable 写,缺 `lock_timeout`（回落无限等待）判红。
  claim+complete 原子性与三路(胜者/败者见 complete/胜者回滚转正)不变——本轮只补「等待封顶」
  这一条硬边界。
- **Ratify 影响**：本轮为 OD-V2-5 的机制补强,不改其推荐方向;OD-V2-1/7 续暂缓待整体复审,
  OD-V2-3/4/6 维持可接受。排期与 D3a 对抗审定性不变（lock_timeout 是标准行锁纪律,非新并发面）。
