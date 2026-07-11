# Global History — PIT-resurrect 锚精确化 + response-shape — 决策 one-pager (RATIFIED — A′ · AS-BUILT R11)

- **Status**: **RATIFIED 2026-07-11（owner R11 directive: 「ratify 锚 A′ 并优先实现」）→ 选项 A′（服务端按 `asOf` T 推导锚）。AS-BUILT**：impl 落在本轮 anchor 分支——`univer-meta.ts` resurrect 锚查询由 `created_at DESC` latest-delete 启发式改为 `WHERE action='delete' AND created_at > $asOfIso ORDER BY created_at ASC, version ASC, id ASC LIMIT 1`；R8 goldens 翻断言为 vintage-exact + 新增同毫秒 tiebreak(D) + 缺席边界(E) + 严格 `>T` 载荷(F) goldens（`multitable-undelete-inbound-resurrect-realdb.test.ts`）。零 wire、零 schema。**边界正确性核验（ratify 前）**：`reconstructRecordsAtT` 用 `created_at <= T`（record-reconstructor.ts:53），故 record 在 resurrect 集 ⟺ 其移除性 delete 严格 `> T`——锁定的 `> T` 是该边界的精确补集。两种边界分别钉：`created_at == T` 的 delete 若是最新 `<=T` revision ⇒ 该记录在 T 不存在 ⇒ 本就不在 resurrect 集（golden **E** 钉「缺席」，记录根本不到锚查询）；但若 T 时刻有更高版本 re-create（记录在 T **存在**），其移除性 delete 严格晚于 T，`>=T` 会误锚到上一 vintage 的同刻 delete ⇒ golden **F** 钉「`>T` 严格性」（唯一在 `>T→>=T` 突变下变红的 golden；审阅 P2 补入）。
- ~~PROPOSED~~ 原始状态（保留供审计）：R10 gate-front 工件（4c-3 wave 验证 §4 项 (1)(2)）。
- **历史现状（R8，已被本轮 A′ AS-BUILT 取代——保留供审计）**：PIT-undelete 的 resurrect 侧无 trash 行可携锚，R8 采用「该记录最新 `action='delete'` revision」`created_at DESC` 启发式选锚（univer-meta.ts ~:10183）；多 vintage 场景**只会 under-replay 不会 over-replay**（R8 多 vintage/未捕获 vintage goldens + 注释诚实化已落 main）。restore 侧（trash 路径）锚精确，无此问题。**R11 后**：resurrect 侧改为 asOf-derived vintage-exact 锚，under-replay 边界消除；restore 侧不变。

## 选项

| 选项 | 内容 | 代价/问题 |
|---|---|---|
| **A′（推荐，审阅 P3-2 补入）** 服务端按 `asOf` T 推导锚 | resurrect 的唯一现役入口是 PIT-revert（undelete 走 revert-preview 链），wire 上**已携带** `asOf` T——服务端按「该记录 T 之后的第一条 delete revision」推导 vintage-正确锚 | **零 wire 变更**、零新存储;恰好修掉多 vintage under-replay;只改锚选择查询+goldens |
| A 显式锚参数 opt-in | 请求加可选 `deleteRevisionId`（校验属于该记录且 action=delete，非法 ⇒ 422），缺省保持现行为 | **注意（审阅修正）**：现 preview 响应只回 `{recordId, snapshot, snapshotHash}`（~:9943/:9960），候选 delete-revision id 并未下发——A 实际还需 preview **response**-shape 增量才能让调用方拿到候选锚;两侧 shape-lock 全扫;且显式锚必须纳入 preview-identity 绑定散列（`resurrectScopeHash` ~:10123），否则 preview/execute 锚可漂移=no-side-channel 破口 |
| B 存储映射 | resurrect 时把所选锚写入新列 | 新列+写路径,为只读诊断性需求引入 schema;偏重 |
| C 维持现状 | 启发式+goldens(已落) | 多 vintage 精确恢复不可达;边界已如实文档化 |

## 建议

**A′**（原推荐 A 经审阅修正后降为次选）：T 已在 wire 上、语义即「恢复到 T 时刻」，vintage-正确锚由 T 唯一决定——服务端推导比把选择权推给调用方更便宜也更不易错。实现要点（ratify 后才排）：
- **锚选择的确定性排序契约（owner P2，锁定为规范文本，与既有 LOCK-11 确定性约束一致）**：筛 `action='delete'` 且 `created_at > T`，排序 **`ORDER BY created_at ASC, version ASC, id ASC LIMIT 1`**——同毫秒多条 delete revision 时由 version、再由 id 决出唯一且稳定的锚；任何实现不得省略三级 tiebreak。
- 找不到时的语义：找不到 = 该记录 T 时刻未删，resurrect 集合本就不含它；以 goldens 钉边界（不回退启发式）。
- Goldens（AS-BUILT，突变逐一在真库核验）：R8 的多 vintage/未捕获 vintage goldens 翻断言为精确重放。突变精确命中：
  - 改回 `created_at DESC` latest-delete 启发式 ⇒ (A) + (D) 红（vintage 与同毫秒各一）；
  - 锚查询 `version DESC`（翻 version tiebreak）⇒ 仅 (D) 红——UUID 无关，稳定；
  - `created_at > T` 改 `>= T`（去严格性）⇒ 仅 (F) 红；
  - **id tiebreak 键**：属 belt-and-suspenders（`(sheet_id, record_id, version)` 索引非 UNIQUE），当前无单独行使它的 golden（去掉不改任何断言）——如实记，不夸大为「去掉任一 tiebreak 键必红」。

- **解锁词**：~~owner 点头选项（A′/A/B/C）~~ **已解锁 → A′（owner R11 directive 2026-07-11）**。本项从 owner 菜单出列（AS-BUILT）。
