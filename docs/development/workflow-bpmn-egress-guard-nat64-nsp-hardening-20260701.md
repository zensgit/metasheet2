# R1-A egress guard — NAT64 Network-Specific-Prefix hardening (2026-07-01)

Follow-up to the R1-A egress guard (`3915c1ca4`), from the ratified BPMN SSRF design-lock
(`#3428`). Guard-only; **no BPMN engine wiring**.

## Finding

An independent adversarial probe of the egress IP classifier surfaced one real bypass class the
R1-A guard missed: **NAT64 on a Network-Specific Prefix (NSP)**. `isBlockedIpv6` decoded the
embedded IPv4 only for the well-known NAT64 prefix `64:ff9b::/96`. A deployment whose NAT64
gateway uses any other (globally-routable) `/96` prefix — e.g. the real public service
`2a00:1098:2c::/96` — wraps an **internal** v4 (RFC-1918 / CGNAT / metadata) in the low 32 bits;
the outer address classifies as `unicast`, so `isBlockedEgressIp` returned `false` and the
internal target could be reached through the translator.

## Fix

`EgressPolicy.nat64Prefixes?: readonly string[]` — extra `/96` NAT64 prefixes this deployment
translates. The well-known `64:ff9b::/96` is always decoded; `validateEgressUrl` passes
`[well-known, ...policy.nat64Prefixes]` to the classifier, which decodes the embedded v4 for any
matching `/96` prefix and classifies it (an internal inner v4 → blocked; a public inner v4 →
decoded and allowed). Existing callers are unchanged (`isBlockedEgressIp(host)` defaults to the
well-known prefix), so the R1-A behaviour and tests are preserved.

## Residual (documented, not a silent gap)

- A NAT64 gateway on an NSP **must be declared** in `nat64Prefixes`; an unconfigured NSP literal
  is treated as ordinary global-unicast. It remains gated by the L3 **allowlist** (an attacker's
  NAT64 literal must be explicitly allowlisted to pass `validateEgressUrl`), which is the backstop.
- NAT64 with a non-`/96` RFC 6052 prefix length is not decoded.
- Full hostname L2 (resolve every A/AAAA, classify, and pin atomically to defeat DNS rebinding)
  remains the slice-2 dispatcher's job; this guard classifies IP-literal hosts only.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run src/guards/__tests__/egress-guard.test.ts`
  — **45 tests pass** (R1-A suite + new NSP cases: well-known default, configured NSP →
  internal/metadata blocked, configured NSP → public decoded, unconfigured residual, and the
  end-to-end `IP_BLOCKED`).
- `pnpm --filter @metasheet/core-backend run type-check` (`tsc --noEmit`) — clean.

No new dependency; no runtime is wired to `executeHttpTask`.
