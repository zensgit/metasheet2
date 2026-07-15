# 多维表 W2 · 统一右侧记录检查器（unified right-side record inspector）· 设计锁

- **Status**: **PROPOSED — 未 ratify。** 本文是 Fable 设计交付物，零裁决。所有仍需 owner 拍板的项在 §6 明列（OD-W2-1..8）。**红线**：一切设计锁**由 owner ratify**，本文不自裁、不自 ratify；实现授权在 owner ratify 之后按 §7 切片单独给。
- **类型**：设计锁 / docs-only，**零 runtime**。不新增/修改任何组件、composable、client、路由、权限判定、CSS。
- **母线**：`multitable-unified-roadmap-W0-W5-20260713.md`（#4211，owner 定线）§1/§9 的 **W2 记录工作区**：「围绕一条业务记录完成工作 = T5 + 统一右侧检查器 + PIT Revert UI」。owner 执行顺序（§2）授权 W2 在 **P2-2a/b/c 之后**开工。
- **基线**：`origin/main` @ `6a10d08c7`（含 T5-safe #4223、comment-affordance token 锁 RATIFIED、P2-2a `MetaSheetViewRail` 抽出、H4-2 焦点环 #4281）。
- **术语（G-10 词典，roadmap §6-n 已 ratify）**：产品名=**多维表**；Base=**工作区**、Sheet=**数据表**、View=**视图**、Record=**记录**。**代码/props/API/路由一律保留 `baseId`/`sheetId`/`recordId` 不动**——本文所有 UI 文案走展示层，底层契约零改名（roadmap §3 不变量 1）。
- **同源锁（引用，不在本文重议）**：T5 决策 brief（`multitable-ui-p2-1c-t5-recorddrawer-decision-brief-20260712.md`，OD-T5a/b/c 已裁）；comment-affordance token 锁（`multitable-comment-affordance-token-design-lock-20260713.md`，RATIFIED）；W0-1 HISTORY_INCOMPLETE 锁（`multitable-global-history-w0-1-history-incomplete-contiguity-trusted-since-design-lock-20260713.md`）；D-1c form-submit revision 锁；P2-2 左栏母锁 + P2-2b 垂直树设计（`multitable-ui-p2-2b-vertical-tree-design-20260713.md`，响应式归 **P2-2c**）。

---

## §0 一句话

今天「一条记录」的工作面**碎成三块彼此争抢右边缘的表面**：`MetaRecordDrawer`（360px 右抽屉，内含 details/history 两个 tab）、`MetaCommentsDrawer`（**另一个** 446 行的右抽屉，与前者可同时打开）、`MetaRecordPermissionManager`（735 行模态框）。W2 = 把它们收敛成**一个右侧检查器壳 `MetaRecordInspector`**，以 tab（或分区）承载 **字段 / 动态(历史) / 评论 / 附件** 四个平级面板；**抽取-复用**既有组件（P2-2a 式），**零新数据路径**——检查器只做组合，不新增任何 fetch/route/权限判定。审批工作台与自动化编辑器**不进检查器**（§1 非目标）。

---

## §1 范围与非目标（"统一"的确切含义）

### §1.1 范围（IN）

- **一个右侧检查器壳** `MetaRecordInspector.vue`，承载四个平级面板：
  1. **字段**（详情编辑）= 今天 `MetaRecordDrawer` 的 `details` tab 主体。
  2. **动态/历史**（activity）= 今天 drawer 的 `history` tab 主体（记录级 revision 时间线 + 逐字段 diff + 逐字段恢复选择）。
  3. **评论** = 今天独立的 `MetaCommentsDrawer` 主体（收编，不再是第二个右抽屉）。
  4. **附件** = 记录上所有 attachment 字段值的**聚合视图**（组合既有的 `attachmentSummariesByField`，非新数据路径）。
- **收编第二个右抽屉**：`showComments` 开出的 `MetaCommentsDrawer` 折进检查器的评论面板；右边缘从此只有一个检查器。
- **PIT Revert UI 的接入点**（记录级）：把 history 面板里现在走**直接** `restoreRecordVersion` 的恢复动作，迁到**预览优先**流（`restorePreviewRecord`/`restoreExecuteRecord`），以便 W0-1 的 `HISTORY_INCOMPLETE` 在写之前就能显示（§4）。**是否内嵌于 history 面板 = OD-W2-4**。
- **术语落地**：检查器所有可见文案 = 记录/工作区/数据表/视图（G-10）。

