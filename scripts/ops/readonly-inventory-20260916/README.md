# 只读盘点包（2026-09-16，2026-09-18 复核返修）— CRED-06 / TRG-04 / ADM-08 / ADM-13

这是一个**只读盘点包**：四个 `.sql` 文件加一个共享前言 `_preamble.sql`，全部只含
`SELECT` / `WITH … SELECT`，没有任何 `INSERT` / `UPDATE` / `DELETE` / DDL。目的是在合并
四条在飞/待裁决工作之前，先知道生产库上现在有多少行会受影响——**不做任何回填、不做任何
清理、不改任何表结构**。

> **生产执行状态：未执行。** 本包**从未在任何真实数据库（含 222）上跑过**。真实盘点需要
> owner 另行授权（目标库、只读身份、窗口、超时与输出预算）。下面的验证全部在**本机一次性
> 合成 PostgreSQL 16 的临时 schema**、**全假数据**上完成。

## 0. 2026-09-18 复核返修（F3 / F4 / F5）

| 编号 | 问题 | 修法 |
|---|---|---|
| F3 | `02-trg04` 用 `actions::text ILIKE '%"url":"http://%'` 扫 JSONB 文本。JSONB **不保留排版**，回显形式是 `"url": "http://…"`（冒号后有空格），正常命中被漏成 0 | 改为 **JSON 字段语义匹配**：`jsonb_path_query(actions,'$.**')` 逐层取节点 → `jsonb_each_text` 取成员 → 键名归一化命中 url 类键名 **且** 字符串值（trim 后、不分大小写）以 `http://` 开头。顶层/嵌套/排版/大小写全覆盖 |
| F4 | `01-cred06` 的「受影响 ID」只按对象形状过滤，普通连接也进 ID 列表，计数却不含它 | 计数与 ID 共用同一个 `hit` CTE 与同一个 `WHERE matched_top_level OR matched_headers`，`|ids| == count` 成为可断言的不变量 |
| F5 | 执行指引三处互相矛盾；Q1 只是探针不会自动选互斥分支；`04` 的旧 schema 回退漏了 `is_active` | 统一为**一种执行方式**（整文件 `psql -f`）＋ `\set ON_ERROR_STOP on` ＋ 探针 `\gset` 自动分派兼容分支 ＋ 每个文件末尾输出 `INVENTORY_RESULT … status=complete\|incomplete reason=…` |

证据与正反例清单见 `docs/development/readonly-inventory-pack-verification-20260916.md` §“复核返修”。

## 1. 这四份文件分别解锁什么

| 文件 | 编号 | 解锁 / 喂给 | 一句话 |
|---|---|---|---|
| `01-cred06-secret-keys.sql` | CRED-06 | PR #5648、PR #5681 | `data_sources` 里还有多少行的连接配置（两种列形状）带着秘密形状的键名 |
| `02-trg04-http-targets.sql` | TRG-04 | PR #5619、PR #5649 | 自动化规则（`automation_rules.actions`）和 webhook 订阅（`multitable_webhooks.url`）里还有多少条 `http://`（非 https）目标 |
| `03-adm08-wildcard-permissions.sql` | ADM-08 | 喂 ADM-07 的裁决 | `users.permissions`（两种列形状）、`user_permissions`、`role_permissions`（含经 `user_roles` 继承）里现在有多少行/多少用户持有 `*:*` |
| `04-adm13-declared-admins.sql` | ADM-13 | PR #5665 / #5677 的**盘点段**（不回填） | 有多少用户满足声明式 admin 字段，但 `user_roles` 里没有 `role_id='admin'` 那一行 |

每个 `.sql` 顶部有更详细的背景、逐条查询的“目的 / 依据代码 / 预期输出”，以及本轮返修说明。

## 2. 唯一的执行方式

**一个文件一条命令，整文件跑，不要逐段复制粘贴。** `_preamble.sql` 已经把
`ON_ERROR_STOP` 打开，任何一条语句出错都会立刻中止该文件并让 `psql` 以非零状态退出——
所以“整文件跑”和“遇错停止”这次是同一件事。

```bash
# 只读角色 + 明确 schema + 留存输出
export PGAPPNAME=readonly-inventory-20260916
psql "$READONLY_DATABASE_URL" -v schema=public -f 01-cred06-secret-keys.sql > 01.log 2>&1
psql "$READONLY_DATABASE_URL" -v schema=public -f 02-trg04-http-targets.sql  > 02.log 2>&1
psql "$READONLY_DATABASE_URL" -v schema=public -f 03-adm08-wildcard-permissions.sql > 03.log 2>&1
psql "$READONLY_DATABASE_URL" -v schema=public -f 04-adm13-declared-admins.sql > 04.log 2>&1
grep -h '^INVENTORY_RESULT' 0*.log
```

222 的默认远程 shell 是 PowerShell 5.1（不认 `&&`，用 `;` 串接；读中文输出要显式
UTF-8）：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PGAPPNAME = 'readonly-inventory-20260916'
psql $env:READONLY_DATABASE_URL -v schema=public -f 01-cred06-secret-keys.sql *> 01.log ; `
psql $env:READONLY_DATABASE_URL -v schema=public -f 02-trg04-http-targets.sql  *> 02.log ; `
psql $env:READONLY_DATABASE_URL -v schema=public -f 03-adm08-wildcard-permissions.sql *> 03.log ; `
psql $env:READONLY_DATABASE_URL -v schema=public -f 04-adm13-declared-admins.sql *> 04.log
Select-String -Path 0*.log -Pattern '^INVENTORY_RESULT'
```

