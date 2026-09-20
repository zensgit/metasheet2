# 审批表单分组 Phase 4(切片 A-5:分组日常操作收口)— 设计 MD

**PROPOSED — 未过门审,未 ratify。** 这份 MD 只记录本切片的锁覆盖判断与实现取舍,不构成对锁文任何一行的裁决。

- 锁文(唯一 ratify 对象,只读):`approval-form-group-entity-design-lock-draft-20260916.md`,**v2.13 RATIFIED 2026-09-18**
- 输入报告:`groups-daily-ops-real-browser-acceptance-20260920.md`(真实浏览器验收,`68 PASS / 8 FAIL / 4 NOTE`,发现 8 条:P1-1/P1-2/P2-1..P2-5/P3-1)
- 本切片范围:报告 §5 的 **P2-1、P2-2、P2-3、P2-4、P2-5、P3-1** 六条发现。**P1-1/P1-2(中文组名 CHECK)不在本切片范围**——那是 #5907(名称规则勘误候选)的事,本切片不动 `atg_name_nonblank`/`atg_org_nonblank`/`atgl_org_nonblank` 三处 CHECK 的谓词。
- 基线:`origin/feat/approval-template-groups-phase3-sections-on-a2` @ `e90d16c90f58a58789a6acd589df362aaa2c2f42`
- 新分支:`feat/approval-template-groups-phase4-daily-ops`
- 依据的既有设计 MD:`approval-template-groups-phase1-design-20260918.md`(A-1 后端)、`approval-template-groups-phase1-fe-design-20260918.md`(A-2 前端,含 §8 合流记录)、`approval-template-groups-phase3-sections-design-20260918.md`(A-4 分节,含 §8 合流记录)

## 0. 处置原则(逐条对六条发现分类)

三个桶,和任务书给的判据一致:

1. **锁内**——锁文 §2/§3/§4 逐字要求或已 ratify 的行为——做,引用锁文行号。
2. **锁未点名但属既有条款的 UI 呈现**——不新增后端能力(不加端点、不改 DDL、不改 guard),只是把已经存在、已经真库测试过的端点/字段/客户端函数接上 UI,或修一个明显违反既有验收意图的实现缺陷——做,并引用支撑条款。
3. **锁外新能力**——需要新的端点、新的数据形状,或需要 owner 对一个锁文从未表态的问题作出裁决——不做,登记 OPEN,交 owner。

## 1. 锁覆盖矩阵

