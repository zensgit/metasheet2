# Managed Visual preview: source and component verification

Source: `3f33e36fd7294fbc0e2739d179da5d9f6e592730`; base: `595acaaea2bd5ce72c365809613084595fa4c4a7`.

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

## Remaining acceptance and publication

Run the managed path against the actual Native Visual provider, actual browser canvas/Discussion markup persistence, current Native RBAC/entitlement/revocation and stale-version/checksum negatives. Verify fresh restored databases and installed runtime-package enable/disable/recovery with explicit configuration handoff. Existing successful plain-Discussion installed74 evidence does not qualify these new Visual changes. Original image-build space floors remain unchanged.

This branch remains a separate candidate. Publication waits for valuable parent jobs to finish and follows the dependency queue; no active useful job is cancelled. Keep its future PR Draft. Native #366 source pin remains `ba07fa952083179c58b5e423b1212eabb2d0c170`; no repinning, merge, deployment, production enablement or issue closure is authorized by this result.
