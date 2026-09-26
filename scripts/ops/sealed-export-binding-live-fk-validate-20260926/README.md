# 073 sealed-export 绑定 live FK：普查 / 补救 / VALIDATE 脚本包（2026-09-26）

> **本包未在任何真实库执行。** `01` 是只读普查；`02 -v APPLY=1` 与 `03` 是
> **生产写入**，按 AGENTS.md「决策机制」属 owner（O）层「先批后动」，必须由
> owner 亲自执行或亲自授权后执行。本包只交付可审的脚本与证据。
> 输出**只有计数与布尔**（values-free）：不打印 binding id、系统 id、租户或任何行值，
> 日志可原样作为证据贴出（贴之前仍自己看一眼）。

与 `scripts/ops/live-id-fk-validate-20260920/` 同形：同一套 preamble 契约、同样
「01 只读 → 02 默认干跑 → 03 按 SQLSTATE 分类」三步、同样的 `verify/` 自证结构。
差别只在：这里没有 id 清单（values-free），补救动作是「退役」而不是「置空指针」。

## 1. 这包在补什么洞

迁移 `packages/core-backend/src/db/migrations/zzzz20260926140000_sealed_export_binding_live_external_system_fk.ts`
给 073 表 `integration_sealed_export_stock_prep_bindings` 加了：

- STORED 生成列 `live_external_system_id = CASE WHEN status = 'ACTIVE' THEN external_system_id END`；
- 外键 `fk_sealed_export_stock_prep_binding_live_external_system`：
  `(live_external_system_id) → integration_external_systems(id)`，`ON DELETE RESTRICT`，**NOT VALID**。

`NOT VALID` 的含义：此后每一条 INSERT、每一条改变该键的 UPDATE（RETIRED→ACTIVE 翻转）都全查全锁；
但**迁移前就已悬空**的 ACTIVE 绑定被容忍、从不扫描。在清掉它们之前约束不能
`VALIDATE`，「没有 ACTIVE 绑定指向已删系统」只是对未来写入的承诺，不是事实。

### 什么算「悬空」

就是外键自己判定的那条（MATCH SIMPLE，生成列对 RETIRED 行为 NULL）：

```sql
status = 'ACTIVE'
AND NOT EXISTS (SELECT 1 FROM integration_external_systems s WHERE s.id = b.external_system_id)
```

`01` 用基础列写这条谓词，所以**迁移前也能跑**（部署前先摸底）；迁移后它再经生成列
复算一次（Q3），两个数必须相等，且 `generated_drift` 必须为 0——这是「生成列定义没漂」的证据。

### 不是 VALIDATE 阻塞、但要知道的一类：租户错配

`tenant_mismatch_active`：ACTIVE 绑定指向的系统**存在**、但属于另一个租户。外键只按
`id`（外部系统主键不含租户，与 057 的 pipelines 外键同形），所以它不挡 VALIDATE；但
插件删除守卫的依赖计数按租户过滤，看不见这种行，于是删除该系统会被数据库以
`23503` 拒绝（系统保留、不悬空），在 HTTP 删除路由上表现为未分类的 500（见 PR 正文
「删除路径」一节的处理建议）。本包只报数，不处理；处理与否是 owner 决定。

## 2. 执行顺序与每步期望输出

三个文件都只有**一种**运行方式：整个文件交给 `psql -f`。preamble 里
`\set ON_ERROR_STOP on`，任何错误都让 psql 以非零码中止。

### 01-inventory.sql —— 只读普查

```bash
psql "$DATABASE_URL" -f 01-inventory.sql > 01.log 2>&1
# 可选：-v schema=public
```

期望输出（按顺序）：

1. `-- generated column present / live FK present / already validated` 后一行三个布尔；
2. Q2 普查块，**恰好一行**：

| 列 | 含义 |
| --- | --- |
| `active_total` | ACTIVE 绑定数。S6-A 是单客户形态（073 `uniq_..._single_customer`：全表至多 1 行 ACTIVE），所以只会是 0 或 1 |
| `dangling_active` | **VALIDATE 会失败的行数**。0 = 直接去 03 |
| `tenant_mismatch_active` | 见 §1「租户错配」 |
| `retired_total` / `retired_system_absent` | 历史行；外键不看它们，只作背景 |
| `inflight_runs_on_dangling` | 引用悬空绑定、状态非终态（非 `CAPTURE_FAILED`/`COMPLETED`）的 run 数。02 不动 runs；这些 run 本来就无法续跑（系统已不在） |

3. Q3 交叉核对块（仅迁移后），**恰好一行**：`generated_drift` 必须为 0；
   `dangling_by_fk_column` 必须等于 Q2 的 `dangling_active`；
4. 最后一行 `INVENTORY_RESULT file=01-inventory.sql status=…`。

**读日志的纪律**：

- 没有 `INVENTORY_RESULT` 行的运行是**不完整**的（中止 / 57014 超时 / 被取消 / 管道截断）。
  **绝不可把「没打印」读成「零悬空」。**
