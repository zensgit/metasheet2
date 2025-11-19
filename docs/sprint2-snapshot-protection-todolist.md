# Sprint 2: Snapshot Protection System TodoList

## Overview
**Duration**: 10-12 days
**Goal**: Implement snapshot labeling, protection rules engine, and enhanced observability with SafetyGuard integration

---

## Milestone A: Schema + API Design (Days 1-2)

### Database Schema
- [ ] Create migration: Add `tags`, `protection_level`, `release_channel` to snapshots table
- [ ] Create migration: Create `protection_rules` table
- [ ] Add GIN index for tags array
- [ ] Add B-tree indexes for protection_level and release_channel
- [ ] Test migration rollback

### Type Definitions
- [ ] Extend Snapshot interface with new fields
- [ ] Create ProtectionRule interface
- [ ] Create RuleCondition and RuleEffect types
- [ ] Update Kysely database types

### OpenAPI Updates
- [ ] Add snapshot label endpoints to OpenAPI spec
- [ ] Add protection rule management endpoints
- [ ] Document query parameters for filtering

---

## Milestone B: Label System Service (Days 3-5)

### SnapshotLabelService
- [ ] Implement `addTags(snapshotId, tags[])` method
- [ ] Implement `removeTags(snapshotId, tags[])` method
- [ ] Implement `setProtectionLevel(snapshotId, level)` method
- [ ] Implement `setReleaseChannel(snapshotId, channel)` method
- [ ] Implement `getByTags(tags[])` query method
- [ ] Implement `getByProtectionLevel(level)` query method
- [ ] Update `cleanupExpired()` to skip protected snapshots
- [ ] Add audit logging for all label operations

### API Routes
- [ ] `PUT /api/snapshots/{id}/tags` - Add/remove tags
- [ ] `PATCH /api/snapshots/{id}/protection` - Set protection level
- [ ] `GET /api/snapshots?tags=...` - Filter by tags
- [ ] `GET /api/snapshots?protection_level=...` - Filter by protection
- [ ] `GET /api/snapshots?release_channel=...` - Filter by channel

---

## Milestone C: Protection Rules Engine (Days 6-8)

### ProtectionRuleService
- [ ] Implement `createRule(rule)` method
- [ ] Implement `updateRule(id, updates)` method
- [ ] Implement `deleteRule(id)` method
- [ ] Implement `listRules()` method
- [ ] Implement `evaluateRules(context)` engine
- [ ] Add priority-based rule execution
- [ ] Implement condition matchers (tags_contain, protection_level, etc.)
- [ ] Implement effect applicators (block, elevate_risk, require_approval)

### SafetyGuard Integration
- [ ] Hook `evaluateRules()` into `SafetyGuard.assessRisk()`
- [ ] Dynamic risk level adjustment based on rule effects
- [ ] Double confirmation for protected snapshots
- [ ] Block operations matching rule conditions
- [ ] Add rule_id and rule_version to audit logs

### Admin API Routes
- [ ] `GET /api/admin/safety/rules` - List all rules
- [ ] `POST /api/admin/safety/rules` - Create new rule
- [ ] `PATCH /api/admin/safety/rules/{id}` - Enable/disable rule
- [ ] `DELETE /api/admin/safety/rules/{id}` - Delete rule
- [ ] `POST /api/admin/safety/rules/evaluate` - Dry-run evaluation

---

## Milestone D: Observability (Days 9-10)

### Prometheus Metrics
- [ ] `metasheet_snapshot_tags_total{tag}` - Tag usage counter
- [ ] `metasheet_snapshot_protection_level{level}` - Protection distribution
- [ ] `metasheet_snapshot_release_channel{channel}` - Channel distribution
- [ ] `metasheet_protection_rule_evaluations_total{rule,result}` - Rule evaluations
- [ ] `metasheet_protection_rule_blocks_total{rule,operation}` - Blocked operations
- [ ] `metasheet_snapshot_protected_skipped_total` - Cleanup skip counter

### Grafana Dashboard
- [ ] Create `snapshot-protection.json` dashboard
- [ ] Protection level distribution panel (pie chart)
- [ ] Rule hit rate panel (time series)
- [ ] Blocked operations panel (time series)
- [ ] Tag cloud/distribution panel (bar chart)
- [ ] Protected snapshots count panel (stat)

### Alerting
- [ ] High block rate alert (>10/hour)
- [ ] Protected snapshot deletion attempt alert
- [ ] Rule evaluation failure alert

---

## Milestone E: E2E Tests & CI (Days 11-12)

### E2E Test Scenarios
- [ ] Tag CRUD operations test
- [ ] Protected snapshot deletion flow test
- [ ] Rule creation and evaluation test
- [ ] Cleanup skipping protected snapshots test
- [ ] SafetyGuard integration test

### CI Integration
- [ ] Add rule JSON schema validation script
- [ ] Add E2E tests to CI pipeline
- [ ] Trigger on snapshot/guards directory changes

### Documentation
- [ ] Update admin-api.yaml OpenAPI spec
- [ ] Create rule writing guide
- [ ] Document deployment procedure
- [ ] Document rollback procedure

### Feature Flags
- [ ] `SNAPSHOT_LABELS_ENABLED` flag
- [ ] `PROTECTION_RULES_ENABLED` flag
- [ ] Gradual rollout support

---

## Success Criteria

- [ ] 7/7 new metrics visible in Prometheus
- [ ] All E2E tests passing
- [ ] Protected snapshots cannot be deleted without confirmation
- [ ] Rules engine evaluates in <100ms P95
- [ ] Full audit trail for all operations
- [ ] Documentation complete and reviewed

---

## Files to Create

1. `src/db/migrations/YYYYMMDD_add_snapshot_labels.ts`
2. `src/db/migrations/YYYYMMDD_create_protection_rules.ts`
3. `src/services/SnapshotLabelService.ts`
4. `src/services/ProtectionRuleService.ts`
5. `src/metrics/snapshot-protection-metrics.ts`
6. `src/routes/snapshot-labels.ts`
7. `src/routes/protection-rules.ts`
8. `grafana/dashboards/snapshot-protection.json`
9. `scripts/test-snapshot-protection-e2e.sh`
10. `scripts/validate-protection-rules.ts`

## Files to Modify

1. `src/services/SnapshotService.ts` - Add label awareness
2. `src/guards/SafetyGuard.ts` - Hook rule engine
3. `src/guards/types.ts` - Extend operation types
4. `src/db/types.ts` - Add new table types
5. `src/routes/snapshots.ts` - Add filter parameters
6. `src/routes/admin-routes.ts` - Add rule management
7. `openapi/admin-api.yaml` - Document new endpoints

---

## Risk Mitigation

- **Database Migration**: Rollback script tested first
- **Performance**: Rule evaluation caching
- **Backward Compatibility**: Feature flags
- **Data Safety**: Auto-backup before protection changes
- **Rule Conflicts**: Priority system + dry-run endpoint

---

**Last Updated**: 2025-11-17
**Sprint Start**: Immediate
**Sprint End**: Day 12
