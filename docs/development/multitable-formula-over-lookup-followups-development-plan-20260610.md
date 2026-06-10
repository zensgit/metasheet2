# 多维表 formula-over-lookup 后续两刀 — 设计锁定 + 执行计划 — 2026-06-10

> Status: **DESIGN-LOCK + EXECUTION PLAN(docs-only,本 PR 无运行时代码)**
> 上游:A-full 设计 `multitable-formula-over-lookup-afull-design-20260609.md`(#2410)+ A-full 实现 **#2450(MERGED `85f4c074b` 2026-06-10**,含独立 review F1 修复:依赖门控结果兼任引擎重算白名单)。
> 配套 TODO:`multitable-formula-over-lookup-followups-todo-20260610.md`。
> 本文档经 4-agent 事实核验(3 核验员 19 条承重声明 + 1 完备性批评)修订;声明逐条对照代码,引用以 #2450 合并后 main 为准。
> K3:全部为多维表内核打磨。不碰 `src/formula/engine.ts`、central RBAC/auth、migrations、`plugin-integration-core`。

## 0. 范围一句话

收掉 formula-over-lookup 链落地后仅剩的两个**可启动**缺口:**FOL-1** 相关表 realtime 失效 fan-out + 相关记录 Yjs 读侧失效(A-full 物化后下游消费者不知情)、**FOL-2** dry-run 预览 hydration(预览与 A-min 后的生产语义脱节)。其余后续项各有既有 gate,见 §5 与 TODO §2。

## 1. 现状地基(2026-06-10 对照代码核实,经独立核验)

### 1.1 realtime 是"失效信号 + 各端按己掩码 refetch"模型

- 共享 publisher `multitable/realtime-publish.ts:25` 广播前**剥掉 `recordPatches`**;线上只有 `spreadsheetId/source/kind` + 可选 `actorId/recordId/recordIds/fieldIds` 元数据,**无字段值**。
- `CollabService.setupEventListeners()`(:48-58)把 `spreadsheet.cell.updated` 原样转发到 socket.io 房间 `sheet:{spreadsheetId}`,无 per-subscriber 过滤;入房资格由 `sheetRoomAuthChecker` 在 **JOIN 时**校验(:221-231)。
- 前端 `useMultitableSheetRealtime`:只处理 `activeSheetId` 的事件(:213);`actorId === currentUserId` 跳过(:214;normalize 把缺失 actorId 映射为 `''`,故**无 actorId 的事件不会被自跳过**);事件中即使出现值也**明确不消费**(:172-173 注释 + normalize 只抽元数据)。
- **refetch 主路径(核验修正)**:非结构性 `record-updated` → **per-record `mergeRemoteRecord` GET**(每条受影响记录一次,经 `univer-meta.ts:7838-7845` 读路径,请求者掩码天然生效);`reloadCurrentSheetPage()` 整页重载只在**结构性变更或 fallback** 时走。K 条记录失效 = 接收端 K 次 GET,事件的 `recordIds` 体量直接决定接收端成本。
- 前端在 :165 先丢弃 `recordIds` 与可见/选中集不相交的事件(**off-page 局限**,见 §2.5)。
- **推论**:#2410 §3.5 顾虑的"接收方字段掩码"问题只存在于推值协议;失效信号协议下不存在。FOL-1 不需要新协议、不需要前端改动。
- 旁注:`setRealtimeCacheInvalidator` 生产端从未注册(它服务的 records 响应缓存已因 subject-scoped mask 撤除,`univer-meta.ts:7689-7692`)——**缓存陈旧不是论据**。

### 1.2 A-full 落地后的下游失效缺口(FOL-1 的"为什么")

`RecordWriteService.patchRecords` 对 A-full 物化的相关记录值,下游有**两个**不知情消费者:
1. **realtime**:Step 6 只对被编辑源表 publish(`record-write-service.ts:963-991`,文件内唯一 publish 点);跨表 `relatedRecords` 与同表 `sameSheetRelated` 都不在 `recordIds` 里 → 相关表观看者零信号。
2. **Yjs 读侧文档缓存(核验新发现)**:Step 3 post-commit 失效钩子只拿**源记录 id**(:786-792);相关记录的 formula 在 Step 4 才物化 → 相关记录若有缓存的 Y.Doc,其 formula 值**保持陈旧**且无人失效。

编辑者自己的活动客户端从 PATCH 响应拿到 `relatedRecords` echo,是唯一"知情者"。

### 1.3 dry-run 预览的语义脱节(FOL-2 的"为什么")

`POST /sheets/:sheetId/formula/dry-run`(#5a 设计 #1860;#5c 真记录采样)的 `recordId` 分支只取 RAW 持久化数据,注释理由"与生产重算一致"在 A-min(#2247)后**倒置**:生产重算对 hydrated 行求值,预览却对 lookup 引用报 `missing_sample`。

## 2. FOL-1 设计锁定 — 相关记录下游失效(realtime fan-out + Yjs 读侧)

### 2.1 锁定决策

1. **纯失效信号,零值上线**:复用既有 `publishMultitableSheetRealtime` + 既有 `kind: 'record-updated'`;**fan-out 调用不得携带 `recordPatches`**(publisher 本就剥除,调用侧也不准构造);不新增事件类型、不改协议、不改前端。
2. **发布门 = 受影响门(锁死,非 echo 即发)**:仅当某相关表存在 ≥1 条记录的 **affected 集非空**(变更源字段确实喂入该表某 lookup/rollup 且记录确实链接,即 #2450 F1 白名单同款门)才为该表 publish 一条事件。helper 的 echo(每个有 computed 字段的可读相关表都返回)**不是**发布条件——否则任何被链接记录的任意编辑都会向全部相关表广播,放大量级不可接受。
3. **`fieldIds` = 未掩码的 affected/recomputed 字段 id 元数据(锁死)**:id 是元数据不是值,与失效信号协议一致。不得用 actor 掩码后的 echo 键集——actor 被 deny 的 formula 字段会从键集消失,接收方(对该字段可读、且视图 sort/filter 在该字段上)将收不到正确的失效提示。为此 **helper 返回形扩展**:`RelatedComputedRecord` 增加未掩码元数据(如 `affectedFieldIds: string[]`,含受影响 lookup/rollup + 实际重算的 formula id),masked `data` 仍只用于 HTTP echo。
4. **actorId 语义分裂(锁死)**:**跨表**事件 omit actorId(编辑者在相关表无本地编辑,其另开标签页应刷新;publisher `:50` 容忍缺省,前端 `:55` 归一化为 `''` 不触发自跳过);**同表** sameSheetRelated 事件**携带 actorId**(否则编辑者发起 tab 会对自己的 PATCH 响应 echo 之外再发 per-record GET,产生冗余请求与竞态;同表 actor tab 的新值已由响应 `records` 合并)。
5. **Yjs 读侧失效纳入本刀**:Step 4 相关记录 formula 物化后,把**相关记录 id** 也送入既有 Yjs 失效机制(`createYjsInvalidationPostCommitHook` 的 invalidator;`source==='yjs-bridge'` 时跳过,与现状一致)。实现时核实 invalidator 的键控(record-id 全局 or sheet 维度)并按需分组;协同桥路径 helper 被 stub 为 `[]` → 天然 no-op。
6. **权限边界继承 A-full §3.4**:actor 不可读的相关表被 helper 跳过 → 无物化 → 无事件,自洽。已知边界(写明不改):入房资格只在 JOIN 时校验,事后撤权的订阅者会继续收到**纯元数据**失效信号(值在 refetch 时被 403/掩码)。
7. **无环**:失效事件不触发任何写路径;实现处注释写明。
8. **partialSuccess 路径**:per-record 调用 `patchRecords`,每次各自发布。**显式接受成本**:N 记录批量 → 至多 N×相关表数 条事件、接收端按事件逐条 GET(前端 eventChain 串行、无跨事件去重)。不在本刀做聚合;若实测放大,聚合是独立 follow-up。
9. **顺手修正陈旧注释**:`record-write-service.ts:985-988` 声称物化值经 `recordPatches` 流到其它客户端并被 `applyRemoteRecordPatch` 合并——与 publisher 剥除行为、前端"不消费值"注释均矛盾,同 PR 内修正,防止未来据此回归出推值实现。

### 2.2 改动面

- `packages/core-backend/src/routes/univer-meta.ts`:`computeDependentLookupRollupRecords()` 返回形扩展(per-record 未掩码 `affectedFieldIds` 元数据;masked `data` 不变)。
- `packages/core-backend/src/multitable/record-write-service.ts`:seam 类型同步;Step 6 邻域按 sheetId 分组 publish + Step 4 后相关 id 送 Yjs 失效;陈旧注释修正。
- 单测 + 真库集成测试。Yjs stub(`index.ts` `async () => []`)形兼容,不动;**不改**共享 publisher、CollabService、前端。

### 2.3 测试矩阵(fail-first;R1-R5 真库件挂 plugin-tests.yml;断言层 = `publishMultitableSheetRealtime` 调用/eventBus spy,与既有 `multitable-sheet-realtime.api.test.ts` 同款——CollabService 原样转发另有覆盖)

| # | 场景 | 断言 |
|---|---|---|
| R1 | 外表 target 编辑,跨表相关记录发生 formula 物化 | 相关表一条 `record-updated`:recordIds=受影响相关记录;fieldIds ⊇ 未掩码 affected ids(用 field_permissions deny 该 formula 的 actor 验证"未掩码"——actor 被 deny 时 fieldIds 仍含该 id);**无 actorId**;publish 调用 payload **无 recordPatches** |
| R2 | 同表自链相关记录 | 源表第二条事件:recordIds=同表相关记录,**带 actorId** |
| R3 | actor 不可读的相关表 | 该表零事件 |
| R4 | 无关字段编辑(AF3 场景)/ 仅链接但无 affected | 相关表**零事件**(发布门=受影响门,非 echo 即发) |
| R5 | 主事件回归 | 源表主 publish 的 recordIds/fieldIds/patch 行为与改动前一致 |
| R6 | Yjs 桥路径(单测) | stub 下零 fan-out、零相关 Yjs 失效 |
| R7 | Yjs 读侧失效(单测) | rest 源 PATCH 后 invalidator 收到相关记录 id;yjs-bridge 源不收 |

### 2.4 回滚

存储中性、协议中性:revert 回到"相关表不刷新 + 相关 Y.Doc 陈旧"的 A-full 现状,无数据风险。

### 2.5 已知局限(写明,不在本刀)

- **off-page 局限**:前端 :165 先按可见/选中集过滤 → 翻页/筛选在外的接收方无刷新;特别地,若接收方视图的 filter/sort 落在被重算的 formula 字段上,"本应进入视图"的记录不会自动出现(导航/刷新时修复)。接受;修复属前端事件处理策略,独立议题。
- **automation/webhook 盲区**:Step 7 `multitable.record.updated` 仍只对源表发;相关表上注册的字段变更自动化/webhook 不会因物化触发。命名为已知缺口,绑定 automation 域,独立 opt-in。

## 3. FOL-2 设计锁定 — dry-run 预览 hydration

### 3.1 锁定决策

1. **route 层 hydrate,引擎保持 no-DB**:`recordId` 分支加载记录后,先 `loadLinkValuesByRecord` + `applyLookupRollup(req, …)` hydrate,再走既有 `filterRecordDataByFieldIds(…, allowedIds)` 掩码,最后 `…sampleValues` 显式覆盖(覆盖优先级既有语义:含对 masked lookup 手填值——是调用者自己的数据,非泄漏)。`dryRunFormulaEngine` 不取得任何 DB 访问。
2. **顺序 = hydrate → mask**:deny/hidden 的 lookup/rollup 键被掩码后仍 `missing_sample`;#5c canary 断言沿用。
3. **hydration 范围按表达式裁剪(锁死,出于成本)**:dry-run 结构上限(`DRY_RUN_MAX_*`)只约束表达式,不约束 hydration;`applyLookupRollup` 默认 hydrate 全表 computed 字段、每个 foreign sheet 一次查询。本刀**只 hydrate 表达式实际引用的 lookup/rollup 字段**(`extractFieldReferences` 已有;向 `applyLookupRollup` 传入裁剪后的 fields 子集 = 被引用 computed 字段 + 全部 link 字段),把成本绑定在表达式上。
4. **actor 视角语义**:hydration 用请求者 `req`(与全部读路径一致;预览无法预知未来编辑者,actor 视角是唯一无提权选择)。已知 parity 边界(写明不改):`applyLookupRollup` 只 gate foreign sheet **表级**可读,不查 foreign 表的 field_permissions——与全部读路径同语义,非本刀回归。
5. **求值语义如实钉死(核验修正)**:hydrated lookup 数组经 `evaluateField` 以**引号 joined string** 代入(A2b 契约):`[100]` → `"100"`、`[]` → `""`;rollup 的 `null` 代入为 `'0'`。D 矩阵期望值按此写,不按"数值算术"想当然。
6. **`missing_sample` 翻转点**:lookup/rollup 引用从"必 missing"变为"有链接→joined 值;无链接→`[]`/null 代入;被掩→missing"。更新 #5c 注释(其"matches production recalc"理由已倒置)。
7. 无 recordId 的 #5b 纯手填路径**不变**;响应 shape `{ ok, data }` 不变(无 OpenAPI 改动)。

### 3.2 改动面

`packages/core-backend/src/routes/univer-meta.ts` dry-run handler `recordId` 分支 + 既有 `multitable-formula-dryrun.test.ts` 扩展。**夹具工作量为本刀主体**(核验修正):既有 `FLD_LOOKUP` 的 property 是 `{}` → cfg 解析为 null → 只演示 []-hydration;D1/D2 需新建 foreign sheet + link 字段 + meta_links + 真实 lookup/rollup cfg。该文件已在 plugin-tests.yml runner 清单,无需加行。

### 3.3 测试矩阵(fail-first)

| # | 场景 | 断言 |
|---|---|---|
| D1 | recordId + 已链接 lookup 引用(新夹具) | 预览值 = joined-string 代入语义下的求值结果(如 `[100]`→`"100"`→`+1` 的引擎实际值);既有 T4(null-cfg lookup)断言按 []-hydration 翻转 |
| D2 | rollup 引用(新夹具,sum) | 预览值 = hydrated 聚合的代入结果 |
| D3 | 被 field_permissions deny 的 lookup | 仍 missing_sample;canary 不泄漏 |
| D4 | 请求者不可读 foreign sheet — lookup | hydrate 为 `[]` → `""` 代入语义钉死 |
| D4b | 同上 — rollup | `null` → `'0'` 代入(与 lookup 语义分歧,显式钉死) |
| D5 | 手填覆盖 vs hydration | `{...masked, ...sampleValues}`:手填 lookup 样本胜过 hydrated 值;对 masked lookup 手填同样生效 |
| D6 | hydration 裁剪 | 表达式未引用的 lookup 不触发其 foreign sheet 查询(spy/计数层断言) |
| D7 | 无 recordId(#5b) | 行为与现状一致 |

### 3.4 回滚

只读预览,零写;revert 即回 raw 采样。

## 4. 执行计划(并行)

1. 本 docs PR 合并后**两条 lane 并行开工**(独立 worktree,基线 = 含 #2450 的 main):
   - Lane A `runtime/multitable-fol1-related-invalidation-20260610` → FOL-1;
   - Lane B `runtime/multitable-fol2-dryrun-hydration-20260610` → FOL-2。
2. **文件交叠说明(核验修正)**:Lane A 也改 `univer-meta.ts`(helper 返回形,~L1918-2063 + 注入点)而 Lane B 改同文件 dry-run 区(~L6354-6437)——区域不相邻,顺序合并 + 后者 rebase 即可;plugin-tests.yml 只有 Lane A 加行(dryrun 文件已在列),**无跨 lane 冲突**。
3. 每条 lane:fail-first 测试 → 实现 → 真库套件 + tsc + 单元全集 → 独立对抗 review(发现的 major 必须修复后复核)→ CI 绿 → admin-squash。
4. 全部落地后补**验证 MD**(`multitable-formula-over-lookup-followups-verification-20260610.md`):per-slice 证据(fail-first 输出、CI run、review 结论)+ TODO 终态打勾。

## 5. 明确不在本计划(各自既有 gate)

递归/多跳(Track C)、formula→formula(A2-full)、lookup/rollup 物化(C2b)、解析器算术(B2)、协同路径重算(Yjs 单独议题)、**相关表 automation/webhook 触发**(automation 域,§2.5)、**前端 off-page 失效策略**(§2.5)、foreign 表字段级权限 in hydration(全读路径 parity 议题)。
