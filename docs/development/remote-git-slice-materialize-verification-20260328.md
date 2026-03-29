# Remote Git Slice Materialize Verification

日期：2026-03-28

## 变更范围

- `scripts/ops/materialize-remote-git-slice.sh`
- `scripts/ops/git-slice-materialize.mjs`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/directory-baseline-git-materialize-design-20260328.md`
- `docs/development/remote-git-slice-materialize-design-20260328.md`
- `docs/development/remote-git-slice-materialize-verification-20260328.md`
- `docs/development/dingtalk-directory-git-baseline-20260327.md`
- `docs/development/directory-migration-baseline-git-slice-20260328.md`
- `docs/verification-index.md`

## 本地与远端验证

### 1. 本地脚本语法与帮助输出

命令：

```bash
bash -n scripts/ops/materialize-remote-git-slice.sh
bash scripts/ops/materialize-remote-git-slice.sh --help
```

结果：

- 通过
- 参数已覆盖：
  - `host / user / identity-file`
  - `target-dir / deploy-dir`
  - `slice`
  - `verify`
  - `keep-remote-work-dir`
  - `local-output-dir`
  - `remote-work-root`
  - `json`

### 2. 本地 `--source-root` 通用能力复核

命令：

```bash
node scripts/ops/git-slice-materialize.mjs \
  --slice directory-migration-baseline \
  --group ops-baseline-tooling \
  --base-ref origin/codex/attendance-pr396-pr399-delivery-md-20260310 \
  --source-root . \
  --verify \
  --output-dir output/git-slice-materializations/local-ops-group \
  --json
```

结果：

- 通过
- `sourceRoot=/Users/huazhou/Downloads/Github/metasheet2`
- 单组 verify 成功生成 `1` 个 commit
- 自动清理完成：
  - `worktreeRemoved=true`
  - `branchDeleted=true`

### 3. 远端 verify 正式通过

命令：

```bash
bash scripts/ops/materialize-remote-git-slice.sh \
  --host 142.171.239.56 \
  --user mainuser \
  --identity-file ~/.ssh/metasheet2_deploy \
  --target-dir /home/mainuser/metasheet2-git-baseline \
  --deploy-dir /home/mainuser/metasheet2 \
  --slice directory-migration-baseline \
  --verify \
  --local-output-dir output/remote-git-slice-materializations/directory-migration-baseline/verify-direct \
  --json
```

结果：

- 通过
- wrapper 返回：
  - `remoteTransportExitCode=0`
  - `remoteCommandExitCode=0`
  - `verifyPassed=true`
- 远端 verify 报告：
  - `branchName=materialized/directory-migration-baseline-2026-03-28-150237965z-188377-478f93`
  - `head=f831ec0b50c9374d875e86a91e8a1743477998bd`
  - `commitCount=5`
  - `verifyMode=true`
  - `cleanup.worktreeRemoved=true`
  - `cleanup.branchDeleted=true`
- 本地已拉回 artifacts：
  - `output/remote-git-slice-materializations/directory-migration-baseline/verify-direct/report.json`
  - `output/remote-git-slice-materializations/directory-migration-baseline/verify-direct/artifacts/manifest.json`
  - `5` 个 patch 文件

### 4. 远端正式 materialize 通过

命令：

```bash
bash scripts/ops/materialize-remote-git-slice.sh \
  --host 142.171.239.56 \
  --user mainuser \
  --identity-file ~/.ssh/metasheet2_deploy \
  --target-dir /home/mainuser/metasheet2-git-baseline \
  --deploy-dir /home/mainuser/metasheet2 \
  --slice directory-migration-baseline \
  --local-output-dir output/remote-git-slice-materializations/directory-migration-baseline/materialized-direct \
  --json
```

结果：

- 通过
- wrapper 返回：
  - `remoteTransportExitCode=0`
  - `remoteCommandExitCode=0`
  - `verifyPassed=true`
- 远端正式 materialize 报告：
  - `branchName=materialized/directory-migration-baseline-2026-03-28-150131852z-187350-32dbcb`
  - `head=a0deed927d584b817a039258cfe812c2e3c37900`
  - `commitCount=5`
  - `verifyMode=false`
  - `cleanup.worktreeRemoved=true`
  - `cleanup.branchDeleted=false`
- wrapper 还确认了远端 branch 真实存在：
  - `remoteBranchHeadConfirmed=a0deed927d584b817a039258cfe812c2e3c37900`
- 本地已拉回 artifacts：
  - `output/remote-git-slice-materializations/directory-migration-baseline/materialized-direct/report.json`
  - `output/remote-git-slice-materializations/directory-migration-baseline/materialized-direct/artifacts/manifest.json`
  - `5` 个 patch 文件

### 5. 远端 baseline 主工作树后置复核

命令：

```bash
ssh -i ~/.ssh/metasheet2_deploy \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no \
  mainuser@142.171.239.56 \
  'cd /home/mainuser/metasheet2-git-baseline && \
    printf "head=%s\n" "$(git rev-parse HEAD)" && \
    printf "status=%s\n" "$(git status --porcelain | wc -l | tr -d " ")" && \
    printf "branch_exists=%s\n" "$(git rev-parse --verify materialized/directory-migration-baseline-2026-03-28-150131852z-187350-32dbcb 2>/dev/null)"'
```

结果：

- 通过
- 输出确认：
  - `head=86d709e0247125d91753e85caaa07e0db892091d`
  - `status=0`
  - `branch_exists=a0deed927d584b817a039258cfe812c2e3c37900`

说明远端 baseline clone 主分支仍保持干净，新的 materialized branch 已独立存在。

### 6. 打包噪声收口

在第一次远端运行时，payload 解包阶段会打印：

- `LIBARCHIVE.xattr.com.apple.provenance`

这是 macOS 本地打包时带入的扩展 header 噪声，不影响逻辑结果，但会污染验证输出。

已修复：

- payload 打包现在使用：
  - `COPYFILE_DISABLE=1`
  - `COPY_EXTENDED_ATTRIBUTES_DISABLE=1`
  - `tar --format ustar`

复测后，远端 verify 输出已无这类 warning。

## 结论

这轮验证说明远端 Git baseline 已不只是“能 clone、能 verify”：

1. 本地 slice 快照可通过 SSH 打包发到远端
2. 远端旁路 Git baseline clone 可以复现本地 `directory-migration-baseline`
3. `verify` 模式会在远端生成真实 `5` 提交序列后再自动清理 branch/worktree
4. 正式 materialize 会保留远端 branch，供后续 Git 收口
5. artifacts 会被拉回本地，形成 `report + manifest + patch` 的双端证据
6. 远端 baseline 主工作树仍保持 clean，不会被 materialize 污染

截至本轮，Git baseline 工具链已经从：

- 本地分析
- 本地物化

推进到：

- 远端旁路 Git baseline clone 可复现
- 本地/远端双端都有正式验证入口
- 后续 Git 收口可以直接围绕远端 materialized branch 继续推进 
