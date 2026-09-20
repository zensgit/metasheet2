# 审批表单分组 Phase 4(A-5 日常操作收口)— 验证 MD

- 设计 MD(同批):`approval-template-groups-phase4-daily-ops-design-20260920.md`(PROPOSED)
- 基线:`origin/feat/approval-template-groups-phase3-sections-on-a2` @ `e90d16c90f58a58789a6acd589df362aaa2c2f42`
- 工作树:`/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/wt-groups-p4`(`git worktree add --detach`;9 处 `node_modules` 软链自 canonical `/Users/chouhua/Downloads/Github/metasheet2`)
- 库:`metasheet2_a5_20260920`(本次新建,`createdb -U postgres -O ms2testbed`;角色 `ms2testbed` 非超级、`Create DB`)
- 分支:`feat/approval-template-groups-phase4-daily-ops`

## 0. 迁移(非超级角色,零权限错误)

```
$ DATABASE_URL=postgresql://ms2testbed:***@localhost:5432/metasheet2_a5_20260920 npx tsx src/db/migrate.ts latest
EXIT=0, 413 条 "was executed successfully"
$ grep -inE "permission denied|42501|must be owner|must be superuser" migrate.log
(零命中)
```

`approval_templates.id` 列类型(`\d approval_templates`):`uuid`,`DEFAULT gen_random_uuid()`——P3-1 的 shape 校验不可能收窄任何真实数据,因为 Postgres 本身在插入时已经不接受非 UUID 值;新库无种子数据,故未做非空 census(空表的「0/0」不构成证据,类型层面的保证是这里唯一有承重意义的证据)。

## 1. 六条发现 × 处置(见设计 MD §1 完整锁覆盖矩阵)

| 发现 | 处置 | file:line |
|---|---|---|
| P2-1 归档视觉区分 | 做 | `apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue` |
| P2-2 错误文案产品化 | 做 | `packages/core-backend/src/services/ApprovalTemplateGroupService.ts:180-197`;`apps/web/src/approvals/api.ts`(`describeApprovalTemplateGroupError`) |
| P2-3 分节计数/行数一致 | 做 | `apps/web/src/views/approval/TemplateGroupSections.vue`(`refreshSectionRange`/`applyItemMove`) |
| P2-4 重命名/归档/取消归档 UI | 做(unlink 不做,已有消费方) | `apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue` |
| P2-5 持久会话组织入口 | 做 + 1 条 OPEN | `apps/web/src/views/approval/TemplateCenterView.vue` |
| P3-1 畸形 templateId 400 化 | 做 | `packages/core-backend/src/routes/approvals.ts`(`isWellFormedUuid`) |

## 2. 红→绿证据(逐条,先红后绿)

**如实披露一处顺序偏差**:`describeApprovalTemplateGroupError` 本身(`api.ts` 新导出函数)在 `approvalTemplateGroupsClient.spec.ts` 里的 4 条用例是在实现之后补的,不是严格先红后绿——这是一个纯函数级别的小改动,风险低,但仍记在这里而不是悄悄略过。其余五条修复(P2-1/P2-2 消费方/P2-3/P2-4/P3-1)全部按先红后绿执行,红色输出见下。

### 2.1 P3-1(后端真库)

新增用例 `P3-1: a malformed templateId on link/unlink is a typed 400, not a raw 500 from the uuid column`(`approval-template-groups-lifecycle.db.test.ts`)。

**红**(实现前,针对 `metasheet2_a5_20260920`):
```
error: invalid input syntax for type uuid: "not-a-uuid"
  at isApprovalTemplateVisibleForGroupLink (routes/approvals.ts:466:18)
✗ P3-1 … → expected 500 to be 400
```
**绿**(加 `isWellFormedUuid` 前置校验后,同一用例 + 全文件重跑):
```
✓ P3-1: a malformed templateId on link/unlink is a typed 400, not a raw 500 from the uuid column
Test Files 1 passed (1)
     Tests 19 passed | 1 skipped (20)
```

