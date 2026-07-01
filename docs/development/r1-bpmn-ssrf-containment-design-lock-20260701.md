# Design-lock — R1: legacy BPMN runtime governance + SSRF containment (security)

> **Live exposure, design-lock-first.** The legacy `BPMNWorkflowEngine` is an un-governed executable runtime
> mounted with **no RBAC**, and its `http` service task performs a **process-supplied-URL `fetch()`** =
> authenticated SSRF. This locks the containment before any runtime code, on the register's (#3385) ratified
> proposed defaults + two reviewer corrections. **One decision is genuinely the owner's** (Q2 — whether any
> production tenant currently depends on the engine); the rest I recommend approving as-defaulted.

## 1. Threat model (code-verified on `c44c284710`)

- **No-RBAC control plane.** `/api/workflow` and `/api/workflow-designer` are mounted **unconditionally**
  (`index.ts:1088/1090`) and **every** route is `authenticate`-only — zero `rbacGuard`. So **any authenticated
  principal** can `deploy` a process, `start`/`signal`/`message`/`complete` instances, and resolve incidents
  (workflow.ts), or `deploy`/`test` a designer draft (workflow-designer.ts). The only authz anywhere is two
  ad-hoc per-draft helpers (`canDeployWorkflowDraft`/`hasWorkflowDraftAccess`) on the designer deploy/test
  handlers — no central RBAC, and none at all on the engine mutation routes.
- **Authenticated SSRF sink.** `BPMNWorkflowEngine.ts:550` — `const response = await fetch(url, …)` where
  `url = this.resolveExpression(props.url, instance.variables)` (`:544`) is **attacker-controllable BPMN
  process content** with no scheme/host/allowlist validation. `:559 await response.json()` reads an
  **unbounded** body into a process variable; there is **no timeout**; the catch (`:569-572`) only logs+rethrows.
  A deployed process can therefore make the server fetch `http://169.254.169.254/…`, internal services, etc.
