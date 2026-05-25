# K3 WISE Reference Mapping — Probe Findings (O4 + lookup code-path analysis) - 2026-05-25

## Scope

Fact-finding for the #1821 reference-mapping authoring design, **before** the UI-contract PR. Two questions that gate that design:

- **O4** — does `config.objects.material.schema` (incl. each field's `reference.identifier`) survive an external-system config save → get round-trip?
- **lookup** — can a multitable `lookup` carry a structured reference object (`{FName, FNumber}` / `{FID, FName}`) end-to-end?

Tests/docs only; no `plugin-integration-core` or multitable runtime change; nothing implemented.

## O4 — config schema round-trip: **PASS** (one nuance)

**Verdict:** the schema content (`name` / `type` / `reference.identifier`) round-trips through `upsertExternalSystem` → store → `getExternalSystem`.

**Evidence:**
- Store: `external-systems.cjs` `normalizeExternalSystemInput` keeps `config` via `jsonObject(...)` **verbatim** — no schema stripping.
- Redaction: `payload-redaction.cjs` `SENSITIVE_PAYLOAD_KEYS` excludes `objects`/`material`/`schema`/`reference`/`identifier`/`name`/`type`, so the public projection does not redact the schema.
- Test (new): `external-systems.test.cjs` §7e asserts the stored row preserves the schema **verbatim**, the get/public projection preserves its **content**, and a config-level `apiKey` **is** redacted — proving sanitize is active on this path (schema survival is not a no-op).

**Nuance:** the get/public projection (`sanitizeIntegrationPayload`) rebuilds nested objects with a **null prototype** (its prototype-pollution guard). Content is identical and JSON-serializable, but consumers must compare JSON-normalized values, not rely on `Object.prototype` (strict `deepEqual` / `instanceof`).

**Scope honesty:** the test uses the in-memory mock DB with the **real** `normalizeExternalSystemInput` + `rowToPublicExternalSystem`/`sanitize`. Postgres stores `config` as JSONB, whose structural round-trip is the assumed property (not re-proven here).

**Implication for ②:** persisting the shape selector into `config.objects.material.schema` is viable — the config layer round-trips it. Remaining ② work is frontend + writing the **complete** schema array (the shallow-merge caveat from #1821).

## lookup → object: **code-path analysis (NOT a live smoke), conclusive**

**Method:** read the production materialization in `packages/core-backend/src/routes/univer-meta.ts` — `resolveLookupValues` (~L1636–1674) and lookup config validation (L940–991). This is a determination from the real code, not a runtime run.

**What a lookup yields:** for each linked record, the lookup pushes `data[targetFieldId]` — the **raw cell value of ONE target field** — and assigns the column an **array** `unknown[]`, one entry **per linked record with a non-null target value** (records whose target value is `null`/`undefined`, and linked records that are missing/unreadable, are skipped) (`univer-meta.ts:1648-1652`, assigned at `:1674`).

**Precise verdict:**
- A lookup pulls **one** target field's raw value; whether that value is a scalar or an object is determined by the **target field's type**.
- For ③'s text columns (`k3FNumber` / `k3FName` / `k3FID`) the values are **scalars**.
- Composing `{FName, FNumber}` / `{FID, FName}` therefore requires **either** two lookups + downstream assembly, **or** a single target cell that *already* holds that object — which standard multitable field types do not natively author.
- Practical corollary: **a single lookup cannot compose a multi-column reference object.**

**Second-order consequence (matters for the next design):** a lookup column is **always an array**, even for a single-cardinality link. So even the *degenerate* single-key `{FNumber: value}` path sourced from a lookup needs a **downstream unwrap** (`[0]`) before #1817 wraps/passes it.

**Live-confirmation recipe** (optional, needs a running stack): create a base; sheet ③ with text columns; sheet ① with a `link` to ③ and a `lookup` targeting `k3FNumber`; add a ③ row and an ① row linking it; GET ① records; observe the lookup cell = `["<k3FNumber>"]` (array of scalar) — confirming the above.

## Implications for the next UI-contract PR (follow-up — NOT this PR)

- The #1821 "③ row → single lookup → reference object" path does **not** hold as stated. Design options there:
  - **(a)** ③ exposes components; ① uses **multiple lookups** (one per component) + a **downstream composition** assembling `{FName, FNumber}`. Composition location: client pre-Save = lock-safe; server/pipeline transform = **frozen**.
  - **(b)** author the reference object directly in ① as a structured cell (if/when a suitable field type exists).
  - **(c)** deferred adapter round-2 two-field synthesis (runtime → **frozen**).
- Every consumer of a lookup-sourced reference column must **unwrap the array**.
- O4: ② can persist into `config.objects.material.schema`; the frontend must write the **complete** schema (shallow-merge caveat) and treat the null-proto projection as JSON-only.

## Boundary

- Tests/docs only; no runtime change; no new K3 object; nothing implemented.
- Rollback procedure and K3 READ runtime remain separate tracks (not in scope here).

## See also

- PR #1821 — `integration-k3wise-reference-mapping-authoring-design-20260525.md` (the design these probes gate).
- Issue #1792 — Customer GATE; `PASS_SAVE_AND_READBACK` proved full reference **objects** are required.
- `external-systems.test.cjs` §7e — the O4 round-trip assertions added by this PR.
