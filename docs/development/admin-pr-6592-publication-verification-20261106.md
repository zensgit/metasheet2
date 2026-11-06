# #6592 workspace and projection audit verification

## Source and dependency

- Reviewed main: `17204e649462104abfdcbce20090620c93aaa65b`.
- Original PR head: `38470bba316b8e5e9b03950cccaf5b690a14686b`.
- Verified code commit: `0ae908cc826c9525f5f76a947450020fe5869a5c`.
- Source tree: `048e8095243f1ff331d7dfbf8b6963525f4b9127`.
- Included #6589 code dependency: `67be7dbab17e9647ee4fc3529174d6e7b2957607`; its separate publication-document commit does not change this dependency's code.

The original workspace/projection feature is retained. The bounded repair preserves a trusted UUID user actor for `directory.local_member.project` in the existing text audit column; numeric IDs still populate the numeric column, and non-user/unrelated actions do not gain this text identity. A real HTTP/session/PG case verifies the persisted UUID and exactly one audit row across an idempotent retry.

The guard registry keeps current main plus both new routes (78 total / 71 platform-admin writes). Required web test lists retain both new main webhook entries and all three organization entries. No #6603 password-policy feature is mixed in. Source auditing verifies every non-slice main blob is unchanged; incoming main changes have no overlap with this slice. No timeout, assertion, gate or test inventory is weakened.

## Local verification

Node 20.20.2, pinned pnpm 10.16.1, offline frozen-lockfile dependencies; owned PostgreSQL 16.15 synthetic databases. No inherited service credentials, customer/provider access, Mac mini or shared environment.

| Check | Result |
| --- | --- |
| Audit/routing/admin/security/CI-contract backend suites, 7 files | 386 passed |
| Latest-main backend regressions, 5 files | 132 passed |
| Workspace/admin-access and latest-main web suites, 6 files | 286 passed |
| Plugin inventory/delivery contracts | 24 passed |
| Latest-main send-budget/authority/runtime contracts | 54 passed |
| Workspace native whole file, dedicated fresh database | 26 passed |
| Department-head native whole file, separate fresh database | 32 passed |
| `pnpm run validate:all`, clean tracked tree and whitespace | passed |

The first local command incorrectly put both native suites in the same database: the department-head suite passed, then the workspace's empty-default-anchor precondition failed. That failed evidence is retained, not presented as green. The harness was corrected to match the two existing CI jobs' separate databases; both whole files then passed without changing product code, test code, budgets or preconditions. Each corrected database has 461 migration entries and 462 public table entries. Local native results use macOS with containerized PostgreSQL, not a full Linux GitHub runner.

Grok 4.7 implemented the earlier repair; Codex independently reviewed the action/user boundaries and persisted audit assertions. Earlier mutation evidence for this same audit blob (`1674d090f7c3ba54438a3f73e9a8272fa0cc4066`) remains applicable to that exact source only: removing the projection action fails both unit and native coverage; removing the user-actor or action-scope guard also fails. This round separately reruns current-source positive coverage.

## Publication boundary

Owner authorized commit, push and actual GitHub CI in #6603 -> #6589 -> #6592 order. Keep Draft; no merge or deployment. Actual exact-head CI remains required and is not claimed by this pre-publication record. Private logs, database receipts and monitor snapshots remain local; real CI variables/protection are unchanged.
