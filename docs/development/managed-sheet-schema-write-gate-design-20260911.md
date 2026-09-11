# 托管表 schema 写门 — 设计（2026-09-11）

分支 `fix/managed-sheet-schema-write-gate`。本文只讲这一支 PR 的形状、覆盖面与代价；验证证据在
`docs/development/managed-sheet-schema-write-gate-verification-20260911.md`。

## 1. 缺口

托管表 = 在 `plugin_multitable_object_registry` 里有行的表（插件 `ensureObject` 在 provisioning 事务里落的行，
客户端写不到；理由见 `packages/core-backend/src/multitable/sheet-delete-guard.ts` 顶部注释）。

- `packages/core-backend/src/multitable/permission-service.ts:1536` `applyContextSheetSchemaWriteGrant`：
  任何**表级** `scope.canRead && scope.canWrite` 的授权都会把 `canManageFields` 抬成 `true`。
- `packages/core-backend/src/routes/univer-meta.ts` 上所有 schema 路由只看 `capabilities.canManageFields`，
  从不问"这张表是不是插件托管的"。
- 托管表的列集由插件反复 `ensure`：`provisioning.ts:426`（`ensureFields`）、`provisioning.ts:712`
  （`ensureMissingObjectFields`，`ON CONFLICT (id) DO NOTHING`），而 `meta_fields` 没有 `(sheet_id, name)` 唯一索引。
  于是"手工建一列，名字和模板列一样"不会撞模板行，只会多出一列同名、永远没人写的死列，且无任何报错。
- 会这么干的人正是在这张表上**合法写数据**的一线操作员：导入未匹配表头默认建列（#5603，前端入口
  `apps/web/src/multitable/import/create-fields.ts`，落到 `POST /api/multitable/fields`）离"写数据"只有一步。

## 2. 修法：门做在能力层

新增 `packages/core-backend/src/multitable/managed-sheet-schema-write-guard.ts`：

- `isPluginManagedSheetFailClosed`（:53）— 复用 `sheet-delete-guard.ts:65` 的 `isPluginManagedSheet`
  （只 import，不改那个文件），查表失败一律答"是托管表"（fail-closed，:59-61）。
- `restrictManagedSheetSchemaWriteCapabilities`（:69）— 纯函数：非 admin × 托管表 ⇒ `canManageFields: false`；
  其余情况原样返回（返回同一对象引用，无复制、无漂移）。

接线在 `permission-service.ts:1787-1800`，位置在 `applyContextSheetSchemaWriteGrant`（:1786）之后、
`restrictApprovalProjectionCapabilitiesPerRow`（:1806）与 `restrictElearningProjectionCapabilities`（:1810）之前，
与那两个投影同形（判定由调用方查、纯函数做降权、lookup 失败 fail-closed）。

两处与裁定原文的出入，先点名：

1. 裁定说 admin 保留"与既有两个投影一致"。**只有 approval 那个投影豁免 admin**
   （`approval-projection-constants.ts:76-88`，`if (!isProjectionSheet || isAdminRole) return capabilities`）；
   elearning 那个对 admin 也砍写面（`elearning-projection-constants.ts:77-93`，`DENIED_KEYS` 无条件置 false）。
   本 PR 按 approval 的形状做（admin 保留），理由写在 guard 模块注释里：admin 修托管表是本门故意留的口子。
2. 裁定说"新增第三个 `restrict*`"写在 `permission-service.ts` 里。既有两个 `restrict*` 的**定义**都在各自的
   constants 模块里，`permission-service.ts` 里只有**调用**。本 PR 照这个既有形状：纯函数放新模块，调用放
   `permission-service.ts`。

一个小优化（也是 blast radius 控制）：只有 `!isAdminRole && capabilities.canManageFields` 时才查注册表
（:1794）。admin 与"本来就没有这个位"的读者不付这次查询；跳过查询不会放宽任何东西——那一位本来就是 false。

## 3. 覆盖的入口（`capabilities.canManageFields` 的全部消费者）

grep `capabilities.canManageFields`（`packages/core-backend/src`），逐条判定：

### 3.1 经 `resolveSheetCapabilities` ⇒ 本 PR 覆盖

