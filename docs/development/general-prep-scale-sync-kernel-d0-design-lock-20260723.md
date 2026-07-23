# 通用备料 D0 — 规模化数据同步内核设计锁（三产品模式 × 正交 capability 矩阵）

**日期**：2026-07-23　**状态**：**PROPOSED（草案，未 ratify）**——owner 裁定"可进入 D0 起草，还不能 ratify"；本稿吸收其两项 P1 修正（capability 正交化、large-bom-jobs 仅可复用合同形状）与全部细则修正。
**分支**：`claude/prep-p1a-substrate-proof-20260722`。**与 #4437 关系**：不互为 blocker——#4437 用**基础模式**完成有界机制验收，不等待本 D0。**纪律**：ratify 前零实现（仅允许只读 feasibility spike）、零 arm、不动现有守卫一字。

---

## 0. 范围与非目标

**范围**：source → staging → diff → apply 全链的规模化形态（用户量/数据量增长后的执行、证明、传输、存储形态）。
**非目标（本 D0 明确不做）**：不改现有 `stock-preparation-readonly-source-run.cjs` 守卫语义；**不首发**全量内容寻址去重（先 retention/分区/压缩取得真实存储数据再决策——复杂度与权限风险过高，且跨租户内容寻址是存在性侧信道）；**不采用** `CHECKSUM_AGG` 式源侧自证（信任方向错误：让源自证源=循环信任）；**不**以单纯调大页数/limit 应对规模（挪墙不拆墙）。

---

## 1. 三种产品模式（用户面）

| 模式 | 用户看到的能力 | 底层策略 |
|---|---|---|
| **基础** | 按项目、BOM 或业务键同步 | 有界 view 或受控 key，**同步完成** |
| **高级** | 整项目、全量物料、批量对账 | **异步 job + 一致性快照 + staging + sealed artifact** |
| **企业** | 持续增量同步 | **Change Feed（CT/CDC）+ 删除墓碑 + 周期全量校验** |

**冻结规则**：
1. **preflight 自动判定可用模式，双向不静默**——既不静默降级，也不静默升级；模式选择与判定依据写入 run evidence。
2. **模式依赖矩阵**：企业模式前置 = 该源**至少一种高级采集组合可用**（水位失效的唯一恢复路径是全量重同步；无高级组合 ⇒ 失效即死路 ⇒ preflight 拒绝启用企业模式）。
3. 用户演进路径：初期只选系统与项目/BOM（基础）→ 数据增大升后台全量（高级）→ 持续运营启增量（企业）——**复杂度按需解锁，不让所有客户预付高级连接器成本**。

---

## 2. 正交 capability 矩阵（P1-1 修正后冻结）

> **A1 修订（2026-07-23，GIP-D0 联动）**：本矩阵**降为 CertifiedReadActionProfile 的认证 schema**（其中 `applyMode` 维度拆出，独立为 CertifiedApplyProfile——read-action 认证书只含 acquisition/consistency/continuation/completeness 四维）——运行时只可选择被认证的具名 action-profile（`bridge.bounded_read.v1` 等），**不得**自由组合维度；组合空间只在认证时使用（坐标声明 + §8 电池按 profile 实例化为合规套件）。见 `gip-d0-general-integration-platform-design-lock-20260723.md` §3。

> 旧四类（BOUNDED_KEY_READ 等）混合了采集/一致性/续读/证明多维度（如 SNAPSHOT_KEYSET_READ 同时说分页与一致性、SEALED_EXPORT_MANIFEST 同时说传输与恢复）。**改为五个正交维度**，每维冻结枚举；组合合法性与恢复策略**由矩阵推导**，不另设自由表。

```
acquisitionMode:      BOUNDED_READ | PAGED_READ | SEALED_EXPORT | CHANGE_FEED
consistencyProof:     SOURCE_SNAPSHOT_TXN | IMMUTABLE_SNAPSHOT_TOKEN | MONOTONIC_VERSION_PIN
continuationLifetime: SINGLE_REQUEST | CONNECTION_BOUND | DURABLE_TOKEN
completenessProof:    SHORT_PAGE | DECLARED_TOTAL | SIGNED_MANIFEST
applyMode:            SYNCHRONOUS_UOW | STAGED_GENERATION
```

