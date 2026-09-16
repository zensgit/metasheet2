# 只读盘点包（2026-09-16）— CRED-06 / TRG-04 / ADM-08 / ADM-13

这是一个**只读盘点包**：四个 `.sql` 文件，全部只含 `SELECT` / `WITH … SELECT`，没有任何
`INSERT` / `UPDATE` / `DELETE` / DDL。目的是在合并四条在飞/待裁决工作之前，先知道生产库
（222）上现在有多少行会受影响——**不做任何回填、不做任何清理、不改任何表结构**。

写这份盘点包的代理**没有连接过任何数据库**，也没有碰过 222。所有 SQL 都是照着仓库里的
迁移文件、以及两组尚未合并分支里的设计文档手工核对列名写出来的，**从未在真实
PostgreSQL 上跑过**。上机前请先把每条查询当作候选语法，用下面第 3 节的方法自己过一遍。

## 1. 这四份文件分别解锁什么

| 文件 | 编号 | 解锁 / 喂给 | 一句话 |
|---|---|---|---|
| `01-cred06-secret-keys.sql` | CRED-06 | PR #5648（`fix/data-source-secret-keys-vocab-nfkc`）、PR #5681（`test/secret-keys-realdb-inventory-sync`） | `data_sources` 里还有多少行的 `connection`（两种列形状）带着秘密形状的键名（`password`/`token`/… 词表） |
| `02-trg04-http-targets.sql` | TRG-04 | PR #5619（`fix/automation-webhook-ssrf-guard`）、PR #5649（`fix/webhook-service-ssrf-guard`） | 自动化规则（`automation_rules.actions`）和 webhook 订阅（`multitable_webhooks.url`）里还有多少条 `http://`（非 https）目标——两条 PR 合并后这些行会立刻开始以 `WEBHOOK_TARGET_REJECTED:scheme-not-allowed` 失败 |
| `03-adm08-wildcard-permissions.sql` | ADM-08 | 喂 ADM-07 的裁决（`*:*` 超级通配权限怎么处理） | `users.permissions`（两种列形状）、`user_permissions`、`role_permissions`（含经 `user_roles` 继承）里现在有多少行/多少用户持有 `*:*` |
| `04-adm13-declared-admins.sql` | ADM-13 | PR #5665 / #5677 的**盘点段**（本文件不回填） | 有多少用户满足声明式 admin 字段（`users.is_admin=TRUE` 或 `users.role='admin'`），但在 `user_roles` 里没有 `role_id='admin'` 那一行——即 `rbac/service.ts` 的 `isAdmin()` 会判"否"，但仓库里另外十几处按 `(is_admin OR role='admin')` 判定的地方会判"是"的那批人 |

每个 `.sql` 文件顶部都有更详细的背景说明和逐条查询的"目的 / 依据代码 / 预期输出 / 缺列缺表怎么办"。

## 2. 怎么跑（222 上的 PowerShell 5.1 约定）

222 的默认远程 shell 是 **PowerShell 5.1**：不认 `&&`，命令之间用 `;` 串接；带参数的多行脚本
建议整个函数用 `-File` 带参调用，或者用 `-EncodedCommand`（PS 5.1 对多行/带特殊字符命令的
一贯坑）。读中文输出必须显式声明 UTF-8，否则会看到乱码或问号。

```powershell
# 1) 建好一个只读连接串（不要把口令打在命令行历史里；用环境变量）
$env:DATABASE_URL = '<读你们自己的机密管理拿到的只读连接串>'

# 2) 确认 psql 能连上（不改任何数据，纯探测）
psql $env:DATABASE_URL -c "SELECT 1"

# 3) 逐个文件跑，每个文件独立、互不依赖，随时可以中断（Ctrl+C）
#    显式声明输出编码为 UTF-8，避免中文注释在控制台乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
psql $env:DATABASE_URL -f 01-cred06-secret-keys.sql
psql $env:DATABASE_URL -f 02-trg04-http-targets.sql
psql $env:DATABASE_URL -f 03-adm08-wildcard-permissions.sql
psql $env:DATABASE_URL -f 04-adm13-declared-admins.sql
```

如果习惯用 `;` 串起来跑（PS 5.1 不认 `&&`）：

```powershell
psql $env:DATABASE_URL -f 01-cred06-secret-keys.sql ; psql $env:DATABASE_URL -f 02-trg04-http-targets.sql ; psql $env:DATABASE_URL -f 03-adm08-wildcard-permissions.sql ; psql $env:DATABASE_URL -f 04-adm13-declared-admins.sql
```

**全部只读、可随时中断、输出不含任何值**：

- 每条 SQL 语句都以 `SELECT`（含 CTE 的 `WITH … SELECT`）开头，psql 遇到语法错误会原样报错
  并停在那一条，前面已经跑完的查询结果不会受影响、也不会被回滚（没有事务，没有东西可回滚）。
