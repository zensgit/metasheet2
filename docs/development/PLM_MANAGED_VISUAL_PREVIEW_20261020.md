# Managed Visual preview: source and component verification

Product source: `3f33e36fd7294fbc0e2739d179da5d9f6e592730`; actual Native/PostgreSQL verification source: `163016141a6101a60cd23119f5cb305585f357a3`; base: `595acaaea2bd5ce72c365809613084595fa4c4a7`.

This slice implements the managed entry’s preview and bound-markup path using the existing Native capability provider, Discussion engine and Meta canvas. It is **not full feature, installed-image, backup/restore or total-window acceptance**. The frozen BD6 product consumed by Native #366 is unchanged.

## Design and authority

The existing source option `visualReviewEnabled` belongs to the legacy data plane, whose Native/stored-tenant equality rule remains intact. It cannot represent managed sources with distinct Native and Meta namespaces. The separate `managedVisualReviewEnabled` boolean defaults off and requires the existing platform administrator confirmation at source create/update, credential re-seal and delete chokepoints. Ordinary owners may rename an approved source; they cannot enable, disable, redirect, rotate credentials or overwrite a newer administrator decision. Durable row locks protect stale-process mutations. A managed opt-in alone never grants legacy preview admission.

Managed requests additionally require exact `PLM_EMBED_VISUAL_PREVIEW_ENABLED=true`. The current persisted source, active link, browser session, user, memberships, origin, root and generation remain locked through the Native operation. Native tenant/org/subject are compared separately from Meta tenant/org/user. The source’s Native configuration is resolved again from persistence. No automatic handoff changes an approved Visual source to seed a personal-read connection.

The browser requests a fresh signed frame-read JWT for each preview action. This is an embed JWT, not an opaque personal-read grant. The relay exchanges it through Native’s existing Visual provider. Signed audience, subject, origin, embed binding, JTI, file/version, content/preview checksums, raster type, size and expiry checks remain in the shared existing transport. Preview metadata confers no authority. No service-account, approval or personal-read fallback was added.

The managed context exposes `visualPreviewEnabled: true` only after the locked runtime/source gates pass. The existing canvas and Discussion components handle the draft and stored markup. Invalid markup is rejected before a Native call; disabling Visual does not silently turn a Visual write into plain text. Identity/source changes dispose token clients and discard stale preview responses and drafts. Managed helper calls require same-origin API configuration and explicit source IDs; empty IDs never fall back to legacy URLs.

## Verification

| Scope | Passed | Evidence |
| --- | ---: | --- |
| Existing signed capability, legacy adapter and binary response regression | 97 | `plm-managed-visual-shared-transport-regression-1130.xml` |
| Managed service, real HTTP administration routes and source validators | 101 | `plm-managed-visual-admin-green-1215.xml` |
| Existing managed companion regressions | 42 | `plm-managed-visual-companion-regressions-1205.xml` |
| Discussion view/component and optional context capability | 18 | `plm-managed-visual-ui-expanded-1200.xml` |
| Managed preview transport/component and late-response controls | 7 | `plm-managed-visual-preview-ui-1215.xml` |
| Real PostgreSQL source authority, including independent Node process | 17 | `plm-managed-visual-pg-20261020.xml` |

All 282 listed test cases passed without skipped/error cases. These counts are distinct; repeated intermediate runs are not added. The service tests use a local signed-capability HTTP fixture and substituted authority locks. They are not an actual Native provider or browser-installation proof.

The PostgreSQL lane uses the existing source migrations and real managers. It proves distinct Native/Meta namespace reload, refusal of legacy admission, stale-owner delete refusal and an independent Node manager blocked on an actual PostgreSQL row lock. `pg_blocking_pids` recorded the waiter before the administrator committed disable; the child then returned `DATA_SOURCE_CONFIGURATION_CONFLICT`, retained disable and exited 0. The owned database stopped and its generated root was removed. Other tables/catalogs are fixture scope, not a complete installation.

Backend TypeScript no-emit and frontend Vue type checking passed. The production Vite SPA built 166 files, manifest SHA256 `e964aa1af3a1669f62bf474207aa24f6a962ce1f8b3b10b85f4ffd80488e8d35`; existing chunk-size warnings remain. Package manifests and frozen lockfile were unchanged. This is a static build, not an installed frontend/browser acceptance.

Intermediate failures are retained: the ordinary Vitest config intentionally excluded the real-DB lane; the disposable harness initially used login `root` instead of the actual process owner; a credentials negative control initially exercised the general source-update endpoint, which intentionally ignores credential payloads, then used the real `/credentials` endpoint. No production authentication, test exclusion, gate or timeout was relaxed.

Compact evidence: `artifacts/plm-managed-visual-preview-20261020/verification.json`. Private immutable receipt manifest SHA256: `688003ba9c40d9e9541ec99756a3752246cacfffa1b403a2646fbaead318d82e`.

## Actual Native PostgreSQL and independent-worker follow-up

The committed repository verifier then passed **all 31 cases, zero skipped/failed/error cases** at `163016141a6101a60cd23119f5cb305585f357a3`. Its existing 27-case gate was increased to 31; the four new cases are mandatory in the same workflow and runtime verifier. It starts the actual Native HTTP application with separate PostgreSQL identity, RBAC and tenant-business stores, real Redis and two independent Meta Node processes. Actual Native authorize/exchange/status/revoke issues the delegation; Meta session rows remain a test fixture. No authentication dependency override or Native test endpoint is installed.

