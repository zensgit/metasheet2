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
python3 -m py_compile scripts/ops/github-dingtalk-oauth-stability-summary.py
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

### 6. 合入前 GitHub `workflow_dispatch` 探测

执行：

```bash
gh workflow run dingtalk-oauth-stability-recording-lite.yml --ref codex/dingtalk-onprem-rollout-20260330
```

实际结果：

- GitHub 返回：
  - `HTTP 404: workflow dingtalk-oauth-stability-recording-lite.yml not found on the default branch`

结论：

- 这不是 YAML/脚本错误
- 是 GitHub Actions 的默认分支限制：当前 workflow 还只存在于 `codex/dingtalk-onprem-rollout-20260330`，尚未进入默认分支，因此还不能由 GitHub 侧真正触发

### 7. 默认分支首条真实 run

前置：

- PR `#608` 已 merged 到 `main`
- merge commit: `6de9330fd042c4f9d6beb32f68cd5e7cc348f0b9`

执行：

```bash
gh workflow run dingtalk-oauth-stability-recording-lite.yml --repo zensgit/metasheet2 --ref main
gh run view 23930809987 --repo zensgit/metasheet2
gh api repos/zensgit/metasheet2/actions/runs/23930809987/artifacts
```

实际结果：

- GitHub 已成功接受 `workflow_dispatch`
- 首条默认分支 run:
  - run id: `23930809987`
  - URL: `https://github.com/zensgit/metasheet2/actions/runs/23930809987`
  - job: `stability-record`
  - 结果: `success`
- 首条 artifact:
  - 名称: `dingtalk-oauth-stability-recording-lite-23930809987-1`
  - id: `6253838739`
- artifact 内容已复核：
  - `stability.json`
  - `stability.log`
  - `summary.md`
- `stability.json` 关键字段：
  - `healthy=true`
  - `health.status=ok`
  - `webhookConfig.configured=true`
  - `webhookConfig.host=hooks.slack.com`
  - `alertmanager.activeAlertsCount=0`
  - `alertmanager.notifyErrorsLastWindow=0`

结论：

- 这条 workflow 现在已经在默认分支真实可用
- GitHub 侧的“被动留档”门禁已打通

### 8. 本机 launchd 主执行面快照

执行：

```bash
bash ~/.codex/memories/metasheet2-onprem-schedule/scripts/ops/print-dingtalk-oauth-launchd-schedule-status.sh
```

实际结果：

- `stability_plist=present`
- `drill_plist=present`
- `summary_plist=present`
- 最近 stability 记录持续为：
  - `health.status=ok`
  - `webhook.configured=True host=hooks.slack.com`
  - `alertmanager.activeAlerts=0 notifyErrors=0`
  - `healthy=true`
- 当前语义保持不变：
  - 本机 `launchd` 仍是主执行面
  - GitHub Actions lite workflow 负责补一份远端稳定性留档，不重复发送 Slack drill

## 验证结论

这条 GitHub Actions workflow 现在已经满足“默认分支真实可运行的被动留档，不重复 drill”的目标：

- 会定时执行 stability check
- 会把 JSON / log / markdown summary 作为 artifact 留档
- 不会额外向 Slack 发送 drill 告警
- 失败时会在 GitHub 上直接表现为红色 run
- 默认分支首条真实 run 已成功产出 artifact

## 备注

本轮最终结论是：

- workflow 结构、artifact 约定和失败门禁都已完成
- `main` 上首条真实 GitHub run 已完成
- 观察期现在进入“本机 launchd 主执行 + GitHub lite 留档补充”的混合模式
