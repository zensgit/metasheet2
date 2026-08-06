<!-- 本文是 owner 裁决材料,不是实现记录。落地前请先读本节。 -->

# ⚠️ 当前状态(2026-08-06 更新,先于正文阅读)

本文成文于 `53a30b685`。此后**D1 已经关闭**,所以正文里凡是描述「自比仍是被接受的配置」的
部分,**作为历史分析保留,不再是当前状态**:

| | 缺陷 | 成文时 | **现在** |
|---|---|---|---|
| **D1** | 自比(binding 绑到 target 自身)仍是被接受的配置 | 未关 | **已关** —— `K3_C6_B4_BINDING_SELF_REFERENTIAL`,#4768 已合入 main(`9a061909c`) |
| **D2** | 判据的**证明力** | 成文时:只比 origin | **已实质收窄,但天花板未破 —— 见下** |

D1 的关闭过程本身值得记一笔:第一次修复(让写目标声明 `pairedReadSystemId`、驱动器改绑真实
读记录)**只改了惯例、没改不变量** —— `pipelineSystemIds` 是并集且仍含 `targetSystemId`,
filter 只问「是否集合成员」,全树无 distinctness 断言,所以在 target 上铸的 binding 照样通过。
当时曾被声明为「已修复」,是过强声明,已撤回。第二次才真正拒掉自引用。

**因此:正文第 1 节读作 D1 的病理分析(准确),第 3 节四个方案读作 D2 的候选解(仍然有效)。**

## ⚠️ D2 的形状已经变了(2026-08-06 二次更新,PR #4790 已合 `aa48c3f18`)

本文正文按「判据 = origin 相等」写成。**那个前提已经不成立**,owner 在复审中裁了一刀窄修复,
现已落 main 并经五轮门审:

**判据现在是「认证身份」,不是 origin。** 在凭据边界内部计算
`HMAC(kind | origin | 该记录实际会用来认证的身份)`,并**镜像 adapter 自己的
认证模式解析**(逐字,不是逐意):

| adapter 分支 | 摘要材料 |
|---|---|
| `credentials.sessionId` 为真 | `sessionId=…` |
| `authMode` ∈ {`authority-code`,`authorityCode`,`token`} | `authorityCode=…` |
| 否则(login) | `acctId=…`(取第一个**已定义**值,与 `firstDefined` 一致) |

只有摘要离开凭据边界,profile 永远看不到 acctId;每进程随机密钥,摘要不可逆、跨重启不可关联;
任一部分缺失即 null,而**两个 null 不得相等**。

**这实质收窄了 D2 的一大块**:成文时正文说「只证明两个 baseUrl 共享 origin」——
现在同一台服务器上**不同账套**、**不同授权码**、**不同会话**都会被判为不同实例。
owner 复审时点名的「写错账套」风险,在这三种模式下都已关闭。

### 但天花板没有破,这一条不因上述进展而改变

**被认证的读记录根本不在 C6 的数据路径上。** 真正被 Save 进 K3 的行来自 pipeline 的
staging 替身源;读记录只是那份被认证的**读契约**所命名的对象。
⇒ **即便读/写身份完美相等,也说明不了被写入那些行的来源。**

这不是判据不够好,是判据管不到的地方 —— 要破它需要让被认证的读记录**真的成为数据来源**,
那是架构变更(正文 §3 的 DISSOLVE 方向),不是再加一道门。

### 因此现在要你裁的,是一个更小的问题

原问题「D2 接受为已知限制,还是再做一刀」——**那一刀已经做完了**。剩下的是:

**上述天花板(读记录不在数据路径上),接受为已知限制并永久写进验收结论,还是要按 §3 的
DISSOLVE 方向做架构变更?**

DISSOLVE 的代价见正文:改 B4 模板内容 ⇒ `contentKey` 变 ⇒ **冻结字面量与全部已审批 binding
需重新 mint + 重新审批**;且其删除清单包含 `loadSystemById`,照字面执行会**回退一个已关闭的
逃逸**。

---

## 正文原有的裁决问题(形状已被上文取代,保留以便对照)

**D2 是接受为已知限制,还是再做一刀?**

- **接受**:代价为零,但「origin 相等是配置交叉检查,不是同一台物理机的证明」这句必须永久留在
  验收结论里,不得在任何文档中被读成「同实例已验证」。
