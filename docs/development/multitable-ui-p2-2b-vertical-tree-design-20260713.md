# 多维表 UI-P2-2b · 垂直树左侧栏（工作区 → 数据表 → 视图）· 设计（DESIGN）

> 状态：**DESIGN**（不是新 lock）。母锁 `multitable-ui-p2-2-left-rail-detail-designlock-20260707.md` 已 **RATIFIED**（owner directive 2026-07-11）并授权本切片：**P2-2b = Fable 设计 → Sonnet 实现 → Opus 对抗审阅前置**（结构性风险，母锁 §4.6/§5）。本文即 Fable 设计交付物。
> 例外：§10 列出的 2 项 **owner 决策为 pending**——实现不得预设，按各项推荐默认执行"不做"侧。
> 基线：`origin/main` @ `78caa7906`（P2-2a #4237 已落：`MetaSheetViewRail.vue` 抽出、行为字节等价、`MetaViewTabBar.vue` 保留为冻结 DOM 等价基线）。
> 术语：UI 展示层用 ratify 过的 G-10 词典（`multitable-unified-roadmap-W0-W5-20260713.md` §6-n）：Base=**工作区**、Sheet=**数据表**、View=**视图**、Record=**记录**；**代码/props/API 一律保留 Base/Sheet/recordId 不动**。

---

## 0. 一句话

把 P2-2a 抽出的 `MetaSheetViewRail`（目前仍是水平标签条）重排为**持久、可折叠的垂直树左侧栏**（工作区 header → 数据表节点 → 视图叶子），4 emits / 7 props / gating / 计数守恒**行为等价不变**，全程 UF token、原生键盘可操作、零权限/数据路径触碰；同时**退役**冻结基线 `MetaViewTabBar.vue`（字节等价从此不再成立，安全网换成行为等价 + 键盘测试）。

## 1. 树结构与数据映射

### 1.1 三层结构

```
┌─ aside.mt-workbench__rail ──────────────┐
│ [工作区 header]  ← MetaBasePicker（原样） │   ← 第 1 层：工作区（Base）
│ ─────────────────────────────────────── │
│ role="tree"（MetaSheetViewRail 内部）     │
│  ▸ 数据表 A                              │   ← 第 2 层：数据表（Sheet）
│  ▾ 数据表 B          (= activeSheetId)   │
│     ▦ 视图 1        (= activeViewId)     │   ← 第 3 层：视图（View）
│     ▤ 视图 2   [个人视图 pill]            │
│  ▸ 数据表 C                              │
│  ＋ 新建数据表       (canCreateSheet 门)  │
└─────────────────────────────────────────┘
```

### 1.2 7 props → 树层级映射（逐一）

`MetaSheetViewRail` 的 props/emits 契约**一个字不改**（母锁 §4.1/§4.2 硬约束）：

| # | prop | 类型 | 驱动树的哪一层 |
|---|------|------|----------------|
| 1 | `sheets` | `MetaSheet[]` | **第 2 层**：每个元素 = 一个数据表节点（N 个 sheet → N 个节点） |
| 2 | `views` | `MetaView[]` | **第 3 层**：每个元素 = active 数据表节点下的一个视图叶子（M 个 view → M 个叶子）。⚠ 见 §1.3 数据不变量 |
| 3 | `activeSheetId` | `string` | 决定**哪个数据表节点是展开的**（唯一展开 = accordion，见 §3.2）+ 该节点 active 态样式 + `aria-selected` |
| 4 | `activeViewId` | `string` | 视图叶子的 active 态 + `aria-selected` + 个人视图 pill 的挂载位置 |
| 5 | `canCreateSheet?` | `boolean` | "＋ 新建数据表"行的 v-if 门（false/absent = 无 DOM，无点击目标） |
| 6 | `personalViewsEnabled?` | `boolean` | 个人视图 pill 的 G-FE-4 门（false/absent = 无 DOM）——与今天逐字等价 |
| 7 | `isPersonalMode?` | `(viewId)=>boolean` | pill 的 `aria-pressed` / `--on` 态——与今天逐字等价 |

