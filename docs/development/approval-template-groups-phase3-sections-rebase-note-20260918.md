# 审批表单分组 Phase 3(切片 A-4 前端分节)— rebase-onto-phase1 记录

- 分支:`feat/approval-template-groups-phase3-sections`(worktree `wt-groups-p3`),堆叠在 `feat/approval-template-groups-phase1` 之上
- rebase 前本分支头:`4641f938b933294d0792d2e92b354ee48a7066eb`
- rebase 目标(`origin/feat/approval-template-groups-phase1` 当时头,含 A-1 回流修复):`a728ed65532918e3726171d0c42f44d6be7e0ba9`
- 旧公共基点(rebase 前两分支的 merge-base):`0144932ac67e80a81f204dd6c6e502d000112276`
- rebase 后本分支头:`27bb6edfe6cdca22d4a0265463f029a67722b795`(12 个提交全部原样重放,提交信息与顺序未变,仅 parent 改写)
- `origin/main`(仅记录,未涉及本次 rebase):`3c6c28958c2ce51334b8f02df13272ef0ae77889`
- 环境:node `v25.9.0`,python3 `Python 3.9.6`,pnpm `10.33.0`
- 私有真库:`metasheet2_lock_a4_rb`(本机 Homebrew PostgreSQL 15.17,`dropdb --if-exists` + `createdb` 全新建库,`pnpm --filter @metasheet/core-backend migrate` 跑满 350 个迁移文件,全部 `was executed successfully`,最后一条 `zzzz20260918090000_create_approval_template_groups`;收尾又空跑一次 `migrate --latest` 确认零待应用迁移、命令本身零报错——DDL 零改动,与 A-1 回流修复的说明一致)

## 1. rebase 结果:零冲突

```
git fetch origin feat/approval-template-groups-phase1 feat/approval-template-groups-phase3-sections
git rebase origin/feat/approval-template-groups-phase1
```

输出:`Successfully rebased and updated refs/heads/feat/approval-template-groups-phase3-sections.`(12/12,过程中**没有**进入任何冲突态、没有 `git status` 显示 unmerged path、没有需要 `git add`/`--continue` 的手工步骤)。

收尾复核(rebase 完成后,非“过程中免检”):

```
git status --porcelain                                                          # 空
grep -rn '^<<<<<<<\|^=======$\|^>>>>>>>' --include=*.ts --include=*.vue \
  --include=*.yml --include=*.mjs --include=*.sh . | grep -v node_modules | wc -l
# 0
```

原因:A-1 的回流修复(`ApprovalTemplateGroupService.ts` 的 23514→400 映射、`routes/approvals.ts` 的 guard/manager 措辞三次改写、`approval-template-groups-lifecycle.db.test.ts` 新用例、两个 `scripts/dev/*.sh`)与 A-4 本 lane 的改动(`routes/approvals.ts` 追加 `section=` 列出 + reorder 端点、两个新服务类、两个新真库测试文件、`plugin-tests.yml`/`vitest.config.ts`/`run-required-web-tests.sh`/s6a 钉/ci-wiring 闭世界)是**同文件不同区块的纯追加**——git 三路合并按行区间自动拼合,没有触发任何冲突配方(错误映射两边保留 / 测试与人口取并集 / s6a 重算)里预案的手工合并步骤。逐项核对(而非只信任“零冲突”这一个信号):

