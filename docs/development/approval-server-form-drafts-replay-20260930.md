# 审批服务端填单草稿(F3-D1)在新 main 上重放 · 设计与验证说明 · 2026-09-30

分支 `feat/approval-server-form-drafts-on-main`,基线 main `39891dc205`。本片把 #5703(分支 `feat/approval-server-form-drafts-p33`,4 个提交,头 `4686893308`)按序重放到新 main,再落实 owner 裁决 Q9 的 ④ 与 ⑤。**含 DDL(新表 `approval_form_drafts`),迁移未应用到任何环境**,只在另一台机器的一次性库上跑过 up / down / up;不开任何开关;#5703 本身不动(不推、不关)。

## 1. 改了什么

| 提交 | 内容 |
|---|---|
| `c3d2af8507` | 重放 #5703 第 1 个提交 `858a0bcbde`:新表迁移、服务层 `approval-form-draft-service.ts`、路由 `approval-form-drafts.ts`(注册在 `approvalsRouter()` 之前)、前端 `serverFormDraft.ts` 与 `ApprovalNewView.vue` 接线、真库套件与独立 workflow `approval-realdb-form-drafts.yml`、签名一致性单测、测试 bootstrap 同步。唯一冲突是 `approval-web-guard.yml` 的定向 `run:` 行,按并集解:保留 main 侧整行,只在 `approval-form-draft` 后插入 `serverFormDraft`。#5703 那边在同一步留下了第二个 `run:` 键(重复键),本分支不带。 |
| `b4e8e8736f` | 重放 `ed704a5b89`:服务层一处注释不再点名考勤 W7 组合锁 helper(该线的惰性普查把生产文件里的任何提及都算调用点)。只改注释。 |
| `2e7fd3be18` | 重放 `c0212b0be9`:`clearApprovalFormDraft` 在自己的事务里取与保存相同的用户级顾问锁;前端提交与「放弃恢复」共用「先静默在飞保存、再清除」的 helper。 |
| `92cd83ebdd` | 重放 `4686893308`:同一组件实例的防抖保存串成 promise 链,按发出顺序执行;签名在防抖触发时快照。 |
| `8a86958e81` | Q9 ④:迁移改名为 `zzzz20261001120000_create_approval_form_drafts.ts`(内容不变,100% 重命名),排在 main 最新迁移 `zzzz20260927121000_add_multitable_install_ledger_intent_kind` 之后;同步 workflow 的两处 `paths:` 与一处注释、bootstrap helper 的两处注释;`APPROVAL_SCHEMA_BOOTSTRAP_VERSION` 改标为 `20261001-f3d1-approval-form-drafts`(bootstrap DDL 不变,只让标记日期与改名后的迁移一致),其单测文本钉同步。 |
| `0b03117a19` | Q9 ⑤:真库套件维持「独立、路径过滤、非必需」的 workflow,`vitest.config.ts` 与该 workflow 里「是否提升为必需属 owner 待裁」的注释改记裁决值;web spec 按仓内两点规则把 `serverFormDraft` 登记进 `run-required-web-tests.sh`(按大小写不敏感排序的位置)并用 `--write` 重生成 `.tokens`。不碰 `plugin-tests.yml`。 |
| `8dfb8eb4e6` | 本说明的首版(只加这一个文件)。门审 r1 修复轮的提交与本说明的更新见 §6。 |

**提交信息更正**:`c3d2af8507` 的提交信息写「including the nine added after #5703 branched」,不准确。实际是:#5703 分叉后 main 在该行新增 **7** 个 token(`approvalTemplateCenterSections`、`approvalTemplateGroupsClient`、`ApprovalTemplateGroupsPanel`、`SessionOrgSwitcher.spec.ts`、`todoApi`、`TodoCenterView`、`todoCountsRealtime`);另有 **2** 个(`categoryCandidateInput`、`templateDetailI18n`)在分叉点就在,但 #5703 的第二个 `run:` 行漏掉了。「9」是 main 行相对 #5703 实际生效行(YAML 重复键取后一个)多出的个数。解法本身不受影响(main 侧整行保留);本分支已有的提交不改写,以本节为准。

**重放完整性(静态核对,本机 git 对象比较)**:

