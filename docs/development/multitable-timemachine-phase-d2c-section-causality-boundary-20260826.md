# Phase D2c section-causality substrate boundary (2026-08-26)

- **Status:** Draft / HOLD. This is a default-off schema and internal-helper slice, not
  runtime enablement or merge authorization.
- **Parent:** D2a/D2b archive catalog and abandoned-pin cleanup on `8cccbdf790`, whose parent
  contract is the owner-ratified Phase D1 durable-archive design lock
  (`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md`, SHA-256
  `19f10cd8d7259861c75ee6d82af4f421f29b875101a5a2a583c0a73c67009caf`), especially D-I0 and D2.
- **Prerequisite:** #5195 closed the checkpoint-floor correction. This slice does not reopen
  reconstruction, prune handoff, or capture.
- **Posture:** `MULTITABLE_RECOVERY_ARCHIVE_ENABLED` remains exact-literal OFF. This slice has
  no runtime caller and performs no provider, KMS, host, staging, production, or flag-enable
  action.

## Delivered by D2c

D2c closes only the D-I0 section-causality substrate:

1. Append-only, seq-bearing `meta_sheet_section_revisions` on the shared `meta_record_chain_seq`
   domain. Section kinds are the v1 data sections (manifest names minus derived
   `coverage_index`). Actions are closed `bootstrap_snapshot|upsert|delete`. Canonical
   `entity_key` plus payload or tombstone is required; `records` section _revisions_ are legal
   only for `bootstrap_snapshot` (ordinary record mutations stay in revision/marker tables).
   Same-sheet `operation_id` is `DEFERRABLE INITIALLY DEFERRED`.
2. `meta_record_history_operations` is versioned in place. Closed
   `operation_kind` is `ordinary|section_bootstrap|archive_snapshot|restore_chunk|restore_aggregate`.
   `event_contract_version` and nullable `component_count` land with defaults that preserve
   legacy four-column ordinary rows as v1 record/marker endpoints.
3. Direct-event kinds (`ordinary`, `section_bootstrap`, `restore_chunk`) require
   `event_count >= 1`. Version 2 count/max is the exact union of record revisions, version
   markers, and section revisions. `section_bootstrap` is exactly one `bootstrap_snapshot`
   section revision and zero record events.
4. The only zero-direct-event kinds are `archive_snapshot` and `restore_aggregate`. Each has a
   distinct immutable membership table (`meta_record_history_snapshot_members`,
   `meta_record_history_operation_members`) with `DEFERRABLE INITIALLY DEFERRED` same-sheet
   parent FKs. Members insert only while the parent endpoint is absent; INSERT after the parent
   is sealed is refused. A parent-scoped fail-fast transaction lock also prevents a second
   transaction from inserting a member while the parent seal is still invisible. The dedicated
   seal inserts members first and the parent LAST. Snapshot
   members carry exact ordinal/section bindings over the nine data sections. Aggregate members
   carry a checked int4 child-count sum and max equal to the sealed `restore_chunk` rows.
5. Dedicated internal helpers live in `recovery-archive-seals.ts`:
   `sealSectionBootstrapOperation` (binds expected section kind/row_count/source_hash to the
   already-written event), `sealArchiveSnapshotOperation`, and
   `sealRestoreAggregateOperation`. `sealDirectEventOperation` seals only `ordinary` and
   `restore_chunk`. `sealOperation` remains the v1 ordinary helper.
6. Migration `up()` fails loud on parent-schema or owned-object drift. `down()` refuses while
   section-causality rows or non-legacy operation kinds remain, then restores the original
   endpoint validator, prune function, and `event_count >= 1` check.

## Snapshot source-vector authority (P1-A / P2-B / P2-C)

D1 §2.3 / D-D require every data-section membership to carry canonical `row_count` and
`source_hash`. D2c has no builder that can recompute those from live ordinary, restore_chunk,
or restore_aggregate heads. Therefore a successfully sealed `archive_snapshot` may use **only**
`section_bootstrap` members whose bootstrap payload binds exact `row_count`/`source_hash`.
Ordinary, `restore_chunk`, and `restore_aggregate` source kinds are schema-enumerated for
later slices, but the dedicated snapshot seal and DB validator fail closed
(`section_causality_snapshot_source_unfinalized`). No unfinalized source may mint a parent.
Caller-supplied 64-hex/count on a real non-record ordinary section revision is not authority.

The validator also requires `source_row.endpoint_seq = member_row.source_head_seq` for every
member, so an earlier event inside a multi-event operation cannot masquerade as the operation
head even if a later slice removes the bootstrap-only refusal.

**D2i must deliberately version/replace this validator** before ordinary / restore_chunk /
restore_aggregate source kinds become usable, and must supply the canonical section vector
rather than trusting membership-row literals.

### P2-C restore_aggregate as a future source-head kind

D1 D-I0.6–7: a successful multi-chunk restore seals a `restore_aggregate` parent with zero
direct events; the last `restore_chunk` is not the advertised whole-sheet anchor; floor-aware
replay through the aggregate contains every chunk because the writer block excludes
interleaving. After such a restore, no single chunk is the full records (or other section)
head. A later current-head archive that binds per-section source heads therefore cannot point
a data section at one `restore_chunk` without omitting sibling chunks. Archive-after-restore
will need `source_head_kind='restore_aggregate'` so D2i can compose the canonical section
vector from the aggregate membership. D2c enumerates that kind now and refuses it at seal
time; it does not add a second migration or a fake vector.

## Deliberate fail-closed choices

- `event_count >= 1` is lifted only for `archive_snapshot` (`event_count = 0`). Restore
  aggregate remains a zero-direct-event parent whose stored `event_count` is the checked int4
  child sum (`<= 2147483647`).
- A nondeferrable parent FK is not an implementation option; members-before-parent must be
  legal inside one transaction and illegal if the FK is rebuilt as immediate.
- Coverage_index is not a live section kind and is not a snapshot member.
- Ordinary logs and database exceptions for the new contract are values-free codes. Legacy v1
  validator messages are preserved for the record-only path.

## Still HOLD after D2c

D2c is not complete D2 and is not archive-before-prune delivery. It intentionally does not
provide:

- archive builder, section serializer, provider adapter, KMS/AEAD/MAC, nonce registry, or key
  lifecycle;
- D-H2 claim/capture/finalize, source-pin creation, or source-deleter enforcement;
- D3 current-head catalog creation, D4 reconstruction, D5 restore jobs, D6 UI, or D7 staging
  acceptance;
- runtime emission of section events from live writers;
- D2i canonical section vector and the validator replacement that can accept ordinary /
  restore_chunk / restore_aggregate source heads.

Those slices must remain default-OFF and independently gated. D3 must not treat a D2c
`archive_snapshot` as full-sheet authority unless every member is a payload-bound
`section_bootstrap` head.

## Exit gate for this Draft slice

- type-check and focused unit tests green;
- D2 CI placement and fail-not-skip contracts green, including this real-DB file;
- fresh Postgres 15 migration plus D2a+D2b+D2c real-DB goldens with zero skips;
- 15-migration reverse-down/forward-up replay and catalog fingerprint green;
- mutations independently prove membership INSERT-after-seal, records ordinary/restore_chunk
  source identity, unfinalized vector, bootstrap bound values, generic-helper bootstrap
  refusal, checked int4 sum, event_count>=1 lift, parent-FK deferrability, concurrent
  membership refusal while a parent seal is uncommitted, missing/duplicate/foreign members,
  forged count/max/hash, and parent-not-last;
- no flag enable, deploy, commit, or production caller.
