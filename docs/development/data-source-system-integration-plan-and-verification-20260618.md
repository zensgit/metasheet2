# 数据库 / 系统对接 — 计划与验证汇总(2026-06-18)

> 本文是"数据库连接 → 通用对接"业务线的**计划 + 验证**汇总(完成态交付物)。
> 它索引各刀的设计/验证文档,不替代它们;每个 runtime 写能力仍是**独立 opt-in + 独立 PR + 独立验证**。
> production / batch / 首笔外部写 = 始终独立显式 owner gate。

## 0. 一页结论

- **只读数据库接入(C2)+ 增量(C3)+ 配置体验(C4)+ K3 generic MSSQL seam(C5)+ 外部写 sandbox 链路(C6)**:全部已交付并实体机验收闭合(release evidence #2769 PASS)。
- **通用对接收敛 S1a(合同层)**:可选写能力面 `targetWriteLifecycle`(#2872)+ values-free 加固(#2882,本轮)已落地。
- **S1b(keystone)**:本轮**完成设计锁定**(`generic-integration-s1b-keystone-design-lock-20260618.md`);**实现 GATED**——它触及全系统风险最高的写路径,且暴露一个必须 owner 先签字的高度(altitude)问题。**这是相对"直接实现 S1b"请求的一次显式 scope 偏移,见 §3。**
- **S2(K3)/ S3(模版对象)/ S4(自描述元数据)/ S5(PLM stock-prep 吸收)/ 首笔生产外部写**:均为后续 gated opt-in,各带自己的 gate(见 §5)。

## 1. 状态阶梯

| 阶段 | 内容 | 状态 | 锚点 |
|---|---|---|---|
| C2 | 只读 SQL 源链路 smoke | ✅ done | issue #2600 |
| C3 | 增量 / watermark runtime | ✅ done(core+CI real-DB lock) | #2609/#2619/#2625/#2628/#2631 |
| C4 | UI / 配置体验 | ✅ done | #2643/#2646/#2649/#2652/#2655 |
| C5 | K3 generic MSSQL seam | ✅ done(红线不开) | #2670 PASS/CLOSED;#2700 runbook |
| C6 | 外部写 sandbox 链路 | ✅ done(C6-0..C6-5c + 实体机 controlled bad-row) | #2720;package `d8244ee13`;#2761;PM2 #2820 |
| Release | 总包 + 实体机验收(scoped) | ✅ done | #2769 PASS(package `79ab455e`) |
| **S1a** | 通用可选写能力面(合同层) | ✅ done | #2868 设计锁;#2872 能力;**#2882 values-free 加固(本轮)** |
| **S1b** | 自有 multitable target 走泛化安全写(keystone) | 🔒 **design-locked,impl GATED**(本轮) | `…s1b-keystone-design-lock-20260618.md` |
| S2 | K3 WebAPI target opt-in 同一安全写(sandbox) | 🔒 gated(opt-in + 实体机) | 总锁 §6 |
| S3 | first-class `integration-template` 对象 | 🔒 gated(opt-in) | 总锁 §6 |
| S4 | adapter 自描述元数据 | 🔒 gated(opt-in) | 总锁 §6 |
| S5 | 统一 field-mapping + PLM stock-prep 吸收 | 🔒 gated(低优先,短期不重写) | 总锁 §3/§6 |
| 首笔生产外部写 | sandbox-first 序列后单独一刀 | 🔒 **owner 授权** | 总锁 §5/§6 |

## 2. 本轮交付:S1a values-free 加固(#2882)

**背景**:独立复审指出 S1a 的 keyHash 只堵了 key 一个 vector,result builder 仍原样放行 `error` / `revision` / `metadata` 自由串(P1);并指出总设计锁"OpenAPI parity"是过声明(P2)。

**修复**(`plugins/plugin-integration-core/lib/contracts.cjs`):

- 结构性 values-free(真保证):
  - `revision` → opaque **`revisionHash`**(sha256;保留**相等性**,故 dry-run→apply revision-fence 仍判漂移);
  - **drop free-text `error`**(DB 错误内嵌行值);人类可读原因改落 dead-letter(`sanitizeIntegrationPayload` + 32KB cap)= relocated, not lost;
  - `metadata` → **number\|boolean\|null only**(拒绝字符串/嵌套)。
- 纵深防御(非硬保证):`errorCode` → CODE charset `[A-Z0-9_]{1,64}`(允许全数字 SQLSTATE 如 `42501`);honestly 标注其非硬保证。
- 文档(P2):总设计锁"OpenAPI parity"改为"plugin-local 内部合同,无公开 API surface,OpenAPI 不适用";新增 §6.1 验收 #3(values-free result 形态,逐 vector canary 锁)+ S1b 衔接(result=code-only 分流,dead-letter=sanitized detail)。

**验证**:

- 逐 vector canary(key/error/revision/metadata)+ revision-fence 相等性测试;`adapter-contracts.test.cjs` 绿。
- **非空洞性经验证明**:逐一回退每个结构保证(error/revision),canary 即触发失败(`apply result must not carry alice@example.com`、`lookup result must not carry Acme Corp Ltd`),还原后转绿——证明 canary 落在被处理的输入字段上,不是自洽通过。
- 独立子智能体复审 **APPROVE**:allow-list 投影(不 spread 输入行/匹配)、canary 非空洞、`REQUIRED_ADAPTER_METHODS` **未变**。
- 受影响 pure-node 测试(含 `external-write-dry-run` / `metasheet-multitable-target-adapter` / `stock-preparation-table-actions` / `connector-action-contracts` / `provenance-contracts`)`pnpm install` 后全绿。
- 基础 5-method 合同**未变**;**零 runtime 消费者**(S1a 未接线)。

**PR**:#2882 — **MERGED**(squash `687271dd6`,2026-06-19T01:10:24Z)。已验证落 `origin/main`:`contracts.cjs` 含加固(`revisionHash`/`valuesFreeMetadata`/`assertErrorCode`/`CODE_PATTERN`),`REQUIRED_ADAPTER_METHODS` 未变。

## 3. S1b:设计锁定(本轮)+ scope 偏移声明

**显式声明(诚实优先)**:owner 的指令是"S1b 应继续做 metasheet:multitable sandbox keystone",期望是**实现**。本轮交付的是 **S1b 设计锁**,不是实现——这是一次**主动 scope 偏移**,理由如下,请 owner 知悉并裁决:

- S1b 要把 C6 `dry-run→apply` 安全生命周期从 `data-source:sql-write-gated` 泛化到能力面。盘点 `external-write-dry-run.cjs`(914 行,**全系统风险最高写路径**)发现它与 sql-write-gated 焊死三处,且与 S1a 合同存在一个**高度问题**:`targetWriteLifecycle.lookup/apply` 到底是 planner *内部数据通路* 还是 *证据投影*?——`classifyExisting` 靠**原始行字段值比较**判 add/update/skip,而 S1a 加固后的 `lookup` 刻意 **values-free 无字段值**,二者**无法直接对接**。
- 这是"design-lock first"纪律的典型场景:在安全写路径上,先由 owner 对高度问题签字,再动代码;否则实现极可能在复审被打回。
- 因此本轮把 S1b 从"一刀"细化为**设计锁 + 可机械执行的实现计划**(`generic-integration-s1b-keystone-design-lock-20260618.md`)。

**推荐解 A(双接口拆分)**:planner 已验证的判定 + 安全逻辑**原样不动**;只把写原语**来源**做成可插拔(adapter-backed 原始内向接口取代 host sql-write-gated facade);`targetWriteLifecycle.lookup/apply`(values-free)定位为 **evidence 投影**——这也使 #2882 加固**保持正确**(它就是 evidence 形态)。B(revision 制判定)= 幂等语义变更,需独立验证;C(另起生命周期)= 违反总锁"复用不重造"。

**实现就绪计划**(签字后机械执行,各刀独立 PR + 子智能体审阅):

- **S1b-1**:planner 写原语来源泛化为可插拔(kind 门 + capability-state 断言抽象);**SQL 路径行为零漂移(既有测试原样绿=硬验收)**;新增 capability 写源用 fake/in-memory 写源覆盖 add/update/skip/held/token/fence/per-row/dead-letter。
- **S1b-2**:`metasheet:multitable` target 提供原始内向写源(自有 sheet lookup/insert/update)+ `targetWriteLifecycle`(values-free)evidence 投影。
- **S1b-3**:sandbox pipeline + route + wire-vs-fixture 集成 smoke(dry-run→apply→re-pull 幂等),**零外部写**。

> **裁决请求**:请 owner 对**高度问题(`lookup/apply`=evidence 投影,A 双接口)**签字。签字="go",我即按 S1b-1→2→3 实现。

## 4. 安全红线(继承,逐字保留)

- 凭据只经 credential store;UI 只引用 system/dataSourceId,不复制凭据。
- 首笔真实外部写 = 独立 owner 授权;sandbox-first 序列不变。
- 两阶段 dry-run→apply;per-row 隔离,不 batch-abort;无自动重试打爆;dead-letter 收口。
- K3 Submit/Audit/BOM 红线不开。
- issue / evidence values-free。

## 5. 剩余 gated 项(各带 gate,均非本轮交付)

| 项 | gate | 备注 |
|---|---|---|
| S1b-1/2/3 实现 | owner 对 §3 高度问题签字 | 计划已就绪 |
| S2(K3 WebAPI opt-in) | opt-in + **实体机 smoke**(operator 执行) | 红线保留;仅 sandbox |
| S3(template 对象) | opt-in | K3/PLM 各出一个参考模版 |
| S4(自描述元数据) | opt-in | 替换 `ADAPTER_METADATA` 静态字面量 |
| S5(PLM stock-prep 吸收) | opt-in | 低优先,短期不重写专用链路 |
| 首笔生产外部写 | **owner 授权** | 多样本只读 dry-run→sandbox apply→re-pull 幂等+人工字段保留→生产 |

## 6. 验证汇总

| 维度 | 证据 |
|---|---|
| C2-C6 + Release | TODO 账本 `data-source-system-integration-delivery-todo-20260614.md` 全勾 + #2769 scoped release evidence PASS(package `79ab455e`) |
| S1a 能力面 | #2872(opt-in 假 target 验证 / 非 opt-in 原样通过 / partial 拒绝 / enum-strict) |
| S1a values-free 加固 | #2882:逐 vector canary + 经验回退证明非空洞 + 独立复审 APPROVE + 受影响 suite 绿 + `REQUIRED_ADAPTER_METHODS` 未变 |
| S1b | 设计锁交付(高度问题裁明 + 推荐 A + S1b-1/2/3 就绪计划);实现 gated |

---

_校验脚注:#2882 合并态已核实——`gh pr view 2882` = MERGED(squash `687271dd6`),`git show origin/main:…/contracts.cjs` 含加固且 `REQUIRED_ADAPTER_METHODS` 未变。_
