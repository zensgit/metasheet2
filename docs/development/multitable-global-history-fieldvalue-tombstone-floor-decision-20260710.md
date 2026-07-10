# Global History — field-value tombstone 留存地板 — 决策 one-pager (PROPOSED)

- **Status**: PROPOSED 决策文档；任何构建选项都需 owner 单项签核。R10 gate-front 工件（R9 审计残差 L2）。
- **现状（真库核验）**：`meta-revision-retention.ts` 的 `floorPredicate` 仅对 link-tombstone 表生效（引用 `meta_records_trash.delete_revision_id` 锚——trash 行不灭则组不灭）；`meta_field_value_tombstones` 的 keep-days 清扫**无地板**。O-2 阶梯文档已如实记为边界（footgun 注记在案）。
- **何时会咬人**：仅当 4c-1/4c-2 flag 在生产开启 **且** retention 同时开启——field-delete/lossy-retype 的值恢复窗口=keep-days，过期即 4d 化（字节消失）。

## 选项

| 选项 | 内容 | 代价/问题 |
|---|---|---|
| **A（推荐）** 接受边界 | 维持现状；O-2 阶梯文档已注明「先开 capture 类 flag 时保持 retention 关闭,或接受 keep-days=恢复窗口」 | 零代码;边界已如实文档化 |
| B 锚定 config-revision 地板 | floor 引用产生该 tombstone 的 `meta_config_revisions` 行(field-delete/retype revision) | config revision 自身也被 retention 老化——链到另一张会老化的表=弱地板,给运维假安全感 |
| C 独立不灭锚 | 为 field-value tombstone 组新增专用 never-delete 标记/存储 | 新存储+新治理面,重;当前无任何 pending-revert 概念可挂 |
| D 差异 keep-days | field-value tombstone 单独更长的 keep-days 旋钮 | 又一个旋钮;不解决「地板」语义,只推迟 |

## 建议

**A**。理由：该边界只在「capture flag 开 + retention 开」的组合世界存在,而 O-2 阶梯本就把这一组合列为联动注意事项;B 是伪地板,C 的成本与当前零生产启用不成比例。**复议触发条件（写入 O-2 阶梯）**：任一 4c 系 capture/revert flag 在生产开启且 retention 计划开启时,本决策自动回到 owner 桌面。

- **解锁词**：owner 选 B/C/D 之一并点头;选 A 仅需在本文所附 PR 上确认（或沉默视为维持现状——A 即现状,无代码）。
