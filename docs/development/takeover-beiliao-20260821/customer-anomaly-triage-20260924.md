# 客户反馈裁定：异常情况（2026-09-24）

> 来源：客户文档《异常情况（20260924）》，8 条反馈、11 张截图，拆成 12 个子问题。
> 方法：每个子问题由一名只读调查员在代码中定位根因，给出 `path:line`；再由一名独立反驳者尝试推翻。12/12 成立，全部附修正；下文采用修正后的结论。
> 基线：客户在演示机 **r59 = main `05461c739`** 上测试（自动化日志时间 2026-09-24 15:54，晚于当天 13:05 上机）。核对时的 main 为 `4189aa096`；`05461c739..4189aa096` 共 12 个提交，不触及下文任何代码面，所以 main 上的结论与演示机一致。
> values-free：本文不含主机、口令、凭据。项目号和行数是客户自己的业务信息，已在 0918 裁定中出现过。

## 0. 结论速览

| # | 客户反馈 | 定性 | 根因一句话 | 修复量 | 需拍板 |
|---|---|---|---|---|---|
| 1a | 「最近开过的」能否清除、清除后去哪看 | 体验缺口 | 卡片只是本机 localStorage 快捷入口，每次登录都会清空；页面没有移除按钮，也没说明卡片不是数据 | S | 否 |
| 1b | 托管表删不掉，历史数据去哪删 | 保护正确 + 体验差 + **真正卡点** | 整表删除被 `SHEET_PLUGIN_MANAGED` 正确拦截，但删除按钮不该出现、提示没给出路；**客户真正要的是清掉旧项目的行**（见 §1） | S + M | **是**（数据清理） |
| 2 | 从 PLM 拉取失败「没能连上取数」 | 环境配置 + 文案 bug + **被遮住的第二个失败** | 很可能是 `CONNECTION_CANONICAL_UNAVAILABLE`（演示机定时试拉 r58 起同样报错）；修好连接后还会被 #5868 以 `TARGET_SHEET_FOREIGN_PROJECT` 拒绝（见 §1）；界面把所有读失败都说成「稍后再试」 | S（文案）+ 上机排查 | **是**（修连接、清表） |
| 3 | 删一行出现 3 条执行日志 | **bug** | 规则「记录删除时 → 删除记录」：删除动作删 0 行也报成功，并再发一条 record.deleted，自我连锁到深度上限 3 才停；Webhook 桥没有深度上限，可能被推 4 次 | M | 否 |
| 4a | 自动化条件字段是英文名 | 历史数据 + 缺工具 | 客户当时开的是插件建的「确认账本」，建表时演示机还没切中文；之后的中文改名只改了主表 | M（改名工具）| **是**（上机改名） |
| 4b | 条件值不随字段类型变化 | 部分 bug | 没选字段时默认值 `equals` 以英文原样显示；分支条件、人员字段的值没有类型化，按天比较日期不可靠 | M（2 个 PR） | 否 |
| 4c | 触发时间 UTC 且 am/pm | 体验缺口 | 后端早就支持时区（#3401），前端只写了 UTC；am/pm 来自浏览器原生时间框 | S | 否 |
| 5 | 新视图与 All Records 数据不一致 | **bug** + 解释 | 行是同一份数据，差别在排序、隐藏列、列宽；另有真 bug：切换视图时上一个视图的排序和筛选残留，点「应用」会被误存进新视图 | S | 否 |
| 6 | 进仪表盘回不去 | **bug** | 仪表盘是一个布尔覆盖层，只有工具栏同一按钮能关；侧栏点视图、浏览器后退都退不出；按钮也没有激活态 | S | 否 |
| 7a | 配置区高度调不了、⤢ 无效 | **bug**（#5643 回归） | ⤢ 和分隔条只改了 `max-height` 上限，flex 布局把面板压在上限以下，所以没有可见变化 | S | 否 |
| 7b | 类型转换只有文本 | 待拍板 | 当前只开无损白名单；#5864 的转换方案 v2.1 等五项拍板，尚未开发 | L | **是**（#5864 五项） |
| 7c | AI shortcut 怎么用、模型在哪加 | 体验缺口 + 待拍板 | 默认关闭，只能在服务器环境变量配置；业务数据只许发往可证明在内网的模型；前端从不检查是否可用，所以看起来能用 | M | **是**（是否给客户开 AI） |
| 8 | 另存模板的范围、能否带数据 | 按设计 + 2 个小 bug | 只存当前表的全部视图结构、不带数据；模板面板保存后不刷新；导出选项「全部已加载行」措辞误导 | S / M / L 三期 | **是**（复制表含数据） |