**连带**:同一文件里既有的 `P1-3`(design-gate A-3)用例原先逐字 PIN 住被修复的那句内部黑话(`当前锁文 CHECK 只接受可打印 ASCII` / `owner 勘误`)——P2-2 的消息修复让它变红(`expected 'This value must include at least one …' to contain '当前锁文 CHECK 只接受可打印 ASCII'`),已按新文案改写为「不含锁文/owner/勘误 + 含 ASCII」的反向 + 正向断言,重跑后随同一文件回到全绿(见上方 19 passed)。**这条不是放宽判据**——旧断言 PIN 的正是本轮要修的缺陷本身。

同批命令(不受影响,回归检查):`approval-template-groups-serialization.db.test.ts` / `-sections.db.test.ts` / `-reorder.db.test.ts` → `Test Files 3 passed (3)`,`Tests 18 passed | 3 skipped (21)`。

### 2.2 P2-1 / P2-2 / P2-4(`ApprovalTemplateGroupsPanel.spec.ts`)

新增 6 个用例(P2-1 归档视觉、P2-2 错误文案、P2-4 rename/archive-confirm-cancel/archive-unarchive-toggle/changed-事件)。

**红**(实现前):
```
✗ P2-1: an archived group is visually distinct … → expected null not to be null
✗ P2-2: a GROUP_NAME_UNSUPPORTED create failure renders product copy … → expected '...This value must include...' not to contain '...This value must include...'
✗ P2-4 rename: … → Cannot read properties of null (reading 'querySelector')
✗ P2-4 archive: asks for confirmation … → Cannot read properties of null (reading 'click')
✗ P2-4 archive/unarchive: … → Cannot read properties of null (reading 'click')
✗ P2-4: archive/rename/unarchive each emit "changed" … → Cannot read properties of null (reading 'click')
Tests 6 failed | 3 passed (9)
```
**绿**(实现后):
```
Test Files 1 passed (1)
     Tests 9 passed (9)
```

### 2.3 P2-3(`approvalTemplateCenterSections.spec.ts`)

新增 2 用例(目标侧「常见/已完整加载」情形、源侧「已分页」对称情形)。

**红**:
```
✗ P2-3 (target, common case): … → expected 2 to be 3           // 计数显示 3,实际只渲染 2 行
✗ P2-3 (source, symmetric case): … → expected '10' to be '9'   // 移出一行后计数没跟着重新同步
```
**绿**(`refreshSectionRange` + `applyItemMove` 对称改写后):
```
Test Files 1 passed (1)
     Tests 22 passed (22)
```

**连带**:既有用例「offers every OTHER active group … updates both counts without re-fetching either section」PIN 了 `container!.querySelector('[data-testid="template-group-section-item-tpl_1"]')).toBeNull()`(整页范围,不分 section)——这条断言的通过原因,在修复前是"item 从两个 section 里都不可见"(bug 本身),修复后 item 正确地出现在目标 section 里,断言因而变红。已改写成分别在 source/target 两个 scope 下断言(source 里不在、target 里在),同时新增 target 里「确实渲染」的正向断言——这是**加强**判据,不是放宽。改写后重跑,22/22 绿(见上方)。

### 2.4 P2-5(`approvalTemplateCenterCategory.spec.ts`,新增 describe 块)

**红**(第一版,mock 用精确字符串匹配 fetch 路径,而 `apiFetch` 实际发出的是 `${origin}${path}`):
```
✗ a multi-org admin with an ALREADY-BOUND session org sees a persistent switcher … → expected null not to be null
✗ switching org through the persistent switcher re-reads the grouped view → expected null not to be null
```
诊断(临时 `console.log` 定位,已移除):`switcher html` 显示 `SESSION_ORG_SWITCH_REFUSED`——`jwt()` 测试 helper 用了 `userId: 'p25-actor'`(比仓内约定的 `'actor'` 长),导致 `btoa(JSON.stringify(...))` 产生 `==` 填充,`useAuth.setExplicitSessionOrg` 的 JWT 形状正则 `[A-Za-z0-9_-]+` 不接受 `=`,鉴权判假。改回仓内统一约定 `userId: 'actor'`(与 `useAuth.spec.ts`/`api.spec.ts`/`ApprovalTemplateGroupsPanel.spec.ts` 等所有既有 jwt() helper 一致),同时把路径匹配从精确相等改成 `.endsWith(...)`(因为经真实 `apiFetch` 的 URL 带 `window.location.origin` 前缀)。

