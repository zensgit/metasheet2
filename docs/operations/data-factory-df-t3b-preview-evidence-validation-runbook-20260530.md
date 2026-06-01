# DF-T3b preview-evidence validation — operator runbook (2026-05-30)

> Validates the **closed DF-T3b preview line** on real evidence before DF-T3b-2c (real-Save) is opened.
> The automated layer is already green (unit/spec/parity); this runbook is the **operator's live
> confirmation** on a running stack that `from_reference_table` resolves, fail-closes, and drops stale
> bindings as designed. **READ-ONLY — preview only. No K3 Save / Submit / Audit / BOM. No customer data
> leaves the workspace.**

## What this gates

DF-T3b's preview line is operator-usable end-to-end: author a reference as **从映射表解析** (#2088) →
bind the sourceCode column + the staging sheet (#2110) → live bulk-read + per-material resolve (#2073).
DF-T3b-2c (compose-before-`upsert`, which changes the bytes sent to K3) does **not** open until this
validation passes and is re-reviewed separately.

## Setup (current `main`)

1. A `metasheet:staging` external system with a **mapping-sheet object** (e.g. `unit_dict`) whose rows
   carry the manifest columns: `sourceCode` · `fNumber`|`fID` · `fName` · `enabled` (+ optional `notes`).
   Populate a few rows (one enabled+complete, one ambiguous pair, one incomplete) for the cases below.
2. In the workbench: a target template (`目标模板 JSON`) for a material profile, derived to a draft.
3. Author a reference field (e.g. `FUnitID`) as **从映射表解析(from_reference_table)** → pick its
   **domain** (e.g. `unit`) and fill the **sourceCode 列** (e.g. `unitSourceCode`).
4. In **引用映射来源**: for that domain, select the staging **system** (by name) and enter the **object**
   (e.g. `unit_dict`).
5. A **sample record** whose sourceCode column (`unitSourceCode`) is populated to exercise each case.

## Confirm — three checks

### 1. Resolved reference objects (the headline)
A `sourceCode` mapping to **exactly one enabled + complete** row → run preview → the field resolves to
the **full** `{FNumber,FName}` / `{FID,FName}` **per-material** (different sample sourceCodes → different
objects). `targetPayloadPreview.referenceResolutions` shows `status: resolved` for the field; preview
`valid: true` (assuming the rest is complete).

### 2. Three-state fail-closed
Each non-resolution → preview `valid: false` + the matching `errorType` (never a half-formed reference):

| Case (mapping rows for the queried sourceCode) | `errorType` |
|---|---|
| **0** enabled+complete rows | `unresolved` |
| **2+** enabled+complete rows | `ambiguous` (resolver must NOT pick the first) |
| matching row missing `fNumber`/`fID` or `fName` | `incomplete-row` |

(A disabled row is invisible; a blank-`sourceCode` row is ignored.)

### 3. Stale binding / drop
Bind a domain, then **revert that field to preserve** (or change its domain) → re-preview → the now-stale
`referenceMappingSources` entry is **dropped** (the request no longer carries it) and the field falls
back to **template-preserve**. No orphaned binding is sent for a domain no rule uses.

## Evidence rule — values-free (mandatory)

Capture **only**: field name · domain · whether a `sourceCode` was present · `status` / `errorType` ·
resolved-vs-not. **Never** customer values — no `sourceCode` values, no `FNumber`/`FID`/`FName`, no
payload JSON.

- ✅ Use `targetPayloadPreview.referenceResolutions` (values-free by design) + the field-provenance summary.
- ❌ Do **not** paste the `payload-preview` JSON — it carries the **composed** payload **with** the
  resolved reference values.

## Pass / fail

**Pass** = all three checks match the expected behavior above with values-free evidence captured. On pass,
DF-T3b-2c may be opened (design-first, its own focused re-review against: same bindings as preview ·
per-row fail-closed → dead-letter/provenance · no batch-abort · no auto-retry loop · adapter `read` I/O
failure as its own category). **Fail** = file the divergence (field/domain/error-type only) before 2c.

---

## Operator quick-run (turnkey) — added 2026-06-01

> Turnkey layer over the checks above: a **values-free preflight**, exactly **where to read the
> evidence**, and a **fill-in capture template**. UI-driven (validate through the workbench, not raw
> API) — nothing here sends a Save. Placeholders only; never paste real hosts, tokens, or customer
> values into the run record.

### Preflight (before any check)

A validation run is meaningless against a stale bundle or a mismatched token — a silent 401 reads as a
"failure" that is really an auth/schema gap, not a resolver gap. Confirm, in order:

1. **Bundle fingerprint** — the running stack serves the `main` that contains **#2122** (this runbook's
   slice) and the picker **#2110**. Confirm the deployed commit/build id matches the expected `main` tip.
   If the stack is staging, recall it uses a **distinct `JWT_SECRET`** and its lane does **not**
   auto-mirror `main` pushes.
