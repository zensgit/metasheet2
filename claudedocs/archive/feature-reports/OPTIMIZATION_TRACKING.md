# 📊 性能优化追踪计划

## 🎯 优化目标与时间线

### 1. OpenAPI Lint 清理 ✅
- **状态**: 已完成
- **PR**: #66
- **预期效果**: 8 warnings → 0-2 warnings
- **影响**: 仅文档改进，无运行时影响

### 2. P99 阈值渐进式收紧 📈

#### 当前基线（2025-09-22）
```yaml
P99_THRESHOLD: "0.3"   # 当前设置
实际表现: 0.0012s      # 远低于阈值
稳定性: 高             # 波动范围 0.0012-0.0036s
```

#### 收紧计划
| 阶段 | 阈值 | 触发条件 | 目标日期 | 状态 |
|------|------|----------|----------|------|
| Phase 1 | 0.3s | 基线建立 | 2025-09-22 | ✅ 当前 |
| Phase 2 | 0.25s | 连续10次 < 0.01s | 2025-09-29 | ⏳ 待定 |
| Phase 3 | 0.2s | Phase 2稳定1周 | 2025-10-06 | 📅 计划 |
| Phase 4 | 0.1s | Phase 3稳定2周 | 2025-10-20 | 🎯 目标 |

#### 监控脚本
```bash
# 检查最近10次P99值
for i in $(gh api "repos/zensgit/smartsheet/contents/reports?ref=gh-pages-data" \
  --jq '.[].name' | grep json | tail -10); do
  gh api "repos/zensgit/smartsheet/contents/reports/$i?ref=gh-pages-data" \
    --jq '.content' | base64 -d | jq '.metrics.p99_latency'
done | awk '{sum+=$1; if($1>max)max=$1} END {
  print "Average:", sum/NR
  print "Maximum:", max
  print "Ready for 0.25?", (max<0.01?"YES":"NO")
}'
```

### 3. 后端状态机与 ENFORCE_422 🔧

#### 当前状态
```yaml
ENFORCE_422: "false"  # 兼容模式，接受200和422
问题: 状态转换验证不一致
```

#### 实施步骤
- [ ] Week 1: 验证后端状态机逻辑
- [ ] Week 2: 单元测试覆盖所有状态转换
- [ ] Week 3: 生产环境观察422响应率
- [ ] Week 4: 启用 ENFORCE_422=true

#### 状态转换矩阵
| 动作 | 允许的初始状态 | 期望响应 |
|------|----------------|----------|
| approve | PENDING, RETURNED | 200/422 |
| reject | PENDING, RETURNED | 200/422 |
| return | PENDING | 200/422 |
| revoke | APPROVED | 200/422 |

### 4. RBAC 缓存优化 🚀

#### 当前指标
```yaml
RBAC_SOFT_THRESHOLD: "60"  # 软警告阈值
实际命中率: 40%            # 持续低于阈值
状态: ⚠️ 需要优化
```

#### 优化策略

##### Phase 1: 多样化预热（立即）
```javascript
// 当前：3次相同查询
for (let i = 0; i < 3; i++) {
  await fetch('/api/permissions?userId=u1');
}

// 优化为：多用户预热
const users = ['u1', 'u2', 'u3', 'admin', 'viewer'];
for (const userId of users) {
  await fetch(`/api/permissions?userId=${userId}`);
}
```
**预期提升**: 40% → 50-55%

##### Phase 2: TTL优化（Week 2）
```javascript
// 当前
const CACHE_TTL = 300; // 5分钟

// 优化为分层TTL
const CACHE_CONFIG = {
  permissions: { ttl: 600 },    // 10分钟
  userRoles: { ttl: 3600 },     // 1小时
  departments: { ttl: 7200 }    // 2小时
};
```
**预期提升**: 50-55% → 60-65%

##### Phase 3: 智能预热（Week 3）
```javascript
// 基于访问模式的预测性预热
async function smartWarmup() {
  const hotPaths = await analyzeAccessPatterns();
  await Promise.all(
    hotPaths.map(path => cacheManager.preload(path))
  );
}
```
**目标**: 稳定 >65%

## 📈 监控仪表板

### 关键指标追踪
- **仪表板**: https://zensgit.github.io/smartsheet/
- **历史报告**: https://github.com/zensgit/smartsheet/tree/gh-pages-data/reports

### 每日检查清单
- [ ] 查看P99趋势
- [ ] 检查RBAC命中率
- [ ] 验证无新增lint警告
- [ ] 检查422响应统计

## 🔄 执行计划

### 本周任务（2025-09-22 至 2025-09-29）
1. ✅ 合并OpenAPI lint清理PR
2. ⏳ 监控P99稳定性（目标：10次运行）
3. ⏳ 实施RBAC多样化预热
4. ⏳ 验证后端状态机逻辑

### 下周任务（2025-09-29 至 2025-10-06）
1. [ ] 评估P99阈值收紧至0.25
2. [ ] 实施RBAC TTL优化
3. [ ] 后端状态机单元测试
4. [ ] 收集422响应统计

### 决策点
| 日期 | 决策项 | 判断标准 |
|------|--------|----------|
| 2025-09-29 | P99收紧至0.25 | 最近10次P99均<0.01s |
| 2025-10-06 | RBAC阈值调整 | 命中率稳定>55% |
| 2025-10-13 | 启用ENFORCE_422 | 422响应率稳定 |
| 2025-10-20 | P99收紧至0.1 | 99.9%运行<0.05s |

## 📊 成功标准

### 短期（1个月）
- ✅ OpenAPI零lint警告
- 🎯 P99阈值达到0.25s
- 🎯 RBAC命中率>55%
- 🎯 422响应一致性>95%

### 中期（3个月）
- 🎯 P99阈值达到0.1s
- 🎯 RBAC命中率>70%
- 🎯 完全启用ENFORCE_422
- 🎯 零误报告警

## 🛠️ 工具命令

```bash
# 更新P99阈值
gh variable set P99_THRESHOLD --body "0.25"

# 更新RBAC阈值
gh variable set RBAC_SOFT_THRESHOLD --body "65"

# 启用严格422模式
gh variable set ENFORCE_422 --body "true"

# 查看当前配置
gh variable list

# 获取性能趋势
gh api "repos/zensgit/smartsheet/contents/reports?ref=gh-pages-data" \
  --jq '.[].name' | tail -10 | while read f; do
  echo -n "$f: "
  gh api "repos/zensgit/smartsheet/contents/reports/$f?ref=gh-pages-data" \
    --jq '.content' | base64 -d | jq -r '.metrics | "\(.p99_latency)s P99, \(.rbac_cache_hit_rate*100)% RBAC"'
done
```

---

**创建时间**: 2025-09-22
**下次评审**: 2025-09-29
**负责人**: DevOps Team