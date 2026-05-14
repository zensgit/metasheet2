# Attendance and Directory Upstream Reconciliation Development

## 背景

本轮目标原本是将当前分支上的考勤统计字段、多维表底座、导入员权限和 DingTalk 组织镜像整理成一个可推送、可 review 的 PR。执行前先复核分支边界，发现原工作区分支 `codex/k3wise-workbench-release-publication-20260513` 相对 `origin/main` 仍包含 K3Wise 发布文档提交，不适合直接作为考勤/目录 PR 推送。

为避免污染原工作区未跟踪文件，本轮创建了独立 worktree：

```text
/Users/chouhua/Downloads/Github/metasheet2-attendance-directory-delivery-20260514
```

并基于最新 `origin/main` 新建分支：

```text
codex/attendance-directory-delivery-20260514
```

## 执行发现

从最新 `origin/main` 复核后，目标主线已经通过等价提交合入主干：

```text
a33de54d6 feat(attendance): add report field catalog foundation (#1529)
ce96d5069 feat(attendance): delegate import operations
94c469459 feat(dingtalk): add directory org tree admin mirror (#1524)
cd67dabcb test(attendance): add report fields live acceptance harness
acae63881 docs(dingtalk): record directory org tree postdeploy verification (#1527)
```

尝试 cherry-pick 原分支统计字段提交 `a388e8e64` 时，`origin/main` 上已有同名统计字段基础文档和 live acceptance 脚本，并且主干版本包含后续增强，例如：

- `API_HOST_HEADER` host-routed live acceptance 支持；
- 显式 `AUTH_SOURCE` / token-file 验证；
- live acceptance 脚本 preflight 与 token path redaction；
- 统计字段、导入员、目录组织镜像的主干等价实现。

因此本轮中止 cherry-pick，避免生成重复功能差异。

## 当前交付策略

本轮不再推送重复 feature PR。当前建议调整为：

- 以 `origin/main` 已合入实现为事实源；
- 保留原工作区未跟踪 `.claude/`、`output/`、integration/K3Wise/staging 文档，不搬动、不纳入本轮；
- 新增本开发说明和配套验证说明，作为“上游对齐/收口”证据；
- 后续只做真实环境验收，不再重复开发统计字段、导入员权限和目录镜像主线。

## 后续真实验收清单

真实验收仍需要外部环境和短期凭据，不应在聊天或文档中暴露 token：

```bash
chmod 600 /path/to/admin.jwt
BASE_URL=<backend> AUTH_SOURCE=AUTH_TOKEN_FILE AUTH_TOKEN_FILE=/path/to/admin.jwt CONFIRM_SYNC=1 pnpm run verify:attendance-report-fields:live
```

建议验收范围：

- 统计字段：使用真实后端同步字段目录，检查字段分类、报表可见性、CSV 字段名称/字段编码模式、evidence headers。
- 导入员权限：使用 importer 账号验证可导入、可查看批次，不可进入规则和系统设置。
- DingTalk 组织镜像：使用真实目录同步数据验证部门树、绑定覆盖、停用部门、非最新批次提示和报告复制。

## 结论

本轮执行后的正确收口不是继续复制旧分支提交，而是确认主干已具备目标能力，并把剩余工作转为真实环境验收。若仍需要 PR，本分支应作为 docs-only reconciliation PR，而不是 feature PR。
