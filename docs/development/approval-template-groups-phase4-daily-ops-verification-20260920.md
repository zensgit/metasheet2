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
| 同上 | `P1-A: with the 管理分组 panel EXPANDED it is still exactly one switcher…` | 门审 §4 写成**未实测推论**的那格(展开面板应出现第三个);本轮把它变成被测配置,不继承推论 |
| `approvalTemplateCenterSections.spec.ts` | `P2-3 (target, already-paginated case)…` | **P2-B**;判别点=目标 page 1 刷新请求 + 被移入行真的渲染 |
| 同上 | 两条 hosted 用例(不渲染自己的切换器 / host 重放 `loadAll()` 后分节回来) | P1-A 的 child 侧契约 |
| `ApprovalTemplateGroupsPanel.spec.ts` | `P3-3: archiving re-reads the list so the rendered order is the server's…` | P3-3 |
| 同上 | hosted 用例(上报 host、不画控件、不发第二次 session-org 请求、host 重放后列表回来) | P1-A 的面板侧契约 + 门审关心的「列表会不会卡在隐藏态」 |
| `SessionOrgSwitcher.spec.ts` | `two instances on one page get distinct select ids, each paired with its OWN label` | `useId()` 的判别配置(**一个实例的集合里断言唯一性是空转**) |

### 8.3 先红后绿 / mutation 台账(21 条 = 第 1 轮 15 条全部重跑 + 本轮新增 6 条,全部 `cp` 备份 → 改坏 → 跑 → `cp` 还原 → `cmp` 校验;零 `git checkout --` / `reset --hard`)

**(a) 先红:新用例对第 1 轮实现的判别力**(把四个源文件逐字还原成 `beec0b8c7e` 的内容,只留新用例):

```
FAIL P1-A: an UNBOUND multi-org admin … exactly ONE switcher       AssertionError: expected 2 to be 1
FAIL P1-A: switching from EVERY rendered switcher instance …       AssertionError: expected +0 to be 1
FAIL P1-A: with the 管理分组 panel EXPANDED …                       AssertionError: expected 3 to be 1
 Test Files  1 failed (1)
      Tests  3 failed | 13 passed (16)
```
——前两条与门审真浏览器实测的 `switchers=2` / `nth=1 ⇒ count=0` **逐字同形**;第三条把门审 §4 那句「**推论,本轮未实测**……应当出现第三个」变成**实测值 3**。还原后 `cmp` 四个文件全部一致。

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
| M8b | 仅 unlink 调用点 → `if (false)` | 1 failed / 19 passed (20)(真库) | 承重 ✅ |
| M9 | 后端 `mapGroupConstraintError` 消息换回内部黑话原句 | 1 failed / 19 passed (20)(真库) | 承重 ✅ |
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
| 六个相关前端 spec 合跑(category / sections / panel / client / SessionOrgSwitcher / templateCenterI18n) | **6 files / 94 tests 全绿**(第 1 轮同样六文件基线 85 → 本轮 9 条新用例全部落在其中) |
| `run-required-web-tests.sh` 结尾那条 `exec` 巨行(400 token,与脚本逐字同形) | **EXIT=0;Test Files 473 passed (473);Tests 7316 passed (7316)**(第 1 轮 473/7307,+9 = 本轮新增用例数) |
| `scripts/dev/atg-exec-line-post-rebase-check.sh` | Check 1 PASS(恰一条 exec 行)/ Check 2 PASS(400 token 全唯一) |
| 六个 token 仍在 exec 行上 | `approvalTemplateCenterCategory` / `SessionOrgSwitcher.spec.ts` / `approvalTemplateGroupsClient` / `ApprovalTemplateGroupsPanel` / `approvalTemplateCenterSections` / `templateCenterI18n` 全部 OK |
| 真库 `approval-template-groups-lifecycle.db.test.ts`(`vitest --config vitest.integration.config.ts`,与 `plugin-tests.yml:1669` 同形) | **1 file / 20 passed (20)** |
| 真库四个 groups 文件合跑(lifecycle + serialization + sections + reorder) | **4 files / 41 passed (41)** |
| `apps/web`:`npx vue-tsc --noEmit -p tsconfig.app.json` | **EXIT=0** |
| `apps/web`:`npx vue-tsc -b`(第 1 轮用的那条,solution 范围) | **EXIT=2,恰 1 条错误**:`vite.config.ts(28,29): error TS2769`,与第 1 轮记录**同一条**;`git diff --stat origin/main HEAD -- apps/web/vite.config.ts` 为空(该文件与 main 逐字节相同)⇒ 环境项,非本 lane 引入 |
| `apps/web`:`npx vite build` | **EXIT=0**(`✓ built in 13.91s`) |
| `packages/core-backend`:`npx tsc --noEmit` | **EXIT=0** |

> `vue-tsc` 说明:两条都**实跑**了,不是靠论证调和。`-p tsconfig.app.json`(门审 §5.6 的形状)EXIT=0 零错误;`-b`(第 1 轮的形状,含 `tsconfig.node.json`)EXIT=2 且**只有**第 1 轮记录的同一条 `vite.config.ts(28,29) TS2769`——`vite.config.ts` 与 `origin/main` 逐字节相同,本 lane 零改动。两个 project 范围各自的实测值都在上表里。

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
- 真浏览器相位 E **已跑**(见 §8.7);C/D 两个相位**未**重跑——本轮未触碰它们打的代码(P2-B 是纯用例,P3-3 只加一次列表重读),它们的真浏览器状态仍以门审 round 1 的记录为准,本轮对它们**不作新的真浏览器断言**

### 8.7 真浏览器相位 E(自起 headless chromium,**未使用会话共享的 MCP 浏览器**)

| 项 | 值 |
|---|---|
| 浏览器 | `playwright@1.57.0`,绝对路径 `require` 自仓库 pnpm store,`chromium.launch({ headless: true })` |
| 驱动脚本 | `soak-working/a5-round2-20260920/e-phase.mjs` |
| UI 库 | `metasheet2_a5r2_ui_20260920`(另一个一次性库,`createdb -U postgres -O ms2testbed`,413 迁移 EXIT=0,零 42501) |
| 后端 / 前端 | `PORT=7803` tsx 起 `src/index.ts` 打该库 / `vite --port 8903 --strictPort`,`VITE_API_URL=http://127.0.0.1:7803` |
| 夹具 | `POST /api/auth/register` 建一个管理员,SQL 置 `role='admin', is_admin=true`,`user_orgs` 插 **两** 行(`org-alpha`/`org-beta`,`is_active=true`)⇒ 服务端实测:`GET /api/auth/session-orgs` 返回 2 个 org、`currentOrgId=null`,`GET /api/approval-template-groups` 与 `GET /api/approval-templates?section=…` **真的 403 `SESSION_ORG_REQUIRED`** —— 即锁文 §2 点名的「多 org 成员默认没有绑定 org」那个人群,不是模拟出来的 |
| 负控 | `addInitScript(window.__APPROVAL_MOCK__ = false)` + 计 `section=` 请求条数 |

