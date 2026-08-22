# Demo Script & Takeover Pitch — 生产备料系统 → MetaSheet

Audience: workshop with **PMC / 生产 / 采购 / 仓库** roles + IT/信息部. Goal: prove MetaSheet reproduces every day-in-the-life flow of the customer's running 备料系统, then close with the security argument for switching on day one.

- Source of truth: `zip/backend/.../controller/StockInfoController.java` (2117 lines) + `GeneralStockInfoController.java` + prior report `scratchpad/reports/zip-backend-domain.md`.
- Path shorthand: `SIC = zip/backend/src/main/java/yaguang/stock/order/controller/StockInfoController.java`, `GSC = .../GeneralStockInfoController.java`.
- **Values-free**: no hostnames / IPs / passwords / authority-codes / appKeys are copied. Where a secret lives is cited by file:line only.

---

## 0. The one-slide story

> "Today PMC types a 项目号, clicks 拉取, and your three departments race to fill a shared grid while a wall of PLM/K3/钉钉/宜搭 glue holds it together — glue that today anyone on the network can also poke. MetaSheet keeps the exact same day-in-the-life, replaces the glue with a **read plan + native grid + automations**, and on day one closes the anonymous `/erp/*` K3 write hole and the plaintext-password login."

Six flows the demo must reproduce, in order: **(A) pull BOM → tree**, **(B) three roles edit their columns**, **(C) refresh a batch, human edits survive**, **(D) 需求日期 auto-computed**, **(E) 钉钉 待办/审批**, **(F) Excel 导入/导出**. Then the **security pitch**.

---

## A. PMC pulls a project's BOM from PLM → tree of 备料明细 appears

### User action (old system)
PMC selects/enters a 项目号 and clicks 拉取. Front end calls `POST /stock/refreshProduct` with `{productCode, userName, loginUserId}` (`SIC:232`).

### What the old system does
- `SIC:239` `selectCountByProductCode` — if the project has **0** rows in `stock_info`, it is a first-time pull: `doGetAllBomInfo(productCode)` (`SIC:995`).
- `doGetAllBomInfo` reads the **PLM SQL Server** (db01): BOM 订单 (`DN_PDM_OrderHeadInfo/OrderDetailInfo`) keyed by 项目号, then finds the **总图** — 图号 starts `J`, ends `-00` (`SIC:1002`). With 总图: take the highest-`SysVer` 总图 + all 钣金图 (`-A`/`-B`, `SIC:1024-1030`). Without 总图: take every BOM-order row but strip rows that are children of another row via `checkHierarchyRelationship` (`SIC:1010-1019`).
- For each entry it recurses children via `selectChildrenBomByPliObjId` + `GetChildrenBom` (`SIC:1057-1090`); child 生产数量 = 明细数量 × 父数量 (`SIC:1084`).
- Persists the tree with `iterSave_concurrent` (`SIC:248`, thread pool + `Thread.sleep(1000)`), builds `nameAndStandard`, auto-creates missing 材料 dictionary rows, and mirrors each row into `purchase_info` + `warehouse_info`. `updateProductInfo` (`SIC:254`) guarantees a `product_status` row exists.
- Result: a **tree** (parentId / parentComponentCode) of 备料明细 rendered in the grid.

### How MetaSheet reproduces it
- **Read plan** against PLM (db01) replacing `doGetAllBomInfo`: one plan node = 项目号 → 总图 selection (`J…-00`, max SysVer) + 钣金 (`-A/-B`) → recursive child expansion with the `qty = detail_qty × parent_qty` rollup. The 总图-selection and hierarchy-strip rules (`SIC:1002-1019`) become **read-plan filters/rules**, not Java.
- **Native grid tree**: `parentId` maps to MetaSheet's native parent/child row nesting — the 备料明细 tree renders natively; no custom recursion code.
- **ext_ columns** hold the PLM-derived, non-editable provenance fields (`pliObjId`, `componentSysVer`, `componentSortId`, `totalNum`, 图号/名称) so a refresh can re-match rows by `pliObjId` without touching human columns.
- **Demo beat**: type 项目号 → click *拉取* automation → tree of 备料明细 appears in < a few seconds. Same click, same result.