- `status=complete live_column=missing` 表示迁移还没跑，但 Q2 普查照样有效（部署前摸底）。
- `status=incomplete reason=live-column-not-generated` 表示同名列存在但不是生成列——
  迁移本身也会拒绝在它上面继续，先查清楚。

### 02-remediate.sql —— 退役悬空绑定（**默认干跑**）

```bash
# 干跑：照样跑完每一步、打印每步受影响行数，末尾 ROLLBACK
psql "$DATABASE_URL" -f 02-remediate.sql > 02-dry.log 2>&1

# 真写：只有 owner 授权后
psql "$DATABASE_URL" -v APPLY=1 -f 02-remediate.sql > 02-apply.log 2>&1
```

只有**精确字面量 `1`** 开写。`-v APPLY=true`、`APPLY=yes`、`APPLY=on`、`APPLY=0`、不传 —— 全是干跑。

| 步骤 | 动作 | 期望输出 |
| --- | --- | --- |
| 守卫 | 表 / 外键必须存在，否则 `REMEDIATE_ABORT reason=missing-…`、零写入 | —— |
| STEP0 | 快照（`CREATE TEMP TABLE s073_dangling ON COMMIT DROP`） | `dangling` 应等于 01 的 `dangling_active`；`inflight_runs` 等于 01 的 `inflight_runs_on_dangling` |
| STEP1 | 这些行 `status = 'RETIRED'`（UPDATE 上重述整条悬空谓词） | `rows` == STEP0 的 `dangling` |
| STEP2 | 从**活表**重数悬空 | `0` |
| STEP3 | `APPLY=1` 且 STEP2 ≠ 0 → `REMEDIATE_ABORT reason=still-dangling`，整单回滚 | 只在真写时执行 |
| 末尾 | `REMEDIATE_RESULT … mode=apply\|dry-run dangling_before=N retired=N remaining=0` + `REMEDIATE_TX=committed\|rolled-back` | 两行都要看 |

为什么是**退役**：

- `RETIRED` 是 073 自己定义的「不再生效」、删除守卫当作历史、外键本就忽略的状态——满足外键的最小改动。
- **不删行**：073 的 runs 外键（`runs.binding_id → bindings.binding_id ON DELETE RESTRICT`）会拒绝删除有 run 的绑定，而且删除抹掉历史。
- **不能改指向**：`external_system_id` 是 073 的不可变锚点（`trg_…_binding_anchors_immutable`）。
- 退役后：S6-A 运行时只读 ACTIVE 绑定，该租户的备料 sealed-export 路径以
  `SEALED_EXPORT_BINDING_UNQUALIFIED` 拒绝（本来它就不可用：系统已不在）；单客户索引被释放，
  可以重新 provisioning 一条新的 ACTIVE 绑定——外键现在要求它指向**活**系统。

并发：本文件**要求外键已存在**。有了外键，运行期间不会冒出新的悬空 ACTIVE 行（指向缺失系统的
INSERT / RETIRED→ACTIVE 翻转被 23503 拒；删除被 ACTIVE 绑定引用的系统被 23503 拒）。登记而不设防的
一种：STEP1 语句快照之后、有人以**同一 id 重建**了该系统行，STEP1 的子查询看不见它，那条绑定照样被
退役——这是保守方向（之后要重新 provisioning，见 §3）。

### 03-validate.sql —— 把约束坐实（生产写入）

```bash
psql "$DATABASE_URL" -f 03-validate.sql > 03.log 2>&1
# 需要更长的锁等待：-v lock_timeout=30s
```

- 自己设 `lock_timeout` 并 `SHOW` 出来；`VALIDATE CONSTRAINT` 取绑定表的 `SHARE UPDATE EXCLUSIVE`
  与外部系统表的 `ROW SHARE`，不挡普通读写，但排队时会挡住后面的流量。
- 只分类两个 SQLSTATE：`23503` → `status=failed reason=dangling-rows`（回去跑 01、02）；
  `55P03` → `status=failed reason=lock-timeout`（什么都没改，换窗口重试）。
- **故意不抓** `57014` 与其它一切：文件中止、**不打印** `VALIDATE_RESULT`。**没有 RESULT 行 = 未知，去查。**
- 状态非 `complete` 时最后一条语句再抛错，`psql -f` 非零退出。幂等：已 validate 再跑是 no-op（`already_validated=yes`）。
- RESULT 行只有状态、SQLSTATE 与固定文案，不带服务端 detail（那会带出键值）。

## 3. 回滚

### 迁移本身

`down()` 先删约束再删生成列，不读写任何绑定行，有数据时照样安全回退（证据见 PR 正文）。
回退后恢复旧行为：删除被 ACTIVE 绑定引用的系统会成功并留下悬空。

### 02 的逆操作（不建议；正路是重新 provisioning）

被退役的绑定锚定的是**旧**系统内容（`system_content_key` / `config_content_key` 由旧系统内容派生），
即使以同一 id 重建系统，内容键通常也对不上，所以正路是：恢复/重建外部系统 → 用 provisioning CLI
重新开通一条新绑定。确需把原绑定翻回 ACTIVE 时（owner 决定）：

