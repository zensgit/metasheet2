# 审批及自动化「操作页面」UX 对标审阅（钉钉/飞书）与改善阶梯 — 2026-07-04

> **性质**：内部 research 文档（可点名外部产品）。由此派生的任何 committed design-lock 必须改述为
> MetaSheet 自身原则，不得出现外部品牌名（既有纪律）。
> **方法**：5-lens 多 agent 代码审计（审批中心/列表 · 详情与处理动作 · 发起与模板中心 · 管理面 ·
> 自动化面），每 lens 逐文件读源（含 #3535/#3536 在飞 diff，避免重复提案），共 62 条原始发现，
> 去重合并为 50 条；3 个头部 claim 已由人工二次复核确认（见 §3）。
> **上位文档**：`approval-automation-dingtalk-feishu-benchmark-20260703.md`（#3529，能力级对标）。
> 本文是它缺的那一层：页面级 UX。两文结论互证：**引擎/动作词汇表已达标杆 parity，差距几乎全部
> 集中在页面「最后一公里」**——热路径点击数、可扫读性、宽恕型错误，以及几处伪装成 UX 问题的
> 生产正确性缺陷。

## 1. 总判断

审批引擎侧（门控、批量 fan-out、催办限流、条件公式 dry-run）不弱于钉钉/飞书，个别点（per-branch
公式 dry-run）领先。但审批员的高频体验由三件事决定，而这三件事目前都不达标：

1. **热路径点击数**：简单单据「看一眼→同意」在钉钉是列表内 1 击；我们是 行点击→整页详情→通过按钮→
   意见对话框→确认，×N 单还要 ×N 次整页往返。
2. **可扫读性**：列表五列（编号/标题/发起人/状态/时间）不含任何表单关键字段、停留时长、进度、
   行级未读——决策信息全在详情页里。
3. **宽恕型错误**：服务端结构化错误（`{error:{code,message}}`）被 `utils/api.ts` 丢弃成
   `API error: 400`，再被各 catch 统一成「操作失败，请重试」；批量部分失败只报数字不报原因。

## 2. 已强项（勿重建）

- 四 Tab IA（待我处理/我发起的/抄送我的/已完成）+ 未读徽标 + socket 实时计数 + 全部标记已读 + 详情自动标读。
- 批量通过/驳回工程质量高：有界并发 fan-out、逐行失败隔离 manifest、批量驳回意见、考勤单诚实排除。
- 催办双点位 + 服务端限流 + 429 人话文案。
- 详情页动作词汇表完整且门控正确（通过/驳回/退回/转交/加签/减签/撤回/评论），时间线含会签/或签/退回/并行富元数据。
- 明细子表链路强（行内小计、自动汇总 + 后端同构镜像、冻结 formSchema 渲染）。
- 模板后台：预设库、一键克隆、条件公式 dry-run（钉钉没有）、占位角色哨兵、画布地基。
- 自动化面：句式规则卡 + 内联启停、测试运行 confirm、高质量日志查看器（统计/过滤/脱敏/支持包）、
  DingTalk 配置预设 + lint + 实时预览。
- WorkflowHub 破坏性操作全确认；WorkflowDesigner 完整脏状态防护（仓内可复制的先例）。
- 移动 T3-1 v0 卡片列表（72px 触控目标、flag 门禁）；空态区分搜索无结果 vs 真空态。

## 3. 三个伪装成 UX 问题的生产正确性缺陷（已人工复核 ✅）

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| 1 | 发起人身份识别是 mock | `ApprovalDetailView.vue:609-612`：`isRequester = approval.requester?.id === 'user_1'`（注释自认 mock） | 生产环境真实发起人**永远看不到**已建成的 撤回/催办 按钮（线上缺陷，非 dev 假象） |
| 2 | 自动化管理器「更新即关闭」 | `MultitableWorkbench.vue:501`：`@updated="showAutomationManager = false"`，而启停/删除/保存全部 emit `updated` | 拨一下启停开关整个模态关闭；连续管理 3 条规则要重开 3 次。一行接线修复，全审计性价比之王 |
| 3 | 附件字段静默丢失 | `ApprovalNewView.vue:285-298`：`action="#"` + `:auto-upload="false"`，raw `File` 进 formData 后被 JSON.stringify 成 `{}` | 用户以为交了发票，实际什么都没存——**伪装成功的静默数据丢失**，全审计最反人性化项 |

