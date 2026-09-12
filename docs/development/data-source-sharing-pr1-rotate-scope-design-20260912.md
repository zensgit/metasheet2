# G02 PR-1 设计:动词拆分与轮换独占(`data_sources:use|rotate|share`)

**上级设计**:`docs/development/data-source-sharing-scope-design-20260911.md` §2、§7 的 PR-1。
本文只覆盖第一刀,**不重述**上级设计的判定与结论。

**基线**:`origin/main` @ `f8cdc2ca1`(`fix(stock-prep): 外接源列表对非 null workspace hint 回退同租户 null 行 …(#5634)`)。
分支 `feat/data-source-sharing-pr1-rotate-scope`。本文所有 `file:line` 均在**本分支的改动后树**上实读复验;
上级设计写的 `:716` 在 main 上仍然成立(改动前实读确认),本刀给该路由加了 33 行注释块(终审返修又补了一段),**改动后**它落在 `:749`。

写于 2026-09-11 18:5x(+08);文件名日期沿用协调方指定的 `20260912`。

---

## 1. 这一刀做什么、不做什么

| | 内容 |
|---|---|
| **做** | ① 一支迁移种子化三个权限码 `data_sources:use` / `data_sources:rotate` / `data_sources:share`,**只种码、零持有者**;② `PUT /api/data-sources/:id/credentials` 的粗门从 `data_sources:write` 改为 `data_sources:rotate` **独占** |
| **不做** | 作用域判定(`assertAccess` / `scopePermitsListing`)一个字节不动;`scope_kind` 值域不动;`PUT /:id/scope` 不建;`use` 三条路由不接线;共享 UI 不做;`resolveActor` 不动;前端不动;pin 不动;`errorCodeLabels.ts` 不动 |

**合完之后共享源走通到哪一步**:**零步**。这一刀与共享功能无关,它的全部价值是把「换口令」从「改指向」的同一把钥匙下摘出来
(上级设计 §2.1),并把后两刀要用的词表一次性落库。

---

## 2. 迁移形状

`packages/core-backend/src/db/migrations/zzzz20260912120000_add_data_source_sharing_permissions.ts`

