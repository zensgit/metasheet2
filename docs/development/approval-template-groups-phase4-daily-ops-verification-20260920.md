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
# 该行共跑 3 次(NUL 修复前 1 次、修复后 2 次),三次的 473 / 7339 逐字相同。
# 修复后的第一次 EXIT=134:全部 473 文件 / 7339 条报告 passed **之后**,node worker 在
# `cjsPreparseModuleExports` 抛 Abort trap: 6 —— 是 ESM loader 的进程级崩溃(本机内存压力),
# 零测试失败;紧接着的重跑 EXIT=0、零 abort。如实登记为环境 flake,不算作红,也不据此声称绿。

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


---

## 11. 第 4 轮验证(对齐 `impl-gate-A5-daily-ops-round3-20260921.md`:1 P1 / 1 P2 / 3 P3,以及 `verify-a5-r3-three-p2-after-push-20260921.md` 的 (2) 与两条 LATENT)

> **仍是 PROPOSED 候选件。** 未合并、未 undraft、未开 PR、未 ratify。下面每个数字都逐字抄自本机输出。
> 本轮起点 head = 门审 head `c3ea127b12a95cc04db7628a0689af4f25d8c1b1`(`git rev-parse origin/feat/approval-template-groups-phase4-daily-ops` 逐字核对)。

| 项 | 值 |
|---|---|
| 工作树 | `…/scratchpad/a5r4-fix`(`git worktree add --detach`;5 处 `node_modules` 软链自 canonical) |
| 一次性库 | `metasheet2_a5r4_20260921`(`createdb -U postgres -O ms2testbed`;`current_database()` / `current_user=ms2testbed` / `rolsuper=f` 已 psql 核验) |
| 连接串变量 | `.github/workflows/*.yml` 共 212 命中 / 3 个变量(`DATABASE_URL` 224、`ATTENDANCE_TEST_DATABASE_URL` 3、`SMOKE_DATABASE_URL` 1);三者**全部** export 指向该库;三个 `package.json` 零命中 |
| 迁移 | `EXIT=0`,**413** 条 `was executed successfully`;`permission denied\|42501\|must be owner\|must be superuser` **零命中** |
| 真后端 / Vite / 浏览器 | `:3411`(`NODE_ENV=development`)/ 修复头 `:5283`、r3 头 `:5284` / **自起 headless chromium(playwright 1.57),未用会话共享的 MCP 浏览器** |
| 未触碰 | peer 工作树 `a5r3-impl` / `a5r3b-impl` / `a5r4-impl` 一个都没动 |

### 11.1 改了什么(3 个源文件 + 5 个 spec + 2 个 MD;零新增文件)

| 文件 | 改动 |
|---|---|
| `apps/web/src/approvals/templateStore.ts` | `loadTemplates` 加请求代数 + 身份签名,三出口各自守卫,返回 `ApprovalTemplateListOutcome`(`applied` / `failed` / `superseded`) |
| `apps/web/src/composables/authPrincipal.ts` | `readAuthSessionSignature` 由模块私有改为**导出**(store 与监听器必须读同一个函数) |
| `apps/web/src/views/approval/TemplateCenterView.vue` | `loadData().settle` 改为只认 `outcome === 'applied'`;删除页面层 `flatListGeneration`(机制已下沉,该守卫无可达输入);错误横幅 `:closable="!flatListStale"` |
| `tests/approvalTemplateCenterCategory.spec.ts` | +18 条用例(6 条组件级 / 9 条 store 级 / 3 条 `onAuthSessionSwitch`);store mock 的 `loadTemplates` 默认解析值改为 `'applied'`;api mock 补 `listTemplates`/`getTemplate`/`getTemplateVersion`(真 store 经 `vi.importActual` 载入时要用);`ElAlert` stub 透出 `data-closable` |
| `tests/approval-e2e-lifecycle.spec.ts` / `approval-e2e-permissions.spec.ts` / `approvalTemplateGovernance.spec.ts` / `templateCenterI18n.spec.ts` | 同一处 mock 默认解析值 `undefined → 'applied'` |

### 11.2 新增用例(18 条,全部落在**既有**文件;零新文件 ⇒ 零 CI 接线改动)

**组件级(6 条)** —— `(③ FLAT) an error left in the SHARED store slot …` / `(③ FLAT, failure exit) …` / `(③ FLAT, superseded exit) …` / `(② M-F) … exactly ONCE` / `(① M-J) …` / `(① M-K) …`

**store 级(9 条,对真 `templateStore`,经 `vi.importActual` 绕开本文件的 store mock)** —— 2 条正控 + `(③ success exit)` / `(③ catch exit)` / `(③ finally exit)` + 3 条 `(① identity)` + 1 条「同主体换发令牌仍被作废」

> 为什么必须对**真** store:5 个组件 spec 把 `templateStore` 整体换成 `vi.fn().mockResolvedValue(...)`,其 `error`/`loading` 是两个手驱 ref——store 的 catch 与 finally 出口在这些机具里**不是没测到,是测不到**。这 9 条是它们第一次被执行。

**`onAuthSessionSwitch`(3 条)** —— 正控 + 「通知与延后读之间被拆卸 ⇒ 不得触发」+ 「被同一次通知里的另一个监听器拆卸 ⇒ 不得触发」。门审 M-D 的机械理由是 `grep -rln 'onAuthSessionSwitch' apps/web/tests/` **零文件**;本轮起不再为零。

### 11.3 Mutation 台账 —— 本轮 8 条新探针 + r1/r2/r2b/r3 **全部按原编号重跑**

规程:`cp` 备份到 `…/scratchpad/a5r4-backups/mutbak/` → 改坏 → 跑 → `cp` 还原 → `cmp` 校验。**零 `git checkout --` / 零 `reset --hard` / 零 `stash`。** 基线 = 6 个文件 **118 passed**。

> **机具事故与其处置(如实记,不藏)**:第一版还原脚本按**basename** 在 `apps/web/src` 下找同名文件回写,而 `src` 下有**三个** `api.ts`(`utils/` `approvals/` `data-sources/`),于是把 `approvals/api.ts` 的内容盖到了另外两个上,随后一轮读数(22 failed)是污染读数、已作废。还原用的是整树 `cp` 备份 + `cmp` 校验(**没有**用 `git checkout --`),脚本改为显式相对路径白名单后基线复现 118 passed,全部探针重跑。第二起:macOS 文件系统大小写不敏感,`m_Mi.py` 与 `m_MI.py` 是同一个文件,r2 的 `M-a/M-c/M-e/M-f/M-g/M-h/M-i` 一批实际跑的是 r3 的 `M-A/M-C/M-E/M-F/M-G/M-H/M-I`;发现后按大小写无歧义的文件名全部重跑,下表是重跑后的读数。

#### (a) 本轮 8 条新探针(P1 修法自身的承重证明)

| 探针 | 改坏了什么 | 结果 | 红在哪 |
|---|---|---|---|
| **M-B′** | `loadData().settle` 的 `outcome === 'applied'` 条件删掉(任何结局都放下 stale) | **2 failed** | `(③ FLAT, failure exit)` / `(③ FLAT, superseded exit)` |
| **M-B-old** | settle 换回第 3 轮的 `if (!store.error)` | **2 failed** | `(③ FLAT)` 共享槽位那条 / `(③ FLAT, superseded exit)` |
| **M-B-S** | store 成功出口的 `if (!isCurrent()) return 'superseded'` 删掉 | **4 failed** | `(③ success exit)` / `(③ finally exit)` / 两条 `(① identity)` |
| **M-B-C** | store 失败出口的同一行删掉 | **2 failed** | `(③ catch exit)` / 一条 `(① identity)` |
| **M-B-F** | store `finally` 的 `if (isLatest())` 改成无条件 | **1 failed** | `(③ finally exit)` |
| **M-B-SIG** | `isCurrent()` 退化成 `isLatest()`(丢掉身份签名) | **3 failed** | 三条 `(① identity)` |
| **M-B-FSIG** | `finally` 的守卫改成 `isCurrent()`(把身份也算进去) | **1 failed** | `(① identity) …but that read still RELEASES loading` —— 即 §7.1 表里那条「转圈停不下来」 |
| **M-CLOSABLE** | `:closable="!flatListStale"` 改回 `true` | **1 failed** | `(③ FLAT, failure exit)` 的 `data-closable` 断言 |

