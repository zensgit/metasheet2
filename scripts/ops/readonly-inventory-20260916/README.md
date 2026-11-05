# 只读盘点包（2026-09-16，2026-09-18 复核返修，2026-09-20 TRG-04 收窄，2026-11-05 新增 05 / 06）— CRED-06 / TRG-04 / ADM-08 / ADM-13

这是一个**只读盘点包**：六个 `.sql` 文件加一个共享前言 `_preamble.sql`，全部只含
`SELECT` / `WITH … SELECT`，没有任何 `INSERT` / `UPDATE` / `DELETE` / DDL。目的是在合并
四条在飞/待裁决工作之前，先知道生产库上现在有多少行会受影响——**不做任何回填、不做任何
清理、不改任何表结构**。

> **生产执行状态（2026-11-05 更新）：`01`–`04` 仍未执行。** `01`–`04` **从未在任何真实数据库
> （含 222）上跑过**；真实盘点需要 owner 另行授权（目标库、只读身份、窗口、超时与输出预算）。
> `05` 的**同一份 SQL**（当时文件名为 `03-webhook-target-totals.sql`，sha256 `8f0733a9…`）
> 已于 2026-11-05 以只读身份在 222 上跑过**一次**：`status=complete`，**所有计数均为 0**。
> `06` **尚未在任何真实数据库上跑过**。除 `05` 的这一次之外，下面的验证全部在**一次性合成 PostgreSQL 的临时 schema**（CI 为 16）、
> **全假数据**上完成。

## 0. 2026-09-18 复核返修（F3 / F4 / F5）

| 编号 | 问题 | 修法 |
|---|---|---|
| F3 | `02-trg04` 用 `actions::text ILIKE '%"url":"http://%'` 扫 JSONB 文本。JSONB **不保留排版**，回显形式是 `"url": "http://…"`（冒号后有空格），正常命中被漏成 0 | 改为 **JSON 字段语义匹配**：`jsonb_path_query(actions,'$.**')` 逐层取节点 → `jsonb_each_text` 取成员 → 键名归一化命中 url 类键名 **且** 字符串值（trim 后、不分大小写）以 `http://` 开头。顶层/嵌套/排版/大小写全覆盖 |
| F4 | `01-cred06` 的「受影响 ID」只按对象形状过滤，普通连接也进 ID 列表，计数却不含它 | 计数与 ID 共用同一个 `hit` CTE 与同一个 `WHERE matched_top_level OR matched_headers`，`|ids| == count` 成为可断言的不变量 |
| F5 | 执行指引三处互相矛盾；Q1 只是探针不会自动选互斥分支；`04` 的旧 schema 回退漏了 `is_active` | 统一为**一种执行方式**（整文件 `psql -f`）＋ `\set ON_ERROR_STOP on` ＋ 探针 `\gset` 自动分派兼容分支 ＋ 每个文件末尾输出 `INVENTORY_RESULT … status=complete\|incomplete reason=…` |

证据与正反例清单见 `docs/development/readonly-inventory-pack-verification-20260916.md` §“复核返修”。

## 0b. 2026-09-20 复核返修（F6：TRG-04 的 HTTP 目标白名单收窄）

| 编号 | 问题 | 修法 |
|---|---|---|
| F6 | `02-trg04` 的命中判据在两个方向上都过宽：① 键名白名单有 7 个名字，其中只有 `url` 会被代码读去发请求，另外 6 个（`webUrl`/`webhookUrl`/`endpoint`/`endpointUrl`/`targetUrl`/`callbackUrl`）在这两张表的取值路径上**零读取点**；② `jsonb_path_query(actions,'$.**')` 递归整棵 `config`，会钻进 `send_webhook` 里**用户自撰的 `body` / `headers`**——`body` 是被序列化后 POST 给 `config.url` 的载荷，里面一个叫 `callbackUrl` 的 `http://` 字符串会被算成"出网目标"，把 owner 用来判断"能不能开 https-only"的数字吹大 | **窄口径**只匹配执行器真正解引用的 jsonpath：`$[*].config.url`、`$[*].config.branches[*].actions[*].config.url`、`$[*].config.defaultBranch.actions[*].config.url`（旧列 `action_config` 同理，上移一层）。键的大小写**敏感**（`config.url` 是 JS 属性读取，存成 `"URL"` 根本读不到），值的 scheme 判定仍然大小写不敏感。**原 `$.**` + 7 键逻辑一条不删**，作为显式标注的**参考上界**列 `*_upper_bound` 并排输出 |

读取点依据（本 worktree 亲读）：

