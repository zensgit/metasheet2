# External-API WRITE self-service — direction design-lock — 2026-07-03

## Status

**Direction design-lock only. No runtime, no config model, no validator, no dry-run
runtime, no apply writer, no wizard, no UI, no code, no write.** This document locks the
*direction* for a consultant/admin-operated external-API **write** self-service layer — the
write-side counterpart of the merged external-API **read** self-service line
(`integration-core-external-api-read-self-service-line-completion-dev-verification-20260703.md`,
#1709) — and composes it with the shipped sandbox-first external-write dry-run discipline
(C6). Each implementation step below is a separate, later, gated opt-in.

Owner-directed 2026-07-03 as the highest benefit/risk-cost item on the multitable frontier
(the standing "read → read-write" enterprise gap). It authorizes no implementation.

## One-line scope (owner)

> Standardize third-party API **write** onboarding as a **consultant/admin self-service**
> capability that a multitable actor can invoke — **but only through a dry-run-first,
> sandbox-first, owner-production-gated ladder.** Read was configurable; **write is strictly
> harder** — it never auto-applies to production, and delete stays out of v1.

## Why write is not "read with a different verb"

The read self-service line established that a consultant, not the end user, is the trusted
party who names an endpoint — through a validated, audited config, never free-form. Write
inherits **all** of that and adds three irreversibility hazards read never had:

1. **A write mutates a third party's system of record.** A wrong endpoint, wrong row, or
   wrong field is not a leak — it is data corruption in someone else's ERP/CRM. So write is
   gated behind an explicit **dry-run → sandbox apply → re-pull idempotency → owner
   production gate**, never a direct apply.
2. **Replay / partial-failure / double-write.** A retried or duplicated write must be a
   **no-op, never a second row**. Write requires content-keyed idempotency and a one-time
   redeemable token at the apply boundary — not merely values-free evidence.
3. **The payload carries values, not just a key.** The read runtime request carried only a
   business key; a write request carries a **row payload** drawn from the authorized
   cleansing zone. That payload is the data plane and must be authored/mapped at config
   time, never free-form from the runtime request.

## The two-tier model (unchanged spine, write-side)

Inherited verbatim from the read line's S0 core:

- **Config-time — implementation consultant / admin (trusted, write-tier).** Authors the
  write *target*: endpoint, method, **write operation** (from a proven set), key field +
  encoding, field map (which cleansing-zone columns map to which target fields), and a
  **credential reference**. The platform runs save-time validation, versioning, and audit
  before the target is usable.
- **Runtime — the multitable actor / cleansing flow.** Selects an **already-approved,
  already-dry-run-proven** write-target preset by id and supplies only the preset-declared
  **named key(s)** plus the row payload **from the authorized cleansing zone** — never a raw
  endpoint, raw method, raw body shape, or raw response path.

Why this preserves every boundary: the runtime request still carries **no structure** (only
keys + mapped values); credentials stay **backend-held** (referenced, never inline, never
echoed); evidence stays **values-free**; and — the write-specific addition — **no runtime
request can reach a production write without an owner-gated, dry-run-proven path.**

## Three governing judgments (owner)

1. **This is NOT "users freely write any API."** That would be a data-corruption /
   SSRF / privilege-escalation / credential-leak pit. The correct form is **consultant
   configures → platform validates → dry-run proves → sandbox proves → owner gates
   production → user invokes an approved, proven target**.
2. **Write standardizes here; delete does NOT ride along.** `upsert` / `save`-style writes
   are in scope (create/update). **Delete is excluded from v1** — even later than the read
   line excluded it, because a wrong delete is the least recoverable operation.
3. **The sandbox-first ladder is not optional and not owner-skippable per-write.** The
   ladder (dry-run → sandbox apply → re-pull idempotency → owner production gate) is the
   capability's shape, not a policy toggle. A production apply is always the last, separately
   owner-gated rung.

## Save-time validation (config-time guardrails the platform enforces)

A consultant fills a form; the platform refuses to save a write-target config that violates
any of:

- **Endpoint** must pass the **same crown-jewel relative-path guard** the read line uses
  (`isSafeRelativeReadPath`, reused verbatim — reject scheme / protocol-relative / backslash
  / all percent-encoding / traversal), relative to the registered external system's base URL.
  No arbitrary host (no SSRF).
- **Write operation** must be one of a **proven, allowlisted set** (v1: `upsert` — i.e.
  create-or-update via a find-then-patch key; optionally the K3-style `save` lifecycle where
  Submit/Audit stay opt-in and a save-only profile is hard-locked). **No `delete`, no raw
  SQL, no free-form statement.**
- **Key field + encoding** must be declared (the target's natural key for find-then-patch);
  a write with no key is invalid (it would blind-insert / duplicate).
- **Field map** declares which authorized cleansing-zone columns map to which target fields
  — the **data plane**. Mapped values flow at runtime under ACL / audit / redaction; the
  **evidence plane stays values-free** (counts / coarse codes only), exactly as the read
  line keeps them separate.
- **Credentials** are a **backend reference only** — never inline, never echoed (**fork**
  `hasSecretShapedValue` + `INLINE_CREDENTIAL_KEYS` — both file-internal to
  `read-source-config.cjs`, not exported, so copy or add an export — and **import** the
  already-exported shared secret-shape scrubber `scrubSecretStringValue`).
- **Sandbox target required.** A write-target config must name a **sandbox** target distinct
  from production; a config with no sandbox binding cannot advance past dry-run.

## The write ladder (each rung a separate opt-in)

| Rung | Scope | Gate |
| --- | --- | --- |
| **W0** (this doc) | direction design-lock: two-tier write model, ladder, save-time validation, dry-run-first, sandbox-first, delete excluded | nothing (docs) |
| **W1** | **write-target config model + validator** — the proven write-op set only; save-time validation; content-keyed versioned store + approve/retire lifecycle (fork the read `read-source-config` + `read-source-config-store` shapes) | no dry-run, no apply, no runtime |
| **W2** | **dry-run contract + values-free preview evidence** — a no-write preview that resolves the endpoint + composes the target body from the field map and returns `{rowsAffected-estimate, coarse-outcome-codes}`, issuing a **one-time content-hashed dry-run token** (fork the shipped C6 `createDryRunToken` discipline) | no apply |
| **W3** | **sandbox apply** — redeems a dry-run token against the **sandbox** target only; then a **re-pull idempotency + human-field-preservation** check proves a re-apply is a no-op | sandbox only; never production |
| **W4** | **production apply** — the **separately owner-gated** rung; redeems a fresh dry-run token against production behind a two-step confirm + Idempotency-Key; first production write is owner-authorized, sandbox-proven, diverse-sample-tested | **owner production gate**; never end-user reachable |

No rung combines config-model + dry-run + apply in one PR. Delete, raw statements, and any
end-user-authored write target remain out of every rung.

## The locks (direction, to be sharpened at W1)

1. **Config surface — strict allowlist, write-op-gated.** Top-level keys are a strict
   fail-closed allowlist (fork `ALLOWED_CONFIG_KEYS`); the write operation is from the
   proven set; a raw path / method / body / response / credential can never ride in under an
   unexpected key. Endpoint through the crown-jewel guard.
2. **Both-endpoint authority + tier separation.** Config authoring, dry-run, and sandbox
   apply are **write-tier**; **production apply is an owner gate** distinct from write-tier.
   The runtime multitable actor tier can invoke an approved target's dry-run/sandbox path but
   has **no path** to trigger a production write.
3. **Dry-run first — no write without a token.** A write apply (sandbox or production)
   requires a **one-time, content-hashed, plugin-stored** dry-run token bound to the exact
   normalized config + payload set; a mismatch or a re-consumed token fail-closes (reuse the
   C6 `CONSUMING_TOKEN_KEYS` / `requireConsumableTokenStore` one-time-consume discipline).
4. **Sandbox first — production is never the first write.** The first apply of any target
   goes to the sandbox binding; production apply is unreachable until a sandbox apply +
   re-pull idempotency proof exists for that target version.
5. **Idempotency — content-keyed find-then-patch, never blind insert.** A write resolves the
   target row by the declared key and patches it; a re-apply of the same content is a
   **no-op, never a second row**. Content-key excludes credential material and volatile
   fields (fork `contentKeyFor`).
6. **No blind delete (v1 hard exclusion).** No `delete` / destructive statement in any rung;
   a delete-shaped config is rejected at W1.
7. **Values-free evidence.** Dry-run and apply return `{rowsAffected, coarse-outcome-code}`
   and container/count shape only — never the row payload values, credential, host, endpoint
   text, or a value-carrying error message (reuse the read line's evidence spine +
   `SAFE_WRITE_ERROR_CODES` allowlist idiom).
8. **Human-field preservation.** The re-pull check after a sandbox apply must prove the write
   did not clobber human-authored target fields outside the field map (the stock-prep C6
   discipline) — a write self-service must not silently overwrite fields it does not own.
9. **Two-step confirm + Idempotency-Key at the production boundary.** A production apply
   carries an Idempotency-Key and a two-step confirm; a duplicate submission is a no-op.
10. **Versioned config + audit lifecycle.** The write target is a content-keyed versioned
    record with a values-free audit trail and a draft → approved → retired lifecycle (fork
    `read-source-config-store`); only an **approved** target version is dry-run/apply-eligible.

## Foundation (reused, not reinvented)

Builds directly on two shipped, verified bases — the design-lock names real primitives so
implementation composes rather than re-derives:

- **Read self-service spine (#1709, merged).** `isSafeRelativeReadPath` (crown-jewel
  endpoint guard, reuse verbatim); `validateReadSourceConfig` / `normalizeReadSourceConfig`
  (the config-model + values-free `{code,field,reason}` validator to fork with a write-op
  allowlist); `hasSecretShapedValue` + `INLINE_CREDENTIAL_KEYS` + `ALLOWED_CONFIG_KEYS`
  (backend-credential-reference-only + strict top-level allowlist — **file-internal to
  `read-source-config.cjs`, fork-only**) plus the exported, importable redaction primitives
  `scrubSecretStringValue` / `sanitizeIntegrationPayload`;
  `createReadSourceConfigStore` (content-keyed versioned store + `contentKeyFor` +
  draft→approved→retired lifecycle + values-free audit — fork wholesale); the named-inputs
  runtime discipline (`normalizeReadSourceProbeInputs`, bounded ≤128-char control-char-free
  key never echoed) as the template for how a write runtime request carries only keys.
- **C6 external-write dry-run spine (shipped).** `external-write-dry-run.cjs`:
  `createDryRunToken` (one-time content-hashed token, plugin-stored),
  `CONSUMING_TOKEN_KEYS` / `requireConsumableTokenStore` (one-time consume), `TARGET_KIND`
  target-scoping, row caps (`DEFAULT_MAX_ROWS` / `MAX_ROWS` / page caps), `SAFE_WRITE_ERROR_CODES`
  (values-free error allowlist); routes `POST /pipelines/:id/external-write/dry-run` +
  `POST /pipelines/:id/external-write/apply`. The write self-service **generalizes** this
  pipeline-scoped dry-run→apply into a **consultant-authored, config-driven** write target,
  reusing the token/idempotency/target-scoping discipline — it does not fork a second token
  scheme.
- **Adapter contract (shipped).** `contracts.cjs` (`createAdapterRegistry`,
  `normalizeUpsertRequest`, `createUpsertResult`, `unsupportedAdapterOperation`) and the
  model gated write adapter `k3-wise-webapi-adapter.cjs` (`upsert` with `ensureOperation`
  allowlist, save-only lifecycle lock, tri-state autoSubmit/autoAudit, sanitized per-row
  diagnostic). The write self-service targets this existing adapter contract;
  `data-source:sql-write-gated` (latent `unsupportedAdapterOperation` today) is the natural
  first generic write target to light up under the ladder.

## The genuine gap (what W1+ actually builds)

- **No generic, config-driven, consultant-authored multitable→external-API WRITE exists.**
  K3 `upsert` is real but **pipeline-scoped** (source→target via runPipeline), not a
  consultant-authored per-record/button write from a multitable. The write self-service is
  that missing counterpart — authored like a read source, gated like a C6 write.
- `data-source:sql-write-gated`'s apply is **latent** (`unsupportedAdapterOperation`); its
  apply-writer / dry-run-token redeemer for the generic case is what W3/W4 would light up,
  behind the ladder.

## Non-goals (explicit)

- No `delete` / destructive statement / raw SQL / free-form body (excluded from every rung).
- No direct production write; no apply without a dry-run token; no sandbox-skip.
- No end-user-authored write target and no runtime-supplied endpoint/method/body/response
  path.
- No config-model, validator, dry-run runtime, apply writer, wizard, or UI in this doc (those
  are W1+).
- No new credential store, no new token scheme (reuse the read credential reference model +
  the C6 token).

## Disposition

Direction only. Authorizes no runtime, no config-model impl, no validator, no dry-run impl,
no apply writer, no wizard, no UI, no write, no delete, and no production apply. Every ladder
rung (W1, W2, W3, W4) and the delete track remain separately, explicitly gated. When opted
in, the first implementable rung is **W1** (write-target config model + validator + versioned
store — pure/config-time, no dry-run, no apply, no runtime).
