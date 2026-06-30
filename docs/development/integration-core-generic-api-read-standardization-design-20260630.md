# Generic external-API read standardization — design-lock — 2026-06-30

## Status

**Design-lock (standard) only. No generic runtime in this PR. No new code, no new preset, no route, no adapter change.**

Owner-authorized 2026-06-30 to standardize the read-onboarding pattern proven on K3 WISE
WebAPI into a reusable, read-only external-API read spec — **before** any generic runtime
is built. This document codifies what four shipped/contracted K3 read patterns already do;
it does **not** introduce a generic framework, and it does not abstract beyond what those
patterns proved.

Deliberate restraint (the C3 LIST tuition): we generalize only the invariants that four
concrete read slices re-derived independently. A generic *runtime* is a separate, later,
gated decision — see Adoption. Locking the standard first avoids premature abstraction.

## Scope

- **Read-only.** Read/probe external data for cleansing flows (this PR adds no runtime and no write; nothing is written into the multitable here).
- Covers: the API preset schema, the shape-intake checklist, the response-extractor
  allowlist, the values-free evidence contract, backend-only credentials, and the four
  read modes.
- **K3 WISE WebAPI is the reference implementation** — every rule below is grounded in a
  shipped or contracted K3 preset (mapping table at the end).

## Non-goals (explicit)

- No Save / Submit / Audit / external write / production write. A read standard never
  authorizes a write.
- No raw endpoint / path / method / body / filter / field / response-path / adapter config
  supplied from the request. The preset owns all of it.
