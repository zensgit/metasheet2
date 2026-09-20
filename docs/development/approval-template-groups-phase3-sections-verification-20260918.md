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

## 7. Mutation 台账(2026-09-18 修复轮 1 全量重写——并入门审 `impl-gate-A4-round1-20260918.md` 的 11 条台账,替换本节此前的 3 RUN / 3 NOT RUN;M10/M11 的「绿」原样保留,不因后续修复而抹去)

**来源分工**:M1–M9 由门审报告 `impl-gate-A4-round1-20260918.md` §4 的门审者本人亲跑(`cp` 备份 → 改 → 跑 → 还原 → `cmp`),本文档按门审报告逐字转录,未在本轮修复会话中重跑(时间预算内不重复门审已完成的工作)。M10/M11 的**上半行**(green,即 P2-2/P2-1 的原始发现)同样来自门审报告。M10/M11 的**下半行**(修复后重跑同一探针转红)是本轮修复(round 1,2026-09-18)在私有库 `metasheet2_lock_a4` 上亲跑的——这是本节相对旧版最实质的更新。

| # | 目标文件 | 探针 | 结果 | 还原校验 | 出处 |
|---|---|---|---|---|---|
| M1 | `routes/approvals.ts` | 删未知 `section=` 令牌的 400,改为静默下沉 | **红**,恰 1 条:`C/J: malformed section requests…` `expected 200 to be 400` | `cmp` 逐字节相同 | 门审报告 §4 |
| M2 | `ApprovalTemplateGroupSectionService.ts` `buildSectionBucketCondition` | 删 `ungrouped` 桶的 `OR t.category = ''` 半句 | **红**,恰 1 条:`C: three tokens / four buckets…` `expected […] to include '<t4>'` | `cmp` 逐字节相同 | 门审报告 §4 |
| M3 | 同上 | 每节 `total` 改由返回页拼(`result.rows.length`,**后端**) | **红**,恰 1 条:`C: pagination is scoped to the section…` `expected 1 to be 5` | `cmp` 逐字节相同 | 门审报告 §4 |
| M4 | `ApprovalTemplateGroupReorderService.ts` | 删 `pg_advisory_xact_lock`(L0) | **红**:`E (phase 3): two concurrent reorders…` — `waitUntilBackendBlockedByHolder` 超时硬失败(「never engaged the production lock」) | `cmp` 逐字节相同 | 门审报告 §4 |
| M5 | DB 约束 | `atg_sort_unique` drop + 重建为 **NOT DEFERRABLE** | **红** 2 条:happy path 与并发格双双 `expected 500 to be 200` | 约束改回 `DEFERRABLE INITIALLY DEFERRED`,`pg_constraint` 复核 `condeferrable=t, condeferred=t` | 门审报告 §4 |
| M6 | `ApprovalTemplateGroupReorderService.ts` | 删 `activeRows` 查询的 `archived_at IS NULL` 半句 | **红**,恰 1 条:`400 GROUP_REORDER_SET_MISMATCH…archived…` `expected 500 to be 400` | `cmp` 逐字节相同 | 门审报告 §4 |
| M7 | `routes/approvals.ts` | 删 `?category=` 与 `section` 同现的 400 | **红**,恰 1 条:`C/J: malformed section requests…` `expected 200 to be 400` | `cmp` 逐字节相同 | 门审报告 §4 |
| M8 | `ApprovalTemplateGroupReorderService.ts` | off-by-one(`sortOrder = index` 而非 `index + 1`) | **红** 2 条:happy path 的 `{id,sortOrder}` 深比较 + 并发格 `expected [1,2,3] 类` 不等 | `cmp` 逐字节相同 | 门审报告 §4 |
| M9 | `.github/workflows/plugin-tests.yml` | 从真库步骤 FILES 里删掉 `…-reorder.db.test.ts` | **红**:`approval-template-groups-ci-wiring.test.mjs` `pass 11 / fail 1`,退出码 1 | `cmp` 逐字节相同 | 门审报告 §4 |
| **M10(修复前)** | `TemplateGroupSections.vue:307` | 每节 `total` 改由客户端拼(`res.data.length`,**前端**) | **绿 18/18 —— 判别力为零 ⇒ P2-2**(原夹具 `{data:[1行], total:1}` 让两种实现观测等价) | `cmp` 逐字节相同 | 门审报告 §4(**原样保留,不因下一行的修复而删除或改写**) |
| **M10(修复后,本轮 2026-09-18 亲跑)** | 同上,夹具已改为 `{data:[1行], total:7}` | 同一处 mutation(`total: res.data.length`)**重新施加**在修复后的 `approvalTemplateCenterSections.spec.ts` 上 | **红**,恰 1 条:「renders per-section items and the section-own total…」`expected '1' to be '7'`;其余 17 条(含相邻的「shows "load more"…」)不受影响,与门审报告 §2 P2-2 对 `hasMore` 计算路径的分析一致 | `cp` 恢复 `TemplateGroupSections.vue` 后 `cmp` 逐字节相同;恢复后重跑 18/18 全绿 | 本轮修复(round 1) |
| **M11(修复前)** | `routes/approvals.ts:1288` | 删 reorder 路由的 `approvalTemplateAdminGuard` | **全绿**(39/39 真库四文件 + 933/14737 全量无库 + 两个 ops 守卫)⇒ **P2-1**(仓内零断言覆盖该端点授权面) | `cmp` 逐字节相同 | 门审报告 §4(**原样保留**) |
| **M11(修复后,本轮 2026-09-18 亲跑)** | 同上 | 同一处 mutation(删 guard)**重新施加**,针对新增的 `approval-template-groups-reorder.db.test.ts` 授权用例 | **红**,恰 1 条:「authorization: reorder requires approvalTemplateAdminGuard…」`expected 200 to be 403`;文件其余 5 条不受影响 | `cp` 恢复 `routes/approvals.ts` 后 `cmp` 逐字节相同;恢复后重跑 6/6 全绿(私有库 `metasheet2_lock_a4`) | 本轮修复(round 1) |

任务书点名的三条必跑 mutation **全部覆盖**:DEFERRABLE 依赖 = **M5**(红);删 section 令牌校验 = **M1**(红);分页 total 改由客户端拼 = **M3**(后端,红)+ **M10**(前端,修复前**绿** = P2-2,修复后**红**)。

**两个纯函数单元测试文件**(`approval-template-group-section-token.test.ts`、`approval-template-group-reorder-validation.test.ts`)本身就是穷举式正/反例(13 条 + 7 条),其判别力来自枚举覆盖而非事后 mutation,未对它们额外做源码级 mutation。

### 7.1 Round-2 门审的独立 12 条 mutation 台账(`impl-gate-A4-round2-20260918.md` §3,round-2 门审者亲跑,本轮 P3 卫生轮未重跑)

round-2 门审对本切片跑了一轮**独立于**上面 §7 表(round-1 台账,M1–M11)的 12 条 mutation,命名 `MD1`–`MD12`(与上表 M1–M11 是**两套独立编号**,不要按数字对齐合并——例如 `MD6` 与 `M3` 都是"每节 total 改由后端返回页拼"同一处探针,由两个不同的人在两次不同的轮次各自亲跑,结果一致但不是同一条记录)。round-2 门审要求「第 3 轮的第一件事就是 commit 这份 MD 并把本轮 12 条台账一并并入」——本节即完成这项要求。**出处**:全部 12 条转录自门审报告本身,round-2 门审者亲自 `cp` 备份 → 改 → 跑 → 还原 → `cmp` 逐字节校验;本 P3 卫生轮(2026-09-19)只转录、未重跑这 12 条(时间预算内不重复门审已完成的工作,同 §7 对 round-1 M1–M9 的处理方式)。