**负控第一次就抓到了一个真问题,登记**:首版脚本**没有**设 `__APPROVAL_MOCK__`,而 `approvals/api.ts:39-40` 在 `import.meta.env.DEV` 下**默认走 mock**(`listTemplatesBySection` 直接 `return { data: [], total: 0 }`)。当时分节确实渲染出来了、判据全绿,但 `section=` 计数是 **0** —— 也就是那一版的分节渲染根本没碰后端。加上 override 后 `section=1`。**这正是「被触发≠被验证」**:如果不把 `section=` 计数当成评分判据而只当注释,那一版会作为「真浏览器全绿」交上去。

**结果(每格 = 本 head vs 第 1 轮 head `beec0b8c7e`,同一套库/后端/前端,只换那 4 个前端源文件)**

| 判据 | 本 head | 第 1 轮 head |
|---|---|---|
| **E1** 未绑定多 org 首次进分组视图,恰 1 个切换器 | **PASS** `switchers=1 selects=1 dup#ids=0` | **FAIL** `switchers=2 dup#ids=1` |
| **E1b** 每个 select 的 id 非空、唯一、且与**自己的** label 恰一一配对 | **PASS** `labelled=1/1` | **FAIL** `labelled=0/2`(两个控件共用写死 id,`<label for>` 只绑第一个 ⇒ 第二个的标签失联) |
| **E1(管理分组面板展开)** | **PASS** `switchers=1 panel=true` | **FAIL** `switchers=3 dup#ids=2 labelled=0/3` ⬅ 门审 §4 那句「**推论,本轮未实测**……应当出现第三个」**现在是实测值 3** |
| **E4[nth=0]** 从第 0 个实例切换后入口仍在 | **PASS** `before=1 after=1` | PASS `before=2 after=1`(第 1 轮唯一赢的那条路径) |
| **E4[nth=1]** 从第 1 个实例切换后入口仍在 | **N/A(只有一个实例)** | **FAIL** `before=2 after=0` ⬅ 门审 P1-A 的自毁,逐字复现 |
| **E4[nth=2]**(面板展开时的第三个) | **N/A** | **FAIL** `before=3 after=0`,且 `panelList=false`(面板列表还卡在被抑制态) |
| **E4** 切换后被挡住的分组视图确实被重放(无错误态) | **PASS**(每格) | PASS |
| **E3** 负控:真后端流量 + mock 关闭(`section=` 请求真的发出) | **PASS** `session-org=4 groups=8 section=1 403s=6` | PASS `session-org=18 groups=14 section=2 403s=10` |

**相位小计**:本 head `plain` **5 PASS / 0 FAIL**、`mgr`(面板展开)**7 PASS / 0 FAIL**;第 1 轮 head `plain` **4 PASS / 3 FAIL**、`mgr` **8 PASS / 5 FAIL**。

证据(截图 + 每格 JSON + 逐请求 net 日志 + 驱动脚本)存于 `soak-working/a5-round2-20260920/`,共 37 个文件;`round1src-` 前缀的是第 1 轮 head 的那两次,无前缀的是本 head 的那两次。

### 8.8 一句话说明:英文文案里为什么有中文

P3-2 的英文串带 `请假Leave` 这个例子。这不是翻译漏进了 EN 槽:`GROUP_NAME_UNSUPPORTED` 只在名字**一个 ASCII 字母/数字/符号都没有**时才触发,看到这句话的人此刻输入的就是纯 CJK 名,举一个**在他自己的名字上加一个字符就能通过**的例子比举 `Leave` 更能解释规则。中英两串举同一个例子,语义一致。

---

## 9. 第 3 轮修复(对齐 `impl-gate-A5-daily-ops-round2-20260920.md` 的 P2-C / P3-D / NIT-A / NIT-B / 记录级过强声明)

**PROPOSED — 未过门审,未 ratify。候选实现,一切裁决交 owner / 下一轮门审。**

- 被修基线 head:`0d2c99487e4982f59ba33c8d8e8216b6ec6bed3c`(round-2 被审 head,round-2 门审 CLEAR 的 5 个提交原样保留,本轮只在其上新增)
- 工作树:`…/scratchpad/a5-fix-d1`(`git worktree add --detach`;`node_modules` / `apps/web/node_modules` / `packages/core-backend/node_modules` 三处软链自 canonical)
- 库:`metasheet2_a5r2b_20260921`(`createdb -U postgres -O ms2testbed`;`psql` 核 `current_database()=metasheet2_a5r2b_20260921`、`current_user=ms2testbed`、`rolsuper=f`)
- 连接串变量普查(跑真库前):`grep -n 'DATABASE_URL' .github/workflows/*.yml` = 212 命中,全部是 CI 内联串;`package.json`/`packages/core-backend/package.json`/`apps/web/package.json` 零命中——只 export 这一个变量,指向上面这个一次性库

### 9.0 记录级勘误(先于其余条目——它更正的是「怎么读下面每一条」)

round-2 门审的 §7 NOTE 指出:实现者(round-2 实现代理)在自己的完成回复里写过一句**绝对断言**——「Mutation 21 条全部承重(round-1 的 15 条含 M8b/M9 全部重跑,M2 由存活转红;本轮新增 6 条)」。**这句话不在本文件里**(§8.3 的台账本身一直是逐条列表,每行都单独标了「承重 ✅」)——它出现在实现代理当轮回复给调用方的纯文本里,门审读取会话记录时把它当作记录级声明一并核验并证伪。为避免同一句话被后续轮次继续引用,这里把它逐字撤回并按门审 round 2 §5.5/§7 的**实测**结果登记(不手写新数字,数字抄自 `impl-gate-A5-daily-ops-round2-20260920.md`):

