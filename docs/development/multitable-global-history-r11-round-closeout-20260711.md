# Multitable Global History / Time Machine — R11 Round Close-out（设计+验证，2026-07-11）

> **性质**：owner R11 directive 下、owner AWAY 的固定节奏 /goal 一轮的收敛记录（设计决策 + 验证台账 + 边界与 hold）。
> 模型：owner 设本会话 = Opus 4.8（1M context，Fable 5 不可用时的替补）。每闸对抗审用独立 adversarial-reviewer（Opus）。
> **本文不改运行时行为**——它是记录；唯一新增的运行时改动已各自随其 PR 落地（见台账）。

## 0. R11 directive（原样，7 步严格顺序）

1. **ratify floor-A**（field-value tombstone 保留地板——纯决策、accept 边界、零代码）
2. **ratify anchor A′ 并优先实现**（服务端 asOf-derived resurrect 锚，零 schema/wire；消除 PIT-resurrect 多 vintage 欠重放）
3. **并行实现 all-tables-B**（服务端 per-sheet masked `fieldNames` 进 History 批次详情）
4. **随后实现 restore 回链，OD-0=(a) 三路穿线**（三条 version-restore 路由穿线，无行为变更）
5. **随后跑 O-2 staging L1→L3；production 保持 OFF**
6. **#4004 D-2 不随本轮开**（独立 ratify——watch-only）
7. **person before 侧名称解析 = R11 收尾项**（需 userId→displayName 目录字典，**不是** linkSummariesForSide 型的速修）

**standing 红线**：高风险开关（#4004 D-2 实现、flag 翻转、O-2 production 启用）需**逐项 owner 显式签字**，永不在通用 /goal 下做。gated 项只推到 gate-front（PROPOSED 设计锁、零 runtime）。fix-forward 改动一份账须全文搜旧措辞（#4074 教训：头部改对 + 正文残留 = 自相矛盾）。repo PUBLIC——不主动披露安全。部署碰活基建（仅 CI、且经请求）。

## 1. 落地台账（本轮 4 PR + 1 设计锁）

| Wave | 项 | PR | 状态 | 对抗审 | 运行时 |
|---|---|---|---|---|---|
| A | floor-A（tombstone 保留地板 ratify） | #4120 | ✅ MERGED 2026-07-11 | docs-only（决策）；o2-ladder §5 补 re-decision 触发器 | 零 |
| A | A′（PIT-resurrect 锚 = asOf T 派生，vintage-exact `created_at > T`） | #4117 | ✅ MERGED 2026-07-11 | APPROVE + P2/P3 修（golden F strict-`>T` + golden E 归因软化） | 查询语义修正，无 flag、无 schema |
| A | all-tables-B（masked cross-table `fieldNames` 进批次详情） | #4119 | ✅ MERGED 2026-07-11 | APPROVE + P3 修（golden 文案 or→and）+ NIT stale ref | 投影增 masked map，无新端点、无 flag |
| B | restore 回链（`restored_from_version`，OD-0=(a) 三路穿线） | #4124 | ✅ **MERGED 2026-07-11**（`1af1e6f5f`） | **APPROVE-with-hardening**（0 P1、0 P2 correctness/security；1 P2 测试覆盖漏洞已修）+ **CI 二次捕获迁移排序 P1 已修** | 迁移 `zzzz20260711000000…`（Kysely TS）一列 + 穿线 + 投影 + FE 徽标；txn-safe 部署窗口守卫 |
| D | person before 侧名称解析（`personNames` 目录字典） | — | 📝 **PROPOSED 设计锁提交**（零 runtime，gate-front） | 待 owner ratify | 零（docs-only） |

## 2. 逐 Wave 设计与验证

