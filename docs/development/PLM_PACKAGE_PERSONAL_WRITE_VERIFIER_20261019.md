# Generated personal write and ECO lifecycle verification

Source: `5738ee2e0838c7c247bbb4c48652a4eee023ac69`. Local verified; publication and exact-head CI remain separate.

The optional `--package-personal-write` mode consumes the actual package renderer output in both processes. It keeps snapshot and approval issuance off, issues a native BOM-purpose grant through the real browser, binds it for a different Meta owner, patches a BOM line, and creates an ECO intent twice with one idempotency key. The native report verifies one ECO, distinct source/target ItemVersion rows for the same product, and RBAC creator 900 resolved from native identity 42. The line audit records native subject 42. A generation increment is not assumed: ECO revision produces generation 1 in this fixture.

The fixture supplies the separately required `plm.bom_eco_revision` entitlement for its owned tenant; it does not bypass entitlement checks. During native outage, personal unbind persists frozen tenant, organization, subject binding, origin and grant identity. Once native resumes, two retries with the Meta write flag disabled revoke the original grant exactly once, clear encrypted material, and preserve the frozen identity hash. Managed logout, transfer, rebind, read revoke and late-callback rejection remain checked.

## Actual evidence

`personal-write-proof.json` summarizes `/tmp/plm-package-personal-write-v5-20261019.json`: PASS, real PostgreSQL 15, Node 20.20.2, Playwright 1.57, Meta source 430effa1e9aef4b36be7b7da1ad191fbb2128990; native business source matches 4f5d2f4964b6b781ab059fe1696597912e0e36de. Every owned process stopped and the owned PostgreSQL directory was removed after marker/status checks.

Earlier v2 failed at the real ECO entitlement gate; the fixture entitlement was added explicitly. v4's browser scenario passed but its parent proof failed because it queried Item instead of ItemVersion and incorrectly assumed generation 2. v5 checks actual version row existence, distinctness, product ownership and creator. Original failed logs remain retained. No product permission or test threshold was weakened.

This does not prove generated personal approval, PostgreSQL 16 CI, production SPA on the new Meta pin, installed images, full stop/resume, backup recovery or customer acceptance. Those remain required separately.

## Generated approval and write combination

Source `97e31900e52cde62ad558c0e09227436b110e99a` adds `--package-personal-approval` to the generated write profile, retaining the write-only mode. Both flags are real renderer output. Native setup uses actual three-store identity, ECO stage/round/seat services and ECO_AUTHZ_MODE=enforce. A browser issues separate BOM-write and approval grants. Meta initializes the existing PLMAdapter with the actual ConfigService, binds/syncs through the existing authenticated bindings HTTP routes, and approves through `/api/approval-card-deliveries/:id/actions` with the real permission and link checks. Only a synthetic local delivery row is seeded; no sender or business notification runs.

Actual v7 passed with renderer bytes subsequently committed as native f9c32bdf7. Native immutable command count1, auth actor42, RBAC actor900, one approved seat. The configured two-person threshold stays incomplete after that vote. Replaying the exact persisted Meta command over native HTTP returns the same receipt. Wrong-purpose grants are refused before either family can impersonate the other; Meta binding is removed after completion. Original line/ECO idempotency, outage frozen write revocation with flag-off retry, managed logout/rebind/revoke and late-callback checks also passed. All owned cleanup passed on PostgreSQL15 / Node20 / actual browser.

Compact `approval-write-proof.json` retains v7. v6 also passed before native scope handoff was made robust for numeric/JSON-looking string IDs; v7 uses the final raw-string scope inputs. Earlier v1–v5 failures were fixture construction or exact response expectation defects: a temporary ORM weak-reference object, the unmapped can_add attribute instead of can_create under enforce mode, a403 purpose refusal rather than assumed422, and applying another fixture's user-column bootstrap to an existing user catalog. Original failures remain retained; no product authorization or approval threshold was relaxed.

This does not qualify external card sending, installed package/PM2/Nginx, PostgreSQL16 CI or production acceptance. Those remain separate from this authenticated cross-process source proof.

Parent integration before publication: normal merge `b951ab5f37b0b96c89583bc899d60b217442539e` includes qualified parent69a6d4ebd0 (23 successful checks) without replacing history. All paired verifier script bytes still match source `97e31900e52cde62ad558c0e09227436b110e99a`; backend source/census inputs match that successful parent. Original runtime source430 and native business source4f5 remain explicit inputs. The native workflow deliberately references immutable verifier source97e31900e5, while this branch's later documentation/merge head must receive its own CI after Draft publication.