> **撤回**:「Mutation 21 条全部承重」——这句话说的是**实现者自己在 round-2 时的内部台账**(该轮验证 MD §8.3,15 条 round-1 探针复跑 + 6 条新探针),不是独立门审的结果,且用词是不受限定的绝对断言。round-2 门审对同一批修复**独立**重跑/新增了 **26** 个探针(门审自己的命名,与实现者 §8.3 的 `M1…M9`/`R1…R7` 命名不是同一套编号——两套探针在意图上重叠但不是同一批,下表一律用门审 `impl-gate-A5-daily-ops-round2-20260920.md` §5.5 的原始命名,不换算、不新编号),其中 **3** 个门审第一次运行时存活(测试全绿、mutation 未被捕获),另有 **2** 个门审判定为「可辩护地 inert」(不计入失败,但也不计入「承重」)。

| 分类 | 数量 | 探针(门审命名,原样抄自 `impl-gate-A5-daily-ops-round2-20260920.md` §5.5) | 处置(本轮) |
|---|---|---|---|
| 承重 ✅ | 21 | 本轮新增 6 个:M-a / M-a2 / M-c / M-d / M-g / M-i;round-1 探针复跑 15 个(门审重述命名):M1 / M2 / M3 / M4 / M4b / M5 / M6 / M6b / M7 / M7b / M7c / M7d / M8 / M8b / M9 | 无需处置,原样成立 |
| 存活(未测守卫)❌ | 3 | M-e / M-f / M-h | 本轮 §9.1/§9.2 逐条补测,补完后 M-e/M-f/M-h 均已重跑变红(见下) |
| 可辩护地 inert | 2 | M-b / M-b2 | 门审已给出理由(hosted 子组件的 `orgs` 无读者);本轮未新增覆盖,原样登记为已知、可辩护的冗余防御,不计入「承重」分母 |

**这份 21/3/2 的分类本身也不是本轮新写的数字**——逐字抄自门审报告 §5.5「26 个探针:21 个承重,3 个存活(M-e/M-f/M-h),2 个可辩护地 inert(M-b/M-b2)」。实现者自己那套 `M1…M9`/`R1…R7`(§8.3)命名的探针与门审这 26 个探针不是同一份清单的两种写法,不作字面对应;需要复核实现者那份台账时,应回 round-2 验证 MD 自己的 §8.3,而不是拿这里的门审命名去反查。

**这不是指控隐瞒**——round-2 门审自己的措辞也是如此(「这不是指控隐瞒;按本仓『对抗审主要抓过强声明』的判据,被证伪的完成声明本身要单列」)。处置方式是**逐条列表 + 分类**,不是补一个新的总数断言。

### 9.1 P2-C——`sessionOrgRequiredSeen` 可见性机制补两条判别用例

- **file:line(被测代码,零改动)**:`apps/web/src/views/approval/TemplateCenterView.vue:555-558`(`showPageSessionOrgSwitcher = pageSessionOrgHasMultiple.value || sessionOrgRequiredSeen.value`)、置位方 `notifySessionOrgRequired()`(同文件)
- **新增用例**:`apps/web/tests/approvalTemplateCenterCategory.spec.ts`——`P2-C: an unbound multi-org admin whose session-orgs lookup ALSO fails still gets exactly one switcher, in its error state`(`GET /api/auth/session-orgs` 500 + 分节视图的 group 调用 403 `SESSION_ORG_REQUIRED` 同时发生)
- **断言**:恰 1 个 `[data-testid="session-org-switcher"]`;它是**失败态**而非可用下拉——`select.disabled===true`、零个真实 org `<option>`、`.session-org-switcher__hint--error` 节点存在
- **mutation 实测(`cp` 备份 → 改坏 → 跑 → `cp` 还原 → `cmp` 校验,零 `git checkout --`)**:
  ```
  M-e(去掉第二析取项 `|| sessionOrgRequiredSeen.value`) → 1 failed: expected +0 to be 1
  M-f(notifySessionOrgRequired 换成 no-op)              → 1 failed: expected +0 to be 1
  ```
  两条均由 round-2 门审记录的「76 passed(存活)」变为**本轮红**。还原后 `cmp` 两次均 OK。

### 9.2 P3-D——解档侧补镜像用例

- **file:line(被测代码,零改动)**:`apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue`(`onUnarchive` 内紧随 `emit('changed')` 的 `await loadGroups()`)
- **新增用例**:`apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts`——`P3-D: unarchiving re-reads the list so the rendered order is the server's, not the pre-unarchive one`(镜像既有 P3-3 归档用例,角色对调)。夹具:两个已归档分组,`atg_3` 归档时间**晚于** `atg_1`(服务端 `archived_at DESC` ⇒ 初始渲染顺序 `[atg_3, atg_1]`);解档 `atg_1` 后服务端顺序变为 `[atg_1(active), atg_3(archived)]`——原地 swap 不会重排,只有真的重读才会
- **mutation 实测**:
  ```
  M-h(删 onUnarchive 的 await loadGroups()) → 1 failed: 期望 ['atg_1','atg_3'],实得 ['atg_3','atg_1']
  ```
  由 round-2 门审记录的「76 passed(存活)」变为**本轮红**。还原后 `cmp` OK。

### 9.3 NIT-A——文案改为与 CHECK 一致的表述

- **file:line**:`apps/web/src/approvals/api.ts`(`GROUP_NAME_UNSUPPORTED` 条目,round-2 头行号 `:1291-1293`)
- **改法**:`Latin letter` → `letter (A–Z)`;中文「拉丁字母」→「英文字母（A–Z）」。`[!-~]`(ASCII 33–126)覆盖的字母子集恰是 A–Z,不再暗示 `Ñ`/`é` 这类非 ASCII 拉丁字母也算数(门审 §7 NIT-A 的反例:`'Ñ' ~ '[!-~]'` 为假)。不采用后端内部的逐字措辞「ASCII letter」——保持产品语言,不引入新术语。
- **回归**:`approvalTemplateGroupsClient.spec.ts` 与 `ApprovalTemplateGroupsPanel.spec.ts` 里钉住这段文案的用例只断言 `/at least one/i` 与 `请假Leave` 子串,均未断言过 `Latin`,故文案改动零红——已实跑确认(见 §9.5 五文件合跑数字)。

### 9.4 NIT-B——条件式 `data-testid` 处置

> **【第 3 轮失效标记 — 只作用于本段的状态断言】** 下面这句「本轮**未改动**」在第 3 轮**不再成立**:条件式 `data-testid` 已改为固定 `approval-template-groups-item` + `:data-archived`(设计 MD §6.6,验证 MD §10.1/§10.2)。本段其余内容——为什么 round-1/round-2 判它可以缓、以及缓的代价——**仍然 OPERATIVE**,它们正是第 3 轮决定动它的理由。

