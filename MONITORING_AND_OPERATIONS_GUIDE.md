# 📊 运行与监控操作指南

## 一、实时监控体系

### 1.1 自动化监控工作流

#### Weekly Trend Summary（每周趋势监控）
- **触发方式**:
  - 自动: 每次push到main分支
  - 定时: 每周一UTC 01:00
  - 手动: workflow_dispatch
- **监控指标**:
  - P99延迟趋势
  - RBAC缓存命中率
  - OpenAPI Lint数量
- **数据位置**: `gh-pages-data`分支 `/reports/weekly-trend.md`

#### Observability V2 Strict（严格监控）
- **触发**: 每次PR和push
- **关键阈值**:
  - P99 < 0.1s（可通过变量调整）
  - RBAC命中率 > 60%
  - 错误率 < 0.005
- **失败策略**:
  - P99：硬门禁（超阈值将导致工作流失败）
  - RBAC命中率：软门禁（仅警告，不阻断CI）
  - 错误率：硬门禁（超过阈值将失败）

### 1.2 健康检查机制

```yaml
# 已内置在 publish-openapi-pages.yml
Post-publish health checks:
  - 6次重试，递增延迟（2s, 4s, 6s, 8s, 10s, 12s）
  - 检查三个关键URL
  - 非阻塞式警告
```

## 二、日常监控操作

**前置条件**:
- 安装并登录GitHub CLI: `gh auth login`
- 配置环境变量: `export GH_TOKEN=<your-token>`
- 具有仓库读取权限

### 2.1 快速健康检查

```bash
#!/bin/bash
set -euo pipefail
# health_check.sh - 一键健康检查脚本
# 依赖: curl, gh CLI (需要预先登录)

echo "🔍 系统健康检查 $(date)"
echo "================================"

# 1. 检查关键链接
echo -e "\n📡 链接可用性:"
for url in \
  "https://zensgit.github.io/smartsheet/reports/weekly-trend.md" \
  "https://zensgit.github.io/smartsheet/releases/latest.md" \
  "https://zensgit.github.io/smartsheet/api-docs/openapi.yaml"
do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  if [ "$status" = "200" ]; then
    echo "✅ $url: $status"
  else
    echo "❌ $url: $status"
  fi
done

# 2. 获取最新性能指标
echo -e "\n📊 最新性能指标:"
curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md | head -7

# 3. 检查最近工作流状态
echo -e "\n⚙️ 最近工作流运行:"
gh run list --repo zensgit/smartsheet --limit 5 \
  --json name,conclusion,createdAt \
  --jq '.[] | "\(.createdAt): \(.name) - \(.conclusion)"'
```

### 2.2 性能趋势分析

```bash
#!/bin/bash
set -euo pipefail
# trend_analysis.sh - 性能趋势分析
# 依赖: git, jq, awk

# 获取30天趋势数据
echo "📈 30天性能趋势分析"
echo "===================="

# 下载所有报告
mkdir -p /tmp/observability-reports
cd /tmp/observability-reports

# 从gh-pages-data分支获取报告
git clone --branch gh-pages-data --single-branch \
  https://github.com/zensgit/smartsheet.git reports 2>/dev/null

# 分析P99趋势
echo -e "\n⏱️ P99延迟趋势:"
find reports/reports -name "*.json" -mtime -30 2>/dev/null | \
  xargs -I {} jq -r '.metrics.p99' {} 2>/dev/null | \
  awk '{sum+=$1; count++} END {
    if(count>0) {
      avg=sum/count;
      printf "平均: %.4fs\n", avg;
      if(avg < 0.01) print "状态: ✅ 优秀";
      else if(avg < 0.1) print "状态: ⚠️ 良好";
      else print "状态: ❌ 需优化";
    }
  }'

# 分析RBAC命中率
echo -e "\n🎯 RBAC缓存命中率:"
find reports/reports -name "*.json" -mtime -30 2>/dev/null | \
  xargs -I {} jq -r '.metrics.rbacHitRate' {} 2>/dev/null | \
  awk '{sum+=$1; count++} END {
    if(count>0) {
      avg=sum/count*100;
      printf "平均: %.1f%%\n", avg;
      if(avg > 85) print "状态: ✅ 优秀";
      else if(avg > 60) print "状态: ⚠️ 达标";
      else print "状态: ❌ 需优化";
    }
  }'
```

### 2.3 实时监控仪表板

