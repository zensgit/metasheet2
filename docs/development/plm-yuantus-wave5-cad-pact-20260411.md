# PLM Yuantus Wave 5 CAD Pact

Date: 2026-04-11

Wave 5 extends the Metasheet2 consumer pact for Yuantus PLM with the nine CAD
endpoints already called on `main`. The canonical artifact stays in:

- `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`

The pact keeps Metasheet2 as the sole source of truth and uses the exact CAD
fixtures expected by the current adapter and frontend wiring:

- `F2` properties GET: `material=AL-6061`, `finish=anodized`, `source=imported`, schema `3`
- `F3` properties PATCH: request sets `material=AL-7075`, `finish=hard-anodized`, `source=manual`; response mirrors it at schema `4`
- `F4` view-state GET: `hidden_entity_ids=[12,19]`, note `check hole position`, `source=client`, schema `3`
- `F5` view-state PATCH: request/response `hidden_entity_ids=[12,19]`, note `hide fastener`, `source=client`, `refresh_preview=false`, schema `3`
- `F6` review GET: `state=pending`, `note=Awaiting review`, `reviewed_by_id=1`
- `F7` review POST: request `{ state: approved, note: Looks good }`, response mirrors it with `reviewed_by_id=1`
- `F8` history GET: entries include `cad_properties_update` and `cad_review_update`
- `F9` diff GET vs `F10`: `added.finish=anodized`, `removed.coating=none`, `changed.weight_kg.from=1.1`, `changed.weight_kg.to=1.2`, schema version `1 -> 2`
- `F11` mesh-stats GET: `available=true`, `entity_count=2`, `triangle_count=102400`, plus bounds

Provider-state names are kept deterministic so the Yuantus verifier can seed
fixture-only responses without mutating shared state between interactions.

Verification:

```bash
cd /tmp/metasheet2-wave5-DTTxfs/packages/core-backend
npx vitest run tests/contract/plm-adapter-yuantus.pact.test.ts \
  tests/unit/plm-adapter-yuantus.test.ts
```

The consumer-side contract test checks the full 28-interaction order, while the
unit test asserts the CAD request/response examples used by the adapter-facing
surface.