## 1. 共同根：一张表混了两个项目（1b / 2 / 5）

- 「bom备料2-20251773」里有两个项目的有效行：先拉的 2-20241722.1723（0918 统计 587 行）和后拉的 2-20251773（652 行），共 1239 行，与 09-24 截图行数一致。见 `customer-anomaly-triage-20260918.md:14` 与 #5860。
- #5868（已在 r59）强制「一张表 = 一个项目」：`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:1009`、`:1058-1101`，由 `:1963` / `:2450` 与 `http-routes.cjs:6495/:6578/:6644` 接线。整表扫描（`filters = {}`，`:1062`），只数**有效**行（`:1079`）。
- 因此：
  - 第 2 条的连接修好后，拉任一项目都会得到 409 `TARGET_SHEET_FOREIGN_PROJECT`，界面仍显示「没能连上取数」（文案 bug，见 2）。
  - 第 1b 条客户想删的「历史数据」，正是解锁拉取所需要清掉的旧项目行。
  - 第 5 条新视图首行是旧项目，是因为该视图没有排序，按录入先后显示。
- 解锁办法（二选一，**owner 拍板**，属于对客户演示表的数据写）：
  - (a) 把旧项目行的「有效」置为 false：可逆，保护只看有效行；
  - (b) 删除旧项目行：进「历史 → 已删除的记录」，只能逐行恢复。
  - 两种都要先确认**这张表保留哪个项目**，并先暂停该表上的「记录删除时」自动化（每删一行触发一次，见 3）。
- 过时文案与此矛盾，必须一起改：`StockPreparationOperatorHome.vue:63`「表里是这台系统上所有项目的行」、`StockPreparationProjectBoardView.vue:407`。

## 2. 逐条

### 1a 「这台电脑上最近开过的」
- 根因：
  - 卡片来自本机 localStorage：`apps/web/src/services/integration/stockPreparation/operatorHomeMemory.ts:40-43`（上限 30 条）、`:63-67`（按租户+账号分桶）。
  - 唯一清除路径是登录态变化：`:161-180`，由 `useAuth.ts:233-234`（每次登录）和 `:479-480`（会话 401）触发；JWT 默认有效期 24h（`AuthService.ts:145`）。
  - 首页列表 = 服务器目录 ∪ 本机记忆（`operatorHomeCards.ts:97-142`）。服务器侧含**租户内所有**拉进备料表的项目（`stock-preparation-pull-target-scan.cjs:553-556`、`:578-589`），不只是本人拉的。
  - 卡片只有两个操作按钮（`StockPreparationOperatorHome.vue:138-160`），没有移除。
- 修：
  - 每张卡片加「从列表移除」，写入本机隐藏表。有待处理事项的卡片不允许隐藏；再次打开该项目会自动恢复。
  - 改文案：「卡片只是快捷入口，移除不会删除数据」；`:185` 的提示补上「备料表里已有数据的项目（不论谁拉的）」。
  - 已知限制：隐藏表也会随登录清空，所以重新登录后卡片会回来。要跨登录保持，需要服务器端个人偏好（T 层取舍，先不做）。
- 去哪看数据：「项目查询」（来源列显示「自助拉取」）→「打开项目备料」；或在首页输入项目号打开；或打开备料多维表后用**搜索**（不要改共享视图的筛选）。

### 1b 托管表删不掉
- 根因：
  - 注册表托管的表，在任何写入之前就返回 409 `SHEET_PLUGIN_MANAGED`（`packages/core-backend/src/routes/univer-meta.ts:15352-15363`、`sheet-delete-guard.ts:65-107`），这是有意的保护。
  - 但 `canDeleteSheet` 没有考虑托管状态（`univer-meta.ts:9036`），所以删除图标照样显示；提示也没说该去哪里处理。
  - 系统里没有按项目清理或归档的路由（`http-routes.cjs:90-260`）。表格里批量删行可以用：删掉的行进入「历史 → 已删除的记录」。
