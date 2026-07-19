# PLM <-> ERP 物料主数据对账 V2 Charter（PROPOSED）— 2026-07-19

> **状态：PROPOSED / doc-only。** 本文把备料通用化计划的下一开发目标收敛为一个真实的
> 第二场景：**PLM <-> ERP 物料主数据对账**。本文不授权运行时代码、迁移、路由、开关、
> 实体机重跑或外部写；运行时实现须等 §10 的 owner 决策与 Charter ratify。
>
> **代码锚：** `origin/main` `e20907b644345e389ff051a150ff62980f068160`。
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

**处理：** 分别生成不可变源快照，以 owner 批准的精确身份键做一对一对账，产出 added、missing、
changed、unchanged、ambiguous 等闭词表结果。V1 不做模糊匹配、别名推断、自动合并或域规则补值。

**输出：** 独立的运行、快照、快照行与差异记录，以及 values-free 证据。任何对外系统写入均不在
本场景内。

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
| `reconciliation_run` | 一次双源对账运行及闭词表状态 | 仅允许 §5 的单向状态迁移；禁止回退或改写身份 |
| `source_snapshot` | PLM 或 ERP 一侧的不可变快照头 | create-only |
| `source_snapshot_row` | 经冻结投影规范化后的快照行 | create-only |
| `reconciliation_diff` | 两个完整快照间的确定性差异 | create-only；仅引用快照句柄 |

人工决议表和值面明细不进入第一版；若需要，另开 RBAC + audit 设计门。

## 4. 不变量

### 4.1 租户与权限

- 所有会产生内部写或持久运行记录的执行，tenant 仅从认证主体派生；body、query、params 中的
  `tenantId` / `workspaceId` / `projectId` / `targetProjectId` / `baseId` steering 在任何
  source、provisioning、records I/O 前拒绝；
- source config 必须属于同一认证 tenant 且状态为 approved；source I/O 前重新读取，提交前以
  同事务锁定验证或 approved-version CAS 证明其所有权和批准版本未变化，具体机制由实现锁冻结；
- V2 是 tenant-level 主数据对账，不借用 stock-prep project scope；
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

- 两侧 source snapshot 都必须完整可证后才能进入 compare；一侧失败不得以另一侧部分数据产出
  「无差异」或有效 diff；
- 身份键为 owner 冻结的精确键。空键、重复键、多行命中、跨侧键规范化冲突均以闭词表
  `ambiguous` / `identity_invalid` fail-closed；
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
- run identity 由服务端根据 tenant、两侧 approved config version、contract version 与完整源
  指纹派生，调用方不能指定租户或持久键；
- 相同输入重放必须 exact-noop，计数和 immutable rows 不增长；相同业务键但内容 / contract
  不同必须响亮冲突，不能覆盖历史；
- 分页读取有界；达到上界但无法证明下一页为空时返回 `READ_UNPROVABLE` 家族错误，不提交 run。

## 5. 场景状态与闭词表（提案）

实现锁应冻结以下最小状态机，命名可由 OD-V2-5 调整但语义不得弱化：

```text
planned -> reading_sources -> snapshots_complete -> compared -> complete
   \-------------- any proven failure --------------------------> failed
```

- `complete` 只允许在两侧完整性、身份唯一性、快照持久化和 diff 原子提交全部成立后出现；
- `failed` 记录固定 family / reason / phase / counts，不保存原始异常；
- 进程崩溃留下的非终态运行不可被查询面当成 complete；重试只能 exact-resume 或创建新 run，
  具体策略在实现锁中冻结；
- 差异词表第一版建议仅 `added`、`missing`、`changed`、`unchanged`、`ambiguous`。

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

## 7. 实施切片（ratify 后才可执行）

任一切片首次新增或改动应用日志 / 内部诊断 telemetry 时，leak-bait 与 redaction mutation
必须作为**同一切片**的退出条件；不得延后到 V3-b 或后续 UI 切片补证。

| 切片 | 内容 | 建议执行 / 审阅 | 退出条件 |
|---|---|---|---|
| V2-a | 独立 manifest、frozen templates、闭词表、flag/permissions contract | Kimi K3 设计审计；Codex 定稿 | schema tests + forbidden-content tests；无 routes/runtime |
| V2-b | 双 approved-source feeder + 两侧完整性预检 | Grok 实现和测试；Codex 逐 diff 复核 | OFF inert；steering pre-I/O；分页边界 mutation |
| V2-c | 独立 immutable snapshots + atomic run | Grok 实现；Kimi 跨模块审计；Codex 安全复核 | 真 PG rollback/replay/ambiguity；meta_fields 物理 id |
| V3-a | 第二场景拉动最小 snapshot/diff core | Grok 机械抽取；Codex 行为审计 | stock-prep + V2 双 contract；完整静态依赖闭包 tripwire |
| V3-b | 路由、权限、values-free 只读 UI / evidence | Grok FE/机械实现；Codex 浏览器与权限复核 | default-OFF；RBAC 双门；leak-bait；真浏览器验收 |

未经每个切片的退出条件和独立复核，不进入下一刀。Grok / Kimi 的绿灯只是证据，不替代 Codex
复核或 owner ratify。

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
4. 一侧空 / 失败被呈现为「无差异」 -> 红；合法且完整可证的空 snapshot 应有独立正控，并按
   另一侧内容产出全 `added` 或全 `missing`，而不是空 diff；
5. 同 run 重放增加 snapshot / diff 行 -> 红；内容变化却返回 noop -> 红；
6. snapshot 行写入后、diff 或 run 终态前注入崩溃仍留下可见成功数据 -> 真库红。

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
| OD-V2-1 | 两个源的产品边界 | **PLM material/item master + ERP material master 的 approved read configs；不读 stock-prep cache** | 冻结 V2 输入与独立性 |
| OD-V2-2 | 身份匹配 | **V1 仅 owner 配置的 exact key；重复/空键 fail-closed；不做 fuzzy** | 解锁 comparator contract |
| OD-V2-3 | 权限 | **独立 `material-reconciliation:read/operate/admin`；不复用 `integration:write` 作为长期权限** | 解锁 manifest / route RBAC 设计 |
| OD-V2-4 | 数据面 | **V1 values-free；值面另开 gated + audited read** | 解锁 evidence UI，值面继续 barred |
| OD-V2-5 | 持久模型 | **run 仅允许 §5 单向迁移；snapshot/row/diff create-only；不建 decision 表** | 解锁 templates / migration 设计 |
| OD-V2-6 | 发布姿态 | **独立 default-OFF flag；仅内部写；`externalWrite=false`** | 解锁 V2-a，仍不授权 ON rollout |

**建议裁决：六项全部按推荐 ratify。** 该裁决只解锁 V2-a；V2-b 及以后仍按 §7 逐刀过门，
不会自动触发运行时开发、发布或实体机执行。

## 11. Charter 退出判据

本 Charter 只有在以下条件同时满足后才从 PROPOSED 转为 RATIFIED：

1. owner 对 OD-V2-1..6 逐项裁决；
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