**处置:维持不改,正式登记(不是遗漏)。** `ApprovalTemplateGroupsPanel.vue:84` 的 `:data-testid="group.archivedAt ? 'approval-template-groups-item-archived' : 'approval-template-groups-item'"` 本轮**未改动**。理由与 round-1/round-2 门审的登记一致且未过期:
1. 这条件式收窄本身是 P2-1(归档视觉区分)存在的**原因**,不是副作用——两个不同的 testid 正是 D2/D3 真浏览器判据与 P2-1 用例（本文件 `'P2-1: an archived group is visually distinct...'`）引用的锚点；
2. 改成「统一 testid + `data-archived` 属性」会动到已经过 round-1/round-2 两轮门审 CLEAR 的判据面，属于**独立的卫生（hygiene）切片**，不在本轮 P2-C/P3-D/NIT-A/记录级四项授权范围内；
3. round-2 门审自己的处置是「仍开放,不重复计分」——本轮不升级、不降级这一判定,只是把它从「隐含维持」改成本节里的**显式登记**，供下一轮门审或 owner 直接引用，不必每轮重新说明。

若 owner 之后要收口这条 NIT，需要单独一个切片，并重新走一遍 P2-1 相关用例的门审。

### 9.5 补充：两组承重场景用例(vitest 层，真浏览器留给门审）

审阅方在 P2-C/P3-D/NIT 之外，额外要求补两组防回归用例——这两组本身不是"新发现"，而是把已经存在、但此前从未在 vitest 层被固化的两条不变量钉下来：

**(i) 退出登录 / 换账号后，host 的组织上下文被清理**

- 机制（零新代码——`useSessionOrg.ts` 属设计锁 §2「不动」文件，本身已经这样做）：`useAuth.setToken`/`clearToken` 统一经 `resetSessionBootstrap` 调 `notifyAuthPrincipalChange()`；`useSessionOrg` 在其 `onAuthPrincipalChange` 回调里把 `orgs`/`currentOrgId`/`errorMessage` 清空。`TemplateCenterView` 的 `pageSessionOrg` 是该 composable 的页面级单实例（P1-A），因此这个清理对 host 同样生效。
- **新增用例**（`apps/web/tests/approvalTemplateCenterCategory.spec.ts`）：
  - `(i) signing out clears the host's session-org list — nothing from the previous account is left rendered`
  - `(i) switching accounts clears the host's session-org list before the new account's own load lands`
- **判据**：两条都是硬断言（非条件式）——`clearToken()`/对新账号 `setToken()` 之后，`container.querySelectorAll('[data-testid="session-org-switcher"]').length` 必须为 `0`（`hasMultipleOrgs` 因 `orgs` 被清空而转假，且本场景 `sessionOrgRequiredSeen` 从未被置真）。
- 这两条是**回归哨兵**：`useSessionOrg.ts` 本身受锁保护不能改，风险点在于未来有人在 `TemplateCenterView.vue` 里另开一条不经过该 composable 的缓存路径（例如把 `orgs` 快照进本地变量）——真出现这种改法，这两条用例会先变红。

**(ii) 快速连续切换两次 org，旧请求晚到不得覆盖新 org 的分组结果**

- **发现**：`TemplateGroupSections.vue` 的 `loadAll()` 与 `ApprovalTemplateGroupsPanel.vue` 的 `loadGroups()` 此前都**没有**请求代数（generation/token）守卫——`TemplateCenterView.onPageSessionOrgChange` 在每次成功切换后都会分别调用二者一次；若管理员快速连续切换两次 org，两次调用的网络往返可能乱序完成，后完成的（可能是先发出、对应"已经离开"的旧 org）会无条件覆盖 `sections.value`/`groups.value`，即使它已经不是当前选中的 org。
- **实现方式（先红后绿）**：在两个函数里各加一个模块级自增计数器 `loadGeneration`；每次调用在入口 `const generation = ++loadGeneration`，并定义 `isCurrent = () => generation === loadGeneration`；成功分支在写 `sections.value`/`groups.value`（以及 `sessionOrgBlocked.value`/`loadError.value`）前先 `if (!isCurrent()) return`；`catch` 分支同样先判断（含 `SESSION_ORG_REQUIRED` 分支——一个过期请求的 403 不应该去顶替一个已经成功的新请求的状态）；`finally` 里的 `loading.value = false` 也只在 `isCurrent()` 时执行，防止旧请求的 finally 抢先关闭一个仍在进行的新请求的 loading 态。**后发出的调用永远最终获胜，不论谁先返回**——不是简单的"取最后一个 resolve"，是"取代数上最新的那一次调用"。
- **file:line**：`apps/web/src/views/approval/TemplateGroupSections.vue`（`loadGeneration` + `loadAll()`，紧邻 `fetchPage` 之后）；`apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue`（`loadGeneration` + `loadGroups()`，紧邻 `handleSessionOrgRequired` 之后）
- **新增用例**：
  - `apps/web/tests/approvalTemplateCenterSections.spec.ts` → `TemplateGroupSections — request algebra guard (rapid org switch)` → `(ii) a stale loadAll() answer that arrives AFTER a newer one must not overwrite the newer org's rendered sections`
  - `apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts` → `ApprovalTemplateGroupsPanel — request algebra guard (rapid org switch)` → `(ii) a stale loadGroups() answer that arrives AFTER a newer one must not overwrite the newer org's rendered list`
  两条用例都手工控制两次调用各自底层 promise 的 resolve 时机（先发出的后 resolve，模拟真实网络乱序），断言最终渲染内容只包含"新 org"的分组名，不包含"旧 org"的。
- **先红后绿实测**（`cp` 备份 → 还原到 round-2 head 的写法 → 跑 → `cp` 还原 → `cmp` 校验）：
  ```
  TemplateGroupSections（无守卫）:      1 failed — expected '...' to contain 'Fresh Org Group'（实际渲染的是 'Stale Org Group'）
  ApprovalTemplateGroupsPanel（无守卫）: 1 failed — expected '...' to contain 'Fresh Org Group'（实际渲染的是 'Stale Org Group'）
  ```
  两处补上守卫后各自变绿；两个文件的既有用例（sections 25/25、panel 12/12）在加守卫后逐一复跑，零回归。

### 9.6 全量实跑(数字逐字抄自输出)