- 逐提交:4 对「原提交 → 重放提交」按文件比较增删行多重集合,23 个(提交,文件)对中 22 个完全一致,唯一不同的是 `c3d2af8507` 的 `approval-web-guard.yml`(即上表的冲突解法)。
- 累计:`git diff d944a1276a 4686893308`(#5703 的 merge-base 到头)与 `git diff 39891dc205 92cd83ebdd` 的文件集合相同(15 个文件),其中 14 个增删行集合完全一致,不一致的仍只有 `approval-web-guard.yml`。
- 并集:该行在 merge-base 上有 104 个 token(去重 101),main `39891dc205` 上 111 个(去重 108),本分支 112 个(去重 109);main 侧 111 个全部保留(多重集合差为空),新增只有 `serverFormDraft`。该行全部 token(不含 `--reporter=dot`)都在 `run-required-web-tests.tokens` 里(main 与本分支各自成立)。
- 相对基线 `39891dc205` 的删除行:`approval-web-guard.yml` 只有被替换的那一条 `run:`;`run-required-web-tests.sh` / `.tokens`、`vitest.config.ts`、`src/index.ts` 为 0。
- 改名:全仓对 #5703 原迁移名(日期 2026-09-14 的那个文件名)的全名检索 0 命中;对新名命中 2 个文件(workflow 与 bootstrap helper,作正控)。本说明也不写出原名全名,以免破坏该检索。

## 2. 依据

- 授权:owner 2026-09-30 23:2x 原话「你建议是？」之后,主会话列出四件事(其中含「把 Q4、Q8、Q9、Q14 记为按建议裁决」与「开工 Q9 服务端草稿和 Q14 后加签,做成 Draft PR」,并写明「不包含的:#6187 合并、锁的 ratify、开关、部署、迁移应用、生产普查」);owner 2026-10-01 00:0x 原话「按建议执行」。Q9 裁决值:① 草稿表不设 `org_id` 列(只按用户)接受;② 不建到模板表的外键接受;③ 写时按上限修剪接受;④ 迁移文件改名到 main 最新迁移之后;⑤ 新真库套件先作参考、不进必需检查。迁移应用到任何环境仍需 owner 另行授权。
- 计划:`approval-feishu-p2-p4-slice-plan-20260930`(规划文件,不在仓内)§4「F3-D1」原文:
  - 改动面:「在 main 上重放 #5703 的 4 个提交,解 `approval-web-guard.yml` 冲突;复核 `APPROVAL_SCHEMA_BOOTSTRAP_VERSION` 跨文件钉;按 Q9 处理迁移名(见风险)。」
  - 验收门:「#5703 正文所列并发 / 限额 / 路由遮蔽 / 跨用户五向攻击用例在新 main 复跑;required 车道全绿;迁移 up/down 在一次性库验证。」
  - 风险:「迁移名 … 早于 main 上 24 支已合迁移,迁移器 `allowUnorderedMigrations: true`(`db/migrate.ts:32`)⇒ 已部署环境会乱序补跑;是否改名属 Q9。」
  - 锁:「不需要(合同 `reviews/p33-server-draft-contract-20260914.md`,三处设计决定待 owner)。」§6 表同样把 F3-D1 列在「不需要新锁」一行。计划文末「第 5 轮(末轮)复验更正」节没有涉及 F3-D1 的条目。
- 合同 `p33-server-draft-contract-20260914`(不在仓内)与本片相关的原文(原文加粗已去):§2「决定:v1 不设 `org_id` 列。」「因此强制要求:访问控制只按 `user_id`,任何代码路径都不得用 org 参与草稿的可见性判定。」§3.1「不建 FK 到 `approval_templates`」;§3.2「采用写时修剪(upsert 之后删除该用户最新 N 条之外的),不用"先计数再放行"」;§5「新套件是否也要提升,属 owner 裁决」(本片按 Q9 ⑤ 落为「先作参考、不进必需」)。

## 3. 验收门实测读数

读数环境:另一台机器(macOS arm64),Node 20.20.2,pnpm 10.16.1,PostgreSQL 16.15,Playwright 1.57.0。本机只做编辑和提交,所有测试都在另一台机器上跑。**§3 的读数于 2026-10-01 重取**,取自门审 r1 修复轮之前的代码终态 `0b03117a19`(对照组 = main `39891dc205`),§3.4 另有逐提交读数;修复轮之后的读数见 §6。每个真库步骤都用本片新建的一次性库(库名含 `q9_impl` 与日期),跑前断言 `current_database()`,所有 `*_DATABASE_URL` 都指向该库,结束后删除并核实本片的库一个不剩。CI 里 `test (20.x)` 作业用 PostgreSQL 14,本片的独立 workflow `approval-realdb-form-drafts.yml` 用 PostgreSQL 16;这里是 16。

### 3.1 迁移 up / down / up(一次性库)

| 步 | 读数 |
|---|---|
| 全新库 up 到最新 | 退出 0;台账 421 行;按名(含 `COLLATE "C"`)与按执行时间排序的最后一支都是 `zzzz20261001120000_create_approval_form_drafts`,按名的前一支是 `zzzz20260927121000_add_multitable_install_ledger_intent_kind`;台账里原名 0 行 |
| 表形状 | 6 列全部 NOT NULL(`id` / `user_id` / `template_id` / `signature` text、`data` jsonb、`saved_at` timestamptz);约束 = 主键 + 5 条 CHECK(`approval_fd_user_nonblank` / `_template_nonblank` / `_signature_nonblank` / `_signature_bounds` / `_payload_bounds`);**外键 0 条;列名含 `org` 的列 0 个**;索引 = 主键 + `idx_approval_form_drafts_user_saved` |
| `--list` | Applied 421 / Pending 0 |
| `--rollback`(一步) | 退出 0;台账 421 → 420(差 1,正是新迁移);表不存在(`to_regclass` = NULL) |
| 再 up | 退出 0;只执行新迁移一支;形状与首次完全一致 |
| 再 up(幂等) | 退出 0;执行 0 支 |
| 直插 CHECK 探针(绕过服务层) | 合规行插入成功;空白 `user_id` / 空白 `template_id` / 空白 `signature` / 8193 字节签名 / 约 300 KB `data` 分别被对应的 CHECK 拒;同一 (用户, 模板) 直插第二行**被接受**(见 §4) |
| 先按 main 迁移、再按本分支迁移 | main 上 up:420 行、表不存在;本分支 `--list`:Pending 仅新迁移 1 支;up 后 421 行、按名与按时间最后一支都是新迁移、名字排在它之后的迁移 0 支、形状同上 |
| 台账里是 #5703 原名的库 | 把台账那一行改回原名后 up:退出 1,`corrupted migrations: previously executed migration <#5703 原名> is missing`;删掉这一行再 up:退出 0,新名迁移执行(`IF NOT EXISTS`,不报错),形状完整,表里已有的 2 行保留 |

另:远端 main 当前头 `ef9eb2d86c`(2026-10-01 只读核对)比基线 `39891dc205` 多 2 个提交(#6193 `48ae5025a5`、#6060 `ef9eb2d86c`),共 19 个文件,其中没有迁移,改名后的迁移仍排在最后。这 19 个文件与本分支的 17 个改动文件只重叠 `packages/core-backend/vitest.config.ts` 一个:取它在基线、本分支、`ef9eb2d86c` 三个版本做三方文件合并(`git merge-file`),无冲突。本分支没有在 `ef9eb2d86c` 上重跑测试。

### 3.2 #5703 正文所列用例在新 main 复跑

**真库套件整文件**(`approval-form-drafts.db.test.ts`,`EXPECT_DB=1`,`--reporter=verbose`,与 workflow 同一条命令):**26 / 26 通过,0 跳过**(#5703 正文写 25/25,那是第三个提交加入 P3-D 交错用例之前的数;§3.4 逐提交读数里前两个提交正是 25)。并发用例读数:`[FIX 6] max row count observed across 25 rounds x 4-way concurrency: 20 (cap N=20)`。

**跨用户五向攻击**(对真服务器 `MetaSheetServer` 发 HTTP;一次性探针文件,不入仓;用户 A 先写草稿,B 发起攻击):

| 向量 | 结果 | 套件里对应的具名用例 |
|---|---|---|
| 正控:A 读回自己的草稿 | 通过(A 看到 `{"secret":"A-only"}`) | A「POSITIVE: user A can load their own saved draft」 |
| V1 跨用户读(B 读同一 templateId) | 通过:200,`draft = null` | A「NEGATIVE: user B requesting the SAME templateId …」 |
| V2 跨用户列 | 通过:B 的列表长度 0 | 同上用例的列表断言 |
| V3a 跨用户写(B PUT 同一 templateId) | 通过:A 仍看到自己的内容,B 只看到自己的 | **套件无单独用例**(探针补测) |
| V3b 跨用户删(B DELETE 同一 templateId) | 通过:204,A 的草稿仍在 | A「NEGATIVE (destroy) …」 |
| V4 伪造头(`x-user-id`、`x-actor-id`、`x-tenant-id` + `x-org-id`、三者合用) | 四种都通过:读 `null`、列表长度 0 | A「NEGATIVE ("any means") …」(只覆盖 `x-user-id` + `x-actor-id`);org 维度见 B 两条 |
| V5 id 枚举(B 以 A 的行 id `afd_…`、以 A 的 userId 当 templateId 读 / 删) | 通过:读 `null`,删 204,A 的草稿仍在 | **套件无单独用例**(URL 里没有行 id;探针补测) |
| 收尾行数 | A 1 行,B 0 行 | — |

**限额**(另一个一次性探针,HTTP PUT;每次前后数该用户行数):1 KiB 合规数据 200、行数 0 → 1;**2 MB 数据 413、8 MB 数据 413、9000 字节签名 413**,三者行数均不变(`APPROVAL_FORM_DRAFT_TOO_LARGE`)。套件 E(条数上限:N−1 不修剪、N+3 稳定在 N、直插超额后写一次收敛回 N、跨用户隔离、修剪幂等)、F(数据体积两层,3 条)、签名体积两层(4 条)全部在上面 26 条里通过。

**路由遮蔽**(同一探针对 14 个 GET 路径记录状态码与归一化响应体哈希):

- 本分支:`/api/approvals/form-drafts` → 200 `{"ok":true,"data":{"drafts":[]}}`;`/api/approvals/form-drafts/q9x-tpl` → 200 `{"ok":true,"data":{"draft":null}}`;`/api/approvals/form-draftsx` 仍 404 `APPROVAL_NOT_FOUND`(前缀相近的路径不被草稿路由吃掉)。
- 把注册顺序倒回去(变异 M4,草稿路由挪到 `approvalsRouter()` 之后):列表路由变成 404 `APPROVAL_NOT_FOUND`(被 `GET /api/approvals/:id` 吃掉),单条路由仍 200;14 行里其余 13 行状态码与哈希逐一相同。
- main `39891dc205`:两个草稿路径都是 404,其余 12 个路径与本分支逐一相同。

### 3.3 变异(每次改一处、跑、`cp` 还原、`cmp` 相同且工作树干净)

本表是 `0b03117a19` 上的读数。修复轮之后:M4 的读数见 §6.2,M5 / M6 / C1–C3 / S1 在 `cf1419e3ed` 上的复跑见 §6.4。

| # | 变异 | 结果 |
|---|---|---|
| M1 | 读单条去掉 `user_id` 过滤 | 套件红 3 条(A 两条 NEGATIVE、B 的「两个不同用户看到不同草稿」正控);探针 V1 / V3a / V4 四种全部 FAIL |
| M2 | 列表去掉 `user_id` 过滤 | 套件红 1 条(A NEGATIVE 的列表断言);探针 V2 与 V4 四种的列表 FAIL |
| M3 | 清除去掉 `user_id` 过滤 | 套件红 1 条(A NEGATIVE destroy);探针 V3b / V5 / 收尾行数 FAIL |
| M4 | 草稿路由注册挪到 `approvalsRouter()` 之后 | 套件恰好红 1 条(唯一调用列表路由的 A NEGATIVE),单条路由用例全绿;探针见 §3.2 |
| M5 | 保存锁退回 (用户, 模板) 粒度 | 套件红 1 条(FIX 6);FIX 6 最大行数 **23**(上限 20)。P3-D 交错用例在这个变异下时红时绿(之前一次草稿读数里红),不作为它的判据;「清除不取锁」由 M6 单独判 |
| M6 | 清除不再取共享顾问锁 | 套件恰好红 1 条(P3-D 交错用例) |
| M7 | 修剪的外层 DELETE 不按写入者收窄 | 套件红 2 条(E「跨用户隔离」、B 的正控) |
| C1 | 前端保存退回「单槽覆盖」 | `approvalNewView` 恰好红 3 条顺序用例(两条逆序完成 + 发出顺序) |
| C2 | 「放弃恢复」里把 `draftArmed = false` 塞回去 | 恰好红 1 条(放弃后继续输入仍自动保存) |
| C3 | 清除不等在飞保存 | 红 4 条(提交 / 放弃两条 FIX C + 两条逆序完成) |
| S1 | `serverFormDraft.ts` 保存从 PUT 改成 POST | `serverFormDraft` 红 2 条(调用形状断言) |
| B1 | 只改 bootstrap helper 里的版本串(不改单测钉) | `approval-admin-jump-migration.test.ts` 红 1 条(跨文件钉承重) |

### 3.4 单测、前端、类型检查与逐提交读数

- 签名一致性 + bootstrap 钉:`approval-form-draft-signature-web-parity.test.ts` 与 `approval-admin-jump-migration.test.ts` 2 文件 21 / 21 通过。
- 前端三个 spec:`serverFormDraft` 18、`approvalNewView` 56、`approval-form-draft`(旧 localStorage 版,逐字节未动)7,合计 **81 / 81**。
- `vue-tsc -b` 退出 0、`vue-tsc --noEmit -p tsconfig.verification-approval.json` 退出 0(均零输出)。
- `node scripts/ops/required-web-lane-token-manifest.mjs --check`:退出 0,19 个门控调用共 546 个不同 token,提交的清单 546 个,`MANIFEST MATCHES`。
- `plugin-tests.yml` 与 `s6a-package-provenance-pins.json` 相对基线 `39891dc205` 逐字节相同(因此不需要重算 pins,不与 #6187 冲突)。
- 逐提交(每个提交各建一次性库、迁移、跑真库套件 + 上面两个单测 + 三个前端 spec;`pnpm-lock.yaml` 相对基线 `39891dc205` 0 行差,依赖不变):

| 提交 | 全新库迁移 | 真库套件(整文件) | 签名一致性 + bootstrap 钉 | 三个前端 spec |
|---|---|---|---|---|
| `c3d2af8507` | 退出 0,执行 421 支 | 25 / 25 | 21 / 21 | 75 / 75 |
| `b4e8e8736f` | 退出 0,执行 421 支 | 25 / 25 | 21 / 21 | 75 / 75 |
| `2e7fd3be18` | 退出 0,执行 421 支 | 26 / 26 | 21 / 21 | 77 / 77 |
| `92cd83ebdd` | 退出 0,执行 421 支 | 26 / 26 | 21 / 21 | 81 / 81 |
| `8a86958e81` | 退出 0,执行 421 支 | 26 / 26 | 21 / 21 | 81 / 81 |
| `0b03117a19` | 退出 0,执行 421 支 | 26 / 26 | 21 / 21 | 81 / 81 |

  前四个提交上迁移还是原名(改名在 `8a86958e81`),全新库里迁移顺序不影响结果;每行的一次性库用完即删。

### 3.5 必需检查(13 个 context)在另一台机器上的重放

清单取自 `main` 分支保护的必需检查(2026-10-01 只读核对,13 个)。重放方法:一个不入仓的小脚本按 workflow 文件逐步执行对应 job 的 `run:` 步骤——`uses:` 步骤(checkout / setup / cache / upload / Postgres 服务)不执行,由这台机器的环境与一次性库代替;所有以 `DATABASE_URL` 结尾的环境变量和脚本里写死的本地 Postgres 连接串都改指一次性库;`if:` 按 `pull_request` 事件与 `20.x` 求值;路径判定以 `39891dc205` 为 diff 基。impl = `0b03117a19`;base = `39891dc205`,只在 impl 有红步时对同一步重跑作对照。读数取于 2026-10-01 06:37–09:17(UTC+8)。

**这一节能证明的是「相对 base 没有新增失败」,不是计划验收门里的「required 车道全绿」**:`test (20.x)` 有 5 个步骤在两边都红(见下表),另有 2 个 context 无法在这台机器上重放。全绿以 Draft PR 上的 CI 为准(见 §4)。

| context | 重放的步骤 | impl 读数 | base 读数 | 判定 |
|---|---|---|---|---|
| `contracts (strict)` | `attendance-gate-contract-matrix.yml` job `contracts`,case `strict`:`./scripts/ops/attendance-run-gate-contract-case.sh strict` | 退出 0;日志里的 `ERROR` 行都是脚本自带的负例,每条后面紧跟「expected failure confirmed」 | 未跑(impl 通过,无需对照) | 通过 |
| `contracts (dashboard)` | 同上,case `dashboard` | 退出 0(同上) | 未跑 | 通过 |
| `contracts (openapi)` | 同上,case `openapi` | 退出 0(同上) | 未跑 | 通过 |
| `pr-validate` | `phase5-validate.yml`:第一步探测 secret `METRICS_URL`,没有就输出空值并退出 0,其后每一步都以该输出非空为 `if:` 条件;有 secret 时校验命令本身也带 `\|\| true` | 未重放(这台机器没有该 secret) | 未重放 | 不适用:结论不取决于本分支代码 |
| `test (20.x)` | `plugin-tests.yml` job `test` 全部 110 步,一次性库 | 93 步通过;7 步红,1 步(099)超出重放器每步 15 分钟的上限;另有 7 个 `uses:` 步、1 个 pwsh 步(055)、1 个建库步(084,由一次性库代替)不执行。红步逐条见下表 | 对 impl 的 8 个红步(另加 npmrc 与迁移两步)逐步重跑 | 本片零新增失败(下表) |
| `web-tests` | `web-tests.yml`:`bash apps/web/scripts/run-required-web-tests.sh` | 退出 0;517 个文件、8511 个用例全部通过,其中 `serverFormDraft` 18、`approvalNewView` 56、`approval-form-draft` 7 | 未跑 | 通过 |
| `stock-prep PowerShell 5.1 acceptance` | `plugin-tests.yml` job `stock-prep-powershell51`:`windows-latest` 上用 Windows PowerShell 5.1(与 pwsh 7)跑 `scripts/ops/__tests__/` 下的 `.ps1` | 未重放(这台机器是 macOS,没有 Windows PowerShell) | 未重放 | 不适用:本分支 17 个改动文件没有一个在 `scripts/` 下,`plugin-tests.yml` 相对基线逐字节相同,该 job 的输入没有变 |
| `attendance-web-guard` | `attendance-web-guard.yml`:变更判定 → 「Report success for unrelated changes」 | 判定为没有受守护的考勤前端文件改动,成功步通过;其余步按 `if:` 不执行 | 未跑 | 通过 |
| `integration-guard` | `integration-guard.yml`:链完整性守卫、Bridge Agent 合同测试、diff 目标解析、变更判定、必需接线合同自检、范围外 no-op、终端安全网 | 执行的步全部通过:Bridge Agent 26 / 26,接线自检 64 / 64;变更判定为无相关改动,其余步按 `if:` 不执行 | 未跑 | 通过 |
| `ssh host-key pin contract (fail-closed known_hosts)` | `ssh-hostkey-pin-contract.yml` 三步 | 12 / 12、14 / 14、16 / 16 | 未跑 | 通过 |
| `observation-kit contract (read-only SQL census + runbook gating)` | `multitable-o2-observation-kit.yml`:hermetic 测试 | 323 个用例:293 通过、0 失败、30 跳过 | 未跑 | 通过 |
| `recovery-schema-drift` | `multitable-recovery-schema-drift.yml`,一次性库:迁移 → drift A-vs-B 守卫(整文件)→ search-path 遮蔽反例(整文件) | 迁移通过;5 / 5;9 / 9 | 未跑 | 通过 |
| `Approval browser verify (chromium)` | `approval-browser-verify.yml`:变更判定 → CI 归属与收集校验 → 装 Playwright chromium → 验证 harness 类型检查 → 真浏览器验证 | 判定为有审批相关改动;归属校验 3 / 3;类型检查退出 0;浏览器验证 42 / 42 | 未跑 | 通过 |
| (非必需,本片改动的 workflow)`approval-web-guard` | `approval-web-guard.yml`:Canvas V2 命令 canary、FWB 映射合同、定向 spec 一步 | 第一次重放时定向步红:6 个用例各报「Test timed out in 5000ms」,分属 6 个本片未改的 spec 文件,2161 / 2167 通过。这 6 个文件随后在 impl 与 base 上各单独跑两次,每次 6 / 6 文件、154 / 154 用例通过;整步重跑通过:110 个文件、2167 个用例 | 整步:109 个文件、2136 个用例通过 | 通过;impl 多 1 个文件 31 个用例 = `serverFormDraft` 18 + `approvalNewView` 新增 13(43 → 56) |

`test (20.x)` 的红步(「名字集合」= 失败用例全名去重后的集合;base 用另一个一次性库):

| 步 | impl 读数 | base 读数 | 判定与依据 |
|---|---|---|---|
| 003 Global History flag manifest contract (R12-C) | 144 通过 / 60 失败 | 144 / 60;失败名字集合与 impl 相同(两边各 60 条,impl 独有 0) | 两边同红,环境性:60 条全在 `scripts/ops/multitable-onprem-package-upgrade-inplace.test.mjs`,该文件默认用 pwsh 执行被测的 PowerShell 脚本(其中 5 条直接报找不到 pwsh),这台机器没有 pwsh;该文件会挂住的子进程两边都由同一条看门狗规则结束。本分支不改 `scripts/`。单独重跑两边结果仍相同(144 / 60)。 |
| 035 Tasks auth CI wiring contract | 全量重放中 2 / 3 | 3 / 3 | 负载导致:红的那条报 Python 起进程超时(`spawnSync python3 ETIMEDOUT`;该守卫按设计在起不了 Python 做 YAML 解析时失败关闭)。impl 单独重跑 3 / 3,与 base 相同。 |
| 043 T2 source-freeze CI wiring contract | 5 / 6 | 6 / 6 | 同上;impl 单独重跑 6 / 6。 |
| 044 T2-Gate collision-mechanism CI wiring contract | 103 / 104 | 104 / 104 | 同上;impl 单独重跑 104 / 104。 |
| 077 Run core-backend tests | 文件 4 红 / 1057 过;用例 43 红 / 17746 过 / 1665 跳 | 文件 4 / 1056;用例 43 / 17735 / 1665;失败名字集合相同(43 = 43,impl 独有 0) | 两边同红(既有,与本片无关):43 条全在 `multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup` 四个单测文件,本分支不改这些文件,也不改它们测的多维表恢复代码;原因不属本片,未查。impl 多 1 个文件 11 个用例 = 新的签名一致性单测 9 条 + 覆盖枚举守卫为本片两个新测试文件各多 1 条「is wired」。 |
| 085 Run isolated manual checkpoint acceptance | 1 红 / 46 过 | 1 / 46;同一条(D5 归档恢复任务的 local custody 用例) | 两边同红(既有,与本片无关);同属多维表恢复的本地托管存储,本分支不碰。 |
| 099 Run multitable real-DB integration | 全量重放中超出 15 分钟上限(无汇总);改用 45 分钟上限重跑(934 秒):文件 4 红 / 259 过,用例 7 红 / 2946 过 / 2 跳 | 全量对照(781 秒):文件 5 红 / 258 过,用例 6 红 / 2947 过 / 2 跳;45 分钟上限重跑(1036 秒):文件 2 红 / 261 过,用例 3 红 / 2950 过 / 2 跳 | 抖动;本片零新增失败,依据见表下 |
| 109 Run attendance integration tests | 文件 1 红 / 123 过;用例 2 红 / 1785 过 | 相同;同两条(`attendance-shift-swap.test.ts` 的两条换班用例) | 两边同红(既有,与本片无关);本分支不碰考勤,原因不属本片,未查。 |

099 的判定依据:

- base 自己两次的失败集合只重合 1 条:D5 的 local custody 用例(impl 也红,同 085)。base 第一次另红 history-events T2b、Yjs bridge flush A4 / M4、read-path 字段遮罩 R7、W1-1 公式新鲜度 GF3;第二次另红 AI 建议公式 M4-T8、D5 的另一条 SIGKILL 用例。
- impl 重跑另红 6 条,落在 3 个文件:Yjs bridge flush(A5 两条、A6、M3;这个文件在 base 第一次也红过,用例不同)、dangling-link 回收站分页(期望 200 得到 405)、reset-pit 关开关(期望 403 得到 401);后两条在 base 上没出现过。
- 于是把这 3 个文件各自单独跑:每次新建一次性库、迁移、只跑这一个文件,impl 与 base 各两轮(同一个重放脚本、同样的连接串改写;期间 1 分钟负载 18–57)。12 次全部通过:dangling-link 30 / 30、reset-pit 14 / 14、Yjs bridge flush 12 / 12,impl 与 base 每轮都一样。
- 本分支对多维表代码与测试的改动为零;服务端唯一新增是四个按完整路径注册的 `/api/approvals/form-drafts*` 路由与一张新表(§3.2 的路由遮蔽读数:其余路径的状态码与响应哈希不变)。

另:与本片最相关的 100「Run approval real-DB integration」(审批真库套件)在 impl 上通过(292 秒)。

## 4. 未跑项与残留

- **迁移未应用到任何环境**;应用需 owner 另行授权。本片只在一次性库上跑过 up / down / up。
- **改名对「台账里已有 #5703 原名」的库**(实测见 §3.1 末行):迁移器拒绝继续、退出 1;删掉台账里原名那一行后可继续,且不会丢表里已有的行。按 #5703 正文,原名迁移只在一次性容器里跑过,没有应用到共享环境;各环境实际状态本片无法核验(UNVERIFIED)。若有人用 #5703 分支建过本地开发库,需要先删那一行(一次性库直接重建即可)。
- **#5703 原有的「就地修改迁移」残留**不因改名消失也不因改名变坏:在已经跑过该迁移的库上,后补进迁移文件的约束不会被补上。按上条,这类库本来就只可能是一次性库。
- **「一个 (用户, 模板) 一槽」只由服务层保证**:表上没有 `(user_id, template_id)` 唯一约束,绕过服务层直插第二行会被接受(§3.1)。服务层在用户级顾问锁内先查后写,所以经 API 不会出现两行;清扫函数是唯一不取锁的写入方(只删不插)。是否补唯一约束属 DDL 形状变更,不在本片范围,照 #5703 原样。
- **客户端 / 服务端顺序残留**:沿用 #5703 正文「未解决」第 3 条,本片不改;关掉它需要 DDL,不在本片范围。清扫函数 `sweepExpiredApprovalFormDrafts` 本片不接到任何定时器。
- **`formDraft.ts` 的四个存储函数**现在没有生产调用方(`formSchemaSignature` 仍在用);删不删属 owner。草稿箱界面未做(只有列表端点与客户端函数)。
- **新前端 spec 没有并入既有 spec 文件**:`serverFormDraft.spec.ts` 保持 #5703 原文件(便于逐文件对照重放),按仓内惯例两点登记(`run-required-web-tests.sh` + `approval-web-guard.yml`)并重生成 token 清单。它是纯前端单测,进必需 web 车道;Q9 ⑤ 说的「不进必需」针对的是新真库套件,该套件只在非必需的独立 workflow 里跑。
- **与并行 lane 的冲突面**:F8-1(多语言)同时改 `ApprovalNewView.vue` 与 `approvalNewView.spec.ts`,本片对前者只做了重放所需的改动,不动文案。对它当前的本地分支头试合并:`ApprovalNewView.vue` 自动合并;`approvalNewView.spec.ts` 有内容冲突——两边都在文件末尾追加了新的 `describe` 块。按并集解时,本片的「P3-3 (gate P2-3): real drift-guard comparison」块须**仍在文件最后**(它的注释写明放在最后是为了让 `vi.resetModules()` 不影响其后的用例),F8-1 的块放在它之前。`run-required-web-tests.sh` / `.tokens` 与 `approval-web-guard.yml` 是 token 清单类文件,合并时按并集处理并重跑 `required-web-lane-token-manifest.mjs --check`。
- **不碰 `plugin-tests.yml`**,因此不需要重算 s6a pins,也不与 #6187 冲突。
- **#5703 未动**:仍是 OPEN 的 Draft;关不关由 owner 决定。
- **必需检查的「全绿」要看 CI**:计划验收门写「required 车道全绿」;§3.5 在另一台机器上能证明的只是「相对 base 零新增失败」——`test (20.x)` 有 5 个步骤两边都红(003 / 077 / 085 / 099 / 109;本片没查原因,也不修),`pr-validate` 与 `stock-prep PowerShell 5.1 acceptance` 无法重放。全绿以 Draft PR 上的 CI 为准:CI 是 Linux,`test (20.x)` 用 PostgreSQL 14;这里是 macOS + PostgreSQL 16。
- **重放器的边界**:不执行 `uses:` 步(checkout / setup / cache / upload / Postgres 服务);全量重放给每一步设 15 分钟上限(099 因此被截断,改用 45 分钟上限另跑);重放期间这台机器同时跑着其它 lane,1 分钟负载约在 5 到 57 之间波动。035 / 043 / 044 的 Python 起进程超时与 approval-web-guard 的 6 个 5 秒超时是负载下的超时,单独重跑后消失;099 里 impl 独有的 6 条,所在 3 个文件单独跑两轮也全部通过。
- **main 已前进**:远端 main 现在是 `ef9eb2d86c`(比基线多 #6193、#6060 两个提交,没有迁移);本片没有在它上面重跑测试,只做了文件级合并检查(§3.1 末段)。合并前以 CI 在 PR 合并结果上的读数为准。
- **合并前检查单**(门审 r1 的 P3-2 与 NIT-2,不改 owner 裁决):
  1. 合并任何触及 `packages/core-backend/src/services/approval-form-draft-service.ts` 或 `packages/core-backend/src/routes/approval-form-drafts.ts` 的 PR 前,人工读非必需 workflow `approval-realdb-form-drafts` 的结果。按 Q9 ⑤,真库套件只在这条非必需 lane 里跑,而按用户隔离的各处 `user_id` 条件(读单条、列表、保存前查重、修剪、清除)只有它在测:它红了不会挡合并。以后若把这个套件提升为必需,先提升 A 组。
  2. 合并时再核一次 `ls packages/core-backend/src/db/migrations | LC_ALL=C sort | tail -1` 是 `zzzz20261001120000_create_approval_form_drafts.ts`。迁移器开着 `allowUnorderedMigrations: true`,若在本片合并前有时间戳更晚的迁移先进 main,已部署环境乱序补跑的问题会回来,需要按 Q9 ④ 再改名。

## 5. 本说明与代码终态的关系

本说明的首版在 `8dfb8eb4e6` 单独提交,当时代码、workflow、测试与清单文件停在 `0b03117a19`,§3 是那时的读数。门审 r1 修复轮又加了 `0c0d35ec27`、`67506ca76c`、`cf1419e3ed` 三个提交,随后加了一个只改服务层注释的 `0f8afc01df`,**代码终态为 `0f8afc01df`**。本说明在 `9630c8e16e` 与其后一个提交里更新,两次都只改本文件(§1 末行、§3 抬头、§3.3 抬头、§4 检查单、本节与 §6)。代码终态的读数见 §6.5。

## 6. 门审 r1 修复轮(2026-10-01)

门审 r1(见私有记录)对头 `8dfb8eb4e6` 的判定是 0 P1 / 1 P2 / 2 P3 / 3 NIT。修复轮只新增提交,不改写已有提交:

| 提交 | 处理的条目 | 内容 |
|---|---|---|
| `0c0d35ec27` | P2-1:四条草稿路由上的 `rbacGuard('approvals', 'write')` 没有测试 | `approval-rbac-boundary.test.ts` 把 `approvalFormDraftsRouter()` 单独挂到一个 app 上,对只有 `approvals:read` 的用户,列表 GET、单条 GET、PUT、DELETE 各一条用例断言 403,另加一条 `approvals:write` 用户四条路由都进入 handler 的正控。真库套件 A 组加同形负例:只读 token 的四条路由读数必须是 `[403, 403, 403, 403]`,该用户 0 行;同一用户换写 token 后 PUT 200。只改测试。 |
| `67506ca76c` | NIT-1:路由遮蔽要靠 TypeError 才红 | A 组跨用户用例在读列表 body 之前先断言 `status` 为 200。只改测试。 |
| `cf1419e3ed` | P3-1:请求被数据库自己拒绝时落成 500;服务层「绝不会」的注释不成立 | 服务层新增导出函数 `mapApprovalFormDraftStorageError`:`23514` 且约束为 `approval_fd_payload_bounds` → `ApprovalFormDraftTooLargeError`(413);SQLSTATE `22P05` / `22P02` / `22021` → `ApprovalFormDraftValidationError`(400);其余原样返回。路由的 `handleDraftError` 先调用它,四条路由都生效;其它失败仍是 values-free 500。服务层文件头与迁移 docblock 改成如实表述:服务层量的是 `JSON.stringify` 的字节数,CHECK 量的是 jsonb 文本输出,后者更大,所以过了服务层的请求仍可能被 CHECK 拒。迁移文件只改注释,DDL 逐字节不变(§6.3)。真库套件新增「storage refusals」组 7 条 HTTP 用例。`approval_fd_signature_bounds` 有意不映射:两层数的都是同一段文本的 UTF-8 字节,且服务层阈值更低,请求到不了这条 CHECK;它若真被触发,说明阈值配置错了,500 才是对的。 |
| `9630c8e16e` | P3-2、NIT-2;r1 未复跑变异的补跑 | 只改本文件:§4 加合并前检查单两条;本节记修复轮读数,含 r1 未复跑变异的补跑及其断言原文。 |
| `0f8afc01df` | `cf1419e3ed` 留下的注释矛盾 | `APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS` 的注释原说服务层阈值低于 CHECK 是因为两层「重新序列化不保证逐字节相同」,并指向载荷上限的注释;那是 jsonb 的情形。改为如实表述:`signature` 是 text 列,两层数的是同一段 UTF-8 字节,服务层阈值更低,总是先触发,余量只是 headroom;`mapApprovalFormDraftStorageError` 不映射 `approval_fd_signature_bounds` 正是依据这一点。只改注释:`git diff -U0 cf1419e3ed 0f8afc01df` 只有一个 hunk(`@@ -110,5 +110,7 @@`),改动行全是 ` *` 注释行;去掉注释行后新旧文件逐字节相同(`cmp`,433 行)。 |
| 本说明的这次更新 | — | 只改本文件:把代码终态改记为 `0f8afc01df`(§1 末行、§5、本表、§6.4 / §6.5 抬头)。 |

读数环境同 §3:另一台机器(macOS arm64),Node 20.20.2,pnpm 10.16.1,PostgreSQL 16.15。工作树是真实的 `pnpm install --frozen-lockfile`(不是软链)。用一个一次性库(库名含 `q9_fix1` 与日期),每轮开跑前断言 `current_database()`,`DATABASE_URL` 指向它。变异一律先备份,再改、跑、还原,还原后 `cmp` 相同且 `git status` 干净。读数取于 2026-10-01 10:0x–10:2x(UTC+8)。

### 6.1 P2-1 只读负例(`0c0d35ec27`)

「拆守卫」= 把该路由上的 `rbacGuard('approvals', 'write')` 换成直通中间件。

| 变异 | `approval-rbac-boundary.test.ts`(默认配置) | 真库套件 A 组 RBAC 用例 |
|---|---|---|
| 无(基线) | 42 / 42(改前 `8dfb8eb4e6` 为 37,新增 5) | 套件 27 / 27 |
| 只拆列表 GET | 恰好红 1 条(列表 GET):`expected 200 to be 403` | 红:`expected [ 200, 403, 403, 403 ] to deeply equal [ 403, 403, 403, 403 ]` |
| 只拆单条 GET | 恰好红 1 条(单条 GET):`expected 200 to be 403` | 红:`[ 403, 200, 403, 403 ]` |
| 只拆 PUT | 恰好红 1 条(PUT):`expected 500 to be 403` | 红:`[ 403, 403, 200, 403 ]` |
| 只拆 DELETE | 恰好红 1 条(DELETE):`expected 500 to be 403` | 红:`[ 403, 403, 403, 204 ]` |
| 四处全拆(门审的 mu8) | 红 4 条(四条负例),正控仍绿 | 红:`expected [ 200, 200, 200, 204 ] to deeply equal [ 403, 403, 403, 403 ]`;套件其余 26 条仍绿 |
| 还原 | 42 / 42 | 套件 27 / 27 |

单测里拆掉 PUT / DELETE 的守卫后得到 500 而不是 200:这个文件的 pg mock 不提供事务,请求过了守卫才在 handler 里失败。断言针对的是 403,所以照样变红。core-backend `type-check` 退出 0。

`approval-rbac-boundary.test.ts` 不在 `packages/core-backend/vitest.config.ts` 的 exclude 里。`plugin-tests.yml` 的「Run core-backend tests」步跑 `pnpm --filter @metasheet/core-backend test`,用的就是这个默认配置,所以这组负例在必需检查 `test (20.x)` 里。真库套件那条只在非必需的 `approval-realdb-form-drafts` 里跑。

### 6.2 NIT-1(`67506ca76c`)

真库套件 27 / 27。门审的 mu7(草稿路由挪到 `approvalsRouter()` 之后)现在红 2 条,都红在断言上:

- A 组跨用户用例:`expected 403 to be 200`。B 的 token 只有 `approvals:write`,列表请求被 `GET /api/approvals/:id` 接走后,在它的读权限守卫上被拒。
- A 组 RBAC 用例:`expected [ 404, 403, 403, 403 ] to deeply equal [ 403, 403, 403, 403 ]`。

§3.3 的 M4 读数(红 1 条)是改之前的。

### 6.3 P3-1(`cf1419e3ed`)

先在一次性库上直接调用服务函数,记下每种输入实际触发的 SQLSTATE(PostgreSQL 16.15):

| 输入 | 结果 |
|---|---|
| `data = {a: [1 × 129000]}`:`JSON.stringify` 为 258,007 B,不超过服务层阈值 258,048 | 新建与更新两条路径都是 `23514`,约束 `approval_fd_payload_bounds`(jsonb 文本 387,007 B) |
| `data` 的值或键里含 U+0000 | `22P05` |
| `data` 里含孤立代理(高位、低位、高位在串尾三种) | `22P02` |
| `signature` 里含 U+0000 | `22021` |
| 模板 id 含 U+0000(保存、读取、清除三条路径) | `22021` |
| `signature` 里含孤立代理 | 写入成功:驱动按 UTF-8 编码时把它换成 U+FFFD,不需要映射 |

修复后真库套件 34 / 34(27 + 新增 7)。逐支变异,每次只改一处:

| 变异 | 结果 |
|---|---|
| 路由不调用映射(`const error = rawError`) | 红 6 条,即全部拒绝用例:4 条 `expected 500 to be 400`、2 条 `expected 500 to be 413`,消息里是改前的 values-free 500 响应体 `APPROVAL_FORM_DRAFT_SAVE_FAILED`。正控(合规 1 KiB → 200)与 D 组「有毒连接池 → 5xx」仍绿:不带 SQLSTATE 的普通 `Error` 不会被误映射 |
| 去掉 `23514` 分支 | 恰好红 2 条(新建、更新两条膨胀用例):`expected 500 to be 413` |
| 集合去掉 `22P05` | 恰好红 1 条(`data` 含 U+0000):`expected 500 to be 400` |
| 集合去掉 `22P02` | 恰好红 1 条(孤立代理):`expected 500 to be 400` |
| 集合去掉 `22021` | 恰好红 2 条(`signature` 含 U+0000、模板 id 含 U+0000):`expected 500 to be 400` |
| 单条 GET 的 catch 不经映射直接回 500 | 恰好红 1 条(模板 id 用例),红在 GET 一步:响应体 `APPROVAL_FORM_DRAFT_LOAD_FAILED`,`expected 500 to be 400` |
| DELETE 的 catch 不经映射直接回 500 | 恰好红 1 条(模板 id 用例),红在 DELETE 一步:响应体 `APPROVAL_FORM_DRAFT_CLEAR_FAILED`,`expected 500 to be 400` |

每条拒绝用例还断言:响应体里没有数据库自己的错误文本(`check constraint`、`approval_fd_`、`invalid input syntax`、`Unicode`、`byte sequence`),该用户行数不变;更新路径的用例另外断言原草稿的签名和内容都没变。core-backend `type-check` 退出 0。

迁移文件只改了注释:`git diff` 只有 docblock 里的一个 hunk(`@@ -43,3 +43,4 @@`,docblock 在第 78 / 79 行结束);从 `import` 到文件尾的 28 行新旧逐字节相同(`cmp`),两个 `sql` 模板体的 md5 也相同。

### 6.4 r1 未复跑变异的补跑(在 `cf1419e3ed` 上跑;`0f8afc01df` 只改注释)

| 变异 | 结果与断言原文 |
|---|---|
| M5 保存锁退回 (用户, 模板) 粒度 | 红 2 条。FIX 6:`expected 23 to be less than or equal to 20`(`[FIX 6] max row count observed across 25 rounds x 4-way concurrency: 23 (cap N=20)`);P3-D 交错用例:`expected 1 to be +0`。P3-D 在这个变异下红不红取决于时序(§3.3 记过时红时绿),这一次是红;「清除不取锁」由 M6 单独判 |
| M6 清除不再取共享顾问锁 | 恰好红 1 条(P3-D 交错用例):`expected 1 to be +0` |
| C1 前端保存退回「单槽覆盖」 | `approvalNewView` 恰好红 3 条:`a second same-slot SAVE must not be issued while an earlier one is still unsettled: expected "spy" to be called 1 times, but got 2 times`;`CLEAR must not be issued while an earlier same-slot SAVE is still unsettled, regardless of what order any LATER save from that slot completes in: expected "spy" to not be called at all, but actually been called 1 times`;`discard must not issue CLEAR while an earlier same-slot SAVE is still unsettled either: expected "spy" to not be called at all, but actually been called 1 times` |
| C2 「放弃恢复」里把 `draftArmed = false` 塞回去 | 恰好红 1 条:`discard must not permanently disarm autosave for the rest of the session: expected "spy" to be called 1 times, but got 0 times` |
| C3 清除不等在飞保存 | 红 4 条:`CLEAR must not be issued while a same-slot SAVE is still in flight -- it can otherwise commit first and the save resurrects the draft on INSERT: expected "spy" to not be called at all, but actually been called 1 times`;`CLEAR must not be issued while a same-slot SAVE is still in flight at discard time either: …`;以及 C1 那两条逆序完成用例的同一断言 |
| S1 `serverFormDraft.ts` 保存从 PUT 改成 POST | `serverFormDraft` 红 2 条:`expected 'POST' to be 'PUT'`;`expected "spy" to be called with arguments: [ …(2) ]` |

计数与 §3.3 在 `0b03117a19` 上的读数一致(M5 除外:§3.3 记 FIX 6 红 1 条,P3-D 那次是绿,原因见上)。每次还原后 `cmp` 相同、工作树干净。

### 6.5 代码终态的读数

真库套件、单测与 core-backend `type-check` 在代码终态 `0f8afc01df` 上重跑;前端三个 spec 与 token 清单取自 `cf1419e3ed`(`0f8afc01df` 只改了一个后端文件的注释,不碰前端与清单)。

- 真库套件(workflow 原命令 `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-form-drafts.db.test.ts --reporter=verbose`,`EXPECT_DB=1`):**34 / 34**,`[FIX 6] max row count observed across 25 rounds x 4-way concurrency: 20 (cap N=20)`。
- 单测:`approval-rbac-boundary`、签名一致性、bootstrap 钉 3 个文件 **63 / 63**。
- 前端三个 spec **81 / 81**(修复轮不改前端)。
- core-backend `type-check`(`tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json`)退出 0(`cf1419e3ed` 与 `0f8afc01df` 各跑一次)。
- `node scripts/ops/required-web-lane-token-manifest.mjs --check`:退出 0,546 个 token,`MANIFEST MATCHES`。
- 远端 main 仍是 `ef9eb2d86c`(2026-10-01 只读核对);它的迁移目录按 `LC_ALL=C` 排序的最后一支仍是 `zzzz20260927121000_add_multitable_install_ledger_intent_kind.ts`,本片迁移仍排在它之后。

### 6.6 修复轮的未跑项与残留

- 必需检查的 13 个 context 没有在修复轮重放,§3.5 是 `0b03117a19` 的读数。修复轮只改了 core-backend 的一个服务文件、一个路由文件、一个迁移文件的注释,以及两个测试文件。与之直接相关的必需步骤是 `test (20.x)` 的「Run type checking」与「Run core-backend tests」:前者本轮跑了 core-backend 部分,后者只跑了受影响的 3 个文件。全量以 Draft PR 上的 CI 为准:CI 是 Linux,`test (20.x)` 用 PostgreSQL 14。
- 新的拒绝映射只有真库套件在测,按 Q9 ⑤ 它只在非必需车道。必需车道里与本片相关的是 §6.1 的 RBAC 负例和签名一致性单测。
- SQLSTATE 只在 PostgreSQL 16.15 上实测过;真库 workflow 用的是 `postgres:16`。
- 极深嵌套的 `data`(数千层以上)在服务层序列化时抛 `RangeError`,这条没有 SQLSTATE,不经映射,落成不带值的 500(不写入任何东西),而不是 400。修法是在序列化之前加嵌套深度上限并按 400 拒绝;不在本片。
- `ApprovalFormDraftConflictError` 的注释仍写清除「不取顾问锁」,与现在的代码不符(清除已取同一把用户级锁,§3.3 的 M6 证明它承重);注释继承自 #5703,本片未改。
- 门审 r2(头 `5f2b37e821`)判定 0 P1 / 0 P2 / 2 P3 / 4 NIT。本提交只改本文件:改正上面三处条目标注,补本节最后两条残留。
