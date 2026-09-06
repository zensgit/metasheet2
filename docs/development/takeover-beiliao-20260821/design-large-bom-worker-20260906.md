> **文档状态**:第四轮定向修订稿。三轮 opus 对抗复核记录见附录 [`design-review-appendix-20260906.md`](./design-review-appendix-20260906.md)。基线 `origin/main` = `f26a3395c`。**未经 owner 拍板,不代表决策。** values-free。
>
> **另**:本稿所有量化收益(时间份额、削减百分比等)均为**待实测假设**;§1.7 是在 222 上做只读实测的具体方案。**实测完成前,不得据此做任何取舍决定。**

---

# 设计稿 4(第四轮)—— 大 BOM 写入慢 与 后台作业 worker 化

**基线**:`origin/main` @ `f26a3395ca1f0efaaa2100953c842f448c4453ee`(本次会话 `git fetch origin`;与第一至第三轮同基线,未漂移)。
**行号口径**:本稿每一处 `文件:行号` 都在 `git show origin/main:<path>` 上**第四次**逐条实读核实。第三轮写错的,在 §0.2 点名改正或删除,在 §9 变更表里给处置。
**values-free**:不含凭据、地址、零件号、项目号。
**只读**:本稿未改动仓库任何文件,未运行任何改变状态的 git 命令,未连接 222。

**本轮的口径变更(最重要的一条)**:第一、二、三轮各自新写了一个"成本模型 / 时间份额",三次全被证伪。**本轮不再建模。** 凡涉及"某项占总时间多少""省几成""最大杠杆""唯一杠杆"的说法,一律降级为**待实测假设**,并在 §1.7 给出拿到真实时间构成的具体办法。能从代码直接读出的只有**结构**(发几条语句、开不开事务、取哪把锁、改什么语义),本稿只写这些。

---

## 0. 第四轮的结论

### 0.1 一句话

> 三轮下来,**事实盘点(§2 现状、§3 安全缺口)已经过硬**;**每一轮新写的时间模型都不成立**。
>
> 本轮不给性能排序。**先做一次不改代码、不改 PG 配置的实测(§1.7),拿到"453.6 s 里服务端占多少、哪条语句吃掉多少"这两个数,再谈 L1 / L2 / L3 / chunk 大小谁先谁后。**
>
> 与实测无关、可以独立推进的只有两件:**§3 的 G1 / G2 两个安全缺口**,和**"关页不丢"这个卖点本身要不要买**(§4.4–§4.6,按语义变化卖,不按"更快"卖)。

### 0.2 第三轮里与代码相反、本稿已改正或删除的机制陈述

| 第三轮的原话 | 处置 | 反证(逐条实读) |
|---|---|---|
| §1.2 的十条往返清单里**没有 BEGIN/COMMIT,也没有事务** | **改正,§1.2 重写** | 宿主的记录门面**每次写调用自开一个事务**:`packages/core-backend/src/index.ts:1021-1022`(`createRecord: async … => { return poolManager.get().transaction(…)`)、`:1059-1060`(`patchRecord` 同形);只有 `queryRecords`(`:999`/`:1001`)与 `getRecord`(`:1041`/`:1043`)走裸 `poolManager.get().query`。所以一行 `add` 是"查询段不开事务 + 写入段一个完整事务",每行一次提交 |
| §1.3 "**这是本稿唯一有结构支撑、且与负载无关的削减点**" | **删除该"唯一"** | `index.ts:1021-1022` 的每写一行一个事务同样是无条件的、同样与负载无关、同样与 add/update 无关。两条都有结构支撑,谁的时间份额大,**代码里读不出来** |
| §1.6 预测表(六行"语句数")+ "预测成立 → **六成的时间**花在读同一行元数据上" | **整段作废,§1.6 重写为"为什么作废",测量方案改到 §1.7** | (a) 条数不是时间:六条主键 SELECT 与一次 `INSERT` + 一次修订写 + 一把 advisory lock + 一次 COMMIT 的单位成本不同量级;(b) 那六行本来就由代码结构直接决定(`plugin-scope.ts:395`/`:399` 每次记录调用各发一条 registry 查询;`query-service.ts:258` 与 `records.ts:680` 各自再走一遍 `loadSheetAndFields`),**几乎不可能被证伪,测不出新信息** |
| §1.2 "453.6 s / 131,510 ≈ **3.4 ms/次**——对本机 PG 是合理量级" | **删除** | 453.6 s 是驱动脚本的墙钟(`48h-autonomous-run-record-20260906.md:52`),而**该驱动脚本不在仓里**(`git ls-tree -r origin/main` 无 `large-bom-drive.cjs`;全仓 `git grep timingsMs` 零命中)。仓里唯一同形驱动每批之间固定 `await wait(2000)`(`apps/web/src/services/integration/stockPreparation/largeBomPull.ts:344`,`intervalMs = 2000` `:235`)。453.6 s 里有多少是客户端等待,**本稿答不了**(见 §1.7 M1/M2) |
| §1.4 "chunk 100→500……每行十次往返没变;仍然基本无效";§5.1 给 chunk 大小 0 收益;§8 PR-5 "收益基本为零" | **全部改为"待实测"** | 每推进一个 chunk 有一笔**与 chunk 大小无关的固定开销**,第三轮漏了:路由 `plugins/plugin-integration-core/lib/http-routes.cjs:6402-6407` → `loadLargeBomCheckpointApplyJob`(`stock-preparation-large-bom-jobs.cjs:1198-1211`,`storage.get` 在 `:1201`)一次整值读;runner `:1259` 又一次整值读;`:1307` 与 `:1334` 两次**整份回写**。作业对象里装着整份 plan(`:1179`,`totalDecisions` `:1180`),存储原语是整值读 / 整值 upsert(`packages/core-backend/src/plugins/plugin-durable-storage.ts:101-114` / `:115-128`),外加 JS 侧 `cloneJson`(`:1268` / `:1301` / `:1335`)。详见 §1.4 |
| §4.3 / N4 "**非 UoW 的 `createRecord` 只取自动编号锁、不取 canonical fence**",据此说 L3 只能收窄 L2(b) 的窗口 | **删除,机制说反了** | `acquireAutoNumberSheetWriteLock`(`packages/core-backend/src/multitable/auto-number-service.ts:23-27`)函数体只有一行 `await acquireCanonicalSheetFence(query, sheetId)`(`:27`),注释 `:19-21` 自陈是 `acquireCanonicalSheetFence` 的 deprecated 别名;两条路发的是同一条 `SELECT pg_advisory_xact_lock(hashtext($1))`、同一把键(`canonical-sheet-fence.ts:81-82`,键函数 `:58`,模块头 `:17-22` 明写"键 NEVER renamed")。UoW 侧 `stock-preparation-persist-unit-of-work.ts:81` 的 `acquireCanonicalSheetFencesInOrder` 内部逐张调同一个函数(`canonical-sheet-fence.ts:97`)。UI/REST 建行路径也无条件取同一把(`record-service.ts:573`)。**所有建行路径互斥**;不取它的是 patch 路径(`records.ts:536` 的 `fenceWriterEntry`),而 patch 建不出重复行 |
| §4.3 / Q5 / PR-3 "L3 只需放宽 `stock-preparation-persist-unit-of-work.ts:38` 的 `sheetIds.length !== 4`,或给一个单表变体" | **改正,规模按代码重报** | 同一个校验器还硬要 `project.projectId`(`:43`)与 `batch.snapshotBatchId`(`:47`)两个非空串,且两个 sheetId 必须落在 `sheetIds` 集合里(`:50-52`);`:87-94` 两把 advisory lock 的键正是从这两组值算出来的(`stockPreparationProjectLockKey` `:56-63`、`stockPreparationBatchLockKey` `:66-72`)。而大 BOM apply 作业里只有单张 `target`(`stock-preparation-large-bom-jobs.cjs:1175`)与 `plan`(`:1179`),**没有 snapshotBatchId**(作业形状 `:1159-1193` 全文无此键)。所以"单表变体" = 为一条新写路径重新设计 fail-closed 形状与锁键集合 |
| §4.3 "把一个 chunk 的 100 行合并成一个事务"——只谈开销摊薄,**没写失败语义变化** | **补上,并据此改 PR-3 与 §6** | 今天是**逐行 catch**:主循环 `plugins/plugin-integration-core/lib/stock-preparation-apply-writer.cjs:540`,`try` 在 `:542`,`catch` 在 `:569`,单行失败只 `counts.failed += 1`(`:570`)并继续,`:596-597` 据此算状态,再由 `terminalApplyStatus`(`stock-preparation-large-bom-jobs.cjs:1231-1234`)把 `failed>0` 折成 `partial`。**一个 chunk 一个 PG 事务之后,第一行真正来自库的错误会 abort 整个事务(后续语句一律 25P02),"100 行里坏 1 行仍写进 99 行"这条今天的契约就没了**,除非每行加 SAVEPOINT |
| §6 理由 4 "G3 该修,但不阻塞任何东西" | **删除该结论** | chunk 运行器在写 `running` 落库(`stock-preparation-large-bom-jobs.cjs:1307`)与写 `paused`/终态(`:1332-1334`)之间**只有 `finally` 放锁(`:1336-1338`),没有 catch**。L3 一旦让 `applyStockPreparationPlan` 整段抛出,作业就永久停在 `running`,之后每次 run 都在 `:1269-1276` 抛 409 —— 即 G3 那个死锁态。**G3 从"罕见崩溃"被 L3 抬成"任何一次库错误"**,所以 PR-3 必须排在 G3 修复之后,或自带 catch |
| §3-G3 "代价 = 从 0 重跑 ≈450 s + 一条垃圾 `plugin_kv` 行",并引 `largeBomPull.ts:316` 作为救援路径 | **改正,§3-G3 重写** | 那一行在**同一次拉取内**、紧跟一次全新展开之后:唯一的客户端在 `largeBomPull.ts:253` 无条件 `api.startExpansion(projectNo)` 开**新的展开作业**,面板 `StockPreparationLargeBomPullPanel.vue:161-182` 挂载即跑整链;客户端 API 面只有 `startExpansion`(声明 `:186`,实现 `:395`)与 `startApply`(声明 `:189`,实现 `:417`),**没有"对既有 jobId 再建一个 apply 作业"的入口**。详见 §3-G3 |
| §4.1 代价第 1 条 "**所有插件、所有 UI 的记录操作都走 `loadSheetAndFields`**" | **收紧** | `loadSheetAndFields` 在 `query-service.ts:168` 与 `records.ts:440` 各有一份**未导出**的私有实现;UI/REST 建行走 `record-service.ts`,自己查字段(`:580-583`),不经过它们。改成"`records.ts` / `query-service.ts` 的调用方" |
| §1.2 #6 advisory lock "**无标志门,无条件**" | **收紧** | 它在 `records.ts:673-677` 的 `else` 支(`:675`),flag 开且有 link 计划时改走 `enterLinkWriterFencePlan`(`:673`)。结论(每行建行都取一把 sheet 级 fence)不变,措辞改为"flag 关时走自动编号别名那条" |
| §1.1 "整条写入路径上 HTTP 往返为零",并据此把 `customer-delivery-guide-20260904.md:383` 的"主要是 HTTP 往返"判为"错的" | **收紧,不再判错** | 与本稿 §1.5/§2.1 自己写的"132 批 = 132 次独立 `POST …/apply-jobs/:applyJobId/run`"打架。准确说法:**不是每行一次 HTTP,是每行多次库内往返;每批仍有一次 HTTP**,而每批那次 HTTP 占多少要等 §1.7 M1/M2 |
| §1.2 的"≈3.4 ms/次"与 §1.5 的"≈3.4 s/批"两个不相关的 3.4 相邻出现 | **前者已删,冲突消失** | — |

### 0.3 第三轮里经第四次实读为真、本稿原样保留的

`recordsApi` 是进程内对象的三跳链条;八条路由与八处 `largeBomJobResponse`(全仓恰九处命中);`pluginHttpRoutes` pin 的实算哈希;G1 / G2 的全部证据;`assertLargeBomJobActor` 的静默 no-op;宿主进程无全局 `unhandledRejection` 兜底;两个迁移目录;`plan` / `target` 跨 chunk 不变;C 的四条否决理由;A′ 那 5 条断言内容;`pre_mapped` 模式下作用域包装不额外发语句。

**两条第三轮复核的 minor 经实读为不成立,本稿维持第三轮写法**:
- 路由条数守卫的位置:`plugins/plugin-integration-core/__tests__/stock-preparation-operator-pull-gate.test.cjs:1473`(filter)+ `:1474-1478`(`assert.equal`),**第三轮写的 `:1473-1478` 是对的**,复核给的 `:1475-1479` 落在断言消息与右括号上。
- `plugin-durable-storage.ts` 的 `list`:`:152-164`(`:163` 返回、`:164` 收 `},`),`:165` 是被返回对象字面量的收尾 `}`。**第三轮写的 `:152-164` 是对的**。

---

## 1. 成本的**结构**(不含时间归属)

> 本章只写"发几条语句、开不开事务、取哪把锁"。**它不回答"哪一项吃掉多少时间"** —— 那是 §1.7 的事。

### 1.1 `recordsApi` 是进程内对象,不是 HTTP 客户端(保留,措辞收紧)

三跳:

1. apply run 路由 `plugins/plugin-integration-core/lib/http-routes.cjs:6426`:`createTargetScopedRecordsApi(getMultitableRecordsApi(), pendingJob.target, { fieldIdTranslation: 'pre_mapped' })`
2. `getMultitableRecordsApi()` 在 `http-routes.cjs:3880-3886`,返回 `context.api.multitable.records`(`:3881`)
3. 那个对象由 `packages/core-backend/src/multitable/plugin-scope.ts:389-453` 构造,宿主在 `packages/core-backend/src/index.ts:2050` 接上钩子

