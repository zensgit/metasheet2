# K3 WISE Preflight Boolean Coercion Sweep · Verification

> Date: 2026-04-25
> Pairs with: `integration-core-k3wise-preflight-bool-coercion-design-20260425.md`

## Commands run

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node --check scripts/ops/integration-k3wise-live-poc-preflight.mjs
git diff --check
```

## Results

```
✔ 13 tests pass (was 9; +4 new)
✔ syntax check pass
✔ no whitespace issues
```

### New test cases (all pass)

1. **`buildPacket coerces sqlServer.enabled "true" string and still applies allowedTables guard`**
   - Asserts: `enabled: 'true'` + `mode: 'middle-table'` + `allowedTables: ['t_ICItem']` → throws `sqlServer.allowedTables` violation
   - Asserts: `enabled: 'no'` + no explicit mode → `safety.sqlServerMode === 'disabled'`

2. **`buildPacket coerces sqlServer.writeCoreTables "true" string`**
   - Asserts: `writeCoreTables: 'true'` + `enabled: true` + `mode: 'middle-table'` + safe `allowedTables` → still throws core-table violation (the writeCoreTables flag alone is enough to trigger guard)

3. **`buildPacket coerces bom.enabled "true" string and enforces productId requirement`**
   - Asserts: `bom: { enabled: 'true', productId: undefined }` + no PLM `defaultProductId` → throws `bom.productId` requirement
   - Asserts: `bom: { enabled: '否' }` → BOM PoC pipeline absent from packet

4. **`buildPacket accepts numeric 0/1 for boolean flags but rejects other numbers`**
   - Asserts: `enabled: 1` + no mode → `sqlServerMode === 'readonly'` (default for enabled)
   - Asserts: `enabled: 0` + no mode → `sqlServerMode === 'disabled'`
   - Asserts: `autoSubmit: 2` → throws `/0 or 1/` message
   - Asserts: `autoAudit: NaN` → throws `/finite/` message

### Regression check (existing 9 tests unchanged)

- `buildPacket emits Save-only external systems, pipelines, and BOM product scope` ✔
- `buildPacket blocks production K3 WISE environments` ✔
- `buildPacket blocks Submit/Audit automation in live PoC packet` ✔
- `buildPacket blocks SQL Server writes to K3 core business tables` ✔
- `buildPacket normalizes safe customer formatting variants` ✔
- `buildPacket rejects truthy Submit/Audit strings and invalid flag values` ✔
- `buildPacket blocks schema-qualified and quoted K3 core SQL table writes` ✔
- `buildPacket requires BOM product scope when BOM PoC is enabled` ✔
- `renderMarkdown and CLI outputs do not leak submitted secret values` ✔

## Manual spot checks

- Read the diff for `normalizeSafeBoolean()`: number branch sits between boolean and string checks, preserving precedence order; `Number.isFinite` rejects `NaN`/`Infinity` before strict 0/1 comparison.
- Verified `gate.sqlServer.enabled`, `gate.sqlServer.writeCoreTables`, `gate.bom.enabled` are now canonical booleans in the returned object — confirmed by grep of `=== true` remaining only at lines 415 and 462 (`gate.bom.enabled === true`), which is now safe because the value is canonically `true`/`false` post-normalization.

## Outstanding (not in this PR)

- Reviewer item #2 (UX) — `mode: 'disabled'` while `enabled: true` produces the generic "must be readonly, middle-table, or stored-procedure" error; clearer guidance ("set `enabled: false` instead") deferred to a separate minor PR.
- Same-class audit on `integration-k3wise-live-poc-evidence.mjs` deferred — that script reads pre-validated PoC output, so customer-side boolean inputs do not flow through it.
