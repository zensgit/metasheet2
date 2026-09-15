# 第六次 24 小时自主开发：设计与验证记录（2026-09-15 18:05 → 2026-09-16 18:05）

授权原话："接下去24小时我不在电脑前，你能帮我持续不间断的开发么？并根据代码难度来选择模型，完成后给出设计及验证MD"。
前置拍板（同日 17:5x，"按建议执行"）：#5741 归审批窗口；阶段二四项默认；顺序 #5742 → #5743 → 阶段二后端 → 阶段二前端；夜间上 222。

状态图例：✅ 合并/完成 ｜ 🟡 进行中 ｜ ⛔ 阻塞/放弃 ｜ 📝 待 owner

## 0. 结果一览（随时更新）

| # | 项 | 模型 | PR / 产物 | 状态 |
| --- | --- | --- | --- | --- |
| Q0 | 铃铛计数 1 / 面板「暂无通知」（顺手，演示记录 §5.4） | 主会话 | #5748（2b67a0462） | ✅ 已合，待 r47 |
| Q1 | #5742 写回 outcome→选项映射（`resultWriteback.outcomeValues`） | opus 实现 / opus 反驳 / fable 裁判 | #5752（f67984b34；裁判 FIX，10 条反驳全落码 + 遗留补 84551a0cb） | ✅ 已合，r47 |
| Q2 | #5743 管理弹窗 1.2 s 轮询 | opus / opus / fable | #5751（268aded99；裁判 MERGE，两项遗留已补 ecfaaaf78；H2 → #5750） | ✅ 已合，待 r47 |
| Q3 | 阶段二后端：记录级送审（提交表、路由、权限码、耐久消费者 v2） | opus / opus / fable | #5754（59d1eac2c；裁判 FIX，10 条反驳 4 真问题已修；realdb 泳道 + G5 注入 + 三处 CI 修） | ✅ 已合，r48 |
| Q4 | 阶段二前端：抽屉送审入口、对话框、审批面板 | opus / opus / fable | #5753（裁判 FIX @8bc1ab1d0，14 条反驳 12 修；遗留 3 项 e91c8c8b0 + guard 镜像 184cf4a20） | ✅ 已合，待 r48 |
| Q5 | componentSpec 中文名「组件规格」 | 主会话 | 222 字段改名（模板已有 labelZh） | ✅ |
| Q6 | 阶段二设计稿 | 主会话（基于 4 代理只读地图） | `multitable-approval-phase2-record-submit-design-20260915.md` | ✅ 草稿 |
| Q7 | 编辑器所有动作类型 config 保留（#5739 泛化） | Explore 普查 → opus / opus / fable | #5756（79dbc6588；裁判 MERGE，8 条反驳全落码，含字段值字符串化与跨基界面失真两条 major） | ✅ 已合，r49 |
| Q8 | #5750 外部上下文同步收敛（先复现） | opus 复现 / opus / opus / fable | #5755（14db7f82e；复现成功 5 次重发 = 5 次 HTTP；裁判 MERGE） | ✅ 已合，r49 |
| Q9 | 2a 后续：列表带模板名/申请人名、hasMore、自动通过原子提升 | opus / opus / fable | #5763（裁判 MERGE，11 条反驳 7 修，含模板名泄漏与回滚不可恢复两条 major；realdb 15 例真库绿） | ✅ 已合，r50 |
| Q10 | #5750 后续：嵌入宿主回显真实上下文、navigated 按请求去重 | opus / opus / fable | #5760（裁判 MERGE，5 条发现全落码，含回显赛跑 major） | ✅ 已合，r50 |
| Q11 | 编辑器跨基 create_record 横幅 + 登记 #5747 客户端测试 | opus / opus / fable | #5761（裁判 MERGE @96b175a42，4 条反驳全落码，含"文案与执行器相反"major；guard 镜像 2e1c54d41；首轮 web-tests 因 vitest worker 卡死 50 min 被杀，见 §4；合入 main f1cc1858b 重跑后全绿；合并 a4007e1e3） | ✅ 已合，r51 |
| Q12 | #5756 真实路径丢键（r49 实证"发现"） | opus 复现 | 未复现（13 例绿）；根因是浏览器跑旧包（见 §3.3），非缺陷；流水线已停 | ⛔ 误报，已纠 |
| Q13 | 管理器→编辑器→PATCH 往返回归用例（源自 Q12 的复现夹具） | opus 单代理 | #5759（76cd69f5b；14 例 + approval.completed；两点登记，guard 镜像 zensgit 推送） | ✅ 已合，r50 |
| Q14 | Q9 前端配套：面板「还有更多」与通知失败标记，客户端 hasMore/limit | opus / opus / fable | #5765（784c22dc1；裁判 MERGE @7f9f04afe，3 条反驳全落码） | ✅ 已合，r50 |
| Q15 | 编辑器 #5756 往返用例 CI 5 s 超时抖动（#5763 web-tests 红暴露） | opus 单代理 | #5764（21 个 it 显式 30 s 超时；变异 1 ms → 12 红） | ✅ 已合，r50 |
| Q16 | 送审面板/对话框/抽屉无路由挂载刷 `[Vue warn] injection "Symbol(router)"`（每次整段打印 mock 客户端，#5761 web-tests 卡死的直接诱因） | sonnet 单代理 | #5766（23133d0df；`useRouter()` 探测 → `inject(routerKey, null)`，告警 75→0，变异回退 27，vue-tsc 干净；合并 7c2af7020） | ✅ 已合，r51 |
| Q17 | 记录抽屉「审批进度」卡片（步骤/待处理人/历史；队列外候选 1） | 3 读者地图 → opus 实现 / opus 反驳×2 / fable 裁判 | #5770（裁判 MERGE @1ad1bb795，7 条反驳 0 major 全落码；可选两项已加固；CI 一轮被审批窗口 tripwire 拦下——多维表不得引用成员身份解析器，改 assigneeName→序号两步规则；合并 8a54a35b1） | ✅ 已合，r51 |
| Q18 | Vue warn 普查（811 spec / 6698 条）+ 多维表侧两处清零（工作台小写 `<router-link>` 1301 条、隐藏对话框 null sheetId ~20 条） | sonnet 普查 / sonnet 实现 | #5769（9628f98f6；`router-link` 1311→0，`Invalid prop` 20→8 余为未涉及的三个弹窗；顺带发现显式导入后 `<script setup>` 会把同名 kebab 标签自动解析，变异须导入与标签一起回退；合并 cae1f2421）；他窗口领域的 62% 只记录在 §5.3 | ✅ 已合，r51 |
| Q19 | 钉钉待办单向镜像（B 方案，队列外候选 4）：设计稿 + 默认关闭的实现 | 3 读者地图 → 主会话写设计 → opus 实现 / opus 反驳×2 / fable 裁判 | #5772（裁判 FIX→已修 @deeee9904：9 条反驳 4 major 全落码——并行网关/重投/发送中遇终态/429 分类；必修 realdb pin 对齐 v3；完成阶段取 token 拆分 cec884ede；realdb 泳道真库绿；合并 0e769bc88）；设计 `dingtalk-todo-mirror-b-design-20260916.md`；owner 前置未满足前保持关闭 | ✅ 已合，r52 |
| Q20 | 技术债：`apps/web/src/multitable` lint 普查 + 仅安全自动修复；#5769 剩下的三个隐藏弹窗 null sheetId 告警 | sonnet 单代理 | #5773（8c154e429，4 行：1 条可安全自动修复的 lint + 三弹窗门控，`Invalid prop` 8→0；普查 43 错/52 警留档：`require-default-prop` 47、vendor `prefer-const` 16、`no-unused-vars` 11 等均非自动修复，另开专项；合并 0be3f25da） | ✅ 已合，r52 |
| — | 222 发布 | — | r47 / r48 / r49 / r50 / r51 / r52 已上并实测（§3.1–3.6）；main `0be3f25da` == 222 | ✅ |

