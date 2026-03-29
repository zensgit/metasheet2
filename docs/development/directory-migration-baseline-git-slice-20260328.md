# Directory Migration Baseline Git Slice

日期：2026-03-28

## 目标

把“目录 / IAM migration 基线修复”从当前大面积 dirty worktree 中切成一组可追溯、可独立提交的文件集合，避免后续 GitHub 收口时再次把无关改动混进来。

## 当前基线事实

复核命令：

```bash
git fetch origin --prune
node scripts/ops/git-baseline-report.mjs
node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline
```

当前状态：

- 分支：`codex/attendance-pr396-pr399-delivery-md-20260310`
- upstream：`origin/codex/attendance-pr396-pr399-delivery-md-20260310`
- 相对远端：`ahead 3 / behind 4`
- dirty：`370` 个变更项
- 当前 slice：`82` 个文件，commit groups 规模为 `5 / 6 / 24 / 2 / 45`，已具备正式 commit groups、safe apply 工具、本地临时 worktree materialize / promote / handoff / replay / attest / submit / land / publish 工具和远端 baseline materialize / promote / handoff / replay / attest / submit / land / publish 工具

结论：

- 当前仓库不能宣称“已同步到 GitHub”
- 但可以先把本轮 migration 基线修复切成单独提交序列
- 且现在可以直接用切片脚本输出 stage 命令，而不是只靠人工照着文档挑文件
- 并且现在已经可以用 safe apply 工具预演每个 commit group 的 staged 结果
- 并且现在已经可以把整条 slice 物化成正式临时 branch 和真实 commit 序列
- 并且现在已经可以在 `142.171.239.56:/home/mainuser/metasheet2-git-baseline` 上复现同一条 slice
- 并且现在已经可以把已物化提交链 replay 成 clean promoted branch
- 并且现在已经可以把 promoted branch 打包成最终 handoff 交接产物
- 并且现在已经可以在 fresh Git repo 中 replay handoff 产物并校验 patch SHA 完全一致
- 并且现在已经可以用 `patch-id + numstat + summary + path-set + patch file name` 五类证据对本地与远端链路做正式 attestation
- 并且现在已经可以把 `promote + handoff + replay + attest` 汇总成最终 submit packet，并明确区分 `sliceReadyForSubmission` 与 `currentWorktreeReadyForPush`
- 并且现在已经可以把 clean landed branch 继续封装成 publish bundle / request-pull / commands / summary，并对“未 push GitHub 时 request-pull 远端失败”做稳定降级

## 建议切片范围

### 1. core backend migration CLI

已跟踪修改：

- `packages/core-backend/package.json`
- `packages/core-backend/src/db/migrate.ts`
- `packages/core-backend/src/db/types.ts`

未跟踪新增：

- `packages/core-backend/src/db/migration-audit.ts`
- `packages/core-backend/src/db/migration-health.ts`

### 2. 目录 / IAM 必需 migration

未跟踪新增：

- `packages/core-backend/src/db/migrations/zzzz20260323120000_create_user_external_identities.ts`
- `packages/core-backend/src/db/migrations/zzzz20260323133000_harden_user_external_identities.ts`
- `packages/core-backend/src/db/migrations/zzzz20260324143000_create_user_external_auth_grants.ts`
- `packages/core-backend/src/db/migrations/zzzz20260324150000_create_directory_sync_tables.ts`
- `packages/core-backend/src/db/migrations/zzzz20260325100000_add_mobile_to_users_table.ts`
- `packages/core-backend/src/db/migrations/zzzz20260327110000_create_directory_template_center_and_alerts.ts`

### 3. 定向测试

未跟踪新增：

- `packages/core-backend/tests/unit/migration-audit.test.ts`
- `packages/core-backend/tests/unit/migration-health.test.ts`

### 4. ops baseline tooling

已跟踪修改：

- `package.json`

未跟踪新增：