---

## B. 生产 / 采购 / 仓库 — three roles each fill their columns (grid inline edit)

### User action (old system)
Each role opens the same project grid and inline-edits **their** columns; saving a cell calls `POST /stock/update` (`SIC:1146`) per row (optimistic-lock `version`). Column visibility/editability per role is driven by `columns` / `role_column` / `ColumnVo.editable` and per-user `table_column_config`.

### What the old system does — the column ownership
- **生产 (PMC/生产)** fill on `stock_info` directly: 材料类型 (`rawMaterialType`), 毛胚类型 (`embryoType`), 备注, 领料节点, 交接工段, 需求日期, 提前周期 (`normalLeadDays`), 备料情况, 毛胚 长/宽/厚/数量/质量, 规格. `update` re-derives `nameAndStandard` and turns dictionary names → ids via `handleConfigColumn` (`SIC:1155`, def `SIC:1994`).
- **采购** fill the **mirror table** `purchase_info`: `purchaseResponseDate`, `purchaseMember`, `purchaseRemark` — via `/purchase/update` + `/purchase/batchUpdate` (join brings them back onto the stock row for display, `stockInfoMapper.xml:126-128`).
- **仓库** fill `warehouse_info`: `materialReportIssuance`, `actualDeliveryDate`, `materialConfirm`, `actualMaterialType` — via `/warehouse/update` + `/warehouse/batchUpdate`. Note `materialConfirm` is writable from **three** places: `/warehouse/update`, `/stock/update` sync (`SIC:1159-1165`), and `pushYiDaForMI`.
- Editability is enforced only cosmetically (front end reads `editable`); server does **not** check role on update (see security section).

### How MetaSheet reproduces it
- **One native grid, column-level permissions**: `role_column` → MetaSheet **column permissions** (生产/采购/仓库 each editable on their own columns, read-only elsewhere) — and this is now **server-enforced**, not just a front-end flag.
- The purchase/warehouse **mirror tables collapse into ext_ columns** on the same sheet (`ext_purchase_*`, `ext_warehouse_*`), removing the `purchase_info`/`warehouse_info` join and the `stock_info_id` two-table ambiguity (prior report §6). All three roles edit **cells on one row** — no cross-table sync code, no `materialConfirm`-written-from-3-places problem.
- **Inline edit** = MetaSheet native grid inline edit; optimistic concurrency is native (replaces hand-rolled `version` checks and the "数据已被他人修改" message at `SIC:1153`).
- **Demo beat**: log in as 生产 → fill 材料类型/毛胚; switch to 采购 → 采购 columns editable, 生产 columns greyed; switch to 仓库 → same. Three people, one live grid.

---

## C. Refresh a batch → new rows added, human-filled + purchase/warehouse rows PRESERVED

**This is the flow that wins or loses the workshop.** The customer's fear: "if I re-pull the BOM, do I lose everything my team typed?"

### User action (old system)
PMC clicks 拉取 again on a project that **already has rows**. `POST /stock/refreshProduct` → since count > 0 → `refreshCurProductAllStockInfo` (`SIC:251`, def `SIC:271`).

### What the old system does — the reuse/carry engine
1. Re-read all BOM-order first-level rows; compare against the DB's **parent-less** old rows by `pliObjId`; rows not in DB = **current batch** (`SIC:277-291`).
2. Current batch: if it has a 总图 (`Utils.regx_general`) take max version + 钣金; else process all current-batch components (`SIC:292-320`).
3. `doRefreshCurProductAllStockInfo` (`SIC:442`): expand children (`doGetAllBomInfo2`), insert the fresh batch with `iterSave_recordAdd_concurrent` into `curBatchInDb` (`SIC:454`).
4. **Carry-over** (`SIC:471-511`): for each old row that (a) has no parent, or (b) shares a `pliObjId` with a current-batch parent-less row, find the matching new row and copy across:
   - `createTime` / `createBy` / `updateBy` (so search-by-batch-time still works),
   - **all human 备料 fields** via `reuseStockInfo` (`SIC:960-988`),
   - parent-hierarchy info when needed (`SIC:492-497`),
   - and the **采购/仓库 content** via `reuseForPurchaseAndWarehouse` (`SIC:503`, def `SIC:519-543`) — old `purchase_info`/`warehouse_info` values BeanUtils-copied onto the new rows (keeping the new id/version).