- **再做一刀**:代价见正文 §3 各方案的「运维代价」栏。其中 DISSOLVE 会改 B4 模板内容 ⇒
  `contentKey` 变 ⇒ **代码层冻结字面量与全部已审批 binding 需重新 mint + 重新审批**;
  且它的删除清单包含 `loadSystemById`,而那正是承载 kind 门的接线 —— 照字面执行会**回退一个
  已关闭的逃逸**。

正文已给出的两条**决定性否定事实**(它们杀死了大多数设计,先于方案阅读):

1. **K3 从不自报身份。** 全仓扫 `whoami|GetAcct|AcctList|GetDbList|FDBName|InstanceId|ServerName|GetVersion|SysInfo`
   **零命中**,没有任何读取「实例/帐套/数据库」标识的代码路径 ⇒「问两边你是谁」没有可站立的面。
   (限定:这是关于**本仓库**的断言,不是关于 K3 WISE **产品**的断言。)
2. **被认证的 read 记录根本不在 C6 的数据路径上。** 真正被 Save 进 K3 的行来自 staging 替身源
   ⇒ **即便有一个完美的「读记录 ≡ 写记录」证明,它也不能说明被写入的那些行的来源。**
   这不是某个方案的缺陷,是这一整类判据的天花板。

---

# B4 同实例判据（same-instance criterion）— owner 裁决文档

- 复核基线（owner 写下意见时的版本）：`a9963cea6`
- 本文成文基线（当前分支 head）：`53a30b685`，分支 `origin/claude/staging-window-rehearsal-20260805`
- 所有行号均取自 **head `53a30b685`**，与 owner 复核时的行号不同；`origin/main`（`e6523c949`）上 `sameK3Instance` 不存在，本文讨论的整块代码只在该分支上
- 本文为只读分析：未修改仓库、未跑测试、未发网络请求

---

## 摘要（三句）

1. owner 的「target 与自身比较」在他复核的 `a9963cea6` 上**完全成立**，且是结构性的 —— 无论比较函数写得多好都不可能发现读/写错配。
2. head 上已落了一个**部分修复**（`2226c548a`）：它让「绑真实 read 记录」变得**可能**，并把 driver 的做法改了过来；但它**没有让自比变成被拒绝的配置** —— 变的是惯例，不是不变量。
3. 因此存在两个**可以分开裁决**的缺陷：**D1**（自比仍是一个被接受的配置，便宜可关）与 **D2**（即便真的比了两行，证明力也很弱，四个方案没有一个能关）。关闭 D1 **不触及** D2。

---

## 1. 问题

### 1.1 owner 的观察在 `a9963cea6` 上成立，且原因是结构性的

链条如下，每一环都可在源码核对：

1. `#4769` 的 relation check 要求 B4 binding 的 `config.systemId` 必须是 pipeline 的端点之一 —— `k3-wise-c6-write-profile.cjs:268-269`：
   ```js
   const boundSystemId = row.config && typeof row.config === 'object' ? row.config.systemId : undefined
   if (typeof boundSystemId !== 'string' || !PIPELINE_SYSTEM_IDS.has(boundSystemId)) return false
   ```
2. K3 **不能**当 C6 的 pipeline source（`external-write-dry-run` 的 `readSourceRows` 发的是裸 `read({object, limit, cursor})`，K3 以 `K3_WISE_READ_LIST_ROUTE_UNSUPPORTED` 回绝，一次 fetch 都不发）。所以 pipeline source 是非 K3 的 staging 替身。
3. 于是在 `a9963cea6` 的两端点集合里，**唯一**能满足 relation check 的值就是 `targetSystemId`。
4. 而 `targetBaseUrl` 恰恰是从 `pipeline.targetSystemId` 那一行读出来的（head `http-routes.cjs:1132`）。

结论：`loadSystemById(boundSystemId)` 重新读回的就是**产生 `targetBaseUrl` 的同一行**，`sameK3Instance(x, x)` 恒真。当时只有两个可达分支 —— **恒真**（绑 target）与**恒假**（绑非 K3 的 staging source，无 `baseUrl`）—— 由操作员绑哪个端点选择，**读远端 0 次**。owner 的表述准确。

> 掩盖它的是 fixture：测试里注入了一个**忽略入参**、直接返回第三条记录的 `loadSystemById`，那是生产接线**造不出来**的输入。测试证明了**函数**有分辨力，从未证明**门**见过两条记录。

### 1.2 head 上已经落了什么（`2226c548a`）

三处，都是真实改动：

- 写目标记录可以**声明**它配对的读记录，该 id 加入 relation 集合 —— `http-routes.cjs:1114-1118`：
  ```js
  pipelineSystemIds: [
    pipeline.sourceSystemId,
    pipeline.targetSystemId,
    (targetSystem.config && targetSystem.config.pairedReadSystemId) || null,
  ].filter(Boolean),
  ```
