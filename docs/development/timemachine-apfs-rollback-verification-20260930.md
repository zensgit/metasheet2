# Time Machine APFS flag-OFF rollback verification — 2026-09-30

Status: **local synthetic PASS; D7 staging HOLD**. The complete run used clean code commit `456333225b017876a9c02899d8510e69ea44fdb7`, tree `da98798ffd69c0bb9bf97f2fee7eecb96545a969`. Current main `cffd5dacbc023fa4853c3c8b643f61cff2301104` was integrated by conflict-free true merge `b7b01f73b2d5a1f36214136b040ad9c634431904` before this extension. The earlier APFS and official-launcher reports keep their original tested SHAs; this report adds fresh evidence.

## Environment and command

macOS APFS Data volume; Node 24.14.1, pnpm 10.33.0, PostgreSQL 15.17. One newly initialized, exclusively owned disposable loopback cluster contained distinct source and empty target databases. Private archive, custody and attachment roots shared this host and storage failure domain. The driver cleared inherited environment and admitted synthetic process-local flags only.

Command shape: `NODE_ENV=test node --import tsx packages/core-backend/scripts/verify-recovery-local-backup.mts --admin-url <OWNED_LOOPBACK_ADMIN> --pgdata <OWNED_PGDATA> --work-root <OWNED_PRIVATE_ROOT>`. Recovery secrets stayed in private memory/IPC/FD3. The two ordinary flag-OFF children received neither a recovery secret nor archive configuration.

## Exact-code results

| Gate | Observed result |
| --- | --- |
| Same-generation capture, backup, import and restore | PASS. Authenticated manual HTTP capture returned the generation imported into the empty target. Source database and source roots were unavailable before restore. The official local launcher restored that generation's scalar data, exact attachment bytes and record history after FD3 unlock. Missing-object and replay refusal controls remained active. |
| Flag-OFF HTTP baseline and rollback | PASS. Fresh ordinary `MetaSheetServer` processes before and after the official-launcher recovery authenticated the synthetic owner. Both catalog calls returned the exact 503 `RECOVERY_ARCHIVE_CATALOG_DISABLED` body; both preview calls returned the exact 503 `RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE` body. Full response bodies matched across the two processes. |
| Flag-OFF SQL no-write scope | PASS. Each child compared counts and SHA-256 digests of canonically ordered row content before startup and after shutdown: 19 `meta_recovery_*` tables plus the synthetic sheet's records and revision rows, 21 tables in total. Every within-process comparison matched. Legitimate restore changes between the two children were separately asserted by the existing restore path; no claim is made that authentication writes are absent from unrelated auth tables. |
| Shutdown | PASS. Both OFF processes stopped and exited 0; their server address was closed and a new socket connection failed. The official recovery launcher also stopped gracefully with no listener. The parent rejects missing or invalid rollback results. |
| Separate scale control | PASS. The existing 5,001-row archive completed in two chunks, released its writer block, retained ten nonce sections and drained 5,001 derived effects. It remains a separate seeded control. |
| Residue | PASS. Independent pre-stop database/backend census was `0|0`. The runner stopped and removed its exact owned cluster; the driver removed its owned run root. A later independent census found zero matching Node processes, cluster directories and run roots. |
| Types and neighboring contracts | PASS. Acceptance-script TypeScript check exited 0. Restore-owner, writer-closure and server-wiring specs passed: 3 files, 72 tests, 0 failed/skipped, exit 0. Vitest cache was disabled. |

The evidence manifest and retained logs are local, ignored files under `artifacts/timemachine-apfs-rollback-20260930/`. The manifest records source/tool hashes, command shape, exit codes and residue. Exact-run log SHA-256: `0d4038bffa53f424b2faa0119db2385d2d3a5fc9a2b1848fcc37198587259207`. Neighbor JSON SHA-256: `b77f24a8630a0b4f4e47b6fdb0141a624b44dd037c71cbda4858bc10c6978a24`. Rollback helper SHA-256: `a779a9e2734832985a1c9e8ac969c6103289769505fc8c5f47d68038d1a9b7d3`.

## Negative verification and limitations

An earlier uncommitted verifier was injected with a synthetic record-version write during the OFF probe. It exited 1 with `RECOVERY_LOCAL_ROLLBACK_UNEXPECTED_WRITE`; independent database/backend census was zero and owned paths were removed. Mutation log SHA-256: `9162a7a5e5be75f3fe368bee4f9d6fa0eb0854048ea60ab4c1d610a0d4724458`. This negative preceded the final result-count and explicit listener-lock follow-ups and is not represented as a run of commit `456333225b`. The injection was removed before the clean committed positive run above.

The first attempt had an incorrect catalog-status expectation of 403 and returned a generic failure before the write-negative was established. Its primary cause was not independently isolated; it is retained and not counted as acceptance or a successful mutation. The existing route contract was checked, the expectation corrected to 503, and the later discriminating negative and committed positive passed.

This result proves same-host, quiesced, synthetic APFS recovery and local flag-OFF rollback only. D7 still needs a selected independent durable provider, staging KMS/test key and corresponding runtime composition, exact candidate/build SHA with current required CI and zero-skipped archive real-DB evidence, owner-authorized staging window, actual fault/scale execution and staging rollback. Phase 5 scheduled target/sample attribution remains open; the separate diagnostic PR does not retroactively supply the absent raw scrape. No deployment, persistent flag change, customer-data operation or remote KMS call occurred.
