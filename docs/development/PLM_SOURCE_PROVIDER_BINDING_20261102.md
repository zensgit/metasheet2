# Managed PLM Source provider binding — static delivery

Source commit: `c4568a21212506b9c35388db7a4f1af381f2d8c8`.
Exact parent: `d4c2eddd58113992c8cd985e300b4d211eb2214b`.
Branch: `codex/plm-source-provider-binding-20261102`.

This is a local static code delivery. Tests, typecheck, build, HTTP/PG,
installation, browser, CI and business acceptance are **NOT_RUN** for this slice.
No push or new PR was performed. All seven delivery packages remain OPEN.

## Problem and resulting behavior

An explicit managed Yuantus Source could declare provider B while the inherited
adapter replaced its URL with global provider A. Source headers could also
disagree with the global login scope. Without a global URL, connect could enter
the inherited mock path. Personal grant transport separately used the persisted
Source, so this was an actual configuration seam in the ordinary pairing flow.

The existing `ManagedPLMAdapter` now preserves a narrow original declaration and
checks it before superclass connect. Explicit `yuantus`/`v1` sources require:

- A valid HTTP(S) source base matching the actual global READ base, including
  pathname. Supplied `url` and `baseURL` aliases must both be valid and agree.
- Exact tenant/org agreement across every case-insensitive header alias and
  source option, with no surrounding whitespace or ASCII controls.
- A Yuantus effective mode and no conflicting global scope. A configured
  username/password pair additionally requires explicit matching login scope.

Raw URL whitespace, controls and literal query/fragment delimiters are rejected
before URL parsing can erase them. Encoded path delimiters remain allowed.
Identity strings are compared without Unicode normalization.

Refusal uses fixed `503 / PLM_SOURCE_PROVIDER_MISMATCH`, without target,
scope or credential values. The capability entry checks before inherited
cache/mock results and resolves to `unavailable` on refusal; it does not connect
automatically. Reconnect checks the construction snapshot.

Global credentials are not redirected to a source-supplied target. Existing
ordinary DI precedence, unbound legacy/default mock behavior, approval provider,
personal grant transport and authorization semantics are retained.

## Source and verification

Only these implementation/test files changed:

- `packages/core-backend/src/data-adapters/DataSourceManager.ts`
- `packages/core-backend/tests/unit/plm-managed-source-provider-binding.test.ts`

The new entry-point matrix covers provider/basepath mismatch, scope and login
conflicts, mode/URL aliases, missing global provider, malformed raw inputs,
Unicode identity comparison, capability/refresh refusal and matching positive
controls. The existing snapshot scenario also changes live URL, headers, mode
and scope to distinguish them from the preserved declaration.

Grok authored the implementation and tests in one persistent bounded session.
Codex independently reviewed them, returned three concrete input-boundary
findings to that same session, and reviewed the repaired result. Root integration
restored a required `string` assertion after `unknown[]` validation and expanded
the same snapshot regression. These small deltas are recorded separately from
the untouched Grok archive.

Final independent static review found no remaining blocker for this bounded
change. `git diff --check` passed. Six read-only input files and the manager
outside the new guard/import region were checked byte-for-byte. No product
module was imported and no execution verification was performed by Root.
The author report records execution checks as NOT_RUN. Terminal retention has a
gap; this is not a complete command-history or global process-absence audit.

Requested Grok model/effort: `grok-4.7 / high`. CLI TUI observations reported
`Grok 4.7 (xhigh)`; backend deployment identity is UNKNOWN. The original author
report records effort UNKNOWN and is preserved. Independent reviewer request:
Sol6.1 high; actual model/effort were not returned and remain UNKNOWN.

Private evidence under `unattended-12h-20261101/grok-tool-restore-20261101/source-provider-binding/`:

- `Root-delegation-contract.json` and `Root-final-artifact-receipt.json`
- `Sol-preliminary-source-independent-static-review.json`
- `Root-integration-delta.json`
- `Sol-final-and-Root-integration-independent-static-review.json`
- `Root-source-local-commit.json` and `Root-local-static-delivery.json`

Original Grok archive SHA256:
`a233202dd6981e0ed3053565847eaa591c89ea652c0c454938a3c963fbcb77ed`.
Final source SHA256:
`2b178d021691be3460a03b89a528a40113685b4ff6cb7b9883eb769712341159`.
Final test SHA256:
`42e2f2432c579b7de8e3a23cdf305d3215be32a65cc3373d94d0d3ab1c762da4`.

## Delivery limits and remaining work

The observed remote main was `5d0798ce59e88a71ae4fa37ea16e08f0636f9906`;
the existing catalogue-forward branch remained
`8d237dac8ef6f168353d7cf8806a878e026bd0e5`. This local stack is not rebased onto
that main. Fresh integration and execution gates remain for future publication.
Existing compiled artifacts and prior runtime receipts do not include this code.

This guard is not a complete Source/grant pairing qualification. A separate
ordinary personal-Source contract gap remains: its resolver accepts a non-root
pathname while the established personal transport uses root origin. That target
divergence is recorded in
`Sol-current-personal-Source-basepath-contract-static-gap-20261102.json`;
it has not been implemented or executed here. Matching READ prefixes are not
proof of personal-transport target agreement.

Current Native/Meta grants, real pairing, licensed features, BOM writes and
revocation still require their separate gates. The N2 lease is retained. All
Source23/W2/Claude/P16/browser HOLDs and Draft/no-merge/no-deploy boundaries remain.
This is the single closeout document; later results belong in body/state evidence.
