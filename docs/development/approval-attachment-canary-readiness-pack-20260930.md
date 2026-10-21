# 审批附件 canary 就绪包(F2-A1)— 设计与验证说明(2026-09-30)

**只读 / 文书。** 本包不连接任何非一次性库,不执行普查,不改任何开关默认值,零 DDL,零迁移。

- 基线:main `cffd5dacbc`
- 分支:`docs/approval-attachment-canary-readiness-pack`

## 1. 改了什么

| 提交 | 内容 |
|---|---|
| `dae353d72d` | `scripts/ops/approval-attachment-canary-census-20260930/`:顶层 attachment 字段只读普查(`_preamble.sql` 只读会话契约 + `01-top-level-attachment-census.sql`)与自检 `verify/`(`census-pack.test.mjs` + `__fixtures__/fixture.sql`;夹具放在 `__fixtures__/` 下,仓内写入点扫描器按测试数据对待) |
| `e6064b0c8c` | 把该包接入既有独立车道 `.github/workflows/ops-sql-pack-verify.yml`:两处触发路径、hermetic 矩阵、postgres:16 执行证明矩阵。`scripts/ops/ops-sql-pack-verify-wiring.test.mjs` 加入该包,并新增「两个矩阵都恰好列出 PACKS」的钉子。未碰 `plugin-tests.yml`,未新建必需检查 |
| `829980c6ff` | `docs/development/approval-attachment-canary-runbook-20260930.md`:主闸 ON 前置顺序、前置核对单(逐项 file:line)、(a)(b) 两路 UAT 剧本 |
| `57e5565a0b`、`bc66ca2a9e` | 本文件(设计与验证说明)及另两包自检读数 |
| `46392d617f` | 评审修复(只改自检与夹具,普查 SQL 与预置未动):① `_preamble.sql` 按行钉死——可执行行必须逐行、按序等于钉住的执行契约;② psql 元命令只能是整行白名单行(两个文件都查;引号参数内不许再出现引号 / 反斜杠 / 反引号,因而白名单行上不能再挂第二条元命令);③ 普查代码(元命令行以外)不得出现反斜杠、块注释、美元引号——即扫描器不建模的语法;④ 副作用黑名单补上名字带下划线的函数族(`set_config`、`pg_notify`、advisory 锁族、大对象族、`dblink_*`),各带负例;⑤ values-free 静态检查钉住 `form_schema` / `form_snapshot` / 命中字段对象只能出现的几种形状,并拒绝 text 类型转换与 `#>` / `#>>`;⑥ 夹具加一条 `archived` 状态的命中版本行(列 CHECK 允许该值,应用不写),(b) 与定位段期望由 7 / 13 改为 8 / 14 |
| `4e130c1535` | 评审修复续:①③ 两项的负例改为不依赖文件原文(预置负例改用钉住的行表本身,语法负例改为追加到普查文本末尾),否则改写了锚点行的变异会以「锚点未找到」而非真实原因变红 |
| 本次文书提交 | runbook:C3 列全三种中止启动的情形、三处 § 交叉引用、A7 补文件名、§7 标注偏离计划 r4 正文;本文件 §1–§4 |

普查输出的内容:

- 计数;
- 定位用的 id:模板 id、版本 id、版本号;
- 生命周期状态、布尔值,以及 `jsonb_typeof` 的类型名。

不输出模板名 / key / 描述、字段 id / 标签、提交值与申请人。谓词只有一处定义:`$.fields[*] ? (@.type == "attachment")`。

| 段 | 内容 |
|---|---|
| (a) | 模板:发起页读的 latest 版 vs 上传口接受的 active 已发布版,以及两种漂移 |
| (b) | 全部版本,不分状态 |
| (b-locate) | 每个命中版本一行,不设上限,行数 = (b) `matching_versions` |
| (c) | 冻结在命中版本上的实例,按实例状态 |
| (d) | 这些字段下已存值的 JSON 类型 |
| 完成行 | 最后一条是 `INVENTORY_RESULT … status=complete`;没有这一行 = 未完成 |