**绿**:
```
Test Files 1 passed (1)
     Tests 13 passed (13)
```

### 2.5 附带发现并修复:`templateCenterI18n.spec.ts` 的既有闭世界守卫

实现 P2-4 的 `window.confirm` 提示时,首版把 `props.tr(en, zh)` 的两个参数拆成了多行——`templateCenterI18n.spec.ts` 现有的
`guard: ApprovalTemplateGroupsPanel.vue has no CJK literal outside a paired tr(en, zh) call` 守卫要求 `tr('英文', '中文')` 必须在**同一行**,因此立刻变红(`expected [ 1 item ] to deeply equal []`)。改成单行 `tr(...)` 调用后绿(守卫本身未改一行)。

## 3. 静态检查

| 检查 | 结果 |
|---|---|
| `apps/web`: `npx vue-tsc -b` | 唯一剩余错误 `vite.config.ts(28,29) TS2769`;`git diff --stat origin/main HEAD -- apps/web/vite.config.ts` = 空(0 字节,与 base 逐字节相同)——**环境项,非本 lane 引入**,与既往门审记录一致。实现过程中暴露并顺带修复了一个**既有的**、与本 lane 无关的编译期缺口:`GROUP_NAME_UNSUPPORTED` 从未被加进 `ApprovalTemplateGroupErrorCode` 联合(A-2 设计 MD §2.2/§12.3 自己登记过的已知风险——「18 码一致性只由一次性脚本核对过,不是常驻守卫」);本轮补上后编译器才第一次能核对 `describeApprovalTemplateGroupError` 表里的键,现在是第 19 个前端码(与另外两个既有实现者请求形状码同一档次,仍非 ratify 码)。 |
| `packages/core-backend`: `npx tsc --noEmit` | 0 错误 |
| `apps/web`: `npx vite build` | 成功(`✓ built in 12.26s`);警告仅既有的 chunk-size 提示,与本 lane 无关 |

## 4. CI 两点接线 / s6a census

- `git diff --stat e90d16c90f58a58789a6acd589df362aaa2c2f42 -- .github/workflows/plugin-tests.yml .github/workflows/approval-web-guard.yml packages/core-backend/vitest.config.ts apps/web/scripts/run-required-web-tests.sh packages/core-backend/src/db/migrations/` → **空**(四个 CI 钉文件 + 迁移目录字节不变,s6a 未受影响)。
- 本轮**零新增测试文件**——全部新用例落在已经在 `vitest.config.ts` exclude 清单 / `plugin-tests.yml` 真库清单 / `run-required-web-tests.sh` exec 行里的既有文件,因此「加新 spec token」不适用,机械证据即上一条的空 diff。
- `scripts/dev/atg-exec-line-post-rebase-check.sh`(无参数,只读检查):
  ```
  Check 1: exactly one '^exec npx vitest run' line — PASS
  Check 2: no duplicate token on that exec line — PASS (400 tokens, all unique)
  ```

## 5. `run-required-web-tests.sh` 本地实跑(含一处坦白的未覆盖)

该脚本由 62 条串联的 `pnpm --filter … vitest run <tokens>` 命令 + 结尾一条覆盖约 400 个 token 的 `exec npx vitest run` 巨行组成,命令间以隐式提前退出的方式串联(任一段失败,后续段不再执行,与是否传 `-e` 无关)。

**遇到一个与本 lane 完全无关、可在隔离环境下确定性复现的既有失败**,挡住了脚本靠前一段(第 9 段左右)的整段串联执行:

```
tests/multitable-recovery-archive-modal.spec.ts > ManualArchiveCapture > does not submit when durable request identity cannot be saved
AssertionError: expected "spy" to not be called at all, but actually been called 1 times
```