**第 1 层（工作区）不由 rail 的任何 prop 驱动**——rail 的 7 props 里没有 base 数据，也不许加（会破 7-props 平价）。第 1 层由**组合**实现：`MultitableWorkbench` 把既有的 `.mt-workbench__base-bar`（内含 `MetaBasePicker`，3 props / 3 emits 契约原样不动）从模板顶部**移入**左栏 aside 作 header（母锁 §3 目标形状明文"顶部 base 名/切换"，此移动已获授权）。`MetaBasePicker` 保持自己的 popover 交互，**不进** `role="tree"`（避免 P2-1b 式"role 名不副实"）。

### 1.3 数据不变量（树设计的地基，实现前必须理解）

`views` prop **只含 active sheet 的视图**：consumer 传 `visibleWorkbenchViews`（`MultitableWorkbench.vue` ~L1305，对 `workbench.views` 做 view-permission 过滤），而 `useMultitableWorkbench.ts` 的 `views` ref 在 `selectSheet()`/`syncContextState()` 时整体换成新 sheet 的视图（~L127/~L298）。因此：

- 树**只有 active 数据表节点渲染子级**（`role="group"`）；非 active 节点没有子级数据可渲染。
- **自由多展开（同时展开多个数据表看各自视图）在 2b 做不了**——那需要按 sheet 拉取视图列表 = 碰数据加载路径，母锁 §4.3 明令禁止。展开语义 = 激活语义（见 §3.2）。
- 计数守恒因此仍是 P2-2a 的同一条：N sheets → N 个数据表节点；M views → M 个视图叶子（全部在 active 节点下）。

## 2. 目标 DOM 结构（实现蓝本）

### 2.1 Workbench 侧（`MultitableWorkbench.vue`，仅模板搬动 + CSS）

现状（模板顺序）：`base-bar` → `MetaSheetViewRail` → `__actions` → `MetaToolbar` → `__content > __main`。

目标：

```html
<div class="mt-workbench">
  <MetaToast/> <conflict banner（不动）/>
  <div class="mt-workbench__actions">…（不动）</div>
  <MetaToolbar …（不动）/>
  <div class="mt-workbench__content">           <!-- 已是 flex row（~L4324） -->
    <aside class="mt-workbench__rail" :class="{ 'mt-workbench__rail--collapsed': railCollapsed }">
      <div class="mt-workbench__rail-head">
        <div v-if="basePickerBases.length" class="mt-workbench__base-bar"><MetaBasePicker …原绑定逐字不动 …/></div>
        <button data-testid="rail-collapse-toggle" :aria-expanded="!railCollapsed" @click="railCollapsed = !railCollapsed">…</button>
      </div>
      <MetaSheetViewRail v-show="!railCollapsed" …7 绑定 + 4 handler 逐字不动（仅挂载位置变）… />
    </aside>
    <div class="mt-workbench__main">…（不动）</div>
  </div>
</div>
```

- 绑定行（7 个 `:prop` + 4 个 `@handler`，现 ~L25）**逐字保留**，只换挂载位置。
- `MetaBasePicker` 的绑定（`:bases/:active-base-id/:can-create/@select/@create/@toggle-favorite`）逐字保留。
- workbench `<script>` 唯一新增：`const railCollapsed = ref(false)` + 折叠按钮 label 取词（见 §5.4）。**不得**碰任何 composable / client / permission 代码。
- 顶部 `__actions` 行与 `MetaToolbar` 保持全宽在 `__content` 之上（最小 diff；rail 从 toolbar 下沿开始，VSCode 式）。整栏全高 rail（actions/toolbar 移入 main 列）**不在 2b 范围**，留给后续 polish——不要顺手做。
- print CSS：`.mt-workbench__rail` 加入既有 print 隐藏列表（~L4436）；rail 组件自身的 `@media print` 隐藏规则保留（换新根类名）。

