## Sprint 2 Capacity Tracking

Purpose: Monitor storage growth of core tables (snapshots, snapshot_items, protection_rules, rule_execution_log, views) to anticipate scaling and index needs.

Collection Script: `scripts/capacity-snapshot.sh` → outputs `capacity-YYYYMMDD-HHMMSS.json` + `.md` in this directory.

Recommended Cadence:
- Before Staging validation (baseline)
- Daily at 09:00
- Post large backfill or migration

Alert Thresholds:
- Single table > 1 GB or 24h growth > 15% → Yellow
- Single table > 5 GB or index growth > 30% week-over-week → Red

Next Actions When Threshold Crossed:
1. Review slow queries (EXPLAIN ANALYZE)
2. Add / adjust composite indexes for high cardinality filters
3. Consider partitioning (by date or tenant) if snapshot_items grows rapidly
4. Evaluate archival strategy for rule_execution_log entries

Rollback Safety: Capacity reporting is read-only; no write or mutation performed.

