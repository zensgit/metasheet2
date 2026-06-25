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

- **T9-W — write side (restore / rollback of config).** **Safe subset SHIPPED via #3164**
  (design-lock + preview/execute): field name/order + view config-update revert; permission /
  sheet_config / create / delete restore are GATED (deferred). Write-gate symmetry + dry-run
  preview→execute + same-transaction recording are in place. **Remaining:**
  - **preview-redaction follow-up — THIS PR:** #3164's `config-restore-preview` returned the view
    `current`/`target` raw, leaking `filterInfo` literals to a field-denied `canManageViews` caller
    (same class as the R3.1 `/config-history` leak, new entry point). Fixed here.
  - **gated unsafe restore** (permission / sheet_config / create / delete) — each a later opt-in.
  - **FE** for the restore flow.
- **Unified timeline** (one list across all entity types, row-gated through the same per-entity
  capability) — deferred; the single endpoint already supports `entityType` filtering within the
  gate, so this is a presentation enhancement, not a security item.
- **FE polish** on the R4 view — out of scope here.

> Note: the **#3163** design-lock (PROPOSED) is superseded by #3164 (which shipped its own
> design-lock + the narrower safe subset). Close #3163 or rewrite it as a post-#3164 *delta* design
> for the still-gated unsafe-restore slices; do NOT land it as the current T9-W design-lock.

## Discipline note
The still-gated T9-W slices (permission/sheet_config/create/delete restore, FE) are each a separate
explicit opt-in: design-lock → review → implement → review, the same cadence R1–R4
followed. Do not begin T9-W implementation before its design-lock is reviewed.