- `scripts/ops/git-baseline-report.mjs`
- `scripts/ops/git-slice-apply.mjs`
- `scripts/ops/git-slice-bundle.mjs`
- `scripts/ops/git-slice-materialize.mjs`
- `scripts/ops/git-slice-handoff.mjs`
- `scripts/ops/git-slice-land.mjs`
- `scripts/ops/git-slice-promote.mjs`
- `scripts/ops/git-slice-publish.mjs`
- `scripts/ops/git-slice-replay.mjs`
- `scripts/ops/git-slice-attest.mjs`
- `scripts/ops/git-slice-submit.mjs`
- `scripts/ops/materialize-remote-git-slice.sh`
- `scripts/ops/handoff-remote-git-slice.sh`
- `scripts/ops/promote-remote-git-slice.sh`
- `scripts/ops/publish-remote-git-slice.sh`
- `scripts/ops/replay-remote-git-slice.sh`
- `scripts/ops/attest-remote-git-slice.sh`
- `scripts/ops/submit-remote-git-slice.sh`
- `scripts/ops/land-remote-git-slice.sh`
- `scripts/ops/git-slices.mjs`
- `scripts/ops/git-slice-report.mjs`
- `scripts/ops/git-slice-sync-plan.mjs`
- `scripts/ops/install-user-node-runtime.sh`

### 5. 设计 / 验证 / Git 基线文档

未跟踪新增：

- `docs/development/directory-baseline-git-apply-design-20260328.md`
- `docs/development/directory-baseline-git-apply-verification-20260328.md`
- `docs/development/directory-baseline-git-bundle-design-20260328.md`
- `docs/development/directory-baseline-git-bundle-verification-20260328.md`
- `docs/development/directory-baseline-git-materialize-design-20260328.md`
- `docs/development/directory-baseline-git-materialize-verification-20260328.md`
- `docs/development/directory-baseline-git-handoff-design-20260329.md`
- `docs/development/directory-baseline-git-handoff-verification-20260329.md`
- `docs/development/directory-baseline-git-replay-design-20260329.md`
- `docs/development/directory-baseline-git-replay-verification-20260329.md`
- `docs/development/directory-baseline-git-attest-design-20260329.md`
- `docs/development/directory-baseline-git-attest-verification-20260329.md`
- `docs/development/directory-baseline-git-submit-design-20260329.md`
- `docs/development/directory-baseline-git-submit-verification-20260329.md`
- `docs/development/directory-baseline-git-promote-design-20260328.md`
- `docs/development/directory-baseline-git-promote-verification-20260328.md`
- `docs/development/directory-baseline-git-publish-design-20260329.md`
- `docs/development/directory-baseline-git-publish-verification-20260329.md`
- `docs/development/remote-git-slice-materialize-design-20260328.md`
- `docs/development/remote-git-slice-materialize-verification-20260328.md`
- `docs/development/remote-git-slice-handoff-design-20260329.md`
- `docs/development/remote-git-slice-handoff-verification-20260329.md`
- `docs/development/remote-git-slice-promote-design-20260328.md`
- `docs/development/remote-git-slice-promote-verification-20260328.md`
- `docs/development/remote-git-slice-replay-design-20260329.md`
- `docs/development/remote-git-slice-replay-verification-20260329.md`
- `docs/development/remote-git-slice-attest-design-20260329.md`
- `docs/development/remote-git-slice-attest-verification-20260329.md`
- `docs/development/remote-git-slice-submit-design-20260329.md`
- `docs/development/remote-git-slice-submit-verification-20260329.md`
- `docs/development/remote-git-slice-publish-design-20260329.md`
- `docs/development/remote-git-slice-publish-verification-20260329.md`
- `docs/development/directory-baseline-git-sync-plan-design-20260328.md`
- `docs/development/directory-baseline-git-sync-plan-verification-20260328.md`
- `docs/development/directory-baseline-host-runtime-and-git-slice-design-20260328.md`
- `docs/development/directory-baseline-host-runtime-and-git-slice-verification-20260328.md`
- `docs/development/directory-migration-baseline-hardening-design-20260327.md`
- `docs/development/directory-migration-baseline-hardening-verification-20260327.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/verification-index.md`

## 建议提交顺序

### 提交 1

`feat(core-backend): add migration audit cli and stable ordering`

包含：

