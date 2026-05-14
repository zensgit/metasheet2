# Attendance and Directory Upstream Reconciliation Verification

## 验证环境

- 日期：2026-05-14
- 原工作区：`/Users/chouhua/Downloads/Github/metasheet2`
- 验证 worktree：`/Users/chouhua/Downloads/Github/metasheet2-attendance-directory-delivery-20260514`
- 验证分支：`codex/attendance-directory-delivery-20260514`
- 基线：最新 `origin/main`

## 分支边界复核

原工作区分支：

```text
codex/k3wise-workbench-release-publication-20260513
```

相对 `origin/main` 的提交包含：

```text
1272e99cd docs(delivery): summarize attendance and directory rollout
5d508d2b6 feat(directory): expose DingTalk organization mirror
1f1665c20 feat(attendance): add delegated import role
a388e8e64 feat(attendance): add report field catalog multitable layer
b3d482f09 docs(integration): record K3 workbench release publication
```

因为其中包含 K3Wise 文档提交，所以未直接推送该分支作为考勤/目录 PR。

## 上游合入复核

执行：

```bash
git log --oneline --grep='report field catalog\|delegate import\|directory org tree\|organization mirror' origin/main
```

确认 `origin/main` 已包含：

```text
cd67dabcb test(attendance): add report fields live acceptance harness
acae63881 docs(dingtalk): record directory org tree postdeploy verification (#1527)
a33de54d6 feat(attendance): add report field catalog foundation (#1529)
94c469459 feat(dingtalk): add directory org tree admin mirror (#1524)
ce96d5069 feat(attendance): delegate import operations
```

## 依赖准备

执行：

```bash
pnpm install --frozen-lockfile --prefer-offline
```

结果：通过。lockfile 已是最新，依赖从本地 pnpm store 复用，未下载新包。pnpm 提示部分依赖 build scripts 被忽略，这是当前 pnpm 安装策略提示，不影响本轮测试执行。

## 脚本语法与离线验收测试

执行：

```bash
node --check scripts/ops/attendance-report-fields-live-acceptance.mjs
node --check scripts/ops/attendance-report-fields-live-acceptance.test.mjs
pnpm run verify:attendance-report-fields:live:test
```

结果：

- 语法检查通过；
- live acceptance 离线测试通过：17/17。

## 后端目标测试

执行：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-import-permission.test.ts tests/unit/admin-directory-routes.test.ts --reporter=dot
```

结果：

```text
Test Files  3 passed (3)
Tests       36 passed (36)
```

## 前端目标测试

执行：

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-anchor-nav.spec.ts tests/attendance-admin-regressions.spec.ts tests/useAttendanceAdminProvisioning.spec.ts tests/directoryManagementView.spec.ts --watch=false
```

结果：

```text
Test Files  5 passed (5)
Tests       83 passed (83)
```

备注：测试启动时出现 `WebSocket server error: Port is already in use` 提示，但 Vitest 用例全部通过。

## 构建与类型检查

执行：

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web type-check
```

结果：均通过。

## 未执行项

未执行真实 live/staging 验收。原因是本轮没有可用的外部后端地址、短期 admin JWT 文件、真实 importer 账号和真实 DingTalk 目录同步数据。

真实验收应使用本地 owner-only token 文件，并避免在聊天、PR 描述或文档中暴露 JWT、appSecret、密码、webhook 或 `SEC`。

## 当前结论

最新 `origin/main` 已具备本轮目标能力：考勤统计字段底座、导入员权限和 DingTalk 组织镜像均可在主干找到等价实现，并通过本轮目标测试、后端 build 和前端 type-check。下一步应进入真实环境验收，而不是继续 cherry-pick 旧分支提交。
