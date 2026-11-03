# 开发计划 vs 已交付缺口审计（2026-09-16）

本文档把「开发计划 vs 已交付」缺口审计矩阵（112 条）整理成正式文档，供产品负责人看剩余工作、合并队列与待裁决清单。全文 values-free，不作推荐，只记录已核实的事实与出处。

## 0. 基线与方法

- **审计取证基线**：`origin/main` `a7128c2f1`（只读 worktree 核验，未改动）。
- **四个来源**：《集成层收敛方案》（`docs/integration-consolidation-plan-20260901.md`，文件头已自降级为「背景调研报告，实施以 minimal-plan 为准」）、《集成层最小可执行收敛方案》（`docs/integration-consolidation-minimal-plan-20260901.md`，实施基准）、24h 自主开发程序总报告 `#5601`（计划报告）、自主开发账本（program/ledger 系列文档）——四份文本来源之外，另加 GitHub 60+ 支在飞 PR 的逐个 `gh pr view` 盘点。
- 由 17 个代理并行取证生成 112 条矩阵项（`matrix`），另有一轮独立批评者复核（`critic`：missing 9 条、mismarked 5 条、top_ready 8 条建议）。
- PR 状态核实时间为 **2026-09-14/15**（`gh` 实查；逐条按 commit subject 尾部 `(#NNNN)` 匹配，避免 `git log --grep` 命中正文里提到该号的其他提交）。
- **口径漂移提示**：本文撰写时（本 worktree 已核 HEAD = `origin/main` `38caaf17b`），main 已在矩阵取证基线之后前进——第六个 24h 窗口合入 18 支多维表×审批线 PR（含 `0be3f25da` 等）与文档收口提交 `38caaf17b`（`#5771`）。**本矩阵下方第 1/2 节的 done/partial 判定停留在 `a7128c2f1` 快照，未随 main 的后续前进重新验证**；这批新合并的 PR 与本审计覆盖的连接层/权限/凭据/admin-security/触发器/备料范围无重叠（是多维表送审、钉钉待办、lint 清零等独立线），但读者若要拿本文档核对当前 main 的真实状态，仍应重跑对应的 `gh pr view` / `git log --grep` 核验，本文档不代做这一步。

---

## 1. 已交付（done，共 12 条，原矩阵记 13 条，DOC-09 经纠错移出）

| id | 事项 | 证据（PR + file:line） |
|---|---|---|
| CR-01 | PR-1：External System 引用统一 data_sources（connection_id + 双读 Resolver + 首批回填） | `#5452`(`4da258c78`)；`packages/core-backend/src/db/migrations/zzzz20260902120000_add_integration_connection_binding.ts:34-129`；`plugins/plugin-integration-core/lib/connection-resolver.cjs:77-88,166-267,375` |
| CR-05 | Connection 引用查询（connection_id + legacy 双形态）与删除 409 | `#5401`(`b7120cd92`)＋`#5452`(`4da258c78`) 扩展；`DataSourceManager.ts:652-680`；`routes/data-sources.ts:832-855` |
| CR-06 | 数据面健壮性三支：错误码规范化 / 源库不可达 503 / 大库结构按需读取 | `#5433`／`#5586`(`e89f3e15e`)／`#5605`(`f3c6dd09d`) |
| CR-10 | `integration_external_systems` 保留并转为稳定 Integration Binding（决策项非工作项） | `zzzz20260902120000...ts` 只 `ADD COLUMN`；`migrations/057_create_integration_core_tables.sql` 未改 |
| PERM-09 | P1 作用域洞与租户声明门系列（四支） | `#5471`／`#5534`／`#5538`／`#5651` |
| PERM-10 | 应用列表/详情按 manifest 权限码双侧过滤（G-7④） | `#5626`(`c45aae54b`) |
| BR-04 | Bridge 只读硬锁约束项（部分，见下方「空真」拆分） | `bridge-agent-readonly-adapter.cjs:43,49,133,148,482`；`scripts/ops/bridge-agent-readonly.ps1:241-282,409-449`；`index.cjs:363` |
| BR-08 | 编辑 Bridge 连接保留完整 config，不再静默丢 schema/pointer | `#5406` |
| BR-10 | 红线：K3 写围栏三套只读闸门（C6 gate / WRITE_SHAPED_KEYS / adapter 拒绝）不得合并成一个开关 | `#5402`；`write-target-config.cjs`；`k3-wise-c6-write-profile.cjs`；`k3-wise-webapi-adapter.cjs` |
| DOC-06 | 集成收敛计划文档与规格澄清、PR 模板保证型硬门 | `#5441`／`#5449`／`#5554` |
| DOC-07 | G4 结构化强制设计文档（实例身份/加载硬依赖/敏感通信边界） | `#5553` |
| OTH-08 | sealed-export 测试链与 pin 解耦（收窄，见纠错） | `#5420`(`9b5091426`) |

### 按批评者纠错

