# 多维表 Cross-base ②b 能力 — 设计锁定刷新(墙后重写)— 2026-06-13

> Status: **DESIGN-LOCK(docs-only,无运行时代码)** — 供 owner opt-in;本文档不实现任何运行时。
> 刷新缘由:#2510 §3 的 ②b 设计写于 **②a 治理墙落地之前**。墙已合入(`foreignBaseId` 零 opt-out 全拒),故本文按 **当前已合并代码(base 7fe7d6c16)** 逐条 file:line 重写 ②b,使设计**建在墙上**而非绕墙。
> 自有原则:本文只陈述 MetaSheet 自身的治理原则与不变量;不引用任何外部产品。
> 前置:本文不取代 #2510 §1/§2(承重事实 + 治理墙锁定),只刷新 §3(能力层);#2510 §2 描述的墙现已是**已合并事实**,见 §1。

---

## 1. 地基复盘 — 墙现在提供什么(②a 四件已合并)

②b 必须**消费**这四件,而不是重造。逐件 file:line:

### 1.1 §2a.1 base 级可读性原语 `resolveBaseReadable`(已建,**未接线**)
- `packages/core-backend/src/multitable/permission-service.ts:1244-1264`。签名 `resolveBaseReadable(req, query, baseId): Promise<boolean>`。
- 派生:① admin role(`access.isAdminRole`,:1253)→ 任意 base;② 全局 base-read 授权码(`BASE_READ_PERMISSION_CODES` = `multitable:base:read` / `multitable:base:admin` / `multitable:admin`,:114-122 / :1254)→ 任意 base;③ base 属主(`meta_bases.owner_id === actor`,:1256-1263)→ 该 base。缺失 / 软删 base(`deleted_at IS NULL` 过滤,:1257)→ 不可读、不 null-deref。
- 文档明示(:1240-1242):**这是 ②b 将消费的原语;此处刻意未接线**;墙(§2a.2)只比两个 base_id 字符串,不调它;它**不碰** central RBAC/auth,纯多维表内核内。
- → ②b 的读路径接线点(§3)。

### 1.2 §2a.2 链接 base 墙 `validateLinkFieldConfig`(零 opt-out 全拒)
- `packages/core-backend/src/routes/univer-meta.ts:1067-1094`。`link` 字段写时:`baseIdsAreCrossBase(sourceBaseId, foreignBaseId)`(:1089)→ 跨 base 即返回 4xx 错误串(:1090),**当前无任何 opt-out 标志**(:1051-1052 明示 `foreignBaseId` 是 ②b 的事)。
- 跨 base 判定走共享 `baseIdsAreCrossBase(a,b) = a !== b`(:1029-1031),null-aware:null/legacy base 与 set base 算跨 base;null-vs-null 与 same-set 算同 base。
- 调用 compat:仅当**原始 payload 显式带 foreign-sheet 键**(`linkForeignKeyInPayload`,:912-916,覆盖 `foreignSheetId`/`foreignDatasheetId`/`datasheetId` 三别名)时才触发;rename-only PATCH 不重判(GA-T4b)。
- **写 chokepoint 两处**:CREATE field(:5599-5610)、PATCH/转换 field(:5915-5937,含 `nextType==='link' && currentType!=='link'` 非 link→link 转换条款,堵两步绕过)。
- → ②b 把"全拒"改为"**非显式才拒**":带合法 `foreignBaseId` 的跨 base 链接放行(§2),墙本身改动见 §2。