- 中断（Ctrl+C）安全：没有任何语句持有写锁或长事务，中断只是少看到几行输出。
- 输出里没有密码、口令、URL、token 这类值——只有计数（`count(*)`）、主键 id、和少量结构性
  标识符（`sheet_id` / `created_by` / `role_id` / `active` 这类"是谁/是哪条"的标签，不是"内容是
  什么"的值）。每份 `.sql` 文件顶部的注释单独说明了这条纪律在这一份文件里的具体边界。
- 建议用只读角色连接（`GRANT SELECT` 而非应用角色），这四份文件不需要任何写权限。

## 3. 本机没跑过真库——上机前怎么自己核一遍

写这份盘点包时本机（开发者工作站 / 本 worktree）**没有可用的 PostgreSQL、docker、psql**（见
配套验证文档 `docs/development/readonly-inventory-pack-verification-20260916.md` §0 的检查记录），
且任务边界明确禁止连接任何数据库，所以四份 `.sql` 从未被真正执行过。上机前请至少做以下几步：

1. **先跑每份文件里的"列探针"（Q1）**。四份文件的第一条查询都是对 `information_schema.columns`
   的只读探测，用来确认本文档假设的列名/列形状（jsonb vs text[]、`config` vs `connection`
   两套 DDL……）在这台生产库上到底是哪一种。如果探针的结果和文件注释里写的两种形状都对不上，
   **停下来**，不要继续跑后面的查询——说明这台库的 schema 和本次盘点依据的迁移文件不一致，需要
   先弄清楚差异再决定怎么改 SQL。
2. **在测试库上先跑一遍**（如果有的话）。哪怕是一个空的、刚跑完迁移的测试库，也能把明显的语法
   错误（拼错的函数名、少了一个括号）筛出来，比直接对生产库跑安全得多。
3. 语法有把握之后，才对生产库跑；仍然建议先跑 Q1 探针、再跑其余查询，不要图快把整份文件一次性
   丢给 `psql -f` ——如果某条查询失败，`psql -f` 默认会继续跑下一条（不是 `ON_ERROR_STOP`），
   所以哪怕报错也不会中断整个文件，请自己逐段看输出，确认每条查询真的返回了预期形状的结果，
   而不是一条静默的报错。

## 4. 结果怎么回填

这份盘点包的产出是**数字和 id 列表**，不是决定本身。下面是每份文件的输出对应哪条后续动作：

| 文件 | 查询 | 回填去哪 |
|---|---|---|
| `01-cred06-secret-keys.sql` | Q2/Q3（形状 A 计数 + id）、Q4/Q5（形状 B 计数 + id） | 把计数和受影响 `id` 列表贴进 PR #5648 / #5681 的合并前检查项；若计数 > 0，参考 `data-source-connection-secret-keys-design-20260912.md` §5"迁移方案"决定是否需要配套的去键 UPDATE（该 UPDATE 本盘点包不包含，需要另开工单，且嵌套 `connection.headers` 那一步——见文件里的注释——不能和顶层一起无脑跑，可能是在用的凭证） |
| `01-cred06-secret-keys.sql` | Q6/Q7（键名普查，供人工核对全角/新词，非强制） | 人工过一遍键名列表，和文件头注释里的词表比对，找出正则规则漏判的形状；发现新形状就回报给 #5648/#5681 的作者，让词表跟着扩，而不是自己在这份盘点包里改判定逻辑 |
| `02-trg04-http-targets.sql` | Q2/Q3（`automation_rules` 计数 + id/sheet_id） | 贴进 PR #5619 的"Pre-merge step for the owner"（该 PR 描述里原话："合并前的存量 `http://` 规则只读盘点没做"——这份文件补上了 id 版本）；按 `sheet_id` 通知对应团队 |
| `02-trg04-http-targets.sql` | Q5/Q6（`multitable_webhooks` 计数 + id/created_by） | 贴进 PR #5649 的"Pre-merge inventory for the owner"；按 `created_by` 通知对应用户 |
| `03-adm08-wildcard-permissions.sql` | 全部 | 交给 ADM-07 的裁决——是否要收紧/取消 `*:*`、怎么处理已持有它的用户/角色；本文件不建议怎么处理，只给现状 |
| `04-adm13-declared-admins.sql` | Q2/Q3（计数 + id，按声明字段分类） | 交给 PR #5665 / #5677——**只作为盘点输入，本文件明确不做回填**（不写任何 `INSERT INTO user_roles`）。是否要把这批用户批量插入 `user_roles(role_id='admin')`，还是反过来去掉他们的 `is_admin`/`role='admin'`，是 #5665/#5677 要做的裁决，不是本盘点包的范围 |

## 5. 文件清单

```
scripts/ops/readonly-inventory-20260916/
├── 01-cred06-secret-keys.sql
├── 02-trg04-http-targets.sql
├── 03-adm08-wildcard-permissions.sql
├── 04-adm13-declared-admins.sql
└── README.md   （本文件）
```

配套文档：

- 设计：`docs/development/readonly-inventory-pack-design-20260916.md`
- 验证（列名核对表）：`docs/development/readonly-inventory-pack-verification-20260916.md`
