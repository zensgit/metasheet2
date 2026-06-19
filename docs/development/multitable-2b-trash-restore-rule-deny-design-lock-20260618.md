# 2b 条件读权限 → 回收站(trash)/恢复(restore)继承 — 设计锁(design-lock)

> **状态**:**IMPLEMENTED**(owner 决策 2026-06-18 = Build:"被条件规则拒读的记录,即使进了回收站也不可见/不可恢复" 作为安全一致性要求)。
> - **首版 runtime by #2900**(`b86751f77`,并行 effort,与本设计锁并发开发):LOCK-1/2(shared evaluator + `loadRuleDeniedTrashRecordIds` 对 `meta_records_trash.data` 求值)、LOCK-3(trash list hide)、LOCK-5(restore refuse)、LOCK-7(admin bypass)、LOCK-8(flag-off inert)均已落地。
> - **LOCK-4 + LOCK-6 fix by 本 PR**(owner review 指出 #2900 未按这两条实现):**LOCK-4** —— `total` 改为 deny-aware(`listDeletedRecords` 新增 `excludeRecordIds`,COUNT+page 同口径排除,不再泄露隐藏记录基数);**LOCK-6** —— rule-denied restore 改返回与"记录不存在"完全同形态的 **404 NOT_FOUND**(非 403),消除存在性 oracle。real-DB golden 同步改 `total === 1` + restore 404 + 不存在 id 同形态断言。
> - 历史:本设计锁原写"实现 GATED, ratify 后再写 runtime";但 runtime 已由 #2900 先行合入 `origin/main`,故状态据实改为 IMPLEMENTED(+ LOCK-4/6 fix)。LOCK-1..8 仍是本特性的安全合同。
> **口径**:本文写 MetaSheet 自有安全设计口径,不引用任何竞品。
> **基线**:代码实测 @ `origin/main`(`permission-service.ts`、`permission-rule-evaluator.ts`、`record-service.ts`、`routes/univer-meta.ts`)。

## 0. 一句话

条件读权限规则(2b)的 read-deny 目前覆盖 **8/9** read surfaces;第 9 个 —— **回收站 list + 恢复(undelete)** —— 未继承,因为 `loadRuleDeniedRecordIds` 只对 **live `meta_records`** 求值,而 trashed 记录在独立的 `meta_records_trash` 表里。本设计把同一套规则求值扩到 trash snapshot,使「被规则拒读的记录」在回收站里**既不可见、也不可恢复**,且严格保持 #18 既有不变量(admin-bypass / flag-off inert / 不泄露基数)。

## 1. 现状对账(代码实测,verified)

- **rule-deny 求值面**:`loadRuleDeniedRecordIds(query, sheetId, recordIds?)`(`permission-service.ts`)`SELECT id, data FROM meta_records …` → 逐行 `evaluateRecordDenied({ data }, rules, fieldsById)`。**只读 live `meta_records`**(JSDoc 已自述:"trash (`meta_records_trash`) is a separate surface not yet covered")。
- **trashed 记录存储**:delete 路径(`record-service.ts` ~823)在同一事务内 `INSERT INTO meta_records_trash (record_id, sheet_id, base_id, data, original_version, …)`(`data` = 删除时的字段值快照),再 `DELETE FROM meta_records`。**trash 行带完整 `data` 快照** → 可对它跑同一套 `evaluateRecordDenied`。
- **trash LIST**:`GET /sheets/:sheetId/trash`(`univer-meta.ts` ~11362,gated on `canDeleteRecord`)。已做:field-read mask + `#18` 行级 deny 过滤 —— `if (!access.isAdminRole && loadRowLevelReadDenyEnabled) { deniedIds = loadDeniedRecordIds(…); filter out }`。
- **undelete(恢复)**:`POST` "#15 recycle bin — restore a deleted record"(`univer-meta.ts` ~11417 → `recordService.restoreRecord` 11431);id 被占用 → 409。
- **grant-deny 在 trash 上是否已生效?VERIFIED = 是**:`record_permissions` 表**无 FK / ON DELETE CASCADE** 到 `meta_records`(migration `zzzz20260413100000_create_record_permissions.ts` 仅 UNIQUE + INDEX),delete 路径也**不**删 `record_permissions` 行 → `'none'` grant 行在记录进 trash 后**持续存在**,故现有 11397 的 `loadDeniedRecordIds` grant-deny 分量**已正确**把 grant-denied 的 trashed 记录排除。**本设计不动 grant-deny 范围**,只补 rule-deny。
- **out of scope —— 版本恢复**:`POST /sheets/:sheetId/records/:recordId/restore`(6259)是 #13/#14 的 **live 记录历史版本恢复**(对 hard-deleted 记录 404 / delete-target `RESTORE_UNSUPPORTED`),**不是**回收站 undelete,本设计不涉及。

## 2. 威胁模型(本设计要堵的旁路)

一条记录被条件读规则拒读(规则对其字段值成立),但它已被删除进回收站。当前:(a) trash LIST 用 `loadDeniedRecordIds`,其 rule-deny 分量对 live 表求值 → 对该 trashed id 返回空 → **记录出现在回收站列表**;(b) 有 `canDeleteRecord` 的非管理员能 **undelete** 它 → 记录复活回 live(随即被 live rule-deny,但复活动作本身 + 200 响应已泄露其存在,且把它重新放回他人可见)。**= read-deny 经回收站旁路**。严重度 bounded(需 #18 phase-2 规则开启 ∧ 记录已 trash ∧ 用户有 trash 访问 三者同时成立),但语义上是真旁路,owner 选 Build 关闭它。

## 3. 锁定语义(LOCK —— ratify 对象)

### LOCK-1 规则在 trashed snapshot 上如何求值(owner 点名①)
对 trash 行的 **`meta_records_trash.data` 快照**跑**同一个** `evaluateRecordDenied(record, rules, fieldsById)`,`fieldsById` 用**当前 live `meta_fields`** 元数据 + sheet 的 `conditional_read_rules`。即:用「删除时的字段值」+「当前规则/字段定义」判定。理由:trash 行就是该记录最后已知的字段值;复活后它会以这份 data 回到 live,故按这份 data 判 deny 与「复活后是否会被拒读」一致。**不**去 live 重新取(记录不在 live)。

### LOCK-2 live 与 trash 共用同一求值核(防语义漂移)
抽出一个**共享**例程「对 `{id, data}` 行集合 + rules + fieldsById 逐行 `evaluateRecordDenied`」;`loadRuleDeniedRecordIds`(live)与新的 `loadRuleDeniedTrashRecordIds`(trash,`SELECT record_id AS id, data FROM meta_records_trash …`)都调它。**fail-closed 语义在两条路径必须逐字节一致**(漂移本身即安全 bug)。
- **预期副作用(intended,非 bug)**:trash 的 fail-closed 会**比 live 更常触发** —— 记录 trash 后,规则引用的字段可能已被删除 → 这类 trashed 行**全部 deny**。方向安全(更严),本文显式声明为预期行为,避免日后被误读为缺陷。

### LOCK-3 trash LIST gating
扩 11397 过滤:非管理员 ∧ flag-on 时,trash list 额外排除 `loadRuleDeniedTrashRecordIds` 命中的行(**scope 到当前页 record_ids**,避免全表扫)。与既有 `loadDeniedRecordIds`(grant-deny)取并集 —— deny-wins。

### LOCK-4 `total` 计数也排除(owner 安全口径 = 不可见 → 不泄露基数;**in-scope,非 follow-up**)
既有代码注释把 exact-count 排除留作 "minor follow-up"。因 owner 明确把本面定为**安全一致性要求(不可见)**,一个仍计入 N 条隐藏 trashed 记录的 `total` 就是 #18 要防的**基数泄露**。**本 Build 内**把 denied trashed 记录从 `total` 一并排除(list 与 count 同口径)。

### LOCK-5 恢复(undelete)前 gating(owner 点名②)
`restoreRecord`(11417/11431)在**复活写之前**:非管理员 ∧ flag-on 时,对该 trash 行跑 LOCK-1 求值;命中 deny → **拒绝复活**(不写)。理由:不能读这条记录的人,不得把它复活。

### LOCK-6 被拒的 undelete 与「不存在」不可区分(防存在性 oracle)
被 rule-deny 的 undelete **必须返回与「记录不存在」完全相同的响应形态**(同 404 not-found shape),**不**用单独的 403,避免有 `canDeleteRecord` 的用户靠 403/404 差异枚举出「哪些被规则隐藏的记录存在于回收站」。(grant-denied undelete 亦同此口径。)

### LOCK-7 admin bypass(owner 点名③)
管理员(`access.isAdminRole`)**bypass** trash list 过滤与 undelete gating —— 与 live read-deny 完全一致(admins bypass record-level read)。

### LOCK-8 flag-off inert(owner 点名④)
`loadRowLevelReadDenyEnabled(sheetId)` 为 false(默认)时,trash list + undelete **与 pre-2b 逐字节一致**:不发 `conditional_read_rules` 查询、不对 trash 求值。列缺失 / 规则空 / 表缺失(pre-migration)→ inert,**绝不** 500、绝不静默放行成 deny 之外的行为(沿用 `loadRuleDeniedRecordIds` 既有 fail-closed-on-error)。

## 4. 不变量(继承 #18,必须保持)
deny-wins(并集)· admin-bypass(LOCK-7)· flag-off byte-identical(LOCK-8)· 无基数泄露(LOCK-4 + LOCK-6)· fail-closed(LOCK-2)· 不改 grant-deny 范围(§1)· 不碰 live 8/9 surfaces · 不碰版本恢复(6259)。

## 5. 验收 / 测试计划(real-DB,impl 阶段交付)
1. **trash list 排除**:flag-on、非 admin、一条 trashed 记录其 data 命中规则 → 不在 list;`total` 也 -1(LOCK-3/4)。
2. **admin 全见**:同场景 admin → list 含该记录、total 不减(LOCK-7)。
3. **flag-off byte-identical**:flag-off → list/total 与 pre-2b 完全一致(LOCK-8)。
4. **undelete 被拒 = not-found shape**:非 admin undelete 一条 rule-denied trashed 记录 → 与 undelete 一个不存在 id **同形态**(LOCK-5/6);记录未复活(live 表无该行)。
5. **undelete 正常**:非 denied trashed 记录 → 正常复活。
6. **deleted-field fail-closed**:规则引用的字段在 trash 后被删 → 该 trashed 行 deny(list 排除 + undelete 拒)(LOCK-2 预期副作用)。
7. **grant-deny 回归**:grant-denied trashed 记录仍被排除(§1 未回归)。
8. CI allowlist 确认(不靠 green job 推断);live 8/9 surfaces 回归不变。

## 6. 实现切片(ratify 后,各自 gated;**现在不写**)
- **S1**:共享求值核 + `loadRuleDeniedTrashRecordIds`(纯逻辑 + 单测:fail-closed / 字段缺失 / 空规则 / flag-off-inert 等价)。
- **S2**:trash LIST gating + `total` 同口径(real-DB golden:list 排除 + count -1 + admin 全见 + flag-off 等价)。
- **S3**:undelete pre-gate + not-found-shape(real-DB golden:被拒=not-found、未复活、正常复活、deleted-field deny)。
- 每片独立 PR + real-DB 反向测试;先 S1(逻辑)再 S2/S3(路由)。

## 7. STOP
**本文是 design-lock,不含 runtime。** 上述 LOCK-1..8 是 ratify 对象;owner 签字后才进 §6 实现。未签字前不写 runtime(同 S1b design-lock #2884 → 签字 → impl 的门)。
