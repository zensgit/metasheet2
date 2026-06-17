# Multitable record-level permission — read-visibility contract (DESIGN-LOCK, decision A) — 2026-06-17

> Status: **DESIGN-LOCK — decision A (document the existing model). Owner-approved 2026-06-17.**
>
> **Contract statement:** *record-level permissions currently model write/admin **elevation** and annotations; record **visibility is sheet-level** unless a future private-record arc introduces deny/whitelist semantics.*
>
> This is a **contract clarification, not a bug fix.** The per-record read filter being grant-additive is **intended** — it is NOT an "ACL gap closed" or a "no-op bug". Record visibility was never promised at the record level.

## 0. Trigger

An audit recap of the `/view` read path observed that the per-record read filter is **grant-additive** for reads (records not matched by a user's grant fall back to the sheet's `canRead`). Rather than mislabel that as a defect, this design-lock pins the existing model as the explicit contract so it is not later misread as a "no-op bug" and accidentally "fixed" into a different, breaking semantic.

## 1. Current facts (verified on origin/main)

- `record_permissions.access_level` CHECK ∈ `{read, write, admin}` — there is **no deny level**.
- `loadRecordPermissionScopeMap` loads only the **grant** rows that match the current user / member-group / role — there is **no deny row type**.
- `deriveRecordPermissions`: a record **not** in the scope map → `canRead = sheet capabilities.canRead`; a record **in** the map → `canRead = capabilities.canRead && (access_level ∈ {read,write,admin})` (always true for a reader).
- ⇒ Record-level permissions today perform **write/admin elevation** (+ annotation / standalone share); they **do not restrict reads**.

## 2. The contract (4 pinned points)

**(1) Current contract — read visibility is sheet-level.**
Any user who can read a sheet can read **all** records in that sheet. `record_permissions` does **not** provide a private-record / read-deny capability. Record-level grants only **elevate** a subject to write/admin (and carry annotation / standalone-share metadata); they never make a record invisible to an otherwise-permitted sheet reader.

**(2) Current read-path filters are retained (parity / forward-compat).**
The read paths that call `deriveRecordPermissions` — `/view`, `GET /records/:id`, the records-list path, etc. — are kept **unchanged**. They are a deliberate forward-compatibility **seam**: if a deny/whitelist semantic is ever introduced (see point 4), it can be inherited at the same seam without re-wiring every read path. Do **not** delete these filters on the grounds that they are "currently inert for reads" — that inertness is the point of A, and the seam is the asset.

**(3) Current canary is retained (grant-additive golden).**
The `#2754` summary canary — an unmapped record (`REC_B`, with no `record_permissions` grant to the current user) is still **returned**, and the `summaries ⊆ returned-rows` invariant holds — is the **grant-additive golden**. `REC_B` being returned is **correct** under this contract. The canary carries an inline note that a future private-record arc (B) **must explicitly flip** these assertions (then `REC_B` would be *excluded*). Until then, do not "fix" the canary to expect exclusion.

**(4) Private records (B) is a demand-gated future arc, not this lock's tail.**
A "private records" / row-level read-deny model is its own **demand-gated security arc**, requiring:
- new semantics (deny / whitelist: *a record carrying permissions is readable only by its granted subjects*);
- a new migration / contract (a deny `access_level`, or a separate visibility column/table);
- coverage of **every** read surface: `/view`, single-record `GET`, summaries (`linkSummaries` / `attachmentSummaries` / `personSummaries`), export, aggregate/dashboard, search/filter, **and the recycle-bin trash paths `GET /sheets/:sheetId/trash` + `POST /records/:recordId/restore`** (added by the #15 recycle-bin arc *after* this doc's first cut — they gate on sheet-level + write-own + field-mask today but deliberately do **not** yet call the `requireRecordReadable` seam, so B **must** include them or they become a silent read-deny hole: restore can call `requireRecordReadable` directly; the trash list needs batched `loadRecordPermissionScopeMap` over the page, not a per-record query);
- real-DB golden tests (flip the `#2754` canary + add a deny golden);
- explicit owner opt-in — it must **not** ride in as a small patch.

> Note: the B1-S1 summary hardening already builds `linkSummaries`/`attachmentSummaries`/`personSummaries` from the **post-filter** row set (leak-proof by construction), so the summary surface is already ready for B should it ever land — there is no urgency forcing B now.

## 3. Decision

**A — document the existing elevation model (this doc).** A is **not** "giving up security": record visibility is *by design* a sheet-level concern, and record-level permissions are *by design* a write/admin elevation + annotation mechanism. If the product later requires genuine private records, that is a **new row-level read-deny security arc (B)**, separately demand-gated — not a follow-on to this design-lock.

## 4. In-repo references

- `packages/core-backend/src/routes/univer-meta.ts` — the grant-additive comment on the `/view` record-permission filter (record-read is a non-gate).
- `packages/core-backend/tests/integration/multitable-records-list-authz.test.ts` (the F0a "record-read is grant-additive" characterization).
- `packages/core-backend/tests/integration/multitable-view-summary-recordperm-leak.test.ts` (`#2754` — the grant-additive summary golden / `summaries ⊆ rows` invariant).
