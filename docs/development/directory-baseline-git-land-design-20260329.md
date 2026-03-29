# Directory Baseline Git Land Design

日期：2026-03-29

## 背景

`directory-migration-baseline` 已经具备：

- materialize
- promote
- handoff
- replay
- attest
- submit

但 `submit` 仍然只是“这条 slice 已可正式交接”的证明，不等于“已经有一条可直接继续 Git 收口的 clean branch”。

## 目标

新增 `git-slice-land`：

1. 读取已经通过 `submit` 的 manifest
2. 在全新 worktree 中，以 `baseSha` 为起点重放这条 slice 的 commit 序列
3. 生成真正的 landed branch，而不是继续停留在理论上的交接包
4. 输出：
   - `manifest.json`
   - `report.json`
   - `landing-summary.md`
   - `README.md`
   - `landing-commands.sh`
   - per-group landed patch
5. 明确给出：
   - `branchReadyForPush`
   - `ahead/behind`
   - `dirty`
   - `upstreamConfigured`

## 设计原则

### 1. land 只消费 submit

`land` 不再直接读取 promote / handoff / replay / attest 四份 manifest，而是只接受 `submit manifest`。

原因：

- `submit` 已经给出这条 slice 是否具备正式交接资格
- `land` 的职责是把“可交接”推进为“可落地 clean branch”

### 2. land 不污染当前 dirty 主工作树

所有 landed branch 都在新 worktree 中生成。

因此：

- 当前主工作树继续保持 `ahead / behind / dirty`
- 但 landed branch 可以独立成为后续 Git 收口候选分支

### 3. landed branch 要面向真正 push

`land` 不只是生成一个 branch name，而是要验证：

- landed branch 以 `baseRef/baseSha` 为基线
- `behind=0`
- `ahead=commitCount`
- `dirty=false`
- upstream 能指向 `baseRef`

满足后才认为 `branchReadyForPush=true`

## 实现

脚本：

- `scripts/ops/git-slice-land.mjs`

输入：

- `--submit-manifest`

过程：

1. 校验 submit readiness：
   - `sliceReadyForSubmission=true`
   - promoted branch/head 存在
   - group 顺序与 slice 定义一致
2. 创建 landed worktree：
   - `git worktree add -b <landed-branch> <dir> <baseSha>`
3. 逐组 cherry-pick `submit.promote.groups[].promotedCommitSha`
4. 重新导出 landed patch
5. 计算 landed branch 状态：
   - `ahead/behind`
   - `dirty`
   - `branchReadyForPush`

## CLI

- `pnpm verify:git-slice-land:directory-migration-baseline`
- `pnpm print:git-slice-land:directory-migration-baseline`
- `pnpm print:git-slice-land:directory-migration-baseline:groups`
- `pnpm land:git-slice:directory-migration-baseline`

## 非目标

- 不直接 push GitHub
- 不修改当前主工作树
- 不替代 `submit`

## 预期收益

工具链推进为：

1. report
2. sync-plan
3. bundle
4. apply
5. materialize
6. promote
7. handoff
8. replay
9. attest
10. submit
11. land

也就是：从“可交接”推进到“已落地为 clean landed branch，可继续进入真正 Git 收口”。 