**归因证据**(确认与本次改动无关,不在本轮范围内处理):

1. `git diff --stat e90d16c90f58a58789a6acd589df362aaa2c2f42 HEAD` 里没有任何一行涉及 `multitable`/`recovery`/`archive`/`ManualArchiveCapture`;
2. 单独跑该文件两次,确定性复现同一失败(不是共享状态污染的偶发 flake):
   ```
   $ npx vitest run tests/multitable-recovery-archive-modal.spec.ts   # 跑两次,结果一致
   Tests 1 failed | 53 passed (54)
   ```
3. `git log -1 --format=%H -- apps/web/tests/multitable-recovery-archive-modal.spec.ts` = `e40d32fd30d5c0c8d1e030a39fb02446f5356d15`(`fix(timemachine): disclose unsupported attachment recovery`)——该文件最后一次改动来自一条与审批分组毫不相关的既有提交,已经在本 lane 的基线 head 上。

**因此本地无法通过该脚本的「一条命令跑到底」方式,把 62 段之后的段落也囊括进同一次调用**——但这不是覆盖缺口:该脚本结尾的 `exec` 巨行才是真正承载 required 门的那一步(其余 61 段各自的 token 集合互不重叠,是独立 `pnpm --filter` 分组),而这条 `exec` 行本身已经**单独完整跑过**且全绿(见 §6)。挡路的是一段**更靠前、与本次六条修复完全无关**的既有段落,记为已知问题,不在本切片修复范围。

## 6. 单独实跑 required 门真正承重的那条 `exec` 巨行(400 个 token,含全部六条修复相关的 6 个 spec 文件)

直接抽取并执行 `run-required-web-tests.sh` 结尾那条 `exec npx vitest run <400 tokens> --reporter=dot`(与脚本执行时完全相同的 token 集合、完全相同的 vitest 调用形状,只是跳过了它之前互不相关的 61 段——那 61 段各自独立,不影响这条巨行本身能否跑通):

```
 Test Files  473 passed (473)
      Tests  7307 passed (7307)
```

六个与本轮直接相关的文件全部在其中且全绿:

```
✓ tests/templateCenterI18n.spec.ts (18 tests)
✓ tests/approvalTemplateCenterSections.spec.ts (22 tests)
✓ tests/approvalTemplateCenterCategory.spec.ts (13 tests)
✓ tests/ApprovalTemplateGroupsPanel.spec.ts (9 tests)
✓ tests/approvalTemplateGroupsClient.spec.ts (20 tests)
✓ tests/SessionOrgSwitcher.spec.ts (3 tests)
```

## 7. 未做(登记 OPEN,交 owner)

**P2-5 唯一一条**:见设计 MD §1 矩阵「OPEN」列——本切片按任务书指令把「持久组织切换入口」做成了 `hasMultipleOrgs` 收窄的形状(保住锁文 §4 验收 J「单 org 成员从不见到选择器」对这个新入口的字面成立),但「持久 vs 反应式」「新入口是否要求同一条正控」本身是 owner 从未表态过的问题(报告原文:「未见 owner 就此落过字,不替 owner 定性」)。本轮的实现是一个**未经 owner 确认的实现选择**,不是裁决——留给 owner 事后确认或推翻。

其余五条(P2-1/P2-2/P2-3/P2-4/P3-1)均落在「锁内」或「既有条款 UI 呈现」两个桶,不产生新的 owner 裁决问题。

---

## 8. 第 2 轮验证(修 `impl-gate-A5-daily-ops-round1-20260920.md` 的 1 P1 / 1 P2 / 3 P3)

**PROPOSED — 未过门审,未 ratify。** 设计说明见同批设计 MD §5。

