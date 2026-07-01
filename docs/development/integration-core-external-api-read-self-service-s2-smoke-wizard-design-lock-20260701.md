# External-API read self-service — S2 internal-consultant smoke wizard — design-lock — 2026-07-01

## Status

**Design-lock only. This document locks the *shape* of S2; it authorizes no
implementation** — no runtime, no probe, no persistence, no wizard, no UI, no write.
It builds on **S0 (#3424, direction design-lock)** and **S1 (#3430, config model +
validator)**. S2 itself decomposes into **contract → probe → persistence**, and **each
sub-slice is a separate, later, gated opt-in — no single PR combines them.**

Owner-authorized 2026-07-01 as a design-lock. It authorizes no code.

## One-line scope (owner)

> S2 is the internal-consultant **smoke wizard**'s minimal closed loop:
> **clone recipe → fill shape (S1-validated) → fixed `locate-container` probe →
> values-free smoke → save version.** Internal use first. **No full UI, no generic
> runtime, no resolver composition, no write.**

## Why S2 crosses two boundaries S1 did not

S1 was pure validation — no network, no storage. S2 crosses **two** boundaries, and that
is exactly why the first cut is a design-lock, not an implementation:

1. **First outbound read.** The fixed probe actually resolves `systemId` → base URL +
   credential and issues a **read-only** request. This is the first time the crown-jewel
   SSRF guard acts on a **live** outbound call rather than on a validated string.
2. **First persistence / version / audit.** "Save version" introduces config
   persistence, a version record, and an audit record — surfaces S1 explicitly did not
   have.

Both step past S1's validation-only edge, so the shape is locked here before any code.

## S2 sub-slices (each a separate later opt-in)

| Slice | Scope | Builds — and explicitly does NOT |
| --- | --- | --- |
| **S2-a** | probe **contract** + evidence **schema** — pure functions | **no** network, **no** persistence |
| **S2-b** | fixed `locate-container` **probe runtime** — live read-only outbound | reuses external-system resolution; **no** new credential path; **no** persistence |
| **S2-c** | **save version** + audit **persistence** | reuses db / migration / credentialStore; **no** probe change |

No single PR combines S2-a / S2-b / S2-c. The first implementable slice, when opted in,
is **S2-a** (contract + evidence schema, pure functions, no outbound, no persistence).
Write, delete, full UI, and generic runtime remain out of **every** slice.

## The locks (the contract)

Locks 1–9 are the owner brief; lock 10 (authorization) is the one axis surfaced during
design-lock review — a live-outbound trigger is a capability surface S0/S1 did not have.

### 1. Probe contract — only S1 normalized config in

