# MetaSheet V2 Roadmap

## Phases
1. Core Integration MVP – DONE
2. Messaging RPC & Retries – DONE
3. Plugin Lifecycle & Sandbox – DONE
4. Observability (Prometheus) – DONE
5. Messaging Pattern + Expiry – DONE
6. Event Bus Metrics Unification – DONE
7. Permission Denial Metrics – DONE
8. Plugin Reload & Hot Swap – DONE
9. Snapshot / Versioning MVP – DONE
10. Advanced Messaging (delay, DLQ, backoff) – FUTURE
11. Performance & Scale (pattern index, sharding) – FUTURE

## Completed
- DB connection pool & stats
- Event bus basic (string + regex)
- Message bus (priority, retries, RPC, pattern, expiry, metrics)
- Sandbox permission groups (database.*, events.basic, messaging.*, http.register)
- Plugin lifecycle load/activate & subscription cleanup
- Prometheus metrics exporter + CI grep
- Event Bus metrics counting unified (eventsEmittedTotal)
- Permission denial metrics (permissionDeniedTotal, PermissionMetrics class)
- Plugin reload: reloadPlugin() method, HTTP endpoint, metrics (pluginReloadTotal, pluginReloadDuration)
- Snapshot/versioning: DB tables (snapshots, snapshot_items, snapshot_restore_log), SnapshotService, REST API, metrics

## In Progress
- None (All planned phases complete through Phase 9)

## Near-Term Planned
- Plugin hot swap during reload (cache module state)
- Snapshot auto-cleanup for expired snapshots
- Snapshot diff comparison API

## Future Enhancements
- Delay scheduling & dead-letter queue
- Pattern subscriber indexing (prefix buckets / trie)
- RPC latency histogram & active correlations gauge
- Auditing expansion & structured logs

## Metric Backlog
| Metric | Purpose | Priority |
|--------|---------|----------|
| rpcActiveCorrelations | RPC inflight gauge | Medium |
| messagesDelayed_total | Delay adoption | Future |
| plugin_reload_total / failures | Ops insight | Medium |
| snapshot_create_total / restore_total | Versioning adoption | Medium |

## Known Technical Debt
- RPC timeout path still keeps reply subscription (will unsubscribe in enhancement)
- Event bus previously had dual counting (now unified)
- Linear scan of patternSubs (optimize later)
- In-memory message queue (no persistence)

## Principles
- Ship minimal vertical slices with metrics
- Backward compatible within V2 until formal semantic versioning
- Favor observability before scale optimization
