# 审批表单页优化 — 切片 1 设计件(无 DDL、无接口契约变更)

- 日期:2026-09-16。基线:`origin/main @ 857e29dd3`(前置普查基线;复核时 main 已到 `efaa80ea2`,唯一新增提交不碰审批文件)。
- 前置普查与对抗审:`reviews/approval-template-ux-prereqs-20260916.md`(私有;本件是它的落地契约,引用其 file:line)。
- **状态**:owner 已同意方向(三件便宜档);本件把范围钉死到可验收。**不含 DDL、不改任何 API 路由/请求/响应形状**。
- owner 不在电脑前期间我做的四个保守决定见 §5,每条可单独推翻。

## 0. 一句话

三个纯前端改动(外加两行后端文案):**模板 key 不再让用户填**(前端已有生成器,只是把输入框换成只读展示、PATCH 不再发 key)、
**用户可见用词「审批模板」→「审批表单」**(内层字段区改叫「字段」以消歧)、**分类输入接上已上线但无人调用的候选端点**。

## 1. 子切片 A — key 不可编辑

### 1.1 事实(已核)
- 输入框:`apps/web/src/views/approval/TemplateAuthoringView.vue:205-206`(`el-form-item label="模板 Key"`,`v-model="draft.key"`,`data-testid="approval-template-key"`)。
- 创建路由原样收客户端的 key:`packages/core-backend/src/routes/approvals.ts:806`。
- **前端已有生成器**:`apps/web/src/approvals/templateAuthoring.ts:2524` 的 `seedDraftIdentityForSave`(保存时播种)。
- 更新路径按 `request.key !== undefined` 守卫(`ApprovalProductService.ts:5948`)⇒ PATCH 不带 key 则该列不进 SET 子句。
- 列为全局 `UNIQUE`、无 org 隔离;重复键今天是裸 500,无泄漏亦无可用提示(`approvalErrorResponse` 不读 pg 消息)。
- **无任何消费方依赖"人取的键值"**(对抗审以正控独立确认:`approval_templates` 零 Kysely 链;自动化只读 `templateId`,从不读 `businessKey`)。

### 1.2 改动
1. 输入框改为**只读展示**(仍是 `el-input`,`readonly`,**保留** `data-testid="approval-template-key"`,值可复制)。
2. **PATCH 不再发送 `key`**;POST **仍然发送**前端生成的 key(`base.yml:4306` 的 `required` 不变)。
3. 播种**提前到建草稿时**(`createEmptyTemplateDraft` 之后立刻播种),使 `basicInfoIssues`(`:1856-1858`)不再对新草稿显示指向不可见字段的「模板 Key 必填」。

### 1.3 验收(已两两核对可同时成立)
| # | 判据 | 正控 / 机制 |
|---|---|---|
| A1 | 经 UI 保存已存在模板后,`approval_templates.key` **逐字节不变** | PATCH body 不含 `key` ⇒ `:5948` 不进 `metadataPatch`;测试:mutation 让 PATCH 带 key ⇒ 红 |
| A2 | 新建与编辑两条路径上,用户**不能修改** key(只读),但**能看到**生成值 | `readonly` 属性 + 输入事件不改变 `draft.key` |
| A3 | POST 仍携带 key,且为前端生成的形状 | 拦截 POST body 断言 `key` 非空;旧的 26 个前缀清理 / 37 个带 `key:` 的后端测试**零改动** |
| A4 | 新草稿在首次保存前**不显示**「模板 Key 必填」徽标 | 播种提前;负控:把播种挪回保存时 ⇒ 徽标出现、测试红 |
| A5 | 跨模板写入回归钉**保留判别力**:`approvalTemplateAuthoring.spec.ts:1498,1518,1538,1667,1673` 原用 key 输入框 `.value` 作唯一探针,改指向只读 key 展示的 `.value` **或** name 输入框,并用 mutation(强制装错模板)证其仍红 | 见 §5-D1 |
| A6 | B0 seed-gate(`:1705-1732`)的**不变量**("已存在模板的 key 不得被静默替换")仍有回归钉,只是钉在新机制上(PATCH 不发 key) | 见 §5-D1;不允许删除该不变量的钉 |

**互斥性说明**:不能写"零行为变更"——隐藏输入框本身就是行为变更;正确表述是**落库数据零变更(A1)+ 界面按预期变更(A2)**。
同理"不改测试"与 A2 互斥:27 行 spec 依赖该输入框,其中只做 `setInput('approval-template-key', …)` 把表单驱动到可保存态的**设置行**在播种提前后成为死代码,允许删除;**观测/断言行一律改指向,不删**。

### 1.4 明确不做
服务端生成 key(那是切片 2:要动 `required` 契约或忽略必填字段,并让 4 处 `WHERE key = $1` 断言失去判别力,还涉及出站事件的 `businessKey` 与 CSV 导出列——需设计锁 + owner 就"按 key 搜索去留"裁决)。

## 2. 子切片 B — 用词「审批模板」→「审批表单」

### 2.1 范围(实测)
- 两个审批目录 113 行 / 21 文件 + 路由 `titleZh` 4 行(`appRoutes.ts:378,398,404,410`)+ 后端 2 行(`ApprovalBreachNotifier.ts:239,264`)= **119 行**。无 i18n 机制,除 2 个标签表外全是硬编码字面量。
- **内层消歧**:「表单」已在同目录 63 行 / 20 文件指模板内的字段区。两条有代码背书的内层改名:`id:'fields'` 的 `label:'表单设计'` → **「字段设计」**;`id:'fieldPermissions'` 的 `label:'表单权限'` → **「字段权限」**。
- 其余散文里的「表单」(`TemplateAuthoringView.vue:6`、`ApprovalNewView.vue:108,136,191,1564`、`ApprovalDetailView.vue:134,231` 等)**本切片不动**,列入 PR body 交 owner 定(§5-D2)。

