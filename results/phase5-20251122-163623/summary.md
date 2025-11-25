# Phase 5 观察结果摘要

**观察时间**: 2025-11-22T16:36:24+08:00
**结束时间**: 2025-11-22T16:36:26+08:00
**采样数量**: 3
**数据文件**: results/phase5-20251122-163623/metrics.csv

## 指标列说明
| 列 | 说明 |
|----|------|
| http_success_rate | 成功请求占比 (1-成功率) |
| p99_latency | 直方图推导 P99 延迟 (秒) |
| fallback_ratio | fallback_total / total_requests |
| error_rate | 5xx 请求占比 |
| cpu_percent | 后端进程 CPU 使用率 (ps) |
| mem_percent | 后端进程内存使用率 (ps) |

## 下一步
1. 使用生产 METRICS_URL 重跑以确认真实延迟与波动。
2. 更新  添加 Production 部分。
3. 根据结果冻结正式 SLO，并存档 CSV。

