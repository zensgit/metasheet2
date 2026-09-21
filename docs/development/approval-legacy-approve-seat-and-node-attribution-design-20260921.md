# 审批遗留决策端点：席位准入 + 服务端节点归属（设计）

**状态：CANDIDATE（候选）。未裁决、未 ratify、未合并、未开 PR。**
日期：2026-09-21 ｜ 分支：`fix/approval-legacy-approve-seat-and-node-attribution`（自 `origin/main` `5edf4c3e17d3608fa4513b5ffd801142da026dcf`）

本文件是**合同变更声明**，交 owner 裁决。它同时声明一件同样重要的事：**本变更与一份已在仓内的
PROPOSED 设计针对同一个界面、但取舍不同**（§6）。两者不能各自默认生效，必须由 owner 择一或明确并存。

> 本文件不写缺陷复现步骤、不写伪造载荷形状。相关取证只在私有 reviews 里：
> `~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/impl-gate-C-slice1-g3-final-round{3,4,5}-2026092{0,1}.md`
> 以及本轮新增的 `legacy-decision-seat-forgery-repro-20260921.md`。

---

## 1. 变更对象

两条遗留端点，均只对本地 `platform` 实例生效：

| 端点 | 源码 |
|---|---|
| `POST /api/approvals/:id/approve` | `packages/core-backend/src/routes/approvals.ts` |
| `POST /api/approvals/:id/reject` | 同上 |

两者在 OpenAPI 里已标 `deprecated: true`，并已注明「改用 `POST /api/approvals/{id}/actions`」。

## 2. 合同变更（逐条）

### 2.1 准入：新增席位/轮次/状态判据

变更前：`authenticate` + `approvals:act` + 乐观 `version` + `status === 'pending'` 即可写入终态。
变更后：在同一事务内、**任何 DML 之前**，再过一道判据 —— 即 `/actions` 的**同一个**谓词
`resolveCanDecideCurrentNode`（`services/approval-seat-authorization.ts`）：

- **状态**：`instance.status === 'pending'`（两条路由原有的 400 `APPROVAL_STATUS_INVALID` 仍在它之前，
  错误身份不变）；
- **席位**：`assignmentMatchesActor` —— user 席位 `assignee_id === actor`，或 role 席位
  `assignee_id ∈ actor 的已解析角色`。委托席位在**建单时**已经物化成真实 assignment 行
  （`ApprovalAssigneeResolver.pushResolved`），因此无需特判即被覆盖；`source_queue` 席位在此与在
  `/actions` 门一样**什么都不匹配**；
- **轮次**：该席位必须 `is_active = TRUE`，且落在 `decidableNodeKeysForInstance` 里 —— 即
  `current_node_key`，外加实例位于并行域时那些**未完成**的分支前沿。一轮结束时该节点的 assignment 行
  被置为非活动，节点重新激活时写入**全新**一批（新 epoch）；所以「在可决节点上持有一条活动席位」
  **就是**当前轮次判据，**没有**另造第二条轮次谓词。

不通过 ⇒ **403 `APPROVAL_ASSIGNMENT_REQUIRED`**。这是 `ApprovalProductService.dispatchAction` 席位闸
**已有**的错误码，逐字复用；**零新错误码**，因此无需登记 §14.3 PROPOSED。信封沿用这两条路由自己的
`{ ok: false, error: { code, message } }` 形状（未改），message 值无关（不含席位、节点名、actor id）。
OpenAPI 对两条端点**已经**声明了 `403` 响应，所以本条不引入未文档化的响应码。

### 2.2 归属：节点键只由服务端推导

变更前：请求体 `metadata` 原样 `JSON.stringify` 写入 `approval_records.metadata`。
变更后：写入前，`metadata` 里的两个键被**剥离**并由服务端值替换（有剥离即 `logger.warn`，
只记键名常量、不记调用方的值）：

| 键 | 服务端来源 |
|---|---|
| `nodeKey` | 让 §2.1 判据通过的那条 assignment 的 `node_key` |
| `nodeEntryEpoch` | `ApprovalProductService.currentNodeEntryEpoch`（门自己的解析器，见 §3） |

调用方的**其他**metadata 键原样保留（逐字节）。

对**非席位闸**实例（没有 `published_definition_id` 的遗留 platform 行、`plm:` 镜像）：服务端**没有**
任何席位证据可以背书任何节点名，所以**一个节点名都不写** —— 既不写调用方的，也不拿
`current_node_key` 猜一个。调用方那个键仍然被剥离。

### 2.3 明确不变的部分

- **非席位闸实例的准入完全不变**：`decisionDoorIsSeatGated` 对它们为假，`resolveCanDecideCurrentNode`
  因此返回 `true`，行为与今天逐字相同。这是刻意的：`/actions` 也**不**对它们做席位闸（它把它们派到
  `ApprovalBridgeService`，那条路径根本没有 assignment 闸）。在这里收窄，会让这道门比另一道门更严，
  正是这个模块存在的理由所反对的「另造更窄同类物」。