## 1. 队列与模型选择依据

- **主会话（fable）**：根因判断、设计、拍板项落地、上机操作、跨代理仲裁。
- **opus（impl-hard）**：跨文件逻辑与守卫/权限/幂等代码（Q1–Q4 的实现与修复）。
- **opus（refuter，只读）**：每个 PR 两个不同镜头的反驳者，只准内存级探针，不在共享 worktree 落盘变异。
- **fable（security-judge）**：终审，按五类漏法（假件背书 / 守卫没接线 / 边界无强制 / 逐套绿整链红 / 触发与边界不同量）。
- **sonnet**：机械改动（本轮未用到；Q5 由主会话一条 SQL 完成）。
- 只读地图（Explore，opus）：阶段二前先摸清审批桥接、RBAC 播种、记录抽屉三块，再由批评者补缺口——地图发现了三条会让直觉方案失败的约束（耐久投递清单冻结、createApproval 自校验 approvals:write、审批实例无来源记录列），全部进了设计稿 §2。

## 2. 每项设计要点

### Q0 铃铛（#5748）
根因：`normalizeRecordSubscriptionNotification` 对所有事件类型要求 `recordId` 非空，而 approval.completed 等无记录触发器产生的 `notification.sent` 行 `record_id=''`；服务端未读计数算它，客户端列表丢它。修：仅记录级事件要求 recordId。组件侧对空 recordId 跳过导航的逻辑在 F9b（#5664）已有。附带删掉 `client.ts` 既有 lint 红（未使用导入）。

