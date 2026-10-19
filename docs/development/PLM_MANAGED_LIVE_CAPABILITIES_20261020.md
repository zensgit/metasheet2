# Live native advisory capabilities for managed PLM sources

The installed-image verification reached a real personal BOM write and a real
personal ECO API revision, but the existing managed adapter returned a fixed
read-only manifest. The frontend therefore hid its already-implemented ECO action.
This change discovers actual native advisory features and entitlement instead of
hardcoding permission or bypassing the missing UI with an API positive control.

## Identity and transport

The existing native `GET /api/v1/integrations/capabilities` is public advisory
metadata, scoped by native tenant/org. The adapter uses the durable managed source
and the canonical installation registration to select that endpoint. It sends only
the existing native tenant/org headers, omits credentials, rejects redirects and
uses the existing bounded timeout. It does not connect the inherited shared client
or send a client secret, cookie, read delegation, approval grant or write grant.
This advisory request is not authority to read PLM objects or perform a write.

Before and after the request, the source fingerprint, active binding/link,
generation, owner, both identity namespaces and registration must still agree.
The registered native origin and Meta client origin must match their persisted
counterparts. A non-null source Meta tenant must match the persisted Meta binding.
For authenticated requests, the current owner and verified Meta tenant must match
too; a conflicting ordinary/managed principal, missing provenance, a native tenant
substituted for Meta tenant, or a stale owner fails closed before transport.

The existing request context carries the Meta tenant only when a signature-verified
claim agrees with the authenticated tenant. A legacy header backfill, missing claim
or rejected claim cannot establish it. No new authentication or approval engine is
introduced. Native personal writes retain their independent `yuw` grant, native
identity, entitlement, ACL, scope and idempotency checks.

Managed capability reads bypass the legacy manifest cache, so license changes are
observed on the next read. The Meta capability response is `no-store` and varies on
ordinary/managed authentication and tenant/org headers. Transport failure, unlink,
disablement, changed registration or concurrent source changes never fall through
to shared credentials or mock-mode data. Positively unbound legacy adapters retain
their existing handshake and cache behavior.

## Source and verification

The initial seven new counterexamples failed on the old static manifest. Current
managed-adapter, native transport, personal line/ECO binding/intent/provenance and
JWT middleware tests pass: **278 tests, zero failures/errors**, including live
entitlement changes, no shared transport, invalid switch values, native/Meta tenant
separation, source/registration changes during fetch, stale owner, conflicting
principal, rejected provenance and no-store response headers. Backend TypeScript
`--noEmit` also passes on Node 20.

Nine legacy handshake tests were independently shown to fail on the exact original
adapter because an unavailable database is not proof that a source is unbound.
Their fixture now explicitly supplies the existing positive unbound classification;
production refusal on missing storage remains unchanged.

The candidate was reconciled with qualified parent
`b88ee9aa40eecd1967246572b2cc6490c1a3429e`. Its intervening changes were documentation
and the existing publication-fence test repair; all six original patch files were
byte-identical after reconciliation. The original patch and stash were retained.
The parent schema-fence census and falsification tests passed separately (49 tests);
its ledger and gates were not changed. Compact evidence is in
`artifacts/plm-managed-live-capabilities-20261020/verification.json`.

Actual fixed-source offline SPA/backend image construction and the real native
unified-entry **ECO DOM** journey are still required. The earlier API positive is
not UI completion. PostgreSQL concurrent configuration/identity rejection and
pending personal-write/retired-grant coupled recovery remain separate acceptance.
Keep the source and subsequent documentation heads distinct and verify exact-head
CI after publication. Draft only; no merge, deployment, production enablement or
claim that the master goal is complete.