**准确的说法**:不是每行一次 HTTP,是**每行多次库内往返**;每批仍有一次 HTTP(132 批 = 132 次 `POST …/apply-jobs/:applyJobId/run`)。每批那一次 HTTP 在总时间里占多少,§1.7 的 M1 与 M2 才能答。

`pre_mapped` 模式下 `createTargetScopedRecordsApi`(`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:940-988`)**不额外发任何语句** —— `:964`/`:977`/`:983` 三处直接透传,只做 `withTargetSheet`(`:955-960`)的 sheet 围栏。所以下面这些往返全部来自宿主层。

### 1.2 一行 `add`(未命中)的语句与**事务**结构

写侧主循环在 `stock-preparation-apply-writer.cjs:540-594`(`for` 在 `:540`,`SKIP`/`MANUAL_CONFIRM` 只计数不落表:`:543-552`)。

**查询段 —— `findExistingRecord`(`:250-267`)→ `recordsApi.queryRecords`。不开事务**(`index.ts:999` 的 `queryRecords` 走裸 `poolManager.get().query`,`:1001`)。

| 标 | 语句 | 出处 |
|---|---|---|
| A | `plugin_multitable_object_registry` 查询 | `plugin-scope.ts:395` 的 `hooks.assertSheetScope` → 宿主 `index.ts:2131` → `assertPluginOwnsSheet`(`plugin-scope.ts:176-194`,SQL `:182`),调用点 `index.ts:2148` |
| B | `SELECT … FROM meta_sheets WHERE id = $1` | `query-service.ts:258` → `loadSheetAndFields` `:168-184`(`:175` `loadSheetRow`)→ `loaders.ts:41-58`(SQL `:47`) |
| C | `SELECT … FROM meta_fields WHERE sheet_id = $1` | `query-service.ts:179` → `loaders.ts:60-76`(SQL `:70`) |
| D | 行 `SELECT`(`limit 2`) | `query-service.ts:317`;调用参数 `stock-preparation-apply-writer.cjs:252-257` |

**写入段 —— `createRecord`(`stock-preparation-apply-writer.cjs:386-389`)。整段被宿主包进一个事务**:`index.ts:1021-1022`(`createRecord: async ({ sheetId, data }) => { return poolManager.get().transaction(…)`)。`records.ts:730-736` 的注释也自陈这一点("`index.ts` wraps every plugin-SDK `createRecord` call in `poolManager.get().transaction(...)`")。

| 标 | 语句 | 出处 |
|---|---|---|
| E | **BEGIN** | `index.ts:1022` |
| F | 又一条 `plugin_multitable_object_registry` | `plugin-scope.ts:399` |
| G | `SELECT pg_advisory_xact_lock(hashtext($1))`(sheet 级 canonical fence) | `records.ts:675` → `auto-number-service.ts:23-27` → `canonical-sheet-fence.ts:81-82`。**在 `:673-677` 的 `else` 支**:writer-fence 标志开且有 link 计划时改走 `enterLinkWriterFencePlan`(`:673`),语句更多 |
| H | 又一条 `meta_sheets` | `records.ts:680` → `loadSheetAndFields` `:440-456`(`:447` `loadSheetRow`) |
| I | 又一条 `meta_fields` | `records.ts:451` |
| J | `INSERT INTO meta_records …` | `records.ts:705-711` |
| K | 修订历史写入 | `records.ts:737` `recordRecordRevision` |
| L | **COMMIT** | `index.ts:1022` 的事务收尾 |

`prepareLinkWriterFencePlan`(`records.ts:664`)、`mintOperation`(`:679`)、`sealOperation`(`:750`)在 `MULTITABLE_ENABLE_WRITER_FENCE` 关时立刻返回、不发语句;开着则每行还要更多。222 上这个标志开没开,本稿无法从代码断定(§7 Q5)。

`UPDATE` / `INACTIVE` 走 `applyPatchDecision`(`:393-413`)→ `patchRecord`,**同样被宿主包一个事务**(`index.ts:1059-1060`);它取的是 `fenceWriterEntry`(`records.ts:536`)而不是 canonical fence,其余形状同量级(`loadSheetAndFields` `:540`、`getRecord` `:551`、锁检查 `:561`、`UPDATE` `:576`、修订 `:634`)。

**这一节能下的结论只有两条,都是结构性的**:
1. 每写一行有**一次独立的持久化提交**(E…L);
2. A/F、B/H、C/I 三对是**同一个常量 `sheetId` 的重复读取**(见 §1.3)。

**它不能下的结论**:这两项各占 453.6 s 的多少。**任何"每语句 X ms""省几成"的算术,在 §1.7 出数之前都不成立。**

### 1.3 常量元数据的重复读取(事实为真,份额**待实测**)

一个 apply 作业里 `sheetId` 恒定:`withTargetSheet`(`stock-preparation-table-actions.cjs:955-960`)把每一次记录调用的 `sheetId` 钉成 `target.sheetId`,不同就 403。于是:

- **A / F**(`plugin_multitable_object_registry`):同一个 `(pluginName, sheetId)`,每行问两遍
- **B / H**(`meta_sheets`):同一个 sheetId,每行读两遍
- **C / I**(`meta_fields`):同一个 sheetId,每行读两遍

**代码里已经有一半的钩子**:`loadFieldsForSheet` 接受可选 `cache`(`loaders.ts:63`,命中 `:65-66`,回填 `:74`),但两个 `loadSheetAndFields` 实现(`query-service.ts:179`、`records.ts:451`)**都不传**;`loadSheetRow`(`loaders.ts:41-58`)根本没有 cache 参数。

**爆炸半径按代码收紧**:`loadSheetAndFields` 是 `query-service.ts:168` 与 `records.ts:440` 两份**未导出**的私有实现;UI/REST 建行走 `record-service.ts`(自己查字段,`:580-583`),**不经过它们**。所以受影响的是"`records.ts` / `query-service.ts` 的调用方",不是"所有插件、所有 UI"。

> **待实测假设**:重复读取确实存在,但它在一次 apply 作业的墙钟里占多少,代码读不出来。§1.7 的 M3 给次数,M4 给时间。

### 1.4 每个 chunk 的固定开销(与 chunk 大小无关,份额**待实测**)

每推进一个 chunk,整份作业对象被**完整读两遍、完整写两遍**:

| 动作 | 出处 |
|---|---|
| 路由侧一次整值读 | `http-routes.cjs:6402-6407` → `loadLargeBomCheckpointApplyJob`(`stock-preparation-large-bom-jobs.cjs:1198-1211`,`storage.get` 在 `:1201`) |
| runner 侧又一次整值读 | `stock-preparation-large-bom-jobs.cjs:1259` |
| 写 `running` 时整份回写 | `:1307` |
| 写 `paused`/终态时整份回写 | `:1334` |

而作业对象里装着**整份 plan**(`plan` 在 `:1179`,`totalDecisions` 在 `:1180`,每条 decision 带行载荷);存储原语是**整值读 / 整值 upsert**:`packages/core-backend/src/plugins/plugin-durable-storage.ts:101-114`(`SELECT value FROM plugin_kv`)、`:115-128`(`INSERT … value = $3::jsonb … ON CONFLICT DO UPDATE`)。多 MB 的 jsonb 会 TOAST。JS 侧还有 `cloneJson`(`:1268` / `:1301` / `:1335`)。

**这项开销随批数线性变化,与每批多少行无关** —— 它正是"chunk 大小"这条杠杆的候选真身。

> **待实测假设**:每批四次整值往返 + 两次全量解析/序列化,在一个 chunk 的墙钟里占多少。§1.7 的 M3 给 `plugin_kv` 的次数,M4 给时间。**在这个数出来之前,不能说 chunk 大小"基本无效",也不能说它"是最大杠杆"。**

### 1.5 两份文档打架,以哪份为准(保留)

- `docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md:383`:"≈3.4s/批,**主要是 HTTP 往返 + 每批落库**"。按 §1.1,"HTTP 往返"这半句**不精确但不算错**——每批确有一次 HTTP;它占多少要等 §1.7。该行同时也记了 `existingRows=0`。
- `docs/development/takeover-beiliao-20260821/48h-autonomous-run-record-20260906.md:52`:同一组数字(试算 6.7s / 展开 8.5s / 规划 2.3s / 写入循环 453.6s ≈3.4s/批 / 驱动总 472.8s / `add 13151` / **`existingRows 0`** / `created 13151`),**没有**那个措辞。

**以 `:52` 为准。** `:383` 那半句建议改为"每批一次 HTTP + 每行多次库内往返,构成待实测"。

另有一处仍需纠正:`48h-…:102`(待拍板第 16 条)写"453.6 秒的写入循环**就是在同一个请求里跑完的**"。按代码这是错的——132 批 = 132 次独立 `POST …/apply-jobs/:applyJobId/run`,`http-routes.cjs:6395-6435` 每次只推进一个 chunk。同一条对**展开** run 的描述("一次 HTTP 请求内同步 await")是对的(`:6290-6310`)。

### 1.6 第三轮那张"语句数预测表"为什么作废

三条理由,任何一条都足够:

1. **它测不出新信息。** 表里"registry ≈ 2N / `meta_sheets` ≈ 2N / `meta_fields` ≈ 2N"这三行由代码结构直接决定(`plugin-scope.ts:395` 与 `:399` 各发一条;`query-service.ts:258` 与 `records.ts:680` 各走一遍 `loadSheetAndFields`),读代码就已确定。
2. **它答不了它自己提的问题。** 表给的是**条数**,而结论要的是**时间份额**。COMMIT(fsync)、TOAST 过的 jsonb 写、`meta_sheets` 主键 SELECT 三者单位成本差一到两个数量级,条数全中也推不出时间归属。
3. **它连自己的预测面都不全。** 表里**一行 `plugin_kv` 都没有**,跑完既证实不了也证伪不了 §1.4 的每批固定开销。

**替代方案见 §1.7。** 它要的是时间,不是条数。

### 1.7 【新增】实测方案(前置于任何取舍)

**约束**:222 上**不改代码、不改 PG 配置**。因此每一项要么读现成的 HTTP 指标端点,要么读 `pg_stat_*` 视图的差分,要么在驱动侧自己记时间。

**先纠正一个前提**:pm2 日志(`ecosystem.config.cjs:71-72` 的 out/err 路径,`:73` 的 `time: true`)只提供**进程级**时间戳与重启事件。写请求日志的 `telemetryMiddleware`(`packages/core-backend/src/middleware/telemetry.ts:44`,收 `:65`、发 `:71-79`)**在全仓没有任何挂载点**(`git grep telemetryMiddleware -- packages/core-backend/src` 只命中定义那一行)。**所以 pm2 日志里没有逐请求的收/发两行,不能用它算每 chunk 墙钟。** 用 M1。

#### M0 前置检查(决定 M4 能不能做)

```sql
SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements';
SHOW shared_preload_libraries;
SHOW track_io_timing;
```

`pg_stat_statements` 若没装,装它要改 `shared_preload_libraries` 并重启 PG —— 属于"改 PG 配置",本方案不做,**M4 直接跳过,退到 M5**。

#### M1 —— 服务端每 chunk 墙钟(零代码,机制已在代码里)

链条逐条实读:

- 插件八条路由全部经 `context.api.http.addRoute` 注册:`plugins/plugin-integration-core/lib/http-routes.cjs:9549`(路由表 `:66-73`);
- 宿主的 `addRoute` 在 `finally` 里结束计时:`packages/core-backend/src/index.ts:666`(取 `__metricsTimer`)、`:677`(`endTimer({ route: path, method: req.method })(res.statusCode)`)。**`route` 标签是注册时的路径模板**,`:actionId` / `:jobId` / `:applyJobId` 保持占位符 → **values-free**;
- 计时器由 `requestMetricsMiddleware` 安装(`packages/core-backend/src/metrics/metrics.ts:705-720`,起点 `:706`),中间件挂在 `index.ts:1606`;
- 指标已注册进 registry:`metrics.ts:540`(histogram)、`:541`(summary)、`:542`(counter);定义在 `:33-38`(`http_server_requests_seconds`,桶 `:37`,上限 5 s)、`:40-45`(`http_server_requests_seconds_summary`,分位 `:44`)、`:47-51`(`http_requests_total`);
- 端点由 `installMetrics`(`metrics.ts:688-698`)挂在 `index.ts:1605`:`GET /metrics`(JSON)与 `GET /metrics/prom`;鉴权 `createMetricsAuthMiddleware`(`:669-686`)在**未配置抓取令牌时直接放行**(`:672`)。

**做法**:apply 作业开跑前、跑完后各抓一次 `/metrics/prom`,对这条 label 取差分:

```
route="/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId/run"
method="POST"  status="200"
```

**要记的字段**:`http_server_requests_seconds_sum`、`http_server_requests_seconds_count`、各 `http_server_requests_seconds_bucket{le=…}`。

**得到**:`(Δsum) / (Δcount)` = **每 chunk 的服务端处理墙钟均值(秒)**。

两条注意:summary 的**分位数是进程生命周期累计、不能差分**;可差分的是 summary 与 histogram 的 `_sum`/`_count` 以及 histogram 的桶。桶上限 5 s(`metrics.ts:37`)意味着超过 5 s 的 chunk 只落在 `+Inf`,分布只能看个粗轮廓,**均值仍然准确**。

#### M2 —— 驱动侧每 chunk 往返墙钟

两条路,取其一:

- **(a)** 222 上那支驱动脚本(`large-bom-drive.cjs`)若已记 `timingsMs`,直接用。**本稿无法核实它**:`git ls-tree -r origin/main` 无此文件,全仓 `git grep timingsMs` 零命中 —— 它不在仓里,**字段名与语义要在 222 上先确认再用**。
- **(b)** 不依赖它:用一段只发 HTTP 的循环(PowerShell / curl),每次 `POST …/apply-jobs/:applyJobId/run` 前后各取一次本机时间戳,记 `startedAt / endedAt / HTTP 状态 / counts`。产品侧驱动每批之间固定 `await wait(2000)`(`largeBomPull.ts:344`,`intervalMs = 2000` `:235`);**手写循环里不要加这个 sleep**,否则测出来的仍是客户端等待。

**M2 与 M1 之差 = 网络 + 客户端间隔。** 453.6 s 里有多少不是服务端时间,只有这一步能答。

#### M3 —— PG 侧表级与事务级差分(只读,不改配置)

一次 apply 作业前后各取一次,按差分记:

```sql
SELECT relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch, n_tup_ins, n_tup_upd
FROM pg_stat_user_tables
WHERE relname IN ('meta_sheets','meta_fields','meta_records','meta_record_revisions',
                  'plugin_multitable_object_registry','plugin_kv');

SELECT xact_commit, xact_rollback, tup_returned, tup_fetched, tup_inserted, tup_updated,
       blks_read, blks_hit, blk_read_time, blk_write_time
FROM pg_stat_database WHERE datname = current_database();
```

**它能答的**:

- `xact_commit` 的差分与写入行数的关系 → 直接证实/证伪 §1.2 的"每行一次提交"(E…L);
- `plugin_multitable_object_registry` / `meta_sheets` / `meta_fields` 的 `idx_scan` 差分与行数的比值 → 证实/证伪 §1.3 的"每行两次常量元数据读";
- `plugin_kv` 的 `idx_scan` / `n_tup_upd` 差分与批数的比值 → 证实/证伪 §1.4 的"每批四次整值往返";
- `blk_read_time` / `blk_write_time` 只在 `track_io_timing = on` 时非零(M0 里查,**不改**)。

**它答不了的**:时间归属。**表级计数不是时间。**

#### M4 —— 语句级时间归属(仅当 M0 显示 `pg_stat_statements` 已装)

```sql
SELECT queryid, calls, total_exec_time, mean_exec_time, rows, left(query, 120) AS q
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 40;
```

作业前后各取一次,按 `queryid` 差分,记 `Δcalls`、`Δtotal_exec_time`、`Δtotal_exec_time / Δcalls`。**这是唯一能给出"哪条语句吃掉多少时间"的读取。** `query` 是参数化后的模板,不含客户值;截断后仍要人工过一眼再落盘。

#### M5 —— 采样式补充(M4 不可用时的替代,精度低)

在一个 chunk 运行期间以固定间隔(如 100 ms)采样:

```sql
SELECT state, wait_event_type, wait_event, left(query, 80) AS q
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle';
```

按 `(wait_event_type, q)` 归类计数,得到一个粗糙的时间分布。样本量小、对 3 s 级 chunk 勉强够用,**只能作为 M4 缺席时的方向性证据,不能当结论**。

#### 要记录的最小字段集

| 来源 | 字段 |
|---|---|
| M1 | route / method / status、`_sum`、`_count`、各 `le` 桶、两次抓取时刻 |
| M2 | 每 chunk 的 `startedAt` / `endedAt` / HTTP 状态 / `counts` |
| M3 | 上面两条 SQL 的全部列,前后各一份 |
| M4 | `queryid`、`Δcalls`、`Δtotal_exec_time`、`Δmean` |
| 环境 | M0 三条 `SHOW` 的结果;pm2 `instances` / `exec_mode`(`ecosystem.config.cjs:60-61`);作业的 `totalDecisions` 与最终 `counts`;`MULTITABLE_ENABLE_WRITER_FENCE` 是否开 |

#### 哪些结论要等这次实测才能下

1. **453.6 s 里服务端占多少、客户端固定等待占多少**(M1 vs M2)。在此之前,任何"每行 X ms""每语句 Y ms"都不成立。
2. **每行是不是真的一次提交,提交在总时间里占多少**(M3 的 `xact_commit` + M4)。这是 **L3 值不值得做**的唯一依据。
3. **常量元数据重读在总时间里占多少**(M3 给次数,M4 给时间)。这是 **L1 值不值得做**的唯一依据。
4. **每 chunk 的 `plugin_kv` 整份读写在总时间里占多少**(M3 给次数,M4 给时间)。这是 **chunk 大小(PR-5)有没有杠杆**的唯一依据。
5. **L1 / L2 / L3 / PR-5 的先后顺序。在 M1–M4 出数之前,本稿不给排序。**

**这个动作是 ops 侧的,不占 PR 队列,不依赖任何前置,不改代码也不改 PG 配置。**

---

## 2. 现状盘点

### 2.1 路由面:八条(全部第四次核实)

注册在 `http-routes.cjs:66-73`,统一经 `context.api.http.addRoute` 挂载(`:9549`)。

| 方法 | 路径尾段 | handler | handler 行 | 返回行 | 状态码 | 网关 |
|---|---|---|---|---|---|---|
| POST | `…/large-bom/expansion-jobs` | `…ExpansionJobStart` | `:6187` | `:6209` | **202** | `read` |
| GET | `…/expansion-jobs/:jobId` | `…ExpansionJobGet` | `:6212` | `:6223` | 200 | `read` |
| POST | `…/expansion-jobs/:jobId/run` | `…ExpansionJobRun` | `:6226` | `:6311` | 200 | `read` |
| POST | `…/expansion-jobs/:jobId/plan` | `…ExpansionJobPlan` | `:6314` | `:6353` | 200 | `read` |
| POST | `…/:jobId/apply-jobs` | `…ApplyJobStart` | `:6356` | `:6376` | **202** | `write` |
| GET | `…/apply-jobs/:applyJobId` | `…ApplyJobGet` | `:6379` | `:6392` | 200 | `read` |
| POST | `…/apply-jobs/:applyJobId/run` | `…ApplyJobRun` | `:6395` | `:6434` | 200 | `write` |
| POST | `…/expansion-jobs/:jobId/cancel` | `…ExpansionJobCancel` | `:6437` | `:6450` | 200 | `write` |

**八个返回全部过 `largeBomJobResponse(...)`** —— `grep` 全仓仅九处命中该符号:定义 `:4006`,加上上表八处 `:6209 / 6223 / 6311 / 6353 / 6376 / 6392 / 6434 / 6450`,一个不漏、一个不多。

`largeBomJobResponse` 定义在 `:4006-4015`,上面 `:3980-4005` 是 FRESHNESS-DIVERGENCE NOTICE:大 BOM 路径不供 `installedFieldProperties` / `extFieldMapping`,`ext_` 列会停在旧 epoch 而周围规范列刷到今天,这条分歧被要求在这一族的**每个响应上显式声明**。函数体是条件挂载(`:4007` 无映射时原样返回),这正是"未配置映射时字节不变"那条惰性保证的来源。

**任何改写这一族任一响应的方案,都必须保留这层包装。**

三条附带事实:

1. **`run` 在一次请求内同步跑完整展开**:`:6290-6310` 直接 `await runLargeBomBackgroundExpansionJob(...)`。
2. **apply run 每次只推进一个 chunk,chunk 大小恒为 100**:路由不传 `maxDecisionsPerChunk`(`:6427-6433`)→ 回落 `LARGE_BOM_APPLY_DEFAULT_CHUNK_SIZE = 100`(`stock-preparation-large-bom-jobs.cjs:101`,经 `:1293` → `normalizeChunkSize` `:1060-1071`)。请求体被 `VALID_EMPTY_REQUEST_KEYS`(`http-routes.cjs:1566`,在 `:6398` 引用)钉成空集。
3. **apply 作业没有 cancel 路由**。只有展开有(`cancelLargeBomBackgroundExpansionJob`,`stock-preparation-large-bom-jobs.cjs:645-673`)。

另:apply chunk 运行器**接受** `installedFieldProperties`(`stock-preparation-large-bom-jobs.cjs:1322`,注释 `:1319-1321`),但路由 `:6427-6433` **从不传**;全仓只有三处传它,全是小 BOM 路由(`http-routes.cjs:5812 / 5979 / 6156`)。**记录,本稿不改。**

### 2.2 展开作业状态机

- 枚举 `stock-preparation-large-bom-jobs.cjs:29-37`,七个。
- **实际被赋值的**:`queued`(`:602`)、`running`(`:933`)、`completed`、`failed`(`:952`)、`cancelled`(`:667`)。
- `paused`:`:32`(枚举)+ **`:922`(run 入口允许列表 `['queued','running','paused','failed']`)**,从不被赋值——是"可作为入口态"的死状态。
- `expired`:`:36`(枚举)+ `:666`(cancel 跳过列表),两处都不赋值。
- 转移:`completed` 早返回幂等(`:921`);不在 `:922` 列表的 → 409 `LARGE_BOM_JOB_RUN_REJECTED`(`:923-928`)。**`running` 在允许列表里**,崩溃后重跑不会被拒。
- 一次 run:`:933-941` 先写 `running` + `budgets` 落库,再 `await expandPlmProjectBom`(`:945-949`);失败走 catch(`:950-`)。
- **展开侧没有分片**:`progress.frontierRemaining` 恒为 0(`:834`),`completedChunks` 只取 0/1(`:835`),`LARGE_BOM_ARTIFACT_CHUNK_COUNT = 1`(`:99`,注释 `:93-98` 自陈"`maxArtifactChunks` 是形状描述,不是预算")。**谈不上"续跑",只有"重跑"。**
- **展开侧没有单飞锁**:全文件只有一个模块级 `Set`(`:103`),只服务 apply;`runLargeBomBackgroundExpansionJob`(`:908-`)不取任何锁。

### 2.3 apply 作业状态机

- 枚举 `:39-48`,八个。
- **实际被赋值的**:`queued`(`:1164`)、`running`(`:1305`)、`paused`(`:1332`)、`succeeded` / `partial`(`terminalApplyStatus` `:1231-1234`,`failed>0 || held>0` 判 `partial`)。
- **`failed` / `cancelled` / `expired` 在 apply 侧从不被赋值**(`cancelled` 在**展开侧** `:667` 是被赋值的)。`failed` 出现在 `:1277` 的重跑允许列表 `['queued','paused','failed']`。
- 推进单元 `runLargeBomCheckpointApplyJobChunk`(`:1254-1339`):取锁 `:1257` → `storage.get` `:1259` → 终态早返回 `:1268` → `running` 拒 409 `:1269-1276` → 状态白名单 `:1277-1284` → `start = nextDecisionIndex(job)` `:1295` → 写 `running` 落库 `:1304-1307` → `end = min(start+chunkSize, len)` `:1309` → 切片 `:1312` → `applyStockPreparationPlan` `:1314-1324` → 合并计数 `:1326-1327` → 写 checkpoint `:1328-1331` → 状态 `paused` 或终态 `:1332` → 落库 `:1334` → **`finally` 放锁 `:1336-1338`**。
- **锁是"每 chunk 取一次、放一次"**,不是"整条循环持一次"。
- **`:1304-1307` 与 `:1332-1334` 之间没有 catch**,只有 `finally` 放锁(`:1336-1338`)。任何从 `applyStockPreparationPlan` 整段抛出的错误都让作业永久停在 `running`(见 §3-G3、§4.3)。

### 2.4 存储键与存储原语

- 存储契约 `ensureDurableJobStorage`(`:487-507`)只要求 `durable === true` + `get`/`set`,否则 501。
- 后端实现 `packages/core-backend/src/plugins/plugin-durable-storage.ts:95-165`,落 `plugin_kv`:`get` `:101-114`;`set` `:115-128`(**无条件 upsert,无 CAS**);**`consume` `:129-141`(`DELETE … RETURNING`,现成的原子领取原语)**;`delete` `:142-151`;`list` `:152-164`(`WHERE plugin = $1 ORDER BY key ASC`,按插件过滤、无 key 前缀过滤)。
- **`stock-preparation-large-bom-jobs.cjs` 全文没有 `storage.delete`、没有 `consume`、没有 TTL / 过期回收**(`expired` 只出现在两个枚举 `:36` / `:47` 与 cancel 跳过列表 `:666`)。作业行永不回收。
- `workspaceId` 在路由侧兜底成字面量 `'workspace-default'`(`http-routes.cjs:1266-1272`)。

### 2.5 幂等 / 续跑语义

| 层 | 幂等靠什么 | 崩溃后能否续 | 依据 |
|---|---|---|---|
| 展开 `run` | `completed` 早返回 | **不能续,只能整体重跑** | `:921`、`:834`、`:99` |
| 展开重跑代价 | 重读源、重计 B2a 页数 | 同 `jobId` 复用同一 claim | `:922`、`b2a-trial-registry.cjs:1110-1118` |
| apply chunk | `checkpoint.nextDecisionIndex` 单调推进 | **同一 applyJob 内能续**;卡在 `running` 时永远拒 | `:1295`、`:1269-1276` |
| **重开一个 applyJob** | 库函数层面可行(`:1128-1196` 对"已存在 apply 作业"零限制,`planArtifact` 留在展开作业 `:1376-1385`) | **库层能,产品里够不着** —— 客户端没有这个入口(§3-G3) | `:1128-1196`、`largeBomPull.ts:253` / `:316` |

### 2.6 B2a 授权与 `requireCompleteBatch`

`run` 路由授权段 `http-routes.cjs:6226-6289`:

- **顺序**:`requireTableActionAccess`(`:6228`)→ 载入存储作业(`:6232-6237`)→ `assertLargeBomJobActor`(`:6246`,定义 `:4422-4427`)→ B2a(`:6258-6280`)→ 才 `loadTableActionSourceAdapter`(`:6286-6289`)。注释 `:6244-6245` / `:6255-6257` 明说:拒绝要早于 claim 与凭据查找。
- **Run 身份 = `large-bom:${jobId}`**(`:6278`)。`claimReadOperation`(`b2a-trial-registry.cjs:1081-1119`)对同 runId 允许重入(`:1110-1118` 走 `pageReads` 累加),**不同 Run 拒 `operation_already_consumed`**(`:1103-1108`)。准确说法是"同一个 jobId 被**它的创建者**在任何进程、任何次数驱动,claim 语义不变"——`assertLargeBomJobActor` 先把非创建者挡在 claim 之前。
- `requireCompleteBatch: Boolean(largeBomB2aAuthorization)`(`:6308`):E3-02 的断游标半边,**ARMED-ONLY**,注释 `:6302-6309` 自陈。
- 读身份用**存储作业的 `principal`**(`:6287`),不是触发者;`principal` 与 `actor` 在创建时就拆成两个字段(`stock-preparation-large-bom-jobs.cjs:580-585`、`:606-607`)。

### 2.7 客户端驱动

`apps/web/src/services/integration/stockPreparation/largeBomPull.ts`:

- 模块头 `:12-23` 把话说死:**"nothing on the server advances a large-BOM job between calls"**,所以"轮询"= 每 tick 重发 `run`。
- 客户端 API 面只有两个入口:`startExpansion`(声明 `:186`,实现 `:395`)与 `startApply`(声明 `:189`,实现 `:417`)。
- **每次拉取都从一次全新展开开始**:`:253` 无条件 `api.startExpansion(projectNo)`;`:316` 的 `api.startApply(state.jobId)` 用的是**这次新开的** jobId。**没有"对既有 jobId 再建一个 apply 作业"的入口。**
- `intervalMs = 2000`(`:235`)、`maxExpansionTicks = 60`(`:237`)、`maxApplyTicks = 500`(`:238`)。
- apply 循环 `:328-345`:`isCancelled()` 在 `:334` 与 `:343`,终态 break 在 `:342`,`wait(intervalMs)` 在 `:344`。
- 面板 `apps/web/src/components/integration/stockPreparation/StockPreparationLargeBomPullPanel.vue`:`onMounted` `:161-182` 挂载即跑整链;`onUnmounted` `:184-190` 置 `cancelled = true`(`:189`),注释 `:185-188` 自陈其保证是"阻止它再发一次 API 调用"——**只在两次调用之间生效,拦不住在飞的那一次**。

### 2.8 守卫清单

**(a) 源码级计数 / 逐字钉住守卫(改了就红,或改了就要一起改)**

| 守卫 | 位置 | 钉住什么 |
|---|---|---|
| 一线准入 step 逐字 `deepEqual` | `__tests__/stock-preparation-operator-pull-gate.test.cjs:1189-1208` | **11 个 step 名**,按序 |
| 大 BOM 路由**条数**必须等于清单条数 | 同文件 `:1473`(filter)+ `:1474-1478`(`assert.equal`) | `[…routes.keys()].filter(k => k.includes('/large-bom/')).length === LARGE_BOM_ROUTES.length` |
| 后端清单本体 | `lib/stock-preparation-workbench-access.cjs:250`,八条大 BOM 在 `:280-327` | 路径 + method + legacyGate |
| **前端镜像清单** | `apps/web/src/services/integration/stockPreparation/workbenchAccess.ts:53-123` | 同一份清单的第二份拷贝 |
| **前后端逐字段 `toEqual`** | `apps/web/tests/StockPreparationProjectBoard.spec.ts:329-334` | 两份清单必须字节镜像 |
| 两个状态枚举整数组 `deepEqual` | `__tests__/stock-preparation-large-bom-jobs.test.cjs:352-372` | `LARGE_BOM_BACKGROUND_EXPANSION_STATUSES`(`:353-361`)与 `LARGE_BOM_CHECKPOINT_APPLY_STATUSES`(`:362-371`)逐字 |
| apply evidence 投影整对象 `deepEqual` | 同文件 `:493-542`,断言在 `:521-540`,后接 `assertValuesFree` `:541` | `summarizeLargeBomCheckpointApplyJobForEvidence` 的**全部**返回键,evidence 只允许三键(`:535-539`) |
| apply 公开投影 values-free 断言 | 同文件 `:2064` | `assertValuesFree(publicCheckpointApplyJob(loaded))` |
| 展开作业"只由创建者驱动" | `__tests__/stock-preparation-operator-pull-gate.test.cjs:493-530` | 同租户同层级的另一个操作员(`:514`)拿到 jobId → 403 `LARGE_BOM_JOB_ACTOR_MISMATCH`(`:516-521`) |
| apply 进程内单飞(在飞时) | `__tests__/stock-preparation-large-bom-jobs.test.cjs:1947-1992` | 第一个 chunk 在飞时,第二次调用 409(`:1980-1983`),且目标表 0 行(`:1984`) |
| apply 库侧 `running` 拒绝(持久行) | 同文件 `:1994-2065` | 手工把行改成 `running`(`:2023`)并落库(`:2038`)→ 409(`:2040-2052`)、目标表仍 1 行(`:2053-2055`)、**且行仍是 `running`(`:2063`)** |
| 沙箱门"开火早于任何写" | `__tests__/http-routes.test.cjs:5536-5554` | 无沙箱配置的 mount → 403(`:5548-5549`)且写入计数不变(`:5550-5554`) |

**(b) 运行时数值上限**

| 上限 | 值 | 位置 |
|---|---|---|
| apply chunk 默认 / 硬顶 | 100 / 1000 | `stock-preparation-large-bom-jobs.cjs:101` / `:102`,`normalizeChunkSize` `:1060-1071` |
| artifact 分片数 | 恒 1 | `:99` |
| 读回计数器天花板 | 1e6 | `clampStoredTotal` `:210-216` |
| 既有行分页 | 1000 × 100 页 | `stock-preparation-table-actions.cjs:106-107` |
| 大 BOM 背景 caps 字段集 | 只有四个 | 同文件 `:336`,ceilings `:345-350`,校验器 `:361-395`(未知键当场 422:`:366-370`,throw 在 `:368`) |
| 生产干净行上限 | 策略给 | `assertProductionCleanRowsWithinBound`,同文件 `:1861` |

**(c) 钉住文件**

- `lib/sealed-export/sealed-export-package-provenance.cjs` 的 `PINNED_RUNTIME_FILES` **从 `:206` 起**(`testChainRunner` `:229-232`,`s6aProvisioningCli` `:233-237`,`s6aAcceptanceRunner` `:238-`),`pluginHttpRoutes` 在 **`:219-222`**。
- 哈希在 `lib/sealed-export/vectors/s6a-package-provenance-pins.json:73`。**本轮实算复核仍一致**:`sha256(origin/main:plugins/plugin-integration-core/lib/http-routes.cjs)` = `56cd0d533aa5fc75efd5984d40349121047af6ecaae3387e903648571f57001b`。`pluginPackageJson` 在 `:70`。
- **`stock-preparation-large-bom-jobs.cjs` 与 `stock-preparation-apply-writer.cjs` 都不在任何 pin 列表里**(provenance 文件全文 grep `large-bom|largeBom|apply-writer` 零命中)。
- 排队纪律出处 `docs/development/takeover-beiliao-20260821/stock-preparation-overall-plan-20260902.md:166`,原文只写"改 `package.json` 测试链或 `pluginPackageJson` pin 的 PR 单独排队合",**没写 `pluginHttpRoutes`**;结论仍成立(两个 pin 同住一个 JSON 文件,任何两支都会冲),但引文不逐字对应。
- `__tests__/stock-preparation-apply-writer.test.cjs` **已存在**且已在测试链(`plugins/plugin-integration-core/package.json:64`),往它加用例**不碰测试链、不重钉 `pluginPackageJson`**。

**(d) 能力可达性守卫——不要高估它**

`__tests__/plugin-capability-reachability.test.cjs` 头注释 `:44-50` 自陈是**声明式**的:"THE DECLARED SET IS NOT DISCOVERED. A capability nobody adds below is not checked",并写明今天就有 **30 / 152** 个 `lib/**.cjs` 模块不可达于任何 production 根。新 worker 模块不加声明不会红。

---

## 3. 三个安全缺口

三条都不是本设计引入的,但每个方案都会放大它们。**这一章不依赖任何未测数字。**

### G1 —— apply 作业没有 actor 守卫,写侧比读侧弱一层(成立,不变)

- 展开侧:作业记 `actor`(`stock-preparation-large-bom-jobs.cjs:585`、`:607`),run 前过 `assertLargeBomJobActor`(`http-routes.cjs:6246`),并被 `operator-pull-gate.test.cjs:493-530` 钉死。
- apply 侧:`createLargeBomCheckpointApplyJob`(`:1128-1196`)落的字段里**没有 `actor`,也没有顶层 `principal`**(作业形状 `:1159-1193`;触发者只被存进 `approval.principal` `:1168-1173`)。
- apply-start(`http-routes.cjs:6356-6377`)与 apply-run(`:6395-6435`)**都没有任何创建者校验**。run 只有 `assertApplyJobMatchesExpansion`(`:6408`,实现 `:2820-2826`)——比对的是 `applyJob.sourceJobId === jobId`,**是 jobId 配对,不是人**。
- 而 `large-bom-apply-start` 与 `large-bom-apply-run` 都在一线准入清单里(`workbench-access.cjs:304-321`)。

**后果**:同租户同 workspace 的另一个操作员,拿到一对 `(jobId, applyJobId)` 就能把别人的 checkpoint apply 用**别人作业里存的 permission**(`:1174`)推到底;甚至能对别人的展开作业**新建**一个 apply 作业。

**便宜的修法,以及两个坑**:

1. `assertLargeBomJobActor` 取值是 `job.actor || job.principal`(`http-routes.cjs:4423`),apply 作业两个字段都没有 → `:4424` 因 `owner` 为空**静默早返回**,是个 no-op。必须先在 `:1159-1193` 落 `actor`。
2. **对存量行仍是 fail-open**:已经躺在 `plugin_kv` 里的 apply 行永远不带新字段。补法是把回退链延到 `job.approval.principal`(`:1168-1173`,值现成)——但那要改 `assertLargeBomJobActor` 本体,而它在 `http-routes.cjs` 里(重钉 pin)。
3. **apply-start 的校验位置**:该路由(`:6356-6377`)**从不加载展开作业**,`sourceJob` 是在库函数内部 `:1133-1138` 才载入的。所以校验要么放进 `createLargeBomCheckpointApplyJob`(推荐,落点全在未钉住的模块侧),要么路由自己多做一次 `storage.get`。

### G2 —— cancel 路由的注释断言了代码没强制的事(成立,不变)

`workbench-access.cjs:278-279` 写着 cancel "**stops a job THIS caller started**"。但 `tableActionLargeBomExpansionJobCancel`(`http-routes.cjs:6437-6451`)没有 actor 校验,只把 `principal: requestPrincipal(req)` 传下去(`:6448`);`cancelLargeBomBackgroundExpansionJob`(`stock-preparation-large-bom-jobs.cjs:645-673`)对它只做 `requiredPrincipal(input.principal)` 的**形状检查**(`:647`),从不与 `job.actor` 比对。

### G3 —— apply 的 `running` 是死锁态(**第三轮的降级被撤回**)

**事实层不变**:进程在 `:1307`(写 `running`)之后、`:1334`(写 `paused`)之前挂掉,库里就永远是 `running`,之后每次 run 都在 `:1269-1276` 抛 409。没有 TTL、没有 reaper、没有 apply 侧 cancel 路由(§2.4:全文件无 `storage.delete` / `consume` / TTL)。

**第三轮说"数据救不回来是错的,再建一个 apply 作业即可,代价只是一条垃圾行" —— 这个降级本轮撤回,理由三条:**

1. **救援路径在产品里够不着。** 库函数层面确实可行(`createLargeBomCheckpointApplyJob` `:1128-1196` 对"已存在 apply 作业"零限制,`planArtifact` 留在展开作业 `:1376-1385`,`assertApplyJobMatchesExpansion` `http-routes.cjs:2820-2826` 只比 `sourceJobId`)。但**客户端没有这个入口**:唯一的驱动在 `largeBomPull.ts:253` 无条件开**新的展开作业**,`:316` 的 `startApply` 用的是新 jobId;面板 `StockPreparationLargeBomPullPanel.vue:161-182` 挂载即跑整链。要走那条路径得**直接手打 `POST …/expansion-jobs/:jobId/apply-jobs`**。
2. **一线的真实恢复动作是整条重拉**:源重读 + 重展开 + 重规划 + 完整写入。而**新展开作业 = 新 jobId = 新 Run 身份 `large-bom:${jobId}`**(`http-routes.cjs:6278`);B2a 注册表**武装时**会以 `operation_already_consumed` 拒掉不同 Run(`b2a-trial-registry.cjs:1103-1108`,只有同 runId 才走 `:1110-1118` 的重入),即还需要 owner 侧补一张新注册。222 是否武装,是 §7 的待答项。
3. **留存面被低估**:那一行装的是**整份 plan**(每条 decision 带行载荷)。§2.4 已核实:该文件无 `storage.delete` / `consume` / TTL,而客户端每次拉取都无条件新建一个 apply 作业(`largeBomPull.ts:316`)。反复拉取同一个项目会**按 MB 级持续堆积客户原始值的副本,永不回收**。