### 2.2 Rail 侧（`MetaSheetViewRail.vue` 内部重排）

新 BEM 块 `.meta-view-rail`（旧 `.meta-tab-bar__*` 类整体退场）：

```html
<nav class="meta-view-rail">
  <ul role="tree" :aria-label="railLabel('rail.treeLabel', isZh)" class="meta-view-rail__tree">
    <li role="none" v-for="s in sheets">
      <button role="treeitem" data-testid="rail-sheet-node"
              :aria-selected="s.id === activeSheetId"
              :aria-expanded="sheetAriaExpanded(s)"   <!-- §5.3 -->
              :tabindex="rovingTabindex(nodeKey)"
              class="meta-view-rail__sheet" :class="{ '--active': s.id === activeSheetId }"
              :title="s.name"
              @click="emit('select-sheet', s.id)" @keydown="onTreeKeydown">
        <chevron 图标（纯装饰，aria-hidden）> {{ s.name }}
      </button>
      <ul role="group" v-if="s.id === activeSheetId && views.length" class="meta-view-rail__views">
        <li role="none" v-for="v in views" class="meta-view-rail__view-row">
          <button role="treeitem" data-testid="rail-view-node"
                  :aria-selected="v.id === activeViewId" :tabindex="rovingTabindex(nodeKey)"
                  class="meta-view-rail__view" :class="{ '--active': v.id === activeViewId }"
                  :title="v.name"
                  @click="emit('select-view', v.id)" @keydown="onTreeKeydown">
            <el-icon><component :is="viewTypeIcon(v.type)"/></el-icon> {{ v.name }}
          </button>
          <button v-if="personalViewsEnabled && v.id === activeViewId" type="button"
                  data-testid="personal-view-toggle" …aria-pressed/label/emit 逐字保留… />
        </li>
      </ul>
    </li>
  </ul>
  <button v-if="canCreateSheet" data-testid="rail-add-sheet" class="meta-view-rail__add" @click="onAddSheet">
    ＋ {{ railLabel('rail.addSheet', isZh) }}
  </button>
</nav>
```

保留逐字不动的部分：`defineProps` 块、`defineEmits` 块、`onAddSheet`（含 `Sheet ${props.sheets.length + 1}` 命名逻辑——测试断言 `'Sheet 3'`）、`VIEW_TYPE_ICON` 映射 + `viewTypeIcon()`（含未知类型 fallback IconGrid）、个人视图 pill 的 `data-testid` / `aria-pressed` / gating / label（`个人视图`/`My view` 字符串不变）。

**不做**（逐条声明，防 scope creep）：无 "＋新建视图" 行（需要第 5 个 emit，母锁 §4.1 禁止——见 §10-B）；无节点右键菜单；无拖拽重排（母锁 §5 "不做"清单）；无 typeahead 搜索；无每节点自由折叠（§1.3）。

## 3. 折叠/展开

### 3.1 整栏折叠（rail-level）——workbench 所有

- 状态：`railCollapsed = ref(false)`，**workbench 本地 ref**（组件重挂即复位）。默认**展开**（rail 是主导航，折叠是逃生舱）。
- 折叠态：aside 收窄为细条（宽 ≈ 36px），`MetaSheetViewRail` 与 base-bar 以 `v-show` 隐藏（`display:none` ⇒ 不可聚焦、不可点击、不在 a11y 树——jsdom 可直接断言 `style.display`）；细条上只有展开按钮（同一颗 `rail-collapse-toggle`，`aria-expanded` 翻转）。
- **不做图标条导航**（折叠态可点 sheet 图标之类）——那是母锁 §5 P2-2c（响应式抽屉/图标条）的地盘。
- **无持久化**：不写 localStorage/服务端。跨会话记住折叠态 = 新增存储 = **owner 决策**（§10-A），2b 按"不持久"实现。
- 放 workbench 而非 rail 组件内的原因：折叠要连 base-bar 一起收，而 base-bar 是 workbench 的模板节点；放 rail 内则要么收不了 base-bar、要么得给 rail 加 prop（破 7-props 平价）。