- **顺序**：`assertAttendanceCentralMutationFailClosed`（P17/P22）仍在席位闸**之前**。否则一个无席位者
  在考勤来源实例上会拿到 403 而不是它今天拿到的考勤错误码 —— 在一条本来就被拒的路径上改变错误身份。
- **零迁移、零 DDL。**

## 3. 为什么 `currentNodeEntryEpoch` 被放开可见性

`ApprovalProductService.currentNodeEntryEpoch` 由 `private` 放宽为公开，**函数体一字未改**、
**调用点一个未改**。理由是反面更糟：路由要盖轮次戳就得重写那条
`SELECT DISTINCT entry_epoch … WHERE is_active = TRUE`，连同它的两条 fail-closed 分支
（空 ⇒ 409 结构性错误、多 epoch ⇒ 500 不变量违反）。手抄一份更窄的同类物，正是本仓反复点名的漂移源。

该调用**只在席位闸分支内**发生，且节点键正是 actor 刚被准入的那个节点 —— 所以「无活动 assignment」
那条 fail-closed 分支从这里不可达，而没有任何 assignment 的遗留 platform 行**根本不会**走到它。

## 4. 消费者影响面（普查）

普查范围：`apps/web`、`plugins/*`、`scripts/*`、`packages/*`、`.github/workflows/*`、`docs/**` 的 curl
示例、生成 SDK 的 operationId（`approveApprovalLegacy` / `rejectApprovalLegacy`）。

| # | 消费者 | file:line | 实例形态 | 影响 |
|---|---|---|---|---|
| 1 | `apps/web/src/**` | — | — | **零直调**。`apps/web/src/views/approvalInboxActionPayload.ts` 只构造 `{version, comment/reason}` 载荷，且在 `apps/web/src` 内**零调用方**（只有它自己的定义与 spec）。审批中心 `useApprovalBatchActions.ts:5` 明确走 `/actions` |
| 2 | `plugins/*` | — | — | **零引用**（`git grep "approvals/" -- plugins` 无命中）|
| 3 | `.github/workflows/observability-e2e.yml` | `:191`, `:197` | `demo-1` | **不受影响**。`src/seeds/seed-approvals.ts:7` 只插 `(id, status, version)` ⇒ `published_definition_id IS NULL` ⇒ 非席位闸 ⇒ §2.3 |
| 4 | `.github/workflows/observability-strict.yml` | `:460`, `:466` | `demo-1` | 同上 |
| 5 | `packages/core-backend/scripts/test-approvals-contract.mjs` | `:185`,`:197`,`:209`,`:222`,`:250`,`:298` | `test-approve-*` / `test-reject-*` | **不受影响**。`setupTestInstance` 同样只插 `(id, status, version)` ⇒ 非席位闸 |
| 6 | `packages/core-backend/tests/integration/approval-revoke-terminal-guard.db.test.ts` | `:206`, `:298` | 模板运行时 | **受影响但通过**：两处都以 `approverToken`（`approval_a` 的 user 席位持有者）调用 ⇒ 席位闸放行。本轮实跑 15/15 绿 |
| 7 | 生成 SDK `packages/openapi/dist-sdk/index.d.ts` | `:631`,`:652`,`:20729`,`:20773` | — | 仅类型声明；仓内**零调用点**。请求 schema 未变（`metadata` 仍是 `additionalProperties: true` 的可选对象），故 SDK 无需重生成 |
| 8 | `packages/openapi/src/paths/approvals.yml` | `:532-575`, `:576-619` | — | **本轮不改**。两条端点已声明 `403`，本变更不新增响应码；把「`nodeKey` 由服务端推导」写进 description 是纯文档收益，但会连带要求重生成 `dist/`，列为后续项（§8）|
| 9 | `docs/**` 的 curl 示例（`docs/PR132_CI_FIX_REPORT.md:101` 等）| — | `demo-1` | 历史记录，非可执行消费者；且同属非席位闸形态 |

**边界要写清楚，不要把「仓内枚举为空」说成「没有别的消费者」。** 仓外调用方（移动端、外部集成、
运维脚本）**无法**用 grep 证明其不存在。对它们的兼容性论证只能是：**新增的拒绝只命中从未持有过
合法席位的调用者** —— 一个本来就该走 `/actions`、并且在 `/actions` 上会被同一个错误码拒绝的调用者。
一个持有席位、诚实调用的仓外消费者，在本变更下读数逐字不变（本轮 `(3)` 正控与 `(4)` 判别腿即此）。

## 5. 历史归属方案（**不从写入修正倒推可信**）

本变更只约束**未来**写入。它**不**、也**不能**使 pre-fix 的遗留行变得可信 —— 那些行的
`metadata.nodeKey` 仍然是调用方自报的，事后无从分辨哪一条是诚实的。建议交 owner 的处置是：