### Wave A-1 — floor-A（#4120，决策）
- **决策**：field-value tombstone **无 retention 地板**（link 侧才有 c5 地板）作为**已知接受边界**，非 bug。若 4c-1 恢复窗口在 retention 上线后变重要，另开 rung 补地板。
- **落点**：ratify 决策文档 + `multitable-global-history-o2-operator-flag-ladder-20260709.md §5` 记 re-decision 触发器（retention 上 prod + 4c-1 恢复窗口重要 ⇒ 重新决策）。
- **验证**：纯决策、零代码；与 o2-ladder §2.2/§5 一致（单旋钮耦合已在册）。

### Wave A-2 — A′ resurrect 锚 vintage-exact（#4117）
- **问题**：PIT-resurrect 的 inbound 重放锚此前按「最新 delete」选，多 vintage 下欠重放（replays N2 而非 asOf T 当刻的 N1）。
- **修**：锚查询改为 `WHERE sheet_id=$1 AND record_id=$2 AND action='delete' AND created_at > $3 ORDER BY created_at ASC, version ASC, id ASC LIMIT 1`（params `[sheetId, recordId, asOfIso]`）。`> T` 严格性 load-bearing——与 `reconstructRecordsAtT` 的 `created_at <= T` 恰好互补（一条记录在 resurrect 集 ⟺ 其移除 delete 严格 `> T`）。
- **验证（realdb goldens，mutation-proven）**：golden A 翻为 vintage-exact（重放 N1 非 N2）；golden D 同毫秒 tiebreak（delLo v2 / delHi v4）；golden E 边界（delete 恰在 T = 缺席）；**golden F strict-`>T`**（create v1@T0, delete v2@T2, re-create v3@T2, delete v4@T3, revert@T2 ⇒ 锚 v4 非 v2）。突变命中：DESC→A+D 红；version DESC→仅 D；`>= T`→仅 F。
- **审阅修**：P2 `> T` 严格性此前未测（`>= $3` 仍全绿）——加 golden F 精确红；P3 doc 声称「去任一 tiebreak key ⇒ 红」对 id key 不成立——改措辞（version 被 exercise，id belt-and-suspenders）。

### Wave A-3 — all-tables-B masked fieldNames（#4119）
- **问题**：批次详情跨 sheet 时，FE 无法把 changed fieldId 解析成字段名（只有当前 sheet 的字段字典）。
- **修**：投影层顺路输出 `fieldNames: Record<sheetId, Record<fieldId, name>>`，**仅覆盖 post-mask 已可见字段**（layer-2 property-hidden ∩ layer-3 field_permissions ∩ taint，即 `allowedFieldsBySheet`），unnest-join meta_fields 后再 `allowed.has` 复查。FE `diffFieldName(fieldId, sheetId)` 优先 props→map→id。
- **LOCK-3 不破**：字段名可见性 = 两独立层（property-hidden + 每-subject RBAC）；复用 `allowedFieldsBySheet` 天然三层交集，隐藏/拒绝字段的名字**绝不进** payload。
- **验证（realdb golden）**：两-sheet 批次，sheet A 含 layer-2 property-hidden 字段 + sheet B 含 layer-3 denied 字段，断言两名字均不泄露（whole-body）。FE spec：跨表 diff 名字解析 + 掩码字段回退 id。突变：去 re-check **且** 去 post-mask 累加（两者都破才泄露 MUT-C）——审阅纠正 golden 文案 or→and（两守卫冗余）。

