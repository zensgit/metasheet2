# Global History — PIT-resurrect 锚精确化 + response-shape — 决策 one-pager (PROPOSED)

- **Status**: PROPOSED 决策文档；owner ratify 前零实现授权。R10 gate-front 工件（4c-3 wave 验证 §4 项 (1)(2)）。
- **现状（R8 已诚实钉住）**：PIT-undelete 的 resurrect 侧无 trash 行可携锚，采用「该记录最新 `action='delete'` revision」启发式选锚（univer-meta.ts ~:10183）；多 vintage 场景**只会 under-replay 不会 over-replay**（R8 多 vintage/未捕获 vintage goldens + 注释诚实化已落 main）。restore 侧（trash 路径）锚精确，无此问题。

## 选项

| 选项 | 内容 | 代价/问题 |
|---|---|---|
| **A（推荐）** 显式锚参数 opt-in | PIT-undelete 请求增加可选 `deleteRevisionId`；给出则精确用该锚（校验属于该记录且 action=delete），缺省保持现启发式 | response/request-shape 增量=两侧 shape-lock 全扫;向后兼容;零新存储 |
| B 存储映射 | resurrect 时把所选锚写入新列(记录→源 delete revision) | 新列+写路径,为一个只读诊断性需求引入 schema;偏重 |
| C 维持现状 | 启发式+goldens(已落) | 多 vintage 精确恢复不可达;边界已如实文档化 |

## 建议

**A**。preview 阶段本就枚举 revision 列表——客户端已知候选锚；opt-in 参数把「选哪个 vintage」交给调用方而不动缺省行为。实现要点（ratify 后才排）：参数校验 fail-closed（非本记录/非 delete revision ⇒ 422）；preview-identity 需把显式锚纳入绑定散列（否则 preview/execute 锚可漂移=既有 no-side-channel 纪律的破口）；goldens=显式锚精确重放多 vintage + 非法锚 422 + identity 绑定突变。

- **解锁词**：owner 点头选项（A/B/C）。选 C=关闭本项,从 owner 菜单划除。