| # | 目标 | 探针 | 结果 | 还原 |
|---|---|---|---|---|
| MD1 | `TemplateGroupSections.vue:307` | 每节 `total` 改由客户端拼(`res.data.length`) | **红**,恰 1 条:`renders per-section items and the section-own total…` `expected '1' to be '7'`(17 条兄弟全绿)⇒ **P2-2 已闭合** | `cmp` 逐字节相同 |
| MD1b | 同上 | 同一 mutation 下跑整条 required 前端门(`run-required-web-tests.sh`) | **`WEB_EXIT=1`**,`Tests 1 failed \| 7181 passed (7182)`,`FAIL tests/approvalTemplateCenterSections.spec.ts` ⇒ required 车道真的收住了这条修复 | 同上 |
| MD2 | `routes/approvals.ts:1288` | **删**reorder 路由的 `approvalTemplateAdminGuard` | **红**,恰 1 条:`authorization: reorder requires approvalTemplateAdminGuard…` `expected 200 to be 403` ⇒ **P2-1 已闭合** | `cmp` 逐字节相同 |
| MD3 | 同上 | **换**成 `rbacGuard('approvals:read')`(不是删) | **绿 6/6 —— 判别力为零** ⇒ round-2 gate P3-2(锁未点名的残留)——**本轮(2026-09-19)已闭合,见 §14** | `cmp` 逐字节相同 |
| MD4 | `routes/approvals.ts:663-667` | 删未知 `section=` 令牌的 400,改为静默下沉 | **红**,恰 1 条:`C/J: malformed section requests…` `expected 200 to be 400` | `cmp` 逐字节相同 |
| MD5 | `routes/approvals.ts:649-656` | 删 `?category=` 与 `section` 同现的 400 | **红**,恰 1 条:同上用例 `expected 200 to be 400` | `cmp` 逐字节相同 |
| MD6 | `ApprovalTemplateGroupSectionService.ts:182` | 每节 `total` 改由返回页拼(`result.rows.length`,后端) | **红**,恰 1 条:`C: pagination is scoped to the section…` `expected 1 to be 5` | `cmp` 逐字节相同 |
| MD7 | DB 约束 | `atg_sort_unique` drop + 重建为 **NOT DEFERRABLE** | **红 3 条**:happy path / 授权用例的管理员正控腿 / 并发格,全部 `expected 500 to be 200` | 约束改回 `DEFERRABLE INITIALLY DEFERRED`,`pg_constraint` 复核 |
| MD8 | `ApprovalTemplateGroupReorderService.ts:118` | 删 `SELECT pg_advisory_xact_lock`(L0) | **红**:`waitUntilBackendBlockedByHolder` 超时硬失败,不是静默通过 | `cmp` 逐字节相同 |
| MD9 | 同上 `:130` | off-by-one(`sortOrder = index` 而非 `index + 1`) | **红 3 条**:happy path 深比较、授权用例、并发格 | `cmp` 逐字节相同 |
| MD10 | 同上 `:120` | 删 `activeRows` 查询的 `archived_at IS NULL` 半句 | **红**,恰 1 条:`400 GROUP_REORDER_SET_MISMATCH…` `expected 500 to be 400` | `cmp` 逐字节相同 |
| MD11 | `…SectionService.ts:108` | 删 `ungrouped` 桶的 `OR t.category = ''` 半句 | **红**,恰 1 条:四桶 ④ | `cmp` 逐字节相同 |
| MD12 | `…SectionService.ts:117-121` | 锁 §4 行 D 自己点名的 B′ 形态:`NOT EXISTS(…AND l.group_id IS NOT NULL)` | **红**,恰 1 条:行 D 的后备谓词承重(round-1 门审对行 D 的判定是**推断**,MD12 是本轮相对 round-1 的增量,把它真的跑出来了) | `cmp` 逐字节相同 |

任务书点名的三条必跑 mutation round-2 也全部覆盖且全部红:DEFERRABLE 依赖 = MD7;删 section 令牌校验 = MD4;分页 total 改由客户端拼 = MD6(后端)+ MD1(前端)。

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
- **移动/重排控件的客户端权限门控**——未做,依赖路由层 fail-closed,设计 MD §5.4 已写明是有意选择。
- **前端两次 `section=` 请求之间的跨时刻一致性**——不作承诺,锁文原文明写,非本切片缺陷。
- **门审 P2-1/P2-2**——已在修复轮 1(2026-09-18)修复并亲跑 mutation 转红,见 §11;§7 的 M1–M9 转录自门审报告未在本轮独立重跑(时间预算内不重复门审已完成的工作),如 owner 或下一轮门审要求可补做。
- **门审 P3-1…P3-6(六条)**——本轮修复未处理(修复轮任务书要求「选尚未处理的一到三条」,本轮选择处理 P2-1/P2-2 两条,P3 六条留待后续轮次或 owner 裁决是否需要);逐条内容见 `impl-gate-A4-round1-20260918.md` §3。

## 11. 修复轮 1(2026-09-18)——P2-1 / P2-2 收敛

门审 `impl-gate-A4-round1-20260918.md`(verdict NEEDS-FIX,0 P1 / 2 P2 / 6 P3,绑定 head `2a687c7d1`)点名两条 P2,本轮全部处理。**本节与 §12 的全部测量均针对测试提交 `e214184afdd329ab9a80a24bb956e282dc9df3dd`(`test(approval): close P2-1/P2-2 gaps from A-4 round-1 gate`,分支头,先于本文档提交)——本文档自身不能引用自己所在的提交 SHA,故引用它所修复的那个代码提交**。

### 11.1 P2-1 —— `POST /api/approval-template-groups/reorder` 授权面补测

**门审发现**:该端点是本切片唯一新写端点,锁 §3 I7 与 §4 行 F 都点名它必须挂 `approvalTemplateAdminGuard`,但仓内没有任何断言能分辨这个端点有没有挂该 guard(门审 M11:删掉 guard 后四个真库套件 39/39、全量无库套件 933/14737、两个 ops 守卫**全部照常绿**)。

**修复**:在 `packages/core-backend/tests/integration/approval-template-groups-reorder.db.test.ts` 新增一格 `authorization: reorder requires approvalTemplateAdminGuard …`——`roles:'user'` + 无关权限 `multitable:read`(同 phase-1 lifecycle 文件行 F 的 actor 形状)发 reorder ⇒ 断言 **403** 且 `sort_order` 零变化(SELECT 现场核对);正控 = 同一 body 用 `roles:'admin', perms:'*:*'` 的 token ⇒ **200** 且排列生效。

**判别力修正(草稿版 → 最终版)**:草稿版只断言 `.status.toBe(403)`。§9 表第 4 行点名本切片「错误码不得降级成裸 HTTP 状态」,而裸 `403` 本身分不清「guard 自己拒绝」与「guard 通过了、是下游 `resolveApprovalTemplateGroupOrgId` 返回的 403」(门审 P3-5 点名过后者存在,形状是 `{ok:false,error:{code:'SESSION_ORG_REQUIRED',...}}`)。最终版加了一行判别式断言:`expect((await asNobody.json()).error).toBe('Insufficient permissions')`——这是 `rbacGuardAny` 自己的拒绝体(`rbac/rbac.ts:174` 一行 `res.status(403).json({ error: 'Insufficient permissions' })`,裸字符串,无 `code` 字段),与 phase-1 lifecycle 文件 `§2(d)` 用例用的同一个判别式(见该文件 `:759-761` 的头注释)。这条断言把「本用例证明的是 guard 本身」与「本用例只是恰好也观测到 403」这两件不同的事分开。

**本轮亲跑验证**(私有库 `metasheet2_lock_a4`,`DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a4 EXPECT_DB=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/approval-template-groups-reorder.db.test.ts`),均针对加了判别式断言之后的**最终版**测试文件跑:

1. 修复后现状:**6/6 全绿**(含新用例,含判别式断言)。
2. **证明旧实现会红**(`cp` 备份 `routes/approvals.ts` → 删 `:1288` 行的 `approvalTemplateAdminGuard` → 跑 → 还原):新用例**单独转红**(在 `.status` 那一行就先失败:`expected 200 to be 403`,判别式断言那行未执行到),其余 5 条不受影响——`cp` 恢复后 `cmp` 逐字节相同,恢复后重跑 6/6 全绿。见 §7 表 M11(修复后)行。
3. **四文件合并重跑**(lifecycle + serialization + sections + reorder,同一私有库):`4 passed (4)` / `40 passed (40)`——40 = 门审报告记录的 39 + 本轮新增的 1 条,其余三个文件零改动,数字对得上(见 §12)。两个 CI 闭世界 ops 守卫(`approval-template-groups-ci-wiring.test.mjs`/`approval-data-closure-ci-wiring.test.mjs`)各 12/12,无回归。

### 11.2 P2-2 —— 前端「每节 total 由服务端给」用例判别力归零的修复

**门审发现**:唯一对口的前端用例 `renders per-section items and the section-own total (not a client-reconstructed count)` 的夹具是 `{data:[1行], total:1}`,`total === data.length`(1===1)让「服务端给」与「客户端拼」两种实现观测等价——门审 M10:把 `TemplateGroupSections.vue:307` 的 `total: res.total` 改成 `total: res.data.length`(客户端拼),该用例连同其余 17 条**全绿**,判别力为零。

