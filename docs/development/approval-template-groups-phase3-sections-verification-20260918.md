# 审批表单分组 Phase 3(切片 A-4)— 验证 MD

- 锁文:`approval-form-group-entity-design-lock-draft-20260916.md`(**v2.13 RATIFIED 2026-09-18**)
- 设计 MD(同批交付):`approval-template-groups-phase3-sections-design-20260918.md`
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片 `A-4 分期 3`)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md`「lane A(分组)」#5–#7
- 分支:`feat/approval-template-groups-phase3-sections`,堆叠基线 A-1 头 `a728ed655`
- 本文档写作时 worktree HEAD(重跑发生时):`6e2e48a7c94499bee6e0e2b622a9f238309ca6ef`
- 私有真库(本次重跑,**处女库**,与之前任何一次 rebase/实现期跑过的库都是不同的物理库):`metasheet2_lock_a4_docs`(`dropdb --if-exists` + `createdb`,本机 Homebrew PostgreSQL 15.17)
- 环境:node `v25.9.0`,pnpm `10.33.0`
- **§1 是原 `approval-template-groups-phase3-sections-rebase-note-20260918.md` 的原文并入**(该 rebase-note 记录的是 rebase 到 A-1 头之后、本轮文档提交之前的一次独立验证;其私有库 `metasheet2_lock_a4_rb` 与本文档 §2 起使用的 `metasheet2_lock_a4_docs` 是两个不同的物理库,内容不共享状态)。任务书要求「把 rebase-note 并入验证 MD 后删除该 note 文件」,已执行——该文件本次提交中被删除,内容原样搬进本节。
- **§2 起是本次(文档交付)在全新处女库上的独立重跑**,不是抄 §1 的旧结果。

## 1. Rebase-onto-A-1 验证记录(原 rebase-note,原文并入)

> 以下内容逐字保留自 `approval-template-groups-phase3-sections-rebase-note-20260918.md`(已删除),仅去除文件自身的标题行,章节编号改为本文档的子节。原文引用的 `metasheet2_lock_a4_rb` 库、`27bb6edfe6...` 头、以及 §1.4 中对 `atg-retraction-sweep.sh` 自身进入扫描面的复核,均为**该次独立验证发生时刻**的现场记录,不因并入本文档而重新执行——§8 会用当前 HEAD 重跑一次同一个脚本,给出这份历史记录之后的最新命中。

### 1.1 元信息(原 rebase-note 抬头)

- 分支:`feat/approval-template-groups-phase3-sections`(worktree `wt-groups-p3`),堆叠在 `feat/approval-template-groups-phase1` 之上
- rebase 前本分支头:`4641f938b933294d0792d2e92b354ee48a7066eb`
- rebase 目标(`origin/feat/approval-template-groups-phase1` 当时头,含 A-1 回流修复):`a728ed65532918e3726171d0c42f44d6be7e0ba9`
- 旧公共基点(rebase 前两分支的 merge-base):`0144932ac67e80a81f204dd6c6e502d000112276`
- rebase 后本分支头:`27bb6edfe6cdca22d4a0265463f029a67722b795`(12 个提交全部原样重放,提交信息与顺序未变,仅 parent 改写)
- `origin/main`(仅记录,未涉及本次 rebase):`3c6c28958c2ce51334b8f02df13272ef0ae77889`
- 环境:node `v25.9.0`,python3 `Python 3.9.6`,pnpm `10.33.0`
- 私有真库:`metasheet2_lock_a4_rb`(本机 Homebrew PostgreSQL 15.17,`dropdb --if-exists` + `createdb` 全新建库,`pnpm --filter @metasheet/core-backend migrate` 跑满 350 个迁移文件,全部 `was executed successfully`,最后一条 `zzzz20260918090000_create_approval_template_groups`;收尾又空跑一次 `migrate --latest` 确认零待应用迁移、命令本身零报错——DDL 零改动,与 A-1 回流修复的说明一致)

### 1.2 rebase 结果:零冲突

```
git fetch origin feat/approval-template-groups-phase1 feat/approval-template-groups-phase3-sections
git rebase origin/feat/approval-template-groups-phase1
```

输出:`Successfully rebased and updated refs/heads/feat/approval-template-groups-phase3-sections.`(12/12,过程中**没有**进入任何冲突态、没有 `git status` 显示 unmerged path、没有需要 `git add`/`--continue` 的手工步骤)。

收尾复核(rebase 完成后,非"过程中免检"):

```
git status --porcelain                                                          # 空
grep -rn '^<<<<<<<\|^=======$\|^>>>>>>>' --include=*.ts --include=*.vue \
  --include=*.yml --include=*.mjs --include=*.sh . | grep -v node_modules | wc -l
