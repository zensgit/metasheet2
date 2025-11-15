# Enabling Dynamic Plugin Loading (Controlled Rollout)

## Flags
| Flag | Default | Effect |
|------|---------|--------|
| `PLUGIN_DYNAMIC_ENABLED` | false | Enables discovery + loading + capability registration |
| `PLUGIN_VALIDATE_ENABLED` | true | Runs lightweight manifest + capability checks |
| `PLUGIN_SANDBOX_ENABLED` | false | Wraps plugin instance post-activation (placeholder isolation) |

## Recommended Rollout Phases
1. Dry run (all flags off) – ensure no regressions.
2. Enable `PLUGIN_DYNAMIC_ENABLED=true` in CI only – observe loader stability.
3. Enable in a staging environment – track `plugin_loaded_total`.
4. Turn on `PLUGIN_SANDBOX_ENABLED=true` in staging – verify no wrap failures.
5. (Optional) Introduce hard capability enforcement (matrix missing → fail).

## Observability (initial)
| Metric | Meaning |
|--------|---------|
| `plugin_loaded_total` | Count of loaded plugin manifest capability sets |
| `plugin_validation_fail_total` | Manifests rejected by lightweight validator |

## Pre-flight Checks
```bash
bash scripts/plugin-lint.sh
bash scripts/capability-matrix-verify.sh
```

## Rollback
```
export PLUGIN_DYNAMIC_ENABLED=false
export PLUGIN_SANDBOX_ENABLED=false
# (optional) restart service / redeploy
```

## Future Hardening
- Pre-activation sandbox wrap
- Execution time / memory limits
- Capability matrix hard-fail mode
- Manifest signature / checksum verification

