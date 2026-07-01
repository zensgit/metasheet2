# R1-A3 BPMN HTTP-task egress policy rollout design-lock (2026-07-01)

**Status: DESIGN-LOCK ONLY — A3 RUNTIME NOT BUILT.** This document opens no
HTTP-task destination, adds no server configuration loader, changes no workflow
route, and does not modify `BPMNWorkflowEngine`. It locks the rollout and policy
enablement contract for the already-merged R1 HTTP-task egress line:

- A1 guard/dispatcher and A2 engine wiring are merged and default fail-closed.
- The original raw `fetch(url)` full-read SSRF path is closed by default.
- A missing configured allowlist still denies all BPMN HTTP-task egress.
- Enabling any real destination remains a separate owner/governance gate.

## 1. Scope

This A3 lock covers only the BPMN HTTP service-task egress policy rollout for
`BPMNWorkflowEngine.executeHttpTask`, reached through the existing workflow and
workflow-designer route surfaces.

In scope:

- server-owned policy source and policy normalization;
- route/runtime provenance requirements for the two `BPMNWorkflowEngine`
  construction sites:
  - `packages/core-backend/src/routes/workflow.ts`;
  - `packages/core-backend/src/routes/workflow-designer.ts`;
- values-free audit/evidence for policy decisions and HTTP-task attempts;
- negative controls proving configured policy enablement does not reopen
  free-form egress.

Out of scope:

- any `HTTPAdapter` or data-source connector egress surface;
- workflow script/expression execution hardening;
- product/admin UI for managing egress policies;
- tenant/user-authored allowlists;
- write/side-effect expansion beyond the R1 method/header policy;
- live destination enablement in this PR.

## 2. Baseline

R1 has already landed the dangerous runtime closure:

- `#3428` design-lock ratified `https:`-only, exact-host allowlists, hard
  fail-closed rollout, header/method constraints, redirect validation, and
  IP-pinned dispatch.
- `#3432`, `#3437`, `#3438`, and `#3443` landed the egress guard and IP
  classifier hardenings.
- `#3447` landed the IP-pinned dispatcher.
- `#3451` wired `executeHttpTask` to the dispatcher and removed the raw
  outbound `fetch` path.
- `#3442` refreshed the development/verification ledger after A2.

The current runtime is intentionally dormant by default. `new BPMNWorkflowEngine()`
uses `defaultEgressPolicy()`, whose `allowedHosts` is empty, so all HTTP-task
egress fails closed unless a future A3 slice injects a validated policy.

## 3. Locked A3 policy model

### P1. Server-owned source only

The egress policy is sourced only from deployment-owned server configuration.
Runtime requests, BPMN variables, BPMN XML, workflow start variables, tenant
records, and user-controlled payloads must not supply or override:

- `allowedHosts`;
- `nat64Prefixes`;
- timeout/body/header/redirect caps;
- method/header allowlists;
- transport or DNS resolver behavior.

The implementation may choose the concrete server-config vehicle in its own
slice (environment variable, process config, or deployment config object), but it
must be backend-only, explicit, audited, and absent-by-default.

### P2. Exact DNS hosts only

The A3 policy normalizer accepts exact DNS hostnames only for `allowedHosts`.
It rejects:

- empty host lists;
- schemes, paths, query strings, fragments, userinfo, ports, slashes, `@`, or
  wildcard characters;
- suffix wildcards and bare-domain wildcards;
- CIDR ranges;
- IP literals, even public IP literals, for v1 rollout policy;
- Unicode/IDN hostnames in non-ASCII form;
- internal-name suffixes already blocked by the guard (`localhost`,
  `.localhost`, `.local`, `.internal`).

Accepted hosts are ASCII DNS names only, normalized case-insensitively and
trailing-dot-insensitively, matching the guard's canonical host comparison.
Punycode labels such as `xn--...` may be accepted as ordinary ASCII DNS labels;
operator-provided Unicode IDNs must not be silently converted in A3 v1. If a
future slice wants first-class Unicode IDN support, it must explicitly normalize
both policy host entries and runtime URL hostnames through the same
Punycode/domain-to-ASCII path and test the match. The existing egress guard still
performs post-DNS IP classification and deny-list checks on every resolved IP.

### P3. NAT64 prefixes are classifier input, not allowlist scope

`nat64Prefixes` is optional operator metadata for the IP classifier only. It
does not authorize any destination by itself.

Rules:

- only `/96` IPv6 prefixes are accepted;
- malformed or non-`/96` prefixes fail the policy closed;
- the well-known `64:ff9b::/96` remains always included;
- no tenant/user-authored NAT64 prefix input exists in A3.

### P4. Fail-closed on absent or malformed policy

Missing config, malformed config, empty allowlist, invalid host, invalid NAT64
prefix, duplicate/unknown shape, or policy parse uncertainty all resolve to the
same runtime posture: HTTP-task egress remains disabled.

A3 must not introduce a warn-only window, a temporary allow, or a fallback to
raw fetch.

### P5. Both engine construction sites share the same policy path

