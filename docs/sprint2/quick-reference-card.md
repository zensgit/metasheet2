# Sprint 2 - Quick Reference Card

**快速命令速查表** | **最后更新**: 2025-11-21 13:20 CST

---

## 🎯 24h决策点 (今晚22:28)

### 步骤1: 检查凭证状态
```bash
gh issue view 5 --repo zensgit/metasheet2 --json comments \
  --jq '.comments[-1] | {author: .author.login, time: .createdAt, preview: .body[0:100]}'
```

### 步骤2A: 如果凭证到达
```bash
# 1. 停止监控器
kill 72134

# 2. 设置环境变量
export STAGING_BASE_URL="<提供的URL>"
export STAGING_JWT="<提供的token>"

# 3. 执行暂存验证 (60-90分钟)
cd /Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2
bash /tmp/execute-staging-validation.sh

# 4. 更新文档并提交PR
# (验证脚本会生成报告)
```

### 步骤2B: 如果无凭证（预期）
```bash
# 发布24h决策通知
gh issue comment 5 --repo zensgit/metasheet2 \
  --body-file docs/sprint2/24h-decision-notice-draft.md

# 确认发布成功
gh issue view 5 --repo zensgit/metasheet2 --json comments \
  --jq '.comments | length'
```

---

## 🔍 日常监控 (每2小时)

### 快速健康检查
```bash
# 一键状态检查
echo "=== Sprint 2 Status ===" && \
echo "Watcher: $(ps aux | grep 72134 | grep -v grep | wc -l | tr -d ' ') process(es)" && \
echo "Server: $(lsof -i :8900 2>/dev/null | grep LISTEN | wc -l | tr -d ' ') active" && \
echo "Branch: $(git branch --show-current)" && \
echo "Latest: $(git log -1 --oneline)" && \
echo "Issue: https://github.com/zensgit/metasheet2/issues/5"
```

**预期输出**:
```
=== Sprint 2 Status ===
Watcher: 1 process(es)
Server: 1 active
Branch: feature/sprint2-snapshot-protection
Latest: 9682366a docs(sprint2): add 24h decision notice draft
Issue: https://github.com/zensgit/metasheet2/issues/5
```

### Issue #5 检查
```bash
# 查看最新评论
gh issue view 5 --repo zensgit/metasheet2

# 统计评论数
gh issue view 5 --repo zensgit/metasheet2 --json comments \
  --jq '.comments | length'
```

### Watcher日志
```bash
# 最近20行
tail -20 /tmp/staging_watch.log

# 检查错误
tail -50 /tmp/staging_watch.log | grep -i error
```

---

## ⚡ 应急操作

### 重启Watcher (如果死掉)
```bash
# 检查状态
ps aux | grep 72134 | grep -v grep

# 如果没输出，重启:
cd /Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet/metasheet-v2
nohup bash scripts/watch-staging-token-and-validate.sh 5 > /tmp/staging_watch.log 2>&1 &
echo "New PID: $!"
```

### 快速烟雾测试
```bash
# 生成JWT
LOCAL_JWT=$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'ops',roles:['admin']},'dev-jwt-secret-local',{expiresIn:'1h'}))")

# 执行30秒测试
bash scripts/staging-latency-smoke.sh "$LOCAL_JWT" http://localhost:8900
```

### 服务器健康检查
```bash
# 基础健康
curl -sS http://localhost:8900/health | jq '{status, timestamp}'

# 详细插件状态
curl -sS http://localhost:8900/health | jq '{status, plugins: .plugins.summary}'
```

---

## 📋 48h决策点 (明晚22:28, 如需要)

### 确认仍无凭证
```bash
# 最终检查
gh issue view 5 --repo zensgit/metasheet2 --json comments \
  --jq '{total: (.comments | length), last_24h: [.comments[] | select(.createdAt > "2025-11-21T14:28:00Z")] | length}'
```

### 提交PR（带条件标签）
```bash
gh pr create \
  --title "Sprint 2: Snapshot Protection System" \
  --body-file docs/sprint2/pr-description-draft.md \
  --label "Local Validation Only" \
  --label "Staging Verification Required" \
  --label "P1-high" \
  --base main

# 获取PR号
gh pr list --head feature/sprint2-snapshot-protection --json number \
  --jq '.[0].number'
```