- `ApprovalTemplateGroupService.ts`:`grep -n "23505\|23514"` 命中两码共存(23505 @ L165、23514 @ L176,含注释),A-4 从未改过此文件(rebase 前后对该文件的 diff 均为 0 行)。
- `routes/approvals.ts`:A-1 的三次改写(guard⊆manager → guard⊋manager → 互不包含,`:395-440`)与 A-4 新增的 `section=` 分节读路径(`:640` 起)、reorder 端点(`:1288`)共存,互不重叠。
- `packages/core-backend/vitest.config.ts` 的 exclude 数组:4 个 `approval-template-groups-*.db.test.ts` 各恰好出现 1 次(`grep -c` 核验),无重复条目。
- `.github/workflows/plugin-tests.yml`:phase1 未touch此文件(其 diff-stat 里没有这一行),A-4 自身新增的 1 个 ci-wiring 步骤名 + 4 个 db-test 文件名各恰好出现 1 次(`grep -c` 核验),无重复步骤/重复 whole-file 参数。
- `scripts/ops/approval-template-groups-ci-wiring.test.mjs`(A-4 的闭世界清单)`FILES` 数组本就是 A-1 的两个原始文件 + A-4 的两个新文件共 4 个,是并集自身,rebase 未改变这一点,`node --test` 现场重跑 12/12 全绿(见 §4)。
- s6a 钉(`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 的 `pluginTestsWorkflow`)与 rebase 后 `.github/workflows/plugin-tests.yml` 的 `sha256sum` 现场比对**逐字节相等**(`c63eeb5bfabc0aaf74552be66fe8fd7e744e1fcdfcc78dafd45ed1a59a2ee6f4`)——因为 phase1 未改过这个文件,rebase 不改变其字节内容,A-4 提交时已经算过的钉在新头上依然成立,**未重算,因为无需重算**(不是漏做,是机械验证过后确认没有漂移)。

结论:冲突配方(错误映射两边保留、测试/人口取并集、s6a 重新机械计算)全部是**预案**,实际 rebase 未触发,已用上述逐项 grep/diff 核验替代“假设已合并正确”。

## 2. 私有真库真库测试

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

## 3. A-1 两个脚本(`scripts/dev/*.sh`)复跑

`scripts/dev/atg-retraction-sweep.sh`(默认 `origin/main` 基线,exit 0——该脚本是报告工具,恒 0,需人读):扫描范围覆盖本分支相对 `origin/main` 的全部改动文件。对 `⊆/⊇/⊂/⊃/⊋/⊊/子集/超集/严格超集/subset/superset/无法制造/通配权限码` 各模式在 `routes/approvals.ts`/`ApprovalTemplateGroupService.ts`/两份 phase1 文档里的命中逐条读原句:全部落在(a)明确点名"已撤回/已证伪/CORRECTED A THIRD TIME"的历史叙事,或(b)"互不包含/mutually non-inclusive/neither is a subset"这类否定式现测结论,或(c)`export⊆read`/`subset`(Wave 2 WP3 的 `unreadCount`)等与 `isTemplateManager`/guard 无关的误命中——**零处**以现在时重申任一方向的包含关系。`routes/approvals.ts:406-440` 的三层递进撤回(`⊆`→`⊋`→"itself false"→"mutually non-inclusive")在 rebase 后原样保留、内容未变(rebase 只重放提交,不改内容)。

`scripts/dev/atg-verification-recount.sh`(exit 0):机械重数 `approval-template-groups-lifecycle.db.test.ts` + `-serialization.db.test.ts` 两文件的 `.status).toBe(4xx|500)`(20 处)与 `error.code).toBe('CODE')`(15 处,11 个不同码 + `APPROVAL_TEMPLATE_NOT_FOUND` 复用 2 处单独track)命中——数字与两份文档 §14/§24.5 一致,rebase 未引入新的裸 403/新码。

两脚本均为报告/计数工具(exit code 恒 0),真正的判据是人工读每一条命中的完整句子(见上),不是脚本自身的退出码。

**收尾复核:本文档写入后自身进入了 `atg-retraction-sweep.sh` 的扫描范围**(其扫描面是 `git diff --name-only origin/main..HEAD`,写入本文档的提交把它自己变成了这个 diff 的一部分),原始的一次运行结果已对不上当前分支头,按脚本自身「§5 任何进一步编辑后重跑」的说明重跑:命中本文档 `:33`(`guard⊆manager → guard⊋manager → 互不包含` 的压缩叙事,以否定式「互不包含」收尾,不是重申某个方向的包含)与 `:61`(逐字引用脚本自身的模式列表,做的是「这个脚本扫什么」的元描述,与脚本注释里引用同一组符号是同一类合法自指命中)——两处均为脚本自身分类规则下的合法命中,零处新增现在时包含断言。重跑还额外带出 15 个此前未见的文件(`packages/core-backend/src/di/identifiers.ts`/`src/routes/comments.ts`/`src/services/CommentService.ts` 等 comment 功能文件):核实是 `origin/main` 在本次执行期间从 `aebed089654f756a76b024a98e051f65e59a1969` 前进到了 `3c6c28958c2ce51334b8f02df13272ef0ae77889`(仓库有其它并行合并,与本 lane 无关),扩大了默认基线 `origin/main..HEAD` 的 diff 面,而不是本分支新引入了这些文件的改动——`git diff --name-only origin/main..27bb6edfe6cdca22d4a0265463f029a67722b795` 现场用固定的两个 SHA 复算恒定为 104(加本文档提交后 105),与新的完整命令行输出一致。这些新增文件里的全部 `subset` 命中(`mentionUnreadCount`/评论计数相关,4 处)与 `approvalTemplateAdminGuard`/`isTemplateManager` 无关,是模式误命中,不是本 lane 的遗留。

## 4. 三条 required 逐字复现

### `pnpm type-check`

仓根目录执行,退出码 0。`packages/core-backend`(`tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json`)与 `apps/web`(`vue-tsc -b` + 两个 verification 项目引用)均 `Done`,零报错。

### `CI=true pnpm --filter @metasheet/core-backend test`(全量)

仓根目录执行,`vitest`(默认 `vitest.config.ts`,不含 `DATABASE_URL`,四个 `approval-template-groups-*.db.test.ts` 按 exclude 名单跳过——与 CI 的无库 `test` job 行为一致):

```
Test Files  933 passed | 175 skipped (1108)
     Tests  14737 passed | 1604 skipped (16341)
```

全文件零 `FAIL`(`grep -c "^ FAIL"` = 0)。第一遍在后台跑(记录了完整 stdout,但没单独捕获 `$?`);为了拿到硬退出码,追加重跑一遍并显式 `echo "EXIT=$?"`——第二遍同样是 `EXIT=0`,`933 passed | 175 skipped (1108)` / `14737 passed | 1604 skipped (16341)`,与第一遍逐位一致,零 `FAIL`。

### `bash -e apps/web/scripts/run-required-web-tests.sh`

仓根目录执行,重复跑两遍,均 `EXIT_CODE=0`。第二遍(带显式 `echo "EXIT_CODE=$?"`)确认:

```
Test Files  466 passed (466)          # 脚本内最后一个 exec 段自身的小计
     Tests  7182 passed (7182)
EXIT_CODE=0
```

脚本由多段独立 `npx vitest run <tokens>` 调用串联、末段用 `exec` 替换 shell 进程;把全部段落的 `Test Files`/`Tests` 小计逐段相加(`grep -oE` 汇总,两次运行结果一致):**总计 568 个测试文件、9122 个用例全部 passed,零 failed,零 skipped**,全文件零 `FAIL`/`✗`/`×`(`grep -c` = 0)。本 lane 新增的前端分节 spec `tests/approvalTemplateCenterSections.spec.ts`(18 用例)在脚本最后一段(`exec` 段,末尾追加的 `approvalTemplateCenterSections` token)里确认执行并通过。

## 5. 结论

`git push --force-with-lease origin feat/approval-template-groups-phase3-sections` 前的三条 required 全绿,rebase 零冲突且逐项核验一致,四个真库文件 + 两个 A-1 脚本在新私有库 `metasheet2_lock_a4_rb` 上现场复核通过。分支头 `27bb6edfe6cdca22d4a0265463f029a67722b795`。