- **DOC-09**（原记 done）改判 **partial**：其「两处 legacy 例外交叉引用与坏引用清理」内容只存在于 open PR `#5620` 分支，main 上两份收敛文档最后一次改动是 `4da258c78`(#5452) 与 `24942c70f`(#5449)，无 `#5620` 分支内容；矩阵自身 `scope_note` 已写「在 open PR #5620 内，未合 main」且 `uncertain=true`，与 `status=done` 自相矛盾。已移入第 2 节合并队列（随 `#5620`/PERM-02 一并合并）。
- **CR-05**（引用查询与删除 409）维持 **done**，但登记计划外偏离：`routes/data-sources.ts:832-842` 的 `force=true` 逃生门允许平台管理员绕过 409 强删；删除默认走 soft delete（`DataSourceManager.ts:834-848` 是 `UPDATE deleted_at`），迁移里的 FK `ON DELETE RESTRICT`（`zzzz20260902120000:108-125`）对 `UPDATE` 不触发，因此 409 校验是唯一防线，`force=true` 一绕即空。minimal-plan §5 PR-2 验收原文（`min:225`）是「连接均无法删除」，文本里没有这个逃生门。该偏离已加入第 4 节「本文档新增」一行。
- **OTH-08**（原断言「终结 O(n²) 插件 PR 冲突」）收窄为 **「仅 sealed-export 一侧解耦」**：`#5420` 已合并，但 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json:70` 仍钉着 `pluginPackageJson` 整文件 sha256，加测试的插件 PR 仍会撞 pin（矩阵 CR-08 自己的 `remaining_work` 也这么写）。`http-routes.cjs` 一侧的 pin 冲突未解，见第 2 节 BR-06（#5590 六次撞 pin）。
- **BR-04**（打包 11 条约束记 done）中，批评者判定「至少三条为空真」，本文档核实到其中两条的具体内容——它们在 main 上「成立」只是因为 PR-3（BR-01/BR-02，第 5 节）压根没开始，不代表已有实际防护：
  - `m`：core `/api/data-sources/:id/test|schema|select|query` 对 Bridge registration 结构化拒绝、raw `/query` 永久 403 ——`routes/data-sources.ts` 全文 grep `bridge` 零命中，这条约束根本没有对应代码。
  - `p`：中央只保存 Agent 注册信息和 Bridge 鉴权引用——全仓 `transport_kind` 零命中，同理无代码对应。
  两条已挂回 BR-01/BR-02（第 5 节），作为 PR-3 落地时的待验收断言。批评者原文计数为「至少三条」但只逐字点名了这两条，**第三条本文档未能从批评者原文定位到具体字母/内容，如实标注计数与点名条目数不一致，留待核实**。真正已落地、仍计入 done 的硬锁：localhost 强制、对象/字段白名单、不支持 upsert、参数化等值过滤、limit 回显校验、客户凭据只在 Agent 本机、协议仅 plugin 一份实现、core 不导入 plugin。
- **CR-06**（保持 done，附加提示）：标题「连接收敛到 data_sources」与内容不符——三支合并 PR（`#5433`/`#5586`/`#5605`）实际是数据面错误码规范化/503/大库按需读取的健壮性修复，与「连接收敛」这件事本身无关；真正的收敛工作在 CR-01（done）与 CR-02（partial，被 CRED-10 卡住，见第 6 节）。

---

## 2. 代码完成，只等合并（partial=open PR，共 34 条）

以下条目代码已完成、CI 已核，剩余动作是合并（或合并前置的只读盘点）。**多条 PR 存在叠加关系**（子分支基于父分支的 diff）：`#5699`→`#5681`→`#5648`、`#5691`→`#5679`、`#5680`→`#5665`、`#5653`→`#5614`、`#5652`→`#5628`、`#5649`→`#5619`、`#5593`/`#5594`→`#5587`、`#5710` 内容叠加在 `#5677` 之上。本仓合并策略是 **squash merge**，父 PR 合并后，子分支不能直接 `git merge`/`git rebase origin/main`——子分支历史里仍带着父 PR 已被 squash 掉的原始提交，会在 diff 里产生重复变更或误判冲突；必须 `git rebase --onto origin/main <merge-base>` 再 `git push --force-with-lease`（参见用户记忆「metasheet2 squash-merge gotcha」）。

| PR | 事项 | 依赖（叠加关系） | 合并前置（真库盘点项） |
|---|---|---|---|
| `#5587`（CR-03） | 外接数据源页并入数据工厂「连接管理」分区，`/data-sources` 改重定向 | — | — |
| `#5593`（CR-04） | 数据源列表「被引用 N」计数列 + 删除前提示 | 叠 `#5587` | — |
| `#5594`（SP-02） | 备料向导拆 ①a 登记外接数据源 / ①b SQL 绑定，`/stock-prep` 门改走工作台谓词 | 叠 `#5587` | — |
| `#5620`＋`#5650`（PERM-02） | G02 数据源共享设计 + 第一刀 use/rotate/share 三码种子化，凭据轮换门从 write 改 rotate 独占 | 依赖 `#5611` 合并（等式测试曾冲突） | — |
| `#5620`（DOC-09） | 两处 legacy 例外交叉引用与坏引用清理（顺带解掉） | 与 PERM-02 同一 PR `#5620` | — |
| `#5611`（PERM-01） | G09 六个 integration/data_sources 权限码种子化 + 反漂移对账 + 交付指南角色模板 | — | — |
| `#5623`（PERM-08） | G44 数据工厂对外契约第一刀：24 条只读 GET 进 OpenAPI + `integration:read` scope | — | — |
| `#5590`（BR-06） | G4 结构化强制第一刀 M2：适配器装载去掉公共投影回退，硬依赖 `getExternalSystemForAdapter` | — | 已撞 `http-routes.cjs` pin 六次（09-14/15 账本记），建议优先合并，见第 8 节 |
| `#5597`（BR-07） | G10 K3 写回文案改口 + 三个 DISABLED 码进人话码表 + K3 目标不渲染 Save-only | — | — |
| `#5638`（GOV-03） | 托管表（插件登记表）schema 写入在能力层 fail-closed 拦非 admin | — | — |
| `#5619`＋`#5649`（TRG-03） | `send_webhook` 与订阅投递出口接 SSRF 守卫、拒跟随重定向 | 叠 `#5649`→`#5619` | TRG-04 只读盘点（存量 `http://` 目标，第 3 节已派） |
| `#5665`（ADM-01） | admin 安全开关与 bulk 写/删等 12 端点补 `requireAdminRole` | — | ADM-13 声明式 admin 账号回填（否则补门端点上 403，第 3 节回填段排队） |
| `#5677`（ADM-02） | `/api/admin/safety/rules` 四写端点补门，创建者/限流身份改 `req.user` | — | ADM-13 |
| `#5680`＋`#5690`（ADM-03） | admin-routes 写路由首位必须 admin 门的结构性守卫 + 7 个子 router 行为断言与清单双向反查 | 叠 `#5680`→`#5665` | — |
| `#5710`（ADM-04） | `#5678` 批次 1：GET /dlq 与 protection-rules 两条 GET 加平台管理员门 | 叠 `#5677` | — |
| `#5716`（ADM-16） | 平台管理员门三种「拿不到角色」情形 fail-closed 钉桩测试 | — | — |
| `#5717`（ADM-17） | `DeadLetterQueueService.list()` 对 `limit:0` 只计数不拉行 | — | — |
| `#5682`（ADM-19） | comments mark-all-read 只以认证主体为准，不接受请求体 userId | — | — |
| `#5687`（ADM-21） | `KANBAN_AUTH_REQUIRED`/x-user-id 过时鉴权文档清理 | — | — |
| `#5711`＋`#5718`（ADM-24） | 生产环境默认加密密钥/盐 fail-closed + preflight/env-check/bootstrap-admin 脚本断言 | 叠 `#5718`→`#5711` | — |
| `#5648`（CRED-01） | connection 下口令类键写入即拒、读取剥离，秘密键判据收敛一处 | — | CRED-06 只读盘点（第 3 节已派） |
| `#5679`（CRED-02） | PLMAdapter Bearer 改存实例字段，不再写回 config.connection.headers 明文落库 | 叠 `#5648` | — |
| `#5681`＋`#5699`（CRED-04） | 秘密键词表补 pw/pswd/passcode + NFKC + 粘连限定词规则；真库道盘点 SQL 与词表同步 | 叠 `#5699`→`#5681`→`#5648` | — |
| `#5689`＋`#5691`（CRED-07） | connection URL userinfo 分阶段迁移设计 + 阶段①a fetch 腿错误文本打码 | 叠 `#5691`→`#5679` | — |
| `#5588`（SP-01） | 备料错误码目录补 SOURCE_UNAVAILABLE（503）+ 交付指南一行 | — | — |
| `#5576`（SP-03） | SQL 源接入验收脚本收尾 + 交付指南「升级后必查」 | — | — |
| `#5592`（DOC-01） | 数据工厂页面布局与能力差距分析报告（W2-W5 派工依据） | — | — |
| `#5613`（DOC-03） | 集成帮助中心术语表 + SQL 只读源→多维表 / K3 预设两条案例 | — | — |
| `#5618`（DOC-04） | 备料交付说明绝对句订正 | — | — |
| `#5596`（OTH-01） | G27 清洗映射转换/校验 UI 对齐引擎全集 | — | — |
| `#5612`（OTH-02） | G34 运行监控到达率：跨管道/状态筛选/翻页/死信/轮询 | — | — |
| `#5614`＋`#5653`（OTH-03） | G52 SQL Server 标识符 Unicode 放宽 + 错误码人话；join.on 结构化白名单硬化 | 叠 `#5653`→`#5614` | — |
| `#5628`＋`#5652`（OTH-04） | X02 transform 字段不存在≠值为空；bare concat 全缺返回 undefined 走「不写」（唯一一条静默数据损坏修复） | 叠 `#5652`→`#5628` | — |
| `#4591`（CR-09） | B2 OFFSET-ordering fail-fast guard + typed 422 + MSSQL fallback deletion | — | **状态特殊**：`isDraft=true`、`mergeable=CONFLICTING`、7 周未动，本轮结论=分支已判废应重切，**不建议按现状合并**；设计仍有效（sql-readonly 默认路径仍无序翻页），缺陷仍活着 |

以下 6 条虽登记为 partial，但并非「代码已完成、只等合并」，实质更接近第 4/5/6 节，此处只作交叉引用，不计入上表：

- **CR-02**（动作一端态收口）——依赖 CRED-10（§6.3 明确延期），当前无法推进，见第 6 节。
- **CR-07**（场景预设目录是否算 §4/§7 P3 交付）——`needs_ruling=true`，见第 4 节。
- **PERM-06**（`POST /:id/query` 边界）——依赖 PERM-03（第 4 节）与 BR-02（第 5 节）。
- **BR-03**（PR-3 收尾回归测试 + 客户可见演示）——依赖 BR-01/BR-02（第 5 节，均 not_started）。
- **GOV-05**（托管表「导入插全新行」野行命运实现）——`needs_ruling=true`，见第 4 节；其唯一关联的 `#5647` 是零代码设计文档，不是实现 PR。
- **OTH-10**（每阶段可回滚，旧凭据/字段/迁移只在审计窗口后清理）——约束项非独立工作项，随 PERM-03/BR-01 出货时各自补 `down()`。

---

## 3. 可立即派（ready=true，共 12 条）

以下状态为本文档撰写时（`origin/main` `38caaf17b`）直接读取 `C:/Users/zhou/Downloads/dev/metasheet-wt-w5{i,k,l,m,n}` 五个工作树的 `git status` / `git log origin/main..HEAD` 结果；**只记录任务归属与截至读取时刻的进行状态，不代表已完成**，产出以各自任务的完成报告与最终 PR 为准。

| id | 事项 | 难度→模型 | 状态 |
|---|---|---|---|
| PERM-04 | `removeDataSource` 先删内存再写库、DB 失败只 `console.warn` 的顺序 bug | hard→opus | 已派 **W5-K**（分支 `fix/data-source-remove-ordering`）：工作树有未提交改动，`DataSourceManager.ts` +74/-9 行，进行中，未提交、未合并 |
| PERM-05 | 可回退 legacy Binding 改 `config.dataSourceId` 时未强制同写 `connectionId` 转 canonical | hard→opus | 已派 **W5-L**（分支 `fix/legacy-binding-datasource-change-requires-canonical`）：工作树建立后无改动，尚未开始或刚起步 |
| CR-08 | PR-1 验收复跑：新旧读取路径的 schema、对象列表与只读查询结果一致 | easy→sonnet | 已派 **W5-M**（分支 `test/pr1-canonical-legacy-read-equivalence`）：工作树无未提交改动/无领先提交，尚无可核验产出 |
| TRG-04 | `#5619`/`#5649` 合并前置：存量 `http://` 自动化规则/订阅目标只读盘点 | easy→sonnet | 已派 **W5-I**（与 CRED-06、ADM-08 打包为一次 222 只读会话，分支 `ops/readonly-inventory-pack-20260916`）：工作树建立后无改动，尚未开始或刚起步 |
| ADM-08 | 真库核验 `*:*` 经 `namespace-admission.ts:126` 过滤后是否仍残留在 `req.user.permissions` | easy→sonnet | 已派 **W5-I**（同上打包） |
| CRED-06 | `#5648`/`#5681` 合并前置：`data_sources.config.connection` 秘密键真库只读盘点 | easy→sonnet | 已派 **W5-I**（同上打包） |
| CRED-13 | `multitable-onprem-preflight.sh` 同类加密密钥空/默认值洞 | easy→sonnet | 已派 **W5-N**（分支 `ops/multitable-preflight-encryption-material`）：工作树有未提交改动，脚本 +50 行，进行中 |
| GOV-08 | 新增操作/插件消费者/部署或授权边界变更须分别提交代码/ADR——落地为合并硬门 | easy→sonnet | 回填段：**排队**，无独立工作树，未派 |
| SC-04 | 按 `runId` 单查 run 的读端点（`GET /api/integration/runs/:runId`） | medium→opus | **排队**：碰 `http-routes.cjs` pin（BR-06 六次冲撞史），在飞插件 PR 仍多，等数量降下来再派；无工作树，未派 |
| ADM-13 | `#5665`/`#5677` 合并前置：声明式 admin 账号回填（仅只读盘点段） | hard→opus | 回填段：**排队**——账本刻意排除：回填涉写库属 O 层需 owner 批，只应派「只读盘点 users.role=admin 但 user_roles 无 admin 行」这半段，本轮未派 |
| DOC-02 | 24h 自主开发程序总报告 §9 收口（`#5601`） | easy→sonnet | **排队**：需先用本矩阵的裁决清单回填 §9，本轮未派 |
| DOC-08 | 正式开发计划从未被拉活执行——用本矩阵替代逐项排期 | easy→sonnet | **本文档即其产出**：本文档（W5-J）本身就是「拉活动作」，后续按 ready=true 条目继续派工 |

---

## 4. 待裁决（26 条，原矩阵 `blocked_ruling`）

「它卡住了什么」一列基于矩阵各条目 `dependencies` 字段的精确匹配（而非全文关键词命中，避免把交叉引用误判为阻塞关系）；未标注下游条目的，表示当前没有其他矩阵项在结构上等它裁决。

| id | 问题 | 它卡住了什么 |
|---|---|---|
| PERM-03 | 共享档按 `#5620` 设计的 `tenant_shared`（租户级）落地，还是按 minimal-plan §5 PR-2 的 workspace 共享落地？ | PERM-06（POST /:id/query 分权档）、BR-01（PR-3 主体，minimal-plan §1 三 PR 顺序依赖）；另有 OTH-10（回滚窗口约束）间接提及 |
| BR-09 †† | `#4786`（K3 API Profile 演进 draft）是 (A) 关闭不留文档，还是 (B) 重写 §7 后合并——其 §7.1/§7.3 以「Save-only + flag 恢复 OFF」为验收基石，已被 K3 写围栏永久禁令（`#5247`/`#5402`）与目标文档自身 §0 推翻 | 无显式下游依赖条目；是独立文档决策（#4786 draft 去留），账本已记「保留 draft，等 owner」 |
| GOV-06 | `meta_comment_reads` 历史冒名已读行是清理（需前向 migration/脚本）还是保留不动？ | 无显式下游依赖条目 |
| GOV-07 | 商业多客户 sealed 交付走每客户独立部署，还是共享实例多租户（需另立 schema/profile 与授权设计）？ | 无显式下游依赖条目 |
| TRG-02 | 入站 webhook 是把 automation webhook 端点纳入全局门豁免表（只靠 HMAC），还是新建带独立授权边界的受控触发入口（需 ADR）？ | 无显式下游依赖条目；第三选项「保持会话+api-token」等价于不做匿名入站 |
| ADM-05 | `#5678` 剩余读侧无门 GET 是全部补平台管理员门，还是只保留批次 1（dlq/protection-rules）不再扩？ | 无显式下游依赖条目；需 222 真库看驱动 error 原文 |
| ADM-06 | 是否把 `data_sources` 从 admin bulk 的 `validTables` 摘掉、只允许经 `/api/data-sources` 专用门操作？ | 无显式下游依赖条目（CRED-01 的 `scope_note` 提及此裁决背景，为信息性交叉引用，非结构依赖） |
| ADM-07 | `ensurePlatformAdmin` 认 `permissions` 含 `*:*` 这条是否收紧到与 `requireAdminRole` 同源（仅 `user_roles` admin）？ | 无显式下游依赖条目；其自身依赖 ADM-08 真库核验结果（第 3 节已派 W5-I），账本建议与 ADM-05/09-12 同批次裁决（非结构依赖，是分组建议） |
| ADM-09 | `/api/admin/safety/rules` 的 `/evaluate` 端点 admin-only 是否符合产品预期？ | 无显式下游依赖条目 |
| ADM-10 | 限流器移到 admin 门后（未授权请求不占限流桶），还是保持门前？ | 无显式下游依赖条目 |
| ADM-11 | dev-token 端点只在本机开发可达（额外显式开关），还是维持 `NODE_ENV!==production` 即开？ | 无显式下游依赖条目 |
| ADM-12 | `#5665` 另 8 条端点（cache/clear、metrics/reset、dlq×4、ratelimits×2）是保留（仅管理员门）还是直接摘掉？ | 无显式下游依赖条目 |
| ADM-14 | `view_states.user_id` 是改列类型为 text（前向 migration），还是改代码拒绝非整数 id 不再 `parseInt`？ | 无显式下游依赖条目 |
| ADM-15 | 脚本默认 `VIEW_ID` 是改为先创建/查找真实 UUID，还是保持非 UUID 时如实 404 退出？ | 无显式下游依赖条目；脚本主体已完成，剩余=合并 `#5694` + 该一处裁决 |
| ADM-20 | `#5682` 中任意评论者可 resolve 是出货语义还是缺口——收紧到评论作者/资源 owner？ | 无显式下游依赖条目 |
| ADM-23 | 孤儿 openapi 文档 `packages/core-backend/openapi/admin-api.yaml` 是删除还是补回引用？ | 无显式下游依赖条目；全仓引用仅 6 处散文，零代码/CI/`$ref` |
| CRED-03 | 存量落库 PLM 令牌与审计副本是只吊销令牌不动数据，还是做清洗迁移抹掉明文？ | 无显式下游依赖条目；需 `#5679` 合并 + 222 真库 |
| CRED-05 | 秘密键词表白名单收窄到当前实测集合并由应用侧单一源生成盘点 SQL，还是允许更宽写法并由运维手工同步？ | 无显式下游依赖条目 |
| CRED-08 | F01 阶段②走「受限自动拆分+拒收兜底」，还是「纯 400 + 前端补 Basic 字段同批」？ | 无显式下游依赖条目；需 `#5648`/`#5681`/`#5691` 合并 |
| CRED-09 | `credentials.bearerToken`/`credentials.token` 死字段是单开 PR 从代码与文档同时删除，还是仅文档删引用？ | 无显式下游依赖条目 |
| SP-05 | 场景 A（K3 只读拉取）超 ~100 行吞吐需求是否放宽读预设与 adapter 上限？ | 无显式下游依赖条目；依赖 SC-01 |
| SP-08 | 场景 B 字段映射是等客户提供 PLM ExAttr 字典后再做，还是先用合成列名做可验收增量？ | 无显式下游依赖条目；依赖 SC-01 + 客户数据 |
| SC-01 | 首个可验收增量选场景 C（Bridge 只读→多维表）还是场景 B（PLM BOM 拉取）？ | SP-04、SP-05、SP-06、SP-07、SP-08、SC-02、SC-03（7 条，均在 `dependencies` 字段显式列出 `SC-01`） |
| SC-03 | Bridge 不能分页，超单页数据量是否投入改 Agent 协议支持分页，还是接受单页上限？ | 无显式下游依赖条目；自身依赖 SC-01 |
| SC-05 | 是否在选 C 的增量之外单开 PR 让 pipeline 校验外接系统 kind（会影响所有既存 pipeline）？ | 无显式下游依赖条目 |
| DOC-05 | 路线图草稿是按 `review.md` 意见修订能力基线后再议，还是直接搁置不修？ | 无显式下游依赖条目 |

`††` BR-09 在矩阵原始数据里 `needs_ruling=false` 且没有 `ruling_question` 字段，与其 `status=blocked_ruling` 自相矛盾；矩阵自己的 `evidence` 文本也承认「已经在等 owner 裁决，所以 needs_ruling 应从 false 翻成 true」。上表 BR-09 一行的二选一问题取自该条目的 `remaining_work` 字段（"裁决题（贴给 owner）"段落的 (A)/(B) 两选项），而非 `ruling_question` 字段——本文档在此处如实标注取材来源，其余 25 条均直接取自各自的 `ruling_question` 字段原文。

### 4.1 本文档新增一条（第 1 节批评者纠错带出，未计入原 26 条）

| id | 问题 | 它卡住了什么 |
|---|---|---|
| CR-05-force | `routes/data-sources.ts:832-842` 的 `force=true` 逃生门（配合 soft delete 令 FK RESTRICT 不触发）是计划外偏离：是给 `force=true` 追加平台管理员限定+审计，还是维持现状（记录为已知偏离，不追加限制）？ | 无显式下游依赖条目；不阻塞其他工作项，但影响「连接均无法删除」这条安全不变量对外的可信度 |

---

## 5. 未开始但被依赖卡住（11 条，`not_started` 且 `ready=false`）

| id | 事项 | 卡在哪 |
|---|---|---|
| PERM-07 | `#5650` 合并前置：`role_permissions`/`user_permissions`/`users.permissions` 三面 0 行真库盘点 + 授 `data_sources:rotate` | `#5650` 合并（rotate 码由其定义）+ 需 222 真库盘点 |
| BR-01 | PR-3 主体：`data_sources.transport_kind` + core 不可执行 registration descriptor + plugin Resolver 分派 `bridge:legacy-sql-readonly` | PR-2（PERM-03/04/05）——minimal-plan §1:16 三个 PR 顺序依赖；PERM-03 未裁（第 4 节） |
| BR-02 | PR-3 core 面：`/api/data-sources/:id/*` 对 Bridge 的结构化错误、raw `/query` 永久 403、UI 显示 transport | BR-01（PR-3 主体未开始） |
| GOV-02 | 死代码清理：040/044 僵尸表 + `DataMaterializationService.ts`；057 `integration_schedules` 接活或删 | 自身有裁决问题（只删源码 还是同时前向迁移连遗留表一起删，见其 `ruling_question`）+ `integration_schedules` 去留随 TRG-01 裁决（TRG-01 归第 6 节明确延期） |
| GOV-04 | 第三个解析器 `approval-record-link-txn-auth.ts:679` 缺托管表判断 | `#5638` 合并（复用 `isPluginManagedSheet`） |
| ADM-18 | admin 限流键无界增长（userId+method+path 组合，从不清扫） | `#5710` 合并 |
| SP-04 | 场景 A（K3 只读拉取）假 K3 WebAPI 夹具 | SC-01 场景裁决 |
| SP-06 | 场景 A 审计需在 `stock-preparation-audit-store.cjs` 闭集新增 action 词条 | SC-01 |
| SP-07 | 场景 B（PLM BOM 拉取）假 PLM 夹具或假 BOM 表种子脚本 | SC-01 |
| SC-02 | 场景 C 本机 SQL Server + Bridge Agent 开发环境编排脚本/文档（工作量大头） | SC-01 选 C |
| OTH-09 | 合并顺序依赖重基重跑：`#5680` 叠 `#5665`、`#5681` 叠 `#5648`、`#5691`(W4-L) 叠 `#5679` | 父 PR `#5665`/`#5648`/`#5679` 先合并（合并后需按第 2 节「squash 后 rebase --onto」处理，不能直接 `git merge`） |

---

## 6. 明确延期（11 条，来源 §6.3 或账本自弃）

- **BR-05**：远程 Bridge Agent fleet 管理——minimal-plan §6.3:322。
- **GOV-01**：062/063/064/065 治理表收敛为通用 versioned-config store（`config_type` 判别列）——minimal-plan §6.3:323；§7:330-332 只允许抽共享版本/审批/审计代码，不物理合并。
- **TRG-01**：定时触发接活（cron→pipeline `triggeredBy:'cron'`）——minimal-plan §6.1:282-298「等客户提出自动同步需求再做」；注：本条 `needs_ruling=true`（现在接活 vs 继续等），矩阵仍归为 deferred，若接活须复用 Automation scheduler、不接活第二套 `integration_schedules` runtime。
- **TRG-05**：AutomationExecutor 与 PipelineRunner 保持两个执行引擎不合并——minimal-plan §6.3:324，§9 决策摘要第 3 条。
- **ADM-22**：G44 creator 停用后仍可读断言——已作废非缺口（安全终审 2026-09-11 13:45 裁定该前提不成立）。
- **CRED-10**：HTTP 类 kind（http/erp:k3-wise-webapi/plm:yuantus-wrapper）凭据迁移到 `data_sources` http type，加密统一到 core encrypted-secrets——minimal-plan §6.3:325，§7:334-336 不强行共用两个 HTTP adapter。
- **CRED-11**：§6.2 基础能力包（整份 credential document 加密、connector auth schema、OAuth、Connector Catalog、强类型 action/trigger、事件去重/重放/限流/观测）——触发条件是客户提出真实 HTTP/K3/PLM/飞书连接需求。
- **CRED-12**：飞书首批按真实场景实现少量动作，不做任意 URL/raw HTTP/SQL 万能节点——minimal-plan §6.2:313。
- **OTH-05**：`run-required-web-tests.sh` 拆行治理——等在飞 web PR 合并到 ≤2 支（当前远超 2）。
- **OTH-06**：刻意不做清单（G54/G56/G01/G08/G20/G24/G31/G36/G38/G47/G42 全量双语等，撞 `http-routes.cjs` pin 或 `IntegrationWorkbenchView` 大面）——账本三次列「仍不做」，从未重新排入。
- **OTH-07**：明确延期：n8n 式可视化画布、连接器市场/第三方 SDK、BPMN 与 Integration 整合——minimal-plan §6.3:319-321。

---

## 7. 批评者补漏

批评者在 `critic.missing` 中实际给出 **9 项**遗漏（非任务书口径的 7 项，如实更正计数，不隐藏也不凑数）。逐条落成条目并给 status：

| # | 遗漏内容 | status |
|---|---|---|
| 1 | plan §4 判决表四块「保留」判决（读取源/组合 `plan:82`、写目标 `plan:83`、pipeline `plan:84`、Bridge Agent 观测 `plan:85`）矩阵全无条目 | **补登记为 done/约束项**（比照 CR-10 形状：四行均为纯判决非工作项，仓内现状本就是「保留不动」，无需新增工作，只需在账本上留痕，避免「数据工厂七块板块」只剩三块在账） |
| 2 | plan §4 动作一「端态」只登记一半：`plan:90-91` 要求 external system 同时是「引用选择器 + **业务场景标签**」，CR-02 只覆盖前半 | **未开始且未登记**：`integration_external_systems` 无任何场景标签列（057 建表、`zzzz20260902120000` 均未加）。性质上归入第 5 节，且被 CR-02 本身卡住的 CRED-10（deferred）间接拖住 |
| 3 | plan §4 动作一第三个 bullet（`plan:99-100`「Bridge Agent 注册进 `DEFAULT_ADAPTER_REGISTRY`」）与 minimal-plan §3.5(`min:88-97`)/§5 PR-3(`min:229-243`) 明确反对的路线冲突，矩阵未登记为可追溯裁决 | **裁决：以 minimal-plan 为准**——两份计划冲突时，minimal-plan 是「实施以此为基准」的现行文本（plan 文件头已自降级为背景调研），BR-01/BR-02 的设计已按 minimal-plan 写（core 不注册、不执行 Bridge 协议，由 plugin Resolver 按 `type+transport` 分派）。本条作为可追溯裁决单列，避免将来有人照 plan §4 去接 `DEFAULT_ADAPTER_REGISTRY` |
| 4 | plan §4 动作三.1 UI 面（`plan:115`「UI 在 pipeline 区加"定时运行"」）无条目 | **随 TRG-01 一并 deferred**：TRG-01 只覆盖调度器写入方与 `IntegrationRunPort` 路线，若 TRG-01 裁定接活，这条用户可见入口需要一并补上，目前无独立占位条目 |
| 5 | plan §4 动作三.2 webhook 三件套（`plan:116`「参照飞书 Webhook 连接配置形态：自动生成 token、IP 白名单、HMAC 签名」）无条目 | **随 TRG-02 一并 blocked_ruling**：TRG-02 只记「受控入口」抽象层面，三项具体能力从未进账；HMAC 与现有多维表 automation webhook 签名实现是否复用也未登记 |
| 6 | minimal-plan §5 收尾指令（`min:278`「完成 PR-3 后停止本轮平台工作，进入**客户只读窗口授权、历史迁移和双轨对账**」）三件后续零条目 | **未登记，随 BR-01/BR-02 落地时补占位**：PR-3 尚未开始（第 5 节），这三件事目前连 not_started 占位条目都没有 |
| 7 | minimal-plan §6.2 正文（`min:302`）两条要求：①用应用层任务把旧 `v1:` 解密重写为 `enc:`；②「**禁止 SQL 直接复制旧密文**」红线 | **红线单列，不与 CRED-11 的能力清单混同**：CRED-11 只收了 §6.2 的 a–g 能力清单（整份加密/auth schema/OAuth/Catalog/强类型 action/事件去重），把正文这两条漏掉。仓内 `credential-store.cjs` 确实「新写 `enc:`、兼容读 `v1:`」，即存量 `v1:` 密文的清退路径至今无人负责；**「禁止 SQL 直接复制旧密文」是任何后续凭据迁移工作都必须遵守的红线，不是可选项** |
| 8 | minimal-plan §7 四条「伪合并」红线只进账三条（GOV-01 对 062-065、CRED-10 对两个 HTTP adapter、GOV-02 对历史 migration），漏第三条：「不把四套字段映射压成一张表」（`min:338-340`，前端编辑 DTO / 读取投影 / ETL 映射 / 备料业务映射不是同一语义） | **补登记为约束项**：可共享 transform registry 与 canonical IR，不可抹平业务边界；这条恰恰最容易被「统一映射层」类重构误伤，目前无任何条目守着 |
| 9 | minimal-plan §6.1 末段（`min:298`）后半句「Automation 也不能通过普通 HTTP/self-webhook 绕过 Integration 的写入围栏」无条目 | **未登记，与 TRG-03 同一战场**：TRG-01 的 `scope_note` 只抄了前半句「触发器不授外部写权限」。这半句是针对 `send_webhook`/self-call 绕行的安全不变量，正好与在飞的 TRG-03（`#5619`/`#5649` send_webhook SSRF 守卫，第 2 节）同一战场，但没有任何条目要求证明「Automation→自家 HTTP 端点」这条绕行路径被挡住 |

---

## 8. 按类别计数与下一跳

**原始矩阵五态计数**（取证时刻 `a7128c2f1` 基线）：done 13、partial 41、not_started 21、blocked_ruling 26、deferred 11，合计 112。`ready=true` 是跨状态的交叉标记，共 12 条（partial 内 2 条：CR-08、DOC-02；not_started 内 10 条：PERM-04、PERM-05、GOV-08、TRG-04、ADM-08、ADM-13、CRED-06、CRED-13、SC-04、DOC-08），不额外计入 112 的总数。

**经本文档第 1 节纠错后**：done 由 13 降为 **12**（DOC-09 移出）；partial 由 41 升为 **42**（DOC-09 移入，归入第 2 节合并队列，与 PERM-02 共用 `#5620`）；blocked_ruling 原 26 条不变，另在第 4.1 节新增一条批评者纠错带出的裁决问题（CR-05-force），未回填进矩阵本体，仅在本文档层面追加；not_started 21、deferred 11 不变。

**下一跳**：先走第 2 节的合并队列，再裁决第 4 节。合并队列中建议优先处理 `#5590`（BR-06）——它因同伴 PR 反复合并已被 `http-routes.cjs` 的 pin 冲撞 6 次（账本记 09-14/15 每次均修复保持 MERGEABLE），越晚合越可能再撞一次；其余条目无此紧迫性，可按第 2 节的叠加关系顺序处理。合并队列清空、第 3 节五个已派任务（W5-I/K/L/M/N）产出可核验结果后，再统一处理第 4 节 26＋1 条待裁决——其中 SC-01（首个增量场景）与 PERM-03（tenant_shared vs workspace）是两条最堵的主干裁决，一天不裁，CR-02/BR-01/BR-02/BR-03/SP-04~08 全线（第 5、6 节多条）动不了。

---

*基线：`origin/main` `a7128c2f1`（矩阵取证）；本文档写作基线：`origin/main` `38caaf17b`。矩阵与批评者原始数据见 `gap-audit-matrix.json`。*