**修复**:把 `apps/web/tests/approvalTemplateCenterSections.spec.ts` 里这条用例的夹具改为 `{data:[1行], total:7}`(第 1 页只有 1 行,还有 6 行在后续页,`total ≠ data.length`),并把徽标断言从 `toBe('1')` 改为 `toBe('7')`。

**本轮亲跑验证**(`cd apps/web && npx vitest run tests/approvalTemplateCenterSections.spec.ts`):

1. 修复后现状:**18/18 全绿**。
2. **证明旧实现会红**(`cp` 备份 `TemplateGroupSections.vue` → 把 `:307` 的 `total: res.total` 改成 `total: res.data.length` → 跑 → 还原):目标用例**单独转红**(`expected '1' to be '7'`),其余 17 条(含门审报告 §2 点名"接不住"的 `shows "load more"…`)不受影响,与门审对 `hasMore` 计算路径读取时机的分析吻合——`cp` 恢复后 `cmp` 逐字节相同,恢复后重跑 18/18 全绿。见 §7 表 M10(修复后)行。

### 11.3 三条 required 重跑(改动落在 `apps/web/tests/**` 与 `packages/core-backend/tests/**`,两条会动)

见 §12(本节新增,紧接本节之后)。

### 11.4 收敛清单核对(对照门审 §10)

| 门审 §10 要求 | 本轮处置 |
|---|---|
| 1. 两条都要亲跑旧实现证明会红 | ✅ 见上 §11.1/§11.2,均单独转红、其余用例不受影响 |
| 2. 把 11 条 mutation 台账并进验证 MD §7,M10 的绿原样写进去 | ✅ 见 §7,M10(修复前)绿行原样保留,新增 M10/M11(修复后)行 |
| 3. 重跑三条 required | ✅ 见 §12 |
| 4. 不需要重算 s6a | ✅ 本轮零改动 `plugin-tests.yml` |
| 5. 开第 2 轮门审 | 待下一步(本轮修复完成后由后续门审轮次执行) |

## 12. 三条 required —— 修复轮 1 重跑(本次;数字与 §4 逐位相同,是复现确认,不是替换——§4 的数字没有被推翻,下表只是本轮独立重跑同一套命令后的观测)

修复只改了 `apps/web/tests/approvalTemplateCenterSections.spec.ts` 与 `packages/core-backend/tests/integration/approval-template-groups-reorder.db.test.ts` 两个测试文件——不改产品源码——所以三条 required 预期零回归;实测如下(worktree `wt-groups-p3`,分支 `feat/approval-template-groups-phase3-sections`)。

| 命令 | 结果 | 与门审报告 §8 / §4 旧值对比 |
|---|---|---|
| `pnpm type-check` | `EXIT=0`,`packages/core-backend: Done` / `apps/web: Done`(含 `type-check:verification-approval`/`type-check:verification-stock-prep` 两个附属 project) | 与门审报告一致(`EXIT=0`,零报错) |
| `CI=true pnpm --filter @metasheet/core-backend test`(全量,无库) | `Test Files 933 passed \| 175 skipped (1108)` / `Tests 14737 passed \| 1604 skipped (16341)`,`EXIT=0` | **逐位相同**——**机制更正(2026-09-19 P3 卫生轮,round-2 门审 P3-1 第 2 点)**:这条数字不动,原因不是 `describeIfDatabase`/`describe.skip`;真正的机制是 `packages/core-backend/vitest.config.ts` 把四个 `approval-template-groups-*.db.test.ts` 整文件排除在这条无库套件的收集面之外——文件根本没被收集,新用例连带整个文件都不参与这次统计。判别式:若真的只靠 `describe.skip`(文件被收集、只是内部整块跳过),新增的这条授权用例会让 `skipped` 从 1604 涨到 1605、`total` 从 16341 涨到 16342(`describe.skip` 仍然收集并计数跳过的用例);实测两个数字都未变,说明文件确实未进入收集面,不是「收集了但跳过」 |
| `bash -e apps/web/scripts/run-required-web-tests.sh` | `WEB_EXIT=0`;剥 ANSI 后机械求和(`grep "Test Files"`/`grep "Tests "` 逐段求和,`grep -c "^ FAIL"`)**19 段 / 568 files / 9122 tests 全 passed**,`^ FAIL` 计数 = **0** | **逐位相同**——修复只改了这条被 required 收的 `approvalTemplateCenterSections` token 命中的那一个文件内部的断言/夹具,文件数与用例数不变(仍是 1 个文件、18 条用例),只是其中一条用例的期望值从 `'1'` 改成了 `'7'` |

另单独重跑两个改动文件本身(见 §11.1/§11.2):`approval-template-groups-reorder.db.test.ts` 私有库 `metasheet2_lock_a4` 上 **6/6**;`approvalTemplateCenterSections.spec.ts` **18/18**。

**四个真库套件合并重跑(本轮,替换 §2.3 的 `4 passed (4)` / `39 passed (39)` 这条现状数字——§2.3 本身作为"rebase 后、本轮修复前"的历史记录原样保留,不删改,此处只是给出修复后的当前值)**:

```
$ DATABASE_URL="postgresql://postgres@localhost:5432/metasheet2_lock_a4" EXPECT_DB=1 \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-lifecycle.db.test.ts \
  tests/integration/approval-template-groups-serialization.db.test.ts \
  tests/integration/approval-template-groups-sections.db.test.ts \
  tests/integration/approval-template-groups-reorder.db.test.ts --reporter=dot

Test Files  4 passed (4)
     Tests  40 passed (40)
```

40 = 39(§2.3 的旧计数)+ 1(本轮新增的 reorder 授权用例)——四个文件里除 `reorder.db.test.ts` 外零改动,数字对得上。另单独重跑两个 CI 闭世界 ops 守卫(`approval-template-groups-ci-wiring.test.mjs` / `approval-data-closure-ci-wiring.test.mjs`),各 **12/12 pass**,无回归。

## 13. 开 PR 前 required 复现(2026-09-18,处女库 `metasheet2_a4_ci`,worktree `wt-groups-p3`,HEAD `bdcdfebc4`)

前置:`git fetch origin feat/approval-template-groups-phase3-sections` 后本地 HEAD `bdcdfebc4` 与 `origin/…` 逐字相同;`git status --porcelain` 空;`git merge-base --is-ancestor origin/main HEAD` 为真(`origin/main` 当前尖 `bb77ca5f2` 已在本分支祖先链内,即"已 rebase"仍成立)。`df -h /` 起始 5.9-6.3Gi 可用,全程未逼近 3G 阈值。

环境勘误:worktree 默认 `node -v` 是 v25.9.0(非 CI 的 20.x),且 `packages/core-backend`/`apps/web` 的 `node_modules` 缺 `typescript`/`vue-tsc` 二进制(`MODULE_NOT_FOUND`)——这不是本分支的改动(`pnpm-lock.yaml`/`package.json` 未出现在 `git diff origin/main...HEAD --stat` 里),是这个 worktree 从未在 node 20 下完整装过。用 `nvm use 20.20.2`(与 CI `node-version: 20.x` 同大版本)+ `pnpm install --frozen-lockfile`(锁文件零改动,纯修复安装,未碰产品代码)后四条方可执行;修复后 `pnpm -v` = 10.16.1,与 `web-tests.yml`/`plugin-tests.yml` 里 `pnpm/action-setup@v4` 钉的 `version: 10.16.1` 逐位相同。

① `pnpm type-check` — `packages/core-backend type-check: Done`,`apps/web type-check: Done`(含 `type-check:verification-approval`/`type-check:verification-stock-prep` 附属 project),`EXIT=0`。

② `CI=true pnpm --filter @metasheet/core-backend test`(全量,无库)—— `Test Files 947 passed | 175 skipped (1122)` / `Tests 15017 passed | 1609 skipped (16626)`,`EXIT=0`,`grep -c "^ FAIL"` = 0(命中的三行 `FAIL` 字样均是测试用例描述文本的一部分,该三条本身都是 `✓`)。与 §12 的历史值(933/1108、14737/16341)不逐位相同,差值 = +14 files / +280 tests(passed 侧)。机械核对而非推断:§12 的测量头 `6e2e48a7c` 当前**不是** `HEAD`(`bdcdfebc4`)也**不是** `origin/main` 的祖先(`git merge-base --is-ancestor` 两个方向都为假)——说明本分支在 §12 之后又经历过一次 rebase,`6e2e48a7c` 这条历史记录点已被替换;`git ls-tree -r 6e2e48a7c -- packages/core-backend/tests | grep -c '\.test\.ts$'` = 1586,同一命令对 `HEAD` = 1600,差值恰好 +14,与本条差值逐位相同;且 `git ls-tree -r 6e2e48a7c` 已经包含 A-4 自己新增的全部 6 个测试文件(4 个 `approval-template-groups-*.db.test.ts` + 2 个 `approval-template-group-*-*.test.ts`),故这 14 个新增文件不来自 A-4 本身的提交,是 rebase 吸收的上游 `origin/main` 新文件——不是本次改动引入的回归。