### §1.2 非目标（OUT，逐条声明防 scope creep）

- **审批工作台 / 审批投影面板**——**多维表 web 侧今天不存在任何记录级审批读投影组件**（`grep approval` 全落在 automation 文件：`MetaAutomationManager`/`MetaAutomationRuleEditor`/`automationSaveBlockReasons` 等）。新建一个审批面板 = **新数据路径**，与 §5 硬不变量冲突。故审批**不进检查器**；`open-automation` 按钮保持为**检查器头部的启动入口**（点开既有自动化表面），不是面板。审批投影若将来要进，须先有它自己的**读投影契约**（另立设计锁），本文不预设。
- **自动化编辑器**——同上，保持头部启动入口。
- **权限管理器改造**——`MetaRecordPermissionManager` 保持为**头部按钮开出的模态**；**不**把权限编辑塞成检查器面板（权限是管理员高级动作，roadmap §3 不变量 2：高级配置只在管理员设置面出现）。本文只承诺权限入口**继续存在**于检查器头部。
- **sheet 级 PIT Reset / Undelete**（破坏性、`MULTITABLE_ENABLE_PIT_RESET` gated）——**不进**记录检查器；那是 sheet 级危险动作，归 W5 逐 flag smoke。检查器只做**记录级** revert。
- **响应式窄屏行为的实现**——归 **P2-2c**（P2-2 母锁 §5 独立门；P2-2b §8.4 明文）。本文只**协同定义**左右两栏在窄屏的对称契约（§3.4），实现切片与 P2-2c 同门。
- **grid 内联编辑 / 看板 / 表单等其它记录表面**——不动；检查器是 grid 行选中后的右侧面。
- **新术语字符串以外的既有措辞改写**——归 W1 术语映射切片，本文不碰。

---

## §2 信息架构：面板清单 · 复用 vs 重排（逐组件点名）

> 纪律：优先 **抽取-复用**（P2-2a 抽 `MetaSheetViewRail` 的同款手法——字节/行为等价搬出，安全网是既有 spec 继续绿），而非重写。下表点名每个面板的**来源组件**与**处置**。

| 面板 | 来源（origin/main `6a10d08c7`） | 处置 | 数据来源（既有，零新增） |
|---|---|---|---|
| **壳** `MetaRecordInspector.vue`（**新**） | `MetaRecordDrawer` 的 tablist + `activeTab` 逻辑（L44-61）+ header actions（L10-41）+ lock banner（L63-74） | **新建壳**：承接 tab 切换、头部动作、lock banner；把两个面板主体**下放**为子组件；收编 `showComments` 分支 | 无（纯组合层） |
| **字段面板** `MetaRecordFieldsPanel.vue`（抽取） | `MetaRecordDrawer` 的 `details` 分支主体（L75-312：`visibleFields` 循环 + 全字段编辑器 + per-field AI shortcut + per-field comment anchor） | **抽取**（行为等价搬出，冻结基线：抽出前后既有 drawer spec 逐条绿） | `props.record` / `fields` / `fieldPermissions` / `attachmentSummariesByField` 等**现有 props**；`emit('patch'|'ai-*'|'comment-field'|'open-*-picker'|'run-button')` 原样上抛 |
| **动态/历史面板** `MetaRecordHistoryPanel.vue`（抽取） | `MetaRecordDrawer` 的 `history` 分支主体（L313-368：`loadRecordHistory` + `historyFieldDiffs` + 逐字段恢复选择 + restore 按钮）| **抽取**；恢复动作按 OD-W2-4 迁预览优先流 | `apiClient.listRecordHistory(sheetId, recordId)` → `MetaRecordRevision[]`（服务端已 field-mask，§4） |
| **评论面板** `MetaCommentsPanel.vue`（抽取） | `MetaCommentsDrawer.vue` 的 **body**（thread 列表 + composer + reactions + presence；L15+，不含它自己的 `__header` 抽屉外壳与 close 钮） | **抽取 body**；`MetaCommentsDrawer` 的 inbox `RouterLink`（→ `multitable-comment-inbox` 路由）**上移**到检查器头部；`MetaCommentsDrawer` 退成薄壳或退役（**OD-W2-7**） | `commentsState.*`（既有 `useMultitableComments` 等）+ `selectedRecordCommentsScope`（既有，服务端 G-8 gated） |
| **附件面板** `MetaRecordAttachmentsPanel.vue`（**新**，纯组合） | 无单独来源——今天附件**只在 attachment 字段内联**（`MetaAttachmentList`，drawer L233-262） | **新建**：遍历记录的 attachment 字段，聚合渲染。**复用** `MetaAttachmentList` 展示 + 既有 `uploadFn`/`deleteAttachmentFn` | `props.attachmentSummariesByField`（**已传入 drawer**，见 workbench L330）——**零新 fetch**；下载 URL 走既有 F2 gated 签发 |

