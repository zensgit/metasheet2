# T9 (config-history) — read-side closeout + remaining-work ledger — 2026-06-25

## Read side — COMPLETE (with this hotfix)

| Slice | What | Status |
|---|---|---|
| T9-R1 | field config-revision recording | merged (#3126) + atomicity follow-up |
| T9-R2 | permission / view / sheet_config recording + field-delete→view cascade | merged (#3130) + rollback goldens (#3138) |
| T9-R3 | config-history READ API — single endpoint `GET /sheets/:sheetId/config-history?entityType=`, per-entity-type gate IN the WHERE clause (read-gate ≡ write-gate) | merged (#3153) |
| **T9-R3.1** | **VIEW payload projection** — redact `before`/`after.filterInfo` literals on the single endpoint (field-read-sensitive, #2052/R9) | **this hotfix** — closes the shipped-path leak |
| T9-R4 | dedicated FE config-history view (calls the single endpoint) | merged (#3155) |
| docs | R3+R4 design & verification | merged (#3156), updated here with §1.4 (view payload projection) |

After this hotfix the read side is **secure and complete**: revisions are gated per entity type by
the authoring capability, and view filter literals are redacted per requester — verified end-to-end
against R2's real recorded shape (`multitable-config-history-view-redaction-realdb.test.ts`).

## Doc-consistency debt (low, no code impact)

- **#3139** (merged design-lock, `e2a7d4578`) locked a **six-endpoint** R3 shape
  (`/config-history/{fields,views,…}` + `/permissions/{…}`). Main shipped the **single** endpoint
  (#3153) instead, and R4's FE uses it. **The authoritative R3 design is now #3156's doc** (single
  endpoint + §1.4 redaction); #3139 is superseded as a design record. #3154 (the six-endpoint
  implementation) was closed as superseded. No code divergence remains — only this historical note.

## Remaining T9 work (each a separate, gated opt-in)

- **T9-W — write side (restore / rollback of config).** The natural next main line, now that the
  read side is closed. NOT started; it is design-heavy + security-sensitive (a config restore can
  re-grant permissions, resurrect a deleted field, revert row-deny) and must be its own
  **design-lock first** (capability gates per entity type, dry-run/preview, idempotency, and the
  same write-gate symmetry as the read side). Open this last.
- **Unified timeline** (one list across all entity types, row-gated through the same per-entity
  capability) — deferred; the single endpoint already supports `entityType` filtering within the
  gate, so this is a presentation enhancement, not a security item.
- **FE polish** on the R4 view — out of scope here.

## Discipline note
T9-W is a separate explicit opt-in: design-lock → review → implement → review, the same cadence R1–R4
followed. Do not begin T9-W implementation before its design-lock is reviewed.