#### (b) r1 / r2 / r2b / r3 全部前轮探针重跑 —— **零回退,且 5 个幸存者归零**

| 轮次 | 探针 | 本轮结果 |
|---|---|---|
| r1 | M1 / M2 / M3 / M4 / M4b / M5 / M6 / M6b / M7 / M7b / M7c / M7d | 2 / 1 / 1 / 2 / 4 / 1 / 1 / 1 / 5 / 18 / 7 / 21 failed —— **12 条全承重** |
| r1 | M8 / M8b / M9 | **NOT RUN**(后端真库探针;本分支后端零改动,见 §11.7-3) |
| r2 | M-a / M-a2 / M-c / M-d / M-e / M-f / M-g / M-h / M-i | 5 / 2 / 3 / 1 / 1 / 1 / 1 / 1 / 2 failed —— **9 条全承重** |
| r2 | M-b / M-b2 | **118 passed(存活)** —— 与 r2 门审自己的判定一致(「可辩护地 inert」),非本轮回退 |
| r2b | M-n / M-o / M-p / M-q / M-r / M-s | 3 / 2 / 1 / 1 / 1 / 2 failed —— **6 条全承重** |
| r3 | M-A / M-C / M-E / M-F / M-G / M-I / M-J / M-K / M-D | 4 / 1 / 1 / 1 / 2 / 13 / 1 / 1 / 2 failed —— **9 条全承重(M-D / M-F / M-J / M-K 由幸存转承重)** |
| r3 | M-B | 机制已下沉到 store,该行不复存在;承重点变四个(M-B′ / M-B-S / M-B-C / M-B-F,上表) |
| r3 | **M-H** | **118 passed(仍存活)** —— 唯一幸存者,已披露不可达(设计 MD §7.4),**正控 M-G 同函数失败分支 ⇒ 2 failed**,证明 `settle` 本身被用例驱动 |

⇒ 门审点名的 **11 探针幸存者(M-B / M-D / M-F / M-J / M-K,加已披露的 M-H)**:前五条全部归零;M-H 按门审结论保留为 P3,并第一次配上正控。

### 11.4 真后端 + 自起 headless chromium —— ③ 的红/绿对照(**真 500**,非 `route.abort`、非伪造响应)

故障注入是**服务端**的:`ALTER TABLE approval_templates RENAME TO approval_templates_parked`,让被作废的那次读在数据库层真的 500,随后重命名回来。浏览器侧**唯一**的拦截是对平铺列表读的**计时闸**(`route.continue()` 透传,从不伪造 status/body/失败;`section=` 的读一律直通),且每一组都配了**同脚本同拦截、只去掉故障**的对照组——门审 §C-3 证明过「拦截本身会污染观测」,这两组对照就是为这一条准备的。

```
########## r3 头 c3ea127b12(未修)—— 真 500
[mount] rows=2 alert=""            [grouped] switcher=1
[HELD flat-read #1] status=published&page=1&pageSize=10     ← org-alpha,压住
[HELD flat-read #2] status=published&page=1&pageSize=10     ← org-beta,压住
  server-side approval-template list now FAILS (table renamed away)
  server-side approval-template list healed
[FLAT VIEW — r3head-real500] rows=0 alert="API error: 500 Internal Server Error Reload" pager=0
  VERDICT: *** BLANK FLAT LIST *** | stale error banner shown: true

########## r3 头 c3ea127b12 —— 对照组(同脚本同拦截,无故障)
[FLAT VIEW — r3head-control]  rows=2 alert="" pager=0   VERDICT: rows rendered | banner: false

########## 本轮修复头 —— 同一脚本、同一真 500
[FLAT VIEW — fixed-real500]   rows=2 alert="" pager=0   VERDICT: rows rendered | banner: false

########## 本轮修复头 —— 对照组
[FLAT VIEW — fixed-control]   rows=2 alert="" pager=0   VERDICT: rows rendered | banner: false
```

⇒ 空白**不是**拦截造成的(两组对照都正常),是被作废的那次读**失败**造成的(仅在未修头上出现),且在本轮修复头上消失。

**边界 ①②④ 同批重放(修复头,真后端,零浏览器拦截)**

```
① 合格身份:rows=2                     ① 分组视图:switcher=1
② 切 org 前:ALPHA-ONLY-GROUP=true  BETA-ONLY-GROUP=false
② 切到 org-beta:ALPHA-ONLY-GROUP=false BETA-ONLY-GROUP=true  switcher=1
② 切后平铺面:rows=2  alert=""
① 登出后:switcher=0 retry=0                    (入口消失、无错误残留 = 正确渲染)
① 单 org 成员(验收 J 正控):switcher=0
④ 服务端 session-orgs 真失败:{"success":false,…,"code":"SESSION_ORGS_UNAVAILABLE"}
④-a 真失败时:retry=1 switcher=1     ④-b 治愈 + 点重试后:switcher=1 retry=0
   user_orgs restored: 3 rows
```

### 11.5 P3-2 的机械复核(本轮新库,逐字输出)

```
templates under org-ALPHA token:  total=2 ['A5R4 Template Two', 'A5R4 Template One']
templates under org-BETA  token:  total=2 ['A5R4 Template Two', 'A5R4 Template One']   ← 逐字相同
groups under org-ALPHA: [{"id":"atg_a5r4_alpha","orgId":"org-alpha","name":"ALPHA-ONLY-GROUP",…}]
groups under org-BETA : [{"id":"atg_a5r4_beta","orgId":"org-beta","name":"BETA-ONLY-GROUP",…}]
information_schema: approval_templates.org_id 命中 0   |   approval_template_groups.org_id 命中 1
```

⇒ 平铺面在本后端**没有可保护的对象**。**是否执行 fix option 0(删机制)交 owner**,理由与边界见设计 MD §7.3。**本轮不删机制。**

### 11.6 静态门 / 全量实跑 / census(数字逐字抄自输出)

| 门 | 结果 |
|---|---|
| `vue-tsc -b --force` | **恰 1 条** `error TS`:`vite.config.ts(28,29): error TS2769`;`git diff 288530a0cd HEAD -- apps/web/vite.config.ts` **为空**(与 main 同形的既有环境项,非本 lane 引入) |
| `vite build` | `built in 12.81s`,`BUILD_EXIT=0` |
| `packages/core-backend` `tsc --noEmit` | `TSC_EXIT=0` |
| 5 个被触碰 spec + `SessionOrgSwitcher` | **118 passed (118)**(门审起点为 100) |
| + 9 个邻居 spec(`templateCenterI18n` / `approvalTemplateGovernance` / `approval-e2e-permissions` / `approval-e2e-lifecycle` / `approvalNavDelegationEntry` / `templateGalleryFilter` / `categoryCandidateInput` / `approvalRecentTemplates` / `useAuth`) | **15 files / 337 passed (337)** |
| required `exec` 巨行(**恰 1 条**,405 token,直跑) | **473 files / 7357 passed (7357)**,`EXEC_EXIT=0`(门审起点自述 7339;+18 = 本轮新增用例数,逐字对上) |
| `run-required-web-tests.sh` 全脚本 | `EXIT=1`,唯一失败仍是 `multitable-recovery-archive-modal.spec.ts > … durable request identity cannot be saved`;**在未修改的 r3 头整树备份上单跑同样 `1 failed | 53 passed (54)`** ⇒ 既有,非本轮回退 |
| s6a pin / `plugin-tests.yml` / `packages` / `scripts` / 迁移 / 端点 / flag / DDL | **字节不变**;`apps/web/scripts/run-required-web-tests.sh` 与 base 零差异;零新增文件 |
| **`approval-web-guard.yml` 的 `paths:` —— 本轮改了 1 个条目 × 2 处,见下** | 见 §11.6-a |
| 提交历史 `Bin` 扫描 | 新历史 `288530a0cd..HEAD` 每个提交 **0** 命中;旧历史同一扫描 `dec28f0595` / `7204c94cce` 各 **1** |