### 3.2 节点展开（sheet-level）——派生态，无本地状态

**展开态 = `activeSheetId` 的纯函数**（accordion，恒一个展开）。没有独立的每节点展开 ref。

- 点击任意数据表节点（含 active 自身）→ `emit('select-sheet', s.id)`——与今天点 sheet tab 逐字同语义（今天点 active tab 也重发 emit，保留）。父组件更新 `activeSheetId` + 重载 `views` → 树重渲染，新 active 节点展开。
- 好处：(a) 展开/数据加载的因果关系不变——组件仍然只是"发 emit、等新 props"，零数据路径触碰；(b) 行为等价可测——展开行为完全由 props 驱动，测试喂不同 `activeSheetId` 断言 group 渲染。

## 4. 4 emits 等价映射（行为等价的可检对照表）

| emit | 今天的触发（水平条） | 2b 的触发（垂直树） | payload | gating |
|------|--------------------|--------------------|---------|--------|
| `select-sheet` | 点 sheet tab | 点数据表节点 button（整行含 chevron 一颗 button；Enter/Space = 原生 button 激活，与今天相同——今天也是原生 button） | `s.id`（不变） | 无（与今天同：任意 sheet 含 active 可点） |
| `select-view` | 点 view tab | 点视图叶子 button（Enter/Space 同上） | `v.id`（不变） | 无（active 视图可重点，与今天同） |
| `create-sheet` | 点 "+" tab | 点 "＋ 新建数据表" 行 | `` `Sheet ${sheets.length + 1}` ``（`onAddSheet` 逐字保留） | `canCreateSheet`（v-if，false/absent 无 DOM） |
| `toggle-personal` | active view tab 旁 pill | active 视图叶子行内 pill（testid/aria-pressed/label 逐字保留） | `v.id`（渲染处即 activeViewId，不变） | `personalViewsEnabled && v.id === activeViewId`（逐字保留） |

- **键盘导航键（方向键/Home/End）纯移焦点，永不 emit**（§5.2）。emit 只从"激活手势"（click / 原生 button 的 Enter/Space）发出——触发条件集合与今天等价，不新增语义触发。
- **计数守恒**：N sheets → N 个 `[data-testid="rail-sheet-node"]`；M views → M 个 `[data-testid="rail-view-node"]`；与 gating 状态无关（P2-2a 同款断言，换选择器）。
- `views` 为空 → 无 `role="group"`（对应今天 `v-if="views.length"` 藏 views 条）。

## 5. 键盘操作与 ARIA（键盘测试与 2b 同 PR 落地，母锁 §6）

### 5.1 角色

`ul[role="tree"]`（带 `aria-label`）> `li[role="none"]` > `button[role="treeitem"]`；视图层 `ul[role="group"]`。数据表节点：`aria-selected`（=active sheet）+ `aria-expanded`（§5.3）。视图叶子：`aria-selected`（=active view），无 `aria-expanded`。**树外普通按钮**（Tab 可达、方向键不可达、无 treeitem role）："＋ 新建数据表"、个人视图 pill、折叠 toggle。全部保持原生 `<button>`（母锁 §4.5"原生 button / 正确 role"两条都满足）。

### 5.2 键位表（`onTreeKeydown`，绑定在 treeitem 上，处理的键 `preventDefault` 防页面滚动；不 stopPropagation 之外的键——workbench 根 `onGlobalKeydown` 只管 mod+z/y 与 `?`，无冲突）