另有一项同级：转交/加签选人器与填单 user 字段是硬编码假人（李四/王五/赵六）——两个协作动作
线上实质不可用；解锁它需要审批人可及的目录端点（B3-04，后端小刀）。

## 4. 改善阶梯

### Batch-1 — 前端-only 快赢 8 项（合计 ~1.5-2 周，建议 3 个 PR 弧）

| # | 项 | 内容 | Effort |
|---|---|---|---|
| B1-01 | **发起人身份修复**（前置） | `useAuth().getCurrentUserId()` 替换 user_1 mock；顺手加「等待你处理」tag | S |
| B1-02 | 详情页快照人性化渲染 | 按冻结 formSchema 顺序渲染 label；select 值→选项 label；date/number 格式化；schema 外 key 防御性保留 | S |
| B1-03 | 列表热路径包 | 行内通过（popconfirm+可选意见）/驳回（复用批量驳回壳）；「已等待 X 天」分级（>3d 橙 >7d 红）+「第 X/Y 步」；批量失败结果清单 + 重试失败项 | M |
| B1-04 | 宽恕型错误三件套 | api 层解析 `error.message/code`（remindApproval 已有先例模式）；对话框内 el-alert 展示失败；驳回必填前置（policy 位已在 DTO，0 处消费） | M |
| B1-05 | 决策动作人体工学 | sticky 底部操作栏（safe-area、移动全宽主按钮、动作集不变=Q8 合规）；常用意见 chips（quickPhrases.ts 纯模块 + localStorage 记忆） | S |
| B1-06 | 自动化生命周期修复 + 删除确认 | §3-2 一行接线修复；删除加确认（正文带 ruleStats「成功 N/失败 M 次，不可恢复」）；文案走 meta-automation-labels | S |
| B1-07 | 两个长表单编辑器丢稿防护 | MetaAutomationRuleEditor（3673 行、三条关闭路径全裸奔）+ TemplateAuthoringView goBack 无确认；复制 WorkflowDesigner 既有模式（全仓唯一先例 :845） | S |
| B1-08 | 最近使用模板捷径 | 提交成功记 localStorage（按 userId），模板中心顶部「最近使用」chips 深链填单页；发起热路径 3+ 次导航 → 1 次 | S |

建议 PR 弧：**PR-A**（B1-01+02+04+05，详情/决策面）→ **PR-B**（B1-03，列表面）→
**PR-C**（B1-06+07+08，自动化+模板面）。顺序上 B1-01 第一（其他详情页改动都受益于真实身份）。

### Batch-2 — P0 余项 + P1（28 项，均为明确路径的中等工作量）

