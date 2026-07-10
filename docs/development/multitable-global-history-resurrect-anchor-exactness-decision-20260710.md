# Global History — PIT-resurrect 锚精确化 + response-shape — 决策 one-pager (PROPOSED)

- **Status**: PROPOSED 决策文档；owner ratify 前零实现授权。R10 gate-front 工件（4c-3 wave 验证 §4 项 (1)(2)）。
- **现状（R8 已诚实钉住）**：PIT-undelete 的 resurrect 侧无 trash 行可携锚，采用「该记录最新 `action='delete'` revision」启发式选锚（univer-meta.ts ~:10183）；多 vintage 场景**只会 under-replay 不会 over-replay**（R8 多 vintage/未捕获 vintage goldens + 注释诚实化已落 main）。restore 侧（trash 路径）锚精确，无此问题。

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
- Goldens：R8 的多 vintage/未捕获 vintage goldens 翻断言为精确重放；**新增同毫秒 golden**（两条 delete revision `created_at` 相同 → version/id tiebreak 选定且跨运行稳定）；锚选择突变（改回 latest-delete 启发式，或去掉任一 tiebreak 键）⇒ 对应 golden 红。

- **解锁词**：owner 点头选项（A′/A/B/C）。选 C=关闭本项,从 owner 菜单划除。
