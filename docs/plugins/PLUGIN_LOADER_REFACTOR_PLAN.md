# Plugin Loader Refactor Plan

## Goals
- Single authoritative loader implementation.
- Optional sandbox + validator layers (flag gated).
- Capability registration centralized; no side-effect scanning.

## Current Issues Observed
- Duplicate loader classes (core vs plugins dir).
- Mixed responsibility: discovery + validation + sandboxing entangled.
- Environment flags inconsistently named.

## Target Architecture
```
core/plugin-loader.ts        # Discovery + lifecycle orchestration
core/plugin-sandbox.ts       # Sandbox wrapper (no-op if disabled)
core/plugin-validator.ts     # Manifest + capability validation
core/plugin-capabilities.ts  # Registry helper (add/list)
plugins/example-plugin/      # Non-production sample
```

## Lifecycle (Load Path)
1. Discover candidate plugin dirs (official + optional local).
2. Read manifest (plugin.json).
3. Validate manifest (PluginValidator) → capability matrix check.
4. Wrap entry (if sandbox enabled) → returns proxied interface.
5. Register capabilities.
6. Emit telemetry event (plugin_loaded) with id + capabilities.

## Feature Flags
| Flag | Default | Description |
|------|---------|-------------|
| PLUGIN_DYNAMIC_ENABLED | false | Enable discovery & load |
| PLUGIN_SANDBOX_ENABLED | false | Wrap plugin exports in sandbox |
| PLUGIN_VALIDATE_ENABLED | true | Enforce manifest/capability checks |

## Capability Matrix Enforcement
- On registration, if capability key missing from CAPABILITIES_MATRIX.md → log warning & (optionally) reject (future hard mode).

## Telemetry (initial)
- plugin_loaded_total{plugin_id}
- plugin_validation_fail_total{reason}
- plugin_sandbox_wrap_total{plugin_id}

## Rollout Steps
1. Merge refactor behind flags (default OFF).
2. Remove duplicate loader/sandbox/validator files (DONE - pending merge).
3. Enable in CI only (dynamic ON / sandbox OFF).
4. Observe metrics stability.
5. Gradually enable sandbox in staging.
6. Add persistence (migration ≥0430).

## Open Questions
- Multiple plugin versions concurrently? (future: version pinning)
- Hot reload trigger? (fs watch vs admin API)
- Sandboxed IPC/resource limits policy granularity.
