# DingTalk P4 Final Evidence Hardening Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: harden final P4 evidence correctness before 142 remote smoke closeout

## Problem

Two final-handoff risks remained in the local P4 tooling:

- `unauthorized-user-denied` pass evidence could prove "no record inserted" with equal negative or fractional record counters when strict compile used `beforeRecordCount` and `afterRecordCount`.
- Reusing a packet output directory could leave old `evidence/` entries behind. The exporter only removed packet marker files, and the validator only checked manifest-registered evidence plus secret scans.

Either issue could make the release packet less auditable even when no real staging secrets were present.

## Changes

- `dingtalk-p4-evidence-record.mjs` now rejects negative or fractional values for `--record-insert-delta`, `--before-record-count`, and `--after-record-count`.
- `compile-dingtalk-p4-smoke-evidence.mjs` now requires unauthorized-denial record counters to be non-negative integers in strict mode.
- Strict compile emits `record_count_non_negative_integer_required` when a present unauthorized-denial counter is invalid.
- `export-dingtalk-staging-evidence-packet.mjs` now clears stale generated `evidence/` content when reusing an existing DingTalk packet output directory.
- Evidence copy now removes the destination evidence slot before copying, preventing old files from being merged into a new slot.
- `validate-dingtalk-staging-evidence-packet.mjs` now rejects top-level `evidence/` entries that are not registered in `manifest.includedEvidence`.
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md` now marks both hardening tasks complete.

## Operator Impact

For `unauthorized-user-denied`, use one of these valid zero-insert proofs:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id unauthorized-user-denied \
  --status pass \
  --source manual-client \
  --operator <operator> \
  --summary "<blocked submit summary>" \
  --artifact artifacts/unauthorized-user-denied/blocked-submit.png \
  --submit-blocked \
  --blocked-reason "<visible denied reason>" \
  --record-insert-delta 0
```

or:

```bash
node scripts/ops/dingtalk-p4-evidence-record.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --check-id unauthorized-user-denied \
  --status pass \
  --source manual-client \
  --operator <operator> \
  --summary "<blocked submit summary>" \
  --artifact artifacts/unauthorized-user-denied/blocked-submit.png \
  --submit-blocked \
  --blocked-reason "<visible denied reason>" \
  --before-record-count <count-before-submit> \
  --after-record-count <same-count-after-submit>
```

Both counts must be integers greater than or equal to zero.

For final handoff, the recommended closeout path remains:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet
```

If a reused packet directory contains unregistered stale evidence, the exporter removes stale generated evidence for recognized packet outputs; the validator also fails closed if stale unregistered evidence is still present.

## Out Of Scope

- No real 142 remote smoke was executed in this slice.
- No live DingTalk, backend, Redis, PostgreSQL, or staging credentials were required.
- This does not relax artifact secret scanning, external artifact gating, final-pass gating, or no-email admin evidence requirements.
