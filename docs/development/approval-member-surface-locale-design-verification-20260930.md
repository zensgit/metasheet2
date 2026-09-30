# 审批成员面跟随界面语言(F8-1)设计与验证说明 · 2026-09-30

分支 `feat/approval-member-surface-locale`,基于 F3-E1(#6189)的头 `51401fee50`(两者都改 `ApprovalCenterView.vue`;`handleExportCsv` 函数体逐字节未动)。只改前端;不改后端、不改 `.github/workflows/*`、零 DDL、不开任何开关,没有真库步骤。

## 1. 依据

- **授权**:owner 2026-09-30 原话「按建议执行」,所指的是主会话在其前一条消息里列出的清单;该清单(主会话所写,非 owner 原话)的第 2 项是在导出按钮(F3-E1)完成后启动 F8-1。
- **计划**:`approval-feishu-p2-p4-slice-plan-20260930`(规划文件,不在仓内)§4「F8-1」,以及文末「第 5 轮(末轮)复验更正」节的 R5-5(更正优先于正文):
  - 改动面(节选):「`ApprovalDetailView.vue`、`ApprovalCommentsPanel.vue`、`ApprovalNewView.vue`、`ApprovalCenterDetailPane.vue`、`ApprovalCenterTable.vue`、`MyDelegationView.vue`、`ApprovalCardDecisionView.vue` 接入 `useLocale`(#5545 的做法:同一模块级单例)」;`ApprovalCenterView.vue` 其余文案「全部改走 locale」;`ApprovalMobileList.vue:51`;三个选择器;「`force-locale="zh"` 只去 **3 处**(`ApprovalDetailView.vue:45`、`ApprovalNewView.vue:32`、`MyDelegationView.vue:24`)」;两个 helper `memberActionDialogGrammar.ts`、`urgeButtonState.ts`。
  - R5-5:「其视图在正常界面态还渲染 9 个零 locale 模块(约 58 行),错误 / 提示态另 7 个(约 30 行);`relativeWait.ts` 应归零 locale……`quickPhrases` 本地化会改变**写入评论的语言**,须单独定性。」
  - 验收门:「① 逐文件源码守卫……对象 = 本切片改动面全部文件」;「② 挂载渲染扫描……门须在扫描前打开五个成员动作对话框……并渲染带催办按钮的表格行……扫描命中若来自尚未并入的模块,逐条列入在场核验的具名例外表(写明来源 file:line,不得用宽松正则静默排除)……渲染扫描里的例外表是对该形状的延伸,不是既有先例」;「③ 真机 en/zh 运行时切换逐项还原」。
  - 风险:「PR 写成『绊线 + 已知绕过枚举』,不写『已覆盖』」;「共享选择器的中间态混排,接受并在 PR 声明」;「并入的两个 helper 被 6 个前端 spec 引用……本地化后须逐个复核其语言态假设」。
  - 锁:「不需要」。
- `amountInWords.ts`(中文大写金额)按计划属领域功能,不本地化。

## 2. 改了什么

| 提交 | 内容 |
|---|---|
| `c14ed120e1` | 成员面 helper 接入界面语言:`memberActionDialogGrammar.ts`(中英两张同形表,`dialogTestId` / `commentRows` 只定义一次)、`urgeButtonState.ts`、`relativeWait.ts`(整句函数,避免「Waited 3 天」式半翻译)、`addSignHonestyCopy.ts`、`routePreviewSummary.ts`、`dateRangeField.ts`、`recordLinkField.ts`、`detailField.ts`、`assigneeSource.ts`、`conditionSummary.ts`、`upcomingNodes.ts` 及错误 / 提示态模块(`store.ts`、`templateStore.ts`、`cardDecision.ts`、`delegations.ts`、`memberActionErrorCopy.ts`、两个 controller、`useApprovalListFieldSummary.ts`)。成员面调用方传入界面语言;只被编排页(F8-3)使用的路径默认仍为 zh-CN。断言中文的既有 spec 显式钉 zh-CN。 |
| `8301b763cc` | 三个共享选择器(部门 / 关联记录 / 成员)接入,文案在新表 `approvalPickerLabels.ts`。 |
| `cc5e0cc4ff` | 审批中心(视图 + 表格 + 详情侧栏)全部界面文案接入,表在 `approvalCenterLabels.ts`;`tabEmptyText` 与导出文案 `exportCopy` 未改。 |
| `9dd9d1fd21` | 审批详情与评论面板接入,表在 `approvalDetailLabels.ts`;去掉 `ApprovalDetailView.vue` 的 `force-locale="zh"`。 |
| `75402759a7` | 发起页、我的委托、卡片决策页接入(各自一张表);去掉 `ApprovalNewView.vue`、`MyDelegationView.vue` 的 `force-locale="zh"`。 |
| `85aef08fb8` | `api.ts` 通用请求错误的兜底文案跟随界面语言(其余 mock 数据与管理面错误表不动)。 |
| `674abd5839` | 中心页表格的提交时间原先固定按 zh-CN 格式化、我的委托的时间窗按浏览器默认语言格式化;两处改为与详情页相同的规则(界面为 zh-CN 用 zh-CN,否则 en-US)。 |
| `f122cf765c` | 门 ①:逐文件源码守卫。 |
| `329334b802`、`366f9e0d74`、`6f30e544d6` | 门 ②:英文挂载渲染扫描。 |
| `9a277995ce` | 浏览器车道两个 harness 钉 zh-CN(见 §5)。 |
| `bbcdff4712`、`1a372065a9` | 计划门 ③:浏览器里的运行时 en / zh-CN 切换(后者只把字符类改写为转义)。 |
| 本提交 | 本说明。 |

`DelegationSettingsView.vue` 的 `force-locale="zh"` 属 F8-2,未动。

## 3. R5-5 模块对账

「渲染证据」指本片某条挂载扫描实际渲染出该模块的英文输出;「守卫」指只由门 ① 与单元测试覆盖。

| 模块 | 处置 | 证据 |
|---|---|---|
| `relativeWait.ts` | 接入 | 渲染:中心页表格、移动端列表、详情页 |
| `addSignHonestyCopy.ts` | 接入 | 渲染:详情页加签对话框 |
| `quickPhrases.ts` | **未接入(owner 取舍,见 §6)** | 渲染扫描具名例外 |
| `routePreviewSummary.ts` | 接入 | 渲染:发起页实时路径预览 |
| `dateRangeField.ts` | 接入 | 渲染:发起页日期区间时长 |
| `recordLinkField.ts` | 成员路径接入;编排路径留 F8-3 | 渲染:发起页已选记录、关联记录选择器 |
| `assigneeSource.ts` | 成员路径接入;编排路径留 F8-3 | 渲染:发起页流程预览 |
| `conditionSummary.ts` | 接入(编排调用方默认 zh-CN) | 渲染:发起页流程预览中的条件节点 |
| `detailField.ts` | 成员路径接入;编排校验留 F8-3 | 守卫 + `approval-detail-field.test.ts` |
| `store.ts` / `templateStore.ts` | 接入 | 守卫 |
| `approvalCenterDetailPaneController.ts` | 接入 | 渲染:详情侧栏加载失败 |
| `routePreviewController.ts` | 接入 | 渲染:发起页路径预览失败 |
| `cardDecision.ts` | 接入 | 渲染:卡片页提交失败、钉钉登录不可用 |
| `api.ts`(通用错误兜底) | 接入 | 守卫(限该函数)+ `approvalApiErrorSurfacing.spec.ts` |
| `memberActionErrorCopy.ts` | 接入 | 守卫 + `approval-member-bar-operation-policy.spec.ts` |
| `delegations.ts` | 我的委托路径接入;`validateDelegationForm`(只服务管理面)留 F8-2 | 渲染:我的委托表单校验提示 |

## 4. 具名例外

### 门 ①(源码守卫,`templateCenterI18n.spec.ts` 新 describe;逐条按原文与次数核在场)

| 来源 | 内容 | 归属 |
|---|---|---|
| `assigneeSource.ts:28-57` | `assigneeSourceSummary` 的 zh-CN 分支(16 行) | 编排页专用,F8-3 |
| `assigneeSource.ts:113-154` | 提前返回的 zh-CN 分支(6 行,英文分支紧邻其上) | 本片已接入的另一半 |
| `delegations.ts:120-125` | `validateDelegationForm`(6 行) | 管理面,F8-2 |
| `detailField.ts:76-207` | 新增子字段默认名与编排期校验(13 行) | F8-3 |
| `detailField.ts:360` | 明细必填行提示的 zh-CN 分支 | 本片已接入的另一半 |
| `recordLinkField.ts:20,35,121-122,302,305,310` | 编排期目标选项、端点标签、失效提示;无引用方的提示常量 | F8-3 |
| `ApprovalDetailView.vue:2136` | 快捷短语插入时的全角逗号 | 与 `quickPhrases` 同一 owner 取舍 |
| `ApprovalNewView.vue:560` | 附件开关关闭时的占位说明(B2-28,被既有 spec 逐字节钉住) | 附件梯度 |

`api.ts` 只扫 `approvalRequestError` 一个函数(同 #5545 对 `tabEmptyText` 的做法),其余为开发 mock 数据与管理面错误表。

### 门 ②(挂载渲染扫描;逐条按原文与次数核在场)

| 渲染面 | 文本 | 来源 |
|---|---|---|
| 详情页评论对话框 | `已阅`、`请尽快处理` | `quickPhrases.ts:15`(`QUICK_PHRASES.comment[0]`、`[1]`) |
| 详情页通过 / 驳回对话框(修复轮 1 补;不在计划门 ② 的五个对话框之内,扫描见 §9) | 通过:`同意`、`情况属实`、`已核实无误`;驳回:`不符合要求`、`请补充材料后重新提交` | `quickPhrases.ts:13` / `:14`(`QUICK_PHRASES.approve` / `.reject`) |
| 发起页 | 附件占位说明 | `ApprovalNewView.vue:560` |
| 我的委托 | `未开始`、`生效中`×2、`已过期`、`已停用` | `delegationStatus.ts:20` 的状态键,只出现在 `StatusTag.vue:6` 的 `data-status` 属性里;可见标签为英文(用例同时断言可见文本无 CJK) |

## 5. 验收门读数

读数环境:另一台机器(macOS arm64),Node 20.20.2,vitest 1.6.1,Playwright 1.57.0(Chromium)。本机只编辑与提交,所有测试都在该机器上跑。没有真库步骤(纯前端),未建库。

**门 ① 源码守卫**(形状同 `templateDetailI18n.spec.ts:955-1030`):对象是本片改动的全部 39 个非测试文件(与 `git diff --name-only 51401fee50..HEAD` 去掉 `apps/web/tests/`、`apps/web/verification/` 与 `docs/` 后的清单逐一相等)。剥 `<style>` / HTML 注释 / 块注释 / 整行 `//` 注释后,识别五种结构(`isZh` 字符串三元、对象三元、`if (isZh.value) { return {…} } return {…}`、`*_ZH` 表且同文件有无 CJK 的 `*_EN` 兄弟、`X` / `X_EN` 常量对)并逐个核英文侧无 CJK;每个文件的结构计数都钉死(计数防空转);具名例外按原文与次数核在场;其余任一行含 CJK 即红。读数:该 describe 40 个用例全过(39 个文件 + 1 个正控);变异 4 个(视图模板插入中文、详情表英文值改回中文、催办英文标签改回中文、`relativeWait` 三元改恒真)**4/4 转红**。

这是**绊线,不是证明**。已知绕过:CJK 写成 `\u` 转义或用 `String.fromCharCode` 拼;CJK 放在守卫清单以外的模块(如 `quickPhrases.ts`、`amountInWords.ts`)或由清单外的宿主作为 prop 传入;英文侧是一个绑定到中文的标识符;字符串字面量里的 `/*` 会被注释剥离误当成注释开头。

**门 ② 挂载渲染扫描**(对 #5545 渲染扫描形状的延伸,见 `tests/helpers/approvalLocaleScan.ts` 头注):扫整个渲染子树的文本和**所有**属性值(#5545 只读 `aria-label` / `placeholder` / `title`);命中非本片来源时进具名例外表,例外按原文与次数核在场。夹具全为 ASCII。凡是某个 stub 声明了文案 prop 却不渲染(列标题、占位、气泡确认按钮文字、对话框标题、分隔线插槽、表格空态),新 describe 注册本地变体,不改共享 stub。每条扫描都做 en → zh-CN(必须出现中文)→ en 往返。

| 宿主 spec(均在必需 web 车道) | 覆盖 |
|---|---|
| `approval-member-action-dialog-grammar.spec.ts` | 详情页,五个成员动作对话框**逐个打开**;每个对话框的标题、说明标签、占位、确认按钮与选择器占位作为正控必须以英文出现 |
| `approvalCenterDesktopEmptyTextI18n.spec.ts` | 中心页五个标签都有行、「更多筛选」展开、「我发起的」行的催办按钮(催办前 / 催办后的标签、title 与提示)、行驳回与批量驳回对话框打开 |
| `approval-center-master-detail.spec.ts` | 详情侧栏(已加载;加载失败兜底) |
| `approvalNewView.spec.ts` | 每种成员字段类型、流程预览(多种审批人来源、抄送、条件节点)、实时路径预览(角色审批人、未解析节点)、路径预览失败兜底 |
| `myDelegationView.spec.ts` | 所有状态行、新建对话框(含表单范围输入)、停用确认框文案、表单校验提示 |
| `approvalCardDecisionView.spec.ts` | 可处理、必须评论、已处理、已流转、链接无效、登录不可用、提交失败兜底 |
| `approvalMobileI18n.spec.ts`、`approval-comments-panel.spec.ts`、`approval-record-link-picker.spec.ts` | 移动端列表、评论面板、关联记录选择器(列表 / 无权 / 空) |

变异(每处把一条英文文案改回中文,跑对应扫描,逐个还原):催办标签、表格列标题、侧栏关闭标签、发起页流程标题、条件运算符 `in`、路径预览未解析、我的委托标题、卡片通过按钮、评论截断提示、`relativeWait` 不足一小时、转交选择器英文占位、退回对话框英文占位、选择器 stub 隐去占位 —— **全部转红**。另有一个变异(`OPERATOR_EN.isEmpty`)未转红:该值不参与显示(`isEmpty` 走单独分支),不是扫描缺口。

**任务门 ③ 引用两个 helper 的 6 个既有 spec**:

| spec | 语言态 |
|---|---|
| `approval-member-action-dialog-grammar.spec.ts` | 原 describe 显式钉 zh-CN;新增中英表对照与英文扫描 |
| `approval-urge-button-state.test.ts` | 所有调用显式传 `isZh`;新增英文 describe |
| `approval-member-bar-operation-policy.spec.ts` | 文件级 `beforeEach` 钉 zh-CN;`memberActionFailure` 显式传语言,新增英文断言 |
| `approvalCenterRemindBadge.spec.ts` | 文件级 `beforeEach` 钉 zh-CN |
| `approval-e2e-lifecycle.spec.ts` | 外层 `beforeEach` 早已钉 zh-CN(`:550`,UF-3),本片未改 |
| `approval-e2e-permissions.spec.ts` | 外层 `beforeEach` 早已钉 zh-CN(`:481`,UF-3b),本片未改 |

**计划门 ③ 真机运行时切换**:浏览器车道新增 `verification/approval-shell-locale-switch.spec.ts`(真实 Router / Pinia / Element Plus,真实 fetch 路径,`page.route()` 代替服务端;经与应用外壳相同的 `useLocale().setLocale` 切换)。中心页(「我发起的」标签、带催办行)与详情页(五个对话框各开一次)逐项快照「每行可见文本 + 每个可见的 placeholder / aria-label / title」:英文快照无 CJK(评论对话框的两个快捷短语除外,按原值列出);切到 zh-CN 后指定项变为中文表的值;切回英文后快照与首次**逐项相等**。读数 6/6 通过;变异(转交对话框英文标签改回中文)转红。

**浏览器车道既有两个 harness 钉 zh-CN**(`9a277995ce`):`approval-member-action-dialog-harness.ts`(按 zh-CN 无障碍名找对话框)与 `approval-form-builder-mounted-harness.ts`(编排页 F8-3 前仍为中文,但其中的部门选择器已随本片接入)此前不设语言,在英文浏览器下渲染英文,6 个用例红;改为挂载前 `setLocale('zh-CN')`,spec 不变,重跑 19/19 通过。

**整体读数**:见 §7 末的读数表。

## 6. 中间态与 owner 取舍

- **快捷短语(owner 取舍)**:`quickPhrases.ts` 的短语点选后原样写入评论正文,本地化会改变写入评论的语言。本片保持其内容与写入逻辑不变(中英界面下都插入中文短语),也保持插入时的全角逗号;是否按界面语言提供短语、已写入的评论如何处理,交 owner 决定。
  - (修复轮 1 补)同一取舍也覆盖通过 / 驳回对话框:那里的短语原样写入审批意见。所以英文界面下,通过对话框显示 3 个中文短语(`同意`、`情况属实`、`已核实无误`),驳回对话框显示 2 个(`不符合要求`、`请补充材料后重新提交`),评论对话框显示 2 个(`已阅`、`请尽快处理`)。三处写入内容的门内钉子见 §9。
- **共享选择器混排(计划已接受)**:F8-2 / F8-3 落地前,`DelegationSettingsView.vue` 与 `TemplateAuthoringView.vue` 未给选择器传占位,英文态下会出现「选择器英文、页面其余中文」;部门选择器还被编排页的字段检查器与行内编辑器引入,同样混排。
- **共享 helper 的编排路径**:`assigneeSource.ts`、`conditionSummary.ts`、`recordLinkField.ts`、`detailField.ts`、`routePreviewSummary.ts`、`routePreviewController.ts` 的编排页调用方仍取 zh-CN 默认值,随 F8-3 接入。
- `delegations.ts` 的 `validateDelegationForm` 只服务管理面,随 F8-2。

## 7. 未跑项与残留

- 与当前 main 的关系:本分支基于 #6189 合并前的头;试合并当前 main(只读 `git merge-tree`,不建 ref)在 `ApprovalCenterView.vue`、`ApprovalDetailView.vue`、`approval-center.spec.ts`、`approvalApiErrorSurfacing.spec.ts`、`verification/approval-member-action-dialog-harness.ts` 与 #6189 的说明文件上有冲突,须在推送前由主会话变基处理;变基后须重跑门 ① 与本节读数。
- (修复轮 1 补)本片改过的两个 spec 不在任何 CI 门里(既不在 `run-required-web-tests.sh`,也不在 `approval-web-guard.yml` 的 run-list):
  - `myDelegationForm.spec.ts`:本片给其 zh 断言补了 `isZh` 实参(参数必填)。原先加在这里的英文 describe 已在修复轮 1 移到必需车道上的 `myDelegationView.spec.ts`。
  - `approvalMobileDetailActions.spec.ts`:它是 `run-required-web-tests.sh` 头注所列的既有红文件之一,本片只加了文件级 zh-CN 钉。它在本片头与 main `48ae5025a5` 上都是 3 红 / 8 绿,红的是同样 3 条(读数见 §9),不是本片引入。其中 B1-05(点快捷短语填入)两边都绿,但它不在门内;写入路径的门内钉子是 §9 的新 describe。
- `tests/helpers/approvalLocaleScan.ts` 未加入 `approval-web-guard.yml` 的路径过滤(不改 workflow);它只被必需 web 车道上的 spec 引用。
- 几处错误兜底文案(卡片页的登录不可用与请求失败、详情侧栏加载失败、发起页路径预览失败)在出错当时按当前语言生成一次;消息显示期间再切换语言,这条消息不会重译,重试后按新语言生成。
- `detailField.ts` 旧附件值占位的渲染点、`store.ts` / `templateStore.ts` 的告警条只有守卫与单元测试,没有挂载扫描。
- eslint(审批文件不在仓内 `lint` 脚本清单里,仅作参考):本片改动的 78 个 `.ts` / `.vue` 文件 0 个本片引入的 error;唯一 error 在 `ApprovalCenterView.vue:1453` 的 `exportNotice`(来自 #6189,本片未改);另一处是新浏览器 spec 的字符类写成了字面字符,已在 `1a372065a9` 改为 `\u` 转义。

### 读数表(完整批在 `6f30e544d6` 上跑;其后 `1a372065a9` 只改浏览器 spec 的写法、`674abd5839` 只改两处日期格式,均重跑相关项)

| 项 | 结果 |
|---|---|
| 必需 web 车道 `run-required-web-tests.sh`(`6f30e544d6`) | 退出码 0;19 次 vitest 调用 0 失败;末次调用 516 files / 8537 tests passed |
| `vue-tsc -b`(`6f30e544d6`) | 退出码 0,0 error |
| `vue-tsc --noEmit -p tsconfig.verification-approval.json`(`6f30e544d6`) | 退出码 0 |
| `node scripts/ops/required-web-lane-token-manifest.mjs --check`(`6f30e544d6`) | MANIFEST MATCHES(未新增 vitest spec 文件,未改 run-list) |
| `node --test scripts/ops/approval-browser-ci-wiring.test.mjs`(`6f30e544d6`) | 3/3 pass |
| 引用两个 helper 的 6 个 spec(`6f30e544d6`) | 6 files / 170 tests passed |
| Approval browser verify 整车道,`CI=1 --retries=0`(`6f30e544d6`) | 47 passed(原 41 + 新增 6) |
| 新浏览器 spec + eslint(`1a372065a9`) | 6 passed;eslint 0 error |
| 日期格式改动后(`674abd5839`) | 门 ① 与中心页 / 我的委托相关 14 个 spec 文件全过(11 files / 295 tests、6 files / 97 tests 两批);新浏览器 spec 6 passed;`vue-tsc -b` 0 error |
| 代码最终状态(`674abd5839` 的树,其后只有本说明的提交)重跑 | 必需 web 车道退出码 0,19 次调用 0 失败,末次 516 files / 8537 tests passed;Approval browser verify 整车道 `CI=1 --retries=0` 47 passed |

## 8. 并入 main 与重跑(2026-10-01)

§7 第一条所说的「须在推送前并入当前 main」已做,读数如下;本节之前的内容保持原样(是 `2b8ecc9ea8` 时点的记录;标「修复轮 1 补」的句子除外,见 §9)。

**合并提交 `02a65651de`**:把 main `48ae5025a5`(含 #6189 的 squash `39891dc205`,即 F3-E1 加上其在途导出加固;以及 #6190 `ba8065517f`、#6191、#6192、#6193)并入本分支;本 PR 最终 squash 合并,合并提交只是中间态。六个文件冲突,逐个按「F8-1 的改动重放在 main 的行上」解:

| 文件 | 取法 |
|---|---|
| `ApprovalCenterView.vue` | main 的 `loadCurrentTab`(只在列表实际变化时才换快照对象)与 `handleExportCsv`(`stillSameFeed` 守卫)原样保留;F8-1 的文案表在其外围不变。main 在此文件没有新增用户可见文案(只有注释与守卫),无需新的中英对。 |
| `ApprovalDetailView.vue` | 过程附件上传口取 main 的门 `attachmentPipelineEnabled && canAttachProcessEvidence`(#6190),标签取 F8-1 的 `:label="t.attachments"`。 |
| `approval-center.spec.ts` | main 的版本(在途导出五条用例 + 网络失败文案用例)加 F8-1 的 `beforeEach` 钉 zh-CN。 |
| `approvalApiErrorSurfacing.spec.ts` | main 的导出 import 加 F8-1 的 `beforeEach` 与语言复位。 |
| `verification/approval-member-action-dialog-harness.ts` | main 的 `?scenario=role-seat-evidence` 参数与 F8-1 的 zh-CN 钉都保留。 |
| #6189 的说明 MD | 取 main 侧。 |

合并结果的核法:合并后的树相对 main 的逐行差异(`-U0` 的 +/- 行)与 `51401fee50..2b8ecc9ea8` 的逐行差异**完全相等**(80 个文件,+4215 / -706);相对 `2b8ecc9ea8` 的逐行差异与 `51401fee50..main` 的逐行差异也完全相等。即合并树 = main + F8-1 的改动,冲突之外没有改任何东西。main 在成员面文件里新增的中文只出现在注释(HTML 注释、块注释、整行 `//`),门 ① 剥注释后不计,所以 `ApprovalCenterView.vue` 的结构计数保持 ternary 14 / ifZhBlock 2,守卫未改。

**`9351ca7d0e`**:§7 提到的 `exportNotice` eslint 报错(`vue/return-in-computed-property`)在合并结果上核实属实,且在 main `48ae5025a5` 的同一文件上同样报(main 上是第 1416 行),不是本分支引入。修法一行:穷尽 `switch` 之后补 `return null`(运行时不可达,只是给 lint 规则一个返回)。修后这五个冲突文件 eslint 0 error(59 条 warning 与修前相同,均非本次引入)。

**重跑读数**(同一台机器,Node 20.20.2 / vitest 1.6.1 / Playwright 1.57.0 Chromium;在 `9351ca7d0e` 上;lockfile 未变):

| 项 | 结果 |
|---|---|
| 门 ① 源码守卫 `templateCenterI18n.spec.ts` | 1 file / 58 tests passed(计数未变) |
| 门 ② 挂载渲染扫描(引用 `approvalLocaleScan` 的 9 个 spec) | 9 files / 161 tests passed |
| `approval-center.spec.ts` + `approvalApiErrorSurfacing.spec.ts` | 2 files / 85 tests passed |
| 引用两个 helper 的 6 个 spec | 6 files / 170 tests passed |
| main 侧改过的 `approval-process-attachment-dialog.spec.ts` + `approval-detail-instance-consistency.spec.ts`(自动合并,文件级 zh-CN 钉覆盖其新用例) | 2 files / 70 tests passed |
| `vue-tsc -b` | 退出码 0,0 error |
| `vue-tsc --noEmit -p tsconfig.verification-approval.json` | 退出码 0 |
| `required-web-lane-token-manifest.mjs --check` | MANIFEST MATCHES |
| `approval-browser-ci-wiring.test.mjs` | 3/3 pass |
| Approval browser verify 整车道 `CI=1 --retries=0` | 48 passed(原 47 + #6190 的角色席位用例 1,后者在 harness 的 zh-CN 钉下按中文无障碍名找对话框) |
| 必需 web 车道 `run-required-web-tests.sh` | 第一次:19 次调用中末次 5 files / 9 tests 失败,9 条全是 `Test timed out in 5000ms`(1 条在 `approval-member-action-dialog-grammar.spec.ts`,8 条在与本片无关的 4 个 multitable spec),当时机器上另一条 lane 在并行跑整批,负载均值 35–54(10 核);这 5 个文件单独重跑 5 files / 319 tests passed;**整车道第二次:退出码 0,19 次调用 0 失败,末次 516 files / 8546 tests passed**(比 §7 多的 9 条是 main 侧新增用例)。 |
| 变异(把 `stillSameFeed` 改恒真) | `approval-center.spec.ts` 恰红 3 条在途用例(切 tab / 筛选变化 / 提交搜索),还原后 47/47 —— 与 #6189 加固时的读数相同。 |

**残留**:详情页评论对话框里过程附件上传口的英文标签(`t.attachments`)只有门 ① 与单元测试覆盖,没有挂载英文扫描(扫描夹具不开附件开关、不带 `canAttachProcessEvidence`);合并前如此,合并后亦然,记在这里不在本次改。

## 9. 修复轮 1(2026-10-01)

门审(规划侧记录,不在仓内)在 `1510445ee4` 上的结论是 0 P1 / 1 P2 / 3 P3 / 4 NIT。逐条处置如下。

| 项 | 处置 |
|---|---|
| P2-1:快捷短语写入的内容没有门内测试钉住(门审的变异 M5a / M5b 在已门控文件上全绿) | 修。`approval-member-action-dialog-grammar.spec.ts`(必需 web 车道)新增一个 describe,见下 |
| P3-1:通过 / 驳回对话框在英文态显示 5 个中文预置短语,既没扫描也没单列 | 修。同一 describe 在英文态打开该对话框做整页扫描,把 5 条列为具名例外(`quickPhrases.ts:13` / `:14`);§4 门 ② 表与 §6 各补一句 |
| P3-2:改过的两个 spec 不在门内,说明里没写 | 修。§7 补上披露;`myDelegationForm.spec.ts` 的英文 describe 移到必需车道上的 `myDelegationView.spec.ts`,并加一条「每种失败各有一条不同的消息」 |
| P3-3、N4:提交尾行 | 属于提交元数据,不在仓内文档里处理;交合并时处理 |
| N1、N2 | 不改(已分别在 §8、§2 声明) |
| N3:§4 的行号基准 | 补注:§4 的行号以 `2b8ecc9ea8` 为准。并入 main 后,§4 引用的文件里只有 `ApprovalDetailView.vue` 行号有变,快捷短语插入时的全角逗号那一行由 `:2136` 移到 `:2146`;其余文件在 `2b8ecc9ea8..HEAD` 之间没有改动 |

**新 describe**(`O-8 / F8-1 — quick-phrase chips write the preset text unchanged in both locales`):通过、驳回、评论三个对话框各跑 en 与 zh-CN,共 6 个用例。每个用例做四件事:

1. chip 文本等于字面预置值。测试里直接写字面值,不引用常量,所以常量一改就会红。
2. 点第 1 个 chip,输入框的值等于该字面值;再点第 2 个,值是两者以全角逗号相接。
3. 清空输入框,再点第 1 个并提交。断言视图交给审批 store 替身 `executeAction` 的参数恰为 `('apv_1', { action, comment: <字面值> })`,成功提示出现一次,对话框没有错误。这里钉的是「视图 → store」这一跳,不是 HTTP 请求体;「store → API」那一跳不在本片改动面内。
4. 英文态下,在对话框打开、尚未点 chip 时扫描整页(文本加所有属性值):除该动作的预置短语(各 1 次,作为具名例外,带来源行)外没有 CJK。另有正控:对话框标题按当前语言显示。

这是对写入内容的**绊线**:它钉住的是本片不改写入内容这一现状,不是在替 owner 做取舍。owner 若决定本地化短语,改这个 describe 即可。

**变异**:在另一台机器上跑。每项都是 cp 备份 → 改 → 跑 grammar spec 整文件 → 还原 → cmp 一致,全部结束后 `git status` 干净。

| 变异 | 结果(整文件 26 条) |
|---|---|
| M5a:两处 chip 都改成 `applyQuickPhrase(isZh ? phrase : 'x')`(与门审同名变异相同) | 3 红:三个对话框的 en 用例。zh 用例绿,符合预期(zh 的写入没变) |
| M5b:两处都改成 `applyQuickPhrase(phrase + '!')`(与门审同名变异相同) | 6 红 |
| 只改通过 / 驳回对话框的 chip(`phrase + '!'`) | 4 红:通过、驳回的 en / zh;评论绿 |
| 只改评论对话框的 chip | 2 红:评论的 en / zh |
| 追加分隔的全角逗号改成 `, ` | 6 红 |
| `submitAction` 的提交参数在英文态改成 `'x'`(只改这一处) | 2 红:通过、驳回的 en |
| `submitComment` 的提交参数在英文态改成 `'x'` | 1 红:评论的 en |
| `quickPhrases.ts` 的 `情况属实` 改成 `Verified` | 2 红:通过的 en / zh |
| `DETAIL_EN.actionDialogApprove` 改回中文(检验通过对话框的英文扫描) | 1 红:通过的 en |

**重跑读数**:另一台机器(macOS arm64),Node 20.20.2,vitest 1.6.1。在 `633585ecd4` 上跑,lockfile 未变。纯前端,没有真库步骤,未建库。浏览器车道本轮未重跑:本轮只改了两个 vitest spec、移走一个 describe 和本说明,`src/` 与 `verification/` 都没动。

| 项 | 结果 |
|---|---|
| 改过的三个 spec | 3 files / 43 tests passed。其中 grammar 26 条 = 原 20 + 新 6 |
| 门 ① `templateCenterI18n.spec.ts` | 1 file / 58 tests passed(与 §8 相同) |
| 门 ②:引用 `approvalLocaleScan` 的 9 个 spec | 9 files / 168 tests passed(§8 的 161 + 新 7) |
| 引用两个 helper 的 6 个 spec | 6 files / 176 tests passed(§8 的 170 + 新 6) |
| `myDelegationForm.spec.ts` + `approvalQuickPhrases.spec.ts` | 2 files / 14 tests passed |
| `approvalMobileDetailActions.spec.ts`(门外,只作对照) | 本片头 `633585ecd4` 与 main `48ae5025a5` 都是 3 failed / 8 passed,失败的是同样 3 条(B1-01 requester-only、B1-04 reject confirm、flag ON + narrow → approve);B1-05 两边都绿 |
| `vue-tsc -b` | 退出码 0,0 error |
| `required-web-lane-token-manifest.mjs --check` | MANIFEST MATCHES(没有新增 spec 文件,没改 run-list) |
| `approval-browser-ci-wiring.test.mjs` | 3/3 pass |
| 必需 web 车道 `run-required-web-tests.sh` | 跑了三次。第三次:**退出码 0,19 次调用 0 失败,末次 516 files / 8553 tests passed**(比 §8 多的 7 条就是本轮新增的用例)。前两次都是退出码 1。当时那台机器上还有与本仓无关的进程在跑,1 分钟负载均值 35–50(10 核)。第一次 15 条失败:14 条 `Test timed out in 5000ms`,另 1 条是 spy 调用次数不符(与一条超时用例同在 `public-multitable-form-view-migration.spec.ts`);第二次 16 条,全是超时。两次失败都落在 multitable、备料、审批中心等本轮未改的 spec 上。失败文件单独重跑全绿:第一次的 5 个文件跑出 312/313(剩 1 条超时),那 1 个文件再单独跑 1/1;第二次的 5 个文件 428/428。第二次另有 1 个 unhandled error:`approvalNewView.spec.ts` 里某条用例排下的 800 ms 草稿保存定时器,在测试环境拆除后才触发(`ApprovalNewView.vue` 的 `scheduleDraftSave` 在卸载时不清定时器,是既有代码)。探针显示,本片头与 main `48ae5025a5` 上排下该定时器的都是同样 9 条既有用例,本片新增的 2 条扫描用例不排。单独连跑该文件 4 次,4 次都是 45/45、0 error。这条记入残留,本轮不改 |

**残留(修复轮 1)**:

- 快捷短语是否按界面语言提供、已写入的内容如何处理,仍待 owner 决定(§6)。§9 的新 describe 钉住的是现状,不是结论。
- `ApprovalNewView.vue` 的草稿保存定时器在卸载时不清除。高负载下它可能在测试环境拆除后触发,使车道报 unhandled error(见上表)。这是既有代码,不属本片改动面。
- 浏览器车道本轮未重跑(理由见上)。