| 键 / 列 | 唯一读取点 |
|---|---|
| `automation_rules.actions[*].config.url` | `packages/core-backend/src/multitable/automation-executor.ts:4199`（`const url = config.url …`），派发在 `:2591`；契约 `SendWebhookConfig` 在 `automation-actions.ts:144-151`；前端只写这一个成员 `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:504` |
| `automation_rules.action_config`（旧列） | `automation-service.ts:1187-1190` 的回退：`actions` 为 NULL/空时，执行器读的就是 `action_config` |
| `multitable_webhooks.url` | `packages/core-backend/src/multitable/webhook-service.ts:394`（`this.fetchFn(wh.url, …)`） |

一层嵌套就是全部：`condition_branch` 读 `config.branches[*].actions`（`automation-executor.ts:2348`、`:2378`）与 `config.defaultBranch.actions`（`:2342`、`:2372-2373`），`parallel_branch` 读 `config.branches[*].actions`（`:2247`）；保存期校验拒绝分支内再套分支（`automation-service.ts:874`、`:877`、`:902`、`:905`），所以没有第三层。

证据与正反例见 `docs/development/readonly-inventory-http-target-allowlist-narrow-verification-20260920.md`。

## 0c. 2026-11-05：新增 `05-trg04-webhook-target-totals.sql`（每个 webhook 目标都数，分四个桶）

为什么要有它：#5619（规则驱动的 `send_webhook`）和 #5649（webhook 订阅投递）都已合并到 main，
本地部署 R 线从 R81 起带上这两道守卫。R81 会拒绝：`http://`、内网 IP / 主机名字面量、
**解析到内网或解析不了的主机名**、**任何 3xx 重定向**，并且**没有任何开关可以放行**。R80 及以前
两条路径都不检查目标，所以今天能投递的内网目标，装 R81 后才**新**被拒。

`02` 只数 `http://` 和内网字面量，**看不见 `https://<内网主机名>`**——而内网部署最可能的正是这种
形状。存量数据分不出一个主机名是内网还是公网，所以 `05` 不猜：**把每一个目标都数出来**，按启用
状态（规则看 `enabled`、订阅看 `active`，NULL 记为 false）分四个桶：

| 桶 | 含义 | 装 R81 后 |
|---|---|---|
| `url_missing` | url 缺失、JSON null、空串或全空白 | 今天就已失败（"Webhook URL is required"），R81 不改变 |
| `not_https` | url 不是 JSON 字符串（数字/数组/对象），或 scheme 不是 https | 被拒 |
| `https_internal_literal` | https 指向内网 IP / 主机名字面量（与 `02` Q7 同一主机集合） | 被拒 |
| `https_other` | 其余所有 https 目标 | **不等于安全**：主机名解析到内网或解析不了、对方回任何 3xx、内网地址的非常规写法（`127.1`、十进制整数、前导零）、url 带 `user:pass@`，R81 都会拒。必须现场逐条确认（只回报条数，不回报主机） |

两个来源全部为 0 ⇒ R81 对本站点的自动化规则与 webhook 订阅没有影响（按钮字段的 webhook 是另一条
路径，不在本文件统计范围）。

执行要点：

- **用 `psql -X`**：`-X` 忽略 `.psqlrc`，后者可能把 AUTOCOMMIT 关掉。
- **`SET transaction_read_only = on;` 紧跟在 `\ir _preamble.sql` 之后**。原因：前言里的
  `SET default_transaction_read_only = on` 只管**之后新开**的事务；用 `psql -1` 或 AUTOCOMMIT off
  跑时，整个文件处在一个**已经开启**的事务里，前言管不到它。事务中任何时刻都允许切换**到**只读。
  合成库上已证明：在这一句之后注入一条 `UPDATE`，`psql -X -1` 与 `AUTOCOMMIT=off` 两种方式都以
  SQLSTATE 25006 中止、不输出 `INVENTORY_RESULT`、行不变；去掉这一句，同一条 `UPDATE` 在 `-1` 下
  会提交。
- 内网主机正则块（`WITH atom AS (` 到它的 `\gset`）与 `02` **逐字节相同**，由测试守住。
- 只输出计数：不选 id / sheet_id / created_by / name / url / config。

### 同日新增 `06-trg04-button-webhook-totals.sql`（按钮字段的 webhook）