## 2. 依据

**排期**:owner 2026-09-30 原话「按建议执行」。所授权的是第一波四片做到 Draft PR,不含任何合并、开关、部署或生产普查。

**切片**:审批对标飞书 P2–P4 切片计划(2026-09-30)§4 F2-A1 的改动面、验收门与风险三行,加上文末「第 5 轮复验更正」。更正优先于正文:

- R5-1:探针必须是一次动作提交;
- R5-3:(b) 读数时点成门;
- R5-4:(b) > 0 没有应用内处置。

**锁条款原文**(`cffd5dacbc`):

- B3-07 抬头(`approval-attachment-pipeline-design-lock-20260709.md:3`):「the attachment feature plus every related flag stay **OFF** until the full implementation + 8-scenario acceptance pass」
- B3-07 §7 rung 4(`:481-483`):「**Flip authorability + retire B2-28** — make `attachment` an `AuthorableFieldType` … **Only after** the flag is ratified ON and rungs 1–3 have landed.」
- B3-07 §9(`:684`):「`APPROVAL_ATTACHMENTS_ENABLED` | `false` (confirmed — D5) | Master gate.」
- B3-07 §10 第 7 条(`:708-709`):「**Attachment fields inside `detail` sub-forms** — `DETAIL_LEAF_FIELD_TYPES` excludes `attachment`; it stays excluded.」
  - 该条在 main 上未成立:`ApprovalProductService.ts:1114-1122` 没有排除 attachment。它的修复在 OPEN #5476。
- Lock-9 OD-L9-11(a)(`approval-lock9-handler-process-attachments-20260819.md:495-497`):「gated behind the ALREADY-SHIPPED APPROVAL_ATTACHMENTS_ENABLED (backend) and approvalAttachments (frontend), both default OFF, with NO sub-flag」

**关键取舍**:

- **detail 内嵌普查不在本包**。它在 OPEN #5476(头 `f8cefdbc2`,`scripts/ops/approval-detail-attachment-census.sql`),依 #5476 处置(owner)。
  - 本包不复制其 SQL,也不含 detail 形状谓词;自检钉住了这一点。
  - **偏离计划 r4 正文(待 owner 确认)**:计划 §4 F2-A1 ①(r4)把一个无上限、values-free 的 detail (b) 定位段放进本切片;本包没有交付它。理由:
    - 它是 #5476 普查同一口径的扩展。若放在本包,就是 #5476 之外的第二份 detail jsonpath,而本切片的任务边界是「detail 内嵌普查不重写、不复制,只引用并依 #5476 处置(owner)」。
    - 它应随 #5476(owner 评审意见)落地,或由 F2-A0 承接。见 runbook §2 G3。
    - 影响面:只在 #5476 普查 (b) > 0 时需要定位;而 (b) > 0 本身已按 R5-4 停在 owner 另行授权(runbook §2 G3)。
    - 这是本包的取舍,不是 owner 裁决;owner 未确认前按「偏离计划正文」对待。
- **硬门是 #5476 普查的 (b) = 0**。顶层普查只是 owner 做 Q1 (a) / (b) 取舍的输入:
  - 顶层 attachment 是合法字段类型(`ApprovalProductService.ts:1007`);
  - 旗控扫描只拒 detail 形状(`:2366-2372`);
  - 所以 #5476 落地后顶层 (b) 仍可能增长,也要在 ON 前复读。
- **前置顺序**写的是计划与复验的建议,待 owner 确认,不是 owner 裁决。

## 3. 验收门与实测读数

**执行机**:Mac mini 执行机。