| 键 | 在数据表节点上 | 在视图叶子上 | emit？ |
|----|--------------|-------------|--------|
| `↓` / `↑` | 焦点移到可见节点序列的下/上一个（序列 = sheet1, …, activeSheet, 其 view1..M, …, sheetN 的扁平顺序） | 同左 | 否 |
| `→` | active（已展开）→ 焦点进第一个视图叶子；非 active → **no-op**（展开=激活=有副作用 emit，方向键不做有副作用的事——对 APG 的克制偏离，理由 §1.3/§4） | no-op | 否 |
| `←` | no-op（折叠是派生态，不能"取消激活"） | 焦点回父数据表节点 | 否 |
| `Home` / `End` | 焦点到第一个/最后一个可见节点 | 同左 | 否 |
| `Enter` / `Space` | 原生 button 激活 → `select-sheet` | 原生激活 → `select-view` | **是** |
| `Tab` | 离开树（roving tabindex ⇒ 树整体一个 tab stop），到 pill/添加行/折叠钮等普通按钮 | 同左 | 否 |

### 5.3 诚实性条款（Opus 审阅重点，防 P2-1b 复发）

- **Roving tabindex**：树内恒且仅一个节点 `tabindex="0"`（初值 = active 视图叶子，无则 active 数据表节点，无则第一个节点；方向键移焦时更新；props 变化后越界则 clamp）。测试断言"恰一个 0"。
- `aria-expanded`：active 且 `views.length>0` → `"true"`；active 且 views 空 → **省略**（无子级不得声称已展开）；非 active → `"false"`（语义 = "可经激活展开"；已知偏离：个别空表激活后无叶子——服务端默认建 grid 视图，实践中非空；文档如实记录该近似）。
- 装饰性 chevron `aria-hidden="true"`。
- 每个声称的 role/aria 属性都有对应键位行为 + 测试；做不到的（自由折叠、typeahead）**不声称**。

### 5.4 i18n（STRICT-ZERO：新字符串只经 typed label 模块）

- 新模块 `apps/web/src/multitable/utils/meta-sheet-view-rail-labels.ts`（照 `meta-base-picker-labels.ts` 版式）：`rail.treeLabel`（en `Tables and views` / zh `数据表与视图`）、`rail.addSheet`（en `New table` / zh `新建数据表`）。
- workbench 折叠钮：`workbench-labels.ts` 加 key `rail.collapse` / `rail.expand`（en `Collapse sidebar`/`Expand sidebar`，zh `折叠侧栏`/`展开侧栏`）。
- 个人视图 pill 的既有 inline label（`isZh ? '个人视图' : 'My view'`）**保持 inline 不迁移**（最小 diff；字符串一字不变，测试断言其渲染文本）。
- **不改任何既有字符串**：base picker 的 `选择多维表` 等 pre-G-10 措辞归 W1 术语映射切片管，2b 一律不碰（防与 W1 撞车）。
- `create-sheet` 的 payload `Sheet N` 是**数据默认名不是 UI 标签**，保持英文原样（行为等价）。

## 6. UF token 映射（母锁 §4.4：无新硬编码 hex、无新 token 词汇）

旧条的 style 块全是硬编码 hex（P2-2a 字节拷贝所致）；2b 重写 CSS 时**全量换 token**，映射表：