**A2 修正（owner P2）**：profile 认证书对一致性维声明**集合** `supportedConsistencyProofs: [] | [...]`——三值闭集**不扩**；**空集 = 诚实声明"无快照证明"**（不是第四种证明，"有界"不得伪装成一致性）。空集可否被接受由**场景角色政策**决定：stock-prep 的 bom_source 可按场景策略接受（基础模式单页读），material-reconciliation 的角色**必须拒绝**。

**恢复策略（推导，非另配）**：
- `CONNECTION_BOUND` 一致性（快照随连接死）断线 ⇒ **整轮重读**（续页=跨快照缝合，禁止）；
- `IMMUTABLE_SNAPSHOT_TOKEN` + `DURABLE_TOKEN` ⇒ **允许续页**（durable snapshot token 是**冻结的一致性机制**，非未来扩展位——temporal/AS OF、库快照、导出冻结件皆属之）；
- `SEALED_EXPORT` ⇒ **允许续 chunk**（重传不重导；chunk 绑 manifest hash）；
- `BOUNDED_READ` ⇒ 整次重跑（单页，天然整轮）。

**典型合法组合 ↔ 模式映射**（非法组合 preflight 拒绝并给专用失败码）：

| 组合 | 模式 |
|---|---|
| `BOUNDED_READ × supportedConsistencyProofs:[]（无快照证明，场景政策定可否接受） × SINGLE_REQUEST × SHORT_PAGE × SYNCHRONOUS_UOW` | 基础（即 #4437 出口②形态） |
| `PAGED_READ × SOURCE_SNAPSHOT_TXN × CONNECTION_BOUND × SHORT_PAGE/DECLARED_TOTAL × STAGED_GENERATION` | 高级（live 快照读，断线整轮） |
| `PAGED_READ × IMMUTABLE_SNAPSHOT_TOKEN × DURABLE_TOKEN × SHORT_PAGE/DECLARED_TOTAL × STAGED_GENERATION` | 高级（可续页） |
| `SEALED_EXPORT × IMMUTABLE_SNAPSHOT_TOKEN(导出即冻结) × DURABLE_TOKEN(chunk 续传) × SIGNED_MANIFEST × STAGED_GENERATION` | 高级（导出） |
| `CHANGE_FEED × MONOTONIC_VERSION_PIN × DURABLE_TOKEN(水位) × DECLARED_TOTAL(变更集) × STAGED_GENERATION` | 企业 |

**兼容兜底**（确定性分片、离线导入）：**不天然标弱**——若具备一致性 snapshot + 完整 coverage manifest + 签名，可记为强证明；evidence 必须记录**具体 proof class**，不得冒充上述组合。

---

## 3. 共同执行内核管线（三模式共享）

```
approved config
  -> capability preflight            （矩阵判定；双向不静默；结果入 evidence）
  -> attempt/job                     （基础=同步 attempt；高级/企业=durable job）
  -> source-consistency proof        （§6.1，按 consistencyProof 维度）
  -> transactional page/chunk checkpoint（读取、checkpoint、页证据同事务原子落地）
  -> private staging                 （未 seal 前对 persist/diff 不可见）
  -> canonical digest                （仓内冻结规范化序列化 + sha256/分区 Merkle root）
  -> sealed artifact                 （封印=digest+行数+identity/multiplicity+chunk receipt 集）
  -> multiset-aware SQL diff         （§7；禁裸 EXCEPT）
  -> checkpointed apply              （STAGED_GENERATION，§4）
  -> immutable run evidence          （values-free）
```

**全程冻结原则**：values-free evidence / 幂等 / fail-closed。**artifact 本体是业务行数据（非 values-free）**——归私有治理面（租户隔离、留存策略、访问审计）；evidence 只含 count/hash/version/proof-class；**artifact 引用与内容不得出现在公开 issue/PR**。

