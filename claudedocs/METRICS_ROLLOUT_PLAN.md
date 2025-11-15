# Metrics & Monitoring Rollout Plan
**Created**: 2025-10-23
**Status**: READY FOR EXECUTION
**Priority**: Based on ROI and Risk

---

## 执行路线图

### 🟢 Phase 1: 短期观察与验证 (48小时)

**目标**: 验证指标稳定性，建立基线

**当前状态**:
- ✅ METRICS_FAILURE_MODE=warning (非阻断模式)
- ✅ Push Security Gates 已运行并成功
- ✅ 指标已上报到 Pushgateway

**执行步骤**:

1. **监控成功率** (Day 1-2)
   ```bash
   # 查询最近48小时的成功率
   # Prometheus Query:
   sum(rate(security_scan_success_total[48h])) /
   sum(rate(security_scan_total[48h])) * 100
   ```

   **成功标准**:
   - ✅ 成功率 ≥ 95%
   - ✅ BLOCK 事件 = 0
   - ✅ 告警噪声低 (误报 < 5%)

2. **噪声评估**
   - 记录所有 WARN 级别事件
   - 验证是否为真实问题 vs 误报
   - 调整 allowlist 减少误报

**决策点**:
- ✅ 达标 → 进入 Phase 2
- ❌ 未达标 → 优化 allowlist，继续观察

---

### 🟡 Phase 2: 严格模式切换 (Week 1)

**前置条件**: Phase 1 成功率 ≥ 95%，BLOCK = 0

**执行步骤**:

1. **更新 GitHub Actions 配置**
   ```yaml
   # .github/workflows/push-security-gates.yml
   env:
     METRICS_FAILURE_MODE: fail  # 从 warning 改为 fail
   ```

2. **设置分支保护规则**
   ```bash
   # 将 Push Security Gates 设为必过检查
   gh api repos/zensgit/smartsheet/branches/main/protection \
     --method PUT \
     -f required_status_checks[strict]=true \
     -f required_status_checks[contexts][]=Push Security Gates
   ```

3. **团队通知**
   ```
   Subject: [Action Required] Security Gates 现为强制门禁

   团队成员好，

   从 [日期] 开始，Push Security Gates 已升级为强制门禁：
   - 任何 BLOCK 级别的安全问题都会阻止 push
   - 如遇阻塞，请先修复问题或更新 allowlist
   - 紧急情况联系：[负责人]
   ```

**回滚计划**:
```bash
# 如果出现问题，快速回滚到 warning 模式
# 1. 恢复环境变量
METRICS_FAILURE_MODE=warning

# 2. 移除分支保护要求
gh api repos/zensgit/smartsheet/branches/main/protection \
  --method PUT \
  -f required_status_checks[contexts][]=  # 移除 Push Security Gates
```

---

### 🔵 Phase 3: 最小告警上线 (立即可启动)

**优先级**: HIGH (可与 Phase 1 并行)

**告警规则配置**:

```yaml
# prometheus-alerts.yml
groups:
  - name: security_gates
    interval: 1m
    rules:
      # Critical Alert 1: BLOCK 事件检测
      - alert: SecurityScanBlocked
        expr: security_scan_blocked_total > 0
        for: 5m
        labels:
          severity: critical
          component: security
        annotations:
          summary: "Security scan blocked in {{ $labels.repo }}"
          description: "Branch {{ $labels.branch }} has {{ $value }} blocked secrets"

      # Critical Alert 2: 成功率下降
      - alert: SecurityScanSuccessRateLow
        expr: |
          (sum(rate(security_scan_success_total[10m])) /
           sum(rate(security_scan_total[10m])) * 100) < 90
        for: 10m
        labels:
          severity: critical
          component: security
        annotations:
          summary: "Security scan success rate below 90%"
          description: "Current success rate: {{ $value | humanize }}%"

      # Warning Alert: 扫描时长异常
      - alert: SecurityScanDurationHigh
        expr: security_scan_duration_seconds > 300
        for: 5m
        labels:
          severity: warning
          component: security
        annotations:
          summary: "Security scan taking too long"
          description: "Scan duration: {{ $value }}s (threshold: 300s)"
```

**告警路由配置**:

```yaml
# alertmanager.yml
route:
  group_by: ['alertname', 'repo']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h
  receiver: 'slack-security'

  routes:
    # Critical alerts 先发 Slack，验证后再接 PagerDuty
    - match:
        severity: critical
      receiver: 'slack-security'
      continue: false  # 验证期暂不发 PagerDuty

receivers:
  - name: 'slack-security'
    slack_configs:
      - api_url: '${SLACK_WEBHOOK_URL}'
        channel: '#security-alerts'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.description }}{{ end }}'
```

**验证步骤**:

