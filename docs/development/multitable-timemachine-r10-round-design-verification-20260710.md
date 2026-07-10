# Multitable 时间机器线 — R10 轮 设计+验证记录（2026-07-10）

> **性质**：R10 轮次记录（owner /goal「这条线余下开发」，owner 离机全程自动处理）。R9 正式闭环后的余下池 =
> 无门控 hygiene/证据项 + 门控项推至 gate-front（PROPOSED 决策文档，零实现）。红线全程维持：#4004 D-2 实现、
> 一切 flag 翻转、四个决策项的实现均未触碰。权威现状图仍为 `…verified-state-map…20260703.md`；本文只记 R10 增量。

## §1 交付

| 项 | 载体 | 关键验证 |
|---|---|---|
| **TrashModal 双层过滤 hygiene**（R9 观察项收尾） | #4060 `bc97802a2` | `historyVisibleFields`→`twoLayerVisibleFields` 更名服务双消费者；真实挂载 spec 经新 `open-trash` 锚点；突变恰红 `'Hidden Value' to be '#del_1'`；对抗审 **APPROVE 0P1/0P2/0P3**（含反证：fields 仅 title 一处消费、无恢复列选择器回归；全仓 sibling 扫描=最后一个单层喂给面） |
| **四份 gate-front 决策 one-pager** | #4059 `63944c461` | ①restore 回链 mini-lock ②field-value tombstone 地板（推荐 A=接受边界+复议触发器） ③resurrect 锚精确化（**审阅贡献 A′=服务端按 asOf T 推导锚,零 wire 变更,成为新推荐**） ④all-tables 字段元数据（推荐 B=服务端掩码 fieldNames 复用投影 allow-set）。对抗审 APPROVE-with-hardening 0P1/0P2,2P3 全折入（legacy /restore NULL 意图钉进 G2;A 选项成本修正=preview response 并不下发候选锚） |
| **T2 浏览器证据（历史欠账清偿）** | `docs/development/assets/multitable-history-center-t2-evidence-20260710/`（5 PNG + EVIDENCE.md） | 真实全栈（新鲜 pg + migrate + backend + vite + 无头 Chromium）：①密集时间线（~22 可见批次行,actor 显示名非 id,筛选栏全量）②展开批次含**记录标题** + **link diff 显示名称非 JSON** ③record chip click-through 关模态开抽屉 ④workbench 基线 ⑤person diff（含诚实发现,见 §3） |

## §2 复审贡献（值得留档的设计输入）

- **A′ 锚推导方案**（#4059 复审 P3-2）：resurrect 的唯一现役入口 PIT-revert wire 上已携带 `asOf` T，vintage-正确锚可由「该记录 T 之后首条 delete revision」服务端推导——比显式参数便宜（零 wire 变更）且恰好修掉多 vintage under-replay；原推荐 A 的「客户端已知候选锚」经核为不实（preview response 只回 recordId/snapshot/snapshotHash）。
- **legacy `/restore` 第三路**（P3-1）：`POST …/records/:recordId/restore` 也产 `source='restore'` revision 但无活跃 FE 调用方——回链锁 §5 显式出界 + G2 钉 NULL 意图。

## §3 诚实发现与携带项

- **person diff before 侧 raw-id 回退**（证据 04 号图）：person-summary 缓存 miss 时 before 侧显示原始 user id（after 侧正常解析;link diff 两侧均正常）。定性=轻微 UX 缺口非 T2 阻塞项;进入下轮池候选（修法大概率与 linkSummariesForSide 同型：per-side 传递已有缓存）。
- **浏览器验证工程 traps**（EVIDENCE.md 详录,对未来 browser-verify CI 车道直接有用）：①`RBAC_TOKEN_TRUST=true`（注册用户 DB 角色覆盖 dev-token admin 声明）②person 字段受 sheet-member 校验（需 multitable:read/write 授权）+ 默认 `limitSingleRecord=true` ③**Playwright `page.screenshot()` 在此视图无限挂起（持续 layout/rAF 循环）,raw CDP `Page.captureScreenshot` 即时可用**。
- **未做**（如实）：all-tables 跨表字段名（决策文档已备,等解锁词）;#4004 D-2 与 O-2 照旧等 owner。

## §4 剩余（owner 菜单,全部 decision-ready）

🔒 #4004 D-2 ratify（OD-1..8+真值表） · 🧭 O-2 阶梯 · 📄 #4059 四项各自解锁词（回链/地板/锚 A′/字段元数据 B） · ⬜ 下轮池候选：person diff before 侧解析。

## §5 验证物索引

/tmp/pr4059-review-claude-20260710.md（APPROVE-with-hardening,2P3 折入） · /tmp/pr4060-review-claude-20260710.md（APPROVE 0/0/0,突变自复现） · assets/…-t2-evidence-20260710/EVIDENCE.md（复现步骤全录）。