| 用途 | 旧 hex | 新 token（均已存在于 `apps/web/src/styles/tokens.css`） |
|------|--------|--------------------------------------------------------|
| rail 背景 | `#fafbfc` | `var(--ms-bg-page)` |
| rail 右边界 / 分隔线 | `#e5e7eb` | `var(--ms-border-light)` |
| 节点文字（主/次/弱） | `#333` / `#666` / `#888` | `var(--ms-text-1)` / `var(--ms-text-2)` / `var(--ms-text-3)` |
| 节点 hover 背景 | `#f0f0f0` / `#eee` | `var(--ms-bg-card)`（rail 底为 bg-page 时）或 MtButton ghost 惯例；active 行 hover 用 `var(--el-color-primary-light-8)` |
| active 节点背景/文字 | `#e8f0fe` / `#409eff` | `var(--el-color-primary-light-9)` / `var(--ms-color-primary)`（EP 旧蓝 #409eff 全数退场） |
| "＋ 新建数据表" 强调色 | `#409eff` | `var(--ms-color-primary)` |
| 个人视图 pill（off 态） | `#fff` / `#d0d5dd` / `#6b7280` | `var(--ms-bg-card)` / `var(--ms-border)` / `var(--ms-color-info)` |
| 个人视图 pill（on 态） | `#ecfdf3` / `#6ce9a6` / `#067647` | `var(--el-color-success-light-9)` / `var(--el-color-success-light-5)` / `var(--el-color-success-dark-2)` |
| focus ring | （无） | `outline: 2px solid var(--ms-color-primary)` + offset，`:focus-visible` |
| 圆角 / 间距 / 行高 / 缩进 | 零散 px | `var(--ms-radius-sm)`、`var(--ms-space-1..5)`（视图层缩进 `var(--ms-space-5)`）、行高参照 `var(--ms-control-height)` |

- 允许的非 token 数值：布局尺寸（rail 宽 240px 展开 / 36px 折叠、truncate 用 max-width 等）——token 词汇里没有宽度族，**不新造 token**（新造 = owner 决策，本设计不需要）。
- 颜色 hex 一律禁止：**token 闸门测试**（§8.2-T6）断言 `MetaSheetViewRail.vue` 全文匹配 `#[0-9a-fA-F]{3,8}\b`（CSS 颜色形态）为 0 处。这是静态属性检查，源码文本断言在此恰当（对象是"文件不含 hex"这一事实本身）。
- 这些换色是**可见变化**（旧 EP 蓝→UF 蓝、灰阶微移），系母锁 §4.4 授权的既定意图，Opus 审阅不应以"视觉变了"为由驳回——驳回口径只看 §4.1-4.3/4.5 行为等价与路径纪律。

## 7. 零权限/数据路径触碰（不变量 + diff 纪律）

**不变量**：2b 是纯呈现 + 导航重排。不新增/修改任何 API 调用、composable、permission 判定、personal-views 写路径、视图加载逻辑。组件仍然只消费 7 props、只发 4 emits。

**实现者的证明义务**（PR body 附）：

1. `git diff --stat` 白名单（超出即违规）：
   - `apps/web/src/multitable/components/MetaSheetViewRail.vue`（重排）
   - `apps/web/src/multitable/views/MultitableWorkbench.vue`（模板搬动 + CSS + `railCollapsed` ref + 折叠钮 label 取词，**script 无其他改动**）
   - `apps/web/src/multitable/utils/meta-sheet-view-rail-labels.ts`（新）、`apps/web/src/multitable/utils/workbench-labels.ts`（加 2 key）
   - `apps/web/src/multitable/index.ts`（删 `MetaViewTabBar` export 一行）
   - 删除：`apps/web/src/multitable/components/MetaViewTabBar.vue`、`apps/web/tests/meta-view-tab-bar-personal-toggle.spec.ts`
   - 测试：`apps/web/tests/meta-sheet-view-rail.spec.ts`（改）、`apps/web/tests/multitable-workbench-view.spec.ts`（折叠用例）
   - CI：`.github/workflows/multitable-web-guard.yml`
2. 新旧 `MetaSheetViewRail.vue` 的 `defineProps` / `defineEmits` / `onAddSheet` / `VIEW_TYPE_ICON`+`viewTypeIcon` 四块 **diff 为空**（逐块对照贴 PR）。
3. `rg "fetch|client\.|api\.|axios|usePersonalView|permission" apps/web/src/multitable/components/MetaSheetViewRail.vue` 的命中集合与 P2-2a 版一致（即：无新增）。
4. workbench 的 11 个绑定（7 props + 4 handlers）与 MetaBasePicker 的 6 个绑定逐字未变（diff 只显示行移动）。

## 8. 冻结基线退役 + 测试计划