| # | 项 | 一句话 |
|---|---|---|
| B2-01 | 待办列表关键字段摘要 | formSnapshot 已随 list 下发且服务端已脱敏，UI 完全没用；前 3 个叶子字段「label：value」摘要行（live-label 漂移风险须在 PR 声明） |
| B2-02 | 数字字段 min/step/precision 生效 | el-input-number 从不接收 field.props——预设的「请假 min 0.5」全是装饰，-3 天可提交 |
| B2-03 | 发布前校验清单前置 | 现在是先 confirm 后打脸；validateTemplateDraft 等全部已导出，只差聚合渲染 ✓/✗ 清单 |
| B2-04 | 指标看板模板名映射 + 日期快捷档 | 四张表全是裸 UUID；id→name Map + shortcuts 即修 3/5 张（#3535 合并后落，无文件冲突但同文件） |
| B2-05 | 委托 4 态状态 + 停用确认 | endAt 已过仍显示「生效」= 界面撒谎；须 #3536 合并后 rebase |
| B2-06 | 线性模板流程脊柱 + 步骤间插入 | 画布地基已建但 v-if 只给复杂图；90% 用户只看到表单卡堆。只读预览+插入，不做画布重写 |
| B2-07 | 共享 graphSummary.ts | 填单页提交前静态流程链 +模板详情按分支渲染（同一根因：无人话图遍历渲染器） |
| B2-08 | 时间线补当前处理人 + 后续节点 | 发起人第一问题「卡在谁那里」；数据已在客户端；顺带把详情从 live 模板切到钉住版本 |
| B2-09 | 时间线 ID 泄漏清理 | cc:'抄送'、节点 badge 用 nodeLabel()、actorId→actorName 映射、首字母头像 |
| B2-10 | 处理完成后「下一条 →」 | 清 N 单成本 = N×(返回+扫描+点击)；成功后直接给下一条入口 |
| B2-11 | 新待办到达刷新 pill | 徽标 5/列表 3 的脱节；不自动刷新以保护批量勾选 |
| B2-12 | 催办按行状态 + 已催办记忆 | 一条在途禁用所有行属误伤；移动催办是 ballot Q8 复议项不在此实现 |
| B2-13 | 再次提交（被驳回预填） | 发起人最恼火时刻摩擦最大；formSnapshot 预填 + 漂移防护；依赖 B1-01 |
| B2-14 | 填单草稿自动保存/恢复 | localStorage 按 user+template；服务端草稿此阶段不必要 |
| B2-15 | 校验深度 | change 触发 + scroll-to-error + 明细行必填客户端校验（现在直通不可读 400） |
| B2-16 | 金额大写回显 | amountInWords.ts 纯 util，与 amountAutoSum 同 scale 规则 |
| B2-17 | 模板中心 requester 卡片画廊 | 普通员工现在看到的是管理员表格；按 !canManageTemplates 分叉 |
| B2-18 | 复杂图节点编辑器接目录选择器 | 线性步骤有 typeahead，复杂图反而盲填裸 ID；组合式已实例化，复制模板块即可 |
| B2-19 | 条件分支可读摘要 | 「金额 > 5000」替代 edge_2/『amount gte 5000』；四处消费一个纯函数 |
| B2-20 | 委托管理选人/选模板控件 | 裸 ID typo 即创建路由不到人的委托；admin 视图门禁与端点匹配可纯前端修；#3536 后 rebase |
| B2-21 | 模板编辑器发起人视角预览 | 唯一预览是 JSON collapse；抽共享渲染器 + 样例数据实时验证显隐 |
| B2-22 | 规则编辑器保存禁用原因可视化 | ~15 条静默 false 只表现为置灰；saveBlockReasons 列表 + 滚动锚定 |
| B2-23 | 规则卡「上次运行」chip | glanceable status 核心缺失；统计串行改并行 + 最近一条日志 |
| B2-24 | executionMode 折叠 + 触发/动作分组 | 首屏第二个控件是「workflow_job_v1 作业面」引擎术语；后端已 fail-close，纯展示重排零风险 |
| B2-25 | 动作步骤折叠卡片 + 句式摘要 | 3 动作 ≈700 行控件长墙；渐进披露是飞书显得简单的关键 |
| B2-26 | 空态配方卡 + 收敛旧版双入口 | 最需引导的时刻制造最多困惑；预设模式已有先例 |
| B2-27 | 目标表下拉 + 类型化值控件 | 粘贴表 ID 对非开发者不可用而 listSheets() 已存在 |
| B2-28 | **附件字段诚实禁用（止血）** | 全管线（B3-07）落地前：禁用 + 「附件上传即将支持」+ 从 payload 剔除，终结伪装成功 |

### Batch-3 — 需后端/独立 gate 的 14 项（每项独立 opt-in，不自动链式启动）

