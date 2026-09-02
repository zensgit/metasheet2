# UI-P2-1c T5 — MetaRecordDrawer/toolbar MtButton migration — OWNER DECISION RECORD (2026-07-13)

> **性质**：owner 对 T5 决策 brief（#4175）的裁决记录（docs-only，零 runtime）。据此**并行实施**：T5-safe 一条 + comment-affordance 独立短设计锁一条。**本记录不改代码。**
> **前情**：T5 = MetaRecordDrawer/工具栏一组按钮向 UI-P2-1c 的 `MtButton`/`MtIconButton` 迁移。owner 决策 brief（#4175，已合）提出 T5a–T5d 五组的迁移问题；本记录落 owner 裁决。

## 1. Owner 裁决（OD-T5a … OD-T5d）

| 决策 | 裁定 | 口径 |
|---|---|---|
| **OD-T5a** watch 按钮 | **= A** | watch 用 **`MtButton`**；**保留 `--watching` 状态类**（不丢现有视觉态）；**新增 `aria-pressed`**（toggle 语义无障碍）；**原有 loading / disabled / click 行为逐字节不变**。 |
| **OD-T5b** comment 按钮 | **= A** | comment **从 T5 剥离**，单独治理**整个 comment-affordance 系统**（见 §3 独立设计锁）。**不得拿 warning token 冒充 comment-active 色彩**——comment-active 需**专用 token**。 |
| **OD-T5c** workflow / permissions 按钮 | **= A** | 迁 **`MtButton`**；**现有 glyph 保留在 slot**；**暂不引入新图标契约**（不新增 icon API）。 |
| **OD-T5d** duplicate / delete / unlock 按钮 | **放行** | 可迁；**`@click`、`v-if`、`:disabled`、`data-*` 必须逐字节保留**；**delete 使用 `variant="danger"`**。 |

## 2. 实施拆分（并行两条）

### 2.1 T5-safe（一条 PR，可立即实施）
范围：**watch（OD-T5a）+ workflow + permissions（OD-T5c）+ duplicate/delete/unlock（OD-T5d）**。
- 迁 `MtButton`/`MtIconButton`；watch 加 `aria-pressed` + 留 `--watching`；delete `variant="danger"`。
- **逐字节保留** `@click` / `v-if` / `:disabled` / `data-*` / 现有 glyph slot；不新增 icon 契约。
- 验证：组件迁移前后 DOM 快照 diff（行为属性零变化）+ 现有交互测试保持绿；byte-preserve grep 断言（`@click`/`:disabled`/`data-*` 逐条 pin）。
- **不含 comment**（OD-T5b 剥离）。模型：Fable（纯 FE 机械迁移）+ 视觉/无障碍复核。

### 2.2 Comment-affordance 独立短设计锁（一条，先设计）
范围：**整个 comment-affordance 系统**（跨 9 组件的 comment 按钮/角标一致性）。
- 定义**专用 `comment-active` token**（不复用 warning token；OD-T5b 明令）——在 tokens.css `--ms-*` 体系里加一个语义 token（[[project_ui_foundation_uf_arc]] 单一真源）。
- **9 组件一致性测试**：枚举所有出现 comment 按钮/active 态的组件，断言它们用同一 comment-active token、同一交互契约。
- 设计锁定义 token 名 + 9 组件清单 + 一致性测试形状；**实现待 owner ratify 该子锁**。模型：Opus/Sonnet（token 契约 + 一致性设计）。

## 3. 边界
- 本记录零 runtime。
- comment 迁移**不在** T5-safe 内——先出 comment-affordance 设计锁，ratify 后再实施。
- 与 Time Machine（R13）线**无耦合**——独立 UI 线。
