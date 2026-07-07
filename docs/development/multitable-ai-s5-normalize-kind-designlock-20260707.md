# AI 字段 S5 · 按 kind 规整输出 + classify→select rider · 设计锁（PROPOSED）

> 状态：**PROPOSED — 待 owner ratify**。docs-only；不改 runtime、不发 live 请求。
> 前置（已落 main）：AI-shortcut config（kind/sourceFieldIds/params，`ai-shortcut-config.ts`）· AI 输出=不可信写入源 design-lock（`multitable-ai-output-untrusted-write-source-designlock-20260705.md`）· S1 写入血缘 · S2 prompt-config history。
> 模型分档：设计 = Fable；runtime 实现 = Sonnet；点亮相关的对抗审阅 = Opus。

## 1. 原则

AI-shortcut 现在把 provider 的**原始文本输出**当结果。但字段是有**类型**的（select/number/date/checkbox/…），原始文本直接落进去要么"能落但脏"（未 trim/未规范），要么类型不符。S5 定的是：**在结果进入既有"不可信写入路径"之前，按 shortcut 的 kind + 目标字段类型做一层确定性的规整（normalize）**——不新增信任、不绕过校验/权限，只是把"原始文本"整成"目标字段能干净接收的形状"。

**明确的既有缺口**（代码点名）：`ai-shortcut-config.ts:33` —— **「classify 现在只写 label TEXT；select 目标是 later ring」**。即 classify 输出目前只能写文本字段，写不进 select 字段。S5 的 **classify→select rider** 就补这个口。

## 2. 边界（S5 做什么 / 不做什么）

**做**：
- **per-kind 输出规整**（确定性、无二次 AI 调用）：trim、去引号/围栏、按目标字段类型 coerce（number→数值校验、date→解析、checkbox→布尔、单值 select→单选、多值→数组）。coerce 失败 = **不写 + 记 kind 化的原因**（fail-closed，不塞脏值）。
- **classify→select rider**：当 shortcut.kind=classify 且目标字段是 select/multiSelect 时，把分类结果**映射到该字段的既有 options**：命中 option → 写该 option；未命中 → 可配置行为（默认**不写 + 标注 unmatched**，可选"写 label TEXT 到文本镜像字段"或"按 owner 开关自动建 option"——建 option 需独立 opt-in，见 §4）。
- 规整**全程走既有不可信写入路径**——字段掩码/权限/校验一个不绕（重申 output-untrusted-write lock 在 S5 下仍成立）。

**不做（各自独立立项/后续 ring）**：
- 不做二次 AI 调用来"修输出"（规整必须是确定性纯函数）。
- 不自动新建 select option（默认关；若要，是 classify→select 的一个独立 opt-in rider，需 owner 拍板——因为它会改字段 schema）。
- 不碰 provider/点亮（S5 是"拿到输出之后怎么整"，与 DARK/GA 正交）。

## 3. 硬闸门（不变式）

1. **确定性**：规整是纯函数（同输入同输出），无 AI、无网络、无副作用（除写目标字段）。
2. **fail-closed**：coerce/映射失败 → **不写脏值**，记 kind 化原因（进 S1 血缘/日志），不"尽力塞"。
3. **不绕写入路径**：所有规整结果经既有不可信写入 + 权限 + 掩码 + 校验；S5 不是新写通道。
4. **classify→select 不改 schema**（默认）：未命中 option = 不写 + 标注；自动建 option 是独立 opt-in，默认关。
5. **可回滚/可观测**：规整前的原始输出 + 规整后的值 + 失败原因，都可查（复用 S1 血缘）。

## 4. 门禁（TODO-checklist）

- 🔒 **S5-1 per-kind normalize**（确定性 coerce + fail-closed + 单测覆盖各 kind×字段类型矩阵，含失败向量）— 待本锁 ratify；Sonnet。
- 🔒 **S5-2 classify→select rider**（命中/未命中/多值；未命中默认不写+标注）— S5-1 后；Sonnet。
- 🔒 **S5-3（独立 opt-in）自动建 option**（改 schema，默认关，owner 显式开）— demand-gated；Fable 设计→Sonnet。
- 🔒 **不做**：二次 AI 修复、跨字段联动规整（各自立项）。

## 5. 验证纪律
每 slice 双 MD；kind×字段类型规整矩阵 golden（含失败=不写的负向断言）；classify→select 命中/未命中 golden；证明"规整不绕权限/掩码"（在无写权/掩码字段上规整结果被拦）。

## 6. 一句话
字段有类型，AI 给的是文本——S5 在"输出→不可信写入路径"之间加一层**确定性、fail-closed、不绕权限**的按-kind 规整，并补上代码里点名的 classify→select 缺口。不新增信任、不二次调 AI、不改 schema（除非你显式开自动建 option）。