按钮字段的「发送 Webhook」是第三条出网路径，`05` 不统计它。它的目标检查在 R80 与 R81 上相同，但
R80 的钉死连接在 Node 20 上对**任何主机名** url 都失败（`ERR_INVALID_IP_ADDRESS`），所以这类按钮在
R80 上从未真正发出；R81 修好了这条连接，升级后点这种按钮会**真的发送**。按钮只在有 admin 角色或
恰好持有 `multitable:send_webhook` 权限的用户点击时发送，不会自动发送。

`06` 统计 `meta_fields` 里 `type='button'` 且 `property.actionType`（trim 后）为 `send_webhook` 的行，
输出一行六个计数：`button_webhooks`（总数）= `url_missing` + `refused_both`（非 https，或 https 指向
内网字面量；R80/R81 都拒）+ `https_ip_literal`（https 指向其它 IP 字面量；R80 已能发送）+
**`https_hostname`**（https 指向主机名：R80 上失败、**R81 上开始发送**——这是要看的数字）+
`unclassified`（`property` 或 `actionConfig` 以 JSON 字符串存储，本文件不解析，需现场逐条确认，
只报条数）。内网主机正则块同样与 `02` 逐字节相同；`SET transaction_read_only = on;` 同样紧跟前言，
理由同上。

- **`06` 尚未在任何真实数据库上跑过**，只在合成库上验证。
- **读权限**：需要 `meta_fields`（`type`、`property`）的 SELECT。`property` 里也存着每个按钮的
  webhook secret，所以**由谁、用哪个身份跑，由 owner 决定**。

## 1. 这六份文件分别解锁什么

| 文件 | 编号 | 解锁 / 喂给 | 一句话 |
|---|---|---|---|
| `01-cred06-secret-keys.sql` | CRED-06 | PR #5648、PR #5681 | `data_sources` 里还有多少行的连接配置（两种列形状）带着秘密形状的键名 |
| `02-trg04-http-targets.sql` | TRG-04 | PR #5619、PR #5649（**均已合并到 main**：1bcef347d、bd165412a；R 线到 R80 都不带这两道守卫） | 自动化规则（`automation_rules.actions`）和 webhook 订阅（`multitable_webhooks.url`）里还有多少条 `http://`（非 https）目标；**窄口径 = 会坏的条数，另给一列参考上界**（见 §0b / §4b）。**只数 `http://` 和内网字面量，看不见 `https://<内网主机名>`**；问"R81 会拒多少"请用 `05` |
| `03-adm08-wildcard-permissions.sql` | ADM-08 | 喂 ADM-07 的裁决 | `users.permissions`（两种列形状）、`user_permissions`、`role_permissions`（含经 `user_roles` 继承）里现在有多少行/多少用户持有 `*:*` |
| `04-adm13-declared-admins.sql` | ADM-13 | PR #5665 / #5677 的**盘点段**（不回填） | 有多少用户满足声明式 admin 字段，但 `user_roles` 里没有 `role_id='admin'` 那一行 |
| `05-trg04-webhook-target-totals.sql` | TRG-04 | 喂 **R81 安装决策**（2026-11-05） | 每一个 `send_webhook` 目标和每一条 webhook 订阅，按启用状态分 `url_missing` / `not_https` / `https_internal_literal` / `https_other` 四桶计数；`https_other` **≠ 安全**（见 §0c） |
| `06-trg04-button-webhook-totals.sql` | TRG-04 | 喂 **R81 安装前检查**（2026-11-05；尚未在真实库上跑过） | 按钮字段的「发送 Webhook」按六列计数；**`https_hostname` = R80 上发不出、R81 上开始发送的按钮数**；需要 `meta_fields` 的 SELECT（含按钮 secret），由 owner 定执行人和身份（见 §0c） |

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
psql "$READONLY_DATABASE_URL" -X -v schema=public -f 05-trg04-webhook-target-totals.sql > 05.log 2>&1
psql "$READONLY_DATABASE_URL" -X -v schema=public -f 06-trg04-button-webhook-totals.sql > 06.log 2>&1   # 读 meta_fields（含按钮 secret），owner 定身份
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
psql $env:READONLY_DATABASE_URL -v schema=public -f 04-adm13-declared-admins.sql *> 04.log ; `
psql $env:READONLY_DATABASE_URL -X -v schema=public -f 05-trg04-webhook-target-totals.sql *> 05.log ; `
psql $env:READONLY_DATABASE_URL -X -v schema=public -f 06-trg04-button-webhook-totals.sql *> 06.log
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
| `02` | Q2/Q3（`automation_rules` 计数 + id/sheet_id） | 贴进 PR #5619 的合并前盘点；**只按 `http_rules` / `narrow_hit=t` 通知 `sheet_id` 对应团队**，上界列见下表 |
| `02` | Q4（旧列 `action_config` 计数） | 同上；`actions` 为 NULL/空的行，这一列就是执行器读的配置 |
| `02` | Q5/Q6（`multitable_webhooks` 计数 + id/created_by） | 贴进 PR #5649 的合并前盘点；按 `created_by` 通知用户（2026-11-05：#5619 / #5649 均已合并，`02` 的数字改作装 R81 前的参考，判断以 `05` 为准） |
| `05` | R1 / W1（规则、订阅各两行：启用 t/f × 四桶） | R81 安装决策：两表全 0 ⇒ R81 不影响；任一桶非 0（**含 `https_other`**）⇒ 现场逐条确认后再装 |
| `06` | B1（一行六个计数） | R81 安装前检查：`https_hostname` > 0 ⇒ 这些按钮升级后会真的发送，先确认目标；`unclassified` > 0 ⇒ 现场逐条确认 |

