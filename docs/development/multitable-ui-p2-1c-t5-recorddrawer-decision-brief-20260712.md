# UI-P2-1c · T5 · MetaRecordDrawer — OWNER 决策 brief（2026-07-12）

**类型**：决策 brief（docs-only，**零 runtime，零实现**）。
**为什么是 brief 而不是实现**：tail 设计锁（`multitable-ui-p2-1c-tail-resolution-designlock-20260707.md`，已 RATIFIED）§3 对 T5 明写 **「待 owner 定 toggle/emoji 处理」**。T5 的第一个 manager（MetaApiTokenManager，#4143）之所以能直接落，是因为核验后发现它 **没有** stateful toggle——step (b) 用不上。**MetaRecordDrawer 不是这样**：它三样都有。按 owner 红线「**不要让实现自己发明样式语义**」，这里停下来交给 owner。

---

## §1 面：`meta-record-drawer__btn` 的 8 个 sharer（origin/main `db2eb8a57` 逐行核验）

| # | 按钮 | 行 | 语义 | 归档 |
|---|---|---|---|---|
| 1 | **watch / watching** | :11-21 | **真 stateful toggle**：`:class="{ '--watching': recordSubscribed }"` + **标签随态换**（`record.watching` / `record.watch`）+ `:disabled="subscriptionLoading"`。**无 `aria-pressed`** | 🔴 **OD-T5a** |
| 2 | **comment** | :23-31 | 子节点是**组件** `<MetaCommentActionChip>`（**不是文本标签**）；`:class="drawerCommentButtonClass"` ← `resolveCommentAffordanceStateClass(...)` | 🔴 **OD-T5b** |
| 3 | **workflow** | :32 | glyph 前缀标签 `&#x2699;`（齿轮）+ 文本；`v-if="canManageAutomation"` | 🟡 **OD-T5c** |
| 4 | **permissions** | :33 | glyph 前缀标签 `&#x1F512;`（锁）+ 文本；`v-if="canManageRecordPermissions"` → 开权限面板 | 🟡 **OD-T5c** |
| 5 | **duplicate** | :34 | 纯文本 action；`v-if="record && canCreate"` | 🟢 step (a) |
| 6 | **delete** | :35 | 纯文本 + `--danger`；`v-if="resolvedCanDelete"` → `emit('delete')` | 🟢 step (a)（`variant="danger"`） |
| 7 | **unlock** | :64-70 | 纯文本；`v-if="record.canUnlock"`、`data-test="record-unlock-action"` → `emit('toggle-lock')` | 🟢 step (a) |
| 8 | *(nav `‹` `›` 用的是另一个类 `__nav-btn`，**不是** `__btn` sharer——不在 T5 面)* | :7-8 | — | ⚪ 出界 |

> 5/6/7 是锁 step (a) 的「纯文本 action」，**语义无歧义**。1/2/3/4 才是锁点名要 owner 定的那部分。

---

## §2 两个**硬发现**——它们是「实现不能自己拍」的实证理由

### 2.1 active 态的琥珀色**没有对应 token**——「只用 token」与「保住观感」在此**直接冲突**

`.meta-record-drawer__btn--comment--active`（:1077）：

```
border-color: #f59e0b;  background: #fff7ed;  color: #b45309;
```

而 `tokens.css` 里**唯一**的琥珀/警告 token 是：

```
--ms-color-warning: #d97706;   /* waiting / timeout warning */
```

**三个都不等于它**。所以：

- 走「token-only、不新增 hex」⇒ **观感会变**（换成 `--ms-color-warning` 是另一个色阶），**不是**字节等价迁移；
- 走「保住观感」⇒ 得**留着这三个 hex**，那就不是 token 化。

**二者不可兼得。这是一个产品/设计取舍，不是实现细节**——实现无权替 owner 选，也不该偷偷选。

### 2.2 comment 按钮**不是 T5 意义上的 shared-class sharer**——它属于一个**跨 9 组件的 affordance 系统**

`resolveCommentAffordanceStateClass`（`utils/comment-affordance.ts`）被 **9 个组件、约 12 处**调用，每处传自己的 base class：

`MetaGridTable` · `MetaKanbanView` · `MetaGalleryView` · `MetaCalendarView` · `MetaTimelineView` · `MetaHierarchyView` · `MetaFormView` · `MetaCommentAffordance` · `MetaCommentActionChip` · `MetaRecordDrawer`

**把 drawer 这一处单独迁进 MtButton = 把这个系统劈开**：drawer 走原语，其余 8 个视图仍是 bespoke，同一个「有无评论」的视觉语言**从此分叉**。且它的子节点是 `<MetaCommentActionChip>` 组件而非文本——MtButton 的 slot 能装，但「按钮里塞一个自带状态样式的 chip」是否还算 MtButton 的合法用法，本身就是原语契约问题。

**建议：comment 按钮从 T5 剥离，单独成票**（要么整个 affordance 系统一起收敛，要么明确不收敛）。**不要**为了「T5 全 sharer 迁完」这个整齐感,把它顺手拖进来。

---

## §3 OWNER 决策点 — ✅ 全部已裁（owner 2026-07-13，见 §3.5）

## §3.5 OWNER 裁决记录（2026-07-13，逐字采纳）