- `packages/core-backend/package.json`
- `packages/core-backend/src/db/migrate.ts`
- `packages/core-backend/src/db/migration-audit.ts`
- `packages/core-backend/src/db/migration-health.ts`
- `packages/core-backend/src/db/types.ts`

### 提交 2

`feat(core-backend): add required directory iam migrations`

包含：

- 6 条目录 / IAM migration 文件

### 提交 3

`chore(ops): add baseline slice sync and host runtime tooling`

包含：

- `package.json`
- `scripts/ops/git-baseline-report.mjs`
- `scripts/ops/git-slice-apply.mjs`
- `scripts/ops/git-slice-bundle.mjs`
- `scripts/ops/git-slice-handoff.mjs`
- `scripts/ops/git-slice-land.mjs`
- `scripts/ops/git-slice-materialize.mjs`
- `scripts/ops/git-slice-promote.mjs`
- `scripts/ops/git-slice-publish.mjs`
- `scripts/ops/git-slice-replay.mjs`
- `scripts/ops/git-slice-attest.mjs`
- `scripts/ops/git-slice-submit.mjs`
- `scripts/ops/git-slices.mjs`
- `scripts/ops/git-slice-report.mjs`
- `scripts/ops/git-slice-sync-plan.mjs`
- `scripts/ops/install-user-node-runtime.sh`
- `scripts/ops/materialize-remote-git-slice.sh`
- `scripts/ops/handoff-remote-git-slice.sh`
- `scripts/ops/land-remote-git-slice.sh`
- `scripts/ops/promote-remote-git-slice.sh`
- `scripts/ops/publish-remote-git-slice.sh`
- `scripts/ops/replay-remote-git-slice.sh`
- `scripts/ops/attest-remote-git-slice.sh`
- `scripts/ops/submit-remote-git-slice.sh`

### 提交 4

`test(core-backend): cover migration audit and compatibility`

包含：

- `packages/core-backend/tests/unit/migration-audit.test.ts`
- `packages/core-backend/tests/unit/migration-health.test.ts`

### 提交 5

`docs: record migration baseline hardening and git slice`

包含：

- `docs/development/directory-baseline-git-apply-design-20260328.md`
- `docs/development/directory-baseline-git-apply-verification-20260328.md`
- `docs/development/directory-baseline-git-bundle-design-20260328.md`
- `docs/development/directory-baseline-git-bundle-verification-20260328.md`
- `docs/development/directory-baseline-git-handoff-design-20260329.md`
- `docs/development/directory-baseline-git-handoff-verification-20260329.md`
- `docs/development/directory-baseline-git-land-design-20260329.md`
- `docs/development/directory-baseline-git-land-verification-20260329.md`
- `docs/development/directory-baseline-git-replay-design-20260329.md`
- `docs/development/directory-baseline-git-replay-verification-20260329.md`
- `docs/development/directory-baseline-git-attest-design-20260329.md`
- `docs/development/directory-baseline-git-attest-verification-20260329.md`
- `docs/development/directory-baseline-git-submit-design-20260329.md`
- `docs/development/directory-baseline-git-submit-verification-20260329.md`
- `docs/development/directory-baseline-git-materialize-design-20260328.md`
- `docs/development/directory-baseline-git-materialize-verification-20260328.md`
- `docs/development/directory-baseline-git-promote-design-20260328.md`
- `docs/development/directory-baseline-git-promote-verification-20260328.md`
- `docs/development/directory-baseline-git-publish-design-20260329.md`
- `docs/development/directory-baseline-git-publish-verification-20260329.md`
- `docs/development/remote-git-slice-handoff-design-20260329.md`
- `docs/development/remote-git-slice-handoff-verification-20260329.md`
- `docs/development/remote-git-slice-land-design-20260329.md`
- `docs/development/remote-git-slice-land-verification-20260329.md`
- `docs/development/remote-git-slice-materialize-design-20260328.md`
- `docs/development/remote-git-slice-materialize-verification-20260328.md`
- `docs/development/remote-git-slice-promote-design-20260328.md`
- `docs/development/remote-git-slice-promote-verification-20260328.md`
- `docs/development/remote-git-slice-publish-design-20260329.md`
- `docs/development/remote-git-slice-publish-verification-20260329.md`
- `docs/development/remote-git-slice-replay-design-20260329.md`
- `docs/development/remote-git-slice-replay-verification-20260329.md`
- `docs/development/remote-git-slice-attest-design-20260329.md`
- `docs/development/remote-git-slice-attest-verification-20260329.md`
- `docs/development/remote-git-slice-submit-design-20260329.md`
- `docs/development/remote-git-slice-submit-verification-20260329.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/verification-index.md`
- `docs/development/directory-baseline-git-sync-plan-design-20260328.md`
- `docs/development/directory-baseline-git-sync-plan-verification-20260328.md`
- `docs/development/directory-baseline-host-runtime-and-git-slice-design-20260328.md`
- `docs/development/directory-baseline-host-runtime-and-git-slice-verification-20260328.md`
- `docs/development/directory-migration-baseline-hardening-design-20260327.md`
- `docs/development/directory-migration-baseline-hardening-verification-20260327.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/verification-index.md`