---

## 4. Generation 可见性模型（owner 修正后冻结）

> 「`applied == sealed 行数` 后翻转」**不够**——相同行数可以是错误内容。

**Seal 等式（四项全满足才可翻转）**：

```
applied row count
+ canonical multiset digest
+ identity/multiplicity（键与重数逐一对账）
+ complete chunk receipt set
== sealed artifact
```

**模型**：
1. 每次 apply 写入**新的私有 `generationId`**（staging/generation 专用 schema——**新表**，不是在现有行上追加状态列）；
2. 下游查询**只读 `activeGenerationId`** 指向的 generation；
3. 全部 chunk 完成后**重算** canonical digest（对实际落库内容，非对声称）；
4. 最后一个**短事务 CAS 翻转** active pointer，**同事务**落 run/audit 终态；
5. 失败 generation **永不公开**——可重试或按 retention 清理。

**解除 24,999 行写入墙**：chunked apply 使单事务不再约束总量。**前置**：先把该墙的 provenance 钉进实现票（本仓 grep 无此字面量——若为运行时实测墙，须写明测得条件与真实约束表达式：PG 参数上限/单事务时长/锁竞争中的哪个），数字有出处才谈"解除"。

---

## 5. large-bom-jobs 盘点（P1-2 修正后：只复用合同形状，不当通用 substrate）

代码实况（`stock-preparation-large-bom-jobs.cjs`，已逐条核验）：

| # | 实况 | 证据 |
|---|---|---|
| 1 | background expansion **一次性**调 `expandPlmProjectBom`，非逐页 checkpoint | :495 |
| 2 | 完整 rows 整体塞进**单个** `job.artifact` | :440-441 |
| 3 | apply chunk 逐批**直写正式目标**（`applyStockPreparationPlan`）——暂停时部分数据已可见 | :858 |
| 4 | 并发锁 = **进程内** `Set` | :75 `activeCheckpointApplyRuns` |
| 5 | durable store 契约仅 `get/set`，**无 CAS/lease** | :335/:342/:379 等 |

**可复用（合同形状）**：状态词表（queued/running/paused…）、scope/principal 形态、durable-store fail-closed 姿态、progress/evidence 形态、chunk checkpoint 概念。
**必须新建（不可复用为规模 runtime）**：**DB lease/CAS**（跨进程互斥）、**分页 staging**（流式入库，不整体入 artifact）、**generation 隔离**、**最终可见性翻转**（§4）。

---

## 6. 各维契约细则

### 6.1 consistencyProof
- `SOURCE_SNAPSHOT_TXN`：源侧快照事务；随连接死（⇒ CONNECTION_BOUND ⇒ 断线整轮重读）。
- `IMMUTABLE_SNAPSHOT_TOKEN`：durable token（temporal/AS OF、库快照、导出冻结件）；允许 DURABLE_TOKEN 续读/续传。
- `MONOTONIC_VERSION_PIN`（企业模式）：CT/CDC 水位。**每次运行必须在同一 snapshot transaction 内验证 `lastVersion >= MIN_VALID_VERSION`**——"CT retention ≥ N× 同步间隔"只是 readiness 指标，**不替代** per-run 在快照内的水位有效性验证；删除墓碑必需，缺失 ⇒ fail-closed。

### 6.2 keyset 稳定全序（不止"校验声明"，要**证明**）
- **表**：核 DB catalog 的 PK/unique index（源侧结构证据）；
- **view**：必须在**同一快照内**做重复键负检（重复键探测查询须返回空）；必要时使用复合键；
- 不满足 ⇒ 降 `SEALED_EXPORT` 或拒绝——**不得静默**。

### 6.3 manifest 签名与密钥生命周期
- **agent 私钥签名、服务端 per-system pin 公钥**；
- 必含：`keyId`、**轮换重叠期**、**吊销版本**、**system binding**、重放防护（manifest 绑 runId/nonce）；
- manifest 绑定四元组：**query + schema + snapshot(token/version) + chunk hash 集**——闭合"导出的=查的、上传的=导出的"。没有密钥生命周期，"签名"是装饰。

