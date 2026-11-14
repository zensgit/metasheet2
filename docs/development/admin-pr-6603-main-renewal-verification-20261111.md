# #6603 current-main renewal verification

- Frozen main: `a59fa1c59fa82e3cb08cfc21ba4a428b810f07ac`.
- Previous published head: `79b4a635b3cce083367a9fa32f70ffb60f893f2a`.
- Tested code commit: `f89e015f10b37f8e970a3a99a54a0e678753b4df`; tree `fe1967014144498c0d1c2d0ba596befe110da887`.

Main advanced 69 commits since the previous tested baseline. Four password-policy slice paths overlap. The automatic integration retains the original password-policy delta, all new main authorization/lifecycle locks and test additions. It introduces no department-head or organization-workspace feature. Codex reviewed the combined reset route: typed-password validation still precedes hashing, persistence and session revocation; the new main changes to other admin operations remain intact. No further runtime change was necessary.

## Verification

Node 20.20.2 / pnpm 10.16.1 with the unchanged lockfile and existing owned frozen-lockfile installation. No inherited database or service credentials. Real DB checks used owned synthetic PostgreSQL 16.15; actual CI's platform/image checks remain a separate gate.

| Check | Result |
| --- | --- |
| Admin/auth/audit/security unit suites, 14 files | 780 passed |
| Admin/forced-change/permission UI specs, 5 files | 196 passed |
| Plugin execution inventory and synthetic canary contracts | 255 passed |
| Permission lifecycle and role-delete native suites, trust disabled | 15 passed |
| Admin batch native whole file, separate synthetic database | 95 passed |
| Admin recycle native whole file, separate synthetic database | 25 passed |
| `validate:all`, clean tracked tree, whitespace | passed |

An initial local admin-native command used a database name outside the suite's required synthetic naming pattern and was rejected before tests ran. The corrected harness uses separate compliant synthetic databases and the existing full migration command. Test guards, assertions, budgets and CI configuration were not modified. Failed harness evidence is retained privately.

The prior exact-head CI is not reused for this new source. Owner's continued authorization covers this existing branch update and actual GitHub CI, keeping Draft. No merge, deployment, real environment access, CI-variable/protection change, Mac mini or P1-6 action. The follow-up document commit changes documentation only; final SHA and CI receipts are retained in the private renewal artifacts.