## 每个提交的最小验证

### 提交 1 后

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec node --import tsx src/db/migrate.ts --help
pnpm --filter @metasheet/core-backend exec node --import tsx src/db/migrate.ts --audit --json
```

### 提交 2 后

```bash
pnpm --filter @metasheet/core-backend exec node --import tsx src/db/migrate.ts --list --json
```

### 提交 3 后

```bash
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --group ops-baseline-tooling --json
node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --group ops-baseline-tooling --apply --index-file output/git-slice-applies/persisted/ops.index --json
node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --json
node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --stage-command
node scripts/ops/git-slice-materialize.mjs --slice directory-migration-baseline --verify --output-dir output/git-slice-materializations/verify-directory-migration-baseline --json
node scripts/ops/git-slice-promote.mjs --slice directory-migration-baseline --manifest output/git-slice-materializations/directory-migration-baseline/manifest.json --verify --output-dir output/git-slice-promotions/verify-directory-migration-baseline --json
node scripts/ops/git-slice-handoff.mjs --slice directory-migration-baseline --manifest output/git-slice-promotions/directory-migration-baseline/manifest.json --verify --output-dir output/git-slice-handoffs/verify-directory-migration-baseline --json
node scripts/ops/git-slice-replay.mjs --slice directory-migration-baseline --manifest output/git-slice-handoffs/directory-migration-baseline/manifest.json --verify --output-dir output/git-slice-replays/verify-directory-migration-baseline --json
node scripts/ops/git-slice-attest.mjs --slice directory-migration-baseline --verify --output-dir output/git-slice-attestations/verify-directory-migration-baseline --json
node scripts/ops/git-slice-submit.mjs --slice directory-migration-baseline --promote-manifest output/git-slice-promotions/directory-migration-baseline/manifest.json --handoff-manifest output/git-slice-handoffs/directory-migration-baseline/manifest.json --replay-manifest output/git-slice-replays/directory-migration-baseline/manifest.json --attest-manifest output/git-slice-attestations/directory-migration-baseline/manifest.json --verify --output-dir output/git-slice-submissions/verify-directory-migration-baseline --json
node scripts/ops/git-slice-land.mjs --slice directory-migration-baseline --submit-manifest output/git-slice-submissions/directory-migration-baseline/manifest.json --verify --output-dir output/git-slice-landings/verify-directory-migration-baseline --json
node scripts/ops/git-slice-publish.mjs --slice directory-migration-baseline --land-manifest output/git-slice-landings/directory-migration-baseline/manifest.json --verify --output-dir output/git-slice-publishes/verify-directory-migration-baseline --json
node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --json
bash scripts/ops/materialize-remote-git-slice.sh --slice directory-migration-baseline --verify --json
bash scripts/ops/promote-remote-git-slice.sh --slice directory-migration-baseline --verify --json
bash scripts/ops/handoff-remote-git-slice.sh --slice directory-migration-baseline --verify --json
bash scripts/ops/replay-remote-git-slice.sh --slice directory-migration-baseline --verify --json
bash scripts/ops/attest-remote-git-slice.sh --slice directory-migration-baseline --verify --json
bash scripts/ops/submit-remote-git-slice.sh --slice directory-migration-baseline --verify --json
bash scripts/ops/land-remote-git-slice.sh --slice directory-migration-baseline --verify --json
bash scripts/ops/publish-remote-git-slice.sh --slice directory-migration-baseline --verify --json
```

### 提交 4 后

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/migration-audit.test.ts \
  tests/unit/migration-health.test.ts
```