- **Not contained by a mount-gate alone (reviewer defect #1).** The engine is instantiated at **module load**
  (`workflow.ts:26`, `workflow-designer.ts:53`). The constructor is light, but `initialize()` (resume active
  instances = DB I/O + `startTimerProcessor` = a `setInterval` that can fire **timer-driven service-task
  egress**) runs on import unless `DISABLE_WORKFLOW==='true'`. Gating only `app.use(...)` would leave the
  engine live. Containment must gate `initialize()` **and** the mount.

## 2. Containment design (on the ratified defaults + reviewer corrections)

**A. Flag gate — layered, OFF by default (Q1/Q2).** Add `isLegacyWorkflowEngineEnabled()` in
`config/product-mode.ts` mirroring `isPlmEnabled` (via `parseBooleanEnv(process.env.ENABLE_LEGACY_BPMN)`),
**default false**. When **OFF**:
  - **Do not call `workflowEngine.initialize()`** — change the guard in `workflow.ts`/`workflow-designer.ts`
    from `DISABLE_WORKFLOW==='true'` to `!isLegacyWorkflowEngineEnabled()` (so no resume DB I/O, no armed
    timers, no timer egress). *(Closes reviewer defect #1 — quiescent engine, not just a blocked mount.)*
  - **Gate the mounts** with `disabledFeatureHandler('legacy BPMN engine disabled')` (index.ts:202 pattern),
    mirroring the `isPlmEnabled` mount block at index.ts:1091-1100.
  - **Designer fence (Q3):** block only the two engine-touching routes (`/workflows/:id/deploy` :1211,
    `/workflows/:id/test` :1282) when OFF; keep draft CRUD + `compile-preview` live so the designer stays
    **preview-only** (this is the convergence fence: designer = preview, no runtime).

**B. RBAC layer when ON (Q1).** When the flag is ON, apply `requireAdminRole()`
(`guards/audit-integration.ts:113`) to the **side-effecting** routes: workflow.ts `deploy`/`start`/`signal`/
`message`/`complete`/`claim`/`incidents/:id/resolve`, and designer `deploy`/`test`. Read-only routes keep
`authenticate`. (Flag-alone is the minimum acceptable; layered is the recommended posture.)

**C. SSRF-pinned egress (Q4/Q5/Q6/Q7).** Replace the raw `fetch` at `BPMNWorkflowEngine.ts:550`:
```
const check = await checkWebhookTargetUrl(url)          // https-only, internal-blocked, resolve-then-pin
if (!check.ok) throw new Error(`egress blocked: ${check.reason}`)   // Q6 fail-closed → existing catch/incident
const family = check.addresses[0].includes(':') ? 6 : 4            // reviewer defect #2 (no family in result)
const res = await pinnedHttpsFetch(url, check.addresses[0], family, {
  method, headers: { 'Content-Type': 'application/json', ...headers },
  body: body ? JSON.stringify(body) : undefined,
  timeoutMs: Number(process.env.BPMN_HTTP_EGRESS_TIMEOUT_MS) || 10_000,   // Q7
})
// Q5 status-only: pinnedHttpsFetch never reads the body → store { status: res.status, ok: res.ok } (drop :559 response.json)
```
This forces **https-only, public-IP-only, DNS-pinned** egress; **fails closed** on a blocked/errored target
(the existing `:569-572` catch records the incident); bounds the request at **10s**; and eliminates the
unbounded-body read (documented `responseVariable` regression → status-only).

## 3. The 7 decisions — proposed defaults (recommend approve; **Q2 is the owner's**)

| # | Decision | Proposed default (recommend) |
|---|---|---|
| Q1 | Gating mechanism | **Layered**: flag primary + `requireAdminRole` on side-effecting routes when ON |
| **Q2** | **Default state / migration** | **OFF by default** (`ENABLE_LEGACY_BPMN`) + release note. **⚠️ Owner must confirm no production tenant currently deploys/starts BPMN processes before merge** — OFF-by-default breaks them. This is the one call only you can make. |
| Q3 | Designer fence granularity | Block only deploy/test when OFF; keep draft CRUD + preview |
| Q4 | SSRF policy | Reuse `checkWebhookTargetUrl` + `pinnedHttpsFetch` (https-only, no new allowlist; ENV allowlist deferred) |
| Q5 | responseVariable | Status-only `{status, ok}`; no unbounded body; document the regression |
| Q6 | Failed egress | Fail-closed (throw → existing incident path) |
| Q7 | Egress timeout | 10_000ms via `BPMN_HTTP_EGRESS_TIMEOUT_MS` |

## 4. Verification plan (fail-first)

- **Flag OFF (default):** integration test that `/api/workflow/deploy` (and a designer deploy) returns the
  `disabledFeatureHandler` response, **and** that the engine is quiescent — assert `initialize()` is not
  invoked (no resume query, no armed timer) when the flag is off. *(Directly refutes reviewer defect #1 —
  a mount-only test would green while the engine still runs.)*
- **Flag ON + non-admin:** side-effecting routes 403 via `requireAdminRole`; read-only routes still 200.
- **SSRF unit (fail-first):** a process whose `http` task URL resolves to `http://169.254.169.254/…` /
  a private IP / plaintext http → `checkWebhookTargetUrl` rejects → task **fails closed** (incident recorded),
  no fetch to the target. A public-https target → pinned fetch, `responseVariable = {status, ok}`, body never read.
- **Timeout:** a hung target aborts at ~10s (not indefinite).
- tsc 0 · existing convergence-fence guard test stays green · UTC/no-behaviour-change for flag-ON-admin paths.

## 5. Scope / non-goals

**Egress-surface completeness (verified):** line 550 is the **only** `fetch`/network-egress sink in the entire
engine (grep found no other `https.request`/`axios`/`got`/`net.connect`), so pinning it fully closes the SSRF
surface — no second sink slips through. The `scriptTask` runs through the engine's existing safe-evaluator
sandbox (no `Function`/`eval`; `constructor` is regex-blocked) — not RCE, and out of R1 scope.

In: the flag gate + deferred init, RBAC on side-effecting routes, SSRF-pinned egress, the designer fence.
**Out (separate rungs):** an ENV host allowlist (Q4 deferred), a bounded-body response reader (Q5 deferred),
rewriting/retiring the legacy engine (this rung *contains*, it does not expand or replace). No change to the
approval/automation runtime. **Then T2-4 threshold re-entry quorum-bypass fix follows immediately.**

## 6. What I need from you

Approve the defaults (Q1,Q3–Q7 are security-sound; say "approve R1 defaults") — and the one real decision:
**Q2 — can we ship the legacy BPMN engine OFF by default?** i.e. does any production tenant currently rely on
deploying/starting BPMN processes? If yes, we ship OFF-by-default *plus* a migration note / opt-in for that
tenant; if no, OFF-by-default is clean. On your GO I build it design-lock-faithful, real-DB/unit verified, PR
for review.