| 决策点 | 裁决 | 实施边界（owner 原话要点） |
|---|---|---|
| **OD-T5a** | **= A** | watch 迁 `MtButton`，**保留 `--watching` 状态类**，**新增 `aria-pressed`**；原有 loading / disabled / click 行为**不变**。 |
| **OD-T5b** | **= A** | comment **从 T5 剥离**，**单独治理整个 comment-affordance 系统**（独立短设计锁：专用 comment-active token + 9 组件一致性测试）。**不得拿 warning token 代替 comment-active 色彩**（§2.1 的 C 选项被明确否决）。 |
| **OD-T5c** | **= A** | workflow / permissions 迁 `MtButton`，**现有 glyph 保留在 slot**，**暂不引入新图标契约**。 |
| **OD-T5d** | **= 放行** | duplicate / delete / unlock 可迁；**`@click`、`v-if`、`:disabled`、`data-*` 必须逐字节保留**；delete 用 **`variant="danger"`**。 |

**实施拆分（owner 指定，可并行）**：
- **T5-safe** = watch + workflow + permissions + duplicate/delete/unlock（一个 runtime slice，实施中）。
- **Comment-affordance** = 独立短设计锁（`multitable-comment-affordance-token-design-lock-20260713.md`，PROPOSED——token 值是新样式语义，仍需 owner ratify），定义专用 comment-active token + 9 组件一致性测试。

> 下方 §3 原选项表与 §4 推荐保留为**提案历史**;裁决以本节为准。

### 🔴 OD-T5a — watch toggle 的 active 态怎么表达？

| 选项 | 做法 | 代价 |
|---|---|---|
| **A（荐）** | `MtButton`（默认 variant）+ **保留** `--watching` class 做 active 态 + **新增 `aria-pressed`** | `aria-pressed` 是**新增 a11y 语义**（今天没有）——虽是纯改进，但仍属「新语义」，故要 owner 点头 |
| B | 给 `MtButton` 加 **`pressed`/`active` 属性**（原语级 toggle 支持） | 动**原语契约**，影响全站所有 MtButton 使用者；应走独立的原语设计票，不该由一个 manager 的迁移顺带引入 |
| C | watch 按钮**不迁**，留 bespoke；T5 只迁 5/6/7 | 面留个口子，但**零风险、零发明**；日后有真正的 toggle 原语再收 |

> 注：标签本身已随态变（watching/watch），所以即使不加 `aria-pressed`，态**不是**不可感知的——A 的增量主要是给读屏器一个机器可读的态。

### 🔴 OD-T5b — comment 按钮

| 选项 | 做法 |
|---|---|
| **A（荐）** | **剥离出 T5**，单独成票（连同 §2.2 的 9 组件 affordance 系统一起考虑）。T5 本轮**不碰** |
| B | 迁进 MtButton，**保留** `#f59e0b/#fff7ed/#b45309` 三个 hex（承认「不 token 化」这一例外） |
| C | 迁进 MtButton，**改用 `--ms-color-warning`**（接受观感变色） |

### 🟡 OD-T5c — glyph 前缀标签（workflow `⚙`、permissions `🔒`）

| 选项 | 做法 |
|---|---|
| **A（荐）** | 迁 `MtButton`，**glyph 留在 slot 里当文本**（`&#x2699; {{ label }}` 原样搬）——与 T1 的「× 保字形」同一口径，零视觉变 |
| B | 拆成 `MtIconButton` + 独立文字 | 改布局，观感必变 |
| C | 不迁 | — |

### 🟢 OD-T5d — 5/6/7（duplicate / delete / unlock）确认放行？

纯文本 action，语义无歧义，**建议直接按 step (a) 迁**（delete → `variant="danger"`）。
⚠ 但三者都**紧邻红线**（`emit('delete')` / `emit('toggle-lock')` / 权限 `v-if`）——按锁：**只动按钮元素 + CSS，`@click`/`v-if`/`:disabled`/`data-*` 逐字节保留**，逻辑零触碰。请 owner 确认这三个可以动。

---

## §4 我的推荐（**一句话版**）

**T5-drawer 拆成两半**：本轮只做 **OD-T5d 的 5/6/7（纯文本 action）+ OD-T5c=A（glyph 留 slot）**——这四个**零发明、零决策**；**watch toggle 与 comment 按钮各自留票**（OD-T5a / OD-T5b），因为一个要新 a11y 语义、一个要动跨 9 组件的 affordance 系统。

这样 T5 的「全 sharer 一次迁」**不再成立**——但那个「整齐」本来就是把两个真决策揉进一次机械迁移换来的。**如实记为：T5 = 一次部分迁 + 两张待决票。**

---

## §5 本文不主张什么

- 不主张 T5 已完成——T5-safe slice 实施中（未合），comment-affordance 锁是 PROPOSED。
- ~~不主张上面任何一个「（荐）」已被采纳~~ → **2026-07-13 起 §3.5 记录 owner 裁决**：OD-T5a/b/c 均裁 A、OD-T5d 放行（凑巧与推荐一致，但**以裁决为准,不以推荐为据**）。
- 不主张碰过任何权限 / 删除 / 锁定逻辑：**本文零 runtime**。
- 不主张 comment-affordance 的 token **值**已定——那在独立锁里,仍待 owner ratify。