### 创建后续Issue
```bash
# 替换 <PR_NUMBER> 为实际PR号
gh issue create --repo zensgit/metasheet2 \
  --title "[Post-Merge] Sprint 2 Staging Validation" \
  --label "P1-high" \
  --label "Post-Merge" \
  --body "## Post-Merge Staging Validation Required

**Related PR**: #<PR_NUMBER>
**Priority**: P1-high
**Timeline**: Complete within 24h of merge

**Required Items**:
- Staging BASE_URL
- Admin JWT Token (2h validity acceptable)

**Validation Steps**: See docs/sprint2/staging-validation-report.md
**Rollback Plan**: docs/sprint2/rollback.md

**Estimated Time**: 60-90 minutes validation
**Scripts Ready**:
- scripts/verify-sprint2-staging.sh
- scripts/staging-latency-smoke.sh"
```

---

## 🛠️ 故障排查

### 问题: Watcher无响应
```bash
# 检查进程
ps aux | grep 72134

# 检查日志错误
tail -100 /tmp/staging_watch.log | grep -E "(error|timeout|failed)"

# 检查GitHub API限流
curl -s https://api.github.com/rate_limit \
  -H "Authorization: token $(gh auth token)" | jq '.rate'
```

### 问题: 服务器无响应
```bash
# 检查端口占用
lsof -i :8900

# 检查进程
ps aux | grep "tsx src/index.ts"

# 重启服务器
cd packages/core-backend
npm run dev
```

### 问题: JWT Token过期
```bash
# 重新生成（1小时有效期）
node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:'ops',roles:['admin']},'dev-jwt-secret-local',{expiresIn:'1h'}))"
```

---

## 📚 关键文档路径

| 文档 | 路径 | 用途 |
|------|------|------|
| **24h决策框架** | `docs/sprint2/24h-decision-brief.md` | 决策逻辑与选项 |
| **24h通知草稿** | `docs/sprint2/24h-decision-notice-draft.md` | 今晚发布用 |
| **操作清单** | `docs/sprint2/operations-checklist.md` | 完整操作指南 |
| **待命报告** | `docs/sprint2/standby-status-report.md` | 系统状态概览 |
| **PR草稿** | `docs/sprint2/pr-description-draft.md` | PR提交用 |
| **验证报告** | `docs/sprint2/staging-validation-report.md` | 验证状态跟踪 |
| **风险评估** | `docs/sprint2/pr-description-draft.md:129+` | 20个风险详情 |
| **回滚计划** | `docs/sprint2/rollback.md` | 应急回滚步骤 |

---

## 🔑 关键信息

| 项目 | 值 |
|------|-----|
| **Issue #5** | https://github.com/zensgit/metasheet2/issues/5 |
| **分支** | feature/sprint2-snapshot-protection |
| **Watcher PID** | 72134 |
| **服务器端口** | 8900 |
| **日志路径** | /tmp/staging_watch.log |
| **最新commit** | 9682366a |
| **24h时间点** | 2025-11-21 14:28 UTC (22:28 CST) |
| **48h时间点** | 2025-11-22 14:28 UTC (22:28 CST) |

---

## ⏱️ 时间线速查

```
2025-11-20 14:28 UTC  ✅ Issue #5创建
2025-11-20 22:28 CST  ✅ Day 1开始
2025-11-21 00:07 CST  ✅ 12h检查点
2025-11-21 08:14 CST  ✅ 18h更新
2025-11-21 13:20 CST  ✅ 当前（T-9h）
2025-11-21 22:28 CST  ⏳ 24h决策点 ← 今晚
2025-11-22 22:28 CST  ⏳ 48h决策点 ← 明晚（如需）
```

---

## 💡 快速提示

- 📌 **保存此文件**: 命令随时可用
- ⚡ **一键复制**: 所有命令可直接粘贴执行
- 🔄 **定时检查**: 每2小时运行快速健康检查
- 📱 **Issue监控**: 手机也可以查看GitHub Issue #5
- ✅ **验证优先**: 凭证一到立即执行（不要等待）

---

**版本**: 1.0 | **创建**: 2025-11-21 | **维护**: Sprint 2 Team