- 修：
  - A（S，T 层）：托管表的 `canDeleteSheet=false`，并改提示文案。
  - B（M，**需拍板**）：在「项目备料」里按项目「预览 → 确认执行」清理或停用，管理员可用，留审计。
    - 是归档（置无效）还是清除？是否触发行级自动化？连带清哪些存储？
    - 注意：只做「归档标记」而不把「有效」置为 false，解不了 #5868 的拉取锁。

### 2 从 PLM 拉取失败
- 根因（第一层）：
  - canonical 连接解析的所有失败都会变成 `CONNECTION_CANONICAL_UNAVAILABLE`（`plugins/plugin-integration-core/lib/connection-resolver.cjs:166-184`）。
  - 前端把 dry-run 的任何异常都归成 `PLAN_READ_FAILED`（`apps/web/src/services/integration/stockPreparation/projectSync.ts:712-717`、`:484-488`），显示「没能连上取数，稍后再试」，错误码只在「技术详情」里。
  - 演示机的定时试拉在 r58 期间从 200 变成 400 `CONNECTION_CANONICAL_UNAVAILABLE`，r59 重启后依旧。可能的原因：
    - 连接被删、软删或未加载（r58 仍允许管理员 `?force=true` 删除被引用的数据源）；
    - 租户或作用域不匹配；
    - 绑定的属主戳不一致。
  - **只能在演示机上核实**，见附录 A 的 Q2-1/Q2-2。
  - PR #5933 只回填 `connection_id IS NULL` 的旧绑定，**不是**这次的修复。
- 根因（第二层）：见 §1，连接修好后会被 `TARGET_SHEET_FOREIGN_PROJECT` 拒绝。
- 修：
  - 上机（旧机）：先跑只读核查，再按分支修复：由属主账号重存绑定 / 重建连接并重新指向 / 查启动日志。
  - 代码（S）：`PLAN_READ_FAILED` 按错误码拆开，分别给出人话：
    - `CONNECTION_*`：「数据来源连接失效，重试没用，请联系管理员在『数据来源与体检』处理」；
    - `TARGET_SHEET_FOREIGN_PROJECT`：「这张备料表已有其他项目的数据」；
    - 403：权限不足；
    - 只有网络错误和 5xx 才说「稍后再试」。
  - 代码（S）：解析失败时记一条 values-free 的原因词（not_loaded / owner_mismatch / tenant_mismatch …）。
  - 注意：source-preflight 改为委托身份读取时，不能顺带放宽权限。

### 3 删一行出现 3 条执行日志
- 根因：
  - 同表的 `delete_record` 删的是已经不存在的触发记录：0 行 DELETE 仍报 success，并且无条件重新入队并发出 `multitable.record.deleted`（新 `_eventId`，深度 +1）。见 `packages/core-backend/src/multitable/automation-executor.ts:3261-3266`、`:3312-3316`、`:3422-3444`。
  - 深度上限 3 截断连锁（`automation-service.ts:128`、`:3061-3065`），所以出现 3 条。
  - Webhook 桥没有深度上限（`webhook-event-bridge.ts:82-86`、`automation-routing-manifest.ts:91`）。若配了 record.deleted Webhook，一次删除会推送 4 次。
- 修（M）：
  - 执行器：触发记录已不存在时，删除动作返回 `skipped`，并且**不**发连锁事件。同类问题的 update_record / lock_record 一并评估。
  - 保存时拒绝「record.deleted + 同表改/删/锁本记录」这类组合。
    - **但停用（enabled=false）必须放行**：`setRuleEnabled` 走的是 `updateRule`（`automation-service.ts:1974-1980`），不放行的话，客户连这条规则都停不掉。
  - 编辑器里隐藏这类动作；运行日志标出「连锁触发（第 N 层）」。
  - 需改动锁定旧行为的测试：`multitable-d1-delete-revision-parity-realdb.test.ts:187-200`；另补回归测试。

### 4a 条件字段是英文
- 根因：
  - 下拉显示的是字段存储名（`MetaAutomationRuleEditor.vue:264`）。
  - 确认账本模板本身带中文名 `labelZh`（`stock-preparation-templates.cjs:979-1015`），但只在建表时选用（`:601-618`）；已有账本不会重新描述（`confirmation-decisions.cjs:478-485`）。
  - 09-07 重建库后，历次中文改名只针对主表，账本一直是英文。