- No UI.
- **No generic read runtime in this PR** — this locks the standard, not an implementation.
- No recursion, no server-side composition — each remains its own gate per the existing
  ladders (#3399 BOM, #3415 resolver).

## The four read modes

Each mode is a shape, not a new capability. The request supplies only the runtime key(s);
the preset owns everything else; evidence is values-free.

| Mode | Input → output | K3 reference (status) |
| --- | --- | --- |
| `single_record` | one business key → one record | `k3wise.material-detail.v1` — `Material/GetDetail` by `FNumber` (shipped) |
| `list_page` | optional bounded filter → one bounded page of rows | `k3wise.material-list.v1` — `Material/GetList`, preset-owned `Top/PageSize/PageIndex`, optional keyed filter (shipped) |
| `detail_with_lines` | one parent key → header container + line container | `k3wise.material-bom.v1` — `BOM/GetDetail` by `FBillNo` → `Data.Page1` header + `Data.Page2` lines (shipped) |
| `resolver_lookup` | one business key → target-id candidate(s) + selection rule | `k3wise.material-bom-resolver.v1` — material → `FBillNo` candidate(s) (GATE-front, #3415) |

Mode boundaries that MUST hold (each proven on K3): `single_record` returns one record, not
a page; `list_page` is a single bounded page, not the full table, never a request-supplied
limit/cursor/watermark; `detail_with_lines` is one call, header + flat lines, **no
recursion**; `resolver_lookup` returns candidate identifiers only and **must not auto-call**
the downstream read (composition is a separate gate).

## API preset schema

A read preset is built-in and allowlisted. Common metadata:

- `presetId` (built-in, allowlisted), `requiredKind`, `object`, `allowedObjects`,
  `allowedModes`, `defaultObject`, `defaultMode`.
- `readConfigOverlay.objects.<object>`: `readPath`, `readMethod`, `readMode`, plus
  mode-specific body/container/key config.

**Read-only object rule (prescriptive for NEW standard presets):** a new standard read
preset MUST overlay a **distinct read-only object** — `operations: ['read']`, **no
`savePath`** — so the object structurally cannot reach a write/Save path. Do **not** overlay
read onto a write-capable (`upsert`) object.

**Honest status of the references — this invariant is NOT yet uniform:**

- `k3wise.material-bom.v1` (#3405) realizes it: a distinct read-only `material-bom` object,
  no `savePath`.
- `k3wise.material-detail.v1` / `k3wise.material-list.v1` **predate** this rule — they
  overlay read onto the **shared write-capable `material` object**, which retains
  `savePath: /K3API/Material/Save` (plus `submitPath`/`auditPath`). They are delivered
  **route-level** read-smoke compat references: the read is gated at the route/adapter layer
  (only `adapter.read` is invoked), **not** by structural object isolation. This doc does
  **not** claim they satisfy the structural no-`savePath` invariant; migrating them to
  distinct read-only objects is optional/future, not done.

Invariants (all references):

- The preset owns endpoint / path / method / body template / filter dialect / field
  selection / response container paths.
- The request supplies **only the runtime key(s)** (e.g. the record key, the optional list
  filter value, the parent key, the resolver business key) — never structural config.
- Reads are invoked through the credentialed read-smoke route, operator-write-gated, on an
  in-memory system overlay (stored config untouched).

Route-marker gating is also **not uniform** (same caveat as the read-only object): `list_page`
(LIST marker) and `detail_with_lines` (BOM marker) require an internal Symbol marker so a
persisted `readMode` cannot activate them from another path; `single_record_detail` predates
the marker and relies on its read-only scope assertion + operations check. **New standard
presets MUST be marker-gated.**

## Shape-intake checklist (shape-first, before any runtime)

No read runtime for a new endpoint until the operator/customer returns a **redacted live
shape** (or authoritative per-instance doc). This is the standard ask — values-free,
structure only:

1. Endpoint path + HTTP method.
2. Request skeleton; mark the key field(s) and **the key encoding** — structured JSON value
   / filter-expression value / number / internal id. **Encoding is confirmed per instance,
   never copied from another preset by habit** (the validated lesson: a structured field
   bound directly, NOT escaped as a filter expression).
3. Required scope fields (org / version / effective date / category), if any.
4. Response skeleton: top-level keys + types; the row/line/candidate container path **and
   case** (case-aware candidates from day one), type, arrayLength.
5. Per-row field keys + types (no values).
6. For `list_page` / `resolver_lookup`: the multiplicity rule — how many rows for one key,
   and which field selects the default/current one.
7. Error envelope keys/codes (not configured / not found / ambiguous / invalid input).

Front-loading the shape collapses the diagnostic chain (K3 LIST blind-probed a row
container across six slices that the operator later revealed in one comment).

## Response-extractor allowlist

- A read preset declares a **fixed, frozen allowlist of container paths**, case-aware from
  day one (`Data.DATA` / `Data.data` / `Data.Data`; `Data.Page1` / `Data.Page2`; etc.). No
  arbitrary response-key probing against the live system.
- The shape probe surfaces only allowlisted container keys with `{type, arrayLength}`.
- The values-free sanitizer iterates a **frozen key allowlist**; a container key added to
  the probe MUST be added to the sanitizer allowlist in the same change, and a wire test
  must assert the route preserves it while scrubbing leak-bait (the #3390 P1 wire-drift
  lesson).

## Values-free evidence contract

Success and error evidence carry **only**: counts (non-negative integers), booleans,
shape types, container `{type, arrayLength}`, coarse enum-like error codes, and
`keyEchoed=false`. **Never**: row values, material/business values, raw request/response
payload, messages, credentials/tokens/authority codes/connection strings, host/system/
tenant/base ids, or arbitrary response keys. The adapter may hold real records internally
for the next server step; the public evidence is sanitized at the preset/route layer.

## Credentials — backend-only

Credentials/tokens live in the backend external-system config, are never request-supplied,
never echoed, and render `<redacted>`. The read-smoke route loads the backend credential
context (not the public credential-stripped system response) and applies the preset overlay
to an in-memory clone — the stored system is never mutated.

## Common locks (apply to every read mode)

- Built-in allowlisted preset; request supplies only runtime key(s).
- Fail-closed on: unknown preset/object/mode, missing required key, no-match,
  ambiguous-multiple-without-rule, unsupported version semantics.
- Operator write-gated (`integration:write`) even though read-only (the credentialed probe
  is an existence oracle).
- In-memory overlay; persisted system/config untouched; values-free on success/failure/
  validation-error; distinct error-code prefix per surface (no fallthrough to a write code).

## K3 WISE reference mapping

| Standard element | K3 WISE reference |
| --- | --- |
| `single_record` | `k3wise.material-detail.v1` (#1868 / #3241) |
| `list_page` | `k3wise.material-list.v1` (#3330 / #3390; no-key + keyed entity-verified) |
| `detail_with_lines` | `k3wise.material-bom.v1` (#3399 GATE-front → #3405 runtime; entity-verified) |
| `resolver_lookup` | `k3wise.material-bom-resolver.v1` (#3415 GATE-front; runtime frozen) |
| route marker | internal read-smoke Symbol markers (LIST / BOM) |
| evidence sanitizers | `readSmokeSuccessEvidence` / `readSmokeErrorEvidence` + frozen `READ_SMOKE_*_KEYS` allowlists |

## Adoption — and why no generic runtime yet

This standard is adopted **per integration**: a new external-API read onboarding declares a
preset in one of the four modes, runs the shape-intake first, and reuses the extractor
allowlist + values-free evidence + backend-credential discipline.

A **generic read runtime/framework** (one engine parameterized by preset, replacing
per-adapter read code) is a **separate, later, gated decision** — justified only after a
*second* external system (not just K3 WISE) adopts the standard and proves it generalizes.
Abstracting a runtime from a single reference system risks the over-fit we paid for on C3
LIST. Until then: this is the standard; new reads follow it with per-adapter code.

## Disposition

This document opens only the **standard**. It authorizes no runtime, no generic framework,
no write, and no new live call. Each future read integration, and any generic-runtime
decision, remains its own explicitly-gated step.