- 被修基线 head:`beec0b8c7eca6129647c056216b6255b4634b4dd`
- 工作树:`…/scratchpad/a5r2`(`git worktree add --detach`;`node_modules` 自 canonical 软链)
- 库:`metasheet2_a5r2_20260920`(本轮新建,`createdb -U postgres -O ms2testbed`;`psql` 核 `current_database()=metasheet2_a5r2_20260920`、`current_user=ms2testbed`、`rolsuper=f`)
- 迁移:`DATABASE_URL=postgresql://ms2testbed:***@localhost:5432/metasheet2_a5r2_20260920 npx tsx src/db/migrate.ts latest` → **EXIT=0,413 条 `was executed successfully`**;`grep -inE "permission denied|42501|must be owner|must be superuser"` **零命中**
- 连接串变量普查(跑真库前):`grep -n 'DATABASE_URL' .github/workflows/*.yml` = 212 命中,全部是 CI 内联串;`package.json` / `packages/core-backend/package.json` / `apps/web/package.json` 零命中;被跑的真库文件只读 `process.env.DATABASE_URL`(`approval-template-groups-lifecycle.db.test.ts:42/:133/:215`)——本轮只 export 这一个变量,指向上面那个一次性库

### 8.1 改了什么(11 个文件,零新增文件)

| 文件 | 为什么 |
|---|---|
| `apps/web/src/components/SessionOrgSwitcher.vue` | P1-A:`useId()` 替换写死 DOM id;新增 `SessionOrgHost` / `SessionOrgHostKey` |
| `apps/web/src/views/approval/TemplateCenterView.vue` | P1-A:本页唯一 `useSessionOrg()` 实例 + `provide` + `hasMultipleOrgs \|\| sessionOrgRequiredSeen` |
| `apps/web/src/views/approval/TemplateGroupSections.vue` | P1-A:`inject` host;host 模式不建实例、不渲染切换器、不发 session-org 请求 |
| `apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue` | P1-A 同上;P3-3 归档/解档后 `await loadGroups()`;NIT-3 注释 |
| `apps/web/src/approvals/api.ts` | P3-2 文案 |
| `packages/core-backend/src/routes/approvals.ts` | P3-1a 注释(仅注释;谓词与调用点零改动) |
| 4 个既有 spec + `SessionOrgSwitcher.spec.ts` | 新增 8 条用例(见 8.2) |

### 8.2 新增用例(8 条,全部落在既有文件)

| 文件 | 用例 | 打什么 |
|---|---|---|
| `approvalTemplateCenterCategory.spec.ts` | `P1-A: an UNBOUND multi-org admin on the first grouped hop gets exactly ONE switcher, with a unique select id` | 门审点名缺的 (c) 人群;`querySelectorAll` 计数,不用 `querySelector` |
| 同上 | `P1-A: switching from EVERY rendered switcher instance leaves the page entry in place…` | 实例数**运行时发现**后逐个遍历、每轮重挂;这正是门审要求的「遍历每个实例」 |
| `approvalTemplateCenterSections.spec.ts` | `P2-3 (target, already-paginated case)…` | **P2-B**;判别点=目标 page 1 刷新请求 + 被移入行真的渲染 |
| 同上 | 两条 hosted 用例(不渲染自己的切换器 / host 重放 `loadAll()` 后分节回来) | P1-A 的 child 侧契约 |
| `ApprovalTemplateGroupsPanel.spec.ts` | `P3-3: archiving re-reads the list so the rendered order is the server's…` | P3-3 |
| 同上 | hosted 用例(上报 host、不画控件、不发第二次 session-org 请求、host 重放后列表回来) | P1-A 的面板侧契约 + 门审关心的「列表会不会卡在隐藏态」 |
| `SessionOrgSwitcher.spec.ts` | `two instances on one page get distinct select ids, each paired with its OWN label` | `useId()` 的判别配置(**一个实例的集合里断言唯一性是空转**) |

### 8.3 先红后绿 / mutation 台账(19 条,全部 `cp` 备份 → 改坏 → 跑 → `cp` 还原 → `cmp` 校验;零 `git checkout --` / `reset --hard`)

**(a) 先红:新用例对第 1 轮实现的判别力**(把四个源文件逐字还原成 `beec0b8c7e` 的内容,只留新用例):

