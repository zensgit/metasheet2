# AI 字段 S5 · 按 kind 规整输出 + classify→select rider · 设计锁（PROPOSED）

> 状态：**PROPOSED — 待 owner ratify**。docs-only；不改 runtime、不发 live 请求。
> 前置（已落 main）：AI-shortcut config（kind/sourceFieldIds/params，`ai-shortcut-config.ts`）· AI 输出=不可信写入源 design-lock（`multitable-ai-output-untrusted-write-source-designlock-20260705.md`）· S1 写入血缘 · S2 prompt-config history。
> 模型分档：设计 = Fable；runtime 实现 = Sonnet；点亮相关的对抗审阅 = Opus。

## 1. 原则

AI-shortcut 现在把 provider 的**原始文本输出**当结果。但字段是有**类型**的（select/number/date/checkbox/…），原始文本直接落进去要么"能落但脏"（未 trim/未规范），要么类型不符。S5 定的是：**在结果进入既有"不可信写入路径"之前，按 shortcut 的 kind + 目标字段类型做一层确定性的规整（normalize）**——不新增信任、不绕过校验/权限，只是把"原始文本"整成"目标字段能干净接收的形状"。

**明确的既有缺口**（代码点名）：`ai-shortcut-config.ts:33` —— **「classify 现在只写 label TEXT；select 目标是 later ring」**。即 classify 输出目前只能写文本字段，写不进 select 字段。S5 的 **classify→select rider** 就补这个口。

## 2. 边界（S5 做什么 / 不做什么）

**做**：
- **per-kind 输出规整**（确定性、无二次 AI 调用）：trim、去引号/围栏、按目标字段类型 coerce（number→数值校验、date→解析、checkbox→布尔、单值 select→单选、多值→数组）。coerce 失败 = **不写 + 记 kind 化的原因**（fail-closed，不塞脏值）。**术语澄清（严格解析条款）**：S5 的 "coerce" = **strict parse（严格、无损、无歧义的解析）**，与父锁 §2-B 禁止的 **nearest-value coercion（向"最近的"合法值凑）不是一回事，后者 S5 同样禁止**。任何歧义（多个可行解析、locale 不确定的日期、非精确的布尔词、近似匹配等）一律 **reject-on-ambiguity：不写 + 记原因**，绝不挑"最接近"的值。
- **classify→select rider**：当 shortcut.kind=classify 且目标字段是 select/multiSelect 时，把分类结果**映射到该字段的既有 options**：命中 option → 写该 option；未命中 → 可配置行为：默认**不写 + 标注 unmatched**；可选**镜像回退**——把 label TEXT 写入 **owner 在 shortcut 配置里显式指定的镜像字段（`unmatchedMirrorFieldId`）**：该字段必须是 `string`/`longText`（即现行 `AI_SHORTCUT_TARGET_FIELD_TYPES` 内的类型），**不得是 select 目标本身**，且对它的写入走与主目标**同一套字段级写闸**（路由层类型闸 + layer-3 field-permission 可编辑检查 + `ensureRecordWriteAllowed` 行策略，同 `routes/multitable-ai.ts:469`/`:497` 一线）——未配置或镜像字段不合格 = **回退不发生，仅标注 unmatched（fail-closed）**；或"按 owner 开关自动建 option"（建 option 需独立 opt-in，见 §4）。
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
6. **S5-2 = L3，显式继承父锁，不豁免、不自降档**：把 `select`/`multiSelect` 放进 `AI_SHORTCUT_TARGET_FIELD_TYPES`（`ai-shortcut-config.ts:34`；今天仅 `string|longText`，路由层对其它类型硬 400，`routes/multitable-ai.ts:469`）正是父锁 §0 点名的「target becomes a `select`/`enum` → blast radius changes class」事件，且命中父锁 §5 trip-wire（AI-output sink）**自动升 L3**。S5-2 因此**逐项继承**父锁（`multitable-ai-output-untrusted-write-source-designlock-20260705.md`）的 L3 门槛——L3 标签、G-A/G-B/G-C observed-RED goldens、独立 golden 作者、§6 enablement-ledger 条目、default-off——细目见 §4；S5 不为该 sink 另设更轻的门槛（父锁 §7 禁止 silent divergence）。

