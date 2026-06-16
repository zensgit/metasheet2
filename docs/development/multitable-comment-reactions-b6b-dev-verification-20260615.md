# 多维表评论 Emoji 反应 B6-b — 开发 & 校验 — 2026-06-15

> Status: **DONE + CI-BROWSER-VERIFIED**(jsdom/单测 + 真实 Chromium 截图确认)。B6 弧的 UI 半 = 评论反应展示 + 选择器 + 组合式/客户端接线。延续 B6-a(存储 + API,已合并 #2673)。浏览器目检已由 CI lane(#2689)完成:chips(含 reactedByMe 高亮)、picker popover、点选 🚀 → 新 chip 出现的交互均截图确认。realtime 广播仍推迟(见 §4)。
>
> 设计延续 B6-S0 设计锁；FE 接面经 dynamic workflow `wf_55831f49-88b`(3 路) + 逐文件独立核验 grounded。A5-1c 先例：FE 渲染可凭 jsdom 逻辑测落地，视觉/交互为浏览器残余。

## 1. 开发（做了什么）

| 层 | 文件 | 改动 |
|---|---|---|
| 类型 | `multitable/types.ts` | `MultitableCommentReaction {emoji,count,reactedByMe}` + `MultitableComment.reactions?` + `COMMENT_REACTION_PALETTE`(镜像后端白名单) |
| 客户端 | `multitable/api/client.ts` | `normalizeMultitableCommentReactions` + 在 `normalizeMultitableComment` 显式携带 `reactions`（**修 wire-drift**）；`addReaction`/`removeReaction`（POST/DELETE `/reactions`，emoji 入 body，镜像 createComment 的 Content-Type+JSON.stringify） |
| 组合式 | `multitable/composables/useMultitableComments.ts` | `addReaction`/`removeReaction`（await-then-mutate，镜像 resolveComment）+ `applyReaction` 本地重算 + `reactingKeys` 在途去抖 + `upsertComment` **保留既有 reactions**（修 edit/realtime 抹除 bug）|
| 组件 | `multitable/components/MetaCommentReactions.vue`（新） | reaction chips（emoji+count，reactedByMe 高亮）+ 选择器 popover（8-emoji 调色板）；emits `react`/`unreact`；`pendingKeys` 禁用在途 chip |
| 抽屉 | `multitable/components/MetaCommentsDrawer.vue` | 在 thread root + reply 内容下嵌 `<MetaCommentReactions>`；新增 emits `react`/`unreact` + `reactingKeys` prop（保持 presentational：emit 给父） |
| 父接线 | `multitable/views/MultitableWorkbench.vue` | `@react/@unreact` → `commentsState.addReaction/removeReaction` + `:reacting-keys` |
| i18n | `meta-comment-labels.ts` + `workbench-labels.ts` | `comment.addReaction`/`errorAddReaction`/`errorRemoveReaction` + `toast.commentReactFailed`（zh/en）|

## 2. 关键设计点

- **wire-drift 修复（headline）**：`normalizeMultitableComment` 是白名单逐字段拷贝，**默认丢弃** raw 的 `reactions`。三处必改：`MultitableComment` 类型 + `RawComment`(经 Partial 继承) + 规范化器显式携带（新 `normalizeMultitableCommentReactions` 镜像 `normalizeMultitableCommentMentions`）。否则后端返回的 reactions 在 FE 静默消失。**有 round-trip 单测守卫**。
- **await-then-mutate（非乐观）**：反应端点不回任何 reaction 数据（POST→201 `{}`、DELETE→204），故先 `await api` 成功再本地重算 `comment.reactions`（镜像 resolveComment 约定）；失败抛错且**不**改本地态。无 target 记忆 → 本地重算优于 refetch。
- **本地重算 `applyReaction`**：add 新 emoji→push count1/me=true；add 已存在未 me→count+1/me=true；add 已 me→no-op；remove me→count-1/me=false，归零则删条目；remove 非 me→no-op。与后端幂等语义一致。
- **upsert 保留 reactions（修 bug）**：edit/realtime 的 comment 载荷未 hydrate reactions，`{...old,...new}` 会用 `undefined` 抹除已显示的 reactions；upsert 现于 incoming.reactions===undefined 时保留旧值。
- **emoji 入 body**（add+remove 对称）：沿 B6-a §3.3，绕开多码点 path 编码漂移。
- **可见 ≠ 可操作（canReact）**：reaction **计数对所有能看该评论的人可见**（后端对所有 reader 返回 reactions），仅**添加/切换**需 `comments:write`。故 `MetaCommentReactions` 加 `canReact` prop：chips 始终渲染（read-only 时禁用、仅显示计数），选择器(add)仅 `canReact` 时显示；抽屉以 `canComment || 有reactions` 决定是否渲染该组件、并传 `:can-react="canComment"`。（advisor 复核：原先整组件 `v-if=canComment` 会把计数也对只读者隐藏，已改为有意区分。）

## 3. 校验

| 校验项 | 结果 |
|---|---|
| 组合式 + 客户端规范化 `multitable-comments.spec.ts`（真实 client + mock fetch） | 含 B6 新增（wire-drift round-trip、add POST body+本地重算、增量/幂等、remove DELETE body+归零删条目、保留既有他人计数、upsert 保留、失败不改态本地化兜底） |
| 组件 `multitable-comment-reactions.spec.ts`（jsdom mount） | chip 渲染+count+reactedByMe 高亮/aria；点未反应 chip→react、点己 chip→unreact；开调色板→pick→react→关；pendingKeys 禁用在途；空列表仍显加按钮 |
| 两文件合计 | **25 + (component) passed**（合并跑 25 composable/client，component 套件单列全绿）|
| 回归：drawer/i18n/composer/labels/client 既有套件 | 50 passed（抽屉改动无回归）|
| 本地 tsc（pure-TS 变更文件，过滤模块解析噪声）| 无类型错误 |
| FE 类型门 `vue-tsc -b` | **CI `test (18.x/20.x)` 为权威门**（本机 Node 25 跑不了 vue-tsc）|

> jsdom CSS 属性选择器无法可靠匹配星平面 emoji 字符 → 组件测按 class + emoji 文本内容定位（非 `[data-test="…👍"]`）；已记为测试基建注意点。

## 4. Goal 边界（诚实残余）

- ✅ **逻辑层（client/composable/component emit + render 状态）jsdom/单测验证到位。**
- ✅ **浏览器目检 = 已由 CI lane 完成**（#2689 真实 Chromium 截图）：reaction chips（含 reactedByMe 高亮）、picker popover 定位、点选 🚀 → 新 chip 即时出现的交互均确认。frozen/滚动观感与全栈 realtime 仍未单独验，非本弧阻塞（realtime 见 §4，仍为具名 opt-in）。
- ⏸ **realtime 广播仍推迟**：他人反应不会实时推达本端（反应非 comment 事件；本端反应即时本地重算）。后端先把持久化/聚合/读做正确；realtime 作为后续具名 opt-in。upsert 保留修复已确保既有 comment realtime 更新不抹除本端 reactions。
- ⏸ **palette 漂移**：FE 调色板硬编码镜像后端白名单；漂移时后端 400 兜底（失败安全，不损数据）。理想为共享常量，YAGNI 暂缓。

## 5. 落地

B6-b（types + client + composable + component + drawer + workbench + i18n + 测）+ 本记录，单 PR。CI `test (18.x/20.x)` 验单测 + `vue-tsc -b`。B6 弧后端(B6-a)+UI 逻辑(B6-b)闭合；剩 realtime + 浏览器目检为具名 opt-in / 访问门。