③ `bash -e apps/web/scripts/run-required-web-tests.sh` —— ANSI 剥离后对 19 段 `Test Files`/`Tests` 小计逐段 `awk` 求和:**569 files passed (569)、9183 tests passed (9183)**,`grep -c "^ FAIL"` = 0,`EXIT=0`。与 §12(568/9122)差值 +1 file/+61 tests;`git ls-tree -r 6e2e48a7c -- apps/web/tests | grep -cE '\.(test|spec)\.ts$'` = 817,同一命令对 `HEAD` = 822(+5),量级同方向但脚本只跑其中的策展子集,未能像②那样把 +1 精确钉到某一个文件——按与②相同的"该分支在 §12 之后又经历一次 rebase"机制推断为同源 upstream drift,未做到逐文件坐实,如实标注为推断而非机械证明。

④ real-DB 按 CI 配方(逐字读 `.github/workflows/plugin-tests.yml` id=`approval-real-db-integration`,行 1576-1669):**该步骤自身 `env:` 只有 `DATABASE_URL: postgresql://postgres@localhost:5432/metasheet_test` 一项** —— `MIGRATION_EXCLUDE` 不在这一步的 env 里,而是挂在同一 job 更早的「Run DB migrations」步骤(行 1104),对这个 job 共用的库只在建库时应用一次;`PRODUCT_MODE` 全仓检索后只出现在这个 job 里另一个独立步骤(`elearning V0.1 auth/tenant/RBAC gate`,行 1192),`approval-real-db-integration` 这一步没有它。`EXPECT_DB` 的检索范围要更正:它不是"只在其它独立工作流里"——`grep -rl EXPECT_DB packages/core-backend/tests` 命中约 60 个文件(含本次 A-4 新增的四个 `approval-template-groups-*.db.test.ts` 和多个既有 `approval-*.db.test.ts` 兄弟文件),是这条 real-DB 测试族普遍采用的"反 skip-green 哨兵"模式(`itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip`);但 `approval-real-db-integration` 这一步的 `env:` 确认只有 `DATABASE_URL`,不设 `EXPECT_DB`,所以这些文件里的哨兵用例在这一步统一按设计跳过,不是本次改动新引入的缺口。任务描述里预设 `MIGRATION_EXCLUDE`/`EXPECT_DB`/`PRODUCT_MODE` 都直接挂在这一步 env 上是不准的,按实读结果记录如上。

复现步骤:`createdb metasheet2_a4_ci`;`DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_a4_ci MIGRATION_EXCLUDE="008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql" pnpm --filter @metasheet/core-backend db:migrate`(逐字取自行 1104,`EXIT=0`,含新迁移 `zzzz20260918090000_create_approval_template_groups` 成功执行);随后 `DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_a4_ci` 跑行 1587-1669 逐字提取的 81 个文件同一条 `vitest --config vitest.integration.config.ts run ... --reporter=dot` 命令(按清单顺序一次性传给同一个 vitest 进程,未拆批)。

结果:**Test Files 81 passed (81)**(与从工作流文件机械提取的 81 个文件名逐一对应,非空跑/非 skip-shaped-green)、**Tests 890 passed | 7 skipped (897)**,`grep -c "^ FAIL"` = 0,`EXIT=0`。7 个 skip 分布在 7 个不同文件里各 1 条,逐一 `grep` 定位后确认全部是同一个 `itIfExpectDb` 哨兵用例(`sentinel: EXPECT_DB lane must have DATABASE_URL...`),包括四个新文件 `approval-template-groups-{lifecycle,serialization,sections,reorder}.db.test.ts` 各 1 条,以及三个既有兄弟文件 `approval-comments.db.test.ts`/`approval-instance-readability-s1.db.test.ts`/`approval-lock9-process-attachments-realdb.db.test.ts` 各 1 条——四个新文件只是复制了这三个既有文件已经在用的同一套哨兵模式,不是 A-4 独有的新缺口。这 7 条哨兵按设计只在 `EXPECT_DB=1` 时执行(该 lane 只设 `DATABASE_URL`,故跳过属预期),正控已经在 §12 里跑过:同样四个文件加 `EXPECT_DB=1` 单独重跑得到 `40 passed (40)`、零 skip,证明这四条哨兵在被点燃时确实会执行且通过,不是被永久性关闭的死代码。跳过属于该文件内部条件分支,文件本身仍标 `✓`,不是整文件被 `describeIfDatabase` 跳过。**处女库 + 完整 81 文件清单一次性合并重跑未复现 A-3 那类共享库 org 碰撞**——四个 A-4 新文件在这条完整清单里干净通过,没有观察到红。

修复:无。四条腿全绿,未触碰任何生产代码,未修改任何测试,未应用迁移到共享库(`metasheet2_a4_ci` 为本次新建的一次性专用库)。收尾 `dropdb metasheet2_a4_ci`;`df -h /` 释放前 5.8Gi、释放后 5.9Gi 可用。

本节之外一点记录在案、不在本轮四条腿范围内:本分支同一份 diff 里给 `plugin-tests.yml` 新增了一个独立具名步骤「Approval template-groups CI wiring contract」(`node --test scripts/ops/approval-template-groups-ci-wiring.test.mjs`,行 ~519),脚本文件已在分支上存在;它既不在 `scripts/ops/__tests__/*.test.mjs` 通配符里也不影响 `EXPECTED_OPS_TESTS_COUNT=48` 计数闸,未纳入本次①-④复现,如实记录供开 PR 后核对该步骤本身是否绿。

## 14. P3 卫生轮(2026-09-19)

**范围**:门审报告 `impl-gate-A4-round1-20260918.md` §3(6 条)与 `impl-gate-A4-round2-20260918.md` §2/§9(round-2 自己新记的 3 条,含对 round-1 P3-4 的反驳/收窄,以及 round-1 P3-2/P3-3/P3-5/P3-6「本轮零处置」的重申)——两份报告合计的「仍开放 P3」去重后是 **8 条**(round-1 P3-1 的诉求已被 round-2 P3-1 吸收重述,不单列)。

**前置**:本轮开工前先 `git rebase origin/feat/approval-template-groups-phase1`(栈底 phase1 分支在两份门审报告落笔之后又推进了约 35 个提交,含它自己的一轮 P3 卫生),`git rebase` **零冲突**(`Successfully rebased`,45/45),`git push --force-with-lease` 已执行一次。rebase 后重新核对 round-2 §6.5 的 s6a 钉:`sha256sum` 现算 `c63eeb5bfabc0aaf74552be66fe8fd7e744e1fcdfcc78dafd45ed1a59a2ee6f4`,与 `s6a-package-provenance-pins.json` 里的 `pluginTestsWorkflow` 逐字节相同——phase1 的重进展里虽然有一次 `plugin-tests.yml` + s6a 的同步再钉提交(`645209861`),但那次改动已经把两者钉在一起,rebase 未引入新的漂移,**无需重算**。

### 14.1 处置表