The probe consumes **only** the frozen output of S1 `validateReadSourceConfig`. It never
accepts a raw endpoint, raw filter, raw body, or raw container path — those cannot enter
the probe surface at all. Top-level keys are a **strict, fail-closed allowlist** (mirror
S1's `normalizeReadSmokeContract` `onlyAllowedKeys` discipline): a raw
path / method / headers / body / response / credential / adapter config can never ride in.

### 2. Outbound boundary — registered system only, no new credential path

The probe resolves its target through the **existing** external-system registry only:
`systemId` → registry row → **base URL** (from the registered connection config) +
**backend credential** (decrypted **backend-side** via the shared `credentialStore`). The
endpoint is assembled from the resolved `baseUrl` + the **S1-normalized relative path**.
**The primary probe-time path guarantee is that any path reaching the probe has necessarily
already passed the strong config-time guard `isSafeRelativeReadPath`** (reject-all-`%`,
traversal, scheme, protocol-relative, backslash); **S2-b re-runs `isSafeRelativeReadPath` at
probe time** as defense-in-depth. **No
new credential path, no inline credential, no consultant-suppliable host.** S2 holds S1's
**relative-only** boundary; the host-allowlist option floated in S0 remains **deferred** —
the probe does **not** introduce it, and **no guard is widened.** The adapter's
`assertRelativePath` is only a **weaker second net** — it rejects scheme / protocol-relative /
backslash but **not** traversal or `%2f`, so it is **never** the primary defense.

### 3. Probe behavior — locate / shape / optional bounded smoke, never row values

The probe does exactly three things: **locate container** (does the S1-declared container
path resolve in the response shape?), **shape check** (container `{type, arrayLength}`),
and an **optional bounded smoke** (a capped read). It returns **no row values**.

The **optional bounded smoke is the single highest value-leak risk in the slice**, so it
is locked hardest: it **reuses the existing read-smoke evidence path verbatim**
(`readSmokeResponseShapeContainerEvidence` / `readSmokeSuccessEvidence`), never a parallel
evidence path, and surfaces only `{type, arrayLength}` / counts / allowlisted booleans —
**never field keys, never row content.**

**Evidence-plane only.** The field-map **data plane** — mapped field *values* flowing into
the authorized cleansing zone — is a **runtime** concern and is **explicitly OUT of S2**.
The probe carries no mapped values anywhere.

### 4. Evidence schema — values-free

Counts / booleans / coarse codes / container `{type, arrayLength}` only. Mirrors
`readSmokeSuccessEvidence` / `readSmokeErrorEvidence` (coarse reason codes, no message).
**Never** a raw response, field keys, row values, credential, host / base URL, or
tenant / base id.

### 5. Persistence schema — structure + version + audit, never values or credentials

- **Persists:** the config **structure** (the S1 normalized config), **version**,
  **status**, `createdBy` / `updatedBy`, and audit metadata.
- **Stores the `systemId` reference only** — **never** a resolved base URL, **never**
  resolved credential material, **never** the probe response. Resolution stays **dynamic
  at probe time**, extending S1's backend-reference model to the stored record.
- **The audit trail is values-free too:** coarse status / enum codes, actor, timestamps —
  **never** a probe response body and never a value-carrying error message.
- Reuses the existing **db + migration (kysely) + `credentialStore`** conventions; no new
  secret store, no new credential format.

### 6. Idempotency — content-keyed versioning

A version is **content-keyed** on the normalized-config structure (a stable hash of the S1
normalized output, `systemId` included, **credential material excluded**). An **identical
save is a no-op** and returns the existing version; a **changed save mints a new version.**
Save/version behavior is deterministic and defined — the word "idempotent" is not left to
carry the meaning on its own.

### 7. Timeout / cap — platform-fixed, not consultant-suppliable

The probe uses **platform-fixed constants** for request timeout and fetch cap, and they
are **not consultant-suppliable.** A consultant cannot set a large timeout or an unbounded
fetch — that would be an SSRF / DoS amplification vector. Short timeout; bounded row cap on
the optional smoke.

### 8. No-write — fail-closed, never routes to a write path

The probe accepts **no** write/delete shape and calls **no** Save / Submit / Audit / delete
endpoint. Fail-closed on two counts: a write/delete-shaped config is already rejected by
S1, and S2 additionally **never routes to a write path**. `operations` stays `['read']`.

### 9. S2 OUT (non-goals, explicit)

No full UI (S2 is the internal-consultant minimal loop). No generic runtime /
config-driven read framework (that is **S3**). No resolver composition. No write / delete.
No host-allowlist widening. No end-user free-form access.

### 10. Authorization — who may trigger the live outbound call

S2 introduces the **first platform action that issues a live outbound call** (the probe)
and the **first that writes a persisted record** (save version). Both are gated to the
**consultant / admin tier** through the **existing permission infrastructure** — the same
config-time trust boundary S0 established — and are **never end-user reachable.** The
end-user / cleansing-flow runtime tier (which supplies only business keys against an
already-approved preset) has **no** path to trigger a probe or mint a version. *Who* can
cause a live outbound call is part of the security shape, not an implementation detail, so
it is stated here rather than left to be inherited.

## Foundation (reused, not extended)

Builds on **S0 (#3424)**, **S1 (#3430)**, and the shipped values-free read-smoke
(#1709 / #3416). The reuse map:

- **Evidence spine** — `normalizeReadSmokeContract` +
  `readSmokeResponseShapeContainerEvidence` (values-free `{type, arrayLength}`).
- **Outbound spine** — `createExternalSystemRegistry` resolution (pure reuse). Endpoint
  assembly + the relative-path guard currently live **private** to
  `k3-wise-webapi-adapter.cjs` / `http-adapter.cjs` (not exported); at **S2-b** the probe
  either routes through the existing adapter request path **or** extract-and-generalizes
  those into a shared helper — a small, explicitly-scoped lift, **not** a new capability.
  The strong config-time guard `isSafeRelativeReadPath` (S1) is re-run at probe time as the
  primary path defense.
- **Credential spine** — the external-system registry + `credentialStore`
  (encrypted at rest, decrypted backend-side, referenced by `systemId`).
- **Config spine** — S1 `validateReadSourceConfig` normalized output (frozen,
  `operations: ['read']`).

S2 **reuses** the evidence, credential, and config spines as-is. For the outbound spine it
reuses the system-resolution and re-runs S1's guard; the **only** permitted generalization
is lifting the existing (currently adapter-private) endpoint-assembly helper into shared
scope — **no new capability, no widened boundary.**

## Disposition

Design-lock only. Authorizes no runtime, no probe impl, no persistence impl, no wizard, no
UI, no write, no delete, no host-allowlist, and no generic framework. **S2-a, S2-b, S2-c**
and the write / delete tracks remain separately, explicitly gated. When opted in, the first
implementable slice is **S2-a** (probe contract + evidence schema — pure functions, no
outbound, no persistence).