| 路由 | 门 file:line | 性质 | 会不会写 `meta_fields` |
| --- | --- | --- | --- |
| `POST /api/multitable/fields` | univer-meta.ts:12582 | schema 写（#5603 导入建列走这条） | 是（univer-meta.ts:12638） |
| `PATCH /api/multitable/fields/:fieldId` | univer-meta.ts:12938 | schema 写（改名/改类型/改 property） | 是（UPDATE） |
| `DELETE /api/multitable/fields/:fieldId` | univer-meta.ts:13278 | schema 写（删列 + 数据裁剪） | 是（DELETE + 级联） |
| `POST /api/multitable/sheets/:sheetId/config-restore-execute` | univer-meta.ts:9747 | schema 写（`entity_type='field'` 的还原/反删） | 是（`recreateFieldFromConfig`，univer-meta.ts:6992） |
| `POST /api/multitable/person-fields/prepare` | univer-meta.ts:12830 | 写（按源表权限，给 People 系统表补列） | 是（`ensurePeopleSheetPreset`，univer-meta.ts:5542） |
| `PUT /api/multitable/sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId` | univer-meta.ts:8868 | 写（字段级 ACL，不是列集） | 否 |
| `PATCH /api/multitable/sheets/:sheetId`（表改名） | univer-meta.ts:14496 | 写（显示名） | 否 |
| `POST /api/multitable/sheets/:sheetId/config-restore-preview` | univer-meta.ts:9545 | 预览（读） | 否 |
| `GET /api/multitable/sheets/:sheetId/field-permissions` | univer-meta.ts:8737 | 读 | 否 |
| `GET /api/multitable/sheets/:sheetId/config-history` | univer-meta.ts:9482 | 读（决定列表里能不能出现 `entity_type='field'` 行） | 否 |
| `POST /api/multitable/sheets/:sheetId/formula/dry-run` | univer-meta.ts:15412 | 读（试算，不落库） | 否 |
| `POST /api/multitable/sheets/:sheetId/ai/suggest-formula` | multitable-ai.ts:1514 | 读（出候选公式，不落库） | 否 |

拒绝形状**沿用既有** `sendForbidden`（univer-meta.ts:4443）⇒ `403 {ok:false,error:{code:"FORBIDDEN",
message:"Insufficient permissions"}}`；AI 那条本来就是自己拼的同码 403（multitable-ai.ts:1515）。
**没有发明新错误码**，也没有动 `errorCodeLabels.ts`。前端要识别的话，用的就是既有的 `FORBIDDEN`。

### 3.2 不在本 PR 范围（点名说明）

1. **插件自己的 provisioning 补列** — `provisioning.ts:426` / `:712` 直接走 SQL，压根不经过能力层。
   这是模板演进的正路，卡死它就等于卡死升级；本门刻意不碰。
2. **全局派生的三条路由** — `PATCH /bases/:baseId`（univer-meta.ts:7348）、`POST /templates`（:7442）、
   `DELETE /templates/:templateId`（:7552）用的是 `deriveCapabilities(access.permissions, ...)`（全局派生，
   与具体 sheet 无关）。没有 sheetId 可判，也不改任何托管表的列集。
3. **`sheet-capabilities.ts:resolveSheetCapabilitiesForUser`**（Yjs/collab、api-token、automation 的能力口）—
   全仓 grep `.canManageFields` 的消费者只有 permission-service.ts:1485、
   recovery-authorization-stability.ts:27（两次解析取交集，两次都已被本门收窄）和 multitable-ai.ts:1514；
   那个 user-keyed 解析器的调用方只读 `canRead / canCreateRecord / canEditRecord / canManageSheetAccess`
   （index.ts:4096/4110/4132/4226/4360、automation-service.ts:2291/2330、routes/api-tokens.ts）。
   也就是说那条链上**今天没有 schema 写面**，加一道无法被测试触发的门就拿不到"去掉它测试就红"的证据，
   所以本 PR 不加，只在此备案：将来若有人在那条链上读 `canManageFields` 去写 schema，需要同样收窄。
4. **`DELETE /api/multitable/sheets/:sheetId`** — 已有 `resolveSheetDeleteRefusal` 的 409 门
   （univer-meta.ts:14349），与本门并行，不重复。
5. **`GET /api/multitable/context`**（univer-meta.ts:7910）直接调 `applyContextSheetSchemaWriteGrant`，
   不经 `resolveSheetCapabilities` ⇒ **不在本门覆盖内**，见下节误伤/口径评估。

## 4. 误伤评估（能力位的其它消费者）

**结论：数据面零影响；读面有三处收窄；UI 亲和度有一处已知不一致。**

- **数据面不动**：本门只改 `canManageFields` 一位。同一演员的
  `canRead / canCreateRecord / canEditRecord / canDeleteRecord / canManageViews / canComment / canExport`
  与改动前逐位相同（`tests/unit/multitable-managed-sheet-schema-write-gate.test.ts` §2 有断言，
  真库件里还有一条 `POST /records` 正控）。