```bash
#!/bin/bash
set -euo pipefail
# dashboard.sh - 实时监控仪表板
# 依赖: curl, gh CLI, bc

while true; do
  clear
  echo "┌─────────────────────────────────────────────┐"
  echo "│        🎯 SmartSheet 实时监控仪表板         │"
  echo "│             $(date +"%Y-%m-%d %H:%M:%S")            │"
  echo "└─────────────────────────────────────────────┘"

  # 性能指标
  echo -e "\n📊 性能指标"
  echo "├─ P99延迟: $(curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md | grep "P99:" | awk '{print $2, $3}')"
  echo "├─ RBAC命中: $(curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md | grep "RBAC" | awk '{print $3, $4}')"
  echo "└─ Lint数量: $(curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md | grep "OpenAPI" | awk '{print $3, $4}')"

  # 工作流状态
  echo -e "\n⚙️ 最近工作流"
  gh run list --repo zensgit/smartsheet --limit 3 \
    --json name,conclusion,createdAt \
    --jq '.[] | "├─ \(.name): \(.conclusion)"' 2>/dev/null || echo "├─ 无法获取"

  # 系统状态
  echo -e "\n🔗 链接状态"
  for name in "Weekly" "Release" "OpenAPI"; do
    echo -n "├─ $name: "
    case $name in
      "Weekly") url="https://zensgit.github.io/smartsheet/reports/weekly-trend.md";;
      "Release") url="https://zensgit.github.io/smartsheet/releases/latest.md";;
      "OpenAPI") url="https://zensgit.github.io/smartsheet/api-docs/openapi.yaml";;
    esac
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
    [ "$status" = "200" ] && echo "✅" || echo "❌ ($status)"
  done

  echo -e "\n按 Ctrl+C 退出 | 30秒后刷新..."
  sleep 30
done
```

## 三、告警配置

### 3.1 GitHub Actions通知（带去重机制）

