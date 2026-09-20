# 数据源删除侧：引用检查与软删合入同一事务并持行锁（PR-A 设计）

- 日期：2026-09-20
- 任务：W7-B PR-A（#5784 owner 保留②的第一刀）
- 基线 sha：`0708051ca`（origin/main）
- 相关：#5784（删除改为先写库后清内存，未上事务）、#5401（引用守卫）、#5783（legacy 重绑必须同写 canonical）
- 上游文档：`docs/development/data-source-remove-ordering-design-20260916.md` §5.2、`docs/integration-consolidation-minimal-plan-20260901.md` §5 PR-2
- 验证记录：`data-source-remove-transactional-lock-verification-20260920.md`

> **本刀不声称并发删除隔离已完成。** 本刀只关闭「绑定在前、删除在后」这一半时序（§3 时序 B）；「删除在前、绑定在后」（§3 时序 A）仍然敞着，需要 PR-B 的 FK 改造，而 PR-B 会改掉 `force` 的语义，待 owner 裁决（§6）。

---

## 1. owner 的要求

> 「#5784 不能因此标为并发删除隔离已完成。后续仍须绑定创建/重绑与删除两侧参与持久化锁协议，不能只给删除加 FOR UPDATE。」

本文档回答「绑定侧怎么参与」并把工作切成两刀：

- **PR-A（本刀）**：删除侧的引用检查与软删/硬删合入**同一个事务**，事务首句 `SELECT id FROM data_sources WHERE id = $1 FOR UPDATE`。绑定侧通过**既有 FK** 的 KEY SHARE 锁被动参与，因此「绑定在前」时序被关闭。不含迁移。
- **PR-B（待裁）**：让软删对 FK 可见（FK 指向「活着才存在」的键），关闭「删除在前」时序。它改 `force` 语义，需 owner 先裁。

---

## 2. 调用链（谁生产输入、谁消费输出）

### 删除侧
```
routes/data-sources.ts  DELETE /:id
  → assertAccess(id, actor)                       # owner / platformAdmin
  → manager.countExternalSystemReferences(id)     # 路由侧「顾问性」预计数：只用于 403/409 文案与 force 审计
  → DataSourceManager.removeDataSource(id, {hardDelete, force})
      BEGIN
        SELECT id FROM data_sources WHERE id=$1 FOR UPDATE     # ① 行锁（本刀新增）
        countExternalSystemReferences(id, trx)                 # ② 事务内权威计数（#5401 守卫，双形态）
        UPDATE data_sources SET deleted_at… / DELETE            # ③ 持久化（#5784 先写库）
      COMMIT
      ④ 清 adapters / connectionPool / scopes
      ⑤ 断连
```
路由侧的预计数**不是门**：它跑在自动提交连接上，只为决定给非管理员返回 403 还是 409、以及 force 审计里的数字。真正阻止删除的是事务内的第二次计数——manager 自己重算，不信任调用方传来的数字（`DataSourceManager.ts` removeDataSource 的 docblock 是权威描述）。

`countExternalSystemReferences` 数两种形态：
- canonical：`integration_external_systems.connection_id = id`
- legacy：`connection_id IS NULL AND config->>'dataSourceId' = id AND config->>'dataSourceOwnerId' = 该源 owner`

### 绑定侧（本刀不改）
```
plugin-integration-core http-routes
  → external-systems.cjs  upsertExternalSystem(input)
      → dataSourceBinder.assertReferenceable(dataSourceId, principal)   # data-source-plugin-facade.ts:617，只读内存
      → db.updateRow(TABLE, …) / db.insertOne(TABLE, …)                  # 写 integration_external_systems
```

两个实读出来的关键事实：

1. **`assertReferenceable` 完全不碰数据库。** `data-source-plugin-facade.ts:617-629` 只调 `manager.assertAccess` + `manager.getDataSource`，两者都只读内存里的 `scopes` / `adapters`。绑定侧今天对 `data_sources` **没有任何一条 SQL**。
2. **插件的 db helper 在结构上够不到 `data_sources`。** `plugins/plugin-integration-core/lib/db.cjs` 把表名白名单硬编码为 `integration_` 前缀（`assertTable`），明确写着没有逃生门。让绑定侧自己 `SELECT … FROM data_sources … FOR SHARE` 必须放宽这个白名单——这是为了读取更宽而扩大作用域，属禁止项，本设计不走。

