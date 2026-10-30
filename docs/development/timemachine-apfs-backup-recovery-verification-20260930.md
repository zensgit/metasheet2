# Time Machine local APFS backup recovery verification, 2026-09-30

Status: **local synthetic PASS; staging deployment HOLD**. This report verifies the [capture-to-backup lock](timemachine-apfs-capture-backup-recovery-design-lock-20260930.md) on code commit `65a04e41a4b3e0ec9bb8c268d185ac2042a647bf`, based on main `4f19aa0b91236cf8c4fa9f081a0fdbbba239242b`. A later report-only commit does not change the tested code. No service deployment, persistent flag change, customer data, remote KMS, or merge occurred.

## Environment and inputs

- macOS APFS Data volume, one exclusively owned disposable PostgreSQL 15.17 cluster on loopback; source and target were separate owned databases on that same cluster. The archive, custody, and attachment roots were private directories on the same APFS volume. This is process/resource isolation, not a separate physical failure domain.
- Node 24.14.1 and pnpm 10.33.0. The driver cleared inherited environment variables and set only synthetic test flags in its own process and children. The cluster, source/target databases, roots, secret, and attachment bytes were disposable and created for this run.
- Driver SHA-256: `9d4fcc9d1010d3b86cf11757e90d7a462662463100bf39a8f5f3daa2ab1e4e14`; HTTP fixture helper: `5ff79f0b165478bda27e87821da627367a9df12d31bc6c7c0eeb506f324294bb`; fresh target helper: `be21a166c4c3117c53ec6fb13e5f71c038882ffeb7908083b`; acceptance TS config: `de66acf75bfa5d59eb968e9c0ea279f9fca52e442ee7acbe24a671943c5e7431`.
- The local command was `NODE_ENV=test pnpm --filter @metasheet/core-backend exec tsx scripts/verify-recovery-local-backup.mts --admin-url "$TM_OWNED_ADMIN_URL" --pgdata "$TM_OWNED_PGDATA" --work-root "$TM_OWNED_WORK_ROOT"`. These variables referred only to the dedicated disposable cluster and a new private root. Full stdout/stderr was retained locally with SHA-256 `668ddc629db0cbeff4969c51e5f5477aa972b08cdd4616ea25098eecbc78de4f`; the command exited 0.

## Results

| Gate | Result | Evidence |
| --- | --- | --- |
| Manual source capture | PASS | Real HTTP capture returned one verified generation containing a scalar record and immutable attachment; exact request replay returned the same generation. |
| Same-generation backup/import | PASS | Quiesced source dump and copied archive/custody were imported into an empty target. The source database and roots were removed before target restore. Source and target selected bindings matched exactly, and the synthetic sheet had exactly one archive generation. |
| Fresh target restore | PASS | A new process admitted copied custody, selected the imported generation through public catalog/preview, and executed public restore. Exact scalar, record version/history, attachment reference, and recovered attachment bytes matched the capture. The target attachment root was absent before restore. Replay returned conflict without a second write. |
| Captured attachment refusal | PASS | Hiding the captured attachment object made the authenticated reader refuse; target row, revision count, and job count were unchanged. Restoring the object allowed the positive path. |
| Existing larger worker control | PASS | Independent seeded 5,001-row async restore completed in two chunks; writer block released, 5,001 derived effects drained, 10 nonce sections retained, and existing wrong-secret/store/custody/object negatives passed. This is separate evidence from the manual generation. |
| Resource residue | PASS | After the run, the owned source/target database count and backend count were both zero; the run root was absent. The dedicated cluster was then stopped and its exact disposable data directory removed. |
| Type and neighbor tests | PASS | Acceptance-script `tsc --noEmit` exited 0. Reader, preview, and sync-restore unit files: 3 files, 66 tests passed, command exited 0 after Vitest cache access was granted. |

The new path first failed closed with `unsupported_attachments` when the target runtime lacked its attachment-storage capability. Supplying the real local storage service changed that refusal to a PASS. This was a direct negative/positive guard check. An earlier sandboxed unit invocation ran 66 passing assertions but exited 1 because Vitest could not write its cache; the privileged rerun above is the recorded passing command. No product route, archive format, migration, or default flag was changed by this PR.

## Remaining gates

| Gate | State |
| --- | --- |
| Draft PR exact-head CI and review | Pending at report creation; local Node 24 results do not replace the repository's Node 20 CI. |
| Phase 5 scheduled latency samples | OPEN: all three scheduled runs had six required N/A samples and no measured threshold breach. See [attribution](timemachine-phase5-sample-attribution-20260930.md). |
| Controlled staging deployment, live rollback, flag activation | HOLD for separate owner authorization after candidate SHA, environment, synthetic-data ownership, and rollback packet are reviewed. |
| Production Time Machine completion | Not claimed. This local same-host APFS drill does not prove remote staging storage/KMS, hot backup, independent host loss, customer-data fidelity, business UAT, or production monitoring health. |