| # | 项 | 后端需求 |
|---|---|---|
| B3-01 | 「我已处理」第五 tab | listApprovals 增 tab='processed'（approval_records 按 actor 反查，不限 status） |
| B3-02 | 行级未读标识 | pending 分支 LEFT JOIN approval_reads，DTO 增 isRead |
| B3-03 | 模板/时间筛选 + 看板钻取 | GET /api/approvals 增 templateId + createdFrom/To；看板计数变 router-link |
| B3-04 | **审批人可及目录端点 + 真实选人器** | 解锁面最广的一刀：同时救活 转交/加签/表单选人/委托自助 四个面（rbacGuard approvals:act，复用既有服务形状/限流/脱敏） |
| B3-05 | 提交前动态审批人解析预览 | POST /approvals/preview 只读跑 resolve 管线；design-lock first |
| B3-06 | 模板整流程试运行 | route-preview 只读图遍历；与 B3-05 同底座、分开 opt-in |
| B3-07 | 附件上传管线 | 上传端点 + 存储（评估复用 multitable 附件基建）+ refs 进 formSnapshot；独立 design-lock |
| B3-08 | 模板停用/启用 + 用量 | status published↔archived + blast radius 展示 |
| B3-09 | 模板版本历史 + 发布说明 | versions 列表端点 + publish note；治理孤例补齐 |
| B3-10 | 自动化失败一键重试 | 须继承 A5 replay 治理底座（confirmSideEffects + 幂等 ledger），不得裸 re-execute；过 flow-governance 双门 |
| B3-11 | 运行监控行 ruleName/sheetName | A2 序列化器附只读向后兼容字段 |
| B3-12 | 测试运行可选样本记录 | test 端点接受可选 recordId |
| B3-13 | P2 纯前端打磨组 | 骨架/空态 CTA、撤回策略感知（policy.allowRevoke 已在 DTO）、按动作 loading、打印/复制、cron 下次运行预览、Hub 中英混杂治理 |
| B3-14 | 清理遗留 ApprovalInboxView | 521 行未路由死代码自称「审批中心」；删除前评估其乐观冲突 reconcile 是否移植（仓内唯一先例） |

## 5. 纪律红线（实现时必须遵守）

1. **Ballot Q8 移动动作集锁定**（approve/reject/comment/initiate）：移动催办、移动批量、任何扩展
   动作集的改动都是 ballot 复议项，不得直接实现；B1-05 sticky bar 已限定为只改布局不改动作集。
2. **i18n 双轨**：multitable 自动化面所有新文案必须扩展 `meta-automation-labels.ts` 的
   `AutomationLabelKey` 类型化模块；审批 views 按既有约定内联中文，若做去重应抽
   `approvals/approvalStatusLabels.ts` 式共享词汇模块，禁止 ad-hoc 表。
3. **live-label vs 冻结快照漂移**（B2-01）：展示层可接受但 PR 必须声明权衡；冻结版本端点是
   admin-guarded，不得为此放宽守卫。反方向：B2-08 应把详情页从 live 模板切到钉住版本。
4. **read-only-never-flatten**：B2-06 画布增量不得新增任何可能扁平化复杂图的写路径；
   「步骤间插入」仅对线性草稿启用。
5. **WorkflowDesigner/BPMN = designer-only 永不 runtime**；B3-10 重试须过 flow-governance
   双门（named use-case + 继承共享底座）。
6. **staged opt-in lineage**：batch3 每项独立 gate；B3-05/B3-06 虽共享底座也分开 opt-in。
7. **在飞 PR 碰撞**：B2-05/B2-20 等 #3536 合并后 rebase；B2-04 等 #3535 合并后落。
8. **USE_MOCK 陷阱**：`api.ts:30` 的 `USE_MOCK = import.meta.env.DEV` 意味着 B1-01/B1-04 在本地
   dev 看不出效果——UAT 必须用生产构建/真实后端验证。
9. **B3-14 删除前**：grep 确认两个专属 helper 无其他消费者 + 评估乐观冲突 reconcile 移植。

## 6. 建议执行顺序

```
batch-1 PR-A（B1-01/02/04/05 详情决策面）
  → PR-B（B1-03 列表热路径）
  → PR-C（B1-06/07/08 自动化+模板）
→ batch-2 以 P0 余项打头（B2-28 附件止血、B2-02 数字校验、B2-03 发布清单、B2-04/05 看板+委托）
→ batch-3 逐项 gated opt-in（推荐第一刀 = B3-04 目录端点：解锁面最广，
   且是「转交/加签线上不可用」正确性缺陷的根治）
```