## 4. 门禁（TODO-checklist）

- 🔒 **S5-1 per-kind normalize**（确定性 coerce + fail-closed + 单测覆盖各 kind×字段类型矩阵，含失败向量）— 待本锁 ratify；Sonnet。**放宽点点名**：S5-1 把 `number`/`date`/`checkbox` 放进 `AI_SHORTCUT_TARGET_FIELD_TYPES`（`ai-shortcut-config.ts:34`），**不含 `select`/`multiSelect`**（select 只在 S5-2）；仍受父锁 §2-B fail-closed reject 约束，档位按父锁 §5 在其 PR 中写明供审。
- 🔒 **S5-2 classify→select rider**（命中/未命中/多值；未命中默认不写+标注）— S5-1 后；Sonnet 实现、Opus 对抗审。**L3，显式逐项继承父锁门槛（不豁免）**：
  - **trip-wire**：本 slice 的放宽点 = `AI_SHORTCUT_TARGET_FIELD_TYPES`（`ai-shortcut-config.ts:34`）**首次放入 `select`/`multiSelect`**——即父锁 §0 的 blast-radius 变类事件 + §5 trip-wire 自动 L3，不自评降档；
  - **goldens**：父锁 §4 **G-A**（不能直接写 W 的 actor 也不能经 AI-输出路径写 W）/ **G-B**（域外 label fail-closed reject、不 coerce、不写）/ **G-C**（masked/absent/not-writable 目标统一拒绝、no-oracle）全部落地，并按父锁 §5 记录 **observed-RED**（merge 前实际观察到的 RED，非"理论上会红"）+ **独立 golden 作者/对抗审阅**（从 SPEC 出发，非从实现出发）；
  - **点亮**：**default-off** 独立 flag + 父锁 §6 **enablement-ledger 条目**（owner · precondition · last-reviewed · flag-on smoke · rollback），merged ≠ enabled ≠ safe-to-enable。
- 🔒 **S5-3（独立 opt-in）自动建 option**（改 schema，默认关，owner 显式开）— demand-gated；Fable 设计→Sonnet。至少继承 S5-2 同档（L3）门槛。
- 🔒 **不做**：二次 AI 修复、跨字段联动规整（各自立项）。

## 5. 验证纪律
每 slice 双 MD；kind×字段类型规整矩阵 golden（含失败=不写的负向断言）；classify→select 命中/未命中 golden；证明"规整不绕权限/掩码"（在无写权/掩码字段上规整结果被拦）。**S5-2 的 golden 直接对应父锁 §4：G-A/G-B/G-C，实 DB、fail-first、observed-RED 记录在 PR 里，golden 由独立视角从 SPEC 编写或对抗审阅（父锁 §5）**——上述"命中/未命中"即 G-B 的正/负向，"不绕权限/掩码"即 G-A/G-C 的实例化。

## 6. 一句话
字段有类型，AI 给的是文本——S5 在"输出→不可信写入路径"之间加一层**确定性、fail-closed、不绕权限**的按-kind 规整，并补上代码里点名的 classify→select 缺口。不新增信任、不二次调 AI、不改 schema（除非你显式开自动建 option）；select 落点（S5-2）按父锁 **L3 档位**走：observed-RED goldens + 独立作者 + enablement-ledger + default-off。

## 7. 修订记录
- **Rev1（2026-07-09，门禁整改；状态不变，仍 PROPOSED）**：按独立对抗门禁 CHANGES_REQUESTED（light）整改——**P2-a（governance）**：S5-2 显式逐项继承父锁 L3 门槛（§3.6 + §4），不再轻于父锁；**P2-b**：未命中镜像回退命名为显式配置的 `unmatchedMirrorFieldId` 并绑定与主目标同套字段级写闸（§2）；**P3-a**：点名 `AI_SHORTCUT_TARGET_FIELD_TYPES`（`ai-shortcut-config.ts:34`）的放宽即 trip-wire 事件，并据此切分 S5-1（number/date/checkbox）/ S5-2（select）（§4）；**P3-b**：加严格解析/reject-on-ambiguity 条款，澄清与父锁 §2-B 禁止的 nearest-value coercion 的关系（§2）。本次修订仅为整改，**不是 ratify**。