**为什么壳是新建而非改 drawer**：今天 `MetaRecordDrawer` 同时是「壳 + 字段面板 + 历史面板」三合一的 1163 行组件。把壳单拎出来后，(a) 评论/附件面板能作平级 sibling 挂进去（今天它们进不去——评论是另一个抽屉、附件散在字段里）；(b) 字段/历史面板成为可独立测试的纯呈现单元；(c) `activeTab` 从二值扩为四值由壳统一管，ARIA tab pattern 一处补全（§3.3）。

**复用的边界（诚实）**：字段面板与历史面板是**行为等价抽取**（既有 spec 是安全网）；评论面板是**body 抽取 + 外壳换新**（抽屉 chrome 换成 tabpanel chrome，thread/composer/reactions 逐字保留）；附件面板是**唯一真·新建**，但它消费的数据（`attachmentSummariesByField`）已在 drawer props 里，故仍**零新数据路径**。

---

## §3 交互契约

### §3.1 打开 / 关闭 / pin

- **打开**：与今天一致——grid 行选中 `onSelectRecord` → `selectedRecordId` 置位 → 检查器 `visible="!!selectedRecordId"`；或深链 `resolveDeepLink(recordId, opts)`（§3.2）。
- **关闭**：头部 close 钮 → `emit('close')` → `onCloseDrawer`（清 `selectedRecordId`）。Esc 关闭沿用 workbench 根 `onGlobalKeydown`（不与 tab 键位冲突，见 §3.3）。
- **pin / 版式**：今天 drawer 已是**持久侧面板**（在 `.mt-workbench__content` 的 flex row 内与 grid 并列，grid 保持可交互——非模态遮罩）。检查器沿用此「push（grid 让位）」语义。**wide 屏是 push 还是 overlay = OD-W2-3**；「是否提供固定/浮动切换钮」并入该 OD。

### §3.2 深链（多维表既有机制，E3-等价）

- 多维表**已有 URL 深链**：`router/multitableRoute.ts` 读 `route.query.recordId` 与 `route.query.commentId` → workbench `resolveDeepLink(recordId, { openComments, highlightCommentId, targetFieldId })`（workbench L3873）。`commentId` 已能深链到评论 + 高亮（`highlightedCommentId`）。这是多维表版的 E3 通知深链等价物。
- **提案（本文只提，不实现）**：新增可选 `route.query.panel ∈ {fields|activity|comments|attachments}`，深链直达某面板。`commentId` 存在时**隐含** `panel=comments`（保持今天行为）。深链缺省 panel = OD-W2-2 的缺省面板。
- 深链契约**不改权限**：`resolveDeepLink` 走 `client.getRecord`（既有 gated），命中即渲染、无权即 `getRecord` 自身 403/404——检查器不新增可见性判断。

### §3.3 键盘 / ARIA（tab pattern 补全，随壳切片同 PR 落地）

- 今天 drawer 的 tablist 有 `role="tablist"`/`role="tab"`/`aria-selected`，但**缺** `aria-controls` / `role="tabpanel"` / 方向键——ARIA tab pattern 不完整。检查器壳**补全**（照 P2-2b 给树补 roving tabindex 的同款诚实性纪律）：
  - `ul[role="tablist"]` > `button[role="tab"]`，每个 tab `aria-controls` 指向其 `[role="tabpanel"]`；panel `aria-labelledby` 回指 tab。
  - **Roving tabindex**：tablist 内恒且仅一个 tab `tabindex="0"`（= active tab），其余 `-1`；`←/→`（或 `↑/↓`，二选一，APG 允许水平 tablist 用 `←/→`）移焦 + 激活；`Home/End` 跳首尾。测试断言"恰一个 0"。
  - **不声称做不到的**：不做 tab 拖拽重排、不做 typeahead。声称的每个 role/aria 都有对应键位 + 测试（P2-2b §5.3 诚实性条款同款）。
