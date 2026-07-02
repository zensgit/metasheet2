# PLM BOM write-back — consumer `If-Match` optimistic concurrency (dev & verification, 2026-07-02)

Type: development + verification record for **#3469** (`codex/plm-writeback-if-match`) — the consumer
half of governed BOM write-back optimistic concurrency. **This closes the last correctness gap on
the PLM × MetaSheet integration line** (see the line tracker
`Yuantus:docs/development/plm-collab-integration-line-living-tracker.md`).

## 1. The gap it closes

The Yuantus provider (#917/#927) has long emitted a per-line `write_etag` on the read projection and
returned **412** on a stale `If-Match` — but the MetaSheet2 consumer **never sent it**. So a
*same-cell* concurrent BOM write-back silently **dropped the loser's edit and reported success** on
the governed, **audited** Phase-7 path. Cross-cell edits already merged (the provider applies only
sent cells via `exclude_unset`); the exposure was same-cell only. Provider changes required: **none**.

## 2. The change (error-and-reload, owner-chosen)

End-to-end consumer adoption, 5 layers, 7 files:

| Layer | File | Change |
|---|---|---|
| Adapter | `packages/core-backend/src/data-adapters/PLMAdapter.ts` | Type `write_etag` on `BomMultitableLine` (**optional** + **tolerant** read guard); accept `options.ifMatch`; send it as `If-Match` **verbatim** (strong-ETag quotes preserved). No etag → no header → prior behavior. |
| Relay route | `packages/core-backend/src/routes/plm-workbench.ts` | Forward the client `If-Match`; map provider **412 → `precondition-failed`** (distinct from the 400/403/404/409/422 set). |
| FE service | `apps/web/src/services/integration/workbench.ts` | `PlmBomMultitableLine.write_etag`; `updatePlmBomMultitableLine` sends `If-Match` when present. |
| FE panel | `apps/web/src/components/plm/PlmBomReviewPanel.vue` | Send the line's `write_etag`; on **412 → reload fresh context** (new etags; `load()` drops the retry key so the re-submit mints a **fresh** `Idempotency-Key`, not a cached replay) + conflict message — never a false success. |
| Tests | (adapter / route / panel specs) | See §4. |

**Conflict UX = error-and-reload** (owner decision): the correctness-preserving choice for a
governed/audited write-back — last-write-wins would silently discard an audited edit.

## 3. Design decisions (and two deliberate non-changes)

- **Tolerant read guard.** `write_etag` is optional on the interface and the context guard does **not**
  require it — so the READ panel's availability is never coupled to a write field across the
  independently-deployed provider. Missing etag → no `If-Match` → exactly prior behavior.
- **No change to the broker-published pact.** A 412 interaction would create a Yuantus
  provider-verification obligation that could red the provider gate invisibly (we test in ms2). 412 is
  covered by **consumer-side unit tests** instead; a provider-side 412 pact state is a separate Yuantus
  follow-up if desired.
- **Embed §0 read-only invariant untouched** — this is the workbench write path, not the embed iframe.

## 4. Verification

Rebased onto current `main` (`143645977`); re-verified green after rebase.

- `pnpm --filter @metasheet/core-backend exec vitest run` (adapter + relay-route + pact) — **52 pass**,
  including: `If-Match` sent **verbatim** with the quoted strong-ETag (byte round-trip — a stripped
  quote would silently 412 every write); `If-Match` **omitted** when no etag (backward-safe); relay
  route **forwards** `If-Match` and maps provider **412 → precondition-failed**.
- `pnpm --filter @metasheet/web exec vitest run` (panel + service) — **19 pass**, including the
  **412 → reload + fresh-key + no-false-success** flow and the quoted-etag round-trip through the panel.
- `tsc --noEmit` (core-backend) and `vue-tsc -b` (web) — **clean**. No new dependency.

### 4.1 Adversarial verification pass

A 3-dimension adversarial pass (independent agents, refute-by-default, each writing + running its own
scratch vitests against the real adapter / real `HTTPAdapter.select` / real router). **All three clean —
no defect found.**

| Dimension | Method | Result |
|---|---|---|
| **ETag byte-integrity + 412 mapping** | 11 scratch tests through panel→service→relay→adapter→real axios headers | **CLEAN.** The strong ETag `"bom-line:<sha256>"` survives byte-for-byte (literal quotes intact; `.trim()` is a no-op on a well-formed etag); absent/empty/whitespace etag → `If-Match` **omitted at every layer** (no empty precondition → no silent lost-update); `req.header('If-Match')` case-insensitive; `relayProviderWritebackError` singles out **412 → `precondition-failed`** distinct from `[400,403,404,409,422]`, verified against the *real* `select` output (a provider 412 yields `{data:[], error}` with `error.response.status===412` preserved — `select` does not throw on 4xx nor strip the status, so the mapping is live code). |
| **Regression / backward-safety** | 7 scratch tests + `type-check` | **CLEAN.** The read guard accepts `write_etag` absent OR `string\|null` (so a context omitting it still validates — the read panel never breaks) yet still **rejects a wrong-typed** `write_etag` (not neutered); the no-etag write is byte-for-byte prior behavior (no `If-Match`, `Idempotency-Key` always present); no type errors; only callers are the relay + the read-only embed route. |
| **Concurrency-correctness** | scratch tests + the committed panel spec (12 tests) | **CLEAN.** The 412 path reloads fresh context and **drops the retry key** so the re-submit mints a fresh `Idempotency-Key` (no cached-original replay); no false success on conflict. (The adversarial agent for this dimension hit transient infra retries; its scratch suite + the committed `PlmBomReviewPanel.spec.ts` 412 test were run directly and pass — 12 tests.) |

One benign non-defect noted and dismissed: the web-service layer does not `.trim()` `write_etag` while the
route does — observable only for whitespace-only etags, which the provider never emits.

## 5. Status & what is deliberately NOT in this record

- **#3469 is built, adversarially verified, rebased, and green — awaiting the owner merge-go** (held
  per the metasheet2 owner-merge rule; a rebase + `--squash --auto` ships it).
- **Not this record:** #934's date-obsolete reason-length P2 (a parallel PR, tracked separately); the
  decision-gated tracks (locked-BOM ECO route, Phase-6 SSO, commercial) — each needs its own owner
  opt-in per the line tracker's §3 decision sheet.
