# R1 BPMN SSRF egress line — development & verification (2026-07-01)

Survey of the BPMN HTTP-task SSRF boundary line (design-lock `#3428` plus A3
rollout lock `#3452`): what is landed, what is verified, and what remains
gated. Grounded against `origin/main` after `#3457` plus this A3-c runtime
policy-injection slice.

## 1. Baseline

- The live target is `BPMNWorkflowEngine.executeHttpTask` in
  `packages/core-backend/src/workflow/BPMNWorkflowEngine.ts`.
- Before R1, the HTTP task used raw outbound `fetch(url, ...)` after templating
  `url`, `headers`, and `body`, then stored the response body into a workflow
  variable. That was full-read SSRF, not blind egress.
- The R1 design-lock (`#3428`) ratified hard fail-closed rollout (`D3`),
  `https:`-only, exact-host allowlists, forbidden hop-sensitive headers, and an
  in-process IP-pinned dispatcher.

## 2. Landed And Verified

| Item | PR / commit | Covers |
|---|---|---|
| SSRF boundary design-lock | `#3428` / `0a794a118` | Boundary spec: L1 scheme, L2 IP deny-list, L3 positive allowlist, L4 redirect validation, L5 rebinding/TOCTOU defeat, L6 caps, L7 fail-closed, L8 header/method hardening, and D0-D5 decisions. |
| R1-A egress URL/IP guard | `#3432` / `3915c1ca4` | `validateEgressUrl` + `isBlockedEgressIp`: `https:`-only, credentials rejected, exact-host allowlist, fail-closed empty allowlist, internal DNS names rejected, public/private IP classification, and WHATWG canonicalization of decimal/hex/short IPv4 forms. |
| NAT64 NSP hardening | `#3438` / `032e063af` | Adds configurable `/96` NAT64 prefixes so network-specific-prefix NAT64 cannot hide an embedded unsafe IPv4. |
| IPv4-compatible / ISATAP hardening | `#3437` / `dabd5217b` | Blocks deprecated IPv4-compatible and ISATAP-wrapped embedded IPv4 literals. The adversarial ISATAP/compat probe blocked internal embedded IPv4 and allowed public embedded IPv4. |
| Helper API hardening | `#3443` / `925932837` | `isBlockedEgressIp()` always folds in the well-known NAT64 prefix even for direct helper callers passing custom prefixes, preventing future default-prefix drift. |
| A1 IP-pinned dispatcher | `#3447` / `be35eec6` | Adds `dispatchPinnedEgressRequest`: resolve-all DNS, deny if any resolved IP is unsafe, pin the chosen validated IP, revalidate redirects, cap redirects, and require manual redirect handling. No engine wiring in that slice. |
| A2 engine wiring | `#3451` / `5193432a8` | Replaces the raw `fetch` path in `executeHttpTask` with the pinned dispatcher plus HTTPS JSON transport; preserves Host/SNI while connecting to the pinned IP; enforces GET/POST only; rejects `Authorization`, `Cookie`, `Host`, `Proxy-*`, `Forwarded`, and `X-Forwarded-*`; caps headers, redirects, timeout, and response size; default policy remains fail-closed. |
| A3 rollout policy design-lock | `#3452` / `771871e05` | Locks the next governance gate: server-owned policy source only, exact DNS host policy entries, NAT64 prefixes as classifier metadata only, fail-closed malformed/absent config, both engine construction sites sharing one loader path, route provenance negative controls, and values-free evidence. The design-lock itself did not enable runtime egress. |
| A3-a policy normalizer | `#3455` / `cead5a84d` | Adds `normalizeBpmnHttpTaskEgressPolicyConfig`: server-owned policy config parsing, exact ASCII DNS host validation, `/96` deployment NAT64 prefix normalization, duplicate rejection, order-independent fingerprinting, and values-free metadata/errors. No route/runtime/config loader, DNS lookup, transport, persistence, or live allowlist enablement. |
| A3-b route provenance negative controls | `#3457` / `4bd15aca3` | Locks that workflow deploy/start/designer payloads, start variables, and BPMN extension XML cannot smuggle egress policy into `BPMNWorkflowEngine`. Adds route and engine negative controls while keeping A3-c runtime policy injection gated. |
| A3-c runtime policy injection | `#3460` | Injects the normalized backend-only `BPMN_HTTP_TASK_EGRESS_POLICY` source into both BPMN route engine construction sites. Missing/malformed/invalid config still injects the default empty allowlist. No concrete production/staging destination is committed. |