- **面板内焦点**：切 tab 后焦点进入激活的 tabpanel（或其首个可聚焦控件），Esc 从 panel 回到关闭/grid（不吞 workbench 的 mod+z/y 与 `?`）。
- **焦点环**：走 `:focus-visible` + UF token（`--ms-color-primary`），与 H4-2（#4281）的一致焦点环约定同源；**真浏览器验**（§8）。

### §3.4 响应式与 P2-2c（左栏）的对称契约

- **归属**：窄屏行为的**实现**属 P2-2c（P2-2 母锁 §5 独立门）。本文**只协同定义契约**，供 P2-2c 一并落地（§7 Slice 7 与 P2-2c 同门）。
- **对称原则**：roadmap W1 完成标准 = **1024px 无溢出**。左栏（P2-2c）在窄屏折叠为 overlay/图标条；右侧检查器须**对称**：**≤ 1024px 时左右两栏均从 push 退化为 overlay 抽屉**（各自覆盖在 grid 上、不再挤占 grid 宽度），保证 grid 主体在窄屏保留可用最小宽度、`body` 永不横向滚动。**两栏是否可同屏共存 overlay、还是互斥（打开一个自动收另一个）= OD-W2-6**。
- 本文**不加**任何 media query（P2-2c 落）；只把「右栏窄屏 = overlay、与左栏对称」钉为设计意图。

---

## §4 历史面板细节

### §4.1 消费的 API（既有，零新增）

- `GET /api/multitable/sheets/:sheetId/records/:recordId/history` via `apiClient.listRecordHistory(sheetId, recordId, { limit })` → `MetaRecordRevision[]`。
- **服务端已做全部安全过滤**（`univer-meta.ts` L8388-8465，逐行核验）：`resolveSheetReadableCapabilities.canRead` 门 → 行级 deny（`deriveRecordPermissions().canRead`）→ **字段掩码链**（`loadAllowedFieldIds` / reveal 时 `loadRevealedFieldIds` + `maskStoredRecordFieldIds` 公式 taint-drop chokepoint）→ `redactRecordRevisionEntry(item, allowedFieldIds)` 逐条掩 `patch`/`snapshot`/`changedFieldIds`。
- **前端是忠实客户端**：`historyFieldDiffs`（drawer L791-810）只遍历**已掩码的** `changedFieldIds`、只读**已掩码的** `patch`/`snapshot`——**leak-safe by construction**（drawer L783-789 的注释即此保证）。检查器抽取历史面板时**这条不变量原样保留**：面板**不得**改为遍历 `snapshot` 原始 keys 或旁路 `changedFieldIds`（那会造出掩码旁路）。

### §4.2 `HISTORY_INCOMPLETE` 与 restore markers 的呈现

- **实证核验**：记录历史**读**路由**不返回** completeness 标记——`HISTORY_INCOMPLETE` 是 **restore preview/execute（写路径）的预检**（`history-integrity-precheck.ts` + W0-1 锁）。故：
  - **历史时间线（读）** = 纯掩码读，无 incomplete 横幅。
  - **恢复/PIT Revert（写）** = `HISTORY_INCOMPLETE` 在**预览步**显示；execute = **零写入 fail-closed**（W0-1 owner 裁定）。
- **落地要求**：检查器的恢复动作**必须走预览优先流**（`restorePreviewRecord` → 显示预览含 incomplete 标注 → `restoreExecuteRecord`），**替换**今天 drawer 的**直接** `restoreRecordVersion`（L780，无预览）。既有 `RestorePreviewDialog`（workbench L417）是现成的预览 UI 承接点。**恢复是否内嵌 history 面板 vs 独立对话 = OD-W2-4**；无论哪个，**预览优先 + execute 零写入**是硬前置，不是 OD。
- **restore markers**：既有逐字段 before→after diff（`--history-diff-*`）+ 逐字段恢复勾选（`history-field-select`）+ 恢复按钮（`record-history-restore`）**原样保留**。恢复回链 `restored_from_version`（R11）见 §4.3。

