# ERP/PLM Phase 2 Adapter Closeout Design - 2026-05-08

## Scope

This closeout continues the ERP/PLM K3 WISE Phase 2 backend hardening line after
the guard closeout recorded in #1418.

This batch covers adapter/runtime safety around PLM input normalization, generic
HTTP adapter URL/query behavior, runner write counters, connection-test
redaction, K3 live PoC secret text rejection, and K3 SQL Server table allowlist
separation.

## Merged PRs

All seven PRs were refreshed onto current `main`, waited for fresh CI, and then
squash-merged.

| PR | Merge commit | Purpose |
|---|---|---|
| #1387 | `832601dbf0eb20c81743e75fff8d27d108fffc9e` | Tighten PLM wrapper input normalization |
| #1386 | `2d9fdde004cda10ef2159c81285cb64def3ed8b7` | Reject unsafe HTTP adapter relative paths |
| #1385 | `12cbdd2dfcdfce69ecaa023c3f199cb8602654cb` | Preserve HTTP adapter pagination query guards |
| #1383 | `3e99b83278ecc7cf93e3a19fd2e023665e5d8aff` | Guard runner target write counters |
| #1381 | `a8d65f81126af0e8e5300d309666c6860589826b` | Redact test-connection result payloads |
| #1382 | `621933df46e82ff4684598a54b629c248f8c8bf4` | Reject secret-bearing K3 live PoC text |
| #1380 | `520f1f197aca757eb25ed8d1a8f85ffe84f31bab` | Split K3 SQL Server core-table and middle-table allowlists |

## Cross-Batch Adjustment

Combined local verification found one test expectation that became stale after
#1387. The PLM wrapper now normalizes string identifiers, so the REST PLM -> K3
WISE route-chain test must expect the dead-letter `sourcePayload.code` value to
be `bad-02` instead of the pre-normalization ` bad-02 `.

The runtime behavior is intentionally unchanged by this closeout PR; only the
test assertion is aligned with the normalized source-payload contract introduced
by #1387.

## Design Outcome

The integration path now has these additional protections on `main`:

- PLM source records are normalized consistently before downstream cleansing and
  dead-letter capture.
- HTTP adapter paths reject absolute or traversal-like inputs and preserve
  reserved pagination query parameters.
- Pipeline-runner target-write metrics are guarded against malformed adapter
  counter values.
- External-system connection tests do not expose secret-like result payloads.
- K3 live PoC preflight/evidence text rejects secret-bearing values in free-text
  fields.
- K3 SQL Server channel separates core-table read allowlists from middle-table
  write targets.

## Remaining Work Estimate

After this batch, the open ERP/PLM/K3 queue is mostly smaller hardening PRs plus
a separate UI/config/live-evidence group.

Approximate remaining engineering work:

- Backend/runtime guard drain: 2-3 more small batches.
- K3 setup UI/config stack, including #1392: 1 focused batch after stack cleanup
  or backend metadata-preservation patching.
- Conflicting/live-evidence PRs: 1-2 batches, depending on conflict depth.
- Customer live PoC: blocked on GATE packet, network reachability, credentials,
  and test账套 behavior; usually 2-5 working days after customer data arrives.

The codebase is much closer to test deployment than to final customer signoff:
mock/offline paths are strong, while live K3/PLM signoff still depends on
customer-provided environment facts.
