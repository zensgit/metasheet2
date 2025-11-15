# Plugin Dynamic Loading Rollback Guide

## Fast Disable (No Code Revert)
Set environment flags:
```
PLUGIN_DYNAMIC_ENABLED=false
PLUGIN_SANDBOX_ENABLED=false
```
Restart service → dynamic loading path skipped.

## Soft Validation Relaxation
If lightweight validation causes false-negatives:
```
PLUGIN_VALIDATE_ENABLED=false
```
(Leave dynamic load ON while debugging validation rules.)

## Full Revert (Merge Commit)
1. Identify merge commit hash of dynamic loading PR
2. Tag current state (optional):
   `git tag pre-dynamic-revert-$(date +%Y%m%d%H%M)`
3. Revert:
   `git revert -m 1 <merge_commit_hash>`
4. Deploy

## Post-Revert Cleanup
- Remove any dangling plugin processes (future worker model)
- Ensure capability matrix does not list removed capabilities (or mark deprecated)

## Common Recovery Scenarios
| Symptom | Cause | Action |
|---------|-------|--------|
| Loader crash on startup | Malformed manifest | Disable flag → inspect manifest logs |
| Sandbox wrap errors | Incompatible plugin shape | Disable sandbox flag, file issue |
| Missing capabilities warnings | Matrix outdated | Update CAPABILITIES_MATRIX.md |
| Performance drop | Excessive plugin count / heavy init | Disable dynamic, profile plugin init |

## Observability Signals (Add When Metrics Active)
- plugin_loaded_total spike after deploy
- plugin_validation_fail_total rising
- sandbox_wrap_fail_total > 0