| # | 出处 | 原文一句 | 处置 |
|---|---|---|---|
| 1 | round-2 §2 P3-1(吸收 round-1 §3 P3-1 的诉求) | 「验证 MD §7 的 mutation 台账...在暂存区,没有进任何提交」+「§12 有一处理由不精确:...真正让计数不动的是 `vitest.config.ts:1850` 的 exclude,`describe.skip` 那一半在这里不起作用」 | **CLOSED-MD** — 见 §14.2 |
| 2 | round-2 §2 P3-2 | 「新授权用例只对『删』掉 guard 有判别力,对『换』成另一把 guard 没有...一行修法:补一个『有 `approvals:read`、没有 `approval-templates:manage`/`approvals:admin-templates`』的第三个 actor」 | **CLOSED-测试** — 见 §14.3 |
| 3 | round-1 §3 P3-2 | 「`mapReorderConstraintError` 的 `GROUP_SORT_CONFLICT` 有映射但无正向用例」 | **DEFERRED-需行为改动** — 见 §14.4 |
| 4 | round-1 §3 P3-3 | 「`expect(listApprovalTemplateGroupsSpy).not.toHaveBeenCalled()` 是『断言不发生』,同文件内无正控」 | **CLOSED-测试** — 见 §14.5 |
| 5 | round-2 §2 P3-4(反驳/收窄 round-1 §3 P3-4) | 「实测该失败模式在本 lane 的配置下不可达...建议把这条从『必须加 `pageSize`』降级为『加了更稳、不加不算缺陷』」 | **CLOSED-MD** — 见 §14.6 |
| 6 | round-1 §3 P3-5 | 「A-2 的 session-org 脱困入口没接到新的 `section=` 读路径...A-2↔A-4 的合流顺序需要 owner 一句」 | **DEFERRED-owner项** — 见 §14.7 |
| 7 | round-1 §3 P3-6 | 「目标文档 `goal-three-locks-full-implementation-20260918.md` 的 A-4 状态行已过期:写着『已落 @`3218a4aaa`...』」 | **CLOSED-MD**(外部文档,已由其它 lane 更新;本轮验证一致)— 见 §14.8 |
| 8 | round-2 §2 P3-5 | 「`EXPECT_DB` 在 `plugin-tests.yml` 里一处都没设...这些哨兵在 CI 里恒为 `it.skip`,从不执行」 | **DEFERRED-需行为改动** — 见 §14.9 |

### 14.2 #1 CLOSED-MD — 验证 MD 提交状态 + §12 机制理由

round-2 门审的 P3-1 有两层:(a)round-1 收敛项 2 要求的「11 条台账并入 §7」在 round-2 审查的 head(`e214184af`)上还只在暂存区——这一层在本轮修复轮内(`aa105931b`,2026-09-18)已经提交,不是本次 P3 卫生轮做的;(b)round-2 自己新加的两项要求当时确实还没有任何提交做过:round-2 自己亲跑的 **12 条**(`MD1`–`MD12`,与 round-1 的 `M1`–`M11` 是不同编号)从未并入本文档,以及 §12 那句「两个新用例...`describeIfDatabase` 无 `DATABASE_URL` 时整块跳过」的机制解释本身不精确(真正机制是 `vitest.config.ts` 的 exclude,不是 `describe.skip`——若只靠 `describe.skip`,`skipped`/`total` 计数会随新用例增加而变动,实测未变动)。

本轮处置:新增 §7.1(round-2 的 12 条独立台账,标注为「round-2 门审者亲跑,本轮未重跑」,不与 §7 的 round-1 台账混编号)+ 改写 §12 第二行(机制更正,给出判别式)。

### 14.3 #2 CLOSED-测试 — reorder 授权用例补第三个 actor

`packages/core-backend/tests/integration/approval-template-groups-reorder.db.test.ts` 的 `authorization: reorder requires approvalTemplateAdminGuard...` 用例新增 `readerOnly` actor(`roles:'user', perms:'approvals:read'`),断言与 `nobody` actor 相同的判别式拒绝体(403 + `{error:'Insufficient permissions'}`)。

**本轮亲跑验证**(私有库 `ms2_a4_p3hygiene_20260919`,处女库):

1. 修复后现状:**6/6 全绿**(含新 actor)。
2. **mutation 探针**(`cp` 备份 `routes/approvals.ts` → 把 `:1288` 的 `approvalTemplateAdminGuard` **换**成 `rbacGuard('approvals:read')`——round-2 门审 MD3 的同一处替换探针,不是删除):同一命令重跑,**恰 1 条转红**——新增的 `readerOnly` 腿 `expected 200 to be 403`(其判别式断言那行未执行到),其余 5 条(含 `nobody` 腿)不受影响;这就是 round-2 MD3 发现「`nobody` 一个人扛不住换 guard」的那个缺口现在被堵上的直接证据。
3. `cp` 恢复 `routes/approvals.ts` 后 `cmp` 逐字节相同;恢复后重跑本文件 **6/6 全绿**;随后与 lifecycle/serialization/sections 三个兄弟文件合并重跑 **4 passed (4) / 40 passed (40)**,无回归。

### 14.4 #3 DEFERRED-需行为改动 — `mapReorderConstraintError` 无正向用例

`ApprovalTemplateGroupReorderService.ts:44` 的 `mapReorderConstraintError` 是模块私有函数(未 `export`)。要给它加一条正向格式用例(不经过真实约束违反,直接构造一个 postgres 约束错误对象喂给它),唯一途径是把它从私有函数改成 `export function`——这是对生产源码可见性面的改动,不在本轮「只允许测试、注释、MD、scripts/dev」的范围内(即使调用点行为零变化)。round-1 门审已确认它在正确实现下不可达(reorder 全程持 L0 + 写完整活跃集),不是活缺口,只是防御性分支缺一条正向格。登记为 DEFERRED,交下一轮实现性修复(需要 owner 认可"导出一个私有符号供测试直调"这个改动形状,或改用集成层面的构造手法)处理。

### 14.5 #4 CLOSED-测试 — `not.toHaveBeenCalled()` 的同文件正控

侦察结论(与 advisor 复核一致):`apps/web/tests/approvalTemplateCenterCategory.spec.ts` 挂载的是 `TemplateCenterView.vue`,而这个组件的脚本**从未**导入 `listApprovalTemplateGroups`(只有 `TemplateGroupSections.vue` 会调用它,做 phase-3 的分组视图)——所以「同一文件内构造一条会真的调用这个函数的路径」这件事,在这个组件身上**架构上不存在**,不是没找而是没有。

本轮处置(同文件,两部分):

1. **注释**:在 `not.toHaveBeenCalled()` 断言下方写明上述架构原因,并交叉引用真正的调用点正控——`approvalTemplateCenterSections.spec.ts` 的 `expect(listApprovalTemplateGroupsSpy).toHaveBeenCalledTimes(1)`(同一个 spy 函数,不同组件,`TemplateGroupSections.vue` 确实会调它)。
2. **测试**:新增一条同文件内的「mock 接线」正控——直接 `await import('../src/approvals/api')` 拿到被 `vi.mock` 接管的真实导出并调用一次,断言 `listApprovalTemplateGroupsSpy` 被记录到这一次调用。这不证明「组件会调用它」(架构上不会),证明的是「如果组件调用了,`not.toHaveBeenCalled()` 不会因为 mock 接线本身坏掉(错路径/被覆盖/热更新失效)而误判为通过」——这是 `not.toHaveBeenCalled()` 唯一可能在本文件内被证伪的失效模式,现在被堵上。

**本轮亲跑验证**:`npx vitest run tests/approvalTemplateCenterCategory.spec.ts` **8/8 全绿**(含新增断言)。

### 14.6 #5 CLOSED-MD — `ungrouped` 正控的 pageSize 降级记录

round-2 门审已实测收窄:`packages/core-backend/vitest.integration.config.ts:26-27` 是 `fileParallelism: false` + `maxConcurrency: 1`(注释原文「Run files serially」),而四桶测试里的 `t1`…`t5` 夹具是在同一条用例里、断言前一刻经生产路径创建的——它们的 `updated_at` 严格新于库里任何既有行,按 `ORDER BY updated_at DESC` 恒在首页前五。要把它们挤出首页需要有并发写入方在同一毫秒窗口内造出 ≥20 条新模板,而串行配置排除了这一点。round-2 因此把这条从「必须加 `pageSize`」降级为「加了更稳、不加不算缺陷」。

本轮处置:仅记录这条降级判定(本节 + 处置表),**不改动测试文件**——round-2 已经给出机械证据,给 `ungrouped` 桶的三次 section 请求追加显式 `pageSize` 是一次纯粹的防御性加固,不修复任何当前会红的东西,在一个已绿的套件上做零风险收益的改动没有必要占用本轮的 mutation-probe 预算;全仓检索确认仓内没有任何地方把「必须加 `pageSize`」写成现在时的强断言需要撤回(`grep -rn` 零命中,见 §14.10)。

### 14.7 #6 DEFERRED-owner项 — A-2 session-org 未接入 section= 读路径

`grep -rn "SessionOrgSwitcher" apps/web/src` 命中的 3 处全部是 `AttendanceSessionOrgSwitcher`(考勤线自己的组件,`apps/web/src/views/attendance/AttendanceSessionOrgSwitcher.vue`),approval 线 A-2 的 `apps/web/src/components/SessionOrgSwitcher.vue` 在本分支**依旧不存在**(`ls` 确认 No such file or directory)——round-1 的披露在 rebase 到最新 phase1 之后仍然成立。这是 A-2(尚未落地/未合并到本 lane)与 A-4(本切片)之间的合流顺序问题,不是本切片能单方面修复的缺陷;继续登记为待 owner 裁决项,设计 MD §6 / 验证 MD §10 的既有披露保持原样。