| 门 | 结果 |
|---|---|
| 5 个被点名的 FE spec 合跑(category / sections / panel / client / SessionOrgSwitcher) | **5 files / 82 passed (82)**(round-2 记录的同五文件基线 76 → 本轮 6 条新用例：P2-C ×1、(i) ×2、P3-D ×1、(ii) ×2 = 82) |
| `apps/web`:`npx vue-tsc --noEmit -p tsconfig.app.json` | **EXIT=0** |
| `packages/core-backend`:`npx tsc --noEmit` | **EXIT=0** |
| `apps/web`:`npx vite build` | **EXIT=0**(`✓ built in 13.46s`;既有 chunk-size 警告与本轮无关) |
| `run-required-web-tests.sh` 结尾那条 `exec` 巨行(与脚本逐字同形,直接抽取执行) | **EXIT=0;Test Files 473 passed (473);Tests 7322 passed (7322)**(round-2 记录 473/7316,+6 = 本轮新增用例数,逐条对得上) |
| 真库四个 group 文件合跑(`metasheet2_a5r2b_20260921`,`vitest --config vitest.integration.config.ts`,与 `plugin-tests.yml:1669-1672` 同形) | **4 files / 41 passed (41)**(与 round-2 记录一致——本轮零后端行为改动，只改了一段注释级措辞判据以外的前端文案与两处前端 mutation 守卫) |

### 9.7 CI / s6a / 爆炸半径 census(对 round-2 head 逐文件)

- `git diff --stat 0d2c99487e -- .github/workflows/plugin-tests.yml .github/workflows/approval-web-guard.yml .github/workflows/attendance-web-guard.yml apps/web/vitest.config.ts packages/core-backend/vitest.config.ts apps/web/scripts/run-required-web-tests.sh package.json apps/web/package.json packages/core-backend/src/db/migrations/` → **空**（九个 CI 钉文件 + 迁移目录字节不变）
- **零新增文件**——本轮六个改动全部落在 round-2 已经改过的既有六个文件（`api.ts` / `TemplateGroupSections.vue` / `ApprovalTemplateGroupsPanel.vue` / 三个既有 spec）之内，不需要新 spec token，不触 s6a pin，不需要考勤四道 census 钉
- 锁文正文（`approval-form-group-entity-design-lock-draft-20260916.md`）未触碰；`useSessionOrg.ts` 与 `views/attendance/AttendanceSessionOrgSwitcher.vue` 逐字节未动（本轮的 mutation 校验虽然临时改写过 `useSessionOrg.ts` 以外的文件用于红绿对照，从未改写过这两个文件本身；(i) 的两条用例完全不需要改写它们即可验证——它们验证的是已有行为，不是新写的行为）

### 9.8 未做 / 交 owner（本轮新增）

- §9.4（NIT-B）的收口本身——本轮只登记disposition，不实现
- §9.0 撤回的「全部承重」断言之外，round-2 门审 §7 记录的 `sessionOrgRequiredSeen` 一旦置真永不复位的记录级事实——本轮**未处理**（不在 P2-C/P3-D/NIT-A/NIT-B/记录级四项授权范围内，门审自己也只是"建议在补测里钉住"，未升级为阻断项）
- round-2 §9 交 owner 的三条（P2-5 持久 vs 反应式形状 OPEN、被挡住写动作不自动重放的产品决策、§3.2 管理面板 UI 未列入锁文分期清单）——本轮未触碰这些讨论，原样沿用 round-2 的登记

一切仍是**候选**，不构成"已裁 / 已 ratify"；本节记录的红绿与数字均可复核（分支 `feat/approval-template-groups-phase4-daily-ops`）。

---

## 10. 第 3 轮验证(对齐 `impl-gate-A5-daily-ops-round2b-20260921.md`:P2-D / P3-E / P3-F / NIT-B / NIT-C)

> 起点 head(门审对象)= `288530a0cdc17067910994e758a705e631bff5b7`。设计见设计 MD §6「组织上下文生命周期」。
> **一切是候选**:未裁、未 ratify、未合并、未开 PR、未 undraft。
> 本节的「未做」逐条给理由,**前两轮的结果只作历史证据,不填充本轮未执行项**。

### 10.1 改了什么(6 个源文件 + 3 个 spec + 2 个 MD;零新增文件)

| 文件 | 改动 |
|---|---|
| `apps/web/src/composables/authPrincipal.ts` | 新增 `onAuthSessionSwitch` + 内部 `readAuthSessionSignature`。**延后一个微任务再读签名**:`useAuth.setToken`/`clearToken` 先发通知后写存储,通知那一刻读到的是离场会话 |
| `apps/web/src/views/approval/TemplateCenterView.vue` | 闩锁 → principal-keyed claim(失败即丢弃);`onAuthSessionSwitch` 生命周期监听(清理同步 / 重取延后一 tick);`flatListStale` + `visibleTemplates`;`loadData`/`loadCategories`/`loadRecentTemplates` 请求代数;`reloadOrgScopedSurfaces()`(分节/面板/平铺/分类/最近使用);重试控件;`onPageSessionOrgChange` 的 own-switch 窗口;过强注释改写 |
| `apps/web/src/views/approval/ApprovalTemplateGroupsPanel.vue` | 自有 principal 重置(含 `loadGeneration++`)+ own-switch 例外(保 `pendingRetry`/草稿,重放才成立);NIT-B 固定 `data-testid` + `data-archived` |
| `apps/web/src/views/approval/TemplateGroupSections.vue` | 同上(无草稿态) |
| `apps/web/src/views/approval/templateCenterLabels.ts` | 重试控件文案(ZH/EN) |
| `apps/web/src/approvals/api.ts` | NIT-C 文案 |
| 3 个 spec | 17 条新用例(§10.2);两条 NIT-B 断言改写 + 一条 NIT-C 断言 |

### 10.2 新增用例(17 条,全部落在既有文件;用例名逐字对应 ①-④)

**① 外部身份变化 —— `apps/web/tests/approvalTemplateCenterCategory.spec.ts`**

| 用例 | file:line |
|---|---|
| `(① sign-out) clears the previous account's organization list AND its grouped/flat data, leaves no error behind, and re-asks nothing` | `apps/web/tests/approvalTemplateCenterCategory.spec.ts:1225` |
| `(① different account) re-asks for the NEW account's organizations; the entry comes back for it and carries none of the previous account's options` | `:1275` |
| `(① same account, rights change) losing the second organization re-asks and takes the entry away — no stale list, no error` | `:1311` |
| `(① same account, rights change) GAINING a second organization brings the entry back without a reload` | `:1344` |
| `(① another tab) a token swapped with NO notification at all is caught by the principal-keyed claim on the next entry into the grouped view` | `:1373` |
| `(①) a "blocked on a session-org choice" state does not carry over to the next identity — acceptance J's control holds for a single-org successor` | `:1409` |
| `(①) an external principal change drops this panel's rendered groups, and the load it had in flight cannot commit afterwards` | `apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts:785` |
| `(①) an external principal change drops the rendered sections, and the load in flight for the previous identity cannot commit afterwards` | `apps/web/tests/approvalTemplateCenterSections.spec.ts:1247` |
| 既有 `(i) switching accounts …`(r2)**被补强**:不再只断言清空,追加 `sessionOrgsCalls === 2` 与「入口回来」 | `apps/web/tests/approvalTemplateCenterCategory.spec.ts:1129` |

