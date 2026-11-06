# #6589 department-head integration verification

## Scope and source

- Reviewed main: `17204e649462104abfdcbce20090620c93aaa65b`.
- Original PR head: `ee5663a409b7f98b9246c58df8284e9e974b58db`.
- Verified code commit: `67be7dbab17e9647ee4fc3529174d6e7b2957607`.
- Source tree: `6939b6019c124b6bad89dc96a267550d97b3f938`.

This slice retains the original department-head feature and current main. It does not include #6592's workspace/projection feature or #6603's password-policy changes. Conflict resolution preserves the newer main guard registry and native-test exclusions: 77 registered admin writes, 70 platform-admin writes; the new department-head DB suite remains excluded only from the no-DB runner and has its own whole-file native workflow. The handover upgrade case is retained. No security gate or timeout is weakened.

The latest 21-path main delta is non-overlapping and its incoming blobs were verified unchanged after an automatic merge. Earlier Grok 4.7 integration was independently checked by Codex; the isolated slice is revalidated here rather than reusing a combined-tree pass.

## Local evidence

Node 20.20.2, pinned pnpm 10.16.1, offline frozen-lockfile dependencies; PostgreSQL 16.15 in an owned synthetic-only container. No inherited service credentials, provider IO, customer data, Mac mini or shared database.

| Check | Result |
| --- | --- |
| Audit, directory routing, admin guards and CI contract, 4 files | 240 passed |
| Latest-main backend regressions, 5 files | 132 passed |
| Latest-main webhook and owner-send web tests, 3 files | 174 passed |
| Plugin inventory/delivery contracts | 24 passed |
| Latest-main send-budget/authority/runtime contracts | 54 passed |
| Applied-handover pre-head schema upgrade case | 1 passed; 23 deliberately unselected |
| Native department-head and handover suites, whole files | 52 passed, no skipped cases |
| `pnpm run validate:all`, clean tracked tree and whitespace | passed |

The filtered upgrade run is a distinct pre-migration check, not a substitute for the whole-file run. The isolated database finished with 461 migration entries and 462 public table entries. Actual Linux GitHub CI is a separate required gate; local native tests use macOS with containerized PostgreSQL.

## Publication boundary

Owner authorized the existing-branch update and actual CI, keeping Draft. No merge, deployment, real CI-variable change or branch-protection change. Raw test logs and private resource receipts stay in the local task artifacts. CI results are not claimed by this pre-publication document.