### 6.4 budget 词表（超限均 fail-closed 专用码）
每租户并发 job 上限 / 单 run 行数与字节预算 / chunk size 界 / artifact 尺寸上限 / 上传速率界。

### 6.5 失败词表纪律
三层 pin（carry-policy 教训平移）：`deepEqual` exact-pin + 运行时消费者（抛未声明码 ⇒ 内部错，coarse token 不回显）+ 源级不变量（grep 全部抛点 ∈ 词表）。

### 6.6 周期全量校验（企业模式）
**digest 对 digest**：上次物化态 vs 走同一内核的低频全量重读，两者都是**我方对我方持有**计算的 canonical digest/分区 Merkle root；**永不采信源侧聚合自证**。不一致 ⇒ 强制全量重同步。

---

## 7. multiset-aware SQL diff

- diff 下推 PG set-based；**禁止裸 `EXCEPT`**（EXCEPT 去重，吞 multiplicity）；实现形态 = GROUP BY 键 + 重数对账，或 row_number 标注 join。
- **现状保真**：现 JS diff 已显式处理重复组（`stock-preparation-snapshot-diff.cjs` :182-189 `rows.length > 1` 分组）——SQL 化是**迁移不是弱化**；
- 去重 diff 会**掩蔽 idempotency-key 碰撞**（P4 线把同 key 不同内容定为 MANUAL_CONFIRM hold——依赖碰撞浮出而非被吞）。
- 内容寻址若未来引入：**仅限租户内**，且必须保留 path/order/multiplicity。

---

## 8. 验证方式（承重电池；每守卫"禁用 ⇒ 红"）

| 守卫 | mutation 探针 | 期望 |
|---|---|---|
| generation 可见性 | 删 `activeGenerationId` 谓词 | 下游读到未翻转数据 ⇒ 红 |
| seal 等式 | 篡改一行内容（行数不变） | digest 不等 ⇒ 拒翻转 ⇒ 红 |
| CAS 翻转 | 构造并发双翻（TOCTOU 纪律：真并发，非顺序论证） | 恰一胜 |
| keyset 全序 | view 注入重复键 | 同快照负检 ⇒ 红 |
| 水位 | 令 `MIN_VALID_VERSION` 越过水位 | fail-closed |
| manifest | 改任一 chunk 一字节 / 换 keyId 未 pin | 签名/哈希拒 |
| 词表 | 偷加/删值；抛未声明码 | 三层 pin 各红 |
| staging 隔离 | seal 前从 persist/diff 面读 | 不可见 ⇒ 违反即红 |

---

## 9. 落地序（owner 定序）

1. **#4437**：基础模式完成有界机制验收（不等本 D0）；
2. **本 D0 冻结**（capability 矩阵 / consistency proof / job / artifact / budget / 失败词表）→ **ratify 门**；
3. 异步 job + sealed staging + generation schema（**unarmed**）；
4. 并行：SQL snapshot/keyset 与 Bridge export/manifest——**Bridge 侧先做 feasibility spike**：SEALED_EXPORT 虽省交互分页，但新增加密上传、私有存储、签名轮换、清理与重放防护；**先比较真实改动面（vs 交互分页协议改造），spike 结论决定首选，不预断**；
5. multiset SQL diff + checkpointed apply（解除写入墙；先钉 24,999 provenance）；
6. 高级模式 UI；
7. 企业模式（CHANGE_FEED + 墓碑 + 周期全量校验）。

---

## 10. 边界

- ratify 前零实现（仅只读 spike）；全程 unarmed；不动现有守卫一字；
- artifact 私有面纪律（§3）；本 D0 自身 values-free；
- 本 D0 与 W3/G1 设计锁（`general-prep-w3-consumption-and-g1-emit-seam-design-locks`）并行独立，互不 blocker。
