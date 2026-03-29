# Remote Git Slice Replay Verification

日期：2026-03-29

## 变更范围

- `scripts/ops/replay-remote-git-slice.sh`
- `scripts/ops/git-slice-replay.mjs`
- `scripts/ops/git-slice-handoff.mjs`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/remote-git-slice-replay-design-20260329.md`
- `docs/development/remote-git-slice-replay-verification-20260329.md`
- `docs/development/directory-baseline-git-replay-design-20260329.md`
- `docs/development/directory-baseline-git-replay-verification-20260329.md`

## 远端验证

### 1. 先刷新 remote materialized / promoted / handoff 来源

命令：

```bash
pnpm ops:materialize-remote-git-slice:directory-migration-baseline
pnpm ops:promote-remote-git-slice:directory-migration-baseline
pnpm ops:handoff-remote-git-slice:directory-migration-baseline
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
- remote handoff output：
  - `output/remote-git-slice-handoffs/directory-migration-baseline/handoff`
- remote handoff bundle SHA-256：
  - `6d3e314947f36a2eb77e947df33a04db12bd1aa92fc63492a22c3ab110200a9c`
- baseline 主工作树仍保持：
  - `HEAD=86d709e0247125d91753e85caaa07e0db892091d`
  - `dirty=0`

### 2. verify remote replay

命令：

```bash
pnpm verify:remote-git-slice-replay:directory-migration-baseline
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
- replay branch：
  - `replayed/directory-migration-baseline-2026-03-28-171355800z-229389-82198c`
- replayed head：
  - `4a9f9334b48ed54a75f831678d4b850e27dfa84a`
- verify output：
  - `output/remote-git-slice-replays/directory-migration-baseline/verify`

patch SHA 全量一致：

- `0001`：
  - `7f6ab2f5cec5f4eb0a456472e1e4bf88103196ba1e3d5300e0a28a8227a39504`
- `0002`：
  - `65130dff4d4637be100e42e8a27af61c7989885be4fe4f9f99ec429c7f911737`
- `0003`：
  - `cfd39a56045bb74359882bb547ffecee63fd038dab84f565550024a3cc8bbbed`
- `0004`：
  - `c36df29068d28a6cf85815e8a76f02524ec4220c23aaa22eb309bc816bc82174`
- `0005`：
  - `6eb4b58defc2d86979a1a15c6fe52976aafabfdbe7afc64054f949c5beb21771`

### 3. 正式 remote replay

命令：

```bash
pnpm ops:replay-remote-git-slice:directory-migration-baseline
```

结果：

- 通过
- replay branch：
  - `replayed/directory-migration-baseline-2026-03-28-171419280z-230151-d81858`
- replayed head：
  - `4a9f9334b48ed54a75f831678d4b850e27dfa84a`
- output：
  - `output/remote-git-slice-replays/directory-migration-baseline/replay`
- `verifyPassed=true`
- cleanup：
  - `replayRepoRemoved=true`
  - `branchDeleted=true`
  - `tempParentRemoved=true`

## 结论

远端 baseline clone 这条链现在已经推进到：

1. bootstrap
2. materialize
3. promote
4. handoff
5. replay

补充状态：

- 这轮 replay 使用的 remote materialized / promoted / handoff 来源都已经切到 `63` 文件 slice

并且 wrapper 已经能自动：

- 从 remote handoff manifest 解析 bundle / ref / base 信息
- 上传整批 handoff artifacts 到远端临时目录
- 在远端旁路 fresh repo 中完成 replay
- 回收 `report + README + replay summary + regenerated patches`

## 实际执行命令

```bash
pnpm ops:materialize-remote-git-slice:directory-migration-baseline
pnpm ops:promote-remote-git-slice:directory-migration-baseline
pnpm ops:handoff-remote-git-slice:directory-migration-baseline
pnpm verify:remote-git-slice-replay:directory-migration-baseline
pnpm ops:replay-remote-git-slice:directory-migration-baseline
```