- rehearsal driver 改为在**真实 K3 读记录**上 mint B4 —— `stock-prep-window-rehearsal-driver.mjs:340`：`buildK3WiseMaterialListB4Config({ systemId: sourceSystemId })`，同时 target 配置里写 `pairedReadSystemId: sourceSystemId`（driver:168）。
- 增加了 kind 门 —— `k3-wise-c6-write-profile.cjs:376-381`，`K3_C6_B4_BINDING_KIND_MISMATCH`。这是为了堵一个已被复核者构造出来的逃逸：**PLM source 与 K3 target 共享 origin 时，PLM 的读契约可以为 K3 的写背书**。这个门是有价值的，任何方案不得删掉承载它的接线。

在 rehearsal 的拓扑下，门**确实**加载了两条不同的行。

### 1.3 但 owner 的反对**没有被关闭** —— 改的是惯例，不是不变量

- `pipelineSystemIds` 是**并集**，`targetSystemId` 仍在其中（`http-routes.cjs:1114-1118`）。
- filter 只要求「属于集合任一成员」（`c6:268-269`）。
- 全树**没有任何** `boundSystemId !== targetSystemId` 的断言（我逐行读了 `c6:265-274` 的 filter 与 `c6:353-388` 的 test 块，无此判断）。

所以：**在 target 上 mint 的 binding 至今仍然通过**，随后 `loadSystemById(target)` 取回的就是产生 `targetBaseUrl` 的那一行，`sameK3Instance` 仍然恒真。

`2226c548a` 让「绑真实 read 记录」成为**被允许**且**被 driver 采用**的做法，但没有让「绑 target」成为**被拒绝**的做法。**自比仍然是一条绿色通道。**

### 1.4 两个必须分开裁决的缺陷

| | 缺陷 | 现状 | 能否关闭 |
|---|---|---|---|
| **D1** | 自比仍是一个被接受的配置 | 未关闭 | **能**，一条 distinctness 断言即可，且可在 route 级证伪 |
| **D2** | 即便真的比了两行，也只是「两个操作员敲进去的字符串在 origin 上相等」 | 未关闭 | **四个方案没有一个能关** |

**关闭 D1 不等于解决问题。** 若把 D1 的修复宣传为「同实例已验证」，就是本条线反复被抓到的那类过强声明。

---

## 2. 可用的身份材料（这是杀死大多数设计的约束，先于方案陈述）

| 材料 | 来源 | 何时可得 | 可信度 |
|---|---|---|---|
| `config.baseUrl` | 外部系统行的 config JSONB；`k3-wise-webapi-adapter.cjs:200-224` 校验 | 公开投影与 adapter 投影都有；`origin` 不被脱敏改写 | **操作员声明，零远端确认**。这是我们**拨号的地址**，不是服务端对自己的断言。同 origin 不蕴含同 K3；不同 origin 不蕴含不同 K3 |
| `credentials.acctId`（帐套） | 加密凭据；`adapter:1922` 读、`:1932` 放进 login body | **仅** `getExternalSystemForAdapter` 可得 | **只发不收**。全文件仅 4 处出现，从未从任何响应里解析。它是关于「我们的配置」的证据，不是关于「远端」的证据。且属**凭据面** |
| Set-Cookie / SessionId / Token | `adapter:1900-1968`、`:1868-1898` | adapter 内部闭包，从不外露 | 远端返回，但**每次登录都不同**，无法跨记录做等值比较；若进 `capabilityState` 会破 `buildRevision` |
| `testConnection` 结果 | `adapter:1970-1999` | 需有人调用；C6 写源刻意不调 | **无身份内容**。`healthPath` 默认 `null`（`:1791`），此时直接返回合成的 `status: 200`；即使配置了，也**只读 `response.status`，响应体被丢弃** |
| `FItemID` 等行值 | B4 投影 `['FItemID','FNumber','FName','FModel','FUnitID']` | 需真实网络读 | 真·远端返回且实例本地，是全系统唯一**原则上**能分辨两台 K3 的材料。但：撞 values-free 教条；两条记录**不能执行同一读形状**（armed 记录的 readList* 全被剥离，只能 GetDetail）；且**同库克隆出来的两台 K3 行值相同** —— 恰恰是操作员最容易混淆的那一对 |
| `credentialFingerprint` | `credential-store.cjs` | 每个公开投影都有 | **无用**。`encrypt()` 用随机 IV，`fingerprint()` HMAC 的是**密文** —— 两行装**完全相同**的凭据会得到**不同**指纹。明确排除 |
| `pairedReadSystemId` | `targetSystem.config`，经 `external-systems.cjs:93` 的 `config: jsonObject(input.config, 'config')` 落库 | head 上已在用 | **无 allowlist、无审批、不进 contentKey、不进 `capabilityState`（`c6:391-404`）、因而不进 `buildRevision`**。即：**被约束的那一方自己声明由谁来跟它比对**，且改了不产生 409 |