## 3. Current Runtime State

`executeHttpTask` is no longer a naked outbound fetch site. It now calls
`dispatchPinnedEgressRequest` with:

- a route-injected policy loaded from backend-only
  `BPMN_HTTP_TASK_EGRESS_POLICY`, or the default empty allowlist when config is
  missing/malformed/invalid;
- a DNS resolver that returns all A/AAAA answers and validates every answer;
- `createPinnedHttpsJsonTransport()`, which connects to the pinned IP and keeps
  the original hostname for Host/SNI;
- method/header filtering before the dispatcher sees the request.

That closes the live full-read SSRF path by default. Existing workflows that
depended on unconstrained HTTP tasks now fail closed unless deployment-owned
server config supplies an exact-host allowlist.

## 4. Verification

- Guard tests cover scheme, credentials, allowlist, internal hostnames, unsafe
  IPv4/IPv6 classes, IPv4-mapped, IPv4-compatible, NAT64 well-known + NSP,
  ISATAP, 6to4, Teredo, and decimal/hex/short-form IPv4 canonicalization.
- Dispatcher tests cover default fail-closed policy, Host-header rejection,
  DNS uncertainty, mixed public/private DNS answers, NAT64, IP literals,
  redirect re-validation, redirect caps, and pinned-target handoff.
- Pinned transport tests cover IP pinning, Host/SNI preservation, caller Host
  stripping, timeout, response-size cap, and JSON response parsing.
- Engine egress tests cover denied URL/DNS/header/method paths before
  transport, allowed dispatcher-normalized URL usage, response-variable
  persistence, and default fail-closed behavior.
- `#3451` fresh CI passed `test (18.x)`, `test (20.x)`, coverage, K3 WISE,
  after-sales, and the contract gates.
- Focused local verification recorded on `#3451`: 75/75 focused tests,
  backend type-check, backend build, focused ESLint, and `git diff --check`.
- `#3452` fresh CI passed `test (18.x)`, `test (20.x)`, coverage, K3 WISE,
  after-sales, and the contract gates; the A3 design-lock is docs-only and
  does not enable a destination.
- `#3455` shipped the pure A3-a policy normalizer with focused tests for
  fail-closed missing/malformed config, exact-host validation, NAT64 prefix
  validation, duplicate handling, order-independent fingerprints, and
  values-free error metadata. The slice has no route/runtime consumer.
- `#3457` local focused verification recorded route + engine provenance tests:
  2 files / 10 tests PASS; core backend build PASS; the combined R1
  guard/dispatcher/transport/policy-normalizer/engine/route-provenance suite:
  6 files / 112 tests PASS; `git diff --check` PASS.
- `#3457` fresh CI passed `test (18.x)`, `test (20.x)`, coverage, K3 WISE,
  after-sales, and the contract gates after rebasing to the current main.
- A3-c runtime verification covers missing/malformed config fail-closed,
  allowlisted-host pass-through via mocked DNS/transport, request/BPMN/variables
  policy-smuggling negative controls, both route construction sites sharing the
  same server-owned policy source, and the convergence guard that prevents the
  policy helper from importing `BPMNWorkflowEngine`.

## 5. Remaining Gate

The R1 code path is closed by default, and the A3 rollout runtime now has a
server-owned policy source. Configuring any real destination remains a separate
deployment/governance action, but the code path for policy injection is shipped
by this slice.

| Remaining item | State | Why it remains separate |
|---|---|---|
| Concrete destination rollout | **CONFIGURATION GATED** | The code supports backend-only `BPMN_HTTP_TASK_EGRESS_POLICY`, but no production/staging host is committed here. Choosing a real host remains an owner/governance deployment decision. |

## 6. Outcome

- R1 design-lock, guard, IP classifier hardening, dispatcher, engine wiring,
  A3-a policy normalizer, A3-b route provenance negative controls, and A3-c
  runtime policy injection are all merged or implemented by this line.
- The original live SSRF hole is closed by default: no configured allowlist means
  no outbound HTTP-task request is dispatched.
- The remaining work is not another blind SSRF patch; it is concrete
  deployment-owned allowlist configuration, if/when an owner chooses a real
  destination.

## Invariants Held

- No `HTTPAdapter`, connector-action runtime, script-task expression boundary,
  or non-BPMN outbound surface is claimed as fixed by R1.
- No temporary allowlist or warn-only mode was introduced.
- No owner/governance gate was converted into an implicit runtime enablement.