2. **Auth round-trip** — an authenticated read (e.g. list data sources / current user) returns **200**
   with the operator's token, not **401**. A 401 here is a deploy/secret gap — fix it before reading any
   resolver result.
3. **Pending migrations** — none outstanding for the running image (image-pull deploys must diff pending
   migrations; a schema gap surfaces as a spurious resolver failure).
4. **Fixtures present** — the `metasheet:staging` mapping-sheet object from *Setup* exists with the
   one-enabled-complete / ambiguous-pair / incomplete rows, and the sample record's sourceCode column is
   populated.

### Where to read the evidence (values-free source)

For each preview run, read the **`targetPayloadPreview.referenceResolutions`** array from the preview
response (devtools → Network → the `templates/preview` response) **plus** the read-only **field-provenance
summary** in the workbench preview panel (DF-T1.5). Both are values-free by design — **not** the resolved
`FNumber`/`FID`/`FName`. **Never** open or copy the `payload-preview` JSON — that one carries the composed
payload **with** the resolved values.

Exact entry shape (so you record the right path): each `referenceResolutions[]` entry is
**`{ field, status, evidence }`**.
- **`status`** (top-level) is the outcome enum: `resolved` / `unresolved` / `ambiguous` / `incomplete`.
- **`errorType`** lives **under `evidence`** (`evidence.errorType`): `unresolved` / `ambiguous` /
  **`incomplete-row`** — note `incomplete` *status* maps to `incomplete-row` *errorType* (intentionally not
  the same string; `resolved` has no errorType).
- **`domain`** is **your own per-rule binding** (what you authored), not echoed on the entry — record it
  from the rule you set up.

### Capture template (fill in — values-free)

Copy this block back as the run record. `sourceCode?` = whether a sourceCode was present (Y/N), **not** its value.

```
DF-T3b preview-evidence validation — run record
stack/bundle: <build-id or main tip>   auth: 200 OK   migrations: none pending   date: <YYYY-MM-DD>

Check 1 — resolved (headline)
  field=<FUnitID>  domain=<unit>  sourceCode?=Y  status=resolved   preview.valid=true
  per-material distinct? <Y/N>   (two different sample sourceCodes -> two different resolved objects)

Check 2 — three-state fail-closed (preview.valid=false for each)
  case=0-match            field=<>  domain=<>  sourceCode?=Y  status=unresolved  errorType=unresolved
  case=2+-enabled         field=<>  domain=<>  sourceCode?=Y  status=ambiguous   errorType=ambiguous
  case=missing-component  field=<>  domain=<>  sourceCode?=Y  status=incomplete  errorType=incomplete-row

Check 3 — stale binding / drop
  bound domain=<unit>, then field -> preserve  =>  referenceMappingSources entry dropped? <Y/N>
  field falls back to template-preserve? <Y/N>

verdict: PASS / FAIL
divergences (field/domain/error-type only, no values): <none | ...>
```

### On PASS

File this run record (values-free) and open **DF-T3b-2c** as a fresh design-first slice with its **own**
focused re-review against the nine locks (see *Pass / fail* above). 2c is the first slice in this line
that changes the bytes sent to K3 — it does **not** inherit this runbook's approval; it earns its own.