### 2.1 两条决定性的否定事实

**(a) K3 从不自报身份。** 我在 head 上独立扫过 `plugins/plugin-integration-core` 与 `scripts/ops`（`whoami|GetAcct|AcctList|AccountList|GetDbList|FDBName|InstanceId|ServerName|GetVersion|SysInfo`），**零命中**（命中的都是无关的 PowerShell `whoami` 与考勤 approval-instance id）。全树没有任何读取「实例/帐套/数据库」标识的代码路径。因此「问两边你是谁」**没有可站立的面**。
> 限定：这是关于**本仓库**的断言，不是关于 K3 WISE **产品**的断言。adapter 自己写明其 endpoint 词表「NOT CLOSED」。

**(b) 被认证的 read 记录根本不在 C6 的数据路径上。** pipeline source 是 `metasheet:staging` 替身，真正被 Save 进 K3 的行来自那里。**即使有一个完美的「读记录 ≡ 写记录」证明，它也不能说明被写入的那些行的来源。** 这不是本方案族的缺陷，而是这一整类判据的**天花板**，必须在裁决时知道。

---

## 3. 四个方案

### 方案一 — DISSOLVE（合一：把两条腿收进同一条记录）

- **判据**：B4 读契约与 C6 Save 必须解析到**同一行**。比较 `binding.config.systemId` 与 `system.id`。前提是把 B4 的列表读移到**同一记录上的第二个只读对象名**（如 `materialList`），从而绕开 `material` 这个**对象名**上的冲突 —— profile 只在 `name === 'material'` 时武装并剥离 readList*。
- **强制点**：`k3-wise-c6-write-profile.cjs` 的 `test()`；删除 `sameK3Instance` 与 `targetBaseUrl`。
- **能证明什么**：提供 Save 连接（baseUrl + 凭据 + acctId）的那一行**就是** B4 契约命名的那一行 —— 一行，因此**没有一对操作员字符串需要比较**，也没有「比不出来」的状态。它还修掉一个真实的荒谬：今天被认证的 binding 命名的记录**上面根本跑不了 B4 的读**（armed 记录的 readList* 已被剥离，`readPath` 被钉回 GetDetail）。
- **不能证明什么**：**关于远端仍然零证明**。它把「两个未经验证的操作员信任决定」降为「一个」，仅此而已。不能证明时间上的同一性 —— `buildRevision` 哈希的是 `capabilityState` 而非 config，改 baseUrl/凭据不改 `systemId`，仍然通过。不能证明数据血统。
- **绕过方式**：**时间性重指**（dry-run 与 apply 之间改这一行的 baseUrl/凭据）；**遗留并行读记录**（旧 K3 读记录不下线，人继续从它喂 intake，门看不见 —— 这是迁移期的**默认状态**，不是恶意行为）；**对象名作用域的写守卫是真洞** —— `K3_WISE_MATERIAL_PROFILE_REQUIRED` 只作用于 `request.object === 'material'`，而 `mergeOperations` 是**并集**，所以一个带 `savePath` 的 `materialList` 会在持有 Save 凭据的记录上逃出 profile 锁（因此方案自带的只读 pin 是**必需项**，不是附注）。
- **运维代价**：**最大**。B4 模板内容变更 → `contentKey` 变 → 代码层冻结字面量与全部已审批 binding 需**重新 mint + 重新审批**；需要新的 read-smoke preset 变体；`assertMaterialListReadOnlyScope` 的对象名检查要从「恰为 material」放宽到一个封闭集合（这是对一个当前**精确**守卫的真实放松）；下游所有以 `object === 'material'` 为键的消费者（stock-prep intake、读执行路由）必须先审计 —— 方案自陈这是**未完成的前置条件**。
- **两个必须让 owner 看见的点**：(1) 该方案的删除清单包含 `loadSystemById`，而那正是承载 **kind 门**（`c6:376-381`，用来堵已被证明的 PLM 逃逸）与 `pairedReadSystemId` 通道的接线 —— 照字面执行会**回退一个已关闭的逃逸**；(2) 合一会强制 B4 的读用 **Save 记录的凭据**执行，等于取消了「读/写用最小权限双服务账号」这一 ERP 常见姿态。

