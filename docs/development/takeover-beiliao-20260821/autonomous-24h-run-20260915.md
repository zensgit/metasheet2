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
| Q9 | 2a 后续：列表带模板名/申请人名、hasMore、自动通过原子提升 | opus / opus / fable | 裁判 MERGE @12974a85e（11 条反驳 7 修，含模板名泄漏与回滚不可恢复两条 major）；PR 见 §2 | 🟡 CI |
| Q10 | #5750 后续：嵌入宿主回显真实上下文、navigated 按请求去重 | opus / opus / fable | #5760（裁判 MERGE，5 条发现全落码，含回显赛跑 major） | ✅ 已合，r50 |
| Q11 | 编辑器跨基 create_record 横幅 + 登记 #5747 客户端测试 | opus / opus / fable | 裁判 MERGE @96b175a42（4 条反驳全落码，含"文案与执行器相反"major）；guard 镜像；PR 见 §2 | 🟡 CI |
| Q12 | #5756 真实路径丢键（r49 实证"发现"） | opus 复现 | 未复现（13 例绿）；根因是浏览器跑旧包（见 §3.3），非缺陷；流水线已停 | ⛔ 误报，已纠 |
| Q13 | 管理器→编辑器→PATCH 往返回归用例（源自 Q12 的复现夹具） | opus 单代理 | #5759（76cd69f5b；14 例 + approval.completed；两点登记，guard 镜像 zensgit 推送） | ✅ 已合，r50 |
| Q14 | Q9 前端配套：面板「还有更多」与通知失败标记，客户端 hasMore/limit | opus / opus / fable | 裁判 MERGE @7f9f04afe（3 条反驳全落码）；PR 见 §2 | 🟡 CI |
| Q15 | 编辑器 #5756 往返用例 CI 5 s 超时抖动（#5763 web-tests 红暴露） | opus 单代理 | #5764（21 个 it 显式 30 s 超时；变异 1 ms → 12 红） | 🟡 CI |
| — | 222 发布 | — | r47 / r48（夜间） | 📝 |

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

## 4. 过程发现与教训

- 主检出本地 `main` 落后 origin/main 三周（e89f3e15e vs 28d11496b），在那里读代码与派只读诊断会得到旧代码/错行号；已快进并记忆化（读前 ff-only）。
- 只读地图 + 批评者比直接写设计更可靠：三条硬约束（§1 末）任何一条漏掉都会让阶段二返工。

## 5. 未完成 / 交接

（24 小时结束时填写：在飞 PR、未上 222 的合并、待 owner 拍板项、下一步建议）