**P3-3 的压平证明(逐字可复核)**

| 项 | 值 |
|---|---|
| 压平点(本轮改动之前的最后一个提交) | `d487b74f55898dd9a75367a518bdf8ec0665585b` |
| `git rev-parse c3ea127b12…^{tree}` | `d1da65e3e25f0c9dbcf6f98f1e9faa076d4d0be3` |
| `git rev-parse d487b74f55…^{tree}` | `d1da65e3e25f0c9dbcf6f98f1e9faa076d4d0be3`(**相同**) |
| `git diff c3ea127b12… d487b74f55…` | **0 行** |
| `#5878 e90d16c90f58a58789a6acd589df362aaa2c2f42` | `git merge-base --is-ancestor` → **真**(对本轮 HEAD) |

重建后的五个提交:`d545824bf4`(feat,含折回的 NUL 移除 + `disposed` 修复,`authPrincipal.ts | 73 ++++` 文本 diff)、`8970214b2b`(test)、`971b36c8ae`(docs)、`d6c02f71b1`(docs,原 `7204c94cce` 的 MD 部分)、`d487b74f55`(docs)。作者/日期沿用原提交。

### 11.6-a 本轮唯一的 CI 改动:把 `templateStore.ts` 加进 `approval-web-guard.yml` 的 `paths:`

**为什么不能沿用 r3 门审的接线结论**:r3 门审核过「`paths` 逐条覆盖本次 10 个代码/测试文件」,但
`apps/web/src/approvals/templateStore.ts` **不在 r3 的改动集里**(`verify-a5-r3-three-p2-after-push-20260921.md`
§2.1 逐字写明它「不在其中」),所以那条结论**不可能覆盖它**。本轮机械复核(`git show <head>:…yml` 解析 YAML):

```
patch 前:pull_request.paths 268 条 / push.paths 256 条,'apps/web/src/approvals/templateStore.ts' → False（两处）
patch 后:pull_request.paths 269 条 / push.paths 257 条,同一键 → True（两处）
         authPrincipal.ts / TemplateCenterView.vue / approvalTemplateCenterCategory.spec.ts → True（两处,本来就在）
```

**这不是本候选件今天的门洞**:`paths` 是析取,本 PR 还动了 `authPrincipal.ts`、`TemplateCenterView.vue`
和四个已列出的 spec,所以 guard 今天照样触发。它决定的是**明天**:store 的三出口现在是这条修法唯一的承重
证明,而那 9 条用例只在 `approvalTemplateCenterCategory.spec.ts` 里;若只动 `templateStore.ts` 的一次改动
不触发这条 workflow,它们一条都不会跑。「闸已存在但不覆盖你这条路」正是这种形状。

**为什么改的是 `approval-web-guard.yml` 而不是别的**:它就是这批 spec 的门;`plugin-tests.yml`
逐字未动(s6a pin 不受影响)。机械核对:全仓**没有任何测试**读取或哈希 `approval-web-guard.yml`
(`grep -rln 'approval-web-guard' packages/core-backend/tests` 零命中;`apps/web/tests` 的 8 处命中全是注释),
所以这次增行不会触发任何 census 断言。该 workflow 的 `vitest run` 过滤串本来就含
`approvalTemplateCenterCategory` token,无需改。

⇒ 本轮 CI 改动 = **1 个 path 条目,写进两个 `paths:` 列表,共 12 行(含说明注释)**,已在此逐字披露;
不再声称「零 CI 改动」。

### 11.7 本轮未做 / 交 owner(不藏)

1. **`verify-a5-r3-three-p2-after-push-20260921.md` §1.4-R(跨标签页未被通知的令牌替换)**:两个子组件的 `isCurrent()` 仍然只比代数、不核 token。本轮**未改**——该验证件自己写明这是合同级取舍(补 token 核对 vs 放宽 `useAuth` 的 `explicitTransition` 闸)。平铺面这一侧本轮起有身份签名兜底,子组件侧**没有**。**交 owner。**
2. **同件 §3.4(LATENT)**:`useSessionOrg` 订阅**裸** `onAuthPrincipalChange`、宿主订阅 `onAuthSessionSwitch`,两者对「非切换的漏斗运行」判断不一致。本轮**未改**,判据不一致仍在。**交 owner。**
3. **r1 的 M8 / M8b / M9**(后端真库探针)本轮 **NOT RUN**:它们针对后端 `isWellFormedUuid` / unlink 调用点 / P2-2 后端消息串,本分支后端零改动;跑它们需要另跑后端真库套件,本轮未跑。**登记,不用前几轮结果填充。**
4. **r1 21 条验收判据里的 15 条**(C0–C5 / D2 / D3 / D4 / D4b / D5 / D5b / D7)本轮 **NOT RUN**;本轮真浏览器只跑 ①②③④ 与 P3-2 复核。
5. 多标签页直接写 `localStorage` 那一支的**浏览器**重放、生产 PG15 轴 / musl-collation 轴、`run-required-web-tests.sh` 其余段落 —— **NOT RUN**。
6. **M-H 仍存活**(设计 MD §7.4);按门审结论保留为 P3,配正控,不补测。
7. **`approval-web-guard.yml` 之外的门未逐条复核**:本轮只核了这一条 workflow 的 `paths` 是否覆盖
   `templateStore.ts`,没有把仓里其余 workflow 的 path filter 对本轮改动集再做一次全量普查。**登记。**
8. 合并 / undraft / 开 PR / 新分支合并 / DDL 应用 —— **全部未做,仍需 owner 逐条授权**。本件不含任何「已裁 / 已 ratify」的记述。

---

## 12. 第 5 轮验证(对齐 `impl-gate-A5-daily-ops-round4-20260921.md`:0 P1 / 1 P2 / 4 P3)

> **PROPOSED —— 未过门审,未 ratify,未合并,未 undraft,未开 PR。** 本节的每个数字都逐字抄自本轮输出。
> 起点 head = `4e94e8fe0219be61a908f42d5af13dee7e189e1a`(`git rev-parse origin/feat/approval-template-groups-phase4-daily-ops`,与门审报告抬头逐字一致);`#5878`(`e90d16c90f58a58789a6acd589df362aaa2c2f42`)`git merge-base --is-ancestor` **PASS**。

### 12.1 改了什么(2 个源文件 + 1 个 spec + 2 个 MD;零新增文件)

代码侧的 diffstat 特意**限定在 `apps/` 下**,因为本节自己就在被改的两个 MD 里——把一个包含本文件的计数写进本文件,是一个自指快照,下一次改动这两个 MD 就会让它对不上(「记录修复轮只删不加、不手写数字」)。两个 MD 的路径在下方用文字点名。

```
git diff --stat 4e94e8fe0219be61a908f42d5af13dee7e189e1a -- apps/
 apps/web/src/approvals/templateStore.ts            |  65 +++-
 apps/web/src/views/approval/TemplateCenterView.vue | 131 +++++++--
 .../tests/approvalTemplateCenterCategory.spec.ts   | 327 ++++++++++++++++++++-
 3 files changed, 490 insertions(+), 33 deletions(-)
```

另两个被改文件是本轮的记录件本身:
`docs/development/approval-template-groups-phase4-daily-ops-design-20260920.md`(新增 §8)与
`docs/development/approval-template-groups-phase4-daily-ops-verification-20260920.md`(新增 §12)。**零新增文件。**