**给 owner 的代价一栏应写**:"整条重拉(源重读 + 重展开 + 重规划 + 完整写入)+ 一份永不过期的整表载荷副本 + 武装态下可能还要补一张 B2a 注册"。**G3 不是"该修但不阻塞任何东西"** —— 见 §4.3:L3 会把它的触发条件从"罕见崩溃"抬成"任何一次库错误"。

多实例下另有一层:进程内单飞是 `activeCheckpointApplyRuns = new Set()`(`:103`),在 `ecosystem.config.cjs:60-61` 的 `instances: 1, exec_mode: 'fork'` 下是真锁;多实例下不是,而库侧 `:1269` 那道检查是 read-then-write、`plugin_kv.set` 无 CAS(`plugin-durable-storage.ts:115-128`),所以是 TOCTOU,**不是保证**。

---

## 4. 三个性能杠杆 + 四个搬运方案

**先分清两件事**:①"让它快"和 ②"让它别丢"。§4.1–4.3 只谈快,§4.4–4.7 只谈丢。

> **§4.1–4.3 的"收益"一栏在本稿里一律是"待实测"。** 每条杠杆下面写的是**它改什么结构、改什么语义、动哪些文件**,以及**§1.7 的哪一项能判它值不值得做**。

### 4.1 L1 —— 常量元数据不再逐行重读

**形状**:给 `loadSheetAndFields` 一个**调用链作用域**的缓存。`loadFieldsForSheet` 已经支持(`loaders.ts:63` 参数、`:65-66` 命中、`:74` 回填),两个调用点(`query-service.ts:179`、`records.ts:451`)不传;`loadSheetRow`(`loaders.ts:41-58`)需要新增同样的参数。再把 `assertSheetScope` 的结果在一个 chunk 内按 sheetId 记忆一次。

**它改什么**:§1.2 的 A/F、B/H、C/I 三对重复读取合并成各一次。**次数减少是确定的;时间减少多少,由 §1.7 的 M3(次数)+ M4(时间)判。**

**三条代价**:

1. **这是共享路径,但爆炸半径比第三轮写的小。** `loadSheetAndFields` 是 `query-service.ts:168` 与 `records.ts:440` 两份**未导出**的私有实现;UI/REST 建行走 `record-service.ts`(自己查字段 `:580-583`),不经过它们。受影响的是"`records.ts` / `query-service.ts` 的调用方"。缓存必须绑在一次调用链(一个 chunk 或一个请求)上,不能是进程级,否则并发的字段/表头变更看不见。
2. **`assertSheetScope` 是一道安全钩子,记忆化改的是它的调用频率。** 论证:`withTargetSheet`(`stock-preparation-table-actions.cjs:955-960`)把每次调用的 `sheetId` 钉成 `target.sheetId`,不同就 403,所以**一个 chunk 内被断言的 `(pluginName, sheetId)` 集合恒为单元素**,记忆化不缩小被断言的集合。论证完整,但仍要 owner 明确点头。
3. **"调用链作用域"没有现成落点。** `createPluginScopedMultitableApi` 在 `index.ts:2050` 每个插件只构造一次,`plugin-scope.ts:389-413` 的闭包里没有 chunk / 请求边界可绑;而 `loadSheetAndFields` 是模块私有函数,cache 要从 `index.ts:999-1100` 的 records 门面一路穿进去。**所以这不是"给 `loadSheetRow` 加可选参数 + 两处透传",而是改插件可见的记录 API 入参形状(或引入隐式上下文)。**

**落点**:`packages/core-backend`,不碰任何插件 pin;按宿主改动评审,不能塞进备料的波次。

### 4.2 L2 —— 削掉存在性查询(原方案 D)

**形状**:chunk 开始时一次批量读拿到本批 key → recordId 映射,`findExistingRecord`(`stock-preparation-apply-writer.cjs:250-267`)命中即用。

**它改什么**:§1.2 查询段的 A–D 四条,在**命中时**省掉。

**三条约束**:

1. **在被实测的那次负载上,按规则 (a) 收益为 0。** `48h-…:52` 记 `existingRows 0`,存在性查询全部落空;在"未命中回退单行查询"的规则下一次也省不掉。而 owner 要拍的恰恰是首次导入。
2. **它借的读取器不能用。** `readExistingStockPreparationRows`(`stock-preparation-table-actions.cjs:785-810`)每行过 `unmapRecordFields`(`:774-783`),只回投 `record.data` 的字段,**顶层 `id` 被丢掉**(行形状 `query-service.ts:224-241`,`id` 在 `:231`),而 `id` 正是 patch 要用的值(`apply-writer:377-383`、`:407-411`)。它还按 `projectNo` 过滤(`:790-792`)、分页 1000×100(`:106-107`),按每 chunk 调一次算,第 k 批要读回前 k-1 批自己刚写的行。要做 L2 **必须自写一个 chunk 级读取器**(按本 chunk 的 key 集合查、回投 `record.id`)。
3. **安全规则是个真的二选一,owner 必须选**:
   - **(a) 未命中回退单行查询** —— 保住 `apply-writer:261-265` 的 `duplicate_target_key` 唯一性守卫,但首次导入零收益;
   - **(b) 未命中即视为不存在** —— 才有收益,但把唯一性守卫从**写入时刻**退到**预读时刻**。
   **按 §4.3 订正后的锁事实**:所有**建行**路径(插件 `createRecord`、UI/REST `record-service.ts:573`、UoW)取的都是同一把 sheet 级 canonical fence,所以 (b) 的残余窗口比第三轮写的**窄**;剩下的窗口在 patch 路径(`records.ts:536` 的 `fenceWriterEntry`,不取 canonical fence)与纯读者,而 patch 建不出重复行。

**改动面**:`lib/stock-preparation-apply-writer.cjs` + `lib/stock-preparation-large-bom-jobs.cjs`,**两个都不在 pin 列表**;不碰路由、不重钉 pin。注意 `applyStockPreparationPlan` 起始行是 **`:512`**,它头上 `:507-511` 有一段 SECURITY 注释,明写"这是 stock-prep apply 的**唯一写入咽喉**,任何新调用方必须套同一道门"——改这个函数签名时要连它一起读。

### 4.3 L3 —— 一个 chunk 一个事务(接口已有;**语义变化最大的一条**)

**宿主接口存在。** `records` 对象上第七个方法就是 `runStockPreparationPersistUnitOfWork`(`plugin-scope.ts:414-452`),宿主实现是 `index.ts:2162-2211`:校验器 `:2166` → `poolManager.get().transaction(...)` `:2167`,事务内先逐 sheet 过归属(`:2180-2185`,未注册即抛 `unclaimed`),再取锁(`:2186`),然后把**事务内的** `queryRecords`/`createRecord`/`patchRecord` 交给回调(`:2188-2209`)。已有活的调用方:`stock-preparation-sync-run-persist.cjs:642-656`。

**它改什么结构**:把一个 chunk 的 100 行合并成一个事务,消掉每行一次的 BEGIN/COMMIT(§1.2 的 E 与 L)。**这项开销确实存在且无条件(`index.ts:1021-1022`),但它在总时间里占多少,由 §1.7 的 M3(`xact_commit` 差分)+ M4(时间)判。**

**挡路的一:宿主校验器,而且不是一个长度判断。** `validateStockPreparationPersistUnitOfWorkInput`(`stock-preparation-persist-unit-of-work.ts:30-53`)同时要求:

- `sheetIds.length !== 4 || new Set(sheetIds).size !== 4` 就抛(`:38`);
- `project.projectId` 必须是非空串(`:43`);
- `batch.snapshotBatchId` 必须是非空串(`:47`);
- 两个 sheetId 必须落在 `sheetIds` 集合里(`:50-52`)。

而 `:87-94` 那两把 advisory lock 的**键就是从这两组值算出来的**(`stockPreparationProjectLockKey` `:56-63`、`stockPreparationBatchLockKey` `:66-72`)。大 BOM checkpoint apply 作业里只有单张 `target`(`stock-preparation-large-bom-jobs.cjs:1175`)与 `plan`(`:1179`),**没有 snapshotBatchId**(作业形状 `:1159-1193`)。**所以"单表变体" = 为一条新写路径重新设计 fail-closed 形状与锁键集合,按安全评审走。**

**挡路的二:它改写失败语义。** 今天是**逐行 catch**(`apply-writer:540` 循环、`:542` try、`:569` catch、`:570` `counts.failed += 1` 后继续),`:596-597` 据此算状态,`terminalApplyStatus`(`large-bom-jobs.cjs:1231-1234`)把 `failed>0` 折成 `partial`。**一个 chunk 一个 PG 事务之后,第一行真正来自库的错误会 abort 整个事务(后续语句一律 25P02)**,"100 行里坏 1 行仍写进 99 行"这条今天的契约就没了,除非每行加 SAVEPOINT。

**挡路的三:它把 G3 从"罕见崩溃"抬成"任何一次库错误"。** chunk 运行器在 `:1304-1307`(写 `running`)与 `:1332-1334`(写终态)之间**只有 `finally` 放锁(`:1336-1338`),没有 catch**。UoW 一抛,作业永久停在 `running`,之后每次 run 都在 `:1269-1276` 抛 409。**所以 L3 必须排在 G3 修复之后,或在同一支里给 chunk 运行器补 catch/失败落库。**

**锁的事实(第三轮说反了,本轮订正)**:UoW 在事务里取目标 sheet 的 canonical fence(`stock-preparation-persist-unit-of-work.ts:81` → `canonical-sheet-fence.ts:97` → `:81-82`)。**非 UoW 的建行路径取的是同一把**:`records.ts:675` → `auto-number-service.ts:23-27`(函数体只有一行 `await acquireCanonicalSheetFence`,`:27`;注释 `:19-21` 自陈是别名)→ `canonical-sheet-fence.ts:81-82`,键函数 `:58`,模块头 `:17-22` 明写键 NEVER renamed;UI/REST 建行 `record-service.ts:573` 也无条件取同一把。**所以所有建行路径互斥,L3 对"并发建重复行"的保护比第三轮说的强;残余窗口在 patch 路径(`records.ts:536` 的 `fenceWriterEntry`)与纯读者,而 patch 建不出重复行。**

**一条新的、必须写明的代价**:UoW 的 canonical fence 是**事务作用域**。一个 chunk 的整段时间里,**同表的任何建行(含 UI 手工新增)都排队等锁**;而今天是每行一取一放。chunk 越大,这段独占越长。

**另一条**:UoW 路径对 sheet 归属**更严** —— `index.ts:2180-2185` 未注册即抛,而非 UoW 路径按 `pluginSheetScopeMode` 默认只告警(`:2152-2159`)。上线前必须确认目标 sheet 已在 `plugin_multitable_object_registry` 里,否则 apply 从"告警"变"报错"。

### 4.4 方案 A′ —— 进程内 worker + 持久租约(买"关页不丢",不买"更快")

**"进程内"不等于"不持久"。** 仓里就有反例:`plugins/plugin-elearning/lib/jobs.cjs` 是一套完整的后台作业运行器,跑在同一个后端进程里,由 `plugins/plugin-elearning/index.cjs:73` 的 `startJobsWorker(context)` 起 tick。它的 `CLAIM_SQL`(`:20` 起)用 `FOR UPDATE SKIP LOCKED`(`:30`)+ `lease_until`(`:27`、`:47`)+ `claim_worker_id` 围栏(`:48`)+ attempts/死信(`:32-42` 的 `exhausted`、`:44-54` 的 `claimed`)。**进程内、持久租约、多实例安全,三者同时成立。**

真正的分界不是进程边界,而是:**作业由"带着已授权 adapter 的请求"驱动,还是由"worker 事后自己重建 adapter"驱动**——后者才是 `createHandlers` 闭包那笔账,**而它只在展开侧成立**。

**A′ 必须捆的三件事**

1. **展开侧补单飞锁**(今天只有 apply 有,`:103`)。没有它,`run` 允许从 `running` 重入(`:922`),而 web 每 2 s 重发 run(`largeBomPull.ts:344`),会并起 N 条同 job 的展开。
2. **worker 里的 `storage.set` 抛出必须自己接住。** 202 之后没有任何调用栈接得住它,而**后端主进程没有全局 `unhandledRejection` 兜底**——全仓唯一那两个处理器(`packages/core-backend/src/core/PluginIsolationManager.ts:285-297`)在一个**模板字符串里**(闭合反引号 `:298`),是生成给 worker thread 的源码,不装在宿主进程上。Node 默认姿态下这是整进程退出,`ecosystem.config.cjs:62` 的 `autorestart` 再拉起。
3. **保留 `largeBomJobResponse` 包装**(§2.1)。

**B2a 时序变化**:A′ 把源读挪到请求之后,claim 仍在请求内取(`:6258-6280`)。同 runId 重入语义不变,但 claim 与真正的源读之间从此隔着一个不确定的排队窗口。

**暴露面(不是"零影响")**:响应投影不变(`publicBackgroundExpansionJob` `:562-567`),日志不变。但 A′ 会把一个已解密的源连接句柄放进模块级队列里存活不确定时长,而 `ecosystem.config.cjs:62-64` 上有 `autorestart: true` + `max_memory_restart: '1024M'`。

**与现有断言的冲突 —— 5 条内容**

run 路由在测试里共 10 个调用点:`http-routes.test.cjs:5382 / 5398 / 5406 / 5659 / 5756`;`b2a-trial-registry-wiring.test.cjs:854 / 878 / 1542`;`operator-pull-gate.test.cjs:515 / 524`。

**需要 drain + 改断言内容的 5 处**:

