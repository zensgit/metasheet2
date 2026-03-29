# Remote Git Slice Handoff Verification

日期：2026-03-29

## 变更范围

- `scripts/ops/handoff-remote-git-slice.sh`
- `scripts/ops/git-slice-handoff.mjs`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/remote-git-slice-handoff-design-20260329.md`
- `docs/development/remote-git-slice-handoff-verification-20260329.md`
- `docs/development/directory-baseline-git-handoff-design-20260329.md`
- `docs/development/directory-baseline-git-handoff-verification-20260329.md`

## 远端验证

### 1. 先刷新 remote materialized / promoted source

命令：

```bash
pnpm ops:materialize-remote-git-slice:directory-migration-baseline
pnpm ops:promote-remote-git-slice:directory-migration-baseline
```

结果：

- remote materialized branch：
  - `materialized/directory-migration-baseline-2026-03-28-171302290z-226987-6e5313`
- remote materialized head：
  - `aac7f496d7172913573d7630345b3bfe6a158c16`
- remote promoted branch：
  - `promoted/directory-migration-baseline-2026-03-28-171321621z-227892-9a2038`
- remote promoted head：
  - `4a9f9334b48ed54a75f831678d4b850e27dfa84a`
- baseline 主工作树仍保持：
  - `HEAD=86d709e0247125d91753e85caaa07e0db892091d`
  - `dirty=0`

### 2. 直接 verify handoff

命令：

```bash
pnpm verify:remote-git-slice-handoff:directory-migration-baseline
```

结果：

- 通过
- `remoteTransportExitCode=0`
- `remoteCommandExitCode=0`
- `verifyPassed=true`
- source branch：
  - `promoted/directory-migration-baseline-2026-03-28-171321621z-227892-9a2038`
- source head：
  - `4a9f9334b48ed54a75f831678d4b850e27dfa84a`
- verify output：
  - `output/remote-git-slice-handoffs/directory-migration-baseline/verify`
- remote bundle SHA-256：
  - `6d3e314947f36a2eb77e947df33a04db12bd1aa92fc63492a22c3ab110200a9c`
- patch 数量：
  - `5`
- 回收产物：
  - `report.json`
  - `exit-code`
  - `artifacts/manifest.json`
  - `artifacts/README.md`
  - `artifacts/commit-summary.md`
  - `artifacts/directory-migration-baseline.bundle`
  - `artifacts/patches/*.patch`

### 3. 直接正式 handoff

命令：

```bash
pnpm ops:handoff-remote-git-slice:directory-migration-baseline
```

结果：

- 通过
- source branch：
  - `promoted/directory-migration-baseline-2026-03-28-171321621z-227892-9a2038`
- source head：
  - `4a9f9334b48ed54a75f831678d4b850e27dfa84a`
- output：
  - `output/remote-git-slice-handoffs/directory-migration-baseline/handoff`
- remote bundle SHA-256：
  - `6d3e314947f36a2eb77e947df33a04db12bd1aa92fc63492a22c3ab110200a9c`
- `verifyPassed=true`

### 4. 远端宿主机复核

命令：

```bash
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
  mainuser@142.171.239.56 \
  'cd /home/mainuser/metasheet2-git-baseline && printf "head=%s\n" "$(git rev-parse HEAD)" && printf "status=%s\n" "$(git status --porcelain | wc -l | tr -d " ")" && printf "branch_exists=%s\n" "$(git rev-parse promoted/directory-migration-baseline-2026-03-28-171321621z-227892-9a2038)"'
```

结果：

- `head=86d709e0247125d91753e85caaa07e0db892091d`
- `status=0`
- `branch_exists=4a9f9334b48ed54a75f831678d4b850e27dfa84a`

说明：

- 远端 baseline 主工作树仍 clean
- remote handoff 只消费 promoted source branch，不污染 baseline 主工作树

## 结论

远端 baseline clone 这条链现在已经推进到：

1. bootstrap
2. materialize
3. promote
4. handoff

并且 wrapper 已能自动：

- 从 remote promote report 解析 source branch
- 回收 handoff 产物
- 在本地形成正式 handoff 归档目录
- 与 `63` 文件 slice 保持一致

## 实际执行命令

```bash
pnpm ops:materialize-remote-git-slice:directory-migration-baseline
pnpm ops:promote-remote-git-slice:directory-migration-baseline
pnpm verify:remote-git-slice-handoff:directory-migration-baseline
pnpm ops:handoff-remote-git-slice:directory-migration-baseline
ssh -i ~/.ssh/metasheet2_deploy -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no mainuser@142.171.239.56 'cd /home/mainuser/metasheet2-git-baseline && printf "head=%s\n" "$(git rev-parse HEAD)" && printf "status=%s\n" "$(git status --porcelain | wc -l | tr -d " ")" && printf "branch_exists=%s\n" "$(git rev-parse promoted/directory-migration-baseline-2026-03-28-171321621z-227892-9a2038)"'
```