# 0
```

原因:A-1 的回流修复(`ApprovalTemplateGroupService.ts` 的 23514→400 映射、`routes/approvals.ts` 的 guard/manager 措辞三次改写、`approval-template-groups-lifecycle.db.test.ts` 新用例、两个 `scripts/dev/*.sh`)与 A-4 本 lane 的改动(`routes/approvals.ts` 追加 `section=` 列出 + reorder 端点、两个新服务类、两个新真库测试文件、`plugin-tests.yml`/`vitest.config.ts`/`run-required-web-tests.sh`/s6a 钉/ci-wiring 闭世界)是**同文件不同区块的纯追加**——git 三路合并按行区间自动拼合,没有触发任何冲突配方(错误映射两边保留 / 测试与人口取并集 / s6a 重算)里预案的手工合并步骤。逐项核对(而非只信任"零冲突"这一个信号):

- `ApprovalTemplateGroupService.ts`:`grep -n "23505\|23514"` 命中两码共存(23505 @ L165、23514 @ L176,含注释),A-4 从未改过此文件(rebase 前后对该文件的 diff 均为 0 行)。
- `routes/approvals.ts`:A-1 的三次改写(guard⊆manager → guard⊋manager → 互不包含,`:395-440`)与 A-4 新增的 `section=` 分节读路径(`:640` 起)、reorder 端点(`:1288`)共存,互不重叠。
- `packages/core-backend/vitest.config.ts` 的 exclude 数组:4 个 `approval-template-groups-*.db.test.ts` 各恰好出现 1 次(`grep -c` 核验),无重复条目。
- `.github/workflows/plugin-tests.yml`:phase1 未 touch 此文件(其 diff-stat 里没有这一行),A-4 自身新增的 1 个 ci-wiring 步骤名 + 4 个 db-test 文件名各恰好出现 1 次(`grep -c` 核验),无重复步骤/重复 whole-file 参数。
- `scripts/ops/approval-template-groups-ci-wiring.test.mjs`(A-4 的闭世界清单)`FILES` 数组本就是 A-1 的两个原始文件 + A-4 的两个新文件共 4 个,是并集自身,rebase 未改变这一点,`node --test` 现场重跑 12/12 全绿(见 §1.3)。
- s6a 钉(`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 的 `pluginTestsWorkflow`)与 rebase 后 `.github/workflows/plugin-tests.yml` 的 `sha256sum` 现场比对**逐字节相等**(`c63eeb5bfabc0aaf74552be66fe8fd7e744e1fcdfcc78dafd45ed1a59a2ee6f4`)——因为 phase1 未改过这个文件,rebase 不改变其字节内容,A-4 提交时已经算过的钉在新头上依然成立,**未重算,因为无需重算**(不是漏做,是机械验证过后确认没有漂移)。

结论:冲突配方(错误映射两边保留、测试/人口取并集、s6a 重新机械计算)全部是**预案**,实际 rebase 未触发,已用上述逐项 grep/diff 核验替代"假设已合并正确"。

### 1.3 私有真库测试(rebase 后,`metasheet2_lock_a4_rb`)

命令(`packages/core-backend` 目录下):

```
DATABASE_URL="postgresql://postgres@localhost/metasheet2_lock_a4_rb" EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-lifecycle.db.test.ts \
  tests/integration/approval-template-groups-serialization.db.test.ts \
  tests/integration/approval-template-groups-sections.db.test.ts \
  tests/integration/approval-template-groups-reorder.db.test.ts \
  --reporter=dot
```

结果:`Test Files 4 passed (4)` / `Tests 39 passed (39)`(`EXPECT_DB=1` 的哨兵用例本身也在 39 条之内且通过,证明本轮不是 `DATABASE_URL` 缺失导致的 skip-green)。四个文件里前两个(lifecycle/serialization)是 A-1 的原始文件,后两个(sections/reorder)是本 lane(A-4)新增文件——rebase 后四者在同一私有库上一次性全绿。

`node --test scripts/ops/approval-template-groups-ci-wiring.test.mjs`(仓根目录):`tests 12` / `pass 12` / `fail 0`——闭世界二点接线(`vitest.config.ts` 排除 + `plugin-tests.yml` 真库步骤内 whole-file 参数 + 文件存在)对四个文件逐一核验通过。

### 1.4 A-1 两个脚本(`scripts/dev/*.sh`)复跑(rebase 后)

`scripts/dev/atg-retraction-sweep.sh`(默认 `origin/main` 基线,exit 0——该脚本是报告工具,恒 0,需人读):扫描范围覆盖本分支相对 `origin/main` 的全部改动文件。对 `⊆/⊇/⊂/⊃/⊋/⊊/子集/超集/严格超集/subset/superset/无法制造/通配权限码` 各模式在 `routes/approvals.ts`/`ApprovalTemplateGroupService.ts`/两份 phase1 文档里的命中逐条读原句:全部落在(a)明确点名"已撤回/已证伪/CORRECTED A THIRD TIME"的历史叙事,或(b)"互不包含/mutually non-inclusive/neither is a subset"这类否定式现测结论,或(c)`export⊆read`/`subset`(Wave 2 WP3 的 `unreadCount`)等与 `isTemplateManager`/guard 无关的误命中——**零处**以现在时重申任一方向的包含关系。`routes/approvals.ts:406-440` 的三层递进撤回(`⊆`→`⊋`→"itself false"→"mutually non-inclusive")在 rebase 后原样保留、内容未变(rebase 只重放提交,不改内容)。

`scripts/dev/atg-verification-recount.sh`(exit 0):机械重数 `approval-template-groups-lifecycle.db.test.ts` + `-serialization.db.test.ts` 两文件的 `.status).toBe(4xx|500)`(20 处)与 `error.code).toBe('CODE')`(15 处,11 个不同码 + `APPROVAL_TEMPLATE_NOT_FOUND` 复用 2 处单独 track)命中——数字与两份文档 §14/§24.5 一致,rebase 未引入新的裸 403/新码。

两脚本均为报告/计数工具(exit code 恒 0),真正的判据是人工读每一条命中的完整句子(见上),不是脚本自身的退出码。

**收尾复核(rebase-note 撰写时的原始记录,历史值,§8 会给出并入本文档之后的最新一次)**:rebase-note 写入后自身进入了 `atg-retraction-sweep.sh` 的扫描范围(其扫描面是 `git diff --name-only origin/main..HEAD`,写入该文档的提交把它自己变成了这个 diff 的一部分)。当时命中该文档 `:33`(`guard⊆manager → guard⊋manager → 互不包含` 的压缩叙事,以否定式"互不包含"收尾)与 `:61`(逐字引用脚本自身的模式列表,做的是"这个脚本扫什么"的元描述)——两处均为脚本自身分类规则下的合法命中,零处新增现在时包含断言。当时的重跑还额外带出 15 个此前未见的文件(`identifiers.ts`/`comments.ts`/`CommentService.ts` 等),核实是 `origin/main` 在执行期间从 `aebed089654f756a76b024a98e051f65e59a1969` 前进到了 `3c6c28958c2ce51334b8f02df13272ef0ae77889`(仓库有其它并行合并,与本 lane 无关)——**这些行号锚点(`:33`/`:61`)在本次并入之后已经作废**(rebase-note 文件本身已删除,不再是 diff 的一部分),§8 用当前 HEAD 重跑一次给出替换值,不沿用这里的旧行号。

### 1.5 三条 required 逐字复现(rebase 后,历史记录)

**`pnpm type-check`**:仓根目录执行,退出码 0。`packages/core-backend`(`tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json`)与 `apps/web`(`vue-tsc -b` + 两个 verification 项目引用)均 `Done`,零报错。

**`CI=true pnpm --filter @metasheet/core-backend test`(全量)**:仓根目录执行,`vitest`(默认 `vitest.config.ts`,不含 `DATABASE_URL`,四个 `approval-template-groups-*.db.test.ts` 按 exclude 名单跳过——与 CI 的无库 `test` job 行为一致):

```
Test Files  933 passed | 175 skipped (1108)
     Tests  14737 passed | 1604 skipped (16341)
```

全文件零 `FAIL`。第一遍在后台跑;为了拿到硬退出码,追加重跑一遍并显式 `echo "EXIT=$?"`——第二遍同样是 `EXIT=0`,数字逐位一致,零 `FAIL`。

**`bash -e apps/web/scripts/run-required-web-tests.sh`**:仓根目录执行,重复跑两遍,均 `EXIT_CODE=0`。第二遍确认:

```
Test Files  466 passed (466)          # 脚本内最后一个 exec 段自身的小计
     Tests  7182 passed (7182)
EXIT_CODE=0
```

脚本由多段独立 `npx vitest run <tokens>` 调用串联、末段用 `exec` 替换 shell 进程;把全部段落的 `Test Files`/`Tests` 小计逐段相加:**总计 568 个测试文件、9122 个用例全部 passed,零 failed,零 skipped**,全文件零 `FAIL`/`✗`/`×`。本 lane 新增的前端分节 spec `tests/approvalTemplateCenterSections.spec.ts`(18 用例)在脚本最后一段(`exec` 段,末尾追加的 `approvalTemplateCenterSections` token)里确认执行并通过。

### 1.6 结论(rebase-note 原结论)

`git push --force-with-lease origin feat/approval-template-groups-phase3-sections` 前的三条 required 全绿,rebase 零冲突且逐项核验一致,四个真库文件 + 两个 A-1 脚本在新私有库 `metasheet2_lock_a4_rb` 上现场复核通过。分支头 `27bb6edfe6cdca22d4a0265463f029a67722b795`。

---

## 2. 本次(文档交付)重跑 —— 处女库 `metasheet2_lock_a4_docs`

与 §1 使用不同的物理库,以下命令全部在本文档撰写当次现场重跑,不沿用 §1 的旧结果。

### 2.1 建库 + 迁移

```
$ dropdb --if-exists metasheet2_lock_a4_docs && createdb metasheet2_lock_a4_docs
NOTICE:  database "metasheet2_lock_a4_docs" does not exist, skipping
$ DATABASE_URL="postgresql://postgres@localhost/metasheet2_lock_a4_docs" pnpm --filter @metasheet/core-backend migrate
...
migration "zzzz20260918090000_create_approval_template_groups" was executed successfully
```

全部迁移(截至本 HEAD 共 350+ 个文件)逐条 `was executed successfully`,最后一条是本功能的 DDL 迁移。收尾空跑一次同一条 `migrate` 命令,输出为空(无新迁移待应用),`EXIT=0`——确认零待应用迁移,DDL 与代码状态一致。

### 2.2 Schema 现场核对(不是照抄迁移文件,是 `\d` 现场输出与设计 MD §2.1/2.2 逐条比对)

```
$ psql -d metasheet2_lock_a4_docs -c "\d approval_template_groups"
```
索引:`approval_template_groups_pkey`(PK,id)、`atg_org_id_uni`(UNIQUE, org_id,id)、`atg_sort_unique`(UNIQUE, org_id,sort_order, **DEFERRABLE INITIALLY DEFERRED**)、`uq_atg_org_name_active`(UNIQUE, org_id,name, `WHERE archived_at IS NULL`)。CHECK:`atg_name_nonblank`、`atg_org_nonblank`、`atg_sort_archived_pair`。字节与 A-1 设计 MD §2.1 表逐条一致。

```
$ psql -d metasheet2_lock_a4_docs -c "\d approval_template_group_links"
```
PK `(org_id, template_id)`;CHECK `atgl_org_nonblank`/`atgl_state_check`;FK `atgl_group_fk`(复合,→ `approval_template_groups(org_id,id)`)、`atgl_template_fk`(→ `approval_templates(id)` ON DELETE CASCADE)。与 A-1 设计 MD §2.2 表逐条一致。

### 2.3 四个 `.db.test.ts` 真库重跑(§4 验收 C/D/E 后半、I3 的主证据)

```
$ DATABASE_URL="postgresql://postgres@localhost/metasheet2_lock_a4_docs" EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-lifecycle.db.test.ts \
  tests/integration/approval-template-groups-serialization.db.test.ts \
  tests/integration/approval-template-groups-sections.db.test.ts \
  tests/integration/approval-template-groups-reorder.db.test.ts \
  --reporter=dot
```

结果:

```
 ✓ tests/integration/approval-template-groups-lifecycle.db.test.ts
 ✓ tests/integration/approval-template-groups-serialization.db.test.ts
 ✓ tests/integration/approval-template-groups-sections.db.test.ts (5 tests) 299ms
 ✓ tests/integration/approval-template-groups-reorder.db.test.ts (5 tests) 323ms

 Test Files  4 passed (4)
      Tests  39 passed (39)
```

`EXPECT_DB=1` 哨兵用例(每文件一条)均在 39 条之内且通过,不是 skip-green。同一命令重跑第二遍(mutation 探针之后的收尾核验,见 §7)结果逐位一致。

## 3. 验收行 → 测试文件 + 用例名 + lane(全部映射,不留空)

| 锁文行 | 判据摘要 | 测试文件 | 用例名(节选,逐字) | lane |
|---|---|---|---|---|
| §4 C(四桶) | `group:<id>`①/`ungrouped`②+④/`category:<name>`③,不重不漏 | `approval-template-groups-sections.db.test.ts` | `C: three tokens / four buckets — group:<id> / ungrouped (②+④) / category:<name>, no template in two sections or zero sections` | `approval-real-db-integration` 步骤,`test (20.x)` |
| §4 C(分页) | 每 section 独立 `total`,不跨桶不丢行 | 同上 | `C: pagination is scoped to the section — total is this bucket's own count, pages do not overlap or drop rows` | 同上 |
| §4 C/J(400) | `?category=` 与 `section` 同现 400;未知 `section=` 令牌 400;重复 query key(数组)两种都不下沉 | 同上 | `C/J: malformed section requests are rejected 400 before any DB access` | 同上 |
| §4 D | category 后备 = `NOT EXISTS`(从未关联),非 `group_id IS NULL` | 同上 | `D: category fallback is scoped to "never had a link row" — NOT "group_id IS NULL" (that is the B′ mutation target, re-run here at the section layer)` | 同上 |
| §4 D(前端半,按测试名重钉,不新建文件) | 分组不改变扁平表格 tag 渲染;`category=''` 与 `null` 同归空态 | `apps/web/tests/approvalTemplateCenterCategory.spec.ts` | `renders a category tag per row`(同名重钉,`:489` 附近;新增 I6 断言 `listApprovalTemplateGroupsSpy` 未被扁平路径调用) | `run-required-web-tests.sh`(既有 token `categoryCandidateInput` 覆盖的文件) |
| §3 I3(重排 1..n) | 分期 3 拖拽后整体重排,序号写 1..n,L0 锁内 | `approval-template-groups-reorder.db.test.ts` | `writes sort_order = 1..n in the SUBMITTED order, not the pre-existing creation order` | `approval-real-db-integration` 步骤 |
| §3 I3(集合校验,纯函数) | 排列缺项/多项/重复/含归档组 ⇒ `GROUP_REORDER_SET_MISMATCH` | `packages/core-backend/tests/unit/approval-template-group-reorder-validation.test.ts` | 7 条 `it`(accepts exact permutation / accepts empty / rejects missing / rejects extra / rejects duplicate / rejects archived / raises dedicated code) | 无库 `test (20.x)` 的 `tests/unit/` 收集面(非 `.db.test.ts`,不被 exclude) |
| §4 E 后半(并发重排) | 两次并发重排 ⇒ 终态是其中一方的完整 1..n 排列,非撕裂混合 | `approval-template-groups-reorder.db.test.ts` | `E (phase 3): two concurrent reorders of the SAME org both succeed; the final state is exactly ONE side's complete 1..n permutation, never a torn mix` | `approval-real-db-integration` 步骤 |
| §4 E 后半(集合不匹配,端到端) | 排列含归档组/缺项 ⇒ 400,且 `sort_order` 未被触碰 | 同上 | `400 GROUP_REORDER_SET_MISMATCH when the permutation includes a since-archived group id, and leaves sort_order untouched` | 同上 |
| §4 E 后半(请求形状) | `groupIds` 非法形状(非数组/空白项)⇒ 400,先于 DB | 同上 | `400 GROUP_REORDER_IDS_REQUIRED before any DB access when groupIds is not an array of non-blank strings` | 同上 |
| §4 C/J(令牌语法,纯函数) | 三令牌语法 + 8 条反例 | `packages/core-backend/tests/unit/approval-template-group-section-token.test.ts` | 13 条 `it`/`it.each`(recognizes "ungrouped" / splits group:<id> / splits category:<name> on first colon / does not trim / 8× returns null for ...) | 无库 `test (20.x)` 的 `tests/unit/` 收集面 |
| §6 表第 3 行(前端分节 + 上移下移 + 拖拽归组替代) | 见 §5 全表 | `apps/web/tests/approvalTemplateCenterSections.spec.ts` | 18 条 `it`(见 §6) | `run-required-web-tests.sh`,新增 token `approvalTemplateCenterSections`(脚本末段) |
| Q5 | `?category=`/`/categories` 去留——本切片不删不改 | 无独立测试(设计 MD §7 披露项,非可测判据) | — | — |

**"被触发≠被验证"核对**:两个 `tests/unit/*.test.ts` 文件不是 `.db.test.ts`,不在 `vitest.config.ts` 的 exclude 名单里,因此会被无库 `test` job 正常收集——已在 §4 的全量重跑输出里逐条 grep 到(`approval-template-group-reorder-validation.test.ts` 的 7 条用例、`approval-template-group-section-token.test.ts` 的 13 条用例全部以 `✓` 出现),另有 `tests/unit/approval-ci-coverage-enumeration.test.ts` 的「T4」census 用例明确断言这两个文件「is wired」——不是只看到文件名出现在收集列表就当作已验证,是看到具体用例的 `✓` 与内容匹配。

## 4. 三条 required 逐字复现(本次处女库重跑,非沿用 §1.5 的历史值)

### 4.1 `pnpm type-check`

```
$ pnpm type-check
Scope: 13 of 14 workspace projects
packages/core-backend type-check$ tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json
packages/core-backend type-check: Done
apps/web type-check$ vue-tsc -b && pnpm run type-check:verification-approval && pnpm run type-check:verification-stock-prep
apps/web type-check: Done
```
`EXIT=0`,零报错。

### 4.2 `CI=true pnpm --filter @metasheet/core-backend test`(全量,无库)

```
Test Files  933 passed | 175 skipped (1108)
     Tests  14737 passed | 1604 skipped (16341)
EXIT=0
```
`grep -c "^ FAIL"` = 0。数字与 §1.5(rebase 后)逐位一致——**这是预期的,不是巧合**:`git diff --stat 27bb6edfe..HEAD` 只有 1 个文件(rebase-note 本身,100 行新增,纯文档),`27bb6edfe`(rebase-note 记录的头)到本次重跑的 HEAD(`6e2e48a7c`)之间的两个提交(`94cbf9dd6`/`6e2e48a7c`)全部是文档提交,代码零改动,故两次全量测试的通过/跳过计数理应逐位相同——不是省略重跑、直接抄旧数字,是两次独立执行且确认了它们应当相等的理由。

### 4.3 `bash -e apps/web/scripts/run-required-web-tests.sh`

```
Test Files  466 passed (466)          # 最后一个 exec 段自身小计
     Tests  7182 passed (7182)
EXIT_CODE=0
```
逐段小计相加(19 个 `Test Files`/`Tests` 汇总行,`awk` 机械求和):**568 个文件、9122 个用例全部 passed,零 failed**(`grep -c "^ FAIL\|✗\|×"` = 0,ANSI 转义已剥离后核对)。同 §4.2 理由,与 §1.5 历史值逐位一致。`stderr` 里出现的唯一一处 `[approval-detail] mark-read failed Error: network` 堆栈是 `approvalCenterUnreadBadge.spec.ts` 的一条**测试内故意构造的**异常("does not surface an error toast when mark-read rejects"),该文件本身 `✓ (8 tests)` 全绿,不是失败。

## 5. 分支保护 required contexts(现场重读,不沿用锁文引用的旧快照)

```
$ gh api repos/zensgit/metasheet2/branches/main/protection
```
`required_status_checks.strict = false`;`contexts`(13 个,逐字):`contracts (strict)`、`contracts (dashboard)`、`pr-validate`、`test (20.x)`、`contracts (openapi)`、`web-tests`、`stock-prep PowerShell 5.1 acceptance`、`attendance-web-guard`、`integration-guard`、`ssh host-key pin contract (fail-closed known_hosts)`、`observation-kit contract (read-only SQL census + runbook gating)`、`recovery-schema-drift`、`Approval browser verify (chromium)`。

与锁文引用的「2026-09-17 读取的分支保护 API 快照,13 个 required contexts」逐字一致(本次是 2026-09-18 现场重读,不是照抄锁文数字)——`test (20.x)` 与 `web-tests` 均在列,支持设计 MD/本文档对"后端真库行只能经 `test (20.x)`"的依赖。

## 6. CI 两点接线证据(grep 计数 + 机械核对,非肉眼读 diff)

### 6.1 `vitest.config.ts` exclude(四文件逐条核对)

```
$ node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { isQuotedInTestExclude } from './scripts/ops/ci-realdb-step-contract.mjs';
const cfg = readFileSync('packages/core-backend/vitest.config.ts', 'utf8');
for (const f of [
  'tests/integration/approval-template-groups-lifecycle.db.test.ts',
  'tests/integration/approval-template-groups-serialization.db.test.ts',
  'tests/integration/approval-template-groups-sections.db.test.ts',
  'tests/integration/approval-template-groups-reorder.db.test.ts',
]) { console.log(f, isQuotedInTestExclude(cfg, f)); }
"
```
四行输出全部 `true`(通过 `scripts/ops/approval-template-groups-ci-wiring.test.mjs` 的 12/12 全绿间接核实,见 §6.3——本节命令与该守卫内部调用的是同一个 `isQuotedInTestExclude` 函数)。

### 6.2 `plugin-tests.yml` 真库步骤 whole-file 参数(四文件 × 正负两格)

`isSuiteWiredInRealDbStep(wf, REAL_DB_STEP_IDS.approval, <file>)` 对四个文件均为 `true`;`isSuiteWiredInRealDbStep(wf, REAL_DB_STEP_IDS.multitable, <file>)` 对四个文件均为 `false`(负控——四文件均未被误接进 multitable 的真库步骤)。同样通过 §6.3 的 `node --test` 现场核实,不是肉眼读 YAML。

### 6.3 `scripts/ops/approval-template-groups-ci-wiring.test.mjs`(A-1 遗留闭世界缺口的收口,本切片新增)

```
$ node --test scripts/ops/approval-template-groups-ci-wiring.test.mjs
✔ vitest.config.ts excludes ... lifecycle.db.test.ts ...
✔ plugin-tests.yml runs ... lifecycle.db.test.ts ... approval real-DB step
✔ the wired suite ... lifecycle.db.test.ts ... exists on disk
(× 4 文件,3 项 = 12 项)
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

A-1 phase1-verification §5 曾披露:「目前没有任何已存在的 CI 守卫会在未来有人不慎从 `plugin-tests.yml`/`vitest.config.ts` 移除这两个文件的接线时报红——这是一个真实的、未收口的闭世界缺口」。本切片新增的这个文件把该缺口**收口**,且覆盖面是「四个文件」而不是只覆盖本切片新增的两个——理由(文件头注释,`:14-25`):缺口本身早于分期 3 存在,不特定于分期 3,不能只补新文件那一半。

### 6.4 全量兄弟 `*-ci-wiring` 回归(45 个家族文件,含本切片新增的第 46 个)

```
$ node --test scripts/ops/*-ci-wiring.test.mjs
```
本次(隔离执行,无并发资源争用)结果:

```
ℹ tests 488
ℹ pass 488
ℹ fail 0
```

`488 = 476(A-1 phase1-verification §5 记录的基线)+ 12`(本切片新增的 `approval-template-groups-ci-wiring.test.mjs` 恰好贡献 12 条),数字自洽。**首次尝试**(与另一条 grep 命令在同一条 bash 调用里连续执行、资源竞争下)复现了 A-1 verification §5 同一类环境瞬态:`b7-round2-ci-wiring.test.mjs` 的 `python3` 子进程 `spawnSync ETIMEDOUT`(与本次改动无关,该守卫本身在 §3 的 grep 命中里也没有出现在 `approval-template-groups` 相关文件列表)——单独隔离重跑后 488/488 全绿,与 A-1 verification §5 里 `elearning-v01-auth-ci-wiring.test.mjs` 的同一类"并发抢 python3 子进程导致超时,单独重跑即通过"的模式相同,不是本次改动引入的回归。

### 6.5 s6a sha256 重钉时效性(本次重读,不假设起草时的值到现在仍然有效)

```
$ node -e "
const m = require('./plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs');
const pins = m.computePackageProvenancePinSet(process.cwd());
const staged = require('./plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json');
console.log('computed:', pins.evidenceFiles.pluginTestsWorkflow);
console.log('match:', pins.evidenceFiles.pluginTestsWorkflow === staged.evidenceFiles.pluginTestsWorkflow);
"
computed: c63eeb5bfabc0aaf74552be66fe8fd7e744e1fcdfcc78dafd45ed1a59a2ee6f4
match: true
```
**时效性披露(与 A-1 phase1-verification §4 同一句提醒)**:此值只对**本 worktree HEAD 当前的 `plugin-tests.yml` 字节**成立。若在本 Draft PR 合并之前 main 上有任何其他 PR(哪怕与本线无关)先改动了 `plugin-tests.yml`,这枚 sha256 钉会失效,必须在**准备合并前**重新跑上面这条命令再核一次。

### 6.6 `run-required-web-tests.sh` 新令牌子串碰撞检查(补充清单 #5 引用的两点纪律)

```
$ find apps/web -iname "*approvalTemplateCenterSections*"
apps/web/tests/approvalTemplateCenterSections.spec.ts        # 唯一文件

$ grep -o "approvalTemplateCenterSections" apps/web/scripts/run-required-web-tests.sh | wc -l
1                                                              # 脚本里恰好一处
```
新 token `approvalTemplateCenterSections` 与既有 token `approvalTemplateCenterCategory` 互不为子串,vitest 的子串匹配不会把两者混为一谈(两者共享前缀 `approvalTemplateCenter` 但后半截不同,不构成 vitest CLI 参数级别的子串碰撞)。

## 7. Mutation 台账(cp 备份 → 改 → 跑受影响用例 → 还原 → `cmp` 校验;仅报告本次会话内实际执行的探针,未执行的如实标注 NOT RUN)

| # | 目标文件 | 探针 | 命令与结果(节选) | 还原校验 |
|---|---|---|---|---|
| 1 | `ApprovalTemplateGroupSectionService.ts:149` | 删除 `buildSectionBucketCondition(...)` 调用,WHERE 条件替换为字面量 `'TRUE'` | 重跑 `approval-template-groups-sections.db.test.ts`:`4 failed \| 1 passed (5)`——「C 四桶」「D 后备」「C 分页」「C/J 400 正控格」全部转红(`TypeError: Cannot read properties of undefined`/`expected 500 to be 200`),仅 §4 C 的一条 400 反例格未受影响,与探针性质一致(去掉桶过滤只影响返回内容,不影响请求形状校验) | `cp` 恢复后 `cmp` 逐字节相同;恢复后重跑 4 文件 39/39 全绿 |
| 2 | `ApprovalTemplateGroupSectionService.ts:108` | 删除 `ungrouped` 分支里 `OR t.category = ''` 半句(改成只判 `IS NULL`) | 重跑同文件:`1 failed \| 4 passed (5)`——**恰好**且**只有**「C: three tokens / four buckets」转红,断言`expected […] to include '<t4-id>'` 失败(`category=''` 的模板未落入 `ungrouped`)——与 v2.6 P2-A 的判别力描述完全吻合,不是笼统的"大面积变红" | `cp` 恢复后 `cmp` 逐字节相同;恢复后重跑 4 文件 39/39 全绿 |
| 3 | `ApprovalTemplateGroupReorderService.ts:118` | 删除 `SELECT pg_advisory_xact_lock(...)`(L0 顾问锁) | 单独重跑该文件的并发用例(`-t "two concurrent reorders"`):`1 failed \| 4 skipped`,断言 `Error: timed out waiting for backend blocked by holder pid ... (never engaged the production lock — race golden would be vacuous)`——是一次响亮的红(硬失败 + 明确诊断信息),不是静默通过,与文件头注释「the concurrent test's `waitUntilBackendBlockedByHolder` call times out (a hard failure, not a silent pass)」逐字吻合 | `cp` 恢复后 `cmp` 逐字节相同;恢复后重跑 4 文件 39/39 全绿 |
| 4 | `ApprovalTemplateGroupReorderService.ts:120`(`archived_at IS NULL` 半句) | **NOT RUN(本次会话)**——`approval-template-groups-reorder.db.test.ts` 文件头注释自陈「VERIFIED (2026-09-18, cp → edit → re-run → restore → cmp byte-identical)」,即这条探针已由**实现阶段**的会话执行并记录在源码注释里;本次验证 MD 撰写会话未独立重跑这一条,如实标注为「文档来源于源码注释的既有记录,未在本轮独立复核」而非「本轮验证」 | — |
| 5 | `ApprovalTemplateGroupSectionService.ts`(路由层 `total`/`LIMIT`/`OFFSET` 组合) | **NOT RUN(本次会话)**——时间预算内选择了判别力最强的 3 条(桶谓词整体移除、`OR ''` 单独移除、L0 移除),分页字段组合改动留待下一轮门审或 owner 要求时补做 | — |
| 6 | `ApprovalTemplateGroupReorderService.ts`(`ORDER BY id` … `index+1` off-by-one) | **NOT RUN(本次会话)**——同上,时间预算内的取舍,`validateApprovalTemplateGroupReorderIds` 的 7 条单元测试与「happy path」端到端用例的精确 `{id, sortOrder}` 断言已经是这条 off-by-one 的静态判别力来源,但未真正跑一遍改坏版本观察红 | — |

**两个纯函数单元测试文件**(`approval-template-group-section-token.test.ts`、`approval-template-group-reorder-validation.test.ts`)本身就是穷举式正/反例(13 条 + 7 条),其判别力来自枚举覆盖而非事后 mutation,未对它们额外做源码级 mutation。

## 8. 撤销/重数脚本 —— 并入本文档之后的重跑(替换 §1.4 的旧行号锚点)

`rebase-note` 文件已删除,其自身的两处历史命中(旧 `:33`/`:61`)不再存在于 diff 面里。按 `atg-retraction-sweep.sh` 自身「任何进一步编辑后重跑」的要求,在本次删除+新增两份 MD 的提交之后重跑:

```
$ bash scripts/dev/atg-retraction-sweep.sh
$ echo "EXIT=$?"
EXIT=0
```

**实测结果(而非预判)**:两份新文档的扫描范围命中(`git diff --name-only origin/main..HEAD` 的文件清单)只有**本验证 MD**(`approval-template-groups-phase3-sections-verification-20260918.md`)本身携带模式命中——正文 §1 并入的原 rebase-note 内容原样保留了它自己的两处历史命中(压缩叙事「guard⊆manager → guard⊋manager → 互不包含」、逐字引用脚本模式列表的元描述),行号从旧文件的 `:33`/`:61` 变为本文档现在的 `:50`/`:78`(后者在文档内被引用了多次,`grep -c` 命中即为引用次数,非独立命中数);§1.4 段落自身的转述文字(`:84`)与 §8 本段(`:330` 附近)作为**对这两处历史命中的再次转述**,同样落入否定式/元描述分类,不构成新增的现在时包含断言。**设计 MD 在这些模式上零命中**(它引用 A-1 锁文的 I2′/DEFERRABLE 条款用的是「NOT EXISTS」「DEFERRABLE」等词,不落在 `⊆/⊇/⊂/⊃/⊋/⊊/子集/超集/严格超集/subset/superset/无法制造/通配权限码` 这组扫描模式里),之前一版草稿在此处的表述("设计 MD §2.2……引用了……"暗示设计 MD 也会命中)与实测不符,已按实测更正。`routes/approvals.ts:406-440` 的三层递进撤回内容本次会话未改动,继续原样成立,`packages/core-backend/src/routes/approvals.ts` 的命中(`:406`/`:408`/`:434`/`:1781`/`:2304`)均是 A-1 遗留的历史叙事/元描述,不属于本切片新增。

`scripts/dev/atg-verification-recount.sh` 本次重跑,退出码 0,计数与 A-1 verification §14/§24.5 记录的数字一致——本切片未新增任何 4xx/500 状态码断言或错误码断言到那两个文件(lifecycle/serialization 属 A-1,A-4 的断言全部落在新文件 `sections`/`reorder` 里,不在这个脚本的扫描范围内)。

## 9. 补充清单逐条核对(`impl-supplementary-gate-checklist-20260918.md`,17 项全部,含 lane B/C 的 N/A)

| # | 内容 | 适用 lane | 本切片核对结果 |
|---|---|---|---|
| 1 | 新 `.db.test.ts` 必须逐个普查进 `*-ci-wiring` 闭世界,不能只「如果存在」 | 三 lane 共用 | **已收口**——`approval-template-groups-ci-wiring.test.mjs` 覆盖全部四个文件(含 A-1 遗留的两个),§6.3/§6.4 |
| 2 | `vitest.config.ts:42-45` 在地惯例是"NOT plugin-tests.yml",本锁裁定覆盖,PR body 要写明理由 | 同上 | **已写明**——`vitest.config.ts` 两处新增注释逐字给出覆盖理由(见 diff),设计 MD §1.1 亦记录 |
| 3 | `plugin-tests.yml` 的 s6a 重钉需安静窗口 | 同上 | **已重算**,§6.5;时效性披露已写 |
| 4 | 错误码不得降级成裸 HTTP 状态 | 同上 | **已核**——`APPROVAL_TEMPLATE_SECTION_CATEGORY_CONFLICT`/`APPROVAL_TEMPLATE_SECTION_TOKEN_INVALID`/`GROUP_REORDER_IDS_REQUIRED`/`GROUP_REORDER_SET_MISMATCH`/`GROUP_SORT_CONFLICT` 均在测试里断言 `.error.code`,非仅断言 `.status` |
| 5 | J 行「未知 section 令牌⇒400」+ C 行「category 与 section 同现⇒400」挪分期 3 | lane A | **本切片落地**,设计 MD §2.4、测试见 `C/J: malformed section requests` 用例 |
| 6 | 分期门「1 落地」求值为「Draft PR 过门审」 | lane A | **已按此口径执行**——本切片开工前提是 A-1 Draft PR #5852 第 7 轮门审 DRAFT-READY(`a728ed655`),非"已合并" |
| 7 | 前端 spec 必须放 `apps/web/tests/`,不是 `src/**/__tests__/` | lane A | **已核**——`approvalTemplateCenterSections.spec.ts`/`approvalTemplateCenterCategory.spec.ts`/`approval-member-identity-coverage-enumeration.spec.ts` 均在 `apps/web/tests/` |
| 8 | 独立 vitest project 的 gate 必须断言 `NODE_ENV` | lane B(待办中心) | **N/A**——本切片不涉及独立 vitest project |
| 9 | `MIGRATION_EXCLUDE` 显式复制进新 lane env;命名避开 `*.db.test.ts` exclude | lane B | **N/A**——本切片无新 lane env,四个真库文件本就是 `*.db.test.ts` 命名,依赖既有 exclude 机制,不是要避开它 |
| 10 | `validate-migration-exclude.sh` 是 WARN-ONLY,不能当门 | lane B | **N/A**——本切片未依赖该脚本作为门 |
| 11 | 判据 E(代数守卫)属前端切片 2,首切片写"未做" | lane B | **N/A**——本条是待办中心线自己的判据编号 E,与本锁(分组)§4 判据 E 是同名不同物,不适用本切片 |
| 12 | A0 前两行复用既有 realdb lane,不是新 lane | lane B | **N/A** |
| 13 | W7-R10 分类钉按目录 root 归属推断,不用文件基名 grep | lane C(撤销) | **N/A**——本切片不touch `plugin-attendance` |
| 14 | 考勤四道普查钉(s6a/W7-R10/CI corpus/DML 表分类) | lane C | **N/A**——本切片零新表、零 `plugin-attendance/index.cjs` 改动 |
| 15 | FE 同步钉须读后端源码而非手抄字面量数组 | lane C | **N/A** |
| 16 | 锁 §5 I6「撤销不限次」验收 | lane C | **N/A** |
| 17 | 锁 §14.1/§14.3/§2-G2 的逐字钉与 mutation | lane C | **N/A** |

**DML 表分类闸自查(任务书 §5 风险清单点名的通用自查项,非本锁强制门)**:本切片零新迁移文件、零新表(复用 A-1 已建的 `approval_template_groups`/`approval_template_group_links`),故不触发"新表登记"这条自查——A-1 phase1-verification 已对这两张表本身做过该项自查,本切片不重复。

## 10. 未做 / 未验(如实列出,与设计 MD §6 对应)

- **两个写入面换分组选择器(I4)**——未做,原因见设计 MD §1.2/§6。
- **A-2 session-org 脱困入口未接入 `section=` 端点**——新披露的缺口,见设计 MD §6;本切片未修复,归入 owner 待裁的关联事实。
- **Q5(`?category=`/`/categories` 去留)**——未裁,本切片按锁文字面"不动",但新增了一个具体的新消费方披露(设计 MD §7)。
- **Mutation 台账 4/5/6 三条**——见 §7,NOT RUN,理由已写明(#4 是既有记录未独立复核;#5/#6 是本次会话的时间预算取舍)。
- **移动/重排控件的客户端权限门控**——未做,依赖路由层 fail-closed,设计 MD §5.4 已写明是有意选择。
- **前端两次 `section=` 请求之间的跨时刻一致性**——不作承诺,锁文原文明写,非本切片缺陷。
