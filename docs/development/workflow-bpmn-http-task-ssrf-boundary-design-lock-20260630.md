# R1 — BPMN HTTP service-task SSRF egress boundary (design-lock, 2026-06-30)

**This is a design-lock. It authorizes no runtime.** It adds no HTTP-egress code, no config
scaffold, no stub, and no "temporary allow," and it does **not** modify `executeHttpTask`. It
locks the threat model, the egress policy, the test matrix, and the fail-closed behavior for the
BPMN HTTP service-task SSRF boundary, and enumerates the implementation slices to be carved
**only after ratification**. The R1 first cut is this document + TODO — nothing else.

## 1. Scope (owner-locked) + grounding assumption

**Grounding assumption (stated so a mis-scope surfaces in one line at review):** R1 locks the SSRF
boundary for the **BPMN HTTP service-task** — `BPMNWorkflowEngine.executeHttpTask`
(`packages/core-backend/src/workflow/BPMNWorkflowEngine.ts:539`), reached from
`executeServiceTask` when `props.type === 'http'`. The user named "R1 BPMN/SSRF"; this file is the
inferred target.

**Explicitly out of scope** (named so they are not silently pulled in):
- `HTTPAdapter` (`packages/core-backend/src/data-adapters/HTTPAdapter.ts`) — the data-source HTTP
  connector; its own egress story, separate slice.
- The latent connector-action contract (`DF-T1A`, `data-factory-df-t1a-connector-action-metadata-*`)
  — already relative-path-only and **not wired to any runtime**; not an outbound-HTTP path.
- The expression / scriptTask surface (`props.expression` / `evaluateExpression`,
  `props.delegateExpression`, `props.class`) — a code/expression-injection threat class, **not**
  SSRF. Distinct boundary, not covered here.
- The `offsetDays` `RangeError` — an independent validation follow-up, deliberately kept out of R1.

## 2. Current state — the hole (why this boundary exists)

`executeHttpTask` (verbatim behavior today):

- resolves `url`, `headers`, `body` via `resolveExpression(props.*, instance.variables)`, and reads
  `method` directly as `props.method || 'GET'` (BPMN-definition-controlled, **not** variable-templated);
- calls `fetch(url, { method, headers, body })` with **no scheme/host/IP validation**;
- stores the response JSON into `props.responseVariable` when set.

Two properties make this severe:
1. **Full-read SSRF, not blind** — the fetched body is written back into a readable workflow
   variable, so an attacker reads the response (e.g. a cloud-metadata credential document), not
   just triggers a request.
2. **Multi-field attack surface** — not only `props.url`. `url`, `headers`, and `body` are
   field-level `resolveExpression` inputs (BPMN definition + workflow variables), so lower-trust
   runtime inputs can influence the outbound target, headers, and payload. `method` is
   BPMN-definition-controlled (`props.method`), **not** workflow-variable-templated today — still
   attacker-selectable via the definition, which is why L8 constrains it.

## 3. Threat / input model

**Trust boundary:** whoever can (a) deploy/author a BPMN definition (the parsed `bpmn_xml`) or
(b) set the workflow variables that template into an http-task field. The design assumes a
workflow author is **not** trusted to reach the internal network or cloud metadata. (The exact
deploy-time authz/provenance is a confirmation point — see D0 — but the boundary must hold
regardless.)

**Attacker-controlled fields and what each buys:**

| Field | Abuse |
|---|---|
| `url` | primary target selection — cloud metadata (`169.254.169.254`), loopback/internal services, port/host scan |
| `headers` | inject `Authorization`/`Cookie` into internal services; `Host` override for vhost/routing confusion |
| `method` | choose read (`GET`) vs **side-effecting** (`POST`/`PUT`/`DELETE`) against internal endpoints (set in the BPMN definition, not variable-templated) |
| `body` | payload to internal side-effecting APIs |

**Assets at risk:** cloud instance-metadata credentials, internal-only HTTP admin/data APIs,
loopback services, internal network reconnaissance, and exfiltration of any of the above via
`responseVariable`.

## 4. Locked policy (invariants — these are the design-lock)