### 提交 5 后

- 仅文档复核，无额外构建要求

## 远端关联状态

`142.171.239.56` 当前已完成：

- `packages/core-backend` ownership 修复为 `mainuser:mainuser`
- 关键 migration / audit / 文档文件已同步回宿主机源码目录
- `metasheet-backend` 容器内 `--audit` 终态绿色
- `trackedMigrations.executedCount=66`
- `trackedMigrations.pendingCount=0`

但这仍不等于 GitHub 已同步。

## 后续动作

1. 先基于本切片整理 commit，不要直接在 370 个脏文件上混提。
2. 再处理当前分支 `behind 4` 的问题，避免提交后马上再被远端打散。
3. 最后才做 push / PR / GitHub 收口。

## 关联脚本

- `node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline`
- `node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --json`
- `node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --stage-command`
- `node scripts/ops/git-slice-bundle.mjs --slice directory-migration-baseline --export-dir output/git-slice-bundles/directory-migration-baseline --json`
- `node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline`
- `node scripts/ops/git-slice-promote.mjs --slice directory-migration-baseline --manifest output/git-slice-materializations/directory-migration-baseline/manifest.json --json`
- `node scripts/ops/git-slice-handoff.mjs --slice directory-migration-baseline --manifest output/git-slice-promotions/directory-migration-baseline/manifest.json --json`
- `node scripts/ops/git-slice-handoff.mjs --slice directory-migration-baseline --manifest output/git-slice-promotions/directory-migration-baseline/manifest.json --group ops-baseline-tooling --json`
- `node scripts/ops/git-slice-submit.mjs --slice directory-migration-baseline --promote-manifest output/git-slice-promotions/directory-migration-baseline/manifest.json --handoff-manifest output/git-slice-handoffs/directory-migration-baseline/manifest.json --replay-manifest output/git-slice-replays/directory-migration-baseline/manifest.json --attest-manifest output/git-slice-attestations/directory-migration-baseline/manifest.json --json`
- `node scripts/ops/git-slice-land.mjs --slice directory-migration-baseline --submit-manifest output/git-slice-submissions/directory-migration-baseline/manifest.json --json`
- `node scripts/ops/git-slice-publish.mjs --slice directory-migration-baseline --land-manifest output/git-slice-landings/directory-migration-baseline/manifest.json --json`
- `bash scripts/ops/promote-remote-git-slice.sh --slice directory-migration-baseline --json`
- `bash scripts/ops/handoff-remote-git-slice.sh --slice directory-migration-baseline --json`
- `bash scripts/ops/submit-remote-git-slice.sh --slice directory-migration-baseline --json`
- `bash scripts/ops/land-remote-git-slice.sh --slice directory-migration-baseline --json`
- `bash scripts/ops/publish-remote-git-slice.sh --slice directory-migration-baseline --json`
- `node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --json`
- `node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --list-groups`
- `node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --group ops-baseline-tooling --json`
- `node scripts/ops/git-slice-apply.mjs --slice directory-migration-baseline --export-dir output/git-slice-applies/directory-migration-baseline --json`
- `node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline`
- `node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --json`
- `node scripts/ops/git-slice-report.mjs --slice directory-migration-baseline --stage-command`
- `node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline`
- `node scripts/ops/git-slice-sync-plan.mjs --slice directory-migration-baseline --stage-command`
- `pnpm verify:git-slice:directory-migration-baseline`
- `pnpm verify:git-slice-apply:directory-migration-baseline`
- `pnpm print:git-slice-apply:directory-migration-baseline:groups`
- `pnpm export:git-slice-apply:directory-migration-baseline`