### 8.1 退役清单（P2-2a 明文约定：基线"retires at P2-2b"）

字节等价在 2b 后不再成立（视觉重排），基线失效，**整链退役**：

| 动作 | 对象 |
|------|------|
| 删文件 | `apps/web/src/multitable/components/MetaViewTabBar.vue` |
| 删文件 | `apps/web/tests/meta-view-tab-bar-personal-toggle.spec.ts`（断言先吸收，见 T4） |
| 删 export | `apps/web/src/multitable/index.ts` ~L29（先 `rg -w "MetaViewTabBar"` 全仓确认无残余 import） |
| 删 spec 块 | `meta-sheet-view-rail.spec.ts` 的 "DOM-snapshot equivalence" describe + `normalizeScopeHash` + `MetaViewTabBar` import |
| CI 清理 | `multitable-web-guard.yml`：两处 path-filter 里 `meta-view-tab-bar-personal-toggle.spec.ts`（~L243/~L580）与两处基线注释（~L79-80/~L416-417）删除；run 列表（~L766）删 token `meta-view-tab-bar-personal-toggle` |
| 注释更新 | `MetaSheetViewRail.vue` 头注释重写（不再描述"字节等价于 MetaViewTabBar"） |

**替代安全网** = 行为等价测试（4 emits / gating / 计数守恒——在视觉重排下继续成立的那部分契约）+ 新增键盘/ARIA 测试 + token 闸门。字节等价的使命（保 P2-2a 抽取无损）已完成，不续命。

### 8.2 测试计划（全部随 2b 同 PR）

`meta-sheet-view-rail.spec.ts` 重写（保持 P2-2a 的纪律：结构化选择器/testid、查到即断言非空、emit 逐个断言"只发这一个"）：

- **T1 四 emit 等价**：4 个用例逐 emit（payload 精确断言：`'s2'` / `'v2'` / `'Sheet 3'` / `'v1'`），选择器换 `rail-sheet-node` / `rail-view-node` / `rail-add-sheet` / `personal-view-toggle`。
- **T2 gating**：`canCreateSheet` false/absent → 无 add 行；G-FE-4 `personalViewsEnabled` absent/false → 零 pill；pill 只随 active 视图叶子；active 切换 pill 跟随。
- **T3 计数守恒**：N/M 精确计数 × gating 双态；3-sheets/1-view 缩放例；`views:[]` → 无 group 无叶子。
- **T4 吸收退役 spec 的断言**（逐条搬进，一条不丢）：pill `aria-pressed` on/off + `--on` 类（新类名）；点击 emit `toggle-personal('v1')`；label en `My view` / zh `个人视图`（`useLocale().setLocale` 双语，afterEach 复位）。
- **T5 键盘/ARIA**（母锁 §6 要求随 2b 落）：`role="tree"`/`treeitem`/`group` 结构；`aria-selected` 双层；`aria-expanded` 三态（true/省略/false，§5.3）；roving tabindex "恰一个 0"；`↓↑` 移焦（断言 `document.activeElement`）；`→` 三分支（active 进子级 / 非 active no-op 且 **0 emit** / 叶子 no-op）；`←` 叶子回父；`Home`/`End`；方向键全程 **0 emit**（vi.fn 全量断言）。
- **T6 token 闸门**：读组件源文件，断言颜色 hex 出现次数 = 0（§6）。
- **T7 折叠**（`multitable-workbench-view.spec.ts`，rail 已 mock，加用例）：默认展开；点 `rail-collapse-toggle` → rail stub 与 base-bar `display:none`、`aria-expanded="false"`；再点还原（计数守恒经 round-trip 后由 T3 保障——T7 断言 stub 重新可见即可）。
- **新字符串双语**：T5 的 `aria-label` 与 add 行文本在 zh/en 各断言一次（label 模块生效证明）。

### 8.3 CI 两点接线（skip-shaped green 防线）