### 方案二 — DECLARED（声明配对，并把声明冻结进 content key）

- **判据**：在 B4 read-source config 上加**一个**字段承载配对声明，使配对进入 `contentKey`（sha256 覆盖整个规范化 config，`version` 除外）。两种形状：
  - **C1**（保守）：`systemId` 仍为 target，新增 `pairedReadSystemId` = 读记录。
  - **C2**（翻转，作者推荐形）：`systemId` = **读记录** R，`pairedWriteSystemId` = 写目标 W。附加：`pairedWriteSystemId === targetSystemId`（关系）、`systemId !== targetSystemId`（**distinctness**，这是对 owner 的机械答复）、R 必须解析得到、必须是 `erp:k3-wise-webapi`、必须**未被 profile 武装**（因而确实保留 readList*）。
- **强制点**：`read-source-config.cjs`（allowlist 与 normalize **两处必须同改**，否则字段被接受后静默丢弃）、`read-source-k3-material-list-b4-contract.cjs` 模板、`c6` 的 filter 与 `test()`、`http-routes.cjs` 的 `resolveC6WritePlanInputs` 增加 `targetSystemId`。
- **能证明什么**：门**可证地**读了**两条不同的行**（distinctness 是 throw，不是 filter）；配对**骑在 sha256 里面**，因而审批后不可静默重指 —— 改了就是新 draft（对 `status:'approved'` 的过滤不可见），审批后到 dry-run 之间的改动表现为拒绝，dry-run 到 apply 之间表现为 409；并顺带关掉几个**与同实例无关的今日缺口**（mint/approve 只做语法校验，从不查 `integration_external_systems`，所以今天一个已审批 binding 可以命名一个**不存在**或**类型不符**的系统）。
- **不能证明什么**：**同一前端、不同帐套** —— R 与 W 都写 `https://k3.customer.local/K3API`，凭据里 `acctId` 不同 ⇒ 不同帐套、不同法人实体、不同数据。**上述每一项检查都通过**。这在既定约束下**结构上不可关闭**：`acctId` 属凭据面，要读第二条记录的 `acctId` 就得把 `loadSystemById` 从公开访问器扩到 adapter 访问器（把第二条记录的**解密凭据**放上 plan 路径），并把凭据派生数据放进被 `buildRevision` 哈希的 `capabilityState`。冻结绑的是**标识符**，不是标识符指向的**记录内容**（R 的 baseUrl 仍可在审批后被改）。零远端确认。
- **绕过方式**：**无双人控制**（这是整个方案的承重绕过）—— `transition()` 的 `actor` 来自入参，只校验 `row.status === spec.from`，从不比对 `created_by`，所以「owner 声明」实为**一个凭据**而非一次评审；**诚实的错误声明**（人真心相信两台是一台，系统就完美地冻结了一个错误事实）；审批后 / dry-run 前的重指；同 origin 不同帐套；诱饵读记录（R 指向无害 K3，W 指向生产，只要 origin 相同即通过）。
- **运维代价**：**所有现存已审批 B4 行全部失效**，必须重新 mint + 重新审批（C1/C2 相同，不构成两者的区分点）；代码层冻结字面量重钉，且**必须配一条负控**证明旧形状的行**不**匹配；C2 需 owner 修订 `#4769` 的关系谓词（是**契约变更**，不是实现选择）；rehearsal driver 两条记录同指一个 `MOCK_K3_URL`，**无法**演练比较器的否定分支，需要第二个 mock origin。
- **一处必须纠正的自我陈述**：方案称其修订「严格收窄」`#4769`。**不成立** —— `#4769` 拒绝的是「第三条非端点记录」，而该方案正是要放行它。head 上的代码注释在这点上比方案诚实：「NOTE this WIDENS #4769's relation check by one target-declared id」。关系不变量**确实**得以保留（转移到配对轴上），但理由必须如实陈述。

### 方案三 — DERIVABLE（不要指针，从注册表按配置形状推导读记录）