——审计（5 lens + synthesis 共 6 agent，62→50 条）与三个头部 claim 的人工复核均于 2026-07-04 完成。

---

## 7. 收尾点与「parity 必需 vs 锦上添花」裁决基准（2026-07-05 追加）

> owner 问「还剩多少开发量」。答案是个判断题：**batch-1「让操作不丢人」这一档已做完；
> 此后每一项都是可点单的菜单，不是待烧的 backlog。** 本节给出停手点与逐项裁决判据，
> 让后续每次点单都能回答「这项是通用面 parity 必需，还是更精致」。

### 7.1 裁决判据（两分法）

- **P = parity 必需**：不做，用户合理预期能完成的任务就*做不成*或*被迫走 workaround*。
  → 属于「桌面 parity」的定义，应完成。
- **G = 锦上添花（polish）**：任务本就能完成，此项让它更快/更好看。
  → 空闲带宽点单，随时可弃，不进「必须」清单。

判据落到一句可执行的问句：**「去掉这项，钉钉/飞书上能做的这件事，我们还能做成吗？」**
——答「做不成」= P；答「能，只是更烦」= G。

### 7.2 收尾点（stopping line）

> **batch-1（已完成）+ 一键处理主链（A-2/A-3/A-4，A-5 验收）+ batch-2 的 P 切片
> ≈ 桌面 parity + 一个真差异化。到此，通用办公审批面停手。**

**batch-2 的 P 切片**（剩余 28 项中，逐条过 §7.1 判据后判为 P 的最小集）：

| # | 项 | 为何是 P（去掉就做不成的那件事） |
|---|---|---|
| B2-01 | 待办列表关键字段摘要 | 「不点开就能决策」——钉钉/飞书卡片核心；缺则每单被迫进详情 |
| B2-07 | 提交前流程链（graphSummary） | 「会到谁手上、几步」——飞书提交前可见；缺则发起是盲盒 |
| B2-08 | 时间线补当前处理人 + 后续节点 | 发起人第一问「卡在谁那里」——缺则无法判断该不该催 |
| B2-13 | 再次提交（被驳回预填） | 驳回→改→重提是核心闭环；缺则用户手抄一遍最恼火 |
| B2-15 | 校验深度（change 触发 + 定位 + 明细必填） | 缺则脏数据直通服务端不可读 400，等于「填了但交不出」 |

其余 batch-2（B2-06 画布脊柱、B2-16 金额大写、B2-14 草稿自动保存、B2-09/10/11/12 列表微交互……）
一律默认 **G**——按 §7.1 判据均答「能做成，只是更烦」，归入空闲带宽点单，不进 parity 必需清单。
（个别项若 owner 认为摩擦足够大可单独升 P，但默认 G。）

### 7.3 收尾点之后：不再堆通用面，转投 fusion

到达收尾点后，**通用办公审批面的军备竞赛停手**（IM 原生卡片密度/移动端/打磨密度是钉钉飞书的结构性主场，
追无止境）。力气转向唯一的战略大刀——

> **T3-6 approval projection 的 per-row `visibility_scope` 继承**（#3537 后当前 admin-only）。
> 放开到行级可见性继承后，「审批结果是一张可被公式/视图/下一条自动化消费的表」对普通用户成立——
> 这是 §一(fusion 帧) 里对飞书的结构性卖点，其价值 > batch-2 剩余全部 G 项之和。
> 独立 design-lock（不与 B3-04 候选人目录小刀混合）。

### 7.4 batch-3 的地位

batch-3 剩余项**不是收尾点的一部分**——每项是独立 gated opt-in（多数需后端 + 自己的设计锁），
是「按具体需求解锁」的菜单而非「完成度」的分母。其中服务 fusion 场景的（B3-04 目录端点已在做、
B3-05/B3-07 等）优先级高于纯通用面打磨；纯通用打磨组（B3-13）降为最低。

**一句话结论**：欠的承诺（A-5）一周内清得完；「桌面 parity」再补 batch-2 的 5 项 P 切片即达标；
其后是 fusion 大刀 + 按需点单的菜单，没有固定「总剩余量」——这正是诚实的答案。