### Q1 #5742（PR #5752）
- 配置：`start_approval.resultWriteback.outcomeValues?: { approved?, rejected?, revoked?, cancelled? }`，缺省行为不变（写原文）。一个纯函数 `resolveWritebackStatusValue(writeback, outcome)` 供保存校验、触发校验（同基/跨基）与 `buildResultWritebackPatch` 三处共用，避免"保存时按 A 判、写入时按 B 写"。
- 校验：对象、仅四个键、值非空；`{}` 视为未声明；无 `statusField` 时禁止非空映射；错误文案带映射值与 outcome。保存门在 `onNonApproved === true` 时也校验 `rejected`。
- 编辑器：状态字段下「审批结果 → 写入值」块（勾选"非通过结果也写回"→ 展开 rejected/revoked/cancelled 行；单选目标给选项下拉含"写入原文"空选项，文本目标给输入框），客户端镜像服务端规则做保存阻断（选项集不可见时只提示），跨基写回不阻断；显式 `onNonApproved:false` 原样回传避免 #4196 指纹漂移。
- 证据：后端单元 22+ 例（含触发时映射解析）、编辑器 spec +7；变异 6 条各红；反驳 10 条全部落码（1 major：客户端阻断误拦跨基写回）。运维提示：给有在途审批的规则加映射会触发桥接指纹守卫，需在无待审批实例时改。

### Q2 #5743（PR #5751）
根因（只读诊断，已核对 origin/main 仍成立）：`MultitableWorkbench.vue` 的 `startDialogMetaRefresh` 在字段/权限/视图/导入四个管理弹窗打开期间以 1200 ms `setInterval` 无条件重拉 fields + context，不比对内容、不看页面可见性；四个按钮仅管理员可见。
- 修：开弹窗刷新一次 + 15 s 保活（`DIALOG_META_REFRESH_INTERVAL_MS`）+ `document.hidden` 跳过 + `visibilitychange` 追补一次并重置节奏；停止时清 interval 与监听；卸载后在飞刷新不再补枪、不写 `grid.fields`（`workbenchAlive`）。
- `useMultitableWorkbench.loadSheetMeta` 对载荷做稳定序列化指纹 + 对当前状态做半指纹（`toRaw`），两者未变且 sheetId/viewId 相同时跳过状态替换；`grid.fields` 只在元素身份变化时重建。
- 证据：manager-flow +5、composable +6、既有三处用例改引常量（175 例绿）；变异 7 条各红；反驳 9 条中 7 条落码；222 实测 20 s 内 4 次请求（此前约 40 次）。H2 路径另立 #5750（Q8 已修）。

### Q3 / Q4 阶段二（PR #5754 / #5753）
设计见 `multitable-approval-phase2-record-submit-design-20260915.md`；与设计稿的偏差与补强：
- 后端：响应包络按仓库惯例 `{ ok, data: { submission } }` / `{ submissions }`（设计稿写的是裸对象，前端已按此对齐）；对抗评审补了四个设计稿没写的失败模式——创建即自动通过时完成事件先于实例绑定到达（第三步终态感知 + 一次复核）、`creating` 吸收态（5 分钟 TTL、DB 时钟、可回收）、`createApproval` COMMIT 后抛错（5xx 保留认领并标 `RECORD_APPROVAL_CREATE_UNVERIFIED`）、`SUPPORTED_MANIFEST_VERSIONS` 变成真实版本门；完成 UPDATE 与通知 INSERT 同事务（两条投递腿共用同一 sink）。realdb 泳道由本 PR 新增独立 workflow（不动 s6a 钉住的 plugin-tests.yml）。
- 前端：设计稿的 `StatusTag domain="approval"` 不存在，改用 `approvalInstance` 并对 `creating/failed` 本地文案；409 标识符在服务端 `error.details` 里（三层合并读取）；记录消失时重置对话框标志（封掉"对下一条记录自动弹出"的既有模式）；guard 镜像由 workflow-scoped 账号推送。
- 实际覆盖：后端单元 service 37 + routes 13 + 清单/处理器/能力等共 126；realdb G1–G6b 在真库 12/12（含 409 撞真索引、真适配器完成、掩码漂移）；前端新 spec 57 + 冻结抽屉/检视器批 203。
- CI 修三处：Global-History 清单把 4 个常量当 flag（NON_GH_EXACT）；G6b 因 RBAC 权限 60 s 缓存而假过（改专用无读用户 + 失效缓存）；outbox 断言仍钉清单 v1 文案（改 v2）。
- 222 实测见 §3.2。

