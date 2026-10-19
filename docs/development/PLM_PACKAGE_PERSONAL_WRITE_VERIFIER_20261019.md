# Generated personal write and ECO lifecycle verification

Source: `5738ee2e0838c7c247bbb4c48652a4eee023ac69`. Local verified; publication and exact-head CI remain separate.

The optional `--package-personal-write` mode consumes the actual package renderer output in both processes. It keeps snapshot and approval issuance off, issues a native BOM-purpose grant through the real browser, binds it for a different Meta owner, patches a BOM line, and creates an ECO intent twice with one idempotency key. The native report verifies one ECO, distinct source/target ItemVersion rows for the same product, and RBAC creator 900 resolved from native identity 42. The line audit records native subject 42. A generation increment is not assumed: ECO revision produces generation 1 in this fixture.

The fixture supplies the separately required `plm.bom_eco_revision` entitlement for its owned tenant; it does not bypass entitlement checks. During native outage, personal unbind persists frozen tenant, organization, subject binding, origin and grant identity. Once native resumes, two retries with the Meta write flag disabled revoke the original grant exactly once, clear encrypted material, and preserve the frozen identity hash. Managed logout, transfer, rebind, read revoke and late-callback rejection remain checked.

## Actual evidence

`personal-write-proof.json` summarizes `/tmp/plm-package-personal-write-v5-20261019.json`: PASS, real PostgreSQL 15, Node 20.20.2, Playwright 1.57, Meta source 430effa1e9aef4b36be7b7da1ad191fbb2128990; native business source matches 4f5d2f4964b6b781ab059fe1696597912e0e36de. Every owned process stopped and the owned PostgreSQL directory was removed after marker/status checks.

Earlier v2 failed at the real ECO entitlement gate; the fixture entitlement was added explicitly. v4's browser scenario passed but its parent proof failed because it queried Item instead of ItemVersion and incorrectly assumed generation 2. v5 checks actual version row existence, distinctness, product ownership and creator. Original failed logs remain retained. No product permission or test threshold was weakened.

This does not prove generated personal approval, PostgreSQL 16 CI, production SPA on the new Meta pin, installed images, full stop/resume, backup recovery or customer acceptance. Those remain required separately.
