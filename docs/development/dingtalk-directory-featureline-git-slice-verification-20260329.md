# DingTalk Directory Featureline Git Slice Verification

日期：2026-03-29

## 验证目标

验证新定义的 `dingtalk-directory-featureline` slice 是否满足：

1. 业务边界完整
2. 文件路径全部可解析
3. commit groups 可用于后续正式收口
4. 当前与 upstream 的真实重叠被如实暴露
5. 可导出 patch 作为交接证据

## 执行命令

### 1. 切片范围报告

```bash
node scripts/ops/git-slice-report.mjs --slice dingtalk-directory-featureline --json
```

### 2. 切片同步计划与 patch 导出

```bash
node scripts/ops/git-slice-sync-plan.mjs \
  --slice dingtalk-directory-featureline \
  --patch-file output/git-slices/dingtalk-directory-featureline.patch \
  --json
```

## 结果

### 切片范围报告

结果：

- `files=73`
- `present=73`
- `missing=0`
- `trackedChanged=27`
- `untracked=46`

bucket 分布：

- `apps=18`
- `packages=21`
- `docs=29`
- `scripts=2`
- `root=2`
- `docker=1`

说明：

- 新增的 slice 设计 / 验证文档已经被纳入切片
- 当前切片没有 clean 文件，说明这是完整的业务增量面，不是零散补丁
- `node scripts/ops/git-slice-report.mjs --slice dingtalk-directory-featureline --verify --json` 已通过

### 同步计划

结果：

- `upstreamOnlyCount=4`
- `localOnlyCount=3`
- `sliceFilesCount=73`
- `dirtyStatus.changedCount=73`
- `dirtyStatus.trackedChangedCount=27`
- `dirtyStatus.untrackedCount=46`

关键门禁：

- `stageReadiness.safeToStage=false`
- `syncReadiness.githubSyncReady=false`

根因：

- 当前 slice 与 upstream behind 提交有真实路径重叠
- 当前重叠集中在 IAM 收口过的公共路径

重叠路径共 `14` 个：

- `apps/web/src/main.ts`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/views/LoginView.vue`
- `apps/web/src/views/SessionCenterView.vue`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/tests/loginView.spec.ts`
- `apps/web/tests/sessionCenterView.spec.ts`
- `apps/web/tests/userManagementView.spec.ts`
- `packages/core-backend/src/index.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/utils/error.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/auth.yml`

对应 upstream behind overlap commits：

1. `83767edbb95112e77fb63e2a7799d5cd7365cd34`
   `feat(iam): close runtime, auth-session, and contract gaps`
2. `de963c83c2feaa492fa9285be915c6545fd2f0e8`
   `fix(iam): preserve frontend error instance messages`

### patch 导出

结果：

- 文件：`output/git-slices/dingtalk-directory-featureline.patch`
- 当前导出成功
- 当前 patch 大小：`175912` bytes
- 可作为后续 handoff / recut / 审阅证据

## 结论

`dingtalk-directory-featureline` 当前验证结论是：

- 切片定义：通过
- 文件完整性：通过
- patch 导出：通过
- GitHub sync readiness：未通过

失败不是 slice 定义错误，而是当前主工作树与 upstream 仍然重叠。

## 下一步建议

1. 先处理这条 slice 与 upstream IAM 收口路径的重叠。
2. 再进入正式的 `materialize/promote/handoff` 链路。
3. 在那之前，不宣称这条业务线已经与 GitHub 同步。
