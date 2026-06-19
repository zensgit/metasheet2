# Development & Verification Record — 2026-06-19 (session snapshot)

> Status: **DATED RECORD (point-in-time snapshot), not a living status ledger.**
> Scope: records the development + verification performed in this session as of 2026-06-19, grounded on `origin/main` @ `d9f72091b`.
> For *current* multitable completion status, see the maintained ledger chain (#2913 and successors). This document is intentionally a dated snapshot and is **not** kept current — that is by design, to avoid the stale-status-text problem that retired the earlier standalone remainder ledger (#2888, closed-as-superseded by the maintained chain). The two are complementary: living status lives in the ledger chain; this is a historical record of session work.

## 1. #2914 — P0 field-write-gate fix (developed + verified this session)

**Defect (P0 audit):** the main bulk `POST /api/multitable/patch` did **not** enforce per-subject `field_permissions.read_only`. The write spine (`RecordWriteService.patchRecords`) enforces only PROPERTY-level field guards (`readOnly`/`hidden`/`computed`), and per-subject field read-only was enforced on the **restore + copy** paths but **not** the everyday grid PATCH. A field set read-only for a specific subject was therefore still writable through the grid — a write-bypass / privilege hole.

**Fix** (`packages/core-backend/src/routes/univer-meta.ts` ~L11622): a **layer-3 per-subject field-write gate**, run **before any write**, fail-closed:

```
forbidden = unique(changes.fieldId).filter(fid => {
  const perm = fieldPermissions[fid]
  return !perm || perm.visible === false || perm.readOnly === true
})
if (forbidden.length) → 403 sendForbidden(...)
```

Properties (verified by review):
- **Fail-closed:** `fieldPermissions` is derived over the full visible-property-field set, so every visible field has an entry; a missing entry ⇒ not-visible/unknown ⇒ forbidden — never a false block of a normal field.
- **Atomic / restore-style:** the whole request is rejected before any write (no silent-drop of the locked field while persisting the rest).
- **Parity + no admin bypass:** matches the restore/copy layer-3 gates; per-subject `read_only` applies regardless of role. Admin authority is exercised by editing/removing the `field_permissions` rule, not by write-time bypass.
- **No info leak:** `/patch` fieldIds are caller-submitted; nonexistent vs read-masked fail identically — no existence oracle.

**Verification:** real-DB golden `packages/core-backend/tests/integration/multitable-fieldperm-write-gate-patch-realdb.test.ts` (registered in `plugin-tests.yml`, sentinel fails-not-skips):
- enforce — per-subject read-only field → **403, nothing written**;
- regression-guard — a normal field (no per-subject rule) **still writes** (not block-all);
- atomic — a mixed (normal + locked) request is **rejected whole**; the normal field is NOT persisted.

**Review verdict:** APPROVE (security-correct, no changes requested). **State:** PR #2914 OPEN, reviewed, auto-merge armed, BEHIND cleared — lands on green (CI test 18.x/20.x in flight at time of writing).

## 2. Button-action track — per-item audit (verified on `main`)

| Action / surface | State on `main` | Proof |
|---|---|---|
| `record_click` | shipped (inert / no persistent row) | `BUTTON_ACTION_POLICIES` L84 |
| `send_notification` (B1-S1 D0-A) | shipped — in-app sink, server-confirm, `canSendNotification` gate, recipient hard-reject, requestId at-most-once dedup, fail-closed durable audit | #2768 `b636aecd6`; policy L85 |
| `update_record` (B1-S1 D0-B) | shipped — first record-mutating action; sheet `edit` gate **+** per-row no-elevation re-gate | #2806 `bbd1787a9`; policy L83 |
| `send_webhook` | **NOT built — sole remainder** | absent from `BUTTON_ACTION_POLICIES` → 400 NOT_ENABLED |
| B1-e drawer rendering | shipped — `field.type==='button'` in record drawer, emits `run-button` → same secured `runButton` as grid | #2716 `01a777eac`; `MetaRecordDrawer.vue:266`, `MultitableWorkbench.vue:683`, spec `:201` |

## 3. `send_webhook` — design-lock authored (#2897, gated)

The sole remaining button action is real external egress (highest blast radius). Per the staged-opt-in discipline it gets a design-lock first; runtime is gated on owner security sign-off (the same path #2768 took). Decisions surfaced for the owner: **D-GATE** (recommend dedicated `canSendWebhook`, default-OFF), **D-SSRF** (https-only + private/loopback/metadata block + resolve-then-pin), **D6** (at-most-once + disable the reused executor retry), payload-interpolation OFF. No runtime built. PR #2897 OPEN for review.

## 4. Attendance `/me` self-service (shipped earlier; recorded for completeness)

Endpoint #2850 + overview card #2853; token-locked subject (no `userId` param; param- and header-spoof both locked by integration + FE tests). Its own design+verification MD is on `main`. Only the **owner-run L6 staging smoke** remains.

## 5. Remaining (pending / gated)

- **#2914** — code complete + reviewed; merges automatically on CI green (in flight).
- **`send_webhook` runtime** — gated on the owner's #2897 decisions; not buildable without them (egress/SSRF posture is the owner's call).
- **Attendance L6 staging smoke** — owner-run (sandbox cannot reach the staging host).

## 6. Verification provenance

All "shipped" claims above are cited to a merged commit + a live file/line on `origin/main` (not inferred from a design-lock PR's open/closed state — the lesson of this session: a design-lock PR being OPEN ≠ the feature unbuilt; verify against `main`). Current cross-track status is maintained in the ledger chain (#2913 and successors); this record does not duplicate that role.
