# Product load completion ownership — 2026-11-02

Parent: `b581584a05d674647a810c2aa927817e066355a9`. Source: `ab330207d1598336da918ad53ffab58c04f33a64`.

A normal manual product A load can overlap Search result “Use B”, which calls the same real View loader. When B completes before A, the earlier completion could replace B, canonicalize the old ID/URL, dispatch an old child-read batch, report a stale error/auth effect, or clear loading while the current request remained pending.

One per-instance generation now limits those completion effects to the latest nonempty `loadProduct` invocation. The existing empty-ID return, request arguments, synchronous start resets, current-error previous-product retention, canonical-ID success, and four-read batch order stay intact. Only the admitted state and loader fragments changed; mechanically undoing them recovers the entire original 281241-byte View, SHA256 `71f541407c1466fd8d2760a4ae24f5fec5483240b71714cb51070eaa6e94fdcf`.

The new `apps/web/tests/plmProductLoadOwnership.spec.ts` statically imports the real View and calls its already-existing Product/Search panel props. Five finite definitions cover B-then-A success, A success while B is pending, stale A rejection after B metadata, current B failure before A success, and one current item-number lookup/canonical-ID success. Product C is seeded through the actual loader; service DTOs and callback arguments are explicit. No product API/expose, helper extraction, copied loader, timer, dependency or fixture framework was added. Real child DOM buttons, transport and auth are mocked boundaries.

Grok requested model/effort: `grok-4.7` / `high`. Root observed literal CLI `Grok 4.7` / `xhigh`; backend deployment ID and author actual profile remain UNKNOWN. Final seven-file capsule SHA256 `7489f4c7163c06dc29985b17485f7ddafa4324c443962ebc3f6482ca2f22a9e3` (16760 bytes), three readonly inputs exact, Root delta NONE. Independent static review SHA256 `76405e6efed78cb577e5e1d723d0702ceca16dd49ed7f54a771deaccc72116a5`, blockers `[]`.

All new product execution is NOT_RUN: unit tests, types, SFC imports, lint, builds, dependency installation, HTTP, databases, browser and CI. Draft6694’s earlier exact-b581 CI does not qualify this new source. Static admission and the five definitions are not a runtime PASS or business acceptance. Review records retain nonblocking limits: one case relies on other cases for error/auth dimensions, and early assertion failure has no guaranteed deferred-drain cleanup.

Already-dispatched child loaders have independent asynchronous continuations and are outside this parent-only fix. No route/reset/unmount/draft-input invalidation, cancellation or global ownership policy is introduced. N2 and all HOLD boundaries remain; all seven packages remain OPEN. This source plus one document is local only, with no push, new PR, dispatch, merge, deployment, production enablement, real notification or issue closure.
