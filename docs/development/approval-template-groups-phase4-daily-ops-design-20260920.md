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
