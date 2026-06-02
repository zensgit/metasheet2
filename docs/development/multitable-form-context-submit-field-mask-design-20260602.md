# D1 — form-context / form-submit layer-3 echo gate: decision & design

**Slice:** D1, the last open item of the multitable field-read-gate arc (tracker `multitable-field-read-gate-tracker-20260602.md` §2b; #2106 inventory finding D1, framed there as "anonymous-form design question — likely intentional"). **Date:** 2026-06-02.

## The question (as posed)
Should `GET /form-context` and `POST /views/:viewId/submit` apply the subject-scoped layer-3 (`field_permissions.visible`) read gate to the **record data they echo**, the way `/view` + `/records/:id` do (#2028)? The #2106 inventory tagged this "layer-1+2, anonymous-form, likely no-op." On close reading, **the no-op assumption is wrong for the identified path** — there is a real layer-3 leak. This doc records why, and the fix.

## Caller model: both routes are MIXED (public-token OR authenticated)
Both `form-context` (@6693) and `submit` (@6848) accept an optional `publicToken` and branch on `isPublicFormAccessAllowed`:
- **Anonymous (valid public token):** `effectiveAccess = { userId: '', … }`, `effectiveCapabilities = PUBLIC_FORM_CAPABILITIES`. Crucially, public callers **cannot load or update an existing record** — `recordId` → 400 (form-context @6735, submit @6902). So anonymous only ever *creates*.
- **Authenticated (JWT, no token):** real `access.userId` + real per-sheet capabilities; must hold `canRead`/`canCreateRecord`/`canEditRecord`. Can load (form-context `recordId`) and update (submit `recordId`).

## Answer 1 — why anonymous has no subject (layer-3 is moot, correctly)
`field_permissions` rows are keyed to a **subject** (`subject_type` ∈ user/role/member-group + `subject_id`). An anonymous caller has **no `userId`** → `loadFieldPermissionScopeMap` is never called (or returns nothing) → the scope map is empty → `deriveFieldPermissions(...).visible` carries **no layer-3 denial**. There is no subject to deny against. So applying layer-3 to an anonymous caller is a **strict no-op by construction** — not a policy choice we can "turn on." The #2106 "likely intentional" read was right *for anonymous*. (Anonymous create still can't leak a *cross-subject* denial, because the deny targets a specific user, not "the public.")

## Answer 2 — identified callers SHOULD apply layer-3, and today they DON'T (the leak)
Both routes mask the echoed `record.data` by `visible*FieldIds` = **layer-1 (view.hidden) ∧ layer-2 (`property.hidden`) only** — they never intersect the layer-3 `fieldScopeMap`:
- **form-context** loads `fieldScopeMap` (@6763) but feeds it **only to the `fieldPermissions` metadata** (@6765/6816); the data mask at @6794 uses `visibleFieldIds` (layer-1∧2).
- **submit** loads **no `fieldScopeMap` at all**; the echo mask at @7198 (+ attachment @7210, + recalculated-formula overlay @7238) uses `visibleFormFieldIds` (layer-1∧2).

Consequence: an **authenticated** caller who is `field_permissions.visible=false` on field X (yet can read the sheet) reads X's value by:
- `GET /form-context?recordId=R` → `data.record.data[X]`, or
- `POST /views/:viewId/submit` (update or create) → `data.record.data[X]`,

even though `/view` and `/records/:id` mask X (#2028). This is the **same egress-vs-metadata split** as the original #2015 finding (the layer-3 deny is shipped as metadata but the value is in the payload), on two read/echo paths the arc had not yet covered for the identified case. So D1 is **not no-code** — it is a real layer-3 leak requiring the same composite fix.

## Answer 3 — context-echo and submit-echo: same MECHANISM, not the same test
Both get the identical fix: mask the echoed `record.data` (and attachment summaries) by the **layer-2 ∧ layer-3 composite** (`deriveFieldPermissions(...).visible !== false` → `allowedFieldIds`), keyed to the requester — exactly #2015/#2028. But the **submit echo carries the F3/F4 subtleties** the read path does not:
- **write-only-no-read (F3):** a caller may *submit* a value to a layer-2-visible-but-layer-3-denied field. The write still happens (the write-validation gates @6920–6977 are layer-2 and are **left unchanged** — a field can be writable yet read-denied); the **echo must omit it**.
- **server-assigned (F4):** a denied field the submitter **never sent** — a recalculated **formula** (@7238 overlays formula values gated only by `visibleFormFieldIds`) or a server default — must not surface in the echo. This is the *unambiguous* canary: its presence can't be a "user submitted it" artifact. The locking test's create case (C4) uses a denied formula field for exactly this reason.

## Fix (minimal — add layer-3, don't re-litigate layer-1)
- **form-context:** `visibleFields` already applied layer-1∧2; intersect with layer-3 via the already-computed `fieldPermissions` → `readableFieldIds = visibleFields.filter(f => fieldPermissions[f.id].visible !== false)`; use it for the `record.data` + attachment masks. Field **definitions** (`fields: visibleFields`) and the `fieldPermissions` metadata stay unchanged (the client hides denied columns via metadata, per #2028 — layer-1 stays display-only; we do not switch to `/view`'s "value stays" semantics here).
- **submit:** add `loadFieldPermissionScopeMap` (the handler had none) → `echoFieldPermissions` → `readableEchoFieldIds`; use it for the `record.data` mask, attachment mask, and the formula overlay.
- **Anonymous:** `effectiveAccess.userId=''` → empty scope map → `readableFieldIds`/`readableEchoFieldIds` **equal** the existing `visible*FieldIds` → the public-form path is byte-for-byte unchanged (proven by the locking test's C6).
- **Out of scope / untouched:** write-validation gates, central RBAC/auth, record-level read-deny (K3 Stage-1 lock).

## Locking test (fail-first, real DB)
`tests/integration/multitable-form-context-submit-field-mask.test.ts` — 7 cases: C1 form-context recordId read (RED), C3 submit update echo (RED), **C4 submit create server-assigned formula (RED — the F4-style unambiguous canary)**, C2/C5 per-subject positive controls, **C6 anonymous public create = fix is a no-op** (the framing guard). RED on unmodified `origin/main` (C1/C3/C4 leak) → 7/7 GREEN. Wired into `plugin-tests.yml`.

## Verdict
D1 is a **real, identified-only layer-3 leak** on form-context (record load) + submit (create/update echo); anonymous is correctly moot. Fixed with the #2015 composite + a real-DB locking test. This closes the arc's last open finding → **12/12**.