| 发现 | 桶 | 锁覆盖(行号) | 处置 | file:line |
|---|---|---|---|---|
| **P2-1** 面板对「已归档」零视觉区分 | 2(既有条款 UI 呈现) | 锁文 §2 `approval_template_groups` 表定义 `archived_at timestamptz NULL`(:87)是 ratify 的表形状;服务端 `listApprovalTemplateGroups` 已经把 `archivedAt` 序列化下发(A-2 设计 MD §2.1 DTO 映射);D6/D8(锁文 §4 行 B 归档语义、I8:87-96/155-156)要求「已归档组在管理面板里仍可见(历史可见)」——数据契约已经要求这一行存在,只是不要求它长什么样。加一个视觉标记(徽标 + 置灰 + `data-group-id`)是对**已经承诺存在的数据**的呈现方式选择,不是新增数据、新增端点或新增判定逻辑。 | 做 | `apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue`(模板 `data-testid="approval-template-groups-item-archived"` 行 + `.approval-template-groups-panel__item--archived`/`__badge` 样式) |
| **P2-2** 用户面错误文案是内部术语且内容有误 | 2(既有条款 UI 呈现,兼修一处不准确的既有实现文本) | `GROUP_NAME_UNSUPPORTED` **不是**锁文 §2/§4 的 ratify 码——它是 `ApprovalTemplateGroupService.ts` 自己文档承认的「implementer's choice」(该文件头注释:"an implementer's request-shape mapping, not a ninth ratified code"),因此改这句提示文案不触碰任何 ratify 条款,也不需要碰 §2 的 CHECK 本身(P1-1/P1-2 留给 #5907)。锁文 I7(:154)只钉了 guard 归属,不钉错误文案的具体措辞。 | 做 | 后端消息:`packages/core-backend/src/services/ApprovalTemplateGroupService.ts:180-192`(`mapGroupConstraintError`);前端映射表:`apps/web/src/approvals/api.ts`(`describeApprovalTemplateGroupError` + `APPROVAL_TEMPLATE_GROUP_ERROR_COPY`,新导出),消费方 `ApprovalTemplateGroupsPanel.vue` 的四处 catch 分支 |
| **P2-3** 分节计数与行数不一致 + 「加载更多」永远空转 | 2(既有条款 UI 呈现,修一个违反 §4 验收 C 意图的实现缺陷) | 锁文 §4 验收表行 C(:169)「每个 section 独立 page/pageSize」蕴含的不变量是「`total` 与实际可翻阅的行数一致」——`applyItemMove`(A-4 实现细节,非锁文条款本身)只抬 `total` 不管 `items`,让这条隐含不变量失守。修复不改变 `section=` 令牌形状、四桶判定谓词、分页参数形状,只改前端对移动结果的**呈现**逻辑。 | 做 | `apps/web/src/views/approval/TemplateGroupSections.vue`(`applyItemMove`/新 `refreshSectionRange`,约 :517-580 区) |
| **P2-4** 归档/取消归档/重命名/解除关联无 UI | 2(既有条款 UI 呈现,严格限定在锁内已有端点) | 七个端点(建/**改名**/**归档**/**解档**/挂接/解除/重排)是 §6 phase 1 ratify 的门(:195「1 落地」)之一,I7(:154)已经把写 guard 钉死为 `approvalTemplateAdminGuard`;A-2 设计 MD §1.2 明文自述这五个客户端函数「已在 api.ts 就绪待未来切片消费」。本切片**只**接「重命名」「归档」「取消归档」三个 UI——**不**新造「解除关联」UI,因为 A-4 的「移动到…」`<select>`(`TemplateGroupSections.vue`)已经是 link/unlink 的 UI 消费方(A-2 设计 MD §1.2 表「注意 link/unlink 例外」),面板层面再造一个会是重复入口而非缺口。 | 做(rename/archive/unarchive);**不做**(unlink UI,已有其他消费方,不是缺口) | `apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue`(`startRename`/`submitRename`/`onArchive`/`onUnarchive` + 对应模板按钮) |
| **P2-5** 选完组织后页面上再无切换入口 | 2(既有条款 UI 呈现)**+ 登记一条 OPEN** | 锁文 §2(:132)「首期必须……提供 session-org 选择入口」是 ratify 的要求本身;它没有 ratify「入口必须只在首次 403 时出现一次」这个实现细节——现有两处(A-2 面板、A-4 分节视图的 D3-1)都把「提供入口」实现成了**反应式**(只在 403 时短暂出现),持久化入口是对同一条款更完整的满足,不是新增条款要求的能力。**OPEN(逐字登记,不由本切片替 owner 决定)**:锁文 §4 验收 J(:177)「正控:单 org 成员从不见到选择器」原文写的是针对反应式实现的判据;本切片新增的第三个持久化入口用 `hasMultipleOrgs` 把这条正控的**精神**延续到新入口上(单 org 成员的 `session-orgs` 恰好一条,新入口也不出现),但这是**实现者选择**,不是 owner 对「持久 vs 反应式」「是否要求同一条正控适用于新入口」的裁决——owner 从未就这个问题表态(报告 §4.7/§5 P2-5 原文:「未见 owner 就此落过字,不替 owner 定性」)。本切片按任务书指令实现持久入口,登记为待 owner 事后确认的实现选择,不是既成裁决。 | 做(持久入口,`hasMultipleOrgs` 收窄)+ **OPEN**(是否接受这一实现选择 vs 要求别的形状,交 owner) | `apps/web/src/views/approval/TemplateCenterView.vue`(新 `useSessionOrg()` 实例 + `SessionOrgSwitcher` 挂载 + `onPageSessionOrgChange`) |
| **P3-1** 畸形 templateId 在 link/unlink 上吐 500 | 2(既有条款 UI 呈现的后端镜像:请求形状校验) | link/unlink 两个端点本身是锁文 §2/§6 ratify 的端点;`templateId` 格式校验是**请求形状**校验,同一档次的先例已经在这两个端点内(`APPROVAL_GROUP_ID_REQUIRED`、`resolveApprovalTemplateGroupOrgId` 的 400 分支)——都是「实现者按锁文以外的输入健壮性自行加的 400」,不改变端点对**合法输入**的行为(正控:合法但不存在的 uuid 仍然 404/204,不受影响)。 | 做 | `packages/core-backend/src/routes/approvals.ts`(`isWellFormedUuid` + 两处调用点,link :~1310、unlink :~1345) |

