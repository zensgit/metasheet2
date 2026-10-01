# Same archive 5,001-row LOCAL recovery verification

Status: authorized synthetic LOCAL verification, Draft/HOLD. This is a bounded
verification increment under the original D1/D7 contract. Product activation,
D2+ merge, staging, independent durable storage and KMS gates remain open.

## Contract

- Extend the existing LOCAL verification composition only. Capture a real manual
  generation through the public admission/builder path, containing 5,001 synthetic
  records and an immutable attachment on a middle record, with all ten sections.
  Require ten section nonce identities plus the exact single attachment nonce
  identity (eleven total reservations), preserved byte-for-byte through import
  and restore. Do not accept arbitrary extra nonce rows.
  Do not seed a verified generation or relax the async attachment refusal.
- Back up the full source database/catalog and owned archive/custody. Import into
  a distinct database proven to have zero user tables before import. Remove the
  owned source database/root and prove them unavailable before target recovery.
  This proves full backup import followed by archive recovery, not archive-only
  HTTP bootstrap of an empty product catalog or hard-delete resurrection.
- Start the target with the official FD3 LOCAL composition locked; unlock using
  existing custody. First perform a synchronous selected-fields restore of only
  the attachment field. Leave all 5,001 scalar differences intact. A fresh
  whole-sheet preview of the same generation must select the async scalar job.
  These are two explicit operations, not atomic async attachment restoration.
- Use the existing bounded worker composition with one chunk per run and a slow
  interval. Observe a committed 5,000-row first chunk, kill only the verified owned
  worker process, and prove ordinary writes remain blocked. After database-time
  lease expiry, start a fresh official locked target, unlock it and take over the
  same job. Require a higher worker fence, the same immutable block fence, the
  remaining one-row chunk, exact aggregate receipt, no double apply and stale CAS
  refusal. Do not label a HTTP paused-job resume as lease takeover.
- The takeover profile uses a 60-second worker interval and lease, one chunk per
  run, a 600-second async resume horizon and a test-only 600-second parent timer.
  Finalization requires a later no-pending-chunk run; a still-live lease can make
  an intervening tick idle. After B proves done and the exact aggregate, stop B
  gracefully. Start official locked/unlocked C from a new private exclusive-create
  config differing only in the existing worker interval (10 ms). C consumes the
  existing terminal derived effects; require unchanged job/chunks/aggregate and
  restore revisions, then stop C gracefully. It never repeats restore.
- Bind evidence to one frozen source commit and exact source inventory before
  the load-bearing APFS run. Retain object/section/nonce/attachment hashes, source
  unavailability, chunk/job/aggregate witnesses, process ownership and cleanup.
  Run OFF rollback in fresh processes and compare retained table counts/digests.
- Use only owned disposable synthetic databases, APFS directories and keys for
  this run. Preserve retained LC key stores and all other sessions/worktrees.
  No customer data, shared database, external provider/KMS call, key destruction,
  staging deployment or feature activation.

## Verification

Focused script validation and applicable existing neighbor checks precede source
freeze. Independently review the composition and then run the fixed-SHA drill.
Record commands, exit status, exact hashes, assertions and owned residue counts.
The full D7 fault matrix, remote durability/KMS, Phase 5 cause and actual staging
remain separate open gates even when this bounded local drill passes.

Current checkpoint: source/focused validation only; the same-archive runtime
drill remains NOT_RUN until independent review and fixed-source freeze.