`workflow.ts` and `workflow-designer.ts` each instantiate `BPMNWorkflowEngine`.
A3 runtime wiring must cover both construction sites through one shared loader or
factory path. Enabling policy for only one route family is incomplete.

### P6. Route provenance and authorization are part of the rollout boundary

The egress boundary must not rely on workflow authors being trusted.

Before or alongside configured egress enablement, A3 must prove that the route
surfaces that can deploy/start BPMN HTTP tasks remain authenticated and cannot
smuggle policy:

- `POST /api/workflow/deploy`;
- `POST /api/workflow/start/:key`;
- `POST /api/workflow-designer/workflows/:id/deploy`.

The route surfaces may carry BPMN definitions, variables, and task inputs, but
they must not carry policy. A request body containing an allowlist-like or
egress-policy-like key is ignored or rejected; it must never override the
server-owned policy.

### P7. Values-free audit and evidence

A3 evidence/audit may include only bounded, non-secret metadata:

- policy present/missing;
- normalized allowed-host count;
- policy fingerprint or version;
- destination host only, not full URL;
- coarse deny reason;
- workflow definition id/key, process instance id, activity id, and route name;
- actor/user id if already available from auth middleware.

A3 evidence/audit must not include:

- full URL, path, query, fragment, headers, body, response body, cookies, bearer
  tokens, credentials, or workflow variable values;
- raw BPMN XML;
- raw policy JSON if it contains deployment-specific hostnames that the chosen
  evidence channel is not allowed to disclose.

If hostnames are considered sensitive in a deployment evidence channel, use a
stable hash/fingerprint instead of the literal host.

## 4. Implementation slices

Each slice needs its own owner opt-in. No slice may combine this design-lock with
live destination enablement.

### A3-a. Policy loader and normalizer, pure

Build a pure module that reads a server-owned config input and returns either:

- a normalized `EgressPolicy` plus values-free metadata; or
- a fail-closed decision plus coarse error code.

No route, engine, transport, DNS, database, or outbound call is touched in this
slice.

Required tests:

- missing config -> disabled/fail-closed;
- empty allowlist -> disabled/fail-closed;
- exact host normalization -> accepted;
- wildcard/suffix/path/scheme/port/IP literal/CIDR/internal-name inputs ->
  rejected;
- Unicode IDN host input -> rejected; explicit punycode host input -> accepted
  if it otherwise passes the exact-host rules;
- malformed NAT64 prefix -> rejected;
- valid `/96` NAT64 prefix -> accepted as classifier metadata;
- no raw config value is echoed in evidence.

### A3-b. Route provenance and policy-smuggling negative controls

Add or verify route-level tests around workflow deploy/start and designer deploy
showing:

- auth still gates those routes;
- policy-like request payload fields do not reach the engine as policy;
- BPMN XML and variables cannot set `allowedHosts` or `nat64Prefixes`;
- evidence stays values-free.

This slice still does not need to enable a live destination.

### A3-c. Runtime policy injection, configured enablement

Wire the normalized server-owned policy into both `BPMNWorkflowEngine`
construction sites. This is the first slice that can make an allowlisted
destination reachable, so it requires explicit owner opt-in.

Required tests:

- default/missing config remains fail-closed;
- malformed config remains fail-closed;
- disallowed host is denied before transport;
- allowlisted host can pass through mocked DNS + mocked transport;
- redirect to non-allowlisted host is denied;
- mixed public/private DNS answer is denied;
- request-supplied policy cannot override the server policy;
- both route construction sites use the same policy source.

## 5. Acceptance matrix

| Case | Expected |
|---|---|
| No policy configured | HTTP task denied; no transport call. |
| Policy configured with empty host list | Denied; no transport call. |
| Policy configured with `https://api.example.com` as host entry | Rejected at policy-normalization time; hosts are hostnames only. |
| Policy configured with `*.example.com` or `.example.com` | Rejected; no wildcard/suffix policy in v1. |
| Policy configured with public IP literal | Rejected by A3 policy even if the lower guard could classify it. |
| Policy configured with Unicode IDN host | Rejected; A3 v1 requires ASCII host entries and avoids silent IDN/Punycode mismatch. |
| Policy configured with explicit punycode host | Accepted only as an exact ASCII DNS hostname, then still subject to DNS/IP checks. |
| BPMN XML or start variables contain `allowedHosts` | Ignored or rejected; server policy unchanged. |
| Allowlisted `api.example.com` resolves to one public IP | Mocked transport may run against the pinned IP. |
| Allowlisted host resolves to public + private answers | Denied; no transport call. |
| Allowlisted host redirects to non-allowlisted host | Denied on redirect re-validation. |
| Evidence emitted for a denied task | Coarse code/counts/ids/host-or-hash only; no URL/path/query/body/header/response. |

## 6. Explicit non-authorization

Merging this design-lock does not authorize:

- configuring any production or staging destination;
- enabling any tenant/customer workflow to call an external host;
- adding a UI or API for users to manage allowlists;
- broadening R1 beyond BPMN HTTP service-tasks;
- replacing the default fail-closed runtime posture.

A3 becomes active only through the follow-up slices above, with fresh review and
green CI for each slice.