`git diff --name-only <r4 head> -- .github/ '**/package.json' '**/s6a-package-provenance-pins.json' apps/web/scripts/` = **空**。⇒ 零 CI 改动、零 s6a pin 变动、零迁移、零 DDL、零新端点、零新 flag。三个被改文件都**已经**在 `approval-web-guard.yml` 的两个 `paths:` 触发器里(命中数 2 / 3 / 2),不需要新的接线。

### 12.2 新增用例(7 条,全部落在既有文件)

| # | 用例(原文) | 钉的是 |
|---|---|---|
| 1 | `(① C-1) an EXTERNAL identity change landing inside this page's own switch window is NOT credited to this page: one re-read, the organization list is re-asked, the entry stays, the flat table comes back` | 设计 MD §8.1 判据 (b) |
| 2 | `(① C-1, second transition) a LATER external change that happens to land on this page's target organization is still external — the claim was already invalidated by the first one` | §8.1 判据 (a) |
| 3 | `(① C-1, indistinguishable case) a foreign switch to this page's OWN target organization is credited to the page at the listener — and the superseded switch is what recovers from it` | §8.1 兜底条款 |
| 4 | `(C-7 positive control) a lone DETAIL read owns the shared loading slot and releases it` | 正控:区分「修好了」与「本来就没坏」 |
| 5 | `(C-7, loadTemplates writer) a LIST read settling while a detail read is in flight does not take down the detail read's spinner` | §8.2 共享票(写入方 1) |
| 6 | `(C-7, loadTemplate writer) a detail read settling while a VERSION read is in flight leaves the shared loading slot alone, and a detail answer for the PREVIOUS session applies nothing` | §8.2 共享票 + 身份签名(写入方 2) |
| 7 | `(C-7, loadVersion writer) a version read settling while a detail read is in flight leaves the shared loading slot alone, and a version answer for the PREVIOUS session applies nothing` | §8.2 共享票 + 身份签名(写入方 3) |

另有**一条既有用例被加强**(门审 C-1 修法第 4 项):`(③ FLAT, superseded exit)` 原先只断言 `rows === 0`,现在追加断言「出路仍在」——重进分组视图 `switchers === 1`,且下一条**当前**答案能把行重新放出来。**这条加强的标定要说准**:它**不是**由 C-1 自身的探针变红(C-1 的死态发生在另一条路径上),它的**正控**是 `M7d'`(把页面切换器的 `v-if` 关成 `false`)—— 该探针下这条用例**变红**,证明新断言确实被求值、不是空转。

**先红后绿(把两个源文件逐字还原成 head 的内容,只留新用例)**:

```
Tests  6 failed | 49 passed (55)
× (① C-1) an EXTERNAL identity change landing inside this page's own switch window …
× (① C-1, second transition) a LATER external change that happens to land …
× (① C-1, indistinguishable case) a foreign switch to this page's OWN target …
× (C-7, loadTemplates writer) a LIST read settling while a detail read is in flight …
× (C-7, loadTemplate writer) a detail read settling while a VERSION read is in flight …
× (C-7, loadVersion writer) a version read settling while a detail read is in flight …
```

还原为修复版后 `cmp` 两文件一致(`RESTORE-CMP-OK`),同一命令:`Tests  55 passed (55)`。

> 第 4 条(正控)在红的那一轮就是绿的——**这正是正控该有的行为**,它的作用是证明「另外三条 C-7 用例的红不是因为机具本身跑不通」。

### 12.3 Mutation 台账 —— 本轮 10 条新探针 + r1/r2/r2b/r3/r4 **按原编号重跑**

规程:`cp` 备份到 `…/scratchpad/a5r5-mutbak/`(**显式相对路径白名单,绝不按 basename 匹配**——r4 的机具事故就出在这)→ 改坏 → 运行器自检「锚点存在且文件真的变了」→ 跑 → `cp` 还原 → `filecmp` 校验。**零 `git checkout --` / 零 `reset --hard` / 零 `stash`。** 探针全部跑完时 `git status --porcelain` 只剩本轮有意改的 3 个 `apps/` 文件(两个 MD 是随后才写的),7 个被探针碰过但未被本轮改动的文件(`authPrincipal.ts` / panel / sections / switcher / `api.ts` 等)逐个 `cmp` 与备份一致。

基线:`approvalTemplateCenterCategory` 单文件 **55 passed**;5 个 spec 集合(category / sections / panel / switcher / groupsClient)**124 passed**;9 个 spec(+ e2e-lifecycle / e2e-permissions / governance / i18n)**259 passed**;邻居 8 个(useSessionOrg / AttendanceSessionOrgSwitcher / approvalNewView / templateDetailI18n / approvalDetailPolish / approvalTemplateVersionHistory / approval-detail-instance-consistency / approval-detail-can-decide-current-node)**135 passed**。

#### (a) 本轮 10 条新探针

| 探针 | 改坏了什么 | 结果 | 红在哪 |
|---|---|---|---|
| **M-L** | `claimOwnSwitchTransition` 退化成裸 `pageOwnedSwitch !== null`(= r4 的形状) | **2 failed** | `(① C-1)` / `(① C-1, second transition)` |
| **M-L-a** | 只删判据 (a)(签名半边) | **1 failed** | `(① C-1, second transition)` |
| **M-L-b** | 只删判据 (b)(目标组织半边) | **2 failed** | `(① C-1)` / `(① C-1, second transition)` |
| **M-N** | 关掉 `!ok` 兜底 | **1 failed** | `(① C-1, indistinguishable case)` |
| **M-O** | `loadTemplates` 的 `finally` 换回 r4 的 `isLatest()` | **1 failed** | `(C-7, loadTemplates writer)` |
| **M-P** | 删 `loadTemplate` 的 `if (!isCurrent()) return`(内容 + 身份) | **1 failed** | `(C-7, loadTemplate writer)` |
| **M-Q** | 删 `loadVersion` 的同一守卫 | **1 failed** | `(C-7, loadVersion writer)` |
| **M-R** | `loadTemplate` 的 `ownsLoadingSlot()` → 恒 `true` | **1 failed** | `(C-7, loadTemplate writer)` |
| **M-S** | `loadVersion` 的 `ownsLoadingSlot()` → 恒 `true` | **1 failed** | `(C-7, loadVersion writer)` |
| **M-T** | claim 的 own-switch 重钥 → **一律保留** claim | **8 failed** | 5 条 ① + `(① C-1)` ×2 + ④ |

**(a) 与 (b) 各自都有单独的判别输入**(M-L-a / M-L-b 各自单删只红对应用例),所以本轮没有留下一个「合取式里无人验证的那一项」。

#### (b) 前轮探针按原编号重跑 —— **零回退**

| 轮次 | 探针 | 本轮结果 |
|---|---|---|
| r4 | M-B′ / M-B-old / MUT-S1(=M-B-S)/ MUT-S2(=M-B-C)/ MUT-S3(=M-B-F)/ M-B-SIG / M-B-FSIG / M-CLOSABLE | 2 / 2 / 4 / 2 / 2 / 3 / 1 / 1 failed —— **8 条全承重** |
| r3 | M-A / M-C / M-D / M-E / M-F / M-G / M-I / M-J / M-K | 4 / 1 / 2 / 1 / **2** / 2 / 15 / 1 / 1 failed —— **9 条全承重** |
| r3 | **M-H** | **124 passed(仍存活)** —— 与 r3 / r4 结论一致,已披露不可达;**正控 M-G 同集合 2 failed** |
| r2b | M-n / M-o / M-p / M-q / M-r / M-s / M-t / M-t2(=M-C)/ M-u / M-v(=M-G)/ M-w(=M-A)/ M-x / M-y / M-z(=M-I)/ M-aa / M-ab / M-ac / M-ad / M-ae / M-nitc | 3 / 2 / 1 / 1 / 1 / 1 / 1 / 1 / 16 / 2 / 4 / 10 / 1 / 15 / 1 / 1 / 1 / 1 / 1 / 1 failed —— **全承重** |
| r2 | M-a / M-a2 / M-c / M-d / M-e / M-f / M-g / M-h / M-i | 5 / 2 / 3 / 1 / 2 / 1 / 1 / 1 / 2 failed —— **9 条全承重** |
| r1 | M1 / M2 / M3 / M4 / M4b / M5 / M6 / M6b / M7′ / M7b′ / M7c′ / M7d′ | 2 / 1 / 1 / 2 / 4 / 1 / 1 / 1 / 5 / 21 / 7 / 24 failed —— **12 条全承重(M2 仍红)** |
| r1 | **M8 / M8b / M9** | **NOT RUN**(后端真库探针;本轮 delta 零后端文件,见 §12.7-2) |
| r2 | **M-b / M-b2** | **NOT RUN —— 且理由要说准**:前几轮台账只写了「可辩护地 inert」,**没有记下它们改的是哪一行**;本代理不按描述另造一个更窄的同类物冒充原探针。登记为「原始改法不可从台账复原」。 |

