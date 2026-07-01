# External-API read self-service / consultant config — direction design-lock — 2026-06-30

## Status

**Direction design-lock only. No runtime, no config model, no validator, no wizard, no UI,
no code, no write.** This document locks the *direction* for a consultant/admin-operated
external-API **read** self-service layer, built on top of the #3416 read standard. Each
implementation step below is a separate, later, gated opt-in.

Owner-authorized 2026-06-30 as a direction-lock. It authorizes no implementation.

## One-line scope (owner)

> Standardize third-party API **read** onboarding as a **consultant/admin self-service**
> capability — **not** end-user free-form. **Read is configurable; write/delete remain
> owner-gated + sandbox-first**, out of this line.

## The two-tier model (the core)

The capability is safe **only** because "who may define access" and "who may run it" are
split into two tiers:

- **Config-time — implementation consultant / admin (trusted, validated, versioned,
  audited).** Defines the data source: endpoint, method, read mode, key field + encoding,
  response container, field map, **credential reference**. The platform runs **save-time
  validation**, versioning, and audit before the source is usable.
- **Runtime — end user / cleansing flow.** Selects an **already-approved data-source
  preset** and supplies only the business **key(s) / conditions**. It may **never** pass a
  raw endpoint, raw filter, raw body, or raw response path. **Conditions are preset-declared
  named inputs only:** fixed field(s), fixed operator/encoding, fixed caps. Runtime must not
  supply field names, operators, raw predicates, pagination shape, or response paths.

Why this preserves every boundary we have held: the runtime request still carries **only a
key, never structure**; credentials stay **backend-held** (referenced, never in the config
value, never echoed); evidence stays **values-free**. The consultant, not the end user and
not the running request, is the trusted party that names an endpoint — and only through a
validated, audited config form, never free-form.

## Three governing judgments (owner)

1. **This is NOT "users freely connect any API."** That would be an SSRF /
   privilege-escalation-probing / credential-leak / data-leak pit. The correct form is
   **consultant configures → platform validates → user consumes**.
2. **Read may standardize here; write/delete do NOT ride along.**
   - Read: config-driven preset + values-free smoke wizard.
   - Add / modify: a **separate** track — `dry-run → sandbox apply → re-pull idempotency →
     owner production gate` (the C6 discipline). Never on this read line.
   - Delete: **even later; v1 of this line explicitly excludes delete.**
3. **The generic runtime design may reopen, but do not build the full framework now.**
   #3416 locked the read standard and deferred a generic runtime "until a second system
   adopts the standard." Consultant self-service is a legitimate trigger to reopen that
   *design* — but the **first cut is a design-lock, not a runtime**.

## Save-time validation (config-time guardrails the platform enforces)

A consultant fills a form; the platform refuses to save a config that violates any of:

- **Endpoint** must be relative to the registered external system's base URL, or on an
  explicit **host allowlist** — never an arbitrary host (no SSRF).
- **Read mode** must be one of the four proven modes (below) — nothing else.
- **Container path** must be well-formed and drawn from the case-aware allowlist; the
  platform can `locate-container` probe values-free rather than trust a guess.
- **Credentials** are a **backend reference only** — never a raw token in the config, never
  echoed in evidence.
- **Field map — data plane vs evidence plane (keep these separate).** The field map
  declares which fields the authorized cleansing **data plane** carries into the approved
  cleansing context, under **ACL / audit / redaction** rules — the mapped field **values do**
  flow into the cleansing zone (else the capability is useless). This is distinct from the
  **evidence plane**: public **evidence / logs / issue-ready output remain values-free**
  (counts / flags / types / container `{type, arrayLength}`), and those mapped values must
  **never** appear in evidence, logs, docs, or operator issue comments.
- **Read-only by default.** A write/delete-shaped config is **not accepted on this line**
  (fail-closed); write goes through the separate sandbox-first owner gate.

## Read modes in scope (from #3416, unchanged)

Only the four already-proven read modes: `single_record`, `list_page`,
`detail_with_lines`, `resolver_lookup`. No new mode is invented here. K3 WISE presets
(`material-detail` / `material-list` / `material-bom` / `material-bom-resolver`) become the
seed **recipe library** a consultant clones from.

## Non-goals (explicit)

- No write / Save / Submit / Audit; no **delete** (excluded from v1).
- No end-user free-form API access (no raw endpoint / filter / body / response-path from the
  runtime request).
- No config model or validator implementation (that is step S1).
- No consultant wizard / UI (that is step S2 / S3).
- No generic runtime / framework build — this is its *trigger to reopen design*, not its
  build.

## Staged ladder (each a separate opt-in)

| Step | Scope | Builds |
| --- | --- | --- |
| **S0** (this doc) | direction design-lock: two-tier model, save-time validation, host allowlist, credential reference, values-free evidence, read-only, write/delete excluded | nothing (docs) |
| **S1** | **config model + validator** — the four read modes only; save-time validation; versioning/audit | no UI, no write, no runtime executor |
| **S2** | **internal-consultant smoke wizard** — clone recipe → fill shape → fixed `locate-container` probe → values-free smoke → save version | internal use first |
| **S3** (later) | full self-service UI **and** the generic config-driven read-runtime decision | reopens the #3416-deferred generic runtime |

No step combines config-model + wizard + generic-runtime in one PR. Write, delete, and any
end-user free-form access remain out of every step on this line.

## Foundation

Builds directly on #3416 (read standard: four modes, shape-intake checklist, response
extractor allowlist, values-free evidence, backend-only credentials) and the shipped/
contracted K3 WISE read presets as the seed recipes. The shape-intake checklist becomes the
consultant's config form; the values-free read-smoke becomes the consultant's test button;
the container allowlist + shape probe become the `locate-container` step.

## Disposition

Direction only. Authorizes no runtime, no config-model impl, no validator, no wizard, no UI,
no write, no delete, and no generic framework. Every ladder step (S1, S2, S3) and the write/
delete tracks remain separately, explicitly gated.