### §4.3 `restored_from_version` 回链（R11）——已知 gap，列 OD

- **实证核验**：R11 回链字段 `restoredFromVersion` 今天在**base 级** `HistoryChange` 类型（`types.ts` L389-391，`HistoryCenterModal` 渲染 badge），**不在**记录抽屉的 `MetaRecordRevision` 类型（L353-368）。故记录检查器 history 面板**当前无法**渲染 R11 恢复 badge。
- **处置 = OD-W2-5**：(a) 给记录历史读 API + `MetaRecordRevision` 加 `restoredFromVersion`（小数据形改，与 base 中心口径一致，badge 就地渲染）；或 (b) history 面板对 `source='restore'` 条目**链出**到 base History Center。本文**不选**。

### §4.4 字段掩码 goldens（面板不得造掩码旁路）

历史面板抽取后仍受这些 real-DB golden 钉（§5/§8 复用）：
- `multitable-record-history-field-mask.test.ts`（记录历史逐条掩码）
- `multitable-history-audit-reveal-realdb.test.ts`（reveal audit-before-disclosure）
- `multitable-history-incomplete-precheck-realdb.test.ts`（恢复预检零写入）
- 变异证明（§8）：把面板 diff 逻辑改成读原始 `snapshot` keys → 上列 mask golden 必红。

---

## §5 权限模型（硬不变量 + 每面板 golden 钉）

**硬不变量（HI-1）**：**检查器新增 0 条数据路径。** 它只是**重新宿主**已经消费 gated 路由的组件——每个面板背后的读门与今天逐字相同。检查器壳/面板里**不得**出现任何今天没有的 `client.` / `fetch(` / `api.` 调用（diff 纪律 §7、变异证明 §8）。

| 面板 | 既有读门（服务端） | 前端镜像 | 钉住的 golden |
|---|---|---|---|
| **字段** | `records:read` + 字段掩码 + 行级 deny | `visibleFields = fields.filter(fieldPermissions[id].visible !== false)`（drawer L558，镜像服务端 visible 掩码）；`canEditField` 镜像 readOnly/system/rowActions | `multitable-records-read-field-mask.test.ts`；`multitable-records-list-authz.test.ts` |
| **历史** | 同一路由的 canRead + 行 deny + 字段掩码链（§4.1） | 忠实客户端，仅渲染已掩码条目 | `multitable-record-history-field-mask.test.ts`；`multitable-history-audit-reveal-realdb.test.ts` |
| **评论** | **G-8 sheet-visibility**（评论按数据表可见性 gated）+ `canComment` | `resolvedCanComment = rowActions.canComment`；scope 走 `selectedRecordCommentsScope`（服务端 gated） | `multitable-permmatrix-b4-g8-comments-visibility-realdb.test.ts` |
| **附件** | **F2 attachment read-gate**（下载 URL 签发按读权限） | 复用 `attachmentSummariesByField`（record fetch 时已 gated）+ 既有 gated 下载 URL；无独立附件列举 fetch | `multitable-attachment-readgate.security.test.ts` |
| **恢复(PIT Revert)** | restore preview/execute 重查行 deny + 字段门 + version + `HISTORY_INCOMPLETE` 预检 | 预览优先，execute 前必显预览 | `multitable-record-restore.test.ts`；`multitable-history-incomplete-precheck-realdb.test.ts` |

- **audit-before-disclosure**：历史 reveal（`?reveal=1&reason=`）只解字段掩码、**不解**行 deny（LOCK-4，`univer-meta.ts` L8430 注释）——检查器抽取后此语义不变，reveal 入口若上检查器须带 reason（L8-required）。
- **权限编辑器**：`MetaRecordPermissionManager` 保持模态，其自身的 real-DB 权限 golden 不受本文影响（本文不动它）。

---

## §6 owner 决策台账（OD-W2-1..8）——**均未裁**；下表选项非决定，各附推荐，owner 拍板