The new cases prove an actual Native PNG and signed public descriptor, bound pin markup created by Native user 42 and read back through another Meta worker, forged checksum/stale-version rejection with valid-current recovery, Visual entitlement disable/restore and delegation revocation stopping preview before another Native capability request. The existing first-party cookie, current Meta/source locks, replay, expiry, root and unlink cases also passed.

The executed Native checkout was `0b013740398690753e761a703cfa0f7dd485c85b`; its entire `src`, locked requirements and Native fixture match the declared `ba07fa952083179c58b5e423b1212eabb2d0c170` source pin. Workflow checkout and report assertions pin ba07 exactly. Before/after fingerprints match for 1,441 source files: `8c2e0510fda8ce3520a1ed8dc6b664b1475e270e327a8273a6d3f134b247d1e2`. Both Meta workers exited 0 with acknowledged shutdown; Native, PostgreSQL and Redis cleanup passed and the owned root was removed. Actionlint passed for the expanded workflow.

The first new fixture run correctly refused a Native registration whose issuer omitted `/installation`; only the disposable coordinator registration was corrected. A subsequent cross-worker comparison exposed UTC versus PostgreSQL `+08:00` timestamp serialization for the same instant. The test now normalizes that timestamp to ISO UTC while comparing the complete remaining comment/markup object. No payload field is discarded, and product timestamp behavior was unchanged. Only the failed case was rerun while diagnosing this; the complete strengthened repository verifier subsequently passed all 31 cases.

The existing 4GiB preflight refused one attempt. Three stopped, explicitly owned synthetic failure roots were fully archived; all 7,030 files in each were size/hash verified from the archive before removing those exact roots. Archives and manifests remain private; no unknown Docker cache, volume, image or business directory was deleted. This own-fixture cleanup is not proof of the separate 8GiB image-build requirement.

Additional compact receipt: `artifacts/plm-managed-visual-preview-20261020/native-postgres-verification.json`; private manifest SHA256 `583e7ec3e5734bb00f3bd13e572a32356cd48c8f3324ab919db2f8e231feb1e8`. These are actual Native provider/route/process results, not a real-browser or service installation proof.

## Native object ACL and fresh business-domain restore

The next test-only source `af724799c8cfc956716376ccc05ef8ab5d96f1ab` adds Native object-ACL and actual fresh-restore controls. The strengthened repository verifier again passed all 31 cases without skips. Runtime began at checkout `7c27a098b59946976abebe26ea64ad9d9e907eed` with the three test/verifier changes present; a separate `git show` check subsequently bound **all 1,441 executed source-file bytes and every critical hash** to commit af7247. The identical before/after/committed fingerprint is `48ed9b090d30b643f66da57e01dcbab20aceb2e51afe03a2c02570c4077a2ded`. The raw checkout label is preserved rather than relabelled.

A fresh embed JWT is minted before the actual Native object's `can_get` ACL is revoked. Native's preview endpoint then returns 401; the Meta relay returns its existing generic 503. The initial test incorrectly expected Meta 401; the correction explicitly asserts **both** observed boundaries and the subsequent Native 200/200 mint/redeem after restoring the ACL through the other Meta worker. No product status handling, authentication gate or privilege was changed.

The fixture performs a real custom-format PostgreSQL dump and single-transaction restore into a fresh tenant-business database. Complete JSON rows for the thread, comments, markup, file, version and root item match. Raster bytes are copied into a separate owned storage directory and checked against the authenticated preview checksum. A separate Native HTTP process opens that fresh database and storage, returns the saved thread/author/geometry and actually mints and redeems the restored PNG. Its database template retains **both tenant and organization placeholders**; no isolation check is bypassed.

The restored thread and raster APIs both returned 200. Domain SHA256: `0cc7a06fd0e63c2716d50cd4d285d0e0de65c791ddb71f195911b9b826e251d8`; dump SHA256: `0d9452febf87f7bbabe9b494a9134a1dbf664eec381fad9cc149c5911b7c6ae3`; source/restored raster SHA256: `8dfc1b8f21dba791473d4817294fd384cbdc2d88928f70989fc6d4f209b9b301`. Restored worker 39937 completed application shutdown under SIGTERM. Meta workers 39785/39802 acknowledged shutdown and exited 0; original Native/Redis/PostgreSQL cleanup passed and the generated root was removed.

This restores **Native business data and one raster asset**, while retaining the original live identity/RBAC stores and private fixture configuration. It does not qualify full authority/configuration recovery, Meta recovery, installed service images or a browser journey. The failed fixture's complete 8,171-file raw root was archived and each entry size/hash verified before exact owned-root cleanup; archive SHA256 `cd7d1f33200b8708ec0557f83d7b97b2027af8e86f17f444ccf84c5504f1886c` remains private. No unknown storage was removed.

Receipt: `artifacts/plm-managed-visual-preview-20261020/restore-acl-verification.json`; private successful evidence manifest SHA256 `76c3408a29beb58f5851abac4490adab60bdd0aab93ff6a0d075a660c8fe8e5c`.

## Remaining acceptance and publication

Complete actual browser canvas/Discussion markup interaction, full authority/configuration and Meta restoration, and installed runtime-package enable/disable/recovery with explicit configuration handoff. Existing successful plain-Discussion installed74 evidence does not qualify these new Visual changes. Original image-build space floors remain unchanged.

This branch remains a separate candidate. Publication waits for valuable parent jobs to finish and follows the dependency queue; no active useful job is cancelled. Keep its future PR Draft. Native #366 source pin remains `ba07fa952083179c58b5e423b1212eabb2d0c170`; no repinning, merge, deployment, production enablement or issue closure is authorized by this result.
