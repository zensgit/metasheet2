# Remote Git Slice Attest Verification

日期：2026-03-29

## 变更范围

- `scripts/ops/attest-remote-git-slice.sh`
- `scripts/ops/git-slice-attest.mjs`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/remote-git-slice-attest-design-20260329.md`
- `docs/development/remote-git-slice-attest-verification-20260329.md`
- `docs/development/directory-baseline-git-attest-design-20260329.md`
- `docs/development/directory-baseline-git-attest-verification-20260329.md`

## 远端验证

### 1. 刷新 remote materialized / promoted / handoff / replay 来源

命令：

```bash
pnpm ops:materialize-remote-git-slice:directory-migration-baseline
pnpm ops:promote-remote-git-slice:directory-migration-baseline
pnpm ops:handoff-remote-git-slice:directory-migration-baseline
pnpm verify:remote-git-slice-replay:directory-migration-baseline
pnpm ops:replay-remote-git-slice:directory-migration-baseline
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
- remote handoff bundle SHA-256：
  - `6d3e314947f36a2eb77e947df33a04db12bd1aa92fc63492a22c3ab110200a9c`
- remote replay verify output：
  - `output/remote-git-slice-replays/directory-migration-baseline/verify`
- remote replay output：
  - `output/remote-git-slice-replays/directory-migration-baseline/replay`
- baseline 主工作树保持：
  - `HEAD=86d709e0247125d91753e85caaa07e0db892091d`
  - `dirty=0`

### 2. verify remote attest

命令：

```bash
pnpm verify:remote-git-slice-attest:directory-migration-baseline
```

结果：

- 通过
- `verifyPassed=true`
- verify output：
  - `output/remote-git-slice-attestations/directory-migration-baseline/verify`
- invariants 全绿：
  - `localRoundtripEquivalent=true`
  - `remoteRoundtripEquivalent=true`
  - `crossEnvironmentHandoffEquivalent=true`
  - `crossEnvironmentReplayEquivalent=true`
  - `allPatchIdsEquivalent=true`
  - `allNumstatDigestsEquivalent=true`
  - `allSummaryDigestsEquivalent=true`
  - `allPathSetDigestsEquivalent=true`
  - `patchFileNameLayoutEquivalent=true`

### 3. 正式 remote attest

命令：

```bash
pnpm ops:attest-remote-git-slice:directory-migration-baseline
```

结果：

- 通过
- `verifyPassed=true`
- attest output：
  - `output/remote-git-slice-attestations/directory-migration-baseline/attest`
- summary：
  - `output/remote-git-slice-attestations/directory-migration-baseline/attest/attestation-summary.md`
- readme：
  - `output/remote-git-slice-attestations/directory-migration-baseline/attest/README.md`

### 4. 远端五组证据与本地对齐

远端 attestation 最终与本地完全一致：

- `core-backend-migration-cli`
  - `numstatDigest=cc494c7e22dc52513123cf2f30ea35dd3ea6659c5f3d5e21583fbbed71070b34`
  - `summaryDigest=a178370a8592308e07d7c1c1ce99336b94973ce1dbc26230ee12fb83e362332f`
  - `pathSetDigest=8dfdbdb1f7fcf619f43e583f8cc0763cf5b1b69a62eab5da3ad9d36f4030df16`
- `directory-iam-migrations`
  - `numstatDigest=9c659b57ec1d369f67a075dadedcd541849e3acebc9df6730cad205a9a4c2fa4`
  - `summaryDigest=b7e7d83d28c4e83429bb81d5e90db406f16655fb47be19e0e6377cac284b12d2`
  - `pathSetDigest=2fd7049e87db331f0db375d68529b3157c5ff738b3f438791590a16ee18a023d`
- `ops-baseline-tooling`
  - `numstatDigest=39c46d5a80613fd4674fea2ce7ff5bb1bb5ac2132456c09eef3cb82daebdf530`
  - `summaryDigest=48955cd746ff6dac5f3fef6bb1c6e7e3af793feb4cf2819e4270a868d5842924`
  - `pathSetDigest=727c4bf9f5109a322a66ad9de618929cdb6d95af63c38acdefc0666a4f610ad6`
- `migration-audit-tests`
  - `numstatDigest=60f4afc2d0013c1251d8dc56d14a0854ad90af7a557006d34462fb6428402c30`
  - `summaryDigest=98a739fc273c931c0e00acb3a4e64f01a2c6f21c7668a3a68b26d6aac944c4a0`
  - `pathSetDigest=49bd61ffc54b40e2f3f24513619adc606d9e0ae86025b4bcdc42ea4c3b5c9405`
- `migration-baseline-docs`
  - `numstatDigest=b71404e4c291379d6faf5f747afd9806c14594160d8dd4521e71f435efe61e4b`
  - `summaryDigest=d161df72b8822dc4509f281400fa57dcacd63100a009a5af9ff3e12c95c7ae58`
  - `pathSetDigest=aa1892244d690b8ae02e13adbc6835d9a3d85185242647affeafeb565e91e002`

## 结论

远端 baseline clone 这条链已经推进到：

1. bootstrap
2. materialize
3. promote
4. handoff
5. replay
6. attest

并且这一步不是只证明“远端能跑通”，而是正式证明：

- 远端 handoff 与本地 handoff 语义等价
- 远端 replay 与本地 replay 语义等价
- 四条链路在 `patch-id / numstat / summary / path-set / patch file name` 五类证据上完全一致

## 实际执行命令

```bash
pnpm ops:materialize-remote-git-slice:directory-migration-baseline
pnpm ops:promote-remote-git-slice:directory-migration-baseline
pnpm ops:handoff-remote-git-slice:directory-migration-baseline
pnpm verify:remote-git-slice-replay:directory-migration-baseline
pnpm ops:replay-remote-git-slice:directory-migration-baseline
pnpm verify:remote-git-slice-attest:directory-migration-baseline
pnpm ops:attest-remote-git-slice:directory-migration-baseline
```