### 前置条件（每条都不是可选项）

- **只读角色**：用只有 `GRANT SELECT` 的角色连接，不要用应用角色。包本身还会
  `SET default_transaction_read_only = on`（写语句会以 SQLSTATE 25006 失败），但那是纵深
  防御，不替代账号层的只读。
- **`search_path`**：用 `-v schema=<schema>` 显式指定；不传就用角色默认值。四份文件的探针
  都经 `current_schemas(false)` 解析，**探针看得见的表 == 查询会读的表**。
- **超时**：前言固定 `statement_timeout=120s`、`lock_timeout=5s`、
  `idle_in_transaction_session_timeout=30s`。超时是错误，会触发 `ON_ERROR_STOP` 中止。
- **输出预算**：带 id 的查询没有 `LIMIT`（owner 要的是「计数 + id」）。如果计数是成千上万，
  **先只回报计数**，拿到明确预算后再单独取 id 列表。
- **键名普查默认不跑、不外传**：`01` 的 Q6/Q7（键名清单）只有加 `-v census=1` 才执行。
  任意键名也可能承载业务内容，**默认不外传键名普查结果**；要导出须 owner 同意，且只在受控
  渠道内传阅。

## 3. 怎么判断这次跑完了（唯一的完成态口径）

每个文件的**最后一条语句**输出一行：

```
INVENTORY_RESULT file=<文件名> status=complete …
INVENTORY_RESULT file=<文件名> status=incomplete reason=<原因> …
```

判读规则：

1. `status=complete` → 该文件的数字可用。
2. `status=incomplete reason=…` → **数字不完整**（缺表/缺列，例如老 schema 没有
   `automation_rules.actions` 或 `users.is_admin`）。此时打印出来的计数只是**下界**，
   **绝不能当成“零命中”**。
3. **根本没有 `INVENTORY_RESULT` 行** → 这次运行中途夭折（语法错误、权限不足、
   `statement_timeout`/`lock_timeout` 取消、连接断开、Ctrl-C、输出被截断）。同样按
   **不完整**处理，`psql` 退出码非零可以佐证。重跑前先解决原因。

缺列、超时、截断一律记 `incomplete`；**任何一种都不得被解读为零命中**。

## 4. 结果怎么回填

| 文件 | 查询 | 回填去哪 |
|---|---|---|
| `01` | Q2/Q3（形状 A 计数 + id）或 Q4/Q5（形状 B，自动分派） | 贴进 PR #5648 / #5681 的合并前检查项；计数 > 0 时是否要配套去键 UPDATE 另开工单（嵌套 `connection.headers` 可能是在用凭证，不能和顶层一起无脑跑） |
| `01` | Q6/Q7（键名普查，`-v census=1` 才跑） | 人工比对词表找漏判形状，回报给 #5648/#5681 的作者；**默认不外传** |
| `02` | Q2/Q3（`automation_rules` 计数 + id/sheet_id） | 贴进 PR #5619 的合并前盘点；按 `sheet_id` 通知团队 |
| `02` | Q5/Q6（`multitable_webhooks` 计数 + id/created_by） | 贴进 PR #5649 的合并前盘点；按 `created_by` 通知用户 |
| `03` | 全部 | 交给 ADM-07 的裁决；本文件只给现状 |
| `04` | Q2/Q3（计数 + id，按声明字段分类） | 交给 PR #5665 / #5677，**只作为盘点输入，不回填** |

## 5. 文件清单与验证

```
scripts/ops/readonly-inventory-20260916/
├── _preamble.sql                 （共享执行契约：ON_ERROR_STOP / 只读 / 超时 / search_path）
├── 01-cred06-secret-keys.sql
├── 02-trg04-http-targets.sql
├── 03-adm08-wildcard-permissions.sql
├── 04-adm13-declared-admins.sql
├── verify/
│   ├── fixture-modern.sql        （合成新 schema：全假值）
│   ├── fixture-legacy.sql        （合成旧 schema：缺 actions / is_admin / is_active）
│   ├── run-verify.mjs            （一次性 schema 建→灌→跑→断言→DROP）
│   └── readonly-inventory-pack.test.mjs （node --test 两层：静态契约 + 合成库）
└── README.md                     （本文件）
```

本机/CI 跑验证（**只连一次性合成库，不要指向任何真实库**）：

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/scratch \
  node --test scripts/ops/readonly-inventory-20260916/verify/readonly-inventory-pack.test.mjs
```

没有 `DATABASE_URL` / `psql` 时合成库那层会**显式跳过并打印提示**；在 CI 的 DB 泳道里设
`METASHEET_REAL_DB_TEST_STEP=1`，缺 `DATABASE_URL` 或缺 `psql` 会**红**而不是静默跳过。

配套文档：

- 设计：`docs/development/readonly-inventory-pack-design-20260916.md`
- 验证：`docs/development/readonly-inventory-pack-verification-20260916.md`