### Q7 编辑器全动作类型配置保留（PR #5756）
加载深克隆 `originalConfig`，保存 = 克隆 − OWNED 键 + 建模值；`ACTION_OWNED_CONFIG_KEYS` 单处声明并有源码扫描用例强制每个重建分支声明；update/create 未编辑行回传原始值（修掉字段值字符串化）；钉钉动作不再凭空长出镜像键；跨基三元组保留后界面说实话（横幅、不预勾选确认、三元组不全阻断）。反驳 8 条全落码（2 major）。

### Q8 #5750 外部上下文收敛（PR #5755）+ Q10 后续（PR #5760）
复现：同一上下文重发 5 次 = 5 次 HTTP（403 无限重试）。修：`syncExternalContext` 记忆「请求 → 产生的 active 三元组」并带在飞登记（反驳者抓到"memo 记下别人写入的状态会吞掉后续导航"）；`externalContextMatchesWorkbench` 仅忽略"同 base 另一种拼法"；EmbedHost 不再抹掉 `?baseId=`。后续：`applied` 回显解析后的上下文但只在"仍是本请求的解析"时（防赛跑回显入侵者三元组）；`mt:navigated` 按 requestId/三元组去重、`mt:navigate-result` 保持 1:1；协议文档 §4.1。

### Q9 / Q14 2a 后续（PR #5763 / #5765）
列表带 `templateName`（须 `approvals:read` + 审批中心同一可见性过滤，反驳者抓到初版泄漏）与 `submittedByName`（两次批量 IN 查询）；`?limit=` 钳位与 `hasMore`（limit+1 探针、全序 ORDER BY）；自动通过路径提升与通知同事务并在通知失败时补偿盖章 `RECORD_APPROVAL_NOTIFICATION_FAILED`（反驳者指出纯回滚会留下永久 `creating` + 孤儿实例）。前端：客户端透出 `{ submissions, hasMore }` 与 `limit`，面板显示「还有更多（仅显示最近 N 条）」与通知失败标记（approved / 其它终态两套文案）。

### Q11 编辑器跨基 create_record（PR #5761）
后端允许 create_record 仅凭 `targetBaseId` 声明跨基；编辑器现在显示目的地横幅、按声明 base 过滤目标表下拉（roster 行自带 `baseId`）、`sheetId` 缺失内联提示；反驳者抓到初版文案"运行会失败"与执行器相反（执行器在目标表与触发表同 base 时静默建在本 base），文案改为陈述真实规则并钉用例；保存阻断只对 mutate 类三元组。预览层同类失真另立 #5762。

### Q17 记录抽屉审批进度卡片
- **地图（3 只读读者，origin/main 784c22dc1）**：面板今天只列提交行（状态/编号/申请人/送审时间/漂移），不渲染 completedAt，无节点/历史；审批中心 `GET /api/approvals/:id` 给 status、currentStep/totalSteps、currentNodeKey(s)、assignments[]（assigneeId/nodeKey/isActive，无名字），`/history` 给 snake_case 行（occurred_at/actor_name/action/comment）；两者都先过 `rbacGuard('approvals:read')`（403）再过参与人门 `canReadApprovalInstance`（非参与人值无关 404）；前端无可复用时间线组件（ApprovalDetailView 内联，pinia store 是共享单例不能借用）；待处理人名字靠 member-display-identity 批量解析。
- **设计**：前端-only。面板每行有 `approvalInstanceId` 且查看者持 FE `approvals:read`（与审批中心同一门）才显示「查看进度」；展开才并行取 detail+history，缓存按实例，随面板既有失效路径（record.id / record.version / refreshToken）清空；渲染步骤 x/y、当前待处理人（复用审批中心的名字解析）、历史（兼容 snake/camel，最多 20 条）、终态行补「完成时间」；403 →「无权查看审批进度」、404 →「你不是该审批的参与人」、其它 → 重试，全部值无关；不加轮询/不加 useRouter。
- **不做**：审批中心代码不动（只 import）；申请人无 `approvals:read` 时看不到进度——这正是 #5741/授予 `approvals:read` 给普通角色的 owner 决定（§5.2）。
- **登记**：新 spec 两点登记（必跑脚本 + guard 清单）。

### Q19 钉钉待办单向镜像（B 方案）
- **地图纠偏**：代码里没有任何待办 API；"A 方案已上"实为群机器人 handoff 通知（`(本条由系统发送)`），`stock-preparation-24h-design-and-verification-20260903.md:109` 的说法与代码不符；unionId 已在 `user_external_identities` / `directory_accounts` 落库；新消费者要开 manifest v3；审批侧没有"任务已决"事件，只能靠下一节点激活与实例终态推断。
- **设计**：见 `dingtalk-todo-mirror-b-design-20260916.md`（消费者 `dingtalk-todo-mirror`、账本 `dingtalk_todo_mirrors`、状态机、租约/退避照抄考勤账本、开关 `DINGTALK_TODO_MIRROR_ENABLED` 默认关、凭据仍在 `directory_integrations` 由 owner 录入、只出不进）。
- **Owner 前置**：待办写权限、操作者 unionId、222 上 unionId 覆盖率、role 席位是否要做。