| # | 决策 | 选项 | 推荐（待 owner 确认，非决定） |
|---|---|---|---|
| **OD-W2-1** | 面板承载：**tab 还是 accordion(分区)** | (a) 横向 tab（沿用今天 details/history 二 tab 的心智）· (b) 纵向分区可折叠（字段常驻、动态/评论/附件折叠） | **(a) tab**——四面板中「字段」与「历史+评论+附件」高度差极大，accordion 会导致长滚动与焦点跳动；tab 复用既有 tablist 与既有 spec。 |
| **OD-W2-2** | **缺省面板**（打开检查器时选中哪个） | (a) 恒 字段 · (b) 记住上次 · (c) 上下文驱动（`commentId` 深链→评论，否则字段） | **(c)**：`commentId` 存在→评论（=今天行为）；否则字段。不引入跨会话「记住上次」存储（那是新存储面 = owner 决策）。 |
| **OD-W2-3** | **wide 屏版式**：push 还是 overlay | (a) push（grid 让位，=今天 flex 行为）· (b) overlay（浮于 grid 上）· (c) 提供 pin 切换钮 | **(a) push**——最小 diff、与今天一致；pin 切换（c）留作 W2 之后 polish，不在首刀。 |
| **OD-W2-4** | **PIT Revert UI 位置**：史面板内嵌 vs 独立 | (a) 内嵌 history 面板（就地预览优先恢复，复用 `RestorePreviewDialog`）· (b) 独立恢复表面（history 面板只读、恢复另开） | **(a) 内嵌**——「围绕一条记录闭环」正是 roadmap W2 目标；sheet 级破坏性 Reset 仍 OUT（§1.2）。**注**：无论 a/b，「预览优先 + execute 零写入」是硬前置非 OD（§4.2）。 |
| **OD-W2-5** | **R11 `restored_from_version` 回链**呈现 | (a) 扩记录历史 API+`MetaRecordRevision` 加 `restoredFromVersion`，就地 badge · (b) `source='restore'` 条目链出 base History Center · (c) 首刀不做回链 | **(a)**——与 base 中心口径一致、就地可读；是小数据形改（服务端 + 类型 + 渲染），单独小刀，非 W2 首刀阻塞。 |
| **OD-W2-6** | **窄屏左右两栏关系**（与 P2-2c 协同） | (a) 两栏 overlay 可同屏共存 · (b) 互斥（开右收左）· (c) 全交给 P2-2c 定 | **(a) 可共存但都 overlay**（≤1024px），保证 grid 最小宽度与零横向滚动；最终与 P2-2c 同门实现、届时复核。 |
| **OD-W2-7** | `MetaCommentsDrawer` 抽 body 后的**去留** | (a) 退役（仅 inspector 面板消费）· (b) 保留为薄壳（若有非 inspector 调用方）· (c) 保留原样 + 面板复用其 body 组件 | **(b/c) 取决于调用方核查**——实现首查 `MetaCommentsDrawer` 是否仅被 workbench 一处消费；若是则退役（P2-2b 退役 `MetaViewTabBar` 同款清链），否则薄壳保留。 |
| **OD-W2-8** | **审批投影是否进检查器** | (a) 不进（非目标，本文默认）· (b) 待审批读投影契约就绪后另立面板 | **(a) 不进**——今天无审批读投影组件，进 = 新数据路径违反 HI-1；`open-automation`/审批入口保持头部启动钮。 |

> 其余取舍（术语走 G-10、附件面板复用 `MetaAttachmentList`、权限保持模态、sheet 级 Reset OUT）为设计决定非 owner 决策，理由已随文给出。

---

## §7 切片计划（PR 级独立切片 + 逐刀验证）

> 量级：W2 roadmap §9 = 6–10 PR。本清单 **7 刀**（含 1 刀与 P2-2c 同门），落在区间内。每刀独立可合、独立可回滚。**抽取刀走冻结基线纪律**（P2-2a 同款：抽出前后既有 spec 逐条绿 = 安全网）。