- **读面收窄（可接受，但记在这里）**：
  1. `GET /sheets/:sheetId/field-permissions`（:8737）对托管表上的非 admin 表级写手从 200 变 403。
     这是"谁能看/改字段级 ACL"的管理面，不是数据；同一位演员本来也改不了（:8868 同门）。
  2. `GET /sheets/:sheetId/config-history`（:9482）：`entity_type='field'` 的配置修订行不再出现在他的列表里
     （不是 403，是列表变窄）。
  3. `POST /sheets/:sheetId/formula/dry-run`（:15412）与 `POST /sheets/:sheetId/ai/suggest-formula`
     （multitable-ai.ts:1514）对托管表变 403。两条都不落库，其价值是"为写公式字段做准备"，
     而写公式字段本身已被本门挡住，所以不构成新的能力断裂。
- **UI**：工作台的字段管理入口取自 `GET /context` 的能力位，而 `/context` 走的是
  `applyContextSheetSchemaWriteGrant` 直调（univer-meta.ts:7910），**本 PR 不改 `univer-meta.ts`**，
  所以按钮/面板对托管表**不会消失**，点下去由服务端答 403。
  方向是 fail-closed（服务端严于 UI），代价是一次"看得见点不动"的体验落差。要对齐的话是后续单独一支
  （改 `/context` 的能力口径），不在本 PR。
- **非 admin 的全局 `multitable:manage-schema` 持有者**在托管表上也会被挡（裁定写的是"非 admin ⇒ false"，
  本 PR 照做）。补救路径：admin 角色，或插件自己的 provisioning。这条是**故意的**，
  并且有用例锁住（§1 "global multitable:manage-schema holder … → 403"）。
- **fail-closed 的代价，明说**：注册表读不到（表不存在/瞬时故障）时，非 admin 在**任何**表上都拿不到
  `canManageFields`。方向是能力少给，不是多给；`plugin_multitable_object_registry` 由迁移
  `zzzz20260408123000_create_plugin_multitable_object_registry.ts` 建，正常部署里存在。

## 5. 本 PR 动了哪些文件

| 文件 | 性质 |
| --- | --- |
| `packages/core-backend/src/multitable/managed-sheet-schema-write-guard.ts` | 新增：纯函数 + fail-closed 判定 |
| `packages/core-backend/src/multitable/permission-service.ts:1787-1800` | 接线（唯一的产品代码改动，+18 行） |
| `packages/core-backend/tests/unit/multitable-managed-sheet-schema-write-gate.test.ts` | 新增：无库半（真路由 + 真 permission service） |
| `packages/core-backend/tests/integration/multitable-managed-sheet-schema-write-gate.db.test.ts` | 新增：真库件 |
| `packages/core-backend/tests/unit/multitable-permission-subject-hydration.test.ts` | 夹具补一条注册表应答（验证文档 §4.1） |
| `packages/core-backend/tests/unit/multitable-recovery-archive-writer-closure-routes.test.ts` | SQL 序列 sha256 pin 重打（验证文档 §4.1） |
| `packages/core-backend/vitest.config.ts` | 真库件从无库道排除（两点法的一半） |
| `.github/workflows/managed-sheet-schema-write-gate-realdb.yml` | 新增：真库证据道（两点法的另一半） |
| `docs/development/managed-sheet-schema-write-gate-{design,verification}-20260911.md` | 本文与验证 |

## 6. 性能

非 admin 且该位为 true 时，每次 sheet 能力解析多一条
`SELECT 1 FROM plugin_multitable_object_registry WHERE sheet_id = $1 LIMIT 1`（主键命中）。admin 与
读者零新增查询（`permission-service.ts:1794` 的前置判断）。与既有 approval 投影 lookup 同量级。

## 7. 没做的事

- 没碰 `univer-meta.ts`、`sheet-delete-guard.ts`、`MetaFieldManager.vue`、`MetaImportModal.vue`、
  `errorCodeLabels.ts`、任何迁移、`http-routes.cjs`、`plugin-tests.yml`（s6a 打包 pin 输入）。
- 没重构权限体系：没有动 `applyContextSheetSchemaWriteGrant` 的语义，没有新增权限码，没有改角色模型。
- 没给 `meta_fields` 加 `(sheet_id, name)` 唯一索引（那是迁移，且会影响既有数据；本门只堵住入口）。
