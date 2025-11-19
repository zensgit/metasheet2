# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added - Sprint 2: Snapshot Protection System (2025-11-19)

#### Database Schema
- **Migration 20251117000001**: Added snapshot labeling columns to `snapshots` table
  - `tags` (TEXT[]): Array of tags with GIN index for efficient querying
  - `protection_level` (TEXT): Protection level enum (normal, protected, critical)
  - `release_channel` (TEXT): Release channel enum (stable, canary, beta, experimental)
  - Added CHECK constraints for enum validation
  - Added B-tree and GIN indexes for query optimization

- **Migration 20251117000002**: Created protection rules infrastructure
  - `protection_rules` table: JSONB-based rule definition with conditions and effects
  - `rule_execution_log` table: Audit trail for all rule evaluations
  - Added GIN indexes on JSONB columns for efficient condition matching
  - Added priority-based rule ordering support

#### Core Services
- **ProtectionRuleService** (~600 lines)
  - Complete rule engine implementation with CRUD operations
  - Condition matching engine supporting 12+ operators (eq, ne, contains, in, gt, lt, gte, lte, exists, not_exists, etc.)
  - Composite conditions support (all/any/not logic)
  - Priority-based rule evaluation (first match wins)
  - Effect types: allow, block, elevate_risk, require_approval
  - Audit logging for all rule evaluations
  - Prometheus metrics integration

- **SnapshotService Extensions** (+260 lines)
  - `addTags()`: Add tags to snapshots with audit logging
  - `removeTags()`: Remove tags from snapshots
  - `setTags()`: Replace all tags
  - `setProtectionLevel()`: Set protection level (normal/protected/critical)
  - `setReleaseChannel()`: Set release channel (stable/canary/beta/experimental)
  - `getSnapshotsByTags()`: Query snapshots by tags
  - Enhanced `cleanupExpired()`: Skip protected/critical snapshots during cleanup
  - Prometheus metrics for tag operations

#### SafetyGuard Integration
- Made `assessRisk()` asynchronous to support rule evaluation
- Integrated protection rule evaluation into risk assessment flow
- Dynamic risk elevation based on rule effects
- Rule-based operation blocking support
- Double-confirmation requirement from rules
- Rule information stored in operation context for audit trail

#### API Routes
- **Snapshot Labels API** (`/api/admin/snapshots`)
  - `PUT /:id/tags`: Add/remove tags
  - `PATCH /:id/protection`: Set protection level
  - `PATCH /:id/release-channel`: Set release channel
  - `GET /`: Query snapshots by tags/protection/channel

- **Protection Rules API** (`/api/admin/safety/rules`)
  - `GET /`: List all rules with filtering
  - `POST /`: Create new rule
  - `GET /:id`: Get rule by ID
  - `PATCH /:id`: Update rule
  - `DELETE /:id`: Delete rule
  - `POST /evaluate`: Dry-run rule evaluation

#### Observability
- **6 New Prometheus Metrics**:
  - `metasheet_snapshot_tags_total`: Counter for tag usage
  - `metasheet_snapshot_protection_level`: Gauge for protection level distribution
  - `metasheet_snapshot_release_channel`: Gauge for release channel distribution
  - `metasheet_protection_rule_evaluations_total`: Counter for rule evaluations
  - `metasheet_protection_rule_blocks_total`: Counter for blocked operations
  - `metasheet_snapshot_protected_skipped_total`: Counter for cleanup skips

- **Grafana Dashboard** (`grafana/dashboards/snapshot-protection.json`)
  - 10 visualization panels covering all Sprint 2 metrics
  - Protection level and release channel distribution (pie charts)
  - Top 10 tags usage (bar chart)
  - Rule evaluation and blocking trends (time series)
  - Protected snapshot statistics

#### Testing
- **Integration Tests** (`tests/integration/snapshot-protection.test.ts`)
  - 25 comprehensive E2E tests covering:
    - Snapshot labeling API (8 tests)
    - Protection rules API (10 tests)
    - Protected snapshot cleanup (2 tests)
    - SafetyGuard integration (5 tests)

#### Documentation
- **Implementation Design**: `docs/sprint2-snapshot-protection-implementation.md`
  - Architecture overview and technical design
  - Database schema with ERD
  - Component descriptions and integration points
  - API endpoint documentation
  - Observability setup and metrics guide

- **Deployment Guide**: `docs/sprint2-deployment-guide.md`
  - Step-by-step deployment instructions
  - Database migration verification
  - API endpoint testing commands
  - Grafana dashboard setup
  - Functional verification scenarios
  - Monitoring and alerting recommendations
  - Rollback procedures
  - Troubleshooting guide

- **Code Review Checklist**: `docs/sprint2-code-review-checklist.md`
  - Per-file review points for database migrations
  - Service layer code quality checks
  - SafetyGuard integration review
  - API routes security and validation review
  - Observability and testing review
  - Deployment readiness checklist

- **Staging Verification Script**: `scripts/verify-sprint2-staging.sh`
  - Automated staging environment verification
  - Database migration checks
  - API endpoint testing with authentication
  - Functional scenario validation
  - Performance baseline measurements
  - Rollback capability verification

- **Completion Summary**: `docs/sprint2-completion-summary.md`
  - Complete deliverables checklist
  - File inventory with status
  - TypeScript verification results
  - Quality assurance metrics
  - Next steps and recommendations

#### API Documentation
- Updated `openapi/admin-api.yaml` with:
  - 2 new tags: "Snapshot Protection", "Protection Rules"
  - 9 new endpoint definitions
  - 7 new schema components
  - Updated `CleanupResponse` schema with `skipped` field

### Changed
- SafetyGuard risk assessment is now asynchronous
- Snapshot cleanup operation now respects protection levels
- All cleanup operations now return skipped count
- Enhanced audit logging for snapshot operations

### Fixed
- TypeScript compilation errors in SafetyGuard (context.metadata → context.details)
- TypeScript implicit 'any' errors in ProtectionRuleService and SnapshotService
- Risk level type mapping in SafetyGuard rule integration

### Security
- All admin API endpoints require Bearer token authentication
- Rule evaluations logged to audit table for compliance
- Protected snapshots (protection_level = protected/critical) cannot be auto-deleted
- Input validation on all new API endpoints
- SQL injection prevention through parameterized queries

### Performance
- GIN indexes for efficient array and JSONB queries
- Concurrent index creation to avoid table locking
- Non-blocking Prometheus metrics collection
- Rule evaluation target: < 100ms
- Priority-based rule evaluation reduces unnecessary processing

### Migration Notes
⚠️ **Database Migrations Required**

Run migrations before deploying:
```bash
npm run migrate
```

Two new migrations will be applied:
- `20251117000001_add_snapshot_labels.ts`: Adds labeling columns to snapshots table
- `20251117000002_create_protection_rules.ts`: Creates protection rules infrastructure

⚠️ **Backward Compatibility**

All changes are backward compatible:
- Existing snapshots will have default values (tags = [], protection_level = 'normal', release_channel = NULL)
- Snapshot cleanup behavior unchanged for unprotected snapshots
- No breaking changes to existing API endpoints

### Rollback Procedure
If rollback is needed:
```bash
# Rollback migrations
npm run migrate:down

# Stop using new API endpoints
# Existing functionality continues to work
```

---

## [Previous Versions]

Previous changelog entries would go here...
