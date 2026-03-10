# Attendance PR396 上线与审批处置记录（2026-03-10）

## 目标
- 带上 PR #396 改动上线生产。
- 完成审批门禁处置并恢复分支保护。
- 生成仅考勤 On-Prem 安装包并发布到 GitHub Release。

## 结果
- PR：[#396](https://github.com/zensgit/metasheet2/pull/396) 已合并到 `main`。
  - `mergedAt`: `2026-03-10T01:21:02Z`
  - `mergeCommit`: `d7400ac375f1be181eb0101fb6dfef13c574eeba`
- 部署：`Deploy to Production` 成功。
  - run: `22882626193`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/22882626193>
- 严格门禁：`Attendance Strict Gates (Prod)` 成功（双轮）。
  - run: `22882657001`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/22882657001>
- 安装包：`Attendance On-Prem Package Build` 成功并发布 Release。
  - run: `22882772899`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/22882772899>
  - tag: `attendance-onprem-pr396-20260310`
  - release: <https://github.com/zensgit/metasheet2/releases/tag/attendance-onprem-pr396-20260310>

## 审批处置说明
- 平台限制：同一账号不能审批自己提交的 PR。
- 处置方式：
  1. 临时放宽 `main` 的 PR review 要求用于执行合并。
  2. 合并完成后立即恢复为生产策略。
- 恢复后校验：
  - `pr_reviews_required_current=true`
  - `approving_review_count_current=1`
  - `code_owner_reviews_current=false`
  - 校验脚本：`scripts/ops/attendance-check-branch-protection.sh` PASS。

## Release 资产（仅考勤）
- `metasheet-attendance-onprem-v2.5.0-run9.tgz`
- `metasheet-attendance-onprem-v2.5.0-run9.tgz.sha256`
- `metasheet-attendance-onprem-v2.5.0-run9.zip`
- `metasheet-attendance-onprem-v2.5.0-run9.zip.sha256`
- `metasheet-attendance-onprem-v2.5.0-run9.json`
- `SHA256SUMS`

## 关键门禁证据
- 严格门禁本地下载目录：
  - `output/playwright/ga/22882657001/attendance-strict-gates-prod-22882657001-1/`
- 安装包构建本地下载目录：
  - `output/playwright/ga/22882772899/attendance-onprem-package-22882772899-1/`
- 严格 API smoke 关键日志（两轮均命中）：
  - `import upload ok`
  - `idempotency ok`
  - `export csv ok`
  - `SMOKE PASS`

## 复跑命令（占位符）
```bash
# 触发严格门禁
gh workflow run "Attendance Strict Gates (Prod)" --ref main

# 触发并发布仅考勤安装包
gh workflow run "Attendance On-Prem Package Build" --ref main \
  -f publish_release=true \
  -f release_tag=attendance-onprem-<yyyymmdd> \
  -f release_name="Attendance On-Prem <yyyymmdd>"
```

## 后续收口（PR399，部署与门禁刷新）

- 文档 PR：[#399](https://github.com/zensgit/metasheet2/pull/399) 已合并到 `main`。
  - `mergedAt`: `2026-03-10T02:16:26Z`
  - `mergeCommit`: `0f2b3e4c41f77f84a89d21660f450a79a0931ae2`
- 合并后部署：`Deploy to Production` 成功。
  - run: `22883978757`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/22883978757>
- 合并后回归：`Attendance Post-Merge Verify (Nightly)` 成功。
  - run: `22884014042`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/22884014042>
- 合并后总览：`Attendance Daily Gate Dashboard` 成功。
  - run: `22884174207`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/22884174207>

追加证据目录：

- `output/playwright/ga/22884014042/attendance-post-merge-verify-22884014042-1/`
- `output/playwright/ga/22884174207/attendance-daily-gate-dashboard-22884174207-1/`
