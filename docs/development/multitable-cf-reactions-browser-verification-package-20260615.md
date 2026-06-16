# 多维表 条件格式 + 评论反应 — 浏览器验证包(可转交) — 2026-06-15

> Status: **PATH A EXECUTED — 2026-06-16**(见 §6)。一个能跑 Playwright Chrome 的 agent 环境完成了路径 A 组件 harness 验证:A5 渲染(data-bar / color-scale / icon-set)+ B6 反应 chips/picker/pick 往返,**0 console/pageerror**。初判的"数值文字低对比度"发现经**高 DPI 复检 + computed-style 实测已撤销**(文字按底色亮度取深/白,可读;详见 §6 更正)。余下 **3 项 harness 未覆盖子项**(负值色 / frozen 滚动 / 只读反应视角)留待扩 fixture。结论:**浏览器 lane 已被证明可用,A5/B6 渲染目检通过、无 open 发现**。
>
> 原始转交说明(保留备查):本包不新增功能、不改运行时;它把"看起来能渲染(jsdom 证 style/emit)"变成"真实浏览器确认能用"。撰写本包的 agent 沙箱会 `SIGKILL` Playwright 启动的 Chrome(`kill EPERM`),无法在本环境截图/交互,故转交;**执行方 = 一个未被沙箱封禁浏览器驱动的 agent 环境**(2026-06-16 跑通,见 §6)。

## 0. 范围:已验证 vs 待验证