## 2. 逐条实现说明

### P2-1 —— 归档视觉区分

服务端从不过滤 `archivedAt`(`listApprovalTemplateGroups`,读端点契约见 A-1 设计 MD §2.1)。面板原先只渲染 `{{ group.name }}`,把归档/活跃两行渲染成逐字节相同的 DOM(报告 §5 P2-1 的同名探针复现)。修复:

- `<li>` 加 `data-group-id="group.id"`(报告点名的「连 id 属性都没渲染」直接解决)与条件 `data-testid`(`approval-template-groups-item` / `approval-template-groups-item-archived`);
- 归档行加一个 `Archived`/`已归档` 徽标 + 置灰样式类。

### P2-2 —— 错误文案

两处改动,分工明确:

1. **后端**(`ApprovalTemplateGroupService.ts`)把 `mapGroupConstraintError` 里那句「当前锁文 CHECK 只接受可打印 ASCII,纯中文名待 owner 勘误」换成不含「锁文/owner/勘误」内部治理词汇、且更准确的英文描述(「must include at least one ASCII letter, digit, or symbol」——描述的是「至少含一个」而不是报告 P1-2 指出的错误说法「只接受」)。这是**兜底**:任何没有前端映射表的直连调用方(裸 API)看到的也不再是内部黑话。
2. **前端**(`apps/web/src/approvals/api.ts`)新增 `describeApprovalTemplateGroupError(err, tr)`:对锁文/实现者定义的一个子集错误码(`GROUP_NAME_UNSUPPORTED`/`GROUP_NAME_REQUIRED`/`GROUP_NAME_TAKEN`/`GROUP_NOT_FOUND`/`GROUP_ARCHIVED`/`GROUP_NOT_ARCHIVED`/`GROUP_SORT_CONFLICT`/`APPROVAL_GROUP_ID_REQUIRED`)返回产品语言双语文案;**未覆盖的码保持 B1-04 既有契约——服务端消息原样透传**,不吞掉任何还没被产品化的具体原因。类型上键在真实的 `ApprovalTemplateGroupErrorCode` 联合上(`Partial<Record<...>>`),编译期防止键名腐烂。
   - **副产品(修一个既有缺口)**:补这张表时发现 `GROUP_NAME_UNSUPPORTED` **从未被加进** `ApprovalTemplateGroupErrorCode` 联合类型——这是 A-2 设计 MD §2.2 自己登记过的已知风险(「18 码一致性只由一次性脚本核对过,不是常驻守卫」),本次顺带补上,使其成为编译期可核对的第 19 个前端码(仍非 ratify 码,与另外两个既有的实现者请求形状码同一档次)。

### P2-3 —— 分节计数/行数一致性