- 环境:macOS、Node v20.20.2、PostgreSQL 16.15 (Homebrew)。
- 一次性库:本切片专用,用 `createdb` 创建;每次使用前以 `select current_database()` 断言;结束后 dropdb 并核实不存在。
- 本机只做编辑与提交,不跑任何测试。
- **被测提交:下表全部读数取自 `4e130c1535`**(评审修复后的代码头)。其后的文书提交只改本文件与 runbook 两个 MD,不改 SQL / 测试 / 夹具 / workflow。
  - 普查 SQL 与 `_preamble.sql` 自 `e6064b0c8c` 起逐字节未变;评审修复只动了自检与夹具。
  - 上一轮在 `e6064b0c8c` / `bc66ca2a9e` 上取的读数被本表取代。

| 门 | 读数 |
|---|---|
| SQL 车道 hermetic 绿(A:无 `DATABASE_URL`) | `node --test …/verify/census-pack.test.mjs` → rc=0;tests 13 / pass 12 / skip 1(合成库层大声跳过) |
| fail-not-skip 哨兵(B:`METASHEET_REAL_DB_TEST_STEP=1`,无 `DATABASE_URL`) | rc=1,`not ok 12 - sentinel`,即按预期变红 |
| 执行证明(C:合成 PG16 夹具) | rc=0;tests 16 / pass 16。包括:夹具上全部读数;缺表时中止且没有完成行;偷塞一条写语句因只读而失败(25006),且不留完成行;放宽谓词会多数,说明负例夹具是承重的。跑完残留 `a1census_fixture_*` schema 0 个 |
| (b) 定位段行数 = `matching_versions` | 合成夹具 8 = 8(含 `archived` 状态行);真迁移库种子后 1 = 1(R4) |
| 车道接线(D) | `ops-sql-pack-verify-wiring.test.mjs` → rc=0;tests 6 / pass 6 |
| 真迁移库对账(R) | 以 `plugin-tests.yml` 的 `MIGRATION_EXCLUDE` 原样迁移,420 支迁移、0 报错(`kysely_migration` 420 行)。**R1** 刚迁移的库:(a) `1\|0\|0\|0\|0`,(b) `0\|1`,定位 / (c) / (d) 均 0 行,完成行在。**R2** 夹具的 21 个列与 `information_schema` 的类型逐一对上(21 of 21,0 行不符);`approval_template_versions_status_check` 为 `status = ANY (ARRAY['draft','published','archived'])`,即夹具的 `archived` 行是真库允许的值。**R3** 经真实 NOT NULL 列种入:一个顶层命中模板、一个只有 detail 形状的模板、一张旧字符串值实例。**R4** 本普查:(a) `3\|1\|1\|0\|0`,(b) `1\|3`,定位 1 行(发布 / active / 发起页版 / 1 个字段 / 1 张冻结实例),(c) `pending\|1`,(d) `string\|1\|1`,完成行在;detail 形状模板未被计入。**R5** 同一库上跑 #5476 普查(`f8cefdbc2`,只读会话):(b) `1\|3`,即只计 detail 形状,不计顶层。两份口径在真实 schema 上互不重叠 |
| 变异(评审给出的形状;只跑静态层,即不设 `DATABASE_URL`,改的是包的副本) | 同一变异分别配旧自检(`bc66ca2a9e`)与新自检(`4e130c1535`)。**ME** 预置里在只读默认之前加 `CREATE TABLE`:旧 rc=0,新 rc=1(`not ok 1`)。**ME2** 预置里建旁表并写入一行:旧 0,新 1(`not ok 1`)。**MS** (b) 语句行中插入元命令、下一行才收分号:旧 0,新 1(`not ok 6`)。**MS4** 在一条 `\echo` 白名单行尾再挂一条元命令(行尾仍以引号结束):旧 0,新 1(`not ok 5`)。**MC** 定位段选出 `v.form_schema`:旧 0,新 1(`not ok 9`)。**MD** (d) 段把原始值转成 text 选出:旧 0,新 1(`not ok 9`)。**MH** (b) 的 WHERE 里调 `set_config(…)`:旧 0,新 1(`not ok 4`) |
| 变异(夹具 `archived` 行承重;执行层) | **MA** (b) 改为跳过 `archived` 状态行:旧自检 + 旧夹具 rc=0(测不出),新自检 + 新夹具 rc=1(`not ok 13`、`not ok 16`) |
| 变异(M:原有七项,在新自检上重跑;执行层;期望全部变红) | M1 定位段加 `LIMIT 5`:`not ok 13`。M2 (a) 改成 active 优先:`not ok 13`。M3 预置里删掉只读默认:`not ok 1`(预置钉)与 `not ok 15`(偷塞写入)。M4 定位段选出模板名:`not ok 9` 与 `not ok 13`。M5 (b) 只数已发布:`not ok 13` 与 `not ok 16`。M6 上传目标不再要求发布定义有效:`not ok 13`。M7 提前插一条完成行:`not ok 3` 与 `not ok 13`。以上 rc 均为 1;每项只因真实原因变红,没有「锚点未找到」类的连带失败 |
| 变异(W:接线) | W0 副本基线 rc=0;W1 从执行证明矩阵删掉本包 → rc=1(`not ok 6 - every pack is in both job matrices`) |
| 变异收尾 | 跑完一次性库里 `a1census*` 表 0 个、`a1census_fixture_*` schema 0 个;变异副本目录已删 |
| 剧本逐步有期望值 | runbook §5 A1–A10、§6 B1–B8,每步都有期望值与 file:line |
| 核对单每项附 file:line | runbook §3 C1–C9 |
| (r5)(b) 读数须取自 #5476 写路径半部署之后,并在 ON 前当场复读 | runbook §2 G2 / G6 |