| 能力 | 已验证(免再测) | 待**真实浏览器**验证(本包) |
|---|---|---|
| data-bar (A5-1, #2640) | jsdom render + 逻辑 | 渐变对齐、负值色、frozen 滚动观感 |
| color-scale (A5-2, #2680) | jsdom: cell bg 端点/中点精确 | 真实底色对比度/可读性、文字在底色上的可读性 |
| icon-set (A5-3, #2680) | jsdom: 各桶字形 ↓/→/↑ 等 | 字形跨平台渲染、与数值并排观感、颜色 |
| B6 reactions (#2673 后端 / #2674 UI) | 后端**真实 PG/HTTP** 往返 + jsdom: chip/picker emit | 真实 popover 定位、chip 高亮对比、点击手感、抽屉内排版 |

**结论**:逻辑层全绿;唯一开口 = **视觉/交互渲染**。本包只需确认这一层。

## 1. 路径 A — 组件 harness(快,无需后端/DB/登录)

最快路径:用 Vite 直接挂载**真实组件 + fixture 数据**,无需后端、seed、鉴权。覆盖 data-bar / color-scale / icon-set 网格渲染 + 反应 chips/picker。

### A.1 落两个临时文件

`apps/web/bv.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8" /><title>BV harness</title></head>
<body style="margin:16px;font-family:system-ui">
  <h3>A5 conditional-formatting render + B6 reactions — browser verification</h3>
  <div id="app"></div>
  <script type="module" src="/src/bv-main.ts"></script>
</body></html>
```

`apps/web/src/bv-main.ts`:
```ts
import { createApp, h, ref } from 'vue'
import MetaGridTable from './multitable/components/MetaGridTable.vue'
import MetaCommentReactions from './multitable/components/MetaCommentReactions.vue'
import { buildFieldScaleMap, sanitizeScaleRule } from './multitable/utils/conditional-formatting'
import type { MultitableCommentReaction } from './multitable/types'

const FIELDS = [
  { id: 'bar', name: 'Data bar', type: 'number' },
  { id: 'scale', name: 'Color scale', type: 'number' },
  { id: 'icon', name: 'Icon set', type: 'number' },
  { id: 'label', name: 'Label', type: 'string' },
]
const ROWS = [0, 25, 50, 75, 100].map((n, i) => ({
  id: `r${i}`, version: 1, data: { bar: n, scale: n, icon: n, label: `row ${i}` },
}))
const scaleMap = buildFieldScaleMap([
  sanitizeScaleRule({ id: 'b', fieldId: 'bar', kind: 'dataBar', order: 0, range: { mode: 'auto' }, dataBar: { color: '#2196f3' } })!,
  sanitizeScaleRule({ id: 'c', fieldId: 'scale', kind: 'colorScale', order: 1, range: { mode: 'auto' }, colorScale: { stops: [{ at: 'min', color: '#ff5252' }, { at: 'mid', color: '#ffeb3b' }, { at: 'max', color: '#4caf50' }] } })!,
  sanitizeScaleRule({ id: 'i', fieldId: 'icon', kind: 'iconSet', order: 2, range: { mode: 'auto' }, iconSet: { set: 'arrows3', thresholds: [33, 66] } })!,
], ROWS)

// Reactive reactions so clicks are OBSERVABLE in the browser: onReact/onUnreact
// apply the same local recompute the composable does (add/increment/flip/drop),
// so picking an emoji actually adds a chip / changes a count on screen.
const reactions = ref<MultitableCommentReaction[]>([
  { emoji: '👍', count: 3, reactedByMe: true },
  { emoji: '❤️', count: 1, reactedByMe: false },
  { emoji: '🎉', count: 5, reactedByMe: false },
])
function applyReaction(emoji: string, mode: 'add' | 'remove') {
  const cur = reactions.value
  const ex = cur.find((r) => r.emoji === emoji)
  if (mode === 'add') {
    if (!ex) reactions.value = [...cur, { emoji, count: 1, reactedByMe: true }]
    else if (!ex.reactedByMe) reactions.value = cur.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r))
  } else if (ex?.reactedByMe) {
    const count = Math.max(0, ex.count - 1)
    reactions.value = count === 0
      ? cur.filter((r) => r.emoji !== emoji)
      : cur.map((r) => (r.emoji === emoji ? { ...r, count, reactedByMe: false } : r))
  }
}

createApp({
  setup() {
    return () => h('div', [
      h('div', { style: 'border:1px solid #ddd;margin-bottom:24px' }, [
        h(MetaGridTable, {
          rows: ROWS, visibleFields: FIELDS, sortRules: [], loading: false,
          currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
          searchText: '', rowDensity: 'normal', conditionalFormattingScale: scaleMap,
        }),
      ]),
      h('div', { style: 'padding:12px;border:1px solid #ddd;max-width:360px' }, [
        h('div', { style: 'margin-bottom:8px;color:#333' }, 'Reaction chips + picker:'),
        h(MetaCommentReactions, {
          commentId: 'c1', canReact: true,
          reactions: reactions.value,
          onReact: (_id: string, emoji: string) => applyReaction(emoji, 'add'),
          onUnreact: (_id: string, emoji: string) => applyReaction(emoji, 'remove'),
        }),
      ]),
    ])
  },
}).mount('#app')
```

> 备注:挂载方式与通过的 jsdom 测试(`multitable-grid-databar.spec.ts` / `multitable-comment-reactions.spec.ts`)同款,故组件必能挂载;真实浏览器要看的是 **CSS/字形/颜色渲染**,正是 jsdom 证不了的部分。**验证完务必删除这两个临时文件**(勿提交)。

### A.2 启动 + 截图

```bash
# 终端 1:dev server
pnpm --filter @metasheet/web exec vite --port 5174
# 浏览器打开 http://localhost:5174/bv.html  (或用下方 Playwright 脚本截图)
```

Playwright 截图脚本(存为 `/tmp/bv-shot.mjs`,`node /tmp/bv-shot.mjs`):
```js
import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1100, height: 700 } })
// Attach console + pageerror listeners BEFORE navigation so load/render/click-time
// errors are captured (attaching after goto/click would miss exactly those).
const errs = []
p.on('console', m => m.type() === 'error' && errs.push(m.text()))
p.on('pageerror', e => errs.push(String(e)))
await p.goto('http://localhost:5174/bv.html', { waitUntil: 'networkidle' })
await p.waitForSelector('.meta-grid__cell')
await p.screenshot({ path: '/tmp/bv-grid.png', fullPage: true })
// open reaction picker, screenshot, then pick an emoji and confirm the chip updates
await p.click('[data-test="reaction-add"]')
await p.waitForSelector('[data-test="reaction-palette"]')
await p.screenshot({ path: '/tmp/bv-reactions-picker.png' })
await p.click('[data-test="reaction-pick-🚀"]')          // pick a new emoji
await p.waitForSelector('[data-test="reaction-chip-🚀"]') // reactive harness → chip appears
await p.screenshot({ path: '/tmp/bv-reactions-after.png' })
await b.close()
// Fail loud so the executor (or CI) can't overlook errors.
if (errs.length) throw new Error(`console/page errors:\n${errs.join('\n')}`)
console.log('OK — no console/page errors')
```

## 2. 路径 B — 全栈(更深:集成 + 反应 API 往返)

撰写本包时**已实测可启动**(仅浏览器步骤被沙箱封禁):

```bash
# 1) 干净库 + 迁移(含 meta_comment_reactions 迁移,实测全绿)
createdb metasheet_bv
DATABASE_URL="postgresql:///metasheet_bv" pnpm --filter @metasheet/core-backend migrate
# 2) 后端(:7778,实测 /health 返回 ok、14 插件、DB 连上)
DATABASE_URL="postgresql:///metasheet_bv" PORT=7778 JWT_SECRET=devsecret RBAC_BYPASS=true NODE_ENV=development \
  pnpm --filter @metasheet/core-backend exec tsx src/index.ts
# 3) 前端(:5173,/api 代理到 :7778)
pnpm --filter @metasheet/web dev
# 4) 登录:前端用 dev-token —— GET /api/auth/dev-token?userId=user_1 → 写入 localStorage(auth_token)
```

**seed(本包未完成,留给执行方)**:经 UI 或 API 建 base→sheet→numeric 字段→若干 records;经视图 config 写 `conditionalFormattingScaleRules`(色阶/图标集规则);在某 record 上建 comment 并加反应。路径 A 已绕开此步,故路径 B 仅在需要验证**真实工作台集成 + 反应 API 往返**时才用(API 往返本身已由 #2673 真实 PG 测覆盖)。

## 3. 验证 checklist(逐项视觉/交互证据)

### ☑ data-bar (A5-1) — 渲染已目检(2026-06-16)
- ☑ 单元格内**左锚定渐变条**,长度随值递增(0%→100%):fixture 0/25/50/75/100 → 条长正确递增,`linear-gradient(to right, rgb(33,150,243) X%, transparent X%)` 实测对齐;
- ☐ 负值用 negativeColor(若配置):**未覆盖** — fixture 无负值,留待 harness 扩展;
- ☐ frozen 列滚动时条不丢:**未覆盖** — harness 无 frozen 列/滚动;
- ☑ 数值文字可读:positive 值 computed color = `rgb(17,24,39)`(`#111827` 深),非"浅绿"(那是相邻 icon-set 列的 positive 渲染色,初判时在缩略全页图里看串了 —— 见 §6 更正)。

### ☑ color-scale (A5-2) — 插值 + 文字可读性已目检(2026-06-16)
- ☑ 单元格**实底色**随值在 min/mid/max 间插值(fixture 红→橙→黄→黄绿→绿,平滑);
- ☑ 中点值(50)底色 ≈ mid stop(黄),非端点;
- ☑ **底色上的数值文字可读**:`readableTextOn(fill)` 按 YIQ 亮度取深/白 —— 高 DPI 复检确认 25/50/75 在橙/黄/黄绿上为深字、**100 在深绿格上为白字**(`cellVar=#ffffff`),均可读。初判"低对比度"系缩略全页图里把相邻 icon-set 列的 positive 绿数值看串,已撤销(§6);
- ☐ frozen 列底色不被 sticky #fff 盖掉:**未覆盖** — harness 无 frozen 列。

### ☑ icon-set (A5-3) — 已目检(2026-06-16)
- ☑ 每单元格值前一个**字形**(arrows3: ↓/→/↑),按桶正确:0/25→↓、50→→、75/100→↑(thresholds 33/66);
- ☑ 字形颜色(红/琥珀/绿)正确、无豆腐块;
- ☑ 字形与数值并排不挤、不换行。

### ☑ B6 reactions — 已目检(2026-06-16)
- ☑ chips 显示 emoji + count;**reactedByMe 高亮**明显(👍3 蓝底高亮 vs ❤️1/🎉5 无高亮);
- ☑ 点 add 按钮 → **picker popover 定位正确**(在 + 上方,8 个 emoji 全显,不溢出/不裁剪);
- ☑ picker 内点 🚀 → **新 chip 🚀1 出现且高亮**(harness 本地重算驱动 onReact,浏览器内可见变化);
- ☐ 只读视角(`canReact=false`):**未覆盖** — harness 用 `canReact=true`,留待补一个只读挂载。

## 4. 跑完之后

- **全通过** → 在对应 dev/verification MD 把"浏览器目检 = 残余"改为"已目检",附截图链接;然后 browser lane 视为建立,**方可**开 B1-b/c、A5 config dialog 等后续 browser-gated UI。
- **发现视觉 bug** → 按项开 focused fix PR(各带 jsdom 回归测 + 本包复跑)。
- 在此之前:**不新增 browser-gated UI**,避免风险挂账滚大。

## 5. 已知限制

- 撰写方 agent 沙箱 `SIGKILL` Chrome(`kill EPERM`)→ 无法本地截图;故转交。**更新**:执行方 agent 环境**不受此限**,Chrome 可正常启动截图(见 §6)。
- 路径 A 的 harness 文件为临时验证用,**勿提交**;路径 B 的 `metasheet_bv` 库验证后 `dropdb metasheet_bv`。**确认**:§6 执行后两个临时文件(`apps/web/bv.html`、`apps/web/src/bv-main.ts`)已删除,`git status` 干净。

## 6. 路径 A 执行结果(2026-06-16)

**环境**:一个能启动 Playwright Chrome 的 agent 环境(本地缓存 `~/Library/Caches/ms-playwright/chromium-1208`,`@playwright/test` 1.57.0)。先以 `setContent` 冒烟确认 `chromium.launch()` 不被 `kill EPERM`,再跑全量路径 A。

**步骤**:按 §1 落 `apps/web/bv.html` + `apps/web/src/bv-main.ts`(逐字同本包)→ `vite --port 5174 --strictPort`(`ready in 201ms`,`bv.html` HTTP 200)→ chromium 脚本(`@playwright/test` 的 `chromium`,因裸 `playwright` 未作直接依赖符号链接)挂 console/pageerror 监听后导航、截 3 图。**跑完即删 harness + 停 vite**。

**结果**:
- 网格挂载成功(`.meta-grid__cell` 命中),**0 console error / 0 pageerror**;
- 截图(已归档 `~/Downloads/Github/_bv-evidence-20260616/`):`bv-grid.png`(网格)、`bv-reactions-picker.png`(picker)、`bv-reactions-after.png`(pick 🚀 后);
- A5-1 / A5-2 / A5-3 / B6 勾项见 §3(逐项 ☑ / 未覆盖)。

**发现:无 open 项。** 初判的"data-bar + color-scale 数值文字低对比度"经复检**撤销 / 误报**:
- **复检手段**:(a) `deviceScaleFactor:2` 高 DPI 重截(`bv-grid-highdpi-readable.png`,已归档);(b) Playwright `getComputedStyle` 实测数值元素。
- **实测**:数值元素 = `<span class="meta-cell-renderer--number ... --positive">`;在 scale-fill 上 computed `color` = `rgb(17,24,39)`(深),`100` 在深绿格上 = 白(cellVar `#ffffff`)。即 `MetaGridTable.cellStyle` 的 `readableTextOn`(YIQ 亮度取深/白)+ CSS `.meta-grid__cell--scale-fill :deep(.meta-cell-renderer--positive/negative){ color: var(--meta-grid-scale-text-color)!important }` **已正确生效**。
- **误判根因**:首次用 `fullPage` 缩略全页图(deviceScaleFactor 1),把**相邻 icon-set 列**的 positive 绿数值(该列无 fill,故走默认 positive 绿渲染)看串成 data-bar/color-scale 列的文字。高 DPI 单列复检即澄清。**无需任何代码改动**。

**harness 未覆盖(3,非缺陷,仅 fixture 局限)**:data-bar 负值色;frozen 列滚动;只读反应视角(`canReact=false`)。扩 fixture 即可补。

**lane 结论**:路径 A 在 agent 环境**可重复执行、零基建**,是当前最快的浏览器 gate 开门方式。每个新 browser-gated UI(A5 config dialog / B1-b/c / 记录恢复前端 #2662 / per-field checkbox)在开发同一轮内配一个组件 harness + 本地跑即可产出 gate 证据。窄 CI Playwright lane 仍可作为"无 agent 在环"时的常备兜底(独立 PR、不接 branch protection),按需再建。