见矩阵行的机制说明。核心不变量:一次移动结束后,任一受影响 section 的 `items.length` 与 `total` 必须自洽(要么相等 [complete],要么 `items.length < total` 且这条差值确实可以被下一次 `loadMore` 取到)。修复对 **源** 和 **目标** 两侧对称处理:

- 若该 section 移动前已持有其**完整**已知集合(`items.length >= total`,即 `hasMore` 为 false)——直接本地增删,零请求(与既有「移动到另一分组,不重新拉取任一 section」这条 pinned 测试完全兼容,验证 MD 会附机械证据)。
- 若该 section 移动前**不完整**(已经在分页中)——重新拉取它已加载过的页码范围(`refreshSectionRange`),替换 `items`/`total`/`hasMore`。页码位移在并发删改下不可能靠本地计数器猜出来,这是唯一能保证一致性的做法。

**求值,不删除**(按「失效标记要求值不作废整节」的纪律):「`loadMore`/一次未来的 `loadAll()` 会把它呈现出来」这句原话只活在 `TemplateGroupSections.vue`(`applyItemMove` 头部注释),不在 `phase3-sections-design-20260918.md` 的正文里——该设计 MD §5.3 本身没有逐字写这句(核对:`grep -n loadMore` 该文件,命中的三处都在别的段落,与本句无关)。修复没有把这句代码注释直接删掉,而是保留旧注释所在函数、整体改写成解释新机制的新注释,并在其中点名:旧行为(只抬 `target.total`)已被本轮替换,原因见验收报告 P2-3。`loadMore` 半句在「已分页」分支上**改由 `refreshSectionRange` 承担**(不再要求用户手动点「加载更多」);`loadAll()` 半句本来就一直成立(刷新页面必然重新拉取真实状态)。

### P2-4 —— 重命名 / 归档 / 取消归档

三个动作各自复用既有客户端函数,面板自己维护一个 `actionBusyId`(单槽,面板本就是单写路径串行)。归档前 `window.confirm` 一句话:说明「会解除该组下所有模板的关联」(Q4/I8 的既有语义),不打印成员数(没有端点返回这个数字,不编造)。三个动作成功后都 `emit('changed')`,复用既有的「面板改了东西→父组件重跑分节视图的 `loadAll()`」这条已存在的收口线(`handleGroupsChanged`),避免创建又一条状态不同步的路径。

`link`/`unlink`(解除关联)不在本轮新增 UI——`TemplateGroupSections.vue` 的「移动到…」`<select>` 已经是这两个函数的消费方(A-4,B/B′/B″/H 真库覆盖)。面板上再造一个「解除关联」按钮会是同一能力的第二个入口,不是缺口。

### P2-5 —— 持久会话组织切换入口

新增第三个独立 `useSessionOrg()` 实例(与面板、分节视图各自的实例并列,不共享 state——遵循 phase-3 设计 MD §8.4 已经定下的「不把分组列表上提到父组件共享一份 state」惯例的同一理由:每个消费方自己的验收行钉死了自己的调用次数)。

- 进入分组视图时调一次 `loadSessionOrgs()`(不是每次切回分组视图都调,用一个 `pageSessionOrgsRequested` 标记)。
- 渲染条件是 `hasMultipleOrgs`(`orgs.length > 1`),**不是**照抄考勤页「只要 ≥1 个 org 就显示」的字面行为——这是本设计 MD 唯一一处主动偏离「与考勤页同形」字面指令的地方,理由记在矩阵表与 §1「OPEN」条目:不这样收窄会让锁文 §4 验收 J 的「单 org 成员从不见到选择器」正控在**这个新入口**上变成假命题。
- 切换成功后调 `groupSectionsRef.value?.loadAll()` 与(若管理面板已展开)`groupsPanelRef.value?.loadGroups()`,同一条「通知别的呈现面重读」惯例。

### P3-1 —— 畸形 templateId