### Q5 componentSpec
模板 `stock-preparation-templates.cjs:754` 早已 `labelZh: '组件规格'`，222 上的字段 `fld_3340800c07dc656a26e7141c`（五个恢复列之一，无 pack fieldId）仍是英文名，直接 `UPDATE meta_fields SET name` 改为「组件规格」（值无关，条件带原名）。新装实例走 zh-CN 时自然取中文。

## 3. 验证记录

### 3.1 r47（main `f67984b34` = r46 + #5748 + #5751 + #5752），2026-09-15 20:17–20:19 上 222
- 升级前备份 `pre-r47-20260915-201741.dump`；in-place 升级退出 0；后端/nginx 健康 OK；维护门 WIRED；包 gitSha == main；后端 dist 含 `outcomeValues`/`resolveWritebackStatusValue`、前端包含 `resultWritebackOutcomeValue-` 与 `visibilitychange` 字面量（提示级，权威是 gitSha）；定时 dry-run 0；pm2 online；9 条 False 与 r46 相同（已知良性）。
- **#5748 铃铛**：打开 bom备料 → 铃铛徽标 1 → 面板列出 1 条 `notification.sent`（r46 上为「暂无通知」）。
- **#5751 轮询**：打开「字段」管理弹窗，20 s 内 fields/context 共 4 次请求（开弹窗 1 对 + 15 s 保活 1 对；修复前约 20 对），关闭后 0。
- **#5752 映射**：先把演示字段「审批状态」的选项从 approved/rejected 改为 已通过/已驳回（同步那条记录的值）；打开规则 A 编辑器出现「审批结果 → 写入值」块，且因选项集不含原文 approved 而正确给出阻断「请在下方选择要写入的选项」；选 已通过、勾选「非通过结果也写回」、选 已驳回后阻断消失，保存成功，DB `actions[0].config.resultWriteback = {statusField, onNonApproved:true, outcomeValues:{approved:已通过, rejected:已驳回}}`。端到端：记录 → 待审批（20:22:08.9）→ AP-100002 pending → 审批中心驳回（必填原因）→ 20:22:43.00 实例 rejected → 20:22:43.03 记录写回「已驳回」→ 规则 B 通知 1 条。规则 A 的执行记录为 failed「Approval completed with rejected」，这是既有设计（非通过结果终止后续动作链），写回仍按 `onNonApproved` 完成。
- 顺带观察：客户自建的「测试」规则（当记录更新时 → 发送通知，无收件人）每次记录更新都失败一次（现 15 次），属既有配置问题，未动。

### 3.2 r48（main `59d1eac2c` = r47 + #5753 + #5754），2026-09-15 22:08–22:10 上 222
- 备份 `pre-r48-20260915-220804.dump`；两条迁移（提交表、`multitable:submit-approval`）执行成功；upgrade 退出 0；健康 OK；后端 dist 含提交服务与路由、前端包含送审入口 testid；探针：表与四个索引存在（含部分唯一 `uniq_mt_record_approval_in_flight`）、admin 已授权限码；dry-run 0；pm2 online；9 条 False 同前。
- **阶段二端到端（记录 rec_bb72a248…，`bom备料`）**：
  1. 抽屉 kebab 出现「送审」→ 对话框只列已发布模板「备料送审示例」→ 选中后渲染 说明/备注 → 提交 → toast「已送审 AP-100003」；DB 提交行 `pending`，`record_version_at_submit=2`，快照非空，绑定真实实例。
  2. 展开抽屉「审批」面板：模板 id / 待处理 / 编号 / 申请人 id / 送审时间（名称 join 留 2a 后续）。
  3. 改一格（审批状态 → 已通过）→ 面板显示「送审后数据已变更（1 个字段）」。
  4. 审批中心通过 AP-100003 → 22:11:59.22 提交行 `approved`（同事务写入申请人通知，`record_id` 有值）+ 规则 B 通知 1 条；回到抽屉面板状态芯片「已通过」，铃铛徽标 4。
  5. 在途唯一：再送审得 AP-100004（前一条已终态，部分索引放行）；紧接着第三次送审被拒，对话框内提示「该记录已在此模板审批中。 AP-100004 查看审批」。随后在审批中心通过 AP-100004 收尾。
- 截图：r48-01 送审对话框、r48-02 面板待处理、r48-03 面板已通过、r48-04 409 提示。

