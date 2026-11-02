# Admin users review fixes: #6668 then #6676

## Frozen inputs

- Review main: `e94c982b66a0d41a2eeb7e49a1a367934f39a2b6`.
- Implementation main after fresh fetch: `b0fc545ce696d2edbfbbd9c0bc3a21bc04bcdb2b` (adds #6624 migration backfill fix).
- Parent #6668: `e456b07574799f5c043d58c92071dcfb4670fa5a`.
- Child #6676: `41babc4517fcc67944182de8594e8111a7038c36`.
- Owner authorizes bounded repairs, synthetic isolated verification, CI test-chain coverage, and independent Astra ultra review. No merge or deployment. Public updates are not part of this local execution.

## Required gates

1. Parent: role replacement removes superseded privileges using existing writer protocols; activation changes invalidate stale directory restore evidence; imported identity conflicts remain conflicts; self-disable is rejected before side effects.
2. Parent: write-route registry and behavioral permission negatives include all four batch endpoints; frontend helper tests enter both required and domain chains; no existing chain entries are removed.
3. Child: automatic purge revalidates due time and deletion incarnation under lock; concurrent administrator deletion preserves an administrator; recycle lifecycle invalidates stale recovery evidence and denies recycled/purged API token creators.
4. Child: irreversible automatic purge defaults OFF, requires exact `true`, and is registered in the actual flag registry.
5. Synthetic tests cover positive and negative behavior, real database transaction interleavings, and migration apply/down. No real tenants, external identity providers, staging, or production access.
6. Independent Astra ultra reviews final local diffs and evidence. A failed or unexecuted gate remains explicit; local tests do not constitute remote CI success.

## Environment and ownership

Grok owns bounded implementation. Codex owns integration and environment setup. Astra ultra owns independent review. Parent is repaired and verified before child integration. Preserve separate parent and child patches without modifying another checkout or overwriting remote branches.

Mac mini internal disk is critically full at preflight. Use a new, dedicated local PostgreSQL 15 cluster with synthetic data, an isolated port and explicit database URL; do not connect to default database services. Native macOS validation is not Linux CI parity. Stop the dedicated cluster after validation. Do not install dependencies into shared node_modules or change existing environments.
