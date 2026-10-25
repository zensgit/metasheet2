# PLM data-source bootstrap persistence design validation

Status: **bootstrap repair verified by real HTTP; complete W23 remains RED**. Draft; no merge, installation or production enablement.

Baseline `fa8eeee6429be86ff0344fa4e9f0596d9427424c` on `codex/plm-data-source-bootstrap-persistence-20261025`. Lock nonce `f281bf0cd14d40d1946d5b30233b914a`.

## Old source

Owned Meta row was absent while manager init succeeded. Real HTTP on that source ended `status_preview-eco_403` (`row_present` false, init-success marker true, init-failure marker false). Pointer: `/tmp/plm-w23-r15-source-forbidden-Root-diagnostic-current-20261025.json`.

Node 20.20.2 plus the existing tsx loader, CommonJS, loaded static and dynamic `./routes/data-sources` as different singleton managers. Twenty-one pure identity and binding controls ran with no SQL: `/tmp/plm-w23-r15-manager-binding-actual-pure-review-20261025.json` (`ACTUAL_MODULE_BINDING_SPLIT_REPRODUCED_NO_SQL`). That is a module-binding mechanism proof, not a retained live-instance trace. Root real HTTP decides causal closure.

## Exact change

Only `packages/core-backend/src/index.ts`. SHA-256 before `172a5cc6788c3401265fe64879741ea50dceb850b730d6a3bd506cc19704814e`. SHA-256 after `ba7efc5c177f6b76b0f828a7615d80263992bcfbc358ceb3ad2917eb6d518115`.

Line 342 adds `initializeDataSourceManager` to the existing static import of `dataSourcesRouter` and `getDataSourceManager`. The dynamic `await import('./routes/data-sources')` binding is removed. Late `await import('./db/db')`, the existing `initializeDataSourceManager(kyselyDbDataSources)` call, order, success log, and degraded-mode catch stay.

## Checks

Node v20.20.2 and TypeScript 5.8.3 `transpileModule(index.ts)` reported no syntax diagnostics. This is syntax only, not a full typecheck. A finite source walk found one value import of those three names, no dynamic data-sources import, and one persistence try whose statements are the db import, the existing call, and the success log, with the same catch. The 21 controls were not rerun. Transpile output was not written.

## Not qualification

Old fa8 compiled backend `/tmp/plm-fa8-backend-production-20261025-252525e6108c4fc18bf712c1f9af56d2` and package archive `/tmp/plm-fa8-production-package-20261025-6c26cad66b944a2e8731dfdd1a2ad2fd` record baseline fa8. They do not qualify this new source.

At Grok implementation handoff, real HTTP was NOT_RUN and it performed no commit, push, merge, install, SQL, service or network. Root subsequently completed the source commit and actual verification below.

## Root source and actual verification

Source `8346168524cc95a71672758ec7de4652efcd569f` contains only the two index edits, directly on fa8. The new closeout is a separate documentation commit; its SHA and Draft/CI URLs are recorded externally, avoiding a circular commit. Six private W23 verifier files remain byte-identical to the independently reviewed R14 packet.

Independent Sol high source review `dba0d13813d62a9b141962746502a1dea3cd58efb08bb2323c9e4703ad57a4cb` accepted the exact three-file candidate. Root's actual production-index import/call graph rejected the old source, accepted the new source, and rejected both removal of the static initializer and redirection of its call. The unchanged 21 real Node20 module-binding controls were retained rather than repeated. Full typecheck and current package/image qualification remain open.

Root ran the unchanged R14 full HTTP profile with exact Native538 and this new Meta Source. Eleven requests completed: eight HTTP200, two HTTP201 and the expected missing-version HTTP422. ECO preview, confirm and get all returned200. The retained real Native journal increased from3 to4 source POSTs for the Meta relay; no service-account/mock transport or permission bypass was added. This supports closure of the bootstrap binding defect, not complete collaboration acceptance.

The profile then remained RED at `eco_cell_missing_target_version_id`. A separate transparent metadata-only diagnostic confirmed the returned cells object has its own `target_version_id` key with value null. The existing wire/parser permits that value, while the private verifier currently requires a string. Its missing/type/empty-string distinctions need a separate minimal oracle repair; no target version is invented and no product condition is relaxed here. Source and owned resource cleanup checks passed; no live owned PID or serial lease remains.

Actual bootstrap packet manifest: `56f3d64fd81fda473b98e49f35f2046bae0f8980018f9f82c6e61b324cb38d5c`. Target-null diagnostic packet manifest: `6a9935d5c22d4736849067749783f568d5f4561f3e8b6b2065153f3905f46819`. Raw source/runtime pointers and counts are in the accompanying verification JSON. These actual runs use Source8346, not an asserted future documentation head.

Restart, CAS/concurrency, revocation/recovery, the pending same-collection owner choice, browser/original-frame/hour, complete dependency startup and installation/lifecycle acceptance remain open. Old fa8 compiler/archives do not qualify the new source. Parent Draft6532 stays unchanged; the new Draft targets its exact fa8 branch. Claude Stage A/RG/#249 HOLD and the separate ECO review/owner merge password remain; there is no merge, deployment, production enablement, real notification or issue closure.
