# 审批表单分组 Phase 1(切片 A-2 前端)— 设计 MD

- 锁文(唯一 ratify 对象):`approval-form-group-entity-design-lock-draft-20260916.md`,**v2.13 RATIFIED 2026-09-18**
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片清单「A 分组 / A-2 前端脱困」:「共享 `SessionOrgSwitcher.vue`(复制泛化,考勤原文件不动)+ 验收 J + run-required 令牌」)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md` 三线共用 #1–#4(#1–#3 不适用本切片,见 §1.2;#4 适用,见 §3.4)+ lane A 专属 #5–#7(全部适用,见 §1.2/§6/§7)
- 设计 MD(同批交付的后端对偶):`approval-template-groups-phase1-design-20260918.md`(切片 A-1)
- 本文档所在分支:`feat/approval-template-groups-phase1-fe`,堆叠在 `feat/approval-template-groups-phase1`(A-1)之上
- 本文档写作时 worktree HEAD:`cb6d7fa9f97b02438f0d0f36c8fb955870f9e2e8`(6 个提交,`git log --oneline feat/approval-template-groups-phase1..HEAD` 现场核对为 6 行)。**抬头 stale 披露(P3 卫生轮,2026-09-19,gate `impl-gate-A2-round1-20260918.md` P3-4)**:被审 head 是 `d3097be00`(晚两个 docs-only 提交);本轮又在其上做了卫生修复(见验证 MD §12)。下文全部 `file:line` 锚点已在卫生轮对当前 HEAD 逐条复核仍成立——git 历史见 `git log --oneline feat/approval-template-groups-phase1..HEAD` 现场核对。
- 基线关系(现场 `git merge-base` 核对,零漂移):`feat/approval-template-groups-phase1` 尖端 = `0144932ac67e80a81f204dd6c6e502d000112276` = 本分支与 A-1 的 merge-base(本分支是 A-1 的直接后代);A-1 与 `origin/main`(`89f1ecdee2c3b70205a318074824c834bc6a5c7e`)的 merge-base 就是 `origin/main` 尖端本身(A-1 是 `origin/main` 的直接后代)——两段都零漂移。
- 下文所有 `file:line` 都是**对本 HEAD 现场 `grep -n` 的结果**;它们只在这个 HEAD 上成立,后续任何一次提交（含本文档自身的提交）都可能使行号位移,合并前需重新核对(与 A-1 设计 MD 同一纪律)。

## 0. RATIFY 记录(原样引用锁文抬头,不改写)

> **RATIFY 记录(2026-09-18)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、#5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **裁决结果(按建议值)**:Q3 分组按 org 作用域,`org_id` 只取 `req.authenticatedTenantId` = **是**;Q4 归档不保留成员、解档得空组 = **是**;Q5 `?category=` 与 `/categories` 首期不动、分期 3 再裁;分期 2(按现有 category 建组并挂接)= **要**,做成预览→执行→可回滚的管理员操作;`key` 全局唯一 = **另立锁**,不顺带。§7 第 2 项(§2 两表形状 + 锁序表 + I1–I8)按 v2.13 ratify。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR 一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

本切片(A-2)**不含 DDL**——它只加前端文件(一个共享组件、一组类型化客户端函数、一个最小面板)与两处 CI 接线,后端两张表/七端点/DDL 属 A-1(已 Draft PR 落地,见 A-1 设计 MD)。本切片对应目标文档切片清单里的「A-2 前端脱困」一行,以及锁文验收表 J 行(§4)「未选 session org 的多 org 成员……前端收到该码 ⇒ 展示 session-org 选择器……选定后重试 ⇒ 201」这一半——J 的后端半(403 `SESSION_ORG_REQUIRED` 本身)已由 A-1 的 `resolveApprovalTemplateGroupOrgId` 覆盖,不需要本切片新增任何后端代码。

## 1. 范围 / 不在范围

### 1.1 本切片(A-2)包含 —— 逐条对锁文 § / 目标文档 / 补充清单

| 内容 | file:line | 出处 |
|---|---|---|
| 共享组件 `SessionOrgSwitcher.vue`(复制并泛化 `AttendanceSessionOrgSwitcher.vue`;考勤原文件与 `useSessionOrg.ts` 不动) | `apps/web/src/components/SessionOrgSwitcher.vue`(全文件,145 行) | 锁文 §2「多 org 成员」;目标文档 A-2 一行 |
| 七个端点的类型化前端客户端(list/create/rename/archive/unarchive/link/unlink) | `apps/web/src/approvals/api.ts:1162-1219` | 锁文 §2/§4(七端点定义见 A-1 设计 MD §3.1) |
| 18 个专用错误码的联合类型,与后端逐字重合(§2 本文) | `apps/web/src/approvals/api.ts:1142-1160`(`ApprovalTemplateGroupErrorCode`) | A-1 设计 MD §3.3 全表 |
| 最小面板 `ApprovalTemplateGroupsPanel.vue`(挂载于模板中心页,`canManageTemplates` 门控;只做「列表 + 新建」,不做重命名/归档/解档/挂接/解除关联 UI——见 §1.2) | `apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue`(全文件,218 行);挂载点 `TemplateCenterView.vue:60` | 目标文档「共享 `SessionOrgSwitcher.vue`……+ 验收 J」;锁文 §2「首期必须……提供 session-org 选择入口」 |
| **验收 J 前端半**:403 `SESSION_ORG_REQUIRED` → 展示选择器 → 选定后重试 → 201;单 org 成员从不见到选择器 | `ApprovalTemplateGroupsPanel.vue:119-172`(`handleSessionOrgRequired`/`loadGroups`/`onCreate`/`onSessionOrgChange`) | 锁文 §4 验收表 J 行;正控「单 org 成员从不见到选择器」同行 |
| CI 两点接线(AGENTS.md「Testing Guidelines」惯例:新 spec 须同时进域 web-guard workflow 与 `run-required-web-tests.sh`) | `.github/workflows/approval-web-guard.yml`(两处 `paths:` 块 + 一处 `run:` 步骤)、`apps/web/scripts/run-required-web-tests.sh`(一处 `exec` 行) | 补充清单 lane A #7(spec 位置)延伸的两点接线惯例;目标文档「run-required 令牌」 |
| 三份新 spec(全部在 `apps/web/tests/`,非 `src/**/__tests__/`) | `SessionOrgSwitcher.spec.ts`(92 行)、`approvalTemplateGroupsClient.spec.ts`(181 行)、`ApprovalTemplateGroupsPanel.spec.ts`(175 行) | 补充清单 lane A #7 |
| 三处既有 spec 的 mock 接缝补丁(见 §5) | `approvalTemplateCenterCategory.spec.ts:98-100`、`approvalTemplateGovernance.spec.ts:104-106`、`templateCenterI18n.spec.ts:116-118` | 无锁文出处——面板无条件挂载在 `canManageTemplates` 之下产生的既有测试兼容性接缝,见 §5 |

### 1.2 本切片明确不做(逐条引用锁文 § / 目标文档分期 / 补充清单)

| 项 | 出处 | 去处 |
|---|---|---|
| J 行「未知 `section=` 令牌 ⇒ 400」 | 补充清单 lane A #5:`section=` 到分期 3 才存在,分期 1/本切片不可满足 ⇒ **锁文勘误请示 owner 未决**(挪到 A-4 门) | A-4(分期 3) |
| C 行「`?category=` 与 `section` 同现 ⇒ 400」 | 同上,同一 owner 勘误桶 | A-4 |
| 后端七端点 / 两表 DDL / L0 锁序 / RR 池隔离级别 / I6 爆炸半径 / A~B″/E 前半/F/G/H/I/I′/K 的后端判据 | 已属 A-1(独立 Draft PR,已过第 3 轮门审) | A-1(不在本切片重复实现或重复验证) |
| 分组的重命名 / 归档 / 解档 / 挂接 / 解除关联 **UI**(客户端函数已在 `api.ts` 导出,但本切片的面板不调用它们) | 目标文档 A-2 一行原文只列「共享 `SessionOrgSwitcher.vue` + 验收 J + run-required 令牌」,未列完整 CRUD 面板;实现者裁量,见下方说明 | 未排期——五个函数(`renameApprovalTemplateGroup`/`archiveApprovalTemplateGroup`/`unarchiveApprovalTemplateGroup`/`linkApprovalTemplateToGroup`/`unlinkApprovalTemplateFromGroup`)已就绪待未来切片的 UI 消费,`approvalTemplateGroupsClient.spec.ts` 已在客户端层面对全部七个函数做隔离覆盖(§4) |
| 中心页 `section=` 分节 + 节内分页 + 拖拽归组 + 重排端点 + 两个写入面换分组选择器 | 锁文 §6「期 3」;设计 MD(A-1)§1.2 同条 | A-4(分期 3) |
| 管理员「按现有 category 建组并挂接」预览→执行→可回滚 | 锁文 §6「期 2」 | A-3(分期 2) |
| CI 三共用项(#1 闭世界 census、#2 vitest exclude 惯例覆盖、#3 s6a 重钉) | 补充清单「三条 lane 共用」#1–#3 | **不适用本切片**——本切片零 `.db.test.ts`、零 `vitest.config.ts` 改动、零 `plugin-tests.yml` 改动(§3.4/验证 MD §2 现场核对) |

**实现者裁量说明(面板范围,未获锁文/目标文档文本逐字背书)**:锁文 §2 原文只要求「首期必须在审批表单中心页提供 session-org 选择入口」,未要求首期就有完整的分组管理 UI;目标文档切片清单 A-2 一行原文同样只写「共享 `SessionOrgSwitcher.vue` + 验收 J + run-required 令牌」。实现者把面板做成「列表(只读展示)+ 新建表单」的最小形态——这是**能验证验收 J 的最小面**(建组端点会触发 403,列表端点的初始加载也会),而不是完整 CRUD——五个未接 UI 的客户端函数留给后续切片消费,不是遗漏。

## 2. 数据模型与约束(前端无 DDL;对锁文 §2 的对应是 DTO 字段与后端行映射的逐字重合)

本切片不含数据库对象,「数据模型」在前端层面等价于:(a) DTO 形状是否与后端序列化逐字对应,(b) 错误码联合是否与后端专用码集合逐字对应,不多不少。两者都已用脚本机械核对(命令与结果见验证 MD §5)。

### 2.1 DTO 字段 ↔ 后端行映射(机械核对,非目测)

| 前端类型 | file:line | 后端映射函数 | file:line | 核对结果 |
|---|---|---|---|---|
| `ApprovalTemplateGroupDTO`(8 字段:`id/orgId/name/sortOrder/createdBy/createdAt/updatedAt/archivedAt`) | `apps/web/src/approvals/api.ts:1115-1124` | `mapGroupRow` | `packages/core-backend/src/services/ApprovalTemplateGroupService.ts:96-106` | 字段名与顺序逐字相同(Python 脚本对两处 AST 风格提取结果做 `==` 比较,见验证 MD §5.1) |
| `ApprovalTemplateGroupLinkDTO`(6 字段:`orgId/templateId/groupId/linkedBy/linkedAt/unlinkedAt`) | `apps/web/src/approvals/api.ts:1126-1133` | `mapLinkRow` | `packages/core-backend/src/services/ApprovalTemplateGroupService.ts:109-117` | 同上,逐字相同 |

### 2.2 错误码联合 ↔ 后端专用码集合(18 个,机械核对)

`ApprovalTemplateGroupErrorCode`(`apps/web/src/approvals/api.ts:1142-1160`)列出 18 个码:锁文 §2/§4 ratify 的 7 个(`SESSION_ORG_REQUIRED`/`ORG_ID_NOT_ACCEPTED`/`GROUP_NOT_FOUND`/`GROUP_ARCHIVED`/`GROUP_NAME_TAKEN`/`GROUP_NOT_ARCHIVED`/`GROUP_SORT_CONFLICT`)+ 实现者新增的 3 个请求形状码(`GROUP_NAME_REQUIRED`/`APPROVAL_GROUP_ID_REQUIRED`/`APPROVAL_ACTOR_REQUIRED`,A-1 设计 MD §3.3)+ 7 个 `*_FAILED` 兜底码 + §3.5(A-1)新增的 `APPROVAL_TEMPLATE_NOT_FOUND`(挂接可见性前置检查的 404)。用脚本对 `routes/approvals.ts` + `ApprovalTemplateGroupService.ts` 做双向核对(命令见验证 MD §5.2):18 个前端码全部作为字符串字面量出现在后端源码中(零遗漏);反向从后端源码提取同一区块内的全部 `ALL_CAPS` 字符串字面量,除这 18 个外只多出 `APPROVAL_PARTICIPANT_DIRECTORY_FAILED`(不相关的目录搜索端点,不在七个分组端点范围内)与 `VALIDATION_ERROR`(本路由文件里跨多个不相关端点复用的通用码,分组端点自身从不产生它)——前端联合类型既不多造码,也不漏码。

**接缝(复用而非新造错误管道)**:`ApprovalApiError` 类(`apps/web/src/approvals/api.ts:1027-1038`)与 `approvalRequestError` 辅助函数(`:1047-1052`)是**既有代码**(该文件既有的 `createApproval`/`dispatchAction` 已在用,注释自陈"unchanged"),七个分组客户端函数经 `getApprovalJson`/`patchApprovalJson`/`postApprovalJson`/`deleteApprovalJson`(`:1079-1105`,后三者中 `postApprovalJson` 为既有函数,前两者+`deleteApprovalJson` 为本切片新增的同构 GET/PATCH/DELETE 兄弟)复用同一条错误管道——`.code` 字段从 `payload.error.code` 读出并原样挂到 `ApprovalApiError.code` 上,不经过 `utils/api.ts` 的 `apiGet`/`apiPost`(那两个不保留 `.code`,这是新增这组 `*ApprovalJson` 辅助函数的直接原因,`:1069-1078` 头部注释自陈)。

## 3. 接口与错误码

### 3.1 七个客户端函数(`apps/web/src/approvals/api.ts`)

| 函数 | file:line | HTTP | 说明 |
|---|---|---|---|
| `listApprovalTemplateGroups()` | `:1162-1165` | `GET /api/approval-template-groups` | 不接受 orgId 参数(A‴,§3.2 下方说明) |
| `createApprovalTemplateGroup(name)` | `:1167-1173` | `POST /api/approval-template-groups` | |
| `renameApprovalTemplateGroup(groupId, name)` | `:1175-1183` | `PATCH /api/approval-template-groups/:id` | 未接 UI(§1.2) |
| `archiveApprovalTemplateGroup(groupId)` | `:1186-1191` | `POST /api/approval-template-groups/:id/archive` | 未接 UI |
| `unarchiveApprovalTemplateGroup(groupId)` | `:1194-1199` | `POST /api/approval-template-groups/:id/unarchive` | 未接 UI |
| `linkApprovalTemplateToGroup(templateId, groupId)` | `:1203-1212` | `POST /api/approval-templates/:id/group` | 未接 UI |
| `unlinkApprovalTemplateFromGroup(templateId)` | `:1216-1218` | `DELETE /api/approval-templates/:id/group` | 未接 UI;204 幂等(H,A-1) |

### 3.2 org 来源(A‴,前端侧的推论)

七个函数**没有任何一个**接受 `orgId` 参数——这不是遗漏,是与后端 `resolveApprovalTemplateGroupOrgId`(A-1 设计 MD §3.2,`routes/approvals.ts:352-370`)的镜像:该函数把 body/query 里出现 `orgId` 一律判 400 `ORG_ID_NOT_ACCEPTED`,前端客户端如果开放 orgId 形参,调用方迟早会传一个值触发该 400——**签名本身就是防呆**,机械核对见验证 MD §5.3(`grep -c "orgId" apps/web/src/approvals/api.ts` 的七个函数体内命中数为 0)。

### 3.3 错误码全表

见 §2.2(设计 MD 篇幅,不重复罗列 18 行——A-1 设计 MD §3.3 已有权威全表,本节只做联合类型层面的机械核对陈述)。

### 3.4 三条共用检查(补充清单「三条 lane 共用」)对本切片的求值

| # | 检查 | 本切片求值 |
|---|---|---|
| #1 | `t2-source-freeze-ci-wiring` 闭世界(新 `.db.test.ts` 须同时登记到 `ci-realdb-step-contract.mjs` 的硬编码数组) | **不适用**——本切片零 `.db.test.ts`(全部三份新 spec 都是纯 vitest 单元/组件测试,mock `apiFetch`/`fetch`,零 DB 依赖,见验证 MD §4) |
| #2 | `vitest.config.ts:42-45` 在地惯例覆盖 | **不适用**——本切片零改动 `vitest.config.ts` |
| #3 | s6a sha256 重钉 | **不适用**——本切片零改动 `plugin-tests.yml`;现场 `git diff --exit-code` 对正确基线(A-1 尖端,非 `origin/main`)核对 exit=0,见验证 MD §2 |
| #4 | 错误码不得降级成裸 HTTP 状态 | **适用,已满足**——`ApprovalTemplateGroupsPanel.spec.ts` 与 `approvalTemplateGroupsClient.spec.ts` 的验收 J 用例全部断言 `err.code === 'SESSION_ORG_REQUIRED'`(而非仅 `err.status === 403`),面板自身的分支逻辑(`loadGroups`/`onCreate` 的 catch)同样按 `.code` 分支,见 §1.1 行 4 与验证 MD §1 |

## 4. 事务与锁序

**不适用本切片。** A-2 是纯前端切片:七个客户端函数只是 `fetch` 包装,面板组件只做 DOM 状态机(`loading`/`creating`/`showSessionOrgSwitcher` 等 `ref`),不发出任何 SQL、不持有任何数据库连接或锁。机械核对(验证 MD §5.4)限定在四个production 代码文件(`api.ts`/`SessionOrgSwitcher.vue`/`ApprovalTemplateGroupsPanel.vue`/`TemplateCenterView.vue`)上跑 `grep -c "BEGIN\|COMMIT\|pg_advisory\|FOR UPDATE\|new Client\|new Pool"`,全部为 0——**更正**:第一版曾对「全部改动文件」不加限定地跑同一模式,命中 15(全部是英文散文里的假阳性,如 `commit body`/`new client methods` 这类与 SQL 无关的自然语言用词,以及本文档与验证 MD 自身引用锁文/A-1 术语造成的自指命中,详见验证 MD §5.4 的更正记录),已收窄到只扫描本切片实际新增/改动的生产代码与 spec 源文件(排除 CI shell 脚本的散文注释与本 MD 文档自身)。事务与锁序表属 A-1 设计 MD §4,本切片不重复。

## 5. 与既有代码的接缝(file:line)

| 接缝 | file:line | 说明 |
|---|---|---|
| 挂载点 | `TemplateCenterView.vue:60` `<ApprovalTemplateGroupsPanel v-if="canManageTemplates" :tr="tr" />` | 复用既有的 `canManageTemplates`(`:300`,`useApprovalPermissions()` 解构,非本切片新增),不新建权限判定 |
| `tr` 函数签名对齐 | `TemplateCenterView.vue:312` `const tr = (en, zh) => (isZh.value ? zh : en)` | 与 `AttendanceView.vue:10468` 同形状的 `tr(en, zh)` 签名(而非本文件自己惯用的整对象 `t` 约定),供 `SessionOrgSwitcher`/`ApprovalTemplateGroupsPanel` 复用 |
| `useSessionOrg` composable 复用(未改动) | `ApprovalTemplateGroupsPanel.vue:83,95-105` 消费 `apps/web/src/composables/useSessionOrg.ts`(全文件未改,现场 `git diff --exit-code` 核对,见验证 MD §3) | 与考勤页(`AttendanceView.vue:10314,14876`)共用同一个 composable 实例类型,不复制其逻辑 |
| `AttendanceSessionOrgSwitcher.vue` 不动 | 现场核对全文件字节不变(验证 MD §3) | 保护 `attendance-web-guard.yml:297-301,:397-400` 的闭世界 session-spec census(见验证 MD §3 现场 24/24 绿) |
| `ApprovalApiError`/`approvalRequestError` 复用 | `apps/web/src/approvals/api.ts:1027-1052`(既有类/函数,未改) | 见 §2.2「接缝」说明 |
| 三处既有 spec 的 mock 接缝补丁 | `approvalTemplateCenterCategory.spec.ts:98-100`、`approvalTemplateGovernance.spec.ts:104-106`、`templateCenterI18n.spec.ts:116-118` | 面板现在无条件挂载在 `canManageTemplates` 为真时,这三份既有 spec 的 `vi.mock('../src/approvals/api', ...)` 替换体缺少 `ApprovalApiError`/`listApprovalTemplateGroups`/`createApprovalTemplateGroup` 三项,面板 `onMounted` 会抛未捕获异常——三处各自补了同一套最小 mock(空列表 + 一个可解析的建组桩)。这不是锁文条款,是既有测试对新增无条件挂载点的兼容性接缝,验证 MD §7 现场重跑确认三处 28/28 绿。 |
| CI 两点接线 | `.github/workflows/approval-web-guard.yml`(2 处 `paths:` + 1 处 `run:` 步骤)、`apps/web/scripts/run-required-web-tests.sh`(1 处 `exec` 行) | 详见 §1.1;机械令牌计数见验证 MD §2 |

## 6. 留给后续切片的项

| 项 | 去处 |
|---|---|
| J 行「未知 `section=` 令牌 ⇒ 400」的锁文勘误(挪到分期 3 门) | A-4;owner 未答复,见 §7 |
| C 行「`?category=` 与 `section` 同现 ⇒ 400」同一勘误桶 | A-4 |
| 分组重命名 / 归档 / 解档 / 挂接 / 解除关联的 UI(客户端函数已就绪) | 未排期,留给后续 UI 切片(可能是 A-3/A-4 或独立切片,目标文档未点名) |
| 补充清单 lane A #6(分期门「1 落地」的求值:门审通过 vs 已合并) | owner 未答复,见 §7——本设计 MD 采用「Draft PR 过门审」口径撰写,不代表已裁决 |
| 无既有 `*-ci-wiring` 家族守卫覆盖 `run-required-web-tests.sh` / `approval-web-guard.yml` 里这三个新 token 的未来意外删除(闭世界缺口,与 A-1 §5/§9 披露的性质相同但对象不同) | 未排期,验证 MD §6 披露,留给后续单元或 owner 裁决是否现在做 |

## 7. Owner 待裁项(原样引用锁文抬头 RATIFY 记录 + 补充清单未决项,不改写)

锁文 §7(与 A-1 设计 MD §7 相同,本切片不重复裁决,仅摘录与本切片直接相关的两条勘误请示):

> 1. **Q3:分组是否 org 作用域**(建议是;`org_id` **只**取 `req.authenticatedTenantId`;可见性不受分组影响);(**已 ratify**,见 §0 抬头记录)
> 2′. **Q4:归档是否保留成员**(建议不保留,解档得到空组;若要保留则形状重做);(**已 ratify**,见 §0)
> 2″. **Q5:分期 3 时 `?category=` 过滤与 `/categories` 端点的去留**(首期不动);(**已 ratify**,见 §0)

按 §0 抬头 RATIFY 记录:上述三项均已 ratify,与本切片(A-2)无直接实现依赖(A-2 不碰 org 作用域裁决、不碰归档语义、不碰 `?category=`)。

**本切片新增/沿用的两条未决 owner 请示(补充清单 lane A,未见 owner 回应,不阻塞本切片 Draft PR)**:

1. **补充清单 #5**:J 行「未知 `section=` 令牌 ⇒ 400」与 C 行「`?category=` 与 `section` 同现 ⇒ 400」——`section=` 到分期 3(A-4)才存在,分期 1/A-2 都不可满足 ⇒ 锁文勘误请示 owner(把这两句挪到 A-4 门),首切片(含本切片)不做,PR body 需披露。
2. **补充清单 #6**:分期门「1 落地」的求值(门审通过 vs 已合并)——DDL Draft-only 是永久约束,字面「落地」永不发生 ⇒ 请示 owner 定义为「Draft PR 过门审」。本设计 MD 与目标文档一致,按「Draft PR 过门审」口径撰写,但这仍是**请示中**,不是 owner 已确认的定义。

本切片没有引入新的、超出上述两条已披露请示的 owner 裁决问题。
