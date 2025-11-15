# Claude Documentation Index

Status: ![docs-health](https://github.com/zensgit/smartsheet/actions/workflows/docs-health.yml/badge.svg)

This directory contains documentation generated and maintained by Claude Code for the MetaSheet v2 project.

## 📚 Documentation Categories

### 🔒 Security & Credentials

**Available Documentation**:

- **[CREDENTIAL_ROTATION_GUIDE.md](./CREDENTIAL_ROTATION_GUIDE.md)** ⭐ **ACTIVE**
  - Comprehensive guide for rotating exposed credentials
  - Covers JWT_SECRET, DB_PASSWORD, REDIS_PASSWORD, ADMIN_PASSWORD
  - Includes verification steps, troubleshooting, and rollback plans
  - **700+ lines**, ready for production use

**Implementation Status**:

- ✅ **Environment Validation Integration**: Completed in commit 670e5de
  - Pre-hooks added to package.json for automatic validation
  - Development mode: `pnpm dev` validates before startup
  - Production mode: `pnpm start` validates before startup
  - Scripts: `scripts/validate-env.sh`, `scripts/docker-entrypoint-validate.sh`

- ✅ **Documentation Organization**: Created centralized index (commit c281ba9)
  - This README.md serves as unified documentation entry point
  - Organized by category: Security, PRs, Architecture, Packages

---

### 🎯 Pull Request Management

- [PR_245_FINAL_REPORT.md](./PR_245_FINAL_REPORT.md)
- [PR_245_MERGE_COMPLETE.md](./PR_245_MERGE_COMPLETE.md)
- [PR_245_OBSERVABILITY_FIX_SUMMARY.md](./PR_245_OBSERVABILITY_FIX_SUMMARY.md)
- [PR_245_STATUS_REPORT.md](./PR_245_STATUS_REPORT.md)
- [PR_261_CI_STATUS_REPORT.md](./PR_261_CI_STATUS_REPORT.md)
- [PR_261_OBSERVABILITY_E2E_ENHANCEMENT.md](./PR_261_OBSERVABILITY_E2E_ENHANCEMENT.md)
- [PR_263_MERGE_REPORT.md](./PR_263_MERGE_REPORT.md)
- [PR_263_WORKFLOW_LOCATION_FIX.md](./PR_263_WORKFLOW_LOCATION_FIX.md)

---

### 🏗️ Architecture & Implementation

- [BASELINE_ABSTRACTION_FOLLOWUP_REPORT.md](./BASELINE_ABSTRACTION_FOLLOWUP_REPORT.md)
- [CORE_PR_SPLIT_STRATEGY.md](./CORE_PR_SPLIT_STRATEGY.md)
- [MERGE_STRATEGY_ACTION_PLAN.md](./MERGE_STRATEGY_ACTION_PLAN.md)
- [ISSUE_257_RBAC_METRICS_FIX_REPORT.md](./ISSUE_257_RBAC_METRICS_FIX_REPORT.md)

---

### 📦 Package-Specific Documentation

Located in `/packages/claudedocs/`:

- [PR_246_TRACK1_COMPLETE_SUMMARY.md](../packages/claudedocs/PR_246_TRACK1_COMPLETE_SUMMARY.md)
- [PR_271_TYPECHECK_FIX_REPORT.md](../packages/claudedocs/PR_271_TYPECHECK_FIX_REPORT.md)
- [PR_272_MERGE_GUIDE.md](../packages/claudedocs/PR_272_MERGE_GUIDE.md)
- [PR_272_PHASE2_RBAC_IMPLEMENTATION.md](../packages/claudedocs/PR_272_PHASE2_RBAC_IMPLEMENTATION.md)
- [PR_273_PHASE3_ROUTES_IMPLEMENTATION.md](../packages/claudedocs/PR_273_PHASE3_ROUTES_IMPLEMENTATION.md)
- [PR_274_PHASE4_METRICS_COMPATIBILITY.md](../packages/claudedocs/PR_274_PHASE4_METRICS_COMPATIBILITY.md)
- [PR_275_PHASE5_PLUGIN_TOUCHPOINTS.md](../packages/claudedocs/PR_275_PHASE5_PLUGIN_TOUCHPOINTS.md)

---

## 🚀 Quick Start Guides

### Security Setup

**Credential Rotation**:
- Use [CREDENTIAL_ROTATION_GUIDE.md](./CREDENTIAL_ROTATION_GUIDE.md) for step-by-step rotation
- Covers JWT_SECRET, DB_PASSWORD, REDIS_PASSWORD, ADMIN_PASSWORD
- Includes verification, troubleshooting, and rollback procedures

**Environment Validation** ✅:
- Already integrated into `package.json` (commit 670e5de)
- Automatic validation on `pnpm dev` and `pnpm start`
- Scripts available: `scripts/validate-env.sh`, `scripts/docker-entrypoint-validate.sh`

### Development Workflow

1. **Environment Setup**:
   ```bash
   # Automatic validation on development start
   pnpm -F @metasheet/core-backend dev

   # Manual validation
   pnpm -F @metasheet/core-backend validate:env:dev
   ```

2. **Production Deployment**:
   ```bash
   # Automatic validation on production start
   pnpm -F @metasheet/core-backend start

   # Manual validation
   pnpm -F @metasheet/core-backend validate:env:prod
   ```

---

## 📋 Documentation Conventions

### File Naming

- **Security**: `SECURITY_*_YYYYMMDD.md`
- **Pull Requests**: `PR_###_DESCRIPTION.md`
- **Guides**: `*_GUIDE.md` or `*_MANUAL.md`
- **Reports**: `*_REPORT.md` or `*_SUMMARY.md`
- **Checklists**: `*_CHECKLIST.md`

### Status Indicators

- ⭐ **NEW**: Recently added (last 7 days)
- ✅ **COMPLETE**: Fully implemented and verified
- 🚧 **IN PROGRESS**: Active development
- ⚠️ **ACTION REQUIRED**: User action needed
- 📋 **REFERENCE**: For future reference

---

## 🔗 Related Project Documentation

### Main Project README
- [metasheet-v2/README.md](../README.md)

### Component-Specific READMEs
- [apps/web/README.md](../apps/web/README.md)
- [packages/observability/README.md](../packages/observability/README.md)
- [packages/openapi/README.md](../packages/openapi/README.md)
- [scripts/README.md](../scripts/README.md)

---

## 📝 Contributing to Documentation

When adding new documentation to this directory:

1. **Follow naming conventions** (see above)
2. **Add entry to this README** under appropriate category
3. **Include creation date** in document header
4. **Use status indicators** (⭐ NEW, ✅ COMPLETE, etc.)
5. **Link to related documents** in "References" section
6. **Add to Quick Start Guides** if relevant for onboarding

---

## 🗂️ Archive Policy

Documents older than 6 months may be moved to `claudedocs/archive/` unless:
- Still referenced in active workflows
- Part of security audit trail
- Required for compliance

---

---

## 📝 Metrics & Monitoring Rollout

**Rollout Plan**: [METRICS_ROLLOUT_PLAN.md](./METRICS_ROLLOUT_PLAN.md) ⭐ **NEW**
- Comprehensive 6-phase implementation guide
- Based on ROI and risk prioritization
- Includes timelines, success criteria, and rollback procedures

**Phase Summary**:
1. **短期观察** (48h) - Validate metrics stability, establish baseline
2. **严格模式** (Week 1) - Switch to fail mode, enforce branch protection
3. **最小告警** (Immediate) - Critical alerts to Slack, validation workflow
4. **Grafana 仪表板** (Week 1) - Visual monitoring with customizable variables
5. **Pushgateway 运维** (Week 1-2) - Cleanup automation, prevent metric bloat
6. **治理与可持续** (Ongoing) - Quarterly allowlist reviews, documentation

**Future Enhancements** (Optional):
- Grafana dashboard variables: `scan_type`, `branch`, `repo`, threshold=90%, window=24h
- validate-env.sh "CI mode" with JSON output for pipeline artifacts
- Cross-repository reusable workflow templates
- Advanced alerting with PagerDuty integration

---

**Last Updated**: 2025-10-23
**Maintained By**: Claude Code
**Questions**: Refer to specific document or project maintainers
