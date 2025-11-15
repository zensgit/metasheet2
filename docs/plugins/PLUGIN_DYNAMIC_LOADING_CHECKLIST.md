# Plugin Dynamic Loading Merge Checklist

## Pre-merge (Branch Rebase)
- [ ] Rebased onto strict-gates-enabled `main`
- [ ] No changes to MIGRATION_INCLUDE
- [ ] No new SQL / TS migrations introduced
- [ ] Duplicate loader files removed (only core/plugin-loader.ts remains)
- [ ] Sandbox & validator logic ONLY in `core/` (no parallel versions in plugins/)
- [ ] Example plugin present and flagged as non-production

## Feature Flags
- [ ] `PLUGIN_DYNAMIC_ENABLED` default = false
- [ ] `PLUGIN_SANDBOX_ENABLED` default = false
- [ ] `PLUGIN_VALIDATE_ENABLED` default = true (fail-close only if turned off explicitly)

## Capability Matrix
- [ ] Added any new capabilities to CAPABILITIES_MATRIX.md
- [ ] `scripts/capability-matrix-verify.sh` passes
- [ ] No spurious capability extraction warnings

## Lint & Guards
```bash
bash scripts/plugin-lint.sh
bash scripts/capability-matrix-verify.sh
bash scripts/migration-include-guard.sh
```

## Runtime Validation
| Scenario | Flags | Expected |
|----------|-------|----------|
| Baseline | all off | No dynamic load logs |
| Dynamic only | PLUGIN_DYNAMIC_ENABLED=true | Loader logs discovered plugins |
| Dynamic + Sandbox | PLUGIN_DYNAMIC_ENABLED=true, PLUGIN_SANDBOX_ENABLED=true | Sandbox wrap debug logs |
| Validator disabled | PLUGIN_VALIDATE_ENABLED=false | Skips lightweight validation |

## Logging & Metrics
- [ ] Loader logs total loaded count
- [ ] (Optional) Added debug metric placeholder lines

## Security Review Quick Checks
- [ ] No direct `fs` / `child_process` usage in plugin runtime path (except allowed abstractions)
- [ ] No unbounded eval / dynamic import of arbitrary user path
- [ ] Sandbox OFF path ≠ escalate privileges (capability checks still enforced)

## Rollback Plan
1. Set `PLUGIN_DYNAMIC_ENABLED=false`
2. (If needed) revert merge commit (no schema impact)
3. Flush any cached plugin manifests (future persistence phase)

## Post-merge TODO
- [ ] Add prom-client metrics (plugin_loaded_total)
- [ ] Persistence layer (≥0430 migration)
- [ ] Capability hard-enforcement mode (warn → fail)