### 14.8 #7 CLOSED-MD — 目标文档状态行(外部文件,已被其它 lane 更新)

`goal-three-locks-full-implementation-20260918.md` 位于 `~/.claude/projects/.../reviews/`,不在本 git 仓库/本分支内(`grep -rn "3218a4aaa" .` 在整个 worktree 内零命中,该文档也确实不在 `find` 结果里)。现场读取该外部文件:A-4 那一行已经是「**Draft PR #5878**(第 2 轮门审 DRAFT-READY 0 P1/0 P2/5 P3 @e214184af;required 四条复现全绿 @dab7670b6;堆叠在 #5852)」——round-1 点名的 `@3218a4aaa` 已经不在里面,说明这一行在 round-2 门审运行期间或之后已被其它 lane/session 更新过。本轮验证其现状与两份门审报告的事实一致,不重复编辑;提醒:该行引用的 `@e214184af`/`@dab7670b6` 是本轮 rebase 之前的旧头,rebase+push 之后会再次过期,但更新这份跨三把锁的目标文档不属于本 lane 的职责范围,留给下一次触碰该文档的 session。

### 14.9 #8 DEFERRED-需行为改动 — `EXPECT_DB` 在 real-DB 步骤未设

现场重跑 `grep -c "EXPECT_DB" .github/workflows/plugin-tests.yml`(post-rebase head)= **0**,与 round-2 门审的披露一致,rebase 未改变这一点。这不是本切片(phase 3)引入的缺口——四个 phase-3 文件只是复制了 phase-1 两个原始文件已经在用的同一套 `itIfExpectDb` 哨兵模式,且这套模式在仓内普遍存在:本轮现场重跑 `grep -rl "EXPECT_DB" packages/core-backend/tests | wc -l` = **54 个文件**(§13 在 rebase 之前的旧头上量得的是「约 60 个」,数字随分支前后移动是预期的,不当正文常量维护,以本次现场重跑为准),`plugin-tests.yml` 的 `approval-real-db-integration` 步骤从一开始就不设 `EXPECT_DB`,不是本切片改坏的。修复需要给该步骤的 `env:` 加一行 `EXPECT_DB: '1'`——这是对 `.github/workflows/plugin-tests.yml` 的改动,不在本轮「只允许测试、注释、MD、scripts/dev」范围内(工作流文件的改动惯例上还会级联触发 s6a 重新计算,影响面覆盖这条 real-DB 步骤下的全部 54 个文件,不只是本切片的四个)。登记为 DEFERRED,交 owner 决定是否要把这行加上(以及由谁承担 s6a 重钉与安静窗口协调)。

### 14.10 撤回类改动的全分支扫描(item ③)

**方法论说明(自引用问题,已两次绕进去,现固定处理方式)**:本节讨论并展示这四条 grep 模式本身,而这四条模式又要拿来扫描"仓内是否还有人以现在时重申这几句被撤回/被降级的话"——这意味着**本节自己**(以及 §14.1/§14.2/§14.6/§14.8 转述这些原话的地方)从写下的那一刻起就会命中自己,而且每编辑一次本文档,命中数就可能再变一次(本节初版声称"0 hits",一次重跑就命中了自己;第二次重写给出的具体数字,又被本次编辑追加的说明文字再次推高)。这不是测量错误,是"用会变的东西描述自己"这类陈述的结构性性质,phase1-verification 的 §24.1/§24.6 在同一类问题上得出的规程是:**不钉一个会漂移的数字,钉判读规则**("是否以现在时重申",不是"grep 数字是否为零")。本节照此收敛,把范围**显式排除本文档自身**,只报告"这份文档之外,仓库其它地方"的命中——这个数字不会因为继续编辑本文档而变化:

```
$ git grep -l "3218a4aaa" -- . ':(exclude)docs/development/approval-template-groups-phase3-sections-verification-20260918.md'
```
**0 个文件**(本文档之外)。

```
$ git grep -l "两个新用例都在 \`\.db\.test\.ts\` 里,\`describeIfDatabase\` 无 \`DATABASE_URL\` 时整块跳过" -- . ':(exclude)docs/development/approval-template-groups-phase3-sections-verification-20260918.md'
```
**0 个文件**——这条本身也是本文档自己在 §12 改写前后引用过的逐字原句,但改写后 §12 用的是新措辞而非旧句,连本文档自身现在也不命中。

```
$ git grep -n "NOT RUN" -- docs/development/approval-template-groups-phase3-sections-design-20260918.md
```
**0 处**(设计 MD 里从未出现过这个词组;验证 MD 自身的 §7 标题命中被排除法则排除,不在本次计数里,是元描述,category-3,详见 §14.2 的说明)。

```
$ git grep -l -E "必须加.*pageSize|pageSize.*必须" -- . ':(exclude)docs/development/approval-template-groups-phase3-sections-verification-20260918.md'
```
**3 个文件**,与本切片/本轮修复主题**均无关**,逐一读过确认是正则假阳性(`.*` 跨越了同一行/同一表格单元格里两个不相关的子句):`docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md:367`(「pageSize 上限 20」与同一段落末尾「必须 staging ... 后才翻 ✅」——考勤线自己的 staging 门槛判据,与分页参数无关);`docs/development/multitable-crosspage-grouping-datamodel-designlock-20260708.md:307` 与 `docs/development/multitable-nongrid-view-materialization-designlock-20260708.md:390`(两处都是「`pageSize`/`offset += pageSize` ... **mutation-red**:...断言必须红」——多维表分组/甘特图设计锁自己的 mutation-red 判据措辞,与本切片 `ungrouped` 桶的分页无关)。

**结论**:排除本文档自身后,四条模式里三条零命中,第四条的全部命中都是与本切片无关的正则假阳性——仓内没有任何地方以现在时重申这几句已被撤回或已被降级的断言。本文档自身命中自己(§14.1/§14.2/§14.6/§14.8 转述这些原话的地方)是预期的元描述,不逐次重新计数,判读标准见上。

另:`bash scripts/dev/atg-retraction-sweep.sh` 现场重跑(post-rebase + post-本轮编辑),`EXIT=0`;扫描范围内本轮新增的命中(`⊇`/`⊂`/`subset`/`superset` 若干处,均在 `origin/main` 自身前进带来的无关文件里,如 `plugin-attendance/index.cjs` 的考勤三层嵌套、`univer-meta.ts` 字段收窄)逐条读过,**零处**触及 `approvalTemplateAdminGuard`/`isTemplateManager` 主题,判定结论(guard/manager 两个方向互不包含)不受影响——已把这次现场重跑的脚注写回 §8(phase1-verification 那份历史更正另见其自身文档,不在本 lane 职责范围内重复维护)。

### 14.11 本轮改动范围(`git diff --stat`)

起点 = rebase-onto-phase1 完成、push 之前的 head `aad08d275168c127d4d66758a3bc0977654f8e56`(与本文档 §13 记录的 HEAD `bdcdfebc4` 之后、rebase 之后的最新一次提交一致)。

**范围说明(避免自引用漂移)**:本文档自己就是本轮改动的一部分,一份还在写作中的文档不能把"自己写到一半时的字节数"当成最终范围——之前一版这里犯了这个错误(用 `aad08d275..HEAD` 这个会随后续编辑继续增长的活动范围,写的却是一次性的静态数字)。改为钉两个**固定、已提交、不再变化**的端点:

```
$ git diff --stat aad08d275..1d2a7f903
```

```
 .../tests/approvalTemplateCenterCategory.spec.ts   |  21 ++
 ...groups-phase3-sections-verification-20260918.md | 120 ++++++++++++++++++++-
 .../approval-template-groups-reorder.db.test.ts    |  27 ++++-
 3 files changed, 166 insertions(+), 2 deletions(-)
```

`1d2a7f903` 是本轮三条实质性修复提交(round-2 P3-2 测试、round-1 P3-3 测试、本 §14 disposition 表的第一版)的最后一个;此后 §14.10/§14.11/§14.9 的本次订正又追加了一个纯文档提交(`docs(approval): embed literal diffstat in P3 hygiene §14.11` 及本次订正),把范围钉在 `1d2a7f903` 而不是不断移动的 `HEAD`,是为了让这段文字本身可以被复现验证而不会因为文档还在继续编辑而失真——最终 PR/commit 历史里完整的、包含本次订正在内的范围以 `git log --oneline aad08d275..<本 lane 推送的最终 HEAD>` 现场核对为准,不在本段重复维护一个会过期的数字。

