# 多维表 Cross-base ②b — automation 切片设计锁定 — 2026-06-13

> Status: **DESIGN-LOCK(docs-only,无运行时代码)** — 供 owner opt-in;本文档**不实现任何运行时**,不改任何代码。
> 缘起:②b slice 1(#2582,base `252d44fdf`)已合入跨 base **读**链接(`foreignBaseId` opt-in + `resolveBaseReadable` 读门)。其设计 doc(`multitable-crossbase-2b-capability-design-refresh-20260613.md` §4)把 **automation(写侧跨 base)显式 DEFER 到"自己的切片"**。**本文即那个切片的设计锁定**。
> 自有原则:本文只陈述 MetaSheet 自身的治理原则与不变量;**不引用任何外部产品**。
> 安全敏感:跨 base **写**比读更利(读泄露信息,写改动他人 base 的真实数据)。**权限模型必须 airtight + fail-closed**——下文每条 claim 都对当前已合并代码 file:line 核对。

> **RATIFIED 2026-06-13(owner 标准授权「按建议执行」→ 代行 ratify,fail-closed 优先)** — 实现按此集走:
> - 决策1 = **(a)** `base:admin` 蕴含 write(`BASE_WRITE_PERMISSION_CODES` = `BASE_ADMIN_PERMISSION_CODES`,不加新码)。
> - **决策2 = (b) 触发者权威**(**覆盖本文推荐的 (a) 属主**)。理由:这是承重安全决策,对 owner 承诺取最保守 = **零 confused-deputy**(写以触发者自身权限执行,触发者缺 target-base-write / null-actor 计划触发 = fail-closed 不写,入日志)。代价:计划触发(null-actor)的跨 base 写本切片**不支持**;headline 的**用户触发型**跨部门工作流(申请→审批→履约,有触发者)**不受影响**。owner 可后续显式 opt-in (a) 属主权威以支持计划触发——**宜在限流护栏(§7.1)落地后**(属主权威 + 无配额 + confused-deputy 是最险组合)。
> - 决策3 = **(b)** DEFER 跨 base delete/lock。 决策4 = **(b)** base-write denied → step failed 显式入执行日志。 决策5 = **(a)** update 显式 id 寻址(`targetBaseId+targetSheetId+targetRecordId`)。 决策6 = **(a)** `targetBaseId` 可变 + 执行期重判(automation 无存储跨 base 数据,不照搬 link 字段不可变先例)。
> - **本切片同时收口 §1.3 既存洞**:今天 `executeCreateRecord` 对 `config.sheetId`(可指他 base)裸 INSERT 零校验 = 活的 ungated 跨 base 写;本切片的写门关掉它。

---

## 1. 地基复盘 — slice 1 给了什么 + automation 写路径今天长什么样

### 1.1 slice 1 的跨 base 读地基(已合并,本切片在其旁边建写门)
- **base 级可读性原语** `resolveBaseReadable(req, query, baseId): Promise<boolean>` — `packages/core-backend/src/multitable/permission-service.ts:1244-1264`。派生:① admin role(:1253)→ 任意 base;② 全局 base-read 授权码 `BASE_READ_PERMISSION_CODES`(`multitable:base:read` / `:base:admin` / `multitable:admin`,:114-119 / :1254)→ 任意 base;③ base 属主(`meta_bases.owner_id === actor`,:1256-1263)→ 该 base。缺失/软删 base 不可读。
- **base 权限码两件套**:`BASE_READ_PERMISSION_CODES`(:114-119)、`BASE_ADMIN_PERMISSION_CODES`(`multitable:base:admin` / `multitable:admin`,:121-124)。**注意:今天只有 read 与 admin 两档,没有独立的 `base:write` 码,也没有 base-WRITE resolver。** 本切片要补的正是写门(§2)。
- **`foreignBaseId` opt-in**(slice 1)= 链接字段的 author-time 跨 base 声明 + 三处 `resolveBaseReadable` 读门(univer-meta.ts:2034 / :3648 / :9228)。**这是读侧;写侧从零起。**

### 1.2 automation 的"改记录"写路径今天怎样(逐 sink,file:line)
执行器 `AutomationExecutor`(`packages/core-backend/src/multitable/automation-executor.ts`)。动作分发在 `:1276-1300` 的 `switch`。**三个会改记录数据/锁的 sink**:

| sink | 方法 | file:line | 今天写哪 | 有无跨 base 参数 | 有无 base 写门 | 过 lock 闸? |
|---|---|---|---|---|---|---|
| `update_record` | `executeUpdateRecord` | :1454-1504 | trigger 记录 `context.recordId`@`context.sheetId`(:1488) | **无**(config 只有 `fields`) | **无** | **是** — `ensureRecordNotLocked`(:1478) |
| `create_record` | `executeCreateRecord` | :1506-1532 | `config.sheetId ?? context.sheetId`(:1510)新记录 | **半有** — `config.sheetId` 已可指任意 sheet(:1510) | **无**(裸 `INSERT`,:1515-1518) | 不适用(新记录,无锁) |
| `lock_record` | `executeLockRecord` | :2059-2094 | trigger 记录 `context.recordId`@`context.sheetId`(:2073/:2081)的锁列 | **无** | **无** | 不适用(它**就是**改锁列) |

**没有 `delete_record` 动作**:`AutomationActionType`(`automation-actions.ts:6-18`)不含 delete;DELETE 在本切片**因 sink 不存在而 N/A**(§3 / §8-决策3)。

### 1.3 ⚠️ 已存在的 ungated 跨 sheet 写洞(承重事实 — 本切片是"收口",非"加功能")
- `executeCreateRecord` 在 `:1510` 取 `config.sheetId ?? context.sheetId`,然后 `:1515-1518` **裸 `INSERT INTO meta_records ... VALUES (...)`,零权限校验**。
- **rule-save 期也不拦**:`validateActionObject`(`automation-service.ts:180-189`)只校 `action.type` 是否 canonical(:184)并把 `config` coerce 成 record(:187),**不校 `create_record.config.sheetId`** 的同 base/存在性。
- 后果:**今天一个 automation 可以 `create_record` 到任意 sheet——包括另一个 base 的 sheet——无任何门**。这不是理论:运行期完全开放、配置期零缓解。
- → 因此本切片在 §1/§7 的定位是**收紧一个既存的跨 base 写洞**(今天:ungated 跨 base create → 切片后:gated),不仅是新增 `targetBaseId` 能力。这强化安全叙事,也是 fail-first 矩阵(§6)的基线对照。

### 1.4 承重:automation 的"有效行动身份"今天怎么定(THE 安全决策的输入)
执行器**没有 `req: Request`**——它只有 `queryFn`(`AutomationDeps`,:676-681)。`ExecutionContext`(:663-672)带**两个**与身份相关的字段:
- `actorId?: string | null`(:670)= **触发者**,源自 `payload.actorId`(:734)。**可为 null**:计划触发(scheduler)以 `{ _triggeredBy: 'schedule' }` 入口(`automation-service.ts:561`),**无 `actorId`** → `context.actorId === null`。
- `ruleCreatedBy: string`(:669)= **规则属主/创建者**,源自 `rule.createdBy`(:733)。**恒非空**(规则必有创建者)。

**已有先例 — `start_approval` 的 requester 解析**(同款"trigger_actor vs rule_creator"抉择,且 fail-closed):
- 配置 `StartApprovalConfig.requester.mode: 'trigger_actor' | 'rule_creator'`(`automation-actions.ts:123-125`)。
- 解析:`automation-approval-bridge-service.ts:350-352` — `mode==='rule_creator' ? ruleCreatedBy : (context.actorId || ruleCreatedBy)`;**无 req 也能取该 userId 的权限码**:`listRbacPermissionCodes(userId)`(:99-117,纯 SQL,UNION user_permissions + role_permissions)。
- fail-closed:requester 解析不出 → `ServiceError(...,400,...)`(:354-355);user inactive/not-found → 404(:373-374)。

这证明执行器**有能力**在无 `req` 下、由 userId 解析出权限码并 fail-closed——正是 base-write 门所需。**但**(§2.3 详述)`start_approval` 的 actor 抉择回答的是**身份**(谁当申请人),而跨 base 写门要回答的是**授权**(谁的权限准许这次写)——同机制、不同问题,**不可惯性照搬它的 `trigger_actor` 默认**。

---

## 2. 跨 base 写契约 —「显式 targetBaseId + 执行期目标-base 写权」

### 2.1 契约语句
给 `update_record` / `create_record` 增加可选目标寻址。**当 `targetBaseId` 被设置且 ≠ trigger 所在 base 时 → 这是一次跨 base 写 → 要求该动作的有效行动者(§2.3)在执行期对 target base 持有 base-WRITE 权限**(§2.2 的 `resolveBaseWritable`)。fail-closed:有效行动者解析不出、或缺 base-write → **该 step 失败并写入执行日志,绝不静默写**。

### 2.2 base-WRITE resolver(`resolveBaseWritable` — `resolveBaseReadable` 的写侧对应)

**slice 1 只有 read 与 admin 两档,无写门。** 补法两选一(§8-决策1):

- **(a) `base:admin` 即蕴含 write(推荐,最省 + 贴合现有两码模型)**:写权 = `BASE_ADMIN_PERMISSION_CODES`(`multitable:base:admin` / `multitable:admin`,:121-124)∪ base 属主。**不引入新码**。
- (b) 新增 `multitable:base:write` 码,形成 read < write < admin 三档。

**推荐 (a)**:与既有"read / admin 两码 + owner 派生"对称、零迁移、不与 central RBAC 纠缠。**显式记账其后果**:选 (a),则 `BASE_WRITE_PERMISSION_CODES = { multitable:base:admin, multitable:admin }` 与 `BASE_ADMIN_PERMISSION_CODES`(:121)**完全相同** → 本切片"base-writable" ≡ "base-admin-或-属主",是一道**有意偏高**的门。更细的 `base:write`(让"可写不可管"成为可能)留作**未来独立切片**(§8-决策1 备注)。

**签名必须与 `resolveBaseReadable` 分叉**(承重):后者吃 `req: Request` → `resolveRequestAccess(req)`(:1252);**执行器没有 `req`,只有 `queryFn`**(:678)。故写门**必须吃已解析的 userId**(不是 Request),内部走 `start_approval` 同款 `listRbacPermissionCodes(userId)` + base-owner SQL:

```
// 设计意图(伪代码,非实现):
async function resolveBaseWritable(userId, queryFn, baseId): Promise<boolean> {
  if (!userId) return false                       // fail-closed:无身份 → 不可写
  const codes = await listRbacPermissionCodes(userId)   // 复用 :99-117 同款 SQL,无需 req
  if (codes.some(c => BASE_WRITE_PERMISSION_CODES.has(c))) return true   // admin/base:admin
  // base 属主(对称 resolveBaseReadable :1256-1263)
  const owner = await queryFn('SELECT owner_id FROM meta_bases WHERE id=$1 AND deleted_at IS NULL', [baseId])
  return ownerMatches(owner, userId)
}
```

注:`resolveBaseReadable` 现版用 `req` 拿 `isAdminRole`;写门走 `listRbacPermissionCodes(userId)` 取码再比 `multitable:admin`(等价 admin 蕴含)。这是同一授权事实的两种取法,二者不冲突。

### 2.3 谁的权限 — 有效行动者(THE 安全决策,显式且可辩护)

**这是本设计最尖的一刀。** `start_approval` 的 `actorId || ruleCreatedBy` 默认(:352)在 null-actor 场景**危险**:计划触发(无 actorId)会让跨 base 写**静默以属主权威执行**。对一道既是 fail-closed 边界又可能成为 confused-deputy 的写门,**必须显式定**,不能让 fallback 替你定。

**推荐:以规则属主 `ruleCreatedBy` 作为受门的授权身份**(§8-决策2 默认 (a)),理由:
1. **构造上 null-safe** — `ruleCreatedBy` 恒非空(:669/:733),无需 fallback 链;触发者可能为 null(计划触发,:561),拿它当授权会逼出 fallback,fallback 即藏污。
2. **可预测** — 若选触发者(trigger_actor),则**每个缺 target-base-write 的触发者都让规则 fail**(常态),执行日志被"Alice 能跑、Bob 不能"的神秘失败淹没。
3. **语义自洽** — `targetBaseId` 是属主在规则里配的;以属主权威设门 = "你只能把写接到你**自己写得了**的 base";confused-deputy 被**双重收窄**:per-action opt-in(属主主动配)+ 执行期重判(每次跑都重新核 `resolveBaseWritable`)。

**显式记账接受的 tradeoff**:选属主权威 = confused-deputy(触发者借属主的写权写 target base)。它被"属主主动配 `targetBaseId`" + "执行期重判" + "per-action opt-in"三重约束到可控。owner 可选更高安全的替代(§8-决策2 备选):**(b) 触发者权威**(零越权,但 null-actor 计划触发的跨 base 写必须 fail——因无身份可核);**(c) 两者都需**(触发者 AND 属主都得有 target-base-write,最严)。决策判别:**可预测性 + null-safe(属主)对零越权(触发者)**。

**fail-closed 不变量(无论选哪个有效行动者)**:
- 有效行动者**解析不出**(如选触发者却 null)→ step **failed** 入日志,**不写**。
- 有效行动者**缺 target-base-write** → step **failed** 入日志,**不写**。
- target base 缺失/软删 → `resolveBaseWritable` 返回 false → fail-closed。

### 2.4 update_record 的**完整寻址**(承重 — `targetBaseId` 单独对 update 不自洽)
`create_record` 的 config 已带 `sheetId`(`automation-actions.ts:42`)且执行器已 target `config.sheetId`(:1510)——**create 是跨 base-ready 的**:加 `targetBaseId` + 门 + 校 `targetSheetId ∈ targetBaseId`(claim==truth,镜像墙的 `claimed === actualForeignBaseId`,univer-meta.ts:1129)即干净。

**但 `update_record` 不是**:`UpdateRecordConfig` 只有 `{fields}`(:37),执行器写 `context.recordId`@`context.sheetId`(:1488)即 **trigger 记录**。若 `targetBaseId ≠ trigger base`,trigger 记录**按定义不在** target base → `targetBaseId` 单独**无法指明该更新哪条记录**。故 update 的跨 base 寻址**必须补全** `targetSheetId + targetRecordId`:

- **(a) 显式 id(推荐,本切片)**:cross-base update 要求 config 显式给 `targetBaseId + targetSheetId + targetRecordId`。校验 `targetSheetId ∈ targetBaseId`(claim==truth)+ `targetRecordId ∈ targetSheetId`。
- (b) match-key 查找(`targetBaseId + targetSheetId + 匹配键`,执行期 SELECT 定位记录)——**DEFER**(引入"找记录"语义 + 多/零命中歧义,独立切片)。

→ **据此修正 task 的"给两个写动作加 targetBaseId"**:对 create **足够**(`targetBaseId` + 已有 `sheetId`);对 update **不足**,需 `targetBaseId + targetSheetId + targetRecordId`(寻址模型见 §8-决策5)。

### 2.5 lock 闸的跨 base 重定向(承重 — 今天 lock 查的是错的 sheet)
`executeUpdateRecord` **确实**过 `ensureRecordNotLocked`(:1478),good。但它从 `context.recordId`/`context.sheetId` SELECT 锁行(:1470-1473)、并 UPDATE 同一对(:1488)——**都指 trigger sheet**。一旦 update 跨 base,**lock-check 的 SELECT 与 UPDATE 都必须重定向到 target sheet/record**(`targetSheetId`/`targetRecordId`),否则锁保证**静默地核了错的记录**(核 trigger 记录的锁、却写 target 记录)。这是 §4(lock 交互)与 §6(fail-first)的承重点:**cross-base update 必经 target 记录的 `ensureRecordNotLocked`**。

---

## 3. multi-sink 写枚举(每个 record-mutating 动作的处置)

| sink | file:line | 本切片处置 | 说明 |
|---|---|---|---|
| `create_record` | executor:1506-1532 | **加 `targetBaseId` + 写门 + claim==truth(`targetSheetId ∈ targetBaseId`)+ fail-closed 日志** | config 已有 `sheetId`(:42),寻址就绪;**收紧 §1.3 既存洞** |
| `update_record` | executor:1454-1504 | **加 `targetBaseId + targetSheetId + targetRecordId`(§2.4)+ 写门 + lock 重定向(§2.5)+ fail-closed 日志** | 寻址需补全;lock 闸已在(:1478)但须指 target |
| `lock_record` | executor:2059-2094 | **本切片保持 same-base only**(DEFER 跨 base 锁) | 跨 base 锁语义(锁他人 base 的记录)复杂度高、非数据写;§8-决策3 |
| `delete_record` | — | **N/A(sink 不存在)** | `AutomationActionType`(actions.ts:6-18)无 delete;无 sink 可门 |

**判定 — 跨 base DELETE / LOCK 是否进本切片?DEFER。** delete 无动作可加(N/A);lock 是改锁列非改数据、且跨 base 锁引入"我能锁你 base 的记录吗"的新治理面,与"写记录数据"的本切片正交 → 留独立 gated 切片(§8-决策3)。

**非 record-mutating 动作**(`send_webhook` :1534 / `send_notification` / `send_email` / `send_dingtalk_*` / `wait_for_callback` / `condition_branch` / `start_approval` / `parallel_branch`)**不在本切片**——它们不改记录数据,跨 base 与否无写门可言(webhook 出网是另一治理面)。

---

## 4. 与既有不变量的交互(正交性核对)

### 4.1 与 link 墙(§2a.2)正交 — 记录写 ≠ link-field 写
slice 1 的 `foreignBaseId` 墙治的是 **link 字段的 author-time 跨 base 声明**(字段 schema 层);本切片治的是 **automation 跑时改记录数据**(record data 层)。**两层正交**:link 墙不看 automation 写,automation 写门不看 link 字段。
**组合点(记账,不在本切片处理)**:一个 cross-base `create_record` 可以创建一条**被某个 cross-base link 指向**的记录(link 已由 slice 1 合法 opt-in 建成,target 记录由本切片合法写门创建)。这是两个独立合法机制的**自然组合**,非新洞:link 的存在性合法性由 slice 1 墙保证,记录写权由本切片写门保证,各管各层。

### 4.2 与 slice-1 读门(§2a.3 / §3)正交 — 跨 base 写出的记录仍按常规读门掩
本切片**只开写**,不动读。一条 cross-base automation 写出的记录,被任何 reader 读时**仍走常规的 §2a.3 字段掩码 + §3 base-read 门**——写门不授予任何读豁免。即:能写 ≠ 能读;写进 target base 的记录,reader 若缺 target base-read 仍被掩。**读写两门独立 AND,互不放宽**。

### 4.3 与记录 LOCK(rank-8)交互 — 跨 base 写**必须**尊重 target 记录的锁
- `executeUpdateRecord` **确实经** `ensureRecordNotLocked`(:1478;`record-lock.ts:93-101`:`locked===true` 且 `canEditWhileLocked` 不放行 → throw)。
- **承重(§2.5)**:cross-base update 必须把 lock-check 的 SELECT(:1470-1473)与 UPDATE(:1488)**双双重定向到 target sheet/record**,否则锁核的是 trigger 记录、写的是 target 记录——锁保证形同虚设。
- `create_record` = 新记录无锁,不适用;`lock_record` = 本切片 same-base only,不适用。
- → §6 fail-first:**locked target record → 跨 base update 被 block(step failed,不写)**,与同 base 一致。

---

## 5. 首个实现切片范围(gated MVP)— 一个可审 PR

**Slice(automation)= 两写动作的 `targetBaseId` schema + `resolveBaseWritable` + 执行期写门 + fail-closed 日志 + permission-golden 写维度。** 内容:
1. **Schema / 契约**:
   - `CreateRecordConfig`(actions.ts:41-44)加 `targetBaseId?: string`(缺省=同 base 即 trigger base,向后兼容)。
   - `UpdateRecordConfig`(actions.ts:36-38)加 `targetBaseId?: string` + `targetSheetId?: string` + `targetRecordId?: string`(§2.4 显式 id 寻址;三者全缺=同 base trigger 记录,向后兼容)。
   - **rule-save 校验补全**:`validateActionObject`(automation-service.ts:180-189)今天对 create/update **零 config 校验**;本切片在此(或专用 validator)加 cross-base config 形状校验(targetBaseId 非空时 update 必须三件齐、create 的 targetSheetId 必须给)。
   - **OpenAPI parity**:automation action config 的 spec 同步记 `targetBaseId`(及 update 的三件)+ 描述其跨 base 写语义;过 `verify:multitable-openapi:parity`。
   - **wire round-trip 集成测试**:`targetBaseId` 经真 wire(创建/更新规则 → 读回 rule.actions[].config)往返保真——堵 wire-vs-fixture(白名单/pick/select 投影会静默丢字段;本仓血泪规则)。
2. **`resolveBaseWritable`**(§2.2):吃 userId(非 req)+ `queryFn`;`BASE_WRITE_PERMISSION_CODES` = `BASE_ADMIN_PERMISSION_CODES`(决策1 推荐 a)+ base 属主;复用 `listRbacPermissionCodes` 同款 SQL。
3. **执行期写门 + 有效行动者**(§2.3):`executeCreateRecord`/`executeUpdateRecord` 在跨 base 分支(`targetBaseId` 存在且 ≠ trigger base)先解析有效行动者(决策2 推荐 a = `ruleCreatedBy`)→ `resolveBaseWritable` → 失败则 step failed 入日志(**不写**);update 另需 lock 重定向(§2.5)。
4. **D3/permission-golden 写维度**:在真库 golden(`multitable-permission-golden-d3*.test.ts`,`describeIfDatabase` + plugin-tests.yml DB step)加**新维度** `cross-base-write × {base-write granted, base-write denied}`,断言 §6 矩阵。复用既有 seed/harness,不引新框架。

**显式 DEFER 到各自独立 gated 切片**(边界理由附后):
- **跨 base 速率限制 / 配额(named 攻击向量:Base-A-thrashes-Base-B)** — 一个 Base A 的高频触发器借合法写门**反复写爆** Base B(放大/DoS/写风暴)。**本切片刻意不含限流**;它是**已知但延后**的滥用面,naturally 跟在写门开放之后(§7.1)。**点名记账:这是开写门后第一个要补的护栏。**
- **Yjs 跨 base fan-out** — 写门改的是后端 INSERT/UPDATE;跨 base 写后的实时失效信号 fan-out 到 target base 的房间是独立验证项(实时层无新协议但需独立 fan-out 正确性测试,与权限契约正交)。
- **前端**:cross-base automation builder UI(在动作编辑器里选 target base/sheet/record)——单独 frontend 环,后端写契约稳固后再做。
- **update 的 match-key 寻址**(§2.4b)、**跨 base lock_record**(§3)、**跨 base delete**(待 sink 存在再议)。

**切片边界总理由**:本切片 = "**开一条受治理的跨 base 写记录**"——schema + 写 resolver + 执行期门 + fail-closed + golden,全是**写侧权限契约 + 一个 chokepoint(executor)**,自包含、一个权限域、可独立审与回滚。限流(滥用面)、Yjs(实时层)、UI(前端层)各是不同域/层,强行同 PR 破坏"一次一个显式 opt-in"的 staged 纪律。

---

## 6. Slice fail-first 测试矩阵(canary)

真库 `describeIfDatabase` + 沿用 ②a/slice-1 的 canary 风格:

| canary | 场景 | 期望 |
|---|---|---|
| XW-1 | cross-base `create_record`(`targetBaseId`=另一 base),有效行动者**有** target base-write | **成功**:记录创建到 target sheet@target base |
| XW-1b | cross-base `create_record`,有效行动者**缺** target base-write | **step failed 入日志,无写**(fail-closed) |
| XW-1c | cross-base `create_record`,`targetSheetId ∉ targetBaseId`(claim≠truth) | **step failed,无写**(一致性闸,镜像 :1129) |
| XW-2 | cross-base `update_record`(`targetBaseId+targetSheetId+targetRecordId`),有效行动者**有** target base-write | **成功**:target 记录更新 |
| XW-2b | cross-base `update_record`,有效行动者**缺** target base-write | **step failed,无写** |
| XW-2c | cross-base `update_record`,target 记录**被锁**(且行动者非 locker)| **被 block**(`ensureRecordNotLocked` 经 target 记录,§2.5;step failed,无写)——**即便有 base-write 也挡**(锁优先) |
| XW-2d | cross-base `update_record`,缺 `targetSheetId`/`targetRecordId`(只给 `targetBaseId`)| **rule-save 400 或 step failed**(§2.4 寻址不全,fail-closed) |
| XW-3 | same-base `create_record`/`update_record`(无 targetBaseId,或 targetBaseId==trigger base)| **不受影响**(现状回归;不过写门) |
| XW-4 | 有效行动者解析:计划触发(actorId=null)+ 选属主权威(决策2-a)→ 属主有 target base-write | **成功**(属主恒非空,null-safe);若选触发者权威(决策2-b)→ **fail-closed**(无身份可核) |
| XW-5 | `targetBaseId` 经真 wire 往返(写规则 → 读回 config) | 保真,不被投影丢(wire-vs-fixture) |
| XW-6(基线对照)| **今天**(切片前):cross-base `create_record` 无门 → 写穿 | 记录此为切片**修复前**基线(§1.3),切片后 XW-1b 取代之 |

XW-1c/XW-3 锚定"写门不撕开同 base + claim==truth";XW-2c 锚定 lock 跨 base 优先;XW-4 锚定有效行动者 null-safe;XW-6 锚定本切片是"收口既存洞"。

---

## 7. 风险 + gated 序 + fail-closed 不变量

### 7.1 滥用向量(点名,延后)
**Base-A-thrashes-Base-B**:Base A 的触发器借合法写门高频写 Base B → 写放大 / 资源耗尽 / 跨 base 写风暴。**本切片不含限流/配额**——它是**已知且点名的**延后护栏,是写门开放后**第一**个要补的独立 gated 切片。在它落地前,owner 应将 cross-base 写规则视为受信任配置(per-action opt-in + 属主权威已是约束,但非速率护栏)。

### 7.2 run-as 身份风险
有效行动者选属主权威(决策2-a)= confused-deputy:触发者借属主写权写 target base。约束:per-action opt-in(属主主动配 `targetBaseId`)+ 执行期重判(每跑重核 `resolveBaseWritable`)+ 属主只能配自己写得了的 base。owner 可选触发者权威(决策2-b)消除越权,代价是 null-actor 计划触发的跨 base 写必须 fail。

### 7.3 必守 fail-closed 不变量
1. **无身份不写**:有效行动者解析不出 → step failed,不写(§2.3)。
2. **无写权不写**:缺 target base-write → step failed,不写(§2.2)。
3. **claim==truth**:`targetSheetId ∈ targetBaseId`、`targetRecordId ∈ targetSheetId` 才写;不一致 → failed(§2.4,镜像 :1129)。
4. **锁优先**:locked target 记录 → block,即便有 base-write(§2.5,经 target 记录 `ensureRecordNotLocked`)。
5. **写门不放宽读门**:跨 base 写出的记录仍按常规 §2a.3/§3 读门掩(§4.2)。
6. **same-base 零回归**:无 `targetBaseId`(或 ==trigger base)的动作不过写门、行为不变(§4 / XW-3)。
7. **失败入日志非静默**:所有 fail-closed 拒绝以 step `failed` 显式入执行日志,绝不静默吞写(对照 :1501-1503 / :1529-1531 既有 catch 入日志姿态)。

### 7.4 gated 序(每步独立 opt-in)
**slice 1(读,已合)→ owner opt-in → 本 automation 切片(写)→ 跨 base 限流/配额 → Yjs 跨 base fan-out → cross-base automation UI**,每步单独 named opt-in,**绝不自动接续下一环**(staged opt-in lineage 纪律)。

---

## 8. Owner 决策(每项附推荐默认,可「按推荐」一词确认)

| # | 决策 | 选项 | 推荐默认 |
|---|---|---|---|
| 1 | base-WRITE 怎么定? | (a) `base:admin` 蕴含 write(`BASE_WRITE_PERMISSION_CODES`=`BASE_ADMIN_PERMISSION_CODES`,不加新码);(b) 新增 `multitable:base:write` 码(read<write<admin 三档) | **(a)** — 贴合现有两码 + owner 派生模型、零迁移、不碰 central RBAC;代价是本切片写门 ≡ base-admin-或-属主(有意偏高)。更细 `base:write` 留未来切片 |
| 2 | 受门的**有效行动者**是谁? | (a) 规则属主 `ruleCreatedBy`;(b) 触发者 `actorId`(零越权,但 null-actor 计划触发的跨 base 写必 fail);(c) 两者都需 | **(a)** — null-safe(属主恒非空)+ 可预测(不淹日志)+ 语义自洽(属主配的 target、用属主权威);confused-deputy 被 per-action opt-in + 执行期重判收窄。决策判别:可预测性+null-safe vs 零越权 |
| 3 | 跨 base **delete / lock** 进本切片吗? | (a) 进;(b) DEFER | **(b)** — delete 无 sink(N/A);lock 是改锁列非改数据 + 引入"锁他人 base 记录"新治理面,正交于本切片的"写记录数据" |
| 4 | base-write **denied** 时姿态? | (a) 静默跳过;(b) step failed 显式入执行日志 | **(b)** — automation 是后端跑批,无交互;失败必须**显式入执行日志**(§7.3-7,对照 :1501/:1529 既有姿态)以可观测,绝不静默吞 |
| 5 | `update_record` 的跨 base 寻址模型? | (a) 显式 id(`targetBaseId+targetSheetId+targetRecordId`);(b) match-key 查找 | **(a)** — 无歧义、可 claim==truth 校验;match-key(找记录 + 多/零命中歧义)留独立切片 |
| 6 | `targetBaseId` 在动作上**可变**还是建后不可变? | (a) 可变 + 执行期重判;(b) 不可变 | **(a)** — automation 动作**无存储的跨 base 数据**(每跑重新求值),不像 link 字段的 `foreignBaseId`(改它会废存量 link 数据故不可变,见 refresh-doc §2.5)。执行期每跑重核 `resolveBaseWritable` 已使不可变对安全**非必要**;不反射式照搬字段不可变先例(其理由不迁移) |

---

## 9. 不在本设计

跨 base **限流/配额**(Base-A-thrashes-Base-B,§7.1 点名延后)· Yjs 跨 base fan-out · cross-base automation builder 前端 · 跨 base `lock_record` / `delete`(待 sink)· update 的 match-key 寻址 · 更细的 `multitable:base:write` 码 · central RBAC/auth(永不,多维表内核内解决)。各为独立 gated 切片,owner 逐一 opt-in。

---

## 附:本设计涉及的"会改动什么"(供 owner 评估改动面,非实现)

| 改动点 | file:line(当前) | 改动性质 |
|---|---|---|
| `CreateRecordConfig` / `UpdateRecordConfig` 加 target 字段 | automation-actions.ts:36-44 | 契约 schema |
| rule-save config 校验补 cross-base 形状 | automation-service.ts:180-189 | 校验 |
| `resolveBaseWritable` 新增(吃 userId,非 req) | permission-service.ts(新,旁 :1244) | 写 resolver |
| `BASE_WRITE_PERMISSION_CODES` 常量 | permission-service.ts(新,旁 :114-124) | 权限码(决策1-a 时 = `BASE_ADMIN_*`) |
| `executeCreateRecord` 加 targetBaseId + 写门 | automation-executor.ts:1506-1532 | 执行期门(收紧 §1.3 洞) |
| `executeUpdateRecord` 加 target 三件 + 写门 + lock 重定向 | automation-executor.ts:1454-1504 | 执行期门 + lock 重定向 |
| 有效行动者解析(复用 `listRbacPermissionCodes`) | automation-approval-bridge-service.ts:99-117(复用) | 身份解析 |
| OpenAPI spec 记 target 字段 | openapi base.yml(automation action config) | parity |
| permission-golden 加 cross-base-write 维度 | multitable-permission-golden-d3*.test.ts | 测试 |

> 以上为**设计意图标注**,供 owner 评估范围;**本 PR 不实现其中任何一项**。