### 3.3 r49（main `79dbc6588` = r48 + #5755 + #5756），2026-09-15 22:22–22:24 上 222
- 备份 `pre-r49-20260915-222239.dump`；upgrade 退出 0；健康 OK；前端包含 `crossBaseTarget` 与外部上下文字面量（提示级）；dry-run 0；pm2 online；9 条 False 同前。`gh run watch` 撞 API EOF 后由 resume 路径自动接管（脚本已内置）。
- **#5756 实证（含一次误判与纠错）**：先用 SQL 给规则 B 的 `send_notification` 配置塞入未建模键 `x_customerExtension`，在编辑器里原样保存并抓 PATCH 体。前三次 PATCH 体都不含该键，一度判定为"#5756 未覆盖真实路径"并派了复现流水线（管理器层 13 例全绿，未复现）；随后核对 `document.scripts` 发现浏览器仍在跑 **r48 的包**（`index-B9H5OXJF.js`），而服务端已在发 r49 的 `index-CV9OqCO5.js`——222 的 nginx 对 `index.html` 不发 `Cache-Control`（只有 ETag），浏览器启发式缓存了旧 HTML，SPA 内导航与 `ignoreCache` 导航都没换包。用带随机参数的 URL 强制拉新 HTML 后重测：**PATCH 体含该键，DB 复核保留**，#5756 生效。
  - 教训已入记忆：上机实测前先核对 `document.scripts` 的 `index-*.js` 与包一致。
  - 运维项（待 owner）：nginx 给 `index.html` 加 `Cache-Control: no-cache`，否则升级后用户会残留旧包直到启发式缓存过期。
- #5755（外部上下文收敛）无法在 222 手工构造嵌入宿主重发，以单元/组件级用例（指向主检出 4 红 / 本分支绿）为证。

### 3.4 r50（main `784c22dc1` = r49 + #5759 + #5760 + #5763 + #5764 + #5765），2026-09-16 01:01–01:07 上 222
- 构建 3 min（run 34998683711），包 gitSha `784c22dc1` == origin/main；上机 wrapper 8 步全过：维护门 WIRED、F22 必存文件 + 逐文件哈希过、迁移跑完、backend `:8900/health` 第 3 次探测 OK、nginx `/api/health` 200、pm2 online；计划任务 dry-run 200（service-account 路径，未碰凭据）。
- 标记：与 r49 逐行一致（diff 为空）；权威标记仍是 gitSha。
- 浏览器实测（先 `about:blank` 再带 `_v=` 回来，`document.scripts` 只含 `index-Don-5Acb.js`，与构建日志一致）：
  - `rec_bb72a248…` 抽屉「审批」面板列出 2 条已通过（AP-100004 / AP-100003），每条显示模板名「备料送审示例」（#5763 走审批中心可见性门，admin 可见）、申请人显示名、编号链接 `/approvals/<instanceId>`、送审时间；AP-100003 带「送审后数据已变更（1 个字段）」；请求 `?limit=20`（#5765 客户端透出 limit）；只有 2 条故无「还有更多」。
  - 无送审记录 `rec_cd439e98…`：「此记录尚未送审」。
  - 未做：#5760 嵌入宿主回显（需 iframe 宿主页，222 上没有）；#5759/#5764 是 spec-only。
- #5761（Q11）、#5766（Q16）此时未合，留给 r51。

### 3.5 r51（main `8a54a35b1` = r50 + #5761 + #5766 + #5769 + #5770），2026-09-16 03:16–03:22 上 222
- 构建 3 min（run 35012668469），包 gitSha `8a54a35b1` == origin/main；wrapper 8 步全过（维护门 WIRED、哈希核验、迁移、backend 第 3 次探测 OK、nginx 200）。
- 浏览器实测（`about:blank` → 带 `_v=r51a` 回来，`document.scripts` 只含 `index-BFqiki7G.js`）：
  - `rec_bb72a248…` 抽屉审批面板：两条已通过行都多了「完成时间」；每行有「查看进度」；点开 AP-100004 只发 `/api/approvals/<id>` 与 `/history` 两个请求，卡片显示「第 1 / 1 步」和历史两条（发起 / 通过，带操作者显示名与时间），终态实例不显示「当前待处理人」——与 #5770 设计一致。
  - 未实测：无 `approvals:read` 用户看不到「查看进度」（222 只有 admin 账号可用）；#5766/#5769 为 spec 侧噪音清零，生产无可见变化；#5761 跨基横幅需跨 base 规则，未在 222 上造。