`isWellFormedUuid`(`routes/approvals.ts`)校验 `:id` 路由参数匹配标准 8-4-4-4-12 十六进制形态,校验放在 `resolveApprovalTemplateGroupOrgId` 之后、任何触及 `uuid` 列的查询之前。真库 census(`metasheet2_a5_20260920`,413 条迁移后)确认 0 行 `approval_templates.id` 不满足该形态,故此校验对任何真实数据都不收窄。

## 3. 明确不做(锁外新能力,登记 OPEN)

无——本轮六条发现里,唯一带 owner 未表态成分的是 P2-5(见 §1 矩阵「OPEN」列),其余五条全部落在「锁内」或「既有条款 UI 呈现」桶,不需要新的 owner 裁决即可实现。

## 4. 测试

见同批交付的 `approval-template-groups-phase4-daily-ops-verification-20260920.md`。摘要:

- 每条修复都有至少一个 vitest spec(前端)或真库用例(后端),先红后绿,红色输出贴在验证 MD;
- 新增测试全部落在**已经在 required web-tests exec 行 / plugin-tests.yml 真库清单里**的既有文件——本轮零新增测试文件,因此不需要新 spec token,也不触碰 s6a 的 `plugin-tests.yml`;
- `approval-template-groups-lifecycle.db.test.ts` 的新增 `P3-1` 用例 + 一条被本轮文案修复改写的既有断言(`P1-3`,该断言此前 PIN 的正是被修复的那句内部黑话——修复即证伪原断言,已按新文案改写,不是放宽判据)。

---

## 5. 第 2 轮(门审 `impl-gate-A5-daily-ops-round1-20260920.md` CHANGES-REQUESTED 后)

**本节仍是 PROPOSED,未过门审、未 ratify。** 输入:独立 Opus 门审 round 1,判定 **1 P1 / 1 P2 / 3 P3 / 3 NIT**,基线 head `beec0b8c7eca6129647c056216b6255b4634b4dd`。

### 5.0 对第 1 轮陈述的逐句求值(失效标记只让状态断言失效,不作废整节)