### Wave B / Lane 3 — restore 回链 restored_from_version（#4124，OD-0=(a)）
- **设计锁**：`multitable-global-history-restore-backreference-design-lock-20260710.md`（RATIFIED / AS-BUILT）。OD-0=(a) 三路全穿线 · OD-1=版本号 · OD-2=上线即显（只读元数据，无 flag）。
- **实现**：迁移 067 加 `meta_record_revisions.restored_from_version`（int nullable，forward-only，无回填）；`restoredFromVersion` 经 `RecordWriteService.patchRecords → recordRecordRevision` 单 seam 穿三条 version-restore 路由（legacy `/restore`:9549、`/restore-execute`:9690、`/restore-batch-execute` 的 9851+9879）；投影 `HistoryChange.restoredFromVersion` + FE「从版本 N 恢复」徽标（键于**非 NULL**）。
- **关键契约（NULL-by-design）**：`restored_from_version` 非 NULL **当且仅当** 写入携带 targetVersion（= 三路）。其余所有 `source='restore'` 发射点恒 NULL：PIT-resurrect create-v1（:10164）、PIT-reset 存活/删除（:10380/:10462）、lossy-retype-revert（:6442）。FE 徽标键于非 NULL，**绝不键于 `source='restore'`**——否则复现 #4074 两类语义不一致残迹。
- **部署窗口 txn-safe（自捕的关键 bug）**：`recordRecordRevision` 在 `patchRecords` 事务内跑；扩展 INSERT 的 42703 会**毒化事务**（try/catch 回退二次失败「current transaction is aborted」）。故用**列存在性 SELECT 探测**（information_schema，只缓存 present 正结果）择 INSERT 形状，而非 catch。投影读侧走非事务 pool query，try/catch 回退安全。二者预迁移窗口均降级为 base 形状（值静默 NULL），永不失败写入/500 读取。
- **验证（realdb goldens，mutation-verified）**：G1 legacy `/restore` 端到端（字段类型须 'string' 非 'select'）；G1b recordRecordRevision seam；**G1c/G1d/G1e 三条 live 路由端到端（restore-execute :9704、batch all-or-nothing :9856、batch per-record :9884）——审阅 P2 补齐**；G2 NULL-by-design（普通/resurrect 形状/reset 形状三者 NULL——钉住「徽标键于非 NULL 非 source='restore'」核心契约）；G3 投影携带且掩码不变。FE badge spec + NULL 不渲染。tsc 双清、13/13 realdb（含 all-tables-B 邻测）绿。
- **对抗审 = APPROVE-with-hardening**（review MD：`/tmp/pr4124-backref-review-claude-20260711.md`）：0 P1、0 P2 correctness/security；txn-safety/NULL-by-design/三路穿线/LOCK-3 均 PASS。**唯一 P2 = 测试覆盖漏洞（mutation-proven）**：原只有 legacy `/restore`（无 live FE 调用方）有端到端 golden，两条**实际 live** 路由（restore-execute、batch-execute）的穿线可被静默删除而全绿。**已修**：加 G1c/G1d/G1e 三条 e2e golden，**per-site mutation 实证**（neuter :9704⇒仅 G1c 红、:9856⇒仅 G1d、:9884⇒仅 G1e），并订正 lock §3 G1/G5 的过度声称 + §2.5 标 RESOLVED；附带硬化部署窗口列探测（`current_schemas(false)` 作用域，防跨 schema 假阳性毒化事务——审阅 NIT）。
- **CI 二次捕获（review 后、真 from-scratch migrate 才暴露的 P1-类）**：加完 e2e golden 后，required **test(20.x) realdb 全红**（我 file 7/8 失败，`column "restored_from_version" does not exist` 42703）。**根因 = 迁移排序**：`meta_record_revisions` 表由 Kysely TS 迁移 `zzzz20260430172000_create_meta_record_revisions` 创建（`zzzz` 前缀在合并排序里**晚于所有 0xx 数字 SQL 迁移**）；原 `067_*.sql` 遂在**表创建之前**运行，`to_regclass` 守卫见不到表而静默 no-op（"executed successfully" 但列从未加）。**审阅 DB 与本地容器都手工应用过 067 到已存在的表，故都漏掉——只有 from-scratch CI migrate 能暴露**。**修**：改写为 `zzzz20260711000000_add_meta_record_revisions_restored_from_version.ts`（与 batch_id 列同型），删 067 SQL，更新全部 "migration 067" 引用 + lock §2.1 排序注。**验证 = 复现 CI 路径**：新建 fresh DB → 全量 db:migrate → 列存在（integer）→ 13/13 golden 绿。**教训见 §7**。