所以绑定侧只能通过**数据库自己**参与：它已经在参与（FK 的 KEY SHARE 锁），缺的是让软删对 FK 可见——那是 PR-B。

---

## 3. 真 PG 实证：只给删除加 FOR UPDATE 为什么只够一半

环境：本机便携 PostgreSQL **16.9**，默认隔离级别 **READ COMMITTED**。表结构按真实 DDL 复刻，含真实外键
`fk_integration_external_systems_connection_id FOREIGN KEY (connection_id) REFERENCES data_sources(id) ON DELETE RESTRICT`
（定义在 `packages/core-backend/src/db/migrations/zzzz20260902120000_add_integration_connection_binding.ts`）。

### 时序 A：删除在前，绑定在后（`FOR UPDATE` + 现有 FK）—— **本刀不覆盖**

| t | 会话 A（删除） | 会话 B（绑定） | 说明 |
|---|---|---|---|
| 0 | `BEGIN` | | |
| 0 | `SELECT … WHERE id='ds1' FOR UPDATE` | | 拿到行锁 |
| 0 | `SELECT count(*) … connection_id='ds1'` → **0** | | 事务内计数 |
| 1 | （持锁中） | `INSERT … connection_id='ds1'` | FK 触发 **KEY SHARE**，与 A 的 FOR UPDATE 冲突 → **阻塞** |
| 4 | `UPDATE data_sources SET deleted_at=now()` | （仍阻塞） | 软删只改非键列 |
| 4 | `COMMIT` | | 锁释放 |
| 4 | | INSERT 恢复，FK 复查「`ds1` 这一行还在吗？」→ **在**（软删不删行）→ `INSERT 0 1` | |

**终态实测：**
```
 id  | connection_id | ds_soft_deleted
-----+---------------+-----------------
 es1 | ds1           | t
```
→ 悬空引用仍然产生。两侧确实被 FK 串行化了，但**软删对 FK 不可见**，等待中的绑定醒来后复查照样通过。这是「不能只给删除加 FOR UPDATE」的机器证据，也是 PR-B 存在的理由。

### 时序 B：绑定在前，删除在后（`FOR UPDATE` + 现有 FK）—— **本刀关闭**

| t | 会话 B（绑定） | 会话 A（删除） |
|---|---|---|
| 0 | `BEGIN`；`INSERT … connection_id='ds1'`（持 KEY SHARE，未提交） | |
| 1 | | `BEGIN`；`SELECT … FOR UPDATE` → **阻塞** |
| 3 | `COMMIT` | |
| 3 | | FOR UPDATE 返回；`count(*)` → **1** → 抛 409 |

实测 `refs = 1`。没有 FOR UPDATE 时，删除侧在 READ COMMITTED 下看不见 B 未提交的行，会数到 0 并继续删。**本刀落地的正是这一半。**

### 锁序与死锁
两侧锁序一致，都是 **`data_sources` 行在先、`integration_external_systems` 在后**：删除侧显式 `FOR UPDATE` → 再读/写 `integration_external_systems`；绑定侧 FK 在写 `integration_external_systems` 时由 PG 取 `data_sources` 的 KEY SHARE。同序 ⇒ 不构成循环等待。

### 隔离级别假设
READ COMMITTED（PG 默认，本部署实际运行的级别）即可。时序 B 的保证不依赖更强的快照语义：它建立在显式行锁上，`FOR UPDATE` 返回后 `count(*)` 取新快照，恰好能看见「等待期间提交的那些绑定」。

---

## 4. 绑定侧如何参与（PR-B 设计，本刀不落地）

把 FK 指向一个「活着才存在」的键：

```sql
ALTER TABLE data_sources
  ADD COLUMN live_id TEXT
  GENERATED ALWAYS AS (CASE WHEN deleted_at IS NULL THEN id END) STORED;
CREATE UNIQUE INDEX uq_data_sources_live_id ON data_sources (live_id);

ALTER TABLE integration_external_systems
  ADD CONSTRAINT fk_integration_external_systems_live_connection_id
  FOREIGN KEY (connection_id) REFERENCES data_sources(live_id)
  ON DELETE RESTRICT NOT VALID;
```

后果：软删变成 key update，与 FK 的 KEY SHARE 冲突 → 绑定侧成为真正参与者，插件一行不改；等在删除后面的绑定醒来时 FK 复查找不到 `live_id` → 拒绝。同一时序 A 换成新 FK 的实测：
```
ERROR:  insert or update on table "integration_external_systems"
        violates foreign key constraint "fk_integration_external_systems_live_connection_id"
新增悬空行数 = 0
```
`NOT VALID` 让库里已存在的悬空行不会卡住部署（实测植入一行已软删源的引用后迁移照常通过、该行保留待单独清理）。迁移文件已写好并在真 PG 上验证通过，**不随本刀提交**，见 §6。