### 1.3 §2a.3 跨 base 字段级掩码 `resolveForeignFieldReadability` / `shouldMaskForeignField` / `maskStoredRecordFieldIds`
- `resolveForeignFieldReadability`(:1945-1971):per-foreignSheet 解析 actor 可读外表字段 + `crossBase` 标志(`foreignBaseId !== sourceBaseId`,:1967),每外表一次。
- `shouldMaskForeignField`(:1979-1992):外表 targetField **可读则放行**(:1988 `readableFieldIds.has(targetFieldId)` → false);不可读时,**跨 base 无条件掩码**(:1990 `entry.crossBase` → true),同 base 默认掩码(除非显式 `skipForeignFieldMasking`,:1991)。
- `maskStoredRecordFieldIds`(:2131-2150):单一 CHOKEPOINT,经 `resolveTaintedFormulaFieldIds`(:2016) 把"读到被掩码外表字段的 formula(含 formula→formula 传递闭包)"从 actor 允许集剔除。已 UNIFORMLY 铺在所有 read/aggregate/export/history sink(:2978/:3122/:5283/:7061/:7183/:7366/:7447/:7925/:8362/:8583/:8734/:8885/:9501)。
- **②b 不变量**:此掩码对 actor **不可读**的跨 base 外表字段**已无条件生效**;②b 的 base-read 只能在其**之上加更粗的门**,绝不放宽它(§6 安全不变量)。注:对 actor **可读**的跨 base 外表字段,§2a.3 今天就放行(:1988)——base-read 是这层之外的**叠加 coarse gate**,不是 bypass。