> **前轮探针是按台账的**散文描述**重建的,不是原始补丁**——前几轮只把 `.orig` 备份留在 `reviews/a5r*-mutbak/`,**没有留下 mutation 脚本**。因此:
> - 每条重建探针都经运行器自检「锚点存在 + 文件确实变了 + 不是语法崩溃(`NO-SUMMARY`)」;
> - 重建探针**红在哪条用例**已逐条记录(上文各行),读者可据此核对它与原编号描述是否同一个机制;
> - `M-b` / `M-b2` 的描述在台账里只有「可辩护地 inert」一句,**无法定位改的是哪一行**,因此登记 NOT RUN 而**不**另造一个同类物冒充(见「另造更窄同类物=合同变更」这条房规)。

> **两处必须写明的锚点迁移**(否则下一轮会对着一个已不存在的行重跑):
> 1. **MUT-S3 / M-B-F 的锚点变了**:原文是 `templateStore.ts` 的 `finally { if (isLatest()) loading.value = false }`;本轮起该行是 `finally { if (ownsLoadingSlot()) loading.value = false }`。探针语义不变(把 `finally` 改成无条件),**红在两条用例**(原来的 `(③ finally exit)` + 本轮新增的 `(C-7, loadTemplates writer)`)。
> 2. **M-F 的锚点未变**(`if (ownSwitch) return`),但**红从 1 条变成 2 条**:原来的 `(② M-F)` 之外,本轮新增的 `(① C-1, indistinguishable case)` 也红。这是覆盖变宽,不是回退。
> 其余被重跑探针的锚点(M-C / M-G / M-D / M-I / M-A / M-E / M-J / M-K / M-CLOSABLE)本轮逐条机械核对,**均未被本轮改动触碰**。

### 12.4 静态门

| 门 | 结果 |
|---|---|
| `vue-tsc --noEmit -p tsconfig.app.json` | **EXIT=0,零行输出** |
| `vue-tsc -b --force` | **EXIT=2,1 个 `error TS2769`,唯一来源 `vite.config.ts`** —— **与 `origin/main`(`5edf4c3e17d3608fa4513b5ffd801142da026dcf`)同形**:在独立 main 工作树上跑同一命令得到**同一个** `TS2769` / 同一个文件;该 main 工作树的 `vue-tsc --noEmit -p tsconfig.app.json` 同样 EXIT=0。⇒ 本机共享 `node_modules` 里 vite 5.4.21 与 7.3.6 并存造成的**环境项**,不是本候选引入,按任务书「仅允许与 main 同形环境项」登记 |
| `vite build` | **EXIT=0**,`✓ built in 12.23s`(仅既有 chunk-size 警告) |
| `packages/core-backend` `tsc --noEmit` | **EXIT=0,零行输出** |

### 12.5 required 门真正承重的那条活 `exec` 行 —— 直跑

```
grep -c '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh   → 1     (恰一条)
该行位置 :1211 ;位置参数 401 个
9/9 被改 / 相关 spec 的 token 都在该行上(category / sections / panel / switcher /
   groupsClient / i18n / governance / e2e-lifecycle / e2e-permissions)

本轮 head:   Test Files  473 passed (473)      Tests  7364 passed (7364)     EXIT=0
r4 head 基线:Test Files  473 passed (473)      Tests  7357 passed (7357)     EXIT=0
                                                    ^ 同一台机器、同一条命令、同一次会话
Δ = +7 = 本轮新增用例数(§12.2),零既有用例丢失、零既有用例转红。
```

收集行(本轮 head):`Duration 54.26s (transform 25.60s, setup 3.17s, collect 134.39s, tests 190.58s, environment 88.64s, prepare 17.47s)`。

> **不重走 `bash run-required-web-tests.sh` 整脚本**:门审 §C-9 已把原因查清——脚本 `:606` 的预检 spec 在**本机 Node 25**(CI 是 20.x)下红,`:473` 的 `set -euo pipefail` 让脚本就地中止,`:1211` 的 `exec` 根本到不了。该 spec 在 `origin/main` 同 SHA 上 CI 为绿,本分支对它零改动。本轮按任务书直跑活 `exec` 行,上表即是执行层证据 —— 这**补上了**门审 §C-9 结尾指出的缺口(「本候选的 spec 在 required lane 上确实被跑到」此前只有接线层证据)。

### 12.6 全量实跑(数字逐字抄自输出)

```
# 被触碰 spec + 本分支 spec(9 个)
Test Files  9 passed (9)        Tests  259 passed (259)

# 邻居 8 个(useSessionOrg / AttendanceSessionOrgSwitcher / approvalNewView /
#            templateDetailI18n / approvalDetailPolish / approvalTemplateVersionHistory /
#            approval-detail-instance-consistency / approval-detail-can-decide-current-node)
Test Files  8 passed (8)        Tests  135 passed (135)
```

> 邻居集合**本轮特意扩了 6 个**:`loadTemplate` / `loadVersion` 第一次带上身份签名,而这两个方法的真实消费者就在这些 spec 里。它们全绿是「内容槽位按种类各自计数」这条设计(设计 MD §8.2 第 2 点)没有误伤并发详情/版本读的证据。

### 12.7 本轮未做 / 交 owner(不藏)

1. **C-1 的真浏览器 / 双标签页重放:NOT RUN。** 本轮的证据全部来自 vitest 组件机具(真 `TemplateCenterView` + 真 `useAuth` 漏斗 + 真 `authPrincipal` + 真 `useSessionOrg`)。三条新用例里的外部转换是**直接调用生产 setter**(`useAuth().setToken` / `useAuth().setExplicitSessionOrg`)产生的,**没有**经过 `window` 的 `storage` 事件那一跳。「另一标签页的切换会保留 marker」这一条是**读源码**得出的(`useAuth.ts:74-79` 与 `:301` 都传 `preserveExplicitSession = true`,`:124` 是那个参数的唯一消费点),**未在浏览器里执行验证**。标 UNVERIFIED-IN-BROWSER。
   > **勘误(第 6 轮,门审 C-2)**:这一句本身是对的(两处**都**传 `true`),但它与**同一提交**的设计 MD §8.1「`setExplicitSessionOrg` 是**唯一**传 `true` 的转换」**直接矛盾**;机械普查为**四处**传 `true`。设计 MD §8.1 已就地勘误,判据 (b) 的承重机制改述为读侧的「marker 与 token 文本严格绑定」(设计 MD §9.2)。本句其余部分不变。
   > **另:第 6 轮补上了这条 NOT RUN 的一半** —— `storage` 事件那一跳现在有用例了(`(① C-1, partial transition)`,验证 MD §13.2),走的是**真的 `window` `storage` 事件** + 真的 `useAuth` 监听器;仍未在**真浏览器**里重放,UNVERIFIED-IN-BROWSER 的标记保留。
