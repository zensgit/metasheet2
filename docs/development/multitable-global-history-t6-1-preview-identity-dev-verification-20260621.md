# Global History — T6-1 Restore Preview-Identity Contract 开发与验证 MD

> First step of the T6 scoped-restore slice (owner-ratified). **Contract ONLY** — the mint/verify module +
> goldens, per the T6 design-lock SR-3. **Touches no route and writes nothing**; the mint→preview and
> verify→execute wiring + the forward-revision write are T6-2 (the owner's "不直接碰 destructive restore").

## 1. What it is

`restore-preview-identity.ts`: a stateless, signed identity a preview (T5-2) will mint and the restore execute
(T6-2) will verify, so **execution matches the preview** (SR-3).

- `mintRestorePreviewIdentity(claims, expiresIn='10m')` → a JWT/HS256 token (same primitive as invite-tokens,
  via `secretManager` `RESTORE_PREVIEW_SECRET` → `JWT_SECRET` fallback).
- `verifyRestorePreviewIdentity(token, expected)` → `{ valid, reason }`. JWT covers signature + expiry; the
  per-claim checks bind every axis.
- `hashPreviewChanges(changes)` → the canonical diff hash bound into the identity.

**Bound claims:** `{ sheetId, recordId, targetVersion, strategy:'revert', changesHash, actorId }`.

**SCOPE LOCK (v1 = record-version only).** This identity binds a SINGLE record-version restore — it does NOT
express a batch / multi-record / field-subset scope. So **T6-2 v1 must execute a single-record record-version
restore ONLY**; the design-lock's batch / fan-out restore is a LATER slice that adds a `scope` claim (kind +
recordIds/fieldIds/batchId) and binds a scope canonical hash. A matching `changesHash` must not be read as
authorizing a wider scope. (Per the owner review: don't let the docs imply a batch/fan-out identity is done.)

## 2. The locks it establishes (for T6-2 to inherit)

- **Execution-matches-preview** = the `changesHash` (sha256 of the MASKED preview changes) + scope + strategy.
  A stale diff (data — or the actor's field permissions — moved since preview) makes the execute's re-hash
  diverge → reject → re-preview.
- **changesHash is ORDER-INVARIANT** (the correctness pin): sort by `fieldId`, include `op`, stable value
  serialization (`JSON.stringify(v ?? null)`, the same form the diff uses). A non-deterministic hash would make
  every restore re-hash diverge → a silent denial-of-restore. Golden asserts two array orders → equal hash.
- **Reveal-safe BY CONSTRUCTION**: the hash is over the MASKED changes (what the actor saw); T5-2's preview has
  no reveal path, so the identity can only ever bind reveal-free fields. The design-lock's "a reveal grant never
  enters the writable set" is therefore INHERITED at T6-2, not re-solved.
- **Actor-bound**: an identity minted for A is unusable by B — else B could replay A's identity to skip B's own
  permission computation at execute. (golden: actor mismatch → reject.)
- **Strategy = `revert` only**: the destructive `reset` is T8, never T6.

## 3. Verification

- backend `tsc` 0.
- **6 unit goldens** (pure; no DB, no route): mint→verify roundtrip valid; tampered token rejected (signature);
  expired → `reason:'expired'`; every bound axis mismatched (sheet/record/version/strategy/changesHash/actor) →
  rejected; changesHash order-invariant; changesHash distinguishes a changed value.
- `jsonwebtoken` is already a direct dep — no lockfile change. No migration, no FE, no route touched.

## 4. Out of scope (explicitly T6-2 / later — so they don't creep in)

- mint→preview wiring (T5-2 response returns the identity) and verify→execute wiring — **T6-2**.
- the forward-revision write (`source='restore'`), the per-record permission re-application across the fan-out
  (SR-2: row-deny + field write gate + expectedVersion), the atomic + idempotent execution — **T6-2**.
- single-use / anti-replay: needs server state; the `changesHash` already defeats stale replay, so this is a
  **T6-2 idempotency** concern, not the identity contract.
- the destructive sheet-wide reset — **T8**.