1. **模拟 BLOCK 事件**
   ```bash
   # 临时添加真实 secret 到 test branch
   git checkout -b test/alert-validation
   echo "password=real_secret_123" > test-secret.txt
   git add test-secret.txt && git commit -m "test: trigger alert"
   git push origin test/alert-validation

   # 预期: 5 分钟内收到 Slack 告警
   ```

2. **验证静默功能**
   ```bash
   # 在 Alertmanager UI 中创建 silence
   # 预期: 告警不再发送，但仍记录在 Prometheus
   ```

3. **验证恢复通知**
   ```bash
   # 删除 secret，重新 push
   git checkout test/alert-validation
   git rm test-secret.txt && git commit -m "fix: remove secret"
   git push

   # 预期: 收到恢复通知
   ```

**成功标准**:
- ✅ BLOCK 告警触发并发送到 Slack (< 5min)
- ✅ 成功率告警触发并发送到 Slack (< 10min)
- ✅ 静默功能正常工作
- ✅ 恢复通知正常发送
- ✅ 误报率 < 5%

---

### 🟣 Phase 4: Grafana 仪表板发布 (本周内)

**目标**: 提供可视化监控界面

**仪表板配置**:

```json
{
  "dashboard": {
    "title": "Security Scan Monitoring",
    "tags": ["security", "gitleaks", "ci"],
    "timezone": "browser",
    "templating": {
      "list": [
        {
          "name": "scan_type",
          "type": "query",
          "query": "label_values(security_scan_total, scan_type)",
          "current": { "text": "All", "value": "$__all" },
          "multi": true
        },
        {
          "name": "branch",
          "type": "query",
          "query": "label_values(security_scan_total, branch)",
          "current": { "text": "main", "value": "main" }
        },
        {
          "name": "repo",
          "type": "query",
          "query": "label_values(security_scan_total, repo)",
          "current": { "text": "smartsheet", "value": "smartsheet" }
        },
        {
          "name": "threshold",
          "type": "custom",
          "query": "90,95,99",
          "current": { "text": "90", "value": "90" }
        },
        {
          "name": "window",
          "type": "custom",
          "query": "1h,6h,24h,7d",
          "current": { "text": "24h", "value": "24h" }
        }
      ]
    },
    "panels": [
      {
        "title": "Quick Summary",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(security_scan_success_total{repo=\"$repo\", branch=\"$branch\"})",
            "legendFormat": "Total Scans"
          }
        ]
      },
      {
        "title": "Success Rate (${window})",
        "type": "gauge",
        "targets": [
          {
            "expr": "sum(rate(security_scan_success_total{repo=\"$repo\"}[$window])) / sum(rate(security_scan_total{repo=\"$repo\"}[$window])) * 100"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "thresholds": {
              "steps": [
                { "color": "red", "value": 0 },
                { "color": "yellow", "value": "$threshold" },
                { "color": "green", "value": 95 }
              ]
            }
          }
        }
      },
      {
        "title": "Scan Duration Trend",
        "type": "timeseries",
        "targets": [
          {
            "expr": "security_scan_duration_seconds{repo=\"$repo\", branch=\"$branch\"}",
            "legendFormat": "{{ scan_type }}"
          }
        ]
      },
      {
        "title": "BLOCK vs WARN Trend",
        "type": "timeseries",
        "targets": [
          {
            "expr": "rate(security_scan_blocked_total{repo=\"$repo\"}[$window])",
            "legendFormat": "BLOCK"
          },
          {
            "expr": "rate(security_scan_warned_total{repo=\"$repo\"}[$window])",
            "legendFormat": "WARN"
          }
        ]
      },
      {
        "title": "Allowlist Growth",
        "type": "timeseries",
        "targets": [
          {
            "expr": "security_scan_allowlist_size{repo=\"$repo\"}",
            "legendFormat": "Allowlist Entries"
          }
        ]
      }
    ]
  }
}
```

**部署步骤**:

1. **导入仪表板**
   ```bash
   # 通过 Grafana API 导入
   curl -X POST http://grafana:3000/api/dashboards/db \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer ${GRAFANA_API_KEY}" \
     -d @grafana-dashboard.json
   ```

2. **设置权限**
   ```bash
   # 设为只读，团队成员可见
   # Organization: Viewers
   # Folder: Security Monitoring (read-only)
   ```

3. **分享链接**
   - 添加到 claudedocs/README.md
   - 发送给团队成员
   - 固定到 Slack #security 频道

**成功标准**:
- ✅ 最新扫描 5 分钟内可见
- ✅ 变量切换正常 (scan_type, branch, repo)
- ✅ 阈值调整反映到 gauge 颜色
- ✅ 历史数据完整 (至少 24h)

---