5. Recurse into children with `iterCompare` (`SIC:556`); **user-hand-added rows** (`pliObjId == null`) are re-parented and re-inserted so manual additions survive too (`SIC:577-592`).
6. Only after carry-over does it **delete the old batch rows + their purchase/warehouse rows** (`SIC:514-519`).

**The single most-citable primitive** — the "which prior fill do I inherit?" rule for a brand-new row (borrowed/通用 component seen in another project): `reuseStockInfoExistsInDb` (`SIC:935-955`): `selectByPliObjId` → pick the **latest `createTime`** across all projects (`SIC:941-943`) → `reuseStockInfo` copies 规格 / 备料情况 / 材料类型 / 毛胚类型 / 备注 / 领料节点 / 交接工段 / 需求日期 / 提前周期 / 毛胚尺寸 (`SIC:960-988`). This is the carry logic to reproduce exactly.

### How MetaSheet reproduces it
- **Refresh = idempotent read-plan re-sync keyed on `ext_pliObjId`** (plus 图号 for hand-added rows). The plan re-materializes BOM structure/quantities; a **merge/upsert automation** matches incoming rows to existing rows by `ext_pliObjId` and:
  - **new pliObjId** → insert; seed 备料 columns from the **latest prior fill of the same `pliObjId`** (the `reuseStockInfoExistsInDb` "newest createTime" rule, `SIC:935-955`),
  - **existing pliObjId** → **preserve every human-owned column and the 采购/仓库 ext_ columns** (structure/quantity refreshed from PLM, human fills untouched),
  - **hand-added rows** (`ext_pliObjId` empty) → carried and re-parented, mirroring `SIC:577-592`.
- Because 采购/仓库 are **ext_ columns on the same row** in MetaSheet, `reuseForPurchaseAndWarehouse` disappears — preserving them is automatic (they never leave the row). This removes the biggest correctness risk in the old code: the **no-transaction, insert-then-delete** batch swap (prior report §6.2) that can leave half-new/half-old data if it fails mid-way. MetaSheet's sync is transactional.
- **Demo beat (the money shot)**: 生产 fills 5 rows, 采购 fills 采购备注, 仓库 fills 实际到货日. PMC clicks *拉取* again (simulating a new PLM 批次). New rows appear; **every typed value stays put**; a hand-added row survives under its parent. Say out loud: *"same reuse rule as today (`reuseStockInfoExistsInDb`), but atomic — no half-written batches."*

---

## D. 需求日期 computed from 总图 − leadDays

### User action (old system)
生产 fills the 总图's 需求日期, gives each row a 提前周期 (`normalLeadDays`), and clicks 刷新需求日期. `POST /stock/refresh/{userName}` with the visible rows (`SIC:1093`).

### What the old system does
- Find the first-level 总图: 图号 ends `-00` **and** 需求日期 already filled (`SIC:1108-1114`); if none → fail "未找到总图或总图的需求日期信息" (`SIC:1116`).
- For every project row except the 总图 and rows with null `normalLeadDays` (`SIC:1123-1132`): `requirementDate = 总图需求日期 − normalLeadDays` (`SIC:1128`), persisted via `updateRequirementDate` (note: carries a `version` condition but does **not** increment it, `stockInfoMapper.xml:860-865`).
- (Historical `_bk` variant walked the tree top-down parent-minus-child; current version is **flat: everything relative to the 总图**.)

### How MetaSheet reproduces it
- **Computed / formula column** `需求日期 = [总图.需求日期] − [提前周期]`. The 总图 anchor is a lookup (row where 图号 ends `-00`); MetaSheet recomputes reactively on any 提前周期 or 总图-date change — no explicit 刷新 click, no batch update loop, no non-incrementing-version quirk.
- If the workshop prefers an explicit button (change management), wrap it as a one-click **automation** that runs the same formula across the project.
- **Demo beat**: set 总图 需求日期 → every child's 需求日期 fills in instantly per its 提前周期. Change one 提前周期 → that row updates live.