---

## 5. 本刀落地了什么

`packages/core-backend/src/data-adapters/DataSourceManager.ts`：

- `countExternalSystemReferences(id, executor?)` —— 新增 **executor 参数**。省略时 `?? this.db`，对所有既有调用方与既有测试逐字节等价；`removeDataSource` 传入自己打开的事务，使计数与写在同一连接、同一把行锁之下。
- `removeDataSource` —— ①引用检查 + ②持久化写合入 `this.db.transaction().execute(trx => …)`，事务第一件事是 `SELECT id FROM data_sources WHERE id = $1 FOR UPDATE`；`force=true` 跳过的是**计数**，不是**锁**。
- 409 是**判定**不是持久化失败，因此按 `code` 原样透出，不被翻译成 500；其它任何事务内失败（含计数本身的驱动错误）统一翻译为 values-free 的 `DATA_SOURCE_DELETE_NOT_PERSISTED_CODE` 500，驱动原文只进日志。
- 无 db 的纯内存 manager 走等价旁路：仍调用 `countExternalSystemReferences(id)`（无 executor），非零同样 409；不开事务。
- 源码块注释明确写出「时序 A 未关闭 / PR-B 待裁」，不得被读成隔离完成。

### 5.1 两处语义变化（与 #5784 相比，均已在测试里钉住）

| 场景 | #5784 | 本刀 | 备注 |
|---|---|---|---|
| 事务内计数抛非 42P01 驱动错误 | 原始驱动错误直接冒泡 | 翻译成 values-free 500 `DELETE_NOT_PERSISTED` | 更严格的 values-free；`remove-ordering` 用例断言 |
| 事务内计数命中 42P01（引用表不存在） | 视作 0，删除照常 | 计数仍返回 0，但 PG 已把事务置为 aborted，随后 UPDATE 报 25P02 → 500 | **fail-closed 代替 fail-open**。迁移 057 在每个部署都建了该表，这是姿态说明不是活路径；若要保住 fail-open 需 SAVEPOINT，留给 PR-B 一并考虑 |

### 5.2 测试替身（本刀真正的剩余工作）

三份 fake db 原本没有 `transaction()`，`data_sources` 分支的 builder 没有 `select()/forUpdate()`，事务化后全红。修法：

- `data-source-remove-ordering.test.ts`：把 fake 重构为 `makeExecutor(tag, view)`，`db` 与 `transaction().execute(cb)` 交给回调的 `trx` 是同一套 builder，但每条语句按执行者打标 `@db` / `@trx` 写入有序日志 `ops`；事务对 `rows` 的**暂存副本**操作、回调成功才折回（rollback 是真的）；`transactions[]` 记录每次事务是否提交及其错误。顺序断言由「写库先于清内存」升级为 `for-update → count:canonical → count:legacy → soft-delete`，全部 `@trx`。
- `data-source-scope.test.ts`、`data-source-visibility-authority-matrix.test.ts`：只加 `transaction()`（回调拿同一套 builder）与 `select()/forUpdate()` 直通；顺序契约只钉在 remove-ordering 一处，避免三处漂移。

**表名也是契约的一维（反驳 r1 补钉）。** 反驳者指出：fake 的 `selectFrom(table)` 只对 `integration_external_systems` 分流、其余一律按 `data_sources` 形态回答，`ops` 日志只有 id 与执行者标签，所以把源码里的锁改成 `selectFrom('integration_runs').forUpdate()` 时三份 spec 全绿——「在 data_sources 行上持 FOR UPDATE」这句标题级保证在「锁的对象」这一维上没被证明（`as never` 让 tsc 也拦不住）。修法：