| 第 1 轮原句(位置) | 求值 | 处置 |
|---|---|---|
| §2 P2-5「新增第三个独立 `useSessionOrg()` 实例(与面板、分节视图各自的实例并列,**不共享 state**——遵循 phase-3 设计 MD §8.4 已经定下的『不把分组列表上提到父组件共享一份 state』惯例的同一理由」 | **SUPERSEDED(且当时的类比本身站不住)**。§8.4 说的是**分组列表**:列表的每份副本互相独立,各消费方的验收行各自钉自己的请求数。session-org 不是列表数据——`switchSessionOrg` 会**重铸 auth token**,`useSessionOrg` 的 `onAuthPrincipalChange` 随即清空**每一个**实例的 `orgs`,只有发起切换的那个把自己恢复回来。所以这两份副本不是独立的,是**互相摧毁**的(真浏览器实测:从分节视图的实例切换后整页零切换器)。§8.4 从来不是这件事的合法先例。 | 本轮改为**本页只有一个** `useSessionOrg()` 实例,经 `provide/inject` 下发 |
| §2 P2-5「本切片按任务书指令实现持久入口,登记为待 owner 事后确认的实现选择」 | **OPERATIVE**(未变)。持久 vs 反应式的**形状**仍是 owner 未表态的问题 | OPEN 保留,并**新增一个输入**:见 §5.4 |
| §1 矩阵 P2-5 行「`hasMultipleOrgs` 收窄……保住 §4 验收 J 的正控」 | **OPERATIVE**,但谓词本轮变成 `hasMultipleOrgs \|\| sessionOrgRequiredSeen` | 见 §5.1 对第二个析取项的论证(它**复现**旧的反应式可见规则,不是放宽 J) |
| §2 P3-1「真库 census 确认 0 行 `approval_templates.id` 不满足该形态,故此校验对任何真实数据都不收窄」 | **部分 SUPERSEDED**。census 本身成立,但它证明的是**已存储值**,不是**可接受的输入形态**。门审 A/B 实测:无连字符形与花括号形在修复前 201/204、修复后 400 ⇒ **确实是一次输入形态收窄** | 见 §5.5(`approvals.ts` 的注释按实测改写,过强声明已逐字撤回) |
| §2 P2-2「前端映射表返回产品语言双语文案」 | **OPERATIVE 但未闭合**:第 1 轮的文案不含任何规则说明 | 见 §5.6 |
| §2 P2-4「三个动作成功后都 `emit('changed')`」 | **OPERATIVE**,但不充分:`changed` 只驱动**分节视图**重读,面板自己的列表顺序不跟服务端 | 见 §5.7 |
| §4「本轮零新增测试文件」 | **OPERATIVE**,第 2 轮同样成立(全部新用例落在既有五个 spec 文件里) | — |
| 门审 §4 P1-A「(**推论,本轮未实测**)面板自己也持有一个反应式实例……管理员若已展开「管理分组」面板,应当出现第三个;相位 E 两次运行均未展开面板,实测值恒为 2」 | **该推论成立,现已实测**:本轮在 vitest(`expected 3 to be 1`)与真浏览器(`switchers=3 dup#ids=2 labelled=0/3`)两处各测一次,第 1 轮 head 展开面板后确实是 **3** 个;本 head 是 1 个 | 见验证 MD §8.3(a) / §8.7 |

### 5.1 P1-A(阻断)—— 本页只保留一个 `useSessionOrg()` 实例

**缺陷机制(门审已 CONFIRMED,本轮在 vitest 里独立复现)**:`useSessionOrg` 的 `onAuthPrincipalChange` 回调体是 `generation++; orgs.value = []; currentOrgId.value = null`,**每个实例都注册**;`switchSessionOrg` 在调 `auth.setExplicitSessionOrg` 之前把 `memberships` 存下、之后 `orgs.value = memberships` ——所以**只有发起切换的那个实例**能恢复。第一跳(多 org 未绑定)上页面级常驻实例与分节视图的反应式实例同时渲染,管理员点中后者 ⇒ 前者 `orgs` 永久为空 ⇒ `hasMultipleOrgs` 变假 ⇒ 常驻入口消失,且 `pageSessionOrgsRequested` 已为 true 挡住补拉。

**为什么修法只有这一个**:锁文 §2 逐字写「**考勤原文件与 `useSessionOrg.ts` 不动**」。本轮把这句按字面执行(不改一个字节),因此**不能**在 composable 里修 `onAuthPrincipalChange` 的跨实例清空。在「不改 composable」这个约束下,「一页一个实例」不是风格偏好,而是**唯一可用的修法**。

**实现**:
- `SessionOrgSwitcher.vue` 的普通 `<script lang="ts">` 块新增 `SessionOrgHost` 接口 + `SessionOrgHostKey: InjectionKey<SessionOrgHost>`。**不新建文件**:该文件已经在 `approval-web-guard.yml` 的两处 path 清单里、也有自己的 spec token 在 required exec 行上,新开一个 `.ts` 反而会落在两条 lane 的 path 过滤之外。
- `TemplateCenterView.vue` 建**唯一**实例并 `provide({ sessionOrg, notifySessionOrgRequired })`。
- `ApprovalTemplateGroupsPanel.vue` / `TemplateGroupSections.vue`:`const host = inject(SessionOrgHostKey, null)`;`const { … } = host?.sessionOrg ?? useSessionOrg()`。**有 host ⇒ 不调 `useSessionOrg()`**(一页恰一个实例,by construction);**无 host ⇒ 行为与第 1 轮逐字相同**(自己的实例、自己的切换器、自己的重试槽)——这正是让锁文 §4 验收 J 的 mutation(「去掉前端对该码的处理 ⇒ 停在 403」)在它们各自的组件级 spec 里**继续承重**的原因。
- 职责边界(写死):**host 拥有 fetch、渲染、重放;child 只上报「我被 SESSION_ORG_REQUIRED 挡住了」**。child 在 host 模式下把 `pendingRetry` 清空,由 host 的 `onPageSessionOrgChange` 重放 `loadAll()`/`loadGroups()`。
- **被丢掉的自动重放是刻意的**:面板的 `onCreate`/`submitRename`/`onArchive`/`onUnarchive` 在 host 模式下**不**自动重提到刚切换过去的组织——把一个写操作自动打到另一个 org 是危险而非便利;管理员自己再提交一次。面板的列表会回来(`loadGroups()` 成功即把 `sessionOrgBlocked` 置 false),这一点由新增用例压住,不是靠论证。
- 可见性:`v-if="pageSessionOrgHasMultiple || sessionOrgRequiredSeen"`。第二个析取项**复现**第 1 轮就存在的反应式可见规则(此前是 child 自己渲染 `<SessionOrgSwitcher>`,由该组件自身的 `v-if="loading || orgs.length > 0 || errorMessage"` 决定显不显);J 的正控依据是「**单 org 成员永远收不到该码**」,不是这个 `v-if`。
- `SessionOrgSwitcher.vue` 的写死 DOM id `session-org-switcher-select` 改为 `useId()`(Vue 3.5.24)。该 id 在 `approval-template-groups-phase1-fe-verification-20260918.md` P3-6 里被登记为「今天只有一个宿主,不是活缺陷」——本轮之前那个前提第一次变假(真浏览器 `duplicate#ids=2`)。现在是**按构造**每实例唯一,不再依赖「恰好只有一个宿主」。

### 5.2 P2-B(阻断)—— 目标侧「已分页」分支补判别用例

源码零改动,补的是**用例**。关键:门审建议的「把源侧用例角色对调」这个镜像写法**不判别** —— 目标 page1=10/total=11、移入一行后,修复前的 `target.hasMore = items.length < total` 同样算出 `10 < 12 = true`,计数同样显示 12。真正判别的是两条:①目标 page 1 的**刷新请求**(修复后恰 1 次,修复前 0 次);②服务端 post-move 的 page 1 **真的被渲染出来**(被移入的行出现在目标分节里)。用例按这两条写,mutation M2 当场变红(见验证 MD §8.3)。

### 5.3 三条 NIT 的处置

| NIT | 处置 |
|---|---|
| NIT-1 `data-testid` 条件式收窄(归档行不再匹配 `approval-template-groups-item`) | **不改,登记**。改成「通用 testid + `data-archived`」会动到本切片已经通过门审的 P2-1 判据面(`item` / `item-archived` 两个 testid 是 D2/D3 真浏览器判据引用的);属独立卫生切片,交 owner 决定是否另起 |
| NIT-2 无条件的一次 `/api/auth/session-orgs` 请求与兄弟 spec 的「reactive-not-proactive」惯例相反 | **在代码里逐字点名**(`TemplateCenterView.vue` 的 `ensurePageSessionOrgsLoaded` 注释)。兄弟 spec 钉的是**分节视图**「非 J 失败不查 session-org」,那条现在**更强**地成立:分节视图在 host 模式下**一次 session-org 请求都不发**。页面级入口无法是反应式的——它存在的意义就是「什么都没失败时也在」 |
| NIT-3 面板单槽注释陈旧(写「只有 loadGroups/onCreate」,实则五个写者) | **已改**(注释改写为五写者 + `actionBusyId`/`creating` 互斥的依据) |

### 5.4 交 owner(本轮新增一个输入,OPEN 不变)

第 1 轮登记的 OPEN(持久 vs 反应式形状)**仍然开着**,本轮给它加一个具体输入:页面级入口与两个反应式入口**不能各自持有 session-org state**(机制见 §5.0 第一行)。本轮的形状是「一个 state + 一个渲染入口 + child 只上报」;若 owner 想要别的形状(例如只保留反应式、或要求 child 也能渲染),`useSessionOrg.ts` 的跨实例清空就必须一起裁——而那个文件锁文写着不动,所以**那是一次锁文层面的裁决,不是实现者的裁量**。

### 5.5 P3-1a —— `approvals.ts` 的过强注释按实测撤回

取门审给的修法①(最小):注释逐字撤回「is not narrower than any real id」,改为如实陈述「**刻意**只接受规范 8-4-4-4-12 形态,PG 自己接受的其它文本形态(无连字符、花括号)一并拒绝」,并把 census 那句**重新定界**为「证明的是已存储值,不是可接受的输入形态——这是两个集合」。谓词**不动**(不取修法②的归一化):产品自己的客户端只回传从这些 API 读到的规范 id,一个 id 一种拼写让端点输入空间与真实调用方一致。

### 5.6 P3-2 —— 产品文案说出规则 + 给一个能通过的例子

`GROUP_NAME_UNSUPPORTED` 的文案改为:`Group names must contain at least one Latin letter, digit or symbol — for example, 请假Leave. Add one and try again.` / `分组名称需至少包含一个拉丁字母、数字或符号,例如「请假Leave」。请补充后重试。` 与后端兜底串(`must include at least one ASCII letter, digit, or symbol character`)同义、无内部术语。**带一个通过例**是刻意的:门审指出「这条文案对零宽垃圾名和正常中文名是同一句,用户无从判断 `请假Leave` 是能建成的」——只说规则不给例子仍然不闭合那半句。该句描述**今天**的行为;若 #5907 放宽名称规则,这句话必须一起改(已在代码注释里点名)。

### 5.7 P3-3 —— 归档/解档后按服务端顺序重读

服务端 `ORDER BY (archived_at IS NOT NULL), sort_order NULLS LAST, archived_at DESC NULLS LAST, name`(`ApprovalTemplateGroupService.ts:222`);归档置 `sort_order = NULL`、解档取 `MAX+1` ⇒ 两个动作都**移动行**。修法取门审给的第一条:`onArchive`/`onUnarchive` 成功后 `await loadGroups()`,让**服务端是唯一排序权威**——本地复排那个四键比较器会是又一个「更窄的同类物」。**重命名不重读**:改名按钮只对**活跃**行渲染,活跃行由唯一非空 `sort_order` 完全定序,`name`(最后一个键)永远轮不到决定它们的顺序。

### 5.8 残留 / 已知代价(登记,不藏)

1. `SessionOrgHostKey` 住在 `SessionOrgSwitcher.vue` 的普通 `<script>` 块里(而不是一个独立模块),理由见 §5.1;代价是这个展示组件现在多了一个非组件导出。
2. host 模式下 child 的 `pendingRetry` 恒空 ⇒ 被挡住的**写**动作不自动重放(§5.1 已说明为刻意)。
3. NIT-1 未处理(§5.3)。
4. 本轮**零新增文件、零 CI 文件改动、零迁移**——`approval-web-guard.yml` / `plugin-tests.yml` / 两个 `vitest.config.ts` / `run-required-web-tests.sh` 字节不变(验证 MD §8.5 机械取证)。
5. 真浏览器**只重跑了相位 E**(P1-A 打的那一相)。C(移动/分节计数)与 D(归档/解档/重命名 UI)两相未重跑:本轮没有触碰它们打的代码路径(P2-B 是纯用例;P3-3 只在面板动作成功后多加一次列表重读,它的顺序判据由新增 vitest 用例承担)。它们的真浏览器状态仍以门审 round 1 的记录为准。
6. **英文文案含一个中文例子**(`请假Leave`),理由见验证 MD §8.8——不是翻译泄漏。