三个文件(`aad08d275..1d2a7f903` 范围内):两个测试文件(`packages/core-backend/tests/integration/approval-template-groups-reorder.db.test.ts`、`apps/web/tests/approvalTemplateCenterCategory.spec.ts`)与本验证 MD 自身——零生产代码改动、零 workflow 改动、零迁移、零新文件、零重命名。`git diff --name-only aad08d275..1d2a7f903 -- packages/core-backend/src apps/web/src '.github/workflows' 'packages/core-backend/src/db/migrations'` 现场核对为**零命中**,机械确认上一句不是自述。本次订正(`1d2a7f903..HEAD`)只改动本文档自身(§14.9/§14.10/§14.11 三处订正),同一条零命中命令对这个范围重跑同样为空。

### 14.12 本轮全绿复核(处女库 `ms2_a4_p3hygiene_20260919`,用完 `dropdb`)

- 四个真库套件合并重跑:`Test Files 4 passed (4)` / `Tests 40 passed (40)`。
- `node --test scripts/ops/approval-template-groups-ci-wiring.test.mjs`:`pass 12 / fail 0`。
- 两个纯函数单测(`approval-template-group-reorder-validation.test.ts` + `approval-template-group-section-token.test.ts`):`2 passed (2)` / `19 passed (19)`。
- `apps/web` 改动文件本身:`tests/approvalTemplateCenterCategory.spec.ts` **8/8**。
- `pnpm type-check`:`EXIT=0`(`packages/core-backend: Done` / `apps/web: Done`)。
- 收尾 `dropdb ms2_a4_p3hygiene_20260919`。

**处置汇总(8 条:CLOSED 4 / DEFERRED 3 / CLOSED-MD 外部文档确认 1)**:#1 CLOSED-MD、#2 CLOSED-测试、#3 DEFERRED-需行为改动、#4 CLOSED-测试、#5 CLOSED-MD、#6 DEFERRED-owner项、#7 CLOSED-MD(外部)、#8 DEFERRED-需行为改动。三条 DEFERRED 均已登记原因与所需的下一步(owner 裁决或需要一次超出本轮范围的生产/workflow 改动),未做任何生产代码或 workflow 改动。

---

## 15. A-2 × A-4 合流验证(2026-09-20,分支 `feat/approval-template-groups-phase3-sections-on-a2`)

> 本节记录 **A-4 重放到 A-2 head 之上** 之后的重跑。**§1–§14 不作废**:那些数字测的是 A-4 在 A-1 之上的 head
> (`879070ef2e`),在那个 head 上仍然成立;本节测的是另一个 head,两套数字并存,受影响的句子在 §15.7 逐句求值。
> 设计侧的取舍写在设计 MD §8。合流缺陷来源:`reviews/verify-groups-a2-a4-combined-build-20260920.md`。

### 15.1 底座、重放与机械核对