- 三份 fake 一律**表严格**：`data_sources` 是唯一建模的有状态表，`selectFrom / insertInto / updateTable / deleteFrom` 收到任何别的表名直接抛 `fake db: <verb>("<table>") — … models only data_sources`（`integration_external_systems` 仅在 `selectFrom` 上分流到计数 builder）。
- remove-ordering 的 `ops` 三类 data_sources 语句都带表名：`for-update:data_sources:<id>@trx`、`soft-delete:data_sources:<id>@trx`、`hard-delete:data_sources:<id>@trx`（无锁退化为 `select:data_sources:<id>`）；全部顺序断言同步改写。
- 新增 ④「锁取在 data_sources 上」与 ④-敏感性（fake 对 `integration_runs` / 大小写变体 / 空串四个外来表名在四个动词上都抛错，两张合法表不抛）——后者是 ④ 这根杠杆的自检，防止将来有人把 fake 又放宽。
- 对应的内存级变异 M7/M8/M9（锁 / 软删 / 硬删分别指向 `integration_runs`）见验证记录 §4b；M7 = 反驳者的变异 C，修后 3 个 spec 文件 19 条红。

新增用例：① 事务内计数命中引用 → 409、UPDATE 未发出、事务未提交、行逐字节不变；② 计数用的是同一 `trx`（不是 `this.db`），并附一条「敏感性」用例：在原型上把 executor 丢掉时 fake 必须看见 `@db`；③ 无 db 旁路：无引用 → 清内存；计数（spy）非零 → 409 且调用形参不含 executor；force 仍绕过。

---

## 6. 未决阻塞：PR-B 的新 FK 会改掉 `force` 的语义（待 owner 裁）

`force=true` 的现有承诺（见 409 文案）是「平台管理员可以**故意打断引用**」——即**带着引用把源软删掉**。

§4 新 FK 下实测：
```
UPDATE data_sources SET deleted_at=now() WHERE id='ds1';   -- ds1 尚有绑定引用
ERROR:  update or delete on table "data_sources" violates foreign key constraint
        "fk_integration_external_systems_live_connection_id" on table "integration_external_systems"
```
即 **`force` 从「成功、留下悬空引用」变成「根本做不到」**。这是对逃生门语义的实质改动，超出本刀边界。PR-B 开工前需 owner 在三个选项中裁一个：

1. **取消 force**：引用存在就是删不掉，由 DB 兜底；路由的 force 分支与审计字段随之退役。
2. **force 先断引用**：同事务内把引用行的 `connection_id` 置空（或删除引用行）再软删——这是新语义，需要单独设计（谁被通知、legacy 形态怎么办）。
3. **FK 声明 `ON UPDATE CASCADE/SET NULL`**：让软删**静默**改写绑定行，反而更危险，不推荐。

裁决前 PR-B 不开工；本刀与三个选项都兼容。

---

## 7. 覆盖矩阵（写 `connection_id` / `config.dataSourceId` 的入口逐个标注）

| # | 写入口 | 位置 | 写什么 | 状态 |
|---|---|---|---|---|
| 1 | `upsertExternalSystem` INSERT | `external-systems.cjs`（insertOne） | `connection_id` + `config.dataSourceId` | **partial**：时序 B 已关闭；时序 A 需 PR-B |
| 2 | `upsertExternalSystem` UPDATE（含重绑） | `external-systems.cjs`（updateRow） | 同上 | **partial**，同 #1 |
| 3 | `deleteExternalSystem` | `external-systems.cjs` | 删引用行 | **n/a**：减少引用，不制造悬空 |
| 4 | 切换迁移的 backfill | `zzzz20260902120000_…ts` | `connection_id` | **covered**：一次性、离线、与运行时删除不并发 |

**uncovered（本刀明确不覆盖）：**

- **legacy 形态的竞态**：`config.dataSourceId`（`connection_id IS NULL`）这一支**没有 FK**，绑定侧不会取任何 `data_sources` 锁。即使 PR-B 落地，legacy 绑定与删除的竞态仍然敞着；它只被删除侧的 `FOR UPDATE` 挡住「绑定已提交」的情形（计数看得见），挡不住「绑定在飞」。
- **其它持有 dataSourceId 指针、但删除守卫不计数的表**：`integration_stock_prep_source_binding`(079)、read-source-config store 等。既有缺口，非本刀引入，登记待办。
- **`force=true` 路径**：按定义绕过引用检查，仍会留下悬空引用（§6）。
- **硬删（`hardDelete`）**：由 FK 的 `ON DELETE RESTRICT` 保护，本刀只把它纳入同一事务与锁序，未新增覆盖也未削弱。
- **时序 A**（删除在前、绑定在后）：见 §3，PR-B。

---

## 8. 未改动

`routes/data-sources.ts`（路由侧顾问性预计数保留原样）、`http-routes.cjs`、`package.json`、`.github/`、`force` 语义、插件 db helper 的表白名单、任何迁移——均未触碰。