2. **后端真库步骤:零。** 本轮 delta 不含任何后端文件,也不含迁移 / DDL;因此**没有**建过一次性库,`plugin-tests.yml` 的真库套件与 r1 的 M8 / M8b / M9 **NOT RUN**,不用前几轮结果填充。
3. **r1 的 21 条验收判据、③ 的真 500 真浏览器对照、P3-2 的真后端复核:本轮 NOT RUN**(均为第 4 轮/门审已做的项,本轮未重跑,也不据此声称本轮已验)。
4. **PG15 轴 / musl collation 轴:NOT RUN。**
5. **`error` 槽位的跨种类仲裁仍未关闭**(设计 MD §8.2 末段),**M-H 仍存活**(P3-1,保持披露)。
6. **§11.7-1 / §11.7-2 两条 owner 项原样保留**:子组件 `isCurrent()` 仍只比代数不核 token;`useSessionOrg` 订阅裸 `onAuthPrincipalChange` 与宿主订阅 `onAuthSessionSwitch` 的判据仍不一致。
7. **P3-2(平铺列表不是 org 域数据)仍是 owner 项**,本轮未改机制、未改措辞。
8. **合并 / undraft / 开 PR / 新分支合并 / DDL 应用 —— 全部未做**,仍需 owner 逐条授权。本件不含任何「已裁 / 已 ratify」的记述。

---

## 13. 第 6 轮验证(对齐 `impl-gate-A5-daily-ops-round5-20260921.md`:0 P1 / 1 P2 / 5 P3 / 4 NIT)

> **PROPOSED —— 未过门审,未 ratify,未合并,未 undraft,未开 PR。**
> 起点 head = `a26d34398dbfa132dda4c051e5d6f9db09bb6090`(`git rev-parse origin/feat/approval-template-groups-phase4-daily-ops`,与门审报告抬头**逐字一致**);`#5878`(`e90d16c90f58a58789a6acd589df362aaa2c2f42`)与 `4e94e8fe0219be61a908f42d5af13dee7e189e1a` 的 `git merge-base --is-ancestor` 双 **PASS**。

### 13.1 改了什么(1 个源文件 + 1 个 spec + 2 个 MD;零新增文件)

另两个被改文件是记录件本身:`…-design-20260920.md`(§8.1 就地勘误 + 新增 §9)与本文件(§12.7-1 就地勘误 + 新增 §13)。

**`apps/web/src/approvals/templateStore.ts` 本轮零改动**(C-4 选的是「写明扩展理由与后果」,不是改代码;见设计 MD §9.4)。这同时是邻居 `approvalMobileDetailActions.spec.ts` 归因的机械证据:`git diff a26d34398d -- apps/web/src/approvals/templateStore.ts` = 空,门审 §B.1 的三点归因(head / r4 store / merge-base store 三版同样 3 failed)因此原样成立,本轮复跑仍是 **3 failed | 8 passed (11)**,**与本候选无因果**。

```
git diff --name-only a26d34398d -- .github/ '**/package.json' '**/s6a-package-provenance-pins.json' apps/web/scripts/ packages/ scripts/   → 空
```
⇒ 零 CI 改动、零 s6a pin 变动、零后端文件、零迁移、零 DDL、零新端点、零新 flag、零新增文件。两个被改的 `apps/` 文件都**已经**在 `approval-web-guard.yml` 的两个 `paths:` 触发器里。

### 13.2 新增用例(4 条,全部落在既有文件)

| # | 用例(原文) | 钉的是 | 判别性由谁证明 |
|---|---|---|---|
| 1 | `(① C-1, partial transition) a cross-tab switch whose marker and token still disagree does NOT throw through the listener: the re-read happens, the failure is rendered as recoverable, and the entry comes back when the switch completes` | 设计 MD §9.1(P2 / C-1) | **M-U**(把不抛入口改回会抛)⇒ 1 failed,只红这一条 |
| 2 | `(① C-1, criterion (b) discriminating) a foreign switch to a DIFFERENT organization is rejected while a VALID ready marker is standing — (b) works by reading a target, not by finding nothing to read` | §9.3 判据 (b) 的判别格 | **M-L-b** 红、**M-L-a 绿** ⇒ 只有 (b) 撑得住它 |
| 3 | `(① C-1, criterion (a) with a valid marker standing) a SECOND foreign switch that lands on this page's own target is still external — (a) rejects it even though (b) matches` | §9.3 判据 (a),marker 全程有效 | **M-L-a** 红、**M-L-b** 也红(它在第一次转换处就错)⇒ 单删 (a) 足以让它红 |
| 4 | `(① C-1, external transition AFTER this page's switch answered) a REFUSED switch leaves no claim behind for a later foreign transition to satisfy` | §9.3「晚于」变体 | **M-V**(删 `onPageSessionOrgChange` 的 `finally { pageOwnedSwitch = null }`)⇒ 1 failed;**M-L / M-L-a / M-L-b 三条全绿** ⇒ 它隔离的是 `finally` 的清理,不是两条判据 |

**判别力矩阵(本轮实测,逐字抄自 mutation 台账)**:

| 用例 | HEAD | M-L | M-L-a | M-L-b | M-U | M-V |
|---|---|---|---|---|---|---|
| 1 partial transition | ✅ | ✅ | ✅ | ✅ | **RED** | ✅ |
| 2 (b) discriminating | ✅ | **RED** | ✅ | **RED** | ✅ | ✅ |
| 3 (a) with valid marker | ✅ | **RED** | **RED** | **RED** | ✅ | ✅ |
| 4 AFTER the switch answered | ✅ | ✅ | ✅ | ✅ | ✅ | **RED** |

> **用例 1 里有一项**故意**不钉的东西,以及它的正控。** 那条用例在「不可读窗口」里**不断言组织列表再问到底发没发出去**:
> 今天它发不出去(`utils/api.ts:167` 的 `authHeaders()` 读同一份 explicit metadata 且无 try/catch ⇒ 那个窗口里每一次
> `apiFetch` 都同步抛),而这正是本轮**披露但不修、交 owner** 的那条(设计 MD §9.1 末段)。把「没发出去」写成断言,
> 就是**把一个 OPEN 缺陷钉成规格** —— 第 2b 轮的 P2-D 在**同一个 spec 文件**里抓的就是这个形状。
> 改为断言这一页真正欠管理员的东西:**有出路** —— 切换器数 + 重试控件数 `>= 1`。它在三种世界里都成立且都有判别力:
> 今天(查询失败 ⇒ 0+1)、将来 `api.ts` 被加固后(查询成功 ⇒ 1+0)、以及**第 5 轮 head 与 M-U 下(0+0 ⇒ 红)**。
> **正控**:`M-aa`(把重试控件的 `v-if` 关成 `false`)⇒ 本用例**变红**,与软化前逐字同一批(`M-aa` 在完整台账里
> 红的两条 = `(④) a FAILED …` + 本用例,软化前后**计数与名字都没变**)⇒ 这条断言是承重的,不是空转。
> 同理,完成切换之后那一步的 `sessionOrgsCalls` 用 `>= 2` 而不是 `=== 2`;**重读次数与入口渲染仍是严格等值**
> (`loadTemplatesSpy` 差值 `=== 2`、`switchers === 1`),因为本 spec 里 store 是 mock 的,这两项不经过 `apiFetch`。

> **「4 条新用例里有几个正控」要说准(门审 NIT-3)**:**一个都没有**。C-1 族的正控仍然是**既存的** `(② M-F)`(本轮 M-F 仍 **2 failed**),C-7 族的正控是第 5 轮新增的 `(C-7 positive control)`。本轮**没有**新增正控,也不把上面 4 条里的任何一条说成正控。

**先红后绿 —— 用例 1 是唯一在 head 上就红的一条,而且它红的方式正是门审在真浏览器里看到的那个异常**(把 `TemplateCenterView.vue` 逐字还原成 head 内容、只留新用例;随后 `cp` 还原 + `cmp` = `RESTORE-CMP-OK`):

