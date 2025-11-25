# Phase 5 观察结果摘要

**观察时间**: 2025-11-24T08:51:11+08:00
**结束时间**: 2025-11-24T08:51:12+08:00
**采样数量**: 2
**数据文件**: results/phase5-20251124-085111/metrics.csv

## 指标列说明
| 列 | 说明 |
|----|------|
| http_success_rate | 成功请求占比 (1-成功率) |
| p99_latency | 直方图推导 P99 延迟 (秒) |
| fallback_ratio | fallback_total / total_requests |
| http_adapter_ops | HTTP adapter 成功操作数 (query/select/insert/update/delete/batch) 总计 |
| message_bus_rpc_attempts | RPC 尝试次数 (success/timeout/exhausted/error 聚合) |
| cache_get_attempts | 缓存 get 总尝试次数 (hit/miss/error) |
| error_rate | 5xx 请求占比 |
| cpu_percent | 后端进程 CPU 使用率 (ps) |
| mem_percent | 后端进程内存使用率 (ps) |

## 下一步
1. 使用生产 METRICS_URL 重跑以确认真实延迟与波动。
2. 更新  添加 Production 部分。
3. 根据结果冻结正式 SLO，并存档 CSV。

## Fallback 来源说明
| 列 | 来源含义 |
|----|-----------|
| fallback_total | 所有类型降级事件总计 |
| fallback_http | HTTP 适配器路由/请求失败降级 |
| fallback_message | 消息总线 RPC 超时 / 重试耗尽 |
| fallback_cache | 缓存 miss / error (miss 仅观测，生产可细化是否算降级) |

