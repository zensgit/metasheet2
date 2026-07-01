# R1 BPMN SSRF egress line — development & verification (2026-07-01)

Survey of the BPMN HTTP-task SSRF boundary line (design-lock `#3428`): what is landed, what is
in-flight, and the remaining gated slices — grounded against current `main`. Guard work is
**not wired** to `executeHttpTask`; nothing here changes runtime behaviour of live workflows.

## 1. Baseline

- MetaSheet2 `origin/main` at `032e063af`.
- The egress guard lives at `packages/core-backend/src/guards/egress-guard.ts` (+ its test); it is
  a pure policy/IP primitive with no BPMN engine wiring.

## 2. Landed (verified on `main`)

| Item | PR / commit | Covers |
|---|---|---|
| SSRF boundary design-lock | `#3428` | The boundary spec — L1 scheme, L2 IP deny-list, L3 allowlist, L4 redirect, L5 rebinding/TOCTOU, L6 caps, L7 fail-closed, L8 header/method — and the D0–D5 decisions. |
| R1-A egress guard | `3915c1ca4` | `validateEgressUrl` + `isBlockedEgressIp`: https-only scheme, creds rejection, exact-host allowlist (fail-closed), internal-DNS-name block (`localhost`/`.local`/`.internal`), IPv4/IPv6 class deny-list, IPv4-mapped + NAT64 (well-known) + 6to4 + Teredo decomposition, WHATWG canonicalization of decimal/hex/short IPv4. Guard-only. |
| NAT64 NSP hardening | `#3438` | Configurable `EgressPolicy.nat64Prefixes` — closes the NAT64 **Network-Specific-Prefix** embedded-v4 bypass an adversarial probe surfaced (main previously decoded only the well-known `64:ff9b::/96`). |

## 3. In-flight (implemented, awaiting merge)

| Item | PR | State | What it adds |
|---|---|---|---|
| Embedded IPv4-compatible / ISATAP literals | `#3437` (`codex/r1a-egress-ip-compat-followup`) | OPEN, **DIRTY** (+26/−1) | Blocks deprecated IPv4-compatible (`::a.b.c.d`, `::/96`) and ISATAP-wrapped (`…:5efe:a.b.c.d`) embedded literals — a real remaining IP-class gap (current `main` handles neither). |

`#3437` is the only open buildable item on this line. It is DIRTY because `#3438` changed the
`isBlockedIpv6` base after it was branched; it needs a **rebase onto post-`#3438` main**, after
which it completes the IP-literal classification surface. It is a **parallel codex branch**, not
mine — landing it is a coordinate-and-rebase, not new build.

## 4. Coordination note — this file is under active parallel iteration

`egress-guard.ts` took R1-A, `#3438`, and `#3437` within a single day, all touching
`isBlockedIpv6`. One duplicate collision already occurred (a from-scratch slice-1 rewrite, PR
`#3434`, was closed as a duplicate of R1-A; only its NAT64 fix was salvaged as `#3438`). The
classifier is now near-complete, so **further IP-class additions must be small deltas on the
current base and rebased promptly**, not parallel rewrites — otherwise they DIRTY-churn against
each other.

## 5. Remaining slices — gated, and **dependency-ordered (not parallel)**

The user's usual "order for parallel execution" does not apply cleanly here: unlike the PLM line's
independent groups, the remaining R1 slices are a **sequential chain** (each is the prerequisite
for the next) and each takes its **own explicit opt-in** before code.

| Order | Slice | Gate | Depends on |
|---|---|---|---|
| 2 | **IP-pinned egress dispatcher** — DNS resolve-all + `isBlockedEgressIp` on every resolved IP + **atomic IP pinning** (L5 anti-rebinding) + redirect re-validation (L4) + timeout/response-size caps (L6). | opt-in + **D5** (in-process pinned dispatcher vs central egress proxy) | the landed guard |
| 3 | **Engine wiring + header/method hardening** — route `executeHttpTask` through the dispatcher; forbid caller-set `Authorization`/`Cookie`/`Host`; method allowlist (L8, **D4**). | opt-in + D4 | slice 2 |
| 4 | **Rollout** — fail-closed (L7) is a behaviour change for existing http-tasks; owner ratifies hard-fail-closed vs warn-then-enforce vs per-tenant (**D3**), then enable behind policy. | **owner D3 governance** | slice 3 |

Parallelism exists only *within* slice 2 (resolver, pinned-connection agent, redirect validator,
caps can be built concurrently); the slices themselves are 2 → 3 → 4.

## 6. Verification (current)

- Landed guard: `packages/core-backend/src/guards/__tests__/egress-guard.test.ts` — scheme/creds/
  allowlist/internal-name/IP-class matrix (incl. IPv4-mapped, NAT64 well-known + NSP, 6to4, Teredo,
  and decimal/hex/short-form normalization) passes on `main`; `tsc --noEmit` clean.
- Adversarial probe (run against the **closed** slice-1 build `#3434`, **not** current `main`): the
  **URL-parsing** corpus found no bypass; the **IP-representation** corpus found exactly one — NAT64
  NSP — now fixed (`#3438`). The IPv4-compatible / ISATAP forms were **not** in that probe's scope,
  and `#3437`'s handling of them is **unverified** here.

## 7. Outcome

- Current `main`'s IP-literal classification covers IPv4-mapped, NAT64 (well-known + NSP), 6to4, and
  Teredo. It **still has the IPv4-compatible / ISATAP gap** — `#3437` intends to close it but is
  **unlanded, DIRTY, and its embedded-v4 extraction is not adversarially verified** here (ISATAP
  decode is exactly the fiddly path that leaked as NSP-NAT64 did). The surface is not "complete"
  until `#3437` is verified + landed. The one prior probe ran against the *closed* slice-1 build,
  not current `main`.
- The **substantive remaining development is slices 2–4**, which are **gated (opt-in)** and
  **dependency-ordered**, with slice 4 carrying the **D3 rollout governance** decision. There is no
  unowned, buildable-now, ungated slice that can be built without colliding on the actively-iterated
  guard file.
- **Next motion:** (a) rebase + land `#3437` (coordinate — it is a parallel branch, not mine); the one
  non-colliding value-add available now is an **adversarial review of `#3437`'s ISATAP/compat
  extraction** (does it block the embedded *internal* v4, or leak like NSP-NAT64 did?) as a review
  comment on that PR, reusing the probe harness. Then (b) owner opt-in for **slice 2** (the IP-pinned
  dispatcher, the real next build).

## Invariants held

- Guard-only; no wiring into `executeHttpTask`.
- The embed §0 read-only invariant is untouched; this line concerns outbound http-task egress only.
- No owner/ops/governance gate (D3 rollout especially) was converted to code.