### 🟠 Phase 5: Pushgateway 运维优化 (随启)

**问题**: Pushgateway 不会自动清理指标，可能导致内存增长

**解决方案**:

1. **启用抓取后清理** (可选)
   ```yaml
   # .github/workflows/push-security-gates.yml
   env:
     METRICS_CLEAN_AFTER_SCRAPE: true  # 新增变量

   # 在 metrics push 后添加清理步骤
   - name: Clean up Pushgateway metrics
     if: env.METRICS_CLEAN_AFTER_SCRAPE == 'true'
     run: |
       # 删除当前 job/instance 组
       curl -X DELETE "http://pushgateway:9091/metrics/job/security_scans/instance/${GITHUB_RUN_ID}/branch/${GITHUB_REF_NAME}"
   ```

2. **定期清理脚本**
   ```bash
   #!/bin/bash
   # scripts/cleanup-pushgateway.sh

   # 删除 7 天前的指标组
   CUTOFF_DATE=$(date -d '7 days ago' +%s)

   curl -s http://pushgateway:9091/api/v1/metrics | \
     jq -r '.data[] | select(.push_time_seconds < $cutoff) |
            "/metrics/job/\(.job)/instance/\(.instance)"' \
     --argjson cutoff $CUTOFF_DATE | \
     while read path; do
       curl -X DELETE "http://pushgateway:9091$path"
       echo "Deleted: $path"
     done
   ```

3. **Cron 定时任务**
   ```yaml
   # .github/workflows/cleanup-metrics.yml
   name: Cleanup Old Metrics
   on:
     schedule:
       - cron: '0 2 * * 0'  # 每周日凌晨 2 点

   jobs:
     cleanup:
       runs-on: ubuntu-latest
       steps:
         - name: Cleanup Pushgateway
           run: bash scripts/cleanup-pushgateway.sh
   ```

**成功标准**:
- ✅ Prometheus 已抓取的历史数据不受影响
- ✅ Pushgateway 组数稳定 (< 1000 groups)
- ✅ 内存使用稳定 (< 500MB)

---

### 🔵 Phase 6: 治理与可持续性 (长期)

#### 6.1 Allowlist 生命周期管理

**季度复查流程**:

```yaml
# .github/workflows/quarterly-allowlist-review.yml
name: Quarterly Allowlist Review
on:
  schedule:
    - cron: '0 9 1 1,4,7,10 *'  # 每季度第一天
  workflow_dispatch:

jobs:
  create-review-issue:
    runs-on: ubuntu-latest
    steps:
      - name: Create Review Issue
        uses: actions/github-script@v7
        with:
          script: |
            const allowlistSize = await fetch('http://pushgateway:9091/metrics')
              .then(r => r.text())
              .then(t => t.match(/security_scan_allowlist_size (\d+)/)?.[1] || 'unknown');

            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `[Q${Math.ceil((new Date().getMonth() + 1) / 3)}] Allowlist Review`,
              body: `
## Quarterly Allowlist Review

**Current Status**:
- Allowlist Size: ${allowlistSize} entries
- Review Period: ${new Date().toISOString().split('T')[0]}

**Action Items**:
- [ ] Remove obsolete/expired entries
- [ ] Verify each entry has clear justification comment
- [ ] Update expiration dates for temporary entries
- [ ] Document any new patterns discovered

**Principles**:
- ✅ Minimum Exception Priority (最小特例优先)
- ✅ Every entry must have: reason + owner + expiration (if temp)
- ✅ Prefer narrow regexes over broad wildcards

**References**:
              `,
              labels: ['security', 'quarterly-review', 'allowlist'],
              assignees: ['security-team']  // 替换为实际负责人
            });
```

**最佳实践**:

```toml

[[rules.allowlist]]
description = "Example credentials in test fixtures"
regex = '''test-password-123'''
paths = ['''^tests/fixtures/.*\.json$''']
# Owner: @security-team
# Reason: Test data only, not real credentials
# Expiration: N/A (permanent test fixture)

[[rules.allowlist]]
description = "Legacy API key migration period"
regex = '''legacy-api-key-\d{8}'''
# Owner: @backend-team
# Reason: Migration in progress, remove after 2025-12-31
# Expiration: 2025-12-31
# TODO: Create followup issue to remove this
```

#### 6.2 文档维护

**更新 claudedocs/README.md**:

```markdown
## 🔗 Monitoring & Observability

**Grafana Dashboards**:
- [Security Scan Monitoring](http://grafana:3000/d/security-scans) - 实时监控和历史趋势
- [Pushgateway Metrics](http://grafana:3000/d/pushgateway) - 指标推送状态

**Alert Rules**:
- [Prometheus Alerts](http://prometheus:9090/alerts) - 当前告警状态
- [Alertmanager](http://alertmanager:9093) - 告警路由和静默管理

**Runbooks**:
```

