# Directory Baseline Git Attest Verification

日期：2026-03-29

## 变更范围

- `scripts/ops/git-slice-attest.mjs`
- `scripts/ops/attest-remote-git-slice.sh`
- `scripts/ops/git-slices.mjs`
- `package.json`
- `docs/development/directory-baseline-git-attest-design-20260329.md`
- `docs/development/directory-baseline-git-attest-verification-20260329.md`
- `docs/development/remote-git-slice-attest-design-20260329.md`
- `docs/development/remote-git-slice-attest-verification-20260329.md`

## 本地验证

### 1. CLI 可用性

命令：

```bash
node scripts/ops/git-slice-attest.mjs --list-slices
node scripts/ops/git-slice-attest.mjs --slice directory-migration-baseline --list-groups
```

结果：

- 全部通过
- `directory-migration-baseline` 当前仍是 `5` 个 commit groups
- 当前 slice 已扩展到 `63` 个文件

### 2. attestation 证据模型增强

本轮 attestation 不再只比较 `patch-id`，而是同时比较：

- `patch-id`
- `numstatDigest`
- `summaryDigest`
- `pathSetDigest`
- `patchFileName` 布局

这样跨环境证明不再依赖单一归一化指纹，而是用“补丁内容 + 变更统计 + 路径集合 + 产物布局”的组合证据。

### 3. 刷新本地链路产物

命令：

```bash
pnpm materialize:git-slice:directory-migration-baseline
pnpm promote:git-slice:directory-migration-baseline
pnpm handoff:git-slice:directory-migration-baseline
pnpm verify:git-slice-replay:directory-migration-baseline
pnpm replay:git-slice:directory-migration-baseline
```

结果：

- materialized branch：
  - `materialized/directory-migration-baseline-2026-03-28-171207596z-70062-9a9665`
- materialized head：
  - `402047aba8df99a78c4d7dacf20971094ef07829`
- promoted branch：
  - `promoted/directory-migration-baseline-2026-03-28-171211339z-70930-6bc354`
- promoted head：
  - `b2c55366e41dce8ae8687a3fcf670e534d81ca88`
- handoff output：
  - `output/git-slice-handoffs/directory-migration-baseline`
- handoff bundle SHA-256：
  - `3bdcaa6b1e0a8fcda7c3b34a0f660bb1040bc09e7028d9bf06ce4532dfeeed93`
- replay verify output：
  - `output/git-slice-replays/verify-directory-migration-baseline`
- replay output：
  - `output/git-slice-replays/directory-migration-baseline`

### 4. 首轮 attest 暴露的真实边界

首次在远端旧产物还未刷新时执行：

```bash
pnpm verify:git-slice-attest:directory-migration-baseline
pnpm attest:git-slice:directory-migration-baseline
```

真实结果：

- `verifyPassed=false`
- 差异集中在：
  - `ops-baseline-tooling`
  - `migration-baseline-docs`

根因：

- 本地已切到 `63` 文件 slice
- 远端当时仍停留在旧的 `57` 文件链路产物
- `attest` 正确识别出跨环境不一致，而不是误报全绿

### 5. 远端刷新后补跑本地 attest

命令：

```bash
pnpm verify:git-slice-attest:directory-migration-baseline
pnpm attest:git-slice:directory-migration-baseline
```

结果：

- 全部通过
- verify output：
  - `output/git-slice-attestations/verify-directory-migration-baseline`
- attest output：
  - `output/git-slice-attestations/directory-migration-baseline`
- `verifyPassed=true`

顶层 invariants：

- `localRoundtripEquivalent=true`
- `remoteRoundtripEquivalent=true`
- `crossEnvironmentHandoffEquivalent=true`
- `crossEnvironmentReplayEquivalent=true`
- `allPatchIdsEquivalent=true`
- `allNumstatDigestsEquivalent=true`
- `allSummaryDigestsEquivalent=true`
- `allPathSetDigestsEquivalent=true`
- `patchFileNameLayoutEquivalent=true`

五个 commit groups 的本地基准证据：

- `core-backend-migration-cli`
  - `patchId=6e20c9ab781c260e9b911ce55b6cf3bc96af68cc`
  - `numstatDigest=cc494c7e22dc52513123cf2f30ea35dd3ea6659c5f3d5e21583fbbed71070b34`
  - `summaryDigest=a178370a8592308e07d7c1c1ce99336b94973ce1dbc26230ee12fb83e362332f`
  - `pathSetDigest=8dfdbdb1f7fcf619f43e583f8cc0763cf5b1b69a62eab5da3ad9d36f4030df16`
- `directory-iam-migrations`
  - `patchId=151ac579d7ae2aa6fd873e394198ad5639bf0466`
  - `numstatDigest=9c659b57ec1d369f67a075dadedcd541849e3acebc9df6730cad205a9a4c2fa4`
  - `summaryDigest=b7e7d83d28c4e83429bb81d5e90db406f16655fb47be19e0e6377cac284b12d2`
  - `pathSetDigest=2fd7049e87db331f0db375d68529b3157c5ff738b3f438791590a16ee18a023d`
- `ops-baseline-tooling`
  - `patchId=efd97f0ef82592a13b93c30a571b114d19c0788e`
  - `numstatDigest=39c46d5a80613fd4674fea2ce7ff5bb1bb5ac2132456c09eef3cb82daebdf530`
  - `summaryDigest=48955cd746ff6dac5f3fef6bb1c6e7e3af793feb4cf2819e4270a868d5842924`
  - `pathSetDigest=727c4bf9f5109a322a66ad9de618929cdb6d95af63c38acdefc0666a4f610ad6`
- `migration-audit-tests`
  - `patchId=5e51604a434073280906c6d3e7ebe0ce6ee6b979`
  - `numstatDigest=60f4afc2d0013c1251d8dc56d14a0854ad90af7a557006d34462fb6428402c30`
  - `summaryDigest=98a739fc273c931c0e00acb3a4e64f01a2c6f21c7668a3a68b26d6aac944c4a0`
  - `pathSetDigest=49bd61ffc54b40e2f3f24513619adc606d9e0ae86025b4bcdc42ea4c3b5c9405`
- `migration-baseline-docs`
  - `patchId=a93b285a5d3c9562127017d36170bec20237ff1a`
  - `numstatDigest=b71404e4c291379d6faf5f747afd9806c14594160d8dd4521e71f435efe61e4b`
  - `summaryDigest=d161df72b8822dc4509f281400fa57dcacd63100a009a5af9ff3e12c95c7ae58`
  - `pathSetDigest=aa1892244d690b8ae02e13adbc6835d9a3d85185242647affeafeb565e91e002`

## 结论

本地 Git baseline 工具链现在正式推进到：

1. report
2. sync-plan
3. bundle
4. apply
5. materialize
6. promote
7. handoff
8. replay
9. attest

也就是不仅能本地 replay / 远端 replay，还能用多因子证据证明本地和远端链路语义等价。

## 实际执行命令

```bash
node scripts/ops/git-slice-attest.mjs --list-slices
node scripts/ops/git-slice-attest.mjs --slice directory-migration-baseline --list-groups
pnpm materialize:git-slice:directory-migration-baseline
pnpm promote:git-slice:directory-migration-baseline
pnpm handoff:git-slice:directory-migration-baseline
pnpm verify:git-slice-replay:directory-migration-baseline
pnpm replay:git-slice:directory-migration-baseline
pnpm verify:git-slice-attest:directory-migration-baseline
pnpm attest:git-slice:directory-migration-baseline
```