- **判据**：枚举本 tenant+workspace 下 `kind: 'erp:k3-wise-webapi'` 且 `status:'active'` 的记录，把「某个对象条目自带 `readMode === 'list'`」者判为读对端；要求**恰好一个**且不等于 target；再比较完整规范化 baseUrl（origin **加**挂载路径）。
- **强制点**：同上 `test()`；`resolveC6WritePlanInputs` 需注入 `listSystems`。
- **能证明什么**：在 pipeline 作用域内，存在**恰好一条**另外的 K3 记录被配置成执行列表读，且其 API 根与写目标**逐字符相同**。它不需要任何新的操作员声明字段。
- **不能证明什么**：与方案二同级的全部远端空白；此外还多一层 —— 它证明的是「**看起来像**读记录的那条记录」的地址，而不是「实际被读的那条记录」。
- **绕过方式**（**这是本方案被判死的地方**）：**它读的那个键在 B4 的读路径上根本不起作用**。B4 的读由 `read-source-probe-runtime.cjs` 构造的**内存 overlay** 驱动（`readConfigOverlay…readMode='list'` 加 `options.k3ReadMode='list'`），overlay **从不写库**，且 `resolveMaterialReadMode` 取 `optionMode || configMode || 'single_record_detail'` —— 光靠 option 就够。于是存储里的 `readMode` 是**操作员可写、语义惰性、且在正确配置的读记录上可能压根不存在**的装饰键。三个后果：(1) 客户真实的读记录会被判为「不存在对端」而拒绝，唯一的补救是往行里**添加一个运行时从不查阅的装饰键** —— 门在**教操作员伪造自己的证据**；(2) 对端集合**少数**，两条真实读记录指向两台不同 K3、只有一条带该键时，基数读作 1 而**通过** —— 方案自称的「非空泛」控制**反向失效**；(3) 另外，`K3_PROFILE_FORBIDDEN_OVERLAY_KEYS` 的剥离发生在**运行时规范化**（`adapter:756-757` 作用于本地 `normalized` 副本），**存储行仍保留该键**，所以「armed ∩ list = ∅」这条前提在门读取的那一层是**假的**，而方案给它配的守卫测试断言的是另一个命题（恒绿）。
- **运维代价**：隐含强加「每个 workspace 只能有一条 K3 列表读记录」的教条；枚举**未设上限**（`db.select` 默认 1000），截断可掩盖第二条对端而静默通过 —— 而同一文件在 40 行之上刚为 B4 binding 修过同一个缺陷（`B4_BINDING_PAGE_LIMIT` + `K3_C6_B4_BINDING_PAGE_EXHAUSTED`）。

### 方案四 — PROBE（运行时远端指纹）— **不可建**

- **判据**（若可建）：读记录与写记录各自返回**同一个服务端产生的实例标识**。
- **为什么不可建**：需要同时满足三条 ——(a) 服务端产生（非回显我们发过去的值）、(b) 跨会话稳定、(c) 能分辨同库克隆。**全树没有任何候选材料同时满足三条**：session/cookie/Token 满足 (a) 但不满足 (b)（且会让每次 apply 变成 409）；`acctId` 不满足 (a)（`:1922` 读、`:1932` 发，从不解析响应）；`healthPath` 只读 status 且默认 null；行值满足 (a)(b) 但结构上不满足 (c)。
- **额外的两个独立死因**：
  1. **接线上就发不出这个探测**。`test()` 触及第二条记录的唯一句柄是 `b4.loadSystemById`，它绑定在**剥除凭据**的公开访问器上（`http-routes.cjs:1137-1139`）。而 K3 的每一次远端调用都要过 `login()`，后者要求凭据。所以探测第二条记录**在必须决策的那个点上无法认证**。要建就必须把闭包扩到 `getExternalSystemForAdapter` —— 凭据面扩张。
  2. **即使给它一个厂商 endpoint，在今天的接线下它仍会自比**：唯一能取到的操作数就是 target 自己，两次带凭据的往返返回**必然相等** —— 它会发出一个**绿色**信号，而且是通过真实网络调用发出的，任何复核者读起来都像「我们对着活的 K3 验过了」。这比现在的字符串比较**更糟**。
- **一个真实发现，值得记录**：`login()` 在 `credentials.sessionId` 存在时，直接用**操作员配置**合成 headers 并返回，**零网络调用**。任何建立在「登录成功 ⇒ 真有一台 K3 接受了我们」之上的判据，在这条分支上被击穿 —— 且恰恰被该判据要约束的那一方击穿。
- **回魂条件（供 owner 定价）**：需要厂商文档确认 K3 WISE 15.1 存在一个「服务端生成、与请求参数无关、跨会话稳定、且**克隆不继承**」的安装标识。注意最后一条把大多数候选形状（数据库内、注册表内、配置内的 GUID）都排除了 —— 因为测试库正是从生产库还原出来的。目前没有任何一个已知形状能同时满足「跨会话稳定」与「克隆不继承」。

