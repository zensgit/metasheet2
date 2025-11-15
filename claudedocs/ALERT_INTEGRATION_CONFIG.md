# 告警集成配置指南 (Alert Integration Configuration Guide)

## 概述 (Overview)

observability观察脚本（`scripts/observe-24h.sh`）支持自动告警集成，可在检测到异常时发送通知或创建GitHub Issue。

**告警触发条件：**
- Success Rate < 0.98 (98%)
- Fallback Ratio > 0.10 (10%)
- 检测到BLOCK事件（审批冲突导致完全阻塞）
- 检测到CRIT事件（严重错误）

---

## 配置选项 (Configuration Options)

### 1. Webhook通知 (ALERT_WEBHOOK_URL)

发送告警到webhook endpoint（支持Slack、Discord、钉钉、飞书等）。

#### 环境变量设置

```bash
export ALERT_WEBHOOK_URL="https://your-webhook-service.com/endpoint"
```

#### 告警Payload格式

脚本会POST以下JSON payload到webhook URL：

```json
{
  "timestamp": "2025-11-14T17:00:00+08:00",
  "alert_type": "PERFORMANCE_DEGRADATION",
  "severity": "WARNING",
  "message": "Success rate below threshold: 0.95 (target: >0.98)",
  "metrics": {
    "success_rate": 0.95,
    "fallback_ratio": 0.12,
    "p99_latency": 1.234,
    "conflicts": 0
  },
  "sample_number": 5,
  "observation_window": "phase5-prod-2h"
}
```

#### Slack集成示例

1. 创建Slack Incoming Webhook：
   - 进入Slack App设置
   - 选择"Incoming Webhooks"
   - 创建新webhook并复制URL

2. 设置环境变量：
   ```bash
   export ALERT_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
   ```

#### 钉钉集成示例

1. 创建钉钉群机器人：
   - 群设置 → 智能群助手 → 添加机器人 → 自定义webhook
   - 配置安全设置（推荐使用加签）
   - 复制webhook地址

2. 设置环境变量：
   ```bash
   export ALERT_WEBHOOK_URL="https://oapi.dingtalk.com/robot/send?access_token=YOUR_TOKEN"
   ```

**注意**：钉钉需要特殊格式，可能需要在脚本中添加适配器将JSON payload转换为钉钉markdown格式。

#### 飞书集成示例

1. 创建飞书群机器人：
   - 群设置 → 机器人 → 添加机器人 → Custom Bot
   - 复制webhook地址

2. 设置环境变量：
   ```bash
   export ALERT_WEBHOOK_URL="https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_TOKEN"
   ```

---

### 2. 自动创建GitHub Issue (CREATE_GH_ISSUE)

在检测到BLOCK或CRIT事件时自动创建GitHub Issue进行追踪。

#### 环境变量设置

```bash
export CREATE_GH_ISSUE=true
```

#### 前置条件

- 已安装并配置`gh` CLI工具
- 具有创建Issue的权限
- 已认证GitHub账户

#### Issue创建规则

**触发条件：**
- 检测到`BLOCK`状态（审批冲突导致完全阻塞）
- 检测到`CRIT`状态（严重错误）

**Issue标题格式：**
```
[ALERT] Observability Event: BLOCK detected at sample #5
[ALERT] Observability Event: CRIT detected at sample #8
```

**Issue内容：**
```markdown
## Alert Details

**Event Type**: BLOCK
**Sample Number**: 5 / 12
**Timestamp**: 2025-11-14T17:00:00+08:00
**Observation Window**: phase5-prod-2h

## Metrics

- Success Rate: 0.95 (target: >0.98)
- Fallback Ratio: 0.12 (target: <0.10)
- P99 Latency: 1.234s
- Conflicts: 3

## Raw Sample Data

\```json
{
  "timestamp": "2025-11-14T17:00:00+08:00",
  "success_rate": 0.95,
  "fallback_ratio": 0.12,
  "p99_latency": 1.234,
  "conflicts": 3,
  "notes": "BLOCK"
}
\```

## Action Required

Please investigate approval conflicts causing BLOCK status.

## Related Files

- Log: `artifacts/phase5-run.log`
- Summary: `artifacts/observability-24h-summary.json`
- CSV: `artifacts/observability-24h.csv`
```

**自动添加标签：**
- `alert`
- `observability`
- `priority-high`
- `needs-investigation`

---

## 完整配置示例 (Complete Configuration Examples)

### 示例1：最小配置（仅metrics采集）

```bash
cd metasheet-v2

export METRICS_URL="https://prometheus.prod.example.com:9090"
export INTERVAL_SECONDS=600
export MAX_SAMPLES=12
export OBS_WINDOW_LABEL=phase5-prod-2h
export OUT_DIR=metasheet-v2/artifacts
export LC_ALL=C

nohup bash scripts/observe-24h.sh > metasheet-v2/artifacts/phase5-run.log 2>&1 &
echo $! > metasheet-v2/artifacts/phase5.pid
```