| 断言 | 内容 |
|---|---|
| `http-routes.test.cjs:5410-5414` | 200 + `status === 'completed'` + `authoritative === true` + `artifactRevisionPresent` + `rowsExpanded === 1` |
| `http-routes.test.cjs:5663-5667` | 200 + `completed` + `rowsExpanded === 1` + `sourceRead` 已发生 |
| `http-routes.test.cjs:5760-5770` | 200 + `status === 'failed'` + `logger.warnCalls.length === 1` + `errorTypes` |
| `b2a-trial-registry-wiring.test.cjs:1545-1547` | 200 + `failed` + `authoritative === false` |
| `b2a-trial-registry-wiring.test.cjs:881-882` | `statusCode !== 403` + `okSource.reads.length > 0`(源读挪进 worker,不 drain 同样红) |

**原样绿的 5 处**(都是请求内就发生的拒绝):`http-routes.test.cjs:5382-5388`(400)、`:5398-5404`(403 actor)、`b2a-…:854-859`(B2a 拒绝 + 零读 + 零凭据加载)、`operator-pull-gate.test.cjs:515-521` / `:524-529`。

**成本按"重写 5 条断言内容 + 新增 `drainLargeBomWorker()` 导出"报。** 一线准入白名单**不用动**(不新增路由;轮询用已在册的 `GET`)。

### 4.5 方案 B-apply-only —— 独立 worker,只做 apply

apply 侧**一行源凭据都不碰**:`runLargeBomCheckpointApplyJobChunk`(`:1254-1339`)只吃 `storage` + `recordsApi`。而写入循环**恰恰全在 apply 侧**。所以"只做 apply worker"不用抽 `createHandlers`、不新增凭据持有进程、不碰 B2a。

原语仓里全有:`consume`(`plugin-durable-storage.ts:129-141`,原子)、077 租约表(`packages/core-backend/migrations/077_create_integration_stock_prep_confirmation_reconcile_lease.sql:27-32`,`scope_key` PK + `expires_at`,表注释 `:34-35` 自陈"expired leases are taken over by CAS on lease_id")、078 一次性 claim(`078_create_integration_b2a_operation_claim.sql`)、elearning 那套完整协议(§4.4)。

**它不改变写入时长**,只改变"关页就丢"和"浏览器挂着"。

**迁移落点待答**:仓里两个迁移目录——`packages/core-backend/migrations/`(编号 `.sql`,最高确为 **086**,**083 缺号**)与 `packages/core-backend/src/db/migrations/`(时间戳 `.ts`,340 个)。租约先例(077/078)在第一个;作业表先例在第二个。

### 4.6 方案 C —— 服务端 apply 循环(**不做**)

**形状**:`large-bom-jobs.cjs` 加 `runLargeBomCheckpointApplyJob({ maxChunks, maxElapsedMs, gate })`,内部 `while` 调 `:1254`;路由 `:6395-6435` 改调它。

**四条否决理由**:

1. **它不改变写入总时长**,只把 132 个短请求换成一个长请求。
2. **它删掉一线唯一的中止手段。** 今天面板卸载置 `cancelled = true`(`…PullPanel.vue:189`),驱动在 `largeBomPull.ts:334` / `:343` 停手;注释 `…PullPanel.vue:185-188` 自陈这个保证是"阻止它再发一次 API 调用"。C 合成一次之后,服务端循环没有任何客户端信号能停——apply 侧没有 cancel 路由,`STOCK_PREP_OPERATOR_PULL_STEPS` 里只有 `large-bom-expansion-cancel`(`workbench-access.cjs:322-327`)。**C 引入的新失败模式正是"生产备料表被一个无法中止的请求写满"。**
3. **门在循环中途抛出时怎么办,没有好答案。** `assertStockPrepApplyAllowed`(`stock-preparation-table-actions.cjs:1836`)在生产策略下走 `assertProductionPolicyNotExpired(policy, now)`(`:1840`),入参是 `now`。今天每个 chunk 是独立请求,策略中途过期只让下一次请求干净 4xx、checkpoint 完好;C 的循环里第 N+1 轮抛出时前 N 轮已经写了行。
   (`gate` 回调**不需要**收上一轮返回的作业——`plan` 在创建时写入(`:1179`)、`target` 在 `:1175`,chunk 运行器只改 `counts`/`evidence`/`checkpoint`/`status`/`updatedAt`(`:1326-1334`);路由注释 `:6419-6420` 也这么声明。循环里需要刷新的只有 `now`。)
4. **它把 §2.8(a) 那条沙箱断言的语义掏空,即使测试仍绿。** `http-routes.test.cjs:5536-5554` 钉的是"门在 checkpoint 写之前开火、这一次 run 一行都没写"。C 之后 403 的含义从"本次请求什么都没写"变成"写了 N 批之后被拒"。那个用例里门在第一轮就开火(且它的 decision 数至少是 2——`:5562-5563` 同时断 `created === 1` 与 `inactive === 1`),所以**断言照样绿**。绿的是断言,空的是它想表达的保证。

**关于并发**:锁是每 chunk 取放的(`:1257` / `:1336-1338`),两轮之间锁松着、库里状态是 `paused`(`:1332`)——恰好是可重跑状态(`:1277`)。所以反代掐断后客户端重发、或另开一个 tab,**可能开出第二条服务端循环**与第一条交替推进 checkpoint(行不会写重,`nextDecisionIndex` 单调 `:1328-1331`)。**但这不是 C 造成的,C 反而让窗口更窄**——今天两 chunk 之间锁松着整整一个 2 s 客户端 tick(`largeBomPull.ts:344`)加一次网络往返,而循环里只隔几次同步调用(四个门全是同步 `function`:`stock-preparation-table-actions.cjs:1802` / `:1822` / `:1836` / `:1861`,路由处也没 await:`http-routes.cjs:6412` / `:6423`)。

**C 唯一为真的优点**:守卫冲突最少,展开侧五处断言一个都不碰。但那是因为守卫**没在该红的地方红**。

### 4.7 方案 A(朴素进程内队列,无持久租约)—— 不做

A′ 去掉租约的退化版:进程一挂,展开停在 `running`(可重跑),apply 停在 `running`(409,G3)。它把 G3 的触发条件从"罕见崩溃"抬到"每次 pm2 restart"。既然租约无论如何都要做,直接做 A′。

**完整的 B(展开也搬出去)**:成本在 `createHandlers` 闭包上——`loadTableActionSourceAdapter`(`http-routes.cjs:4457`)、`assertLargeBomJobActor`(`:4422`)、`largeBomJobResponse`(`:4006`)、全部 handler 都定义在 `createHandlers(services, options)`(工厂 `:3482`)内部,`loadTableActionSourceAdapter` 第一个参数就是 `req` 并靠它推 workspace / tenant 兜底(`:4463-4468`)。抽它是在一个 9602 行的钉住文件上做大手术,**加上"第二个持有客户源凭据的进程"这个安全面,记账不做。**

---

## 5. 对照表

**分两张表。第一张只比"快",第二张只比"丢"。两张表的"收益"一栏一律是"待实测",只保留能从代码直接读出的列。**

### 5.1 性能杠杆

| | L1 元数据不重读 | L2 削存在性查询 | L3 一 chunk 一事务 | C 服务端循环 |
|---|---|---|---|---|
| **收益** | **待实测**(§1.7 M3 次数 + M4 时间) | **待实测**;且规则 (a) 下在 `existingRows 0` 的负载上结构性为 0 | **待实测**(§1.7 M3 的 `xact_commit` + M4) | **无**(不改变写入总时长,只合并请求) |
| 改什么结构 | A/F、B/H、C/I 三对重复读取各合并成一次 | 查询段 A–D 在命中时省掉 | 消掉每行一次 BEGIN/COMMIT(E、L) | 132 个短请求 → 1 个长请求 |
| 落点(文件) | `packages/core-backend`:`loaders.ts`、`query-service.ts`、`records.ts`,并需把 cache 从 `index.ts:999-1100` 的门面穿进去 | `lib/stock-preparation-apply-writer.cjs` + `lib/stock-preparation-large-bom-jobs.cjs` | 宿主 `stock-preparation-persist-unit-of-work.ts` + 插件 chunk 运行器 | 插件 + 路由 |
| **语义变化** | 安全钩子 `assertSheetScope` 的**调用频率**变(集合不变,论证见 §4.1);缓存生命周期必须绑调用链 | 若选 (b):唯一性守卫从**写入时刻**退到**预读时刻** | ①**逐行 catch 契约消失**(`apply-writer:569-570` → 事务 abort);②**G3 从罕见崩溃抬成任何一次库错误**(`:1304-1338` 无 catch);③canonical fence 变**事务作用域**,一个 chunk 期间同表建行全排队;④sheet 归属从"告警"变"报错"(`index.ts:2180-2185`) | **删掉一线唯一的中止手段**;掏空"门在任何写之前开火"这条保证 |
| 改动规模的真实口径 | **不是**"加个可选参数 + 两处透传":要改插件可见的记录 API 入参形状或引入隐式上下文(§4.1 第 3 条) | **不能**复用 `readExistingStockPreparationRows`(丢顶层 `id`),必须自写 chunk 级读取器 | **不是**"放宽一个长度判断":`:38` + `:43` + `:47` + `:50-52` 四道,且 `:87-94` 的锁键从这两组值算出;作业里无 `snapshotBatchId` | 小 |
| 碰钉住文件 / 重钉 pin | 否 | 否 | 否 | **是** |
| 撞现有断言 | 0(插件侧);新测试落 core-backend 自己的套件 | 0(新增用例,落已在册的 apply-writer 套件) | 0 | 0 绿,但掏空 1 条保证 |
| 前置 | §1.7 出数 + owner 批宿主改动 | §1.7 出数 + owner 选 (a)/(b) | §1.7 出数 + owner 批宿主安全形状 + **G3 先修** | — |

**另一条不在表内、但同属"快"的候选**:每 chunk 四次整值读写整份 plan(§1.4)。它的收益同样**待实测**(M3 给 `plugin_kv` 次数,M4 给时间),落点是 chunk 大小可配(PR-5)或作业分片。**在数出来之前,不能说它"基本无效",也不能说它是杠杆。**

### 5.2 搬运方案("关页/断网后作业能不能跑完")

| | A′ 进程内+租约 | B-apply-only | C | A 朴素队列 | 今天 |
|---|---|---|---|---|---|
| **写入总时长** | 不变 | 不变 | 不变 | 不变 | — |
| 请求不再挂长时间 | ✅ | ✅ | ❌ 合成一个长请求 | ✅ | ➖ 每次一个 chunk |
| **关页/断网后作业能跑完** | ✅ | ✅ | ❌ 照样丢 | ❌ | ❌ |
| 保住"可中止" | ✅ 不动 | 需新增 cancel | **❌ 删掉唯一中止手段** | ✅ | ✅ |
| 多实例安全 | ✅(靠租约) | ✅ | ❌ | ❌ | ❌ |
| 崩溃后恢复 | ✅ | ✅ | ➖ 同今天 | ❌ 更差 | ❌ 整条重拉(§3-G3) |
| 新增凭据持有进程 | 否 | **否** | 否 | 否 | — |
| 碰钉住文件 / 重钉 pin | 是 | 否 | 是 | 是 | — |
| 撞现有断言 | **5 条内容** | 1 条(选 (b) 分支后原样绿,见 §8 PR-6) | 0 | 同 A′ | — |
| 需改一线白名单(四处镜像) | 否 | 需新增 cancel 时才要 | **是** | 否 | — |
| 工作量 | 中偏大(3-4 支) | 中(3-4 支) | 小(1-2 支) | 中 | — |

---

## 6. 推荐

> **① PR-0(apply actor 守卫)先合。** 与所有选型无关,三个方向都在放大 G1。证据链不依赖任何未测数字。
> **② 做一次 §1.7 的实测(M0→M1/M2→M3→M4 或 M5)。** ops 侧,不占 PR 队列,不改代码也不改 PG 配置。
> **③ 在 M1–M4 出数之前,本稿不给 L1 / L2 / L3 / chunk 大小的排序,也不推荐其中任何一条先做。** 这是本轮唯一的性能立场。
> **④ L3 无论排序如何,都必须排在 G3 修复之后**(或在同一支里给 chunk 运行器补 catch/失败落库)——这一条与实测无关,是语义问题(§4.3)。
> **⑤ "关页不丢"是另一件事**,由 B-apply-only(便宜)或 A′(贵)买,按这个卖点卖,**不要按"更快"卖**——三案都不改变写入总时长。
> **⑥ C 不做。**

理由,按重要性:

1. **本稿三轮都因为"没测就建模"翻车了,不该有第四次。** 第一轮押 C(消掉 HTTP 往返),被"没有 HTTP"打掉;第二轮押 D(砍掉一半存在性查询),被 `existingRows 0` 打掉;第三轮押 L1(六成时间在元数据重读),被"条数不是时间"+"漏掉每行一次事务"+"漏掉每批整值读写"打掉。三次的共同点都是**拿一个没实测的算术当推荐依据**。§1.7 之所以放在第二位,是因为它是第一个**能把自己证伪**的动作,而且它测的是时间不是条数。
2. **代码能给的只有结构,已经给完了。** 每行一次提交(`index.ts:1021-1022`)、每行三对常量元数据重读(§1.3)、每批四次整份 plan 读写(§1.4)——三条并列,**代码里没有任何东西能判它们谁大**。谁先做取决于 M4。
3. **一支安全 PR 必须走在所有 worker 化前面**(G1)。修法便宜、落点大部分在未钉住的模块侧。
4. **G3 的紧急度不能降。** 第三轮的降级依据("再建一个 apply 作业即可")在产品里够不着(§3-G3),而 L3 会把它的触发条件从崩溃抬成任何一次库错误(§4.3)。
5. **C 的成本不在它写多少代码,在它删掉什么。** 它删掉一线唯一的中止手段,把"门在任何写之前开火"的保证掏空。"守卫冲突 0 处"是真的,但那是因为守卫没在该红的地方红。
6. **顺序上互不挡路。** PR-0 与 §1.7 都不依赖别的;L1/L3 在宿主侧,与插件 pin 队列无关;L2 与 worker 化在未钉住的插件模块侧。

