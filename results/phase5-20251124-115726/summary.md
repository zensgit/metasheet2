# Phase 5 观察结果摘要

**观察时间**: 2025-11-24T11:57:26+08:00
**结束时间**: 2025-11-24T11:57:26+08:00
**采样数量**: 1
**数据文件**: results/phase5-20251124-115726/metrics.csv

## 指标列说明
| 列 | 说明 |
|----|------|
| http_success_rate | HTTP 成功率 (1 - 5xx 比例) |
| p50_latency/p90_latency/p95_latency/p99_latency | 延迟分位 (秒) |
| fallback_ratio | 有效降级事件 / 总请求 (可排除 cache miss) |
| error_rate | 4xx + 5xx 综合错误率 |
| error_rate_4xx | 4xx 客户端错误率 |
| error_rate_5xx | 5xx 服务端错误率 |
| cpu_percent | 后端进程 CPU 使用率 |
| rss_mb | 后端进程常驻内存 (MB) |
| request_rate | 每秒请求速率 (delta/间隔) |
| fallback_total/http/message/cache | 降级事件分源原始计数 |
| http_adapter_ops | HTTP 适配器操作总计 |
| message_bus_rpc_attempts | MessageBus RPC 尝试总计 |
| cache_get_attempts | 缓存 get 尝试总计 |
| fb_http_ratio/message_ratio/cache_ratio | 分源降级率 (源计数/源操作数) |
| plugin_reload_success/failure | 插件重载成功/失败计数 |
| snapshot_* | 快照创建/恢复成功失败计数 |

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