`multitable-web-guard.yml` 三处核对：
1. run 列表（~L766）：`meta-sheet-view-rail` token 已在（重写后文件名不变，继续命中）；删 `meta-view-tab-bar-personal-toggle`。
2. **两处** path-filter（~L81-82 与 ~L418-419 所在的两个列表）：已有 `MetaSheetViewRail.vue` + `meta-sheet-view-rail.spec.ts`；**新增** `apps/web/src/multitable/utils/meta-sheet-view-rail-labels.ts`；确认 `MultitableWorkbench.vue` 与 `multitable-workbench-view.spec.ts` 已在列表（应已在，逐处核对）。
3. 本地实跑：`pnpm --filter @metasheet/web exec vitest run meta-sheet-view-rail multitable-workbench-view` 贴结果；对 T1 任一 emit 转发与 T5 roving 逻辑各做一次 mutation 自检（先 commit 再 mutate，红→还原）。

### 8.4 响应式 = 明确不做

窄屏抽屉/图标条/断点行为 = **P2-2c**（母锁 §5 独立门）。2b 不加任何视口 media query（print 除外）。窄屏下 rail 暂占 240px 属已知过渡态。

## 9. Sonnet 实现切序（建议）

1. 新 labels 模块 + workbench-labels 两 key。
2. `MetaSheetViewRail.vue` 内部重排（§2.2 蓝本，冻结四块逐字搬）。
3. workbench aside 组合 + 折叠（§2.1/§3.1）。
4. spec 重写（T1-T6）+ workbench T7。
5. 退役链（§8.1 清单逐项）+ CI 三处（§8.3）。
6. §7 证明义务产出 + 本地实跑 + mutation 自检 → PR（**不合并**，等 Opus 对抗审阅——母锁 §4.6 硬前置）。

## 10. Owner 决策（PENDING——实现不得预设，按推荐默认执行）

| # | 决策 | 推荐默认（2b 按此执行） |
|---|------|------------------------|
| **A** | **折叠态跨会话持久化**：是否把 `railCollapsed` 写 localStorage（有既成模式：`base-local-state.ts` 的 `metasheet:multitable:*:v1` key 族可循）？ | **不持久**（session-local ref，默认展开）。若 owner opt-in，作为独立小 PR 循 `base-local-state.ts` 模式加 key `metasheet:multitable:rail-collapsed:v1`——新存储面，须显式授权。 |
| **B** | **"＋ 新建视图"树内入口**：母锁 §3 目标形状提了它，但它需要第 5 个 emit，与 §4.1 硬约束（4 emits 不新增）直接冲突——硬约束赢，2b 不做。是否立独立后续切片（新 emit + consumer 接线 + 测试）？ | **defer 到 2c 之后**；视图创建现由视图管理器承担，无功能缺口。立项时它是 emit 契约变更，需自己的小设计（非本锁行为等价范畴）。 |

（默认展开/不做图标条/术语边界等其余取舍均为设计决定，非 owner 决策，理由已随文给出。）

## 11. Opus 对抗审阅要点（前置门，随 PR 附上本节自查）

1. 4 emits 逐一：名/payload/触发条件（含两道 gate）与 `78caa7906` 版逐字等价？冻结四块 diff 为空？
2. 方向键是否真的 0 emit（refute：构造 `→` 在非 active 节点上）？
3. roving tabindex 不变量在 props 突变（sheets 缩短、activeViewId 失效）下是否 clamp？
4. §7 diff 白名单有无越界；workbench script 是否只有 ref+label？
5. 退役是否完整（rg 无 `MetaViewTabBar`/`meta-tab-bar__` 残余）且 G-FE-4/aria-pressed/双语断言无一丢失（对照 §8.2-T4 清单）？
6. CI 三处接线真实生效（path-filter 触发路径推演 + run token 命中文件名）？
7. token 闸门是否可被"hex 写进 :style 内联"绕过（refute：闸门匹配全文而非仅 style 块）？