---

## E. 钉钉 待办 / approval for changes

### User action (old system)
- **生产 发起常规待办**: after拉取/填写, 生产 clicks 发送待办 → `POST /stock/notice` with `useTag = 0` (`SIC:1462`, `SIC:1475`). A 钉钉 process instance is started carrying 项目号 / 规格 / 当前批次物料时间范围 / 待办分支="常规" (`SIC:1477-1497`), addressed via the initiator's **手机号 → userId** (`DingUtil.sendToDo`, `SIC:1498`).
- **采购/仓库/生产 发起修改待办**: `useTag != 0` (`SIC:1503`). Changed material ids come in `editIds`; rows are grouped by 项目号, one instance per project, 待办分支 = `targetDeptName + "确认"` (`SIC:1538`); a `ding_talk_comment` row records `approvalInstanceId / editIds / useTag / 发起部门` (`SIC:1546-1562`).
- **Downstream sees the 待办**: `POST /stock/getApprovalStatus/{requestType}` (`SIC:1580`) lists last-7-day RUNNING instances where a task node is the current user and unapproved (`SIC:1592-1614`), parsing 项目号/时间范围 from the 钉钉 form and attaching `editIds` + a `useTag` mapped from 发起部门 (生产=1 / 仓库=2 / 其它=3, `SIC:1650-1660`).
- **Approve**: `POST /stock/throughApproval` (`SIC:1685`) → `DingUtil.executeProcessInstance2` (result=agree) and logs a comment (`SIC:1690-1700`).
- 通用件 uses the same machinery with 项目号 forced to "通用件" (`GSC:385`, filter at `GSC:483`).

### How MetaSheet reproduces it
- **Automation triggered on cell change** (生产 filling a batch, or 采购/仓库 editing flagged rows) → sends the 钉钉 待办/审批, carrying the same fields (项目号 / 规格 / 批次时间范围 / 待办分支). The initiator lookup (**手机号 → 钉钉 userId**) and `PROCESS_CODE` move from hard-coded constants in `DingUtil` (`DingUtil.java:23-28,51-53` per prior report §5.4) into **MetaSheet connection config / secrets** — no code, no recompile.
- **`editIds` → a filtered selection / saved view**: the "which rows changed" set becomes a MetaSheet row-selection the downstream role opens directly (replacing the `ding_talk_comment.editIds` round-trip and the two conflicting `useTag` numbering schemes flagged in prior report §3.6).
- **Approval status** = a MetaSheet **view/board** of pending items per role (native), optionally still mirrored to 钉钉 via automation for users who live in 钉钉.
- **Demo beat**: 采购 edits 3 rows → automation fires a 钉钉 修改待办 → 生产's 钉钉 shows the 待办 → approve → status flips in MetaSheet. Emphasize: **the same 钉钉 flow, but every secret is in config and the "which rows" list is a native selection, not a comma-string in a comment table.**

---

## F. Excel 导入 / 导出