### 4b. `02-trg04` 的窄口径 / 上界两个数怎么读（2026-09-20 起）

| 结果字段 | 口径 | 怎么用 |
|---|---|---|
| `http_rules` | **窄（actionable）**：只数落在执行器真正解引用的 jsonpath 上的 `http://` | **这是会坏的条数。** 合并 #5619 前按它评估影响面、按它通知团队 |
| `http_rules_upper_bound` | **参考上界**：旧的 `$.**` 递归 + 7 键白名单 | 只做参考。差额 = "长得像 http 目标但没人读它"（`send_webhook` 的 `body`/`headers` 载荷、大小写写错的键名）。**不要**用它评估破坏面 |
| Q3 的 `narrow_hit` / `upper_bound_hit` | 上面两列的逐行版 | `narrow_hit=t` → 该规则会坏；`narrow_hit=f AND upper_bound_hit=t` → 规则里某处有 `http://` 字符串但不是出网目标，仅供排查 |
| `http_rules_legacy_column` / `…_upper_bound` | 同一对口径，作用在旧列 `action_config` 上 | 同上 |
| `internal_target_rows` / `…_upper_bound` | 同一对口径，作用在"内网目标"上。主机集合只定义一次（`\gset` 成 `inv_internal_target_re`，Q7 三处共用），按 `webhook-ssrf-guard.ts` 的字面量/主机名判定逐类对齐（2026-09-27）：IPv4 `0/8`、`127/8`、`10/8`、`172.16/12`（第二段恰为 16–31）、`192.168/16`、`169.254/16`；`localhost`、`*.localhost`、`*.internal`、`*.local`；IPv6 `::1`、`::`、`::ffff:`+内网 IPv4、ULA `fc00::/7`、link-local `fe80::/10`；带用户信息/端口/大写的 URL 也认，且按整段主机精确匹配（`10.x.example` 这类域名不再算） | 分母/上下文；仍是**下界**：只会漏、不会多——`127.1`、`0x7f.0.0.1`、`2130706433`、带前导零的段、`[::0.0.0.1]`、百分号编码/非 ASCII/`xn--` 主机不计；要靠 DNS 解析才知道是内网的域名本来就盘不到 |
| Q5/Q6 的 `http_webhooks` | 只有一个口径 | `multitable_webhooks.url` 是专用 `text` 列，没有键名要猜、没有 JSON 要递归，本来就是窄的，**没有上界孪生列** |

不变量（由 `verify/run-verify.mjs` 断言）：
`count(Q3 rows WHERE narrow_hit) == Q2.http_rules`，`count(Q3 rows) == Q2.http_rules_upper_bound`，且窄口径恒 ⊆ 上界。
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
├── 05-trg04-webhook-target-totals.sql （2026-11-05：每个 webhook 目标分四桶计数）
├── 06-trg04-button-webhook-totals.sql （2026-11-05：按钮字段 webhook 六列计数）
├── verify/
│   ├── fixture-modern.sql        （合成新 schema：全假值）
│   ├── fixture-legacy.sql        （合成旧 schema：缺 actions / is_admin / is_active）
│   ├── fixture-webhook-totals.sql （05 专用：带 enabled 列的规则 r1–r16、订阅 w1–w6）
│   ├── fixture-button-webhooks.sql （06 专用：meta_fields 按钮行 b1–b17）
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
- TRG-04 收窄验证（F6，2026-09-20）：`docs/development/readonly-inventory-http-target-allowlist-narrow-verification-20260920.md`
- 05 webhook 目标总数验证（2026-11-05）：`docs/development/readonly-inventory-webhook-target-totals-verification-20261105.md`