---

## 4. 推荐

**推荐：关闭 D1（结构性、便宜、可证伪），并把 D2 作为一条明示的已知限制记录下来，而不是用一个弱检查把它糊过去。**

具体三步：

**(1) 立刻关 D1 —— 加 distinctness 断言。** 在 `c6` 的 `test()` 里，`binding` 选定之后：若 `binding.config.systemId === pipeline.targetSystemId` 则**拒绝**（独立错误码，例如 `K3_C6_B4_BINDING_NOT_READ_RECORD`，与「无 binding」可区分）。这是**唯一**一个能让「target 与自身比较」在结构上**不可达**的最小改动，而且它**可以**在 route 级证伪，不需要任何生产接线造不出来的注入式 fixture。同时保留 head 已有的 kind 门。
> **但证伪必须自己建**：head 的 driver 拓扑只提供**肯定**一侧（绑读记录 → 通过）。**必须新增一条 route 级负控** —— 在 target 上 mint 的 binding 必须以新错误码被拒 —— **不得只靠单测**：掩盖原缺陷的正是一个注入式 fixture（§1.1）。且 rehearsal 两条记录共用一个 `MOCK_K3_URL`，**它无法充当这条负控**（§6.3）。

**(2) 比较器范围交给 owner 选（见 Q2），本文不替 owner 定。** 需要 owner 知道的事实：`buildEndpointUrl`（`adapter:418-431`）把 `baseUrl` 的 pathname 当作**挂载前缀**合并到 endpoint path 前面，因此 `https://k3.corp/PROD` 与 `https://k3.corp/UAT` **同 origin、不同 K3 数据库**，当前 origin-only 比较**放行**。但把比较收紧到路径**不是免费的**：`buildEndpointUrl` 同时容许两种解析结果相同的写法（`baseUrl=…/K3API` + 相对 readPath，或裸 origin baseUrl + 绝对 `/K3API/…` readPath），而 armed 记录的 readPath 被 profile **钉死**为 `/K3API/Material/GetDetail`，所以裸 origin 是一种**自然的客户配置**，逐字符比较会**误拒**它。自己写归一化器是本仓库反复吃过亏的陷阱。因此只给两个可选项：**(i)** 维持 origin-only，把「同 origin 不同挂载/不同帐套」写成明示残留；**(ii)** 要求两条记录的 `baseUrl` 规范化后**逐字节相同**（简单、可辩护、rehearsal 已满足），代价是一条**显式的操作员约束**而非一个聪明的函数。

**(3) 不假装 D2 已关闭 —— 改名 + 把人的背书写进审批记录。** 该检查的诚实名字是：**「对操作员声明地址的错配 tripwire」**，外加**一次被冻结的人工背书**。真正的保证在窗口期的人身上：操作员分别登录两条 K3 记录的控制台，确认二者服务的是**同一个帐套（同库、同服务器）**，把该确认写进 approval 记录；代码不验证这个事实，只冻结它的结论并拒绝其后的任何变更。文档与 PR body 里**不得**出现任何暗示「已验证两条记录指向同一台 K3」的句子。

**我知道自己放弃了什么（明示）：**

- **放弃了「同一前端、不同帐套」这一类**。这是多法人实体客户**最可能**踩的错配，而它在推荐方案下**完全通过**。要关就必须把第二条记录的解密凭据引上 plan 路径 —— 我判断这个代价高于收益，但这是 owner 的判断题（Q4），不是我的。
- **放弃了配对指针的冻结。** 推荐方案沿用 head 的 `pairedReadSystemId`，而它坐在 target 的**可变、未审批、不进 contentKey、不进 `buildRevision`** 的 config 上 —— 即**被约束的一方自己声明由谁来跟它比对**。方案二把配对搬进 sha256 才能关掉这一条，代价是全部已审批 binding 重新 mint + 重新审批（Q3）。
- **放弃了「被写入的行来自被认证的读记录」这一层**（§2.1(b)）。任何两条外部系统行之间的静态检查都够不到它。
- **放弃了方案一的结构性优势。** 方案一在「可证明性」上其实是四者中最强的姿态（一行，无可比之物），我不推荐它是因为它的迁移面（模板 contentKey 变更、preset 变体、守卫放宽、下游 `object === 'material'` 消费者审计**尚未完成**）远超它多买到的东西，而且它照字面执行会回退一个已关闭的逃逸。若 owner 优先「结构上不可能错配」而非「迁移成本」，方案一是**唯一**值得重开的选项（Q5）。

