# 审批表单分组 Phase 3(切片 A-4 分期 3:section 分节 + 重排)— 设计 MD

- 锁文(唯一 ratify 对象):`approval-form-group-entity-design-lock-draft-20260916.md`,**v2.13 RATIFIED 2026-09-18**(全文见 `/Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/approval-form-group-entity-design-lock-draft-20260916.md`)
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片 `A 分组 / A-4 分期 3`)
- 实现任务书:`impl-taskbook-A-grouping-20260918.md` §2「分期 3」(W10–W14)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md`「lane A(分组)」#5–#7(#5=J/C 的 section 400 挪分期 3;#7=前端 spec 位置)
- 本文档所在分支:`feat/approval-template-groups-phase3-sections`(worktree `wt-groups-p3`),堆叠基线 = `feat/approval-template-groups-phase1` 的 A-1 第 7 轮门审头 **`a728ed655`**(A-1 Draft PR #5852,DRAFT-READY 0 P1/0 P2/4 P3)
- 本文档写作时 worktree HEAD:`6e2e48a7c94499bee6e0e2b622a9f238309ca6ef`
- 下文所有 `file:line` 都是**对本 HEAD 现场 `grep -n` 的结果**,不是照抄锁文基线的行号(锁文行号仅在直接引用锁文条款时保留,并标注「锁文行号」)。
- 本切片 = A-1 之后的 12 个功能提交(`51878dd08`…`27bb6edfe`)+ 2 个文档提交(本次新增),不含 A-2(session-org 共享组件)与 A-3(分期 2 按 category 建组)——A-4 直接堆叠在 A-1 之上,**不含** A-2 的 `SessionOrgSwitcher.vue`(见 §6「留给后续」)。

## 0. RATIFY 记录(原样引用锁文抬头,不改写)

> **RATIFY 记录(2026-09-18)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、#5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **裁决结果(按建议值)**:Q3 分组按 org 作用域,`org_id` 只取 `req.authenticatedTenantId` = **是**;Q4 归档不保留成员、解档得空组 = **是**;**Q5 `?category=` 与 `/categories` 首期不动、分期 3 再裁**;分期 2(按现有 category 建组并挂接)= **要**,做成预览→执行→可回滚的管理员操作;`key` 全局唯一 = **另立锁**,不顺带。§7 第 2 项(§2 两表形状 + 锁序表 + I1–I8)按 v2.13 ratify。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR 一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

**本切片(A-4)的地位**:锁文 §7 把 Q5(「分期 3 时 `?category=` 过滤与 `/categories` 端点的去留」)明写为「首期不动,**分期 3 再裁**」——即 owner 在 ratify 时刻把 Q5 的实际决策**推迟到本切片**,不是一次性裁完。本切片不含 DDL(复用 A-1 已建的两张表,零新迁移),但仍是新写路径(reorder 端点),交付形态照常先 Draft(任务书 §1「DDL owner 闸(贯穿性)……分期 3 的重排端点不含新 DDL……但仍是新写路径,交付形态照常先 Draft」)。

## 1. 范围 / 不在范围

### 1.1 本切片(A-4)包含 —— 逐条对锁文 §

| 内容 | 锁文出处 | 本文档章节 |
|---|---|---|
| `section=` 三令牌/四桶列表(`group:<id>` / `ungrouped` / `category:<name>`) | §4 验收 C;§6「期 3」 | §2 |
| `category` 后备桶(从未关联 + 非空 category) | §4 验收 D | §2.3 |
| 每 section 独立分页,`total` = 该桶自己的计数 | §4 验收 C「每个 section 独立 page/pageSize」 | §3 |
| J 行「未知 `section=` 令牌 ⇒ 400」+ C 行「`?category=` 与 `section` 同现 ⇒ 400」(补充清单 #5 挪期) | §4 验收 J、C;补充清单 #5 | §2.4 |
| 重排端点(该 org 全部活跃组的完整 1..n 排列) | §3 I3;§4 验收 E 后半;§6「期 3」表第 3 行 | §4 |
| 前端「分组视图」:section 渲染、每 section 独立"加载更多"、`group:` 分组上移/下移、模板项按下拉移动分组 | §6「期 3」表第 3 行「拖拽归组」(本切片以键盘可操作控件替代原生 HTML5 拖拽,见 §5) | §5 |
| 两个新 `.db.test.ts`(sections/reorder)+ 两点 CI 接线 + s6a 重钉 + 新增 `*-ci-wiring.test.mjs`(补 A-1 遗留的闭世界缺口) | §6「期 1」门原文对两个 A-1 文件提的要求,本切片同法应用到四个文件 | 验证 MD |

### 1.2 本切片明确不做(逐条引用锁文 § 与去处)

| 项 | 锁文出处 | 去处 / 理由 |
|---|---|---|
| 两个写入面(`TemplateAuthoringView.vue:211-218`、`TemplateDetailView.vue:99-110`)换成分组选择器(I4 生效) | §6「期 3」表第 3 行;任务书 W12 | **未做**——TemplateGroupSections.vue 头注释原话「the two write-face group selectors (I4) are deferred (needs the session-org entry point extended to those two surfaces plus a defined create-then-link failure contract; owner 勘误候选,not implemented here)」。I4「生效时点 = 分期 1 落地、两个写入面换成分组选择器之时」(锁文 I4)在本切片仍未触发——两个写入面维持裸 `el-input`,继续写 `category`,与 phase1 设计 MD §1.2 记录的现状一致 |
| Q5 本身的裁决(`?category=` 过滤 / `/categories` 端点去留) | §7-2″ | **未裁,仍 OPEN**——见 §7;本切片**不删、不改** `GET /api/approval-templates/categories`(`routes/approvals.ts:539` → `listTemplateCategories`)与既有 `?category=` 等值过滤,两者原样保留 |
| A-2 共享 `SessionOrgSwitcher.vue` + `useSessionOrg` 前端接线 | §2「多 org 成员」;验收 J 前端半;目标文档切片清单归 A-2 | 本切片堆叠在 A-1(`a728ed655`)之上,**不含** A-2 的任何提交——`apps/web/src/components/SessionOrgSwitcher.vue` 在本分支不存在(见 §6) |
| 分期 2(按现有 category 建组并挂接) | §6「期 2」 | 另一条并行 lane(A-3),与本切片无依赖关系 |
| 硬删分组端点 | §5「明确不做」 | 不排期,与 A-1 一致 |
| 模板在分组内的排序 | §3 I3「模板在分组内首期无排序」;§5 | 本切片重排**只**对 `group:` 分组本身排序,不对分组内的模板项排序——前端 `TemplateGroupSections.vue` 中「模板项从不重新排序」是与此对应的实现事实(`:12` 头注释) |

## 2. `section=` 四桶判定谓词(§4 验收 C/D)

### 2.1 三令牌解析(`parseApprovalTemplateSectionToken`,`ApprovalTemplateGroupSectionService.ts:44-54`)

| 令牌形状 | 解析结果 | 锁文出处 |
|---|---|---|
| 字面量 `ungrouped` | `{ kind: 'ungrouped' }` | §4「三个令牌、四个桶」 |
| `group:<id>`(按**第一个** `:` 切分) | `{ kind: 'group', groupId }` | §2「令牌按第一个 `:` 切分,name 原样」 |
| `category:<name>`(按第一个 `:` 切分,name **原样**,不 trim、不大小写折叠) | `{ kind: 'category', name }` | 同上——`normalizeTemplateCategory`(`ApprovalProductService.ts:4280`)只 trim + 64 上限,从不拒绝 `:`,故 `category:HR:Onboarding` 的 name 是 `HR:Onboarding` |
| 空串 / 无冒号且非 `ungrouped` / `group:`(空 id)/ `category:`(空 name)/ 冒号在首字符 / 前缀大小写不匹配 / `ungrouped` 带后缀 | `null` → 路由层 400 `APPROVAL_TEMPLATE_SECTION_TOKEN_INVALID`(§4 行 J) | 见 §2.4 |

纯函数,零 DB 依赖,由 `tests/unit/approval-template-group-section-token.test.ts` 的 13 个 `it`/`it.each` 案例逐一钉死(含 8 个 `null` 反例,见验证 MD §3)。

### 2.2 四桶 SQL 判定(`buildSectionBucketCondition`,`ApprovalTemplateGroupSectionService.ts:75-127`)

**org 谓词落在 EXISTS/NOT EXISTS 子查询里,不落在外层**(`approval_templates` 无 org 列,锁文 §1)——三个桶各自的子查询都带 `l.org_id = $1`(与 A-1 §2「SELECT 必须带 org 谓词」/ 验收 A″ 同一纪律,应用到读路径而非行锁):

| 桶 | 令牌 | SQL 判定(现场 `:line`) | 锁文出处 |
|---|---|---|---|
| ① | `group:<id>` | `EXISTS (… l.org_id=$1 AND l.template_id=t.id AND l.group_id=$N)`(`:87-90`) | §2「有效关联」= `group_id IS NOT NULL`,`atgl_state_check` 已把它与 `unlinked_at IS NULL` 配对,单条件即可 |
| ②+④ | `ungrouped` | `EXISTS(...group_id IS NULL) OR (NOT EXISTS(...) AND (category IS NULL OR category=''))`(`:98-110`) | §4 验收 C「`ungrouped`(② 有关联行但 `group_id IS NULL` ∪ ④ 无关联行且 `category IS NULL OR category=''`)」 |
| ③ | `category:<name>` | `NOT EXISTS(...) AND category IS NOT NULL AND category<>'' AND category=$N`(`:117-124`) | §4 验收 C/D;I2′「`NOT EXISTS` 判定谓词」 |

**桶 ③/④ 的 `NOT EXISTS` 谓词是 A-1 锁文 §3 I2′ 判定谓词的逐字复用,非重新发明**——A-1 锁文原文(§3):

> 判定谓词 = `NOT EXISTS (SELECT 1 FROM approval_template_group_links WHERE org_id = $org AND template_id = $tpl)`

本切片桶 ③/④ 的 `NOT EXISTS` 子查询(`:104-107`、`:118-121`)与该谓词的表/列/组合逐字一致,只是把 `$org`/`$tpl` 换成参数化占位符 `$${orgIndex}`/`t.id`(外层查询的自然连接变量),没有引入第二套「是否从未关联过」的判定逻辑——这正是 A-1 设计 MD §6「留给后续切片的项」里点名的「I2′ 判定唯一消费方(`section=` 列表端点)也在 A-4 才存在」的兑现点,该行原话:「A-4 落地端点时须对该端点重做台账」——本切片桶③/④与 §4 D 行 mutation(同 B′:「后备判定改成『当前 `group_id IS NULL`』」)共同构成这份重做的台账,见验证 MD §4。

`OR category = ''` 半句(`:108`)是 v2.6 P2-A 修法的逐字落地——锁文原句(§4 验收 C):「`section=ungrouped`……② 有活跃关联 ∪ ④ 无关联行且 **`category IS NULL OR category = ''`**——与 D 的 `<> ''` 收窄配对,否则空串行落零 section」。

### 2.3 Row → DTO 映射复用(不新造第二套 DTO 转换)

`listApprovalTemplatesBySection`(`ApprovalTemplateGroupSectionService.ts:140-184`)的 `SELECT t.*` 结果经 `ApprovalProductService.ts` 导出的 `TemplateRow` 类型与 `toApprovalTemplateListItemDTO` 函数映射(该服务文件本轮把两者从模块私有改为 `export`,`ApprovalProductService.ts:245`/`:4081` 附近,diff 见 `git diff a728ed655..HEAD -- packages/core-backend/src/services/ApprovalProductService.ts`)——`section=` 响应的 `data[]` 形状因此与既有 `GET /api/approval-templates` 逐字节一致,不是并行的第二套映射会漂移的风险。

### 2.4 J/C 两句 400(补充清单 #5 挪期落地,`routes/approvals.ts:634-680`)

A-1 设计 MD §6 把这两句列为「留给后续切片」,原话:

> J 行「未知 `section=` 令牌 ⇒ 400」→ 补充清单 #5:锁文勘误请示 owner,挪到 A-4(分期 3)门,`section=` 到分期 3 才存在
> C 行「`?category=` 与 `section` 同现 ⇒ 400」→ 同上,挪到 A-4

本切片落地位置:`GET /api/approval-templates` 路由 handler 内,`section=` 分支的最前面(`:648-680`,先于任何 DB 访问):

1. **`section` 与 `category` 冲突**(`:649-655`):`isOrgIdValuePresent(req.query.category)` 为真 ⇒ 400 `APPROVAL_TEMPLATE_SECTION_CATEGORY_CONFLICT`。
2. **未知/非法 `section` 令牌**(`:660-667`):`sectionRaw` 非字符串(含重复 `?section=a&section=b` 解析成的数组)或解析失败 ⇒ 400 `APPROVAL_TEMPLATE_SECTION_TOKEN_INVALID`。

**实现者裁量,写明供门审核实**:`isOrgIdValuePresent`(`:350-354`)是 A-1 为 `orgId` 请求体/查询串检测而写的辅助函数,本切片复用它检测 `category` 查询参数是否「出现」(含数组形态)——函数名字面上是为 `orgId` 设计的,复用到 `category` 场景是命名与用途的不对齐,但行为正确(它的递归数组语义——「非空数组即算出现」——对 `?category=a&category=b` 同样适用,验证 MD §4 的「C/J: malformed section requests」用例已实测这条数组分支确实经这个调用点触发,不只是经 `resolveApprovalTemplateGroupOrgId` 自己的调用点触发)。是否要为 `category` 场景单独抽一个同义辅助函数是门审可核对项,不是缺陷。

两句 400 的判定顺序(先 category 冲突,后 token 合法性)是实现者选择——两者都在任何 DB 访问之前,顺序不影响最终状态,只影响两者同时触发时返回哪一个码;测试(验证 MD §4)按当前实现顺序断言,未单独测过反序。

## 3. 分页形状(§4 验收 C「每个 section 独立 page/pageSize」)

- 请求:`GET /api/approval-templates?section=<token>&page=<n>&pageSize=<m>`(与既有 `listTemplates` 同一对 `page`/`pageSize` 参数名,路由内经 `resolveApprovalListPaging` 转换成 `limit`/`offset`,`:636-637`,本切片未新增分页参数形状)。
- 响应:`{ data, total, limit, offset, section }`(`:670-676`)——`total` 是**该桶自己的行数**(`SELECT COUNT(*) … WHERE <同一 WHERE 子句>`,`ApprovalTemplateGroupSectionService.ts:167-170`),不是全部 section 的并集计数,也不是该 org 的模板总数(验证 MD §4「C: pagination」用例用一条桶外控制行验证这一点)。
- **跨请求一致性不作承诺**——锁文原文(§4 验收 C):「独立请求之间不承诺跨时刻一致」。前端 `TemplateGroupSections.vue` 对每个 section 各自发起独立请求(`loadAll`/`loadMore`,`:270-337`),两次请求之间若发生归组变更,允许出现暂时的不一致,不是缺陷(任务书 §5 风险清单原话)。
- 前端「加载更多」不用 `el-pagination`(N 个独立 section 游标用一个共享分页控件不自然),改为每个 section 一个手动"加载更多"按钮,`hasMore` 判据是 `items.length < total` 的真实剩余量检查,不是 `page * pageSize < total`(后者对短页/整页边界都会算错,`TemplateGroupSections.vue:310-313` 注释自陈理由)。

## 4. 重排端点的事务与锁序(§3 I3;§4 验收 E 后半;§6 表第 3 行)

### 4.1 端点(`routes/approvals.ts:1288-1303`)

```
POST /api/approval-template-groups/reorder
Guard: authenticate, approvalTemplateAdminGuard(与其余六个 A-1 写端点同一常量)
Body:  { groupIds: string[] }  — 该 org 全部活跃组的完整排列,不是增量
```

请求体形状校验(数组、每项非空白字符串)在**任何 DB 访问之前**完成(`:1292-1296`),失败 ⇒ 400 `GROUP_REORDER_IDS_REQUIRED`——与本文件其余六个端点「先解析 org / 校验请求,再碰 DB」的一贯纪律一致(`:1216` 附近的既有注释「Every handler resolves `orgId` … FIRST — before any query」)。

### 4.2 锁序(§2 锁序表「重排 L0→L1(该 org 全部活跃行)」)

`reorderApprovalTemplateGroups`(`ApprovalTemplateGroupReorderService.ts:111-142`),逐语句锁序:

| 步骤 | 语句 | file:line | 锁 |
|---|---|---|---|
| 1 | `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` | `:117` | 无锁,但**必须是 `BEGIN` 后第一条语句**(与 A-1 四条 L0 路径同一纪律——晚置在 RR 默认下报 `25001` 并中止整事务) |
| 2 | `SELECT pg_advisory_xact_lock(hashtext($1))`,key = `'atg:' + orgId` | `:118` | **L0**,与 A-1 六条既有路径共用同一把顾问锁 |
| 3 | `SELECT id FROM approval_template_groups WHERE org_id=$1 AND archived_at IS NULL ORDER BY id FOR UPDATE` | `:119-122` | **L1**(批量,该 org 全部活跃行;`ORDER BY id` 只为锁等待轨迹的确定性,非正确性必需——见 `:103-106` 注释:任何其他写者都先取 L0,已经把这条事务与之全序化) |
| 4 | `validateApprovalTemplateGroupReorderIds(orderedIds, activeIds)`(纯函数,零 DB) | `:123-126` | 在 L0+L1 临界区**内**读到的 `activeIds` 上做 SET 相等校验——与 §2「无 TOCTOU 窗口」的要求一致:校验用的快照与随后写入用的是同一个 | 
| 5 | N 条 `UPDATE approval_template_groups SET sort_order=$3 WHERE org_id=$1 AND id=$2`(每行一条,`sortOrder = index+1`) | `:129-136` | 仍在同一事务/L0/L1 临界区内 |

**六条路径(A-1 的五条 + 本切片重排)的锁序表全部满足 L0<L1<L2 递增或止步于 L0/L1,无一路径反向获取**——重排本身不碰 `approval_template_group_links`,故止于 L1,不涉及 L2(`ApprovalTemplateGroupReorderService.ts:13-14` 头注释:「reorder never touches `approval_template_group_links`, so there is no L2」)。

### 4.3 `atg_sort_unique` DEFERRABLE 约束的利用(§2 DEFERRABLE 三条副作用)

约束定义:`packages/core-backend/src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts:58`:

```sql
CONSTRAINT atg_sort_unique UNIQUE (org_id, sort_order) DEFERRABLE INITIALLY DEFERRED
```

重排的 N 条 `UPDATE` **逐行顺序写**而非「先清 NULL 再统一写」的两阶段舞步——利用的正是 DEFERRABLE 副作用③(约束只在 **COMMIT** 时检查):写第 K 行 `sort_order=k` 与写第 K+1 行之间,事务内部完全可能出现瞬时重复(例如把 `sort_order=1` 从组 A 移到组 B 之前,组 B 短暂持有旧值),这在语句级别合法,只在 COMMIT 时校验(锁文原句:「重排事务内允许中间态重复,提交时校验」——`ApprovalTemplateGroupReorderService.ts:21-26` 头注释与迁移文件 `:53` 注释引用同一条 DDL 注释)。这是本切片相对「两阶段清空再写」这种更保守写法的一个明确设计选择,依赖的正是 A-1 已经 ratify 的约束形状,不是本切片新增的约束行为。

### 4.4 约束错误映射(与 A-1 同码,非新造)

`mapReorderConstraintError`(`ApprovalTemplateGroupReorderService.ts:44-56`)是 A-1 `ApprovalTemplateGroupService.ts` 私有 `mapGroupConstraintError` 的**复制**,不是共享导入——头注释(`:6-11`)说明理由:并行的分期 2(A-3)lane 正在把 `ApprovalTemplateGroupService.ts` 重构为 `WithClient` 原语,本切片对它唯一的真实依赖只是这一段约束映射,体量小到不值得跨两条并发变化的 lane 做导出/导入耦合。映射结果:

| 约束 | 触发条件 | 映射结果 | 与 A-1 关系 |
|---|---|---|---|
| `atg_sort_unique`(23505) | 重排写入的 `sort_order` 与另一并发写入的值在 COMMIT 时冲突 | 500 `GROUP_SORT_CONFLICT` | **复用 A-1 已 ratify 的同一个码**(A-1 §2「DEFERRABLE 副作用③」),不是本切片新码 |
| `uq_atg_org_name_active`(23505) | 重排的 `UPDATE` 从不写 `name`,今天不可达(见下) | 409 `GROUP_NAME_TAKEN` | 同上——保留这条分支是防御性的,供未来若某次重排语句改为也写 `name` 时仍有类型化码,而非让裸 23505 经 `handleApprovalsError` 的通用 500 泄漏出去(`:38-42` 头注释原话) |

### 4.5 请求形状校验(纯函数,§3 I3「排列缺项/多项/含归档组」)

`validateApprovalTemplateGroupReorderIds`(`ApprovalTemplateGroupReorderService.ts:74-100`)对四种不匹配形状(缺项/多项/重复/含归档组或外部 id)统一抛同一个 `ServiceError`(400,`GROUP_REORDER_SET_MISMATCH`)——不是每种形状一个专属码。理由(`:67-72` 注释):客户端可观测的事实在四种情况下完全相同——「你发来的列表不是这个 org 当前的活跃组集合」——而 `activeIds` 参数按约定只包含活跃组 id,一个已归档组的 id 在这里与一个从未存在过的外部 id 无法区分(两者都只是没通过 `activeSet.has(id)`)。

## 5. 前端分节 / 上移下移(`TemplateGroupSections.vue`,新文件,583 行)

### 5.1 挂载方式(不影响既有测试)

`TemplateCenterView.vue` 新增一个 `viewMode`(`'flat' | 'grouped'`,默认 `'flat'`)的视图切换按钮组;既有的管理表格/申请人画廊整块包进 `v-if="viewMode === 'flat'"`,`TemplateGroupSections` 作为**兄弟模板**(`v-else`)而非既有表格的包装层——诊断:若把新分组视图合并进既有表格自身的 `v-if`/`v-else` 对,会让画廊的 `v-else` 分支在「分组模式 + 非管理员」时也意外触发(`TemplateCenterView.vue` 新增注释原话,`:113-119`)。默认值保持 `'flat'`,故 `approvalTemplateCenterCategory.spec.ts`/`templateCenterI18n.spec.ts` 等既有 spec 在从不触碰 `viewMode` 时行为逐字节不变(验证 MD §5 已重跑确认)。

### 5.2 分组上移/下移(§3 I3 / §4 验收 E 后半 / §6 表第 3 行)

每个 `group:<id>` section 的表头带 ▲/▼ 两个按钮(`data-testid="template-group-section-move-up-<token>"`/`move-down-...`),点击后:

1. 在**当前渲染的** `group:` 分组顺序(`groupTokenOrder`,`:259`,不是活跃重新拉取)里与相邻项交换;
2. 组装该 org 全部活跃组 id 的完整排列,调用 `reorderApprovalTemplateGroups`;
3. 成功 ⇒ 按响应的 `sortOrder` 重排 `sections` 里的 `group:` 项(不重新拉取任何 section 的内容——`applyGroupOrder`,`:377-384`);失败 ⇒ 非阻塞行内错误(`reorderError`),顺序保持移动前的状态。

`reorderingToken` 在请求进行中禁用全部上移/下移按钮,防止第二次点击与同一个 L0 临界区竞争。`ungrouped`/`category:<name>` 两类 section 从不显示这两个按钮(`v-if="isGroupToken(section.token)"`,`:112`)。

### 5.3 「拖拽归组」的实现替代(明确的设计选择,非缺失)

锁文 §6「期 3」表第 3 行原文写「拖拽归组」;本切片**没有**实现原生 HTML5 拖放,而是给每个模板项一个键盘可操作的 `<select>`(「移动到…」)。这是一个**有意的、已写明的替代**,理由与先例(`TemplateGroupSections.vue:16-19` 头注释):

- 与仓内既有先例 `TemplateAuthoringView.vue` 的步骤重排「上移」/「下移」按钮同一套惯例(该文件本身也不用原生拖放);
- 键盘可操作的输入面覆盖面**等于或宽于**鼠标拖放(拖放操作本身通常也仍需一个非拖放的键盘替代方案才能满足可访问性,而 `<select>` 本来就是键盘原生的),不是缩窄。

`<select>` 调用的是 A-1 phase-1 已经真库测试过的 link/unlink 端点(`linkApprovalTemplateToGroup` / `unlinkApprovalTemplateFromGroup`,B/B′/B″/H 覆盖),不是新写路径。

**目标集规则**(`moveTargetsFor`,`:393-401`,三条边界,均在头注释里逐条写明理由,不是隐式行为):

1. 目标只从**当前渲染的** `group:` 分组取,不做移动瞬间的活跃重新拉取——与分组重排同一「可接受的过期」惯例;若目标在加载与点击之间被别人归档,呈现为端点自身的 409 `GROUP_ARCHIVED`,按普通失败处理(非阻塞行内错误,行位置不变)。
2. 「未分组」选项**只**从 `group:<id>` section 提供——从 `ungrouped` 提供是逻辑上的空操作;从 `category:<name>` 提供也不会做任何有意义的事(该行从未关联过,`unlink` 的 `WHERE … AND group_id IS NOT NULL` 匹配 0 行,`NOT EXISTS` 仍为真,行会继续留在原 category 桶——若 UI 对此显示"成功"就是在撒谎)。
3. 把 `category:<name>` section 的最后一行移出后,该 section 从 `sections` 中整体移除(与 `loadAll()` 对零命中 category 候选的丢弃是同一条「0-total 候选即不渲染」规则,`applyItemMove:441-443`)。

### 5.4 未做的门控(写明供门审核实,非疏漏)

上移/下移按钮与移动 `<select>` **都不**在这个组件里再做一层 `canManageTemplates` 客户端门控——两者都只依赖路由自身的 `approvalTemplateAdminGuard`(I7)fail-closed 403(与其余错误同一种非阻塞行内呈现)。头注释(`:38-46`)说明这是对两个写控件的**统一**选择,不是逐控件的临时判断(只门控一个不门控另一个,会在同一组件里把一个 guard 拆成两半)。加客户端门控需要这个文件依赖 `useApprovalPermissions()`,会改变现有 spec 的 mock 面,列为未做(不是被否决,只是本次范围之外)。

## 6. 留给后续 / 未做

| 项 | 状态 | 说明 |
|---|---|---|
| 两个写入面换分组选择器(I4 生效) | **未做** | 见 §1.2;I4 生效时点未到 |
| 前端会话-组织(session-org)脱困入口接入 `section=` 端点 | **缺口,新披露** | `section=` 分支复用 `resolveApprovalTemplateGroupOrgId`(`:668`,与其余七个端点同一函数),多 org 成员在未选 session org 时会在**这条读路径**也吃 403 `SESSION_ORG_REQUIRED`(与既有 6 个写端点同一失败形状)——但 `TemplateGroupSections.vue` 的 `loadAll`/`loadMore` 只把任何异常的 `message` 塞进一个通用错误字符串(`:318-319`、`:333-336`),**没有**对 `SESSION_ORG_REQUIRED` 单独识别、也没有像 A-2 设计的那样触发 session-org 选择器。更根本的是:本分支不含 A-2 的任何提交,`apps/web/src/components/SessionOrgSwitcher.vue` 在这个 worktree 里**不存在**(`find` 零命中)——即便本切片想接,也没有可接的组件。锁文验收 J 的 mutation(「去掉前端对该码的处理 ⇒ 用例停在 403」)在这条新读路径上目前就是这个未处理状态,不是假设性风险。归类为「A-2/A-4 交叉线的新缺口」,列入 owner 待裁(见 §7)。 |
| `approval_templates.key` 全局唯一 / 多级分组 / 按分组授权 / 跨组织共享分组 / 硬删分组端点 | 不排期 | 与 A-1 §5「明确不做」一致,本切片未新增 |
| §4 验收 C 的跨请求一致性 | 不作承诺 | 锁文原文明写,见 §3 |
| 移动/重排控件的客户端权限门控 | 未做 | 见 §5.4,依赖路由 fail-closed,不是客户端二次判断 |

## 7. Owner 待裁项(Q5,原样引用抬头 RATIFY 记录;含本切片新增的一条披露)

锁文 §7 原文(与 A-1 设计 MD §7 相同一份清单,Q5 那一行是本切片的门):

> 2″. **Q5:分期 3 时 `?category=` 过滤与 `/categories` 端点的去留**(首期不动);

抬头 RATIFY 记录对 Q5 的裁决是「首期不动,分期 3 再裁」——即 owner 把**实际决定**留给了本切片交付的这一刻。本切片**按锁文字面**执行了「不动」的那一半:`?category=` 等值过滤与 `GET /api/approval-templates/categories` 端点在本切片**零改动**(`git diff a728ed655..HEAD -- packages/core-backend/src/routes/approvals.ts` 里两处相关代码块之外的既有过滤逻辑未被触碰)。但「再裁」的那一半——去还是留——**本切片没有替 owner 作出**,原样悬空。

**本切片新增的一条披露(不是「零改动」就等于「零影响」)**:`TemplateGroupSections.vue` 的 `loadAll()`(`:280-324`)新增了 `/categories` 端点的一个**新消费方**——它调用 `listTemplateCategories()` 枚举 `category:<name>` 候选 section(`:193`、`:286`),对每个候选名再向 `section=category:<name>` 请求解析成该 org 的真实桶,零命中的候选被丢弃(`:317`)。这意味着:如果 owner 在 Q5 上最终裁决**去掉** `/categories` 端点(该端点本身是「全局、org 无关的名字候选列表」,§Q5 待裁的正是这一点),分组视图会失去枚举 `category:<name>` section 的手段——不是「删掉一个没人用的端点」,而是「删掉一个刚多了一个新调用方的端点」。这条事实应当作为 Q5 裁决的一项输入,而不是被本切片的「不删不改」这句话盖过去当作与 Q5 无关。

按 §0 抬头 RATIFY 记录以及本切片的执行结果:Q5 仍是唯一悬空的 owner 裁决点,新增了一条具体的影响面披露,不构成裁决,也不阻塞本切片的 Draft PR(与 A-1 设计 MD §7 末段「不阻塞本切片的 Draft PR」同一处置方式)。
