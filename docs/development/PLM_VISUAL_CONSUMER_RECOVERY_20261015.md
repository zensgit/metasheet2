# Visual Review consumer — design and verification

## Scope and source

Consumer candidate based on MetaSheet `c11e3a2a2010d5a17ef886bbb9551eca13ba3818`, paired with Yuantus markup branch `1f295bfca8ca23389a2ec610b4eb74d9bfb4d961` plus the native-parent follow-up. Local verification is complete for this slice; Draft publication and exact-head remote CI are tracked separately. Whole-window development remains active; this document covers the Visual slice only.

## Design

Restore Visual preview and V1 markup through the existing PLM embed entry. Server configuration pins the data source; an administrator explicitly enables a tenant-bound PLM source. Embed and preview capabilities independently bind identity, scope, Part, parent session and raster descriptor. The adapter checks signed metadata, nonce consumption, bounded image size, image signature and digest before returning pixels. Browser messaging retains origin/window/nonce checks. Discussion writes reuse Yuantus authorization and current-raster validation.

An ordinary source owner can rename an approved source. Redirecting credentials, host, tenant or other bindings, re-sealing its credentials, disabling or deleting it requires the platform administrator. The trusted actor is passed separately from request bodies. The manager reads and locks the durable row before deciding a write. A creation conflict is refused by an ordinary INSERT/unique key, rather than an upsert that could overwrite another instance's approved source. Stale active updates cannot resurrect a deleted row. Legitimate administrator soft-delete revival remains supported.

The approved configuration is deep-copied before adapter construction, since real PLM connection setup materializes headers and URL fields. Durable comparisons use that separate snapshot. Ordinary approved-source renames update only name/updated_at and preserve stored credentials and binding bytes.

Visual data-plane admission reads the current active row, compares the approved binding and scope, and checks the adapter identity again after the database await. Preview checks before/after connection and after provider work. Visual create/reply checks before the shared text guards, after them, and immediately after credential exchange before its business POST. Markup read projection rechecks admission. Pure text discussion retains its existing path. These reads do not claim atomic cancellation after a business POST is already issued, or a distributed transaction with Yuantus.

This slice deliberately rejects a Visual body containing `visibility_scope`; the current restored writer does not implement that field. It must not silently downgrade an internal-visibility intent. Discussion visibility X2 remains a separate full-window requirement.

The Yuantus parent admits the exact `visual-preview` purpose using its existing origin/window/generation controls and unchanged mint budget. The Visual iframe card spans the parent grid so the preview remains usable on narrow screens. Native sign-out first tears down the iframe/token channel and local credentials, then sends the server-required same-origin UI intent and JSON request. It redirects only after a successful cookie-clearing response; failure reports an error without pretending the server cookie was cleared. Server CSRF checks are unchanged, and API bearer revocation is not claimed by this presentation logout.

## Reproductions and fixes

- Shared-storage stale rename and creation reproduced the unconditional-upsert defect. Owner DELETE returned 200 instead of required 403 once the fake SELECT API was correctly modeled. The first deletion500 was a fixture defect, not product proof.
- Replacing only the new persistence function with the original implementation against real PostgreSQL produced **7 failed / 1 passed**. Both owned-cluster cleanup checks passed. The current implementation passed all original8cases, then the expanded suite below.
- Independent read-only review found stale-cache data-plane use, real adapter runtime mutation, and the credential-exchange wait window. Deferred actual HTTP create/reply regressions returned200 on the old code (**2 failed / 30 passed**); after the final admission check, business write methods remain uncalled.

## Verification observed