### 2.2 禁改边界(逐条零 diff)
表名、API 路由、权限 key、TS 类型名、Vue 文件名、路由 `name`/`path`、`data-testid`、RATIFIED 串(`表单内联系人*` 是字段修饰语,不受外层改名影响)、多维表投影列名。机制上这些标识符不含 CJK,一次文案改动碰不到它们;PR body 附 grep 证据。

### 2.3 验收
| # | 判据 | 正控 |
|---|---|---|
| B1 | 用户可见文案零「审批模板」(`git grep` 用户可见面 = 0;fixture 里作为**模板名字数据**的 `'通用审批模板'` 等**不算**) | 改前同 grep 命中 119 |
| B2 | §2.2 边界逐条零 diff | `git diff --stat` 不含表名/路由/类型文件的标识符变更 |
| B3 | 两条内层改名落地 | grep 新标签各 1 处 |
| B4 | **11 条钉文案的断言按新文案重钉**(不删):`approval-breach-notifier.test.ts:244`、`approval-e2e-lifecycle.spec.ts:658`、`approval-e2e-permissions.spec.ts:913,1186,1196`、`templateCenterI18n.spec.ts:466,494,527,611,623`、`approvalDelegationForm.spec.ts:25`、`approvalMetricsTopnReport.spec.ts:224`、`approval-template-authoring-errors.test.ts:27`。六个 FE token 都在 `run-required-web-tests.sh` 的 exec 行上 ⇒ 这些是**合并阻塞**,不是记账 | 每条改前红、改后绿 |

## 3. 子切片 C — 分类输入接候选端点(分组便宜档)

### 3.1 事实
- `approval_templates.category TEXT`(可空)+ 部分索引;`GET /api/approval-templates/categories` **已上线但无人调用**(正控:同 grep 找到 `updateTemplateCategory` 在 `TemplateDetailView.vue:780`)。
- 两个写入面都是裸 `el-input`:`TemplateAuthoringView.vue:210-218`(`data-testid="approval-template-category"`)、`TemplateDetailView.vue:99-110`(`data-testid="template-detail-category-input"`)。打错字就静默多出一个分组。

### 3.2 改动
两处改为**可输入的候选下拉**(候选来自该端点,**允许新建**,不退化成闭集);**新控件内部仍须渲染一个 `<input>` 且该 `<input>` 挂原 testid**。

### 3.3 验收
| # | 判据 | 正控 |
|---|---|---|
| C1 | 两处输入均从端点取候选;输入不在候选内的值仍可保存 | 拦截 GET 断言被调用;保存新值后 PATCH body 含之 |
| C2 | 零服务端变更、零契约变更 | `git diff` 不含 `packages/core-backend` |
| C3 | 三处以裸 `HTMLInputElement` 语义驱动这两个 testid 的 spec(`approvalTemplateAuthoring.spec.ts:1355` 经 helper `:423-427`;`templateDetailI18n.spec.ts:600-602,616-618`,带 `!` 非空断言)**继续通过**;做不到则最小改动并逐条披露 | 改前绿 |

**互斥性说明**:C2 与"顺便给 `listTemplateCategories` 补 status 过滤"互斥(会打破 `approval-wp4-template-categories.api.test.ts:305`);C 与"中心页分组分节渲染"互斥(打破 `approvalTemplateCenterCategory.spec.ts:491`,且分页下只能得到跨页撕裂的分组)。两者都**不进本切片**。

## 4. 交付形态与门

- 一条分支、**三个提交**(A / B / C 各自可单独回滚)、一个 Draft PR;含本设计件与验证件(`approval-form-ux-slice1-verification-20260916.md`,闸后补)。
- 实现 Sonnet;**独立闸 Opus**(refute-first,默认 REJECT);修复轮必重跑闸。
- **测试纪律**:每处测试改动必须是"按新文案/新机制重钉",判别力不降;唯一允许删除的是 §1.3 所述的纯设置行,闸逐行核。
- 前端必需闸 `apps/web/scripts/run-required-web-tests.sh` 那一行不需要动(无新 spec 文件);若加新 spec 则加 token 并做双向子串碰撞检查。

## 5. owner 不在期间我做的保守决定(每条可推翻)

| # | 问题 | 我的决定 | 理由 |
|---|---|---|---|
| D1 | B0 seed-gate 回归钉:重设计还是删除 | **重设计**:同一不变量改钉在"PATCH 不发 key"上 | 仓内纪律:不删测试换绿;不变量本身仍真 |
| D2 | 散文里的「表单」怎么改 | **不动**,只做两条代码背书的内层改名 | 那是文案取舍,owner 的活 |
| D3 | 「模板 Key 必填」徽标的修法 | **播种提前到建草稿时**(而非改校验器) | 校验器语义不变;受影响的 5 条测试按新时序重钉 |
| D4 | 分类控件选型 | **必须内含挂原 testid 的 `<input>`** | 三处 spec 用裸 DOM 语义,不想为选型改测试 |

## 6. 不在本切片、等 owner 的

Q1 按 key 搜索去留(阻塞切片 2);Q2 散文「表单」;Q3 分组实体是否 org 作用域(阻塞正式档——`approval_templates` 至今无 org 列,分组表会是模板侧第一个 org 作用域对象);中心页分组分节渲染(需端点配合分页)。