### 1.4 §2a.4 sheet-create TOCTOU 收口 + base-delete 不可达 + 悬挂清理
- `validateSheetCreateNoRetroactiveCrossBaseLink`(:1110-1138):从另一侧堵——新建 sheet(caller 选 id+baseId)时,若某 EXISTING link 字段的 foreign 目标=新 sheet id 且其源表 base ≠ 新 base,则 4xx。**SQL 侧**比对(`COALESCE(NULLIF(trim(... 'foreignDatasheetId')),...)`,:1122-1126 + `baseIdsAreCrossBase`,:1132)。
- 集中于 **`createSeededSheet` chokepoint**(:3894-3911,仅 genuinely-new insert 时触发)+ **POST /sheets**(:6838-6849)。两处都先 `acquireLinkTargetMaterializationLock`(:3907/:6841)。
- base 删除已证不经 API 可达 + 悬挂链接有 ops 清理(#2510 §2a.4 已落)。
- → ②b 的 opt-in 必须让**这条 SQL 侧 TOCTOU 也认 `foreignBaseId`**(§2,这是唯一结构不同的站点)。

### 1.5 共享 helper `baseIdsAreCrossBase`(:1029-1031)
墙、TOCTOU、掩码 `crossBase` 三处的唯一真相源(掩码处用裸 `!==`,语义同)。②b 不改它——改的是"跨 base 是否**被允许**",不是"是否**是**跨 base"。

---

## 2. `foreignBaseId` opt-in 契约 —「显式且一致才跨」

### 2.1 契约语句
一个 `link` 字段携带显式 `foreignBaseId` 时,**当且仅当** `foreignBaseId` 等于**外表实际 `base_id`** 才被允许跨 base。这是一致性校验:**你不能声明错误的 base**。墙的"拒一切跨 base"由此变为"**除非显式且经校验的 opt-in,否则拒**"。

**术语消歧(写入文档,避免 :1088 同名混淆)**:
- `actualForeignBaseId` = 外表实际 base = `foreignSheet.baseId ?? null`(墙当前 :1088 的本地变量)。
- `claimedForeignBaseId` = opt-in 声明 = link property 里的 `config.foreignBaseId`(②b 新增,可空)。
- 校验:`claimedForeignBaseId === actualForeignBaseId`(严格相等,null-aware)。

### 2.2 `validateLinkFieldConfig` 的精确改动(:1067-1094)
在 :1089 的 `baseIdsAreCrossBase(sourceBaseId, foreignBaseId)` 命中分支内,**插入 opt-in 短路**(改写后逻辑):

```
sourceBaseId    = sourceSheet.baseId ?? null        // 不变
actualForeignBaseId = foreignSheet.baseId ?? null   // 即现 :1088 的 foreignBaseId,重命名以消歧
claimed = parseLinkFieldConfig(property).foreignBaseId ?? null   // ②b 新增字段(§4 codec/parser)

if (baseIdsAreCrossBase(sourceBaseId, actualForeignBaseId)) {
  // 跨 base：唯有显式且一致的 opt-in 放行
  if (claimed !== null && claimed === actualForeignBaseId) {
    return null            // opt-in 成立 → 放行（不再 4xx）
  }
  // 退化：actualForeignBaseId 为 null（legacy/无 base 外表）→ 无具体 base 可声明 → 不可 opt-in
  //（claimed===null 时落入下方拒绝；claimed!==null 与 null actual 不等亦拒绝）
  return `链接字段跨 base 需显式 foreignBaseId 且与外表实际 base 一致：源表 base=${sourceBaseId ?? 'null'}，外表 ${linkCfg.foreignSheetId} 实际 base=${actualForeignBaseId ?? 'null'}，声明=${claimed ?? 'null'}`
}
return null    // 同 base：不变
```

**退化用例(写入文档,§5 canary)**:null/legacy-base 外表无具体 base 可被声明 → 不可 opt-in(`claimed === null` 落拒绝串;`claimed !== null && actual === null` 因不等亦拒)。保持 §1.2 的 null-aware 语义不被 opt-in 撕开。

**注意**:opt-in 校验只是"声明 == 实际"的一致性闸,**不在此处加外表读权限校验**——读权限是 §3(base-read)+ §2a.3(字段掩码)的事,在墙内加 perm 会 over-reach(墙是纯结构比对,:1056-1057 已定调)。

### 2.3 必须同样认 `foreignBaseId` 的 base-比对站点(multi-sink 枚举)
墙是多 chokepoint 防御;opt-in 必须**一致地**被每个站点认识,否则一个站点放行、另一个拒绝就产生裂缝。逐站点:

| # | 站点 | file:line | opt-in 改动 | 侧 |
|---|---|---|---|---|
| S1 | 墙函数 `validateLinkFieldConfig` | univer-meta.ts:1089 | §2.2 短路(claimed===actual 放行) | TS |
| S2 | CREATE field 调用点 | univer-meta.ts:5599-5610 | 无需改逻辑(调 S1);但 §2.5 payload-gate | TS |
| S3 | PATCH/转换 field 调用点 | univer-meta.ts:5915-5937 | 无需改逻辑(调 S1);但 §2.5 payload-gate + 转换条款 | TS |
| S4 | TOCTOU SQL 守 `validateSheetCreateNoRetroactiveCrossBaseLink` | univer-meta.ts:1117-1132 | **SQL 侧改动**(见 §2.4) | **SQL** |
| S5 | `createSeededSheet` chokepoint(调 S4) | univer-meta.ts:3906-3911 | 随 S4 自动覆盖 | SQL(经 S4) |
| S6 | POST /sheets chokepoint(调 S4) | univer-meta.ts:6841-6849 | 随 S4 自动覆盖 | SQL(经 S4) |
| — | 掩码 `resolveForeignFieldReadability.crossBase` | univer-meta.ts:1967 | **刻意不改**(§6 不变量:opt-in 不放宽掩码) | — |
| — | `baseIdsAreCrossBase` helper | univer-meta.ts:1029 | **不改**("是否跨 base"≠"是否被允许") | — |

S1 是唯一逻辑改动点(TS);S4 是唯一**结构不同**的站点(SQL);S2/S3/S5/S6 经调用 S1/S4 自动受益,但 S2/S3 另需 §2.5 的 payload-presence 处理。

### 2.4 S4 的 SQL 侧精确改动(:1117-1132)
S4 当前 SQL 只取 EXISTING link 的 foreign 目标 + 源表 base,比 `baseIdsAreCrossBase(sourceBaseId, newSheetBaseId)`。让它认 opt-in **不是** `baseIdsAreCrossBase` 的调参微调,而是在 SQL SELECT 里**额外抽出该 link 字段的 `foreignBaseId` claim**并比对:

```sql
SELECT mf.id AS field_id,
       s.base_id AS source_base_id,
       NULLIF(trim(mf.property ->> 'foreignBaseId'), '') AS claimed_foreign_base   -- 新增
  FROM meta_fields mf
  JOIN meta_sheets s ON s.id = mf.sheet_id
 WHERE mf.type = 'link'
   AND COALESCE(NULLIF(trim(mf.property ->> 'foreignDatasheetId'), ''),
                NULLIF(trim(mf.property ->> 'foreignSheetId'), ''),
                NULLIF(trim(mf.property ->> 'datasheetId'), '')) = $1
```

TS 侧 :1130-1136 循环改为:跨 base 时,若 `claimed_foreign_base === newSheetBaseId`(该 link 已 opt-in 到这个即将创建的 base)→ 跳过(不报错);否则维持 4xx。即:一个已声明 `foreignBaseId = X` 的 link,在 base X 的 sheet 后建成时,TOCTOU 不应回溯拒绝它——因为它本就是合法的跨 base opt-in。

### 2.5 S2/S3 的 payload-presence 处理(承重 — 与 §7 immutable 决策耦合)
墙今天只在 payload 带 foreign-sheet 键(`linkForeignKeyInPayload`,:912-916,键集 `LINK_FOREIGN_KEYS` :912)时触发。若 `foreignBaseId` **可变**,则一个**只带 `{foreignBaseId: X}`**(无 foreign-sheet 键)的 PATCH 会改写 opt-in 声明却**不触发重判** → 存储的 claim 与现实脱钩、永不校验。两条出路:

- **(a) 把 `foreignBaseId` 加入 `LINK_FOREIGN_KEYS`(:912)** → 任何改 claim 的 PATCH 都触发 S1 重判。
- **(b) `foreignBaseId` 建后不可变(immutable-after-create)** → PATCH 试图改它一律拒绝(不是静默忽略),claim 一旦写定即与外表实际 base 绑死。

**推荐 (b)**,且它正是 §7 的 owner 决策项:更干净(不在热路径加重判分支)、claim 即真相、杜绝"先建同 base link 再 PATCH 加 `foreignBaseId` 谎称跨 base"。本文档把 §2.5 ↔ §7-决策3 显式连起来:选 (b) 则 S2/S3 无需扩 `LINK_FOREIGN_KEYS`,只需在 PATCH 路径拒绝 `foreignBaseId` 变更。

---

## 3. 读权限语义 — base 门 + 字段掩码双层

### 3.1 语义
跨 base link/lookup 的 reader 需 **源表读 AND 外表所在 base 读**。base 门用 §1.1 的 `resolveBaseReadable`;它与 §1.3 的字段级掩码**双层叠加**(base 门**先**判能否进这个 base,字段掩码**再**判这个 base 内哪些字段可见)。

### 3.2 接线点(两个读 sink,都要进 slice 1)
跨 base 读分两条独立 sink,**两条都必须在 slice 1 base-gate**,否则 slice 1 漏(源表 reader 能看到自己读不了的 base 的外表摘要):

- **Sink A — lookup/rollup hydration + formula-taint(共享派生)**:`resolveForeignFieldReadability`(:1945-1971)是喂给 lookup/rollup 物化**与** formula-taint 的**共享**派生。在其内,当 `crossBase`(:1967)为真时,先调 `resolveBaseReadable(req, query, actualForeignBaseId)`;**失败 ⇒ 该外表 `readableFieldIds` 置空**(等同所有外表字段不可读 → `shouldMaskForeignField` :1988 不命中放行 → 全掩码)。一处接线同时覆盖 lookup/rollup 物化与 formula 物化两个消费者。签名 `(req, query, baseId)` 直接可用,`actualForeignBaseId` 即 :1966 已算出的 `foreignBaseId`。
- **Sink B — 直读 link 摘要(独立路径,sheet 级 gate)**:**两处**仅按 sheet 级(`resolveReadableSheetIds` / `resolveSheetReadableCapabilities`)gate,**不查 base**:
  - `buildLinkSummaries`(:3557 `resolveReadableSheetIds`;:3611 `readableSheetIds.has(...)` 决定该外表摘要是否清空)——内联 link 摘要(/view、单记录读、写回 echo)。
  - `GET /link-records` 选择器端点(:9105-9106 `resolveSheetReadableCapabilities(...).canRead` → :9106 `if (!capabilities.canRead) return sendForbidden`)——link-picker 读外表候选。
  跨 base link 一旦开放,这两处必须**追加 base-read 门**:对 cross-base 外表,`readableSheetIds`/`canRead` 通过后**再**判 `resolveBaseReadable(foreignBase)`,失败则该外表摘要清空(Sink B-1)/端点 403(Sink B-2)。否则 slice 1 直接漏:有外表 sheet 读但无外表 base 读的 actor 可经 `/link-records` 枚举外表记录。

### 3.3 与 §2a.3 掩码的分层(精确)
- base 门(§3.2)= **粗门**:能否进这个 base。
- 字段掩码(§1.3)= **细门**:进了之后哪些字段可见;对跨 base 不可读字段**已无条件掩码**(:1990)。
- **两者都生效、AND 关系**:base 门拒 → 整个外表数据不出(摘要空 / 端点 403 / hydration 空);base 门过、字段掩码命中 → 该字段值仍被掩。base 门**只增不减**可见性——它是叠加的 coarse gate,非 bypass(§6)。

### 3.4 D3 golden 扩展(新维度,非新框架)
在现有真库 golden(`multitable-permission-golden-d3d1.test.ts` / `-d3d2.test.ts`,`describeIfDatabase` + plugin-tests.yml DB step)加**一个新维度**:`cross-base × {base-read granted, base-read denied}`,叠在既有 FIELD × VIEW 维度上。断言:
- cross-base + base-read granted + 字段可读 → 值出现;
- cross-base + base-read **denied** → 全外表数据不出(Sink A hydration 空 / Sink B 摘要空 / `/link-records` 403);
- cross-base + base-read granted + 字段 field-permission denied → 字段仍被 §2a.3 掩(双层验证)。
复用既有 seed/route harness,不引新测试框架。

---

## 4. 首个实现切片范围(gated MVP)— 一个可审 PR

**Slice 1 = schema + 墙 opt-in + base-read 读门 + golden 扩展。** 内容:

1. **Schema / 契约**:
   - link property 新增 `foreignBaseId?: string`(缺省=同 base,向后兼容)。
   - **parser** `parseLinkFieldConfig`(univer-meta.ts:894-903)+ `LinkFieldConfig` 类型(:869-872)抽出 `foreignBaseId`(trim,空→省略)。
   - **codec / sanitizer 显式化(wire-vs-fixture 纪律)**:`sanitizeFieldProperty` 的 link 分支(univer-meta.ts:1483-1493)与 `field-codecs.ts:206-219` 都 `...obj` 透传——**透传是偶然非契约**。两处都要把 `foreignBaseId` 提为**显式 normalized 键**(与 `foreignSheetId` 并列,trim,空→省略),使其**契约性**保留、不因日后收紧 spread 被静默丢。
   - **OpenAPI parity**:`MultitableField.property` 当前 `additionalProperties: true`(base.yml:2101-2103),故 parity 闸(`verify:multitable-openapi:parity`)不会拒它,但 spec **未记载** `foreignBaseId`。按 wire 纪律,在 spec 显式记 link property 的 `foreignBaseId`(描述其 opt-in 语义),并跑 `pnpm exec tsx packages/openapi/tools/build.ts` 重建 dist。
   - **wire round-trip 集成测试**:`foreignBaseId` 经真 wire(POST field → 读回 field / property)往返保真——正是 wire-vs-fixture 陷阱要堵的(白名单/pick/select 投影会静默丢字段)。
2. **墙 opt-in 路径**:§2.2 的 S1 改动 + §2.4 的 S4 SQL 改动;S2/S3 按 §2.5 推荐 (b) 在 PATCH 拒 `foreignBaseId` 变更(immutable)。
3. **base-read 读门**:§3.2 Sink A(`resolveForeignFieldReadability` 内接 `resolveBaseReadable`)+ Sink B-1(`buildLinkSummaries`)+ Sink B-2(`/link-records`)三处接线。
4. **golden 扩展**:§3.4 的 cross-base × base-read 维度。

**显式 DEFER 到各自独立 gated 切片**(切片边界理由附后):
- **跨 base AUTOMATION**:`update_record`(executor:1460-1502,patch `context.sheetId`,无 `targetSheetId`)/ `create_record`(`CreateRecordConfig` automation-actions.ts:42 只有 `sheetId`;executor:1510-1528 直 INSERT 无 base 校验)加 `targetBaseId` + 执行期目标-base 写权限校验。**理由**:automation 是**写**侧跨 base,触及"执行期 actor 对目标 base 的写权",与 slice 1 的**读**门是不同权限域 + 不同 chokepoint(executor vs route);混入会让一个 PR 同时改读写两套语义,不可独立审/回滚。
- **Yjs 跨 base fan-out**:房间 `sheet:{sheetId}` 已 base-agnostic(#2510 §1),FOL-1(#2464)一跳失效信号可跨 base 工作,但跨 base fan-out 覆盖面是独立验证项。**理由**:实时层无新协议但需独立 fan-out 正确性测试,与权限契约正交。
- **base 级速率限制 / 配额**:防 Base A 触发器 thrash Base B。**理由**:仅在 automation 切片开放后才有攻击面,naturally 跟在 automation 之后。
- **前端**:cross-base link picker(`/link-records` 跨 base 列)+ base 切换器。**理由**:单独 frontend 环,后端契约稳固后再做。

**切片边界总理由**:slice 1 = "**开一条受治理的跨 base 读链接**"——schema 一致性 + 墙 opt-in + 读门 + golden,全是**读侧 + 结构**,自包含、一个权限域、可独立审与回滚。写侧(automation)、实时(Yjs)、防滥用(quota)、UI 各自是不同域/层,强行同 PR 会破坏"一次一个显式 opt-in"的 staged 纪律。

---

## 5. Slice 1 fail-first 测试矩阵(canary)

沿用 ②a 的 GA-T* 命名风格 + 真库 `describeIfDatabase`,新增:

| canary | 场景 | 期望 |
|---|---|---|
| XB-1 | CREATE 跨 base link **带正确 `foreignBaseId`**(== 外表实际 base) | **放行**(墙不再 4xx);字段建成 |
| XB-1b | CREATE 跨 base link 带 `foreignBaseId` **不等于**外表实际 base | **拒绝 4xx**;字段未建(claim 不一致) |
| XB-1c | CREATE 跨 base link **不带** `foreignBaseId`(裸跨 base) | **拒绝 4xx**(墙 §1.2 现状,opt-in 缺失) |
| XB-1d(退化) | CREATE 跨 base link 指向 **null/legacy-base 外表**,带任意 `foreignBaseId` | **拒绝 4xx**(无具体 base 可声明,§2.2 退化用例) |
| XB-2 | reader **缺外表 base-read**,读含跨 base lookup 的记录 / 经 `/link-records` 拉外表候选 | hydration 空 / 摘要空 / 端点 403(Sink A+B 都验) |
| XB-2b | reader **有外表 base-read** 但外表字段 field-permission denied | base 门过、§2a.3 字段仍掩(双层) |
| XB-3 | 同 base link / lookup 现状回归 | **不受影响**(opt-in 不动同 base 路径) |
| XB-4 | `foreignBaseId` 经真 wire 往返(POST field → 读回 property) | 保真,不被 sanitizer/codec 丢(wire-vs-fixture) |
| XB-5(转换) | 非 link→link 转换,stash 跨 base 目标 + 带正确 `foreignBaseId` vs 无/错 claim | 有正确 claim 放行;无/错 claim 拒(:5928 条款 + opt-in) |
| XB-6(seed TOCTOU) | 先建带 `foreignBaseId=X` 的跨 base link,后在 base X 建该外表 sheet(POST /sheets 与 seed 路径各一) | TOCTOU **不**回溯拒绝合法 opt-in(§2.4);claim≠新 base 时仍拒 |

XB-1c/XB-3 锚定"墙现状不被 opt-in 撕开";XB-2/XB-2b 锚定双层读门;XB-4 锚定 wire 纪律;XB-6 锚定 S4 SQL 改动。

---

## 6. 风险 + gated 序 + 安全不变量

### 6.1 gated 序(每步独立 opt-in)
**slice 1(本设计)→ owner opt-in → automation 切片 → Yjs/quota → UI 切片**,每步单独 named opt-in,绝不自动接续下一环(staged opt-in lineage 纪律)。

### 6.2 必守安全不变量
1. **opt-in 不放宽 §2a.3 掩码**:`foreignBaseId` 是**结构/author-time 允许**(这条 link 能否跨 base 存在?);base-read 是**reader/read-time 门**(这个 actor 能否看进那个 base?)。**正交**。一个合法 opt-in 的跨 base link,对缺 base-read 的 reader 仍被全门掩。掩码层(:1967/:1990)**刻意不认 `foreignBaseId`**(§2.3 枚举表)。
2. **base-read 是叠加,非 bypass**:§2a.3 今天就让**字段可读**的跨 base 字段流过(:1988,非无条件全掩);base-read 只在其**之上**加一道粗门——只会**减少**可见性,绝不增加。Sink A/B 接线后,base-read 失败 ⇒ 外表数据**全不出**(比今天更严),不会让任何今天被掩的东西露出。
3. **claim == 实际 才放行**:`foreignBaseId` 是一致性闸不是信任输入(§2.1);谎报 base 必拒(XB-1b)。
4. **同 base 零回归**:opt-in 只动跨 base 命中分支(:1089 内),同 base 路径(墙返回 null、掩码 same-base 语义)不变(XB-3)。

---

## 7. Owner 决策(每项附推荐默认,可「按推荐」一词确认)

| # | 决策 | 选项 | 推荐默认 |
|---|---|---|---|
| 1 | 开跨 base 读是否**需外表 base 属主显式 grant**,还是由 `resolveBaseReadable` 现有派生(admin/grant-code/owner)即可? | (a) 必须 foreign-base owner 显式 grant;(b) 沿用 §1.1 已建派生(owner/admin/base-read 码) | **(b)** — §1.1 原语已含 owner+grant-code+admin 三派生,够用;不引第二套授权机制(避免与 central RBAC 纠缠) |
| 2 | 跨 base **automation** 是否随 slice 1 一起开? | (a) 一起;(b) 默认 **OFF**,等其独立 gated 切片 | **(b)** — automation 是写侧 + 不同 chokepoint(§4 DEFER 理由);slice 1 只读 |
| 3 | `foreignBaseId` 是否**建后不可变**(immutable-after-create)? | (a) 可变(则须扩 `LINK_FOREIGN_KEYS` 触发重判,§2.5a);(b) 不可变(PATCH 拒改,§2.5b) | **(b)** — claim 即真相、杜绝两步绕过、不在热路径加重判分支(§2.5↔本项耦合) |
| 4 | base-read **denied** 时跨 base 读的姿态? | (a) 静默掩码(外表数据不出,与字段掩码同姿态);(b) 显式 403/错误 | **(a)** 用于 hydration/摘要 sink(与 §2a.3 同姿态,不泄露"存在"),**(b)** 仅用于 `/link-records` 这类**显式拉外表**的端点(已有 `sendForbidden` 语义,:9106) |

---

## 8. 不在本设计

跨 base **写**(automation `targetBaseId`)· Yjs 跨 base fan-out · base 级配额/限流 · 前端(picker 跨 base 列 + base 切换)· 跨 base 递归图/模板 · base 间数据迁移 · central RBAC/auth(永不,多维表内核内解决)。各为独立 gated 切片,owner 逐一 opt-in。