```
 Test Files  1 failed (1)
      Tests  1 failed | 58 passed (59)
     Errors  1 error

 FAIL  … > (① C-1, partial transition) a cross-tab switch whose marker and token still disagree …
AssertionError: expected false to be true          ← warn 没记到:那一行抛了,根本没进 catch

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯
Error: SESSION_ORG_REAUTH_REQUIRED
 ❯ ensurePageSessionOrgsLoaded      src/views/approval/TemplateCenterView.vue:685:21
 ❯ redetermineEligibilityAndReload  src/views/approval/TemplateCenterView.vue:820:37
```

> 这**逐行对上了**门审 §C-1 在真 chromium 里抓到的栈(`readExplicitSession` → `getAuthPrincipalKey` → `ensurePageSessionOrgsLoaded` → `redetermineEligibilityAndReload`),**门审自己登记的「vitest 层零覆盖」因此在本轮被关闭**。
> 用例 2 / 3 / 4 在 head 上是**绿的** —— 这正是 C-3 的形状:守卫本来就是对的,缺的是**候选件自己的判别性用例**;它们的判别力由上面的 mutation 矩阵证明,而不是由「在 head 上红」证明。

**修复版同一命令**:`Tests  59 passed (59)`(55 + 4)。

### 13.3 Mutation 台账 —— 本轮跑 **72 条探针**,零幸存者回退

规程不变:`cp` 备份到 `…/scratchpad/a5r6-mutbak/`(**显式相对路径白名单,绝不按 basename 匹配**)→ 改坏 → 运行器自检「锚点存在 + 文件真的变了 + 不是 `NO-SUMMARY`」→ 跑 → `cp` 还原 → `filecmp` 校验。**零 `git checkout --` / 零 `reset --hard` / 零 `stash`。** 72 条跑完后 7 个被探针碰过的文件逐个 `cmp` 与备份一致(`view` / `store` / `auth` / `panel` / `sections` / `switcher` / `api` 全部 `CMP-OK`),`git status --porcelain` 只剩本轮有意改的 4 个文件。

**与门审「38 条」的对账,说准**:门审 §B.2 的 38 = 10 条 round-5 新探针 + 26 条按原编号重跑 + 2 条门审自有(其中 `G-CLEARTOK` 被门审**自己撤回**)。那 **36 条有编号的本轮全部重跑**,结果见下;门审自有的 2 条是门审的工件(`G-CLEARTOK` 已撤回;`[GATE-V2]` / `[GATE-V3]` 的**机制**按门审 C-3 修法第 1 项**移植进了候选件**,即 §13.2 的用例 2 / 3)。本轮实跑的 72 条是那 36 条的**超集**(把 r1 / r2 / r2b 台账里可复原的探针一并重跑)。

#### (a) round-6 新探针(2 条,全部承重)

| 探针 | 改坏了什么 | 结果 | 红在哪(原文) |
|---|---|---|---|
| **M-U** | `tryReadAuthPrincipalKey` 绕过 catch,直接 `return getAuthPrincipalKey()`(= 第 5 轮的形状) | **1 failed** | `(① C-1, partial transition) a cross-tab switch whose marker and token still disagree does NOT throw through the listener…` |
| **M-V** | 删 `onPageSessionOrgChange` 的 `finally { pageOwnedSwitch = null }` | **1 failed** | `(① C-1, external transition AFTER this page's switch answered) a REFUSED switch leaves no claim behind…` |

#### (b) 门审点名的 36 条,按原编号重跑

| 编号 | 出处 | 本轮 | 与门审 round-5 的差 |
|---|---|---|---|
| M-L | r5 | **4 failed** | +2 —— 新增的用例 2 / 3 也红,覆盖变宽 |
| M-L-a | r5 | **2 failed** | +1 —— 新增用例 3 |
| M-L-b | r5 | **4 failed** | +2 —— 新增用例 2 / 3 |
| M-N | r5 | 1 failed | 同 |
| M-O / M-P / M-Q / M-R / M-S | r5 | 各 1 failed | 同 |
| M-T | r5 | **12 failed** | +4 —— 四条新用例全部红(它一律保留 claim) |
| M-A | r3 | 4 failed | 同 |
| M-B-old / M-B-prime | r4 | 2 / 2 failed | 同 |
| M-B-SIG | r4 | 3 failed | 同 |
| M-B-FSIG | r4 | 1 failed | 同 |
| M-CLOSABLE | r4 | 1 failed | 同 |
| M-C | r3 | 1 failed | 同 |
| M-D | r3 | 2 failed(5-spec 集合 128) | 同 |
| M-E | r3 | 1 failed | 同 |
| M-F | r3 | 2 failed | 同(C-1 族的正控,仍承重) |
| M-G | r3 | 2 failed | 同 |
| **M-H** | r3 | **存活(59 passed)** | 同 —— **已披露的不可达守卫,保留,不通胀**;正控见下 |
| M-I | r3 | 15 failed / 128 | 同 |
| M-J / M-K | r3 | 各 1 failed | 同 |
| MUT-S1 / MUT-S2 / MUT-S3 | r4 | 4 / 2 / 2 failed | 同(S3 的锚点迁移见 §12.3 的登记,本轮未再变) |
| M2 | r1 | 1 failed | 同 |
| M-e / M-f | r2 | 2 / 1 failed | 同 |
| M-h | r2 | 1 failed | 同 |
| M-n / M-o | r2b | 3 / 2 failed | 同 |
| **M-H-5spec** | r3/r4 | **存活(128 passed)** | 同 |
| **M-G-5spec** | r3/r4 | **2 failed** | 同 —— M-H 的正控,同一集合、同一函数的失败分支 |

#### (c) 其余 34 条(r1 / r2 / r2b 台账里可复原的,本轮一并重跑,全部承重)

`M7-prime` 5 / `M7b-prime` 25 / `M7c-prime` 7 / `M7d-prime` 28 / `M-w` 4 / `M-x` 14 / `M-t` 1 / `M-u` 20 / `M-v` 2 / `M-aa` 2 / `M-ad` 1 / `M-ae` 1 / `M-z` 15 / `M-p` 1 / `M-q` 1 / `M-r` 1 / `M-s` 1 / `M-y` 1 / `M-ab` 1 / `M-ac` 1 / `M-a` 5 / `M-a2` 2 / `M-c` 3 / `M-d` 1 / `M1` 2 / `M3` 1 / `M4` 2 / `M4b` 4 / `M5` 1 / `M6` 1 / `M6b` 1 / `M-g` 1 / `M-i` 2 / `M-nitc` 1 —— **failed,全部非零。**

> **两处新的锚点迁移,必须登记,不能默默替换**(与第 5 轮 MUT-S3 同样的处置):
> **M-T** 与 **M-ad** 原来的锚点是 `pageSessionOrgsClaim = ownSwitch ? { principal: getAuthPrincipalKey() } : null`;本轮起该行读 `tryReadAuthPrincipalKey()`(设计 MD §9.1)。两条探针的**语义未变**(M-T:一律保留 claim;M-ad:一律丢 claim),只把函数名跟着改。结果:M-T **12 failed**、M-ad **1 failed**,与前轮同向且覆盖变宽。
> **`M-b` / `M-b2` 仍为 NOT RUN**,理由与第 5 轮逐字相同:前轮台账只写了「可辩护地 inert」,**没有记下它们改的是哪一行**,本代理不按描述另造一个更窄的同类物冒充原探针(房规「另造更窄同类物=合同变更」)。

**唯一的幸存者**是 `M-H` / `M-H-5spec`(同一行的两个集合),与 r3 / r4 / r5 **四轮同结论**⇒ 不是「无判别力的测试」而是「不可达的纵深守卫」,**保留,不通胀**(设计 MD §7.4 / §9.5)。

### 13.4 静态门