---

## 可选提升

### 7.1 validate-env.sh "CI 模式"

**需求**: 将环境验证结果输出为 JSON 格式，用于 CI 工件

**实现**:

```bash
# scripts/validate-env.sh - 添加 CI 模式支持

VALIDATE_ENV_OUTPUT=${VALIDATE_ENV_OUTPUT:-text}  # text | json

if [ "$VALIDATE_ENV_OUTPUT" = "json" ]; then
  # JSON 输出模式
  {
    echo "{"
    echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"environment\": \"$ENV_MODE\","
    echo "  \"validation_result\": \"${VALIDATION_RESULT}\","
    echo "  \"missing_vars\": ["
    # ... 输出缺失变量列表
    echo "  ],"
    echo "  \"errors\": ["
    # ... 输出错误信息
    echo "  ]"
    echo "}"
  } > validation-result.json
else
  # 标准文本输出
  echo "✅ Environment validation passed"
fi
```

**使用示例**:

```yaml
# .github/workflows/validate-env.yml
- name: Validate Environment
  run: |
    VALIDATE_ENV_OUTPUT=json bash scripts/validate-env.sh production

- name: Upload Validation Report
  uses: actions/upload-artifact@v4
  with:
    name: env-validation-report
    path: validation-result.json
```

### 7.2 跨仓复用

**场景**: 多个仓库接入 Security Gates

**改进**:

```json
// grafana-dashboard.json - 增加 repo 变量
{
  "templating": {
    "list": [
      {
        "name": "repo",
        "type": "query",
        "query": "label_values(security_scan_total, repo)",
        "current": { "text": "All", "value": "$__all" },
        "multi": true,
        "includeAll": true
      }
    ]
  }
}
```

```yaml
# reusable-workflow/security-gates.yml
name: Reusable Security Gates
on:
  workflow_call:
    inputs:
      pushgateway_url:
        required: true
        type: string

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run Security Scan
        run: |
          # 使用 reusable workflow
          bash scripts/push-security-gates.sh
        env:
          PUSHGATEWAY_URL: ${{ inputs.pushgateway_url }}
          REPO_NAME: ${{ github.repository }}
```

---

## 执行时间线

| Phase | Timeline | Priority | Dependencies |
|-------|----------|----------|--------------|
| Phase 1 | Day 1-2 | 🔴 HIGH | None |
| Phase 3 | Day 1-3 | 🔴 HIGH | None (可并行) |
| Phase 2 | Week 1 | 🟡 MEDIUM | Phase 1 成功 |
| Phase 4 | Week 1 | 🟡 MEDIUM | Phase 3 完成 |
| Phase 5 | Week 1-2 | 🟢 LOW | Phase 4 完成 |
| Phase 6 | Ongoing | 🟢 LOW | All phases |

---

## 回滚与应急

**快速回滚步骤**:

1. **禁用强制门禁**
   ```bash
   # 1. 环境变量回滚
   METRICS_FAILURE_MODE=warning

   # 2. 移除分支保护
   gh api repos/zensgit/smartsheet/branches/main/protection \
     --method PUT -f required_status_checks[contexts][]=
   ```

2. **静默所有告警**
   ```bash
   # Alertmanager UI: Create silence
   # Matchers: alertname=~"SecurityScan.*"
   # Duration: 24h
   # Comment: "Emergency rollback - investigating"
   ```

3. **通知团队**
   ```
   #security: 🚨 Security Gates temporarily disabled
   Reason: [具体原因]
   Expected Resolution: [预计时间]
   Action: Continue development as normal
   ```

**应急联系**:
- Security Lead: [负责人]
- DevOps On-Call: [on-call 联系方式]
- Slack: #security-incidents

---

## 成功指标 (KPIs)

**Phase 1-2 (基础设施)**:
- ✅ 成功率 ≥ 95% (48h baseline)
- ✅ BLOCK 事件 = 0
- ✅ 平均扫描时长 < 60s

**Phase 3-4 (可观测性)**:
- ✅ 告警响应时间 < 5min (BLOCK)
- ✅ 仪表板刷新延迟 < 5min
- ✅ 误报率 < 5%

**Phase 5-6 (治理)**:
- ✅ Pushgateway 组数 < 1000
- ✅ Allowlist 季度复查完成率 100%
- ✅ 文档更新及时 (< 7 days)

---

## 相关文档

- [Push Security Gates Workflow](../../.github/workflows/push-security-gates.yml) - CI 配置
- [Grafana Dashboards](http://grafana:3000) - 监控面板

---

**Last Updated**: 2025-10-23
**Owner**: Security Team
**Review Cycle**: Monthly