1. **不回填、不改写历史行。** 任何把服务端值「补写」进旧行的动作都是在制造一个无法证伪的归属，
   比留着一条来路不明的行更坏。
2. **下游读侧对「无服务端席位佐证的历史行」一律阻断并登记，而不是猜。** 具体到 C-1 撤销轮的席位推导：
   一条 `approve` 行只有在能被**服务端记录**（该 actor 在该节点的 assignment 行）背书时才可用于推导
   席位；不能背书的，答案是**阻断 + 登记**（走 C-1 已有的 `CANCEL_ROUND_SEAT_INELIGIBLE` /
   `seat_unresolvable` 类答案），**不得**回退给历史被委托人、也不得从「现在写入已经正确了」推出
   「那条旧行大概也是对的」。
3. **可区分性要做成数据，不是约定。** 本变更落地后写入的行，其 `nodeKey`/`nodeEntryEpoch` 是服务端派生的；
   pre-fix 的行没有这个性质。**当前实现没有给行打时代标记**，所以「这条行是 pre-fix 还是 post-fix」
   今天只能靠时间戳与部署时点推断 —— 这是一个**已知缺口**，不是已解决项。若 owner 需要可机核的区分，
   需要一条额外的持久化标记（本候选**未**实现，因为那会引入迁移/DDL，超出本次零迁移的边界）。
4. **规模未知。** 生产库里 pre-fix 遗留行的数量与形态不在本次授权范围内，**未普查**。因此本文件
   **不**声称「影响面很小」。

## 6. 与既有 PROPOSED 设计的关系（**必须由 owner 裁**）

`docs/development/takeover-beiliao-20260821/multitable-approval-integration-design-20260915.md`
（已在 main）§「缺口·最高优先」与其护栏 #1、以及它自己的 owner 问题 **#8**，针对**同一对端点**提出了
一个**更强**的处置：对 `published_definition_id IS NOT NULL` 的实例一律 **409 `APPROVAL_RUNTIME_UNSUPPORTED`**，
并配开关 `APPROVAL_LEGACY_TERMINAL_ROUTES_ENABLED` 默认关。该问题**至今未裁**。

两者的关系，逐条说清楚：

| | 本候选 (c) | beiliao 设计 (a) |
|---|---|---|
| 收窄的是 | **谁**可以驱动（席位）+ 行**记在哪个节点**（归属） | **做什么**（对模板运行时实例整个移除该能力） |
| 模板运行时实例 | 有席位者仍可用 | 一律 409 |
| 非模板运行时实例 | 不变 | 不变 |
| 是否修「裸终结」 | **否** | 是 |
| 开关 | 无 | 有，默认关 |

**本候选是一个 PROPOSED 产物的更窄同类物 ⇒ 按本仓规矩，这是合同变更，须由 owner 裁，不能默认并存。**
若 (a) 被 ratify，本候选在模板运行时实例上即成为**死代码**（那条路径先被 409 挡掉），但在非模板运行时
platform 行上仍然活着（归属剥离那一半）。若 owner 选择先落 (c) 再议 (a)，也必须知道 (c) **没有**修掉
(a) 所针对的那个问题。

**本候选明确不修的事**（不得把本交付读成「遗留路由现在安全了」）：这两条端点被准入之后所**做**的事
一字未改 —— 仍然直接写终态，**没有**节点推进、**没有**执行器的完成事件、**不**唤醒桥。一个持有席位的
审批人走遗留 `/approve`，照样把一张模板运行时单据搁浅在原地。

## 7. 回滚

**代码回退即可，零数据补偿。**

- 无迁移、无 DDL ⇒ schema 层无回滚动作；
- 回退代码后，两条端点恢复到「不查席位、原样收 metadata」的旧行为；
- 本变更期间写入的行，其 `nodeKey`/`nodeEntryEpoch` 是服务端派生的**正确**值，回退后它们仍然是正确值，
  **不需要**、也**不应该**被改写；
- 被本变更 403 拒绝过的请求**没有写入任何行**（验收里逐条以 `approval_records` 行数差 = 0 断言），
  所以没有「半成品」需要清理；
- 唯一的回退副作用是：旧行为重新可用。若在回退窗口内有调用方依赖了新的拒绝语义（例如把 403 当作
  「该走 /actions」的信号），它会重新收到 200 —— 这是行为恢复，不是数据损坏。

## 8. 后续项（本候选**未**做，不要读成已做）

1. OpenAPI description 补一句「`metadata.nodeKey` / `nodeEntryEpoch` 由服务端推导，客户端同名键被忽略」，
   并重生成 `packages/openapi/dist/`（本轮未做，避免 dist 重生成与本变更混在一起）；
2. 历史行的时代标记（§5.3），需迁移，超出本次零迁移边界；
3. §6 的 owner 裁决；
4. 生产库 pre-fix 遗留行的普查（§5.4）。