| 门 | 结果 |
|---|---|
| `vue-tsc --noEmit -p tsconfig.app.json` | **EXIT=0,零行输出** |
| `vue-tsc -b --force` | **EXIT=2,恰 1 个 `error TS`,唯一来源 `vite.config.ts`** —— **与 main 同形,按机械证据而不是复述**:`git diff --stat origin/main a26d34398d -- apps/web/vite.config.ts` = **空**(该文件与 `origin/main` 逐字相同),所以这条错误不可能由本分支引入。第 5 轮 §12.4 已在独立 main 工作树上跑出同一个 `TS2769` / 同一个文件。按任务书「仅允许与 main 同形环境项」登记 |
| `vite build` | **EXIT=0**,`✓ built in 12.64s`(仅既有 chunk-size 警告) |
| `packages/core-backend` `tsc --noEmit` | **EXIT=0,零行输出** |

### 13.5 required 门真正承重的那条活 `exec` 行 —— 直跑

```
grep -c '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh   → 1     (恰一条)
该行位置 :1211 ;`awk NF` = **405 个 token**(`exec` / `npx` / `vitest` / `run` + 401 个位置参数)
9/9 被改 / 相关 spec 的 token 都在该行上(category / sections / panel / switcher /
   groupsClient / i18n / governance / e2e-lifecycle / e2e-permissions)—— 逐个 PRESENT

本轮 head:   Test Files  473 passed (473)      Tests  7368 passed (7368)      EXIT=0
r5 head 基线:Test Files  473 passed (473)      Tests  7364 passed (7364)      EXIT=0(§12.5)
Δ = +4 = 本轮新增用例数(§13.2),零既有用例丢失、零既有用例转红。
```

收集行(本轮 head,**提交树上的最后一次运行**):`Duration 53.72s (transform 25.46s, setup 2.79s, collect 133.58s, tests 189.15s, environment 86.42s, prepare 17.31s)`。

> **仍不重走 `bash run-required-web-tests.sh` 整脚本**,理由与第 5 轮 §12.5 逐字相同(脚本 `:606` 的预检 spec 在本机 Node 25 下红、`:473` 的 `set -euo pipefail` 就地中止、`:1211` 的 `exec` 到不了;该 spec 在 `origin/main` 同 SHA 上 CI 为绿,本分支对它零改动)。本轮按任务书直跑活 `exec` 行,上表即执行层证据。

### 13.6 全量实跑(数字逐字抄自输出)

```
# 被触碰 spec + 本分支 spec(9 个)
Test Files  9 passed (9)        Tests  263 passed (263)      ← r5 为 259,Δ=+4

# 邻居 8 个(useSessionOrg / AttendanceSessionOrgSwitcher / approvalNewView /
#            templateDetailI18n / approvalDetailPolish / approvalTemplateVersionHistory /
#            approval-detail-instance-consistency / approval-detail-can-decide-current-node)
Test Files  8 passed (8)        Tests  135 passed (135)      ← 与 r5 逐字相同

# 邻居:approvalMobileDetailActions(既存红,与本候选无因果,见 §13.1)
Test Files  1 failed (1)        Tests  3 failed | 8 passed (11)
```

### 13.7 本轮未做 / 交 owner(不藏)

1. **真浏览器 / 双标签页重放:NOT RUN。** 本轮的 C-1 证据来自 vitest 组件机具,但**这一次真的走了 `window` 的 `storage` 事件那一跳**(真 `StorageEvent` → 真 `useAuth.ts:65-78` 监听器 → 真 `resetSessionBootstrap` → 真 `onAuthSessionSwitch`),不再是直接调生产 setter。**仍未在真 chromium 里重放**;门审 round-5 已在真浏览器上做过 CONTROL/PROBE 两臂 ×2 的红/绿对照,本轮 delta 未触碰那两臂走过的任何一行以外的行为。标 **UNVERIFIED-IN-BROWSER**。
2. **后端真库步骤:零。** 本轮 delta 不含任何后端文件、迁移或 DDL;**没有建过一次性库**,`plugin-tests.yml` 的真库套件与 r1 的 M8 / M8b / M9 **NOT RUN**,不用前几轮结果填充。**PG15 轴 / musl collation 轴:本轮 NOT RUN**(门审 round-5 在其自己的一次性库上覆盖过 PG15,那是门审的工件,不计为本轮已验)。
3. **门审 §A.3 的 ④ 腿(真 503 → 重试 → 入口回来)本轮 NOT RUN**;门审登记为 INCONCLUSIVE(其代理 503 规则在页面侧零命中,是机具问题),r4 在 `4e94e8fe0` 上实测 PASS(4/4),本轮 delta 未触碰 `pageSessionOrgsFailed` / 重试控件的任何一行 —— **但本轮新增用例 1 在单测层第一次断言了这条路径的可恢复渲染**(重试控件在场)。建议下一轮仍按门审建议重测真浏览器腿。
4. **`utils/api.ts:167` 的同族缺口:披露,不修。** `authHeaders()` 直接调 `explicitSessionOrg(...)` 且无 try/catch,所以在同一个「marker 与 token 不自洽」窗口里**整个 app 的每一次 `apiFetch` 都会同步抛**。本轮用例 1 把它实测出来并写进断言(那个窗口里组织列表再问 `sessionOrgsCalls` 停在 1)。改它是跨全站的共享模块变更 + 门审 C-1 修法第 2 项的 16 调用点普查,**越出本轮人口,登记 OPEN 交 owner**(设计 MD §9.1 末段 / §9.6)。
5. **监听器那一处 `tryReadAuthPrincipalKey()` 无判别输入**:按机制够不到(设计 MD §9.1 末段),**登记为纵深防御,不声称有用例覆盖**。
6. **C-4 选的是「写明」而不是「撤回」**(设计 MD §9.4):`loadTemplate` / `loadVersion` 的身份丢弃**保留**,扩展理由、「无 replay 所有者」的后果、可达性边界、以及「要不要把身份丢弃限定在有 replay 所有者的读上」这个**结构性要求**都写在 §9.4,**交 owner 裁**。
7. **`error` 槽位的跨种类仲裁仍未关闭**(设计 MD §8.2 末段);**M-H 仍存活**(C-5 / P3-1,保持披露);**C-6 / §7.3 的 owner 项原样保留**,本轮无真库步骤、不重新取证、不改措辞。
8. **门审 NIT-2(`M-P`/`M-R` 与 `M-Q`/`M-S` 红在同一条用例)本轮不拆**,登记 OPEN(设计 MD §9.7)。
9. **合并 / undraft / 开 PR / 新分支合并 / DDL 应用 —— 全部未做**,仍需 owner 逐条授权。本件不含任何「已裁 / 已 ratify」的记述。

### 13.8 mutation 台账之后的那一次编辑,以及为什么台账仍然绑定(不藏)

§13.3 的 72 条探针跑完之后,本轮**又改过一次**被测文件,必须说清改了什么、以及为什么不需要重跑台账:

1. **注释**:`TemplateCenterView.vue` 里 `tryReadAuthPrincipalKey` 在监听器那一处的说明,原文写「两次读之间**没有**任何能碰
   storage 的东西」。这句话越界了 —— 语句顺序只能约束**本标签页**做了什么,而**另一个标签页的写**正是推翻第 5 轮
   「到得了这个监听器的路径都已完成转换」的那个主体。改成只主张能主张的:「本监听器**自己的**语句里没有碰 storage 的」,
   并明说**正因为跨标签页的写在原则上落得进来,这个调用才是被守住而不是被论证掉的**。
2. **两条断言软化**(上文方框):`sessionOrgsCalls` 的两处严格等值换成「有出路 `>= 1`」与 `>= 2`。

两项都**不改一行行为**。台账因此仍然绑定:`M-U` 的红来自用例 1 的**第一条**断言(warn 有没有记到),与被软化的两条无关
——**已复跑核对**(M-U:`1 failed`,只红用例 1;M-aa:`2 failed`,与软化前逐字同一批)。
`…/scratchpad/a5r6-mutbak/` 在这次编辑之前就已按清理规程删掉,所以**没有**再跑整套台账(也因此不会踩到本轮登记过的
「`restore()` 会用陈旧 `.orig` 静默回滚」那个机具坑);重跑的是 §13.4 / §13.5 / §13.6 的全部门与全量实跑,数字见上。