**不推荐方案三**：其对端判据读的是一个在 B4 读路径上**语义惰性**的键，会同时造成对真实读记录的误拒与对端集合的少数（因而反向失效）。**不推荐方案四**：在既定接线下它无法认证第二条记录，且即使给它一个厂商 endpoint，今天它也只会自比并发出一个**看起来像远端验证过**的绿色信号。

---

## 5. 给 owner 的裁决点

> 每条都可以用一个词回答。

**Q1 — D1 是否立刻关闭？**（加 `binding.config.systemId !== targetSystemId` 的拒绝断言，使自比不可达）
→ **是 / 否**
*若是*：旧 binding **不失效**，但会**被门拒绝**，需在读记录上重新 mint（**同一冻结模板，仅 `systemId` 替换** —— `buildK3WiseMaterialListB4Config({ systemId })` 是模板唯一的自由度）+ 重新审批。**代码层冻结字面量不动，contentKey 形状不变，`capabilityState` 与 `buildRevision` 不变。** 这正是 Q1 与 Q3 的成本分界：Q3 才需要重钉冻结字面量。另：若某部署未设 `pairedReadSystemId`，该门将变成**无条件拒绝**。

**Q2 — 比较器范围取哪一个？**
→ **origin-only（保持现状，明示残留）/ baseUrl 逐字节相同（更严，误拒风险由操作员约束承担）**

**Q3 — 配对声明是否必须进入 content key（即方案二）？**
→ **是 / 否**
*若是*：这是一次 ratified 契约变更（`#4769` 的关系谓词需重述），且全部现存已审批 B4 行需重新 mint + 重新审批。*若否*：接受「配对指针可被 target 单方面改写且不产生 409」。

**Q4 — 是否为了覆盖「同一前端、不同帐套」而允许把 `loadSystemById` 扩到 adapter 访问器（即把第二条记录的解密凭据引上 C6 plan 路径）？**
→ **是 / 否**
*这是本文唯一一处会扩张凭据面的选项；不批准则该类错配保持敞开并作为已知限制记录。*

**Q5 — 是否要为「结构上不可能错配」重开方案一（单记录 + 第二个只读对象名）？**
→ **是 / 否 / 暂缓**
*若是*：需先完成下游 `object === 'material'` 消费者审计（当前**未做**），且不得删除承载 kind 门的 `loadSystemById` 接线。

**Q6 — 是否向厂商索取 K3 WISE 15.1 的实例标识 endpoint 文档？**（要求：服务端生成、与请求参数无关、跨会话稳定、**克隆不继承**）
→ **是 / 否**
*这是唯一能把判据从「操作员声明」升级为「远端证据」的路径，且不在本仓库可解范围内。*

---

## 6. 本文的局限

1. **未跑测试、未发网络请求。** §1 的自比推导是**接线推导**，不是运行时观测。若需机械确认：把 `sameK3Instance` 改成 `return true` 跑 C6 套件，预期只有注入式单测变红、无 route 级测试变化 —— 那将证明没有现实接线在真正行使这个比较。我没有跑（会修改工作区）。
2. **K3 WISE 产品是否存在实例标识 endpoint，未确定。** 我的扫描是关于**本仓库**的断言。adapter 自陈其 endpoint 词表「NOT CLOSED」，因此仓库内的缺席不等于产品的缺席。需厂商文档或对客户 K3 的实测。
3. **客户两条 K3 记录的真实形态未知。** rehearsal 两条记录共用一个 `MOCK_K3_URL` 与一套凭据，因此**它无法演练比较器的否定分支** —— 任何「已验证」的说法都不得以 rehearsal 的绿色为依据。客户现场是「同 origin 不同帐套」还是「不同 origin」，会实质改变 Q2/Q4 的答案。
4. **客户 K3 的 login 响应形状未确定。** adapter 用四个候选路径提取 SessionId，说明该形状是**猜**出来的而非按规范钉死的。
5. **是否有部署设置了 `config.healthPath`、其返回什么，未确定。** 默认 `null`，且即使设置了响应体也被丢弃 —— 今天要用它做任何身份判断都需要改代码。
6. **方案一的下游影响未审计。** 以 `object === 'material'` 为键的消费者（stock-prep intake、读执行路由）我没有逐一核对；这是方案一的**前置条件**，不是细节。
7. **双人控制的缺失我只做了源码级确认**（`transition()` 的 `actor` 来自入参、只校验 `status`），未确认是否有部署层（路由权限、审批流）在别处补上。若有，方案二的承重绕过会相应减弱。
