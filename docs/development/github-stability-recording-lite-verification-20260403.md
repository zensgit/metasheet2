# GitHub Stability Recording Lite Verification

日期：2026-04-03

## 范围

验证 GitHub Actions 轻量留档 workflow 的结构、引用路径、artifact 输出约定和失败门禁逻辑。

## 实际执行

### 1. Workflow YAML 解析

执行：

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/dingtalk-oauth-stability-recording-lite.yml'); puts 'ok'"
```

结果：

- 通过，输出 `ok`

### 2. Shell 脚本语法

执行：

```bash
bash -n scripts/ops/dingtalk-oauth-stability-check.sh
bash -n scripts/ops/set-dingtalk-onprem-alertmanager-webhook-config.sh
```

结果：

- 通过

### 3. 路径与 Secrets 约定复核

人工复核 workflow 内容，确认：

- 只引用现有脚本
  - `scripts/ops/dingtalk-oauth-stability-check.sh`
- 只依赖现有 deploy secrets
  - `DEPLOY_HOST`
  - `DEPLOY_USER`
  - `DEPLOY_SSH_KEY_B64`
- artifact 输出目录固定为：
  - `output/github/dingtalk-oauth-stability/`

结果：

- 通过

### 4. 失败门禁逻辑

人工复核 workflow 末尾 gate step，确认：

- `stability_rc != 0` 时 workflow fail
- `healthy != true` 时 workflow fail
- 但 artifact upload 仍通过 `if: always()` 执行

结果：

- 通过

### 5. 索引和 workflow 说明

确认已更新：

- `docs/verification-index.md`
- `.github/workflows/README.md`

结果：

- 通过

## 验证结论

这条 GitHub Actions workflow 已满足“被动留档，不重复 drill”的目标：

- 会定时执行 stability check
- 会把 JSON / log / markdown summary 作为 artifact 留档
- 不会额外向 Slack 发送 drill 告警
- 失败时会在 GitHub 上直接表现为红色 run

## 备注

本轮验证是本地静态验证，不包含真实 GitHub Actions 运行回执。首次真实回执应在：

- 手动 `workflow_dispatch`
- 或首次 schedule 触发后

再把 run URL / artifact 名称回填到后续 deployment/ops 文档。