- 修：
  - 上机改名（**需拍板**，元数据写）：账本表名和 16 列按 `stock-preparation-template-zh-labels.test.cjs:107-124` 的词表改。
    - 只改名字仍是英文模板原名的列。
    - 插件按字段 id 寻址，改名安全。
    - 注意同名冲突：`meta_fields` 没有 `(sheet_id, name)` 唯一索引。
  - 产品化（M）：管理员触发的「表头改中文」。要求幂等、先 dry-run、compare-and-set，跳过手改过的名字和已占用的目标名，并记录配置修订。
  - 顺带确认 pm2-runtime 下 `MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE=zh-CN` 仍然生效。

### 4b 条件值不随类型变化
- 根因：
  - 编辑器自 #1472/#1473 起已经按类型切换，截图里是「刚添加、还没选字段」的一行：`createBlankCondition()` 预置了 `equals`（`MetaAutomationRuleEditor.vue:3412-3414`），下拉找不到对应项，只能原样显示英文。
  - 另有真问题：
    - 分支条件的值不做类型转换就保存（`conditionBranchAuthoring.ts:229`），后端只校验形状（`automation-service.ts:870`）；
    - 人员、关联字段存的是数组，但求值用 `===`（`automation-conditions.ts:435-436`），永远匹配不上；
    - 布尔下拉显示的是 true/false，不是中文；
    - 日期「等于某天」拿时间戳比字符串，不可靠。
- 修：
  - PR-1 前端：未选字段时把条件和值两格置灰；抽出共用的类型化值输入组件（分支条件也用）；日期改用 el-date-picker 并用中文说法；人员字段改为选人。
  - PR-2 后端：日期格式校验；日期按北京时间的「天」比较；分支条件也做字段类型校验；修人员条件的判断逻辑。

### 4c 触发时间 UTC / am/pm
- 根因：
  - 后端已经支持 `triggerConfig.timezone`（#3401），但编辑器只写 `timeOfDay`（`MetaAutomationRuleEditor.vue:126-128`、`:5215-5219`）。
  - 时间框用的是原生 `type="time"`，12/24 小时制跟随浏览器语言。
  - 同类问题：表格里 dateTime 单元格默认按 UTC 显示（`field-display.ts:23-26`、`:142`）。
- 修（S，纯前端）：
  - 改成 24 小时 `el-time-select`（步长 15 分钟）；新规则默认 Asia/Shanghai；文案去掉 UTC。
  - 旧规则只能一键「改为北京时间」，**不自动改**。编辑时必须写回原来存的时区，否则无关的保存会让提醒平移 8 小时。
  - cron 的「每天午夜」随后跟进。

### 5 新视图与 All Records 不一致
- 根因：
  - 各视图读的是同一行集，无排序时按 `created_at ASC, id ASC`（`univer-meta.ts:16842-16848`）。新视图是空白的（`:14448-14458`）。All Records 带 3 条排序、隐藏列，冻结项目号；「BOM层」就是被截断的「BOM层级」。
  - **bug**：`syncFromView` 只在规则数组存在时才覆盖排序和筛选（`apps/web/src/multitable/composables/useMultitableGrid.ts:790-806`），所以上一个视图的排序残留到新视图。
    - 点表头、点「应用」或清除筛选时，会把残留规则持久化进新视图（`MultitableWorkbench.vue:2894-2900`、`:2911`；`useMultitableGrid.ts:842-846`）。
    - 在工具栏清空最后一条规则也保存不上。
- 修：
  - A（S）：视图数据为准，缺省即清空；清空时显式发送空规则。
  - B（S-M）：服务器端「复制视图」。**必须剥离 `config.publicForm` 里的分享密钥**，并走写入围栏。
  - C（S）：新建视图处加说明文字。

### 6 仪表盘回不去
- 根因：
  - `showDashboardView` 在全文件只出现 3 处（`MultitableWorkbench.vue:51`、`:270`、`:1406`）：唯一出口是工具栏同一按钮。
  - 侧栏点视图或数据表不会复位它（`:4080-4085`、`:4098-4102`）。
  - 激活样式 `--active` 从未定义；不写 URL，所以浏览器后退会直接离开页面。