| # | Invariant | LOCKED |
|---|---|---|
| L1 | **Scheme allowlist.** Only `https` (and `http` only per D1). Reject `file:`, `ftp:`, `gopher:`, `data:`, `blob:`, `ws:`/`wss:`, `mailto:`, and any non-http(s). Reject credentials-in-URL (`user:pass@host`). | ✔ |
| L2 | **IP egress deny-list (post-resolution).** Resolve host → ALL A/AAAA records; **deny if ANY** resolved IP is loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16` incl. `…/169.254.169.254`; `fe80::/10`), private (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), IPv6 ULA (`fc00::/7`), IPv4-mapped/compat IPv6 (`::ffff:0:0/96`), `0.0.0.0/8`, multicast (`224/4`, `ff00::/8`), or otherwise non-global/reserved. | ✔ |
| L3 | **Positive egress allowlist.** A destination not on an explicitly configured allowlist (host/CIDR per D2) is denied — allowlist is a *required* positive control on top of L2's negative blocks. | ✔ |
| L4 | **Redirect handling.** Do not auto-follow, OR re-run L1+L2+L3 on every hop's `Location` and its resolved IP; cap redirect count; a redirect to a denied target fails the task. | ✔ |
| L5 | **Rebinding / TOCTOU defeat.** Validation and connection target the **same** IP: resolve → validate the resolved IP(s) → connect to the **pinned** validated IP carrying the original Host/SNI. No re-resolution at fetch time. | ✔ |
| L6 | **Limits.** Bounded connect + total timeout; **max response body size** (the body lands in a variable — cap it); max redirect count (L4); max header size. | ✔ |
| L7 | **Fail-closed.** Unresolvable host, resolution error, validation uncertainty, or missing/empty allowlist → **deny** the task (no fetch). The http-task capability is OFF unless the egress policy is explicitly configured. | ✔ |
| L8 | **Header/method hardening** (shape per D4) — the design locks that caller-set hop-sensitive headers (`Authorization`, `Cookie`, `Host`) and the method set are constrained, not free-form. | ✔ |

## 5. Decisions required to ratify (OPEN — owner's call, not decided here)

| # | Decision | Recommendation |
|---|---|---|
| D0 | Deploy-time provenance/authz of BPMN definitions + who can set http-task variables. | Confirm the actual boundary; design holds either way. |
| D1 | `http` allowed at all, or `https`-only? | `https`-only by default; `http` only for explicitly-named internal allowlisted integrations, if any. |
| D2 | Allowlist granularity: exact host / suffix / CIDR / mix? | Exact host + optional CIDR; **no** bare suffix wildcards. |
| D3 | **Rollout for existing deployed http-tasks.** L7 fail-closed is a **behavior change** — live workflows fetching non-allowlisted targets will break. | A ratification/rollout call, **not** a silent default: (a) hard fail-closed, (b) warn-then-enforce window, (c) per-tenant migration. |
| D4 | Outbound header/method policy (L8 shape). | Forbid caller-set `Authorization`/`Cookie`/`Host`; allow a configured method set. |
| D5 | In-process IP-pinned dispatcher vs a vetted central egress proxy (§6). | Prefer a central egress proxy if one exists (easier to audit); else an in-process pinned-IP agent. |

## 6. Why the current call site cannot be patched in place (TOCTOU)

A naive `validate(url); fetch(url)` **re-resolves DNS at fetch time**, reopening a rebinding window
(validated IP ≠ connected IP). So the implementation slice is **not** "add an if-statement before
`fetch`." It must either (a) introduce a custom fetch dispatcher/agent that connects to the
L5-pinned validated IP with the original Host/SNI, or (b) route through a vetted egress proxy that
enforces L1–L7. This is the realistic scope of the fetch-replacement slice.

## 7. Test matrix (to build in the impl slice — not now)

- **Scheme:** reject `file:`/`ftp:`/`gopher:`/`data:`/`blob:`/`ws:`/`mailto:`; reject creds-in-URL; accept allowlisted `https`.
- **IP class:** reject `127.0.0.1`, `::1`, `169.254.169.254`, `fe80::…`, `10/172.16/192.168`, `100.64…`, `fc00::…`, `::ffff:127.0.0.1` (mapped), `0.0.0.0`; accept an allowlisted public host.
- **Allowlist:** deny a public-but-not-allowlisted host; allow an allowlisted host.
- **Redirect:** reject redirect → internal; cap hop count.
- **Rebinding:** resolver returns public then private across calls → still safe (pinned IP).
- **Limits:** oversize body → denied/truncated; timeout → fails closed.
- **Fail-closed:** no allowlist configured → all http-tasks denied; DNS error → denied.
- **Fields:** attacker-set `headers`/`method`/`body` never reach a denied target.

## 8. Files

- **This design-lock doc — the only file this slice touches.**
- (Post-ratification, impl slices would touch `BPMNWorkflowEngine.executeHttpTask`, a new
  egress-guard/dispatcher module, and tests — **not** in this slice.)

## 9. Existing primitives

A grep of `core-backend` found **no dedicated SSRF/egress-guard primitive** to reuse; the impl
slice introduces one. (`multitable/automation-executor.ts` is worth checking during impl for any
reusable URL/allowlist handling before inventing.)

## 10. Implementation slices — NOT started (carve only after D0–D5 are ratified)

1. **Egress-guard module** — `validateEgressUrl(url, policy)` (L1–L3) + fail-closed policy config
   (L7), unit-tested against the §7 scheme/IP/allowlist matrix. No engine wiring.
2. **IP-pinned egress dispatcher** (L5) + redirect re-validation (L4) — the `fetch` replacement.
3. **Wire `executeHttpTask`** to the dispatcher; apply L6 limits + L8 header/method policy +
   response-size cap.
4. **Rebinding + redirect + rollout (D3) integration tests**; enable behind the configured policy.

Each slice takes its own opt-in.

---

**This document authorizes no runtime.** `executeHttpTask` is unchanged; no egress code, config
scaffold, or temporary allow is introduced. Implementation begins only after D0–D5 are ratified.