```
FAIL P1-A: an UNBOUND multi-org admin … exactly ONE switcher   AssertionError: expected 2 to be 1
FAIL P1-A: switching from EVERY rendered switcher instance …   AssertionError: expected +0 to be 1
 Test Files  1 failed (1)
      Tests  2 failed | 13 passed (15)
```
——与门审真浏览器实测的 `switchers=2` / `nth=1 ⇒ count=0` **逐字同形**。还原后 `cmp` 四个文件全部一致。

**(b) 台账**(`Tests` 行逐字抄自输出;探针名带 `'` 的是第 1 轮探针按新代码形状的**重述**,不是原字面):

| # | 目标 | 结果 | 判定 |
|---|---|---|---|
| M1 | 目标「已完整」分支:去掉本地插入 | 2 failed / 23 passed (25) | 承重 ✅ |
| **M2** | **目标「已分页」分支:换回修复前写法** | **1 failed / 24 passed (25)** | ✅ **第 1 轮存活的探针现在变红** |
| M3 | 源「已分页」分支:换回本地计数 | 1 failed / 24 passed (25) | 承重 ✅ |
| M4 | 面板归档徽标 | 2 failed / 9 passed (11) | 承重 ✅ |
| M4b | 面板 `:data-group-id` | 3 failed / 8 passed (11) | 承重 ✅ |
| M5 | 五处 `describeApprovalTemplateGroupError` → 原始 message | 1 failed / 10 passed (11) | 承重 ✅ |
| M6 | `onArchive` 的 `emit('changed')` | 1 failed / 10 passed (11) | 承重 ✅(加了 `loadGroups()` 后仍承重) |
| M6b | `onArchive` 的 confirm 守卫 | 1 failed / 10 passed (11) | 承重 ✅ |
| M7′ | 页面切换器门:`hasMultipleOrgs` → `orgs.length > 0` | 1 failed / 14 passed (15) | 承重 ✅(**锁文验收 J 正控**) |
| M7b′ | 删进入分组视图的 session-orgs 拉取 | 2 failed / 13 passed (15) | 承重 ✅ |
| M7c′ | 删切换成功后的两处重读 | 2 failed / 13 passed (15) | 承重 ✅ |
| M7d′ | 页面切换器门 → `false` | 4 failed / 11 passed (15) | 承重 ✅ |
| M8 | `isWellFormedUuid` → `return true \|\|` | 1 failed / 19 passed (20)(真库) | 承重 ✅ |
| R1 | 分节视图:删 host 分支 | 1 failed / 39 passed (40) | 承重 ✅ |
| R2 | 分节视图:host 模式下照画切换器 | 2 failed / 13 passed (15)(category);1 failed / 24 passed (25)(sections 自身) | 承重 ✅ |
| R3 | 面板:删 host 分支 | 1 failed / 10 passed (11) | 承重 ✅ |
| R4 | 面板:host 模式下照画切换器 | 1 failed / 10 passed (11) | 承重 ✅ |
| R5 | 切换器:换回常量 DOM id | 1 failed / 3 passed (4) | 承重 ✅ |
| R6 | 面板 `onArchive`:删 P3-3 重读 | 1 failed / 10 passed (11) | 承重 ✅ |
| R7 | `api.ts`:换回第 1 轮无规则、无例子的文案 | 2 failed / 29 passed (31) | 承重 ✅ |

**过程中自己抓到的两个问题,如实登记**(两条都在交付前修掉,不是事后发现):
1. **R3 第一版是无效 mutation**:只删三行留下不配对的大括号 ⇒ vitest 直接崩(`NO-SUMMARY`),不是判别力证据。改为整块删除后 1 failed。
2. **R4 第一版存活**:面板的 hosted 用例里 host 从没拉过 org 列表,`orgs` 为空,而 `SessionOrgSwitcher` 自身的 `v-if="… orgs.length > 0 …"` 让**不设防的面板也渲染不出东西** ⇒ 判据空转。已在两个 hosted 用例的 host 里加 `void sessionOrg.loadSessionOrgs()`(并断言 `sessionOrgLookups() === 1`,即「host 一次、child 零次」),R4/R2 随即变红。

