# Phase 5 Validation Scripts

集中说明与 Phase 5 相关的本目录脚本，快速执行端到端指标验证、CI 断言与生产最小校验。

## 脚本总览
| 脚本 | 场景 | 描述 | 输出 | 退出码 |
|------|------|------|------|--------|
| `phase5-full-validate.sh` | 本地开发 | 迁移→快照创建/恢复→缓存模拟→fallback 触发→可选插件重载→汇总 JSON | `phase5-validation.json` | 前置缺失=1 序列内部容错 |
| `phase5-ci-validate.sh` | CI | 快速断言关键指标（≥1 成功 + 阈值） | 文本 / JSON | 断言失败=2 环境=1 |
| `phase5-prod-validate.sh` | 生产验证 | 幂等迁移 + create/restore + 可选 reload（不触发测试路由） | 简洁 JSON | 失败>0 |
| `phase5-cache-simulation.sh` | 辅助 | 触发 miss→set→hit | 日志 | 失败不退出 |
| `phase5-fallback-trigger.sh` | 辅助 | 触发测试 fallback 路由 | 日志 | 失败不退出 |
| `phase5-run-snapshot-migration.sh` | 基础 | 调用 TypeScript 迁移执行 | 日志 | 失败>0 |
| `phase5-snapshot-migrate-and-restore.ts` | 基础 | Node 脚本：迁移→创建→恢复 | JSON 行 | 异常>0 |

## 必需环境变量
| 变量 | 用途 | 示例 |
|------|------|------|
| `DATABASE_URL` | Postgres 连接串 (迁移/快照) | `postgres://user:pass@host:5432/db` |
| `FEATURE_CACHE` | 开启缓存路径 | `true` |
| `CACHE_IMPL` | 缓存实现 | `memory` / `redis` |
| `ENABLE_FALLBACK_TEST` | 暴露 fallback 测试路由 | `true` (生产关闭) |
| `COUNT_CACHE_MISS_AS_FALLBACK` | miss 是否计入有效 fallback | `false` (验证差异) |
| `PORT` | 服务端口 | `8900` |

## 快速使用示例
```bash
# 开发全量验证
DATABASE_URL=postgres://user:pass@host:5432/db FEATURE_CACHE=true CACHE_IMPL=memory \
ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false \
./packages/core-backend/scripts/phase5-full-validate.sh --view view_123 --reload-plugin example-plugin --output phase5-validation.json
cat phase5-validation.json | jq .

# CI 验证（最少）
FEATURE_CACHE=true CACHE_IMPL=memory ENABLE_FALLBACK_TEST=true COUNT_CACHE_MISS_AS_FALLBACK=false \
./packages/core-backend/scripts/phase5-ci-validate.sh http://localhost:8900

# 生产最小验证
DATABASE_URL=postgres://user:pass@host:5432/db \
./packages/core-backend/scripts/phase5-prod-validate.sh --view view_123 --reload-plugin example-plugin
```

## 指标字段 (full JSON)
| 字段 | 含义 |
|------|------|
| `pluginReloadSuccess/Failure` | 插件重载结果计数 |
| `snapshotCreateSuccess` | 快照创建成功 |
| `snapshotRestoreSuccess/Failure` | 快照恢复成功 / 失败 |
| `cacheHits/Misses` | 缓存命中 / 未命中 |
| `fallbackTotalRaw` | 全部 fallback 次数 |
| `fallbackCacheMiss` | 原因=miss 次数 |
| `fallbackEffective` | 排除 miss 后的有效降级次数 |
| `pluginReloadLatency.p50/p95/p99` | 重载时长百分位 |
| `snapshotCreateLatency.* / snapshotRestoreLatency.*` | 快照操作时长百分位 |

## 百分位算法说明
基于 Prometheus `_bucket` 累计：rank = ceil(total * percentile)，选取首个累计 ≥ rank 的桶 `le` 值。误差来源：桶边界分辨率；可在生产调整 buckets 或改用 HDR Histogram。

## Fallback 区分
Raw: 所有 `metasheet_fallback_total` 计数。
Effective: Raw 减去 reason=miss（当 `COUNT_CACHE_MISS_AS_FALLBACK=false`）。用于度量真实降级质量而非正常缓存穿透。

## 常见故障排查
| 症状 | 原因 | 解决 |
|------|------|------|
| 快照恢复失败缺表 | 未运行迁移 | 执行 `phase5-run-snapshot-migration.sh` |
| 插件重载无计数 | 未打补丁或 metrics 导入失败 | 检查 `plugin-loader.ts` reloadInstrumentation & 重启服务 |
| 缓存命中率 NA | NullCache | 设置 `FEATURE_CACHE=true CACHE_IMPL=memory` 并执行缓存脚本 |
| fallbackEffective=raw | 未排除 miss 或无 miss | 设置 `COUNT_CACHE_MISS_AS_FALLBACK=false` 并触发缓存 miss |
| 百分位均为 0 | 无 histogram bucket 数据 | 确保至少一次操作成功后再收集 metrics |

## 后续改进建议
- 独立 Node 模块处理百分位，移除 python 依赖。
- 配置化阈值 (`phase5-thresholds.json`) 按环境差异调整。
- 定时 CI 运行与结果归档（防回归）。
- 增加插件重载失败注入用例验证失败路径延迟分布。

---
如需扩展或新增脚本，请保持命名前缀 `phase5-` 并在上表补充说明。