### Wave D — person before 侧名称解析（PROPOSED，gate-front）
- **落点**：`multitable-global-history-person-before-side-name-resolution-design-lock-20260711.md`（**PROPOSED，零 runtime**）。
- **残差**：History 批次 diff 里 person 字段 before 侧的「已从当前单元格移除的人」不在 grid 缓存 ⇒ 回退 raw userId（不可读）。after 侧（当前值）正常。
- **与 link 侧的关键区分（directive item 7）**：person 是**按 value 逐 id 映射**，无 link 侧「有 summaries 就无视 value」的 bug——`linkSummariesForSide` 那套对 person 不适用。故需 **userId→displayName 目录字典**（选项 A：`loadHistoryBatchDetail` 顺路输出 `personNames`，复用批次详情端点**已在用**的 `resolveUserDisplayNames`——与 `actorName` 同源、同端点、零新往返），**不是** linkSummariesForSide 型速修。
- **不可绕约束**：person 值已受 field_permissions 掩码（denied 字段值已在服务端投影丢弃 ⇒ 其 userId 本就不在 payload）；只对 post-mask 已可见 person 单元格里的 userId 解析显示名，零新字段值披露。
- **owner 决策点**：OD-P1 选项 A/B/C（荐 A）；OD-P2 `personNames` 是否带 inactive 标记（荐带）；OD-P3 是否需 flag（荐否——只读目录元数据，与 all-tables-B/actorName 同级）。

## 3. Wave C — O-2 staging enablement（operator/CI action，本轮 = runbook，不在 sandbox 执行）

**为何 runbook 而非执行**：核验——**无任何 workflow / docker 文件引用 `MULTITABLE_ENABLE*` / `TOMBSTONE_CAPTURE*`**（`git grep .github/ docker/` 空），故这些 flag 经**部署 host 的 env** 设置、非 CI workflow input，sandbox 无法到达部署 host。O-2 本就是 **owner/operator 决定**（见 o2-ladder 抬头）。故本轮交付 = 可执行清单，落 owner/CI 手上。

**R11 特有前置（新增于既有阶梯）**：
- **A′（#4117）必须在部署到 staging 的 build 里**，再开 L2（`MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND='true'`）——否则 resurrect 重放旧的「最新 delete」锚而非 vintage-exact 锚，多 vintage 下欠重放。A′ 已 merged 到 main（2026-07-11），下一次 staging 部署即含。
- all-tables-B（#4119）/ restore 回链（#4124）纯读侧/元数据增量，**不受 flag 门控**，随部署即生效，无 enablement 步骤。

**阶梯（引 `multitable-global-history-o2-operator-flag-ladder-20260709.md §3`，不复述）**：
- L1 staging `TOMBSTONE_CAPTURE_ENABLED='true'` → 验 `meta_link_tombstones` 出 `reason='record_delete'` 组。
- L2 staging `RECORD_UNDELETE_INBOUND='true'`（**build 须含 A′**）→ 回收站恢复 → 响应 `inbound.replayed≥1`；**额外验 A′：多 vintage 记录 resurrect 后重放的是 asOf-当刻边而非最新边**。
- L3 staging `ENABLE_PIT_UNDELETE='true'`（若走 PIT 面）→ revert-execute confirm:'undelete' 带 `undeleteInbound`。
- **production 全程 OFF**（directive item 5）。retention（L4）/ prod（L5）独立 owner 决定。
- **回滚**：关对应 flag 即逐字节回到关前（金测 RB1/P3-2a 钉死 flag-off 路径）。

⚠ operator footgun（引 ladder §1）：capture/replay flag 用 `'true'`，retention 开关用 `'1'`。照抄错值 = 静默不生效。

## 4. Hold / 边界（如实，directive 对齐）

- **#4004 D-2（automation/plugin 删除不可恢复）**：**watch-only，本轮不开**（directive item 6）。独立 ratify，需 owner 逐项签字。
- **flag 翻转**：本轮零翻转。O-2 staging = runbook 交 operator；production OFF。
- **field-value tombstone retention 地板**：floor-A 已 ratify 为**接受边界**；re-decision 触发器在 o2-ladder §5。
- **4d 红线不变**：已删字段列值的值级恢复永不承诺。
- person 名称解析：**仅 PROPOSED**，owner ratify 前零实现授权。

