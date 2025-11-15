# 📅 2025-09-25 复盘任务清单

## 🎯 P99阈值调整

### 检查项
1. **收集P99数据** (2025-09-22 至 2025-09-25)
   - [ ] 查看3天内所有Observability运行的P99值
   - [ ] 确认是否稳定在 < 0.1s
   - [ ] 检查Weekly Trend中P99趋势

### 执行步骤
如果P99稳定在0.1s以下：

1. **更新默认值**
   ```yaml
   # 文件: .github/workflows/observability-strict.yml:22
   # 修改前:
   P99_THRESHOLD: ${{ vars.P99_THRESHOLD || '0.3' }}
   
   # 修改后:
   P99_THRESHOLD: ${{ vars.P99_THRESHOLD || '0.1' }}
   ```

2. **移除TODO注释**
   ```yaml
   # 删除第21行的TODO注释:
   # TODO: After 2-3 days of stable 0.1s performance, update default to '0.1'
   ```

3. **提交PR**
   ```bash
   git checkout -b chore/sync-p99-threshold
   git add .github/workflows/observability-strict.yml
   git commit -m "chore: Sync P99 threshold default to 0.1s after stable performance"
   gh pr create --title "chore: Sync P99 threshold default value" \
                --body "After 3 days of stable performance, updating default from 0.3s to 0.1s"
   ```

## 🔐 ENFORCE_422 评估

### 检查项
1. **收集422响应数据**
   - [ ] 查看最近的Observability运行日志
   - [ ] 确认是否返回422（而非200）
   - [ ] 统计连续成功次数

### 执行步骤
如果连续2-3次成功返回422：

1. **设置仓库变量**
   ```bash
   gh variable set ENFORCE_422 --repo zensgit/smartsheet --body "true"
   ```

2. **观察2-3次运行**
   - 确认所有运行成功

3. **移除兼容代码**
   ```yaml
   # 文件: .github/workflows/observability-strict.yml
   # 移除第117-120行的兼容逻辑:
   elif [ "$code" == "200" ] && [ "${ENFORCE_422}" != "true" ]; then
     echo "Contract check passed (temporary): Backend allows repeated approvals (200)"
     echo "Note: Will enforce 422 once backend is updated in CI"
   ```

## 📝 监控指标

### 最新状态（2025-09-22）
| 指标 | 当前值 | 目标 | 状态 |
|------|--------|------|------|
| P99 Latency | 0.0012s | < 0.1s | ✅ |
| RBAC Hit Rate | 87.5% | > 60% | ✅ |
| Error Rate | 0.0000 | < 0.005 | ✅ |
| OpenAPI Lint | 6 | 0 | ⚠️ |

### 检查命令
```bash
# 查看最近的P99数据
gh run list --repo zensgit/smartsheet --workflow "Observability (V2 Strict)" --limit 10 --json conclusion,createdAt | jq

# 查看Weekly Trend
curl -s https://zensgit.github.io/smartsheet/reports/weekly-trend.md

# 检查变量设置
gh variable list --repo zensgit/smartsheet | grep -E "P99_THRESHOLD|ENFORCE_422"
```

## ⚠️ 重要提醒

1. **执行日期**: 2025-09-25 (周三)
2. **负责人**: DevOps团队
3. **风险**: 过早收紧可能影响CI稳定性
4. **回滚**: 保留原始值作为备份

---
**创建时间**: 2025-09-22  
**计划执行**: 2025-09-25  
**文档维护**: Claude Code Assistant