### 8.4 全量实跑(数字逐字抄自输出)

| 门 | 结果 |
|---|---|
| 六个相关前端 spec 合跑(category / sections / panel / client / SessionOrgSwitcher / templateCenterI18n) | **6 files / 93 tests 全绿**(第 1 轮同样六文件基线 85 → 本轮 8 条新用例全部落在其中) |
| `run-required-web-tests.sh` 结尾那条 `exec` 巨行(400 token,与脚本逐字同形) | **EXIT=0;Test Files 473 passed (473);Tests 7315 passed (7315)**(第 1 轮 473/7307,+8 = 本轮新增用例数) |
| `scripts/dev/atg-exec-line-post-rebase-check.sh` | Check 1 PASS(恰一条 exec 行)/ Check 2 PASS(400 token 全唯一) |
| 六个 token 仍在 exec 行上 | `approvalTemplateCenterCategory` / `SessionOrgSwitcher.spec.ts` / `approvalTemplateGroupsClient` / `ApprovalTemplateGroupsPanel` / `approvalTemplateCenterSections` / `templateCenterI18n` 全部 OK |
| 真库 `approval-template-groups-lifecycle.db.test.ts`(`vitest --config vitest.integration.config.ts`,与 `plugin-tests.yml:1669` 同形) | **1 file / 20 passed (20)** |
| 真库四个 groups 文件合跑(lifecycle + serialization + sections + reorder) | **4 files / 41 passed (41)** |
| `apps/web`:`npx vue-tsc --noEmit -p tsconfig.app.json` | **EXIT=0** |
| `apps/web`:`npx vite build` | **EXIT=0**(`✓ built in 13.91s`) |
| `packages/core-backend`:`npx tsc --noEmit` | **EXIT=0** |

> `vue-tsc` 说明:第 1 轮记录的 `vite.config.ts(28,29) TS2769` 是 `npx vue-tsc -b`(整个 solution,含 `tsconfig.node.json`)的产物;本轮按门审 §5.6 的形状跑 `-p tsconfig.app.json`,**EXIT=0,零错误**,`vite.config.ts` 本轮同样零改动。两条记录不矛盾,是两个不同的 project 范围。

### 8.5 CI / s6a / 爆炸半径 census(对第 1 轮 head 逐文件)

`git status --porcelain` 只列 11 个文件(见 §8.1),其中:

- `.github/workflows/plugin-tests.yml`、`.github/workflows/approval-web-guard.yml`、`apps/web/vitest.config.ts`、`packages/core-backend/vitest.config.ts`、`apps/web/scripts/run-required-web-tests.sh` —— **一个都不在改动清单里**(字节不变,s6a pin 不受影响)
- `packages/core-backend/src/db/migrations/` —— **零改动**(无迁移,无 DDL)
- `multitable/automation-service.ts` + `automation-approval-template-access.ts`(锁文 I6) —— **零改动**
- **零新增文件**(源码与测试都没有)⇒ 不需要新 spec token、不触四道 census 钉
- 锁文正文(`approval-form-group-entity-design-lock-draft-20260916.md`)**未触碰**——它不在本分支的 diff 里;`useSessionOrg.ts` 与 `views/attendance/AttendanceSessionOrgSwitcher.vue` **逐字节未动**(锁文 §2「不动」按字面执行,见设计 MD §5.1)

### 8.6 未做 / 交 owner

- 设计 MD §5.4 的 OPEN(持久 vs 反应式形状)——本轮给它加了一个输入,**未替 owner 定性**
- NIT-1(`data-testid` 闭世界收窄)未处理,理由见设计 MD §5.3
- 真浏览器复跑**未做**:本轮把门审的真浏览器 A/B 判据(`switchers=2` / `nth=1 ⇒ count=0`)在 vitest 里逐字复现为先红后绿(§8.3(a)),但那不等于真浏览器复验。若门审要求 E 相位重跑,需要一次新的 headless chromium 跑(后端 + vite + 一次性 UI 库),**本轮未跑,不作任何真浏览器断言**
