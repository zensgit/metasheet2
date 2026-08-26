# Phase D2b abandoned source-pin cleanup boundary (2026-08-26)

- **Status:** Draft / HOLD. This is a default-off database-protocol slice, not runtime enablement or
  merge authorization.
- **Parent:** D2a archive catalog in PR #5213, whose parent contract is the owner-ratified Phase D1
  durable-archive design lock.
- **Posture:** `MULTITABLE_RECOVERY_ARCHIVE_ENABLED` remains exact-literal OFF. This slice has no
  runtime caller and performs no provider, KMS, host, staging, production, or physical-delete action.

## Delivered by D2b

D2b closes only D2a's explicitly held abandoned-pin fault path:

1. A generation-scoped staging-object inventory records an opaque object id, closed object class and
   lifecycle, the parent key id, and a values-free terminal receipt digest.
2. An abandoned generation can be cleanup-claimed only after its prior lease expires and the exact
   prior owner/fence tuple matches. The claim advances the fence exactly once and installs a bounded
   new cleanup lease.
3. A staging object can become `deleted` or `absent` only under that current owner/fence. Terminal
   receipts are immutable and are rechecked at commit.
4. A `source/building` attachment pin receives a one-transaction cleanup authorization tuple. It can
   be deleted only when:
   - its parent remains `building/abandoned/incomplete` under the same live cleanup owner/fence;
   - at least one terminal attachment staging row proves inventory for that exact attachment;
   - every staging row in the generation is terminal;
   - no same-generation `archive_object` reference exists for that attachment.
5. A deferred guard refuses a cleanup authorization that survives commit without consuming the exact
   source pin. The delete path rechecks the parent, inventory, and archive-reference predicates before
   commit, so an old owner cannot unpin a newer cleanup attempt.
6. D2a's successful active-builder handoff remains intact: an archive-object reference, source-pin
   release, and parent finalization still commit atomically.

The migration verifies the exact D2a attachment-guard source and trigger posture before rebinding that
trigger to the D2b guard. `down()` restores the original D2a binding and refuses while any staging row
or unconsumed cleanup authorization remains.

## Deliberate fail-closed choices

- Staging absence is generation-wide. One nonterminal staging row blocks every abandoned source-pin
  release in that generation.
- An empty inventory is not proof of absence. A matching terminal attachment inventory row is required.
- Cleanup ownership is carried by database rows, not a session GUC or request-derived value.
- Terminal receipts contain a lowercase SHA-256 digest only; no provider URI, object key, tenant value,
  attachment id, owner id, or secret is emitted in ordinary errors.

## Still HOLD after D2b

D2b is not complete D2 and is not archive-before-prune delivery. It intentionally does not provide:

- archive builder, section serializer, provider adapter, KMS/AEAD/MAC, nonce registry, or key lifecycle;
- source-pin creation by a live builder or source-deleter enforcement in attachment cleanup, purge,
  direct-delete, provider cleanup, or future bulk-delete paths;
- verified archive writer/reader, coverage proof, retention/prune handoff, scheduler, route, or UI;
- D3 catalog lifecycle, D4 reconstruction, D5 restore, D6 UI, or D7 staging acceptance.

Those slices must remain default-OFF and independently gated. In particular, every physical source
deleter must honor the source-pin exclusion before any archive writer becomes reachable.

## Exit gate for this Draft slice

- type-check and pure contract tests green;
- D2 CI placement and fail-not-skip contracts green;
- fresh Postgres migration plus D2a+D2b real-DB suites green with zero skips;
- 14-migration reverse-down/forward-up replay and catalog fingerprint green;
- mutations independently prove expired-owner CAS, terminal-receipt shape, generation-wide staging
  closure, one-transaction authorization consumption, cross-generation isolation, and D2a trigger
  fingerprint refusal;
- independent refute-first review on the exact head with no unresolved P1/P2.
