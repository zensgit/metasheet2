# G02 PR-1 验证:动词拆分与轮换独占

设计见 `data-source-sharing-pr1-rotate-scope-design-20260912.md`。
本机 Windows,**无本地 PostgreSQL**;worktree `metasheet-wt-w3c`,分支
`feat/data-source-sharing-pr1-rotate-scope`,基线 `origin/main` @ `f8cdc2ca1`。
执行于 2026-09-11 18:4x–19:0x(+08)。

---

## 1. 改动文件

| 文件 | 性质 | 关键行 |
|---|---|---|
| `packages/core-backend/src/db/migrations/zzzz20260912120000_add_data_source_sharing_permissions.ts` | **新增** 181 行 | `up() :111-128`、`down() :130-181`、导出常量 `:86 / :99 / :106` |
| `packages/core-backend/src/routes/data-sources.ts` | 改 | **`:738`** 门 `write` → `rotate`;`:712-737` 注释块 |
| `packages/core-backend/tests/unit/data-source-sharing-permission-codes-seed.test.ts` | **新增** 27 项 | 见 §3 |
| `packages/core-backend/tests/unit/data-source-visibility-authority-matrix.test.ts` | 改 | `:80-88` 新增 rotate 版 actor;`:451-530` 新增 5 项;`:438-448` 既有用例改用 `OTHER_WITH_ROTATE` |
| `packages/core-backend/tests/unit/data-source-readonly.test.ts` | 改 | `:421` 用例改名;`:431-440` 新增 403 断言;`:446-454` 保留 404 断言 |
| `docs/development/data-source-sharing-pr1-rotate-scope-{design,verification}-20260912.md` | **新增** | 本文与设计 |

**pin 未动**:`.gitattributes` 里被 `sealed-export-package-provenance` 按 LF 字节钉住的 66 项
(`plugins/plugin-integration-core/lib/sealed-export/**`、6 支 SQL 迁移、7 个 external module、
`PINNED_RUNTIME_FILES`、`PINNED_EVIDENCE_FILES`)**没有一项落在本次改动里**——本次只碰
`packages/core-backend/src/{db/migrations,routes}`、`packages/core-backend/tests/unit` 与 `docs/`,
其中 `packages/core-backend/migrations/*.sql`(被钉的那 6 支)与 `src/db/migrations/*.ts`(本次新增的位置)
是**两个不同目录**。`errorCodeLabels.ts`、前端、插件均未触碰(全仓 grep `data_sources:` 在
`apps/web/src` 与 `plugins/` 下**零命中**)。

---

## 2. 命令与退出码

| # | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile --prefer-offline` | `Done in 1m 54.3s using pnpm v9.15.9` | 0 |
| 2 | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/data-source-sharing-permission-codes-seed.test.ts` | **27 passed** (1 file) | 0 |
| 3 | `… vitest run tests/unit/data-source-visibility-authority-matrix.test.ts` | **43 passed** (1 file) | 0 |
| 4 | `… vitest run tests/unit/data-source-readonly.test.ts` | **19 passed** (1 file) | 0 |
| 5 | `… vitest run tests/unit/{data-source-scope,outbound-sql-write-gate,permissions-routes,rbac-namespace-admission,data-source-schema-list-only,data-source-test-ephemeral}.test.ts` | **127 passed** (6 files) | 0 |
| 6 | `… vitest run` 上述三个受影响 spec 合跑(变异探针的基线) | **89 passed** (3 files) | 0 |
| 7 | `pnpm --filter @metasheet/core-backend run type-check` | `tsc --noEmit` 无输出 | 0 |
| 8 | `… vitest run tests/unit/migration-provider.test.ts tests/unit/db.test.ts` | `db.test.ts` 9 passed;`migration-provider.test.ts` **4 failed** | 1 |

命令 #5 选这六个是因为它们分别覆盖:属主作用域(`data-source-scope`)、
`codedGateRefusal` 与 create/update/credentials 的交汇(`outbound-sql-write-gate`)、
授予路由(`permissions-routes`)、命名空间准入过滤(`rbac-namespace-admission`)、
以及两条被 `read` 门覆盖、PR-4 将要改成 `use` 的数据面路由(`schema-list-only`、`test-ephemeral`)。

**命令 #8 的 4 红是 Windows 环境红,与本刀无关(已实证归因,不是"看着像")**:四条都抛
`Only URLs with a scheme in: file, data, and node are supported by the default ESM loader.
On Windows, absolute paths must be valid file:// URLs. Received protocol 'c:'`——是 Node ESM 动态
import 在 Windows 绝对路径上的老问题。归因证据不是猜:`migration-provider.test.ts:10-11` 用
`fs.mkdtemp(os.tmpdir())` **自建临时迁移目录**并往里写合成迁移文件(`:35-47`、`:65-76`),
**全程不读** `packages/core-backend/src/db/migrations` 这个真实目录,因此本刀新增的迁移文件
在物理上无法影响它。跑它只是为了确认这一点。CI(Linux)是裁判。