| 项 | 值 |
|---|---|
| 底座(A-2 head,#5854) | `4678b01cb6e3ad7ed7179c3a5a44b1fe864f426c` |
| 被重放 lane(A-4 head,#5878) | `879070ef2ec11c6d2e8b099b8ca9755b637a5fff` |
| 重放命令 | `git rebase --onto 4678b01cb6 66f526145c`(切点判据见设计 MD §8.1:两条 lane 的 A-1 段末尾树 `d302d29569` 逐字节相同) |
| 重放提交数 | 27 个中落地 25 个(2 个因内容已在底座而成空提交被丢弃) |
| `git cherry origin/main HEAD` | 83 行,**全部 `+`**,零 `-` ⇒ 与 `origin/main`(`123b1d1e54`)零重复 |
| `origin/main..HEAD` 内部重复 patch-id | **0** ⇒ A-1 段只出现一次 |

### 15.2 合流缺陷在 rebase 路径下的复现(先复现再修,不是直接修)

重放完成、尚未做任何收口时,`apps/web` 的 `vue-tsc -b`:**14 条错误**(exit 1)——
与报告 §3.1 的 merge 路径**逐行逐列相同**(同样的 `api.ts(11,3)` / `(410,23)` / `(476,23)` / `(487,23)` /
`(1257,23)` / `(1298,23)` / `(1311,23)`,同样的 TS2440 / TS2323×6 / TS2393×6),外加环境项
`vite.config.ts(28,29) TS2769`。即 P1-1 **在 merge 与 rebase 两条路径下同形**,不是报告那次合并手法的产物。

日志:`soak-working/d3-groups-merge-20260920/pre-convergence-vuetsc.log`

### 15.3 `vite.config.ts(28,29) TS2769` 的 `origin/main` 基线(报告 §4.4 拒绝断言的那一条,本次补上)

报告只把这条标成「非合流引入 / 环境」,并明写「本次没有在干净安装上复核过 main 的基线」。本次在**同一个工作树、
同一份软链 `node_modules`**、`git worktree add --detach origin/main` 的干净检出上先跑了一次:

```
$ cd apps/web && npx vue-tsc -b            # HEAD = origin/main = 123b1d1e54250ba9e96b33dcbb8112cf2fcdf8af
vite.config.ts(28,29): error TS2769: No overload matches this call.
EXIT=2        # 错误条数:1,且就是这一条
```

⇒ 这条错误在 `origin/main` 上就存在,与两条 lane 无关(错误文本点名 pnpm store 里的 `vite@5.4.21` 与 `vite@7.3.6` 两份)。
**因此 `pnpm type-check` 在本分支仍然非零退出,但错误集合与 `origin/main` 逐字相同**——这是基线相等,不是本分支新引入的红。

日志:`soak-working/d3-groups-merge-20260920/baseline-originmain-vuetsc.log`

### 15.4 收口后的四项闸

| 闸 | 命令 | 结果 |
|---|---|---|
| 1 `apps/web` 类型 | `npx vue-tsc -b` | **只剩** `vite.config.ts(28,29) TS2769` 一条,与 §15.3 的 `origin/main` 基线**逐字相同**;13 条合流引入的错误全部消失 |
| 2 `apps/web` 构建 | `npx vite build` | **exit 0**,`✓ built in 38.73s`(报告里 esbuild 的 6 条 `Multiple exports with the same name` 全部消失) |
| 3 required web lane | `bash -e apps/web/scripts/run-required-web-tests.sh` | **exit 1**,但死在**与两条 lane 无关的、`origin/main` 自身就红的**一条上 —— 见 §15.5 |
| 4 两条 lane 定向 spec | `npx vitest run SessionOrgSwitcher.spec.ts approvalTemplateGroupsClient ApprovalTemplateGroupsPanel approvalTemplateCenterSections approvalTemplateCenterCategory templateCenterI18n approvalTemplateGovernance` | **8 files / 63 tests 全绿**(报告 Tree B2 是 1 failed \| 62 passed,那一条红就是 P2-1) |
| 5 后端 | `npx tsc --noEmit -p tsconfig.json`(core-backend) | **exit 0,零错** |
| 6 CI 两点接线 | `node --test scripts/ops/approval-template-groups-ci-wiring.test.mjs` | **12/12 pass** |
| 7 s6a 封包指纹 | `node plugins/…/sealed-export-package-provenance.test.cjs` | **OK**(pin 在重放中每次撞到都按当时的 `plugin-tests.yml` 重算,最终值 `6af0690a3cb93891e1158d79d95ee325bdf5bbae42df09760932367e2ede264c` 与文件实测 sha256 相等) |
| 8 exec 行形状 | `bash scripts/dev/atg-exec-line-post-rebase-check.sh` | **PASS**:`^exec npx vitest run` 恰好 **1** 行,行上 **399** 个 token 互不重复(整行 `run` 之后 400 个字段,其中 1 个是 `--reporter=dot`)(两条 lane 各自 head 上这个脚本此前都是红的) |
| 9 A-4 闭世界普查 | `npx vitest run approval-member-identity-coverage-enumeration` | **16/16 pass** |
| 10 审批 CI 覆盖枚举 | `CI=true npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts` | **350/350 pass**(按报告 P1-2 的告诫,这条绿**不**被当作 exec 行覆盖证据,只作回归) |

### 15.5 闸 3 的诚实结论:退出码 1 来自 `origin/main` 自身的一条红,不是合流

`run-required-web-tests.sh` 共有 **19** 条可执行的 `npx vitest run` 调用(全文件 50 行含这个字样,其余 31 行都在注释里)。
本次运行在**第 9 条**(脚本 `:606`)被 `set -euo pipefail` 打断:

```
FAIL tests/multitable-recovery-archive-modal.spec.ts > ManualArchiveCapture
     > does not submit when durable request identity cannot be saved
AssertionError: expected "spy" to not be called at all, but actually been called 1 times
Test Files  1 failed | 1 passed (2)      Tests  1 failed | 153 passed (154)
REQUIRED_WEB_EXIT=1
```

**归因(实测,不是推断)**:

1. 这个 spec 与它 import 的全部 `src`(`apps/web/src/multitable/**`)在本分支与 `origin/main` **零差异**
   (`git diff --name-only origin/main HEAD -- apps/web/tests/multitable-recovery-archive-modal.spec.ts apps/web/src/multitable/ …` 输出 0 行);
2. 在 `origin/main`(`123b1d1e54`)的独立干净工作树里跑**同一条命令**,得到**逐字相同的红**:
   `Test Files 1 failed | 1 passed (2)` / `Tests 1 failed | 153 passed (154)`。
   日志:`soak-working/d3-groups-merge-20260920/baseline-originmain-multitable-recovery.log`。

**剩余 10 条调用(含最后那条 `exec` 行)是否也绿**:为了回答这个问题(errexit 让它们在上面那次根本没跑到),
把脚本复制成一个**未跟踪的探针副本**,只把 `:606` 那一条调用注释掉,其余逐字不动,跑完后删除探针文件
(`git status` 干净,被测脚本本体一字未改):

```
PROBE_REQUIRED_EXIT=0          # 18/18 条调用全部执行,全部通过
最后一条(exec 行):Test Files  472 passed (472)   Tests  7273 passed (7273)
```

**两条 lane 的 spec 确实被 required lane 收集并执行**(在最后那条 `exec` 行的 472 个文件里各出现 1 次):

| lane | spec 文件 | 在 exec 行那次运行里出现 |
|---|---|---|
| A-2 | `tests/SessionOrgSwitcher.spec.ts` | 1 |
| A-2 | `tests/approvalTemplateGroupsClient.spec.ts` | 1 |
| A-2 | `tests/ApprovalTemplateGroupsPanel.spec.ts` | 1 |
| A-4 | `tests/approvalTemplateCenterSections.spec.ts` | 1 |

即报告 P1-2 指出的「A-4 那 18 个 `approvalTemplateCenterSections` 测试在任何 CI lane 上都不会被执行」
**在本分支已经不成立**:token 在唯一的活 exec 行上,并且实测被执行。

日志:`soak-working/d3-groups-merge-20260920/run-required-web-tests.log`(原样,exit 1)、
`…/run-required-web-tests-minus-main-red.log`(探针,exit 0)。

### 15.6 Mutation 台账(合流收口专属,三条;全部 `cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp` 字节相同)

| # | 目标 | 注入 | 观测 | 判定 |
|---|---|---|---|---|
| M-C1 | 主从关系与 I6 的挂载判据 | 把 `ApprovalTemplateGroupsPanel` 改回「不分 viewMode 恒挂」(合流前的形态) | `approvalTemplateCenterCategory.spec.ts` **3 红**:I6 的 `renders a category tag per row`,加上本轮新增的两条分组视图用例 | **有判别力**;还原后 10/10 绿 |
| M-C2 | `changed` 事件 → 分节视图重读(P3-1 的状态不同步那一半) | 删掉面板 `onCreate` 里的 `emit('changed')` | `grouped view: creating a group in the manager re-reads the sections view` **红**:`expected 2 to be greater than 2`;其余 9 条绿 | **有判别力**;还原后 10/10 绿 |
| M-C3 | 挂载点变化对 A-2 i18n 守卫覆盖面的影响(实测,不靠推断) | 在面板模板里**单独起一行**插入裸中文 | `templateCenterI18n.spec.ts` **1 红**,就是那条 file-level 守卫 `guard: ApprovalTemplateGroupsPanel.vue has no CJK literal outside a paired tr(en, zh) call`;整页渲染 sweep **不再**跟着红(面板已不在平铺视图里挂载) | 守卫仍然有效,但**覆盖面窄了一条**,见 §15.7 |

**M-C3 过程中另外实测到的一条既有弱点(与本次改动无关,原样披露不修)**:把裸中文追加到一行**已经含有**
`tr('English', '中文')` 调用的行尾(第一次探针的形态),`templateCenterI18n.spec.ts` **18/18 全绿**——
该守卫的白名单粒度是「整行」,所以任何粘在已翻译行尾的散落中文都能逃过。这是 A-2 那条守卫自带的性质
(`pairedTrCall` 正则逐行判定),不是本次合流引入的;记在这里供 lane/门审处置,本分支不擅自改守卫形状。

### 15.7 §1–§14 受影响句子的逐句求值(不作废整节)

| 出处 | 原句(摘要) | 本分支求值 |
|---|---|---|
| §4.1 / §12 / §13 的 `pnpm type-check` 绿 | A-4 自己 head 上 type-check 通过 | **对那个 head 仍然成立,未被推翻**。本分支(底座换成 A-2)上 `vue-tsc` 非零退出,错误集合 = `origin/main` 基线那一条 `vite.config.ts` TS2769(§15.3)。差异来自**环境**(pnpm store 两份 vite)与**底座**,不是 A-4 的改动。 |
| §4.3 / §12 / §13 的 `run-required-web-tests.sh` 绿 | A-4 head 上该脚本退出 0 | **对那个 head 仍然成立**。本分支上退出 1,死在 `multitable-recovery-archive-modal.spec.ts`——该 spec 在 `origin/main` 上同样红(§15.5 实测),不是合流引入。把那一条调用摘掉的探针里,其余 18 条全绿。 |
| §6.5 s6a sha256 重钉 | 记的是 A-4 head 上的 pin 值 | **已被本分支重算取代**:`6af0690a3c…`(与合流后的 `plugin-tests.yml` 实测 sha256 相等,`sealed-export-package-provenance.test.cjs` OK)。旧值不是错的,是**另一个 head 的值**。 |
| §6.6 exec 行新令牌子串碰撞检查 | A-4 head 上的 token 集合 | **重算**:合流后活 exec 行 399 个互不重复的 token,含两条 lane 的 4 个新 token;`atg-exec-line-post-rebase-check.sh` PASS(两条 lane 各自 head 上它都是红的,见报告 P1-2)。 |
| §14.5(#4)`not.toHaveBeenCalled()` 的同文件正控 | 该正控证明 mock 接线是活的 | **仍然成立且仍然绿**;本轮另外给它加了两条**调用面**用例(§15.6 M-C1 证明有判别力),所以 I6 现在既有 live-binding 正控,也有「谁会去调它」的挂载面反例。 |
| §14.7(#6)A-2 session-org 未接入 `section=` 读路径 | 标为 DEFERRED-owner 项;当时的理由之一是本分支没有 A-2 的组件 | 见设计 MD §8.5:「没有组件可接」这半句在本分支被推翻(底座就是 A-2);缺口本身**仍然 OPERATIVE**,且合流后 `listApprovalTemplateGroups` 抛的已是带 `.code` 的 `ApprovalApiError`,**接线的前置条件已具备**。仍留 owner 裁,本分支不擅自接。 |
| §3 验收行 → 测试文件映射 | 全部映射 | **未受影响**:A-4 的 18 个 `approvalTemplateCenterSections` 用例在本分支仍然 18/18 绿,验收行的证据文件一个都没换。 |

### 15.8 未做 / 未验(如实列出)

- **没有建任何数据库、没有对任何库应用迁移**。本节的 10 项闸全部是 FE/vitest 与 `tsc`/node 脚本;
  四个 `*.db.test.ts` 真库套件**本轮未跑**。理由是实测的零差异,不是推断:

  ```
  $ git diff --stat 879070ef2e HEAD -- packages/core-backend
  (无输出)
  ```

  即整个 `packages/core-backend`(四个真库套件、三个 service、`routes/approvals.ts`、那条迁移在内)
  在本分支与 A-4 head **逐字节相同**,所以 §2.3 / §13 在处女库上的真库记录对本分支同样适用,不重复消耗一次建库。
  **这仍然是「未重跑」,不是「已重跑且绿」** —— 谁要把它当验收证据,请读 §2.3/§13 里那个 head 的记录。
- `pnpm --filter @metasheet/core-backend test` 全量**未跑**;只跑了 `tsc --noEmit`(零错)与两条定向 node 脚本。
- DEV mock 语义的残留(设计 MD §8.3)**未验**:没有起 dev server 实测分组视图在 DEV 下的表现,结论是读代码得出的。
- A-2 那条 i18n 守卫的行粒度弱点(§15.6 末)**未修**,原样披露。