## 5. 验证总账

| 面 | 证据 |
|---|---|
| A′ 锚正确性 | realdb goldens A/D/E/F，mutation-proven（DESC/version-DESC/`>=T` 各精确命中不同 golden）；与 reconstruct `<=T` 互补性人工推证 |
| all-tables-B 掩码不泄露 | 两-sheet realdb golden（layer-2 + layer-3 各一），whole-body 断言；复用三层 `allowedFieldsBySheet` |
| restore 回链 | G1/G1b/**G1c/G1d/G1e**/G2/G3 realdb（三路各带 e2e，per-site mutation 实证）+ FE badge spec；txn-poison 自捕并以列探测（`current_schemas` 作用域）修复（standalone dw-check 证降级不毒化） |
| NULL-by-design 契约 | G2 三形状（普通/resurrect/reset）全 NULL；四发射点核验只三路穿线 |
| tsc | core-backend + apps/web 双清（各 PR 内） |
| CI | plugin-tests.yml 白名单加两新 realdb 文件；required 5 检查（contracts×3/pr-validate/test-20.x）绿 |
| 对抗审 | 每闸独立 adversarial-reviewer（Opus）refute-first + 修 findings + /tmp MD 存档 |

## 6. Cleanup（本轮结束）

- Lane 3 落地后移除 `/tmp/r11-backref` worktree。
- 停/删测试容器 `ms2-r11-pg`（port 55444）。
- 更新 memory：`project_global_history_line.md`（R11 wave 落点）+ `MEMORY.md` 指针。

## 7. 教训（本轮新增，写入 memory）

1. **`meta_record_revisions`（及任何由 `zzzz`-前缀 Kysely TS 迁移创建的表）的新列，必须用 `zzzz`-时间戳 TS 迁移，不可用数字前缀 `0xx_*.sql`**。合并后的迁移集按规范化名**字典序**排序（SQL 与 TS 混合排），`zzzz…` 晚于所有 `0xx`。数字前缀 SQL 会在表创建**之前**跑；即便带 `to_regclass` 存在性守卫，也只是静默 no-op（"executed successfully" 但列没加）。**判据：对照该表现有列迁移的命名**（本例 `zzzz20260619120000_add_meta_record_revisions_batch_id.ts` 就是模板）。
2. **"迁移已应用"的 DB 会掩盖排序 bug**。对抗审用的 DB 和本地容器都**手工应用过**该列到已存在的表，故 8/8 绿；只有 **from-scratch 全量 migrate**（CI test(20.x) realdb）能暴露。**安全/迁移类改动的验证必须包含一次 fresh-DB 全量 migrate**，不能只在预置了目标列的库上跑测。（呼应 #4102 "隔离schema漏加列迁移" 同类。）
3. **对抗审 APPROVE ≠ CI 绿**。审阅在预置库上验证了行为正确（穿线/契约/txn-safety 全对），但迁移能否 from-scratch 落地是**审阅前提之外**的一层——required check 才是地板。「fixed」判据 = 新 head 的 required 全绿，非本地/审阅库绿。
4. **测试覆盖漏洞：只测无 live 调用方的路由**。原 golden 只端到端覆盖 legacy `/restore`（FE 从不调用），两条真 live 路由的穿线可被静默删除而全绿——"真实生产者不可达" 的缓解在这里**反向**成立（该测的路由没被测）。补 e2e + per-site mutation 实证。

---

**收官口径**：本轮 ratify/decision-clean 池已清空至 gate-front（floor-A/A′/all-tables-B/restore 回链落地；person 名称解析 PROPOSED 待 owner ratify）。剩余 = O-2 staging enablement（operator/CI runbook，production OFF）+ #4004 D-2（owner-gated，watch-only）+ person 实现（owner ratify 后）。**非「全部开发好了」**。