| 刀 | 内容 | 前置 | 逐刀验证 | 量级 |
|---|---|---|---|---|
| **S1** | 抽 `MetaRecordFieldsPanel`（drawer `details` 主体行为等价搬出） | ratify | 既有 `multitable-record-drawer.spec.ts`/`-button`/`-duplicate`/`-t5-migration` 逐条绿；字段编辑器/AI/comment-anchor emit 逐一等价 | 1 PR |
| **S2** | 抽 `MetaRecordHistoryPanel`（drawer `history` 主体搬出，恢复暂留直接流） | S1 | 既有 `meta-record-drawer-history-diff.spec.ts` / `meta-record-drawer-restore.spec.ts` 绿；掩码不变量保留 | 1 PR |
| **S3** | 新建 `MetaRecordInspector` 壳：承接 tablist（补全 ARIA tab pattern §3.3）+ 头部动作 + lock banner；挂 S1/S2 两面板；drawer 退成壳的调用者或退役 | S1,S2 | 新 `multitable-record-inspector.spec.ts`（tab 切换 / roving tabindex 恰一个 0 / aria-controls↔tabpanel / 面板计数守恒）；键盘用例 | 1 PR |
| **S4** | 抽 `MetaCommentsPanel`（`MetaCommentsDrawer` body 抽出），挂第 3 tab；收编 `showComments` 分支（右边缘只剩一个面）；inbox link 上移头部；按 OD-W2-7 处置旧抽屉 | S3 | 既有 `multitable-comments-drawer.spec.ts` / `multitable-comment-*` 断言吸收无丢；「无双抽屉」用例；G-8 前端镜像不变 | 1 PR |
| **S5** | 新建 `MetaRecordAttachmentsPanel`（聚合 `attachmentSummariesByField`，复用 `MetaAttachmentList`），挂第 4 tab | S3 | 新附件面板 spec（聚合计数 / 空态 / 上传删除走既有 fn）；F2 parity（§8） | 1 PR |
| **S6** | **PIT Revert UI**：history 面板恢复迁**预览优先流**（`restorePreviewRecord`/`restoreExecuteRecord` + `RestorePreviewDialog`）；`HISTORY_INCOMPLETE` 预览标注；execute 零写入（按 OD-W2-4 定位） | S2,S3 | `multitable-record-restore.test.ts` + `multitable-history-incomplete-precheck-realdb.test.ts` 绿；前端预览优先用例（无预览不得 execute） | 1 PR |
| **S7** | **响应式对称**（与 **P2-2c 同门**）：≤1024px 左右两栏 overlay 化、grid 最小宽、零横向滚动（§3.4/OD-W2-6） | P2-2c | 真浏览器（§8，`multitable-browser-verify.yml`）：1024px 无溢出、overlay 切换、焦点环 | 1 PR |

- **OD-W2-5**（R11 回链）若 owner 选 (a) = 一把独立小刀（服务端 + 类型 + 渲染），排 S2 之后、不阻塞主链。
- CI 接线（每刀）：`multitable-web-guard.yml` 的 path-filter（两处列表）+ run 列表须含新组件与新 spec 文件名（skip-shaped-green 防线，P2-2b §8.3 同款三处核对）。

---

## §8 验证计划

### §8.1 权限 parity goldens（每面板 vs 裸路由，real-DB）

复用 §5 表的 6 个 real-DB golden 作**每面板 parity 门**：检查器渲染的可见集合**恒等于**对应裸路由返回的可见集合——因为检查器不新增数据路径，parity 是**结构性成立**，goldens 是它的证据而非新逻辑。
- 字段：`multitable-records-read-field-mask.test.ts` + `multitable-records-list-authz.test.ts`
- 历史：`multitable-record-history-field-mask.test.ts` + `multitable-history-audit-reveal-realdb.test.ts`
- 评论：`multitable-permmatrix-b4-g8-comments-visibility-realdb.test.ts`
- 附件：`multitable-attachment-readgate.security.test.ts`
- 恢复：`multitable-record-restore.test.ts` + `multitable-history-incomplete-precheck-realdb.test.ts`

### §8.2 前端组件测试（vitest / jsdom）

- 抽取刀（S1/S2/S4）：**既有 spec 是安全网**——抽出前后逐条绿，emit/payload/gating 逐一等价（P2-2a 纪律）。
- 壳刀（S3）：新 `multitable-record-inspector.spec.ts`——tab 切换、roving tabindex「恰一个 0」、`aria-controls`↔`role="tabpanel"` 对偶、面板计数守恒、深链 `panel=` 选中、Esc 关闭。
- 附件刀（S5）：聚合计数（N attachment 字段 → N 分组）、空态、上传/删除走既有 fn（无新 fetch）。

