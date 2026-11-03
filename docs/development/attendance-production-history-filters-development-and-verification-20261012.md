# Attendance production verifier history filters

The real isolated Strict production-flow browser timed out filling `#attendance-from-date` after returning to Overview. The input existed but was hidden inside the default-collapsed history `<details>`. Preserve that UI default; the verifier must open the visible summary before filling date/user fields.

The script now exports a small helper: wait for visible details, return immediately when already open, click the visible summary when closed, and require the resulting open state. An ineffective click fails with `ATTENDANCE_HISTORY_FILTERS_NOT_OPEN`. The main entry uses `pathToFileURL` so importing the helper does not launch the flow. The existing plugin-tests chain adds the focused script test without removing neighbors. No product UI, API, tenant policy or feature flag changes.

Implementation commit: `3236848abd19a3a3acbcd0c07411ee139a164e1d`; parent `8b2213f1fad87569d8c89497e60ef6c062dafc36`. Source SHA256: `4c00680e3170cf34c2693f408959d00abf7b9351aacd418f10e741c961699280`; spec SHA256: `aff76f4ac173d03df535d92291bab9f978f2268a728814d7731e63a7a28ebe94`.

| Design-lock gate | Result |
| --- | --- |
| Real original regression | Complete Strict failed with an invisible date-input timeout after successful import |
| Helper behavior | 6/6 pass, 0 skipped; closed opens, already open does not toggle, ineffective click rejects, missing details error propagates |
| Neighbor coverage | 25/25 pass, 0 skipped |
| Original-source link counterexample | Missing named export fails before executing the original flow; this alone is not browser reproduction |
| Mutation | Removing post-click rejection makes the matching negative fail; restored bytes pass 6/6 |
| Import and wiring | Actual helper import is safe; static checks pin call before the field fills and the guarded entry |
| CI union | Only a focused command added to plugin-tests; deleting that addition reproduces the base workflow bytes |
| Quality | `pnpm validate:all` exit 0; `git diff --check` clean |
| Independent review | Sol 6.1 medium implementation, Astra medium independent review: 0 actionable findings; coordinator inspected diff and runtime evidence |
| Real patched production flow | Exit 0 against owned fully synthetic runtime |
| Combined local acceptance | Two complete runs: API, role provisioning, production flow, desktop and mobile PASS; before/after backend SHA proofs pass |
| Public branch/PR/CI | Not authorized for this separate repair; local only |

Commands with Node 20.20.2/pnpm 10.16.1:

```bash
node --test scripts/verify-attendance-production-flow.test.mjs \
  scripts/ops/attendance-import-scope.test.mjs \
  scripts/ops/attendance-history-reconcile.test.mjs \
  scripts/ops/attendance-smoke-workdate.test.mjs
pnpm validate:all
git diff --check
```

Combined consumer: `78aeaa6480e7f5ef5e0145ab07276c23f6b870ed` (this fix plus the separately reviewed request/readback organization fix). Combined focused tests: 29/29, 0 skipped. Real backend/front-end source: `4a00287848a2e57312a8471f0b60ea96fb9e796d` (main source plus separate locale verifier repair); backend build identity remained stable. Consumer and runtime revisions are deliberately recorded separately. None of these local revisions is claimed deployed.

The complete runs used the original Strict required API options and browser settings-save checks, plus all three provisioning roles, in a new wholly synthetic database with all 439 migrations and no exclusions. After initial fail-closed effective-permission readback, the owned synthetic employee's explicit attendance namespace admission was added through the isolated admin API; the existing policy and assertions were retained. The second complete run started at least 90 seconds after the first finished. Private evidence retains failed attempts and positive controls.

Docker deployment preflight was SKIP because this is a local source runtime; runtime-build and token-tenant acceptance preflight did run before/after. These two runs do not establish shared staging, scheduled GitHub Strict/performance, branch governance or production acceptance. No real-target data, CI variable, real environment, feature flag, branch protection, merge or deployment changes.