## 4. 未跑项与残留

- **CI 未跑**:按约束未推 GitHub。`ops-sql-pack-verify.yml` 的两路矩阵只在本机等价命令上跑过。
- **另两个 SQL 包的自检已在同一车道形状下重跑**:两个包本身未改动,但它们与本包共用被改的 workflow。
  - 上一轮在同一执行机的一次性库上取得,被测提交 `57e5565a0b`。本轮未重跑:`57e5565a0b..4e130c1535` 之间 `.github/`、这两个包与接线测试均无改动(`git diff --quiet` 为真),读数沿用。
  - `readonly-inventory-20260916`:hermetic rc=0(11 / pass 10 / skip 1);执行层(`DATABASE_URL` + `METASHEET_REAL_DB_TEST_STEP=1`)rc=0(11 / pass 11)。
  - `live-id-fk-validate-20260920`:hermetic rc=0(18 / pass 17 / skip 1);执行层 rc=0(18 / pass 18)。
  - 跑完没有残留的 `inv_verify_ro_*` 角色,也没有残留的 `*fixture*` schema。
- **UAT 未在任何环境跑过**。普查只在一次性库上跑过。任何真实环境的读数都不是本包产出,均属 owner / ops。
- **静态层仍是有限规则**:values-free 与副作用两项静态检查是白名单形状 + 黑名单记号,不能穷举一切写法;values-free 的证明是执行层的标记检查(夹具值全带 `sentinelx`,输出与 stderr 中 0 命中),只读的证明是执行层的 25006 用例。两者在执行证明车道上都会跑。
- **detail (b) 定位段不在本包**(见 §2,偏离计划 r4 正文,待 owner 确认)。#5476 普查 (a) 段取 active 优先,与模板读取 latest 优先不一致;建议 owner 作为 #5476 的评审意见处置。
- **owner 未裁**:
  - Q1 放行形态与 #5476 处置;
  - Q2「8 场景验收」所指;
  - 主闸解析大小写宽松是否预期;
  - `APPROVAL_ATTACHMENT_MAX_SIZE` 在锁 §9 里列着,但代码不读它,上限是常量(`approval-attachment-validation.ts:30-34`)。本包只记事实,不提锁勘误。
- **UAT B8(角色席位审批人)**:依赖 F2-A2,落地前恒为 NOT RUN。