**② 所有数据视图同步**

| 用例 | file:line |
|---|---|
| `(②) switching organization re-reads the FLAT gallery and the category list, not only the grouped surfaces`(并断言本页自己切换**不多发** session-orgs,且再次进入分组视图仍不发) | `apps/web/tests/approvalTemplateCenterCategory.spec.ts:1451` |
| `(②) while the new organization's template list is in flight the flat surfaces show their empty state, never the previous organization's rows`(注入延迟;期间断言 `[data-el-row]` 为 0 且 store **仍持有**旧行 ⇒ 证的是「拒绝渲染」而不是「store 空了」) | `:1495` |

**③ 异步三出口**

| 用例 | file:line |
|---|---|
| `(③ catch exit) a stale loadGroups() FAILURE landing after a newer one must not post the previous org's error over the new org's list` | `apps/web/tests/ApprovalTemplateGroupsPanel.spec.ts:691` |
| `(③ finally exit) a stale loadGroups() settling while the newer one is STILL in flight must not clear the newer request's loading state`(带正控:竞态前空行**在场**) | `:735` |
| `(③ catch exit) a stale loadAll() FAILURE landing after a newer one must not replace the new org's sections with the previous org's error` | `apps/web/tests/approvalTemplateCenterSections.spec.ts:1170` |
| `(③ finally exit) a stale loadAll() settling while the newer one is STILL in flight must not clear the newer request's loading state`(带正控:结算后 loading 态**不在场**) | `:1205` |
| (成功出口 = r2 既有的两条 `(ii) …`,本轮未动) | — |

**④ 失败可恢复**

| 用例 | file:line |
|---|---|
| `(④) a FAILED organization-list lookup offers a retry, and the retry re-asks and brings the entry up` | `apps/web/tests/approvalTemplateCenterCategory.spec.ts:1549` |
| `(④) after a failed lookup, simply re-entering the grouped view re-asks — the entry is not latched off for the lifetime of the view` | `:1582` |
| `(④) a request issued for the PREVIOUS identity that lands with a 403 afterwards triggers no recovery action for the new one` | `:1611` |

### 10.3 Mutation 台账 —— 本轮 15 条新探针 + r1/r2/r2b 全部重跑(零回退)

> 规程:`cp` 备份到 `~/.claude/projects/<proj>/reviews/a5r3b-mutbak/` → 改坏 → **`cmp` 确认文件真的变了**(防无效 mutation)→ 跑 → 记 → `cp` 还原 → `cmp` 校验。全程零 `git checkout --` / `reset --hard` / `stash drop`;结束 `git status --porcelain` 为空。

#### (a) 本轮新代码的 15 条探针

| # | 目标 | 改法 | 结果 | 判定 |
|---|---|---|---|---|
| **M-p** | panel `loadGroups` 的 `finally { if (isCurrent()) … }` | 改成无条件 | **1 failed / 14 passed**,红在 `(③ finally exit)`:`expected <li …> to be null` | 承重 ✅ **P3-F 的一角关闭** |
| **M-q** | sections `loadAll` 的 `finally` 同上 | 同上 | **1 failed / 27 passed**,红在 `(③ finally exit)`:`expected null not to be null` | 承重 ✅ |
| **M-r** | panel `catch` 的 `if (!isCurrent()) return` | 删 | **1 failed / 14 passed**,红在 `(③ catch exit)`:`expected <p role="alert" …> to be null` | 承重 ✅ |
| **M-s** | sections `catch` 的 `if (!isCurrent()) return` | 删 | **1 failed / 27 passed**,红在 `(③ catch exit)`:`expected <div …> to be null` | 承重 ✅ |
| **M-t** | host claim 的 keying + 复位一并换回布尔闩锁 | `if (mutRequested) return` | **8 failed**(全部 ① / ④ 用例) | 承重 ✅ **P2-D 关闭** |
| **M-t2**(窄化) | 只去掉 keying(`if (pageSessionOrgsClaim) return`),保留监听器复位 | 同上 | **1 failed**,恰好红在 `(① another tab)` | 承重 ✅(keying 单独有判别力) |
| **M-u** | 整个 `onAuthSessionSwitch` 监听体换成 no-op | 早 return | **7 failed**(①×5 / ②×1 / ④×1) | 承重 ✅ |
| **M-v** | settle 里的「失败丢弃 claim」 | 删那一行 | **2 failed**,两条 ④ 重试用例 | 承重 ✅ |
| **M-w** | `visibleTemplates` 的陈旧闸 | 恒返回 `store.templates` | **2 failed**(① sign-out / ② in-flight) | 承重 ✅ **P3-E 的渲染侧** |
| **M-x** | `reloadOrgScopedSurfaces` 去掉平铺三件 | 只留两个分组面 | **2 failed**(两条 ②) | 承重 ✅ **P3-E 的重读侧** |
| **M-y** | sections 重置里的 `loadGeneration++` | 删 | **1 failed**,红在 sections 的 `(①)` | 承重 ✅ |
| **M-ab** | panel 重置里的 `loadGeneration++` | 删 | **1 failed**,红在 panel 的 `(①)` | 承重 ✅ |
| **M-ac** | panel 重置里的 `groups.value = []` | 删 | **1 failed**,红在 panel 的 `(①)` | 承重 ✅ |
| **M-z** | `onAuthSessionSwitch` 的微任务延后 | 改成通知时立即读签名 | **8 failed**(三个 spec 全部 ① + ② + ④) | 承重 ✅ |
| **M-aa** | 重试控件 `v-if="pageSessionOrgsFailed"` | → `false` | **1 failed**,红在 ④ 重试用例 | 承重 ✅ |
| **M-ad** | claim 的 own-switch 重钥 | 一律置 null | **1 failed**,红在 `(②) switching organization …` 的「再次进入不重发」断言 | 承重 ✅ |
| **M-ae** | 监听器里的 `sessionOrgRequiredSeen.value = false` | 删 | **1 failed**,红在 `(①) a "blocked on a session-org choice" …` | 承重 ✅ |
| **M-nitc** | NIT-C 文案 | 换回 `letter (A–Z)` / `英文字母（A–Z）` | **1 failed**,红在 `approvalTemplateGroupsClient.spec.ts` 的 `not.toMatch(/A\s*[–-]\s*Z/)` | 承重 ✅ |

