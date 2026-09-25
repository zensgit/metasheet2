# Time Machine V1 Residual Development

Status: DRAFT/HOLD. This is a current-main closeout ledger, not a release approval.
Baseline: `1aaffe3f9fd9df20ea878aaaa0662d38bb09e7c3` (#6052 merge).

The authoritative capability contract and detailed implementation history remain in
[the attachment restore design lock](timemachine-attachment-restore-design-lock-20260919.md).
This report records only the remaining work after its bounded V1 implementation.

## Delivered On Main

- Manual archive capture, local key custody, archive preview and recovery are
  wired through the production Workbench and backend routes. The runtime remains
  gated by exact `MULTITABLE_RECOVERY_ARCHIVE_ENABLED === 'true'`.
- Synthetic owned-DB and browser acceptance covers retained soft-deleted table,
  row and field recovery, scalar changes, and synchronous recovery of original
  attachment bytes to the existing record and field. It does not imply that a
  physically hard-deleted whole table can be resurrected.
- The existing administrator, sheet, row and field authority is retained.
  Removing an attachment from a cell does not revoke its old ID; explicit
  deletion makes that ID unavailable. No new tenant or detach-revocation rule
  was introduced by this slice.
- #5882 delivered the product scope; #6050 corrected the isolated acceptance
  harness; #6052 merged the SHA-bound verification report. These are distinct
  code, test and evidence milestones, not production activation.

## Remaining Work

| Item | Current disposition | Completion evidence required |
| --- | --- | --- |
| Historical browser `API_REQUEST_FAILED` | Original event has no request identity; later complete passes do not identify its cause. The current verifier records method, pathname and aborted/transport class without weakening its zero-failure oracle. | A new attributable event or stable synthetic reproduction, followed by a scoped fix, distinguishing regression and exact-head checks. If it never recurs, retain it as an explicitly unattributed risk rather than claiming a fix. |
| Isolated storage UAT | NOT RUN on a selected local or test-NAS target. No customer storage has been connected. | Owner-specified environment and authorization for synthetic data, then capture, process restart/unlock, backup-set restore, original-byte download, permission negatives and cleanup evidence on that exact target. |
| Release and customer acceptance | Feature flag, deployment and real-tenant UAT remain separate owner gates. | Separate exact authorization and environment-specific evidence. Do not infer these from merged code or synthetic CI. |
| Phase 5 legacy metrics | The nightly missing-histogram failure is a separate operations concern, tracked by [#6054](https://github.com/zensgit/metasheet2/issues/6054). | Authorized real samples for the legacy snapshot create/restore and plugin reload metrics, or a separately reviewed monitoring-contract change; never fabricate samples or weaken the missing-sample gate. |

Asynchronous attachment restoration, hostile-NAS durability certification,
new tenant isolation, detach-immediate revocation and hard-deleted whole-table
resurrection are outside the ratified V1 scope. They are not silently added to
the release criteria above and require separate contracts.

The paired [verification report](timemachine-v1-residual-verification-20260925.md)
separates completed synthetic evidence from the NOT RUN gates.
