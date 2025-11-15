# Pre-init Sandbox Refactor Plan

## Goal
Move sandbox wrapping earlier (before plugin module execution) so initialization code is also isolated.

## Current State
- Sandbox wraps post-activation in `plugin-loader.ts`.
- Initialization (require/import + lifecycle.install) runs unsandboxed.

## Target Flow
1. Discover manifest
2. Validate manifest
3. Resolve entry path
4. Create sandbox context (if enabled)
5. Load module INSIDE sandbox boundary
6. Register capabilities
7. Activate

## Required Changes
| Area | Change |
|------|-------|
| plugin-sandbox.ts | Add method to `executeModule(entryPath)` |
| plugin-loader.ts | Split loadPlugin: resolve path vs execute/instantiate |
| plugin-context.ts | Accept sandbox proxy for API bridging |
| metrics | Add sandbox_wrap_fail_total counter |

## Risk Mitigation
- Fallback to current post-activation wrap if early sandbox fails.
- Log module load timing for regression detection.

## Rollout Strategy
1. Introduce dual-path (flag `PLUGIN_SANDBOX_PRE_INIT=true`)
2. CI enable → staging → production
3. Remove legacy post-activation path after two stable releases

## Open Questions
- Should plugin code get isolated FS/network by default? (future policy)
- Error boundary semantics (restart plugin vs skip)

