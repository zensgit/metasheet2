# Time Machine launcher import compatibility correction

Owner authorized local development, testing and review on 2026-10-12. This slice
fixes existing resource launcher module loading; it does not authorize native
recovery exercises, staging, deployment or feature activation.

Base: object wire correction `b1d5d43c18` (Draft #6369), stacked on Draft #6334.

## Contract

The two explicit `.mts` resource launchers must load their existing TypeScript
modules under Node 20.20.2 and Node 24.14.1 with the existing `--import tsx` command.
Replace only local static value imports with the typed `createRequire` pattern
already used by the local launcher. Preserve module loading order, default-OFF
refusal, config validation, cancellation, startup, shutdown and error messages.
No fallback loader, flags, dependency updates or global runtime changes.

## Local gates

| Gate | Evidence required |
| --- | --- |
| Regression | Existing two launcher tests fail on unchanged Node 24 source |
| Runtime compatibility | Same resource suite passes with both Node versions |
| Startup contract | Synthetic localhost object service drains and restarts; remote CLI refuses OFF |
| Types and repository checks | Resource TypeScript configuration and validate:all pass |
| Independent review | Import-only diff and preserved lifecycle reviewed |

Fixtures use temporary ordinary files and synthetic TLS data. They do not prove
APFS volume provisioning, a real database, same-archive 5001-row recovery, native
stale-worker recovery, staging acceptance or deployment rollback.

## Verification

- Both original launcher import preambles fail under Node 24.14.1. After the
  correction, all four import-only probes pass across Node 20.20.2 and 24.14.1.
- Root ran the same six resource unit files under each runtime: 76/76 passed
  on Node 20 and 76/76 on Node 24, including both existing launcher regressions.
- Resource TypeScript configuration, `pnpm validate:all` and `git diff --check`
  passed. Existing tests already exercise the regression; no test was weakened.
- Runtime bodies after the import preambles are byte-identical to the base.
- Independent Astra source review approved the frozen two-file diff; root
  verified source hashes and the dual-runtime test results.

These local results do not replace native or staging acceptance.
