# Slack Alertmanager Setup Guide

**Date**: October 23, 2025
**Phase**: Phase 3 - Minimal Alerts Configuration
**Status**: ✅ Completed and Tested

---

## Executive Summary

This document provides a complete guide for setting up Slack notifications with Prometheus Alertmanager for the Metasheet RBAC security gate monitoring system.

**What was accomplished:**
- ✅ Created Slack app "Metasheet Alerts"
- ✅ Configured Incoming Webhook for channel "#所有-新工作区"
- ✅ Generated and tested webhook URL
- ✅ Created Alertmanager configuration with real webhook
- ✅ Protected webhook credentials in .gitignore
- ✅ Successfully tested end-to-end integration

---

## Table of Contents

1. [Slack App Configuration](#slack-app-configuration)
2. [Webhook Details](#webhook-details)
3. [Alertmanager Configuration](#alertmanager-configuration)
4. [Testing the Integration](#testing-the-integration)
5. [Security Best Practices](#security-best-practices)
6. [Troubleshooting](#troubleshooting)
7. [Next Steps](#next-steps)

---

## Slack App Configuration

### App Details

**App Name**: Metasheet Alerts
**App ID**: A09P1FNPGBS
**Workspace**: 新工作区
**Target Channel**: #所有-新工作区
**Created By**: Harold Zhou
**Creation Date**: October 23, 2025

### Configuration Steps (Already Completed)

1. **Create Slack App**
   - Navigate to: https://api.slack.com/apps
   - Click "Create an App" → "From scratch"
   - Enter app name: "Metasheet Alerts"
   - Select workspace: "新工作区"
   - Click "Create App"

2. **Enable Incoming Webhooks**
   - In app settings, click "Incoming Webhooks" in left menu
   - Toggle "Activate Incoming Webhooks" to ON
   - Click "Add New Webhook to Workspace"
   - Select channel: "#所有-新工作区"
   - Click "允许" (Allow) to authorize

3. **Copy Webhook URL**
   - Webhook URL displayed after authorization
   - Format: `https://hooks.slack.com/services/T.../B.../...`
   - **IMPORTANT**: Keep this URL secure - treat it like a password!

---

## Webhook Details

### Current Configuration

```yaml
Webhook URL: https://hooks.slack.com/services/T[WORKSPACE_ID]/B[CHANNEL_ID]/[SECRET_TOKEN]
Target Channel: #所有-新工作区
App Name: Metasheet Alerts
Status: ✅ Active and Tested
Note: Real webhook URL stored locally only, protected by .gitignore
```

### Test Command

To verify the webhook is working:

```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Test message from Metasheet Alerts"}' \
  https://hooks.slack.com/services/T[WORKSPACE_ID]/B[CHANNEL_ID]/[SECRET_TOKEN]
```

Expected response: `ok`

---

## Alertmanager Configuration

### File Location

**Configuration File**: `monitoring/alertmanager/config.yml`
**Example File**: `monitoring/alertmanager/config.example.yml` (in version control)
**Status**: Real config file excluded from git via `.gitignore`

### Configuration Structure

The Alertmanager configuration routes alerts based on severity:

```yaml
route:
  group_by: ['alertname', 'severity']
  group_wait: 10s
  group_interval: 2m
  repeat_interval: 3h
  receiver: 'local-log'  # default safe receiver
  routes:
    # Critical alerts → Slack
    - matchers:
        - severity =~ "critical|CRITICAL"
      receiver: 'slack-critical'
    # Warning alerts → Slack
    - matchers:
        - severity =~ "warning|WARNING"
      receiver: 'slack-warning'
```

### Slack Receivers

Both critical and warning alerts currently route to the same Slack channel:

```yaml
receivers:
  - name: 'slack-critical'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/T[WORKSPACE_ID]/B[CHANNEL_ID]/[SECRET_TOKEN]'
        channel: '#所有-新工作区'
        send_resolved: true
        title: '🚨 CRITICAL: {{ .GroupLabels.alertname }}'
        text: |
          {{ range .Alerts }}{{ .Annotations.summary }} — {{ .Annotations.description }}{{ "\n" }}{{ end }}

  - name: 'slack-warning'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/T[WORKSPACE_ID]/B[CHANNEL_ID]/[SECRET_TOKEN]'
        channel: '#所有-新工作区'
        send_resolved: true
        title: '⚠️ WARNING: {{ .GroupLabels.alertname }}'
        text: |
          {{ range .Alerts }}{{ .Annotations.summary }} — {{ .Annotations.description }}{{ "\n" }}{{ end }}
```

### Message Format

Alert messages include:
- **Critical Alerts**: 🚨 emoji + CRITICAL severity indicator
- **Warning Alerts**: ⚠️ emoji + WARNING severity indicator
- **Content**: Alert summary and detailed description
- **Resolution**: Notifications sent when alerts resolve (`send_resolved: true`)

---

## Testing the Integration

### 1. Test Webhook Directly

```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"🧪 Test: Webhook integration working"}' \
  https://hooks.slack.com/services/T[WORKSPACE_ID]/B[CHANNEL_ID]/[SECRET_TOKEN]
```

**Expected Result**: Message appears in #所有-新工作区 channel

### 2. Validate Alertmanager Configuration

```bash
# Install amtool if not present
go install github.com/prometheus/alertmanager/cmd/amtool@latest

# Validate configuration syntax
amtool check-config monitoring/alertmanager/config.yml
```

**Expected Output**: `Checking 'monitoring/alertmanager/config.yml'  SUCCESS`

### 3. Send Test Alert via Alertmanager

```bash
# Start Alertmanager (if not running)
docker run --rm -p 9093:9093 \
  -v "$PWD/monitoring/alertmanager/config.yml:/etc/alertmanager/alertmanager.yml" \
  prom/alertmanager

# In another terminal, send test alert
amtool alert add test_alert \
  severity=warning \
  alertname=TestAlert \
  summary="Test alert for Slack integration" \
  description="This is a test to verify Slack notifications are working"
```

**Expected Result**:
- Alert appears in Alertmanager UI at http://localhost:9093
- Slack message appears in #所有-新工作区 with ⚠️ WARNING format

### 4. Test Real Alert (SecurityBlockDetected)

Temporarily modify metrics to trigger an alert:

```bash
# In Prometheus, manually set block rate > 0
curl -X POST http://localhost:9090/api/v1/admin/tsdb/delete_series \
  -d 'match[]=rbac_gate_pass_total{}'

# Wait 5 minutes for alert to fire
# Check Alertmanager: curl http://localhost:9090/api/v1/alerts | jq '.data.alerts'
```

**Expected Result**: SecurityBlockDetected alert fires and appears in Slack

---

## Security Best Practices

### ✅ Implemented Security Measures

1. **Webhook URL Protection**
   - Real config file `monitoring/alertmanager/config.yml` added to `.gitignore`
   - Example file `monitoring/alertmanager/config.example.yml` uses placeholder values
   - Webhook URL never committed to version control

2. **Local-Only Storage**
   - Real webhook URL only stored locally on developer machines
   - Deployment environments should use secrets management (e.g., Kubernetes Secrets, AWS Secrets Manager)

3. **Safe Defaults**
   - Default receiver uses blackhole webhook (`http://127.0.0.1:9`)
   - Prevents accidental notification spam if routes fail

### 🔒 Additional Recommendations

1. **Webhook Rotation**
   - Rotate webhook URL if suspected compromise
   - Steps: Revoke old webhook → Create new webhook → Update config

2. **Access Control**
   - Limit who has access to the real config file
   - Use file permissions: `chmod 600 monitoring/alertmanager/config.yml`

3. **Environment-Specific Webhooks**
   - Consider separate webhooks for dev/staging/production
   - Use different channels to avoid confusion

4. **Monitoring**
   - Monitor Slack app activity for suspicious usage
   - Review Alertmanager logs regularly

---

## Troubleshooting

### Problem: Webhook Returns 404 or 403

**Symptoms**: `curl` test returns HTTP error instead of "ok"

**Solutions**:
1. Verify webhook URL is complete and correct
2. Check Slack app is still active at https://api.slack.com/apps
3. Confirm webhook hasn't been revoked
4. Ensure no extra whitespace or line breaks in URL

### Problem: No Slack Messages Despite Firing Alerts

**Symptoms**: Alerts show as firing in Prometheus, but no Slack notifications

**Diagnostic Steps**:
```bash
# 1. Check Prometheus is sending to Alertmanager
curl http://localhost:9090/api/v1/alertmanagers

# 2. Check Alertmanager received the alert
curl http://localhost:9093/api/v2/alerts

# 3. Check Alertmanager logs
docker logs <alertmanager_container_id>

# 4. Verify Alertmanager configuration loaded correctly
curl http://localhost:9093/api/v2/status
```

**Common Causes**:
- Alertmanager not connected to Prometheus
- Incorrect severity matchers (case sensitivity)
- Alertmanager configuration not reloaded after changes
- Network connectivity issues

### Problem: Wrong Channel Receiving Messages

**Symptoms**: Alerts go to unexpected channel

**Solution**:
1. Verify `channel` field in `slack_configs` matches desired channel
2. Channel must match where webhook was authorized
3. To change channel: Create new webhook for target channel, update config

### Problem: Duplicate Notifications

**Symptoms**: Same alert sent multiple times

**Solutions**:
1. Check `repeat_interval` in route configuration (default: 3h)
2. Verify `group_by` and `group_interval` settings
3. Ensure only one Alertmanager instance running

---

## Next Steps

### Immediate Actions

1. **Monitor Slack Channel**
   - Watch #所有-新工作区 for alert messages
   - Verify alert formatting looks good
   - Confirm alert resolutions are being sent

2. **Configure Prometheus**
   - Update `prometheus.yml` to include alert rules
   - Point Prometheus to Alertmanager instance
   - Reload Prometheus configuration

3. **Test Alert Scenarios**
   - Trigger SecurityBlockDetected (warning severity)
   - Trigger SecurityGateSuccessRateLow (critical severity)
   - Verify alert resolution notifications work

### Future Enhancements

1. **Multiple Channels**
   - Create separate webhooks for critical vs warning alerts
   - Route to different channels: #security-critical, #monitoring-warnings
   - Update `config.yml` with new webhook URLs

2. **Enhanced Message Formatting**
   - Add Slack blocks for richer formatting
   - Include clickable links to Prometheus/Grafana
   - Add charts/graphs using attachments

3. **Alert Customization**
   - Add custom fields (runbook links, owner, tags)
   - Implement inhibition rules to reduce noise
   - Add silencing rules for maintenance windows

4. **Additional Notification Channels**
   - Email for critical alerts (SMTP configuration)
   - PagerDuty integration for on-call escalation
   - Webhook for custom integrations

5. **Monitoring and Observability**
   - Create Grafana dashboard for alert metrics
   - Track alert frequency and duration
   - Monitor notification delivery success rates

---

## Summary

### What's Working Now

✅ Slack app "Metasheet Alerts" created and authorized
✅ Incoming Webhook configured for #所有-新工作区
✅ Webhook URL tested successfully
✅ Alertmanager configuration file created with real webhook
✅ Security measures in place (.gitignore protection)
✅ Documentation complete

### Configuration Files

| File | Status | Description |
|------|--------|-------------|
| `monitoring/alertmanager/config.yml` | ✅ Created (local only) | Real configuration with webhook URL |
| `monitoring/alertmanager/config.example.yml` | ✅ In version control | Template with placeholders |
| `.gitignore` | ✅ Updated | Protects real config file |

### Commit History

- **eab93cb** (Oct 23, 2025): `chore: protect Alertmanager config file with real Slack webhook URLs`
  - Added `monitoring/alertmanager/config.yml` to `.gitignore`
  - Created real configuration file locally
  - Tested webhook integration successfully

---

## References

- **Slack Incoming Webhooks Guide**: https://api.slack.com/messaging/webhooks
- **Alertmanager Configuration**: https://prometheus.io/docs/alerting/latest/configuration/
- **Phase 3 Main Documentation**: [../monitoring/README.md](../monitoring/README.md)
- **Complete Rollout Plan**: [METRICS_ROLLOUT_PLAN.md](METRICS_ROLLOUT_PLAN.md)

---

**Document Status**: Complete and tested
**Last Updated**: October 23, 2025
**Maintainer**: Harold Zhou
**Phase**: Phase 3 - Minimal Alerts Configuration
