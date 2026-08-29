# Phase D2a archive-catalog boundary (2026-08-26)

- **Status:** Draft / HOLD. This is an implementation-slice boundary, not an enablement or merge
  authorization.
- **Parent contract:** `multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`,
  ratified at SHA-256 `19f10cd8d7259861c75ee6d82af4f421f29b875101a5a2a583c0a73c67009caf`.
- **Default posture:** `MULTITABLE_RECOVERY_ARCHIVE_ENABLED` remains exact-literal OFF. This slice
  has no runtime caller and does not touch staging, production, or any recovery flag value.

## Delivered by D2a

D2a provides only the additive catalog and closed TypeScript contract needed by later D2 slices:

- archive-generation binding and state constraints;
- exact coverage-row binding and immutable verified coverage;
- generation-scoped source-pin and archive-object reference classes;
- fail-loud source-schema and owned-object collision checks;
- the atomic successful handoff in one transaction: matching archive-object references are created,
  matching source pins are released, and the parent generation is finalized;
- a deferred commit guard that refuses an archive-object reference committed without finalizing its
  parent generation;
- required-CI wiring plus a post-install behavioral proof that an armed real-DB spec cannot skip
  when `DATABASE_URL` is absent.

No archive bytes, staging objects, provider adapter, KMS call, retention/prune caller, physical
deleter, route, or scheduler is implemented here.

## Implementation clarification: same-anchor replacement authority

D1 remains authoritative that every correction is a **new archive generation** and that a verified
payload is never edited in place. A replacement generation for the exact same recovery point does
not, however, mint a second D-I0 operation history or a second reservation map for that point. The
claim-anchor guard therefore accepts only these two closed shapes:

1. the first generation owns exactly the ten D-I0 reservations, including the ordinal-10 parent
   snapshot reservation; or
2. a later generation owns zero reservations and reuses the exact ten-row authority of a different,
   finalized `verified` or `expired` generation whose workspace/base/sheet, anchor operation/seq,
   checkpoint, format version, and source-vector hash all match.

A replacement that owns a partial or new reservation set, points at a mismatched source vector or
recovery identity, or cannot resolve one exact finalized authority generation fails closed. This is
an implementation clarification of immutable-generation replacement, not permission to mutate a
payload, relax source binding, or reuse an operation identity for another recovery point.

The D2 source/claim closeout proves this shape with production v2 claims on a freshly migrated
PostgreSQL database. Its cumulative real-DB roster is 11 files, 235 tests, zero skips; mutations that
remove same-anchor authority reuse or omit the claim-anchor predecessor during migration replay both
turn the corresponding proof red.

## Explicit HOLD: abandoned source pins

D1 D-G step 7 and the D2 fault-path pin-release requirement are **not delivered by D2a**. A committed
`source/building` pin whose generation later becomes `abandoned` remains fail-closed and cannot be
deleted by the current catalog guard. This prevents an unowned cleanup from exposing a live builder,
but it is not stale-pin cleanup.

A later stacked D2 slice must add the staging-object inventory and replace or extend
`meta_recovery_archive_attachment_ref_guard_row` so cleanup is allowed only after all of these are
proven in the same owner/fence protocol:

1. the parent generation is abandoned and its lease is expired;
2. the cleanup actor CAS-claims a newer owner fence on that parent;
3. no sealed staging object or archive-object reference remains for the attachment;
4. the delete names the `source` class and cannot affect another generation;
5. the final delete rechecks the same parent owner/fence before commit.

The later slice must mutation-prove live-builder preservation, stale-owner refusal, staged-object
presence refusal, cross-generation isolation, and successful cleanup by the current CAS owner. Until
that slice lands, D2a must not be described as complete D2, complete D-G, merge-ready runtime, or
archive-before-prune delivery.

## Exit gate for this slice

D2a may be reviewed as a Draft/HOLD substrate only when its exact head has:

- type-check, unit contract, manifest, CI-wiring, and package-provenance checks green;
- fresh-migration plus real-DB catalog tests green with zero skips;
- mutation evidence for the migration guards, atomic handoff, release rechecks, and fail-not-skip CI
  behavior;
- an independent review that treats the abandoned-pin work above as a blocking dependency of full
  D2 rather than silently crediting it to this sub-slice.