### 示例2：Slack告警集成

```bash
cd metasheet-v2

export METRICS_URL="https://prometheus.prod.example.com:9090"
export ALERT_WEBHOOK_URL="https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX"
export INTERVAL_SECONDS=600
export MAX_SAMPLES=12
export OBS_WINDOW_LABEL=phase5-prod-2h
export OUT_DIR=metasheet-v2/artifacts
export LC_ALL=C

nohup bash scripts/observe-24h.sh > metasheet-v2/artifacts/phase5-run.log 2>&1 &
echo $! > metasheet-v2/artifacts/phase5.pid
```

### 示例3：完整集成（Webhook + GitHub Issue）

```bash
cd metasheet-v2

export METRICS_URL="https://prometheus.prod.example.com:9090"
export ALERT_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
export CREATE_GH_ISSUE=true
export INTERVAL_SECONDS=600
export MAX_SAMPLES=12
export OBS_WINDOW_LABEL=phase5-prod-2h
export OUT_DIR=metasheet-v2/artifacts
export LC_ALL=C

nohup bash scripts/observe-24h.sh > metasheet-v2/artifacts/phase5-run.log 2>&1 &
echo $! > metasheet-v2/artifacts/phase5.pid
```

---

## 告警测试 (Alert Testing)

### 手动触发测试告警

可以手动调用webhook测试告警集成：

```bash
curl -X POST "https://your-webhook-url.com/endpoint" \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2025-11-14T17:00:00+08:00",
    "alert_type": "TEST",
    "severity": "INFO",
    "message": "Test alert from observability script",
    "metrics": {
      "success_rate": 0.99,
      "fallback_ratio": 0.05,
      "p99_latency": 0.500,
      "conflicts": 0
    },
    "sample_number": 0,
    "observation_window": "test"
  }'
```

### 验证GitHub Issue创建

手动创建测试Issue：

```bash
gh issue create \
  --repo zensgit/smartsheet \
  --title "[TEST] Observability Alert Integration Test" \
  --body "Testing automated issue creation from observability script." \
  --label "alert,observability,test"
```

---

## 故障排除 (Troubleshooting)

### Webhook无响应

1. 检查ALERT_WEBHOOK_URL是否正确：
   ```bash
   echo $ALERT_WEBHOOK_URL
   ```

2. 手动测试webhook连通性：
   ```bash
   curl -v -X POST "$ALERT_WEBHOOK_URL" \
     -H "Content-Type: application/json" \
     -d '{"test": true}'
   ```

3. 检查观察日志中的curl错误：
   ```bash
   grep -i "webhook\|curl" artifacts/phase5-run.log
   ```

### GitHub Issue创建失败

1. 检查gh CLI认证状态：
   ```bash
   gh auth status
   ```

2. 验证repository访问权限：
   ```bash
   gh repo view zensgit/smartsheet
   ```

3. 手动测试Issue创建：
   ```bash
   gh issue create --repo zensgit/smartsheet --title "Test" --body "Test issue"
   ```

4. 检查观察日志：
   ```bash
   grep -i "github\|gh issue" artifacts/phase5-run.log
   ```

### 告警未触发

1. 确认环境变量已设置：
   ```bash
   env | grep -E "ALERT_WEBHOOK_URL|CREATE_GH_ISSUE"
   ```

2. 检查告警条件是否满足：
   - Success rate < 0.98?
   - Fallback ratio > 0.10?
   - 有BLOCK或CRIT事件?

3. 查看观察日志确认告警逻辑执行：
   ```bash
   grep -i "alert\|threshold\|below target" artifacts/phase5-run.log
   ```

---

## 最佳实践 (Best Practices)

1. **生产环境建议启用告警**：至少配置webhook通知，以便及时发现性能问题

2. **测试告警集成**：在生产运行前，先在测试环境验证webhook和GitHub Issue创建

3. **告警降噪**：避免设置过于敏感的阈值，防止告警疲劳
   - 当前阈值：Success rate < 98%是合理的生产标准
   - Fallback ratio < 10%允许适度回退

4. **日志留存**：保留所有告警日志用于后续分析

5. **告警响应流程**：建立告警响应SOP
   - 谁负责响应？
   - 响应时限？
   - 升级路径？

---

## 相关资源 (References)

- **观察脚本**: `scripts/observe-24h.sh`
- **Phase 5 Issue草稿**: `claudedocs/ISSUE_DRAFT_PHASE5_PROD_ENDPOINT.md`
- **主指南**: `claudedocs/OBSERVABILITY_HARDENING_COMPLETE_GUIDE.md`
- **Slack Incoming Webhooks**: https://api.slack.com/messaging/webhooks
- **钉钉自定义机器人**: https://open.dingtalk.com/document/robots/custom-robot-access
- **飞书Custom Bot**: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot

---

**创建日期**: 2025-11-14
**版本**: 1.0
**维护者**: Observability Team
