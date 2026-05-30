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