**另有一次假红需要登记**:命令 #6 第一次跑时报 `5 failed | 84 passed`,紧接着重跑两次(bash 直跑一次、
python 子进程一次)都是 `89 passed`。原因是上一轮 vitest 刚退出、`usePinnedServer` 的固定监听端口
尚未释放。变异脚本因此在每次 `vitest run` 前 `sleep(3)`,基线与全部六个变异都在这个节奏下取得。
**判定:与本次改动无关的端口竞争,不是代码问题。**

---

## 3. 新增测试的覆盖(`data-source-sharing-permission-codes-seed.test.ts`,27 项)

| 组 | 项数 | 钉住什么 |
|---|---|---|
| vocabulary `:337-428` | 7 | 三码齐全且与迁移 SQL 逐字一致;三码同 `data_sources` 前缀(= 同一个准入开关);迁移文件在 provider 能发现的目录/命名下;`DO $$` + `ON CONFLICT` 形状;`up()` 零发权;`down()` 子表先于父表且不碰别的域(**包括 `data_sources:read/write/execute` ——那三个不是本迁移能删的**) |
| the rotate gate `:430-501` | 7 | `:738` 的门是 `rotate` **独占**;`:615` 仍是 `write`;解析器认全部三种调用形态与三种引号;路由消失时**大声失败**(而不是让断言空转) |
| reconciliation `:503-566` | 5 | 路由文件里每一个被强制的 `data_sources:*` 码都可授予;PR-1 **只接线 `rotate` 一个**;`use`/`share` 当前在路由文件里**不存在**(正面断言,不是"没查") |
| idempotency `:568-632` | 5 | `up()` 跑两遍 = 三行、不抛重复键;库里已有部分码时 no-op;`permissions` 表不存在时整块跳过;`down()` 只回收自己的三码、保住运维已有的 `data_sources:write` 角色绑定 |
| admission posture `:634-662` | 3 | `data_sources` 仍受准入管控;豁免资源做反证;迁移**可执行段**不含 `NON_NAMESPACED_PERMISSION_RESOURCES` / `user_namespace_admissions` |

行为面(supertest)另在两个既有文件里:

| 用例 | 位置 | 断言 |
|---|---|---|
| 属主持 `write` 无 `rotate` → **403**,凭据未变、无审计行 | `data-source-visibility-authority-matrix.test.ts:470` | 403 + `storedPassword` 不变 + `auditCalls('update_credentials')` 长度 0 |
| **同一个人**加上 `rotate` → **200** | 同上 `:486` | 200 + 凭据已换 + 审计 `changedCredentialKeys:['password']` + **无** `crossOwnerAdmin` |
| 非属主持 `rotate` → **404**(细门没放宽) | 同上 `:499` | 404 + 统一 not-found 体 + 凭据未变 |
| 平台管理员 → **200**(短路不受影响) | 同上 `:507` | 200 + 审计 `crossOwnerAdmin:true` |
| 拆分是真的拆分:`write` 持有者仍能改连接串;只持 `rotate`+`read` 的人**不能**改 | 同上 `:518` | `PUT /:id` 200 / 403 |
| 非管理员 `write` → 403;`write+rotate` 非属主 → 404 | `data-source-readonly.test.ts:437` / `:446` | 403 / 404,凭据仍是 `alice-password` |

这五个矩阵用例刻意写成**成对**:同一个 id 只换权限列表 → 隔离粗门;同一权限列表只换 id → 隔离细门;
同一个人只换路由 → 证明拆分。任何一个 403/200/404 都能归因到唯一的一个变量。

---

## 4. 变异表(对**真实文件**做临时变异 → 跑 3 个受影响 spec → 还原并按 sha256 校验)

基线:`89 passed (3 files)`,退出码 0。脚本跑在 `%TEMP%` 的 scratchpad 里,不入库;
每个变异在 `finally` 里还原,并断言 `sha256` 与变异前一致(末行 `restore verified: routes=True migration=True`)。

