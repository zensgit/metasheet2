# Time Machine APFS official-launcher recovery verification, 2026-09-30

Status: **local synthetic PASS; staging deployment HOLD**. The tested code is commit `9c40a28f7d6fc60a8a3b720d8beab65a1113aeb5`, tree `b38f6ffea5bb4a9399a41c257da796b2ff219278`, based on main `4f19aa0b91236cf8c4fa9f081a0fdbbba239242b`. This report-only follow-up does not change that tested code. It extends the [earlier APFS proof](timemachine-apfs-backup-recovery-verification-20260930.md): the imported, manually captured generation is now restored through the official local launcher in a fresh target process.

## Environment and command

- macOS APFS Data volume; Node 24.14.1, pnpm 10.33.0, and one exclusively owned disposable PostgreSQL 15.17 loopback cluster. The source and empty target were distinct owned databases on that cluster. Archive, custody, and attachment roots were private directories on the same APFS volume. This is one host and one storage failure domain.
- The driver cleared inherited environment variables and admitted only synthetic test flags. It created synthetic credentials and passed the recovery secret through private IPC/FD3, never through command arguments or logs.
- Command shape: `NODE_ENV=test pnpm --filter @metasheet/core-backend exec tsx scripts/verify-recovery-local-backup.mts --admin-url "$TM_OWNED_ADMIN_URL" --pgdata "$TM_OWNED_PGDATA" --work-root "$TM_OWNED_WORK_ROOT"`. These placeholders denoted only this run's owned disposable cluster and private root. The exact-code-SHA run exited 0. Its retained local log has SHA-256 `7fdc3cd41cc43b1e400941eeb7946d769a8588fe943c3a806ee87aa353b7afcf`.
- Test-tool SHA-256: backup driver `bf5d74749869db7d040c6b4bf9e887a1e5f2f2e8c746faadfa35bed302a8a2d8`; manual HTTP helper `8692bdb53f5aa53ac0212438e6c8d5cf1a7421be788c117cb090ba133c23b3f8`; target launcher helper `2b39109e1de190af6adb8cbb0786fdbe77ef478baad093f51facfccf754f8764`; process worker helper `1fc1b86181716f1cad87f968bae06bccd38de3ad2035e955e28dc2717040d888`.

## Exact-SHA results

| Gate | Result |
| --- | --- |
| Manual capture and same-generation import | PASS. Real authenticated HTTP capture returned a verified synthetic scalar-and-attachment generation. The quiesced backup imported its catalog, archive objects, and custody package into the empty target. The source database and roots were unavailable before target restore. Source, imported, previewed, and restored generation identities matched. |
| Official target launcher | PASS. A fresh process started the repository's `start-recovery-local.mts`; it exposed no listener before FD3 operator unlock. A synthetic user logged in through its HTTP route and used catalog, preview, and execute to restore the imported generation. Graceful stop left no listener. |
| Exact restoration and refusal | PASS. Scalar data, record version/history, attachment reference, and attachment bytes matched capture. Hiding the captured object refused before target writes. Replay did not perform a second write. |
| Separate larger worker control | PASS. The existing seeded 5,001-row two-database worker drill ran before the official launcher, completed in two chunks, released its writer block, drained 5,001 derived effects, and retained ten nonce sections. Existing secret, store, custody, and object negatives remained in force. This control is separate from the manually captured generation. |
| Residue | PASS. The post-run owned source/target database count and matching backend count were zero, and the run root was absent. The dedicated cluster was then stopped and its exact disposable data directory removed. |
| Type and neighbor tests | PASS. `pnpm --filter @metasheet/core-backend type-check` exited 0. Reader, preview, sync-restore, local-startup, and archive-wiring Vitest files passed: 5 files, 99 tests, exit 0. The retained unit log has SHA-256 `a04e424fd7a2956b05f0211665af76a4f39dd6a55ddc5cd1d133b453bf23b48d`. |

One earlier attempt in this launcher series failed at the existing 5,001-row derived-effect drain check after the worker reported completion. Its generic child error did not establish the cause. The 150-second drain gate was not relaxed; the process-worker diagnostic was narrowed to fixed error codes, and subsequent runs, including the run on the committed code SHA above, passed. The failed attempt is retained as a limitation, not counted as a pass.

## Remaining gates

| Gate | State |
| --- | --- |
| Draft PR exact-head CI and review | Pending for the new PR tip at report creation. Local Node 24 proof does not replace Node 20 CI. |
| Phase 5 scheduled latency samples | OPEN. Three scheduled runs had six required N/A samples each and no measured threshold breach; see [attribution](timemachine-phase5-sample-attribution-20260930.md). |
| D7 controlled staging, rollback, flag activation | HOLD for separate owner authorization after exact candidate/build SHA, environment, synthetic-data ownership, and rollback packet review. |
| Production completion | Not claimed. This same-host synthetic drill does not prove remote storage/KMS, independent-host loss, hot backup, power-loss recovery, customer-data fidelity, business UAT, or production monitoring health. |

No service deployment, persistent flag change, customer-data operation, remote KMS use, or merge occurred.