### User action (old system)
- **导出**: `GET /stock/export?productCode&componentCode` (`SIC:1365`) → POI XSSF, **23 columns** (序号, 备料日期, 生产编号, 父组件图号/名称, 图号, 名称及规格, 规格, 材料, 总数量, 材料类型, 毛胚类型, 备注, 领料节点, 交接工段, 需求日期, 提前周期, 备料情况, 毛胚 长/宽/厚/数量/质量) written straight to the response stream (does 5 `config_info` single-lookups per row).
- **导入**: `POST /stock/importProduct/{userName}` (`SIC:1963`) — rows get `pliObjId = importTag` (a marker so they're never PLM-refreshable), `version=0`, `componentSysVer=1`, dictionary names → ids via `handleConfigColumn`, mirrored into 采购/仓库. **Note: the feature is annotated 暂停 / 停用** ("暂停该需求 20250819", `SIC:1959`) precisely because imported rows have no `pliObjId`, can't be sorted by hierarchy, and can't refresh from PLM (`SIC:1955-1962`). 通用件 import: `GSC:623`.

### How MetaSheet reproduces it
- **导出** = MetaSheet native grid export (Excel/CSV) with a **saved column layout** matching the 23-column sheet — no POI, no per-row dictionary re-query, no "stream already committed but still returns Result" bug (prior report §6.7).
- **导入** = MetaSheet native paste/upload. Crucially, the old system **had to disable import** because imported rows lacked `pliObjId` and broke refresh/sort. In MetaSheet, `ext_pliObjId` is just an optional column: imported rows coexist with PLM rows, sort by an explicit order column, and simply **don't participate in the pliObjId-keyed re-sync** (opt-out is data, not a special code path). So MetaSheet can **re-enable the import the customer had to shut off** — a concrete "we fix what you gave up on" win.
- **Demo beat**: export the project to Excel (matches their current sheet 1:1), edit a couple rows in Excel, paste back — imported rows live alongside pulled rows without breaking a later 拉取.

---

## G. TAKEOVER SECURITY PITCH (values-free) — what switching fixes on day one

Frame to IT/信息部: *"Your备料系统 works, but it is running with the doors open. Here is what a takeover closes the moment you cut over — no phased hardening project, day one."*

### Risk 1 — Every endpoint is anonymous; nothing checks who you are
- `SecurityConfig.java:19` sets `antMatchers("/**").permitAll()` — **all** endpoints open. The intended `TokenFilter` and `.anyRequest().authenticated()` are **commented out** (`SecurityConfig.java:21,25`).
- Identity is whatever the client sends: `loginUserId` / `userName` / `loginUser` in the path or body. The one server-side check (`CheckPermissionsAspect`) is used on only 4 RoleController methods and **passes through when `loginUserId` is null** (prior report §5.6).
- **Fix on day one**: MetaSheet enforces authenticated sessions + **server-side role/column permissions** (the 生产/采购/仓库 column ownership from flow B is enforced, not cosmetic). No endpoint is reachable anonymously.

### Risk 2 — Anonymous `/erp/*` endpoints can drive **K3 writes**
- `ErpController` is mapped at `/erp` (`ErpController.java:27`) under the same `permitAll`. It exposes **write** endpoints to 金蝶 K3: `POST /erp/addMaterial` → `Material/Save` (`ErpController.java:92,193`), `POST /erp/addBom` → `BOM/Save` (`:245`), `POST /erp/saveEcn` → `Bill1002535/Save` 工程变更单 (`:355`), `POST /erp/savePPBomEcn` → `Bill1002502/Save` 生产投料变更单 (`:550`), `POST /erp/savePD` → `PD/Save` 生产任务单 (`:769`).
- These are hard-coded **prototypes** today (no real business input), but they are **reachable by anyone on the network** and each one **acquires a K3 token and calls the K3 WebAPI**. The blast radius is your live ERP.
- The K3 **host + authorityCode are hard-coded** in `ErpController.java` (constants near `:34-36`, and the token URL is re-hard-coded around `:73` — locations only, values not reproduced here).
- **Fix on day one**: takeover removes the anonymous `/erp/*` surface entirely. K3 integration becomes a **governed, authenticated automation/connection** with credentials in MetaSheet secret config — no public HTTP path that can write to K3.

### Risk 3 — Plaintext credentials everywhere
- **User login is plaintext**: `userMapper.xml:40-54` does an equality match on name+password (prior report §2.14/§5.6); `/user/addUser` stores the password in the clear (prior report §2.19). A `BCryptPasswordEncoder` bean is even declared but **unused** (`SecurityConfig.java:36`).
- **Datasource credentials are plaintext** in `application-dev.yml` / `application-prod.yml` (url/username/password for the MySQL 备料库, the PLM SQL Server, and the K3 SQL Server); `application.yml:4` activates `prod` (prior report §0/§5). Anyone with repo/deploy access reads all three databases — including **direct K3 DB** connectivity.
- **Integration secrets are hard-coded in source**: 钉钉 appKey/appSecret/agentId, 宜搭 appType/systemToken/formUuid, SMB share credentials, upload API — locations in `DingUtil.java` / `SmbjFileProcess.java` (prior report §5.4/§5.5).
- **Fix on day one**: MetaSheet uses hashed credentials + SSO/session auth for users, and all DB/integration secrets move to **managed secret config** out of source control. Rotating a credential no longer means editing and redeploying Java.

### Risk 4 — No transactions, no audit boundary
- Multi-table writes (`stock_info` + `purchase_info` + `warehouse_info` + `product_status` + `ding_talk_comment`) are **non-atomic**; the batch-refresh insert-then-delete (flow C, `SIC:454` vs `SIC:514-519`) can leave half-new/half-old data on failure (prior report §6.2). There is **no `@Transactional`** anywhere.
- **Fix on day one**: MetaSheet writes are transactional and versioned, with a real audit trail — the batch swap in flow C can no longer corrupt a project.

### Risk 5 — Aging, vulnerable dependency surface
- fastjson 1.2.80, log4j 1.x (with an SMTP mail appender configured in `log4j.properties`), Spring Boot 2.7.15 on Java 8 (prior report §6.8-9). These are the exact libraries with well-known RCE/deserialization histories, sitting behind a `permitAll` front door.
- **Fix on day one**: takeover retires this stack; the备料 workload runs on MetaSheet's maintained platform instead of an unpatched Spring Boot app.

### The close
> "Everything your team does today survives the move — the BOM pull, the shared grid, the batch-reuse that keeps their typing, the 需求日期 math, the 钉钉 待办, the Excel round-trip. What does **not** survive is the anonymous `/erp/*` K3 write path, the plaintext passwords, and the `permitAll` front door. Those close the day you cut over."

---

## H. Demo run-sheet (tight sequence for the room)

1. **A** — Enter 项目号, click 拉取 → BOM tree of 备料明细 appears.
2. **B** — Log in as 生产 (fill 材料类型/毛胚), 采购 (fill 采购备注), 仓库 (fill 到货日) on the same grid; show columns lock per role.
3. **D** — Set 总图 需求日期 → children auto-fill via 提前周期 formula.
4. **C** — Click 拉取 again (new 批次) → new rows appear, **all typed values + a hand-added row survive** (say: `reuseStockInfoExistsInDb`-equivalent, now atomic).
5. **E** — 采购 edits flagged rows → 钉钉 修改待办 fires → 生产 approves → status flips.
6. **F** — Export to Excel (matches their 23-column sheet), paste a row back; note import that they had to disable now works.
7. **G** — Security slide: `permitAll` + anonymous `/erp/*` K3 writes + plaintext creds → closed on day one.

## I. Old-system mechanics → MetaSheet primitive (cheat sheet)

| Old-system mechanic | Key cite | MetaSheet primitive |
|---|---|---|
| Pull BOM tree from PLM | `SIC:232,995-1090` | Read plan (PLM) + native tree grid |
| Row provenance (pliObjId, sysVer, sortId) | `SIC:705-746` | ext_ columns |
| Three-role column ownership | `role_column`, `/purchase`,`/warehouse` update | One grid + server-enforced column permissions |
| Purchase/Warehouse mirror tables | `purchase_info`/`warehouse_info` | ext_ columns on same row (join gone) |
| Batch refresh + reuse human fills | `SIC:271,442-592` | Idempotent read-plan re-sync keyed on ext_pliObjId (transactional) |
| "Inherit latest prior fill" | `reuseStockInfoExistsInDb` `SIC:935-955` | Seed-from-newest automation rule |
| 需求日期 = 总图 − leadDays | `SIC:1093-1132` | Computed/formula column |
| 钉钉 待办/审批 | `SIC:1462-1700`, `DingUtil` | On-change automation + native approval view; secrets in config |
| editIds "which rows changed" | `ding_talk_comment.editIds` | Native row selection / filtered view |
| Excel 导出 (23 col) / 导入 | `SIC:1365,1963` | Native export/import; import re-enabled |
| Anonymous `/erp/*` K3 writes | `ErpController.java:27,92,245,355,550,769`; `SecurityConfig.java:19` | Removed; governed authenticated K3 automation |
| Plaintext creds | `userMapper.xml:40-54`; `application-*.yml`; `DingUtil.java`/`SmbjFileProcess.java` | Hashed auth + managed secret config |