```sql
-- 前置 1：被引用的外部系统行必须已存在（同一 id），否则外键以 23503 拒绝这条 UPDATE。
-- 前置 2：全表不能有别的 ACTIVE 绑定（073 单客户唯一索引），否则 23505。
-- 本包日志不含 id；binding_id 请 owner 在自己的会话里按条件查出，不入证据面。
BEGIN;
UPDATE integration_sealed_export_stock_prep_bindings
   SET status = 'ACTIVE'
 WHERE binding_id = '…'
   AND status = 'RETIRED';
COMMIT;
```

**注意不对称**：03 之后「回滚」意味着让约束重新接受悬空行，只能
`ALTER TABLE integration_sealed_export_stock_prep_bindings DROP CONSTRAINT fk_sealed_export_stock_prep_binding_live_external_system`
再按迁移 `up()` 以 NOT VALID 重建——这是 schema 改动，同样是 owner 层动作。

## 4. 授权点（owner 亲自执行）

| 步骤 | 性质 | 谁 |
| --- | --- | --- |
| `01-inventory.sql` | 只读（会话 `default_transaction_read_only = on`），只输出计数与布尔 | 可由运维以只读角色执行 |
| `02-remediate.sql`（不带 APPLY） | 干跑，末尾 ROLLBACK；但**连接的是生产库** | 需要生产库连接，按现场规矩走 |
| `02-remediate.sql -v APPLY=1` | **写客户生产表**（绑定行状态） | **owner 先批后动（O 层 ②）** |
| `03-validate.sql` | **DDL：把约束提升为 validated**，全表扫描 + SHARE UPDATE EXCLUSIVE | **owner 先批后动（O 层 ②）** |

02 需要 073 绑定表上的 UPDATE 权限（表属主有；073 已对 PUBLIC `REVOKE ALL`）。

## 5. 与迁移的部署顺序

```
迁移 zzzz20260926140000（加生成列 + NOT VALID 外键）
      │        ↑ 01 在迁移之前也能跑：部署前摸底（live_column=missing）
      ▼
01-inventory.sql（只读，随时可跑，跑几次都行）
      │
      ▼   dangling_active > 0
02-remediate.sql（先干跑，把 02-dry.log 交 owner 看）
      │
      ▼   owner 批准
02-remediate.sql -v APPLY=1
      │
      ▼   再跑一次 01，确认 dangling_active = 0
03-validate.sql（owner）
```

- `02` 要求外键已存在（迁移之前跑会 `REMEDIATE_ABORT reason=missing-constraint`、零写入）。
- `02` 与 `03` 之间**必须**重跑 `01`。
- `03` 成功之后，新的悬空 ACTIVE 绑定在数据库层就不可能落地——`verify/` 的 S6 就是这条。

## 6. 自验

```bash
# 只跑静态契约层（无需数据库）
node --test scripts/ops/sealed-export-binding-live-fk-validate-20260926/verify/sealed-export-binding-live-fk-validate-pack.test.mjs

# 全量：指向一个一次性的合成库，绝不能指向真实库
DATABASE_URL=postgresql://<user>@<host>:<port>/<throwaway-db> \
  node --test scripts/ops/sealed-export-binding-live-fk-validate-20260926/verify/sealed-export-binding-live-fk-validate-pack.test.mjs
```

`verify/run-verify.mjs` 用**真实** SQL 迁移 057 + 068…075 建 `s073fx_*` 临时 schema（不设 S6-A 角色
GUC，073/074/075 以「潜伏」形态安装），在迁移前植入合成的 `fx-` 行，再套上 `verify/migration-up.sql`
（与迁移 `up()` 逐句一致，静态层有漂移检查且证明检查会咬）。跑 S1…S11 十一个场景与 PM1…PM7
七个变异；变异全在内存里做（改过的 SQL 走 psql 的 stdin，cwd 设成包目录让 `\ir` 仍能解析），不落盘。
S11 扫描本包文件在 S1…S10 打印过的全部输出，断言其中不含任何 `fx-` 植入值；PM7（01 多打印一列
binding id）证明这条扫描会红、不是空转。

| 变异 | 改动 | 红的断言 |
| --- | --- | --- |
| PM1 | 01 的悬空计数去掉 status 过滤 | S1（`dangling_active` 1→2）与 Q2/Q3 一致性 |
| PM2 | 02 去掉 STEP1（退役） | S4；APPLY 被 STEP3 守卫以 `still-dangling` 中止、零提交 |
| PM3 | PM2 再去掉 STEP3 守卫 | APPLY **静默提交**一张仍悬空的表——守卫存在的理由 |
| PM4 | 02 的 APPLY 门也认 `true` | S3 |
| PM5 | 03 的 lock_timeout 置 0 | S8（等锁、无 RESULT 行） |
| PM6 | **迁移**的生成列去掉 status 过滤 | S1（`generated_drift`=2）；02 之后 03 仍 23503——RETIRED 历史会挡 VALIDATE、让系统删不掉 |
| PM7 | 01 多打印 binding id | S11 values-free 扫描 |