---

## 7. 实测后要回答的问题(5 个)

> **G1 / G2 两条安全缺口不在此列** —— 它们与实测无关,证据链在 §3,可以现在就单独交付并开工(§8 PR-0)。

1. **M1 与 M2 的差是多少?**(453.6 s 里服务端占多少、客户端固定等待占多少。)若差值很大,"写入慢"这个问题的形状就变了——先改驱动的间隔,而不是改宿主。**在这个数出来之前,本稿不接受任何"每行/每语句多少毫秒"的说法。**
2. **`xact_commit` 的差分说明每行确实一次提交吗?提交在 M4 的时间榜上排第几?** 这是 **L3 值不值得做**的唯一依据;而 L3 的三条语义变化(逐行 catch 契约消失、G3 被抬高、canonical fence 变事务作用域独占)是要 owner 单独点头的,不能只看收益。
3. **常量元数据重读(A/F、B/H、C/I)在 M4 的时间榜上排第几?** 这是 **L1 值不值得做**的唯一依据;而 L1 要改的是一道安全钩子的调用频率 + 插件可见的记录 API 入参形状(§4.1 第 2、3 条),规模比第三轮报的大。
4. **每批四次 `plugin_kv` 整值读写(§1.4)在 M4 的时间榜上排第几?** 这是 **chunk 大小(PR-5)有没有杠杆**的唯一依据。若它排得高,PR-5 从"可选"升为优先项,但落点要同时动 `stock-preparation-table-actions.cjs:336` 字段表、`:345-350` ceiling 表与 `:361-395` 校验器,而动作配置是被快照 + 哈希的(`:356-359`)。
5. **实测跑在什么部署姿态上,结论才可外推?** 要一并记下并回答:222 上 `MULTITABLE_ENABLE_WRITER_FENCE` 开没开(影响 §1.2 的 G 走哪一支);pm2 会不会在可见的将来上多实例(今天 `instances: 1 / fork`,`ecosystem.config.cjs:60-61`;若会,apply 单飞锁 `:103` 与 `:1269` 的 TOCTOU 都不是保证,**这件事的优先级会超过 worker 化本身**);B2a 注册表是武装还是休眠(决定 `requireCompleteBatch` `:6308` 在不在闩上,也决定 §3-G3 的恢复动作要不要 owner 补注册)。

**另外两条不是问题,是纠正**:

- **租户边界**:这一族路由的租户由 `largeBomJobScope`(`http-routes.cjs:1266-1272`)→ `scopedInput`(`:1247-1253`)→ `resolveTenantId` 解出,与作业键的 `{tenantId}` 段是同一个值。挡住 `x-tenant-id` 那个洞的是 `assertVerifiedTenantClaim`(`:1045`),它是 env 门控的(`stockPreparationTenantClaimRequired` `:1312-1313`,**代码默认关**);**但 222 上已经开着**——`48h-…:48` 记录追加该 env 并实测 FLAG EFFECTIVE。
- **两处文档订正**:`customer-delivery-guide-20260904.md:383` 的"主要是 HTTP 往返"应改为"每批一次 HTTP + 每行多次库内往返,构成待实测";`48h-…:102` 第 16 条的"453.6 秒的写入循环就是在同一个请求里跑完的"按 §2.1 是错的(132 次独立请求),对**展开** run 的同类描述才是对的。

---

## 8. 最小 PR 拆分

按依赖排序。每支都能单独合、单独回滚。

### PR-0 —— apply 作业的 actor 守卫(安全前置,与实测无关)

- `lib/stock-preparation-large-bom-jobs.cjs`:在 `createLargeBomCheckpointApplyJob` 的作业对象(`:1159-1193`)里落 `actor`(`input.principal` 已在手,`:1131`);**并在同一个函数里用已载入的 `sourceJob`(`:1133-1138`)校验触发者**——路由 `:6356-6377` 手里没有 `sourceJob`。
- `lib/http-routes.cjs`:apply-run(`:6395-6435`)在 `assertApplyJobMatchesExpansion`(`:6408`)之后、沙箱门(`:6412`)之前,调既有的 `assertLargeBomJobActor`(`:4422-4427`)。
- **存量行 fail-open 要一并处理**:`:4423` 的回退链是 `job.actor || job.principal`,存量 apply 行两个都没有 → `:4424` 静默放行。补法是把回退链延到 `job.approval.principal`(`:1168-1173`,值现成)。
- **动了 `http-routes.cjs` → 必须重钉 `s6a-package-provenance-pins.json:73`。**(若只做库函数侧的 apply-start 校验、暂不动 apply-run,可以不重钉——但那样 run 路由仍无守卫,不推荐拆。)
- 新测试进 `__tests__/stock-preparation-operator-pull-gate.test.cjs`,照抄 `:493-530`(展开侧 P-10)的形状。
- 冲突面:0 处现有断言(`publicCheckpointApplyJob` `:569-574` 只投 summarize 结果,新增 `actor` 不进响应)。
- 若 owner 一并要修 G2(cancel),同一支里加。

### PR-1 —— 实测(事实前置)

**零代码,不占 PR 队列。** 见 §1.7:M0 前置检查 → M1(`/metrics/prom` 差分)+ M2(驱动侧计时)→ M3(`pg_stat_*` 差分)→ M4(`pg_stat_statements` 差分,若已装)或 M5(采样)。**不改代码、不改 PG 配置。**

**若 owner 坚持要代码内的分段计时,成本按下面报,不是 0**(且本稿不推荐,因为 M1 已经免费给了服务端每 chunk 墙钟):

- `lib/stock-preparation-large-bom-jobs.cjs`:`mergeApplyEvidence`(`:1221-1229`)加第四个键(它今天把 `job.evidence` **整体重建**为三键 `:1224-1228`,任何新键下一次 `:1327` 调用就被抹掉);`summarizeLargeBomCheckpointApplyJobForEvidence`(`:1453-1475`)的投影(`:1469-1473`)加同一个键,否则 `publicCheckpointApplyJob`(`:569-574`)带不出来。
- **必须同时重写 `__tests__/stock-preparation-large-bom-jobs.test.cjs:521-540` 的整对象 `deepEqual`**,并保证新键仍过 `:541` 与 `:2064` 两处 `assertValuesFree`。
- 计数必须是整数,按 `clampStoredTotal`(`:210-216`)的口径。
- **冲突面 1 处。** 不碰路由,不重钉 pin。

### PR-2 —— L1:常量元数据不再逐行重读(依赖 §7 Q3 的数 + owner 批准)

- `packages/core-backend/src/multitable/loaders.ts`:给 `loadSheetRow`(`:41-58`)加可选 cache 参数(`loadFieldsForSheet` `:60-76` 已有 `:63`)。
- `query-service.ts:168-184` 与 `records.ts:440-456` 两个 `loadSheetAndFields` 接受并透传一个**调用链作用域**的 cache。
- **落地机制是这支 PR 的主要成本,不是那两处透传**:cache 要从 `index.ts:999-1100` 的 records 门面穿进去,而 `createPluginScopedMultitableApi` 在 `index.ts:2050` 每插件只构造一次、`plugin-scope.ts:389-413` 的闭包里没有 chunk / 请求边界可绑。要么改插件可见的入参形状,要么引入隐式上下文。
- `plugin-scope.ts:389-413` 的六个 scope 断言:在一个 chunk 内按 `(pluginName, sheetId)` 记忆一次。
- **缓存生命周期必须绑在一个 chunk / 一个请求上,不能进程级。**
- 不碰任何插件文件,不重钉任何 pin。新测试落在 core-backend 自己的套件。

### PR-3 —— L3:一个 chunk 一个事务(依赖 §7 Q2 的数 + owner 批准 + **G3 先修**)

- **前置**:G3 修复,或在本支里给 `runLargeBomCheckpointApplyJobChunk`(`:1254-1339`)补 catch + 失败落库——今天 `:1304-1307` 与 `:1332-1334` 之间只有 `finally` 放锁(`:1336-1338`),UoW 一抛就永久 `running`。
- **宿主**:`validateStockPreparationPersistUnitOfWorkInput`(`stock-preparation-persist-unit-of-work.ts:30-53`)不是一个长度判断:`:38`(四张表)+ `:43`(projectId)+ `:47`(snapshotBatchId)+ `:50-52`(集合归属)四道,而 `:87-94` 两把锁的键从 `:56-63` / `:66-72` 算出。大 BOM 作业里没有 `snapshotBatchId`(`stock-preparation-large-bom-jobs.cjs:1159-1193`)。**"单表变体" = 重新设计 fail-closed 形状与锁键集合,按安全评审走。**
- **插件**:`runLargeBomCheckpointApplyJobChunk`(`:1314-1324`)把 `applyStockPreparationPlan` 包进 UoW 回调,形状照 `stock-preparation-sync-run-persist.cjs:642-656`。
- **必须一并决定失败语义**:今天逐行 catch(`apply-writer:542` / `:569-570`)→ 事务里第一行库错误 abort 全 chunk。要保住"坏 1 行仍写 99 行"就得每行 SAVEPOINT;要接受新语义就得改 `terminalApplyStatus`(`:1231-1234`)一线的解释与文档。
- **必须写明独占代价**:canonical fence 是事务作用域,一个 chunk 期间同表建行全排队。
- 上线前确认目标 sheet 已在 `plugin_multitable_object_registry`(UoW 路径 `index.ts:2180-2185` 未注册即抛)。

### PR-4 —— L2:削掉存在性查询(依赖 §7 的数 + owner 在 (a)/(b) 里裁决)

- **必须自写 chunk 级读取器**(按本 chunk 的 key 集合查、回投 `record.id`),**不能用 `readExistingStockPreparationRows`**(理由见 §4.2)。
- `lib/stock-preparation-apply-writer.cjs`:`applyStockPreparationPlan`(**`:512`** 起,主循环 `:540-594`)接受可选的 chunk 级 key→recordId 映射;`findExistingRecord`(`:250-267`)映射命中直接用。改签名时连 `:507-511` 的 SECURITY 注释一起读。
- 新测试进已在册的 `__tests__/stock-preparation-apply-writer.test.cjs`(`package.json:64`,**不碰测试链、不重钉 `pluginPackageJson`**),必须含"映射未命中的行为符合裁决选定的规则""映射过期时不产生重复行"两条。
- 两个文件都不在 pin 列表;不碰路由,不重钉 pin。冲突面 0。

### PR-5(收益待实测)—— chunk 大小可配 / 作业分片

- **收益待实测**:§1.7 的 M3 给每批 `plugin_kv` 次数、M4 给时间。**第三轮"收益基本为零"的判断已撤回**(它建立在"没有可观的每批固定开销"这个未验证前提上,而 §1.4 证明该开销存在)。
- **落点未定**:`action.largeBom` 今天装不下这个键——`normalizeActionLargeBomCaps`(`stock-preparation-table-actions.cjs:361-395`)对不在 `LARGE_BOM_BACKGROUND_CAP_FIELDS`(`:336`)里的键当场 422(`:366-370`,throw 在 `:368`);要走这条落点得同时动 `:336` 字段表、`:345-350` ceiling 表与 `:361-395` 校验器,而动作配置是被快照 + 哈希的(`:356-359`)。
- **另一条落点**:不改 chunk 大小,而把整份 plan 从作业行里拆出去,让 `:1307` / `:1334` 的整值回写只写状态与 checkpoint。这条改动面更大但直击 §1.4,同样等 M4 的数。

### PR-6(仅当 owner 要"关页不丢")—— apply 侧持久租约 + worker

- 租约:作业行加租约字段,`:1269-1276` 那道 `running` 拒绝改成"租约过期即接管",接管时不重置 `checkpoint.nextDecisionIndex`。**必须每 chunk 续期。**
- **两条路的取舍,按 §3-G3 订正后的口径**:
  - **(a)「无租约字段 = 可接管」**:能救回卡住的存量行,代价是 `__tests__/stock-preparation-large-bom-jobs.test.cjs:1994-2065` 会红(那里手工写的 `running` 行 `:2023` / `:2038` **不带任何租约字段**),且要重述其语义。
  - **(b)「无租约字段 = 永不接管」**:该测试原样绿、冲突面 0,但**卡住的存量行永远接管不了**,而 §3-G3 已证明"再建一个 apply 作业"在产品里够不着 —— 一线的实际动作是整条重拉。**第三轮"建议选 (b)"的论证依赖那条被撤回的降级,本轮退回 owner 裁决,不给建议。**
- 状态若引入 `leased` / `stale` 之类新枚举会撞 `:352-372` 的枚举 `deepEqual`;复用 `paused` 则不撞。
- worker 形状照 `plugins/plugin-elearning/lib/jobs.cjs`(`CLAIM_SQL` `:20`,`FOR UPDATE SKIP LOCKED` `:30`,`lease_until` `:27`/`:47`,`claim_worker_id` `:48`,死信 `:32-42`,claim `:44-54`),入口照 `plugins/plugin-elearning/index.cjs:73`。
- **worker 必须自带 catch**(§4.4 第 2 条)。迁移落点见 §4.5。
- **顺带该一起解决的**:作业行的清理 / TTL —— §2.4 已核实全文件无 `storage.delete` / `consume` / TTL,而客户端每次拉取都新建一个 apply 作业(`largeBomPull.ts:316`),整份 plan 副本按 MB 级堆积、永不回收。