```yaml
# .github/workflows/monitoring-alert.yml
name: Monitoring Alert

on:
  schedule:
    - cron: '0 */6 * * *'  # 每6小时检查
  workflow_dispatch:

jobs:
  check-metrics:
    runs-on: ubuntu-latest
    steps:
      - name: Check System Health
        run: |
          # 检查P99
          P99=$(curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md |
                grep "P99:" | awk '{print $2}')
          if (( $(echo "$P99 > 0.01" | bc -l) )); then
            echo "::warning::P99延迟异常: ${P99}s > 0.01s"
            echo "ALERT_P99=true" >> $GITHUB_ENV
          fi

          # 检查RBAC
          RBAC=$(curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md |
                 grep "RBAC" | awk '{print $3}')
          if (( $(echo "$RBAC < 0.6" | bc -l) )); then
            echo "::warning::RBAC命中率低: ${RBAC} < 60%"
            echo "ALERT_RBAC=true" >> $GITHUB_ENV
          fi

      - name: Create Issue if Alert
        if: env.ALERT_P99 == 'true' || env.ALERT_RBAC == 'true'
        uses: actions/github-script@v6
        with:
          script: |
            const title = `[告警] 性能指标异常 - ${new Date().toISOString().split('T')[0]}`;
            const body = `
            ## 🚨 监控告警

            检测时间: ${new Date().toISOString()}

            ### 异常指标:
            ${process.env.ALERT_P99 ? '- ❌ P99延迟超过阈值' : ''}
            ${process.env.ALERT_RBAC ? '- ❌ RBAC命中率过低' : ''}

            ### 建议操作:
            1. 查看 [Weekly Trend Report](https://zensgit.github.io/smartsheet/reports/weekly-trend.md)
            2. 检查最近的代码变更
            3. 运行性能分析脚本
            `;

            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: title,
              body: body,
              labels: ['alert', 'performance']
            });
```

### 3.2 Slack/钉钉集成

```bash
#!/bin/bash
# alert_webhook.sh - 发送告警到Slack/钉钉

send_alert() {
  local message=$1
  local severity=$2  # info, warning, error

  # Slack Webhook
  if [ -n "$SLACK_WEBHOOK_URL" ]; then
    curl -X POST $SLACK_WEBHOOK_URL \
      -H 'Content-Type: application/json' \
      -d "{
        \"text\": \"🚨 SmartSheet监控告警\",
        \"attachments\": [{
          \"color\": \"$([ $severity = 'error' ] && echo 'danger' || echo 'warning')\",
          \"text\": \"$message\",
          \"footer\": \"监控系统\",
          \"ts\": $(date +%s)
        }]
      }"
  fi

  # 钉钉 Webhook
  if [ -n "$DINGTALK_WEBHOOK_URL" ]; then
    curl -X POST $DINGTALK_WEBHOOK_URL \
      -H 'Content-Type: application/json' \
      -d "{
        \"msgtype\": \"markdown\",
        \"markdown\": {
          \"title\": \"监控告警\",
          \"text\": \"### 🚨 SmartSheet监控告警\\n\\n$message\\n\\n时间: $(date)\"
        }
      }"
  fi
}

# 使用示例
check_p99() {
  P99=$(curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md |
        grep "P99:" | awk '{print $2}')
  if (( $(echo "$P99 > 0.01" | bc -l) )); then
    send_alert "P99延迟异常: ${P99}s (阈值: 0.01s)" "error"
  fi
}
```

## 四、故障处理流程

### 4.1 快速诊断

```bash
#!/bin/bash
# diagnose.sh - 快速诊断脚本

echo "🔧 系统诊断开始..."

# 1. 检查GitHub Pages状态
echo -n "GitHub Pages: "
curl -s https://www.githubstatus.com/api/v2/components.json |
  jq -r '.components[] | select(.name=="GitHub Pages") | .status'

# 2. 检查最近失败的工作流
echo -e "\n失败的工作流:"
gh run list --repo zensgit/smartsheet --status failure --limit 5

# 3. 获取错误日志
echo -e "\n最近错误:"
gh run list --repo zensgit/smartsheet --limit 1 --json databaseId -q '.[0].databaseId' |
  xargs -I {} gh run view {} --repo zensgit/smartsheet --log 2>&1 |
  grep -i "error\|fail" | head -10
```

### 4.2 恢复操作

```bash
#!/bin/bash
# recovery.sh - 系统恢复脚本

recover_pages() {
  echo "📄 重新部署GitHub Pages..."
  gh workflow run "Publish OpenAPI (V2)" --repo zensgit/smartsheet
  echo "等待部署完成..."
  sleep 60

  # 验证
  for url in \
    "https://zensgit.github.io/smartsheet/reports/weekly-trend.md" \
    "https://zensgit.github.io/smartsheet/releases/latest.md" \
    "https://zensgit.github.io/smartsheet/api-docs/openapi.yaml"
  do
    status=$(curl -s -o /dev/null -w "%{http_code}" "$url")
    echo "$url: $status"
  done
}

recover_trend() {
  echo "📊 重新生成Weekly Trend..."
  gh workflow run "Weekly Trend Summary" --repo zensgit/smartsheet
}

# 主恢复流程
echo "选择恢复选项:"
echo "1. 恢复GitHub Pages"
echo "2. 重新生成趋势报告"
echo "3. 全部恢复"
read -p "选择 (1-3): " choice

case $choice in
  1) recover_pages ;;
  2) recover_trend ;;
  3) recover_pages && recover_trend ;;
  *) echo "无效选择" ;;
esac
```

## 五、定期维护任务

### 5.1 每日检查清单
```bash
# daily_check.sh
[ ] Weekly Trend自动生成正常
[ ] 三个关键URL返回200
[ ] P99 < 0.01s
[ ] RBAC > 80%
[ ] 无失败的工作流
```

### 5.2 每周维护
```bash
# weekly_maintenance.sh
[ ] 分析性能趋势
[ ] 清理旧的工作流运行记录
[ ] 更新监控阈值（如需要）
[ ] 审查告警记录
```

### 5.3 每月优化
```bash
# monthly_optimization.sh
[ ] 分析长期趋势
[ ] 优化慢查询
[ ] 更新依赖
[ ] 归档历史数据
```

## 六、监控指标说明

| 指标 | 正常范围 | 警告阈值 | 严重阈值 | 处理建议 |
|------|----------|----------|----------|----------|
| P99延迟 | <0.005s | 0.01s | 0.1s | 检查最近代码变更，优化慢查询 |
| RBAC命中率 | >85% | 60% | 40% | 检查缓存预热，优化缓存策略 |
| 错误率 | <0.1% | 0.5% | 1% | 查看错误日志，修复bug |
| 链接可用率 | 100% | 99% | 95% | 检查Pages部署，重新触发 |
| OpenAPI Lint | 0-2 | 5 | 10 | 修复API文档问题 |

## 七、快速命令参考

```bash
# 变量管理
gh variable list --repo zensgit/smartsheet
gh variable set NAME --repo zensgit/smartsheet --body "VALUE"

# 工作流管理
gh workflow run "WORKFLOW_NAME" --repo zensgit/smartsheet
gh run list --repo zensgit/smartsheet --workflow "WORKFLOW_NAME"
gh run view RUN_ID --repo zensgit/smartsheet --log

# 问题排查
gh issue create --title "标题" --body "内容" --label "bug"
gh pr list --repo zensgit/smartsheet --state open
```

---
**文档版本**: 1.0
**最后更新**: 2025-09-22
**维护团队**: DevOps