- 修（S）：
  - 侧栏点视图、数据表或 Base 都退出仪表盘；仪表盘头部加「返回表格」按钮；按钮加高亮和 `aria-pressed`。
  - 注意与在飞的 PR #5466（工具栏收纳）改的是同几行。

### 7a 配置区高度
- 根因：
  - ⤢ 和分隔条只改 CSS 变量，而这个变量只用作 `max-height`（`apps/web/src/multitable/components/MetaFieldManager.vue:15`、`:3403-3406`）。
  - 弹窗整体限高 84vh，并且是可收缩的 flex 列（`:3336-3351`），面板被压在上限以下，所以调大上限看不到任何变化。
  - 拖动起点取的是上限值而不是实际高度（`:3291`、`:3295`）。
  - #5864 评论里曾判断「已可调、只是不显眼」，这个判断是错的。
- 修（S）：
  - 面板设 `flex: 0 0 auto`；可用最大高度扣掉头部、添加行、删除确认行和列表保底 96px；拖动从实际高度起算。
  - 加 Playwright 真浏览器断言（jsdom 抓不到布局问题）；监听删除确认行等动态行的出现。

### 7b 类型转换
- 现状：白名单只开无损方向，文本只能转长文本（`packages/core-backend/src/multitable/field-retype-whitelist.ts:120-132`；前端镜像在 `apps/web/src/multitable/utils/field-retype.ts:51-65`）。转换方案 #5864 v2.1 等五项拍板，尚未开发。
- 建议一句话拍板：
  > 「#5864 v2.1 按建议值通过：权限门 canManageFields + 全表可读；前镜像保留沿用现有 retention（开启时 365 天）；往返保真走 A；首批 = 文本→单选/多选（多选→单选后置）；选项上限 5000、首版不设长度上限；面板按 7a 处理。」
- 补充风险：托管备料表的插件写入列（包括确认账本的 Status、Conflict Type、处理动作、备注）不能转单选，否则之后插件写入会失败。ADR 要写明排除这些列。

### 7c AI shortcut
- 现状：
  - 默认关闭，只由服务器环境变量开启（`MULTITABLE_AI_ENABLED` 等）。
  - 业务数据只许发往可证明在内网的模型端点（#5419 路由闸），所以云端 key 用不了。
  - 前端从不检查是否可用，配置区、额度卡片、公式 AI、抽屉的 AI 按钮都照常显示。
  - 中文界面保留「AI shortcut」英文是有意的约定（`meta-manager-labels.ts:436-437`），改名属于 T 层决定。
- 修（M）：
  - 新增 values-free 的 `GET /ai/availability`；不可用时各 AI 入口收成一行「未开通」说明。注意不能复用 `aiShortcutSectionVisible` 做闸门，它同时控制别的分支。
  - 中文名改为「AI 自动填写」，加使用说明。
  - 在 docs/ops 加一份开通手册，只写变量名。
- 是否给这位客户开 AI（需要客户内网模型主机）：**owner 拍板**。

### 8 另存为模板
- 现状：
  - 只存当前表的全部字段和全部视图（不含筛选、排序、列宽），不含任何记录。
  - 「使用模板」总是新建 Base（#5909 在飞）。
  - 小 bug：模板面板只在首次打开时加载（`MultitableWorkbench.vue:4589`）；导出选项「全部已加载行」实际导出的是整个筛选后的视图（`meta-core-labels.ts:176`）。
- 修：
  - 一期（S）：弹窗写明来源表，列出会保存的视图，字段类型中文化，面板刷新，改导出措辞，视图顺序稳定。
  - 二期（M）：可选视图、可多表、按视图可见列预选字段。
  - 三期（L，**需拍板**）：独立的「复制数据表（含数据）」。
- 风险：给客户的临时办法是「导出 → 导入」，**复制出的表不继承字段权限**，按部门隐藏的列会暴露给有全局读权限的人，必须明确提醒客户。

## 3. 执行清单

**A. 代码修复（T 层，默认推进；每条一个 PR，保证型走反驳 + 终审）**