**未找到判别输入、登记为纵深防御(不算进承重分母)**:host settle 的 claim 身份比对(设计 MD §6.4 b)、`loadCategories` / `loadRecentTemplates` 的代数守卫。理由:`useSessionOrg.loadSessionOrgs` 自己的代数守卫已在上游压住陈旧答案的错误写入,单独中和它们造不出可见差异。**不声称承重**。

#### (b) r1 / r2 / r2b 全部前轮探针重跑 —— **零回退**

| 探针(前轮编号) | 本 head 结果 | 红在哪 |
|---|---|---|
| M-e | 1 failed | `P2-C: an unbound multi-org admin whose session-orgs lookup ALSO fails …` |
| M-f | 1 failed | 同上 |
| M-c(`provide` 删除) | 3 failed | 两条 P1-A + 本轮 `(①) blocked-state …` |
| M-d(`useId` 写死) | 1 failed | `SessionOrgSwitcher.spec.ts > two instances … distinct select ids` |
| M7(`hasMultipleOrgs` → `length > 0`) | 3 failed | 验收 J 正控 + 本轮两条「权限变化」 |
| M7b(`watch(viewMode)` 不取数) | ≥3 failed | 已绑定入口 / 切换重读 / `(i) signing out` |
| M7c(切换后两处分组重读删) | ≥3 failed | 切换重读 / P1-A / 本轮 `(②) …FLAT gallery…` |
| M7d(切换器 `v-if` → false) | ≥3 failed | 三条入口用例 |
| M-a / M-a2(子组件 `&& sessionOrgHost === null`) | 3 / 2 failed | P1-A 与 hosted 用例 |
| M1 / M2 / M3(分节分页三分支) | 2 / 1 / 1 failed | P2-3 三条(M2 = r1 存活项,仍承重) |
| M4 / M4b / M5 / M6 / M6b | 2 / 3 / 1 / 1 / 1 failed | P2-1 / P2-4 / P2-2 各自判据 |
| M-g / M-h(归档 / 解档重读) | 1 / 1 failed | P3-3 / P3-D |
| M-i(P3-2 文案换回无规则句) | 2 failed | 客户端映射 + 面板渲染 |
| **M8 / M8b / M9(后端,真库)** | 各 **1 failed / 18 passed / 1 skipped** | P3-1 typed 400 ×2、P1-3 CJK 名 400 |

### 10.4 真后端 + 自起 headless chromium(**未使用会话共享的 MCP 浏览器**)

**台**:一次性库 `metasheet2_a5r3b_20260921`(`-O ms2testbed`,`rolsuper = f`;`psql` 核 `current_database()` = 该库),`DATABASE_URL` / `ATTENDANCE_TEST_DATABASE_URL` / `KANBAN_DB` / `PGUSER` / `PGDATABASE` / `PGHOST` 全部指向它(发包前已按硬约束 `grep -n 'DATABASE_URL' .github/workflows/*.yml` 与各 `package.json` 做连接串变量普查);后端 `tsx src/index.ts` on :7801;前端 `vite` on :5231 代理 `/api` → :7801;`globalThis.__APPROVAL_MOCK__ = false`(`api.ts:36-38` 自己写明的 Playwright 钩子)让审批面走真网络;playwright chromium headless,自起自关。

种子:`multi-admin`(org-alpha + org-beta 两条 `user_orgs` 活跃)、`solo-member`(仅 org-alpha);每个 org 各一个分组(`Alpha Group One` / `Beta Group One`)与一个模板。

| 观测 | 输出(逐字) | 对应边界 |
|---|---|---|
| B0 挂载 | `mount list reqs = 2` `["/api/approval-templates?page=1&pageSize=10","/api/approval-templates/categories"]`;`flat switchers = 0` | 平铺无常驻切换器 |
| B1 进分组 | `grouped switchers = 1`;`options = ["org-alpha","org-beta"]`;`shows Alpha grp = true` | 入口可达 |
| B2 切到 org-beta | `switchers after = 1`;`shows Beta grp = true`;`shows Alpha grp = false`;**`flat-list reqs = 3`(含一条裸 `?page=1&pageSize=10`)**;`category reqs = 2`;**`session-orgs reqs = 0`** | ② 平铺重读 + own-switch 不多问组织 |
| C0→C1→C2 在途窗口 | `flat rows at mount = 2` → **`flat rows IN FLIGHT = 0`** → `flat rows AFTER = 2`(用 `page.route` 卡住切换后的 `?page=` 响应) | ② 不把旧组织数据当新结果 |
| B3 同账号失权(库里置 `is_active=false` 再换发同主体令牌) | `session-orgs reqs = 1`;`switchers = 0`;`retry control = 0`;`sections error = 0` | ① 失权 ⇒ 入口消失且无错误残留 |
| B4 同账号复权 | `session-orgs reqs = 1`;`switchers = 1`;`options = ["org-alpha","org-beta"]` | ① 仍具资格 ⇒ 无刷新回来 |
| B5 登出 | `switchers = 0`;`retry = 0`;`sections error = 0`;`panel error = 0`;**`session-orgs reqs = 0`**;`shows any org grp = false` | ① 登出 ⇒ 消失、不重问、无错误 |
| D1 组织列表 500 | `session-orgs reqs = 1`;`switchers = 0`;**`retry control = 1`** | ④ 失败可见且可区分于「无资格」 |
| D2 点重试 | `session-orgs reqs = 1`;`switchers after retry = 1`;`retry control = 0`;`options = ["org-alpha","org-beta"]` | ④ 可恢复,非永久闩锁 |
| E1 换成单 org 账号 | `session-orgs reqs = 1`;`switchers = 0`;`retry = 0`;`sections error = 0`;`shows Beta grp = false`;`shows Alpha grp = true`(solo-member **本就是** org-alpha 成员,这是它自己 org 的新读,正确) | ① 换账号 |
| 控制台 | `CONSOLE ERRORS = 1`,唯一一条是 D1 故意注入的 500 | — |

截图:`/tmp/a5r3b-browser/{b1,b2,b3-rights-change,b4-regained,b5-signed-out,c1-inflight,c2-after,d1-failed-lookup,d2-after-retry,e1-other-account}.png`。

