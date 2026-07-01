# R1-A BPMN egress guard slice 1 — development + verification (2026-07-01)

**Status: REVIEWABLE — NOT WIRED.** This slice implements the pure egress URL/policy guard
authorized by `workflow-bpmn-http-task-ssrf-boundary-design-lock-20260630.md` after `R1 GO`.
It does not modify `BPMNWorkflowEngine.executeHttpTask`, does not fetch, and does not change live
workflow behavior.

## What this slice adds

- `validateEgressUrl(url, policy)` in `packages/core-backend/src/guards/egress-guard.ts`.
- `defaultEgressPolicy()` is fail-closed: an empty/missing allowlist denies every URL.
- V1 policy follows the ratified §0 decisions:
  - `https:` only; `http:` remains denied even if the host is allowlisted.
  - exact-host allowlist only, case-normalized.
  - no suffix wildcard, bare wildcard, or CIDR allowlist in this runtime slice.
  - credentials in the URL are rejected.
  - unsafe hostnames such as `localhost`, `.localhost`, `.local`, and `.internal` are rejected
    even if accidentally allowlisted.
  - IP literals are classified before allow, including canonicalized decimal/hex/short IPv4 forms.
- `ipaddr.js` is now a direct backend dependency because this security boundary needs robust IPv6
  classification for mapped IPv4, NAT64, 6to4, Teredo, CGNAT, multicast, and reserved ranges.
- The existing `send_webhook` SSRF guard was reviewed and left untouched. It is a product-specific
  resolve-and-pin path; this slice adds the BPMN policy primitive under `src/guards` and keeps
  dispatcher reuse/wiring for later slices.
- Callers must use the returned `decision.normalizedUrl` when a URL is allowed. It is the WHATWG
  canonicalized URL that this guard evaluated; a later caller that fetches the raw input string could
  reintroduce parser-split ambiguity outside this module.

## Explicitly not shipped

- DNS resolution and post-resolution IP validation.
- IP-pinned dispatcher and redirect validation.
- Header/method filtering.
- Any wiring into BPMN HTTP service tasks.

Those are the next R1 slices.

## Verification

- Unit coverage: `packages/core-backend/src/guards/__tests__/egress-guard.test.ts`
  - scheme rejection matrix;
  - credential rejection;
  - default fail-closed policy;
  - exact-host allowlist;
  - wildcard/CIDR non-support;
  - local/internal hostname rejection;
  - unsafe IPv4/IPv6 classes, IPv4-mapped IPv6, NAT64, 6to4, and Teredo;
  - deprecated IPv4-compatible IPv6 and ISATAP-wrapped IPv4;
  - URL canonicalization of decimal/hex/short IPv4 forms before IP blocking.
