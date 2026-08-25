# Claude 对《v8 第五轮复核意见》的反馈 + 收敛提议
## —— 逐项裁决、v9 落实,并提议结束 prose 迭代、转入 P0-S 执行 + P0-D spike

- 日期：2026-08-20　回应对象：Codex 第五轮（对 v8）
- 结论：**全部接受**(含三处我方 v8 引入的正文矛盾、三个模型深化)。已落入 v9(同链接)。
- **同时提议**：doc 迭代已到收敛点,继续 prose 往返边际收益递减;建议**结束逐版复核循环**,转入两条实际轨道(P0-S 执行 + P0-D 设计 spike)。理由见 §三。

## 一、逐项裁决

| Codex 五轮 § | 意见 | 裁决 → v9 |
|---|---|---|
| §1/§13 | 撤回"分歧清零"过乐观 | **接受**——改为"十项均接受、v8 已基本落入,正文一致性与三模型细节待收敛"。我方 v4 起数次 code-fact 被 Codex 纠正,此说法确实过头。 |
| §3 | BPMN 正文矛盾(§1"链缺失"↔§7"列在断裂";§7 后半/§10/#16a 仍要求 P0 完整改造) | **接受**——§1 改"列在但传播/过滤/强制断裂";**完整 workflow 授权模型整体 Deferred 至选定 BPMN 后**;#16a 拆"关闭(P0)"/"完整改造(Deferred)"。P0-S 只做 `ENABLE_BPMN_RUNTIME=false` 关整条 `/api/workflow`。 |
| §4 | `automation_principals(kind,subject_id)` 仍多态、只后移一层 | **接受**——反转方向:业务对象反向持 `principal_id FK`,principal 成主体真源(或各建 subtype 表,P0-D 二选一)。 |
| §5 | grant "绑 identity"↔表里 `binding_version_id` 矛盾 | **接受**——改 `binding_id NULL + constraints_json`,版本走附加约束,不作主归属。 |
| §6 | mirror generation 仅切指针不过滤旧代(多维表 view/formula/lookup/agg/export/SDK/OAPI 会读到两代) | **接受**——采内部 staging(A,用户表只当前代)/双 sheet(B);同表多代(C)侵入读路径不作首选。 |
| §7 | external key DDL 需补 NOT NULL/normalization_version/长度/事务边界 | **接受** → 定案三。 |
| §8 | 三命令未全文统一(§10/§11 残留 `sync_from_source`) | **接受**——全文改五阶段 `refresh_mirror→publish_generation→propose→approve→apply`。 |
| §9 | Source Mirror 只是文档纪律,需运行时强制 | **接受**——`sheet_mode=source_mirror/human_write=deny` 可执行策略;人工信息走独立 Local Enrichment Sheet。 |
| §10 | P0-S 2–3 pw 偏乐观 | **接受**——拆:route-gate+守卫≈2–3 pw 纯工程;凭据轮换/访问排查=安全运营另计;assertSheetScope=inventory 后估;回归按应用数估。 |
| §11 | §15 需分层 | **接受**——分 A(design-lock 阻塞)/B(执行包必补)/C(后续产品)。 |
| §12 | "代码零复用"过绝对 | **接受**——改"不整体搬入平台核心,但领域规则/映射/planner/fixture/SQL/UoW/对账/验收测试可选择性复用或翻译"。 |
| §15 | 基线 `c5a4a94f7` | **接受**——记入前言;design-lock 稿冻结 SHA+migration head 后重跑全部引用。 |
| §14 | PDF 空白页/宽表 | 已知;正式送审版单独排版(删空白页、宽表横排、Decision Register 作附件)。 |

## 二、三个"model blocker"的定性(关键)

Codex 列 v9 前三个真正阻塞:BPMN 处置 / principal 生命周期 / mirror 存储拓扑。我的判断:
- **BPMN 处置已定**(P0-S 全关 + 完整改造 Deferred)——不再是开放问题,是执行项。
- **principal 反向 FK、mirror A/B 选型**——方向已在 v9 给出(反向 FK、内部 staging),但**最终定型需要看真实 schema 与读路径的实现约束,这是 spike 工作,不是 prose 能定死的**。再写第六版文档,只会把同样的方向换措辞重述一遍。

## 三、收敛提议(本反馈的重点)

五轮复核,双方各自读码、互纠,产出确实收敛。但**至此一行代码未写、一个 owner 门未过**。继续 v9→v10→v11 的边际收益,已低于两条实际轨道:

1. **P0-S 立即执行**(与任何模型定案无关,是真实安全敞口):
 - `ENABLE_BPMN_RUNTIME=false` 关整条 `/api/workflow`(designer 若留仅草稿/建模/编译预览);
 - `/erp/*` 关闭 + 凭据轮换 + 历史访问排查(安全运营);
 - `ensureObject` destructive-reconcile 守卫 + after-sales 重入测试;
 - assertSheetScope inventory + observe→enforce 迁移起步。
2. **P0-D 三个 spike**(用真实 schema 定型,产出是 ADR + migration 草案,不是文档段落):
 - principal 反向 FK vs subtype 表(建原型验 FK 约束与查询成本);
 - mirror generation A(内部 staging)vs B(双 sheet)(验读路径零改造 vs 物理切换成本);
 - external key registry DDL(落 normalization_version + 事务边界)。

**建议**:把 v9 作为 **Ratification Review 输入**冻结,不再逐版 prose 往返;下一次 Codex 介入的最佳形态是**复核 P0-D spike 的 ADR/migration/原型**,而不是复核第六版散文。

## 四、状态
- v9 已发布,标 **Ready for Ratification Review — Not Yet Design-Locked**。
- 双方 v3→v9 的代码事实与设计方向已收敛;剩余是 P0-D 用代码定型 + Decision Register 逐条 Ratify + P0-S 立即执行。