### §8.3 真浏览器 CSS 验证（**jsdom 不算**）

走 `multitable-browser-verify.yml`（Playwright，既有）——CSS/focus-visible/响应式**只在真浏览器成立**（feedback：CSS 要在真浏览器验）：
- tab 焦点环（`:focus-visible` + `--ms-color-primary`）：`getComputedStyle` 读实际值。
- comment-active token 三元组在评论 affordance 上取值正确（`--ms-color-comment-active-*`）。
- 响应式（S7）：1024px `body` 无横向滚动、overlay 切换、grid 保持最小宽。
- **正控腿**（必配，否则观测坏了空转变绿）：移除焦点环规则 → 值回落 UA 默认（auto/1px/近黑），断言"变了"；移除 overlay media query → 断言窄屏溢出复现。

### §8.4 变异证明（关键守卫，先证变异落地再判）

- **掩码旁路**：把历史面板 diff 改为遍历原始 `snapshot` keys（旁路 `changedFieldIds`）→ `multitable-record-history-field-mask.test.ts` **必红**（否则掩码门空转）。
- **数据路径新增（HI-1）**：在任一面板注入一条今天没有的 `client.` 读调用绕过既有 gate → 对应 parity golden **必红**。
- **预览优先（S6）**：删恢复的预览步、直接 execute → `multitable-history-incomplete-precheck-realdb.test.ts` **必红**（不可信历史上零写入被破坏）。
- 每条变异**先 commit 再 mutate、红后还原**（feedback：变异必须先证明自己落地——失败的替换与健壮的守卫从外面看一样）。

---

## §9 本文不主张什么

- 不主张任何组件已抽出/已建/壳已存在——本文**零 runtime**；S1-S7 按 owner ratify 后单独授权。
- 不主张审批已（或将）进检查器——§1.2 明列为非目标，进需先有审批读投影契约（另立锁）。
- 不主张历史读路由会显示 `HISTORY_INCOMPLETE`——**实证核验它不显示**；incomplete 只在**恢复预览**显示、execute 零写入（§4.2）。
- 不主张 R11 回链今天能在记录检查器渲染——**实证核验** `restoredFromVersion` 不在 `MetaRecordRevision`（§4.3 = OD-W2-5）。
- 不主张改了 `baseId`/`sheetId`/`recordId` 契约——恰相反，§术语把不改名钉为不变量（roadmap §3）。
- 不主张检查器新增了任何数据路径——HI-1（§5）钉零新增，parity + 变异证明是其门。
- 不主张响应式在 W2 内做——§3.4 归 P2-2c，S7 同门。

---

## §10 Opus 对抗审阅要点（前置门，实现 PR 附本节自查）

1. **HI-1 零新数据路径**：`rg "client\.|fetch\(|api\." ` 在每个新面板/壳的命中集合 ⊆ 抽取来源组件已有集合？附件面板真的只读 `attachmentSummariesByField`、无新列举 fetch？
2. **掩码不变量**：历史面板是否仍只遍历已掩码 `changedFieldIds`、只读掩码后 `patch`/`snapshot`？（refute：构造一个对该 actor 掩掉的字段，断言 diff 不出现它。）
3. **预览优先**：恢复是否**不可能**绕过预览直接 execute？（refute：删预览步 → incomplete golden 红。）
4. **ARIA 诚实性**：每个 `role`/`aria-controls`/`aria-selected` 有对应键位 + 测试？roving tabindex 在 props 突变（面板集合变）下 clamp？不声称 typeahead/拖拽？
5. **抽取等价**：S1/S2/S4 抽出前后既有 spec 逐条绿、emit/payload/gating diff 为空（逐块对照贴 PR）？
6. **无双抽屉**：S4 后右边缘是否只剩一个检查器（`showComments` 分支已收编，`MetaCommentsDrawer` 按 OD-W2-7 处置无残留 import）？
7. **CI 接线真生效**：`multitable-web-guard.yml` path-filter + run 列表含新文件名？真浏览器 `multitable-browser-verify.yml` 覆盖焦点环/响应式且带正控腿？
8. **G-10 术语**：检查器可见文案零出现 Base/Sheet/recordId 字样（普通 UI 只显示 记录/工作区/数据表/视图）？
