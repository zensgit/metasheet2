# Time Machine test resource adapters

Status: local implementation candidate; deployment, resource product ratification,
staging flags and native same-archive acceptance remain separately gated.

The owner requested removing the block on 2026-10-11 after reviewing the proposed
Mac mini POSIX object service and OpenBao Transit test-key resource plan. Prepare
that reversible candidate for review. This does not select a production backend,
ratify D-F assurance, or authorize installing or starting shared remote services.

Dependency: PR #6314 at `564ca848dbf17d65c62d3dfa4a87ec5e11820ecf`. The candidate
was implemented and qualified with fresh main
`e450de6909afb639f334b9c03dee36cb4024dc98` in integration commit
`98b8d5091f`. Its independent publication branch is based directly on the frozen
dependency so the resource review contains only this slice. Reverify that branch;
integration evidence does not replace exact-head qualification or remote CI.

## Locked behavior

1. Explicit construction only. Default application startup and default-OFF bytes
   remain unchanged. No new flag, database schema or recovery permission.
2. Private TLS object service/client wraps the existing POSIX provider and its
   seven operations: put/get/head/pin/deleteExpired/discard/status. Preserve own
   immutable storeId and complete operation/binding receipts. `status` can
   reconcile persistence, so every operation uses authenticated POST, no caching.
3. Require HTTPS with certificate validation; no redirect, insecure TLS fallback,
   credentials in URLs, automatic retries or response-body logging. Bound request
   and response sizes and total network deadline. A timeout is unknown, never
   `absent`. Existing transaction and exact-result guards apply to every verb.
4. OpenBao custody uses one explicitly configured logical staging key and three
   distinct Transit keys: generation wrapping, stable DEK fingerprint and root
   MAC. Generate a 256-bit DEK; bind wrapping to logical key and generation with
   AEAD associated data. Verify wrapped-blob identity before unwrapping.
5. Fingerprint the actual DEK with the locked domain and an explicitly pinned
   independent HMAC key/version; wrapping-key rotation cannot change that
   fingerprint. Manifest MACs carry their version and use a separate key.
   Reject malformed base64, wrong versions/lengths and non-boolean verification.
   Scrub temporary DEK copies. No external call inside a database transaction.
6. Resource credentials and TLS private keys come from private file references
   in any execution packet. No plaintext key export/backup endpoint or root-token
   privilege is required by the application adapter. Backup encrypted service
   state and preserve separately owned unlock/recovery material.

## Evidence gates

| Gate | Required proof |
| --- | --- |
| TLS and protocol | Real local TLS requests; wrong CA/token/route/shape/limit/deadline negatives |
| Object semantics | Exact replay, pin/delete arbitration, discard/status receipts and persisted restart; existing POSIX acceptance retained |
| Custody | Mint/unwrap AAD binding, stable actual-DEK identity across wrapping rotation, root MAC mismatch, closed errors and zero transaction IO |
| Default OFF | Canonical activation gates refuse construction/resource IO when absent or not exact true |
| CI | New complete backend unit files discovered by default Vitest and named in a focused workflow step; repository-mode resource typecheck and strict standalone TLS-transport typecheck |
| Resource execution packet | Versions/digests, private identities/paths, TLS, scoped policy, encrypted backup, stop/rollback commands |
| Remote/staging | Still requires physical failure-domain proof, owner product/window decisions, current deployed SHA and execution/rollback receipts |

Local protocol fixtures prove adapter behavior, not actual OpenBao availability
or independent durability. The historical native HOLD in the same-archive
two-scenario lock remains unchanged. No local-v1 fallback closes the KMS gate.

API source: https://openbao.org/docs/api/secret/transit/ (stable 2.7.x).