### PR-7(仅当 owner 要展开侧也 worker 化)—— 展开侧 A′

- 新 `lib/stock-preparation-large-bom-worker.cjs` + 展开单飞锁;`run` 改 202,**保留 `largeBomJobResponse` 包装**;web 展开段改 GET 轮询。
- **必须一次性带上 §4.4 那张表的 5 条断言内容重写** + `drainLargeBomWorker()` 导出,否则一定假绿或一定红。
- 重钉 pin(与 PR-0 冲突,**排队合,别并发**)。

### PR-8(可选)—— apply 续跑 / 中止入口

- 新增 `POST …/apply-jobs/:applyJobId/resume`(与/或 `…/cancel`);**必须同步改四处**——`workbench-access.cjs:280-327`、`operator-pull-gate.test.cjs:1189-1208`、`apps/web/.../workbenchAccess.ts:53-123`、`apps/web/tests/StockPreparationProjectBoard.spec.ts:329-334`,外加 `operator-pull-gate.test.cjs:1473-1478` 的路由计数断言(清单派生,会自愈,但要知道它在)。
- **它也是 §3-G3 的正解**:给客户端一条"对既有 jobId 继续/重开"的入口,一线就不必整条重拉。

**排队纪律**:PR-0 / PR-7 都动 `http-routes.cjs`,都要重钉 `s6a-package-provenance-pins.json:73`,**单独排队合**(依据 `stock-preparation-overall-plan-20260902.md:166` 的同类规矩,注意原文只点名 `pluginPackageJson`,但两个 pin 同住一个文件)。**PR-1 是 ops 动作,不占队列;PR-4 / PR-5 / PR-6 全在未钉住的插件模块侧;PR-2 / PR-3 在 `packages/core-backend`,与插件 pin 队列无关。都可与它们并行。**

---

## 9. 第四轮变更表(blocker → 处置)

### 9.1 复核 1 的四条 blocker

| # | blocker | 处置 | 本轮实读的行号 |
|---|---|---|---|
| **B1** | 成本模型漏掉"每行一次事务",据此得出的"唯一削减点"与排序无依据 | **采纳。** §1.2 重写为"语句与**事务**结构",补 E(BEGIN)/L(COMMIT)两条;删除 §1.3 的"唯一";§5.1 的"省几次"列整列删除,收益一律改"待实测";§6③ 明写"本稿不给排序" | `index.ts:1021-1022`(createRecord 事务)、`:1059-1060`(patchRecord 事务)、`:999`/`:1001`(queryRecords 裸 query)、`:1041`/`:1043`(getRecord 裸 query);`records.ts:730-736` 注释自陈 |
| **B2** | 预测表只测条数、结论却用时间份额;453.6 s 的构成未经核实 | **采纳。** §1.6 改写为"预测表为什么作废"(三条理由);**新增 §1.7**,以时间为目标:M1 服务端每 chunk 墙钟、M2 驱动侧墙钟、M3 表级/事务级差分、M4 语句级 `total_exec_time`、M5 采样;删除"3.4 ms/次"与"六成时间" | 驱动脚本不在仓里(`git ls-tree -r origin/main` 无 `large-bom-drive.cjs`;`git grep timingsMs` 零命中);产品侧 `largeBomPull.ts:344` 每批 `wait(2000)`,`:235` |
| **B3** | 漏掉每 chunk 把整份 plan 读两遍写两遍的固定开销,而它正是 chunk 大小这条杠杆的真身 | **采纳。** **新增 §1.4**;§5.1 增列"另一条不在表内的候选";§8 PR-5 的"收益基本为零"撤回,改为待实测,并补第二条落点(把 plan 从作业行里拆出去);§1.7 M3 的表清单里包含 `plugin_kv` | 路由 `http-routes.cjs:6402-6407` → `large-bom-jobs.cjs:1198-1211`(`storage.get` `:1201`);runner `:1259`;整份回写 `:1307` / `:1334`;plan 在 `:1179`;整值原语 `plugin-durable-storage.ts:101-114` / `:115-128`;`cloneJson` `:1268` / `:1301` / `:1335` |
| **B4** | 锁的结论说反了(非 UoW create 其实也取 canonical fence),而它是给 owner 的裁决依据 | **采纳,删除 N4 与那句机制。** §4.3 按证据重推:**所有建行路径互斥**;残余窗口在 patch 路径与纯读者;§4.2 的 (b) 风险据此收窄 | `records.ts:675` → `auto-number-service.ts:23-27`(体 `:27`,别名注释 `:19-21`)→ `canonical-sheet-fence.ts:81-82`(键 `:58`,模块头 `:17-22`);UoW `stock-preparation-persist-unit-of-work.ts:81` → `canonical-sheet-fence.ts:97`;UI/REST `record-service.ts:573`;patch 走 `records.ts:536` |
| **B5** | 把宿主侧改动缩成"放宽一个长度判断",owner 会按错误的规模拍板 | **采纳。** §4.3 与 §8 PR-3 列出四道校验 + 两把锁键的来源 + 作业里没有 `snapshotBatchId`;并补"canonical fence 变事务作用域、一个 chunk 期间同表建行全排队"这条第三轮没写的代价 | 校验器 `:30-53`(`:38` / `:43` / `:47` / `:50-52`),锁键 `:56-63` / `:66-72`,取锁 `:81` / `:87-94`;作业形状 `large-bom-jobs.cjs:1159-1193`(`target` `:1175`、`plan` `:1179`,无 snapshotBatchId) |

### 9.2 复核 2 的四条 blocker

| # | blocker | 处置 | 本轮实读的行号 |
|---|---|---|---|
| **B6** | 同复核 1 B4(锁说反) | **采纳,见上** | 同上 |
| **B7** | chunk 包事务会改写失败语义,并把 G3 从"罕见崩溃"抬成"任何一次库错误";PR-3 不是"两个文件" | **采纳。** §4.3 新增"挡路的二 / 挡路的三";§5.1 的"语义变化"格写全四条;§6④ 明写 L3 必须排在 G3 之后;§8 PR-3 把"补 catch/失败落库"写成前置 | 逐行 catch:`apply-writer:540` / `:542` / `:569` / `:570` / `:596-597`;`terminalApplyStatus` `large-bom-jobs.cjs:1231-1234`;chunk 运行器无 catch:`:1304-1307` 与 `:1332-1334` 之间只有 `finally` `:1336-1338`,`running` 拒 409 `:1269-1276` |
| **B8** | 被推为"第一位事实前置"的测量按稿子写的口径答不了它自己的问题 | **采纳。** §1.6 记为作废,§1.7 全部重写为**以时间为目标**:M1 拿服务端每 chunk 墙钟(`_sum`/`_count` 差分)、M2 拿驱动侧墙钟、M4 拿 `total_exec_time`;并写明 M3 的表级计数**答不了时间归属** | M1 链条逐条核实:`http-routes.cjs:9549` → `index.ts:666` / `:677` → `metrics.ts:705-720`(`:706`)、中间件 `index.ts:1606`、注册 `metrics.ts:540-542`、定义 `:33-38` / `:40-45` / `:47-51`、端点 `:688-698` 挂 `index.ts:1605`、鉴权 `:669-686`(`:672` 无令牌放行) |
| **B9** | G3 降级所依赖的救援路径在产品里够不着,代价被低估 | **采纳,撤回降级。** §3-G3 重写为三条理由(客户端无入口 / 一线动作是整条重拉 + 新 Run 身份可能撞 B2a / 整份 plan 副本永不回收);§2.5 的"重开 applyJob"一行改成"库层能,产品里够不着";§6 理由 4 反转;§8 PR-6 撤回"建议选 (b)",退回 owner 裁决;§8 PR-8 补一句"它也是 G3 的正解" | 客户端只有两个入口:`largeBomPull.ts:186` / `:395`(startExpansion)、`:189` / `:417`(startApply);`:253` 无条件开新展开;面板 `…PullPanel.vue:161-182`;Run 身份 `http-routes.cjs:6278`;B2a 拒不同 Run `b2a-trial-registry.cjs:1103-1108` vs 同 runId 重入 `:1110-1118`;无清理:`large-bom-jobs.cjs` 全文无 `storage.delete` / `consume` / TTL(`expired` 只在 `:36` / `:47` / `:666`) |

### 9.3 minors

| minor | 处置 |
|---|---|
| §3-G3 "一条永久垃圾 `plugin_kv` 行"低估留存面 | **收。** §3-G3 第 3 条 + §2.4 补"全文件无 `storage.delete` / `consume` / TTL" + §8 PR-6 末条把"作业行清理/TTL"列为该支一并解决 |
| PR-2 缺"调用链作用域"的落地机制,规模报低 | **收。** §4.1 第 3 条 + §5.1"改动规模的真实口径"格 + §8 PR-2 明写"落地机制是主要成本,不是那两处透传" |
| §1.2 advisory lock "无标志门,无条件"措辞过头 | **收。** §1.2 G 行改为"在 `records.ts:673-677` 的 else 支;flag 开且有 link 计划时改走 `enterLinkWriterFencePlan`(`:673`)" |
| 两个不相关的 "3.4" 相邻出现易串 | **收。** "3.4 ms/次"已随 B2 删除 |
| §1.1 "HTTP 往返为零"与本稿自己的"132 次请求"打架;据此判文档"错的"过头 | **收。** §1.1 改为"不是每行一次 HTTP,是每行多次库内往返;每批仍有一次 HTTP";§1.5 对 `customer-delivery-guide:383` 改判为"不精确但不算错",给出建议措辞 |
| §1.2 每行清单漏了 `createRecord` 自带事务 | **收,已并入 B1**(E / L 两行) |
| §4.1 "所有插件、所有 UI 都走 `loadSheetAndFields`"是能被 grep 打掉的绝对句 | **收。** §1.3 与 §4.1 收紧为"`records.ts` / `query-service.ts` 的调用方";补 `record-service.ts:580-583` 自己查字段 |
| 行号偏差三条 | **两条驳回、一条收。** ①路由条数守卫:实读为 `:1473`(filter)+ `:1474-1478`(assert),**第三轮的 `:1473-1478` 正确**,复核给的 `:1475-1479` 落在断言消息与右括号上 → 驳回,§0.3 记录。②`plugin-durable-storage.ts` 的 `list`:实读 `:152-164`(`:163` 返回、`:164` 收 `},`),`:165` 是返回对象字面量的收尾 → **第三轮正确**,驳回,§0.3 记录。③`normalizeActionLargeBomCaps` 两处口径不一 → **收**,全稿统一为 `:361-395`(未知键拒绝在 `:366-370`,throw 在 `:368`) |

### 9.4 本轮新增、两路复核都没提的

| 项 | 内容 | 依据 |
|---|---|---|
| N1 | **仓里已有一条零代码的服务端每请求墙钟通路,而且 values-free**:插件路由经 `addRoute` 注册 → 宿主在 `finally` 里结束计时 → Prometheus histogram + summary → `/metrics` / `/metrics/prom`,`route` 标签是路径模板,`:applyJobId` 保持占位符。**这是 §1.7 M1 的基础,第一至三轮都没发现** | `http-routes.cjs:9549`;`index.ts:666` / `:677` / `:1605` / `:1606`;`metrics.ts:33-38` / `:40-45` / `:47-51` / `:540-542` / `:669-686` / `:688-698` / `:705-720` |
| N2 | **`telemetryMiddleware` 定义了但全仓没有挂载点**,所以 pm2 日志里**没有**逐请求的收/发两行——"用 pm2 日志时间戳算每 chunk 墙钟"这个想法在这个仓里不成立 | `packages/core-backend/src/middleware/telemetry.ts:44`(定义)、`:65`(收)、`:71-79`(发);`git grep telemetryMiddleware -- packages/core-backend/src` 只命中定义那一行 |
| N3 | **`http_server_requests_seconds` 的桶上限是 5 s**,一个 3.4 s 的 chunk 落在 `le=5`;分布只能看粗轮廓,但 `_sum`/`_count` 的差分给的均值是准确的;summary 的**分位数是进程生命周期累计、不能差分** | `metrics.ts:37`(桶)、`:44`(分位) |
| N4 | **`pg_stat_statements` 是不是装着,决定 §1.7 能不能做时间归属**;装它要改 `shared_preload_libraries` 并重启 PG,属于"改 PG 配置",本方案不做 → 退 M5 采样 | §1.7 M0;仓内只有两处文档引用该视图(`docs/rollback-procedures/viewservice-unification.md:253`、`packages/core-backend/docs/sprint2-final-push-checklist.md:398`),**不构成 222 已装的证据** |
| N5 | **`records.ts` 的 patch 路径与 create 路径取的锁不同**:create 取 canonical fence(`:675`),patch 取 `fenceWriterEntry`(`:536`)。这是 §4.2 (b) 残余窗口的准确边界 | `records.ts:536` vs `:675` |

---

## 10. 交付状态

- **可以现在就单独交 owner 的**:§3(三个安全缺口,含撤回降级后的 G3)、§8 的 PR-0。证据链完整,不依赖任何未测数字。
- **可以现在就动手的**:§1.7 的实测(ops 侧,不占 PR 队列,不改代码也不改 PG 配置)。**M1 用的是仓里已有的指标端点,不需要任何前置。**
- **等 §1.7 出数才排序的**:L1(PR-2)、L3(PR-3)、L2(PR-4)、chunk 大小 / plan 拆出(PR-5)。**本稿不给它们排序,也不推荐其中任何一条先做。**
- **与实测无关但必须先解决的顺序约束**:L3(PR-3)排在 G3 修复之后,或自带 catch。
- **等 owner 拍板才开工的**:PR-6 / PR-7 / PR-8(要不要"关页不丢",要不要给一线一条续跑/中止入口)。
