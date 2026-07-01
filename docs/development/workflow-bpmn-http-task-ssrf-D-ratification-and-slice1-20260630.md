# R1 SSRF — D0–D5 ratification + slice 1 (egress-guard module), 2026-06-30

Companion to the design-lock
`docs/development/workflow-bpmn-http-task-ssrf-boundary-design-lock-20260630.md` (`#3428`).
This record (1) ratifies the D0–D5 decisions and (2) records slice 1 — the standalone
egress-guard module. **No runtime is wired to `executeHttpTask`;** the module resolves no DNS and
opens no sockets.

## 1. D0–D5 ratification

Ratified per the design-lock recommendations. The two decisions that shape slice 1 (D1, D2) are
encoded as **`EgressPolicy` config**, not hard-coded; the rest bind at their *wiring* slices and
remain owner-amendable — so slice 1 does **not** silently settle the genuinely owner-scoped calls
(D3 rollout especially).

| # | Decision | Ratified | Binds at |
|---|---|---|---|
| D0 | Deploy provenance / who sets http-task fields | Workflow authors are untrusted for network egress; the boundary holds regardless of deploy authz. | (assumption; no code input) |
| D1 | `http` vs `https`-only | `https`-only **default**; `http` allowed only when explicitly configured. Encoded as `EgressPolicy.allowedSchemes` (default `['https']`). | slice 1 (config) |
| D2 | Allowlist granularity | Exact host **and** CIDR; no bare suffix wildcards. Encoded as `allowedHosts` (exact) + `allowedCidrs`. | slice 1 (config) |
| D3 | **Rollout for existing http-tasks** | fail-closed (L7) is a behavior change — **still an owner call** (hard fail-closed / warn-then-enforce / per-tenant). Not decided here. | **slice 3/4 (wiring)** — owner ratifies before enforcement reaches live workflows |
| D4 | Outbound header/method policy (L8) | forbid caller-set `Authorization`/`Cookie`/`Host`; configured method set. | slice 3 (wiring) |
| D5 | in-process IP-pinned dispatcher vs egress proxy | in-process pinned-IP dispatcher unless a central egress proxy is adopted. | slice 2 (dispatcher) |

Slice 1 is safe to build now because it needs only D1 + D2 (both config); D3/D4/D5 do not gate it
(the module is not wired, so no live workflow is affected and no rollout call is forced).

## 2. Slice 1 — egress-guard module (this PR)

`packages/core-backend/src/guards/egress-guard.ts` + `__tests__/egress-guard.test.ts`, exported
from `guards/index.ts`. Adds the runtime dep **`ipaddr.js`** (vetted IP/CIDR parsing on a security
path — chosen over hand-rolling IPv6/mapped/CIDR logic).

Exports:
- **`isBlockedIp(ip, nat64Prefixes?)` (L2 core, reusable by slice 2):** blocks loopback, link-local
  (incl. cloud metadata `169.254.169.254`), private, CGNAT, IPv6 ULA, multicast, reserved,
  unspecified/broadcast — and **decomposes embedded-IPv4 tunnel forms** (IPv4-mapped, 6to4
  `2002::/16`; Teredo blocked outright; NAT64 for the well-known `64:ff9b::/96` **and any
  operator-configured `/96` prefix**) so those wrappers cannot smuggle a blocked v4. Unparseable →
  fail-closed. **Residual:** a NAT64 gateway on a Network-Specific Prefix must be declared via
  `EgressPolicy.nat64Prefixes`, else an IP-literal in that prefix is treated as global-unicast
  (still gated by the L3 allowlist); non-`/96` NAT64 lengths are not decoded.
- **`validateEgressUrl(url, policy)` (synchronous — L1 + L3 + L2-for-IP-literals):** canonicalizes
  with WHATWG `URL` and classifies `url.hostname` (so decimal/octal/hex/short IPv4 forms normalize
  before classification); enforces scheme allowlist, rejects credentials-in-URL, requires allowlist
  membership, and applies `isBlockedIp` to IP-literal hosts. **L2 overrides L3** (an allowlisted
  internal IP is still blocked).
- **`defaultEgressPolicy()`:** `https`-only + empty allowlist ⇒ **deny all** (fail-closed).

**Explicitly NOT in slice 1:** DNS resolution + the atomic resolve-and-pin dispatcher (slice 2,
where `isBlockedIp` runs on each resolved IP then pins it — keeping resolve-and-pin atomic so no
rebinding hole opens between slices); wiring into `BPMNWorkflowEngine.executeHttpTask` + header/
method hardening (slice 3, L8); rollout (slice 3/4, D3).

## 3. Verification

- `pnpm --filter @metasheet/core-backend exec vitest run src/guards/__tests__/egress-guard.test.ts`
  — **59 tests pass** (scheme/creds; the IP-literal zoo incl. IPv4-mapped/NAT64/6to4/Teredo metadata
  + loopback, and decimal/hex/short-form normalization; allowlist; L2-overrides-L3; fail-closed).
- `pnpm --filter @metasheet/core-backend run type-check` (`tsc --noEmit`) — **clean**.
- An independent adversarial probe (IP-representation + URL-parsing corpus) was run over both
  functions. The URL probe found **no** bypass. The IP probe surfaced one real gap — NAT64 on a
  Network-Specific Prefix (only the well-known prefix was decoded) — now closed by the configurable
  `nat64Prefixes` above and pinned by new tests.

## 4. Next slices (not started — each takes its own opt-in)

2. IP-pinned egress dispatcher (L4 redirect re-validation + L5 rebinding/TOCTOU defeat) — calls
   `isBlockedIp` on every resolved IP and pins.
3. Wire `executeHttpTask` to the dispatcher; apply L6 limits + L8 header/method policy (D4); D3
   rollout.
4. Rebinding/redirect/rollout integration tests; enable behind the configured policy.

This record authorizes no runtime wiring. `executeHttpTask` is unchanged.