| 序 | 项 | 量 | 备注 |
|---|---|---|---|
| A1 | #3 自动化连锁 | M | 保证型：执行器不发幽灵事件 + 保存校验（停用放行）+ 回归 |
| A2 | #6 仪表盘退出 | S | 与 #5466 协调 |
| A3 | #7a 配置区高度 | S | 需真浏览器断言 |
| A4 | #5 视图状态残留 | S | 另开「复制视图」时剥离 publicForm |
| A5 | #2 拉取失败文案按码拆分 + 原因日志 | S | 不改权限 |
| A6 | #1b 托管表隐藏删除 + 过时「所有项目」文案 | S | 与 §1 口径统一 |
| A7 | #4c 触发时间北京时间 / 24 小时；dateTime 单元格显示与编辑统一 24 小时制 | S-M | 旧规则不自动改；owner 09-25 追加要求「时间直接按 24h 显示」 |
| A8 | #1a 从列表移除 + 文案 | S | |
| A9 | #4b 条件类型化（前端 + 后端两 PR） | M | |
| A10 | #8 一期 | S | |
| A11 | #7c 可用性闸门 + 说明 | M | |
| A12 | #4a 表头改中文工具 | M | 上机执行另需拍板 |

**B. owner 拍板**

已决（2026-09-25，owner 在会话中答复）：
- **7b / #5864 五项：按建议值通过。** 权限门 canManageFields + 全表可读；前镜像保留沿用现有 retention（开启时 365 天）；往返保真走 A；首批 = 文本→单选 / 多选（多选→单选后置）；选项上限 5000、首版不设长度上限；面板问题按 7a 处理。托管备料表的插件写入列不在转换范围内。下一步是不超过 3 页的首批设计锁 ADR，然后做只读预览接口。
- **7c：不为该客户开 AI，只改界面**（可用性闸门、中文名、使用说明）；服务器配置不动。
- **8 三期：「复制数据表（含数据）」作为独立功能开发，复制时保留表权限与字段权限；模板入口可以提供复制数据的选项。** 默认的模板本身仍然不带数据：共享模板带数据会越过权限，所以带数据只能走「复制」动作，并且要校验复制者对源数据的读权限。
- **4c 追加：时间一律按 24 小时制显示**，包括自动化触发时间、dateTime 单元格的显示与编辑框。
- **4c 追加：日期时间的显示时区（T 层，默认推进，owner 可否决）。**
  - 现状 bug：显示按字段的 `property.timezone`，界面没有设置入口，所以恒为 UTC（`apps/web/src/multitable/utils/field-display.ts:22-33`、`:50-61`）；编辑框却按浏览器本地时间解析（`:35-48`）。北京用户填 09:00，回显成 01:00。系统里没有用户级时区设置，语言切换不改时区。
  - 规则（owner 09-25 确认：不按浏览器本地时间解析）：
    - 存储不变，仍存 UTC 绝对时刻。
    - 显示与解析统一按「业务时区」：租户级设置，本客户默认 `Asia/Shanghai`，字段 `property.timezone` 可覆盖。
    - 表格显示、编辑框、导出、筛选（如「今天」）、自动化提醒、通知消息用同一时区。
    - 固定格式 `YYYY-MM-DD HH:mm`，24 小时制。
    - 仅当浏览器时区与业务时区不同时，在时间旁标注「北京时间」。
  - 不采用浏览器本地时间的理由：同一记录不同人看到的不同；与服务器端计算（导出、提醒、「今天」筛选）不一致；依赖客户电脑时区配置，设错了难以发现。
  - 服务器端已有定时规则不自动迁移；新规则默认业务时区。
  - **实现偏差记录（Ratified-by-default-2026-09-26，owner 可否决）**：
    - 业务时区的实现方式：PR #6083 做成**实例级**环境变量 `MULTITABLE_BUSINESS_TIMEZONE`（未设置时默认 `Asia/Shanghai`，已登记 flag manifest），不是上文写的租户级设置。当前是单客户部署，两者效果相同；多租户时再做租户级设置。
    - 字段上存的 `property.timezone = 'UTC'` 视为「未设置」：这个值是后端读字段时自动补上的，界面从来没让用户选过，照字面尊重它就等于没修。真要按 UTC 显示，请改设 `Etc/UTC`。
    - 自动化规则 `triggerConfig.timezone = 'UTC'` 的含义不同，仍表示真实 UTC（旧规则），两处语义分开处理。