| # | 变异 | 期望 | 实测 |
|---|---|---|---|
| **M-A** | `:738` 的门改回 `rbacGuard('data_sources','write')`(PR 前状态) | 红 | **5 failed / 84 passed**。红的是:`…seed.test.ts` 的「独占」正面断言 + 两条形状探针;`matrix:470` 的 FAIL-CLOSED 403;`readonly:421` 的 403/404 成对用例 |
| **M-B** | `:738` 的门改成 `rbacGuardAny(['data_sources:rotate','data_sources:write'])`(「把 403 修掉」的那种改法) | 红 | **3 failed / 24 passed**。`…seed.test.ts` 的三条结构断言全红。**注意**:另两个 spec 这一轮只收集到 27 项——因为 `rbacGuardAny` 在 `data-sources.ts` 里没有 import,路由构造期就 `ReferenceError`,两个 supertest 文件整体收集失败。这恰好说明了 §3.1 的点:**行为用例对这个变异是"全绿或全崩",只有形状断言给出精确的、可读的红** |
| **M-C** | 迁移 `VALUES` 删掉 `data_sources:rotate` 一行(只种 2/3) | 红 | **5 failed / 84 passed**,全部落在 `…seed.test.ts`:词表对账、幂等(三行变两行)、以及对账抛 `enforced but never seeded: data_sources:rotate` |
| **M-C2** | 迁移 `VALUES` 删掉 `data_sources:use` 一行(**当前无任何网关引用的码**) | 红 | **5 failed / 84 passed**。这条是专门设计的:少一个"还没接线"的码,`enforced` 方向看不见它,只有新增的 `declared but never seeded` 方向能抓 —— 证明两个方向都不是摆设 |
| **M-D** | `up()` 里追加 `INSERT INTO role_permissions … ('admin','data_sources:rotate')`(种子变成发权) | 红 | **2 failed / 87 passed**:「零自动持有」正面断言 + 「去掉 ON CONFLICT 第二遍必炸」那条探针(因为多出的语句改变了 `executed` 的条数) |
| **M-E** | `PUT /:id`(改连接串)也挪到 `rotate`(从另一侧重新融合) | 红 | **4 failed / 85 passed**:`…seed.test.ts` 的「`:615` 仍是 write」断言 + 其探针;`matrix:518` 的「拆分是真的拆分」;`matrix:438` 的既有编辑路由用例 |

另有 **9 条常驻内存探针**写在测试文件里,每次 CI 都跑(不是一次性脚本):
`:387`(迁移发权)、`:441`(门改回 write)、`:451`(门改成 any-of)、`:464`(`:615` 挪到 rotate)、
`:491`(路由消失)、`:526`(逐个删码)、`:549`/`:556`(多出未种子化的网关 / 提前接线 `use`)、
`:645`(准入姿态的反证)。它们都在内存里改一份源码副本,**从不落盘**。

---

## 5. 上机前置(必须在部署门改动之前做,**迁移里没有自动补权**)

```sql
-- 只读
SELECT 'role_permissions' AS surface, role_id AS subject, COUNT(*) AS grants
  FROM role_permissions WHERE permission_code = 'data_sources:write' GROUP BY role_id
UNION ALL
SELECT 'user_permissions', user_id::text, COUNT(*)
  FROM user_permissions WHERE permission_code = 'data_sources:write' GROUP BY user_id;
```

非 0 行 → 先**经角色**把 `data_sources:rotate` 授给这些主体(直接写 `user_permissions` 会被命名空间准入
过滤成 403 —— 2026-09-08 的备料教训),确认 `data_sources` 命名空间准入已开,让用户重登(RBAC 缓存 60s),
再上门改动。**本前置未在 222 或客户库上执行过**(本机无 PG,未上机)。

---

## 6. 未跑 / 交给 CI / 明说不做的

1. **真库迁移重放未跑**:本机无 PostgreSQL。幂等性由「捕获迁移**自己发出的真实 SQL** + 模拟
   `permissions(code)` 主键与 `ON CONFLICT` 语义」的内存重放覆盖(`…seed.test.ts:568-632`,含 M-D 那条
   去掉 `ON CONFLICT` 必炸的探针)。**真库 `db:migrate` 跑两遍 / `down()` 回滚交给 CI 的
   migration-replay 泳道**,本文不冒充已验。
2. **222 上机未做**:§5 的只读查询、角色补权、重登后 403→200 的端到端未在真机上跑。
3. **未跑全量 core-backend 单测**(内存与磁盘吃紧,按任务约束只跑受影响 spec);未跑前端与插件套件
   (本次零改动,且全仓 grep 确认它们不引用 `data_sources:*` 字面量)。
4. **`down()` 语义沿用既有 seed 迁移**(连带删除运维已授出的角色绑定),未做跨 seed 迁移的口径统一——
   那是 #5611 后续单第 2 条登记的横扫事项。
5. **403 的响应体不告诉调用方缺哪个码**(`rbacGuard` 统一回 `{ error: 'Insufficient permissions' }`),
   前端 `apps/web/src/data-sources/api.ts:96-101` 只会显示一句通用失败。这是所有 `rbacGuard` 路由的
   既有形态,本刀不改,登记为 PR-5 面板可用性的输入。
6. **#5611 的对账测试会被本刀打红**(设计文档 §5.1 给了根因与两种修法)。这不是本支能在自己树上修的:
   那个文件不在本分支上。**后合的那一支必须改**,协调方在试合时会看到。
7. **解析器的射程**:`…seed.test.ts` 的门解析只读 `src/routes/data-sources.ts` 一个文件、只认写成引号字面量的门。
   在别的文件里新挂一个 `rbacGuard('data_sources:purge')`,或把码在运行时拼出来,这套对账看不见——
   这条残余风险不是写在注释里声明的,而是被 `:487` 一条断言(拼接形态解析为空)**钉成事实**。