- Current focused backend: **198 passed across8modules**. Complete source-management/deletion/credential/scope and adjacent relay collection before the last two exchange checks: **482 passed across24modules**. The final affected exchange/preview/markup3modules: **60 passed**. These collections overlap and must not be added together.
- Backend type check passed on the final consumer source before the native UI-only follow-up. Web **174 passed across9modules**, and web source types passed.
- Real PostgreSQL15: **14 passed, zero skips**, owned-cluster cleanup=true. Two independent manager caches cover both directions of stale Visual flags; actual `pg_blocking_pids` proves an insert conflict and row-update wait before release. Positive controls cover owner name-only credential preservation, real PLMAdapter mock connection header mutation, administrator delete/revival, and stale active-update refusal after deletion. Real HTTP on a stale manager after durable disable/delete refuses both files/image before connect, nonce consumption or provider methods. This uses the real source-table/scope migrations and an installed empty reference catalog, not the complete application migration chain.
- Native Yuantus workspace and login complete modules: **76 passed**, including execution of the real logout handler under success/HTTP refusal/network failure and existing server same-origin controls.
- New dedicated consumer workflow covers backend, web, types and whole-file PostgreSQL cases. actionlint passed. Remote CI is pending publication.

## Browser evidence and limits

First browser run failed all3tests, with owned children observed exited and cleanup=true. The preview loop reached its sign-out URL assertion after rendering the selected rasters; sign-out received403 and the presentation cookie remained, sending login back tohome. The markup test persisted all four tools, loaded matching records as a second reviewer and reloaded them, then failed the narrow-screen stage-width check (65px instead of >180px). The dedicated logout test also received403 instead of204. These are retained failures, not acceptance passes.

The parent fixes address those observed causes. Final `browser-04-locked` passed all3tests in249.49seconds, cleanup=true, with3,804recorded source inputs unchanged during execution. All71Python lockfile pins matched the selected environment. It includes twenty raster/version selections, four persisted tools, second-reviewer reload, keyboard controls, narrow layout, CSS zoom, stale write refusal, session reset and actual cookie-clearing logout after changing both API Base input and storage to an external URL. Logout always targets the server-provided local API base. Earlier browser02 (3passed) and targeted browser03 (1passed,2filteredout) used a historical environment that did not match requirements.lock (23matching,15missing,33mismatched pins); those runs remain exploratory evidence and do not substitute for the final locked run. The fixture now observes owned child exit, removes temporary authorities only after those exits, records cleanup, and fails cleanup errors. It uses real Yuantus HTTP and native parent UI, the actual MetaSheet feature Express relay/Vite UI and current adapter, synthetic PNG/JPEG rasters and three private SQLite authority stores. Redis and the source registry/admission in this browser lane are substitutes; the PostgreSQL source-admission lane is separate evidence. No full MetaSheetServer, complete migration catalog, customer drawings, enterprise notifications or production TLS claim is made.

## Delivery boundaries

Do not declare the whole window complete. Full Discussion/SSO/revocation/DP1, Stage A and RG/version items remain tracked separately. Keep both feature PRs Draft after publication and follow exact-head CI; no merge, deployment or production enablement is authorized here. Source PR345 previously hit runner acquisition failure before any detect_changes step (runner_id0); its failed aggregate is not a business regression result and must remain recorded separately from the follow-up head.


## Reproduction

Use Node20 and pnpm10.16.1. The dedicated workflow contains the exact focused backend/web/type commands. For source-authority tests, point `PLM_VISUAL_SOURCE_TEST_DATABASE_URL` at an isolated disposable PostgreSQL database and set `EXPECT_PLM_VISUAL_SOURCE_DB=1`, then run the complete integration file with `vitest.integration.config.ts`; it creates and drops its own schema. Do not use a production database.

For the browser fixture, set `RUN_PLM_VISUAL_BROWSER_E2E=1`, `E2E_YUANTUS_WORKTREE` to the companion markup checkout, `E2E_YUANTUS_PYTHON` to a Python3.11 environment matching its requirements.lock, and `PLM_VISUAL_BROWSER_OUTPUT` to a fresh artifact directory. From packages/core-backend, run `pnpm exec vitest run --config vitest.visual-preview-browser.config.ts`. Local Chromium must already be installed. Redis/source-registry substitutes remain explicit.

The final narrow-screen capture is [available here](assets/plm-visual-consumer-20261015-narrow.png), with a [desktop capture](assets/plm-visual-consumer-20261015-desktop.png). The compact evidence JSON records current input hashes and observed PostgreSQL blocker/waiter IDs; raw local browser/PG logs remain under artifacts/plm-visual-consumer-20261015. Independent read-only review found and closed the described authority and await-boundary findings; it is not a second test execution.