形状**照抄** `zzzz20260830100000_add_stock_prep_permissions.ts`(也是 #5611 `zzzz20260910120000_add_integration_permissions.ts` 抄的那一支):

| 要件 | 位置 | 说明 |
|---|---|---|
| `DO $$` + `information_schema.tables` 表存在守卫 | `:142-147`、`:161-166`、`:178-183`、`:195-200` | `permissions` 表不存在时整块跳过,不报错 |
| `INSERT INTO permissions (code, name, description)` 三行 | `:148-152` | 三行的 `code` 就是三个新码 |
| `ON CONFLICT (code) DO NOTHING` | `:153` | 幂等的全部依据 |
| **不写 `role_permissions`** | `up()` 全体 `:140-157` | 刻意省略,见 §4 |
| `down()` 子表先于父表 | `role_permissions :160-175` → `user_permissions :177-192` → `permissions :194-209` | FK 是 `ON DELETE CASCADE`,只删父表也够;显式删子表是为了让爆炸半径在源码里看得见 |
| 导出常量 | `DATA_SOURCE_SHARING_PERMISSION_CODES :115`、`DATA_SOURCE_PREEXISTING_PERMISSION_CODES :128`、`DATA_SOURCE_ALL_PERMISSION_CODES :135` | 供测试对账,沿用 `STOCK_PREP_PERMISSION_CODES` 的既有约定 |

**与 #5611 刻意解耦**:`DATA_SOURCE_PREEXISTING_PERMISSION_CODES`(read/write/execute)是**列出来的,不是 import 的**。
#5611 尚未合(2026-09-11 实查 `state: OPEN`),两支迁移彼此独立、可以任意顺序落地;
一旦 import,合并顺序就成了承重结构。

**为什么三码同用 `data_sources` 前缀**:`derivePermissionResource`
(`packages/core-backend/src/rbac/namespace-admission.ts:125-131`)按**第一个冒号之前**取 resource,
所以三个新码的 resource 都是 `data_sources`,与既有三码**复用同一个命名空间准入开关**。
运维不多开任何东西。这一条被 `data-source-sharing-permission-codes-seed.test.ts:350` 钉住。

**没有加进 `NON_NAMESPACED_PERMISSION_RESOURCES`**(`namespace-admission.ts:11-38`)。
那是一张**豁免**名单——`isNamespaceAdmissionControlledResource` 对**不在**名单里的一切答 `true`(`:133-137`)——
把 `data_sources` 塞进去不会「让授予生效」,只会让**每一个**现存与未来的 `data_sources:*` 持有者
整体绕过 `user_namespace_admissions`。测试 `:635` 正面钉住「仍受准入管控」,`:645` 用四个已豁免资源做**反证**,
确保那条断言不是恒真。

---

## 3. 门改动

| 文件 | 行 | 改动 |
|---|---|---|
| `packages/core-backend/src/routes/data-sources.ts` | **`:749`** | `rbacGuard('data_sources', 'write')` → `rbacGuard('data_sources', 'rotate')` |
| 同上 | `:712-748` | 注释块 37 行(其中 33 行是本刀新增),写明「独占、不是 `rbacGuardAny`」、fail-closed 的理由与上机前置的指向 |

**只有这一处。** 改动后全文件 15 处 `rbacGuard('data_sources', …)` 的分布:

| 路由 | 行 | 门 |
|---|---|---|
| `GET /api/data-sources` | `:336` | `read` |
| `GET /api/data-sources/health` | `:374` | `read` |
| `GET /api/data-sources/:id` | `:421` | `read` |
| `POST /api/data-sources` | `:463` | `write` |
| `POST /api/data-sources/test` | `:549` | `write` |
| `PUT /api/data-sources/:id` | `:615` | `write` ← **刻意不动** |
| `PUT /api/data-sources/:id/credentials` | **`:749`** | **`rotate`** ← 本刀 |
| `DELETE /api/data-sources/:id` | `:851` | `write` |
| `POST /api/data-sources/:id/connect` | `:931` | `write` |
| `POST /api/data-sources/:id/disconnect` | `:983` | `write` |
| `GET /api/data-sources/:id/test` | `:1022` | `read` |
| `POST /api/data-sources/:id/query` | `:1070` | `execute` |
| `POST /api/data-sources/:id/select` | `:1176` | `read` |
| `GET /api/data-sources/:id/schema` | `:1236` | `read` |
| `GET /api/data-sources/:id/tables/:table` | `:1290` | `read` |

`:615` 留在 `write` 是**拆分成立的另一半**:如果后来有人把它也挪到 `rotate`,两个动作就从另一侧重新融合了。
这条由 `data-source-sharing-permission-codes-seed.test.ts:436` + 变异探针 `:464` 钉住。

### 3.1 为什么是**独占**而不是 `rbacGuardAny(['data_sources:rotate','data_sources:write'])`

`rbacGuardAny` 在 `rbac/rbac.ts:119` 是现成的,选它是**最省事**的写法,而且它能让所有正向用例照绿——
恰恰因为如此它是这一刀最危险的"修法"。接受 `write` 兜底 = 两个动作仍然同钥匙 = 本刀退化成纯注释。
所以:

- 门的**形状**被结构断言钉住(`…seed.test.ts:130 assertRotateGateIsExclusive`),它读**真实路由文件**,
  同时拒绝「码不等于 `data_sources:rotate`」和「出现 `rbacGuardAny`」两种形态;
- 这条断言能抓到一个**行为测试抓不到**的变异:换成 any-of 之后,每一条正向轮换用例仍然绿,
  只有那条 403 用例会红——而那条用例是可以被"顺手删掉"的。变异 M-B 的实测见验证文档。

### 3.2 细门一个字节不动

`manager.assertAccess(id, actor)`(改动后 `routes/data-sources.ts:775`)与 `resolveActor` 都没动。
持 `rotate` 的非属主仍然吃统一 404。这由 `data-source-visibility-authority-matrix.test.ts:499`
与 `data-source-readonly.test.ts:437-440`(403)+ `:446-454`(404)两处成对钉住。

---

## 4. 上机前置(**不在迁移里自动补权**)

切独占是一次**收紧**。回归面 = 「今天谁持有 `data_sources:write` 但不会自动拿到 `rotate`」。
平台管理员不受影响(`rbac/rbac.ts:69-72` 的全局管理员短路发生在查表之前)。
非管理员持有者则会**立刻失去「就地」轮换能力**(`PUT /:id/credentials` 答 403;删后重建与改指向仍在 `write` 手里,见本节末),直到管理员显式授权。

**因此上机前必须先跑这两步只读查询**,它们写在迁移头注释 `:61-85` 里,也抄在这里:

```sql
-- 步骤 0(只读):先定 legacy 列 users.permissions 的形状。
-- 走 zzzz20260119100000_create_users_table.ts:16 建起来的库是 jsonb;走更老的
-- packages/core-backend/migrations/054_create_users_table.sql:10 建起来的库是 TEXT[]。
-- text[] 没有到 jsonb 的合法 cast,所以第三段谓词必须按形状二选一。
SELECT pg_typeof(permissions) FROM users LIMIT 1;
```

```sql
-- 步骤 1(只读)。部署本刀的门改动之前执行。**三张活面,不是两张**:
-- userHasPermission 查 user_permissions(rbac/service.ts:44)、role_permissions(:47),
-- 以及 legacy 的 users.permissions 列(:57-61);listUserPermissions 也把该列并进结果(:94-96),
-- 而那正是 req.user.permissions 的来源、rbacGuard 最先信的数组(rbac/rbac.ts:77-83)。
SELECT 'role_permissions' AS surface, role_id AS subject, COUNT(*) AS grants
  FROM role_permissions WHERE permission_code = 'data_sources:write' GROUP BY role_id
UNION ALL
SELECT 'user_permissions', user_id::text, COUNT(*)
  FROM user_permissions WHERE permission_code = 'data_sources:write' GROUP BY user_id
UNION ALL
-- jsonb 形状:
SELECT 'users.permissions', id::text, 1
  FROM users WHERE permissions::jsonb ? 'data_sources:write';
-- TEXT[] 形状改用这一段:
--   SELECT 'users.permissions', id::text, 1
--     FROM users WHERE 'data_sources:write' = ANY(permissions);
```

- **三面均返回 0 行** → 直接上,零回归面。只查前两面不足以支撑这个结论。
- **任意一面返回行** → 先把 `data_sources:rotate` 授给这些主体,再上门改动。
  **推荐经角色**,但「直接写 `user_permissions` 一律被过滤成 403」是过绝对的说法:
  命名空间准入的 `controlledNamespaces` 只从 `user_roles ⋈ role_permissions`
  (外加 `<namespace>_admin` 这类委派管理员 role id)推导(`rbac/namespace-admission.ts:179-205`),
  所以**只有靠角色根本够不到 `data_sources` 命名空间的人**才会被过滤成 403
  ——2026-09-08 备料那条教训正是这一类(该用户没有任何 stock-prep 角色)。
  今天真能用 `data_sources:write` 的人通常已经经角色持有该命名空间,对他们直接授予其实有效。
  仍然一律走角色:一种配方覆盖两类人,而且授权可审计。
- 授完要**确认该用户的 `data_sources` 命名空间准入是开的**。**不需要重登**:
  **授予下一次请求即生效** —— `rbacGuard` 在 `req.user` 这条路径没命中后会落到
  `userHasPermission`(`rbac/rbac.ts:101`),而 `rbac/service.ts:36-72` 是直查
  `user_permissions` / `role_permissions`,**不走** `service.ts:12-13` 的 60s 缓存。
- 滞后只发生在**撤销**方向:用裸 SQL 撤销后,`listUserPermissions`(`service.ts:74-99`)的缓存
  会让 `req.user.permissions`(`rbac.ts:77-83` 最先信的那个数组)在**每个进程**里最多再放行
  `RBAC_CACHE_TTL_MS`(默认 60s)。要即时生效就走 `/api/admin/users` 或 `/api/permissions`
  的撤销接口——它们会调 `invalidateUserPerms`(`routes/admin-users.ts:3027`、
  `routes/permissions.ts:175`),裸 SQL 不会。

**刻意不在迁移里写 `role_permissions` 自动补权。** 迁移一旦发权,这次授权就是「没有人做出的授权」,
正是备料 R-11「映射零自动」与 #5611 定的口径要排除的东西。这条由测试 `:382`(正面)+ `:387`(变异探针)钉住;
变异 M-D 的实测见验证文档。

**本刀 fail-closed 的准确表述**:切独占后,未获 `rotate` 的 `write` 持有者**不能再「就地」轮换凭据**
(`PUT /:id/credentials` 答 403),但**仍然能改连接串、能删、能连断**——因为那些路由的门没动。
而且「不能轮换」止于**就地**:`write` 手里仍有 `DELETE /:id`(`:851`)+ `POST /api/data-sources`(`:463`)
同 id 带新 `credentials` 重建(删除先过 `manager.assertAccess`,非属主吃统一 404;重建只会落在调用者自己名下),
以及 `PUT /:id`(`:615`)改指向。这不是「把 write 收窄了」,是「把 rotate 摘出去了」:
拆开的是两个不同量级动作的**授权面**,不是断言「持 write 的人永远碰不到新口令」。

---

## 5. 在飞 PR 的耦合(**两条,协调方必须看**)

### 5.1 #5611 的对账测试会因为本刀变红 —— 后合的那一支必须改

#5611(`feat/integration-permission-codes-seed`,**未合**)带一个
`packages/core-backend/tests/unit/integration-permission-codes-seed.test.ts`,其中:

```ts
const enforced = parseRbacGuardCodes(routeSource, 'data_sources')
expect(enforced).toEqual([...DATA_SOURCES_PERMISSION_CODES].sort())        // read/write/execute
expect(() => assertSeedMatchesEnforcement(seeded, enforced)).not.toThrow()
```

本刀让 `src/routes/data-sources.ts` 多出一个被 `rbacGuard` 强制的 `data_sources:rotate`,
于是 `enforced` 变成 `[execute, read, rotate, write]`:**上面两条断言都会红**
(第二条会抛 `enforced but never seeded: data_sources:rotate`)。

- 这**不是** bug,是两支 PR 的真实耦合:#5611 的对账刻意做成「网关集合 == 种子集合」的等式,
  而本刀合法地扩大了网关集合。
- **修法已在 #5611 侧落地**(#5611 仍 OPEN):把它的 `assertSeedMatchesEnforcement` 的「已知可授予」集合
  **并上**本刀的 `DATA_SOURCE_SHARING_PERMISSION_CODES`,并把那条等式断言放宽成子集 ——
  于是**两支任一顺序合并都绿**,耦合消失。选并集而不是只改等式,有两个理由:PR-3/PR-4 还会再加
  `share` / `use` 两个网关;而且**只取等式那一条**会让 #5611 的变异探针恒抛
  `enforced but never seeded`(`rotate` 永远在 `enforced`、永远不在它的 `seeded` 里),
  从「抓删码」退化成空转。
- **万一 #5611 没有先改**:两支必须**串行合并**,后合的那一支合并前先 rebase 到 main,
  再**单跑** `packages/core-backend/tests/unit/integration-permission-codes-seed.test.ts`。
  两支文件不重叠、git 会干净自动合并,所以红只会在合并后的组合态出现,合并前谁的 CI 都看不到。
- 本支**没有**在自己树上改 #5611 的文件——那个文件不在本分支上,盲改会制造冲突。
- 本支自己的对账(`…seed.test.ts:175 assertSeedMatchesEnforcement`)刻意做成**子集 + 显式接线清单**而非等式,
  就是为了不把同一个雷再埋一次:`:504` 的期望接线是 `['data_sources:rotate']`,PR-3/PR-4 要来这里改一行才能过。

### 5.2 #5593 的争用面

`routes/data-sources.ts` 被 #5593(列表/详情 `referenceCount`)同时改。本刀在该文件的 hunk **只有一处**,
位于 `@@ -712,8 +712,41 @@`(credentials 路由的注释块 + 门那一行),与 #5593 的 `:336`/`:421` 不重叠,
预期 git 自动合并。副作用是该行以下的行号整体 **+33**,#5593 若在描述里写了绝对行号需要重算。

---

## 6. 为什么 `use` / `share` 现在只种不接线

- `use` 的三条落点(`/:id/schema`、`/:id/tables/:table`、`/:id/select`)要改成
  `rbacGuardAny(['data_sources:use','data_sources:read'])`,属于 **PR-4**;它与列表可见性、
  E 段读取放宽是同一刀,单独改门没有任何收益,却会让「谁能看见什么」的回归面提前打开。
- `share` 的落点 `PUT /:id/scope` 这条路由**还不存在**(PR-3 建)。

两个码现在的正确状态是「可授予、无人执行」。这个状态被 `…seed.test.ts:517` **正面钉住**
(断言路由文件里**没有** `data_sources:use` / `data_sources:share`),
所以 PR-3 / PR-4 必须回到这个文件把期望改掉——接线这件事没法悄悄发生。

---

## 7. 我不确定 / 未覆盖的

1. **222 与客户库里 `data_sources:write` 的真实持有者数未查**。本机无 PG,`gh` 也读不到生产库。
   §4 的只读 SQL 是**上机前置**,不是已完成项。
2. **真库迁移重放未跑**(本机无 PostgreSQL)。幂等性由「迁移自己发出的真实 SQL + 模拟 `permissions` 主键」
   的内存重放覆盖(测试 `:568-631`),真库 `db:migrate` 跑两遍交给 CI 的 migration-replay 泳道。
3. **`down()` 的语义沿用既有 seed 迁移**(先删子表再删父表,连带删掉运维已授出的角色绑定)。
   是否应改成「仅在无引用时才删」是跨全部 seed 迁移的口径问题(#5611 的后续单第 2 条已登记),
   单改本支会造成两套语义并存,故未动。
4. **403 的响应体形状与本路由其它错误不一致**:`rbacGuard` 拒绝时回 `{ error: 'Insufficient permissions' }`,
   而路由自身的错误回 `{ ok:false, error:{ code, message } }` 信封。这是**所有** `rbacGuard` 路由的既有形态,
   不是本刀引入,故未改;但前端 `apps/web/src/data-sources/api.ts:96-101` 只会把它渲染成
   「Failed to update data source credentials」,**不会告诉用户缺的是哪个码**。
   若 PR-5 的面板要给出「缺 `data_sources:rotate`」这类提示,需要单独一刀,本刀只登记。
5. **`plugins/` 与 `apps/web/` 全仓 grep `data_sources:` 零命中**,所以没有插件侧或前端侧硬编码该码的地方需要跟改。
   但这只覆盖**字面量**;运行时拼接的门(如果有)看不见——同一条残余风险在测试 `:487` 里被显式断言成
   「拼接形态解析为空」,而不是放在注释里声明。
6. **mongodb 类型的源:`PUT /:id`(`write` 门)仍能换掉口令**——保证③在 mongodb 上的真实缺口。
   `ConnectionConfigSchema`(`routes/data-sources.ts:79`)是开放的 `z.record(...)`,
   而 `MongoDBAdapter`(`packages/core-backend/src/data-adapters/MongoDBAdapter.ts:119-123`)在
   `connection.uri` 是字符串时**原样**交给 `MongoClient`,口令可以内嵌在 uri 里。
   于是持 `write` 的属主用 `PUT /:id` 改 `connection.uri` 即完成一次轮换,绕过本刀的 `rotate` 门。
   pg / mssql / mysql / http 不受影响(适配器只从 `config.credentials` 取密码)。
   今日客户面没有 mongodb 源,故**登记不修**;收口应与 `connection` 的白名单校验同刀做。
7. **`POST /api/data-sources/test`(`:549`,`write` 门)是 `write` 手里的凭据有效性 oracle**。
   它接受完整的 `DataSourceCreateSchema`(含 `credentials`)并对任意 host 真连,所以持 `write`
   未获 `rotate` 的人虽然写不进新口令,却能用它逐个验证候选口令的对错。本刀未动该门(既有形态),
   与第 6 条一起构成「把 `rotate` 摘出去之后 `write` 仍握着的秘密面」。
8. **`down()` 必须与 `:749` 的门改动同回滚**。回滚只删这三码,但 FK 是 `ON DELETE CASCADE`,
   连带 drop 掉运维已授出的 `rotate` / `use` / `share` 绑定;若门不同回滚,`:749` 对非管理员就变成
   「可强制、不可授予」(码不存在时 `role_permissions` 的 FK 会拒绝再授)。方向上仍是 fail-closed、
   管理员短路不受影响,但运维必须知道词汇面和门要成对回滚。