待决：
1. 「bom备料2-20251773」保留哪个项目；旧项目行置无效还是删除；由我们在演示机执行（§1）。这一项还需要客户回复。
2. 演示机 PLM 连接修复：先在旧机跑附录 A 的只读核查；连的是测试副本属 T 层，连的是真实 PLM 属 O 层。
3. 按项目清理功能的形态：归档还是清除、谁可操作（1b-B）。
4. 确认账本上机改中文（4a）。
5. R60 上机（旧机，按 `handoff-r59-two-machine-20260924.md` §3）。

**C. 与同机并行会话的分工（2026-09-25）**：#5954 保留 #6065（并入 #6068 的四处后关闭 #6068）；#5955、form-share 形状守卫、PM2_HOME 探测、#6066 / #6067 / #6069 / #6070、#5923 归对方；本文 A 表各项、#5864② 面板高度（对方 #6072 未通过核验，转交本线）、PLAN_READ_FAILED 分码归本线。

## 附录 A：演示机只读核查（在旧机执行，只看计数和布尔，不复制业务值）

- **Q2-1** 拉取动作用的是哪个外部系统：
  ```sql
  SELECT tenant_id, workspace_id IS NULL AS ws_null, action_id, external_system_id,
         updated_by IS NOT NULL AS has_updater, updated_at
  FROM integration_stock_prep_source_binding
  WHERE action_id = 'plm.stock-preparation.pull-bom.v1';
  ```
- **Q2-2** 绑定与连接健康（布尔）：
  ```sql
  SELECT es.id, es.status, es.connection_id IS NOT NULL AS canonical,
         ds.id IS NOT NULL AS ds_exists, ds.deleted_at IS NULL AS ds_not_deleted, ds.is_active,
         ds.scope_kind, ds.tenant_id = es.tenant_id AS tenant_match,
         NULLIF(BTRIM(es.config->>'dataSourceOwnerId'),'') IS NOT NULL AS owner_stamped,
         NULLIF(BTRIM(es.config->>'dataSourceOwnerId'),'') = ds.owner_id AS stamp_is_owner
  FROM integration_external_systems es
  LEFT JOIN data_sources ds ON ds.id = es.connection_id
  WHERE es.kind = 'data-source:sql-readonly'
  ORDER BY es.updated_at DESC;
  ```
  另查后端启动日志中 DataSourceManager 的 load/skip 行（pm2-runtime 托管，见 `222-pm2-runtime-home` 记录）。
- **Q1** 混表计数（只出计数）：取「bom备料2-20251773」的 sheet id、「项目号」「有效」字段 id，然后
  ```sql
  SELECT data->>'<项目号fid>' AS p, data->>'<有效fid>' AS a, count(*)
  FROM meta_records WHERE sheet_id = '<sid>' GROUP BY 1, 2;
  ```
- **Q3** 自动化连锁：
  ```sql
  SELECT id, triggered_at, status, trigger_event->>'recordId' AS rec,
         trigger_event->>'_eventId' AS eid, trigger_event->>'_automationDepth' AS depth
  FROM multitable_automation_executions WHERE rule_id = '<测试删除 id>' ORDER BY triggered_at;
  ```
  预期：同一 rec、3 个不同 eid、depth 依次递增。
- **Q5** 视图设置：
  ```sql
  SELECT name, sort_info, filter_info, jsonb_array_length(hidden_field_ids)
  FROM meta_views WHERE sheet_id = '<sid>' ORDER BY created_at;
  ```
  另外确认「BOM层」「BOM层级」是同一个字段。
- **Q4a** 账本表与列名：
  ```sql
  SELECT r.sheet_id, s.name
  FROM plugin_multitable_object_registry r JOIN meta_sheets s ON s.id = r.sheet_id
  WHERE r.object_id = 'plm_stock_preparation_confirmation_decision' AND s.deleted_at IS NULL;
  ```
  再列出这些表的 `meta_fields`；并确认 pm2-runtime 环境里有 `MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE`。
- **Q7c** 只报 AI 相关环境变量名是否存在；管理员 `GET /api/multitable/ai/readiness` 期望 `disabled`。

## 附录 B：给客户的答复稿

见同目录 `customer-reply-20260924.md`。