### 3.6 r52（main `0be3f25da` = r51 + #5772 + #5773），2026-09-16 04:20–04:23 上 222
- 构建 3 min（run 见 `r52/build.log`），包 gitSha `0be3f25da` == origin/main；迁移 `zzzz20260916120000_create_dingtalk_todo_mirrors` 建表 + 4 索引成功；backend/nginx health OK；`DINGTALK_TODO_MIRROR_ENABLED` 未设（默认关）。
- 222 事实：`meta_automation_outbox` 为空、`AUTOMATION_DURABLE_DELIVERY_ENABLED` 未设 → 审批事件走 **eventBus 腿**，manifest v3 的耐久扇出在 222 上无法实测（CI realdb 泳道已真库验证）。
- 浏览器实测（`index-CBilgSJU.js`）：抽屉「送审」→ 选「备料送审示例」→ 提交 → 新实例 AP-100005 待处理；面板行「待处理」+「查看进度」→ 卡片「第 1 / 1 步」「当前待处理人: 成员 1」（审批 payload 无 `assigneeName`，按 #5770 的序号兜底，真名在编号链接后）+ 历史「发起」；期间 `dingtalk_todo_mirrors` 保持 0 行（开关 OFF ⇒ 消费者 ACK 不落库，在 eventBus 腿上得证）；审批中心「通过」后实例 approved、提交行 approved + 完成时间；演示实例已关闭。

## 4. 过程发现与教训

- 主检出本地 `main` 落后 origin/main 三周（e89f3e15e vs 28d11496b），在那里读代码与派只读诊断会得到旧代码/错行号；已快进并记忆化（读前 ff-only）。
- 只读地图 + 批评者比直接写设计更可靠：三条硬约束（§1 末）任何一条漏掉都会让阶段二返工。

- **CI「红」先看步骤状态再看断言**：#5761 的 web-tests 失败没有任何 FAIL 断言，日志停在 15:50 的某个用例后 45 min 无输出、步骤仍 `in_progress`，是 job 到 50 min 被杀。直接诱因是该 spec 在无路由挂载时每个用例刷 `[Vue warn] injection "Symbol(router)" not found`，Vue 把整个 mock 客户端对象（几百行）打进 stderr，476 段 dump 撑爆 vitest worker 的 RPC（与考勤守卫「Timeout calling onTaskUpdate」同一形态）。处置分两层：分支合入 main 重跑（#5764 已把同批用例超时放宽），再由 Q16 从组件侧把 `useRouter()` 换成带默认值的 `inject(routerKey, null)` 让警告归零。教训：spec 里的 Vue warn 不是「噪音」，是 CI 稳定性成本，看到就该清。

- **边界先看测试，不看 CODEOWNERS**：三读者地图说"审批中心的所有权边界没有工具化"，错——`approval-member-identity-coverage-enumeration.spec.ts` 的 scope-leak sweep 就是工具化的边界（`src` 全树禁止 `getResolvedUserName / ApprovalDirectoryUser / assigneeId`），#5770 首轮 CI 因此红。设计跨窗口 import 之前，先 grep `tests/` 里有没有针对该模块的 sweep/tripwire；被拦下时按对方的口径改（只用 payload 显示名 + 值无关序号），不改 allowlist。
- **两点登记的 token 行必撞**：`run-required-web-tests.sh` exec 行与 `multitable-web-guard.yml` run-list 都是单行 token 列表，本轮 #5761、#5770 两次与 main 冲突；固定解法是取 main 整行再追加缺的 token（放 `--reporter=dot` 前）、`bash -n` + yaml 解析 + 两个文件 grep 新旧 token；长期该把清单改成多行。
- **Monitor 的 shell 没有 jq**：用 `jq` 解析 `gh` 输出的监控在 Monitor 里恒空，第一版把空当"完成"秒退、第二版 30 分钟零事件过期；改用 `gh --jq`，并对空输出显式打 `gh-empty` 事件。
- **裁判"无人看的路径"要落成 owner 探针**：Q19 里完成 PUT 的任何 404 都当"已清理"，操作者 unionId 变更或权限问题也会 404——代码层无法分辨，写进 owner 前置（真租户探针一轮记录 404 语义）比猜 body code 诚实。

## 5. 未完成 / 交接

（定稿 2026-09-16 04:45；授权到 18:05，若之后再有变动会以进度快照追加到本节末尾）

### 5.0 一句话账目
- 代码 PR 18 个全部合并：#5748 #5751 #5752 #5753 #5754 #5755 #5756 #5759 #5760 #5761 #5763 #5764 #5765 #5766 #5769 #5770 #5772 #5773；docs PR #5771（本文 + 两份设计稿 + 一处 0903 文档纠正）。
- 222 发布 6 次（r47–r52），每次都有 gitSha == main 的权威标记与浏览器实测（§3）；当前 222 = main `0be3f25da`。
- issue 4 个：#5757（nginx index.html 无 Cache-Control）、#5762（编辑器预览与执行器失真）、#5774（convergence guard Windows 伪红）、#5775（他窗口 spec Vue warn 普查）。
- 对抗核验：Q1/Q2/Q3/Q4/Q7/Q8/Q9/Q11/Q14/Q17/Q19 十一条流水线，反驳共 80+ 条，major 全部落码，裁判无一 BLOCK。