**真浏览器 NOT RUN(逐条给理由,不用前两轮结果填充)**:
1. **③ 三出口**:需要把两个重叠请求分别卡在成功 / 失败 / finally 三种落地顺序上,真浏览器里没有可靠的「让第一个请求晚于第二个但先进 finally」的构造点;留在 vitest 用可控 resolver 驱动(§10.2 四条用例 + M-p/M-q/M-r/M-s 四条 mutation)。**登记为 NOT RUN,不推论**。
2. **「平铺行换成另一批」**:本地真后端的模板列表**不是 org 作用域的**(两个 org 读到同一批模板,已实测),这是本切片之外的既有后端性质。因此真浏览器能证「会重读」+「窗口期不显示旧行」,**证不出「行内容换了」**。登记,不夸大。
3. **相位 C / D 的 21 条 r1 判据**:本轮未重跑,理由与 r2b 相同(未触碰其代码路径)。前两轮结果只作历史证据。

### 10.5 静态检查与全量实跑(数字逐字抄自输出)

```
# 5 个被触碰 spec
Test Files  5 passed (5)
      Tests  99 passed (99)        # 起点 head 为 82 ⇒ +17

# 邻居 5 个(templateCenterI18n / approvalTemplateGovernance / useSessionOrg /
#            AttendanceSessionOrgSwitcher / approval-e2e-permissions)
Test Files  5 passed (5)
      Tests  75 passed (75)

# required 门真正承重的那条 exec 巨行(五个相关 spec 的 token 全在该行上)
EXECLINE_EXIT=0
Test Files  473 passed (473)
      Tests  7339 passed (7339)     # r1 记录为 473 / 7307

# vue-tsc -b --force
VUE_TSC_EXIT=0 ; `error TS` 计数 = 1 ,唯一一条 = vite.config.ts(28,29) TS2769
  → 归因:`git diff --quiet origin/main HEAD -- apps/web/vite.config.ts` = 0(与 main 逐字相同)
  → 本轮 6 个被改的 src 文件在 vue-tsc 输出里 0 命中

# vite build
VITE_BUILD_EXIT=0 ,✓ built in 12.10s

# packages/core-backend tsc --noEmit
error TS 计数 = 0

# 真库(一次性库,非超级 owner)
Test Files  3 passed (3)
      Tests  28 passed | 3 skipped (31)
```

**字节级闸(本轮新加,因为本轮差点漏掉它)**:

```
# 每个被改的源文件都必须是 git 眼里的 TEXT,不是 Bin
git diff --stat <base> <head> -- <每个被改文件>        # 出现 `Bin` 或 `Binary files … differ` 即红
python3 -c "print(open(F,'rb').read().count(b'\\x00'))"   # 必须 0
```

**第一次 push(`0f30f3d2ef`)在这一条上是红的**:`readAuthSessionSignature` 的模板串分隔符被写成了**裸 NUL**(U+0000)。它是合法字符串字面量,所以 `vue-tsc` / `vite build` / 7339 条用例**全绿**、一条都发现不了;但 `git diff --stat` 给出 `apps/web/src/composables/authPrincipal.ts | Bin 6672 -> 9624 bytes`,`git diff` 给出 `Binary files a/… and b/… differ` —— 门审会拿到一个**读不出内容的 diff**,secret-scan 也会跳过该文件(`finding_raw_nul_in_domain_constants`)。修法不改行为(签名只做相等比较):`return JSON.stringify([key, readStoredToken()])`,不再引入任何分隔字符。修后该文件 NUL 计数 = 0、`git diff` 正常渲染为文本。

**required 全脚本(`run-required-web-tests.sh`)本地 EXIT=1 —— 原因是一条与本轮无关的既有失败,已机械取证**:

- 失败项:`tests/multitable-recovery-archive-modal.spec.ts > ManualArchiveCapture > does not submit when durable request identity cannot be saved`(`:161:29`,`expect(ctx.capture).not.toHaveBeenCalled()`)。
- 该文件不 import 本轮改过的任何模块(`grep -nE 'authPrincipal|useAuth|TemplateCenterView|TemplateGroupSections|ApprovalTemplateGroupsPanel|approvals/api|templateCenterLabels'` 零命中)。
- 在**门审起点 head `288530a0cd`** 的独立检出上单跑:**同一条用例、同样 `1 failed | 53 passed (54)`**。
- 在 **`origin/main`(`5edf4c3e17d3608fa4513b5ffd801142da026dcf`)** 的同一检出上单跑:**同样 `1 failed | 53 passed (54)`**。
- ⇒ 既有条件(本机环境,main 的 required CI 现为绿),**不是本轮回退**,本轮不在其范围内修它。脚本 `set -euo pipefail` 在该块处终止,所以它后面的那条 `exec` 巨行由本轮**单独实跑**(上方 `EXECLINE_EXIT=0`,473/7339)。

### 10.6 CI / 爆炸半径 census(对本轮 head 逐条机械复核)

| 门 | 结果 | 证据 |
|---|---|---|
| 锁 v2.13 §2「考勤原文件与 `useSessionOrg.ts` 不动」 | **PASS** | `git diff --quiet e90d16c90f HEAD -- apps/web/src/composables/useSessionOrg.ts` = 0;`… -- apps/web/src/views/attendance/AttendanceSessionOrgSwitcher.vue` = 0 |
| 锁外新能力 | **零** | 零新端点 / 零新路由 / 零新 flag / 零 DDL / 零迁移;新增的唯一跨模块导出是 `onAuthSessionSwitch`(设计 MD §6.7-3 登记) |
| CI 文件 / s6a pin / plugin-tests.yml | **字节不变** | `git diff --name-only 288530a0cd HEAD -- .github packages scripts` = 0 个文件 |
| required exec 行 | **恰 1 条**,五个相关 spec 的 token 全在该行上 | `grep -c '^exec npx vitest'` = 1 |
| 新增文件 | **零**(17 条用例全部落在既有 spec) | `git diff --name-only --diff-filter=A` 仅两个既有 MD 之外无新文件 |

### 10.7 本轮未做 / 交 owner(不藏)

1. 真浏览器的 ③ 与「平铺行换批」两项 —— §10.4 已逐条登记为 NOT RUN 并给理由。
2. host settle 身份比对、`loadCategories`/`loadRecentTemplates` 代数守卫 —— 纵深防御,无判别输入,**不声称承重**。
3. `multitable-recovery-archive-modal.spec.ts` 的既有失败 —— 已取证为 main 上同形,不在本轮范围。
4. 平铺模板列表非 org 作用域(后端既有性质)—— 登记为观察,未改。
5. 合并 / undraft / 开 PR / 新分支合并 / DDL 应用 —— **全部未做,仍需 owner 逐条授权**。

