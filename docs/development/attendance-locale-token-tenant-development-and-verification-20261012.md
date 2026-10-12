# Attendance locale token tenant repair — development and verification

Status: locally validated patch; public PR, remote CI and merge not performed. No deployment or shared-runtime acceptance.
Initial source baseline: 2ee3531faa978ec01865c4b89423707137bd3830. Branch: codex/attendance-operational-target-20261012. Contract: attendance-locale-token-tenant-design-lock-20261012.md.

## Problem and change

The scheduled workflow checks its initial token's tenant, but the locale verifier can subsequently refresh or log in and adopt an unverified replacement. HTTP200 wrong/missing tenant or an inconclusive response could reach browser/holiday operations. Login did not send the expected tenant.

The existing shared verifier now checks each bound candidate before adoption and the final effective token before browser launch. Password login supplies the configured tenant. First bound auth responses must have status200, success=true and the exact tenant; a later successful proof cannot override that failure. Initial401/403 retains refresh/login recovery, whose replacement must pass strict proof. Proof failures propagate with a fixed values-free error. Without an expected tenant, established unbound behavior is preserved. No feature flag, backend policy, UI change or workflow test replacement.

## Verification

Node20.20.2/pnpm10.16.1 validation ran in an owned Macmini worktree, with environment cleared of real target credentials. The existing locale PR contract workflow already executes both the entire behavior spec and workflow-shape spec.

| Gate | Result |
| --- | --- |
| Frozen original function reproduction | Wrong/missing/malformed tenant accepted; login tenant absent; no network |
| First expanded regression suite on original source | 47 tests:8 pass,39 intended failures,0 skipped; proves original gap |
| Final locale behavior suite | 60/60 pass,0 failed/skipped |
| Locale plus four acceptance/auth/workflow neighbor files | 134/134 pass,0 failed/skipped/cancelled/todo |
| Mutate first auth-response guard away | 6 intended failures |
| Mutate candidate proof away | 30 intended failures |
| Mutate refresh error propagation away | 10 intended failures |
| Mutate login tenant away | 2 intended failures |
| Mutate final browser-entry proof away | 14 intended failures |
| Restore saved source bytes | Identical SHA256,60/60 positive control |
| pnpm validate:all | Exit0 after final first-response repair |
| Independent Astra review | First P2 reproduced as a distinct first-response negative and repaired; final0 actionable findings |
| Public PR / remote CI / merge | NOT RUN |

Commands:

```bash
node --test scripts/verify-attendance-locale-zh-smoke.test.mjs \
  scripts/ops/attendance-locale-zh-workflow-contract.test.mjs \
  scripts/ops/attendance-acceptance-preflight.test.mjs \
  scripts/ops/attendance-auth-scripts.test.mjs \
  scripts/ops/attendance-verifier-contract.test.mjs
pnpm validate:all
git diff --check
```

Final source SHA256:c9ea953068e2c7f5277438046ab79808cfb7cabaca4dce678dc44ab104415e04.
Final spec SHA256:df3a0d7b7a5b9fb30a8f597c94bc0a1ca5f19afeda739d527efb116dc7a2a02c.
Counts overlap between positive controls and neighbor runs; do not sum them. Original operational inventory's361 hermetic tests and3shared-preflight mutations are separate evidence, not additional runtime acceptance.

Sol6.1high implemented the narrow two-file repair; coordinator added the first-response guard and distinct controls following Astrahigh refutation; Astra independently reviewed final bytes. Luna handled inventory and new isolated PostgreSQL setup. Kimi configured-default evidence advice was independently checked; alias K3 was not verified and advisory review is not runtime proof.

## Operational scope

The user chose a Macmini fully synthetic isolated test environment. A fresh owned PostgreSQL16 cluster and empty database were created;438 full Kysely migrations at the frozen baseline applied successfully with no exclusions. Real backend/auth and later smoke qualifications are tracked in private operational artifacts and are not claimed passed by this code report.

Existing repository CI org and expected deployment SHA are missing; configured target differs from the previously authorized staging. No variables/secrets/protection/flags changed or workflow dispatched. Public health self-reported another build; health200 is not acceptance of this main revision. Full shared-runtime Strict includes global directory/audit reads, settings/RBAC effects and incomplete cleanup, so a synthetic-org string alone does not isolate it. Performance provenance/token-consumer gaps and branch-protection governance remain separate operational gates. This repair does not declare them solved.

Fresh main may advance during qualification. Before publishing or merging, refresh the exact base, inspect applicable changes and rerun the relevant gates; never reuse old-SHA CI as current evidence. No deployment is authorized or performed.