### 5.1 在飞
- 无代码 PR 在飞。docs PR #5771 已绿，定稿后合并（分支 `docs/autonomous-24h-run-20260915`，wt-docs6）。

### 5.2 需要 owner 拍板 / 动手的
| 事项 | 出处 | 说明 |
| --- | --- | --- |
| `approvals:read` 授予普通用户角色 | #5754 / #5763 / #5770 | 记录级送审的申请人要看进度卡片、送审对话框要列模板，都过这道门；222 目前只有 admin 有（手工授予）；播种归审批窗口 #5741 |
| `approvals:write` 是否授予普通用户角色 | #5754 | 申请人创建实例需要 |
| creating-claim TTL 5 min | #5754 | 在途占位过期时间，取默认值 |
| #5763 四项行为变化 | #5763 正文 | 模板名/申请人名走审批中心可见性门、自动通过原子提升+补偿、hasMore、limit 上限 |
| 钉钉待办镜像（B）前置 8 项 | #5772 正文 / 设计稿 §8 | 待办写权限、操作者 unionId（SQL 直设 `directory_integrations.config.todoOperatorUnionId`）、222 unionId 覆盖率、`PUBLIC_APP_URL`、真租户 404 语义探针、role 席位决定、之后才开 `DINGTALK_TODO_MIRROR_ENABLED=true`、重投只有 CLI |
| 222 是否启用耐久投递 | §3.6 | `AUTOMATION_DURABLE_DELIVERY_ENABLED` 未设，审批事件走 eventBus 腿；开了才有 outbox 重试与 manifest v3 扇出，也才需要看 `dingtalk-todo-mirror` 消费者积压 |
| 222 nginx `index.html` 无 `Cache-Control` | #5757 | 浏览器长期跑旧 SPA 包（r49 误判事故根因） |
| 锁包文档 §T0-3 更新 | #5763 裁判遗留 | 说明记录级送审的耐久投递已纳入 v2/v3 清单 |
| 编辑器预览与执行器失真 | #5762 | 预览用 label、执行器用 id，非阻断 |
| 客户规则「测试」每次记录更新失败 | 222 观察 | 早于本轮，未动；需客户确认是否还要 |
| 待处理人显示名 | #5770 | 审批 payload 无 `metadata.assigneeName` 时抽屉只显示「成员 N」；若要真名，需审批窗口在 task 席位 metadata 里带显示名（多维表侧不做 id→名字解析，tripwire） |

### 5.3 已知小遗留（不阻断，谁顺手谁做）
- `apps/web/src/multitable/utils/meta-record-labels.ts` 里 `recordApprovalApproverFallbackLabel` 的注释仍写"目录解析器未能确认"，实际触发条件是"payload 无 assigneeName"（一行）。
- #5770 卡片 `loadProgress` 的 `catch` 分支同款版本守卫未被测试钉住（成功路径已钉）。
- #5772 worker：`failed` / `outcome_unknown` 无告警；创建后的席位探针尽力而为；worker 用例的 org 限定断言是 SQL 文本 pin。
- lint 普查（#5773 正文）：`require-default-prop` 47、vendor `prefer-const` 16、`no-unused-vars` 11、`ban-types` 4、`no-v-html` 3 等均需语义性修改，另开专项。
- 他窗口 spec 噪音见 #5775；convergence guard Windows 伪红见 #5774。

### 5.4 之后的候选（按价值排序）
1. 钉钉待办镜像的 role / source_queue 席位（需审批窗口补"按角色展开成员"的事件，或明确不做）。
2. `failed` / `outcome_unknown` 告警 + 平台管理员级重投路由（现只有 CLI）。
3. 记录级送审：申请人自己撤回（现只能在审批中心撤回）。
4. 两点登记清单改多行（消 token 行冲突）。

### 5.5 环境残留
- worktrees（均无未提交改动，分支已合并可删；删前按 [[git-worktree-remove-follows-junctions]] 先拆 junction）：wt-fe6（Q19）、wt-p5（Q17）、wt-p6（Q18/Q20）、wt-base3（Q16）、wt-flabel（Q10）、wt-docs6（本文，待 #5771 合并后）。
- 发布脚本与日志：`%LOCALAPPDATA%\Temp\claude-auto24\r47…r52\`（含 `ship.log` / `upgrade-222-rNN.log`）；账本 `claude-auto24\STATE.md`（逐条时间戳）。
- 222：演示实例 AP-100003/100004/100005 均已关闭；`dingtalk_todo_mirrors` 空表；无待清数据；`approvals:read` 的手工授予保留。
