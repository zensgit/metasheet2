# YiDa CLI local package closeout — 2026-10-23

## Publication scope after full-branch alignment

The earlier copied-subset evidence below is retained as history. With the owner's subsequent authorization, the permanent verifier correction, existing CI-wired regression and these two MDs are transplanted onto the complete #6315 checkout, retaining CLI compile fix `825a6fbe85c3b4df00aa794807a602f21a22c4d4` and merging main `cb22e18e196e36482ab82a7ad0dcf987a3eca064` without rewriting existing history. The merge was conflict-free.

The two acceptance helpers remain frozen **local evidence tools under the original task's `tmp/`**, not new general repository commands: their fixed package hash and temporary source layout are intentionally not portable. They are not added to this PR. Only the already-wired runtime-closure regression is the permanent new test coverage. The original CLI fix is three existing local changes: compile inclusion, CommonJS entry detection, and an import-must-not-run regression; no new endpoint, privilege, sender or production flag is introduced. See the verification MD's alignment section for complete-candidate gates and explicit historical limitations.

The on-premise package verifier accepted an archive with its compiled initialization-owner CLI removed. The bounded correction requires both `packages/core-backend/dist/scripts/bootstrap-yida-initialization-owner.js` and its direct compiled implementation, `packages/core-backend/dist/src/integration/yida-initialization-bootstrap.js`, before any later package-contract checks. There is no change to CLI parsing, live authority, transactions, immutability, sender code, or grants in production.

## Frozen inputs and implementation evidence

The copied source subset comes from actual WSL commit `825a6fbe85c3b4df00aa794807a602f21a22c4d4`, on reviewed #6315 `e1a9e914c1899f82e1b5d434e85ba3a741b17786`. It is not a complete checkout. The original source archive SHA256 is `4637ae7dc25bee656abe6e4c43ff695bc16c7e73e5bd65c204bfa08a0ef527df`; the supplemental pin-input archive SHA256 is `7e05248e817bf974d46581fee48820fe3ab4df4c97202603daf43867d98c8e6d`. The additional exact-baseline `stock-prep-powershell51.yml` pin input was supplied separately from that frozen commit. No `.env` or customer evidence was read.

The immutable original `package.tgz` SHA256 is `7dc3bfdf3ff0c5ee823cae3e9a8f2788f9ac2b04c909e3e994d973d10551a17c`. The package acceptance runner asserts this before work. Derivatives have separate names and newly computed `SHA256SUMS` entries.

Grok session `gbt-9834-1a166512873-2` actually used `grok-4.7` with `xhigh`. Its connection failed/retried; it made no implementation writes and ran no checks before interruption and closure. Implementation fell back to `gpt-6.1-sol` with `high`; this is not a Grok success claim. Independent Codex review and its sibling audit artifacts are separate evidence.

## Package and provenance checks

The two new acceptance runners are frozen local-only harnesses, with this task's baseline hash, source layout, Windows tool paths and WSL distribution. They are not portable repository/CI commands. The existing CI-wired `onprem-package-runtime-closure.test.mjs` separately adds the two compiled paths to its multitable closure list; its real required-file-loop negatives permanently detect removal of either required entry.

`yida-cli-package-acceptance.mjs` calls the repository's `computePackageProvenancePinSet` and compares every manifest entry, then calls `verifySealedExportPackageProvenance({ repoRoot })`. Hashes use the exact bytes read by that implementation. The only changed provenance input is the package verifier, and the only changed manifest value is `runtimeFiles.multitableOnpremPackageVerify`:

| Input | Before | After |
| --- | --- | --- |
| verifier SHA256 | `87b01cff354a8b1f4e04a26c4b02bb5f7755498e1756d81680332d5c28314e5c` | `9d123e6c5c7b699102cd01248b8105b72df12bbc4e1bb500e6c34b4b13574a9d` |

The good derivative contains the patched verifier and pin manifest. Its inventory must differ from the original in exactly those two files. The runner executes the verifier from that extracted package against the good derivative and two derivatives missing one required file. Negatives require the exact missing-content refusal and a successful outer checksum, so neither an old checksum nor an unrelated provenance error can satisfy them. Full transitive compiled dependency closure is not newly enumerated; the direct bootstrap dependency is the bounded missing-dependency regression.

## Native CLI acceptance

`yida-cli-windows-acceptance.mjs` runs with native Windows Node, extracts the good derivative on NTFS into a new owned Windows temporary directory outside the monorepo, installs pinned `pnpm@9.15.9`, then installs the package with `--prod --frozen-lockfile --ignore-scripts`. Lifecycle execution is deliberately disabled for this local check; it is not proof of the deployment helper's lifecycle behavior. Empty owned npm user/global configs prevent use of ambient registry credentials. Only the public dependency registry is used for installation.

Every child process receives a new allowlisted environment. No inherited database URL, secrets, business flags, proxy, token, or secret-file provider is copied. CLI processes receive only fixed OS/runtime controls plus the generated synthetic `DATABASE_URL` when that test needs it. Runtime dependencies must resolve within the owned package; `tsx`, `typescript`, and `vitest` resolution must fail. A preload guard observes actual CLI executions and rejects file resolutions outside the package, recording only counters. It does not replace CLI, database, or authority logic.

The database is a new owned PostgreSQL 14 cluster in WSL Ubuntu-24.04, bound only to IPv4 loopback at a randomized port. It is a Linux database with a native Windows CLI client, not a native Windows PostgreSQL acceptance claim. `initdb`, `pg_ctl`, migrations, psql setup, and CLI queries are real. The isolated cluster's bootstrap administrator creates six synthetic ACL tables and applies the copied package's real YiDa migrations 090–096. The operator is a separate login with no superuser, BYPASSRLS, database/role creation, replication, object ownership, or powerful inherited memberships.

The operator receives database CONNECT, schema USAGE, SELECT/UPDATE on `users`, `user_roles`, `role_permissions`, `user_permissions`, `user_orgs`, `user_namespace_admissions`, and SELECT/INSERT on `integration_yida_initialization_anchor`. UPDATE on ACL tables is required for PostgreSQL `FOR SHARE` row locks; anchor UPDATE/DELETE is not granted. These are synthetic fixture grants, not a change to production privileges.

The matrix covers invalid argument shapes, absent database environment, unknown/inactive/nonadmin/wrong-tenant owners, each ACL SELECT/UPDATE removal, anchor SELECT/INSERT removal while the table is still empty, one-anchor success, BOM/CRLF input, exact unchanged idempotent rerun, and a conflicting different live administrator. Every refusal and rerun compares the full anchor row including its generated command identifier and creation timestamp, without publishing those values. Permission failures are `unconfirmed`; live-authority refusals are `denied`. The negative INSERT test precedes creation because an idempotent rerun legitimately needs no INSERT.

## Cleanup and boundary

Each run has a unique receipt directory and keeps failed receipts. Synthetic credentials and manifests exist only in owned temporary paths or process memory. Cleanup attempts stop the owned cluster, requires `pg_ctl status` exit 3 before removing a cluster after any start attempt, removes exact validated owned paths, and gates a successful final receipt on all cleanup assertions. Dynamic database logs, password material, and manifests are removed with those paths. Evidence contains statuses, counts, hashes and booleans, not identities, URLs, SQL parameters, raw subprocess errors or stacks.

This work performs no customer read, external system write, YiDa send, token exchange, CI trigger, commit, push, new PR, merge, deployment, or time-service change. It does not replace review on a complete rebased checkout before any future merge.
