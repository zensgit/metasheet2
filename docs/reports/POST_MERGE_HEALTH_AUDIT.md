# Post Merge Health Audit (Dynamic Loading + Strict Gates)

## Scope
Audit main branch after merging migration activation (042 chain), strict gates, and plugin cleanup/instrumentation.

## Components
| Area | Status | Notes |
|------|--------|-------|
| Migrations (042a–d) | Stable | Placeholder + final audit tables present |
| MIGRATION_INCLUDE | Canonical | 042a, 042c (plugins + placeholder), 042d active |
| Strict Gates | Enabled | SKIP_* removed, guard/strict scripts passing |
| Dynamic Loader | Inserted (flags off) | Safe defaults, no runtime change when disabled |
| Sandbox | Post-activation noop | Future: pre-init isolation |
| Validator | Lightweight | Warnings logged, failures counted |
| Metrics | Stub counters | plugin_loaded_total / plugin_validation_fail_total |
| Capability Matrix | Soft (no entries) | Hard enforcement enabled (passes with no registrations) |
| Duplicate Loader Code | Removed | Consolidated in core/plugin-loader.ts |

## Validation Commands
```bash
bash scripts/migrations-lint.sh
bash scripts/migration-include-guard.sh
bash scripts/capability-matrix-verify.sh
bash scripts/plugin-lint.sh
```

## Risk Snapshot
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Unused sandbox path drift | Medium | Medium | Move wrap earlier + tests |
| Capability list not updated when added | Medium | Low | Enforce matrix update policy |
| Metrics not scraped (prom-client absent) | Low | Low | Add metrics init doc |
| Validator false positives stop load | Low | Medium | Flags allow soft-disable |

## Follow-up Backlog
- Pre-activation sandbox instrumentation
- Capability matrix hard gating once keys added
- Persistence (>=0430 migrations) for plugin manifests
- Timeout / resource limiting for future sandbox

